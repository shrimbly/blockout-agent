// Scenes menu: save the scene under a name, load an earlier save. Saves live in scenes/saved/ on the server,
// next to a thumbnail of the shot at the playhead. Loading is a normal change, so ⌘Z brings the old scene back.

import { h, button, panel, text, toast, icon } from './ui/kit.js';
import { store } from './store.js';
import { createDoc } from '/core/doc.js';

export function mountSaves(corner, { viewport }) {
  const newBtn = button({ icon: 'plus', label: 'New scene', kind: 'ghost', title: 'Start a new, empty scene (⌘Z brings this one back)', onClick: () => newScene() });
  const p = panel({ title: 'Scenes', collapsible: false, actions: [newBtn] });
  p.classList.add('saves-panel');
  p.hidden = true;

  const name = text({ placeholder: 'Name this version…', onEnter: () => save() });
  name.classList.add('saves-name');
  const saveBtn = button({ label: 'Save', kind: 'primary', title: 'Save a copy of the scene (⌘S)', onClick: () => save() });
  const list = h('div.saves-list');
  const hint = h('div.cc-label.saves-hint', {}, 'The scene also autosaves as you work. Loading replaces it; ⌘Z undoes a load.');
  p.body.append(h('div.cc-row', {}, name, saveBtn), list, hint);
  document.body.append(p);

  // the menu button names the scene version you are on ("street-v2"); it is set when you save or load
  const sceneName = h('span.scenes-name');
  const btn = h('button.cc-btn.cc-btn--ghost.scenes-btn', { type: 'button', title: 'Scenes: save / load versions (⌘S)', onClick: () => toggle() }, icon('layers'), sceneName, icon('chevronDown'));
  btn.setActive = (on) => btn.classList.toggle('is-active', !!on);
  corner.append(btn);
  const showName = () => { sceneName.textContent = store.doc?.meta?.name || 'untitled'; };
  store.on('doc', showName);

  function toggle(on = p.hidden) {
    p.hidden = !on;
    btn.setActive(on);
    if (on) { refresh(); setTimeout(() => name.focus(), 0); }
  }

  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  function render(saves) {
    if (!saves.length) { list.replaceChildren(h('div.cc-label.saves-empty', {}, 'No saves yet.')); return; }
    list.replaceChildren(...saves.map((s) => h('div.saves-item', { title: s.path },
      s.thumb ? h('img.saves-thumb', { src: s.thumb, alt: '' }) : h('div.saves-thumb'),
      h('div.saves-info', {}, h('div.saves-title', {}, s.name), h('div.cc-label', {}, `${ago(s.savedAt)} · ${s.objects} obj · ${s.keys} keys`)),
      button({ label: 'Load', kind: 'ghost', onClick: () => load(s.name) }),
    )));
  }

  async function refresh() {
    const r = await fetch('/api/saves').then((x) => x.json()).catch(() => null);
    if (r?.ok) render(r.saves);
  }

  async function save(overwrite = false) {
    const n = name.value.trim();
    let r = await store.post('/api/save', { name: n || undefined, overwrite });
    if (!r.ok && r.exists) {
      if (!confirm(`Replace the save "${r.name}"?`)) return;
      r = await store.post('/api/save', { name: r.name, overwrite: true });
    }
    if (!r.ok) { toast(r.error, { kind: 'error' }); return; }
    name.value = '';
    toast(`Saved "${r.name}"`);
    try { // thumbnail: the shot at the playhead
      const canvas = viewport.renderShot(store.state.time, 320, Math.round(320 * store.doc.meta.height / store.doc.meta.width));
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      await fetch(`/api/save/thumb?name=${encodeURIComponent(r.name)}`, { method: 'POST', body: blob });
    } catch {}
    refresh();
  }

  async function load(n) {
    const r = await store.post('/api/load', { name: n });
    if (!r.ok) { toast(r.error, { kind: 'error' }); return; }
    store.set({ selection: null, key: null, time: 0 });
    toast(`Loaded "${n}". ⌘Z to undo.`);
    toggle(false);
  }

  async function newScene() {
    const cur = store.doc?.meta?.name || 'untitled';
    const msg = cur === 'untitled'
      ? 'Start a new, empty scene? ⌘Z brings this one back.'
      : `Start a new, empty scene? "${cur}" stays in your saves (save again first to keep recent changes). ⌘Z brings it back.`;
    if (!confirm(msg)) return;
    try { await store.op({ op: 'load', doc: createDoc() }, 'new scene'); } catch { return; }
    store.set({ selection: null, key: null, time: 0, playing: false });
    toast('New scene. ⌘Z to undo.');
    toggle(false);
  }

  store.on('saves', ({ saves }) => { if (!p.hidden) render(saves); });
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); toggle(true); }
    if (e.key === 'Escape' && !p.hidden) toggle(false);
  }, true);

  return { toggle, save, load, newScene, btn };
}
