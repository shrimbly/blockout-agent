// Client state: the scene document (owned by the server) plus local runtime state.
// The browser never edits the doc directly: it sends ops and re-renders what the server sends back.

const listeners = new Map();

export const store = {
  doc: null,
  rev: 0,
  clientId: Math.random().toString(36).slice(2, 10),
  state: {
    time: 0,
    playing: false,
    loop: true,
    view: 'free',          // 'free' (orbit the set) or 'shot' (look through the timeline camera)
    selection: null,       // object id
    key: null,             // selected camera key id
    gizmo: 'translate',    // translate | rotate | scale
    camDirty: false,       // shot camera moved by hand since the last key/seek
    agent: false,          // an agent is waiting for prompts
    working: false,        // an agent has taken a prompt and not replied yet
    listen: false,
    exporting: false,
    chat: true,            // chat sidebar open
  },

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) { listeners.get(event)?.forEach((fn) => fn(payload)); },

  /** Update runtime state and notify. */
  set(patch) {
    const changed = {};
    for (const [k, v] of Object.entries(patch)) if (this.state[k] !== v) { this.state[k] = v; changed[k] = true; }
    if (Object.keys(changed).length) this.emit('state', changed);
  },

  /** Send ops to the server. Resolves with results; shows errors as toasts via the 'error' event. */
  async op(ops, label) {
    const res = await fetch('/api/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops, label, source: 'ui' }) });
    const data = await res.json();
    if (!data.ok) { this.emit('error', data.error); throw new Error(data.error); }
    return data.results;
  },

  async post(route, body = {}) {
    const res = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  },

  object(id) { return this.doc?.objects.find((o) => o.id === id) || null; },
  keyById(id) { return this.doc?.timeline.keys.find((k) => k.id === id) || null; },
};

// Keep runtime state across the auto-reload that happens when the agent edits app code.
const SAVE = ['time', 'view', 'selection', 'key', 'gizmo', 'loop'];
try {
  const saved = JSON.parse(sessionStorage.getItem('cc-state') || '{}');
  for (const k of SAVE) if (k in saved) store.state[k] = saved[k];
} catch {}
addEventListener('beforeunload', () => {
  try { sessionStorage.setItem('cc-state', JSON.stringify(Object.fromEntries(SAVE.map((k) => [k, store.state[k]])))); } catch {}
});
