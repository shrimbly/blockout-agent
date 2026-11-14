# Blockout API reference

Three ways in, all equivalent: the `canvas` CLI (`canvas …` with the plugin, `node bin/canvas.mjs …` in a checkout), JSON ops
(`canvas op '<json>'`, `canvas ops file.json`), and HTTP on `http://127.0.0.1:5317`.

## Scene document

```jsonc
{
  "meta": { "name": "untitled", "width": 1280, "height": 720 },
  "env": { "background": "#e9e7e2", "ground": true, "grid": true, "fog": 0, "sun": [6, 10, 4] },
  "objects": [
    { "id": "tower", "name": "tower", "type": "box", "params": { "w": 2, "h": 6, "d": 2 },
      "position": [-3, 0, -2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "color": "#d8d4cc", "note": "optional",
      // optional: moves during the shot; position/rotation/scale equal the first key
      "anim": [ { "t": 1, "position": [-3, 0, -2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "ease": "easeInOut" },
                { "t": 3, "position": [-3, 0, 2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "ease": "easeInOut" } ] }
  ],
  "timeline": {
    "duration": 5, "fps": 24, "interp": "smooth", "speed": "linear",
    "keys": [ { "id": "k1", "t": 0, "position": [7, 3.5, 9], "target": [0, 1, 0], "fov": 40, "roll": 0, "ease": "easeInOut" } ]
  },
  "controls": {}
}
```

Rotation is degrees XYZ. `fov` is vertical, in degrees (`--lens` converts from full-frame mm).
`ease` on a key is the curve used from that key to the next.

## Ops

Send one op or an array (applied atomically: all or nothing, one undo step).

| op | fields | result |
|---|---|---|
| `add` | `type`, `name?`, `id?`, `position?`, `rotation?`, `scale?` (number or [x,y,z]), `color?`, `note?`, `size?` [a,b,c], or params by name (`w`, `h`, `r`, …), or `params: {}` | `{ id }` |
| `update` | `id` (or name), any `add` field, `move: [dx,dy,dz]`, `type` (resets params) | `{ id }` |
| `remove` | `id` or `ids: []` | `{ removed }` |
| `duplicate` | `id`, `offset?` (default [1,0,0]), `name?` | `{ id }` |
| `clear` | `keys?: true` also removes camera keys | `{ removed }` |
| `env` | `background`, `ground`, `grid`, `fog` (0–0.1 exp density), `sun` [x,y,z] direction | `{ env }` |
| `meta` | `name`, `width`, `height` (export size, even numbers) | `{ meta }` |
| `anim.move` | `id`, `to?` [x,y,z] or `by?`, `rotation?` or `turn?`, `scale?`, `at?` (start s, default 0), `over?` (s, default 1), `ease?`. Starts from where the object is at `at` | `{ id, from, to, keys }` |
| `anim.key` | `id`, `t`, `position?`, `rotation?`, `scale?`, `ease?`. Missing fields keep where it is at `t`; a key already at `t` is replaced | `{ id, t, keys }` |
| `anim.remove` | `id`, `t?` (omit to remove all of its animation) | `{ id, keys }` |
| `key.add` | `t`, `position`, `target`, `fov?`, `roll?`, `ease?`. A key already at `t` is updated instead | `{ id, replaced? }` |
| `key.update` | `id` or `index` (by time order), any key field | `{ id }` |
| `key.remove` | `id` or `index` | `{ removed }` |
| `key.clear` | | `{ removed }` |
| `timeline` | `duration`, `retime?` (scale key times), `fps` (1–120, decimals allowed e.g. 23.976; default 24), `interp` (`smooth`/`linear`), `speed` (ease, whole shot), `ease` (set every key) | `{ timeline }` |
| `audio` | `file` (name in the scene's `audio/`, from `POST /api/audio`), `name?`, `offset` (s on the timeline where the audio starts; negative skips into it), `volume` (0–4), `muted`, `length` (set by the tab), `fit` (duration = length + offset), `clear` | `{ audio, duration }` |
| `controls.set` | `key`, `value` (any JSON; omit to delete) — state for custom controls | `{ key }` |
| `load` | `doc` — replace the whole scene | |
| `batch` | `ops: []` | `{ results }` |

### Primitives (pivot at bottom centre)

| type | params (defaults) | `size` order |
|---|---|---|
| box | w 1, h 1, d 1 | w,h,d |
| sphere | r 0.5 | r |
| cylinder | r 0.5, h 1, rTop (= r) | r,h |
| cone | r 0.5, h 1 | r,h |
| pyramid | w 1, h 1, d 1 | w,h,d |
| capsule | r 0.3, h 1.8 (total height) | r,h |
| torus | r 0.5, tube 0.15 (lies flat) | r,tube |
| plane | w 4, d 4 (on the ground) | w,d |
| ramp | w 1, h 1, d 2 (rises toward −z) | w,h,d |
| stairs | w 1, h 1, d 1.5, steps 6 (rise toward −z) | w,h,d |
| arch | w 2, h 2.5, d 0.5, t 0.4 (doorway, wall thickness t) | w,h,d |
| person | body male\|female\|child (default male), h (default 1.8 / 1.65 / 1.3 by body); faces +z | h |

### Eases

`linear ease easeIn easeOut easeInOut slowIn slowOut snap anticipate overshoot hold`, or `[x1, y1, x2, y2]`
(CSS cubic-bezier; x in 0–1, y may overshoot). `hold` = no motion until the next key, then a hard cut
to it. On camera keys a hold also splits the smooth path: the moves before and after the cut don't
bend toward each other. For a cut between two moving shots, put shot B's first key one frame after
shot A's last (hold) key.

## Example: a batch file

```json
[
  { "op": "clear", "keys": true },
  { "op": "add", "type": "plane", "name": "street", "w": 8, "d": 60, "color": "#bdbab3" },
  { "op": "add", "type": "box", "name": "bldg-l1", "size": [6, 14, 10], "position": [-8, 0, -5] },
  { "op": "add", "type": "box", "name": "bldg-r1", "size": [6, 20, 12], "position": [8, 0, -8] },
  { "op": "add", "type": "person", "name": "hero", "position": [0, 0, 4] },
  { "op": "key.add", "t": 0, "position": [0, 0.5, 14], "target": [0, 1.2, 4], "fov": 30, "ease": "easeInOut" },
  { "op": "key.add", "t": 5, "position": [3, 6, 2], "target": [0, 1.5, 4], "fov": 45 },
  { "op": "timeline", "duration": 5, "fps": 24 }
]
```

## CLI → browser commands (need an open tab)

`seek <s>`, `play`, `pause`, `view shot|free`, `select <id|none>`, `frame [id]`, `key --from-view`,
`snapshot [--t s] [--view shot|free] [--out file]`, `storyboard [--frames n] [--cols n]`,
`export [--fps] [--width --height] [--grid on|off] [--name]` (mixes in the audio track),
`audio --beats [--json]` and `audio --fit` (the tab decodes the file).

`canvas audio <file> [--offset s] [--volume v] [--mute on|off] [--fit]` uploads and sets the audio track;
`canvas audio` alone prints it; `canvas audio --clear` removes it.

## Save / load

`canvas save [name] [--overwrite]`, `canvas load <name>`, `canvas saves`. Files: `scenes/saved/<name>.json`
(plus `<name>.png` thumbnail when saved from the canvas). Names are slugged (`"Street v1"` → `street-v1`).

## HTTP

| method + path | body / query | returns |
|---|---|---|
| `GET /api/doc` | | `{ rev, doc }` |
| `GET /api/summary` | | readable one-line-per-object summary |
| `GET /api/status` | | `{ agent, listen, waiting, queued, rev, tabs, scene, exports }` |
| `POST /api/op` | `{ ops, label?, amend? }` (amend: not an undo step) | `{ ok, rev, results }` or `{ ok: false, error }` |
| `POST /api/undo`, `/api/redo` | | |
| `GET /api/saves` | | `{ saves: [{ name, savedAt, objects, keys, thumb }] }` |
| `POST /api/save` | `{ name?, overwrite? }` | `{ name, path }`; 409 if it exists |
| `POST /api/load` | `{ name }` | `{ name, objects, keys }` (undoable) |
| `POST /api/audio?name=song.mp3` | raw audio bytes | `{ file, name, path, url }`: stored in the scene folder's `audio/`; then set it with the `audio` op |
| `POST /api/rpc` | `{ method, params, timeout? }` (methods: camera, state, seek, play, pause, view, select, frame, snapshot, storyboard, export, audio) | `{ ok, result }` |
| `GET /api/prompt/next?wait=600` | long poll | `{ prompt }` or `{ prompt: null }` on timeout |
| `POST /api/say` | `{ text, reply?, done? }` | |
| `POST /api/listen` | `{ on, session?, cwd? }` | the agent session that owns listen mode |
| `GET /api/events` | Server-Sent Events: doc, status, prompt, say, rpc, reload | |

Prompt objects: `{ id, text, status: pending|taken|done, context: { selection: [..], time, duration, view, key, camera: { position, target, fov } } }`.
