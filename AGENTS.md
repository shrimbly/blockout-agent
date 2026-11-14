# Blockout: agent instructions

This repo is a minimal three.js blockout canvas that you (Claude Code, Codex, or another coding
agent) operate for the user. The user watches the canvas in a browser and can type prompts into it;
you build the scene, drive the camera timeline, and export a blockout video they pass to a generative
video model.

**Read `skills/camera-canvas/SKILL.md` before doing anything in the canvas.** It is the operating
manual (also installed as a skill at `.claude/skills/camera-canvas` and `.agents/skills/camera-canvas`).
The full op/CLI/HTTP reference is `skills/camera-canvas/references/api.md`.

## Quick start

```bash
npm install
node bin/canvas.mjs up        # server + browser tab at http://127.0.0.1:5317
node bin/canvas.mjs ls        # read the scene
node bin/canvas.mjs help      # every command
```

## Listening for prompts typed in the canvas

The user may say "listen to the canvas" or just start prompting there. Prompts come back to this
session with the selected object, playhead time and camera pose attached.

- **Codex / agents without hooks:** run `node bin/canvas.mjs wait --timeout 600`. When it prints a
  prompt, do it, verify with a snapshot, then `node bin/canvas.mjs say --reply <id> "<what changed>"`
  and run `wait` again. Keep looping until the user tells you to stop; on timeout, just wait again.
- **Claude Code:** `node bin/canvas.mjs listen on` and the Stop hook in `.claude/settings.json` hands
  you each new canvas prompt when you finish a turn (see CLAUDE.md).

## Rules

- Big requests with several independent areas: plan, then fan out to helper agents (Claude Code:
  `.claude/agents/canvas-builder.md`), each limited to its own id prefix with `canvas ops --scope`. See
  `skills/camera-canvas/references/orchestration.md`. Small edits: do them yourself in one batch.

- Change the scene through the CLI or ops, not by editing three.js code. Edit `scenes/scene.json` by
  hand only for bulk rewrites (the server reloads it on save).
- After visual changes, render `canvas snapshot` or `canvas storyboard` and look at the PNG before
  reporting back.
- New UI controls follow `docs/DESIGN.md` exactly: kit components, tokens, ops only, registered in
  `app/controls/index.js`.
- Keep the base minimal: do not add panels or features to the core app unless the user asks;
  prefer a control.
- New capabilities that change data get an op in `core/doc.js`, a CLI command or flag in
  `bin/canvas.mjs`, a line in `references/api.md`, and a test in `test/run.mjs`.
- After editing the skill in `skills/camera-canvas/`, run `npm run skills:sync` to update the copies.
- Before finishing code changes: `npm test` (fast) and, if you touched the app, `npm run e2e`
  (needs Playwright).

## Layout

```
bin/canvas.mjs        agent CLI (talks HTTP to the server)
server/index.mjs      bridge server: scene doc + undo, SSE to tabs, prompt inbox, exports
core/doc.js           scene document, primitives, ops (shared by server, CLI and browser)
core/curves.js        easing, speed curves, camera path sampling
app/                  the browser app (no build step; three.js via import map)
  viewport.js         three.js scene, cameras, gizmos, offscreen rendering
  timeline.js         transport, key track, curve editor
  prompt.js           chat sidebar (prompts to the agent, replies from it)
  render.js           snapshot, storyboard, video export (WebCodecs → mp4)
  ui/                 design-system tokens, kit components, icons
  controls/           user-requested controls (empty by default) + template + example
docs/DESIGN.md        design system for controls
skills/camera-canvas  the agent skill (canonical copy)
scenes/               scene.json, exports/, .canvas/ (prompt inbox) — created at runtime
```
