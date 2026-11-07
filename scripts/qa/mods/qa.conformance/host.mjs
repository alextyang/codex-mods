// qa.conformance: its own kind of each concept the app's shared surfaces show (docs/design/graph-integrity.md G9.1), with its own data.
// Its instances are what the round-trip ledger (docs/coverage/roundtrip.json, GI9) checks: each shown by every shared surface with
// its variation, and opened to its own view (renderer.mjs: drawn with every part the framework lends, fed with this mod's data). Single
// file, built-ins only, no model traffic.
//
// What it provides: an agent (ConfAgent) with two models, a chat of its own (ConfThread) with a first turn (its message, a command step,
// an edit step of its own kind with its diff, the answer), an automation (ConfAutomation), and on that chat one pending request of each
// kind (ConfCommandApproval, ConfEditApproval, ConfNetworkApproval, ConfToolApproval, ConfComputerUseApproval, ConfQuestion). A send
// answers with one message; an answer settles its request. Nothing is kept: every start puts the same instances again. The `conformance`
// service lists them and opens a fresh set of requests.

const sub = (id, parent, spec = {}) => ({ id, kind: 'subtype', parent, spec });
const str = { member: 'state', schema: { t: 'string' }, tier: 'core' };
const TYPES = [
  // its models are its own (the inverse of Model.agent); its edit step says the file and the diff
  sub('ConfAgent', 'Agent', { relations: { models: { member: 'relation', target: 'Model', cardinality: 'many', tier: 'core', owned: false, inverseOf: 'agent' } } }),
  sub('ConfThread', 'Thread'), sub('ConfAutomation', 'Automation'), sub('ConfEdit', 'Step', { state: { path: str, diff: str } }),
  sub('ConfCommandApproval', 'CommandApproval'), sub('ConfEditApproval', 'EditApproval'), sub('ConfNetworkApproval', 'NetworkApproval'),
  sub('ConfToolApproval', 'ToolApproval'), sub('ConfComputerUseApproval', 'ComputerUseApproval'), sub('ConfQuestion', 'Question'),
];
const text = (t) => ({ parts: [{ kind: 'text', text: String(t) }] });
const MODELS = [
  { id: 'conf-quick', name: 'Conformance quick', description: 'Answers at once', efforts: [{ id: 'low', label: 'Low' }], default: true },
  { id: 'conf-deep', name: 'Conformance deep', description: 'Takes its time', efforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], default: false },
];

async function host(ctx) {
  const me = ctx.mod.id;
  const ref = (type, id) => ({ type, provider: me, id });
  const AGENT = ref('ConfAgent', 'agent');
  const THREAD = ref('ConfThread', 'chat');
  const AUTOMATION = ref('ConfAutomation', 'daily');
  const APP = ref('ExternalApp', 'notes');
  let seq = 0;
  let provider = null;
  const now = () => Date.now();

  const turnOf = async (thread, words, startedBy = { kind: 'user' }) => {
    const t = ref('Turn', `turn-${++seq}`);
    const at = now();
    await provider.put(t, { state: { status: 'completed', startedAt: at, endedAt: at, startedBy }, links: { thread } });
    await provider.put(ref('UserMessage', `in-${seq}`), { state: { content: text(words), createdAt: at, steering: false }, links: { turn: t } });
    // its steps: a command it ran and a file it edited (graph-integrity G2.3: drawn by the lent StepRow, DiffView and FileChip)
    await provider.put(ref('CommandRun', `cmd-step-${seq}`), { state: { status: 'done', title: 'Ran echo conformance', startedAt: at, endedAt: at, command: 'echo conformance', directory: '/tmp',
      output: 'conformance\n', exitCode: 0 }, links: { turn: t } });
    await provider.put(ref('ConfEdit', `edit-step-${seq}`), { state: { status: 'done', title: 'Edited conformance.txt', startedAt: at, endedAt: at, path: '/tmp/conformance.txt',
      diff: '--- a/conformance.txt\n+++ b/conformance.txt\n@@ -1 +1,2 @@\n-before\n+after\n+and more\n' }, links: { turn: t } });
    const answer = ref('AgentMessage', `out-${seq}`);
    await provider.put(answer, { state: { content: text(`Conformance answer to: ${words}`), createdAt: at, phase: 'final', streaming: false }, links: { turn: t } });
    await provider.update(t, { links: { answer } });
    await provider.update(thread, { state: { updatedAt: at, preview: `Conformance answer to: ${words}` } });
    return t;
  };

  // who answered is the caller the graph names (the user, or a mod with its id)
  const settle = async (r, status, outcome, caller) => {
    const at = now();
    const answeredBy = { kind: ['user', 'mod', 'app'].includes(caller?.kind) ? caller.kind : 'unknown', ...(caller?.kind === 'mod' ? { id: String(caller.id) } : {}), at };
    await provider.update(r, { state: { status, answeredAt: at, answeredBy, outcome } });
    await provider.emit(r, 'answered', { outcome, answeredBy });
    return null;
  };
  // its approvals' options: approving once or for the chat, or declining (graph-integrity G1.6)
  const OPTIONS = [{ id: 'once', label: 'Allow once', kind: 'approve', scope: 'once' }, { id: 'chat', label: 'Allow for this chat', kind: 'approve', scope: 'thread' },
    { id: 'no', label: "Don't allow", kind: 'deny' }];
  const approval = { answer: { effect: 'local', handler: async ({ ref: r, args: [id], caller }) => {
    const o = OPTIONS.find((x) => x.id === id);
    if (!o) return { status: 'refused', reason: 'unsupported', message: `no option ${id}` };
    return settle(r, o.kind === 'approve' ? 'answered' : 'declined', { decision: o.kind === 'approve' ? 'approved' : 'denied', ...(o.scope ? { scope: o.scope } : {}), option: o.id }, caller);
  } } };

  async function openRequests(turn) {
    const base = () => ({ status: 'pending', from: 'agent', askedAt: now(), options: OPTIONS });
    const links = { thread: THREAD, turn };
    const n = ++seq;
    await provider.put(ref('ConfCommandApproval', `cmd-${n}`), { state: { ...base(), command: 'echo conformance', directory: '/tmp' }, links });
    await provider.put(ref('ConfEditApproval', `edit-${n}`), { state: { ...base(), files: [{ path: '/tmp/conformance.txt', change: 'add', added: 1, removed: 0 }] }, links });
    await provider.put(ref('ConfNetworkApproval', `net-${n}`), { state: { ...base(), host: 'example.com' }, links });
    await provider.put(ref('ConfToolApproval', `tool-${n}`), { state: { ...base(), input: text('{"query": "conformance"}') }, links });
    await provider.put(ref('ConfComputerUseApproval', `cua-${n}`), { state: { ...base(), action: 'click Save' }, links: { ...links, app: APP } });
    const { options: _o, ...q } = base();
    await provider.put(ref('ConfQuestion', `q-${n}`), { state: { ...q, blocking: true, prompts: [
      { id: 'which', header: 'Pick', prompt: text('Which one?'), choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], other: true, secret: false },
      { id: 'token', prompt: text('Your token?'), choices: [], other: true, secret: true },
    ] }, links });
    await provider.update(THREAD, { state: { status: 'waitingForYou', waitingOn: 'approval' } });
  }

  await ctx.graph.registerTypes(TYPES);
  provider = ctx.graph.provide({
    types: {
      ConfAgent: { operations: { newThread: { effect: 'local', handler: async () => THREAD } } },
      ConfThread: {
        operations: {
          send: { effect: 'external', handler: async ({ ref: r, args: [content] }) => turnOf(r, (content?.parts ?? []).map((p) => p.text ?? '').join('')) },
          stop: { effect: 'local', handler: async () => null },
          rename: { effect: 'local', handler: async ({ ref: r, args: [title] }) => { await provider.update(r, { state: { title: String(title) } }); return null; } },
          archive: { effect: 'local', handler: async ({ ref: r }) => { await provider.update(r, { state: { archived: true } }); return null; } },
          restore: { effect: 'local', handler: async ({ ref: r }) => { await provider.update(r, { state: { archived: false } }); return null; } },
          markRead: { effect: 'local', handler: async ({ ref: r }) => { await provider.update(r, { state: { unread: false } }); return null; } },
        },
      },
      ConfAutomation: {
        operations: {
          runNow: { effect: 'local', handler: async () => { await turnOf(THREAD, 'the daily check', { kind: 'app' }); return THREAD; } },
          enable: { effect: 'local', handler: async ({ ref: r }) => { await provider.update(r, { state: { enabled: true } }); return null; } },
          disable: { effect: 'local', handler: async ({ ref: r }) => { await provider.update(r, { state: { enabled: false } }); return null; } },
          edit: { effect: 'local', handler: async () => null },
          delete: { effect: 'local', handler: async ({ ref: r }) => { await provider.remove(r); return null; } },
        },
      },
      ConfCommandApproval: { operations: approval }, ConfEditApproval: { operations: approval }, ConfNetworkApproval: { operations: approval },
      ConfToolApproval: { operations: approval }, ConfComputerUseApproval: { operations: approval },
      ConfQuestion: { operations: {
        answer: { effect: 'local', handler: ({ ref: r, caller }) => settle(r, 'answered', { decision: 'answered' }, caller) },
        skip: { effect: 'local', handler: ({ ref: r, caller }) => settle(r, 'declined', { decision: 'cancelled' }, caller) },
      } },
      ExternalApp: { operations: { open: { effect: 'none', handler: async () => null }, setComputerUse: { effect: 'local', handler: async () => null } } },
      Turn: {}, UserMessage: {}, AgentMessage: {}, CommandRun: {}, ConfEdit: {}, Model: {},
    },
  });

  await provider.put(AGENT, { state: { name: 'Conformance', icon: 'checkmark', available: true } });
  await provider.setComplete('ConfAgent', true);
  for (const m of MODELS) await provider.put(ref('Model', m.id), { state: { name: m.name, description: m.description, efforts: m.efforts, default: m.default, available: true }, links: { agent: AGENT } });
  await provider.setComplete('Model', true);
  await provider.put(APP, { state: { name: 'Notes', icon: 'note', opens: ['file'], computerUse: 'ask' } });
  const at = now();
  await provider.put(THREAD, { state: { title: 'Conformance chat', status: 'idle', unread: true, archived: false, origin: 'user', createdAt: at, updatedAt: at }, links: { agent: AGENT, model: ref('Model', MODELS[0].id) } });
  await provider.put(AUTOMATION, { state: { name: 'Conformance daily', prompt: text('the daily check'), schedule: { kind: 'interval', every: 1440 }, enabled: true }, links: { agent: AGENT } });
  await provider.setComplete('ConfAutomation', true);
  const first = await turnOf(THREAD, 'hello');
  await openRequests(first);
  await provider.setComplete('ConfThread', true);

  ctx.services.provide('conformance', {
    refs: () => ({ agent: AGENT, thread: THREAD, automation: AUTOMATION }),
    async openRequests() { await openRequests(await turnOf(THREAD, 'more')); return { ok: true }; },
  });
}

export default { host };
