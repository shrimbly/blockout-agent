---
name: camera-canvas
description: Operate Camera Canvas, the three.js blockout tool for 3D scenes and camera moves: build and edit the scene, drive the camera timeline, answer prompts typed in the Camera Canvas chat, and export blockout videos for generative video models. Use only for Camera Canvas work: after /blockout-agent:start, when the user names Camera Canvas, when a prompt arrives from the Camera Canvas hooks, or when the user asks to block out a 3D scene or camera move for a video. Not for other canvases (design canvases, HTML canvas, Figma).
allowed-tools: Bash(canvas:*), Bash(node bin/canvas.mjs:*)
---

# Camera Canvas

Camera Canvas is a minimal three.js blockout tool that **you** operate. The user looks at the canvas
in their browser; you change it with the `canvas` CLI. The scene is a JSON document owned by a small
local server, so every change you make shows up live in the user's tab, is undoable (`⌘Z`), and is
saved to `scenes/scene.json` (in `~/Camera Canvas/` when installed as a plugin, in the repo for a checkout).

The end product is a **blockout video**: a camera move through primitive shapes, exported as an MP4
that the user passes to a generative video model as a structure/motion reference.

`canvas` below is the Camera Canvas CLI. With the Claude Code plugin installed it is a command on your
PATH and works from any folder. In a repo checkout without the plugin, run `node bin/canvas.mjs` from the
repo root instead (and `npm install` once). `command -v canvas` tells you which you have.

## 1. Start

```bash
canvas up        # starts the server in the background and opens http://127.0.0.1:5317
canvas listen on # Claude Code: prompts typed in the canvas now come to this session
canvas ls        # ALWAYS read the scene before changing it
```

The user starts a session with `/blockout-agent:start` (plugin), which runs all three and asks what to
block out. When they ask for Camera Canvas by name without it, do the same: run all three, then ask in one
line what they want to block out, and mention they can type it in the canvas or here. Don't send them to a
README or ask them to run commands themselves.

`up` is idempotent. `status` tells you whether a browser tab is open: rendering commands
(`snapshot`, `storyboard`, `export`, `seek`, `view`, `select`, `key --from-view`) need one.
If none is open, run `canvas open` and tell the user.

## 2. The working loop

1. `canvas ls` to see objects (id, type, size, position) and camera keys.
2. **Plan the whole change, then apply it in as few calls as possible.** Anything beyond one or two
   edits goes in one JSON array of ops applied with `canvas ops file.json` (atomic, one undo step);
   use single `add / set / key` commands only for quick one-offs. See [references/api.md](references/api.md).
3. **Look at your work.** `canvas snapshot --t <s>`, `canvas snapshot --from x,y,z --target x,y,z`
   (your own camera) or `canvas storyboard` prints a PNG path: open it with your image-reading tool and
   check composition, scale and overlaps. Render the angles you need in parallel. Do this before you
   say you are done with anything visual.
4. Tell the user what changed in one or two lines (and `canvas say` it if the request came from the canvas).

## 2b. Work fast without cutting corners

Most of the time goes into round trips, so do as much per step as you can:

- **Batch.** Plan the whole change, then apply it as one `canvas ops` file (any size; atomic; one undo).
  Avoid long runs of single `add`/`set` calls.
- **Run independent commands together.** Reads and checks that don't depend on each other (`ls`,
  several snapshots, reading reference images) go in the same turn as parallel tool calls.
- **Check from your own camera** with `canvas snapshot --from x,y,z --target x,y,z --lens 28`: it never moves
  the user's view, so you can check while they look around.
- **Fan out big, separable builds** to helper agents (several areas of ~10+ objects each): you plan the
  layout and brief them, they build in parallel inside their own id prefix and bounds, you integrate, then
  do the camera and review. Read [references/orchestration.md](references/orchestration.md) first; it
  says when it pays off (not for tweaks or one-area scenes, where it is slower), the brief to give, and
  how to review. Camera, timeline, replies and `wait` always stay with you. Keep the user posted with
  `canvas say --working --reply <id> "…"` at each stage (plan, building, joining up, camera).

## 3. Scene conventions

- Units are meters, Y is up, the ground is y = 0. Every primitive's pivot is at its **bottom centre**,
  so `--pos x,0,z` stands it on the ground. Stack by adding the height of what is below.
- Rotations are degrees (`--rot 0,45,0` turns around the vertical axis). `--scale` multiplies size.
- Types: `box(w,h,d) sphere(r) cylinder(r,h,rTop) cone(r,h) pyramid(w,h,d) capsule(r,h) torus(r,tube)
  plane(w,d) ramp(w,h,d) stairs(w,h,d,steps) arch(w,h,d,t) person(h,body)`. `--size a,b,c` fills the
  main params in that order.
- Use `person` (faces +z) for people and as a scale reference. `--body male|female|child` picks the
  body (default male); height defaults to 1.8 / 1.65 / 1.3 m, or set `--h`. Mix bodies in crowds and
  street scenes rather than repeating one.
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
  custom cubic bezier `--ease 0.2,0,0,1`. `hold` freezes until the next key, then cuts to it.
- Hard cuts: a `hold` key ends a shot and the next key starts a new one; the path on each side of the
  cut is independent. To cut from one moving shot straight into another, give the last key of shot A
  `--ease hold` at the cut time and put the first key of shot B one frame later (t + 1/fps):
  `canvas key --t 3 --pos ... --ease hold` then `canvas key --t 3.042 --pos ...` at 24 fps.
- `canvas timeline --speed easeIn` remaps time across the whole shot (a speed ramp), on top of segment eases.
- Path interpolation is a smooth spline through all keys (`--interp linear` for straight segments).
- Defaults that work for video models: 24 fps (decimals such as 23.976 are allowed), 3–8 s, 1280×720 (`canvas meta --width --height`).
  Lens: 24–28 mm wide/establishing, 35 mm natural, 50–85 mm close/portrait. Camera height 1.4–1.7 m
  reads as a person; low (0.3–0.6 m) reads as heroic.
- Keep the target moving smoothly too; a still target with a moving camera reads as an orbit.
- Check the move with `canvas storyboard --frames 8` before exporting.

## 4a. Moving objects

Objects can move during the shot. Each move adds keys on the shot timeline; between keys an object
travels in a straight line with the segment's ease, and before its first / after its last key it holds still.
Translate a prompt like "over 3s have the character enter the house" into `move` commands:

```bash
canvas ls                                   # find the character, the house and its door
canvas move hero --rot 0,180,0 --at 0 --over 0.3        # face the door first (person faces +z)
canvas move hero --to 0,0,-1.5 --at 0.3 --over 2.7 --ease easeInOut   # walk to and through the doorway
canvas storyboard --frames 6                # check it, then reply
```

- `--at` is when the move starts (default 0), `--over` how long it takes (default 1 s). Each move
  starts from where the object is at `--at`, so chain moves back to back to build a path (around a
  corner = two moves). `--to` is an absolute position, `--by` a relative offset; `--rot` / `--turn`
  rotate (absolute / relative degrees), `--scale` scales.
- To face the direction of travel, set the Y rotation to `atan2(dx, dz)` in degrees (a person faces +z).
- Moves past the end of the shot lengthen it. Fit moves inside `canvas timeline --duration` unless
  the user asked for a longer shot.
- `canvas okey <id> --t 2 --pos ...` keys a single moment; `canvas okey-rm <id> [--t 2]` removes one key
  (or all of an object's animation). `canvas set` on an animated object shifts its whole move.
- `canvas ls` prints each object's keys (`anim: 1s@0,0,4 → 3s@0,0,-2`). In the canvas, the selected
  object's keys show as circles under the camera keys; dragging an animated object with the gizmo keys it
  at the playhead.

## 4b. Save and load versions

The scene autosaves continuously, and once it has been saved under a name every change also autosaves into that named version (`meta.name`). Before a big rework (or when the user says "save this"), keep a
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
the `playhead:` time printed with it. When the user attaches images (references, sketches,
screenshots), the prompt has an `images attached:` line with their file paths: open each one with
your Read tool before acting on the prompt.

How to listen depends on the agent:
- **Claude Code**: run `canvas listen on`. The Stop hook (from the plugin, or `.claude/settings.json` in a
  checkout) then keeps this session waiting for the next canvas prompt each time you finish, and hands it to you as a new
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

- `canvas server is not running` → `canvas up`.
- `no canvas tab is open` → `canvas open`, then retry.
- An op error lists valid values (types, params, ease names): fix the call rather than editing JSON by hand.
- `canvas undo` reverts your last change. The scene file can also be edited directly; the server
  reloads it on save.
