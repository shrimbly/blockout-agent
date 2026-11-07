// Example control: environment settings. Register it in app/controls/index.js to use it.
import { row, slider, toggle, color, number } from '../../ui/kit.js';

export default {
  id: 'environment',
  title: 'Environment',
  mount(body, ctx) {
    const env = () => ctx.doc().env;
    const bg = color({ value: env().background, onChange: (v) => ctx.op({ op: 'env', background: v }) });
    const ground = toggle({ value: env().ground, onChange: (v) => ctx.op({ op: 'env', ground: v }) });
    const grid = toggle({ value: env().grid, onChange: (v) => ctx.op({ op: 'env', grid: v }) });
    const fog = slider({ min: 0, max: 0.1, step: 0.001, precision: 3, value: env().fog, onChange: (v) => ctx.op({ op: 'env', fog: v }) });
    const sunAngle = () => Math.round(Math.atan2(env().sun[0], env().sun[2]) * 180 / Math.PI);
    const sun = number({ value: sunAngle(), step: 1, min: -180, max: 180, precision: 0, onChange: (deg) => {
      const r = Math.hypot(env().sun[0], env().sun[2]) || 7, a = deg * Math.PI / 180;
      ctx.op({ op: 'env', sun: [+(Math.sin(a) * r).toFixed(2), env().sun[1], +(Math.cos(a) * r).toFixed(2)] });
    } });
    body.append(row('Background', bg), row('Ground', ground), row('Grid', grid), row('Fog', fog), row('Sun °', sun));
    return ctx.on('doc', (d) => { bg.set(d.env.background); ground.set(d.env.ground); grid.set(d.env.grid); fog.set(d.env.fog); sun.set(sunAngle()); });
  },
};
