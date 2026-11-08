---
name: camera-canvas
description: Build and edit 3D blockout scenes and camera moves in the Camera Canvas (three.js) app, answer prompts the user types in the canvas, and export blockout videos as references for generative video models. Use when the user asks to block out, lay out or stage a scene, add or move shapes, set up a camera move or timeline, change easing or speed, export or render the blockout, listen to the canvas, or add a new control to the canvas UI.
---

# Camera Canvas

Camera Canvas is a minimal three.js blockout tool that **you** operate. The user looks at the canvas
in their browser; you change it with the `canvas` CLI. The scene is a JSON document owned by a small
local server, so every change you make shows up live in the user's tab, is undoable (`⌘Z`), and is
saved to `scenes/scene.json`.

The end product is a **blockout video**: a camera move through primitive shapes, exported as an MP4
that the user passes to a generative video model as a structure/motion reference.

Run every command from the Camera Canvas repo root. `canvas` below means `node bin/canvas.mjs`.

## 1. Start

```bash
npm install            # once (three + mediabunny, no build step)
node bin/canvas.mjs up # starts the server in the background and opens http://127.0.0.1:5317
node bin/canvas.mjs ls # ALWAYS read the scene before changing it
```

`up` is idempotent. `status` tells you whether a browser tab is open: rendering commands
(`snapshot`, `storyboard`, `export`, `seek`, `view`, `select`, `key --from-view`) need one.
If none is open, run `node bin/canvas.mjs open` and tell the user.

## 2. The working loop

1. `canvas ls` to see objects (id, type, size, position) and camera keys.
2. Change the scene with `add / set / dup / rm / env` and the camera with `key / key-set / timeline`.
   For more than ~5 changes, write a JSON array of ops and apply it with `canvas ops file.json`
   (atomic, one undo step). See [references/api.md](references/api.md).
3. **Look at your work.** `canvas snapshot --t <s>` or `canvas storyboard` prints a PNG path: open it
   with your image-reading tool and check composition, scale and overlaps. Do this before you say
   you are done with anything visual.
4. Tell the user what changed in one or two lines (and `canvas say` it if the request came from the canvas).

## 3. Scene conventions

- Units are meters, Y is up, the ground is y = 0. Every primitive's pivot is at its **bottom centre**,
  so `--pos x,0,z` stands it on the ground. Stack by adding the height of what is below.
- Rotations are degrees (`--rot 0,45,0` turns around the vertical axis). `--scale` multiplies size.
- Types: `box(w,h,d) sphere(r) cylinder(r,h,rTop) cone(r,h) pyramid(w,h,d) capsule(r,h) torus(r,tube)
  plane(w,d) ramp(w,h,d) stairs(w,h,d,steps) arch(w,h,d,t) person(h)`. `--size a,b,c` fills the
  main params in that order.
- Use `person` (1.8 m, faces +z) as a scale reference for any scene with people.
- Give objects meaningful names (`--name hero-car`); the name becomes the id.
- Keep blockouts grey (default `#d8d4cc`). Use colour only to tell the subject apart from the set
  (one or two muted colours), because the video model reads colour and shape.
- Large sets: ground-level `plane`s for roads/water, `box`es for buildings, repeat with `dup --offset`.

## 4. Camera and timeline

The shot camera is defined by keys: `t` (seconds), `pos`, `target` (look-at point), `fov` or `lens` (mm),
`roll`, and `ease` (how the camera travels **from this key to the next**).

```bash
canvas key --t 0 --pos 8,1.6,10 --target 0,1.2,0 --lens 35
canvas key --t 4 --pos 2,1.4,4 --target 0,1.2,0 --lens 50 --ease slowOut
canvas timeline --duration 4 --fps 24
canvas key --t 2 --from-view          # key whatever the user is looking at right now
```

- Eases: `linear ease easeIn easeOut easeInOut slowIn slowOut snap anticipate overshoot hold`, or a
  custom cubic bezier `--ease 0.2,0,0,1`. `hold` freezes until the next key (a cut).
- `canvas timeline --speed easeIn` remaps time across the whole shot (a speed ramp), on top of segment eases.
- Path interpolation is a smooth spline through all keys (`--interp linear` for straight segments).
- Defaults that work for video models: 24 fps (decimals such as 23.976 are allowed), 3–8 s, 1280×720 (`canvas meta --width --height`).
  Lens: 24–28 mm wide/establishing, 35 mm natural, 50–85 mm close/portrait. Camera height 1.4–1.7 m
  reads as a person; low (0.3–0.6 m) reads as heroic.
- Keep the target moving smoothly too; a still target with a moving camera reads as an orbit.
- Check the move with `canvas storyboard --frames 8` before exporting.

## 4b. Save and load versions

The scene autosaves continuously. Before a big rework (or when the user says "save this"), keep a
named version: `canvas save street-v1`. `canvas saves` lists versions; `canvas load street-v1`
restores one (undoable with `canvas undo`). `canvas new` starts an empty scene (also undoable; the Scenes menu has a New button). Saving over an existing name needs `--overwrite`;
prefer a new name such as `street-v2`.

## 5. Export

```bash
canvas export                 # mp4 (H.264) of the whole shot at the doc's size/fps; prints the path
canvas export --fps 24 --width 1920 --height 1080 --grid off --name street-chase
```

Exports land in `scenes/exports/`. Give the user the path. Grid lines are kept by default because
they help the video model read ground motion; `--grid off` removes them.

## 6. Prompts typed in the canvas

The canvas has a chat sidebar. Prompts queue on the server and come back to **this session** with the
user's selection, playhead time and camera pose attached. Pick one up, do it, then reply:

```bash
canvas wait --timeout 600      # blocks until a prompt arrives; prints it with context
# ... make the change, check a snapshot ...
canvas say --reply <promptId> "Raised the tower to 10 m and keyed a slower push-in"
```

`canvas say` shows the reply in the canvas and marks the prompt done. Use `--working` for progress
notes that should not close it, and **always finish with a final `say`** (without `--working`):
otherwise the user sees "no reply yet". Then call `canvas wait` again straight away; a prompt is
only delivered to an agent that is waiting. Calling `wait` also marks any prompt you already took
as done and turns listen mode on. "this", "it" or "here" in a prompt refer to the `selected:` object and
the `playhead:` time printed with it.

How to listen depends on the agent:
- **Claude Code**: run `canvas listen on`. The repo's Stop hook (`.claude/settings.json`) then keeps
  this session waiting for the next canvas prompt each time you finish, and hands it to you as a new
  instruction in the same thread. `canvas listen off` stops it. The UserPromptSubmit hook also passes
  along prompts queued while you were busy. Without hooks, run `canvas wait` as a background command
  and handle its output when it completes, then start it again.
- **Codex** (or any agent without hooks): loop `canvas wait --timeout 600`; after handling a prompt,
  call `canvas wait` again. If it times out, run it again unless the user told you to stop.

Keep listening until the user says to stop.

## 7. Adding controls to the canvas

The base UI is intentionally only the timeline. When the user asks for a new control (a slider for
fog, a lens picker, an object list…), follow `docs/DESIGN.md` in the repo:

1. Copy `app/controls/_template.js` to `app/controls/<id>.js`.
2. Build it only from `app/ui/kit.js` components; read state from `ctx`, change the scene only through
   `ctx.op(...)`. New behaviour that needs new data gets a new op in `core/doc.js` (and a CLI flag).
3. Register it in `app/controls/index.js`. Open tabs reload automatically when `app/` changes.
4. Run `npm test`, and check the page loads without console errors.

## 8. Troubleshooting

- `canvas server is not running` → `node bin/canvas.mjs up`.
- `no canvas tab is open` → `node bin/canvas.mjs open`, then retry.
- An op error lists valid values (types, params, ease names): fix the call rather than editing JSON by hand.
- `canvas undo` reverts your last change. The scene file can also be edited directly; the server
  reloads it on save.
