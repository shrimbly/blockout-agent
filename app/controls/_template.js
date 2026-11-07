// Template for a new control. Copy to app/controls/<id>.js, then register it in app/controls/index.js.
// Rules (docs/DESIGN.md): build only from app/ui/kit.js, read state from ctx, change the scene only
// through ctx.op(...) so the agent, undo and scene.json all see the change.

import { row, slider, toggle, color, select, button, segmented, number } from '../ui/kit.js';

export default {
  id: 'my-control',          // kebab-case, unique
  title: 'My control',       // panel title, 1–2 words
  // dock: 'right',          // only 'right' exists today

  /**
   * @param {HTMLElement} body  the panel body: append rows to it
   * @param {object} ctx
   *   ctx.doc()          current scene document (read only)
   *   ctx.op(ops)        apply op(s) on the server: { op: 'env', fog: 0.02 } etc. Returns results.
   *   ctx.on(evt, fn)    'doc' (scene changed) | 'state' (playhead, selection, view changed). Returns unsubscribe.
   *   ctx.state          runtime state: time, playing, view, selection, key
   *   ctx.set(patch)     change runtime state, e.g. ctx.set({ time: 2 })
   *   ctx.selected()     the selected object or null
   *   ctx.value(key, fallback) / ctx.setValue(key, value)  persistent per-control values (doc.controls)
   *   ctx.viewport       the Viewport (three.js scene, cameras) for read-only use
   * @returns {void | (() => void)} optional cleanup
   */
  mount(body, ctx) {
    const fog = slider({ min: 0, max: 0.1, step: 0.001, precision: 3, value: ctx.doc().env.fog, onChange: (v) => ctx.op({ op: 'env', fog: v }) });
    body.append(row('Fog', fog));
    return ctx.on('doc', (doc) => fog.set(doc.env.fog));
  },
};
