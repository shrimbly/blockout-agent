// Fast checks: core document ops, easing math, and that the skill copies are in sync. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, applyOps, migrate, PRIMITIVES } from '../core/doc.js';
import { bezier, sampleCamera, sampleObject, resolveEase, EASES, remapTime, fovToLens, lensToFov, isCut } from '../core/curves.js';

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

test('a hold key is a clean cut: the smooth path on each side ignores the other shot', () => {
  const tl = { duration: 4, interp: 'smooth', speed: 'linear', keys: [
    { t: 0, position: [0, 0, 0], target: [0, 0, -5], fov: 40, ease: 'linear' },
    { t: 2, position: [2, 0, 0], target: [2, 0, -5], fov: 40, ease: 'hold' }, // shot A ends: cut
    { t: 2 + 1 / 24, position: [10, 0, 10], target: [10, 0, 5], fov: 30, ease: 'linear' }, // shot B starts a frame later
    { t: 4, position: [10, 0, 14], target: [10, 0, 9], fov: 30, ease: 'linear' }] };
  assert.ok(isCut(tl.keys[1]) && !isCut(tl.keys[0]));
  const a = sampleCamera(tl, 1), b = sampleCamera(tl, 3);
  assert.ok(Math.abs(a.position[2]) < 1e-9 && Math.abs(a.position[0] - 1) < 1e-9, `shot A stays on its own line (${a.position})`);
  assert.ok(Math.abs(b.position[0] - 10) < 1e-9, `shot B stays on its own line (${b.position})`);
  assert.deepEqual(sampleCamera(tl, 2).position, [2, 0, 0]); // last frame of shot A
  assert.deepEqual(sampleCamera(tl, 2 + 1 / 24).position, [10, 0, 10]); // next frame is shot B
  assert.equal(sampleCamera(tl, 2.02).fov, 40); // nothing blends during the cut
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

test('person bodies: male, female or child, height follows the body unless set', () => {
  const { doc } = applyOps(createDoc(), [
    { op: 'add', type: 'person', name: 'a' },
    { op: 'add', type: 'person', name: 'b', body: 'female' },
    { op: 'add', type: 'person', name: 'c', body: 'child', h: 1.1 },
  ]);
  assert.deepEqual(doc.objects.map((o) => o.params), [{ h: null, body: 'male', detail: null }, { h: null, body: 'female', detail: null }, { h: 1.1, body: 'child', detail: null }]);
  assert.throws(() => applyOps(doc, { op: 'add', type: 'person', body: 'robot' }), /one of male, female, child/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', body: 2 }), /one of/);
  // scenes saved before bodies existed stored every person at 1.8 m; they now take their body's height
  const old = migrate({ objects: [{ type: 'person', id: 'p', params: { h: 1.8 } }, { type: 'person', id: 'q', params: { h: 1.2 } }] });
  assert.deepEqual(old.objects.map((o) => o.params.h), [null, 1.2]);
});

test('person detail: high or low per person, else the scene\'s env.people', () => {
  let { doc } = applyOps(createDoc(), [{ op: 'add', type: 'person', name: 'a' }, { op: 'add', type: 'person', name: 'b', detail: 'low' }]);
  assert.equal(doc.env.people, 'low');
  assert.deepEqual(doc.objects.map((o) => o.params.detail), [null, 'low']);
  ({ doc } = applyOps(doc, { op: 'env', people: 'high' }));
  assert.equal(doc.env.people, 'high');
  assert.equal(migrate(doc).env.people, 'high');
  assert.equal(migrate(createDoc()).env.people, 'low');
  assert.throws(() => applyOps(doc, { op: 'env', people: 'medium' }), /env.people must be one of high, low/);
  assert.throws(() => applyOps(doc, { op: 'update', id: 'a', detail: 'medium' }), /one of high, low/);
  // scenes saved before env.people existed draw people in high detail
  assert.equal(migrate({ objects: [] }).env.people, 'high');
});

test('a mannequin exists for every body: closed parts, 1 unit tall, feet on the ground, facing +z', async () => {
  const { mannequin, BODIES } = await import('../app/mannequin.js');
  assert.deepEqual(Object.keys(BODIES).sort(), [...PRIMITIVES.person.choices.body].sort());
  for (const body of Object.keys(BODIES)) {
    const g = mannequin(body), p = g.attributes.position.array, i = g.index.array;
    assert.equal(mannequin(body), g, `${body} is built once`);
    assert.ok(i.length / 3 <= 4000, `${body}: ${i.length / 3} triangles`);
    assert.ok(i.every((k) => k < p.length / 3), `${body}: indices in range`);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.length; k++) { lo[k % 3] = Math.min(lo[k % 3], p[k]); hi[k % 3] = Math.max(hi[k % 3], p[k]); }
    assert.ok(lo[1] === 0 && hi[1] === 1, `${body} spans y ${lo[1]}..${hi[1]}`);
    assert.ok(Math.abs(lo[0] + hi[0]) < 1e-6, `${body}: left mirrors right`);
    assert.ok(hi[2] > -lo[2] * 1.5, `${body}: the toes point to +z`);
    // every part is a closed surface facing outward: each edge joins two triangles, and the volume is positive
    const edges = new Map();
    let volume = 0;
    for (let t = 0; t < i.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((e) => [p[i[t + e] * 3], p[i[t + e] * 3 + 1], p[i[t + e] * 3 + 2]]);
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      for (let e = 0; e < 3; e++) { const m = i[t + e], n = i[t + (e + 1) % 3], key = m < n ? `${m},${n}` : `${n},${m}`; edges.set(key, (edges.get(key) || 0) + 1); }
    }
    for (const [key, count] of edges) assert.equal(count, 2, `${body}: edge ${key} has ${count} triangles`);
    assert.ok(volume > 0.01 && volume < 0.03, `${body}: volume ${volume.toFixed(4)} of a 1 unit cube`);
  }
});

test('the Claude Code plugin manifests parse and their hooks run the same CLI as the checkout hooks', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const plugin = read('.claude-plugin/plugin.json'), market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'blockout-agent');
  assert.ok(market.plugins.some((p) => p.name === plugin.name && p.source === './'));
  for (const a of plugin.agents || []) assert.ok(fs.existsSync(path.join(ROOT, a)), `${a} is missing`);
  const pluginHooks = read('hooks/hooks.json').hooks, repoHooks = read('.claude/settings.json').hooks;
  for (const ev of ['Stop', 'UserPromptSubmit']) {
    const a = pluginHooks[ev][0].hooks[0].command.split('bin/canvas.mjs')[1];
    const b = repoHooks[ev][0].hooks[0].command.split('bin/canvas.mjs')[1];
    assert.equal(a, b, `${ev} hook differs between hooks/hooks.json and .claude/settings.json`);
  }
  assert.ok(fs.statSync(path.join(ROOT, 'bin/canvas')).mode & 0o111, 'bin/canvas must be executable');
});

test('the plugin has no fixed version, so installed copies follow main', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(m.version, undefined);
  const mk = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  assert.ok(mk.plugins.every((p) => p.version === undefined));
});

test('launchInfo tells Claude Code, Codex and a terminal apart, and finds the plugin', async () => {
  const { launchInfo } = await import('../server/index.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-'));
  assert.equal(launchInfo({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: none }).by, 'claude');
  assert.equal(launchInfo({ CODEX_SANDBOX: 'seatbelt', CLAUDE_CONFIG_DIR: none }).by, 'codex');
  const t = launchInfo({ CLAUDE_CONFIG_DIR: none });
  assert.equal(t.by, 'terminal');
  assert.equal(t.plugin, false);
  fs.mkdirSync(path.join(none, 'plugins'));
  fs.writeFileSync(path.join(none, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'blockout-agent@blockout-agent': [{}] } }));
  assert.equal(launchInfo({ CLAUDE_CONFIG_DIR: none }).plugin, true);
  assert.equal(launchInfo({}, '/Users/x/.claude/plugins/cache/blockout-agent/0.3.0').plugin, true);
});
