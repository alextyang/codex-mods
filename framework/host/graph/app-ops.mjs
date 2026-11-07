// The app's own operations, held for the graph's interceptors (docs/design/interception.md I1-I9; integration.md §6). The app's
// protocol requests that carry a thread operation (a send, a stop, a rename, an archive, ...) are matched at the mux, the one choke point
// these operations cross on 20770 (I2). When the graph has an interceptor for that operation on the thread's type (I4), the request is
// deferred (mux addition 5), the graph decides it through the interceptors (`graph.interceptApp`), and the request then goes on (changed
// or not), is answered with a refusal, or is dropped when the app has gone. Node built-ins only.
import { createAbort, done, failed, refused } from './index.mjs';
import { refs as codexRefs, userContent, inputOfContent } from './providers/codex/map.mjs';

const USER = Object.freeze({ kind: 'user', id: 'user', owner: 'app' });
const APP_GONE = new Set(['appGone', 'expired', 'muxClosed']);
/** What the app sends when the user presses Stop and there is no turn to interrupt yet (its send is still pending). */
export const STOP_WITHOUT_TURN = 'thread/backgroundTerminals/clean';

/**
 * The app's requests that carry a graph operation on a thread (I2): the operation, its arguments from the request's params (null when
 * this request is not that operation), and the params for changed arguments.
 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A send's input, rebuilt from changed content only (the graph's content is lossier than the app's input: mentions, skills, file images). */
const inputOf = (p, content, was) => (same(content, was) ? {} : { input: inputOfContent(content) });
const SANDBOX_ACCESS = { readOnly: 'read-only', workspaceWrite: 'workspace', dangerFullAccess: 'full' };
/** The settings an app send carries (its model, effort, mode and access as the thread's Setting keys name them), as the send's options. */
export function sendOptionsOf(p) {
  const settings = {};
  if (typeof p.model === 'string') settings.model = p.model;
  if (typeof p.effort === 'string') settings.effort = p.effort;
  if (typeof p.collaborationMode?.mode === 'string') settings.mode = p.collaborationMode.mode;
  const access = SANDBOX_ACCESS[p.sandboxPolicy?.type];
  if (access) settings.access = access;
  // the turn's additional context as the source has it (graph-integrity G3.5): what mods add for the agent, in the chain
  const context = p.additionalContext !== null && typeof p.additionalContext === 'object' && !Array.isArray(p.additionalContext) ? { additionalContext: p.additionalContext } : {};
  return { settings, ...context };
}
/** The params for changed send options: only the keys that changed, as the app sends them (a narrowed access drops a named profile). */
function optionsParams(p, options, was) {
  const now = options?.settings ?? {}, before = was?.settings ?? {};
  const out = {};
  if (now.model !== before.model && typeof now.model === 'string') out.model = now.model;
  if (now.effort !== before.effort && typeof now.effort === 'string') out.effort = now.effort;
  if (now.mode !== before.mode && (now.mode === 'default' || now.mode === 'plan')) {
    out.collaborationMode = { ...(p.collaborationMode ?? {}), mode: now.mode, settings: { ...(p.collaborationMode?.settings ?? {}), ...(out.model ? { model: out.model } : {}), ...(out.effort ? { reasoning_effort: out.effort } : {}) } };
  }
  if (now.access !== before.access && now.access === 'read-only') { out.sandboxPolicy = { type: 'readOnly' }; out.permissions = undefined; }
  if (!same(options?.additionalContext ?? null, was?.additionalContext ?? null)) out.additionalContext = options?.additionalContext ?? undefined;
  return out;
}
/** A fork's options: the source's fork parameters but the thread and the turn, which are the operation's own (G3.5). */
const forkOptionsOf = (p) => { const { threadId: _t, lastTurnId: _l, beforeTurnId: _b, ...rest } = p; return rest; };

export const APP_OPERATIONS = Object.freeze({
  'turn/start': { operation: 'send', args: (p) => [userContent(p.input), sendOptionsOf(p)],
    params: (p, [content, options], [was, wasOptions] = []) => JSON.parse(JSON.stringify({ ...p, ...inputOf(p, content, was), ...optionsParams(p, options, wasOptions) })) },
  'turn/steer': { operation: 'steer', args: (p) => [userContent(p.input)], params: (p, [content], [was] = []) => ({ ...p, ...inputOf(p, content, was) }) },
  'turn/interrupt': { operation: 'stop', args: () => [] },
  'thread/name/set': { operation: 'rename', args: (p) => (typeof p.name === 'string' ? [p.name] : null), params: (p, [name]) => ({ ...p, name }) },
  'thread/archive': { operation: 'archive', args: () => [] },
  'thread/unarchive': { operation: 'restore', args: () => [] },
  // a fork from a turn (public-hooks.md §3.5, H6m): the turn it keeps the chat up to (one up to before a turn, `beforeTurnId`, is the fork
  // of the turn before it: classify says it, and refuses what it cannot say while something holds forks)
  'thread/fork': { operation: 'fork', args: (p) => [typeof p.lastTurnId === 'string' && p.lastTurnId ? codexRefs.turn(p.lastTurnId) : undefined, forkOptionsOf(p)],
    params: (p, [turn, options]) => {
      const { lastTurnId: _was, beforeTurnId: _before, ...rest } = p;
      const base = options && typeof options === 'object' && !Array.isArray(options) ? { ...forkOptionsOf(options), threadId: p.threadId } : rest;
      return turn && typeof turn.id === 'string' ? { ...base, lastTurnId: turn.id } : base;
    } },
  // the agent's inputs (graph-integrity G3.5): a thread's start (the agent's), a resume and the session's skill roots, with the source's
  // own parameters, so mods add to what they share in the chain
  'thread/start': { operation: '_startThread', on: 'agent', args: (p) => [p], params: (_p, [params]) => params },
  'thread/resume': { operation: '_resume', args: (p) => [p], params: (p, [params]) => ({ ...params, threadId: p.threadId }) },
  'skills/extraRoots/set': { operation: '_setSkillRoots', on: 'agent', args: (p) => (Array.isArray(p.extraRoots) ? [p.extraRoots.filter((x) => typeof x === 'string')] : null),
    params: (p, [roots]) => ({ ...p, extraRoots: roots }) },
  // an earlier message edited (H6m): the chat goes back to before that turn (its send after is a send of its own)
  'thread/revert': { operation: 'rewind', on: 'turn', args: () => [] },
  'thread/compact/start': { operation: 'compact', args: () => [] },
  'review/start': { operation: 'review', args: (p) => [p.target ?? null], params: (p, [target]) => ({ ...p, target }) },
  // A goal update without an objective changes its status (pause, resume): not the setGoal operation.
  'thread/goal/set': { operation: 'setGoal', args: (p) => (typeof p.objective === 'string' ? [p.objective] : null), params: (p, [objective]) => ({ ...p, objective }) },
  'thread/goal/clear': { operation: 'clearGoal', args: () => [] },
  'thread/delete': { operation: 'delete', args: () => [] },
});

/**
 * What an app request made, as the graph says its operation returns it (public-hooks.md §3.4): a send's or a steer's Turn, a fork's Thread,
 * a new tool server; else nothing (a rewind's Turn is the send after it: not this request's).
 */
function madeBy(operation, result, args = []) {
  if ((operation === 'send' || operation === 'steer') && typeof result?.turn?.id === 'string') return codexRefs.turn(result.turn.id);
  if ((operation === 'fork' || operation === '_startThread') && typeof result?.thread?.id === 'string') return codexRefs.thread(result.thread.id);
  if (operation === 'addToolServer' && typeof args[0] === 'string') return codexRefs.toolServer(args[0]);
  return null;
}
/** How long a hold may wait on the graph: under the mux's own bound (10 min, after which it lets the request go unchanged), so an
 *  undecided one is refused, never let go undecided (built review H6m1). */
export const HOLD_LIMIT_MS = 570_000;

/**
 * The app's requests that are an operation of an instance a Codex area feeds (public-hooks.md §3.5, H6m), held when the user makes them
 * in the app: a plugin's install, uninstall, enable and disable; a skill turned on or off; a tool server's config written, turned on or
 * off, signed in. The area says which instance (`appOperation`); the app's main side's own writes (an id `<method>:<uuid>`) pass unheld.
 */
export const APP_AREA_METHODS = Object.freeze(['plugin/install', 'plugin/uninstall', 'config/batchWrite', 'config/value/write', 'skills/config/write', 'mcpServer/oauth/login']);
// each held one's operations, by concept: what passes interceptors from the app too (I11)
const AREA_OPERATIONS = Object.freeze({ Plugin: ['install', 'uninstall', 'enable', 'disable'], Skill: ['enable', 'disable'],
  ToolServer: ['edit', 'remove', 'enable', 'disable', 'signIn'], Agent: ['addToolServer'], Turn: ['rewind'] });
const APP = Object.freeze({ kind: 'app', id: 'app', owner: 'app' });
// the agent's own tool that uninstalls a plugin (21477: the page carries it out as an ordinary plugin/uninstall)
const AGENT_UNINSTALL = 'uninstall_plugin';

/**
 * @param {{ graph: object, mux: object, log?: object, holdLimitMs?: number,
 *   appOperation?: (method: string, params: object) => (object | null), appOwn?: (method: string, params: object) => boolean }} o
 *   `appOperation`: an area's reading of a request (`{ref, operation, args, params?}`; `{refuse, type, operation}`: one it cannot say,
 *   refused while something holds it; `{pending: {type, operation}, resolve()}`: one it can say once it has read again). `appOwn`: the
 *   request is the graph's own call carried out by the app (it passed the mods already): never held again.
 */
export function createAppOps({ graph, mux, log = graph.log, appOperation = null, appOwn = null, holdLimitMs = HOLD_LIMIT_MS }) {
  const client = mux.client('framework:app-ops');
  const holds = new Map();   // token -> {abort, signal, threadId, operation}
  let closed = false;
  // Reflection (I11): the native provider's thread operations pass interceptors from the app too.
  const provider = codexRefs.thread('x').provider;
  const conceptOf = (s) => graph.type(s.ref.type)?.concept;
  const bindings = [graph.bindAppOrigin((s) => s.ref.provider === provider && conceptOf(s) === 'Thread',
    [...new Set(Object.values(APP_OPERATIONS).filter((x) => x.on !== 'turn' && x.on !== 'agent').map((x) => x.operation))]),
  // the agent's acts (G3.5) pass interceptors from the app too
  graph.bindAppOrigin((s) => s.ref.provider === provider && conceptOf(s) === 'Agent', Object.values(APP_OPERATIONS).filter((x) => x.on === 'agent').map((x) => x.operation)),
  ...(appOperation ? Object.entries(AREA_OPERATIONS) : [['Turn', AREA_OPERATIONS.Turn]]).map(([concept, ops]) => graph.bindAppOrigin((s) => s.ref.provider === provider && conceptOf(s) === concept, ops))];
  // the agent's uninstall_plugin calls open now (callId -> the plugin it names, when it was asked): a plugin/uninstall of that plugin
  // meanwhile is the app's act for the agent. Taken as the server request passes (before the page sees it, so before the page's
  // uninstall), let go when the page answers it, the request is resolved otherwise, or after a while (built review H6m1).
  const AGENT_CALL_MS = 120_000;
  const agentUninstalls = new Map();
  const callOfSid = new Map();   // the id the page was given -> its callId
  const sessionOf = (info) => (info?.session && typeof info.session === 'object' ? info.session.id ?? '' : info?.session ?? '');
  const toolCalls = appOperation ? client.intercept('serverRequest', ['item/tool/call'], (m, info) => {
    const q = m?.params;
    if (q?.tool === AGENT_UNINSTALL && (q.namespace === undefined || q.namespace === 'plugin_management') && typeof q.callId === 'string') {
      agentUninstalls.set(q.callId, { plugin: typeof q.arguments?.plugin === 'string' ? q.arguments.plugin : null, at: Date.now(), session: sessionOf(info) });
    }
    return undefined;
  }) : null;
  /** Whether an uninstall of this plugin, in this session, is the agent's tool's (one of its open calls there names it, by id or name). */
  function agentsUninstall(pluginId, session) {
    const now = Date.now();
    for (const [id, c] of agentUninstalls) {
      if (now - c.at > AGENT_CALL_MS) { agentUninstalls.delete(id); continue; }
      if (!c.plugin || c.session !== session) continue;
      const name = graph.resolve(codexRefs.plugin(pluginId))?.state?.name;
      const said = c.plugin.toLowerCase();
      if (c.plugin === pluginId || pluginId.toLowerCase().startsWith(`${said}@`) || (typeof name === 'string' && name.toLowerCase() === said)) return true;
    }
    return false;
  }

  /**
   * The operation an app request is, as the graph says it: `{ref, operation, args, threadId, params(args)?, caller}`, or null (not one, or
   * on an instance the graph does not have).
   */
  const LOAD_MS = 2000;   // reading a turn the graph does not have yet
  /** A turn of a thread, as the graph has it (read first when it is not resident): its snapshot, or null when it is not that thread's. */
  /** The thread loaded with its turns (its whole history: a view of it at full depth), within LOAD_MS. */
  async function loadThread(threadId) {
    if (typeof graph.subscribe !== 'function') return;
    const view = graph.subscribe({ ref: codexRefs.thread(threadId), depth: 'full' }, () => true);
    await Promise.race([view.loaded, new Promise((r) => { const t = setTimeout(r, LOAD_MS); t.unref?.(); })]).catch(() => {});
    view.dispose();
  }
  /** A turn of a thread, as the graph has it once the thread is loaded: its snapshot, or null when it is not that thread's. */
  async function turnOf(threadId, turnId) {
    const ref = codexRefs.turn(turnId);
    let snap = graph.resolve(ref);
    if (!snap || snap.gone) { await loadThread(threadId); snap = graph.resolve(ref); }
    return snap && !snap.gone && snap.links?.thread?.id === threadId ? snap : null;
  }
  /**
   * The turn before a thread's turn, from its whole history (loaded first: one the graph has only some turns of could skip one; built
   * review H6m1 round 2), or null (it is the first, or not that thread's).
   */
  async function turnBefore(threadId, turnId) {
    await loadThread(threadId);
    const turns = (graph.related(codexRefs.thread(threadId), 'turns') ?? []).filter((t) => t && !t.gone).sort((a, b) => (a.state?.startedAt ?? 0) - (b.state?.startedAt ?? 0));
    const i = turns.findIndex((t) => t.ref.id === turnId);
    return i > 0 ? turns[i - 1] : null;
  }

  /**
   * The operation an app request is, as the graph says it: `{ref, snap, operation, args, threadId, params(args)?, caller}`; `{refuse, type,
   * operation}` (one it cannot say, refused while something holds that operation); `{pending: {type, operation}, resolve()}` (one it can say
   * once it has read: a turn the graph does not have yet, a plugin its catalog does not name yet); or null (not one, or not held here).
   */
  function classify(m, info = null) {
    const p = m?.params ?? {};
    const spec = APP_OPERATIONS[m?.method];
    if (spec?.on === 'agent') {
      // an act of the agent's (a thread's start, the session's skill roots): its CodexAgent
      if (appOwn && appOwn(m.method, p, false)) return { own: true };
      const snap = graph.resolve(codexRefs.agent());
      const args = snap && !snap.gone ? spec.args(p) : null;
      return args ? { ref: snap.ref, snap, operation: spec.operation, args, threadId: null, params: (a, was) => spec.params(p, a, was), caller: USER } : null;
    }
    if (spec) {
      if (typeof p.threadId !== 'string' || !p.threadId) return null;
      if (appOwn && appOwn(m.method, p, false)) return { own: true };   // the graph's own call, carried out by the app: it passed the mods already
      const make = (snap, args) => ({ ref: snap.ref, snap, operation: spec.operation, args, threadId: p.threadId, params: spec.params ? (a, was) => spec.params(p, a, was) : null, caller: USER });
      if (spec.on === 'turn') {
        // the turn it goes back to: as the graph has it, read first when it does not have it yet (built review H6m1)
        if (typeof p.beforeTurnId !== 'string' || !p.beforeTurnId) return null;
        const snap = graph.resolve(codexRefs.turn(p.beforeTurnId));
        if (snap && !snap.gone) return snap.links?.thread?.id === p.threadId ? make(snap, spec.args(p)) : { refuse: 'the turn is not that chat\'s', type: 'Turn', operation: spec.operation };
        return { pending: { type: 'Turn', operation: spec.operation }, resolve: async () => { const t = await turnOf(p.threadId, p.beforeTurnId); return t ? make(t, spec.args(p)) : null; },
          failed: 'the turn it goes back to could not be read' };
      }
      const snap = graph.resolve(codexRefs.thread(p.threadId));
      if (!snap || snap.gone) return null;
      if (m.method === 'thread/fork' && p.beforeTurnId != null) {
        // the turn before it, from the thread's whole history, read first
        return { pending: { type: snap.ref.type, operation: 'fork' }, failed: 'a fork up to before that turn cannot be said',
          resolve: async () => { const before = typeof p.beforeTurnId === 'string' ? await turnBefore(p.threadId, p.beforeTurnId) : null; return before ? { ...make(snap, [before.ref]), params: null } : null; } };
      }
      const args = spec.args(p);
      return args ? make(snap, args) : null;
    }
    if (!appOperation || !APP_AREA_METHODS.includes(m?.method)) return null;
    if (typeof m.id === 'string' && m.id.startsWith(`${m.method}:`)) return null;   // the app's main side's own (its bundled plugins' sync)
    let x;
    try { x = appOperation(m.method, p); } catch { x = null; }
    if (!x) return null;
    if (x.refuse) return { refuse: String(x.refuse), type: x.type, operation: x.operation, ...(Array.isArray(x.held) ? { held: x.held } : {}) };
    const caller = m.method === 'plugin/uninstall' && typeof p.pluginId === 'string' && agentsUninstall(p.pluginId, sessionOf(info)) ? APP : USER;
    const of = (y) => {
      const snap = y ? graph.resolve(y.ref) : null;
      if (!snap || snap.gone || snap.ref.provider !== provider) return null;
      return { ref: snap.ref, snap, operation: y.operation, args: Array.isArray(y.args) ? y.args : [], threadId: null, params: typeof y.params === 'function' ? (a) => y.params(a) : null, caller };
    };
    if (x.pending) return { pending: x.pending, resolve: async () => of(await x.resolve()), failed: x.failed ?? 'it could not be named' };
    return of(x);
  }
  /** What the graph would hold for this request, or null to let it pass. */
  function holdable(m, info = null) {
    const h = classify(m, info);
    if (!h || h.own) return null;
    if (h.refuse || h.pending) return (h.pending ? [[h.pending.type, h.pending.operation]] : h.held ?? [[h.type, h.operation]]).some(([t, op]) => graph.intercepted(t, op)) ? h : null;
    return graph.intercepted(h.ref.type, h.operation) ? h : null;
  }

  // Observed, not held (public-hooks.md §3.4): an app request nothing holds, whose operation a mod's `after` watches, is recorded once its
  // response came, passively (it is never held or changed for that). A held one is recorded by the graph when it decides it.
  const seen = new Map();   // a request's key -> {ref, operation, args}, until its response
  const ownMsgs = new Set();   // the keys of requests that were the graph's own calls (not recorded again)
  function observable(m, info = null) {
    const h = classify(m, info);
    if (!h || h.own || !h.ref || graph.intercepted(h.ref.type, h.operation) || !graph.observed?.(h.ref.type, h.operation)) return null;
    return { ref: h.ref, instance: h.snap, operation: h.operation, args: h.args, caller: h.caller };
  }
  const watched = [...Object.keys(APP_OPERATIONS), ...(appOperation ? APP_AREA_METHODS : [])];
  const watch = typeof client.observe === 'function' ? client.observe({ kinds: ['clientRequest', 'serverResponse', 'serverRequest', 'clientResponse', 'serverNotification'], methods: [...watched, 'item/tool/call', 'serverRequest/resolved'] }, (m, info) => {
    if (closed) return;
    // a server request resolved without the page's answer (cancelled, the turn ended): its agent call is over too (a notification: no id)
    if (info?.method === 'serverRequest/resolved') {
      const sid = String(m?.params?.requestId ?? '');
      if (callOfSid.has(sid)) { agentUninstalls.delete(callOfSid.get(sid)); callOfSid.delete(sid); }
      return;
    }
    if (m?.id === undefined) return;
    // the agent's uninstall_plugin: open from its request until the app answers it
    if (info?.method === 'item/tool/call') {
      if (info.kind === 'serverRequest' && m.params?.tool === AGENT_UNINSTALL && typeof m.params.callId === 'string') callOfSid.set(String(m.id), m.params.callId);
      else if (info.kind === 'clientResponse' && callOfSid.has(String(m.id))) { agentUninstalls.delete(callOfSid.get(String(m.id))); callOfSid.delete(String(m.id)); }
      return;
    }
    if (info?.origin !== 'app') return;
    // one request by its session, backend and id (with its type: 1 is not '1'; built review H6m1)
    const key = `${info.method}\n${sessionOf(info)}\n${info.backend ?? ''}\n${typeof m.id}:${m.id}`;
    if (info.kind === 'clientRequest') {
      if (ownMsgs.has(key)) { ownMsgs.delete(key); return; }   // the graph's own call: recorded by the graph
      const o = observable(m, info);
      if (!o) return;
      seen.set(key, o);
      if (seen.size > 200) seen.delete(seen.keys().next().value);
      return;
    }
    const o = seen.get(key);
    if (!o) return;
    seen.delete(key);
    const outcome = 'error' in m ? { status: 'failed', error: { message: String(m.error?.message ?? 'error') } } : { status: 'done', value: madeBy(o.operation, m.result, o.args) };
    try { graph.recordApp({ ...o, caller: o.caller ?? USER, origin: 'app', outcome }); } catch (e) { log.warn('app-ops: an observed operation was not recorded', { message: String(e?.message ?? e) }); }
  }) : null;

  /** A Stop let through ends the steers held on its thread (I8): there is no turn left for them. */
  function stopped(threadId) {
    for (const h of holds.values()) if (h.threadId === threadId && h.operation === 'steer') h.abort('stopped');
  }
  /** The user's Stop while the app's own send is still pending: the app has no turn to interrupt, so its Stop only cleans the thread's
   *  background terminals (renderer, 20770: the manager's interrupt with no turn id). On a thread with a held send that request is the
   *  user's Stop, and it cancels the held send (I8; G-intercept native run). */
  function stoppedBeforeStart(threadId) {
    for (const h of holds.values()) if (h.threadId === threadId && (h.operation === 'send' || h.operation === 'steer')) h.abort('stopped');
  }

  const ic = client.intercept('clientRequest', [...watched, STOP_WITHOUT_TURN], (m, info) => {
    if (closed || info.origin !== 'app') return undefined;
    const threadId = typeof m.params?.threadId === 'string' ? m.params.threadId : null;
    if (m.method === STOP_WITHOUT_TURN) { if (threadId) stoppedBeforeStart(threadId); return undefined; }
    // the graph's own call carried out by the app: taken once, so another request like it is not let through as well (review H6m1 r2)
    if (appOwn && APP_OPERATIONS[m.method] && threadId && appOwn(m.method, m.params ?? {}, true)) {
      ownMsgs.add(`${m.method}\n${sessionOf(info)}\n${info.backend ?? ''}\n${typeof m.id}:${m.id}`);
      if (ownMsgs.size > 200) ownMsgs.delete(ownMsgs.values().next().value);
      return undefined;
    }
    if (holdable(m, info)) return { defer: true };
    if (m.method === 'turn/interrupt' && threadId) stopped(threadId);
    return undefined;
  });

  const onDeferred = client.onDeferred(({ token, message, info }) => {
    if (info?.kind !== 'clientRequest') return;
    void hold(token, message, info);
  });
  async function hold(token, message, info) {
    let h = closed ? null : holdable(message, info);
    if (!h) { client.release(token).catch(() => {}); return; }   // nothing holds it any more
    const { signal, abort } = createAbort();
    holds.set(token, { abort, signal, threadId: h.threadId ?? null, operation: h.operation });
    // undecided under the mux's bound: refused, never let go undecided (built review H6m1), the request settled here whatever is still
    // pending (a catalog read, an interceptor within its own deadline: round 2)
    const limit = setTimeout(() => {
      abort('undecided');
      if (holds.delete(token)) client.respond(token, { error: { code: -32001, message: 'refused: not decided in time' } }).catch(() => {});
    }, holdLimitMs);
    limit.unref?.();
    const refuse = (message) => { holds.delete(token); clearTimeout(limit); client.respond(token, { error: { code: -32001, message } }).catch(() => {}); };
    // one it cannot say, or cannot name once read: refused while something holds that operation
    if (h.pending) {
      let x;
      try { x = await h.resolve(); } catch { x = null; }
      if (signal.aborted) { holds.delete(token); clearTimeout(limit); if (!APP_GONE.has(signal.reason)) refuse('cancelled'); return; }
      if (!x) { refuse(`refused: ${h.failed}`); return; }
      if (!graph.intercepted(x.ref.type, x.operation)) { holds.delete(token); clearTimeout(limit); client.release(token).catch(() => {}); return; }
      h = x;
    }
    if (h.refuse) { refuse(`refused: ${h.refuse}`); return; }
    const forward = async (args) => {
      const changed = JSON.stringify(args) !== JSON.stringify(h.args);
      // a change the request cannot say is refused, never dropped (H6m): the app is answered so at once (built review H6m1)
      const params = changed ? (h.params ? h.params(args, h.args) : null) : undefined;
      if (changed && !params) {
        const no = refused('unsupported', 'the app\'s request cannot carry that change');
        client.respond(token, { error: { code: -32001, message: `refused: ${no.message}` } }).catch(() => {});
        return no;
      }
      const r = await client.release(token, params ? { params } : undefined);
      if (h.operation === 'stop') stopped(h.threadId);
      if (!r?.released) return refused('unavailable', r?.reason ?? 'the request could not go on');
      const res = r.response;
      return res && 'error' in res ? failed(res.error?.message ?? 'error', res.error?.code === undefined ? undefined : String(res.error.code)) : done(madeBy(h.operation, res?.result, args));
    };
    graph.interceptApp({ ref: h.ref, operation: h.operation, args: h.args, caller: h.caller, origin: 'app', signal }, forward)
      .then((d) => { clearTimeout(limit); decide(token, d, signal); }, (e) => { clearTimeout(limit); log.warn('app-ops: a held operation failed; it goes on', { message: String(e?.message ?? e) }); decide(token, { decision: 'release' }, signal); });
  }

  /** Settle a hold by the graph's decision (I5, I6, I8). */
  function decide(token, d, signal) {
    if (!holds.delete(token)) return;   // settled already (its time ran out)
    const answer = (message) => client.respond(token, { error: { code: -32001, message } });
    try {
      switch (d.decision) {
        case 'forwarded': return;                                         // the request went on and the app has its answer
        case 'refuse': {
          const o = d.outcome ?? {};
          return answer(`refused by an interceptor: ${o.reason ?? 'notAllowed'}${o.message ? `: ${o.message}` : ''}`);
        }
        case 'handled': return answer('handled by an interceptor');
        // a mod stopped the app's request (graph-integrity G6.2): it ends with this answer; a quiet stop of the user's send is the composer's
        // (Draft.send, held in the page before the app sends)
        case 'stopped': return answer(`stopped by ${d.outcome?.by?.id ?? 'a mod'}${d.outcome?.message ? `: ${d.outcome.message}` : ''}`);
        case 'failed': return answer(`an interceptor that replaces this operation did not finish: ${d.reason ?? 'failed'}`);   // never also the app's own
        case 'cancelled':
          if (APP_GONE.has(signal.reason)) return;                         // the mux has closed the hold
          return answer(signal.reason === 'stopped' ? 'cancelled: the turn was stopped' : signal.reason === 'undecided' ? 'refused: not decided in time' : 'cancelled');
        default: client.release(token).catch(() => {});                   // release: as if it had never been held
      }
    } catch (e) { log.warn('app-ops: a hold could not be settled', { decision: d.decision, message: String(e?.message ?? e) }); }
  }

  // The mux ended a hold (the app went away, the hold expired, the mux closed): its interceptors are cancelled (I8).
  const onResolved = client.onResolved((token, reason) => { holds.get(token)?.abort(reason); });
  // A thread that goes away cancels what is held on it.
  const onEvent = graph.onEvent((e) => {
    if (e.kind !== 'removed' || e.ref?.provider !== provider) return;
    for (const h of holds.values()) if (h.threadId === e.ref.id) h.abort('gone');
  });

  return {
    /** Operations held right now (for diagnostics and tests). */
    get held() { return [...holds.values()].map((h) => ({ threadId: h.threadId, operation: h.operation })); },
    async dispose() {
      if (closed) return;
      closed = true;
      ic.dispose(); toolCalls?.dispose(); onDeferred.dispose(); onResolved.dispose(); onEvent.dispose(); for (const b of bindings) b.dispose(); watch?.dispose(); seen.clear();
      for (const h of holds.values()) h.abort('muxClosed');
      await client.dispose();   // the mux releases what this client still holds (I6)
    },
  };
}
