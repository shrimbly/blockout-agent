// Camera timeline: transport, keyframe track, selected-key controls and the easing / speed curve editor.

import { h, button, segmented, number, select, icon, toast } from './ui/kit.js';
import { EASES, bezier, bezierSpeed, resolveEase, easeName, sampleCamera, fovToLens, lensToFov } from '/core/curves.js';
import { store } from './store.js';

const PAD = 14;
const EASE_OPTIONS = Object.keys(EASES).map((k) => ({ value: k, label: k }));

export function mountTimeline(root, { viewport, exporter }) {
  // ---------- bar ----------
  const playBtn = button({ icon: 'play', title: 'Play / pause (Space)', kind: 'ghost', onClick: () => store.set({ playing: !store.state.playing }) });
  const startBtn = button({ icon: 'start', title: 'Go to start (Home)', kind: 'ghost', onClick: () => seek(0) });
  const loopBtn = button({ icon: 'loop', title: 'Loop playback', kind: 'ghost', onClick: () => store.set({ loop: !store.state.loop }) });
  const timeEl = h('span.cc-mono.tl-time');
  const viewSeg = segmented({
    options: [{ value: 'free', label: 'Free', title: 'Orbit the set (C)' }, { value: 'shot', label: 'Shot', title: 'Look through the timeline camera (C)' }],
    value: store.state.view, onChange: (v) => store.set({ view: v }),
  });
  const keyBtn = button({ icon: 'keyAdd', label: 'Key', title: 'Key the current view at the playhead (K)', onClick: () => keyFromView() });

  // selected key controls
  const keyLabel = h('span.cc-chip.cc-mono');
  const easeSel = select({ options: [...EASE_OPTIONS, { value: 'custom', label: 'custom' }], title: 'Easing from this key to the next', onChange: (v) => { if (v !== 'custom') updateKey({ ease: v }); } });
  const lensNum = number({ step: 1, min: 8, max: 300, precision: 0, title: 'Lens (mm, full-frame equivalent)', width: 44, onChange: (v) => updateKey({ fov: +lensToFov(v).toFixed(3) }) });
  const toViewBtn = button({ icon: 'camera', title: 'Set this key to the current view', kind: 'ghost', onClick: () => { const p = viewport.getPose(); updateKey({ position: p.position, target: p.target, fov: p.fov }); } });
  const delKeyBtn = button({ icon: 'trash', title: 'Delete key', kind: 'ghost', onClick: () => deleteKey() });
  const keyGroup = h('div.tl-keyctl', {}, keyLabel, easeSel, h('span.cc-label', {}, 'mm'), lensNum, toViewBtn, delKeyBtn);
  const curveBtn = button({ icon: 'curve', title: 'Easing and speed curves', kind: 'ghost', onClick: () => curve.toggle() });

  const durNum = number({ step: 0.1, min: 0.1, max: 600, precision: 2, title: 'Duration (s). Shift-drag for big steps.', width: 50, onChange: (v) => store.op({ op: 'timeline', duration: v }) });
  const fpsNum = number({ step: 1, min: 1, max: 120, precision: 0, title: 'Frames per second', width: 36, onChange: (v) => store.op({ op: 'timeline', fps: v }) });
  const exportBtn = button({ icon: 'film', label: 'Export', kind: 'primary', title: 'Render the blockout video (mp4)', onClick: () => exporter.exportVideo().catch((e) => toast(e.message, { kind: 'error' })) });

  const bar = h('div.tl-bar',
    {}, startBtn, playBtn, timeEl, h('span.cc-divider'), viewSeg, keyBtn, keyGroup, curveBtn,
    h('span.cc-spacer'), h('span.cc-label', {}, 'dur'), durNum, h('span.cc-label', {}, 'fps'), fpsNum, loopBtn, h('span.cc-divider'), exportBtn);

  // ---------- track ----------
  const track = h('canvas.tl-track');
  root.append(bar, track);
  const ctx = track.getContext('2d');
  let drag = null; // { kind: 'key'|'scrub', id, t, moved }

  const dur = () => store.doc.timeline.duration;
  const fps = () => store.doc.timeline.fps;
  const width = () => track.clientWidth;
  const xOf = (t) => PAD + (t / dur()) * (width() - PAD * 2);
  const tOf = (x) => Math.max(0, Math.min(dur(), ((x - PAD) / (width() - PAD * 2)) * dur()));
  const snap = (t, e) => (e?.shiftKey ? t : Math.round(t * fps()) / fps());
  const keys = () => [...store.doc.timeline.keys].sort((a, b) => a.t - b.t);
  const keyAt = (x) => keys().find((k) => Math.abs(xOf(drag?.kind === 'key' && drag.id === k.id ? drag.t : k.t) - x) < 8);

  function seek(t) { store.set({ time: Math.max(0, Math.min(dur(), t)), camDirty: false }); }

  track.addEventListener('pointerdown', (e) => {
    const x = e.offsetX;
    const k = keyAt(x);
    track.setPointerCapture(e.pointerId);
    if (k && e.button === 0) {
      drag = { kind: 'key', id: k.id, t: k.t, t0: k.t, moved: false };
      store.set({ key: k.id });
      seek(k.t);
    } else if (e.button === 0) {
      drag = { kind: 'scrub', moved: false };
      store.set({ playing: false });
      seek(snap(tOf(x), e));
    }
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) { track.style.cursor = keyAt(e.offsetX) ? 'grab' : 'default'; return; }
    drag.moved = true;
    const t = snap(tOf(e.offsetX), e);
    if (drag.kind === 'key') { drag.t = t; seek(t); }
    else seek(t);
    draw();
  });
  track.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.kind === 'key' && d.moved && Math.abs(d.t - d.t0) > 1e-4) {
      store.op({ op: 'key.update', id: d.id, t: d.t }, 'retime key').catch(() => {});
    }
    if (d.kind === 'scrub' && !d.moved && !keyAt(e.offsetX)) store.set({ key: null });
    draw();
  });
  track.addEventListener('dblclick', (e) => { if (!keyAt(e.offsetX)) keyFromView(snap(tOf(e.offsetX), e)); });
  track.addEventListener('contextmenu', (e) => { const k = keyAt(e.offsetX); if (k) { e.preventDefault(); store.set({ key: k.id }); deleteKey(); } });

  // ---------- actions ----------
  async function keyFromView(t = store.state.time) {
    const p = viewport.getPose();
    const [r] = await store.op({ op: 'key.add', t: +t.toFixed(3), position: p.position, target: p.target, fov: p.fov }, 'key camera');
    store.set({ key: r.id, camDirty: false });
    toast(r.replaced ? `Updated key at ${t.toFixed(2)}s` : `Keyed camera at ${t.toFixed(2)}s`);
  }
  function updateKey(patch) {
    const id = store.state.key;
    if (!id) return;
    store.op({ op: 'key.update', id, ...patch }, 'edit key').then(() => store.set({ camDirty: false })).catch(() => {});
  }
  function deleteKey() {
    const id = store.state.key;
    if (!id) return;
    store.op({ op: 'key.remove', id }, 'delete key').then(() => store.set({ key: null })).catch(() => {});
  }

  // ---------- drawing ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function draw() {
    if (!store.doc) return;
    const dpr = devicePixelRatio || 1;
    const W = track.clientWidth, H = track.clientHeight;
    if (track.width !== Math.round(W * dpr) || track.height !== Math.round(H * dpr)) { track.width = Math.round(W * dpr); track.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const text = css('--cc-text'), dim = css('--cc-text-faint'), line = css('--cc-line'), accent = css('--cc-accent');
    const D = dur(), F = fps();
    const mid = H / 2 + 6;

    // ruler
    ctx.font = `10px ${css('--cc-mono')}`;
    ctx.textBaseline = 'top';
    const pxPerSec = (W - PAD * 2) / D;
    const step = pxPerSec > 120 ? 0.5 : pxPerSec > 40 ? 1 : pxPerSec > 16 ? 2 : 5;
    ctx.fillStyle = dim;
    if (pxPerSec / F > 5) { // frame ticks
      ctx.globalAlpha = 0.5;
      for (let f = 0; f <= D * F; f++) ctx.fillRect(Math.round(xOf(f / F)), 0, 1, 3);
      ctx.globalAlpha = 1;
    }
    for (let t = 0; t <= D + 1e-6; t += step) {
      const x = Math.round(xOf(t));
      ctx.fillRect(x, 0, 1, 6);
      ctx.fillText(`${+t.toFixed(1)}s`, x + 3, 1);
    }
    // baseline
    ctx.fillStyle = line;
    ctx.fillRect(PAD, mid, W - PAD * 2, 1);

    // shot speed curve, faint, across the whole track
    const speed = resolveEase(store.doc.timeline.speed ?? 'linear');
    if (easeName(speed) !== 'linear') {
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.25; ctx.beginPath();
      for (let i = 0; i <= 80; i++) { const u = i / 80; const y = H - 4 - bezier(speed, u) * (H - 18); i ? ctx.lineTo(xOf(u * D), y) : ctx.moveTo(xOf(u * D), y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // segments: tiny ease glyph between keys
    const ks = keys().map((k) => (drag?.kind === 'key' && drag.id === k.id ? { ...k, t: drag.t } : k)).sort((a, b) => a.t - b.t);
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      const x0 = xOf(a.t), x1 = xOf(b.t);
      if (x1 - x0 < 14) continue;
      const e = resolveEase(a.ease);
      const top = mid - 11, bot = mid + 11;
      ctx.strokeStyle = a.id === store.state.key ? accent : dim;
      ctx.globalAlpha = a.id === store.state.key ? 0.9 : 0.55;
      ctx.beginPath();
      const n = Math.max(8, Math.round((x1 - x0) / 4));
      for (let j = 0; j <= n; j++) {
        const u = j / n;
        const y = bot - bezier(e, u) * (bot - top);
        j ? ctx.lineTo(x0 + u * (x1 - x0), y) : ctx.moveTo(x0, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (x1 - x0 > 70) {
        ctx.fillStyle = dim; ctx.textBaseline = 'bottom';
        ctx.fillText(easeName(a.ease), x0 + 8, H - 2);
        ctx.textBaseline = 'top';
      }
    }

    // keys
    for (const k of ks) {
      const x = xOf(k.t), sel = k.id === store.state.key, r = sel ? 6 : 5;
      ctx.beginPath();
      if (k.ease === 'hold') ctx.rect(x - r + 1, mid - r + 1, 2 * r - 2, 2 * r - 2);
      else { ctx.moveTo(x, mid - r); ctx.lineTo(x + r, mid); ctx.lineTo(x, mid + r); ctx.lineTo(x - r, mid); ctx.closePath(); }
      ctx.fillStyle = sel ? accent : text;
      ctx.fill();
    }

    // playhead
    const px = Math.round(xOf(store.state.time));
    ctx.fillStyle = accent;
    ctx.fillRect(px, 0, 1.5, H);
    ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 5.5, 0); ctx.lineTo(px + 0.75, 6); ctx.closePath(); ctx.fill();
  }

  // ---------- bar state ----------
  function refresh() {
    if (!store.doc) return;
    const tl = store.doc.timeline;
    const t = store.state.time;
    timeEl.textContent = `${t.toFixed(2)}s / ${tl.duration.toFixed(2)}s  f${Math.round(t * tl.fps)}`;
    playBtn.replaceChildren(icon(store.state.playing ? 'pause' : 'play'));
    loopBtn.setActive(store.state.loop);
    viewSeg.value = store.state.view;
    keyBtn.setActive(store.state.camDirty);
    keyBtn.title = store.state.camDirty ? 'The camera moved: press K to key this framing' : 'Key the current view at the playhead (K)';
    durNum.set(tl.duration); fpsNum.set(tl.fps);
    const k = store.state.key && store.keyById(store.state.key);
    keyGroup.style.display = k ? '' : 'none';
    if (k) {
      const sorted = keys();
      const i = sorted.findIndex((x) => x.id === k.id);
      keyLabel.textContent = `${k.id} @ ${k.t.toFixed(2)}s`;
      const name = easeName(k.ease);
      easeSel.value = name;
      easeSel.disabled = i === sorted.length - 1;
      easeSel.title = i === sorted.length - 1 ? 'Last key: no segment after it' : 'Easing from this key to the next';
      lensNum.set(Math.round(fovToLens(k.fov)));
    }
    exportBtn.disabled = store.state.exporting;
    draw();
    curve.refresh();
  }

  // ---------- curve editor ----------
  const curve = mountCurveEditor(root, { updateKey, keys, onToggle: (open) => curveBtn.setActive(open), anchor: () => curveBtn });

  store.on('doc', refresh);
  store.on('state', refresh);
  new ResizeObserver(draw).observe(track);
  return { refresh, keyFromView, seek, deleteKey, draw };
}

/** Popover with a draggable cubic-bezier for the segment at the playhead, or the shot-wide speed curve. */
function mountCurveEditor(root, { updateKey, keys, onToggle, anchor }) {
  const W = 260, H = 170, M = 18;
  const cv = h('canvas.curve-canvas', { width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px` } });
  const ctx = cv.getContext('2d');
  let mode = 'segment';
  const tabs = segmented({ options: [{ value: 'segment', label: 'Segment', title: 'Ease between two keys' }, { value: 'speed', label: 'Shot speed', title: 'Time remap across the whole shot' }], value: mode, onChange: (v) => { mode = v; refresh(); } });
  const title = h('span.cc-label.cc-mono');
  const presets = h('div.curve-presets');
  const help = h('div.curve-help.cc-label');
  const closeBtn = button({ icon: 'close', kind: 'ghost', title: 'Close', onClick: () => toggle(false) });
  const pop = h('div.cc-panel.curve-pop', { hidden: true }, h('div.cc-row', {}, tabs, h('span.cc-spacer'), closeBtn), title, cv, presets, help);
  root.append(pop);

  let live = null;   // bezier being dragged
  let dragging = -1; // handle index
  const api = { open: false, toggle, refresh };

  const toX = (x) => M + x * (W - 2 * M);
  const toY = (y) => H - M - ((y + 0.25) / 1.5) * (H - 2 * M); // y range [-0.25, 1.25]
  const fromX = (px) => Math.min(1, Math.max(0, (px - M) / (W - 2 * M)));
  const fromY = (py) => Math.min(1.6, Math.max(-0.6, ((H - M - py) / (H - 2 * M)) * 1.5 - 0.25));

  function target() {
    const tl = store.doc.timeline;
    if (mode === 'speed') return { kind: 'speed', ease: tl.speed ?? 'linear', label: `whole shot · ${tl.duration}s` };
    const ks = keys();
    if (ks.length < 2) return null;
    let i = ks.findIndex((k) => k.id === store.state.key);
    if (i < 0 || i === ks.length - 1) i = sampleCamera(tl, store.state.time)?.segment ?? 0;
    i = Math.min(i, ks.length - 2);
    return { kind: 'segment', key: ks[i], next: ks[i + 1], ease: ks[i].ease, label: `${ks[i].id} → ${ks[i + 1].id} · ${(ks[i + 1].t - ks[i].t).toFixed(2)}s` };
  }

  function commit(ease) {
    const tg = target();
    if (!tg) return;
    if (tg.kind === 'speed') store.op({ op: 'timeline', speed: ease }, 'speed curve').catch(() => {});
    else { store.set({ key: tg.key.id }); updateKey({ ease }); }
  }

  function draw() {
    const tg = target();
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const line = css('--cc-line'), text = css('--cc-text'), accent = css('--cc-accent'), faint = css('--cc-text-faint');
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.strokeRect(toX(0), toY(1), toX(1) - toX(0), toY(0) - toY(1));
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(toX(0), toY(0)); ctx.lineTo(toX(1), toY(1)); ctx.stroke();
    ctx.setLineDash([]);
    if (!tg) { ctx.fillStyle = faint; ctx.font = '11px sans-serif'; ctx.fillText('Add a second key to ease between them', 30, H / 2); return; }
    const b = live || resolveEase(tg.ease);

    // speed (velocity) plot, filled
    if (b !== 'hold') {
      let maxS = 1;
      for (let i = 0; i <= 60; i++) maxS = Math.max(maxS, bezierSpeed(b, i / 60));
      ctx.fillStyle = accent; ctx.globalAlpha = 0.1; ctx.beginPath(); ctx.moveTo(toX(0), toY(-0.25));
      for (let i = 0; i <= 60; i++) { const u = i / 60; ctx.lineTo(toX(u), toY(-0.25) - (bezierSpeed(b, u) / maxS) * (toY(-0.25) - toY(0.6))); }
      ctx.lineTo(toX(1), toY(-0.25)); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = faint; ctx.font = '9px sans-serif'; ctx.fillText('speed', toX(0) + 3, toY(-0.25) - 3);
    }
    // curve
    ctx.strokeStyle = text; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 100; i++) { const u = i / 100; const y = bezier(b, u); i ? ctx.lineTo(toX(u), toY(y)) : ctx.moveTo(toX(u), toY(y)); }
    ctx.stroke(); ctx.lineWidth = 1;
    if (b === 'hold') return;
    // handles
    const hs = [[b[0], b[1], 0, 0], [b[2], b[3], 1, 1]];
    for (const [x, y, ax, ay] of hs) {
      ctx.strokeStyle = accent; ctx.beginPath(); ctx.moveTo(toX(ax), toY(ay)); ctx.lineTo(toX(x), toY(y)); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(toX(x), toY(y), 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', (e) => {
    const tg = target(); if (!tg) return;
    const b = resolveEase(tg.ease); if (b === 'hold') return;
    const [x, y] = pos(e);
    const d0 = Math.hypot(toX(b[0]) - x, toY(b[1]) - y), d1 = Math.hypot(toX(b[2]) - x, toY(b[3]) - y);
    dragging = d0 < d1 ? 0 : 1;
    if (Math.min(d0, d1) > 24) { dragging = -1; return; }
    live = [...b];
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragging < 0) return;
    const [x, y] = pos(e);
    live[dragging * 2] = +fromX(x).toFixed(3);
    live[dragging * 2 + 1] = +fromY(y).toFixed(3);
    draw();
  });
  cv.addEventListener('pointerup', () => {
    if (dragging < 0) return;
    dragging = -1;
    const b = live; live = null;
    const name = easeName(b);
    commit(name !== 'custom' ? name : b);
  });

  function refresh() {
    if (!api.open || !store.doc) return;
    const tg = target();
    title.textContent = tg ? tg.label : '';
    const current = tg ? easeName(tg.ease) : '';
    presets.replaceChildren(...Object.keys(EASES).filter((k) => !(mode === 'speed' && k === 'hold')).map((k) =>
      button({ label: k, kind: 'ghost', active: k === current, onClick: () => commit(k) })));
    help.textContent = mode === 'speed'
      ? 'Remaps time across the whole shot: ease-in starts slow and ends fast. Applied on top of each segment ease.'
      : 'How the camera travels between the two keys. The shaded area is its speed. Drag the orange handles.';
    draw();
  }

  function toggle(on = !api.open) {
    api.open = on; pop.hidden = !on; onToggle?.(on);
    if (on && anchor) { const r = anchor().getBoundingClientRect(); pop.style.left = `${Math.max(12, Math.min(innerWidth - 304, r.left - 140))}px`; }
    refresh();
  }
  return api;
}
