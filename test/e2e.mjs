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
  await page.fill('.saves-name', 'from ui');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.saves-item img.saves-thumb', { timeout: 5000 });
  ok(/from-ui/.test(cli('saves')) && fs.existsSync(path.join(dir, 'saved', 'from-ui.png')), 'save from the canvas writes the scene and a thumbnail');
  await page.keyboard.press('Escape');

  // renders
  const snap = cli('snapshot', '--t', '1');
  ok(fs.existsSync(snap) && fs.statSync(snap).size > 10000, 'snapshot writes a PNG');
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
