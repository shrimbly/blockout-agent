# Fanning out to helper agents

Use this when one request has several **independent, substantial** parts. You stay the orchestrator:
you plan, brief, integrate and review; helpers build their part in parallel.

## When it pays off

| Request | Do |
|---|---|
| A tweak, one object, a camera change, an ease, a reply | Yourself, directly. Spawning costs more than it saves. |
| One area with < ~15 objects | Yourself, as **one** `canvas ops` batch. |
| 2–4 separable areas, each ~10+ objects ("a street with a house, a garage and a parked car, plus two people") | Fan out: one helper per area. |
| Camera, timeline, eases, export, saving | Always yourself, after the builders finish (needs the whole scene). |

Cap it at 4 helpers. More parts than that: group them.

## 1. Plan (you, ~1 minute)

`canvas ls`, open any attached images, then decide the layout before anyone builds:

- **Ground plan**: where each area sits, as an x/z rectangle (`x -6..0, z -8..-2`), plus a max height.
  Leave 0.5–1 m between rectangles so parts don't collide; keep paths/doorways you'll need clear.
- **Prefix** per area: `house-`, `garage-`, `car-`, `cast-`. Lowercase, unique.
- **Shared rules**: scale (person 1.8 m, door 2.1 m × 0.9 m, storey 3 m, car 4.5 × 1.8 × 1.5 m),
  style (grey `#d8d4cc`, colour only the subject), level of detail (blockout: big shapes, no clutter).
- **Interfaces** between parts: e.g. "the house's front door faces +z at x=0 on z=-2, 1.2 m wide" so the
  path builder and the character know where it is.

Tell the user in one line: `canvas say --working --reply <id> "Building in 3 parts: house, garage, street"`.
Post another `--working` line when the helpers are done ("Joining the parts up…") and before the camera
work, then the final reply without `--working`.

## 2. Brief and spawn (one message, several helpers at once)

Claude Code: call the Agent tool once per area **in the same message** (so they run in parallel) with
`subagent_type: "canvas-builder"`. If that type isn't available (it loads when the session starts), use a
general-purpose agent and put the text of [builder.md](builder.md) above the brief. Use the same model as
yours (don't pick a cheaper one). Wait for all of them; don't run them in the background. Agents without
subagents (Codex): build the areas yourself, one `canvas ops` batch each.

Brief template (everything the helper needs; it has none of your context):

```
Build: <what, in a sentence or two, with sizes that matter>
Scope prefix: house-     (every id starts with this; apply with: canvas ops <file> --scope house-)
Bounds: x -6..0, z -8..-2, max height 7 m. Ground is y=0.
Interfaces: front door centred at x=-3 on the z=-2 face, opening 1.2 m wide × 2.1 m, facing +z.
Rules: person = 1.8 m. Grey #d8d4cc; roof #b9b4ab. Blockout detail only: walls, roof, door/window openings.
Reference: <image path, and what to take from it>   (optional)
Check from: --from 4,5,6 --target -3,1.5,-5 --lens 28
Report: ids, footprint used, anything I need to know.
```

## 3. Integrate and review (you)

1. `canvas ls` and read each helper's report.
2. One overview check: `canvas snapshot --from <high 3/4 view> --target <scene centre> --lens 24`, plus
   `canvas storyboard` if there's a camera move. Look for overlaps between areas, mismatched scale, gaps
   at the interfaces, things floating or buried.
3. Fix seams yourself (one batch). Re-spawn a helper only for a large redo.
4. Then do the camera, timeline and any moves that cross areas (e.g. a character walking into the house),
   check the storyboard, and send the final `canvas say --reply <id> "…"`.

Quality bar: the result must look as considered as if you had built it alone. If the overview shows the
parts don't fit together, fix it before replying, even if that takes another pass.
