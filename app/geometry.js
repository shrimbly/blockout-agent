// Primitive geometry builders. Every shape has its pivot at the bottom centre (y = 0 is the ground).
// To add a primitive: add it to PRIMITIVES in core/doc.js, then add a builder here with the same params.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mannequin } from './mannequin.js';
import { PERSON_HEIGHT } from '/core/doc.js';

const up = (g, y) => g.translate(0, y, 0);

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
  // A jointed artist's mannequin (male, female or child), h tall (default: the body's usual height), facing +z.
  person({ h, body }) {
    const H = h ?? PERSON_HEIGHT[body] ?? PERSON_HEIGHT.male;
    return mannequin(body).clone().scale(H, H, H);
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
