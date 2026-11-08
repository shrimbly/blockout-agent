#!/usr/bin/env node
// canvas: the agent's command line for Camera Canvas.
// Every command talks to the bridge server over HTTP (default http://127.0.0.1:5317).
// Run `canvas help` for the reference.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRIMITIVES, createDoc } from '../core/doc.js';
import { EASES } from '../core/curves.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.CANVAS_URL || `http://127.0.0.1:${process.env.CANVAS_PORT || 5317}`).replace(/\/$/, '');

const HELP = `canvas — drive the Camera Canvas blockout scene

Server
  canvas up [--scene path] [--no-open]     start the server in the background (if needed) and open the tab
  canvas serve [--port 5317] [--scene path] run the server in the foreground
  canvas open                               open the canvas in the default browser
  canvas status                             server, tab and agent-listening state
  canvas down                               stop a server started with "up"

Read the scene
  canvas ls                                 one line per object and camera key (start here)
  canvas doc                                the full scene JSON

Objects (meters, Y up, pivot at bottom centre, rotation in degrees)
  canvas add <type> [--name n] [--pos x,y,z] [--rot x,y,z] [--scale s|x,y,z]
                    [--size a,b,c] [--<param> v] [--color #rrggbb] [--note text]
  canvas set <id> [same flags as add] [--move dx,dy,dz] [--type t]
  canvas dup <id> [--offset x,y,z] [--name n]
  canvas rm <id> [id...]
  canvas new                                start a new, empty scene (undoable)
  canvas clear [--keys]                     remove all objects (and camera keys)
  canvas env [--background #hex] [--ground on|off] [--grid on|off] [--fog 0.02] [--sun x,y,z]
  canvas meta [--name n] [--width 1280] [--height 720]
  types: ${Object.entries(PRIMITIVES).map(([k, v]) => `${k}(${Object.keys(v.params).join(',')})`).join(' ')}

Moving objects (keys on the shot timeline; straight-line moves with an ease, objects hold before/after)
  canvas move <id> [--to x,y,z | --by dx,dy,dz] [--rot x,y,z | --turn dx,dy,dz] [--scale s|x,y,z]
                   [--at 0] [--over 1] [--ease name]   move from where it is at --at, over --over seconds
                                                        (e.g. canvas move hero --to 0,0,-3 --at 1 --over 3)
  canvas okey <id> --t 2 [--pos x,y,z] [--rot x,y,z] [--scale ..] [--ease name]   key an object at a time
  canvas okey-rm <id> [--t 2]               remove one object key (or, without --t, all of its animation)

Camera timeline
  canvas key --t 2 --pos x,y,z --target x,y,z [--fov 40 | --lens 35] [--roll 0] [--ease name|x1,y1,x2,y2]
  canvas key --t 2 --from-view              key the camera the user is looking through right now
  canvas key-set <keyId|index> [same flags] change a key (e.g. --ease snap, --t 3)
  canvas key-rm <keyId|index>
  canvas keys-clear
  canvas timeline [--duration 6 [--retime]] [--fps 24] [--interp smooth|linear]
                  [--speed name|x1,y1,x2,y2] [--ease name]   (--ease sets every segment)
  canvas seek <seconds> | play | pause | view shot|free | select <id|none> | frame [id]
  eases: ${Object.keys(EASES).join(' ')}

Render (needs the canvas tab open)
  canvas snapshot [--t 2] [--view shot|free] [--out file.png]   PNG of one frame; prints its path
  canvas storyboard [--frames 8] [--cols 4]                     contact sheet across the shot
  canvas export [--fps 24] [--width 1280 --height 720] [--grid on|off] [--name shot]
                                                                 blockout video (mp4); prints its path

Prompts from the canvas
  canvas wait [--timeout 600] [--json]      block until the user types a prompt in the canvas; prints it.
                                            Marks earlier prompts done and turns listen mode on.
  canvas inbox                              list recent prompts and their status
  canvas say "text" [--reply <promptId>] [--working]   message shown in the canvas
  canvas listen on|off                      keep a Claude Code session waiting for canvas prompts (Stop hook)

Save and load (scenes/saved/<name>.json)
  canvas save [name] [--overwrite]           save a named copy of the scene (default name: scene-<date>-<time>)
  canvas load <name>                         replace the scene with a save (undo brings the old one back)
  canvas saves                               list saves, newest first

Raw / batch
  canvas op '<json op or [ops]>'            e.g. canvas op '{"op":"add","type":"box","w":2}'
  canvas ops <file.json>                    apply an array of ops atomically
  canvas undo | redo
`;

// ---------- helpers ----------
// Flags that never take a value, so `say --working "text"` keeps "text" as the message.
const BOOLEAN_FLAGS = new Set(['working', 'json', 'retime', 'keys', 'from-view', 'open', 'no-open', 'help', 'overwrite']);

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--') || BOOLEAN_FLAGS.has(key)) val = true;
        else { val = next; i++; }
      }
      if (key.startsWith('no-') && val === true) { key = key.slice(3); val = false; }
      flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`); return n; };
const vec = (v, n = 3) => {
  if (v === true) throw new Error('missing value');
  const parts = String(v).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 1 && n === 3) return num(parts[0]);
  return parts.map(num);
};
const bool = (v) => v === true || ['on', 'true', '1', 'yes'].includes(String(v).toLowerCase());
const easeArg = (v) => (/^[a-z]/i.test(String(v)) ? String(v) : vec(v, 4));

async function api(method, route, body, { quietFail = false } = {}) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (quietFail) return null;
    throw new Error(`canvas server is not running at ${BASE}. Start it with: node ${path.relative(process.cwd(), path.join(ROOT, 'bin', 'canvas.mjs')) || 'bin/canvas.mjs'} up`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    if (quietFail) return null;
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

const op = (ops, label) => api('POST', '/api/op', { ops, label, source: 'agent' });
const rpc = (method, params = {}, timeout) => api('POST', '/api/rpc', { method, params, timeout }).then((d) => d.result);
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function objectFields(flags, type) {
  const o = {};
  if (flags.name != null) o.name = String(flags.name);
  if (flags.id != null) o.id = String(flags.id);
  if (flags.pos != null) o.position = vec(flags.pos);
  if (flags.position != null) o.position = vec(flags.position);
  if (flags.rot != null) o.rotation = vec(flags.rot);
  if (flags.rotation != null) o.rotation = vec(flags.rotation);
  if (flags.scale != null) o.scale = vec(flags.scale);
  if (flags.move != null) o.move = vec(flags.move);
  if (flags.color != null) o.color = String(flags.color);
  if (flags.note != null) o.note = String(flags.note);
  if (flags.size != null) { const s = vec(flags.size); o.size = Array.isArray(s) ? s : [s]; }
  if (flags.type != null && flags.type !== true) o.type = String(flags.type);
  const known = new Set(['name', 'id', 'pos', 'position', 'rot', 'rotation', 'scale', 'move', 'color', 'note', 'size', 'type']);
  for (const [k, v] of Object.entries(flags)) {
    if (known.has(k)) continue;
    const allParams = new Set(Object.values(PRIMITIVES).flatMap((p) => Object.keys(p.params)));
    if (!allParams.has(k)) throw new Error(`unknown flag --${k}`);
    o[k] = v === 'null' ? null : num(v);
  }
  if (type && o.position == null) o.position = [0, 0, 0];
  return o;
}

function keyFields(flags) {
  const k = {};
  if (flags.t != null) k.t = num(flags.t);
  if (flags.pos != null) k.position = vec(flags.pos);
  if (flags.position != null) k.position = vec(flags.position);
  if (flags.target != null) k.target = vec(flags.target);
  if (flags.fov != null) k.fov = num(flags.fov);
  if (flags.lens != null) k.fov = (360 / Math.PI) * Math.atan(12 / num(flags.lens));
  if (flags.roll != null) k.roll = num(flags.roll);
  if (flags.ease != null) k.ease = easeArg(flags.ease);
  for (const f of ['position', 'target']) if (typeof k[f] === 'number') throw new Error(`--${f === 'position' ? 'pos' : f} needs x,y,z`);
  return k;
}
const keyRef = (s) => (/^\d+$/.test(s) ? { index: Number(s) } : { id: s });

function formatPrompt(p) {
  const c = p.context || {};
  const lines = [`[canvas prompt ${p.id}] ${p.text || '(no text, see the attached images)'}`];
  if (p.images?.length) lines.push(`images attached (open each with your Read tool): ${p.images.map((i) => i.path).join(' | ')}`);
  if (c.selection?.length) lines.push(`selected: ${c.selection.join(' | ')}`);
  if (c.time != null) lines.push(`playhead: ${Number(c.time).toFixed(2)}s of ${c.duration}s, view: ${c.view}${c.key ? `, key: ${c.key}` : ''}`);
  if (c.camera) lines.push(`camera: pos=${c.camera.position.map((v) => +v.toFixed(2)).join(',')} target=${c.camera.target.map((v) => +v.toFixed(2)).join(',')} fov=${+c.camera.fov.toFixed(1)}`);
  lines.push(`→ do it with canvas commands, then: canvas say --reply ${p.id} "<one line on what changed>"`);
  lines.push('→ then run "canvas wait" again so the next canvas prompt reaches you (until the user says stop).');
  return lines.join('\n');
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

const runDir = () => path.join(ROOT, '.canvas');

// ---------- commands ----------
const commands = {
  help: () => out(HELP),

  async serve({ flags }) {
    const { startServer } = await import('../server/index.mjs');
    await startServer({ port: Number(flags.port) || Number(process.env.CANVAS_PORT) || 5317, scene: flags.scene, host: flags.host || '127.0.0.1' });
    if (flags.open) openBrowser(BASE);
  },

  async up({ flags }) {
    const st = await api('GET', '/api/status', undefined, { quietFail: true });
    if (!st) {
      fs.mkdirSync(runDir(), { recursive: true });
      const logFile = fs.openSync(path.join(runDir(), 'server.log'), 'a');
      const args = [path.join(ROOT, 'bin', 'canvas.mjs'), 'serve'];
      if (flags.scene) args.push('--scene', path.resolve(String(flags.scene)));
      if (flags.port) args.push('--port', String(flags.port));
      const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFile, logFile], env: process.env });
      child.unref();
      fs.writeFileSync(path.join(runDir(), 'server.pid'), String(child.pid));
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await api('GET', '/api/status', undefined, { quietFail: true })) break;
      }
    }
    const s = await api('GET', '/api/status');
    if (flags.open !== false && !s.tabs) openBrowser(BASE);
    out(`canvas running at ${BASE}\nscene:   ${s.scene}\nexports: ${s.exports}\ntabs open: ${s.tabs}`);
  },

  async down() {
    const pidFile = path.join(runDir(), 'server.pid');
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); fs.unlinkSync(pidFile); out('stopped'); }
    catch { out('no background server found (stop a foreground "serve" with Ctrl+C)'); }
  },

  open: () => { openBrowser(BASE); out(`opened ${BASE}`); },

  async status() {
    const s = await api('GET', '/api/status');
    out(`server: ${BASE}\nscene: ${s.scene}\nexports: ${s.exports}\ntabs open: ${s.tabs}\nagent listening: ${s.agent ? 'yes' : 'no'}${s.listen ? ' (listen mode on)' : ''}\nqueued prompts: ${s.queued}\nrev: ${s.rev}`);
  },

  async ls() {
    const s = await api('GET', '/api/summary');
    const lines = [
      `scene "${s.meta.name}" ${s.meta.width}x${s.meta.height}, rev ${s.rev}, ${s.tabs} tab(s) open${s.agent ? '' : ''}`,
      `env: background ${s.env.background}, ground ${s.env.ground ? 'on' : 'off'}, grid ${s.env.grid ? 'on' : 'off'}, fog ${s.env.fog}`,
      `objects (${s.objects.length}):`, ...s.objects.map((o) => `  ${o}`),
      `timeline: ${s.timeline.duration}s @ ${s.timeline.fps}fps, ${s.timeline.interp} path, speed ${JSON.stringify(s.timeline.speed)}`,
      `camera keys (${s.keys.length}):`, ...s.keys.map((k) => `  ${k}`),
    ];
    out(lines.join('\n'));
  },

  async doc() { out((await api('GET', '/api/doc')).doc); },

  async add({ pos, flags }) {
    const type = pos[0];
    if (!type) throw new Error(`usage: canvas add <type> ... (types: ${Object.keys(PRIMITIVES).join(', ')})`);
    const r = await op({ op: 'add', type, ...objectFields(flags, type) });
    out(r.results[0].id);
  },
  async set({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas set <id> --pos x,y,z ...');
    const r = await op({ op: 'update', id: pos[0], ...objectFields(flags) });
    out(r.results[0].id);
  },
  async dup({ pos, flags }) {
    const r = await op({ op: 'duplicate', id: pos[0], offset: flags.offset != null ? vec(flags.offset) : undefined, name: flags.name, newId: flags.name });
    out(r.results[0].id);
  },
  async rm({ pos }) { await op({ op: 'remove', ids: pos }); out(`removed ${pos.join(', ')}`); },
  async new() { const r = await op({ op: 'load', doc: createDoc() }); out(`new empty scene (${r.results[0].keys} camera keys). canvas undo brings the old one back`); },
  async clear({ flags }) { const r = await op({ op: 'clear', keys: !!flags.keys }); out(`removed ${r.results[0].removed} objects`); },
  async env({ flags }) {
    const o = { op: 'env' };
    if (flags.background) o.background = flags.background;
    if (flags.ground != null) o.ground = bool(flags.ground);
    if (flags.grid != null) o.grid = bool(flags.grid);
    if (flags.fog != null) o.fog = num(flags.fog);
    if (flags.sun != null) o.sun = vec(flags.sun);
    out((await op(o)).results[0]);
  },
  async meta({ flags }) {
    const o = { op: 'meta' };
    if (flags.name) o.name = String(flags.name);
    if (flags.width) o.width = num(flags.width);
    if (flags.height) o.height = num(flags.height);
    out((await op(o)).results[0]);
  },

  async key({ flags }) {
    const k = keyFields(flags);
    if (flags['from-view']) {
      const cam = await rpc('camera');
      k.position ??= cam.position; k.target ??= cam.target; k.fov ??= cam.fov;
      if (k.t == null) k.t = cam.time;
    }
    const r = await op({ op: 'key.add', ...k });
    out(`${r.results[0].replaced ? 'updated' : 'added'} key ${r.results[0].id}`);
  },
  async 'key-set'({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas key-set <keyId|index> --ease snap');
    const k = keyFields(flags);
    if (flags['from-view']) { const cam = await rpc('camera'); Object.assign(k, { position: cam.position, target: cam.target, fov: cam.fov }); }
    const r = await op({ op: 'key.update', ...keyRef(pos[0]), ...k });
    out(`updated key ${r.results[0].id}`);
  },
  async 'key-rm'({ pos }) { const r = await op({ op: 'key.remove', ...keyRef(pos[0]) }); out(`removed key ${r.results[0].removed}`); },
  async 'keys-clear'() { const r = await op({ op: 'key.clear' }); out(`removed ${r.results[0].removed} keys`); },
  async move({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas move <id> --to x,y,z [--at 0] [--over 1] [--ease easeInOut]');
    const o = { op: 'anim.move', id: pos[0] };
    if (flags.to != null) o.to = vec(flags.to);
    if (flags.by != null) o.by = vec(flags.by);
    if (flags.rot != null || flags.rotation != null) o.rotation = vec(flags.rot ?? flags.rotation);
    if (flags.turn != null) o.turn = vec(flags.turn);
    if (flags.scale != null) o.scale = vec(flags.scale);
    if (flags.at != null) o.at = num(flags.at);
    if (flags.over != null) o.over = num(flags.over);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    const r = (await op(o, `move ${pos[0]}`)).results[0];
    out(`${r.id} moves ${r.from}s → ${r.to}s (${r.keys} keys)`);
  },
  async okey({ pos, flags }) {
    if (!pos[0] || flags.t == null) throw new Error('usage: canvas okey <id> --t 2 [--pos x,y,z] [--rot x,y,z] [--scale s] [--ease name]');
    const o = { op: 'anim.key', id: pos[0], t: num(flags.t) };
    if (flags.pos != null || flags.position != null) o.position = vec(flags.pos ?? flags.position);
    if (flags.rot != null || flags.rotation != null) o.rotation = vec(flags.rot ?? flags.rotation);
    if (flags.scale != null) o.scale = vec(flags.scale);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    const r = (await op(o, `key ${pos[0]}`)).results[0];
    out(`keyed ${r.id} at ${r.t}s (${r.keys} keys)`);
  },
  async 'okey-rm'({ pos, flags }) {
    if (!pos[0]) throw new Error('usage: canvas okey-rm <id> [--t 2]');
    const r = (await op({ op: 'anim.remove', id: pos[0], t: flags.t != null ? num(flags.t) : undefined })).results[0];
    out(`${r.id}: ${r.keys} animation keys left`);
  },

  async timeline({ flags }) {
    const o = { op: 'timeline' };
    if (flags.duration != null) o.duration = num(flags.duration);
    if (flags.retime) o.retime = true;
    if (flags.fps != null) o.fps = num(flags.fps);
    if (flags.interp != null) o.interp = String(flags.interp);
    if (flags.speed != null) o.speed = easeArg(flags.speed);
    if (flags.ease != null) o.ease = easeArg(flags.ease);
    out((await op(o)).results[0].timeline);
  },

  async seek({ pos }) { out(await rpc('seek', { t: num(pos[0] ?? 0) })); },
  async play() { out(await rpc('play')); },
  async pause() { out(await rpc('pause')); },
  async view({ pos }) { out(await rpc('view', { mode: pos[0] || 'shot' })); },
  async select({ pos }) { out(await rpc('select', { id: pos[0] && pos[0] !== 'none' ? pos[0] : null })); },
  async frame({ pos }) { out(await rpc('frame', { id: pos[0] || null })); },

  async snapshot({ flags }) {
    const r = await rpc('snapshot', { t: flags.t != null ? num(flags.t) : undefined, view: flags.view, name: flags.out ? path.basename(String(flags.out)) : undefined, width: flags.width && num(flags.width), height: flags.height && num(flags.height) }, 60000);
    out(copyOut(r.path, flags.out));
  },
  async storyboard({ flags }) {
    const r = await rpc('storyboard', { frames: flags.frames ? num(flags.frames) : 8, cols: flags.cols ? num(flags.cols) : 4 }, 120000);
    out(copyOut(r.path, flags.out));
  },
  async export({ flags }) {
    const params = {
      fps: flags.fps && num(flags.fps), width: flags.width && num(flags.width), height: flags.height && num(flags.height),
      grid: flags.grid != null ? bool(flags.grid) : undefined, name: flags.name ? String(flags.name) : undefined,
    };
    const r = await rpc('export', params, 30 * 60 * 1000);
    out(`${copyOut(r.path, flags.out)}\n${r.frames} frames, ${r.width}x${r.height} @ ${r.fps}fps, ${r.codec}, ${(r.bytes / 1e6).toFixed(2)} MB`);
  },

  async wait({ flags }) {
    const timeout = flags.timeout != null ? num(flags.timeout) : 600;
    const start = Date.now();
    // Waiting for canvas prompts means this agent is listening: keep it that way across turns
    // (Claude Code's Stop hook uses this flag). `canvas listen off` or --no-listen opts out.
    if (flags.listen !== false) await api('POST', '/api/listen', { on: true }, { quietFail: true });
    // Long-poll in slices so a dropped connection does not lose more than one slice.
    while (true) {
      const left = timeout - (Date.now() - start) / 1000;
      if (left <= 0) { out(flags.json ? { prompt: null } : 'no prompt (timed out). Run "canvas wait" again to keep listening.'); return; }
      let r;
      try { r = await api('GET', `/api/prompt/next?wait=${Math.ceil(Math.min(left, 300))}`); }
      catch (e) { if (/not running/.test(e.message)) throw e; await new Promise((res) => setTimeout(res, 1000)); continue; }
      if (r.prompt) { out(flags.json ? r.prompt : formatPrompt(r.prompt)); return; }
    }
  },
  async inbox() {
    const r = await api('GET', '/api/prompts');
    out(r.prompts.map((p) => `${p.id} [${p.status}] ${p.text}`).join('\n') || 'no prompts yet');
  },
  async say({ pos, flags }) {
    const text = pos.join(' ');
    if (!text) throw new Error('usage: canvas say "message" [--reply <promptId>]');
    await api('POST', '/api/say', { text, reply: flags.reply, done: !flags.working, kind: flags.kind || (flags.working ? 'working' : 'info') });
    out('sent');
  },
  async listen({ pos }) {
    const on = (pos[0] || 'on') !== 'off';
    await api('POST', '/api/listen', { on });
    out(on ? 'listen mode on: when this Claude Code session finishes a turn, the Stop hook waits for the next canvas prompt' : 'listen mode off');
  },

  async op({ pos }) {
    const ops = JSON.parse(pos.join(' '));
    out((await op(ops)).results);
  },
  async ops({ pos }) {
    const ops = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
    out((await op(ops)).results);
  },
  async save({ pos, flags }) {
    const r = await api('POST', '/api/save', { name: pos.join(' ') || undefined, overwrite: !!flags.overwrite });
    out(`saved "${r.name}" → ${r.path}`);
  },
  async load({ pos }) {
    if (!pos[0]) throw new Error('usage: canvas load <name>   (canvas saves lists them)');
    const r = await api('POST', '/api/load', { name: pos.join(' ') });
    out(`loaded "${r.name}": ${r.objects} objects, ${r.keys} camera keys (canvas undo to go back)`);
  },
  async saves() {
    const r = await api('GET', '/api/saves');
    out(r.saves.length ? r.saves.map((s) => `${s.name.padEnd(28)} ${s.savedAt.replace('T', ' ').slice(0, 16)}  ${s.objects} objects, ${s.keys} keys`).join('\n') : `no saves yet (${r.dir})`);
  },
  async undo() { out(await api('POST', '/api/undo')); },
  async redo() { out(await api('POST', '/api/redo')); },

  // ---------- agent hooks (Claude Code) ----------
  async hook({ pos }) {
    const which = pos[0];
    const input = await readStdin().then((s) => { try { return JSON.parse(s); } catch { return {}; } });
    const st = await api('GET', '/api/status', undefined, { quietFail: true });
    if (!st) return; // server not running: hooks are no-ops

    if (which === 'prompt') {
      // UserPromptSubmit: hand over anything queued in the canvas as extra context.
      const got = [];
      for (let i = 0; i < 10; i++) {
        const r = await api('GET', '/api/prompt/next?keep=1', undefined, { quietFail: true });
        if (!r?.prompt) break;
        got.push(formatPrompt(r.prompt));
      }
      if (got.length) out(`Prompts the user typed in the canvas while you were busy:\n\n${got.join('\n\n')}`);
      return;
    }

    if (which === 'stop') {
      // Stop: if the user prompted in the canvas, keep going in this same thread.
      let r = await api('GET', '/api/prompt/next', undefined, { quietFail: true });
      if (!r?.prompt && st.listen) {
        // Long-poll in short slices: Node's fetch gives up on a response after 300 s, which used to end
        // the wait (and the session) after five idle minutes. Re-check listen mode between slices.
        const secs = Number(process.env.CANVAS_LISTEN_SECONDS || 3300);
        const slice = Number(process.env.CANVAS_POLL_SLICE || 240);
        const start = Date.now();
        while (!r?.prompt) {
          const left = secs - (Date.now() - start) / 1000;
          if (left <= 0) break;
          r = await api('GET', `/api/prompt/next?wait=${Math.ceil(Math.min(left, slice))}`, undefined, { quietFail: true });
          if (r?.prompt) break;
          const now = await api('GET', '/api/status', undefined, { quietFail: true });
          if (!now) { await new Promise((res) => setTimeout(res, 2000)); continue; } // server restarting: keep trying
          if (!now.listen) return; // canvas listen off: let the session stop
        }
        if (!r?.prompt) {
          // Nothing for a whole wait: hand back a no-op turn so this hook runs again and listening continues.
          out({ decision: 'block', reason: 'Still listening to the canvas: no prompt arrived. Do nothing and end your turn now (no tool calls, no message); the Stop hook waits again.' });
          return;
        }
      }
      if (r?.prompt) {
        out({ decision: 'block', reason: `The user sent this from the canvas. Handle it now, then reply with canvas say.\n\n${formatPrompt(r.prompt)}` });
      }
      void input;
    }
  },
};

const aliases = { remove: 'rm', delete: 'rm', update: 'set', duplicate: 'dup', list: 'ls', '-h': 'help', '--help': 'help' };

function copyOut(file, dest) {
  if (!dest || dest === true) return file;
  const target = path.resolve(String(dest));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return target;
}

const [cmdName = 'help', ...rest] = process.argv.slice(2);
const cmd = commands[aliases[cmdName] || cmdName];
if (!cmd) { console.error(`unknown command "${cmdName}". Run: canvas help`); process.exit(2); }
try {
  await cmd(parseArgs(rest));
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
