# Camera Canvas

A hyper-minimal three.js canvas for **blocking out 3D scenes and camera moves with your coding
agent** (Claude Code or Codex), then exporting a blockout video to use as a reference for a
generative video model.

The interface is a ground plane, primitive shapes, gizmos when you click something, a camera
timeline with easing and speed curves, and a prompt box. Everything else you ask your agent for.

```
 you ── prompt box in the canvas ──▶ bridge server ──▶ your agent session (same thread)
  ▲                                      │                      │
  └──────── live scene updates ◀─────────┴──── canvas CLI ◀─────┘
```

## Quick start

Requires Node 20+ and a Chromium-based browser or Safari 17+ (for WebCodecs video export).

```bash
npm install
node bin/canvas.mjs up      # starts the local server and opens http://127.0.0.1:5317
```

Then open your agent in this folder and talk to it:

- **Claude Code**: `claude` → "block out a rainy street with a person waiting at a bus stop, slow
  push-in over 5 seconds". The `camera-canvas` skill and hooks load from `.claude/`.
- **Codex**: `codex` → same. Codex reads `AGENTS.md` and the skill in `.agents/skills/`.

To use the skill from any folder: `node bin/sync-skills.mjs --global` (installs to
`~/.claude/skills` and `~/.codex/skills` with this repo's path baked in).

## Prompting from inside the canvas

Type in the box at the top of the canvas. The prompt goes back to your agent session together with
what you have selected, the playhead time and the camera pose, so "make this taller" or "slow the
camera down here" just work. The agent's reply appears under your prompt.

Tell your agent to listen first:

- **Claude Code**: say "listen to the canvas". It runs `canvas listen on`; the Stop hook then keeps the
  session waiting for your next canvas prompt and feeds it into the same thread. Press Esc in the
  terminal to interrupt; "stop listening" turns it off.
- **Codex**: say "listen to the canvas". It loops `canvas wait`, which blocks until you send a prompt.

The chip next to the box shows **agent listening** (green), **agent working** (orange), or **agent not
listening** (prompts queue until the agent picks them up). A prompt the agent took but never answered
shows "no reply yet" instead of spinning forever, and is closed as soon as the agent asks for the next one.

## In the canvas

| | |
|---|---|
| Click | aim the camera at the clicked point (object surface or ground). In Shot view, press `K` to key the new aim. |
| Ctrl-click (or ⌘-click) | select an object; on empty space, deselect |
| Drag | orbit · right-drag pan · scroll zoom · double-click frames the selection |
| `W` `E` `R` | move / rotate / scale gizmo |
| `F` · `Shift D` · `⌫` · `Esc` | frame · duplicate · delete · deselect |
| `C` | toggle **Free** (orbit the set, see the camera path) and **Shot** (look through the timeline camera, letterboxed to the export size) |
| `K` | key the current view at the playhead. In Shot view, orbit to reframe, then `K`. |
| `Space` · `← →` · `Home` | play · step a frame (Shift: 1 s) · start |
| `⌘Z` / `⇧⌘Z` | undo / redo (also undoes agent changes) |

**Timeline:** drag the playhead to scrub; drag a key (◆) to retime it (snaps to frames, Shift for
free); double-click the track to add a key from the current view; right-click a key to delete it.
With a key selected: its ease, lens (mm), "set to current view" and delete. The curve button opens
the editor: **Segment** edits the cubic-bezier ease between two keys (the shaded area is the
camera's speed), **Shot speed** remaps time across the whole shot for speed ramps.

**Export:** the Export button (or `canvas export`) renders every frame through the shot camera at
the scene size and fps and encodes an H.264 MP4 in the browser. Files land in `scenes/exports/`.

## For agents

- [AGENTS.md](AGENTS.md) — project instructions (Codex, and Claude via CLAUDE.md)
- [skills/camera-canvas/SKILL.md](skills/camera-canvas/SKILL.md) — the skill: workflow, conventions, camera craft
- [skills/camera-canvas/references/api.md](skills/camera-canvas/references/api.md) — ops, CLI and HTTP reference
- [docs/DESIGN.md](docs/DESIGN.md) — design system for new controls
- `node bin/canvas.mjs help` — every command

```bash
node bin/canvas.mjs add box --name tower --size 2,8,2 --pos -3,0,-2
node bin/canvas.mjs add person --pos 0,0,3
node bin/canvas.mjs key --t 0 --pos 6,1.6,10 --target 0,1.5,0 --lens 28
node bin/canvas.mjs key --t 5 --pos 1,1.5,5 --target 0,1.6,0 --lens 50 --ease slowOut
node bin/canvas.mjs storyboard     # contact sheet PNG of the move
node bin/canvas.mjs export         # mp4 path
```

## Adding controls

The base ships with no side panels. Ask your agent: "add a control for fog and sun direction". It
copies `app/controls/_template.js`, builds the panel from the UI kit following `docs/DESIGN.md`,
registers it in `app/controls/index.js`, and open tabs reload automatically. See
`app/controls/examples/environment.js` for a complete example.

## How it works

- `server/index.mjs` owns the scene document (`scenes/scene.json`), applies ops with undo history,
  streams changes to open tabs over Server-Sent Events, forwards render requests to a tab, keeps the
  prompt inbox (`scenes/.canvas/inbox.jsonl`), and stores exports. Zero dependencies.
- `core/` is shared by server, CLI and browser: the document model, primitives, ops, and the
  easing / camera-path math.
- `app/` is plain ES modules with three.js from `node_modules` via an import map. No build step.
- Video export uses WebCodecs through [mediabunny](https://mediabunny.dev). If the browser can only
  encode VP9 and `ffmpeg` is installed, the server transcodes to H.264.

Environment: `CANVAS_PORT` (5317), `CANVAS_SCENE` (scene file path), `CANVAS_EXPORTS`,
`CANVAS_LISTEN_SECONDS` (Stop-hook wait, default 3300).

## Tests

```bash
npm test        # core ops, easing, path sampling, skill copies in sync
npm run e2e     # headless browser: selection, gizmo drag, keys, prompt round trip, Stop hook, export
```
