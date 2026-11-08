# Camera Canvas API reference

Three ways in, all equivalent: the `canvas` CLI (`node bin/canvas.mjs …`), JSON ops
(`canvas op '<json>'`, `canvas ops file.json`), and HTTP on `http://127.0.0.1:5317`.

## Scene document

```jsonc
{
  "meta": { "name": "untitled", "width": 1280, "height": 720 },
  "env": { "background": "#e9e7e2", "ground": true, "grid": true, "fog": 0, "sun": [6, 10, 4] },
  "objects": [
    { "id": "tower", "name": "tower", "type": "box", "params": { "w": 2, "h": 6, "d": 2 },
      "position": [-3, 0, -2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "color": "#d8d4cc", "note": "optional" }
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
| `key.add` | `t`, `position`, `target`, `fov?`, `roll?`, `ease?`. A key already at `t` is updated instead | `{ id, replaced? }` |
| `key.update` | `id` or `index` (by time order), any key field | `{ id }` |
| `key.remove` | `id` or `index` | `{ removed }` |
| `key.clear` | | `{ removed }` |
| `timeline` | `duration`, `retime?` (scale key times), `fps` (1–120, decimals allowed e.g. 23.976; default 24), `interp` (`smooth`/`linear`), `speed` (ease, whole shot), `ease` (set every key) | `{ timeline }` |
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
| person | h 1.8 (faces +z) | h |

### Eases

`linear ease easeIn easeOut easeInOut slowIn slowOut snap anticipate overshoot hold`, or `[x1, y1, x2, y2]`
(CSS cubic-bezier; x in 0–1, y may overshoot). `hold` = no motion until the next key.

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
`export [--fps] [--width --height] [--grid on|off] [--name]`.

## Save / load

`canvas save [name] [--overwrite]`, `canvas load <name>`, `canvas saves`. Files: `scenes/saved/<name>.json`
(plus `<name>.png` thumbnail when saved from the canvas). Names are slugged (`"Street v1"` → `street-v1`).

## HTTP

| method + path | body / query | returns |
|---|---|---|
| `GET /api/doc` | | `{ rev, doc }` |
| `GET /api/summary` | | readable one-line-per-object summary |
| `GET /api/status` | | `{ agent, listen, waiting, queued, rev, tabs, scene, exports }` |
| `POST /api/op` | `{ ops, label? }` | `{ ok, rev, results }` or `{ ok: false, error }` |
| `POST /api/undo`, `/api/redo` | | |
| `GET /api/saves` | | `{ saves: [{ name, savedAt, objects, keys, thumb }] }` |
| `POST /api/save` | `{ name?, overwrite? }` | `{ name, path }`; 409 if it exists |
| `POST /api/load` | `{ name }` | `{ name, objects, keys }` (undoable) |
| `POST /api/rpc` | `{ method, params, timeout? }` (methods: camera, state, seek, play, pause, view, select, frame, snapshot, storyboard, export) | `{ ok, result }` |
| `GET /api/prompt/next?wait=600` | long poll | `{ prompt }` or `{ prompt: null }` on timeout |
| `POST /api/say` | `{ text, reply?, done? }` | |
| `POST /api/listen` | `{ on }` | |
| `GET /api/events` | Server-Sent Events: doc, status, prompt, say, rpc, reload | |

Prompt objects: `{ id, text, status: pending|taken|done, context: { selection: [..], time, duration, view, key, camera: { position, target, fov } } }`.
