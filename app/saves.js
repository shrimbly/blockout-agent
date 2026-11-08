// Scenes menu: drops from the scene name in the top-right menu. New scene, Save as (⌘S), then the saved
// versions; click one to load it. Saves live in scenes/saved/ on the server, each with a thumbnail of the shot.
// Every change autosaves into the version you are on (the server does that), and its thumbnail follows.
// New and Load are normal changes, so ⌘Z brings the previous scene back.

import { h, text, toast, icon } from './ui/kit.js';
import { store } from './store.js';
import { createDoc } from '/core/doc.js';

export function mountSaves(corner, { viewport }) {
  // ---------- menu button: names the version you are on ----------
  const sceneName = h('span.scenes-name');
  const chevron = h('span.scenes-chev', {}, icon('chevronDown'));
  const btn = h('button.cc-btn.cc-btn--ghost.scenes-btn', { type: 'button', title: 'Scenes (⌘S to save a version)', 'aria-haspopup': 'menu', onClick: () => toggle() }, icon('layers'), sceneName, chevron);
  btn.setActive = (on) => btn.classList.toggle('is-active', !!on);
  corner.append(btn);
  const current = () => store.doc?.meta?.name || 'untitled';
  store.on('doc', () => { sceneName.textContent = current(); if (!menu.hidden) render(last); });

  // ---------- menu ----------
  const item = (ic, label, onClick, extra) => h('button.scenes-item.scenes-action', { type: 'button', role: 'menuitem', onClick }, icon(ic), h('span.scenes-label', {}, label), extra);
  const newItem = item('plus', 'New scene', () => newScene());
  const saveItem = item('save', 'Save as…', () => startSave(), h('span.scenes-kbd', {}, '⌘S'));
  const name = text({ placeholder: 'Name of the copy', onEnter: () => save() });
  name.classList.add('scenes-field');
  name.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); endSave(); } });
  const saveRow = h('div.scenes-saverow', { hidden: true }, icon('save'), name);
  const list = h('div.scenes-list', { role: 'group', 'aria-label': 'Saved versions' });
  const menu = h('div.cc-panel.scenes-menu', { role: 'menu', hidden: true }, newItem, saveItem, saveRow, h('div.scenes-sep'), list);
  document.body.append(menu);

  let last = [];
  function toggle(on = menu.hidden) {
    menu.hidden = !on;
    btn.setActive(on);
    chevron.replaceChildren(icon(on ? 'chevronUp' : 'chevronDown'));
    if (on) refresh(); else endSave();
  }
  function startSave() {
    saveItem.hidden = true; saveRow.hidden = false;
    name.value = current() === 'untitled' ? '' : nextName(current());
    setTimeout(() => { name.focus(); name.select(); }, 0);
  }
  function endSave() { saveItem.hidden = false; saveRow.hidden = true; name.blur(); }
  // "street-v2" → "street-v3"; anything else → "<name>-v2"
  function nextName(n) {
    const m = n.match(/^(.*-v)(\d+)$/);
    const taken = new Set(last.map((s) => s.name));
    let next = m ? `${m[1]}${+m[2] + 1}` : `${n}-v2`;
    while (taken.has(next)) next = next.replace(/(\d+)$/, (d) => String(+d + 1));
    return next;
  }

  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  function render(saves) {
    last = saves;
    if (!saves.length) { list.replaceChildren(h('div.scenes-empty', {}, 'No saved versions yet')); return; }
    const cur = current();
    list.replaceChildren(...saves.map((s) => h('button.scenes-item', {
      type: 'button', role: 'menuitem', title: `${s.name} · ${new Date(s.savedAt).toLocaleString()}\n${s.objects} objects · ${s.keys} keys · click to load (⌘Z undoes it)`,
      onClick: () => load(s.name),
    },
    s.thumb ? h('img.scenes-thumb', { src: s.thumb, alt: '' }) : h('span.scenes-thumb'),
    h('span.scenes-label', { class: s.name === cur ? 'is-current' : '' }, s.name),
    s.name === cur ? h('span.scenes-tick', {}, icon('check')) : h('span.scenes-age', {}, ago(s.savedAt)),
    )));
  }

  refresh(); // know the saved versions from the start (for autosave thumbnails)
  async function refresh() {
    const r = await fetch('/api/saves').then((x) => x.json()).catch(() => null);
    if (r?.ok) render(r.saves);
  }

  async function thumb(n) { // the shot at the playhead
    try {
      const canvas = viewport.renderShot(store.state.time, 320, Math.round(320 * store.doc.meta.height / store.doc.meta.width));
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      await fetch(`/api/save/thumb?name=${encodeURIComponent(n)}`, { method: 'POST', body: blob });
    } catch {}
  }

  async function save() {
    const n = name.value.trim();
    let r = await store.post('/api/save', { name: n || undefined });
    if (!r.ok && r.exists) {
      if (!confirm(`Replace the saved version "${r.name}"?`)) return;
      r = await store.post('/api/save', { name: r.name, overwrite: true });
    }
    if (!r.ok) { toast(r.error, { kind: 'error' }); return; }
    toast(`Saved as "${r.name}". Changes now autosave there.`);
    toggle(false);
    thumb(r.name);
  }

  async function load(n) {
    toggle(false);
    const r = await store.post('/api/load', { name: n });
    if (!r.ok) { toast(r.error, { kind: 'error' }); return; }
    store.set({ selection: null, key: null, time: 0 });
    toast(`Loaded "${n}". ⌘Z to undo.`);
  }

  // a new scene is saved straight away as scene-N, so it autosaves like every other version
  async function newScene() {
    toggle(false);
    const r0 = await fetch('/api/saves').then((x) => x.json()).catch(() => null);
    const taken = new Set((r0?.saves || last).map((x) => x.name));
    let i = 1; while (taken.has(`scene-${i}`)) i++;
    const doc = createDoc();
    doc.meta.name = `scene-${i}`;
    try { await store.op({ op: 'load', doc }, 'new scene'); } catch { return; }
    store.set({ selection: null, key: null, time: 0, playing: false });
    const r = await store.post('/api/save', { name: doc.meta.name });
    if (r.ok) setTimeout(() => thumb(r.name), 300);
    toast(`New scene "${doc.meta.name}". ⌘Z brings the last one back.`);
  }

  // keep the current version's thumbnail fresh: re-render it a few seconds after the last change
  let thumbTimer = null;
  store.on('doc', () => {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => { const n = current(); if (last.some((x) => x.name === n)) thumb(n); }, 4000);
  });

  store.on('saves', ({ saves }) => { if (!menu.hidden) render(saves); else last = saves; });
  addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) toggle(false); }, true);
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); toggle(true); startSave(); }
    else if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); toggle(false); }
  }, true);

  return { toggle, save, load, newScene, btn };
}
