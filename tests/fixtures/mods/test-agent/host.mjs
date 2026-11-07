// qa.test-agent — host entry (graph-integrity G2.2; docs/design/presentations.md V14). Single-file ESM, built-ins only. No model traffic.
//
// A scripted agent that serves its own threads through ctx.graph: the framework lists them with every chat (the sidebar's group for its
// agent, the mods' sections) and opens them to the view its renderer entry registers (renderer.mjs). It is an
// Agent of its own kind (TestAgent, a subtype of Agent) with a name ("Test agent"), an icon (a symbol name; the theme draws it) and two
// Models ("Test fast", the default, and "Test thorough"), which its threads link to. Each message gets a turn with a reasoning step, a
// command step and a streamed reply:
// - a message containing "approve" asks a CommandApproval before the command runs; one containing "ask" asks a Question; one
//   containing "slow" streams a long reply slowly (about 10 s), so Stop can be pressed while it runs; one containing "crash" makes
//   the mod's worker exit in the middle of the reply (a provider that fails mid-turn; only in a worker, never in the main thread);
// - a message containing "probe step" adds a step of the agent's own type (TestAgentProbe) after the command; one containing "edit" adds an
//   edit of a file with its diff (TestAgentEdit); one containing "notify" ends with the agent's notification about its chat (a click
//   opens the chat's view); a completed reply leaves the chat unread until its view is shown;
// - a message containing "fail this" makes the turn fail after its steps (as failNextTurn does);
// - Stop ends the turn and cancels an open request; rename, archive, restore and markRead change the thread; the agent's newThread
//   makes a thread (on one of its models: a Draft's target model when it is given one);
// - each thread has a thread-scope Setting of the agent's, "Tone" (brief or detailed: public-hooks.md §3.15, a picker in its composer),
//   which its replies follow (a detailed one says so); the agent's own "Tone" (its TestAgent.settings) is its default for new chats, and a
//   Draft given to newThread may hold a choice of it (its target settings), which the new chat takes;
// - an Automation of the agent's, "Test agent check-in" (hourly; public-hooks.md §3.15: listed in the app's Scheduled page): run now
//   starts a chat of origin `automation` that names it and sends its prompt; enable, disable, edit and delete are its own (it never runs
//   by itself: the schedule is what the page shows);
// - a message containing "link" gets two links in its reply (example.com and a localhost page), to open from the message;
// - an Account of its service's, "Test agent account" (public-hooks.md §3.15: a row the framework draws on the app's Account page), with
//   sign in and sign out change only whether it says it is signed in. Its usage is its own to show (graph-boundary.md B3): it has none here.
// Everything but open requests is kept in the mod's storage, so threads and their history survive a restart (a turn a restart cut
// short is shown as failed). The agent and its models are constants, put at every start. The `testAgent` service drives QA:
// createThread (optionally on one of the models), threads, failNextTurn, crash.

const AGENT = 'TestAgent';
const AGENT_ID = 'test-agent';
const THREAD = 'TestAgentThread';
const PROBE = 'TestAgentProbe';   // the agent's own kind of step (its view draws it as a tool step)
const EDIT = 'TestAgentEdit';     // its own edit step: a file's path and the diff it made (its view draws it, graph-integrity G2.3)
const TYPES = [
  // What this agent is made of is its own (docs/design/graph-boundary.md B3): its models (the inverse of Model.agent) and the settings it
  // defines for its chats, declared on its own subtype.
  { id: AGENT, kind: 'subtype', parent: 'Agent', spec: { relations: {
    models: { member: 'relation', target: 'Model', cardinality: 'many', tier: 'core', owned: false, inverseOf: 'agent' },
    settings: { member: 'relation', target: 'Setting', cardinality: 'many', tier: 'core', owned: false },
  } } },
  { id: THREAD, kind: 'subtype', parent: 'Thread', spec: {} },
  { id: PROBE, kind: 'subtype', parent: 'Step', spec: {} },
  { id: EDIT, kind: 'subtype', parent: 'Step', spec: { state: {
    path: { member: 'state', schema: { t: 'string' }, tier: 'core' },
    diff: { member: 'state', schema: { t: 'string' }, tier: 'core' },
  } } },
];
const ICON = 'flask';   // an Image is a symbol name here: the theme draws it, in its own colors
const MODELS = [
  { id: 'test-fast', name: 'Test fast', description: 'Answers at once and thinks little', efforts: [{ id: 'low', label: 'Low' }], default: true, contextWindow: 8000 },
  // what a model says of its size and cost (public-hooks.md §4 F13): a mod's model may say both
  { id: 'test-thorough', name: 'Test thorough', description: 'Takes its time and thinks it over', efforts: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], default: false, inputs: ['text', 'image'],
    contextWindow: 128000, pricing: { input: 1, output: 4, currency: 'USD' } },
];
const DEFAULT_MODEL = MODELS.find((m) => m.default).id;
const REQUESTS = new Set(['CommandApproval', 'Question']);
const STORE_KEY = 'agent/records';
const STEP_MS = 150;
const WORD_MS = 60;
const COMMAND = 'echo hello from the test agent';
const TONES = [{ id: 'brief', label: 'Brief' }, { id: 'detailed', label: 'Detailed' }];   // a choice's id is its value (as the graph's Settings give them)
const TONE_DEFAULT = 'brief';
// what its command approval offers (graph-integrity G1.6): its own options, as it labels them
const OPTIONS = [
  { id: 'once', label: 'Allow once', kind: 'approve', scope: 'once' }, { id: 'thread', label: 'Allow for this chat', kind: 'approve', scope: 'thread' },
  { id: 'deny', label: "Don't allow", kind: 'deny' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ parts: [{ kind: 'text', text: String(t) }] });
const plain = (c) => (Array.isArray(c?.parts) ? c.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('') : '');

async function host(ctx) {
  const me = ctx.mod.id;
  const ref = (type, id) => ({ type, provider: me, id });
  const records = new Map();    // instance id -> {ref, state, links}; ids carry a kind prefix, so they are unique across types
  const running = new Map();    // thread id -> {thread, turn, cancelled, fail}
  const waiting = new Map();    // request id -> {resolve, run}
  let seq = 0;
  let failNext = false;
  let saveTimer = null;
  let provider = null;
  const nid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

  // ---------------------------------------------------------------- records and storage
  async function put(r, state, links = {}) {
    records.set(r.id, { ref: r, state, links });
    persist();
    await provider.put(r, { state, links });
  }
  async function update(r, state, links) {
    const rec = records.get(r.id);
    if (rec) { rec.state = { ...rec.state, ...state }; if (links) rec.links = { ...rec.links, ...links }; }
    persist();
    await provider.update(r, { state, ...(links ? { links } : {}) });
  }
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save().catch((e) => ctx.log.warn('save failed', { message: String(e?.message ?? e) })); }, 300);
  }
  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    const kept = [...records.values()].filter((r) => !REQUESTS.has(r.ref.type));   // open requests end with the mod
    await ctx.storage.set(STORE_KEY, { version: 1, seq, records: kept });
  }
  async function load() {
    const saved = await ctx.storage.get(STORE_KEY);
    if (!saved || !Array.isArray(saved.records)) return;
    seq = Number.isSafeInteger(saved.seq) ? saved.seq : 0;
    for (const r of saved.records) {
      const state = { ...r.state };
      // What a restart cut short ends: the turn failed, its steps were cancelled, the reply stopped streaming, the thread is idle.
      if (r.ref.type === 'Turn' && state.status === 'running') Object.assign(state, { status: 'failed', endedAt: Date.now(), error: 'The test agent restarted during this turn' });
      if (['running', 'waitingForYou'].includes(state.status) && r.ref.type !== 'Turn' && r.ref.type !== THREAD) Object.assign(state, { status: 'cancelled', endedAt: Date.now() });
      if (state.streaming === true) state.streaming = false;
      if (r.ref.type === THREAD && state.status !== 'idle') state.status = 'idle';
      await put(ref(r.ref.type, r.ref.id), state, r.links);
    }
  }

  // ---------------------------------------------------------------- threads
  async function createThread(title, model = DEFAULT_MODEL, automation = null, tone = agentTone()) {
    if (!MODELS.some((m) => m.id === model)) throw new Error(`unknown model "${model}"`);
    const id = nid('thr');
    const now = Date.now();
    const r = ref(THREAD, id);
    await put(r, { title: String(title || 'Test agent thread'), status: 'idle', unread: false, archived: false, origin: automation ? 'automation' : 'user', createdAt: now, updatedAt: now },
      { agent: ref(AGENT, AGENT_ID), model: ref('Model', model), ...(automation ? { automation } : {}) });
    await putTone(r, tone);
    await save();
    return r;
  }
  // its thread-scope Setting (§3.15): the thread's tone, the agent's default until the user picks one in its composer
  const toneRef = (threadId) => ref('Setting', `tone@${threadId}`);
  async function putTone(t, value = agentTone()) {
    await put(toneRef(t.id), { title: 'Tone', key: 'tone', value, default: agentTone(), scope: 'thread', kind: 'choice', choices: TONES,
      overridden: value !== agentTone(), description: 'How much the test agent says' }, { section: ref('SettingsSection', 'test-agent'), definedBy: ref(AGENT, AGENT_ID), thread: t });
  }
  const toneOf = (threadId) => records.get(`tone@${threadId}`)?.state?.value ?? agentTone();
  // the agent's own Tone (TestAgent.settings): its default for a new chat, which a new chat's composer may choose otherwise for the chat it starts
  const AGENT_TONE = 'tone';
  const agentTone = () => (TONES.some((c) => c.id === records.get(AGENT_TONE)?.state?.value) ? records.get(AGENT_TONE).state.value : TONE_DEFAULT);
  async function putAgentTone(value = TONE_DEFAULT) {
    await put(ref('Setting', AGENT_TONE), { title: 'Tone', key: 'tone', value, default: TONE_DEFAULT, scope: 'app', scopes: ['app', 'thread'], kind: 'choice', choices: TONES,
      overridden: value !== TONE_DEFAULT, description: 'How much the test agent says in a new chat' }, { section: ref('SettingsSection', 'test-agent'), definedBy: ref(AGENT, AGENT_ID) });
  }
  const threadRef = (id) => records.get(id)?.ref ?? ref(THREAD, id);

  // ---------------------------------------------------------------- a turn
  /** Who started a turn (Turn.startedBy, graph-integrity G1.7): its send's caller, the app for its automation's runs. */
  const startedByOf = (caller) => (caller?.kind === 'mod' ? { kind: 'mod', id: String(caller.id) } : caller?.kind === 'user' || caller?.kind === 'framework' ? { kind: 'user' } : { kind: 'app' });
  async function send({ ref: t, args: [content], caller }) {
    if (running.has(t.id)) return { status: 'refused', reason: 'unavailable', message: 'a turn is already running in this thread' };
    const now = Date.now();
    const run = { thread: threadRef(t.id), turn: ref('Turn', nid('turn')), cancelled: false, fail: failNext };
    failNext = false;
    running.set(t.id, run);
    const said = plain(content);
    if (/fail this/i.test(said)) run.fail = true;   // a turn that fails, from the composer (presentations.md V13)
    await put(run.turn, { status: 'running', startedAt: now, startedBy: startedByOf(caller) }, { thread: run.thread });
    await put(ref('UserMessage', nid('msg')), { content, createdAt: now, steering: false }, { turn: run.turn });
    await update(run.thread, { status: 'working', updatedAt: now, preview: said.slice(0, 80) });
    play(t.id, run, said).catch((e) => ctx.log.error('the turn failed', { message: String(e?.message ?? e) }));
    return run.turn;
  }

  async function play(threadId, run, said) {
    const { turn } = run;
    const alive = () => !run.cancelled;
    // A reasoning step.
    const reasoning = ref('Reasoning', nid('step'));
    await put(reasoning, { status: 'running', title: 'Thinking', startedAt: Date.now(), thinking: text('') }, { turn });
    await sleep(STEP_MS);
    if (!alive()) return;
    await update(reasoning, { status: 'done', endedAt: Date.now(), thinking: text(`The user said: ${said}`) });
    // A command step, approved first when the message asks for it.
    const cmd = ref('CommandRun', nid('step'));
    const needsApproval = /approve/i.test(said);
    await put(cmd, { status: needsApproval ? 'waitingForYou' : 'running', title: `Run ${COMMAND}`, startedAt: Date.now(), command: COMMAND, directory: '/tmp', output: '' }, { turn });
    let approved = true;
    if (needsApproval) {
      const answer = await ask(run, ref('CommandApproval', nid('req')),
        { status: 'pending', from: 'agent', askedAt: Date.now(), reason: 'The test agent wants to run a command', options: OPTIONS, command: COMMAND, directory: '/tmp' },
        { thread: run.thread, turn, step: cmd });
      if (!alive()) return;
      approved = answer?.approved === true;
      if (approved) await update(cmd, { status: 'running' });
    }
    if (approved) {
      await sleep(STEP_MS);
      if (!alive()) return;
      await update(cmd, { status: 'done', output: 'hello from the test agent\n', exitCode: 0, duration: STEP_MS, endedAt: Date.now() });
    } else await update(cmd, { status: 'cancelled', endedAt: Date.now() });
    let reply = !needsApproval ? 'I ran a command. ' : approved ? 'You approved the command, and it ran. ' : 'You declined the command, so it did not run. ';
    if (toneOf(threadId) === 'detailed') reply += 'You asked for detail, so here it is in detail. ';
    if (/probe step/i.test(said)) {
      const probe = ref(PROBE, nid('step'));
      await put(probe, { status: 'running', title: 'Probing with the agent\'s own step', startedAt: Date.now() }, { turn });
      await sleep(STEP_MS);
      if (!alive()) return;
      await update(probe, { status: 'done', endedAt: Date.now() });
      reply += 'I ran a step of my own kind. ';
    }
    // An edit of its own kind when the message asks for one: a file and the diff it made.
    if (/\bedit\b/i.test(said)) {
      const edit = ref(EDIT, nid('step'));
      await put(edit, { status: 'done', title: 'Edited notes.txt', startedAt: Date.now(), endedAt: Date.now(), path: '/tmp/notes.txt',
        diff: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n-hello\n+hello from the test agent\n world' }, { turn });
      reply += 'I edited notes.txt. ';
    }
    // A question when the message asks for one.
    if (/\bask\b/i.test(said)) {
      const answer = await ask(run, ref('Question', nid('req')),
        { status: 'pending', from: 'agent', askedAt: Date.now(), blocking: true,
          prompts: [{ id: 'pick', prompt: text('Which do you pick?'), choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], other: true, secret: false }] },
        { thread: run.thread, turn });
      if (!alive()) return;
      const a = answer?.answers?.pick;
      reply += answer?.skipped ? 'You skipped my question. ' : `You answered: ${[...(a?.choices ?? []), a?.text].filter(Boolean).join(', ') || 'nothing'}. `;
    }
    // QA: a message containing "link" gets links in its reply (public-hooks.md §3.14, ui.links.route: a link the user opens from a message)
    if (/\blink\b/i.test(said)) reply += 'Here are [the example docs](https://example.com/docs) and [a local page](http://localhost:3999/). ';
    // QA: "seed N turns" makes a thread of N finished turns, to measure a long transcript (breadth.md D2, the G-jsx frame-time budget).
    const seed = /\bseed (\d+) turns\b/i.exec(said);
    if (seed) {
      const n = Math.min(Number(seed[1]), 2000);
      const long = await createThread(`QA ${n} long turns`);
      // Replies of several paragraphs, so the transcript scrolls and the app pages its history as it would on a real long thread.
      const para = 'The test agent answers this turn with a paragraph of ordinary text, long enough to wrap over a few lines of the transcript, so that a long thread renders as a real one would.';
      const words = Array.from({ length: 4 }, () => `${para} ${para}`).join('\n\n');
      for (let i = 1; i <= n; i++) {
        const at = Date.now() - (n - i) * 60000;
        const tr = ref('Turn', nid('turn'));
        const ans = ref('AgentMessage', nid('msg'));
        await put(tr, { status: 'completed', startedAt: at, endedAt: at + 1000, startedBy: { kind: 'user' } }, { thread: long, answer: ans });
        await put(ref('UserMessage', nid('msg')), { content: text(`Turn ${i}: tell me something`), createdAt: at, steering: false }, { turn: tr });
        await put(ans, { content: text(`Reply ${i}. ${words}`), createdAt: at + 900, phase: 'final', streaming: false }, { turn: tr });
      }
      await save();
      reply += `I made "QA ${n} long turns". `;
    }
    if (run.fail) { await finish(threadId, run, 'failed', 'The test agent failed on purpose'); return; }
    // The reply, streamed word by word.
    const msg = ref('AgentMessage', nid('msg'));
    await put(msg, { content: text(''), createdAt: Date.now(), phase: 'final', streaming: true }, { turn });
    await update(turn, {}, { answer: msg });   // its answer (Turn.answer: the turn names it)
    let sofar = '';
    const slow = /slow/i.test(said);
    const body = `${reply}This is the test agent's reply to "${said}".${slow ? ' It takes its time, one word after another, so that there is a moment to press Stop while the words are still arriving on the screen.' : ''}`;
    const crash = /crash/i.test(said);
    let n = 0;
    for (const w of body.split(/(?<= )/)) {
      await sleep(slow ? 300 : WORD_MS);
      if (!alive()) return;
      sofar += w;
      await update(msg, { content: text(sofar) });
      if (crash && ++n === 5) {
        const { isMainThread } = await import('node:worker_threads');
        if (!isMainThread) process.exit(1);
      }
    }
    await update(msg, { streaming: false });
    await finish(threadId, run, 'completed');
    // QA: a message containing "notify" ends with a notification of the agent's about its chat (a click opens the chat's view)
    if (/\bnotify\b/i.test(said) && typeof ctx.ui?.notify === 'function') {
      const said2 = (e) => ctx.log.warn('the notification was not shown', { message: String(e?.message ?? e) });
      try { ctx.ui.notify({ title: 'The test agent replied', body: sofar.slice(0, 200), subject: run.thread, dedupe: `reply-${threadId}`.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '-') })?.shown?.catch?.(said2); }
      catch (e) { said2(e); }
    }
  }

  async function ask(run, r, state, links) {
    const answered = new Promise((resolve) => waiting.set(r.id, { resolve, run }));
    await put(r, state, links);
    await update(run.thread, { status: 'waitingForYou' });
    const answer = await answered;
    if (!run.cancelled) await update(run.thread, { status: 'working' });
    return answer;
  }

  async function finish(threadId, run, status, error) {
    if (running.get(threadId) !== run) return;
    running.delete(threadId);
    const now = Date.now();
    await update(run.turn, { status, endedAt: now, ...(error ? { error } : {}) });
    // a reply the user has not read yet (its view shown reads it)
    await update(run.thread, { status: status === 'failed' ? 'error' : 'idle', updatedAt: now, ...(status === 'completed' ? { unread: true } : {}) });
    await save();
  }

  async function stop({ ref: t }) {
    const run = running.get(t.id);
    if (!run) return null;
    run.cancelled = true;
    for (const [id, w] of [...waiting]) {
      if (w.run !== run) continue;
      waiting.delete(id);
      await update(records.get(id).ref, { status: 'cancelled' });
      w.resolve(null);
    }
    for (const r of [...records.values()]) {
      if (r.links?.turn?.id !== run.turn.id) continue;
      if (r.state.streaming === true) await update(r.ref, { streaming: false });
      if (['running', 'waitingForYou'].includes(r.state.status)) await update(r.ref, { status: 'cancelled', endedAt: Date.now() });
    }
    await finish(t.id, run, 'stopped');
    return null;
  }

  // ---------------------------------------------------------------- answers
  function answerWith(status, value) {
    return async ({ ref: r, args }) => {
      const w = waiting.get(r.id);
      if (!w) return { status: 'refused', reason: 'unavailable', message: 'the request is no longer open' };
      waiting.delete(r.id);
      await update(r, { status, answeredAt: Date.now() });
      w.resolve(value(args));
      return null;
    };
  }
  const change = (state) => async ({ ref: t }) => { await update(t, { ...state(), updatedAt: Date.now() }); await save(); return null; };

  // ---------------------------------------------------------------- its account (§3.15)
  const ACCOUNT = ref('Account', 'test-account');
  async function putAccount(signedIn) {
    await provider.put(ACCOUNT, { state: { service: 'Test service', name: 'Test agent account', signedIn, email: 'test-agent@example.invalid' }, links: {} });
    await ctx.storage.set('agent/account-signed-in', signedIn);
  }

  // ---------------------------------------------------------------- its automation (§3.15)
  const AUTOMATION = ref('Automation', 'check-in');
  const putAutomation = async (state) => {
    const was = records.get(AUTOMATION.id)?.state;
    await put(AUTOMATION, { name: 'Test agent check-in', prompt: text('Check in: say hello from the automation'), schedule: { kind: 'interval', every: 60 }, enabled: true,
      ...(was ?? {}), ...state }, { agent: ref(AGENT, AGENT_ID), project: null });
    await save();
  };
  const automation = {
    runNow: { effect: 'external', handler: async () => {
      const a = records.get(AUTOMATION.id);
      if (!a) return { status: 'refused', reason: 'unavailable', message: 'the automation was deleted' };
      const t = await createThread(a.state.name, DEFAULT_MODEL, AUTOMATION);
      await update(AUTOMATION, { lastRunAt: Date.now() });
      await send({ ref: t, args: [a.state.prompt] });
      return t;
    } },
    enable: { effect: 'local', handler: async () => { await putAutomation({ enabled: true }); return null; } },
    disable: { effect: 'local', handler: async () => { await putAutomation({ enabled: false }); return null; } },
    edit: { effect: 'local', handler: async ({ args: [spec] }) => {
      const next = {};
      if (typeof spec?.name === 'string' && spec.name.trim()) next.name = spec.name.trim();
      if (spec?.prompt && typeof spec.prompt === 'object') next.prompt = spec.prompt;
      if (spec?.schedule && typeof spec.schedule === 'object') next.schedule = spec.schedule;
      if (typeof spec?.enabled === 'boolean') next.enabled = spec.enabled;
      await putAutomation(next);
      return null;
    } },
    delete: { effect: 'local', handler: async () => { records.delete(AUTOMATION.id); await provider.remove(AUTOMATION); await ctx.storage.set('agent/automation-deleted', true); await save(); return null; } },
  };

  // ---------------------------------------------------------------- activation
  await ctx.graph.registerTypes(TYPES);
  provider = ctx.graph.provide({
    types: {
      [AGENT]: {
        operations: {
          // A thread from the app's new-chat composer (presentations.md V11): on the draft's model when it is one of the agent's.
          newThread: { effect: 'local', handler: async ({ args: [draft] }) => {
            const d = draft ? await ctx.graph.resolve(draft) : null;
            const m = d && !d.gone ? d.state?.target?.model : null;
            const model = m && m.provider === me && MODELS.some((x) => x.id === m.id) ? m.id : DEFAULT_MODEL;
            // the new chat's own choice of the agent's Tone (its target's settings, by the Setting's id), else the agent's default
            const tone = d && !d.gone ? d.state?.target?.settings?.[AGENT_TONE] : undefined;
            return createThread('New thread', model, null, TONES.some((c) => c.id === tone) ? tone : agentTone());
          } },
        },
      },
      Model: { supports: ['contextWindow', 'pricing'] },
      [THREAD]: {
        operations: {
          send: { effect: 'external', handler: send },
          stop: { effect: 'local', handler: stop },
          rename: { effect: 'local', handler: ({ ref: t, args: [title] }) => change(() => ({ title: String(title) }))({ ref: t }) },
          archive: { effect: 'local', handler: change(() => ({ archived: true })) },
          restore: { effect: 'local', handler: change(() => ({ archived: false })) },
          markRead: { effect: 'local', handler: change(() => ({ unread: false })) },
        },
      },
      Turn: {}, UserMessage: {}, AgentMessage: {}, Reasoning: {}, CommandRun: {}, [PROBE]: {}, [EDIT]: {}, SettingsSection: {}, Automation: { operations: automation },
      Account: { operations: {
        signIn: { effect: 'local', handler: async () => { await putAccount(true); return null; } },
        signOut: { effect: 'local', handler: async () => { await putAccount(false); return null; } },
      } },
      Setting: {
        operations: {
          set: { effect: 'local', handler: async ({ ref: r, args: [value] }) => {
            const rec = records.get(r.id);
            if (!rec || !TONES.some((c) => c.id === value)) return { status: 'refused', reason: 'invalid', message: 'a tone is brief or detailed' };
            if (r.id === AGENT_TONE) { await putAgentTone(value); await save(); return null; }
            await putTone(rec.links.thread, value);
            await save();
            return null;
          } },
          reset: { effect: 'local', handler: async ({ ref: r }) => { const rec = records.get(r.id); if (rec) { await (r.id === AGENT_TONE ? putAgentTone() : putTone(rec.links.thread)); await save(); } return null; } },
        },
      },
      CommandApproval: {
        operations: {
          // one of its options: approving once or for the chat, or declining
          answer: { effect: 'local', handler: async (call) => {
            const option = OPTIONS.find((o) => o.id === call.args[0]);
            if (!option) return { status: 'refused', reason: 'unsupported', message: `this request offers no option ${call.args[0]}` };
            return answerWith(option.kind === 'approve' ? 'answered' : 'declined', () => ({ approved: option.kind === 'approve', scope: option.scope }))(call);
          } },
        },
      },
      Question: {
        operations: {
          answer: { effect: 'local', handler: answerWith('answered', ([answers]) => ({ answers: answers ?? {} })) },
          skip: { effect: 'local', handler: answerWith('declined', () => ({ skipped: true })) },
        },
      },
    },
  });
  // The agent and its models are constants: put at every start, before any thread links to them, and not kept in the storage.
  const agent = ref(AGENT, AGENT_ID);
  await provider.put(agent, { state: { name: 'Test agent', icon: ICON, available: true }, links: { settings: [ref('Setting', AGENT_TONE)] } });
  for (const m of MODELS) {
    await provider.put(ref('Model', m.id), { state: { name: m.name, description: m.description, efforts: m.efforts, default: m.default, available: true, ...(m.inputs ? { inputs: m.inputs } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.pricing ? { pricing: m.pricing } : {}) }, links: { agent } });
  }
  await provider.put(ref('SettingsSection', 'test-agent'), { state: { title: 'Test agent' }, links: {} });
  await provider.setComplete('Automation', true);
  await putAccount((await ctx.storage.get('agent/account-signed-in')) !== false);
  await provider.setComplete('Account', true);
  await provider.setComplete(AGENT, true);
  await provider.setComplete('Model', true);
  await load();
  await putAgentTone(agentTone());   // the agent's own Tone, as the user last set it
  if (![...records.values()].some((r) => r.ref.type === THREAD)) await createThread('Test agent thread');
  // its automation, unless the user deleted it (kept in its storage as it was: enabled, its last run)
  if (!records.has(AUTOMATION.id) && !(await ctx.storage.get('agent/automation-deleted'))) await putAutomation({});
  // each thread's tone as the agent defines it now (its choices, title, default), keeping the value chosen; one kept from before it had a
  // tone gets one
  for (const r of [...records.values()]) {
    if (r.ref.type !== THREAD) continue;
    const kept = records.get(`tone@${r.ref.id}`)?.state?.value;
    await putTone(r.ref, TONES.some((c) => c.id === kept) ? kept : agentTone());
  }
  await provider.setComplete(THREAD, true);

  ctx.services.provide('testAgent', {
    async createThread(args) { return { id: (await createThread(args?.title, args?.model)).id }; },
    threads() { return [...records.values()].filter((r) => r.ref.type === THREAD).map((r) => ({ id: r.ref.id, title: r.state.title, archived: r.state.archived, model: r.links?.model?.id ?? null })); },
    failNextTurn() { failNext = true; return { ok: true }; },
    /** The worker exits: the provider goes away mid-turn (its chats go with it). */
    crash() { setTimeout(() => process.exit(1), 50); return { ok: true }; },
  });

  return async () => {
    for (const run of running.values()) run.cancelled = true;
    await save().catch(() => {});
  };
}

export default { host };
