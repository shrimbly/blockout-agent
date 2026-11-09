// Camera timeline: transport, keyframe track, selected-key controls and the easing / speed curve editor.

import { h, button, segmented, number, select, icon, toast, affix, panel, toggle as onOff } from './ui/kit.js';
import { EASES, bezier, bezierSpeed, resolveEase, easeName, sampleCamera, fovToLens, lensToFov, isCut } from '/core/curves.js';
import { store } from './store.js';

const PAD = 14;
const SIZES = [[1280, 720], [1920, 1080], [3840, 2160], [1080, 1920], [1080, 1080], [1440, 1080]];
const RETIME_KEY = 'cc-retime';

/** Run fn only when key changed since the last call for this element. Refreshes run every frame while
 *  playing; rebuilding a button's children under the pointer swallows clicks, and rebuilding a select closes it. */
function changed(el, key, fn) { key = JSON.stringify(key); if (el._ccKey !== key) { el._ccKey = key; fn(); } }

/** A tiny inline SVG of an ease curve, for buttons. */
export function easeSvg(ease, size = 14) {
  const b = resolveEase(ease);
  let d = '';
  if (b === 'hold') d = 'M2 13H13V3';
  else for (let i = 0; i <= 16; i++) { const u = i / 16; d += `${i ? 'L' : 'M'}${(2 + u * 12).toFixed(2)} ${(13 - bezier(b, u) * 10).toFixed(2)}`; }
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
const fmtFps = (v) => String(+(+v).toFixed(3));

export function mountTimeline(root, { viewport, exporter }) {
  // ---------- bar: play | camera | output ----------
  const playBtn = button({ icon: 'play', title: 'Play / pause (Space)', onClick: () => store.set({ playing: !store.state.playing }) });
  const startBtn = button({ icon: 'start', title: 'Go to start (Home)', kind: 'ghost', onClick: () => seek(0) });
  const loopBtn = button({ icon: 'loop', title: 'Loop playback', kind: 'ghost', onClick: () => store.set({ loop: !store.state.loop }) });
  const timeNow = h('span');
  const timeDur = h('span.tl-faint');
  const frameEl = h('span.cc-mono.tl-faint.tl-frame', { title: 'Frame at the playhead' });
  const timeEl = h('span.cc-mono.tl-time', {}, timeNow, timeDur);
  const viewSeg = segmented({
    options: [{ value: 'free', label: 'Free', icon: 'orbit', title: 'Orbit the set (C)' }, { value: 'shot', label: 'Shot', icon: 'camera', title: 'Look through the timeline camera (C)' }],
    value: store.state.view, onChange: (v) => store.set({ view: v }),
  });
  const keyBtn = button({ icon: 'keyAdd', label: 'Key', title: 'Key the current view at the playhead (K)', onClick: () => keyFromView() });
  const cutBtn = button({ icon: 'cut', label: 'Cut', title: 'Cut at the playhead: this shot ends here and a new one starts on the next frame (X)', onClick: () => cutHere() });
  // Key the selected object where it is now, at the playhead. Once it has a key, dragging it with the
  // gizmo at another time adds the next key, so a move is: key, scrub, drag.
  const objKeyLabel = h('span');
  const objKeyBtn = h('button.cc-btn.tl-objkey', { type: 'button', onClick: () => keyObject() }, h('span.tl-odot'), objKeyLabel);

  // selected key: time, ease (opens the curve editor), lens, set to view, delete
  const keyTime = h('span.cc-mono.tl-keytime');
  const easeGlyph = h('span.tl-glyph');
  const easeName_ = h('span');
  const easeBtn = h('button.cc-field.tl-ease', { type: 'button', onClick: () => curve.toggle(undefined, 'segment') }, easeGlyph, easeName_, icon('chevronDown'));
  // Lens: sets the selected key's focal length and the free camera's, so the free view looks through the
  // same lens you are keying. With no key selected it sets just the free camera.
  const lensNum = number({ step: 1, min: 8, max: 300, precision: 0, title: 'Lens (mm, full-frame equivalent): the selected key and the free view', width: 34, onInput: (v) => viewport.setFreeFov(lensToFov(v)), onChange: (v) => {
    const fov = +lensToFov(v).toFixed(3);
    viewport.setFreeFov(fov);
    if (store.state.key) updateKey({ fov });
  } });
  const lensField = affix(lensNum, 'mm');
  const toViewBtn = button({ icon: 'aim', title: 'Set this key to the current view', kind: 'ghost', onClick: () => { const p = viewport.getPose(); updateKey({ position: p.position, target: p.target, fov: p.fov }); } });
  const delKeyBtn = button({ icon: 'trash', title: 'Delete key', kind: 'ghost', onClick: () => deleteKey() });
  const keyGroup = h('div.tl-key', {}, h('span.tl-diamond'), keyTime, easeBtn, toViewBtn, delKeyBtn);

  // output: shot settings chip + export
  const shotDur = h('span'), shotFps = h('span');
  const shotBtn = h('button.cc-btn.tl-shot', { type: 'button', title: 'Shot length, frame rate and size', onClick: () => shot.toggle() },
    h('span.cc-mono', {}, shotDur, h('span.cc-affix__unit', {}, ' s')), h('span.tl-faint', {}, '·'), h('span.cc-mono', {}, shotFps, h('span.cc-affix__unit', {}, ' fps')), icon('chevronDown'));
  const exportBtn = button({ icon: 'film', label: 'Export', kind: 'primary', title: 'Render the blockout video (mp4)', onClick: () => exporter.exportVideo().catch((e) => toast(e.message, { kind: 'error' })) });

  const bar = h('div.tl-bar',
    {}, startBtn, playBtn, loopBtn, timeEl, frameEl, h('span.cc-divider'), viewSeg, keyBtn, cutBtn, lensField, keyGroup, objKeyBtn,
    h('span.cc-spacer'), shotBtn, exportBtn);

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
  // While a key is dragged, it (and the other half of its cut) is drawn at the drag time.
  const liveKeys = () => keys().map((k) => (drag?.kind === 'key' && drag.id === k.id ? { ...k, t: drag.t }
    : drag?.kind === 'key' && drag.partner === k.id ? { ...k, t: drag.t + drag.offset } : k)).sort((a, b) => a.t - b.t);
  /** Cuts: every hold key (except the last) ends a shot, and the camera cuts to the next key. A hold key and
   *  the next key within a frame or so of each other are one "split" key either side of the cut line. */
  const cutsOf = (ks) => {
    const out = [];
    for (let i = 0; i < ks.length - 1; i++) {
      if (!isCut(ks[i])) continue;
      const a = ks[i], b = ks[i + 1], tight = b.t - a.t <= 1.5 / fps() + 1e-6;
      out.push({ a, b, tight, x: tight ? (xOf(a.t) + xOf(b.t)) / 2 : xOf(b.t) - 3 });
    }
    return out;
  };
  const keyXs = (ks) => {
    const xs = new Map(ks.map((k) => [k.id, xOf(k.t)]));
    for (const c of cutsOf(ks)) { if (c.tight) xs.set(c.a.id, c.x - 3); xs.set(c.b.id, c.x + 4); }
    return xs;
  };
  const keyAt = (x) => {
    const ks = liveKeys(), xs = keyXs(ks);
    let best = null, bd = 8;
    for (const k of ks) { const d = Math.abs(xs.get(k.id) - x); if (d < bd) { bd = d; best = k; } }
    return best && keys().find((k) => k.id === best.id);
  };
  /** The other key of a tight cut, so dragging either half moves the cut as one. */
  const cutPartner = (k) => {
    const c = cutsOf(keys()).find((c) => c.tight && (c.a.id === k.id || c.b.id === k.id));
    return c ? (c.a.id === k.id ? c.b : c.a) : null;
  };

  const selObj = () => (store.state.selection && store.object(store.state.selection)) || null;
  const okeys = () => selObj()?.anim || [];
  const laneY = () => track.clientHeight - 8; // object keys sit in a lane under the camera keys
  const okeyAt = (x, y) => (y > laneY() - 8 ? okeys().find((k) => Math.abs(xOf(drag?.kind === 'okey' && drag.t0 === k.t ? drag.t : k.t) - x) < 7) : null);

  function seek(t) { store.set({ time: Math.max(0, Math.min(dur(), t)), camDirty: false }); }

  track.addEventListener('pointerdown', (e) => {
    const x = e.offsetX;
    const ok = okeyAt(x, e.offsetY);
    const k = ok ? null : keyAt(x);
    track.setPointerCapture(e.pointerId);
    if (ok && e.button === 0) {
      drag = { kind: 'okey', id: selObj().id, t: ok.t, t0: ok.t, moved: false };
      store.set({ playing: false });
      seek(ok.t);
    } else if (k && e.button === 0) {
      const p = cutPartner(k);
      drag = { kind: 'key', id: k.id, t: k.t, t0: k.t, moved: false, partner: p?.id, offset: p ? p.t - k.t : 0 };
      store.set({ key: k.id });
      seek(k.t);
    } else if (e.button === 0) {
      drag = { kind: 'scrub', moved: false };
      store.set({ playing: false });
      seek(snap(tOf(x), e));
    }
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) { track.style.cursor = okeyAt(e.offsetX, e.offsetY) || keyAt(e.offsetX) ? 'grab' : 'default'; return; }
    drag.moved = true;
    const t = snap(tOf(e.offsetX), e);
    if (drag.kind === 'key' || drag.kind === 'okey') { drag.t = t; seek(t); }
    else seek(t);
    draw();
  });
  track.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.kind === 'key' && d.moved && Math.abs(d.t - d.t0) > 1e-4) {
      const ops = [{ op: 'key.update', id: d.id, t: +d.t.toFixed(3) }];
      if (d.partner) ops.push({ op: 'key.update', id: d.partner, t: +(d.t + d.offset).toFixed(3) });
      store.op(ops, d.partner ? 'move cut' : 'retime key').catch(() => {});
    }
    if (d.kind === 'okey' && d.moved && Math.abs(d.t - d.t0) > 1e-4) {
      const k = store.object(d.id)?.anim?.find((x) => Math.abs(x.t - d.t0) < 1e-3);
      if (k) store.op([{ op: 'anim.remove', id: d.id, t: d.t0 }, { op: 'anim.key', id: d.id, t: +d.t.toFixed(3), position: k.position, rotation: k.rotation, scale: k.scale, ease: k.ease }], `retime ${d.id} key`).catch(() => {});
    }
    if (d.kind === 'scrub' && !d.moved && !keyAt(e.offsetX)) store.set({ key: null });
    draw();
  });
  track.addEventListener('dblclick', (e) => { if (!keyAt(e.offsetX)) keyFromView(snap(tOf(e.offsetX), e)); });
  track.addEventListener('contextmenu', (e) => {
    const ok = okeyAt(e.offsetX, e.offsetY);
    if (ok) { e.preventDefault(); store.op({ op: 'anim.remove', id: selObj().id, t: ok.t }, 'remove object key').catch(() => {}); return; }
    const k = keyAt(e.offsetX); if (k) { e.preventDefault(); store.set({ key: k.id }); deleteKey(); } });

  // ---------- actions ----------
  async function keyObject(t = store.state.time) {
    const o = selObj();
    if (!o) return;
    await store.op({ op: 'anim.key', id: o.id, t: +t.toFixed(3) }, `key ${o.id}`);
    toast(o.anim?.length ? `Keyed ${o.id} at ${t.toFixed(2)}s` : `Keyed ${o.id} at ${t.toFixed(2)}s. Move the playhead, then drag it to key the next spot`);
  }

  async function keyFromView(t = store.state.time) {
    const p = viewport.getPose();
    const [r] = await store.op({ op: 'key.add', t: +t.toFixed(3), position: p.position, target: p.target, fov: p.fov }, 'key camera');
    store.set({ key: r.id, camDirty: false });
    toast(r.replaced ? `Updated key at ${t.toFixed(2)}s` : `Keyed camera at ${t.toFixed(2)}s`);
  }
  /** Cut at the playhead: the current shot ends on this frame (a hold key with the camera as it is here) and
   *  a new shot starts on the next frame from the same framing, selected so it can be re-framed. */
  async function cutHere(t = store.state.time) {
    const tl = store.doc.timeline;
    if (!tl.keys.length) return toast('Key the camera first, then cut', { kind: 'error' });
    const F = tl.fps, f = 1 / F;
    t = Math.round(t * F) / F;
    if (t > tl.duration - f) return toast('Move the playhead before the end of the shot to cut there', { kind: 'error' });
    const ks = keys();
    const here = ks.find((k) => Math.abs(k.t - t) < 1e-3);
    if (here && isCut(here) && ks.some((k) => k.t > t && k.t - t <= 1.5 * f)) return toast(`There is already a cut at ${t.toFixed(2)}s`);
    if (ks.some((k) => k.t > t + 1e-3 && k.t - t <= 1.5 * f)) return toast('A key sits on the next frame: move the playhead to cut', { kind: 'error' });
    const s = sampleCamera(tl, t);
    const r3 = (v) => +v.toFixed(3);
    const pose = { position: s.position.map(r3), target: s.target.map(r3), fov: r3(s.fov), roll: r3(s.roll) };
    const seg = ks[s.segment];
    const ease = seg && !isCut(seg) && s.segment < ks.length - 1 ? seg.ease : 'easeInOut'; // the move carries on into the new shot
    const next = r3(t + f);
    const res = await store.op([{ op: 'key.add', t: r3(t), ...pose, ease: 'hold' }, { op: 'key.add', t: next, ...pose, ease }], 'cut');
    store.set({ key: res[1].id, time: next, playing: false, camDirty: false });
    const n = 1 + keys().filter((k) => isCut(k) && k.t < next - 1e-3).length;
    toast(`Cut at ${t.toFixed(2)}s. Shot ${n} starts here with the same framing: re-frame it, then press K`);
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

    const ks = liveKeys();
    const cuts = cutsOf(ks), xs = keyXs(ks);

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
      const label = `${+t.toFixed(1)}s`, w = ctx.measureText(label).width;
      if (!cuts.some((c) => x + 3 < c.x + 11 && x + 3 + w > c.x - 9)) ctx.fillText(label, x + 3, 1); // leave room for a cut's scissors
    }
    // shots and cuts: every hold key (but the last) ends a shot and the camera cuts to the next key.
    // With at least one cut, shots get a faint alternating band and a name; the baseline breaks at each cut.
    const edges = [PAD, ...cuts.map((c) => c.x), W - PAD];
    ctx.fillStyle = text; ctx.globalAlpha = 0.045;
    for (let i = 1; i < edges.length - 1; i += 2) ctx.fillRect(edges[i], 12, edges[i + 1] - edges[i], H - 12);
    ctx.globalAlpha = 1;
    ctx.fillStyle = line;
    for (let i = 0; i < edges.length - 1; i++) {
      const x0 = edges[i] + (i ? 7 : 0), x1 = edges[i + 1] - (i < edges.length - 2 ? 7 : 0);
      if (x1 > x0) ctx.fillRect(x0, mid, x1 - x0, 1);
    }
    // a long hold before a cut (the shot ends on a still): dotted from the hold key to the cut
    ctx.strokeStyle = dim; ctx.setLineDash([2, 3]); ctx.beginPath();
    for (const c of cuts) if (!c.tight && c.x - xs.get(c.a.id) > 10) { ctx.moveTo(xs.get(c.a.id) + 6, mid + 0.5); ctx.lineTo(c.x - 6, mid + 0.5); }
    ctx.stroke(); ctx.setLineDash([]);

    // shot speed curve, faint, across the whole track
    const speed = resolveEase(store.doc.timeline.speed ?? 'linear');
    if (easeName(speed) !== 'linear') {
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.25; ctx.beginPath();
      for (let i = 0; i <= 80; i++) { const u = i / 80; const y = H - 4 - bezier(speed, u) * (H - 18); i ? ctx.lineTo(xOf(u * D), y) : ctx.moveTo(xOf(u * D), y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // selected segment only: a soft "speed hump" showing how fast the camera moves from the selected key
    // to the next. Flat band = constant speed, a hill = speeds up then slows. Dotted = hold.
    const si = ks.findIndex((k) => k.id === store.state.key);
    if (si >= 0 && si < ks.length - 1) {
      const a = ks[si], b = ks[si + 1];
      const x0 = xs.get(a.id), x1 = xs.get(b.id);
      const e = resolveEase(a.ease);
      if (e === 'hold') {
        ctx.strokeStyle = accent; ctx.globalAlpha = 0.8; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x0, mid + 0.5); ctx.lineTo(x1, mid + 0.5); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      } else if (x1 - x0 >= 6) {
        const room = mid - 16, k = Math.min(10, room / 2.2); // linear sits at k px; peaks clamp to the room above the line
        const n = Math.max(16, Math.round((x1 - x0) / 3));
        const pts = [];
        for (let j = 0; j <= n; j++) {
          const u = j / n, v = bezierSpeed(e, u, 0.004);
          pts.push([x0 + u * (x1 - x0), mid - Math.max(-6, Math.min(room, v * k))]);
        }
        ctx.beginPath(); ctx.moveTo(x0, mid);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(x1, mid); ctx.closePath();
        ctx.fillStyle = accent; ctx.globalAlpha = 0.16; ctx.fill();
        ctx.globalAlpha = 0.9; ctx.strokeStyle = accent; ctx.beginPath();
        pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }

    // shot names, then the cut lines with a scissors tab over the ruler
    if (cuts.length) {
      ctx.font = `500 10px ${css('--cc-font')}`; ctx.fillStyle = dim;
      for (let i = 0; i < edges.length - 1; i++) if (edges[i + 1] - edges[i] >= 56) ctx.fillText(`Shot ${i + 1}`, edges[i] + (i ? 7 : 2), 14);
      ctx.font = `10px ${css('--cc-mono')}`;
    }
    const sunk = css('--cc-surface-sunk');
    for (const c of cuts) {
      const x = Math.round(c.x) + 0.5;
      ctx.fillStyle = text; ctx.fillRect(x - 0.75, 12, 1.5, H - 12);
      ctx.fillStyle = sunk; ctx.fillRect(x - 7, 0, 14, 12);
      ctx.strokeStyle = text; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x - 2.8, 8.6, 1.8, 0, Math.PI * 2); ctx.moveTo(x + 4.6, 8.6); ctx.arc(x + 2.8, 8.6, 1.8, 0, Math.PI * 2);
      ctx.moveTo(x - 1.5, 7.2); ctx.lineTo(x + 2.8, 1.2); ctx.moveTo(x + 1.5, 7.2); ctx.lineTo(x - 2.8, 1.2);
      ctx.stroke(); ctx.lineWidth = 1; ctx.lineCap = 'butt';
    }

    // keys. At a cut the pair becomes one split key: half square = the shot ends, half diamond = the next starts.
    const cutA = new Map(cuts.filter((c) => c.tight).map((c) => [c.a.id, c])), cutB = new Map(cuts.map((c) => [c.b.id, c]));
    for (const k of ks) {
      const x = xs.get(k.id), sel = k.id === store.state.key, r = sel ? 6 : 5;
      ctx.beginPath();
      if (cutA.has(k.id)) { const cx = Math.round(cutA.get(k.id).x) + 0.5; ctx.rect(cx - 1.5 - (r - 0.5), mid - r + 1, r - 0.5, 2 * r - 2); }
      else if (cutB.has(k.id)) { const cx = Math.round(cutB.get(k.id).x) + 0.5; ctx.moveTo(cx + 1.5, mid - r); ctx.lineTo(cx + 1.5 + r, mid); ctx.lineTo(cx + 1.5, mid + r); ctx.closePath(); }
      else if (k.ease === 'hold') ctx.rect(x - r + 1, mid - r + 1, 2 * r - 2, 2 * r - 2);
      else { ctx.moveTo(x, mid - r); ctx.lineTo(x + r, mid); ctx.lineTo(x, mid + r); ctx.lineTo(x - r, mid); ctx.closePath(); }
      ctx.fillStyle = sel ? accent : text;
      ctx.fill();
    }

    // selected object's keys, in a lane under the camera keys
    const oks = okeys();
    if (oks.length) {
      const y = laneY();
      const pts = oks.map((k) => (drag?.kind === 'okey' && Math.abs(drag.t0 - k.t) < 1e-3 ? drag.t : k.t)).sort((a, b) => a - b);
      ctx.fillStyle = accent; ctx.globalAlpha = 0.35;
      if (pts.length > 1) ctx.fillRect(xOf(pts[0]), y - 0.5, xOf(pts[pts.length - 1]) - xOf(pts[0]), 1.5);
      ctx.globalAlpha = 1;
      for (const t of pts) {
        ctx.beginPath(); ctx.arc(xOf(t), y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = css('--cc-surface-solid'); ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = accent; ctx.stroke(); ctx.lineWidth = 1;
      }
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
    timeNow.textContent = t.toFixed(2);
    timeDur.textContent = ` / ${tl.duration.toFixed(2)} s`;
    frameEl.textContent = `f${Math.round(t * tl.fps)}`;
    // only swap the icon when play state flips: refresh runs every frame while playing, and replacing the
    // icon under the pointer between mousedown and mouseup swallows the click.
    if (playBtn.dataset.playing !== String(!!store.state.playing)) {
      playBtn.dataset.playing = String(!!store.state.playing);
      playBtn.replaceChildren(icon(store.state.playing ? 'pause' : 'play'));
      playBtn.title = store.state.playing ? 'Pause (Space)' : 'Play (Space)';
    }
    loopBtn.setActive(store.state.loop);
    viewSeg.value = store.state.view;
    keyBtn.setActive(store.state.camDirty);
    cutBtn.disabled = !tl.keys.length;
    keyBtn.title = store.state.camDirty ? 'The camera moved: press K to key this framing' : 'Key the current view at the playhead (K)';
    shotDur.textContent = tl.duration.toFixed(2);
    shotFps.textContent = fmtFps(tl.fps);
    const k = store.state.key && store.keyById(store.state.key);
    keyGroup.style.display = k ? '' : 'none';
    if (k) {
      const sorted = keys();
      const i = sorted.findIndex((x) => x.id === k.id);
      const last = i === sorted.length - 1;
      keyTime.textContent = `${k.t.toFixed(2)} s`;
      keyTime.title = `Key ${k.id}`;
      changed(easeGlyph, last ? 'linear' : k.ease, () => { easeGlyph.innerHTML = easeSvg(last ? 'linear' : k.ease); });
      easeName_.textContent = last ? 'last key' : easeName(k.ease);
      easeBtn.disabled = last;
      easeBtn.title = last ? 'Last key: no segment after it' : 'Easing from this key to the next (opens the curve editor)';
      // selecting a key (or the agent changing its lens) puts the free view on that lens too
      changed(lensField, [k.id, k.fov], () => viewport.setFreeFov(k.fov));
    }
    const so = selObj();
    objKeyBtn.hidden = !so;
    if (so) {
      objKeyLabel.textContent = `Key ${so.id}`;
      const n = so.anim?.length || 0;
      objKeyBtn.title = n ? `${so.id} has ${n} key${n === 1 ? '' : 's'} (circles under the track). Key it at the playhead; dragging it with the gizmo also keys it` : `Start animating ${so.id}: key where it is now at the playhead`;
      objKeyBtn.classList.toggle('is-animated', !!n);
    }
    const shotView = store.state.view === 'shot';
    const lensFov = k ? k.fov : shotView ? (sampleCamera(store.doc.timeline, store.state.time)?.fov ?? viewport.freeCam.fov) : viewport.freeCam.fov;
    lensNum.set(Math.round(fovToLens(lensFov)));
    const lensOff = shotView && !k;
    lensField.classList.toggle('is-disabled', lensOff);
    lensNum.disabled = lensOff;
    lensField.title = lensOff ? 'Select a key to change its lens' : k ? 'Lens of the selected key; the free view uses it too' : 'Lens of the free view; new keys get it';
    exportBtn.disabled = store.state.exporting;
    draw();
    curve.refresh();
    shot.refresh();
  }

  // ---------- curve editor + shot settings ----------
  const curve = mountCurveEditor(root, { updateKey, keys, onToggle: (open, mode) => { easeBtn.classList.toggle('is-open', open && mode === 'segment'); }, anchor: () => easeBtn });
  const shot = mountShotSettings(root, { anchor: shotBtn, keys, openSpeed: () => { shot.toggle(false); curve.toggle(true, 'speed'); } });


  store.on('doc', refresh);
  store.on('state', refresh);
  new ResizeObserver(draw).observe(track);
  return { refresh, keyFromView, cutHere, seek, deleteKey, draw };
}

/** Popover with a draggable cubic-bezier for the segment at the playhead, or the shot-wide speed curve. */
function mountCurveEditor(root, { updateKey, keys, onToggle, anchor }) {
  const W = 260, H = 170, M = 18;
  const cv = h('canvas.curve-canvas', { width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px` } });
  const ctx = cv.getContext('2d');
  let mode = 'segment';
  const tabs = segmented({ options: [{ value: 'segment', label: 'Segment', title: 'Ease between two keys' }, { value: 'speed', label: 'Shot speed', title: 'Time remap across the whole shot' }], value: mode, onChange: (v) => { mode = v; onToggle?.(api.open, mode); refresh(); } });
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
    changed(presets, [mode, current], () => presets.replaceChildren(...Object.keys(EASES).filter((k) => !(mode === 'speed' && k === 'hold')).map((k) =>
      button({ label: k, kind: 'ghost', active: k === current, onClick: () => commit(k) }))));
    help.textContent = mode === 'speed'
      ? 'Remaps time across the whole shot: ease-in starts slow and ends fast. Applied on top of each segment ease.'
      : 'How the camera travels between the two keys. The shaded area is its speed. Drag the orange handles.';
    draw();
  }

  function toggle(on, m) {
    if (on === undefined) on = !(api.open && (!m || m === mode));
    if (m) { mode = m; tabs.value = m; }
    api.open = on; pop.hidden = !on; onToggle?.(on, mode);
    if (on && anchor) {
      const a = mode === 'speed' ? null : anchor();
      const r = a && a.offsetParent ? a.getBoundingClientRect() : null;
      pop.style.left = r ? `${Math.max(12, Math.min(innerWidth - 304, r.left - 40))}px` : '';
    }
    refresh();
  }
  return api;
}


/** Popover from the "5.00 s · 24 fps" chip: duration (with retime), frame rate (any value, presets), export size, shot speed. */
function mountShotSettings(root, { anchor, keys, openSpeed }) {
  let retime = true;
  try { retime = localStorage.getItem(RETIME_KEY) !== '0'; } catch {}
  const tlOp = (patch, label) => store.op({ op: 'timeline', ...patch }, label).catch(() => {});
  const setDur = (v) => tlOp({ duration: +v.toFixed(3), retime: retime || undefined }, 'shot length');

  const durNum = number({ step: 0.1, min: 0.1, max: 600, precision: 2, width: 44, title: 'Shot length in seconds. Drag to scrub, Shift for big steps.', onChange: setDur });
  const less = button({ icon: 'minus', kind: 'ghost', title: 'Half a second shorter', onClick: () => setDur(Math.max(0.1, store.doc.timeline.duration - 0.5)) });
  const more = button({ icon: 'plus', kind: 'ghost', title: 'Half a second longer', onClick: () => setDur(Math.min(600, store.doc.timeline.duration + 0.5)) });
  const durField = h('div.cc-affix.shot-dur', {}, less, durNum, h('span.cc-affix__unit', {}, 's'), more);
  const retimeSw = onOff({ value: retime, title: 'Scale key times with the shot length so the move keeps its timing', onChange: (v) => { retime = v; try { localStorage.setItem(RETIME_KEY, v ? '1' : '0'); } catch {} } });

  const fpsNum = number({ step: 1, min: 1, max: 120, precision: 3, width: 48, title: 'Frames per second. Any value, e.g. 23.976.', onChange: (v) => tlOp({ fps: v }, 'frame rate') });

  const sizeSel = select({ options: [], title: 'Export size', onChange: (v) => { const [width, height] = v.split('x').map(Number); store.op({ op: 'meta', width, height }, 'export size').catch(() => {}); } });
  const speedBtn = h('button.cc-field.tl-ease', { type: 'button', title: 'Shot speed: remaps time across the whole shot', onClick: () => openSpeed() });
  const foot = h('div.cc-label.cc-mono.shot-foot');

  const p = panel({ title: 'Shot', collapsible: false, actions: [button({ icon: 'close', kind: 'ghost', title: 'Close (Esc)', onClick: () => toggle(false) })] });
  p.classList.add('shot-pop');
  p.hidden = true;
  const rowEl = (label, ...c) => h('div.cc-row', {}, h('span.cc-label', {}, label), ...c);
  p.body.append(
    rowEl('Duration', durField),
    h('div.cc-row.shot-sub', {}, retimeSw, h('span.shot-sub-text', { onClick: () => retimeSw.click() }, 'Stretch keys to fit')),
    rowEl('Frame rate', affix(fpsNum, 'fps')),
    rowEl('Size', sizeSel),
    rowEl('Speed', speedBtn),
    h('div.cc-divider.cc-divider--h'),
    foot,
  );
  document.body.append(p); // outside #timeline so it can sit above the chat panel

  const api = { open: false, toggle, refresh };
  function place() {
    const r = anchor.getBoundingClientRect();
    p.style.right = `${Math.max(12, innerWidth - r.right)}px`;
  }
  function toggle(on = p.hidden) {
    api.open = on; p.hidden = !on;
    anchor.classList.toggle('is-open', on);
    anchor.replaceChild(icon(on ? 'chevronUp' : 'chevronDown'), anchor.lastElementChild);
    if (on) { place(); refresh(); }
  }
  function refresh() {
    if (!api.open || !store.doc) return;
    const tl = store.doc.timeline, m = store.doc.meta;
    durNum.set(tl.duration);
    fpsNum.set(tl.fps);
    const cur = `${m.width}x${m.height}`;
    const opts = SIZES.map(([w, hh]) => `${w}x${hh}`);
    if (!opts.includes(cur)) opts.unshift(cur);
    const ratio = (w, hh) => { const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, hh); return `${w / d}:${hh / d}`; };
    changed(sizeSel, [opts, cur], () => {
      sizeSel.replaceChildren(...opts.map((o) => { const [w, hh] = o.split('x').map(Number); return h('option', { value: o }, `${w} × ${hh} · ${ratio(w, hh)}`); }));
      sizeSel.value = cur;
    });
    const sp = tl.speed ?? 'linear';
    changed(speedBtn, sp, () => {
      speedBtn.innerHTML = easeSvg(sp);
      speedBtn.append(h('span', {}, easeName(sp)), icon('chevronDown'));
    });
    const n = keys().length;
    foot.textContent = `${Math.round(tl.duration * tl.fps)} frames · ${n} key${n === 1 ? '' : 's'}`;
  }
  addEventListener('pointerdown', (e) => { if (api.open && !p.contains(e.target) && !anchor.contains(e.target)) toggle(false); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && api.open) { e.stopPropagation(); toggle(false); } }, true);
  addEventListener('resize', () => { if (api.open) place(); });
  return api;
}
