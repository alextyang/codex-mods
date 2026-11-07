// codexmods.intelligence, host entry: mod intelligence (GOAL.md goal 16; docs/design/reference-mods.md §2). The framework's internal mod
// (framework/host/internal-mods.mjs): the framework ships it, starts it before the user's mods and integrates with it. Single-file ESM,
// Node built-ins only.
//
// - **Model use is each mod's own switch.** A mod that declares model use in its manifest (`intelligence: {why, tools?}`) has one
//   ModelUse instance here (its `modId`): off until the user turns it on on the mod's page, with the models it may use (Luna by default),
//   its token allowances per hour and per day, and the other kinds of tool the user allows it. Only the user changes them (the Mods page
//   acts as the user); a mod never does.
// - **Calls run in managed threads.** A mod calls through `ctx.intelligence.ask` (the SDK), which reaches this mod's `model` service with
//   the caller authenticated. Each call is one ephemeral Codex thread on the app's connection, private to this mod (the mux's private
//   threads: started in a folder under its data folder's `threads`, never seen by the app or another mod), with approvals off, Codex's
//   own tools and the user's setup off, the calling mod's tools as dynamic tools, and its instructions. A tool call is answered by the
//   calling mod, in its own realm, through the short-lived service its ctx provides for the call (only this mod may call it): its own
//   storage, settings and actions. Text streams there too, and the call ends there.
// - **Tokens are measured** from the thread's token reports, per mod and in total, and kept in its storage. **Guardrails:** the allowance
//   per hour and per day, calls per minute, the prompt's size, the call's time, the account near its limit (the CodexUsage the graph has),
//   and the switch, which ends a mod's running calls at once.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_MODEL = 'gpt-6-luna';
export const LIMITS = Object.freeze({
  perHour: 200_000, perDay: 1_000_000,   // tokens, a mod's allowance unless the user gives another
  callsPerMinute: 30, running: 4,        // per mod
  promptChars: 200_000, toolsMax: 32,
  timeoutMs: 60_000, timeoutMaxMs: 300_000,
  accountStopPercent: 95,                // no call while the account's limit is this used
});
const HOUR = 3_600_000, DAY = 24 * HOUR;
const STORE = 'uses';
const TYPE = 'ModelUse';
const str = (tier = 'core') => ({ member: 'state', schema: { t: 'string' }, tier });
const num = (tier = 'core') => ({ member: 'state', schema: { t: 'number' }, tier });
const bool = (tier = 'core') => ({ member: 'state', schema: { t: 'boolean' }, tier });
const list = (tier = 'core') => ({ member: 'state', schema: { t: 'list', of: { t: 'string' } }, tier });
const operation = (args = []) => ({ member: 'operation', args, minArgs: args.length, returns: null, tier: 'core' });
const TYPES = [{
  id: TYPE, kind: 'concept', parent: null, spec: {
    state: {
      modId: str(), name: str(), why: str(),
      enabled: bool(), model: str(), models: list(),      // the model it uses, of those the user gives it
      perHour: num(), perDay: num(),                      // its token allowances
      wants: list(), tools: list(),                       // the other kinds of tool it asks for, and those the user allows
      available: { member: 'state', schema: { t: 'list', of: { t: 'object', fields: { id: { schema: { t: 'string' }, optional: false }, name: { schema: { t: 'string' }, optional: false } } } }, tier: 'core' },   // the models the user may give it: Codex's
      usedHour: num(), usedDay: num(), usedTotal: num(), calls: num(), running: num(),
      lastError: str('optional'),
    },
    operations: {
      setEnabled: operation([{ t: 'boolean' }]), setModel: operation([{ t: 'string' }]),
      setAllowance: operation([{ t: 'object', fields: { perHour: { schema: { t: 'number' }, optional: false }, perDay: { schema: { t: 'number' }, optional: false } } }]),
      setTools: operation([{ t: 'list', of: { t: 'string' } }]), stop: operation(),
    },
  },
}];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');
/** A tool name the agent may call: letters, digits, `_` and `-` (Codex's dynamic tools). */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const NAMESPACE = 'mod';

/** Tokens used in the last `ms` from a list of {t, tokens}. */
export const usedSince = (entries, now, ms) => entries.reduce((n, e) => (now - e.t < ms ? n + e.tokens : n), 0);

/** Whether a call may start now, and if not, why (a refusal the caller is told). */
export function admit(use, { now, calls, account, promptChars, running, live = 0 }) {
  if (!use) return 'this mod has not declared model use in its manifest';
  if (!use.enabled) return 'model use is off for this mod: turn it on on its page in Settings, Mods';
  if (running >= LIMITS.running) return `at most ${LIMITS.running} calls of a mod run at once`;
  if (calls.filter((t) => now - t < 60_000).length >= LIMITS.callsPerMinute) return `at most ${LIMITS.callsPerMinute} calls a minute`;
  if (promptChars > LIMITS.promptChars) return `a prompt is at most ${LIMITS.promptChars} characters`;
  // what its running calls used so far counts too (`live`)
  if (usedSince(use.history, now, HOUR) + live >= use.perHour) return `its allowance of ${use.perHour} tokens an hour is used`;
  if (usedSince(use.history, now, DAY) + live >= use.perDay) return `its allowance of ${use.perDay} tokens a day is used`;
  if (account >= LIMITS.accountStopPercent) return `your Codex account's limit is ${Math.round(account)}% used`;
  return null;
}

/** The most used of the account's limits now, as a percentage (0 when not known). */
export function accountUsed(usages) {
  let most = 0;
  for (const u of usages) for (const snap of Object.values(u?.state?.snapshots ?? {})) {
    if (snap?.rateLimitReachedType) return 100;
    for (const w of [snap?.primary, snap?.secondary]) if (typeof w?.usedPercent === 'number') most = Math.max(most, w.usedPercent);
  }
  return most;
}

/** A managed thread's base instructions, in place of Codex's coding agent's (which a mod's call does not need, and which cost its tokens). */
export const BASE_INSTRUCTIONS = 'You are a model a Codex mod uses through mod intelligence, not a coding agent. You cannot read the user\'s files, run commands or reach the network unless a tool you are given does so. Do exactly what you are asked, and answer briefly.';
/** A tool server's name as a config key path can name it (others make the call refuse: it never runs with a server it cannot turn off). */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * What a managed thread starts with: ephemeral, approvals off, Codex's own tools and the user's setup off, the caller's tools. `servers`:
 * the tool servers the user's config has, each turned off unless the user allowed this mod tool servers.
 */
export function threadParams({ cwd, model, instructions, tools, allowed, servers = [] }) {
  const offServers = allowed.includes('toolServers') ? {} : Object.fromEntries(servers.map((n) => [`mcp_servers.${n}.enabled`, false]));
  return {
    cwd, model, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', personality: 'none', baseInstructions: BASE_INSTRUCTIONS,
    developerInstructions: [
      'You are working for a Codex mod, through mod intelligence. Answer what you are asked, using only the tools you are given.',
      ...(typeof instructions === 'string' && instructions.trim() ? [instructions.trim()] : []),
    ].join('\n\n'),
    ...(tools.length ? { dynamicTools: [{ type: 'namespace', name: NAMESPACE, description: 'The mod\'s own tools: its storage, its settings and its actions.', tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })) }] } : {}),
    config: {
      'features.shell_tool': false, 'features.unified_exec': false, 'features.apply_patch_freeform': false, 'features.view_image': false,
      'features.image_generation': false, 'features.apps': false, 'features.plugins': false, 'features.memories': false,
      'features.multi_agent': false, 'features.browser_use': false, 'features.computer_use': false, 'features.hooks': false,
      'web_search': allowed.includes('web') ? 'live' : 'disabled', 'project_doc_max_bytes': 0, 'include_apps_instructions': false,
      'include_permissions_instructions': false, 'include_environment_context': false,
      'skills.bundled.enabled': false, 'skills.include_instructions': false, 'memories.use_memories': false, 'memories.generate_memories': false,
      ...offServers,
    },
  };
}

/** A tool call's text answer, as Codex takes it from a dynamic tool. */
const answerOf = (value) => ({ success: value?.ok !== false, contentItems: [{ type: 'inputText', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value?.value ?? null) }] });

async function host(ctx) {
  const me = ctx.mod.id;
  const threadsDir = join(ctx.mod.dataDir, 'threads');
  const ref = (modId) => ({ type: TYPE, provider: me, id: modId });
  const uses = new Map();        // modId -> {modId, name, why, wants, enabled, model, models, perHour, perDay, tools, history: [{t, tokens}], total, calls: number}
  const calls = new Map();       // modId -> [start times]
  const running = new Map();     // call id -> {modId, threadId, turnId, caller, service, done, timer, usage, text}
  const byThread = new Map();    // thread id -> its call, until its thread is let go (an ended call's turn may still be running: its usage counts)
  let provider = null, codexModels = [], usages = [];
  const now = () => Date.now();

  // ---- what each mod declares, and what the user decided (kept in storage)
  const kept = (await ctx.storage.get(STORE)) ?? {};
  const stateOf = (u) => {
    const t = now();
    return { modId: u.modId, name: u.name, why: u.why, enabled: u.enabled, model: u.model, models: [...u.models], available: availableModels(), perHour: u.perHour, perDay: u.perDay,
      wants: [...u.wants], tools: [...u.tools], usedHour: usedSince(u.history, t, HOUR), usedDay: usedSince(u.history, t, DAY), usedTotal: u.total,
      calls: u.calls, running: [...running.values()].filter((c) => c.modId === u.modId).length, ...(u.lastError ? { lastError: u.lastError } : {}) };
  };
  // the user's decisions are kept for every mod ever seen: a mod that leaves the list (stopped, or the Host stopping) keeps them
  const save = () => {
    for (const [id, u] of uses) kept[id] = { enabled: u.enabled, model: u.model, models: u.models, perHour: u.perHour, perDay: u.perDay, tools: u.tools,
      history: u.history.filter((e) => now() - e.t < DAY), total: u.total, calls: u.calls };
    return ctx.storage.set(STORE, kept).catch(() => {});
  };
  const show = async (u) => { if (provider) await provider.put(ref(u.modId), { state: stateOf(u), links: {} }).catch((e) => ctx.log.warn('ModelUse not shown', { message: String(e?.message ?? e) })); };
  const availableModels = () => (codexModels.length ? codexModels : [{ id: DEFAULT_MODEL, name: 'GPT-6 Luna' }]);
  const allowedModels = () => availableModels().map((m) => m.id);

  /** The mods that declare model use, as the framework's Mod instances say. */
  async function sync(mods) {
    const seen = new Set();
    for (const m of mods) {
      const decl = m?.state?.intelligence;
      if (!decl || typeof m.ref?.id !== 'string') continue;
      const id = m.ref.id;
      seen.add(id);
      const k = kept[id] ?? {};
      const u = uses.get(id) ?? { modId: id, enabled: k.enabled === true, model: typeof k.model === 'string' ? k.model : DEFAULT_MODEL,
        models: Array.isArray(k.models) ? k.models : [DEFAULT_MODEL], perHour: Number.isFinite(k.perHour) ? k.perHour : LIMITS.perHour,
        perDay: Number.isFinite(k.perDay) ? k.perDay : LIMITS.perDay, tools: Array.isArray(k.tools) ? k.tools : [], history: Array.isArray(k.history) ? k.history : [],
        total: Number.isFinite(k.total) ? k.total : 0, calls: Number.isFinite(k.calls) ? k.calls : 0 };
      u.name = typeof m.state.name === 'string' ? m.state.name : id;
      u.why = String(decl.why ?? '');
      u.wants = Array.isArray(decl.tools) ? decl.tools.filter((t) => typeof t === 'string') : [];
      u.tools = u.tools.filter((t) => u.wants.includes(t));   // a kind it no longer asks for is no longer allowed
      uses.set(id, u);
      await show(u);
    }
    for (const id of [...uses.keys()]) {
      if (seen.has(id)) continue;
      stopAll(id, 'the mod is gone');
      save();   // its decisions stay kept
      uses.delete(id);
      await provider?.remove(ref(id)).catch(() => {});
    }
  }

  // ---- the user's decisions (the Mods page invokes as the user; a mod never changes them)
  const asUser = (fn) => async (call) => {
    if (call.caller?.kind === 'mod') return { status: 'refused', reason: 'notAllowed', message: 'a mod\'s model use is the user\'s to change' };
    const u = uses.get(call.ref.id);
    if (!u) return { status: 'refused', reason: 'unavailable', message: 'that mod does not declare model use' };
    const out = await fn(u, ...(call.args ?? []));
    if (out) return out;
    save(); await show(u);
    return null;
  };
  const operations = {
    setEnabled: asUser(async (u, on) => { u.enabled = on === true; u.lastError = undefined; if (!u.enabled) stopAll(u.modId, 'model use was turned off'); }),
    setModel: asUser(async (u, model) => {
      if (!allowedModels().includes(model)) return { status: 'refused', reason: 'invalid', message: `${model} is not one of Codex's models` };
      u.model = model; if (!u.models.includes(model)) u.models = [...u.models, model];
      return null;
    }),
    setAllowance: asUser(async (u, a) => {
      const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 100_000_000;
      if (!isObj(a) || !ok(a.perHour) || !ok(a.perDay)) return { status: 'refused', reason: 'invalid', message: 'allowances are whole numbers of tokens' };
      u.perHour = a.perHour; u.perDay = a.perDay; return null;
    }),
    setTools: asUser(async (u, tools) => {
      if (!Array.isArray(tools) || tools.some((t) => !u.wants.includes(t))) return { status: 'refused', reason: 'invalid', message: `it asks only for ${u.wants.join(', ') || 'no other tools'}` };
      u.tools = [...new Set(tools)]; return null;
    }),
    stop: asUser(async (u) => { stopAll(u.modId, 'stopped by you'); }),
  };

  // ---- a call
  async function start(args, { caller }) {
    if (caller?.kind !== 'mod') return { status: 'refused', reason: 'notAllowed', message: 'model use is a mod\'s' };
    const modId = caller.id;
    const u = uses.get(modId);
    const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
    const service = typeof args?.service === 'string' && args.service.startsWith('intelligence:') ? args.service : null;
    if (!prompt.trim() || !service) return { status: 'refused', reason: 'invalid', message: 'a call needs a prompt (and the SDK\'s service for it)' };
    const t = now();
    const why = admit(u, { now: t, calls: calls.get(modId) ?? [], account: accountUsed(usages), promptChars: prompt.length + String(args.instructions ?? '').length,
      running: [...running.values()].filter((c) => c.modId === modId).length, live: liveUsage(modId) });
    if (why) return { status: 'refused', reason: 'notAllowed', message: why };
    const model = typeof args.model === 'string' && args.model ? args.model : u.model;
    if (!u.models.includes(model) && model !== u.model) return { status: 'refused', reason: 'notAllowed', message: `${model} is not one of the models you gave this mod` };
    const tools = (Array.isArray(args.tools) ? args.tools : []).slice(0, LIMITS.toolsMax).filter((x) => isObj(x) && TOOL_NAME.test(String(x.name)))
      .map((x) => ({ name: String(x.name), description: clip(String(x.description ?? ''), 1000), inputSchema: isObj(x.inputSchema) ? x.inputSchema : { type: 'object', properties: {} } }));
    const timeoutMs = Math.min(Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : LIMITS.timeoutMs, LIMITS.timeoutMaxMs);
    calls.set(modId, [...(calls.get(modId) ?? []).filter((x) => t - x < 60_000), t]);
    const id = randomUUID();
    const c = { id, modId, service, threadId: null, turnId: null, usage: 0, charged: 0, text: '', ended: false, finished: false, stream: args.stream === true, timer: null, letGo: null };
    running.set(id, c);
    u.calls += 1;
    void show(u);
    void run(c, u, { prompt, instructions: args.instructions, model, effort: args.effort, tools, timeoutMs });
    return { status: 'started', id };
  }
  async function run(c, u, { prompt, instructions, model, effort, tools, timeoutMs }) {
    const cwd = join(threadsDir, c.id);
    c.timer = setTimeout(() => end(c, { failed: `the call took more than ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    try {
      await mkdir(cwd, { recursive: true });
      // the user's tool servers, each turned off for the thread (unless allowed): never a server the user did not give this mod
      const servers = u.tools.includes('toolServers') ? [] : await toolServers(cwd);
      if (c.ended) return;
      const started = await ctx.appServer.request('thread/start', threadParams({ cwd, model, instructions, tools, allowed: u.tools, servers }));
      c.threadId = started?.thread?.id ?? null;
      if (!c.threadId) throw new Error('Codex did not start the thread');
      byThread.set(c.threadId, c);
      if (c.ended) return void finish(c);
      const turn = await ctx.appServer.request('turn/start', { threadId: c.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], model,
        ...(typeof effort === 'string' ? { effort } : {}), approvalPolicy: 'never' });
      c.turnId = turn?.turn?.id ?? null;
      if (c.ended) interrupt(c);   // ended (its time, the switch) before Codex said its turn: stopped now
    } catch (e) { await end(c, { failed: `Codex refused the call: ${String(e?.message ?? e)}` }); }
  }
  /** The user's tool servers (the effective config's), by name; throws when they cannot be read or one cannot be named. */
  async function toolServers(cwd) {
    const r = await ctx.appServer.request('config/read', { cwd, includeLayers: false });
    const names = Object.keys(isObj(r?.config?.mcp_servers) ? r.config.mcp_servers : {});
    const bad = names.find((n) => !SERVER_NAME.test(n));
    if (bad !== undefined) throw new Error(`a tool server's name cannot be turned off for the call: ${clip(bad, 64)}`);
    return names;
  }
  /** Tokens its running calls used so far (they count toward its allowance before they end). */
  function liveUsage(modId) { let n = 0; for (const c of running.values()) if (c.modId === modId) n += c.usage; return n; }
  /** Count what a call used since last counted. */
  function charge(c) {
    const u = uses.get(c.modId);
    const delta = c.usage - c.charged;
    if (!u || delta <= 0) return;
    c.charged = c.usage;
    u.history.push({ t: now(), tokens: delta }); u.history = u.history.filter((e) => now() - e.t < DAY); u.total += delta;
    save(); void show(u);
  }
  /** Whatever ends a call: its answer, a failure, its time, the switch. The caller is told once; the tokens are counted. Its thread is let
   *  go once its turn has ended (what it uses until then still counts). */
  async function end(c, outcome) {
    if (c.ended) return;
    c.ended = true;
    clearTimeout(c.timer);
    running.delete(c.id);
    if (outcome.failed) interrupt(c);
    charge(c);
    const u = uses.get(c.modId);
    if (u) { u.lastError = outcome.failed ? clip(outcome.failed, 300) : undefined; save(); void show(u); }
    if (!c.threadId || c.finished) finish(c);
    else { c.letGo = setTimeout(() => finish(c), 120_000); c.letGo.unref?.(); }   // its turn's end lets it go; at the latest, then
    const tell = outcome.failed ? ['failed', { message: outcome.failed, usage: { tokens: c.usage } }] : ['done', { text: c.text, usage: { tokens: c.usage } }];
    await ctx.services.call(c.modId, c.service, tell[0], tell[1]).catch(() => {});
    void rm(join(threadsDir, c.id), { recursive: true, force: true }).catch(() => {});
  }
  function interrupt(c) {
    if (c.threadId && c.turnId) ctx.appServer.request('turn/interrupt', { threadId: c.threadId, turnId: c.turnId }).catch(() => {});
  }
  /** Its thread is let go: no longer followed, and unloaded (so the mux forgets it once it closes). */
  function finish(c) {
    clearTimeout(c.letGo);
    c.finished = true;
    if (!c.threadId || byThread.get(c.threadId) !== c) return;
    byThread.delete(c.threadId);
    ctx.appServer.request('thread/unsubscribe', { threadId: c.threadId }).catch(() => {});
  }
  function stopAll(modId, why) { for (const c of [...running.values()]) if (c.modId === modId) void end(c, { failed: why }); }

  // ---- what its private threads say (the mux shows them to this mod only)
  ctx.appServer.observe({ kinds: ['serverNotification'], methods: ['item/', 'turn/', 'thread/tokenUsage/updated', 'error'] }, (m) => {
    const p = m?.params ?? {};
    const c = typeof p.threadId === 'string' ? byThread.get(p.threadId) : undefined;
    if (!c) return;
    if (m.method === 'thread/tokenUsage/updated') {
      const total = p.tokenUsage?.total?.totalTokens;
      if (!Number.isFinite(total) || total <= c.usage) return;
      c.usage = total;
      if (c.ended) { charge(c); return; }   // an ended call's turn still running: counted as it goes
      const u = uses.get(c.modId);
      if (u && (usedSince(u.history, now(), HOUR) + liveUsage(c.modId) >= u.perHour || usedSince(u.history, now(), DAY) + liveUsage(c.modId) >= u.perDay)) {
        void end(c, { failed: 'its token allowance is used' });
      }
      return;
    }
    if (m.method === 'turn/completed') {
      if (!c.ended) {
        const st = p.turn?.status;
        void end(c, st === 'completed' ? {} : { failed: st === 'interrupted' ? 'the call was stopped' : clip(String(p.turn?.error?.message ?? `the turn ${st ?? 'failed'}`), 300) });
      }
      finish(c);
      return;
    }
    if (c.ended) return;
    if (m.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      c.text += p.delta;
      if (c.stream) ctx.services.call(c.modId, c.service, 'text', { delta: p.delta }).catch(() => {});
    } else if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
      c.text = p.item.text;
    } else if (m.method === 'error' && p.willRetry === false) {
      void end(c, { failed: clip(String(p.error?.message ?? 'Codex reported an error'), 300) });
    }
  });
  // a tool call: answered by the calling mod, in its own realm
  ctx.appServer.intercept('serverRequest', ['item/tool/call'], async (m) => {
    const p = m?.params ?? {};
    const c = typeof p.threadId === 'string' ? byThread.get(p.threadId) : undefined;
    if (!c || c.ended) return c ? { respond: { result: answerOf({ ok: false, text: 'the call has ended' }) } } : undefined;
    if (p.namespace !== NAMESPACE) return { respond: { result: answerOf({ ok: false, text: `no tool ${p.tool}` }) } };
    const value = await ctx.services.call(c.modId, c.service, 'tool', { name: String(p.tool), args: p.arguments ?? {} })
      .catch((e) => ({ ok: false, text: `the tool failed: ${String(e?.message ?? e)}` }));
    return { respond: { result: answerOf(value) } };
  }, { timeoutMs: 30_000 });

  // ---- the graph: its type, each mod's ModelUse, the mods and the account it reads
  await ctx.graph.registerTypes(TYPES);
  provider = ctx.graph.provide({ types: { [TYPE]: { operations: Object.fromEntries(Object.entries(operations).map(([k, h]) => [k, { effect: 'local', handler: h }])) } } });
  const subs = [];
  const watch = (query, apply) => {
    let members = new Map();
    subs.push(ctx.graph.subscribe(query, (msg) => {
      if (msg?.type === 'snapshot') members = new Map((msg.items ?? []).filter((x) => x?.ref && !x.gone).map((x) => [x.ref.id, x]));
      else if (msg?.type === 'delta' && msg.event?.ref && msg.event.kind !== 'event') {
        if (msg.event.kind === 'removed') members.delete(msg.event.ref.id); else if (msg.event.instance) members.set(msg.event.ref.id, msg.event.instance);
      } else return;
      void apply([...members.values()]);
    }));
  };
  watch({ type: 'Mod' }, (mods) => sync(mods));
  watch({ type: 'CodexUsage' }, (list) => { usages = list; });
  // the models a mod may be given: Codex's (its agent's), as the app lists them
  watch({ type: 'Model' }, async (models) => {
    codexModels = models.filter((x) => x.links?.agent?.type === 'CodexAgent' && x.state?.available !== false)
      .map((x) => ({ id: x.ref.id, name: typeof x.state?.name === 'string' && x.state.name ? x.state.name : x.ref.id }));
    for (const u of uses.values()) await show(u);
  });
  await provider.setComplete(TYPE, true);
  const svc = ctx.services.provide('model', {
    start,
    /** The calling mod's model use: whether it is on, its model, its allowance and what it used. */
    status: (args, { caller }) => {
      const u = caller?.kind === 'mod' ? uses.get(caller.id) : null;
      return u ? stateOf(u) : { enabled: false, declared: false };
    },
  });
  return async () => {
    svc.dispose();
    for (const s of subs) s.dispose();
    for (const c of [...running.values()]) await end(c, { failed: 'mod intelligence stopped' });
    await save();
  };
}

export default { host };
