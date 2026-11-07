// Camera Canvas bridge server. Zero dependencies.
//
// - serves the app (app/, core/, three.js and mediabunny from node_modules)
// - owns the scene document: applies ops, keeps undo history, persists to scene.json
// - pushes changes and RPC calls to browser tabs over Server-Sent Events
// - queues prompts typed in the canvas so the user's agent can pick them up (canvas wait)
// - stores snapshots and exported videos under exports/

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyOps, createDoc, migrate, describe } from '../core/doc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/markdown; charset=utf-8',
};

export function startServer({ port = 5317, host = '127.0.0.1', scene, quiet = false } = {}) {
  const scenePath = path.resolve(scene || process.env.CANVAS_SCENE || path.join(ROOT, 'scenes', 'scene.json'));
  const workDir = path.join(path.dirname(scenePath), '.canvas');
  const exportsDir = path.resolve(process.env.CANVAS_EXPORTS || path.join(path.dirname(scenePath), 'exports'));
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  const inboxPath = path.join(workDir, 'inbox.jsonl');
  const logPath = path.join(workDir, 'log.jsonl');
  const log = (...a) => { if (!quiet) console.log('[canvas]', ...a); };

  // ---------- document ----------
  let doc;
  try { doc = migrate(JSON.parse(fs.readFileSync(scenePath, 'utf8'))); }
  catch (e) {
    if (fs.existsSync(scenePath)) log(`could not read ${scenePath} (${e.message}); starting a new scene`);
    doc = createDoc();
  }
  let rev = 0;
  const undo = [], redo = [];
  let lastWritten = '';
  const persist = () => {
    const text = JSON.stringify(doc, null, 2) + '\n';
    lastWritten = text;
    fs.mkdirSync(path.dirname(scenePath), { recursive: true });
    fs.writeFileSync(scenePath + '.tmp', text);
    fs.renameSync(scenePath + '.tmp', scenePath);
  };
  persist();

  function commit(next, source, label) {
    undo.push(doc); if (undo.length > 200) undo.shift();
    redo.length = 0;
    doc = next; rev++;
    persist();
    broadcast('doc', { doc, rev, source, label });
  }

  // Agents may also edit scene.json by hand: pick that up.
  fs.watchFile(scenePath, { interval: 400 }, () => {
    let text;
    try { text = fs.readFileSync(scenePath, 'utf8'); } catch { return; }
    if (text === lastWritten) return;
    try {
      const next = migrate(JSON.parse(text));
      log('scene.json changed on disk, reloading');
      commit(next, 'file', 'edit scene.json');
    } catch (e) {
      broadcast('say', { from: 'system', text: `scene.json has an error and was not loaded: ${e.message}`, kind: 'error', at: Date.now() });
    }
  });

  // Reload open tabs when the agent edits the app (new controls etc.).
  let reloadTimer;
  for (const dir of ['app', 'core']) {
    try {
      fs.watch(path.join(ROOT, dir), { recursive: true }, () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => broadcast('reload', { at: Date.now() }), 250);
      });
    } catch {}
  }

  // ---------- event stream ----------
  const clients = new Map(); // id -> { res, connectedAt, lastSeen, visible }
  function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function broadcast(event, data) { for (const c of clients.values()) send(c.res, event, data); }
  setInterval(() => { for (const c of clients.values()) c.res.write(': ping\n\n'); }, 15000).unref();

  function pickClient() {
    const list = [...clients.entries()];
    if (!list.length) return null;
    list.sort((a, b) => (b[1].visible - a[1].visible) || (b[1].lastSeen - a[1].lastSeen));
    return list[0];
  }

  // ---------- RPC to the browser ----------
  const pending = new Map(); // rpc id -> { resolve, reject, timer }
  let rpcSeq = 0;
  function rpc(method, params = {}, timeoutMs = 30000) {
    const target = pickClient();
    if (!target) return Promise.reject(Object.assign(new Error(`no canvas tab is open. Open http://${host}:${port} (or run: canvas open)`), { status: 409 }));
    const id = `r${++rpcSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send(target[1].res, 'rpc', { id, method, params });
    });
  }

  // ---------- prompt inbox ----------
  let prompts = [];
  try { prompts = fs.readFileSync(inboxPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const savePrompts = () => fs.writeFileSync(inboxPath, prompts.map((p) => JSON.stringify(p)).join('\n') + (prompts.length ? '\n' : ''));
  const waiters = []; // long-polling agents
  let lastAgentPoll = 0;
  const listenPath = path.join(workDir, 'listen.json');
  let listen = false;
  try { listen = !!JSON.parse(fs.readFileSync(listenPath, 'utf8')).on; } catch {}
  const agentListening = () => waiters.length > 0 || Date.now() - lastAgentPoll < 3000;
  // "Working" only while the agent is visibly active (ops, renders, messages, polls). An agent that took a
  // prompt and then went quiet for 2 minutes is reported as idle, so the canvas never shows a stuck spinner.
  let lastAgentActivity = 0;
  const touchAgent = () => { lastAgentActivity = Date.now(); };
  const agentWorking = () => prompts.some((p) => p.status === 'taken') && Date.now() - lastAgentActivity < 120000;
  const statusPayload = () => ({ agent: agentListening(), working: !agentListening() && agentWorking(), listen, waiting: waiters.length, queued: prompts.filter((p) => p.status === 'pending').length, rev });
  let lastStatus = '';
  const pushStatus = () => { const s = JSON.stringify(statusPayload()); if (s !== lastStatus) { lastStatus = s; broadcast('status', statusPayload()); } };
  setInterval(pushStatus, 2000).unref();

  // The agent asking for the next prompt means it has finished the ones it already took.
  function closeTaken() {
    for (const p of prompts) {
      if (p.status !== 'taken') continue;
      p.status = 'done'; p.doneAt = Date.now(); p.autoClosed = true;
      broadcast('prompt', p);
    }
    savePrompts();
  }

  function takePrompt() {
    const p = prompts.find((x) => x.status === 'pending');
    if (!p) return null;
    p.status = 'taken'; p.takenAt = Date.now();
    savePrompts();
    broadcast('prompt', p);
    return p;
  }
  function deliverToWaiters() {
    while (waiters.length && prompts.some((p) => p.status === 'pending')) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve(takePrompt());
    }
    pushStatus();
  }
  function appendLog(entry) { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); }

  // ---------- http ----------
  const readBody = (req, limit = 512 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req) => { const b = await readBody(req, 50 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  async function serveFile(res, file) {
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
  const within = (base, rel) => { const f = path.resolve(base, '.' + path.sep + rel); return f.startsWith(base + path.sep) || f === base ? f : null; };

  const STATIC = [
    ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')],
    ['/core/', path.join(ROOT, 'core')],
    ['/exports/', exportsDir],
    ['/', path.join(ROOT, 'app')],
  ];

  const routes = {
    'GET /api/doc': (req, res) => json(res, 200, { rev, doc }),
    'GET /api/summary': (req, res) => {
      const tl = doc.timeline;
      json(res, 200, {
        rev, scene: scenePath, exports: exportsDir, ...statusPayload(), tabs: clients.size,
        meta: doc.meta, env: doc.env,
        objects: doc.objects.map(describe),
        timeline: { duration: tl.duration, fps: tl.fps, interp: tl.interp, speed: tl.speed },
        keys: tl.keys.map((k) => `${k.id} t=${k.t} pos=${k.position.join(',')} target=${k.target.join(',')} fov=${k.fov}${k.roll ? ` roll=${k.roll}` : ''} ease=${JSON.stringify(k.ease)}`),
      });
    },
    'GET /api/status': (req, res) => json(res, 200, { ...statusPayload(), tabs: clients.size, scene: scenePath, exports: exportsDir }),

    'POST /api/op': async (req, res) => {
      const body = await readJson(req);
      const ops = body.ops ?? body;
      if (body.source !== 'ui') touchAgent();
      try {
        const { doc: next, results } = applyOps(doc, ops);
        commit(next, body.source || 'agent', body.label || [].concat(ops).map((o) => o.op).join(', '));
        json(res, 200, { ok: true, rev, results });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    },
    'POST /api/undo': (req, res) => {
      if (!undo.length) return json(res, 200, { ok: false, error: 'nothing to undo' });
      redo.push(doc); doc = undo.pop(); rev++; persist();
      broadcast('doc', { doc, rev, source: 'undo' });
      json(res, 200, { ok: true, rev });
    },
    'POST /api/redo': (req, res) => {
      if (!redo.length) return json(res, 200, { ok: false, error: 'nothing to redo' });
      undo.push(doc); doc = redo.pop(); rev++; persist();
      broadcast('doc', { doc, rev, source: 'redo' });
      json(res, 200, { ok: true, rev });
    },

    'GET /api/events': (req, res, url) => {
      const id = url.searchParams.get('client') || `c${Date.now()}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.set(id, { res, connectedAt: Date.now(), lastSeen: Date.now(), visible: true });
      send(res, 'doc', { doc, rev, source: 'connect' });
      send(res, 'status', statusPayload());
      send(res, 'history', { prompts: prompts.slice(-30), messages: readTail(logPath, 30) });
      req.on('close', () => clients.delete(id));
    },
    'POST /api/presence': async (req, res) => {
      const { client, visible } = await readJson(req);
      const c = clients.get(client);
      if (c) { c.lastSeen = Date.now(); c.visible = !!visible; }
      json(res, 200, { ok: true });
    },

    'POST /api/rpc': async (req, res) => {
      const { method, params, timeout } = await readJson(req);
      touchAgent();
      try { json(res, 200, { ok: true, result: await rpc(method, params, timeout || 30000) }); }
      catch (e) { json(res, e.status || 500, { ok: false, error: e.message }); }
    },
    'POST /api/rpc/result': async (req, res) => {
      const { id, result, error } = await readJson(req);
      const p = pending.get(id);
      if (p) { pending.delete(id); clearTimeout(p.timer); error ? p.reject(new Error(error)) : p.resolve(result); }
      json(res, 200, { ok: true });
    },

    // Browser uploads a rendered file (png / mp4 / webm).
    'POST /api/upload': async (req, res, url) => {
      const name = path.basename(url.searchParams.get('name') || `file-${Date.now()}`);
      const file = path.join(exportsDir, name);
      await fsp.writeFile(file, await readBody(req));
      let out = file;
      if (url.searchParams.get('transcode') === 'h264') out = transcodeH264(file) || file;
      json(res, 200, { ok: true, path: out, url: `/exports/${path.basename(out)}` });
    },

    // ----- prompts: canvas -> agent -----
    'POST /api/prompt': async (req, res) => {
      const { text, context } = await readJson(req);
      if (!text || !String(text).trim()) return json(res, 400, { ok: false, error: 'empty prompt' });
      const p = { id: `p${Date.now().toString(36)}`, text: String(text).trim(), context: context || {}, status: 'pending', at: Date.now() };
      prompts.push(p); if (prompts.length > 500) prompts = prompts.slice(-500);
      savePrompts();
      broadcast('prompt', p);
      deliverToWaiters();
      json(res, 200, { ok: true, prompt: p, agent: agentListening() });
    },
    'GET /api/prompt/next': (req, res, url) => {
      lastAgentPoll = Date.now(); touchAgent();
      if (url.searchParams.get('keep') !== '1') closeTaken();
      const p = takePrompt();
      if (p) { pushStatus(); return json(res, 200, { ok: true, prompt: p }); }
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), 3600) * 1000;
      if (!wait) return json(res, 200, { ok: true, prompt: null });
      const w = {
        resolve: (prompt) => { lastAgentPoll = Date.now(); json(res, 200, { ok: true, prompt }); },
        timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); lastAgentPoll = Date.now(); json(res, 200, { ok: true, prompt: null }); pushStatus(); }, wait),
      };
      waiters.push(w);
      req.on('close', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.timer); pushStatus(); } });
      pushStatus();
    },
    'POST /api/listen': async (req, res) => {
      const { on } = await readJson(req);
      listen = !!on;
      fs.writeFileSync(listenPath, JSON.stringify({ on: listen }));
      pushStatus();
      json(res, 200, { ok: true, listen });
    },
    'GET /api/prompts': (req, res) => json(res, 200, { prompts: prompts.slice(-50) }),
    'POST /api/prompt/status': async (req, res) => {
      const { id, status } = await readJson(req);
      const p = prompts.find((x) => x.id === id);
      if (!p) return json(res, 404, { ok: false, error: `no prompt ${id}` });
      p.status = status; savePrompts(); broadcast('prompt', p); deliverToWaiters();
      json(res, 200, { ok: true });
    },

    // ----- messages: agent -> canvas -----
    'POST /api/say': async (req, res) => {
      const { text, reply: replyTo, kind = 'info', done = true } = await readJson(req);
      touchAgent();
      // A reply without --reply answers the prompt the agent is working on, if there is exactly one.
      const taken = prompts.filter((x) => x.status === 'taken');
      const reply = replyTo || (taken.length === 1 ? taken[0].id : undefined);
      const entry = { from: 'agent', text: String(text || ''), reply, kind, at: Date.now() };
      appendLog(entry);
      broadcast('say', entry);
      const p = reply && prompts.find((x) => x.id === reply);
      if (p && done) { p.status = 'done'; p.doneAt = Date.now(); savePrompts(); broadcast('prompt', p); }
      json(res, 200, { ok: true });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) return await route(req, res, url);
      if (req.method !== 'GET') return json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
      if (url.pathname === '/vendor/mediabunny.mjs') return serveFile(res, path.join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'));
      for (const [prefix, dir] of STATIC) {
        if (!url.pathname.startsWith(prefix)) continue;
        let rel = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        const file = within(dir, rel);
        if (file) return serveFile(res, file);
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      log(`ready  http://${host}:${port}`);
      log(`scene  ${scenePath}`);
      log(`export ${exportsDir}`);
      resolve({ server, port, scenePath, exportsDir, close: () => { fs.unwatchFile(scenePath); server.close(); for (const c of clients.values()) c.res.end(); } });
    });
  });
}

function readTail(file, n) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}

let ffmpegOk;
function transcodeH264(file) {
  if (ffmpegOk === undefined) ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!ffmpegOk) return null;
  const out = file.replace(/\.(webm|mp4)$/i, '') + '.h264.mp4';
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out]);
  if (r.status !== 0) return null;
  fs.renameSync(out, file.replace(/\.(webm|mp4)$/i, '.mp4'));
  if (!file.endsWith('.mp4')) fs.unlinkSync(file);
  return file.replace(/\.(webm|mp4)$/i, '.mp4');
}

// Allow `node server/index.mjs` directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT) || 5317 }).catch((e) => { console.error(e.message); process.exit(1); });
}
