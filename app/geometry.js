// Primitive geometry builders. Every shape has its pivot at the bottom centre (y = 0 is the ground).
// To add a primitive: add it to PRIMITIVES in core/doc.js, then add a builder here with the same params.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BODY_PARTS } from './people-data.js';
import { PERSON_HEIGHT } from '/core/doc.js';

const up = (g, y) => g.translate(0, y, 0);
const V = (a) => new THREE.Vector3(...a);
/** A limb tapering from radius ra at point a to rb at point b, with rounded ends (a lathe around a-b). */
function taper(a, b, ra, rb) {
  const A = V(a), Bv = V(b), L = A.distanceTo(Bv), pts = [];
  for (let i = 0; i <= 3; i++) { const t = (-Math.PI / 2) * (1 - i / 3); pts.push(new THREE.Vector2(Math.cos(t) * rb, Math.sin(t) * rb)); }
  for (let i = 0; i <= 3; i++) { const t = (Math.PI / 2) * (i / 3); pts.push(new THREE.Vector2(Math.cos(t) * ra, L + Math.sin(t) * ra)); }
  pts[0].x = pts[pts.length - 1].x = 0; // closed poles
  const g = new THREE.LatheGeometry(pts, 12);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), A.clone().sub(Bv).normalize()));
  return g.translate(Bv.x, Bv.y, Bv.z);
}

/** Builds a mannequin from fitted parts (see app/people-data.js), scaled so it is exactly h tall.
 *  About 4.5k triangles, so crowds stay cheap; smooth shading hides the low facet count. */
function bodyMannequin(parts, h) {
  const geos = parts.map(([kind, ...p]) => {
    if (kind === 'ball') return new THREE.SphereGeometry(p[1], 12, 8).translate(...p[0]);
    if (kind === 'limb') return taper(p[0], p[1], p[2], p[3]);
    const g = new THREE.SphereGeometry(1, 16, 10).scale(...p[1]);
    if (p[2]) g.applyQuaternion(new THREE.Quaternion(...p[2]).normalize());
    return g.translate(...p[0]);
  });
  // Lathe and sphere both carry position, normal and uv, so they merge into one indexed mesh.
  const g = mergeGeometries(geos);
  g.computeBoundingBox();
  const k = h / (g.boundingBox.max.y - g.boundingBox.min.y);
  return g.translate(0, -g.boundingBox.min.y, 0).scale(k, k, k);
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
  // An artist's mannequin (male, female or child) with proportions fitted to MakeHuman bodies, h tall
  // (default: the body's usual height), facing +z.
  person({ h, body }) {
    const b = BODY_PARTS[body] ? body : 'male';
    return bodyMannequin(BODY_PARTS[b], h ?? PERSON_HEIGHT[b] ?? 1.8);
  },
};

export function buildGeometry(type, params) {
  const b = BUILDERS[type];
  if (!b) throw new Error(`no builder for ${type}`);
  const g = b(params);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
