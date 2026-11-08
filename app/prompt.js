// Chat sidebar. Prompts go to the bridge server's inbox; the user's agent (Claude Code or Codex)
// picks them up with `canvas wait` (or the Claude Code Stop hook) and answers with `canvas say`.
// The panel docks on the right; the sidebar toggle in the top-right menu opens and closes it.

import { h, icon, button } from './ui/kit.js';
import { describe } from '/core/doc.js';
import { store } from './store.js';

const OPEN_KEY = 'cc-chat-open';

export function mountPrompt(root, { viewport, corner }) {
  // ---------- header: agent status, and the selection sent with your message ----------
  const dot = h('span.cc-dot');
  const statusText = h('span.chat-status-text');
  const selEl = h('span.cc-mono.chat-sel');
  const newBtn = button({ icon: 'compose', kind: 'ghost', title: 'New chat: clear this conversation', onClick: () => newChat() });
  newBtn.classList.add('chat-new');
  const head = h('div.chat-head', {}, dot, statusText, h('span.cc-spacer'), selEl, newBtn);

  // ---------- thread ----------
  const thread = h('div.chat-thread', { role: 'log', 'aria-live': 'polite' });
  const empty = h('div.chat-empty', {},
    h('div.chat-empty-title', {}, 'Talk to your agent'),
    h('p', {}, 'Messages go to your Claude Code or Codex session with your selection, the playhead and the camera attached.'),
    h('p', {}, 'In your agent, say ', h('b', {}, '“listen to the canvas”'), ' so it picks them up.'),
  );

  // ---------- composer ----------
  const input = h('textarea.chat-input', { rows: 1, placeholder: 'Ask your agent…', spellcheck: false, 'aria-label': 'Message your agent' });
  const send = h('button.cc-btn.cc-btn--primary.cc-btn--icon.chat-send', { type: 'button', title: 'Send (Enter) · new line (Shift+Enter)', disabled: true }, icon('send'));
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
  const attachBtn = h('button.cc-btn.cc-btn--ghost.cc-btn--icon.chat-attach', { type: 'button', title: 'Add images (or paste / drop them)' }, icon('image'));
  const tray = h('div.chat-tray', { hidden: true });
  const composer = h('div.chat-composer', {}, h('div.chat-input-row', {}, h('div.chat-input-col', {}, tray, input), attachBtn, send), fileInput);

  const panel = h('section.cc-panel.chat', { 'aria-label': 'Chat with your agent' }, head, thread, composer);
  root.append(panel);

  // one sidebar toggle in the top-right menu: outline when closed, filled when open.
  // While closed, its badge shows the agent: spinner = working, orange dot = new reply, hollow ring = not listening.
  const badge = h('span.chat-badge', { hidden: true });
  const toggleBtn = button({ icon: 'sidebar', kind: 'ghost', title: 'Show chat (/)', onClick: () => { setOpen(!open); if (open) input.focus(); } });
  toggleBtn.classList.add('chat-toggle');
  toggleBtn.append(badge);
  corner.append(toggleBtn);
  let unread = false;
  let peek = null;

  let open = true;
  try { open = localStorage.getItem(OPEN_KEY) !== '0'; } catch {}
  function setOpen(v) {
    open = v;
    try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch {}
    panel.hidden = !v;
    document.body.classList.toggle('chat-open', v);
    if (v) { unread = false; hidePeek(); scrollToEnd(); }
    toggleBtn.replaceChild(icon(v ? 'sidebarOn' : 'sidebar'), toggleBtn.firstElementChild);
    toggleBtn.classList.toggle('is-open', v);
    toggleBtn.title = v ? 'Hide chat' : 'Show chat (/)';
    toggleBtn.setAttribute('aria-expanded', v);
    store.set({ chat: v });
    refreshBadge();
  }

  // ---------- state ----------
  const prompts = new Map(); // id -> prompt
  const items = new Map();   // prompt id -> element

  function context() {
    const sel = store.state.selection && store.object(store.state.selection);
    return {
      selection: sel ? [describe(sel)] : [],
      time: +store.state.time.toFixed(3),
      duration: store.doc?.timeline.duration,
      view: store.state.view,
      key: store.state.key || undefined,
      camera: viewport.getPose(),
    };
  }

  // ---------- image attachments: uploaded as soon as they are added, sent with the next message ----------
  let attachments = []; // { id, preview, file?, pending, error? }
  const MAX_SIDE = 2000;
  async function toDataUrl(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale === 1 && /^image\/(png|jpeg|webp|gif)$/.test(blob.type)) {
        return await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
      }
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL(blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
    } finally { URL.revokeObjectURL(url); }
  }
  async function addImages(files) {
    for (const f of [...files].filter((x) => x.type?.startsWith('image/')).slice(0, 8 - attachments.length)) {
      const a = { id: Math.random().toString(36).slice(2), preview: URL.createObjectURL(f), pending: true };
      attachments.push(a); renderTray();
      try {
        const res = await store.post('/api/chat/image', { data: await toDataUrl(f), name: f.name || 'pasted' });
        if (!res.ok) throw new Error(res.error || 'upload failed');
        a.file = res.file;
      } catch (e) { a.error = true; console.warn('image upload failed', e); }
      a.pending = false; renderTray();
    }
  }
  function removeAttachment(id) {
    const a = attachments.find((x) => x.id === id);
    if (a) URL.revokeObjectURL(a.preview);
    attachments = attachments.filter((x) => x.id !== id); renderTray();
  }
  function renderTray() {
    tray.hidden = !attachments.length;
    tray.replaceChildren(...attachments.map((a) => h(`div.chat-thumb${a.pending ? '.is-pending' : ''}${a.error ? '.is-error' : ''}`, { title: a.error ? 'Upload failed' : '' },
      h('img', { src: a.preview, alt: '' }),
      a.pending ? h('span.cc-spin') : null,
      h('button.chat-thumb-x', { type: 'button', title: 'Remove', 'aria-label': 'Remove image', onClick: () => removeAttachment(a.id) }, icon('close')))));
    autosize();
  }
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addImages(fileInput.files); fileInput.value = ''; input.focus(); });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  panel.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); panel.classList.add('is-drop'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('is-drop'); });
  panel.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); panel.classList.remove('is-drop'); addImages(e.dataTransfer.files); input.focus(); });

  const readyImages = () => attachments.filter((a) => a.file);
  async function submit() {
    const text = input.value.trim();
    if (attachments.some((a) => a.pending)) return;
    const imgs = readyImages();
    if (!text && !imgs.length) return;
    const sent = attachments;
    input.value = ''; attachments = []; renderTray();
    const res = await store.post('/api/prompt', { text, images: imgs.map((a) => a.file), context: context() });
    if (!res.ok) { input.value = text; attachments = sent; renderTray(); return; }
    for (const a of sent) URL.revokeObjectURL(a.preview);
  }
  function autosize() {
    const MAX = 160; // about 8 lines, then it scrolls
    input.style.height = 'auto';
    const h_ = input.scrollHeight;
    input.style.height = `${Math.min(MAX, h_)}px`;
    input.classList.toggle('is-capped', h_ > MAX);
    send.disabled = attachments.some((a) => a.pending) || (!input.value.trim() && !readyImages().length);
  }
  input.addEventListener('input', autosize);
  new ResizeObserver(() => { if (input.value) autosize(); }).observe(composer); // rewrap when the panel width changes
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') input.blur();
  });
  send.addEventListener('click', submit);

  const nearEnd = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  const scrollToEnd = () => requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function ctxLine(c = {}) {
    const bits = [];
    if (c.selection?.length) bits.push(`@${c.selection[0].split(' ')[0]}`);
    if (c.time != null) bits.push(`${Number(c.time).toFixed(1)}s`);
    if (c.view) bits.push(c.view);
    return bits.join(' · ');
  }

  function statusEl(p) {
    const busy = p.status === 'taken' && (store.state.working || store.state.agent);
    if (p.status === 'done') return null; // done shows nothing
    if (p.status === 'pending') return h('span.chat-meta', {}, icon('clock'), 'queued');
    if (busy) return h('span.chat-meta.is-busy', {}, h('span.cc-spin'), 'working');
    return h('span.chat-meta.is-stale', {}, 'no reply yet');
  }

  function renderPrompt(p) {
    let el = items.get(p.id);
    const stick = nearEnd();
    if (!el) {
      el = h('div.chat-msg.chat-msg--user');
      items.set(p.id, el);
      thread.append(el);
    }
    el.dataset.status = p.status;
    const st = statusEl(p);
    el.title = [p.at ? time(p.at) : '', ctxLine(p.context)].filter(Boolean).join(' · ');
    const imgs = (p.images || []).map((im) => h('a.chat-img', { href: im.url, target: '_blank', rel: 'noopener', title: 'Open image' }, h('img', { src: im.url, alt: '', loading: 'lazy' })));
    el.replaceChildren(
      ...(imgs.length ? [h('div.chat-imgs', {}, ...imgs)] : []),
      ...(p.text ? [h('div.chat-bubble', {}, p.text)] : []),
      ...(st ? [h('div.chat-foot', {}, st)] : []));
    empty.remove();
    if (stick) scrollToEnd();
  }

  function hidePeek() { if (peek) { clearTimeout(peek.timer); peek.el.remove(); peek = null; } }
  function showPeek(m) {
    hidePeek();
    const el = h('div.cc-panel.chat-peek', { role: 'status', title: 'Open chat', onClick: () => { setOpen(true); input.focus(); } },
      h('div.chat-peek-who', {}, h('span.cc-dot.cc-dot--ok'), m.from === 'system' ? 'Canvas' : 'Agent replied'),
      h('div.chat-peek-text', {}, m.text));
    document.body.append(el);
    const timer = setTimeout(() => { if (!peek) return; el.classList.add('is-leaving'); peek.timer = setTimeout(hidePeek, 450); }, 4000);
    peek = { el, timer };
    el.addEventListener('pointerenter', () => { clearTimeout(peek?.timer); el.classList.remove('is-leaving'); });
    el.addEventListener('pointerleave', () => { if (peek) peek.timer = setTimeout(hidePeek, 1500); });
  }

  function renderMessage(m, live = true) {
    const stick = nearEnd();
    const cls = ['chat-msg', 'chat-msg--agent'];
    if (m.kind === 'error') cls.push('is-error');
    if (m.kind === 'working') cls.push('is-working');
    thread.append(h(`div.${cls.join('.')}`, { title: `${m.from === 'system' ? 'Canvas' : 'Agent'} · ${time(m.at)}` },
      h('div.chat-text', {}, m.text)));
    empty.remove();
    if (!open && live) {
      unread = true; refreshBadge();
      if (m.kind !== 'working') showPeek(m);
    }
    if (stick) scrollToEnd();
  }

  store.on('prompt', (p) => { prompts.set(p.id, p); renderPrompt(p); });
  store.on('say', (m) => renderMessage(m));
  store.on('history', ({ prompts: ps = [], messages: ms = [] }) => {
    thread.replaceChildren(); items.clear(); prompts.clear();
    for (const p of ps) prompts.set(p.id, p);
    const all = [...ps.map((p) => ({ at: p.at, p })), ...ms.map((m) => ({ at: m.at, m }))].sort((a, b) => a.at - b.at).slice(-60);
    if (!all.length) thread.append(empty);
    for (const x of all) x.p ? renderPrompt(x.p) : renderMessage(x.m, false);
    unread = false; refreshBadge();
    scrollToEnd();
  });

  async function newChat() {
    try {
      const r = await fetch('/api/chat/new', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      input.focus();
    } catch (e) { console.warn('new chat failed', e); }
  }

  function refresh() {
    const { agent, working, listen } = store.state;
    // three shapes, not just colours: solid dot, spinner, hollow ring
    dot.className = agent ? 'cc-dot cc-dot--ok' : working ? 'cc-spin' : 'chat-ring';
    statusText.textContent = agent ? 'Listening' : working ? 'Working…' : 'Not listening';
    refreshBadge();
    head.title = agent
      ? 'Your agent is waiting for prompts from this canvas.'
      : working ? 'Your agent is working on a prompt. New prompts queue until it is done.'
      : `Prompts queue until your agent listens. Ask it to "listen to the canvas"${listen ? '' : ' (runs canvas wait)'}.`;
    const sel = store.state.selection;
    selEl.textContent = sel ? `@${sel}` : '';
    selEl.title = 'The selected object, the playhead and the camera are sent with your message';
  }
  store.on('state', (c) => {
    if (c.agent || c.working || c.listen || c.selection || c.time || c.view) refresh();
    if (c.agent || c.working) for (const p of prompts.values()) if (p.status === 'taken') renderPrompt(p);
  });
  function refreshBadge() {
    const { agent, working } = store.state;
    const state = open ? null : working && !agent ? 'working' : unread ? 'unread' : !agent ? 'off' : null;
    badge.hidden = !state;
    badge.className = `chat-badge${state ? ` is-${state}` : ''}`;
    toggleBtn.classList.toggle('is-off', !open && !agent && !working);
    const why = { working: ' · agent working', unread: ' · new reply', off: ' · agent not listening' }[state] || '';
    toggleBtn.title = open ? 'Hide chat' : `Show chat (/)${why}`;
  }

  thread.append(empty);
  refresh();
  setOpen(open);

  return { focus: () => { if (!open) setOpen(true); input.focus(); }, input, setOpen, toggleBtn };
}
