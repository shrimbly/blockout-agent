// Blockout UI kit: the only building blocks a control may use.
// Each factory returns a DOM element. Value controls also get .value (get/set) and fire onChange(value).
// Rules live in docs/DESIGN.md.

import { ICONS } from './icons.js';

/** Tiny hyperscript: h('div.cc-row', { onclick }, child, 'text') */
export function h(sel, props = {}, ...children) {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const icon = (name) => {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = ICONS[name] || '';
  return span.firstElementChild || span;
};

/**
 * A floating panel with a title. Put controls in panel.body.
 * panel({ title, collapsible: true, actions: [button(...)] })
 */
export function panel({ title, collapsible = true, collapsed = false, actions = [], id } = {}) {
  const body = h('div.cc-panel__body');
  const head = h('div.cc-panel__head', {}, title, h('span.cc-spacer'), ...actions);
  const el = h('section.cc-panel', { 'data-panel': id || title }, head, body);
  if (collapsed) el.classList.add('is-collapsed');
  if (collapsible) head.addEventListener('click', (e) => { if (e.target === head || e.target.parentNode === head && !e.target.closest('button')) el.classList.toggle('is-collapsed'); });
  el.body = body;
  return el;
}

/** A labelled line: row('Height', slider(...)) */
export const row = (label, ...controls) => h('div.cc-row', {}, label != null ? h('span.cc-label', { title: label }, label) : null, ...controls);
export const label = (text) => h('span.cc-label', {}, text);
export const divider = (horizontal = false) => h(`div.cc-divider${horizontal ? '.cc-divider--h' : ''}`);
export const spacer = () => h('span.cc-spacer');
export const chip = (text, dot) => h('span.cc-chip', {}, dot ? h(`span.cc-dot.cc-dot--${dot}`) : null, text);
export const kbd = (k) => h('span.cc-kbd', {}, k);

/** button({ label, icon, title, kind: 'default'|'ghost'|'primary'|'danger', onClick, shortcut }) */
export function button({ label: text, icon: ic, title, kind = 'default', onClick, active = false } = {}) {
  const cls = ['cc-btn'];
  if (kind !== 'default') cls.push(`cc-btn--${kind}`);
  if (ic && !text) cls.push('cc-btn--icon');
  const el = h(`button.${cls.join('.')}`, { type: 'button', title: title || text, onClick }, ic ? icon(ic) : null, text);
  el.setActive = (on) => el.classList.toggle('is-active', !!on);
  el.setActive(active);
  return el;
}

/** segmented({ options: [{ value, label }], value, onChange }) — 2 to 4 mutually exclusive choices. */
export function segmented({ options, value, onChange, title } = {}) {
  const el = h('div.cc-seg', { role: 'tablist', title });
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', title: o.title || o.label, onClick: () => { set(o.value); onChange?.(o.value); } }, o.icon ? icon(o.icon) : null, o.label);
    b.dataset.value = o.value;
    return b;
  });
  el.append(...btns);
  function set(v) { value = v; btns.forEach((b) => b.classList.toggle('is-active', b.dataset.value === String(v))); }
  set(value);
  Object.defineProperty(el, 'value', { get: () => value, set });
  return el;
}

/**
 * number({ value, step, min, max, precision, suffix, onChange, onInput })
 * Drag horizontally to scrub (Shift ×10, Alt ×0.1), or click to type.
 */
export function number({ value = 0, step = 0.1, min = -Infinity, max = Infinity, precision = 2, onChange, onInput, title, width } = {}) {
  const el = h('input.cc-field.cc-num', { type: 'text', inputmode: 'decimal', title, spellcheck: false });
  if (width) el.style.width = `${width}px`;
  const fmt = (v) => (Number.isFinite(v) ? (+v.toFixed(precision)).toString() : '');
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const set = (v) => { value = clamp(Number(v)); if (document.activeElement !== el) el.value = fmt(value); };
  set(value);
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (document.activeElement === el) return;
    e.preventDefault();
    drag = { x: e.clientX, v: value, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 2) drag.moved = true;
    if (!drag.moved) return;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    value = clamp(+(drag.v + Math.round(dx / 2) * step * mult).toFixed(6));
    el.value = fmt(value);
    onInput?.(value);
  });
  el.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) onChange?.(value);
    else { el.focus(); el.select(); }
  });
  const commit = () => {
    const v = Number(el.value);
    if (Number.isFinite(v)) { set(v); onChange?.(value); }
    el.value = fmt(value);
  };
  el.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep scene shortcuts out of text entry
    if (e.key === 'Enter') { commit(); el.blur(); }
    if (e.key === 'Escape') { el.value = fmt(value); el.blur(); }
  });
  el.addEventListener('blur', commit);
  el.get = () => value;
  el.set = set;
  return el;
}

/** affix(number(...), 'mm') — a field with its unit inside the border. Extra nodes go before the unit. */
export function affix(control, unit, ...extra) {
  return h('label.cc-affix', {}, control, unit ? h('span.cc-affix__unit', {}, unit) : null, ...extra);
}

/** select({ options: [{ value, label }] | ['a','b'], value, onChange }) */
export function select({ options, value, onChange, title } = {}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const el = h('select.cc-select', { title, onChange: () => onChange?.(el.value) }, opts.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value;
  el.addEventListener('keydown', (e) => e.stopPropagation());
  return el;
}

/** slider({ min, max, step, value, onInput, onChange }) — a range with a number readout. */
export function slider({ min = 0, max = 1, step = 0.01, value = 0, precision = 2, onInput, onChange } = {}) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = number({ value, step, min, max, precision, onChange: (v) => { range.value = v; onChange?.(v); }, onInput: (v) => { range.value = v; onInput?.(v); } });
  range.addEventListener('input', () => { num.set(Number(range.value)); onInput?.(Number(range.value)); });
  range.addEventListener('change', () => onChange?.(Number(range.value)));
  const el = h('div.cc-slider', {}, range, num);
  el.set = (v) => { range.value = v; num.set(v); };
  el.get = () => Number(range.value);
  return el;
}

/** toggle({ value, onChange }) — on/off switch. */
export function toggle({ value = false, onChange, title } = {}) {
  const el = h('button.cc-toggle', { type: 'button', role: 'switch', title });
  const set = (v) => { value = !!v; el.classList.toggle('is-on', value); el.setAttribute('aria-checked', value); };
  el.addEventListener('click', () => { set(!value); onChange?.(value); });
  set(value);
  el.set = set; el.get = () => value;
  return el;
}

/** color({ value: '#rrggbb', onInput, onChange }) */
export function color({ value = '#d8d4cc', onInput, onChange, title } = {}) {
  const el = h('input.cc-color', { type: 'color', value, title });
  el.addEventListener('input', () => onInput?.(el.value));
  el.addEventListener('change', () => onChange?.(el.value));
  el.set = (v) => { el.value = v; }; el.get = () => el.value;
  return el;
}

/** text({ value, placeholder, onChange }) — single-line text field. */
export function text({ value = '', placeholder = '', onChange, onEnter } = {}) {
  const el = h('input.cc-field', { type: 'text', value, placeholder, spellcheck: false });
  el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { onEnter?.(el.value); el.blur(); } });
  el.addEventListener('change', () => onChange?.(el.value));
  return el;
}

/** Transient message near the bottom of the screen. */
let stack;
export function toast(message, { kind = 'info', ms = 3200 } = {}) {
  stack ??= document.body.appendChild(h('div.cc-toast-stack'));
  const el = h(`div.cc-panel.cc-toast${kind === 'error' ? '.cc-toast--error' : ''}`, {}, message);
  stack.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}
