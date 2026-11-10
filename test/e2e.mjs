// End-to-end test: starts a server on a temp scene, drives it with the CLI and a headless browser.
// Needs Playwright with Chromium (npx playwright install chromium). Run: node test/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: playwright not installed'); process.exit(0); }

const PORT = 5399;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-e2e-'));
const env = { ...process.env, CANVAS_PORT: String(PORT) };
const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env, encoding: 'utf8' }).trim();
const cliAsync = (...args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), ...args], { env });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out))));
});
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const server = spawn(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'serve', '--scene', path.join(dir, 'scene.json'), '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // --- agent builds a scene before any tab is open ---
  cli('clear', '--keys');
  ok(cli('add', 'box', '--name', 'tower', '--size', '2,5,2', '--pos', '0,0,0') === 'tower', 'add box by name');
  ok(cli('add', 'sphere', '--r', '0.6', '--pos', '3,0,1') === 'sphere-1', 'add sphere gets an id');
  cli('key', '--t', '0', '--pos', '8,3,8', '--target', '0,1,0', '--lens', '35');
  cli('key', '--t', '4', '--pos', '-8,2,6', '--target', '0,1,0', '--ease', 'slowOut');
  cli('timeline', '--duration', '4', '--fps', '12');
  ok(/camera keys \(2\)/.test(cli('ls')), 'ls lists 2 camera keys');
  let failed = false; try { cli('add', 'blob'); } catch { failed = true; }
  ok(failed, 'unknown type is rejected');
  failed = false; try { cli('seek', '1'); } catch (e) { failed = /no canvas tab/.test(e.stderr || e.message); }
  ok(failed, 'browser-only command explains that no tab is open');

  // --- open the canvas ---
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForFunction(() => window.canvas?.store.doc && window.canvas.viewport.meshes.size === 2);
  ok(true, 'page loads the scene');

  // click the tower to select it
  const towerPt = () => page.evaluate(() => {
    const v = window.canvas.viewport; const m = v.meshes.get('tower').mesh;
    const p = m.position.clone(); p.y = 2.5; p.project(v.activeCam);
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  });
  let pt = await towerPt();
  await page.mouse.click(pt.x, pt.y);
  ok(await page.evaluate(() => window.canvas.store.state.selection) === null, 'plain click does not select');
  await page.waitForTimeout(500); // the click aimed the camera at the tower, so it moved on screen
  pt = await towerPt();
  await page.keyboard.down('Control'); await page.mouse.click(pt.x, pt.y); await page.keyboard.up('Control');
  ok(await page.evaluate(() => window.canvas.store.state.selection) === 'tower', 'ctrl-click selects the object');

  // drag the gizmo's centre handle
  const g = await page.evaluate(() => {
    const v = window.canvas.viewport; const p = v.meshes.get('tower').mesh.position.clone().project(v.activeCam);
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  });
  await page.mouse.move(g.x, g.y); await page.waitForTimeout(100);
  await page.mouse.down(); await page.mouse.move(g.x + 60, g.y + 10, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const pos = JSON.parse(cli('doc')).objects.find((o) => o.id === 'tower').position;
  ok(pos.some((v) => Math.abs(v) > 0.05), `gizmo drag moves the object and saves it (${pos})`);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(300);
  ok(JSON.parse(cli('doc')).objects.find((o) => o.id === 'tower').position.every((v) => v === 0), 'undo restores the position');

  // agent drives the timeline and the camera
  ok(JSON.parse(cli('seek', '2')).time === 2, 'seek');
  cli('view', 'shot');
  ok(await page.evaluate(() => window.canvas.store.state.view) === 'shot', 'view shot');
  await page.keyboard.press('k');
  await page.waitForTimeout(300);
  ok(JSON.parse(cli('doc')).timeline.keys.length === 3, 'K keys the current view at the playhead');

  // prompt from the canvas reaches a waiting agent, reply shows in the canvas
  const waiting = cliAsync('wait', '--timeout', '20');
  await page.waitForFunction(() => window.canvas.store.state.agent === true, null, { timeout: 5000 });
  ok(true, 'canvas shows the agent as listening');
  await page.fill('.chat-input', 'make the tower twice as tall');
  await page.keyboard.press('Enter');
  const got = await waiting;
  ok(/make the tower twice as tall/.test(got) && /selected: tower/.test(got), 'canvas wait receives the prompt with selection context');
  const id = got.match(/\[canvas prompt (\w+)\]/)[1];
  cli('set', 'tower', '--h', '10');
  cli('say', '--reply', id, 'Tower is now 10 m tall');
  await page.waitForSelector('.chat-msg--agent');
  ok(await page.$eval(`.chat-msg[data-status="done"]`, () => true).catch(() => false), 'prompt marked done after the reply');
  ok(await page.evaluate(() => window.canvas.viewport.meshes.get('tower').mesh.geometry.boundingBox.max.y) > 9.9, 'agent edit re-renders in the canvas');

  // the Claude Code Stop hook hands a queued prompt back to the session
  await page.fill('.chat-input', 'add a red cone');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const hook = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'bin/canvas.mjs'), 'hook', 'stop'], { env, input: '{}', encoding: 'utf8' }));
  ok(hook.decision === 'block' && /add a red cone/.test(hook.reason), 'Stop hook blocks with the canvas prompt');

  // a prompt the agent took but never answered is closed when it asks for the next one
  ok(await page.$$eval('.chat-msg[data-status="taken"]', (els) => els.length) === 1, 'the hook-taken prompt shows as taken');
  await cliAsync('wait', '--timeout', '1');
  await page.waitForTimeout(300);
  ok(await page.$$eval('.chat-msg[data-status="taken"]', (els) => els.length) === 0, 'calling wait again closes prompts left without a reply');

  // images attached to a chat message reach the agent as file paths
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('.chat-composer input[type=file]', { name: 'ref.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.chat-thumb:not(.is-pending)');
  ok(!(await page.$eval('.chat-send', (b) => b.disabled)), 'an attached image alone enables send');
  await page.fill('.chat-input', 'match this reference');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.chat-msg--user .chat-img img');
  ok(await page.$eval('.chat-msg--user:last-child .chat-img img', (i) => i.complete && i.naturalWidth === 2), 'the sent image shows in the thread');
  const gotImg = await cliAsync('wait', '--timeout', '5');
  const imgPath = (gotImg.match(/images attached[^:]*: (\S+)/) || [])[1];
  ok(imgPath && fs.existsSync(imgPath), 'canvas wait lists the image as a file the agent can open');
  cli('say', '--reply', gotImg.match(/\[canvas prompt (\w+)\]/)[1], 'Looked at it');

  // single click aims the camera at the clicked point
  cli('view', 'free');
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.canvas.viewport.freeOrbit.target.toArray());
  const vp = await page.evaluate(() => { const r = window.canvas.viewport.canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.25, y: r.top + r.height * 0.85 }; });
  await page.mouse.click(vp.x, vp.y);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.canvas.viewport.freeOrbit.target.toArray());
  ok(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.5, `click aims the camera at that point (${after.map((v) => v.toFixed(2))})`);
  ok(await page.evaluate(() => window.canvas.store.state.selection) === 'tower', 'plain click keeps the selection');

  // save / load
  ok(/saved "v1"/.test(cli('save', 'v1')), 'canvas save');
  let dup = false; try { cli('save', 'v1'); } catch (e) { dup = /already exists/.test(e.stderr || e.message); }
  ok(dup, 'saving over an existing name needs --overwrite');
  cli('add', 'cone', '--name', 'extra');
  cli('load', 'v1');
  ok(!JSON.parse(cli('doc')).objects.some((o) => o.id === 'extra'), 'canvas load restores the saved scene');
  cli('undo');
  ok(JSON.parse(cli('doc')).objects.some((o) => o.id === 'extra'), 'undo reverts a load');
  await page.keyboard.press('Control+s');
  await page.fill('.scenes-field', 'from ui');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.click('.scenes-btn');
  await page.waitForSelector('.scenes-list img.scenes-thumb', { timeout: 5000 });
  ok((await page.textContent('.scenes-label.is-current')) === 'from-ui', 'the saved version is ticked as current');
  ok(/from-ui/.test(cli('saves')) && fs.existsSync(path.join(dir, 'saved', 'from-ui.png')), 'save from the canvas writes the scene and a thumbnail');
  await page.keyboard.press('Escape');
  ok((await page.textContent('.scenes-name')) === 'from-ui', 'the Scenes button names the version you saved');
  await page.click('.scenes-btn');
  await page.click('.scenes-action >> text=New scene');
  await page.waitForTimeout(300);
  const fresh = JSON.parse(cli('doc'));
  ok(fresh.objects.length === 0 && /^scene-\d+$/.test(fresh.meta.name), `New scene in the Scenes menu starts an empty scene (${fresh.meta.name})`);
  await page.waitForTimeout(300);
  cli('add', 'box', '--name', 'autosaved');
  await page.waitForTimeout(1200);
  const savedFile = path.join(dir, 'saved', `${fresh.meta.name}.json`);
  ok(fs.existsSync(savedFile) && JSON.parse(fs.readFileSync(savedFile, 'utf8')).objects.some((o) => o.id === 'autosaved'), 'changes autosave into the version you are on');
  cli('undo');
  cli('undo');
  ok(JSON.parse(cli('doc')).objects.length > 0, 'undo brings the old scene back after New scene');

  // objects move over time: the agent's move command plays back in the canvas
  cli('add', 'person', '--name', 'walker', '--pos', '0,0,4');
  ok(/walker moves 1s → 3s/.test(cli('move', 'walker', '--to', '0,0,-2', '--at', '1', '--over', '2', '--ease', 'linear')), 'canvas move adds a timed move');
  ok(/anim: 1s@0,0,4 → 3s@0,0,-2/.test(cli('ls')), 'canvas ls shows the move');
  cli('seek', '2');
  await page.waitForTimeout(200);
  const wz = await page.evaluate(() => window.canvas.viewport.meshes.get('walker').mesh.position.z);
  ok(Math.abs(wz - 1) < 0.05, `the object is halfway at 2s (z=${wz.toFixed(2)})`);
  await page.evaluate(() => window.canvas.store.set({ selection: 'walker' }));
  await page.waitForTimeout(150);
  const body = await page.evaluate(() => { const m = window.canvas.viewport.meshes.get('walker'); m.mesh.geometry.computeBoundingBox(); const bb = m.mesh.geometry.boundingBox; return { tris: m.mesh.geometry.index.count / 3, h: bb.max.y - bb.min.y, minY: bb.min.y, tint: m.mesh.material.emissive.getHex() }; });
  ok(body.tris < 4000 && Math.abs(body.h - 1.8) < 0.01 && Math.abs(body.minY) < 1e-4, `person is a low-poly 1.8 m figure standing on the ground (${body.tris} tris, h=${body.h.toFixed(3)})`);
  ok(body.tint !== 0, 'a selected person is tinted (people draw no edge lines)');
  cli('set', 'walker', '--body', 'female');
  await page.waitForTimeout(250);
  const fh = await page.evaluate(() => { const g = window.canvas.viewport.meshes.get('walker').mesh.geometry; g.computeBoundingBox(); return g.boundingBox.max.y; });
  ok(Math.abs(fh - 1.65) < 0.01, `--body female swaps the body and its usual height (h=${fh.toFixed(3)})`);
  ok(await page.isVisible('.tl-objkey') && /Key walker/.test(await page.textContent('.tl-objkey')), 'selecting an object shows its Key button');
  cli('seek', '4');
  await page.click('.tl-objkey');
  await page.waitForTimeout(300);
  ok(JSON.parse(cli('doc')).objects.find((o) => o.id === 'walker').anim.length === 3, 'Key walker adds a key at the playhead');
  cli('okey-rm', 'walker');
  cli('rm', 'walker');
  await page.evaluate(() => window.canvas.store.set({ selection: null }));

  // the lens field drives the free view camera too
  cli('view', 'free');
  await page.evaluate(() => window.canvas.store.set({ key: null }));
  await page.waitForTimeout(100);
  const lensIn = await page.$('.tl-bar .cc-affix input');
  await lensIn.click(); await lensIn.fill('85'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const freeFov = await page.evaluate(() => window.canvas.viewport.freeCam.fov);
  ok(Math.abs(freeFov - 15.9) < 0.3, `lens 85 mm sets the free view to ~15.9° (got ${freeFov.toFixed(2)})`);
  const kid = JSON.parse(cli('doc')).timeline.keys[0].id;
  await page.evaluate((id) => window.canvas.store.set({ key: id }), kid);
  await page.waitForTimeout(200);
  const keyFov = JSON.parse(cli('doc')).timeline.keys[0].fov;
  ok(Math.abs((await page.evaluate(() => window.canvas.viewport.freeCam.fov)) - keyFov) < 0.01, 'selecting a key puts the free view on its lens');

  // orchestration helpers: scoped batches, per-area listing, snapshots from the agent's own camera
  const fsx = await import('node:fs');
  const scoped = path.join(dir, 'scoped.json');
  fsx.writeFileSync(scoped, JSON.stringify([{ op: 'add', type: 'box', name: 'zone-a-wall', w: 2 }, { op: 'add', type: 'box', name: 'zone-a-roof', position: [0, 1, 0] }]));
  cli('ops', scoped, '--scope', 'zone-a-');
  ok(/zone-a-wall/.test(cli('ls', '--prefix', 'zone-a-')) && !/tower/.test(cli('ls', '--prefix', 'zone-a-')), 'ls --prefix lists one area');
  fsx.writeFileSync(scoped, JSON.stringify([{ op: 'update', id: 'tower', h: 1 }]));
  let refused = '';
  try { cli('ops', scoped, '--scope', 'zone-a-'); } catch (e) { refused = String(e.stderr || e.message); }
  ok(/not one of yours/.test(refused), 'ops --scope refuses changes to objects outside the prefix');
  fsx.writeFileSync(scoped, JSON.stringify([{ op: 'key.add', t: 1, position: [1, 1, 1], target: [0, 0, 0] }]));
  refused = '';
  try { cli('ops', scoped, '--scope', 'zone-a-'); } catch (e) { refused = String(e.stderr || e.message); }
  ok(/outside scope/.test(refused), 'ops --scope refuses camera changes');
  const freeBefore = await page.evaluate(() => window.canvas.viewport.freeCam.position.toArray());
  const own = cli('snapshot', '--from', '6,4,6', '--target', '0,1,0', '--lens', '28');
  const freeAfter = await page.evaluate(() => window.canvas.viewport.freeCam.position.toArray());
  ok(fsx.existsSync(own.trim()) && freeBefore.every((v, i) => v === freeAfter[i]), 'snapshot --from/--target renders without moving the user view');
  cli('rm', 'zone-a-wall', 'zone-a-roof');

  // shot -> free with a key selected keeps the shot camera's position and lens
  const k0 = JSON.parse(cli('doc')).timeline.keys[0];
  await page.evaluate((id) => window.canvas.store.set({ key: id }), k0.id);
  cli('seek', String(k0.t)); cli('view', 'shot');
  await page.waitForTimeout(200);
  const shotPose = await page.evaluate(() => ({ p: window.canvas.viewport.shotCam.position.toArray(), f: window.canvas.viewport.shotCam.fov }));
  cli('view', 'free');
  await page.waitForTimeout(200);
  const freePose = await page.evaluate(() => ({ p: window.canvas.viewport.freeCam.position.toArray(), f: window.canvas.viewport.freeCam.fov }));
  ok(freePose.p.every((v, i) => Math.abs(v - shotPose.p[i]) < 1e-3) && Math.abs(freePose.f - shotPose.f) < 1e-3, 'back to free with a key selected keeps the shot position and lens');

  // Cut at the playhead: this shot ends on the frame, the next starts a frame later from the same framing
  const tlBefore = JSON.parse(cli('doc')).timeline, fr = tlBefore.fps;
  let tc = null;
  for (let f = Math.round((tlBefore.duration * fr) / 2); f < tlBefore.duration * fr - 2; f++) {
    if (!tlBefore.keys.some((k) => Math.abs(k.t - f / fr) < 2.5 / fr)) { tc = +(f / fr).toFixed(3); break; }
  }
  cli('seek', String(tc)); await page.waitForTimeout(150);
  await page.click('.tl-bar button[title^="Cut at the playhead"]');
  await page.waitForTimeout(400);
  const tlCut = JSON.parse(cli('doc')).timeline;
  const ka = tlCut.keys.find((k) => Math.abs(k.t - tc) < 1e-3), kb = tlCut.keys.find((k) => Math.abs(k.t - (tc + 1 / fr)) < 2e-3);
  ok(tlCut.keys.length === tlBefore.keys.length + 2 && ka?.ease === 'hold' && !!kb && kb.position.every((v, i) => Math.abs(v - ka.position[i]) < 1e-6),
    'Cut adds a hold key at the playhead and starts the next shot a frame later from the same framing');
  ok(await page.evaluate(() => window.canvas.store.state.key) === kb?.id, 'after a cut the new shot\'s first key is selected');
  // the pair is drawn as one split key either side of the cut line: each half selects its own key
  const tb = await page.locator('.tl-track').boundingBox();
  const txOf = (t) => tb.x + 14 + (t / tlCut.duration) * (tb.width - 28);
  const cutX = (txOf(ka.t) + txOf(kb.t)) / 2, midY = tb.y + tb.height / 2 + 6;
  await page.mouse.click(cutX - 3, midY); await page.waitForTimeout(120);
  const leftSel = await page.evaluate(() => window.canvas.store.state.key);
  await page.mouse.click(cutX + 4, midY); await page.waitForTimeout(120);
  const rightSel = await page.evaluate(() => window.canvas.store.state.key);
  ok(leftSel === ka.id && rightSel === kb.id, 'left half of a split key selects the end of the shot, right half the start of the next');
  cli('undo');
  ok(JSON.parse(cli('doc')).timeline.keys.length === tlBefore.keys.length, 'one undo removes the whole cut');

  // the play button pauses while playing (its icon must not be rebuilt every frame)
  await page.click('.tl-bar button[title^="Play"]').catch(async () => page.keyboard.press(' '));
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.canvas.store.state.playing), 'play button starts playback');
  await page.mouse.move(0, 0);
  const pb = await page.$('button[title^="Pause"]');
  await pb.click({ delay: 120 });
  await page.waitForTimeout(150);
  ok(!(await page.evaluate(() => window.canvas.store.state.playing)), 'pause button stops playback');

  // the message box grows with its text, up to a cap, and shrinks back after sending
  const hOf = () => page.$eval('.chat-input', (e) => e.getBoundingClientRect().height);
  const h1 = await hOf();
  await page.fill('.chat-input', 'a long message that wraps onto a second line in the chat composer box for sure, and then a third line too');
  const h2 = await hOf();
  await page.fill('.chat-input', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  const h3 = await hOf();
  ok(h2 > h1 + 10 && h3 <= 161 && h3 > h2, `the message box grows then caps (${h1}→${h2}→${h3}px)`);
  await page.fill('.chat-input', '');
  ok(Math.abs((await hOf()) - h1) < 1, 'and shrinks back when emptied');

  // new chat clears the thread
  ok(await page.$$eval('.chat-msg', (els) => els.length) > 0, 'thread has messages before a new chat');
  await page.click('.chat-new');
  await page.waitForFunction(() => !document.querySelector('.chat-msg') && document.querySelector('.chat-empty'));
  ok(true, 'new chat empties the thread and shows the intro');

  // chat toggle + shot settings
  const chatOpen = await page.isVisible('.chat');
  await page.click('.chat-toggle');
  ok((await page.isVisible('.chat')) !== chatOpen, 'the sidebar toggle opens and closes the chat');
  if (!chatOpen) await page.click('.chat-toggle');
  await page.click('.tl-shot');
  await page.fill('.shot-pop .cc-affix input.cc-num >> nth=1', '23.976');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok(JSON.parse(cli('doc')).timeline.fps === 23.976, 'frame rate can be typed with decimals');
  cli('timeline', '--fps', '12');
  await page.keyboard.press('Escape');

  // renders
  const snap = cli('snapshot', '--t', '1');
  ok(fs.existsSync(snap) && fs.statSync(snap).size > 10000, 'snapshot writes a PNG');
  // flat objects a few millimetres apart stay clean when seen from far away (no depth fighting).
  // The top one is added first, so with too little depth precision the one underneath wins the ties.
  cli('op', JSON.stringify([
    { op: 'add', type: 'plane', id: 'zf-top', w: 22, d: 22, position: [150, 0.01, 150], rotation: [0, 30, 0], color: '#333333' },
    { op: 'add', type: 'plane', id: 'zf-under', w: 14, d: 14, position: [150, 0.005, 150], color: '#ff0000' },
  ]));
  const far = cli('snapshot', '--from', '260,35,260', '--target', '150,0,150', '--lens', '50');
  const showing = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    // the plane underneath is pure red and fully covered: any reddish pixel means it shows through
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let red = 0, grey = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 90 && d[i] > 2 * d[i + 1] && d[i] > 2 * d[i + 2]) red++;
      else if (d[i] < 90 && Math.abs(d[i] - d[i + 1]) < 12) grey++;
    }
    return red / Math.max(1, red + grey);
  }, `data:image/png;base64,${fs.readFileSync(far).toString('base64')}`);
  ok(showing < 0.005, `flat objects 5 mm apart stay clean from far away (${(showing * 100).toFixed(1)}% of the top plane shows the one under it)`);
  cli('op', JSON.stringify([{ op: 'remove', id: 'zf-under' }, { op: 'remove', id: 'zf-top' }]));
  const board = cli('storyboard', '--frames', '4', '--cols', '2');
  ok(fs.existsSync(board), 'storyboard writes a PNG');
  const exp = cli('export', '--width', '320', '--height', '180');
  const file = exp.split('\n')[0];
  ok(fs.existsSync(file) && /48 frames/.test(exp), `export writes an mp4 (${exp.split('\n')[1]})`);
  try {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames,width', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    ok(/^h264,320,48$/.test(probe), `ffprobe: ${probe}`);
  } catch { console.log('     (ffprobe not available, skipped)'); }

  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
