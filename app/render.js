// Snapshots, storyboards and blockout video export.
// Video: frame-accurate render through the shot camera, encoded in the browser with WebCodecs
// (mediabunny, H.264 MP4 where available, VP9 otherwise), then uploaded to the server's exports/ folder.
// If the browser cannot encode H.264 and ffmpeg is installed, the server transcodes to H.264.

import { store } from './store.js';
import { toast, h } from './ui/kit.js';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

async function upload(blob, name, query = '') {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}${query}`, { method: 'POST', body: blob });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'upload failed');
  return data;
}
const toBlob = (canvas, type = 'image/png', q) => new Promise((r) => canvas.toBlob(r, type, q));
const safeName = (s) => String(s || 'shot').replace(/[^a-z0-9._-]+/gi, '-');

export function createRenderer(viewport) {
  const size = (p = {}) => {
    const w = p.width || store.doc.meta.width, hgt = p.height || store.doc.meta.height;
    return [w + (w % 2), hgt + (hgt % 2)];
  };

  async function snapshot({ t = store.state.time, view = 'shot', name, width, height, grid } = {}) {
    const [w, hh] = size({ width, height });
    const canvas = viewport.renderShot(t, w, hh, { view, grid });
    const blob = await toBlob(canvas);
    const file = name ? safeName(name).replace(/(\.png)?$/i, '.png') : `snapshot-${stamp()}-t${t.toFixed(2)}.png`;
    const r = await upload(blob, file);
    return { path: r.path, url: r.url, t, width: w, height: hh };
  }

  async function storyboard({ frames = 8, cols = 4, width = 480 } = {}) {
    const tl = store.doc.timeline;
    const A = store.doc.meta.width / store.doc.meta.height;
    const cw = width, ch = Math.round(width / A), rows = Math.ceil(frames / cols), gap = 8, label = 18;
    const sheet = h('canvas', { width: cols * cw + (cols + 1) * gap, height: rows * (ch + label) + (rows + 1) * gap });
    const g = sheet.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
    g.font = '12px ui-monospace, Menlo, monospace'; g.textBaseline = 'top';
    const times = [];
    for (let i = 0; i < frames; i++) {
      const t = frames === 1 ? 0 : (i / (frames - 1)) * tl.duration;
      times.push(+t.toFixed(3));
      const frame = viewport.renderShot(t, cw * 2, ch * 2);
      const x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + label + gap);
      g.drawImage(frame, x, y, cw, ch);
      g.fillStyle = '#bbb';
      g.fillText(`${String(i + 1).padStart(2, '0')}  ${t.toFixed(2)}s  f${Math.round(t * tl.fps)}`, x, y + ch + 3);
    }
    const r = await upload(await toBlob(sheet), `storyboard-${stamp()}.png`);
    return { path: r.path, url: r.url, times };
  }

  async function exportVideo({ fps, width, height, grid, name } = {}) {
    if (store.state.exporting) throw new Error('an export is already running');
    if (!store.doc.timeline.keys.length) throw new Error('add at least one camera key before exporting');
    if (typeof VideoEncoder === 'undefined') return exportRealtime({ fps, width, height, grid, name });
    const M = await import('/vendor/mediabunny.mjs');
    const tl = store.doc.timeline;
    const rate = fps || tl.fps;
    const [w, hh] = size({ width, height });
    const total = Math.max(1, Math.round(tl.duration * rate));
    const codec = await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: hh });
    if (!codec) return exportRealtime({ fps, width, height, grid, name });

    store.set({ exporting: true });
    const progress = toast('Rendering blockout… 0%', { ms: 10 * 60 * 1000 });
    try {
      const target = new M.BufferTarget();
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const first = viewport.renderShot(0, w, hh, { grid });
      const source = new M.CanvasSource(first, { codec, bitrate: Math.round(w * hh * rate * 0.18), keyFrameInterval: 1 });
      output.addVideoTrack(source, { frameRate: rate });
      await output.start();
      for (let i = 0; i < total; i++) {
        const t = i / rate;
        viewport.renderShot(t, w, hh, { grid });
        await source.add(t, 1 / rate);
        if (i % 6 === 0) { progress.textContent = `Rendering blockout… ${Math.round((i / total) * 100)}%`; await new Promise((r) => setTimeout(r)); }
      }
      await output.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      const file = `${safeName(name || store.doc.meta.name)}-${stamp()}.mp4`;
      const r = await upload(blob, file, codec === 'avc' ? '' : '&transcode=h264');
      const result = { path: r.path, url: r.url, frames: total, fps: rate, width: w, height: hh, codec: codec === 'avc' ? 'h264' : `${codec} (transcoded to h264 if ffmpeg was available)`, bytes: blob.size };
      progress.remove();
      toast(h('span', {}, 'Exported ', h('a', { href: r.url, target: '_blank' }, r.path.split('/').pop())), { ms: 8000 });
      return result;
    } finally {
      progress.remove();
      store.set({ exporting: false });
    }
  }

  // Fallback for browsers without WebCodecs: real-time capture with MediaRecorder.
  async function exportRealtime({ fps, width, height, grid, name } = {}) {
    const tl = store.doc.timeline;
    const rate = fps || tl.fps;
    const [w, hh] = size({ width, height });
    const canvas = viewport.renderShot(0, w, hh, { grid });
    const stream = canvas.captureStream(rate);
    const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    store.set({ exporting: true });
    try {
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const t = (performance.now() - t0) / 1000;
          viewport.renderShot(Math.min(t, tl.duration), w, hh, { grid });
          if (t >= tl.duration) return resolve();
          requestAnimationFrame(step);
        };
        step();
      });
      rec.stop();
      await done;
      const blob = new Blob(chunks, { type: rec.mimeType });
      const ext = rec.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const r = await upload(blob, `${safeName(name || store.doc.meta.name)}-${stamp()}.${ext}`, '&transcode=h264');
      return { path: r.path, url: r.url, frames: Math.round(tl.duration * rate), fps: rate, width: w, height: hh, codec: `${rec.mimeType} (realtime)`, bytes: blob.size };
    } finally { store.set({ exporting: false }); }
  }

  return { snapshot, storyboard, exportVideo };
}
