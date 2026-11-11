// The low-detail person: a box body and a cube head with a drawn-on face (dark eyes and mouth, a grey
// nose), facing +z. It reads as "a person, about here, looking that way" and nothing more, which suits
// early blockouts and crowds. Under 200 triangles. The face is vertex colour: white parts take the
// object's colour, the features stay dark whatever the colour is.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Proportions in body heights: body w × d, head side, and the gap between body and head. */
const BODIES = {
  male: { w: 0.42, d: 0.26, head: 0.27 },
  female: { w: 0.36, d: 0.23, head: 0.26 },
  child: { w: 0.44, d: 0.3, head: 0.33 },
};

function part(w, h, d, x, y, z, shade) {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(shade), 3));
  return g;
}

function build({ w, d, head: s }) {
  const bodyH = 1 - s, hz = -0.01; // the head sits a touch back of the body's centre, as in a slouch
  const front = hz + s / 2, t = 0.006; // features stand t proud of the face
  const parts = [
    part(w, bodyH, d, 0, bodyH / 2, 0, 1),
    part(s, s, s, 0, bodyH + s / 2, hz, 1),
    // eyes, nose, mouth, laid out on the face in head sides
    ...[-1, 1].map((k) => part(s * 0.11, s * 0.11, t, k * s * 0.17, bodyH + s * 0.62, front + t / 2, 0.06)),
    part(s * 0.09, s * 0.17, t, 0, bodyH + s * 0.43, front + t / 2, 0.55),
    part(s * 0.28, s * 0.04, t, 0, bodyH + s * 0.25, front + t / 2, 0.06),
  ];
  return mergeGeometries(parts);
}

const CACHE = {};
/** The low-detail person for a body (male, female or child), one unit tall, feet on y = 0, facing +z. */
export function blockman(body) {
  const b = BODIES[body] ? body : 'male';
  return (CACHE[b] ??= build(BODIES[b]));
}
