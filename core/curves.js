// Easing, speed curves and camera path sampling.
// Pure ES module, no three.js: shared by the browser, the server and the CLI.

/** Named easing presets as cubic-bezier control points [x1, y1, x2, y2]. */
export const EASES = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  slowIn: [0.7, 0, 0.84, 0],      // strong acceleration
  slowOut: [0.16, 1, 0.3, 1],     // strong deceleration (expo-ish)
  snap: [0.85, 0, 0.15, 1],       // fast through the middle
  anticipate: [0.36, -0.3, 0.6, 1],
  overshoot: [0.34, 1.4, 0.64, 1],
  hold: 'hold',                   // stay on this key until the next one, then cut
};

/** Normalise an ease spec (preset name, bezier array, or undefined) to a bezier array or 'hold'. */
export function resolveEase(spec) {
  if (spec == null) return EASES.easeInOut;
  if (typeof spec === 'string') {
    if (!(spec in EASES)) throw new Error(`unknown ease "${spec}" (known: ${Object.keys(EASES).join(', ')})`);
    return EASES[spec];
  }
  if (Array.isArray(spec) && spec.length === 4 && spec.every(Number.isFinite)) {
    // x must stay within [0,1] for the curve to be a function of time.
    return [clamp(spec[0], 0, 1), spec[1], clamp(spec[2], 0, 1), spec[3]];
  }
  throw new Error(`bad ease ${JSON.stringify(spec)}: use a preset name or [x1,y1,x2,y2]`);
}

/** The preset name for a bezier, if it matches one. */
export function easeName(spec) {
  if (typeof spec === 'string') return spec;
  const b = resolveEase(spec);
  for (const [k, v] of Object.entries(EASES)) {
    if (Array.isArray(v) && v.every((n, i) => Math.abs(n - b[i]) < 1e-4)) return k;
  }
  return 'custom';
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Evaluate cubic-bezier easing y(x) for x in [0,1]. */
export function bezier(b, x) {
  if (b === 'hold') return x >= 1 ? 1 : 0;
  const [x1, y1, x2, y2] = b;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x; // linear
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  // Newton, then bisection fallback.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const e = sx(t) - x;
    if (Math.abs(e) < 1e-7) break;
    const d = dsx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= e / d;
  }
  if (!(t >= 0 && t <= 1) || Math.abs(sx(t) - x) > 1e-5) {
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

/** Relative speed (dy/dx) of an easing curve at x, 1 = constant speed. */
export function bezierSpeed(b, x, h = 1e-3) {
  if (b === 'hold') return 0;
  const a = clamp(x - h, 0, 1), c = clamp(x + h, 0, 1);
  return (bezier(b, c) - bezier(b, a)) / (c - a || 1);
}

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Centripetal Catmull-Rom (no cusps, no self-intersection) through p1..p2.
function catmull(p0, p1, p2, p3, t) {
  const d = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = lerp(t1, t2, t);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const A1 = ((t1 - u) * p0[i] + (u - t0) * p1[i]) / (t1 - t0);
    const A2 = ((t2 - u) * p1[i] + (u - t1) * p2[i]) / (t2 - t1);
    const A3 = ((t3 - u) * p2[i] + (u - t2) * p3[i]) / (t3 - t2);
    const B1 = ((t2 - u) * A1 + (u - t0) * A2) / (t2 - t0);
    const B2 = ((t3 - u) * A2 + (u - t1) * A3) / (t3 - t1);
    out[i] = ((t2 - u) * B1 + (u - t1) * B2) / (t2 - t1);
  }
  return out;
}

// Mirror an end point so the spline starts/ends without a kink.
const extrap = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];

/** Map shot time t (seconds) through the timeline-wide speed curve. */
export function remapTime(timeline, t) {
  const dur = Math.max(1e-6, timeline.duration);
  const speed = resolveEase(timeline.speed ?? 'linear');
  return bezier(speed, clamp(t / dur, 0, 1)) * dur;
}

/**
 * Sample the shot camera at time t.
 * Returns { position, target, fov, roll, segment, local } or null when there are no keys.
 */
export function sampleCamera(timeline, t) {
  const keys = [...(timeline.keys || [])].sort((a, b) => a.t - b.t);
  if (!keys.length) return null;
  const tt = remapTime(timeline, t);
  const pose = (k) => ({ position: [...k.position], target: [...k.target], fov: k.fov ?? 40, roll: k.roll ?? 0 });
  if (keys.length === 1 || tt <= keys[0].t) return { ...pose(keys[0]), segment: 0, local: 0 };
  const last = keys[keys.length - 1];
  if (tt >= last.t) return { ...pose(last), segment: keys.length - 1, local: 0 };
  let i = 0;
  while (i < keys.length - 2 && tt >= keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const s = bezier(resolveEase(a.ease), clamp((tt - a.t) / span, 0, 1));
  const smooth = (timeline.interp ?? 'smooth') === 'smooth';
  const pick = (field) => {
    if (!smooth) return lerp3(a[field], b[field], s);
    const p0 = keys[i - 1]?.[field] ?? extrap(a[field], b[field]);
    const p3 = keys[i + 2]?.[field] ?? extrap(b[field], a[field]);
    return catmull(p0, a[field], b[field], p3, s);
  };
  return {
    position: pick('position'),
    target: pick('target'),
    fov: lerp(a.fov ?? 40, b.fov ?? 40, s),
    roll: lerp(a.roll ?? 0, b.roll ?? 0, s),
    segment: i,
    local: s,
  };
}

/** Convert a vertical FOV (deg) to a full-frame-equivalent focal length (mm), and back. */
export const fovToLens = (fov) => 12 / Math.tan((fov * Math.PI) / 360);
export const lensToFov = (mm) => (360 / Math.PI) * Math.atan(12 / mm);

/**
 * Transform of an object at shot time t. Objects without animation keys stay where they are.
 * Animation keys ({ t, position, rotation, scale, ease }) interpolate in straight lines with the
 * segment's ease; before the first key and after the last the object holds still.
 * The shot speed curve remaps object time too, so the whole shot stays in sync.
 */
export function sampleObject(obj, timeline, t) {
  const keys = obj.anim;
  if (!keys?.length) return { position: obj.position, rotation: obj.rotation, scale: obj.scale };
  const tt = remapTime(timeline, t);
  const pose = (k) => ({ position: [...k.position], rotation: [...k.rotation], scale: [...k.scale] });
  if (keys.length === 1 || tt <= keys[0].t) return pose(keys[0]);
  const last = keys[keys.length - 1];
  if (tt >= last.t) return pose(last);
  let i = 0;
  while (i < keys.length - 2 && tt >= keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const s = bezier(resolveEase(a.ease), clamp((tt - a.t) / Math.max(1e-6, b.t - a.t), 0, 1));
  return { position: lerp3(a.position, b.position, s), rotation: lerp3(a.rotation, b.rotation, s), scale: lerp3(a.scale, b.scale, s) };
}
