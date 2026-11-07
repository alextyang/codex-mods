// Host entry: runs in this mod's worker thread inside the Host. One file, no imports needed.
//
// An agent of its own: its kind (EchoAgent, a subtype of Agent) and its chats' kind (EchoThread, a subtype of Thread) are registered
// with the graph, and their instances are this mod's to provide (`ctx.graph.provide`). The framework lists its chats with every chat
// (the sidebar's group for the agent, search, the palette) and opens them to the view the renderer entry registers. A message sent in
// one of its chats (`Thread.send`: from its view's composer, or another mod's call) gets a turn: the message, then a reply that
// streams word by word. What it provides is kept in its storage, so its chats survive a restart. It is the shape of the framework's own
// test agent (tests/fixtures/mods/test-agent), cut to its core.

const AGENT = 'EchoAgent', THREAD = 'EchoThread';
const TYPES = [
  // its models are its own (the inverse of Model.agent)
  { id: AGENT, kind: 'subtype', parent: 'Agent', spec: { relations: { models: { member: 'relation', target: 'Model', cardinality: 'many', tier: 'core', owned: false, inverseOf: 'agent' } } } },
  { id: THREAD, kind: 'subtype', parent: 'Thread', spec: {} },
];
const STORE = 'chats';
const WORD_MS = 40;
const textOf = (content) => (Array.isArray(content?.parts) ? content.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const said = (text) => ({ parts: [{ kind: 'text', text }] });

async function host(ctx) {
  const me = ctx.mod.id;
  const ref = (type, id) => ({ type, provider: me, id });
  const agent = ref(AGENT, 'echo'), model = ref('Model', 'echo-1');
  const records = new Map();   // id -> {ref, state, links}: everything it provides, as kept in its storage
  const stopping = new Set();  // turns the user stopped
  let seq = 0;
  let provider = null;
  const nid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

  async function put(r, state, links = {}) { records.set(r.id, { ref: r, state, links }); await provider.put(r, { state, links }); }
  async function update(r, state, links) {
    const rec = records.get(r.id);
    if (rec) { rec.state = { ...rec.state, ...state }; if (links) rec.links = { ...rec.links, ...links }; }
    await provider.update(r, { state, ...(links ? { links } : {}) });
  }
  const save = () => ctx.storage.set(STORE, { seq, records: [...records.values()] });

  async function newThread(title = 'New chat') {
    const now = Date.now();
    const t = ref(THREAD, nid('chat'));
    await put(t, { title, status: 'idle', unread: false, archived: false, origin: 'user', createdAt: now, updatedAt: now }, { agent, model });
    await save();
    return t;
  }
  /** Who started a turn (Turn.startedBy): the user (and the mod whose surface they used), a mod, or the app. */
  const startedBy = (c) => (c?.kind === 'mod' ? { kind: 'mod', id: String(c.id) }
    : c?.kind === 'user' || c?.kind === 'framework' ? { kind: 'user', ...(typeof c.through === 'string' ? { through: c.through } : {}) } : { kind: 'app' });

  async function send({ ref: t, args: [content], caller }) {
    const text = textOf(content).trim();
    if (!text) return { status: 'refused', reason: 'invalid', message: 'a message is needed' };
    if (records.get(t.id)?.state.status === 'working') return { status: 'refused', reason: 'unavailable', message: 'the reply to the last message is still coming' };
    const now = Date.now();
    const turn = ref('Turn', nid('turn'));
    await put(turn, { status: 'running', startedAt: now, startedBy: startedBy(caller) }, { thread: t });
    await put(ref('UserMessage', nid('msg')), { content: said(text), createdAt: now, steering: false }, { turn });
    await update(t, { status: 'working', updatedAt: now, preview: text.slice(0, 80) });
    reply(t, turn, `You said: ${text}`).catch((e) => ctx.log.error('the reply failed', { message: String(e?.message ?? e) }));
    return turn;
  }
  async function reply(t, turn, text) {
    const answer = ref('AgentMessage', nid('reply'));
    await put(answer, { content: said(''), createdAt: Date.now(), phase: 'final', streaming: true }, { turn });
    await update(turn, {}, { answer });   // the turn names its answer (Turn.answer)
    const words = text.split(' ');
    for (let i = 1; i <= words.length && !stopping.has(turn.id); i++) {
      await new Promise((r) => setTimeout(r, WORD_MS));
      await update(answer, { content: said(words.slice(0, i).join(' ')) });
    }
    const now = Date.now();
    await update(answer, { streaming: false });
    await update(turn, { status: stopping.delete(turn.id) ? 'stopped' : 'completed', endedAt: now });
    await update(t, { status: 'idle', unread: true, updatedAt: now });
    await save();
  }
  const change = (patch) => async ({ ref: t }) => { await update(t, patch); await save(); return null; };

  await ctx.graph.registerTypes(TYPES);
  provider = ctx.graph.provide({
    types: {
      // a new chat, from the app's new-chat page (its Draft is the argument: what the user typed there goes with its first send)
      [AGENT]: { operations: { newThread: { effect: 'local', handler: () => newThread() } } },
      Model: {},
      [THREAD]: {
        operations: {
          send: { effect: 'external', handler: send },
          stop: { effect: 'local', handler: ({ ref: t }) => { for (const r of records.values()) if (r.ref.type === 'Turn' && r.links.thread?.id === t.id && r.state.status === 'running') stopping.add(r.ref.id); return null; } },
          rename: { effect: 'local', handler: ({ ref: t, args: [title] }) => change({ title: String(title) })({ ref: t }) },
          archive: { effect: 'local', handler: change({ archived: true }) },
          restore: { effect: 'local', handler: change({ archived: false }) },
          markRead: { effect: 'local', handler: change({ unread: false }) },
        },
      },
      Turn: {}, UserMessage: {}, AgentMessage: {},
    },
  });
  // the agent and its model: the same at every start
  await provider.put(agent, { state: { name: 'Echo agent', icon: 'sparkles', available: true }, links: {} });
  await provider.put(model, { state: { name: 'Echo', description: 'Says back what it is told', efforts: [], default: true, available: true }, links: { agent } });
  await provider.setComplete(AGENT, true);
  await provider.setComplete('Model', true);
  // its chats as it kept them; what a restart cut short ends there
  const kept = await ctx.storage.get(STORE);
  seq = Number.isSafeInteger(kept?.seq) ? kept.seq : 0;
  for (const r of Array.isArray(kept?.records) ? kept.records : []) {
    const state = { ...r.state };
    if (r.ref.type === 'Turn' && state.status === 'running') Object.assign(state, { status: 'failed', endedAt: Date.now(), error: 'The agent restarted' });
    if (r.ref.type === THREAD) state.status = 'idle';
    if (state.streaming === true) state.streaming = false;
    await put(ref(r.ref.type, r.ref.id), state, r.links ?? {});
  }
  if (![...records.values()].some((r) => r.ref.type === THREAD)) await newThread('Say something');
  await provider.setComplete(THREAD, true);
  return () => save();
}

export default { host };
