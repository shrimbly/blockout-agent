// Primitive geometry builders. Every shape has its pivot at the bottom centre (y = 0 is the ground).
// To add a primitive: add it to PRIMITIVES in core/doc.js, then add a builder here with the same params.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const up = (g, y) => g.translate(0, y, 0);
const V = (a) => new THREE.Vector3(...a);
/** A capsule of radius r from point a to point b (rounded ends centred on the points). With 16 sides
 *  neighbouring facets stay under the 28° edge threshold, so no facet lines are drawn. */
function limb(a, b, r) {
  const A = V(a), B = V(b);
  const g = new THREE.CapsuleGeometry(r, A.distanceTo(B), 6, 16);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
  const m = A.add(B).multiplyScalar(0.5);
  return g.translate(m.x, m.y, m.z);
}
/** A sphere (r) or an ellipsoid (radii [x, y, z]) centred on c. */
function blob(c, r, k = [1, 1, 1]) {
  const rr = Array.isArray(r) ? r : [r * k[0], r * k[1], r * k[2]];
  return new THREE.SphereGeometry(1, 24, 14).scale(...rr).translate(...c);
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
  // A simple jointed mannequin (head, neck, chest, pelvis, arms, hands, legs, feet) standing at ease,
  // h tall, facing +z. Proportions follow the usual ~7.5-heads figure.
  person({ h }) {
    const parts = [
      blob([0, 0.932, 0.004], 0.062, [0.84, 1.12, 0.96]), // head
      blob([0, 0.924, 0.06], [0.011, 0.017, 0.014]), // nose: shows facing
      limb([0, 0.835, 0], [0, 0.885, 0.004], 0.027), // neck
      blob([0, 0.725, 0], [0.108, 0.135, 0.062]), // chest
      blob([0, 0.565, 0], [0.09, 0.085, 0.058]), // pelvis
    ];
    for (const s of [-1, 1]) {
      parts.push(
        blob([s * 0.118, 0.806, 0], 0.04), // shoulder
        limb([s * 0.122, 0.8, 0], [s * 0.148, 0.645, -0.006], 0.032), // upper arm
        limb([s * 0.148, 0.645, -0.006], [s * 0.164, 0.49, 0.018], 0.026), // forearm
        blob([s * 0.168, 0.445, 0.024], [0.018, 0.045, 0.03]), // hand
        limb([s * 0.056, 0.5, 0], [s * 0.06, 0.275, 0.006], 0.047), // thigh
        limb([s * 0.06, 0.275, 0.006], [s * 0.062, 0.055, -0.01], 0.036), // shin
        limb([s * 0.062, 0.028, -0.022], [s * 0.068, 0.024, 0.085], 0.026), // foot
      );
    }
    // Indexed parts merge into one indexed mesh, so the vertex normals come out smooth, not faceted.
    return mergeGeometries(parts.map((g) => g.scale(h, h, h)));
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
