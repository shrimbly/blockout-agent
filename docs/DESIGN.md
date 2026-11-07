# Camera Canvas design system

The canvas is a 3D scene with as little chrome as possible. The base UI is: a chat sidebar (right,
collapsible), a selection chip (top left, only while something is selected), a help button (top right)
and the camera timeline (bottom). The controls dock sits to the left of the chat sidebar. Everything else is a **control**: a small panel the user asks
their agent to add. This document is the contract every control follows, so the UI stays coherent
no matter who (or which agent) builds it.

## Principles

1. **The scene is the interface.** Chrome floats over the viewport in small translucent panels and
   never covers the centre of the frame. Prefer gestures in the viewport (gizmos, dragging keys) over
   new panels.
2. **One control, one job.** A control edits one idea (fog, lens, an object list). If it needs a
   paragraph to explain, split it.
3. **Everything goes through ops.** Controls never mutate the scene or three.js objects directly.
   They call `ctx.op(...)`, so changes are saved, undoable, visible to the agent and replayable from
   the CLI. If an op does not exist yet, add it to `core/doc.js` first and a CLI flag in `bin/canvas.mjs`.
4. **Agent parity.** Anything a control can do, the agent can do from the CLI, and vice versa.
5. **Quiet by default.** Grey surfaces, one accent colour, no icons without a tooltip, no animation
   longer than 160 ms.

## Tokens (`app/ui/tokens.css`)

Never write raw colours, sizes or fonts in a control; use the variables.

| token | use |
|---|---|
| `--cc-surface` / `--cc-surface-solid` | panel background (translucent / solid) |
| `--cc-surface-sunk` | wells: tracks, inactive segmented background, default button |
| `--cc-line` / `--cc-line-strong` | 1 px borders and dividers / hover borders |
| `--cc-text` / `--cc-text-dim` / `--cc-text-faint` | values / labels / hints and placeholders |
| `--cc-accent` (+ `--cc-accent-soft`) | **only** for active, selected or "now" (playhead, selected key, active toggle). Never decoration. |
| `--cc-ok` `--cc-warn` `--cc-danger` | status dots and error text only |
| `--cc-h` (24 px) | height of every control |
| `--cc-gap` (6 px), `--cc-pad` (8 px) | spacing inside panels |
| `--cc-radius` (6 px), `--cc-radius-lg` (10 px) | controls / panels |
| `--cc-font`, `--cc-mono`, `--cc-size` (11 px), `--cc-size-sm` (10 px) | UI text / numbers / small caps headers |
| `--cc-ease`, `--cc-dur` | transitions |

Dark mode is automatic (`prefers-color-scheme`), so controls that only use tokens work in both.

## Components (`app/ui/kit.js`)

| component | when to use |
|---|---|
| `panel({ title })` | the container for one control. Title is 1–2 words, shown in small caps. Collapsible by clicking the header. |
| `row(label, ...controls)` | one labelled line. Label ≤ 12 characters, sentence case, no colon. |
| `button({ label?, icon?, kind })` | actions. `kind`: `default`, `ghost` (toolbars), `primary` (at most one per panel), `danger`. Icon-only buttons need `title`. |
| `segmented({ options })` | 2–4 mutually exclusive modes. More than 4 → `select`. |
| `select({ options })` | pick one of many named values (eases, presets). |
| `number({ value, step, min, max, precision })` | numeric values. Drag to scrub (Shift ×10, Alt ×0.1), click to type. Show units in the row label (`Lens mm`). |
| `slider({ min, max, step })` | bounded values where the range matters (opacity, fog). Includes a number readout. |
| `toggle({ value })` | on/off settings that apply immediately. |
| `color({ value })` | `#rrggbb` colours. |
| `text({ value })` | short names. |
| `chip(text, dot?)`, `kbd(key)`, `divider()`, `spacer()` | status, shortcuts, separators. |
| `toast(message)` | transient confirmation or error. Not for anything the user must act on. |
| `icon(name)` | 16 px stroke icons from `app/ui/icons.js`. New icons: 1.5 stroke, round caps, `currentColor`. |

Value controls take `onChange(value)` (commit: send the op here) and optionally `onInput(value)`
(live preview while dragging: do not send ops on every input event). They expose `.set(v)` and
`.get()` so a control can update itself when the doc changes.

## Writing a control

```js
// app/controls/lens.js
import { row, number, segmented } from '../ui/kit.js';

export default {
  id: 'lens',
  title: 'Lens',
  mount(body, ctx) {
    const keyId = () => ctx.state.key;
    const mm = number({ value: 35, step: 1, min: 8, max: 300, precision: 0,
      onChange: (v) => keyId() && ctx.op({ op: 'key.update', id: keyId(), fov: 360 / Math.PI * Math.atan(12 / v) }) });
    body.append(row('Key lens mm', mm));
    const sync = () => { const k = ctx.doc().timeline.keys.find((k) => k.id === keyId()); if (k) mm.set(Math.round(12 / Math.tan(k.fov * Math.PI / 360))); };
    const off1 = ctx.on('doc', sync), off2 = ctx.on('state', sync);
    return () => { off1(); off2(); };
  },
};
```

Then add it to `app/controls/index.js`:

```js
import lens from './lens.js';
export default [lens];
```

Controls stack in the right-hand dock in registration order. Open tabs reload automatically when
any file in `app/` changes.

### The `ctx` a control receives

| | |
|---|---|
| `ctx.doc()` | the current scene document (read only) |
| `ctx.op(ops)` | apply op(s); returns a promise of results; errors show as toasts |
| `ctx.on('doc' \| 'state', fn)` | subscribe; returns an unsubscribe function |
| `ctx.state` | runtime state: `time`, `playing`, `view`, `selection`, `key`, `gizmo` |
| `ctx.set(patch)` | change runtime state (e.g. `ctx.set({ time: 2, view: 'shot' })`) |
| `ctx.selected()` | the selected object, or `null` |
| `ctx.value(key, fallback)` / `ctx.setValue(key, value)` | persistent per-control values, stored in `doc.controls` |
| `ctx.viewport` | the three.js `Viewport`, for read-only use (raycasts, camera pose) |

## Checklist before shipping a control

- [ ] Uses only kit components and tokens; no inline colours or pixel sizes other than widths.
- [ ] Every change goes through `ctx.op`; the CLI can do the same thing.
- [ ] Updates itself on `doc` changes (the agent may change the same values).
- [ ] Every icon-only button has a `title`.
- [ ] Keyboard input in fields does not trigger scene shortcuts (kit fields already stop propagation).
- [ ] Panel fits in the 248 px dock.
- [ ] `npm test` passes and the page loads without console errors.

## Viewport conventions

- Selection: accent edges on the selected object plus the gizmo. Nothing else glows.
- Helpers (camera frustum, path, key markers) are only drawn in **Free** view and are never rendered
  into snapshots or exports. Anything new you draw in the viewport for editing goes in
  `viewport.helpers` for the same reason.
- Shot view letterboxes to the export aspect ratio and keeps clear of the top and bottom UI.
