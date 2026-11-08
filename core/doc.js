// The scene document and the operations that change it.
// Pure ES module: the server applies ops; the browser only renders the result.
//
// Conventions: meters, Y up, rotations in degrees (XYZ order), colors as "#rrggbb".
// Every primitive's pivot is at its bottom centre, so position [x, 0, z] sits on the ground.

import { resolveEase, EASES, sampleObject } from './curves.js';

export const PRIMITIVES = {
  box: { params: { w: 1, h: 1, d: 1 }, size: ['w', 'h', 'd'], about: 'cuboid, w × h × d' },
  sphere: { params: { r: 0.5 }, size: ['r'], about: 'sphere of radius r, resting on the ground' },
  cylinder: { params: { r: 0.5, h: 1, rTop: null }, size: ['r', 'h'], about: 'cylinder; set rTop for a tapered column' },
  cone: { params: { r: 0.5, h: 1 }, size: ['r', 'h'], about: 'cone' },
  pyramid: { params: { w: 1, h: 1, d: 1 }, size: ['w', 'h', 'd'], about: 'square pyramid' },
  capsule: { params: { r: 0.3, h: 1.8 }, size: ['r', 'h'], about: 'capsule, total height h' },
  torus: { params: { r: 0.5, tube: 0.15 }, size: ['r', 'tube'], about: 'ring lying flat (hole points up)' },
  plane: { params: { w: 4, d: 4 }, size: ['w', 'd'], about: 'flat ground-aligned plane (floor, road, water)' },
  ramp: { params: { w: 1, h: 1, d: 2 }, size: ['w', 'h', 'd'], about: 'wedge rising toward −z (stairs, slopes, roofs)' },
  stairs: { params: { w: 1, h: 1, d: 1.5, steps: 6 }, size: ['w', 'h', 'd'], about: 'staircase rising toward −z' },
  arch: { params: { w: 2, h: 2.5, d: 0.5, t: 0.4 }, size: ['w', 'h', 'd'], about: 'doorway / arch, t = wall thickness' },
  person: { params: { h: 1.8 }, size: ['h'], about: 'human stand-in for scale, faces +z' },
};

export const DEFAULT_COLOR = '#d8d4cc';

export function createDoc() {
  return {
    version: 1,
    meta: { name: 'untitled', width: 1280, height: 720 },
    env: { background: '#e9e7e2', ground: true, grid: true, fog: 0, sun: [6, 10, 4] },
    objects: [],
    timeline: {
      duration: 5,
      fps: 24,
      interp: 'smooth',
      speed: 'linear',
      keys: [
        { id: 'k1', t: 0, position: [7, 3.5, 9], target: [0, 1, 0], fov: 40, roll: 0, ease: 'easeInOut' },
        { id: 'k2', t: 5, position: [-6, 2.5, 8], target: [0, 1, 0], fov: 40, roll: 0, ease: 'easeInOut' },
      ],
    },
    controls: {},
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const vec3 = (v, name) => {
  if (typeof v === 'number') return [v, v, v];
  if (!isVec3(v)) throw new Error(`${name} must be [x, y, z] numbers, got ${JSON.stringify(v)}`);
  return [...v];
};
const color = (c) => {
  if (c == null) return DEFAULT_COLOR;
  if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`color must be "#rrggbb", got ${JSON.stringify(c)}`);
  return c.toLowerCase();
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'obj';

// Named objects keep their name ("crate", then "crate-2"); unnamed ones count up ("box-1").
function uniqueId(doc, base, { kind = 'objects', named = false } = {}) {
  const taken = new Set((kind === 'keys' ? doc.timeline.keys : doc.objects).map((o) => o.id));
  const sep = kind === 'keys' ? '' : '-';
  if (named && !taken.has(base)) return base;
  let n = named ? 2 : 1;
  while (taken.has(`${base}${sep}${n}`)) n++;
  return `${base}${sep}${n}`;
}

function findObject(doc, id) {
  const o = doc.objects.find((x) => x.id === id || x.name === id);
  if (!o) throw new Error(`no object "${id}" (have: ${doc.objects.map((x) => x.id).join(', ') || 'none'})`);
  return o;
}

function findKey(doc, ref) {
  const keys = doc.timeline.keys;
  let k;
  if (typeof ref === 'number') k = keys.slice().sort((a, b) => a.t - b.t)[ref];
  else k = keys.find((x) => x.id === ref);
  if (!k) throw new Error(`no key ${JSON.stringify(ref)} (have: ${keys.map((x) => `${x.id}@${x.t}`).join(', ') || 'none'})`);
  return k;
}

function normParams(type, params = {}, base) {
  const spec = PRIMITIVES[type];
  const out = { ...(base || spec.params) };
  for (const [k, v] of Object.entries(params)) {
    if (!(k in spec.params)) throw new Error(`${type} has no param "${k}" (params: ${Object.keys(spec.params).join(', ')})`);
    if (v !== null && !Number.isFinite(v)) throw new Error(`${type}.${k} must be a number`);
    out[k] = v;
  }
  return out;
}

const OBJECT_FIELDS = new Set(['op', 'type', 'name', 'id', 'newId', 'position', 'rotation', 'scale', 'move', 'color', 'note', 'size', 'params', 'anim']);

// Split loose fields ({w:2, r:1}) out of an op into params. Unknown fields are errors (catches typos).
function pickParams(type, op) {
  const spec = PRIMITIVES[type];
  for (const k of Object.keys(op)) {
    if (!OBJECT_FIELDS.has(k) && !(k in spec.params) && op[k] !== undefined) {
      throw new Error(`${type} has no field or param "${k}" (params: ${Object.keys(spec.params).join(', ')}; fields: position, rotation, scale, move, color, name, note, size)`);
    }
  }
  const params = { ...(op.params || {}) };
  for (const k of Object.keys(spec.params)) if (k in op) params[k] = op[k];
  if (op.size != null) {
    const size = Array.isArray(op.size) ? op.size : [op.size];
    spec.size.forEach((k, i) => { if (size[i] != null) params[k] = size[i]; });
  }
  return params;
}

function sortKeys(doc) {
  doc.timeline.keys.sort((a, b) => a.t - b.t);
}

function normKey(k, prev = {}) {
  const out = { ...prev };
  if (k.t != null) { if (!Number.isFinite(k.t) || k.t < 0) throw new Error('key.t must be a time ≥ 0 in seconds'); out.t = round(k.t); }
  if (k.position != null) out.position = vec3(k.position, 'position');
  if (k.target != null) out.target = vec3(k.target, 'target');
  if (k.fov != null) { if (!(k.fov > 1 && k.fov < 170)) throw new Error('fov must be between 1 and 170 degrees'); out.fov = k.fov; }
  if (k.roll != null) out.roll = Number(k.roll);
  if (k.ease != null) { resolveEase(k.ease); out.ease = k.ease; }
  if (out.ease == null) out.ease = 'easeInOut';
  if (out.fov == null) out.fov = 40;
  if (out.roll == null) out.roll = 0;
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;

// ----- object animation: obj.anim = [{ t, position, rotation, scale, ease }], sorted by t -----
function normAnimKey(k, base) {
  if (!Number.isFinite(k.t) || k.t < 0) throw new Error('an animation key needs a time t ≥ 0 in seconds');
  const ease = k.ease ?? 'easeInOut';
  resolveEase(ease);
  return {
    t: round(k.t),
    position: (k.position != null ? vec3(k.position, 'position') : [...base.position]).map(round),
    rotation: (k.rotation != null ? vec3(k.rotation, 'rotation') : [...base.rotation]).map(round),
    scale: (k.scale != null ? vec3(k.scale, 'scale') : [...base.scale]).map(round),
    ease,
  };
}
// Keep keys sorted and the object's own transform equal to its first key, so lists and the gizmo agree.
function syncAnim(o) {
  o.anim.sort((a, b) => a.t - b.t);
  const f = o.anim[0];
  o.position = [...f.position]; o.rotation = [...f.rotation]; o.scale = [...f.scale];
}
// Add or replace a key at time t; missing fields come from where the object is at t.
function putAnimKey(doc, o, k) {
  const at = sampleObject(o, { ...doc.timeline, speed: 'linear' }, k.t);
  const key = normAnimKey(k, at);
  o.anim ||= [];
  const i = o.anim.findIndex((x) => Math.abs(x.t - key.t) < 1e-3);
  if (i >= 0) { if (k.ease == null) key.ease = o.anim[i].ease; o.anim[i] = key; } else o.anim.push(key);
  syncAnim(o);
  if (key.t > doc.timeline.duration) doc.timeline.duration = key.t;
  return key;
}

/** Operation handlers. Each mutates doc in place and returns a result. */
export const OPS = {
  add(doc, op) {
    const type = op.type;
    if (!PRIMITIVES[type]) throw new Error(`unknown type "${type}" (types: ${Object.keys(PRIMITIVES).join(', ')})`);
    const id = op.id ? slug(op.id) : op.name ? uniqueId(doc, slug(op.name), { named: true }) : uniqueId(doc, type);
    if (doc.objects.some((o) => o.id === id)) throw new Error(`id "${id}" already exists`);
    const obj = {
      id,
      name: op.name || id,
      type,
      params: normParams(type, pickParams(type, op)),
      position: op.position != null ? vec3(op.position, 'position') : [0, 0, 0],
      rotation: op.rotation != null ? vec3(op.rotation, 'rotation') : [0, 0, 0],
      scale: op.scale != null ? vec3(op.scale, 'scale') : [1, 1, 1],
      color: color(op.color),
    };
    if (op.note) obj.note = String(op.note);
    if (Array.isArray(op.anim) && op.anim.length) { obj.anim = op.anim.map((k) => normAnimKey(k, obj)); syncAnim(obj); }
    doc.objects.push(obj);
    return { id };
  },

  update(doc, op) {
    const o = findObject(doc, op.id);
    if (op.type && op.type !== o.type) {
      if (!PRIMITIVES[op.type]) throw new Error(`unknown type "${op.type}"`);
      o.type = op.type;
      o.params = normParams(op.type, {});
    }
    const params = pickParams(o.type, op);
    if (Object.keys(params).length) o.params = normParams(o.type, params, o.params);
    if (op.name != null) o.name = String(op.name);
    // On an animated object, changing its transform shifts the whole move (every key) by the same amount.
    const before = { position: [...o.position], rotation: [...o.rotation], scale: [...o.scale] };
    if (op.position != null) o.position = vec3(op.position, 'position');
    if (op.rotation != null) o.rotation = vec3(op.rotation, 'rotation');
    if (op.scale != null) o.scale = vec3(op.scale, 'scale');
    if (op.move != null) o.position = vec3(op.move, 'move').map((v, i) => round(o.position[i] + v));
    if (o.anim?.length) {
      for (const k of o.anim) {
        k.position = k.position.map((v, i) => round(v + o.position[i] - before.position[i]));
        k.rotation = k.rotation.map((v, i) => round(v + o.rotation[i] - before.rotation[i]));
        k.scale = k.scale.map((v, i) => round(before.scale[i] ? v * (o.scale[i] / before.scale[i]) : o.scale[i]));
      }
      syncAnim(o);
    }
    if (op.color != null) o.color = color(op.color);
    if (op.note != null) o.note = String(op.note);
    return { id: o.id };
  },

  remove(doc, op) {
    const ids = [].concat(op.ids ?? op.id);
    for (const id of ids) {
      const o = findObject(doc, id);
      doc.objects = doc.objects.filter((x) => x !== o);
    }
    return { removed: ids };
  },

  duplicate(doc, op) {
    const src = findObject(doc, op.id);
    const copy = clone(src);
    copy.id = op.newId ? uniqueId(doc, slug(op.newId), { named: true }) : uniqueId(doc, src.id.replace(/-\d+$/, ''), { named: !/-\d+$/.test(src.id) });
    copy.name = op.name || copy.id;
    const off = op.offset != null ? vec3(op.offset, 'offset') : [1, 0, 0];
    copy.position = copy.position.map((v, i) => round(v + off[i]));
    doc.objects.push(copy);
    return { id: copy.id };
  },

  clear(doc, op) {
    const n = doc.objects.length;
    doc.objects = [];
    if (op.keys) doc.timeline.keys = [];
    return { removed: n };
  },

  env(doc, op) {
    for (const k of ['background', 'ground', 'grid', 'fog', 'sun']) {
      if (op[k] === undefined) continue;
      if (k === 'background') doc.env.background = color(op.background);
      else if (k === 'sun') doc.env.sun = vec3(op.sun, 'sun');
      else if (k === 'fog') doc.env.fog = Math.max(0, Number(op.fog) || 0);
      else doc.env[k] = !!op[k];
    }
    return { env: doc.env };
  },

  meta(doc, op) {
    if (op.name != null) doc.meta.name = String(op.name);
    for (const k of ['width', 'height']) {
      if (op[k] == null) continue;
      const v = Math.round(op[k]);
      if (!(v >= 16 && v <= 4096)) throw new Error(`${k} must be 16–4096 px`);
      doc.meta[k] = v + (v % 2); // encoders want even sizes
    }
    return { meta: doc.meta };
  },

  'key.add'(doc, op) {
    const tl = doc.timeline;
    const t = op.t ?? 0;
    const existing = tl.keys.find((k) => Math.abs(k.t - t) < 1e-3);
    if (existing) {
      Object.assign(existing, normKey({ ...op, t }, existing));
      sortKeys(doc);
      return { id: existing.id, replaced: true };
    }
    if (op.position == null || op.target == null) throw new Error('key.add needs position and target (or use "canvas key --from-view")');
    const id = op.id || uniqueId(doc, 'k', { kind: 'keys' });
    tl.keys.push({ id, ...normKey({ ...op, t }) });
    if (t > tl.duration) tl.duration = round(t);
    sortKeys(doc);
    return { id };
  },

  'key.update'(doc, op) {
    const k = findKey(doc, op.id ?? op.index);
    const { id, index, ...rest } = op;
    Object.assign(k, normKey(rest, k));
    if (k.t > doc.timeline.duration) doc.timeline.duration = k.t;
    sortKeys(doc);
    return { id: k.id };
  },

  'key.remove'(doc, op) {
    const k = findKey(doc, op.id ?? op.index);
    doc.timeline.keys = doc.timeline.keys.filter((x) => x !== k);
    return { removed: k.id };
  },

  'key.clear'(doc) {
    const n = doc.timeline.keys.length;
    doc.timeline.keys = [];
    return { removed: n };
  },

  // ----- object animation -----
  /** Key an object's transform at time t (fields left out keep where the object is at t). */
  'anim.key'(doc, op) {
    const o = findObject(doc, op.id);
    const k = putAnimKey(doc, o, { t: op.t ?? 0, position: op.position, rotation: op.rotation, scale: op.scale, ease: op.ease });
    return { id: o.id, t: k.t, keys: o.anim.length };
  },

  /**
   * Move an object over time: from `at` (default 0) to `at + over` (default 1 s), ending at `to`
   * (or shifted `by`), optionally rotating/scaling. Keeps where it is at `at` as the start key.
   */
  'anim.move'(doc, op) {
    const o = findObject(doc, op.id);
    const at = op.at ?? 0, over = op.over ?? 1;
    if (!(at >= 0)) throw new Error('at must be a time ≥ 0');
    if (!(over > 0)) throw new Error('over must be a duration > 0');
    const speedless = { ...doc.timeline, speed: 'linear' };
    const start = sampleObject(o, speedless, at);
    putAnimKey(doc, o, { t: at, ...start, ease: op.ease });
    const end = {};
    if (op.to != null) end.position = vec3(op.to, 'to');
    if (op.by != null) end.position = vec3(op.by, 'by').map((v, i) => round((end.position ?? start.position)[i] + v));
    if (op.rotation != null) end.rotation = vec3(op.rotation, 'rotation');
    if (op.turn != null) end.rotation = vec3(op.turn, 'turn').map((v, i) => round((end.rotation ?? start.rotation)[i] + v));
    if (op.scale != null) end.scale = vec3(op.scale, 'scale');
    if (!Object.keys(end).length) throw new Error('anim.move needs to, by, rotation, turn or scale');
    putAnimKey(doc, o, { t: at + over, ...start, ...end, ease: op.ease });
    return { id: o.id, from: round(at), to: round(at + over), keys: o.anim.length };
  },

  'anim.remove'(doc, op) {
    const o = findObject(doc, op.id);
    const before = o.anim?.length || 0;
    o.anim = (o.anim || []).filter((k) => !(op.t != null ? Math.abs(k.t - op.t) < 1e-3 : true));
    if (op.t != null && o.anim.length === before) throw new Error(`${o.id} has no key at ${op.t}s (keys at: ${(o.anim || []).map((k) => k.t).join(', ') || 'none'})`);
    if (o.anim.length) syncAnim(o); else delete o.anim;
    return { id: o.id, keys: o.anim?.length || 0 };
  },

  timeline(doc, op) {
    const tl = doc.timeline;
    if (op.duration != null) {
      if (!(op.duration > 0 && op.duration <= 600)) throw new Error('duration must be 0–600 s');
      if (op.retime) { // scale key times to the new duration
        const f = op.duration / tl.duration;
        tl.keys.forEach((k) => { k.t = round(k.t * f); });
        doc.objects.forEach((o) => o.anim?.forEach((k) => { k.t = round(k.t * f); }));
      }
      tl.duration = round(op.duration);
    }
    if (op.fps != null) {
      if (!(op.fps >= 1 && op.fps <= 120)) throw new Error('fps must be 1–120');
      tl.fps = Math.round(op.fps * 1000) / 1000; // decimals allowed (23.976)
    }
    if (op.interp != null) {
      if (!['smooth', 'linear'].includes(op.interp)) throw new Error('interp must be "smooth" or "linear"');
      tl.interp = op.interp;
    }
    if (op.speed != null) {
      if (op.speed === 'hold') throw new Error('the shot speed curve cannot be "hold"');
      resolveEase(op.speed);
      tl.speed = op.speed;
    }
    if (op.ease != null) { resolveEase(op.ease); tl.keys.forEach((k) => { k.ease = op.ease; }); }
    return { timeline: { duration: tl.duration, fps: tl.fps, interp: tl.interp, speed: tl.speed, keys: tl.keys.length } };
  },

  'controls.set'(doc, op) {
    if (!op.key) throw new Error('controls.set needs a key');
    if (op.value === undefined) delete doc.controls[op.key];
    else doc.controls[op.key] = clone(op.value);
    return { key: op.key };
  },

  load(doc, op) {
    const next = migrate(op.doc);
    for (const k of Object.keys(doc)) delete doc[k];
    Object.assign(doc, next);
    return { objects: doc.objects.length, keys: doc.timeline.keys.length };
  },

  batch(doc, op) {
    return { results: (op.ops || []).map((o) => applyOneInPlace(doc, o)) };
  },
};

function applyOneInPlace(doc, op) {
  if (!op || typeof op.op !== 'string') throw new Error(`each op needs an "op" field, got ${JSON.stringify(op)}`);
  const fn = OPS[op.op];
  if (!fn) throw new Error(`unknown op "${op.op}" (ops: ${Object.keys(OPS).join(', ')})`);
  return fn(doc, op);
}

/**
 * Apply one op or an array of ops atomically. Returns { doc, results }.
 * Throws (leaving the input untouched) if any op fails.
 */
export function applyOps(doc, ops) {
  const next = clone(doc);
  const list = Array.isArray(ops) ? ops : [ops];
  const results = list.map((op, i) => {
    try {
      return applyOneInPlace(next, op);
    } catch (e) {
      e.message = list.length > 1 ? `op ${i} (${op?.op}): ${e.message}` : e.message;
      throw e;
    }
  });
  return { doc: next, results };
}

/** Fill in defaults so older or hand-written scene files load. */
export function migrate(input) {
  const base = createDoc();
  const d = clone(input || {});
  const doc = {
    ...base,
    ...d,
    meta: { ...base.meta, ...(d.meta || {}) },
    env: { ...base.env, ...(d.env || {}) },
    timeline: { ...base.timeline, ...(d.timeline || {}) },
    controls: { ...(d.controls || {}) },
    objects: [],
  };
  if (!d.timeline?.keys) doc.timeline.keys = base.timeline.keys;
  doc.timeline.keys = doc.timeline.keys.map((k, i) => ({ id: k.id || `k${i + 1}`, ...normKey(k) }));
  sortKeys(doc);
  for (const o of d.objects || []) {
    const { doc: tmp } = applyOps(doc, { op: 'add', ...o, params: o.params });
    doc.objects = tmp.objects;
  }
  doc.version = 1;
  return doc;
}

/** One-line description of an object, for agents. */
export function describe(o) {
  const p = Object.entries(o.params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' ');
  const r = o.rotation.some((v) => v) ? ` rot=${o.rotation.join(',')}` : '';
  const s = o.scale.some((v) => v !== 1) ? ` scale=${o.scale.join(',')}` : '';
  const a = o.anim?.length ? ` anim: ${o.anim.map((k) => `${k.t}s@${k.position.join(',')}${k.rotation.some((v) => v) ? ` rot=${k.rotation.join(',')}` : ''}`).join(' → ')}` : '';
  return `${o.id} (${o.type} ${p}) pos=${o.position.join(',')}${r}${s} ${o.color}${o.note ? ` — ${o.note}` : ''}${a}`;
}

export const EASE_NAMES = Object.keys(EASES);
