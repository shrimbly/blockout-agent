// Blockout bridge server. Zero dependencies.
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
import os from 'node:os';
import { applyOps, createDoc, migrate, describe, AUDIO_FILE } from '../core/doc.js';
import crypto from 'node:crypto';
import { dataDir } from './paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How this server was started, so the empty chat can say the right next step: by Claude Code (its Bash
 * tool sets CLAUDECODE), by Codex (CODEX_* variables), or by hand from a terminal; whether the
 * blockout-agent plugin is installed (so /blockout-agent:start works); and whether this is a git checkout
 * (so "listen to the canvas" works for an agent started in it, through the repo's own hooks).
 */
export function launchInfo(env = process.env, root = ROOT) {
  const by = env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID ? 'claude' : Object.keys(env).some((k) => k.startsWith('CODEX_')) ? 'codex' : 'terminal';
  let plugin = !!env.CLAUDE_PLUGIN_ROOT || root.split(path.sep).join('/').includes('/.claude/plugins/');
  if (!plugin) {
    try { plugin = fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json'), 'utf8').includes('"blockout-agent@'); } catch {}
  }
  // the folder as the user would type it: ~/... when it is under home and needs no quoting
  const home = os.homedir(), rel = root.startsWith(home + path.sep) ? root.slice(home.length + 1) : null;
  const dir = rel && /^[\w./-]+$/.test(rel) ? `~/${rel}` : /^[\w./-]+$/.test(root) ? root : JSON.stringify(root);
  return { by, plugin, checkout: fs.existsSync(path.join(root, '.git')), root, dir };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac',
};

export function startServer({ port = 5317, host = '127.0.0.1', scene, quiet = false } = {}) {
  const scenePath = path.resolve(scene || process.env.CANVAS_SCENE || path.join(dataDir(), 'scenes', 'scene.json'));
  const workDir = path.join(path.dirname(scenePath), '.canvas');
  const exportsDir = path.resolve(process.env.CANVAS_EXPORTS || path.join(path.dirname(scenePath), 'exports'));
  const savesDir = path.join(path.dirname(scenePath), 'saved');
  const uploadsDir = path.join(workDir, 'uploads');
  const audioDir = path.join(path.dirname(scenePath), 'audio'); // the timeline's audio tracks, shared by every save
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
    scheduleAutosave();
  };
  // Autosave into the named version you are on (scenes/saved/<meta.name>.json), so a saved version never goes stale.
  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      const n = doc.meta?.name;
      if (!n || n === 'untitled' || !/^[a-z0-9._-]+$/.test(n)) return;
      const file = path.join(savesDir, `${n}.json`);
      if (!fs.existsSync(file)) return; // only versions that were saved once
      try {
        fs.writeFileSync(file, JSON.stringify({ ...doc, meta: { ...doc.meta, savedAs: n, savedAt: new Date().toISOString() } }, null, 2) + '\n');
        broadcast('saves', { saves: listSaves() });
      } catch (e) { console.error(`[canvas] autosave to ${file} failed: ${e.message}`); }
    }, 800);
  }
  persist();

  // amend: a bookkeeping change (e.g. the browser recording an audio file's length) that is not an undo step
  function commit(next, source, label, { amend = false } = {}) {
    if (!amend) {
      undo.push(doc); if (undo.length > 200) undo.shift();
      redo.length = 0;
    }
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

  // ---------- named saves ----------
  const saveName = (s) => {
    const n = String(s || '').trim().toLowerCase().replace(/\.json$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    if (!n) throw Object.assign(new Error('a save needs a name'), { status: 400 });
    return n.slice(0, 80);
  };
  function listSaves() {
    let files = [];
    try { files = fs.readdirSync(savesDir).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files.map((f) => {
      const file = path.join(savesDir, f), name = f.slice(0, -5);
      let objects = 0, keys = 0, savedAt = null;
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); objects = d.objects?.length || 0; keys = d.timeline?.keys?.length || 0; savedAt = d.meta?.savedAt || null; } catch {}
      const mtime = fs.statSync(file).mtimeMs;
      const thumb = fs.existsSync(path.join(savesDir, `${name}.png`)) ? `/saved/${encodeURIComponent(name)}.png?v=${Math.round(mtime)}` : null;
      return { name, path: file, savedAt: savedAt || new Date(mtime).toISOString(), objects, keys, thumb };
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
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
  // Listen mode belongs to one agent session (the one that turned it on), so a Stop hook installed for every
  // Claude Code session (the plugin) only ever holds that session open, never an unrelated one.
  let listen = false, listenSession = null, listenCwd = null;
  try { ({ on: listen, session: listenSession = null, cwd: listenCwd = null } = JSON.parse(fs.readFileSync(listenPath, 'utf8'))); listen = !!listen; } catch {}
  const agentListening = () => waiters.length > 0 || Date.now() - lastAgentPoll < 3000;
  // "Working" while the agent holds a prompt. In listen mode the agent comes back to poll as soon as it
  // finishes (the Stop hook or `canvas wait`), so a taken prompt means it is still busy, even while it is
  // only thinking and touching nothing; give up after 30 minutes in case the session was closed. Without
  // listen mode, fall back to 2 minutes since the last thing the agent did.
  let lastAgentActivity = 0;
  const touchAgent = () => { lastAgentActivity = Date.now(); };
  const agentWorking = () => {
    const taken = prompts.filter((p) => p.status === 'taken');
    if (!taken.length) return false;
    if (Date.now() - lastAgentActivity < 120000) return true;
    return listen && taken.some((p) => Date.now() - (p.takenAt || 0) < 30 * 60000);
  };
  // Listen mode stays on in listen.json after its session quits. Count it as live only while that agent
  // shows signs of life: polling now, holding a prompt, or active in the last two minutes (for example the
  // turn that turned listening on, before its first Stop hook polls).
  const listenLive = () => listen && (agentListening() || agentWorking() || Date.now() - Math.max(lastAgentActivity, lastAgentPoll) < 120000);
  const launch = launchInfo();
  const statusPayload = () => ({ agent: agentListening(), working: !agentListening() && agentWorking(), listen, listenLive: listenLive(), launch, listenSession, listenCwd, pid: process.pid, waiting: waiters.length, queued: prompts.filter((p) => p.status === 'pending').length, rev });
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
    ['/saved/', savesDir],
    ['/uploads/', uploadsDir],
    ['/audio/', audioDir],
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
        timeline: { duration: tl.duration, fps: tl.fps, interp: tl.interp, speed: tl.speed, audio: tl.audio || null },
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
        commit(next, body.source || 'agent', body.label || [].concat(ops).map((o) => o.op).join(', '), { amend: !!body.amend });
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

    // ----- named saves: scenes/saved/<name>.json (+ optional <name>.png thumbnail) -----
    'GET /api/saves': (req, res) => json(res, 200, { ok: true, dir: savesDir, saves: listSaves() }),
    'POST /api/save': async (req, res) => {
      const { name, overwrite } = await readJson(req);
      const n = saveName(name || `scene-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`);
      const file = path.join(savesDir, `${n}.json`);
      if (fs.existsSync(file) && !overwrite) return json(res, 409, { ok: false, error: `a save called "${n}" already exists (overwrite it, or pick another name)`, exists: true, name: n });
      fs.mkdirSync(savesDir, { recursive: true });
      // the scene takes the save's name (shown in the Scenes menu, used for export file names); not an undo step
      if (doc.meta.name !== n) { doc = { ...doc, meta: { ...doc.meta, name: n } }; rev++; persist(); broadcast('doc', { doc, rev, source: 'save' }); }
      fs.writeFileSync(file, JSON.stringify({ ...doc, meta: { ...doc.meta, savedAs: n, savedAt: new Date().toISOString() } }, null, 2) + '\n');
      broadcast('saves', { saves: listSaves() });
      json(res, 200, { ok: true, name: n, path: file });
    },
    'POST /api/save/thumb': async (req, res, url) => {
      const n = saveName(url.searchParams.get('name'));
      if (!fs.existsSync(path.join(savesDir, `${n}.json`))) return json(res, 404, { ok: false, error: `no save "${n}"` });
      fs.writeFileSync(path.join(savesDir, `${n}.png`), await readBody(req, 5 * 1024 * 1024));
      broadcast('saves', { saves: listSaves() });
      json(res, 200, { ok: true });
    },
    'POST /api/load': async (req, res) => {
      const { name } = await readJson(req);
      const n = saveName(name);
      const file = path.join(savesDir, `${n}.json`);
      let next;
      try { next = migrate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (e) { return json(res, e.code === 'ENOENT' ? 404 : 400, { ok: false, error: e.code === 'ENOENT' ? `no save "${n}" (saves: ${listSaves().map((s) => s.name).join(', ') || 'none'})` : `could not read ${n}: ${e.message}` }); }
      delete next.meta.savedAs; delete next.meta.savedAt;
      next.meta.name = n;
      commit(next, 'load', `load ${n}`); // undoable like any other change
      json(res, 200, { ok: true, name: n, rev, objects: next.objects.length, keys: next.timeline.keys.length });
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
      const tc = url.searchParams.get('transcode');
      if (tc === 'h264') out = transcodeH264(file) || file;
      else if (tc === 'aac') out = transcodeAac(file) || file;
      json(res, 200, { ok: true, path: out, url: `/exports/${path.basename(out)}` });
    },

    // An audio file for the timeline: saved under the scene folder's audio/ by a name made from the file's
    // name and content, so loading the same file twice reuses it. The caller then sets it with the audio op.
    'POST /api/audio': async (req, res, url) => {
      const orig = path.basename(url.searchParams.get('name') || 'audio.mp3');
      const ext = (path.extname(orig).toLowerCase() || '.mp3').slice(0, 6);
      const body = await readBody(req, 300 * 1024 * 1024);
      if (!body.length) return json(res, 400, { ok: false, error: 'empty audio file' });
      const stem = orig.slice(0, orig.length - path.extname(orig).length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'audio';
      const file = `${stem}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 8)}${ext}`;
      if (!AUDIO_FILE.test(file)) return json(res, 400, { ok: false, error: `unsupported audio type "${ext}" (use mp3, wav, m4a, aac, ogg, opus, flac or webm)` });
      fs.mkdirSync(audioDir, { recursive: true });
      fs.writeFileSync(path.join(audioDir, file), body);
      json(res, 200, { ok: true, file, name: orig, path: path.join(audioDir, file), url: `/audio/${file}`, bytes: body.length });
    },

    // ----- prompts: canvas -> agent -----
    // Images for chat prompts: saved under .canvas/uploads so the agent can open them by path.
    'POST /api/chat/image': async (req, res) => {
      const { data, name } = await readJson(req);
      const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(String(data || ''));
      if (!m) return json(res, 400, { ok: false, error: 'expected a png, jpeg, webp or gif data URL' });
      fs.mkdirSync(uploadsDir, { recursive: true });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const stem = String(name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'image';
      const file = `${Date.now().toString(36)}-${stem}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, file), Buffer.from(m[2], 'base64'));
      json(res, 200, { ok: true, file, url: `/uploads/${file}`, path: path.join(uploadsDir, file) });
    },
    'POST /api/prompt': async (req, res) => {
      const { text, context, images } = await readJson(req);
      const imgs = (Array.isArray(images) ? images : [])
        .map((f) => path.basename(String(f?.file || f)))
        .filter((f) => fs.existsSync(path.join(uploadsDir, f)))
        .slice(0, 8)
        .map((f) => ({ file: f, url: `/uploads/${f}`, path: path.join(uploadsDir, f) }));
      if ((!text || !String(text).trim()) && !imgs.length) return json(res, 400, { ok: false, error: 'empty prompt' });
      const p = { id: `p${Date.now().toString(36)}`, text: String(text || '').trim(), context: context || {}, status: 'pending', at: Date.now() };
      if (imgs.length) p.images = imgs;
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
      const { on, session = null, cwd = null } = await readJson(req);
      listen = !!on;
      listenSession = listen ? session : null;
      listenCwd = listen ? cwd : null;
      if (listen) touchAgent();
      fs.writeFileSync(listenPath, JSON.stringify({ on: listen, session: listenSession, cwd: listenCwd }));
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

    // New chat: archive the conversation and start an empty thread. Prompts still queued or being worked on stay.
    'POST /api/chat/new': async (req, res) => {
      try { if (fs.existsSync(logPath) && fs.statSync(logPath).size) fs.renameSync(logPath, path.join(workDir, `log-${Date.now()}.jsonl`)); } catch {}
      prompts = prompts.filter((p) => p.status === 'pending' || p.status === 'taken');
      savePrompts();
      broadcast('history', { prompts: prompts.slice(-30), messages: [] });
      json(res, 200, { ok: true, kept: prompts.length });
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
      if (!res.headersSent) json(res, e.status || 500, { ok: false, error: e.message });
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
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  if (r.status !== 0) return null;
  fs.renameSync(out, file.replace(/\.(webm|mp4)$/i, '.mp4'));
  if (!file.endsWith('.mp4')) fs.unlinkSync(file);
  return file.replace(/\.(webm|mp4)$/i, '.mp4');
}

/** The browser could encode H.264 but not AAC (its audio is Opus): re-encode just the audio to AAC, which every player reads. */
function transcodeAac(file) {
  if (ffmpegOk === undefined) ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!ffmpegOk || !file.endsWith('.mp4')) return null;
  const out = file.replace(/\.mp4$/i, '.aac.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  if (r.status !== 0) return null;
  fs.renameSync(out, file);
  return file;
}

// Allow `node server/index.mjs` directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer({ port: Number(process.env.PORT) || 5317 }).catch((e) => { console.error(e.message); process.exit(1); });
}
