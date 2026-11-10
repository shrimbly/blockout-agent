#!/usr/bin/env node
// Bakes the `person` figures (male, female, child) into app/people-data.js: one smooth low-poly mesh per
// body, about 3k triangles. Only half of each is stored (the app mirrors it), as base64 typed arrays (~60 KB
// in all).
//
// Source: the MakeHuman 1.1 base mesh, macro targets and default skeleton (makehumancommunity.org), whose
// assets are CC0. They come from the npm package makehuman-data@0.0.2 (a three.js-friendly export of
// MakeHuman's data; the files still carry 2015-era AGPL headers, which MakeHuman's 2020 licence note says
// no longer apply to assets). Simplification uses meshoptimizer (MIT). Neither is needed at runtime; rerun
// only to change the bodies (about 30 s):
//
//   cd /tmp && npm pack makehuman-data@0.0.2 && tar xzf makehuman-data-0.0.2.tgz   # ~90 MB
//   npm install --no-save meshoptimizer
//   node tools/bake-people.mjs /tmp/package app/people-data.js
//
// For each body:
//   1. shape   MakeHuman's macro targets (gender, age, muscle, weight; ethnicity mixed evenly)
//   2. pose    at ease, using the skeleton's skin weights: feet under the hips, arms down at the sides,
//              fingers together, palms toward the thighs
//   3. seal    fill the posed body into voxels, close every narrow gap (eyes, mouth, nostrils, ear folds,
//              between the fingers and toes) and take the surface of the result: one sealed skin with a
//              plain face, mitten hands and no toes. Only the +x half is kept.
//   4. melt    smooth it, the head, hands and feet harder than the rest
//   5. reduce  simplify to the triangle budget, and keep the smooth surface's normals for shading
// Output is 1 unit tall, feet on y = 0, pivot between the ankles, facing +z. The numbers below can each be
// set from the environment (for example TARGET=4000 for more triangles).

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
  // Mannequin-smooth chest, crotch and lips (the same modifiers MakeHuman's own sliders use).
  out.set('data/targets/breast/nipple-point-in.target', 1);
  out.set('data/targets/breast/nipple-size-min.target', 1);
  out.set('data/targets/pelvis/bulge-decr.target', 1);
  for (const m of (process.env.MOUTH ?? 'mouth-scale-depth-decr,mouth-upperlip-volume-deflate,mouth-lowerlip-volume-deflate').split(',').filter(Boolean)) out.set(`data/targets/mouth/${m}.target`, 1);
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
const STANCE = Number(process.env.STANCE ?? 1.12); // ankle distance from the centre line, as a multiple of the hip joint's
const flat = (a, n) => norm(sub(a, n.map((x) => x * dot(a, n))));
const palmNormal = (co, S) => norm(cross(sub(joint(co, `finger2-1.${S}____head`), joint(co, `finger5-1.${S}____head`)), sub(joint(co, `finger3-1.${S}____head`), joint(co, `wrist.${S}____head`))));
// Stand at ease: feet under the hips, fingers together and slightly curled, arms down at the sides (the upper
// arm `hang` degrees out from vertical, the forearm `flare` degrees), palms toward the thighs.
function relax(co, hang, flare) {
  for (const S of ['L', 'R']) {
    // legs: MakeHuman's rest pose stands wide; swing each leg in from the hip and keep the sole flat
    const hip = joint(co, `upperleg01.${S}____head`), ank = joint(co, `foot.${S}____head`);
    const swing = Math.atan2(hip[0] * STANCE - hip[0], hip[1] - ank[1]) - Math.atan2(ank[0] - hip[0], hip[1] - ank[1]);
    rotateChain(co, `upperleg01.${S}____head`, hip, [0, 0, 1], swing);
    rotateChain(co, `foot.${S}____head`, joint(co, `foot.${S}____head`), [0, 0, 1], -swing);
  }
  for (const S of ['L', 'R']) {
    const side = Math.sign(joint(co, `wrist.${S}____head`)[0]);
    let n = palmNormal(co, S); const flip = n[1] > 0 ? -1 : 1; n = n.map((x) => x * flip); // rest pose: palm faces down
    // fingers: close the splay toward the middle finger, then curl toward the palm
    const mid = norm(sub(joint(co, `finger3-2.${S}____head`), joint(co, `finger3-1.${S}____head`)));
    for (const f of [2, 4, 5]) {
      const base = joint(co, `finger${f}-1.${S}____head`), dir = norm(sub(joint(co, `finger${f}-2.${S}____head`), base));
      rotateChain(co, `finger${f}-1.${S}____head`, base, n, 0.7 * signedAngle(flat(dir, n), flat(mid, n), n));
    }
    for (const f of [2, 3, 4, 5]) for (const [seg, deg] of [[1, 6], [2, 10], [3, 8]]) {
      const base = joint(co, `finger${f}-${seg}.${S}____head`), dir = norm(sub(joint(co, `finger${f}-${seg + 1 > 3 ? 3 : seg + 1}.${S}____${seg === 3 ? 'tail' : 'head'}`), base));
      rotateChain(co, `finger${f}-${seg}.${S}____head`, base, cross(dir, n), deg * Math.PI / 180);
    }
    // Straighten the arm piece by piece (MakeHuman's rest pose holds the arms out and the forearms forward):
    // the elbow also bends a little forward, and the wrist is straight.
    const H = hang * Math.PI / 180, F = flare * Math.PI / 180;
    const aim = (bone, from, to, target, k = 1) => {
      const p = joint(co, from), cur = norm(sub(joint(co, to), p)), t = norm(target);
      const ax = cross(cur, t); if (Math.hypot(...ax) < 1e-6) return;
      rotateChain(co, bone, p, ax, k * Math.acos(Math.max(-1, Math.min(1, dot(cur, t)))));
    };
    aim(`upperarm01.${S}____head`, `upperarm01.${S}____head`, `lowerarm01.${S}____head`, [side * Math.sin(H), -Math.cos(H), -0.02]);
    aim(`lowerarm01.${S}____head`, `lowerarm01.${S}____head`, `wrist.${S}____head`, [side * Math.sin(F), -Math.cos(F), 0.2]);
    const fore = norm(sub(joint(co, `wrist.${S}____head`), joint(co, `lowerarm01.${S}____head`)));
    aim(`wrist.${S}____head`, `wrist.${S}____head`, `finger3-1.${S}____head`, [fore[0] * 0.6, fore[1], fore[2] * 0.6], 0.85);
    // forearm twist so the palm faces the thigh (spread over the forearm bones to avoid a candy-wrapper wrist)
    const el = joint(co, `lowerarm01.${S}____head`), f = norm(sub(joint(co, `wrist.${S}____head`), el));
    n = palmNormal(co, S).map((x) => x * flip);
    const want = [-side, 0, -0.35];
    const tw = signedAngle(flat(n, f), flat(norm(want), f), f);
    for (const [b, k] of [[`lowerarm01.${S}____head`, 0.3], [`lowerarm02.${S}____head`, 0.4], [`wrist.${S}____head`, 0.3]]) rotateChain(co, b, el, f, k * tw);
  }
}

// ---------- triangles of the body and the eyeballs (MakeHuman's other helper geometry is dropped) ----------
const names = mesh.materials.map((m) => m.DbgName), F = mesh.faces;
const bodyTris = [], eyeTris = [];
for (let i = 0; i < F.length;) {
  const t = F[i++]; const n = t & 1 ? 4 : 3; const v = F.slice(i, i + n); i += n;
  let mat = 0; if (t & 2) mat = F[i++];
  if (t & 4) i += mesh.uvs.length; if (t & 8) i += n * mesh.uvs.length; if (t & 16) i++; if (t & 32) i += n; if (t & 64) i++; if (t & 128) i += n;
  const to = names[mat] === 'body' ? bodyTris : /^helper-[lr]-eye$/.test(names[mat]) ? eyeTris : null;
  if (!to) continue;
  to.push(v[0], v[1], v[2]); if (n === 4) to.push(v[0], v[2], v[3]);
}
const bodyV = [...new Set(bodyTris)];
const chain = (roots) => { const s = new Set(); for (const r of roots) for (const b of subtree(`${r}____head`)) s.add(b); return s; };
const HEAD = chain(['head']);
const headW = new Float32Array(NV); for (const v of bodyV) headW[v] = boneW(HEAD, v);
const BREAST = chain(['breast.L', 'breast.R']), GROIN = (() => { const r = row('data/targets/pelvis/bulge-decr.target'); return bodyV.filter((v) => r[v * 3] || r[v * 3 + 1] || r[v * 3 + 2]); })();
const HAND = chain(['wrist.L', 'wrist.R']), TOES = chain(['L', 'R'].flatMap((S) => [1, 2, 3, 4, 5].map((t) => `toe${t}-1.${S}`)));

const { MeshoptSimplifier: MS } = await import(process.env.MESHOPT || 'meshoptimizer').catch(() => { console.error('needs meshoptimizer: npm install --no-save meshoptimizer'); process.exit(1); });
await MS.ready;
const num = (k, d) => Number(process.env[k] ?? d);
const TARGET = num('TARGET', 3000);   // triangles per body
const VOX = num('VOX', 0.025);        // voxel size, dm (the source mesh is in decimetres)
const GAP = num('GAP', 0.08);         // gaps narrower than twice this close up (fingers, toes), dm
const FACE = num('FACE', 0.15);       // the same for the head, where it also levels the eyes, mouth and ears, dm
const MITTEN = num('MITTEN', 0.15);   // the same for the hand on its own: fingers into a mitten, dm
const HANG = num('HANG', 8);          // how far the upper arms hang out from vertical, degrees
const CLEAR = num('CLEAR', 0.25);     // room kept between the hanging hand and the hip, dm
const HEAD_DETAIL = num('HEAD_DETAIL', 4); // how much finer the head is than the body
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

// ---------- 3. seal: solid voxels -> close the gaps -> one surface ----------
// Marks the voxels whose centre is inside a closed mesh. One ray per (x, y) column, counting how often it
// goes in and out (winding number), so folds in the posed skin do not punch holes.
function voxelise(co, tris, vox, { nx, ny, nz, x0, y0, z0, h }) {
  const col = [], zs = [], sg = [];
  // edge function, evaluated the same way from both triangles that share the edge, so a sample is never
  // counted by both or by neither
  const ef = (i, j, px, py) => {
    const s = i < j ? 1 : -1, l = i < j ? i : j, u = i < j ? j : i;
    const v = (co[u * 3] - co[l * 3]) * (py - co[l * 3 + 1]) - (co[u * 3 + 1] - co[l * 3 + 1]) * (px - co[l * 3]);
    return v === 0 ? s * 1e-300 : s * v;
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ax = co[a * 3], ay = co[a * 3 + 1], bx = co[b * 3], by = co[b * 3 + 1], cx = co[c * 3], cy = co[c * 3 + 1];
    // one sample wider than the bounding box: the edge test decides, not the rounding here
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / h - 0.5) - 1), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / h - 0.5) + 1);
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / h - 0.5) - 1), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / h - 0.5) + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = x0 + (i + 0.5) * h, py = y0 + (j + 0.5) * h;
      const w0 = ef(b, c, px, py), w1 = ef(c, a, px, py), w2 = ef(a, b, px, py);
      if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue;
      const area = w0 + w1 + w2;
      col.push(i + nx * j); zs.push((w0 * co[a * 3 + 2] + w1 * co[b * 3 + 2] + w2 * co[c * 3 + 2]) / area); sg.push(area > 0 ? -1 : 1);
    }
  }
  const nxy = nx * ny, start = new Int32Array(nxy + 1);
  for (const c of col) start[c + 1]++;
  for (let c = 0; c < nxy; c++) start[c + 1] += start[c];
  const order = new Int32Array(col.length), fillAt = start.slice(0, nxy);
  for (let e = 0; e < col.length; e++) order[fillAt[col[e]]++] = e;
  let leaks = 0;
  for (let c = 0; c < nxy; c++) {
    const ev = Array.from(order.subarray(start[c], start[c + 1])).sort((p, q) => zs[p] - zs[q]);
    let wind = 0;
    for (let k = 0; k < ev.length; k++) {
      wind += sg[ev[k]];
      if (!wind || k + 1 === ev.length) continue;
      const k0 = Math.max(0, Math.ceil((zs[ev[k]] - z0) / h - 0.5)), k1 = Math.min(nz - 1, Math.ceil((zs[ev[k + 1]] - z0) / h - 0.5) - 1);
      for (let z = k0; z <= k1; z++) vox[c + nxy * z] = 1;
    }
    if (wind) leaks++;
  }
  return leaks;
}

// Squared distance (in voxels) from every voxel to the nearest marked one (Felzenszwalb and Huttenlocher).
function distanceSq(mark, nx, ny, nz) {
  const N = nx * ny * nz, D = new Float32Array(N), INF = 1e9, nxy = nx * ny;
  for (let o = 0; o < N; o += nx) {
    let d = INF;
    for (let x = 0; x < nx; x++) { d = mark[o + x] ? 0 : d + 1; D[o + x] = d; }
    d = INF;
    for (let x = nx - 1; x >= 0; x--) { d = mark[o + x] ? 0 : d + 1; if (d < D[o + x]) D[o + x] = d; D[o + x] *= D[o + x]; }
  }
  const m = Math.max(ny, nz), f = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const line = (off, stride, n) => {
    for (let q = 0; q < n; q++) f[q] = D[off + q * stride];
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * (q - p)); if (s <= z[k]) k--; else break; }
      v[++k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; D[off + q * stride] = (q - p) * (q - p) + f[p]; }
  };
  for (let zi = 0; zi < nz; zi++) for (let x = 0; x < nx; x++) line(x + nxy * zi, nx, ny);
  for (let c = 0; c < nxy; c++) line(c, nxy, nz);
  return D;
}

// Closing: grow the solid by r voxels, then shrink it by r. Gaps narrower than 2r fill, the rest returns to
// where it was. Gives a field that is positive inside, zero on the new surface.
function closed(D1, r, nx, ny, nz) {
  const N = nx * ny * nz, outside = new Uint8Array(N), r2 = r * r;
  for (let i = 0; i < N; i++) if (D1[i] > r2) outside[i] = 1;
  const D2 = distanceSq(outside, nx, ny, nz);
  for (let i = 0; i < N; i++) D2[i] = Math.sqrt(D2[i]) - r;
  return D2;
}

// The zero surface of a field from grid plane `from` in x onward, by marching tetrahedra (six per cell):
// always manifold, and open only along that plane.
function surface(f, { nx, ny, nz, x0, y0, z0, h }, from) {
  const nxy = nx * ny, off = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1]; // corner code: x | y << 1 | z << 2
  const TETS = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];
  const ids = new Map(), pos = [], tri = [];
  let base = 0, bx = 0, by = 0, bz = 0;
  const vert = (ci, co_) => { // on the cell edge from an inside corner to an outside one
    const ia = base + off[ci], ib = base + off[co_], key = Math.min(ia, ib) * 8 + (ci ^ co_);
    let id = ids.get(key);
    if (id === undefined) {
      const t = Math.min(0.98, Math.max(0.02, f[ia] / (f[ia] - f[ib])));
      const c = [0, 1, 2].map((k) => ((ci >> k) & 1) + t * (((co_ >> k) & 1) - ((ci >> k) & 1)));
      id = pos.length / 3; pos.push(x0 + (bx + 0.5 + c[0]) * h, y0 + (by + 0.5 + c[1]) * h, z0 + (bz + 0.5 + c[2]) * h);
      ids.set(key, id);
    }
    return id;
  };
  const emit = (a, b, c, d) => { // wound so the normal points along d (from inside to outside)
    const u = [0, 1, 2].map((k) => pos[b * 3 + k] - pos[a * 3 + k]), w = [0, 1, 2].map((k) => pos[c * 3 + k] - pos[a * 3 + k]);
    if (dot(cross(u, w), d) < 0) tri.push(a, c, b); else tri.push(a, b, c);
  };
  for (bz = 0; bz < nz - 1; bz++) for (by = 0; by < ny - 1; by++) for (bx = from; bx < nx - 1; bx++) {
    base = bx + nx * by + nxy * bz;
    let n = 0; for (let c = 0; c < 8; c++) if (f[base + off[c]] > 0) n++;
    if (n === 0 || n === 8) continue;
    for (const T of TETS) {
      const ins = T.filter((c) => f[base + off[c]] > 0), out = T.filter((c) => !(f[base + off[c]] > 0));
      if (!ins.length || !out.length) continue;
      const d = [0, 1, 2].map((k) => out.reduce((s, c) => s + ((c >> k) & 1), 0) / out.length - ins.reduce((s, c) => s + ((c >> k) & 1), 0) / ins.length);
      if (ins.length === 1) emit(vert(ins[0], out[0]), vert(ins[0], out[1]), vert(ins[0], out[2]), d);
      else if (ins.length === 3) emit(vert(ins[0], out[0]), vert(ins[1], out[0]), vert(ins[2], out[0]), d);
      else { const a = vert(ins[0], out[0]), b = vert(ins[0], out[1]), c = vert(ins[1], out[1]), e = vert(ins[1], out[0]); emit(a, b, c, d); emit(a, c, e, d); }
    }
  }
  return { pos, tri };
}

// Keeps the biggest connected piece (drops sealed-in pockets such as the inside of the mouth).
function biggestPiece({ pos, tri }) {
  const n = pos.length / 3, par = new Int32Array(n).map((_, i) => i);
  const find = (v) => { while (par[v] !== v) { par[v] = par[par[v]]; v = par[v]; } return v; };
  for (let t = 0; t < tri.length; t += 3) { par[find(tri[t])] = find(tri[t + 1]); par[find(tri[t + 1])] = find(tri[t + 2]); }
  const size = new Map(); for (let t = 0; t < tri.length; t += 3) { const r = find(tri[t]); size.set(r, (size.get(r) || 0) + 1); }
  const keep = [...size].sort((a, b) => b[1] - a[1])[0][0], re = new Int32Array(n).fill(-1), P = [], T = [];
  for (let t = 0; t < tri.length; t += 3) {
    if (find(tri[t]) !== keep) continue;
    for (let k = 0; k < 3; k++) { const v = tri[t + k]; if (re[v] < 0) { re[v] = P.length / 3; P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); } T.push(re[v]); }
  }
  return { pos: Float64Array.from(P), tri: Uint32Array.from(T), pieces: size.size };
}

// ---------- 4. melt ----------
// Taubin smoothing (shrink, then inflate) with a per-vertex strength: melts fine detail without losing volume.
// The mesh is the +x half of a mirrored figure: vertices on x = 0 stay there and count the neighbours they
// would have on the other side.
function smooth(P, tri, w, iters, lam = 0.5, mu = -0.53) {
  const n = P.length / 3, deg = new Int32Array(n + 1);
  const seen = new Set(), pairs = [];
  for (let t = 0; t < tri.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = tri[t + k], b = tri[t + (k + 1) % 3], key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) continue; seen.add(key); pairs.push(a, b); deg[a + 1]++; deg[b + 1]++;
  }
  for (let v = 0; v < n; v++) deg[v + 1] += deg[v];
  const nb = new Int32Array(pairs.length), at = deg.slice(0, n);
  for (let i = 0; i < pairs.length; i += 2) { nb[at[pairs[i]]++] = pairs[i + 1]; nb[at[pairs[i + 1]]++] = pairs[i]; }
  const active = []; for (let v = 0; v < n; v++) if ((w ? w[v] : 1) > 0 && deg[v + 1] > deg[v]) active.push(v);
  const D = new Float64Array(active.length * 3);
  const step = (f) => {
    active.forEach((v, i) => {
      let x = 0, y = 0, z = 0, k = 0; const seam = P[v * 3] === 0;
      for (let j = deg[v]; j < deg[v + 1]; j++) { const u = nb[j] * 3, m = seam && P[u] !== 0 ? 2 : 1; x += m * P[u]; y += m * P[u + 1]; z += m * P[u + 2]; k += m; }
      const g = f * (w ? w[v] : 1);
      D[i * 3] = seam ? 0 : g * (x / k - P[v * 3]); D[i * 3 + 1] = g * (y / k - P[v * 3 + 1]); D[i * 3 + 2] = g * (z / k - P[v * 3 + 2]);
    });
    active.forEach((v, i) => { P[v * 3] += D[i * 3]; P[v * 3 + 1] += D[i * 3 + 1]; P[v * 3 + 2] += D[i * 3 + 2]; });
  };
  for (let i = 0; i < iters; i++) { step(lam); if (mu) step(mu); }
}
// Simplifies to `count` triangles. `guide` is the shape the simplifier measures error on; enlarging a part of
// it there leaves that part with more triangles.
function reduce(pos, tri, count, error, guide = pos) {
  const [all, err] = MS.simplify(tri, Float32Array.from(guide), 3, count * 3, error);
  // a thin part (an ear, say) can fold flat into two triangles back to back: drop such pairs
  const key = (t) => [all[t], all[t + 1], all[t + 2]].sort((a, b) => a - b).join(), seen = new Map();
  for (let t = 0; t < all.length; t += 3) seen.set(key(t), (seen.get(key(t)) || 0) + 1);
  const simp = all.filter((_, i) => seen.get(key(i - (i % 3))) === 1);
  const [remap, n] = MS.compactMesh(simp), P = new Float64Array(n * 3), from = new Int32Array(n);
  for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xffffffff) { from[remap[v]] = v; for (let k = 0; k < 3; k++) P[remap[v] * 3 + k] = pos[v * 3 + k]; }
  return { pos: P, tri: simp, err, from };
}
// Thins the vertices along the mirror seam (x = 0) to those its outline needs, measured on `guide` like
// reduce(). The simplifier treats the seam as an open edge and keeps far more of it than of the surface
// around it; thinning it first leaves an even mesh.
function thinSeam(P, tri, guide, tol, maxLen) {
  const T = Array.from(tri), n = P.length / 3, vt = Array.from({ length: n }, () => []);
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) vt[T[t + k]].push(t);
  const dead = new Uint8Array(T.length / 3), next = new Map(), prev = new Map(), dir = new Set();
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) dir.add(T[t + k] * n + T[t + (k + 1) % 3]);
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) { const a = T[t + k], b = T[t + (k + 1) % 3]; if (!dir.has(b * n + a)) { next.set(a, b); prev.set(b, a); } }
  const g = (v) => [guide[v * 3], guide[v * 3 + 1], guide[v * 3 + 2]], p = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const sag = (v) => { // how far v is from the straight line between its seam neighbours
    const a = g(prev.get(v)), b = g(next.get(v)), ab = sub(b, a), L = Math.hypot(...ab);
    if (L > maxLen) return Infinity;
    const u = Math.max(0, Math.min(1, dot(sub(g(v), a), ab) / (L * L || 1)));
    return Math.hypot(...sub(g(v), [a[0] + u * ab[0], a[1] + u * ab[1], a[2] + u * ab[2]]));
  };
  const live = (v) => vt[v].filter((t) => !dead[t / 3]);
  const around = (v) => { const s = new Set(); for (const t of live(v)) for (let k = 0; k < 3; k++) if (T[t + k] !== v) s.add(T[t + k]); return s; };
  const collapse = (v, u) => { // v into u, if the surface stays sound
    const nu = around(u), shared = [...around(v)].filter((x) => nu.has(x));
    if (shared.length !== 1) return false;
    const moved = [];
    for (const t of live(v)) {
      const c = [T[t], T[t + 1], T[t + 2]];
      if (c.includes(u)) continue;
      const before = cross(sub(p(c[1]), p(c[0])), sub(p(c[2]), p(c[0]))), d = c.map((x) => (x === v ? u : x)), after = cross(sub(p(d[1]), p(d[0])), sub(p(d[2]), p(d[0])));
      if (dot(before, after) <= 0.2 * Math.hypot(...before) * Math.hypot(...after)) return false;
      moved.push(t);
    }
    for (const t of live(v)) if (!moved.includes(t)) dead[t / 3] = 1;
    for (const t of moved) { for (let k = 0; k < 3; k++) if (T[t + k] === v) T[t + k] = u; vt[u].push(t); }
    const a = prev.get(v), b = next.get(v);
    next.set(a, b); prev.set(b, a); next.delete(v); prev.delete(v);
    return true;
  };
  let removed = 0;
  for (let again = true; again;) {
    again = false;
    const order = [...next.keys()].filter((v) => prev.has(v) && prev.get(v) !== next.get(v)).map((v) => [sag(v), v]).filter(([s]) => s < tol).sort((a, b) => a[0] - b[0]);
    const touched = new Set();
    for (const [, v] of order) {
      const a = prev.get(v), b = next.get(v);
      if (touched.has(v) || touched.has(a) || touched.has(b) || !(sag(v) < tol)) continue;
      const [first, second] = Math.hypot(...sub(g(v), g(a))) < Math.hypot(...sub(g(v), g(b))) ? [a, b] : [b, a];
      if (collapse(v, first) || collapse(v, second)) { removed++; again = true; touched.add(a).add(b); }
    }
  }
  const out = []; for (let t = 0; t < T.length; t += 3) if (!dead[t / 3]) out.push(T[t], T[t + 1], T[t + 2]);
  return { tri: Uint32Array.from(out), removed, left: next.size };
}
// Vertex normals of the (half) surface, softened a little. The low-poly figure is shaded with these rather
// than with normals from its own few triangles, so it looks as smooth as the surface it came from.
function normals(P, tri, soften) {
  const n = P.length / 3; let N = new Float64Array(n * 3);
  const settle = (A) => { for (let v = 0; v < n; v++) { if (P[v * 3] === 0) A[v * 3] = 0; const l = Math.hypot(A[v * 3], A[v * 3 + 1], A[v * 3 + 2]) || 1; A[v * 3] /= l; A[v * 3 + 1] /= l; A[v * 3 + 2] /= l; } return A; };
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [tri[t] * 3, tri[t + 1] * 3, tri[t + 2] * 3];
    const f = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) N[v + k] += f[k];
  }
  settle(N);
  for (let i = 0; i < soften; i++) {
    const M = N.slice();
    for (let t = 0; t < tri.length; t += 3) for (let e = 0; e < 3; e++) { const a = tri[t + e] * 3, b = tri[t + (e + 1) % 3] * 3; for (let k = 0; k < 3; k++) M[a + k] += N[b + k]; }
    N = settle(M);
  }
  return N;
}
// Skin weights for the new surface: each vertex takes those of the nearest vertex of the posed source mesh.
function nearestSource(co, pos) {
  const cell = 0.4, grid = new Map(), key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const v of bodyV) { const k = key(co[v * 3], co[v * 3 + 1], co[v * 3 + 2]); (grid.get(k) || grid.set(k, []).get(k)).push(v); }
  const out = new Int32Array(pos.length / 3);
  for (let i = 0; i < out.length; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; let best = -1, bd = Infinity;
    for (let r = 1; best < 0 && r < 6; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
      for (const v of grid.get(key(x + a * cell, y + b * cell, z + c * cell)) || []) { const d = (co[v * 3] - x) ** 2 + (co[v * 3 + 1] - y) ** 2 + (co[v * 3 + 2] - z) ** 2; if (d < bd) { bd = d; best = v; } }
    }
    out[i] = best;
  }
  return out;
}

// How far the hand is from the rest of the body (not counting its own arm), dm.
const SIDE = joint(mesh.vertices, 'wrist.L____head')[0] > 0 ? 'L' : 'R'; // the side that lies in +x, the half that is kept
const ARM = chain([`clavicle.${SIDE}`]), HAND_L = chain([`wrist.${SIDE}`]);
const handV = bodyV.filter((v) => boneW(HAND_L, v) > 0.5), restV = bodyV.filter((v) => boneW(ARM, v) < 0.01);
function handClearance(co) {
  let best = Infinity;
  for (const a of handV) for (const b of restV) { const d = (co[a * 3] - co[b * 3]) ** 2 + (co[a * 3 + 1] - co[b * 3 + 1]) ** 2 + (co[a * 3 + 2] - co[b * 3 + 2]) ** 2; if (d < best) best = d; }
  return Math.sqrt(best);
}

const BODIES = { male: { gender: 1, age: 0.5 }, female: { gender: 0, age: 0.5 }, child: { gender: 0.5, age: 0.15 } };
const out = {};
for (const [name, cfg] of Object.entries(BODIES)) {
  const t0 = Date.now(), rest = shape(cfg);
  // 2. pose: the upper arms hang close; the forearms angle out just enough for the hands to clear the hips
  let co, fore = HANG / 2 - 1, gap;
  do { co = rest.slice(); relax(co, HANG, ++fore); gap = handClearance(co); } while (gap < CLEAR && fore < 30);

  // 3. seal. A plane of grid points sits on x = 0, so the surface can be cut there and mirrored.
  const h = VOX, R1 = GAP / h, R2 = FACE / h, pad = Math.ceil(Math.max(R1, R2)) + 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of bodyV) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], co[v * 3 + k]); hi[k] = Math.max(hi[k], co[v * 3 + k]); }
  const mid = Math.ceil(-lo[0] / h) + pad;
  const G = { h, x0: -(mid + 0.5) * h, y0: lo[1] - (pad + 0.371) * h, z0: lo[2] - (pad + 0.371) * h };
  G.nx = mid + 1 + Math.ceil(hi[0] / h) + pad; G.ny = Math.ceil((hi[1] - G.y0) / h) + pad; G.nz = Math.ceil((hi[2] - G.z0) / h) + pad;
  const { nx, ny, nz } = G, nxy = nx * ny, vox = new Uint8Array(nxy * nz);
  const leaks = voxelise(co, bodyTris, vox, G) + voxelise(co, eyeTris, vox, G);
  const D1 = distanceSq(vox, nx, ny, nz);
  const f = closed(D1, R1, nx, ny, nz);
  // the head gets the wider closing, blended in above the chin
  let chin = Infinity; for (const v of bodyV) if (headW[v] > 0.9) chin = Math.min(chin, co[v * 3 + 1]);
  const jb = Math.max(0, Math.floor((chin - 0.6 - G.y0) / h)), sy = ny - jb, D1h = new Float32Array(nx * sy * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < sy; y++) D1h.set(D1.subarray(nx * (y + jb) + nxy * z, nx * (y + jb + 1) + nxy * z), nx * y + nx * sy * z);
  const fh = closed(D1h, R2, nx, sy, nz);
  for (let y = 0; y < sy; y++) {
    const u = Math.max(0, Math.min(1, (G.y0 + (y + jb + 0.5) * h - (chin - 0.1)) / 0.35)), w = u * u * (3 - 2 * u);
    if (!w) continue;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const i = x + nx * (y + jb) + nxy * z; f[i] += w * (fh[x + nx * y + nx * sy * z] - f[i]); }
  }
  // the hand gets a wider closing still, worked out on the hand alone so it cannot web onto the hip: the
  // fingers become one mitten with a rounded end
  {
    const R3 = MITTEN / h, m = Math.ceil(R3) + 3, b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity], c = [0, 0, 0];
    for (const v of handV) for (let k = 0; k < 3; k++) { b0[k] = Math.min(b0[k], co[v * 3 + k]); b1[k] = Math.max(b1[k], co[v * 3 + k]); c[k] += co[v * 3 + k] / handV.length; }
    const o = [G.x0, G.y0, G.z0], n = [nx, ny, nz];
    const s0 = b0.map((x, k) => Math.max(0, Math.floor((x - o[k]) / h) - m)), s1 = b1.map((x, k) => Math.min(n[k] - 1, Math.ceil((x - o[k]) / h) + m)), sn = s0.map((a, k) => s1[k] - a + 1);
    const at = (x, y, z) => x + sn[0] * (y + sn[1] * z), full = (x, y, z) => x + s0[0] + nx * (y + s0[1]) + nxy * (z + s0[2]);
    // the solid voxels connected to the middle of the hand
    const hand = new Uint8Array(sn[0] * sn[1] * sn[2]), seed = c.map((x, k) => Math.round((x - o[k]) / h - 0.5) - s0[k]);
    let start = null, sd = Infinity;
    for (let z = 0; z < sn[2]; z++) for (let y = 0; y < sn[1]; y++) for (let x = 0; x < sn[0]; x++) if (vox[full(x, y, z)]) { const d = (x - seed[0]) ** 2 + (y - seed[1]) ** 2 + (z - seed[2]) ** 2; if (d < sd) { sd = d; start = [x, y, z]; } }
    const stack = [start]; hand[at(...start)] = 1;
    while (stack.length) {
      const [x, y, z] = stack.pop();
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= sn[0] || Y >= sn[1] || Z >= sn[2] || hand[at(X, Y, Z)] || !vox[full(X, Y, Z)]) continue;
        hand[at(X, Y, Z)] = 1; stack.push([X, Y, Z]);
      }
    }
    const fm = closed(distanceSq(hand, ...sn), R3, ...sn);
    for (let z = 0; z < sn[2]; z++) for (let y = 0; y < sn[1]; y++) for (let x = 0; x < sn[0]; x++) { const i = full(x, y, z); if (fm[at(x, y, z)] > f[i]) f[i] = fm[at(x, y, z)]; }
  }
  // whatever the outside air cannot reach is solid: no pockets left inside (the mouth, behind the eyes)
  let pockets = 0;
  {
    const air = new Uint8Array(f.length), stack = new Int32Array(f.length); let top = 0;
    air[0] = 1; stack[top++] = 0; // a corner of the grid, in the padding
    while (top) {
      const i = stack[--top], x = i % nx, y = ((i - x) / nx) % ny, z = Math.floor(i / nxy);
      const visit = (j) => { if (!air[j] && !(f[j] > 0)) { air[j] = 1; stack[top++] = j; } };
      if (x > 0) visit(i - 1); if (x < nx - 1) visit(i + 1); if (y > 0) visit(i - nx); if (y < ny - 1) visit(i + nx); if (z > 0) visit(i - nxy); if (z < nz - 1) visit(i + nxy);
    }
    for (let i = 0; i < f.length; i++) if (!air[i] && !(f[i] > 0)) { f[i] = 1; pockets++; }
  }
  const raw = surface(f, G, mid), dense = biggestPiece(raw);
  const t1 = Date.now();

  // 4. melt: take the voxel grain off, drop to a working mesh, then smooth the head, hands and feet harder
  smooth(dense.pos, dense.tri, null, num('GRAIN_ITERS', 8));
  const work = reduce(dense.pos, dense.tri, num('WORK', 30000), 0.001), P = work.pos, T = work.tri;
  const src = nearestSource(co, P), wOf = (bones, gain = 1) => Float32Array.from(src, (v) => Math.min(1, gain * boneW(bones, v)));
  const wHead = wOf(HEAD), groin = [0, 1, 2].map((k) => GROIN.reduce((s, v) => s + co[v * 3 + k], 0) / GROIN.length);
  const wGroin = Float32Array.from(src, (_, i) => Math.max(0, 1 - Math.hypot(P[i * 3] - groin[0], P[i * 3 + 1] - groin[1], P[i * 3 + 2] - groin[2]) / 1.0) ** 2);
  smooth(P, T, wHead, num('HEAD_ITERS', 20));
  smooth(P, T, wOf(HAND), num('HAND_ITERS', 12));
  smooth(P, T, wOf(TOES, 2), num('TOE_ITERS', 12));
  smooth(P, T, wOf(BREAST), num('BREAST_ITERS', 20));
  smooth(P, T, wGroin, num('GROIN_ITERS', 30));
  smooth(P, T, null, num('BODY_ITERS', 14));

  // unit height, feet on the ground, pivot between the ankles
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < P.length; i += 3) { minY = Math.min(minY, P[i]); maxY = Math.max(maxY, P[i]); }
  const cz = (joint(co, 'foot.L____head')[2] + joint(co, 'foot.R____head')[2]) / 2, H = maxY - minY;
  for (let i = 0; i < P.length; i += 3) { P[i] /= H; P[i + 1] = (P[i + 1] - minY) / H; P[i + 2] = (P[i + 2] - cz) / H; }

  // 5. reduce (each half gets half the budget); the head counts as bigger than it is, so the face keeps its shape
  const guide = P.slice(), hv = [...wHead.keys()].filter((i) => wHead[i] > 0.9), hc = [0, 1, 2].map((k) => (k ? hv.reduce((s, i) => s + P[i * 3 + k], 0) / hv.length : 0));
  for (let i = 0; i < wHead.length; i++) for (let k = 0; k < 3; k++) guide[i * 3 + k] = hc[k] + (1 + (HEAD_DETAIL - 1) * wHead[i]) * (P[i * 3 + k] - hc[k]);
  const thin = thinSeam(P, T, guide, num('SEAM_TOL', 0.0007), 0.05);
  const low = reduce(P, thin.tri, TARGET / 2, 0.05, guide), N = normals(P, T, num('SOFTEN', 4));
  smooth(low.pos, low.tri, null, num('LOW_ITERS', 1));
  // the last steps moved the top and the soles a hair: back to exactly 1 unit tall on y = 0
  { let a = Infinity, b = -Infinity; for (let i = 1; i < low.pos.length; i += 3) { a = Math.min(a, low.pos[i]); b = Math.max(b, low.pos[i]); }
    for (let i = 0; i < low.pos.length; i += 3) { low.pos[i] /= b - a; low.pos[i + 1] = (low.pos[i + 1] - a) / (b - a); low.pos[i + 2] /= b - a; } }
  const NL = Float64Array.from(low.pos, (_, i) => N[low.from[(i - (i % 3)) / 3] * 3 + (i % 3)]);
  // A seam vertex leans the way its neighbours off the seam do (and their mirror images, so not sideways).
  // Otherwise each change of tilt between the seam and its neighbours shows as a faint line down the middle.
  {
    const sum = new Float64Array(NL.length);
    for (let t = 0; t < low.tri.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = low.tri[t + e], b = low.tri[t + (e + 1) % 3];
      for (const [s, o] of [[a, b], [b, a]]) if (low.pos[s * 3] === 0 && low.pos[o * 3] !== 0) { sum[s * 3 + 1] += NL[o * 3 + 1]; sum[s * 3 + 2] += NL[o * 3 + 2]; }
    }
    for (let v = 0; v < sum.length; v += 3) { const l = Math.hypot(sum[v + 1], sum[v + 2]); if (l > 1e-6) { NL[v] = 0; NL[v + 1] = sum[v + 1] / l; NL[v + 2] = sum[v + 2] / l; } }
  }
  const q = new Uint16Array(low.pos.length), nq = new Int8Array(low.pos.length), clamp = (x) => Math.round(Math.max(0, Math.min(1, x)) * 65535);
  let seam = 0;
  for (let i = 0; i < q.length; i += 3) {
    q[i] = clamp(low.pos[i] * 2); q[i + 1] = clamp(low.pos[i + 1]); q[i + 2] = clamp(low.pos[i + 2] + 0.5);
    if (low.pos[i] === 0) seam++; else if (!q[i]) q[i] = 1;
    for (let k = 0; k < 3; k++) nq[i + k] = Math.round(NL[i + k] * 127);
  }
  console.log(`${name}: forearms ${fore} deg out (hand ${(gap * 10).toFixed(1)} cm clear), grid ${nx}x${ny}x${nz}${leaks ? ` (${leaks} leaky columns)` : ''}, ${pockets} pocket voxels filled, half: ${raw.tri.length / 3} tris in ${dense.pieces} pieces -> ${T.length / 3} -> ${low.tri.length / 3} (error ${low.err.toFixed(4)}); seam ${thin.left + thin.removed} -> ${thin.left} -> ${seam}; mirrored: ${low.tri.length / 3 * 2} tris, ${q.length / 3 * 2 - seam} verts; ${((t1 - t0) / 1000).toFixed(1)} + ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  out[name] = { v: b64(q), n: b64(nq), i: b64(Uint16Array.from(low.tri)) };
}
const js = `// Generated by tools/bake-people.mjs from the MakeHuman base mesh, macro targets and skeleton (CC0,
// makehumancommunity.org). Do not edit by hand. One smooth low-poly figure per body, 1 unit tall, feet on
// y = 0, pivot between the ankles, facing +z. Only the +x half is stored; the app mirrors it.
// v: base64 Uint16 xyz (x / 131070, y / 65535, z / 65535 - 0.5; x = 0 is the mirror seam), n: base64 Int8
// normals (/ 127, taken from the detailed surface so the few triangles shade smoothly), i: base64 Uint16
// triangle indices.
export const BODY_MESH = {
${Object.entries(out).map(([k, b]) => `  ${k}: {\n    v: '${b.v}',\n    n: '${b.n}',\n    i: '${b.i}',\n  },`).join('\n')}
};
`;
fs.writeFileSync(OUT, js);
console.log('wrote', OUT, js.length, 'bytes');
