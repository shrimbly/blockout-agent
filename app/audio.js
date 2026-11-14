// The shot's audio track in the browser: decoding, waveform peaks, playback in step with the playhead,
// the mixdown that goes into the exported video, and a rough beat finder the agent can ask for.
// The track itself lives in the doc (timeline.audio: file, offset, volume, muted, length); the file is
// served from the scene folder's audio/.

import { store } from './store.js';

const RATE = 48000;      // decode and mix at this sample rate
const PEAK_RATE = 200;   // waveform buckets per second of audio

let ctx = null;          // realtime AudioContext, made on first play (browsers want a user gesture)
let cur = { file: null, buffer: null, peaks: null, loading: null, error: null };
let voice = null;        // what is playing: { src, gain, at (ctx time), t (timeline time at `at`) }
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

const track = () => store.doc?.timeline.audio || null;
const playable = (a) => a && !a.muted && cur.buffer && cur.file === a.file;

/** Max |sample| per 1/PEAK_RATE s, all channels mixed. */
function computePeaks(buf) {
  const n = Math.ceil(buf.duration * PEAK_RATE), step = buf.sampleRate / PEAK_RATE;
  const peaks = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = peaks[i];
      for (let j = Math.floor(i * step), e = Math.min(d.length, Math.floor((i + 1) * step)); j < e; j++) { const v = Math.abs(d[j]); if (v > m) m = v; }
      peaks[i] = m;
    }
  }
  let max = 0; for (const v of peaks) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max; // normalise so quiet tracks still read
  return peaks;
}

async function load(a) {
  if (!a) {
    if (cur.file) { cur = { file: null, buffer: null, peaks: null, loading: null, error: null }; stopVoice(); changed(); }
    return null;
  }
  if (cur.file === a.file) return cur.loading;
  stopVoice();
  const file = a.file;
  cur = { file, buffer: null, peaks: null, loading: null, error: null };
  cur.loading = (async () => {
    try {
      const res = await fetch(`/audio/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`audio file ${file} not found in the scene's audio/ folder`);
      const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await res.arrayBuffer());
      if (cur.file !== file) return null; // replaced while decoding
      cur.buffer = buf; cur.peaks = computePeaks(buf);
      const len = Math.round(buf.duration * 1000) / 1000;
      const t = track();
      // record the length in the doc (not an undo step) so the agent and "fit" can use it
      if (t?.file === file && Math.abs((t.length || 0) - len) > 0.002) store.op({ op: 'audio', length: len }, 'read audio length', { amend: true }).catch(() => {});
      if (store.state.playing) play(store.state.time);
      return buf;
    } catch (e) {
      if (cur.file === file) cur.error = e.message || String(e);
      store.emit('error', `Could not read the audio: ${cur.error}`);
      return null;
    } finally { changed(); }
  })();
  changed();
  return cur.loading;
}

function stopVoice() {
  if (voice?.src) { try { voice.src.stop(); } catch {} voice.src.disconnect(); }
  voice = null;
}

/** Start the track so that timeline time t plays now. Keeps a clock even when nothing is audible. */
function play(t) {
  stopVoice();
  const a = track();
  if (!playable(a)) return;
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const at = ctx.currentTime + 0.02;
  voice = { src: null, at, t };
  const pos = t - a.offset;
  if (pos >= cur.buffer.duration) return;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = cur.buffer; gain.gain.value = a.volume ?? 1;
  src.connect(gain).connect(ctx.destination);
  if (pos < 0) src.start(at - pos, 0); else src.start(at, pos);
  voice.src = src; voice.gain = gain;
}

export const audio = {
  get file() { return cur.file; },
  get buffer() { return cur.buffer; },
  get peaks() { return cur.peaks; },
  get loading() { return !!cur.file && !cur.buffer && !cur.error; },
  get error() { return cur.error; },
  PEAK_RATE,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  load: () => load(track()),
  play, stop: stopVoice,

  /** Timeline time from the audio clock while it plays (so picture and sound stay locked), else null. */
  now() {
    if (!voice || !ctx || ctx.state !== 'running') return null;
    return voice.t + Math.max(0, ctx.currentTime - voice.at);
  },

  /** Keep playback in step with the store: call once at startup. */
  attach() {
    let sig = '';
    store.on('state', (c) => {
      if (!c.playing) return;
      if (store.state.playing) play(store.state.time); else stopVoice();
    });
    store.on('doc', () => {
      const a = track();
      load(a);
      const s = a ? JSON.stringify([a.file, a.offset, a.volume, a.muted]) : '';
      if (s !== sig) { sig = s; if (store.state.playing) play(store.state.time); changed(); }
    });
  },

  /** The track as it sounds over [0, duration] of the shot, at RATE, for the export. Null if there is none. */
  async mixdown(duration) {
    const a = track();
    if (!a || a.muted) return null;
    await load(a);
    if (!cur.buffer) return null;
    const ch = Math.min(2, cur.buffer.numberOfChannels) || 1;
    const off = new OfflineAudioContext(ch, Math.max(1, Math.ceil(duration * RATE)), RATE);
    const src = off.createBufferSource(), gain = off.createGain();
    src.buffer = cur.buffer; gain.gain.value = a.volume ?? 1;
    src.connect(gain).connect(off.destination);
    if (a.offset >= 0) src.start(a.offset, 0); else src.start(0, -a.offset);
    return off.startRendering();
  },

  /**
   * A rough beat finder: an energy-flux onset envelope, tempo from its autocorrelation (70–180 bpm),
   * and the beat grid with the best phase. Times are on the timeline (offset applied) inside the shot.
   */
  async analyze() {
    const a = track();
    if (!a) throw new Error('no audio on the timeline');
    await load(a);
    if (!cur.buffer) throw new Error(cur.error || 'the audio could not be decoded');
    const buf = cur.buffer, sr = buf.sampleRate, hop = 512, fr = sr / hop;
    const n = Math.floor(buf.length / hop);
    const env = new Float32Array(n);
    const chans = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
    let prev = 0;
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (const d of chans) for (let j = i * hop, k = j + hop; j < k; j++) e += d[j] * d[j];
      const l = Math.log1p(1000 * e / hop);
      env[i] = Math.max(0, l - prev); prev = l;
    }
    let mean = 0; for (const v of env) mean += v; mean /= n || 1;
    let sd = 0; for (const v of env) sd += (v - mean) ** 2; sd = Math.sqrt(sd / (n || 1));
    // tempo
    let best = 0, bestLag = 0;
    for (let lag = Math.round(fr * 60 / 180); lag <= Math.round(fr * 60 / 70); lag++) {
      let s = 0; for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
      const bpm = 60 * fr / lag, w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2); // lean toward ~120
      if (s * w > best) { best = s * w; bestLag = lag; }
    }
    const toT = (i) => Math.round((i / fr + a.offset) * 1000) / 1000;
    const D = store.doc.timeline.duration;
    const inShot = (t) => t >= 0 && t <= D + 1e-6;
    let beats = [], tempo = null, beat = null;
    if (bestLag && best > 0) {
      let phase = 0, ps = -1;
      for (let p = 0; p < bestLag; p++) { let s = 0; for (let i = p; i < n; i += bestLag) s += env[i]; if (s > ps) { ps = s; phase = p; } }
      for (let i = phase; i < n; i += bestLag) beats.push(toT(i));
      beats = beats.filter(inShot);
      tempo = Math.round(600 * fr / bestLag) / 10; beat = Math.round(1000 * bestLag / fr) / 1000;
    }
    // strong onsets: local maxima well above the mean, at least 0.12 s apart, strongest 48 in the shot
    const gap = Math.round(0.12 * fr), thr = mean + 1.5 * sd, picks = [];
    for (let i = 1; i < n - 1; i++) {
      if (env[i] < thr || env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
      if (picks.length && i - picks[picks.length - 1].i < gap) { if (env[i] > picks[picks.length - 1].v) picks[picks.length - 1] = { i, v: env[i] }; continue; }
      picks.push({ i, v: env[i] });
    }
    const onsets = picks.filter((p) => inShot(toT(p.i))).sort((x, y) => y.v - x.v).slice(0, 48).map((p) => toT(p.i)).sort((x, y) => x - y);
    return { file: a.file, length: Math.round(buf.duration * 1000) / 1000, offset: a.offset, tempo, beat, beats, onsets };
  },
};
