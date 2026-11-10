#!/usr/bin/env node
// Fits the artist-mannequin parts for the `person` primitive (male, female, child) and writes them to
// app/people-data.js, a few KB the app builds low-poly mannequins from (about 4.5k triangles each).
//
// Source: the MakeHuman 1.1 base mesh, macro targets and default skeleton (makehumancommunity.org), whose
// assets are CC0. They come from the npm package makehuman-data@0.0.2 (a three.js-friendly export of
// MakeHuman's data; the files still carry 2015-era AGPL headers, which MakeHuman's 2020 licence note says
// no longer apply to assets). Not needed at runtime; rerun only to change the bodies:
//
//   cd /tmp && npm pack makehuman-data@0.0.2 && tar xzf makehuman-data-0.0.2.tgz   # ~90 MB
//   node tools/bake-people.mjs /tmp/package app/people-data.js
//
// For each body: apply MakeHuman's macro targets (gender, age, muscle, weight; ethnicity mixed evenly), pose
// it at ease with the skeleton's skin weights (arms down at the sides, elbows soft, fingers together, palms
// toward the thighs), then fit mannequin parts to the posed skin: an egg for the head, three eggs for the
// torso cut by height (ribcage, waist, pelvis), tapered limbs between the joints with ball joints at the
// shoulders, elbows and knees, egg hands and feet, and for the female body two balls for the bust.
// Everything is 1 unit tall, feet on y = 0, pivot between the ankles, facing +z.

import fs from 'node:fs';
const [P, OUT = 'app/people-data.js'] = process.argv.slice(2);
if (!P) { console.error('usage: node tools/bake-people.mjs <unpacked makehuman-data package dir> [out.js]'); process.exit(1); }
const mesh = JSON.parse(fs.readFileSync(`${P}/public/data/models/human_full_size.json`, 'utf8'));
const tlist = Object.keys(JSON.parse(fs.readFileSync(`${P}/src/json/targets/target-list.json`, 'utf8')).targets).sort();
const NV = mesh.vertices.length / 3, ROW = NV * 3;
const binFd = fs.openSync(`${P}/public/data/targets/targets.bin`, 'r');
if (fs.fstatSync(binFd).size !== tlist.length * ROW * 2) throw new Error('targets.bin size mismatch');
const row = (name) => {
  const i = tlist.indexOf(name); if (i < 0) throw new Error('no target ' + name);
  const b = Buffer.alloc(ROW * 2); fs.readSync(binFd, b, 0, ROW * 2, i * ROW * 2);
  return new Int16Array(b.buffer, b.byteOffset, ROW);
};
// MakeHuman macro weights (human.py)
const ageW = (a) => a < 0.5
  ? (() => { const young = Math.max(0, (a - 0.1875) * 3.2); const baby = Math.max(0, 1 - a * 5.333); return { baby, child: Math.max(0, Math.min(1, 5.333 * a) - young), young, old: 0 }; })()
  : { baby: 0, child: 0, young: 1 - Math.max(0, a * 2 - 1), old: Math.max(0, a * 2 - 1) };
const triW = (v, lo, mid, hi) => v < 0.5 ? { [lo]: 1 - v * 2, [mid]: v * 2, [hi]: 0 } : { [lo]: 0, [mid]: 1 - (v - 0.5) * 2, [hi]: (v - 0.5) * 2 };
function targetsFor({ gender, age, muscle = 0.5, weight = 0.5 }) {
  const G = { female: 1 - gender, male: gender }, A = ageW(age);
  const M = triW(muscle, 'minmuscle', 'averagemuscle', 'maxmuscle'), W = triW(weight, 'minweight', 'averageweight', 'maxweight');
  const R = { african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 };
  const out = new Map();
  for (const [g, gw] of Object.entries(G)) for (const [a, aw] of Object.entries(A)) {
    if (!(gw * aw)) continue;
    for (const [r, rw] of Object.entries(R)) out.set(`data/targets/macrodetails/${r}-${g}-${a}.target`, rw * gw * aw);
    for (const [m, mw] of Object.entries(M)) for (const [w, ww] of Object.entries(W)) if (gw * aw * mw * ww)
      out.set(`data/targets/macrodetails/universal-${g}-${a}-${m}-${w}.target`, gw * aw * mw * ww);
  }
  // Mannequin-smooth chest: flatten the nipples (the same modifiers MakeHuman's breast sliders use).
  out.set('data/targets/breast/nipple-point-in.target', 1);
  out.set('data/targets/breast/nipple-size-min.target', 1);
  return out;
}
function shape(cfg) {
  const co = Float64Array.from(mesh.vertices);
  for (const [t, w] of targetsFor(cfg)) { const r = row(t); for (let i = 0; i < ROW; i++) if (r[i]) co[i] += w * r[i] * 1e-3; }
  return co;
}
const J = mesh.metadata.joint_pos_idxs;
const joint = (co, n) => { const ix = J[n]; const p = [0, 0, 0]; for (const i of ix) for (let k = 0; k < 3; k++) p[k] += co[i * 3 + k] / ix.length; return p; };
const B = mesh.bones;
const subtree = (name) => { const root = B.findIndex((b) => b.name === name); const s = new Set([root]); let grew = true; while (grew) { grew = false; B.forEach((b, i) => { if (!s.has(i) && s.has(b.parent)) { s.add(i); grew = true; } }); } return s; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const boneW = (bones, v) => { let w = 0; for (let k = 0; k < 4; k++) if (bones.has(mesh.skinIndices[v * 4 + k])) w += mesh.skinWeights[v * 4 + k]; return w; };
// Linear-blend rotate the skin of a bone chain (bone + descendants) by `ang` radians about `axis` through `pivot`.
function rotateChain(co, bone, pivot, axis, ang) {
  const bones = subtree(bone), k = norm(axis), c = Math.cos(ang), s = Math.sin(ang);
  for (let v = 0; v < NV; v++) {
    const w = boneW(bones, v); if (!w) continue;
    const p = sub([co[v * 3], co[v * 3 + 1], co[v * 3 + 2]], pivot), kx = cross(k, p), kd = dot(k, p);
    for (let i = 0; i < 3; i++) co[v * 3 + i] = pivot[i] + (1 - w) * p[i] + w * (p[i] * c + kx[i] * s + k[i] * kd * (1 - c));
  }
}
const signedAngle = (a, b, axis) => Math.atan2(dot(cross(a, b), axis), dot(a, b));
const flat = (a, n) => norm(sub(a, n.map((x) => x * dot(a, n))));
const palmNormal = (co, S) => norm(cross(sub(joint(co, `finger2-1.${S}____head`), joint(co, `finger5-1.${S}____head`)), sub(joint(co, `finger3-1.${S}____head`), joint(co, `wrist.${S}____head`))));
// Stand at ease: fingers together and slightly curled, arms down at the sides, palms toward the thighs.
function relax(co, hang) {
  for (const S of ['L', 'R']) {
    const side = Math.sign(joint(co, `wrist.${S}____head`)[0]);
    let n = palmNormal(co, S); const flip = n[1] > 0 ? -1 : 1; n = n.map((x) => x * flip); // rest pose: palm faces down
    // fingers: close the splay toward the middle finger, then curl toward the palm
    const mid = norm(sub(joint(co, `finger3-2.${S}____head`), joint(co, `finger3-1.${S}____head`)));
    for (const f of [2, 4, 5]) {
      const base = joint(co, `finger${f}-1.${S}____head`), dir = norm(sub(joint(co, `finger${f}-2.${S}____head`), base));
      rotateChain(co, `finger${f}-1.${S}____head`, base, n, 0.7 * signedAngle(flat(dir, n), flat(mid, n), n));
    }
    for (const f of [2, 3, 4, 5]) for (const [seg, deg] of [[1, 12], [2, 18], [3, 14]]) {
      const base = joint(co, `finger${f}-${seg}.${S}____head`), dir = norm(sub(joint(co, `finger${f}-${seg + 1 > 3 ? 3 : seg + 1}.${S}____${seg === 3 ? 'tail' : 'head'}`), base));
      rotateChain(co, `finger${f}-${seg}.${S}____head`, base, cross(dir, n), deg * Math.PI / 180);
    }
    // Straighten the arm piece by piece (MakeHuman's rest pose holds the arms out and the forearms forward):
    // upper arm hangs `hang`° out from vertical, the elbow bends a little forward, the wrist is straight.
    const H = hang * Math.PI / 180;
    const aim = (bone, from, to, target, k = 1) => {
      const p = joint(co, from), cur = norm(sub(joint(co, to), p)), t = norm(target);
      const ax = cross(cur, t); if (Math.hypot(...ax) < 1e-6) return;
      rotateChain(co, bone, p, ax, k * Math.acos(Math.max(-1, Math.min(1, dot(cur, t)))));
    };
    const cur = (() => { const a = joint(co, `upperarm01.${S}____head`), b = joint(co, `wrist.${S}____head`); return Math.atan2(Math.abs(b[0] - a[0]), a[1] - b[1]); })();
    aim(`upperarm01.${S}____head`, `upperarm01.${S}____head`, `lowerarm01.${S}____head`, [side * Math.sin(H), -Math.cos(H), -0.02]);
    aim(`lowerarm01.${S}____head`, `lowerarm01.${S}____head`, `wrist.${S}____head`, [side * Math.sin(H) * 0.5, -1, 0.2]);
    const fore = norm(sub(joint(co, `wrist.${S}____head`), joint(co, `lowerarm01.${S}____head`)));
    aim(`wrist.${S}____head`, `wrist.${S}____head`, `finger3-1.${S}____head`, [fore[0] * 0.6, fore[1], fore[2] * 0.6], 0.85);
    const sh = joint(co, `upperarm01.${S}____head`);
    // forearm twist so the palm faces the thigh (spread over the forearm bones to avoid a candy-wrapper wrist)
    const el = joint(co, `lowerarm01.${S}____head`), f = norm(sub(joint(co, `wrist.${S}____head`), el));
    n = palmNormal(co, S).map((x) => x * flip);
    const want = [-side, 0, -0.35];
    const tw = signedAngle(flat(n, f), flat(norm(want), f), f);
    for (const [b, k] of [[`lowerarm01.${S}____head`, 0.3], [`lowerarm02.${S}____head`, 0.4], [`wrist.${S}____head`, 0.3]]) rotateChain(co, b, el, f, k * tw);
    const wr2 = joint(co, `wrist.${S}____head`);
    console.log(`  arm ${S}: ${(cur * 180 / Math.PI).toFixed(1)}° -> ${(Math.atan2(Math.abs(wr2[0] - sh[0]), -(wr2[1] - sh[1])) * 180 / Math.PI).toFixed(1)}°, twist ${(tw * 180 / Math.PI).toFixed(0)}°`);
  }
}
// faces
const names = mesh.materials.map((m) => m.DbgName), F = mesh.faces, KEEP = new Set(['body', 'helper-l-eye', 'helper-r-eye']);
const tris = [];
for (let i = 0; i < F.length;) {
  const t = F[i++]; const n = t & 1 ? 4 : 3; const v = F.slice(i, i + n); i += n;
  let mat = 0; if (t & 2) mat = F[i++];
  if (t & 4) i += mesh.uvs.length; if (t & 8) i += n * mesh.uvs.length; if (t & 16) i++; if (t & 32) i += n; if (t & 64) i++; if (t & 128) i += n;
  if (!KEEP.has(names[mat])) continue;
  tris.push(v[0], v[1], v[2]); if (n === 4) tris.push(v[0], v[2], v[3]);
}
const usedV = [...new Set(tris)].sort((a, b) => a - b), remap = new Map(usedV.map((v, i) => [v, i]));
const index = Uint16Array.from(tris, (v) => remap.get(v));
console.log('verts', usedV.length, 'tris', index.length / 3);
// ---------- fit artist-mannequin parts to each shaped, posed body ----------
const boneName = (i) => B[i].name.replace('____head', '');
const dominant = (v) => { let best = -1, bw = 0; for (let k = 0; k < 4; k++) { const w = mesh.skinWeights[v * 4 + k]; if (w > bw) { bw = w; best = mesh.skinIndices[v * 4 + k]; } } return best; };
const inSub = (root) => { const s = subtree(`${root}____head`); return (b) => s.has(b); };
const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]; };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
// Axis-aligned ellipsoid around a point cloud (2nd–98th percentile extents).
function eggAA(pts, grow = 1, q = 0.02) {
  const c = [], r = [];
  for (let k = 0; k < 3; k++) { const v = pts.map((p) => p[k]), lo = pct(v, q), hi = pct(v, 1 - q); c.push((lo + hi) / 2); r.push(((hi - lo) / 2) * grow); }
  return ['egg', c.map(r4), r.map(r4)];
}
// Ellipsoid along the point cloud's principal axes (hands, feet).
function eggPCA(pts, grow = 1, minRatio = 0) {
  const n = pts.length, c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / n);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (p[i] - c[i]) * (p[j] - c[j]) / n;
  // Jacobi eigen-decomposition of the 3×3 covariance
  const A = C.map((r) => [...r]), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1; for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(A[i][j]) > Math.abs(A[p][q])) { p = i; q = j; }
    if (Math.abs(A[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), cs = Math.cos(th), sn = Math.sin(th);
    for (let k = 0; k < 3; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = cs * a - sn * b; A[k][q] = sn * a + cs * b; }
    for (let k = 0; k < 3; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = cs * a - sn * b; A[q][k] = sn * a + cs * b; }
    for (let k = 0; k < 3; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = cs * a - sn * b; V[k][q] = sn * a + cs * b; }
  }
  let ax = [0, 1, 2].map((i) => [V[0][i], V[1][i], V[2][i]]);
  if (dot(cross(ax[0], ax[1]), ax[2]) < 0) ax[2] = ax[2].map((x) => -x);
  // radius along each axis from the spread of the points (2nd–98th percentile), centred on the midpoint
  const r = [], mid = [...c];
  for (let i = 0; i < 3; i++) { const d = pts.map((p) => dot(sub(p, c), ax[i])), lo = pct(d, 0.02), hi = pct(d, 0.98); r.push(((hi - lo) / 2) * grow); for (let k = 0; k < 3; k++) mid[k] += ax[i][k] * (lo + hi) / 2; }
  const rm = Math.max(...r) * 0.5 + Math.min(...r) * 0.5; for (let i = 0; i < 3; i++) r[i] = Math.max(r[i], minRatio * rm);
  // rotation matrix (columns = axes) -> quaternion
  const m = (i, j) => ax[j][i], tr = m(0, 0) + m(1, 1) + m(2, 2);
  let q;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(m(2, 1) - m(1, 2)) / S, (m(0, 2) - m(2, 0)) / S, (m(1, 0) - m(0, 1)) / S, S / 4]; }
  else if (m(0, 0) > m(1, 1) && m(0, 0) > m(2, 2)) { const S = Math.sqrt(1 + m(0, 0) - m(1, 1) - m(2, 2)) * 2; q = [S / 4, (m(0, 1) + m(1, 0)) / S, (m(0, 2) + m(2, 0)) / S, (m(2, 1) - m(1, 2)) / S]; }
  else if (m(1, 1) > m(2, 2)) { const S = Math.sqrt(1 + m(1, 1) - m(0, 0) - m(2, 2)) * 2; q = [(m(0, 1) + m(1, 0)) / S, S / 4, (m(1, 2) + m(2, 1)) / S, (m(0, 2) - m(2, 0)) / S]; }
  else { const S = Math.sqrt(1 + m(2, 2) - m(0, 0) - m(1, 1)) * 2; q = [(m(0, 2) + m(2, 0)) / S, (m(1, 2) + m(2, 1)) / S, S / 4, (m(1, 0) - m(0, 1)) / S]; }
  return ['egg', mid.map(r4), r.map(r4), q.map(r4)];
}
// Tapered limb from joint a to joint b; radii from how far the segment's skin sits from the bone line.
function limbFit(a, b, pts, k = 1, nearT = [0.08, 0.4]) {
  const d = sub(b, a), L = Math.hypot(...d), u = d.map((x) => x / L), near = [], far = [];
  for (const p of pts) { const w = sub(p, a), t = dot(w, u) / L; const rr = Math.hypot(...sub(w, u.map((x) => x * t * L))); if (t > nearT[0] && t < nearT[1]) near.push(rr); else if (t > 0.6 && t < 0.92) far.push(rr); }
  const rn = pct(near.length ? near : far, 0.6), rf = pct(far.length ? far : near, 0.6);
  return ['limb', a.map(r4), b.map(r4), r4(rn * k), r4(rf * k)];
}

// Slide a hand (or foot) egg along wrist -> centre so its near end tucks into the joint instead of floating.
function handAt(j, egg) {
  const d = sub(egg[1], j), L = Math.hypot(...d), long = Math.max(...egg[2]);
  return ['egg', j.map((x, i) => r4(x + (d[i] / L) * long * 0.8)), egg[2], egg[3]];
}
const BODIES = { male: { gender: 1, age: 0.5 }, female: { gender: 0, age: 0.5 }, child: { gender: 0.5, age: 0.15 } };
const out = {};
for (const [name, cfg] of Object.entries(BODIES)) {
  console.log(name);
  const co = shape(cfg);
  relax(co, 10);
  // unit height, feet on the ground, pivot between the ankles
  let minY = Infinity, maxY = -Infinity; for (const v of usedV) { minY = Math.min(minY, co[v * 3 + 1]); maxY = Math.max(maxY, co[v * 3 + 1]); }
  const aL = joint(co, 'foot.L____head'), aR = joint(co, 'foot.R____head'), cz = (aL[2] + aR[2]) / 2, H = maxY - minY;
  const U = (p) => [p[0] / H, (p[1] - minY) / H, (p[2] - cz) / H];
  const J = (n) => U(joint(co, `${n}____head`));
  const pts = (test) => usedV.filter((v) => v < 13380 && test(dominant(v))).map((v) => U([co[v * 3], co[v * 3 + 1], co[v * 3 + 2]]));
  const named = (...ns) => (b) => ns.includes(boneName(b));
  const female = cfg.gender < 0.5;
  const parts = [];
  parts.push(eggAA(pts(inSub('head')), 1, 0.003)); // chin to crown, ear to ear, nose to back
  parts.push(limbFit(J('neck01'), J('head'), pts(named('neck01', 'neck02', 'neck03')), 1.05));
  // Torso as three eggs (ribcage, waist, pelvis) cut from the trunk by height: each egg is as wide and deep
  // as the trunk in its band and overlaps its neighbours a little, like a wooden mannequin.
  const trunk = pts(named('spine01', 'spine02', 'spine03', 'spine04', 'spine05', 'root', 'pelvis.L', 'pelvis.R', 'clavicle.L', 'clavicle.R', 'breast.L', 'breast.R', 'upperleg01.L', 'upperleg01.R'));
  const crotch = pct(pts(named('upperleg01.L', 'upperleg01.R', 'upperleg02.L', 'upperleg02.R')).filter((p) => Math.abs(p[0]) < 0.012).map((p) => p[1]), 0.98);
  const band = (y0, y1, grow = 1.12) => {
    const b = trunk.filter((p) => p[1] >= y0 && p[1] <= y1), zs = b.map((p) => p[2]), z0 = pct(zs, 0.03), z1 = pct(zs, 0.97);
    return ['egg', [0, (y0 + y1) / 2, (z0 + z1) / 2].map(r4), [pct(b.map((p) => Math.abs(p[0])), 0.97), ((y1 - y0) / 2) * grow, (z1 - z0) / 2].map(r4)];
  };
  const yNeck = J('neck01')[1], yRib = J('spine02')[1], yWaist = J('spine04')[1];
  parts.push(band(yRib, yNeck - 0.01), band(yWaist, yRib, 1.3), band(crotch, yWaist + 0.01));
  if (female) for (const S of ['L', 'R']) { // breasts: balls set into the chest, as far forward as the bust
    const b = pts(named(`breast.${S}`)), cx = b.reduce((t, p) => t + p[0], 0) / b.length, cy = b.reduce((t, p) => t + p[1], 0) / b.length;
    const front = pct(trunk.filter((p) => Math.abs(p[1] - cy) < 0.02 && Math.abs(p[0] - cx) < 0.02).map((p) => p[2]), 0.98);
    const r = 0.36 * parts[2][2][0]; // about a third of the ribcage half-width
    parts.push(['ball', [cx, cy - 0.15 * r, front - r].map(r4), r4(r)]);
  }
  for (const S of ['L', 'R']) {
    const up = limbFit(J(`upperarm01.${S}`), J(`lowerarm01.${S}`), pts(named(`upperarm01.${S}`, `upperarm02.${S}`)));
    const fo = limbFit(J(`lowerarm01.${S}`), J(`wrist.${S}`), pts(named(`lowerarm01.${S}`, `lowerarm02.${S}`)));
    const th = limbFit(J(`upperleg01.${S}`), J(`lowerleg01.${S}`), pts(named(`upperleg01.${S}`, `upperleg02.${S}`)), 1, [0.3, 0.5]);
    const sh = limbFit(J(`lowerleg01.${S}`), J(`foot.${S}`), pts(named(`lowerleg01.${S}`, `lowerleg02.${S}`)));
    parts.push(
      ['ball', J(`upperarm01.${S}`).map(r4), r4(up[3] * 1.15)], up,
      ['ball', J(`lowerarm01.${S}`).map(r4), r4(Math.min(up[4], fo[3]) * 0.95)], fo,
      handAt(J(`wrist.${S}`), eggPCA(pts(inSub(`wrist.${S}`)), 1, 0.55)),
      th, ['ball', J(`lowerleg01.${S}`).map(r4), r4(Math.min(th[4], sh[3]) * 0.95)], sh,
      eggPCA(pts(inSub(`foot.${S}`))),
    );
  }
  if (process.env.DEBUG_JOINTS) for (const n of ['head', 'neck01', 'spine01', 'spine02', 'spine03', 'spine04', 'spine05', 'root', 'pelvis.L', 'upperleg01.L', 'clavicle.L', 'upperarm01.L', 'breast.L']) console.log('   ', n, J(n).map((x) => x.toFixed(3)).join(' '));
  out[name] = parts;
  console.log(`  ${parts.length} parts, height ${(H / 10).toFixed(2)} m in MakeHuman units`);
}
const src = `// Generated by tools/bake-people.mjs from the MakeHuman base mesh, macro targets and skeleton (CC0,
// makehumancommunity.org). Do not edit by hand. Artist-mannequin parts for each body, 1 unit tall,
// feet on y = 0, pivot between the ankles, facing +z:
//   ['egg', centre, radii, quaternion?]   ['ball', centre, r]   ['limb', from, to, rFrom, rTo]
export const BODY_PARTS = {
${Object.entries(out).map(([k, ps]) => `  ${k}: [\n${ps.map((p) => `    ${JSON.stringify(p)},`).join('\n')}\n  ],`).join('\n')}
};
`;
fs.writeFileSync(OUT, src);
console.log('wrote', OUT, src.length, 'bytes');
