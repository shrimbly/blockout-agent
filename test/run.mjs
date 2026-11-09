// Fast checks: core document ops, easing math, and that the skill copies are in sync. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, applyOps, migrate, PRIMITIVES } from '../core/doc.js';
import { bezier, sampleCamera, sampleObject, resolveEase, EASES, remapTime, fovToLens, lensToFov } from '../core/curves.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('add assigns readable ids and validates', () => {
  const { doc, results } = applyOps(createDoc(), [
    { op: 'add', type: 'box' }, { op: 'add', type: 'box' }, { op: 'add', type: 'box', name: 'Crate' }, { op: 'add', type: 'box', name: 'crate' },
  ]);
  assert.deepEqual(results.map((r) => r.id), ['box-1', 'box-2', 'crate', 'crate-2']);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'box', w: 'x' }), /must be a number/);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'box', r: 1 }), /no field or param "r"/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'nope' }), /no object/);
});

test('ops are atomic', () => {
  const d0 = createDoc();
  assert.throws(() => applyOps(d0, [{ op: 'add', type: 'box' }, { op: 'add', type: 'nope' }]), /op 1/);
  assert.equal(d0.objects.length, 0);
});

test('size maps to each type’s main params', () => {
  const { doc } = applyOps(createDoc(), [{ op: 'add', type: 'cylinder', size: [0.3, 4] }, { op: 'add', type: 'box', size: [2, 3, 4] }]);
  assert.deepEqual(doc.objects[0].params, { r: 0.3, h: 4, rTop: null });
  assert.deepEqual(doc.objects[1].params, { w: 2, h: 3, d: 4 });
});

test('key.add at an existing time updates that key; keys stay sorted', () => {
  let { doc } = applyOps(createDoc(), { op: 'key.add', t: 2, position: [1, 1, 1], target: [0, 0, 0] });
  ({ doc } = applyOps(doc, { op: 'key.add', t: 2, fov: 30 }));
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 2, 5]);
  assert.equal(doc.timeline.keys[1].fov, 30);
  ({ doc } = applyOps(doc, { op: 'key.update', index: 1, t: 6 }));
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 5, 6]);
  assert.equal(doc.timeline.duration, 6);
});

test('timeline retime scales key times', () => {
  const { doc } = applyOps(createDoc(), { op: 'timeline', duration: 10, retime: true });
  assert.deepEqual(doc.timeline.keys.map((k) => k.t), [0, 10]);
});

test('bezier easing', () => {
  for (const [name, b] of Object.entries(EASES)) {
    if (b === 'hold') continue;
    assert.equal(bezier(b, 0), 0, name); assert.equal(bezier(b, 1), 1, name);
  }
  assert.ok(Math.abs(bezier(EASES.easeInOut, 0.5) - 0.5) < 1e-6);
  assert.ok(bezier(EASES.easeIn, 0.25) < 0.25 && bezier(EASES.easeOut, 0.25) > 0.25);
  assert.ok(bezier(EASES.overshoot, 0.6) > 1);
  assert.equal(bezier('hold', 0.99), 0);
  assert.throws(() => resolveEase('wobble'), /unknown ease/);
});

test('camera sampling hits keys and respects ease and speed', () => {
  const tl = { duration: 4, interp: 'linear', speed: 'linear', keys: [
    { t: 0, position: [0, 0, 0], target: [0, 0, -1], fov: 40, ease: 'linear' },
    { t: 4, position: [4, 0, 0], target: [0, 0, -1], fov: 20, ease: 'linear' }] };
  assert.deepEqual(sampleCamera(tl, 2).position, [2, 0, 0]);
  assert.equal(sampleCamera(tl, 2).fov, 30);
  assert.deepEqual(sampleCamera(tl, 9).position, [4, 0, 0]);
  tl.keys[0].ease = 'hold';
  assert.deepEqual(sampleCamera(tl, 3.9).position, [0, 0, 0]);
  tl.keys[0].ease = 'linear'; tl.speed = 'easeIn';
  assert.ok(remapTime(tl, 1) < 1 && sampleCamera(tl, 1).position[0] < 1);
  tl.interp = 'smooth';
  const s = sampleCamera(tl, 4); assert.deepEqual(s.position, [4, 0, 0]);
});

test('lens ↔ fov', () => { assert.ok(Math.abs(fovToLens(lensToFov(35)) - 35) < 1e-9); });

test('migrate fills defaults and round-trips', () => {
  const d = migrate({ objects: [{ type: 'sphere', position: [1, 0, 0] }] });
  assert.equal(d.objects[0].id, 'sphere-1');
  assert.equal(d.timeline.keys.length, 2);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(d))), d);
});

test('every primitive has a geometry builder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/geometry.js'), 'utf8');
  for (const t of Object.keys(PRIMITIVES)) assert.match(src, new RegExp(`\\b${t}[:(]`), t);
});

test('skill copies for Claude and Codex are identical', () => {
  const a = path.join(ROOT, '.claude/skills/camera-canvas'), b = path.join(ROOT, '.agents/skills/camera-canvas');
  const list = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  assert.deepEqual(list(a), list(b));
  for (const f of list(a)) assert.equal(fs.readFileSync(path.join(a, f), 'utf8'), fs.readFileSync(path.join(b, f), 'utf8'), f);
});

test('frame rate defaults to 24 and accepts decimals', () => {
  assert.equal(createDoc().timeline.fps, 24);
  const { doc } = applyOps(createDoc(), [{ op: 'timeline', fps: 23.976 }]);
  assert.equal(doc.timeline.fps, 23.976);
  assert.throws(() => applyOps(createDoc(), [{ op: 'timeline', fps: 0.5 }]));
});

test('objects move over time with anim.move and stay put without keys', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'add', type: 'person', name: 'hero', position: [0, 0, 5] }]);
  const still = sampleObject(doc.objects[0], doc.timeline, 2);
  assert.deepEqual(still.position, [0, 0, 5]);
  ({ doc } = applyOps(doc, { op: 'anim.move', id: 'hero', to: [0, 0, -1], at: 1, over: 3, ease: 'linear' }));
  const o = doc.objects[0];
  assert.deepEqual(o.anim.map((k) => k.t), [1, 4]);
  assert.deepEqual(sampleObject(o, doc.timeline, 0).position, [0, 0, 5]);
  assert.deepEqual(sampleObject(o, doc.timeline, 2.5).position, [0, 0, 2]);
  assert.deepEqual(sampleObject(o, doc.timeline, 9).position, [0, 0, -1]);
  // chaining: the next move starts where the last one ended
  ({ doc } = applyOps(doc, { op: 'anim.move', id: 'hero', by: [2, 0, 0], turn: [0, 90, 0], at: 4, over: 1 }));
  assert.deepEqual(doc.objects[0].anim.at(-1).position, [2, 0, -1]);
  assert.deepEqual(doc.objects[0].anim.at(-1).rotation, [0, 90, 0]);
  assert.equal(doc.timeline.duration, 5);
  // moving an animated object shifts the whole move; the scene file round-trips
  ({ doc } = applyOps(doc, { op: 'update', id: 'hero', move: [1, 0, 0] }));
  assert.deepEqual(doc.objects[0].anim.map((k) => k.position[0]), [1, 1, 3]);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(doc))).objects[0].anim, doc.objects[0].anim);
  ({ doc } = applyOps(doc, { op: 'anim.remove', id: 'hero' }));
  assert.equal(doc.objects[0].anim, undefined);
  assert.throws(() => applyOps(doc, { op: 'anim.move', id: 'hero', at: 0, over: 1 }), /needs to, by/);
});

test('the builder helper definition is generated from the skill reference', () => {
  const ref = fs.readFileSync(path.join(ROOT, 'skills/camera-canvas/references/builder.md'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, '.claude/agents/canvas-builder.md'), 'utf8');
  const body = ref.replace(/^# .*\n+(<!--[\s\S]*?-->\n+)?/, '');
  assert.ok(agent.startsWith('---\nname: canvas-builder\n'), 'frontmatter');
  assert.ok(agent.endsWith(body), 'run npm run skills:sync after editing references/builder.md');
});
