// Camera Canvas bootstrap: connects to the bridge server, wires the viewport, timeline, chat sidebar,
// registered controls, keyboard shortcuts and the RPC methods the agent calls (canvas seek/snapshot/export...).

import { store } from './store.js';
import { Viewport } from './viewport.js';
import { mountTimeline } from './timeline.js';
import { mountPrompt } from './prompt.js';
import { createRenderer } from './render.js';
import { h, button, segmented, panel, toast, kbd } from './ui/kit.js';
import { mountSaves } from './saves.js';
import controls from './controls/index.js';

const $ = (id) => document.getElementById(id);
const viewport = new Viewport($('stage'));
const renderer = createRenderer(viewport);
const timeline = mountTimeline($('timeline'), { viewport, exporter: renderer });
const prompt = mountPrompt($('prompt'), { viewport, corner: $('corner') });
window.canvas = { store, viewport, renderer, timeline }; // handy in the devtools console

// ---------- selection chip (top left) ----------
const selName = h('span.cc-mono.sel-name');
const gizmoSeg = segmented({
  options: [
    { value: 'translate', icon: 'move', title: 'Move (W)' },
    { value: 'rotate', icon: 'rotate', title: 'Rotate (E)' },
    { value: 'scale', icon: 'scale', title: 'Scale (R)' },
  ],
  value: store.state.gizmo, onChange: (v) => store.set({ gizmo: v }),
});
const selBox = h('div.cc-panel.sel-box', {}, selName, gizmoSeg,
  button({ icon: 'frame', kind: 'ghost', title: 'Frame selection (F)', onClick: () => viewport.frame(store.state.selection) }),
  button({ icon: 'copy', kind: 'ghost', title: 'Duplicate (Shift+D)', onClick: () => duplicate() }),
  button({ icon: 'trash', kind: 'ghost', title: 'Delete (Backspace)', onClick: () => removeSelected() }),
);
$('hud').append(selBox);
function refreshSel() {
  const o = store.state.selection && store.object(store.state.selection);
  selBox.hidden = !o;
  if (o) selName.textContent = `${o.id} · ${o.type}`;
  gizmoSeg.value = store.state.gizmo;
}

// ---------- help (top right) ----------
const SHORTCUTS = [
  ['Click', 'aim the camera at that point'], ['Ctrl Click', 'select an object (⌘ works too)'], ['W E R', 'move / rotate / scale'], ['F', 'frame selection (or all)'],
  ['Shift D', 'duplicate'], ['⌫', 'delete object or key'], ['Esc', 'deselect'],
  ['Space', 'play / pause'], ['K', 'key the current view at the playhead'], ['X', 'cut at the playhead (new shot on the next frame)'], ['C', 'Free ↔ Shot camera'],
  ['← →', 'step a frame (Shift: 1 s)'], ['Home', 'go to start'], ['/', 'prompt your agent'], ['⌘Z ⇧⌘Z', 'undo / redo'], ['⌘S', 'save / load scenes'],
];
const helpPanel = panel({ title: 'Shortcuts', collapsible: false });
helpPanel.classList.add('help-panel');
helpPanel.hidden = true;
helpPanel.body.append(...SHORTCUTS.map(([k, v]) => h('div.help-row', {}, h('span.help-key', {}, ...k.split(' ').map(kbd)), h('span.help-text', {}, v))),
  h('div.cc-label.help-foot', {}, 'Orbit: drag · Pan: right-drag · Zoom: scroll'));
const helpBtn = button({ icon: 'keyboard', kind: 'ghost', title: 'Shortcuts (?)', onClick: () => { helpPanel.hidden = !helpPanel.hidden; helpBtn.setActive(!helpPanel.hidden); } });
const saves = mountSaves($('corner'), { viewport });
document.body.append(helpPanel);
// top-right menu, one pill: Scenes · | · Shortcuts · Chat toggle
$('corner').append(saves.btn, h('span.cc-divider'), helpBtn, prompt.toggleBtn);

// ---------- controls dock (right) ----------
const ctxFor = (c) => ({
  doc: () => store.doc,
  op: (ops) => store.op(ops, c.id),
  on: (evt, fn) => store.on(evt, fn),
  get state() { return store.state; },
  set: (patch) => store.set(patch),
  selected: () => store.object(store.state.selection),
  value: (key, fallback) => store.doc.controls[`${c.id}.${key}`] ?? fallback,
  setValue: (key, value) => store.op({ op: 'controls.set', key: `${c.id}.${key}`, value }, c.id),
  viewport,
});
let controlsMounted = false;
function mountControls() {
  if (controlsMounted || !controls.length) return;
  controlsMounted = true;
  for (const c of controls) {
    try {
      const p = panel({ title: c.title || c.id, id: c.id });
      $('dock').append(p);
      c.mount(p.body, ctxFor(c));
    } catch (e) { console.error(e); toast(`control "${c.id}" failed: ${e.message}`, { kind: 'error' }); }
  }
}

// ---------- actions ----------
async function duplicate() {
  const id = store.state.selection; if (!id) return;
  const [r] = await store.op({ op: 'duplicate', id }, 'duplicate');
  store.set({ selection: r.id });
}
async function removeSelected() {
  const id = store.state.selection; if (!id) return;
  store.set({ selection: null });
  await store.op({ op: 'remove', id }, 'delete');
}
const undo = () => store.post('/api/undo').then((r) => !r.ok && toast(r.error));
const redo = () => store.post('/api/redo').then((r) => !r.ok && toast(r.error));
const step = (dt) => { store.set({ playing: false }); timeline.seek(store.state.time + dt); };

addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && k === 'y') { e.preventDefault(); return redo(); }
  if (mod) return;
  const f = store.doc?.timeline.fps || 24;
  const map = {
    ' ': () => store.set({ playing: !store.state.playing }),
    w: () => store.set({ gizmo: 'translate' }), e: () => store.set({ gizmo: 'rotate' }), r: () => store.set({ gizmo: 'scale' }),
    f: () => viewport.frame(store.state.selection),
    k: () => timeline.keyFromView(),
    x: () => timeline.cutHere(),
    c: () => store.set({ view: store.state.view === 'shot' ? 'free' : 'shot' }),
    escape: () => { store.set({ selection: null, key: null }); helpPanel.hidden = true; helpBtn.setActive(false); },
    backspace: () => (store.state.selection ? removeSelected() : timeline.deleteKey()),
    delete: () => (store.state.selection ? removeSelected() : timeline.deleteKey()),
    arrowleft: () => step(e.shiftKey ? -1 : -1 / f), arrowright: () => step(e.shiftKey ? 1 : 1 / f),
    home: () => timeline.seek(0), end: () => timeline.seek(store.doc.timeline.duration),
    '/': () => prompt.focus(), '?': () => { helpPanel.hidden = !helpPanel.hidden; helpBtn.setActive(!helpPanel.hidden); },
  };
  if (e.shiftKey && k === 'd') { e.preventDefault(); return duplicate(); }
  const fn = map[k];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------- RPC: methods the agent can call through the server ----------
const RPC = {
  camera: () => viewport.getPose(),
  state: () => ({ ...store.state }),
  seek: ({ t }) => { timeline.seek(t); return { time: store.state.time }; },
  play: () => { store.set({ playing: true }); return { playing: true }; },
  pause: () => { store.set({ playing: false }); return { playing: false, time: store.state.time }; },
  view: ({ mode }) => {
    if (!['free', 'shot'].includes(mode)) throw new Error('view must be "free" or "shot"');
    store.set({ view: mode }); return { view: mode };
  },
  select: ({ id }) => {
    if (id && !store.object(id)) throw new Error(`no object "${id}"`);
    store.set({ selection: id || null }); return { selection: id || null };
  },
  frame: ({ id }) => { viewport.frame(id); return viewport.getPose(); },
  snapshot: (p) => renderer.snapshot(p),
  storyboard: (p) => renderer.storyboard(p),
  export: (p) => renderer.exportVideo(p),
};

// ---------- server connection ----------
let firstDoc = true;
function connect() {
  const es = new EventSource(`/api/events?client=${store.clientId}`);
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('doc', ({ doc, rev, source }) => {
    store.doc = doc; store.rev = rev;
    viewport.sync(doc);
    if (firstDoc) {
      firstDoc = false;
      if (store.state.time > doc.timeline.duration) store.state.time = 0;
      viewport._applyView();
      mountControls();
    }
    if (source === 'agent' || source === 'file') store.set({ camDirty: false });
    if (store.state.key && !store.keyById(store.state.key)) store.set({ key: null });
    if (store.state.time > doc.timeline.duration) store.set({ time: doc.timeline.duration });
    store.emit('doc', doc);
  });
  // listen: listen mode with a live agent behind it; listenStale: on, but its agent has gone quiet
  on('status', (s) => store.set({ agent: s.agent, working: s.working, listen: s.listenLive ?? s.listen, listenStale: !!s.listen && s.listenLive === false, launch: s.launch || null }));
  on('prompt', (p) => store.emit('prompt', p));
  on('say', (m) => store.emit('say', m));
  on('history', (h) => store.emit('history', h));
  on('reload', () => location.reload());
  on('saves', (s) => store.emit('saves', s));
  on('rpc', async ({ id, method, params }) => {
    let result, error;
    try {
      const fn = RPC[method];
      if (!fn) throw new Error(`unknown method "${method}" (methods: ${Object.keys(RPC).join(', ')})`);
      result = await fn(params || {});
    } catch (e) { error = e.message || String(e); }
    store.post('/api/rpc/result', { id, result, error });
  });
  es.onerror = () => { $('offline').hidden = false; };
  es.onopen = () => { $('offline').hidden = true; };
}
connect();

const presence = () => store.post('/api/presence', { client: store.clientId, visible: document.visibilityState === 'visible' });
document.addEventListener('visibilitychange', presence);
setInterval(presence, 10000);

store.on('error', (msg) => toast(msg, { kind: 'error', ms: 5000 }));
store.on('state', (c) => { if (c.selection || c.gizmo) refreshSel(); });
refreshSel();

// ---------- frame loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (store.doc && store.state.playing) {
    const D = store.doc.timeline.duration;
    let t = store.state.time + dt;
    if (t >= D) { if (store.state.loop) t %= D; else { t = D; store.set({ playing: false }); } }
    store.set({ time: t, camDirty: false });
  }
  viewport.tick();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
