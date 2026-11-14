// The timeline's audio lane: a waveform under the camera track so camera moves and cuts can be paced to
// music or dialogue, an "Audio" button in the bar (load a file, or open the track's settings) and dropping
// an audio file anywhere on the timeline. Drag the waveform sideways to slide the audio (Shift: off the
// frame grid); click it to move the playhead. Everything changes the doc through the audio op.

import { h, button, number, affix, slider, toggle as onOff, panel, toast, icon } from './ui/kit.js';
import { store } from './store.js';
import { audio } from './audio.js';

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i;
const fmtLen = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)} s`);

export function mountAudioTrack(root, { xOf, tOf, seek, cutXs, keyXs }) {
  const track = () => store.doc?.timeline.audio || null;
  const op = (patch, label) => store.op({ op: 'audio', ...patch }, label).catch(() => {});

  // ---------- loading a file ----------
  const input = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac', hidden: true });
  input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; if (f) loadFile(f); });
  root.append(input);
  async function loadFile(f) {
    if (!AUDIO_EXT.test(f.name) && !f.type.startsWith('audio/')) return toast(`${f.name} is not an audio file (mp3, wav, m4a, aac, ogg, opus, flac)`, { kind: 'error' });
    const note = toast(`Loading ${f.name}…`, { ms: 60000 });
    try {
      const res = await fetch(`/api/audio?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const up = await res.json();
      if (!up.ok) throw new Error(up.error);
      await store.op({ op: 'audio', file: up.file, name: up.name }, track() ? 'replace audio' : 'load audio');
      const buf = await audio.load();
      note.remove();
      const D = store.doc.timeline.duration;
      toast(buf ? `Loaded ${f.name} (${fmtLen(buf.duration)}).${Math.abs(buf.duration - D) > 0.05 ? ' Fit shot in the Audio menu makes the shot as long as the audio.' : ''}` : `Loaded ${f.name}`, { ms: 5000 });
    } catch (e) { note.remove(); toast(`Could not load ${f.name}: ${e.message}`, { kind: 'error' }); }
  }
  root.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); root.classList.add('is-drop'); } });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('is-drop'); });
  root.addEventListener('drop', (e) => {
    root.classList.remove('is-drop');
    const f = [...(e.dataTransfer?.files || [])][0];
    if (!f) return;
    e.preventDefault();
    loadFile(f);
  });

  // ---------- bar button ----------
  const btnLabel = h('span.tl-audio-name');
  const btn = h('button.cc-btn.tl-audiobtn', { type: 'button', onClick: () => (track() ? pop.toggle() : input.click()) }, icon('music'), btnLabel);

  // ---------- lane ----------
  const lane = h('canvas.tl-audio', { hidden: true });
  const ctx = lane.getContext('2d');
  let drag = null; // { x, off0, off, moved }
  const liveOffset = () => (drag?.moved ? drag.off : track()?.offset ?? 0);

  lane.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !track()) return;
    lane.setPointerCapture(e.pointerId);
    drag = { x: e.offsetX, off0: track().offset, off: track().offset, moved: false };
  });
  lane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.offsetX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    const F = store.doc.timeline.fps;
    let off = drag.off0 + (tOf(drag.x + dx, true) - tOf(drag.x, true));
    if (!e.shiftKey) off = Math.round(off * F) / F;
    drag.off = +off.toFixed(3);
    draw(); pop.refresh();
  });
  lane.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d) return;
    if (!d.moved) { store.set({ playing: false }); seek(Math.round(tOf(e.offsetX) * store.doc.timeline.fps) / store.doc.timeline.fps); return; }
    if (Math.abs(d.off - d.off0) > 1e-4) op({ offset: d.off }, 'slide audio');
    draw();
  });

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function draw() {
    const a = track();
    if (!a || lane.hidden) return;
    const dpr = devicePixelRatio || 1, W = lane.clientWidth, H = lane.clientHeight;
    if (!W || !H) return;
    if (lane.width !== Math.round(W * dpr) || lane.height !== Math.round(H * dpr)) { lane.width = Math.round(W * dpr); lane.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const dim = css('--cc-text-dim'), faint = css('--cc-text-faint'), text = css('--cc-text'), accent = css('--cc-accent');
    const off = liveOffset(), mid = H / 2;
    const peaks = audio.peaks, PR = audio.PEAK_RATE;
    const x0 = Math.ceil(xOf(0)), x1 = Math.floor(xOf(store.doc.timeline.duration));
    ctx.font = `10px ${css('--cc-font')}`; ctx.textBaseline = 'middle';
    if (peaks) {
      const len = peaks.length / PR;
      ctx.fillStyle = drag?.moved ? text : dim; ctx.globalAlpha = 0.75;
      for (let x = x0; x < x1; x++) {
        const a0 = tOf(x, true) - off, a1 = tOf(x + 1, true) - off;
        if (a1 <= 0 || a0 >= len) continue;
        const i0 = Math.max(0, Math.floor(a0 * PR)), i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(a1 * PR)));
        let m = 0; for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
        const hh = Math.max(0.5, m * (mid - 2));
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
      ctx.globalAlpha = 1;
      // where the audio starts / ends, when that is inside the shot
      ctx.fillStyle = faint;
      for (const t of [off, off + len]) { const x = xOf(t); if (t > 0.001 && x < x1) ctx.fillRect(Math.round(x), 2, 1, H - 4); }
    } else {
      ctx.fillStyle = faint;
      ctx.fillText(audio.error ? `Could not read ${a.name}: ${audio.error}` : `Reading ${a.name}…`, x0 + 6, mid);
    }
    if (a.muted) { ctx.fillStyle = css('--cc-surface-sunk'); ctx.globalAlpha = 0.55; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    // camera keys as ticks and cuts as lines, so beats can be lined up with them
    ctx.fillStyle = faint;
    for (const x of keyXs()) ctx.fillRect(Math.round(x), 0, 1, 3);
    ctx.fillStyle = text; ctx.globalAlpha = 0.5;
    for (const x of cutXs()) ctx.fillRect(Math.round(x) - 0.25, 0, 1.5, H);
    ctx.globalAlpha = 1;
    // playhead
    ctx.fillStyle = accent;
    ctx.fillRect(Math.round(xOf(store.state.time)), 0, 1.5, H);
    if (drag?.moved) { // readout while sliding
      const label = `starts at ${off >= 0 ? '' : '−'}${Math.abs(off).toFixed(2)} s`;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = css('--cc-surface-solid'); ctx.fillRect(x0 + 4, mid - 7, w, 14);
      ctx.fillStyle = text; ctx.fillText(label, x0 + 9, mid);
    }
  }
  lane.addEventListener('pointerover', () => { lane.style.cursor = 'ew-resize'; });
  new ResizeObserver(draw).observe(lane);
  audio.on(() => { draw(); pop.refresh(); });

  // ---------- settings popover ----------
  const pop = mountAudioSettings({ anchor: btn, replace: () => input.click(), op, liveOffset });

  function refresh() {
    const a = track();
    const show = !!a;
    if (lane.hidden === show) { lane.hidden = !show; document.body.classList.toggle('has-audio', show); }
    btnLabel.textContent = a ? a.name.replace(/\.[a-z0-9]+$/i, '') : 'Audio';
    btn.title = a ? `${a.name}${a.muted ? ' (muted)' : ''}: start, volume, fit the shot, replace or remove` : 'Load a music or dialogue track to pace the shot to (it is mixed into the export). You can also drop an audio file on the timeline.';
    btn.classList.toggle('is-muted', !!a?.muted);
    if (!a && pop.open) pop.toggle(false);
    draw(); pop.refresh();
  }
  return { btn, lane, refresh, draw, loadFile };
}

function mountAudioSettings({ anchor, replace, op, liveOffset }) {
  const track = () => store.doc?.timeline.audio || null;
  const name = h('span.audio-file.cc-mono');
  const offNum = number({ step: 0.05, min: -3600, max: 3600, precision: 3, width: 56, title: 'Where the audio starts on the timeline, in seconds. Negative skips into the file. Or drag the waveform.', onChange: (v) => op({ offset: v }, 'audio start') });
  const vol = slider({ min: 0, max: 2, step: 0.05, value: 1, precision: 2, onChange: (v) => op({ volume: v }, 'audio volume') });
  const mute = onOff({ title: 'Mute in playback and the export', onChange: (v) => op({ muted: v }, v ? 'mute audio' : 'unmute audio') });
  const fitBtn = button({ label: 'Fit shot', title: 'Make the shot end where the audio ends', onClick: () => op({ fit: true }, 'fit shot to audio') });
  const replaceBtn = button({ label: 'Replace', title: 'Load another audio file', onClick: () => replace() });
  const removeBtn = button({ icon: 'trash', kind: 'ghost', title: 'Remove the audio track', onClick: () => op({ clear: true }, 'remove audio') });
  const foot = h('div.cc-label.cc-mono.shot-foot.audio-foot');

  const p = panel({ title: 'Audio', collapsible: false, actions: [button({ icon: 'close', kind: 'ghost', title: 'Close (Esc)', onClick: () => toggle(false) })] });
  p.classList.add('audio-pop');
  p.hidden = true;
  const rowEl = (label, ...c) => h('div.cc-row', {}, h('span.cc-label', {}, label), ...c);
  p.body.append(
    rowEl('File', name),
    rowEl('Starts at', affix(offNum, 's')),
    rowEl('Volume', vol),
    rowEl('Mute', mute),
    h('div.cc-row.audio-actions', {}, fitBtn, replaceBtn, h('span.cc-spacer'), removeBtn),
    h('div.cc-divider.cc-divider--h'),
    foot,
  );
  document.body.append(p);

  const api = { open: false, toggle, refresh };
  function place() { const r = anchor.getBoundingClientRect(); p.style.right = `${Math.max(12, innerWidth - r.right)}px`; }
  function toggle(on = p.hidden) {
    api.open = on; p.hidden = !on;
    anchor.classList.toggle('is-open', on);
    if (on) { place(); refresh(); }
  }
  function refresh() {
    const a = track();
    if (!api.open || !a) return;
    name.textContent = a.name; name.title = `${a.name} (scene audio/${a.file})`;
    offNum.set(liveOffset());
    vol.set(a.volume ?? 1);
    mute.set(!!a.muted);
    const len = audio.buffer?.duration ?? a.length;
    fitBtn.disabled = !len;
    const D = store.doc.timeline.duration, off = liveOffset();
    foot.textContent = len
      ? `${fmtLen(len)} long · the shot plays ${Math.max(0, -off).toFixed(2)}–${Math.min(len, D - off).toFixed(2)} s of it`
      : audio.error ? `could not read the file: ${audio.error}` : 'reading the file…';
  }
  addEventListener('pointerdown', (e) => { if (api.open && !p.contains(e.target) && !anchor.contains(e.target)) toggle(false); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && api.open) { e.stopPropagation(); toggle(false); } }, true);
  addEventListener('resize', () => { if (api.open) place(); });
  return api;
}
