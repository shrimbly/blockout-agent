// In-scene prompt box. Prompts go to the bridge server's inbox; the user's agent (Claude Code or Codex)
// picks them up with `canvas wait` (or the Claude Code Stop hook) and answers with `canvas say`.

import { h, icon } from './ui/kit.js';
import { describe } from '/core/doc.js';
import { store } from './store.js';

export function mountPrompt(root, { viewport }) {
  const dot = h('span.cc-dot');
  const statusText = h('span');
  const status = h('span.cc-chip.prompt-status', { title: '' }, dot, statusText);
  const input = h('input.prompt-input', { type: 'text', placeholder: 'Ask your agent to change the scene…', spellcheck: false, autocomplete: 'off' });
  const send = h('button.cc-btn.cc-btn--primary.cc-btn--icon.prompt-send', { type: 'button', title: 'Send to your agent (Enter)' }, icon('send'));
  const ctxChip = h('span.cc-chip.prompt-ctx');
  const box = h('div.cc-panel.prompt-box', {}, status, ctxChip, input, send);
  const feed = h('div.prompt-feed');
  root.append(feed, box);

  const prompts = new Map(); // id -> prompt
  const items = new Map();   // id -> element
  let messages = [];

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
    const res = await store.post('/api/prompt', { text, context: context() });
    if (!res.ok) { input.value = text; return; }
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') input.blur();
  });
  send.addEventListener('click', submit);

  const STATUS = { pending: 'queued', taken: 'agent working', done: 'done' };
  function renderPrompt(p) {
    let el = items.get(p.id);
    if (!el) {
      el = h('div.feed-item.feed-item--user');
      items.set(p.id, el);
      feed.append(el);
    }
    el.replaceChildren(
      h('span.feed-text', {}, p.text),
      h('span.feed-meta', {}, p.status === 'taken' ? h('span.cc-spin') : null, STATUS[p.status] || p.status),
    );
    el.dataset.status = p.status;
    trim();
  }
  function renderMessage(m) {
    const el = h(`div.feed-item.feed-item--agent${m.kind === 'error' ? '.is-error' : ''}${m.kind === 'working' ? '.is-working' : ''}`, {}, h('span.feed-text', {}, m.text));
    feed.append(el); // chronological: replies follow the prompt they answer
    trim();
  }
  function trim() {
    const kids = [...feed.children];
    kids.forEach((el, i) => el.classList.toggle('is-old', i < kids.length - 4));
    while (feed.children.length > 24) feed.firstElementChild.remove();
  }

  store.on('prompt', (p) => { prompts.set(p.id, p); renderPrompt(p); });
  store.on('say', (m) => { messages.push(m); renderMessage(m); });
  store.on('history', ({ prompts: ps = [], messages: ms = [] }) => {
    feed.replaceChildren(); items.clear();
    const all = [...ps.map((p) => ({ at: p.at, p })), ...ms.map((m) => ({ at: m.at, m }))].sort((a, b) => a.at - b.at).slice(-8);
    for (const x of all) x.p ? renderPrompt(x.p) : renderMessage(x.m);
  });

  function refresh() {
    const { agent, working, listen } = store.state;
    dot.className = `cc-dot ${agent ? 'cc-dot--ok' : working ? 'cc-dot--accent' : ''}`;
    statusText.textContent = agent ? 'agent listening' : working ? 'agent working' : 'agent not listening';
    status.title = agent
      ? 'Your agent is waiting for prompts from this canvas.'
      : working ? 'Your agent is working on a prompt. New prompts queue until it is done.'
      : `Prompts queue until your agent listens. Ask it to "listen to the canvas" (runs canvas wait${listen ? '' : ', or canvas listen on in Claude Code'}).`;
    const sel = store.state.selection;
    ctxChip.textContent = sel ? `@${sel}` : `${store.state.time.toFixed(1)}s`;
    ctxChip.title = sel ? 'The selected object is sent with your prompt' : 'The playhead and camera are sent with your prompt';
  }
  store.on('state', (c) => { if (c.agent || c.working || c.listen || c.selection || c.time) refresh(); });
  refresh();

  return { focus: () => input.focus(), input };
}
