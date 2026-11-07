// Chat sidebar. Prompts go to the bridge server's inbox; the user's agent (Claude Code or Codex)
// picks them up with `canvas wait` (or the Claude Code Stop hook) and answers with `canvas say`.
// The panel docks on the right; it collapses to a button in the top-right corner.

import { h, icon, button } from './ui/kit.js';
import { describe } from '/core/doc.js';
import { store } from './store.js';

const OPEN_KEY = 'cc-chat-open';

export function mountPrompt(root, { viewport, corner }) {
  // ---------- header ----------
  const dot = h('span.cc-dot');
  const statusText = h('span.chat-status-text');
  const collapseBtn = button({ icon: 'panelRight', kind: 'ghost', title: 'Hide chat', onClick: () => setOpen(false) });
  const head = h('div.chat-head', {}, dot, statusText, h('span.cc-spacer'), collapseBtn);

  // ---------- thread ----------
  const thread = h('div.chat-thread', { role: 'log', 'aria-live': 'polite' });
  const empty = h('div.chat-empty', {},
    h('div.chat-empty-title', {}, 'Talk to your agent'),
    h('p', {}, 'Messages go to your Claude Code or Codex session with your selection, the playhead and the camera attached.'),
    h('p', {}, 'In your agent, say ', h('b', {}, '“listen to the canvas”'), ' so it picks them up.'),
  );

  // ---------- composer ----------
  const ctxSel = h('span.cc-chip.chat-ctx');
  const ctxTime = h('span.cc-chip.chat-ctx.cc-mono');
  const input = h('textarea.chat-input', { rows: 1, placeholder: 'Ask your agent to change the scene…', spellcheck: false });
  const send = h('button.cc-btn.cc-btn--primary.cc-btn--icon.chat-send', { type: 'button', title: 'Send (Enter) · new line (Shift+Enter)' }, icon('send'));
  const composer = h('div.chat-composer', {}, h('div.chat-ctx-row', {}, ctxSel, ctxTime), h('div.chat-input-row', {}, input, send));

  const panel = h('section.cc-panel.chat', { 'aria-label': 'Chat with your agent' }, head, thread, composer);
  root.append(panel);

  // collapsed state: a button in the top-right corner
  const unread = h('span.chat-unread');
  const openBtn = button({ icon: 'chat', kind: 'ghost', title: 'Show chat (/)', onClick: () => { setOpen(true); input.focus(); } });
  openBtn.classList.add('chat-open-btn');
  openBtn.append(unread);
  corner.prepend(openBtn);

  let open = true;
  try { open = localStorage.getItem(OPEN_KEY) !== '0'; } catch {}
  function setOpen(v) {
    open = v;
    try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch {}
    panel.hidden = !v;
    openBtn.hidden = v;
    document.body.classList.toggle('chat-open', v);
    if (v) { unread.hidden = true; scrollToEnd(); }
    store.set({ chat: v });
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

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    const res = await store.post('/api/prompt', { text, context: context() });
    if (!res.ok) { input.value = text; autosize(); }
  }
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; }
  input.addEventListener('input', autosize);
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
    if (p.status === 'done') return h('span.chat-meta.is-done', {}, icon('check'), 'done');
    if (p.status === 'pending') return h('span.chat-meta', {}, 'queued');
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
    el.replaceChildren(
      h('div.chat-bubble', {}, p.text),
      h('div.chat-foot', {}, h('span.chat-ctxline', {}, ctxLine(p.context)), statusEl(p)),
    );
    empty.remove();
    if (stick) scrollToEnd();
  }

  function renderMessage(m) {
    const stick = nearEnd();
    const cls = ['chat-msg', 'chat-msg--agent'];
    if (m.kind === 'error') cls.push('is-error');
    if (m.kind === 'working') cls.push('is-working');
    thread.append(h(`div.${cls.join('.')}`, {},
      h('div.chat-who', {}, h('span', {}, m.from === 'system' ? 'Canvas' : 'Agent'), h('span.chat-time', {}, time(m.at))),
      h('div.chat-text', {}, m.text)));
    empty.remove();
    if (!open) unread.hidden = false;
    if (stick) scrollToEnd();
  }

  store.on('prompt', (p) => { prompts.set(p.id, p); renderPrompt(p); });
  store.on('say', (m) => renderMessage(m));
  store.on('history', ({ prompts: ps = [], messages: ms = [] }) => {
    thread.replaceChildren(); items.clear();
    for (const p of ps) prompts.set(p.id, p);
    const all = [...ps.map((p) => ({ at: p.at, p })), ...ms.map((m) => ({ at: m.at, m }))].sort((a, b) => a.at - b.at).slice(-60);
    if (!all.length) thread.append(empty);
    for (const x of all) x.p ? renderPrompt(x.p) : renderMessage(x.m);
    unread.hidden = true;
    scrollToEnd();
  });

  function refresh() {
    const { agent, working, listen } = store.state;
    dot.className = `cc-dot ${agent ? 'cc-dot--ok' : working ? 'cc-dot--accent' : ''}`;
    statusText.textContent = agent ? 'Agent listening' : working ? 'Agent working' : 'Agent not listening';
    head.title = agent
      ? 'Your agent is waiting for prompts from this canvas.'
      : working ? 'Your agent is working on a prompt. New prompts queue until it is done.'
      : `Prompts queue until your agent listens. Ask it to "listen to the canvas"${listen ? '' : ' (runs canvas wait)'}.`;
    const sel = store.state.selection;
    ctxSel.hidden = !sel;
    ctxSel.textContent = sel ? `@${sel}` : '';
    ctxSel.title = 'The selected object is sent with your message';
    ctxTime.textContent = `${store.state.time.toFixed(1)}s · ${store.state.view}`;
    ctxTime.title = 'The playhead, view and camera are sent with your message';
  }
  store.on('state', (c) => {
    if (c.agent || c.working || c.listen || c.selection || c.time || c.view) refresh();
    if (c.agent || c.working) for (const p of prompts.values()) if (p.status === 'taken') renderPrompt(p);
  });
  thread.append(empty);
  refresh();
  setOpen(open);

  return { focus: () => { if (!open) setOpen(true); input.focus(); }, input, setOpen };
}
