// Primitive geometry builders. Every shape has its pivot at the bottom centre (y = 0 is the ground).
// To add a primitive: add it to PRIMITIVES in core/doc.js, then add a builder here with the same params.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BODY_MESH } from './people-data.js';
import { PERSON_HEIGHT } from '/core/doc.js';

const up = (g, y) => g.translate(0, y, 0);
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const BODY_CACHE = {};
/** The unit-height figure for a body, decoded once. app/people-data.js holds its +x half; mirror the rest. */
function bodyGeometry(body) {
  if (!BODY_CACHE[body]) {
    const { v, n: nb, i } = BODY_MESH[body];
    const q = new Uint16Array(bytes(v).buffer), nq = new Int8Array(bytes(nb).buffer), half = new Uint16Array(bytes(i).buffer), n = q.length / 3;
    const twin = new Uint16Array(n); // each vertex's mirror image; seam vertices (x = 0) are their own
    let count = n;
    for (let k = 0; k < n; k++) twin[k] = q[k * 3] ? count++ : k;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), index = new Uint16Array(half.length * 2);
    for (let k = 0; k < n; k++) {
      const x = q[k * 3] / 131070, y = q[k * 3 + 1] / 65535, z = q[k * 3 + 2] / 65535 - 0.5;
      pos.set([x, y, z], k * 3); pos.set([-x, y, z], twin[k] * 3);
      const nx = nq[k * 3] / 127, ny = nq[k * 3 + 1] / 127, nz = nq[k * 3 + 2] / 127;
      nor.set([nx, ny, nz], k * 3); nor.set([-nx, ny, nz], twin[k] * 3);
    }
    index.set(half);
    for (let t = 0; t < half.length; t += 3) index.set([twin[half[t]], twin[half[t + 2]], twin[half[t + 1]]], half.length + t);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // normals come from the detailed surface the figure was reduced from, so its few triangles shade smoothly
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.userData.ownNormals = true;
    BODY_CACHE[body] = g;
  }
  return BODY_CACHE[body];
}

export const BUILDERS = {
  box: ({ w, h, d }) => up(new THREE.BoxGeometry(w, h, d), h / 2),
  sphere: ({ r }) => up(new THREE.SphereGeometry(r, 40, 20), r),
  cylinder: ({ r, h, rTop }) => up(new THREE.CylinderGeometry(rTop ?? r, r, h, 40), h / 2),
  cone: ({ r, h }) => up(new THREE.ConeGeometry(r, h, 40), h / 2),
  pyramid: ({ w, h, d }) => new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0).scale(w, h, d),
  capsule: ({ r, h }) => up(new THREE.CapsuleGeometry(r, Math.max(0.001, h - 2 * r), 8, 24), h / 2),
  torus: ({ r, tube }) => up(new THREE.TorusGeometry(r, tube, 16, 56).rotateX(Math.PI / 2), tube),
  plane: ({ w, d }) => up(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), 0.003),
  ramp({ w, h, d }) {
    const s = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(d, 0), new THREE.Vector2(d, h)]);
    return new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-w / 2, 0, d / 2);
  },
  stairs({ w, h, d, steps }) {
    const n = Math.max(1, Math.round(steps));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const sh = (h * (i + 1)) / n, sd = d / n;
      parts.push(new THREE.BoxGeometry(w, sh, sd).translate(0, sh / 2, d / 2 - sd * (i + 0.5)));
    }
    return mergeGeometries(parts.map((g) => g.toNonIndexed()));
  },
  arch({ w, h, d, t }) {
    const ow = Math.max(0.05, w - 2 * t), r = ow / 2;
    const spring = Math.max(0, h - t - r); // height where the curve starts
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(-ow / 2, 0); s.lineTo(-ow / 2, spring);
    s.absarc(0, spring, r, Math.PI, 0, true);
    s.lineTo(ow / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 24 }).translate(0, 0, -d / 2);
  },
  // A smooth low-poly human figure (male, female or child) simplified from MakeHuman bodies, h tall
  // (default: the body's usual height), facing +z.
  person({ h, body }) {
    const b = BODY_MESH[body] ? body : 'male', H = h ?? PERSON_HEIGHT[b] ?? 1.8;
    return bodyGeometry(b).clone().scale(H, H, H);
  },
};

export function buildGeometry(type, params) {
  const b = BUILDERS[type];
  if (!b) throw new Error(`no builder for ${type}`);
  const g = b(params);
  if (!g.userData.ownNormals) g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
