#!/usr/bin/env node
// Copy the canonical skill (skills/camera-canvas) to where each agent looks for it:
//   Claude Code: .claude/skills/camera-canvas     Codex: .agents/skills/camera-canvas
// Pass --global to also install into ~/.claude/skills and ~/.codex/skills (the skill then works from any folder;
// it finds this repo through the CANVAS_HOME path written into it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'skills', 'camera-canvas');
const targets = [path.join(ROOT, '.claude/skills/camera-canvas'), path.join(ROOT, '.agents/skills/camera-canvas')];
const global = process.argv.includes('--global');
if (global) targets.push(path.join(os.homedir(), '.claude/skills/camera-canvas'), path.join(os.homedir(), '.codex/skills/camera-canvas'));

for (const dest of targets) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(SRC, dest, { recursive: true });
  if (!dest.startsWith(ROOT)) {
    for (const f of fs.readdirSync(dest, { recursive: true }).filter((f) => f.endsWith('.md'))) {
      const file = path.join(dest, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('node bin/canvas.mjs', `node "${path.join(ROOT, 'bin/canvas.mjs')}"`));
    }
  }
  console.log(`skill -> ${dest}`);
}
