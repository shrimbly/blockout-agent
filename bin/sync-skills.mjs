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

// The builder helper (Claude Code subagent) is generated from the skill's reference, so there is one source.
const builder = fs.readFileSync(path.join(SRC, 'references', 'builder.md'), 'utf8').replace(/^# .*\n+(<!--[\s\S]*?-->\n+)?/, '');
const agentFile = path.join(ROOT, '.claude', 'agents', 'canvas-builder.md');
fs.mkdirSync(path.dirname(agentFile), { recursive: true });
fs.writeFileSync(agentFile, `---
name: canvas-builder
description: Builds one part of a Camera Canvas blockout scene (a zone such as "the house", "the street", "the crowd") from a brief written by the main canvas agent, working in parallel with other builders. Use only when the camera-canvas skill's orchestration guide says to fan out.
tools: Bash, Read, Write
---

<!-- Generated from skills/camera-canvas/references/builder.md by bin/sync-skills.mjs. Edit that file instead. -->

${builder}`);
console.log(`builder agent -> ${agentFile}`);

