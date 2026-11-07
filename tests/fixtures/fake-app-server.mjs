#!/usr/bin/env node
// Fake `codex app-server` for automated tests. Speaks JSONL JSON-RPC on stdio like the real one. STRICT: it answers only what it models,
// below; any other request is refused with a JSON-RPC error that names it, any other client notification is refused (it cannot be answered:
// it is written to stderr and kept for `fake/refusals`), and it never echoes a method it does not model. Pulled from the frozen SDK 2 branch
// (its milestone-3 B0 version) by release-2.md §4, without the SDK 2 domain fixtures; integration.md §12.
// Usage: node fake-app-server.mjs app-server [--name <label>]
//
// Two modes.
//   REPLAY (env FAKE_APP_SERVER_CAPTURE=<capture file>; tests/fixtures/captures.mjs): it plays its session's script of a build-tagged capture of
//     the real app-server (the session named by --name, else the capture's "*" or only session; with env FAKE_APP_SERVER_CLAIMS=<dir>,
//     processes sharing a name take `<name>.1`, `<name>.2`, ... in the order they start), exactly as captured and in order: it answers the
//     client's next request as captured, sends the captured notifications and server requests as soon as the step before them is done, and
//     refuses anything off-script (an error naming the method and the step the capture expects; the script does not advance). Only
//     `fake/replay/status`, `fake/refusals` and `fake/exit` are answered besides the script. Real shapes come from here.
//   MODELLED (no capture): the behaviour below. Its payloads carry every field the schema of each build since 20770 requires (the newest, 21477, is its own protocol;
//     schema-check.mjs checks them in fake-app-server.test.mjs), with fake values; they are not a record of real values.
//
// Modelled protocol methods (the app-server's own, answered in its shapes):
//   initialize → {userAgent: "fake/<name>", codexHome, platformFamily, platformOs}; must precede everything else (other requests get error
//     -32002 before it). Client notification `initialized`.
//   thread/start → {thread: Thread "thr-<name>-<n>" with params.cwd, model: "fake", …}; then notification thread/started {thread}.
//   thread/resume, thread/fork → the same response for params.threadId (resume) or a new thread (fork).
//   thread/read {threadId} → {thread} for a thread this process created, else error -32600 "thread not found: <id>".
//   thread/list → {data: Thread[]} of threads this process created, sorted as Codex sorts: by params.sortKey ("created_at", the default;
//     "updated_at"; "recency_at", which falls back to updatedAt; "section_position", where the fake has no sections: creation order) in
//     params.sortDirection ("desc", the default, or "asc"); equal values keep creation order (reversed for "desc"). Threads this process
//     creates get increasing createdAt/updatedAt (T0 + 10 n, so a test can put a time between two of them); one it loads by resuming an
//     unknown id has T0. With params.limit it pages: nextCursor is the next offset into the sorted list as a string (omitted on the last
//     page), params.cursor the offset to start from. A bad sortKey or sortDirection is error -32602, a cursor that is not a non-negative
//     integer string error -32600, so a cursor of another party that leaks to Codex is caught.
//   thread/compact/start → {} then notification thread/compacted {threadId, turnId}.
//   turn/start {threadId} → {turn: Turn}; emits turn/started, item/agentMessage/delta x3 (with turnId and itemId), turn/completed.
//     After `fake/hold {threadId}` the next turn on that thread is left in progress (only turn/started) until turn/interrupt or
//     fake/finishTurn ends it.
//   turn/steer {threadId, expectedTurnId} → {turnId}; turn/interrupt {threadId, turnId} → {} (a held turn completes as "interrupted").
//   account/login/start → {type: "apiKey"}, or for {type: "chatgpt"} {type: "chatgpt", loginId, authUrl} (a fake auth.openai.com page).
//   account/logout → {}: the account is gone, then account/updated {authMode: null}.
//   account/read → {account: {type: "chatgpt", email, planType}, requiresOpenaiAuth}; account/rateLimits/read → {rateLimits, rateLimitsByLimitId:
//     {codex}}: one snapshot, a 5-hour primary window and a weekly secondary one (usedPercent, windowDurationMins, resetsAt in seconds).
//     `fake/account {account}` (an account or null) and `fake/rateLimits {primary, secondary, reached?}` change them and send
//     account/updated and account/rateLimits/updated.
//   History. Every turn/start records its turn on the thread: a userMessage item (id "<turn>-user", content = params.input), and, when the fake
//     streams the deltas, an agentMessage item (id "<turn>-msg", text "abc"); turn/steer on an in-progress turn adds a userMessage item
//     ("<turn>-steer-<n>"); the turn's status follows turn/completed (fake/finishTurn, turn/interrupt, the automatic completion). A held turn
//     streams no deltas, so its record has only the user message(s).
//   thread/turns/list {threadId, cursor?, limit?, itemsView?, sortDirection?} → {data: Turn[], nextCursor, backwardsCursor}: newest first
//     unless sortDirection "asc"; itemsView "full" (every item), "summary" (the default: the first userMessage and the last agentMessage) or
//     "notLoaded" (no items), each turn tagged with its itemsView. Cursors are anchors, not offsets: nextCursor continues after the page's
//     last turn, backwardsCursor starts at its first turn (pass it with the opposite sortDirection). A limit below 1 counts as 1.
//   thread/items/list {threadId, turnId?, cursor?, limit?, sortDirection?} → {data: ThreadItemEntry[], nextCursor, backwardsCursor}: the
//     thread's items (or one turn's) oldest first unless sortDirection "desc"; cursor is a returned string or {type: "item", itemId}
//     (exclusive, needs turnId). An unknown cursor, turn or thread is error -32600.
//   thread/revert {threadId, beforeTurnId} → {thread} (turns empty, as the real one): the turn and every later one leave the history (an
//     unknown turn is error -32600); thread/rollback {threadId, numTurns} (wire-only: the app sends it for an unpaginated thread) → {thread}
//     without its last numTurns turns. No notification (the app opts out of thread/reverted).
//   thread/archive {threadId} → {}, then thread/archived {threadId} (the thread is marked; thread/list still lists it).
//   thread/name/set {threadId, name} → {} (the name is trimmed, an empty one is error -32600; thread/read and thread/list show it as
//     Thread.name) then notification thread/name/updated {threadId, threadName}.
//   thread/goal/set {threadId, objective?, status?, tokenBudget?} → {goal: ThreadGoal} then thread/goal/updated {threadId, turnId, goal}
//     (turnId = the held turn, else null). A new objective makes a fresh goal (status "active"); without one the existing goal is updated
//     (error -32600 when the thread has none). thread/goal/get → {goal: ThreadGoal | null}. thread/goal/clear → {cleared: boolean}, and
//     thread/goal/cleared {threadId} only when there was a goal. Usage counters (tokensUsed, timeUsedSeconds) stay 0.
//   model/list {includeHidden?, cursor?, limit?} → {data: Model[], nextCursor}: the catalog of three fake models ("fake", the default, "fake-mini"
//     and "fake-old", which is hidden: listed only with includeHidden true). With params.limit it pages like thread/list (the next offset
//     as a string, omitted on the last page; a limit below 1 counts as 1). A cursor that is not a non-negative integer string is error
//     -32600, a limit that is not a non-negative integer or an includeHidden that is not a boolean is -32602. Threads report model "fake".
//   thread/unsubscribe {threadId} → {status}: "unsubscribed" for a thread this connection started, resumed or forked (once; it then reads
//     "notSubscribed"), "notSubscribed" for a known thread it is not subscribed to, "notLoaded" for an unknown one. Nothing else changes.
//   File system, on this machine's disk (absolute paths only: another is error -32602; a missing path error -32600 naming its code):
//     fs/readDirectory {path} → {entries: [{fileName, isDirectory, isFile}]} (symlinks followed); fs/getMetadata {path} → {isDirectory,
//     isFile, isSymlink, createdAtMs, modifiedAtMs} (no size, as the real one); fs/watch {watchId, path} → {path} (its real path; a watchId
//     in use is error -32600); fs/unwatch {watchId} → {}. Watches send nothing by themselves: fake/fsChanged does.
//     fs/createDirectory {path, recursive?} → {} (recursive unless false); fs/writeFile {path, dataBase64} → {} (written on this disk).
//   thread/attachment/list {threadId} → {data: ThreadAttachment[], nextCursor: null}: the attachments fake/attach gave the thread (none else).
// Area modules (breadth.md D5, D10): each file in fake-areas/ beside this one default-exports `(f) => ({ [method]: (m, p) => void })`
//   and models one feature area's methods, in their own file so areas are written apart. `f` is this process's state and senders (see
//   `areaContext` below); a method the switch below models is never handed to an area. Each area module documents its methods.
// Synthetic methods (SYNTHETIC below): names no real method has, which the mux and integration tests use to exercise routing, framing and
// interception. A synthetic request is answered {echo: {method, params}}; a synthetic client notification is accepted and does nothing; a
// synthetic server notification or server request is only ever sent through fake/notify or fake/serverRequest.
// Test controls (not part of the real protocol):
//   fake/serverRequest {method, params, resolve?} → sends that server→client request (one of the build's server requests, or a synthetic
//                                         one); result {answer} holds the client's reply. With resolve: true the server then sends
//                                         serverRequest/resolved {threadId, requestId}, as the real one does.
//   fake/notify {method, params}        → emits that notification (one of the build's server notifications, or a synthetic one).
//   fake/hold {threadId}                → the next turn/start on that thread stays in progress.
//   fake/finishTurn {threadId}          → completes the held turn of that thread (turn/completed, status "completed").
//   fake/forget {threadId, turnId?}     → the thread (or one of its turns) is gone, as if deleted elsewhere; nothing is notified.
//   fake/models {models}                → replaces the catalog model/list serves (Model[] of the build's schema; a new process starts with its own).
//   fake/fsChanged {path}               → fs/changed {watchId, changedPaths: [path]} for every watch of that path or of its folder.
//   fake/attach {threadId, attachmentType, identityKey, payload} → records the attachment and sends thread/attachment/updated (created).
//   fake/exit {code}                    → exits the process.
//   fake/slow {ms}                      → replies after ms.
//   fake/error {code, message}          → replies with that JSON-RPC error.
//   fake/refusals                       → {refusals: [{kind, method, reason}]}: everything refused so far.
//   fake/replay/status                  → (replay) {build, session, position, steps, done, pendingAnswers, refusals}.
// The build whose protocol fake/notify and fake/serverRequest check against: env FAKE_APP_SERVER_BUILD, else the newest in contracts/upstream.
// Env: FAKE_APP_SERVER_LOG=<file> appends every received line (for assertions).
import { createInterface } from 'node:readline';
import { appendFileSync, readdirSync, statSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCapture, sessionScript, contains, protocolMethods, newestBuild } from './captures.mjs';

const name = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : 'primary';
const log = process.env.FAKE_APP_SERVER_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ refusals (both modes)
const NOT_MODELLED = -32601;
const refusals = [];
/** Refuse what is not modelled: a request gets an error naming it; a notification or a response cannot be answered, so it is written to stderr. */
function refuse(kind, method, reason, id) {
  refusals.push({ kind, method: method ?? null, reason });
  process.stderr.write(`fake-app-server (${name}): refused ${kind} '${method}': ${reason}\n`);
  if (id !== undefined) fail(id, NOT_MODELLED, `fake app-server: ${kind} '${method}' refused: ${reason}`);
}

// ------------------------------------------------------------------ synthetic methods (MODELLED mode), with the tests that use them
const SYNTHETIC = {
  // answered {echo: {method, params}}
  request: {
    prefixes: ['echo/'],   // the mux tests' routing and framing probes (r1, r3-r5, r6, r7-r9, r10-r13, r14, r16, r18; integration passthrough)
    names: new Set([
      'x/y',                // mux defaults.test, r7-r9, r10-r13 (a request with no route, a pending request at close)
      'rej/resp',           // mux r6-interceptors.test (a rejected response)
    ]),
  },
  // accepted, no effect (they test the mux's client-notification routing: r6, r7-r9, r10-r13)
  clientNotification: new Set(['note/x', 'wake/up', 'client/kept', 'note/one', 'thread/x']),
  // sent only through fake/notify
  notification: new Set([
    'global/tick', 'global/changed', 'item/note',                                                            // mux r14, r3-r5
    'thread/ping', 'thread/ping2', 'thread/pong', 'thread/mine', 'thread/event', 'thread/zzz', 'thread/ev', // mux r3-r5, r16
    'drop/me', 'keep/me', 'bad/note', 'n/x', 'rej/note', 'ok/note',                                       // mux r6-interceptors
  ]),
  // sent only through fake/serverRequest
  serverRequest: new Set(['item/ask', 'item/approve', 'item/auto']),   // mux r3-r5, r6, r10-r13, r14
};
const syntheticRequest = (method) => SYNTHETIC.request.names.has(method) || SYNTHETIC.request.prefixes.some((p) => method.startsWith(p));
let protocol = null;
const protocolOf = () => (protocol ??= (() => { const build = process.env.FAKE_APP_SERVER_BUILD ?? newestBuild(); return { build, ...protocolMethods(build) }; })());

// ------------------------------------------------------------------ REPLAY mode
function replay(file) {
  const capture = loadCapture(file);
  const { label, script } = sessionScript(capture, name, process.env.FAKE_APP_SERVER_CLAIMS);
  let pos = 0, srvSeq = 0;
  const pending = new Map();   // server request id → the answer the capture expects (or undefined)
  const describe = (s) => (s ? `${Object.keys(s).find((k) => ['client', 'clientNotification', 'notify', 'serverRequest'].includes(k))} '${s.client ?? s.clientNotification ?? s.notify ?? s.serverRequest}'` : 'nothing (the script is done)');
  /** Send every notification and server request that follows the step just done, up to the next thing the client must send. */
  const advance = () => {
    while (pos < script.length && ('notify' in script[pos] || 'serverRequest' in script[pos])) {
      const s = script[pos++];
      if ('notify' in s) notify(s.notify, s.params ?? {});
      else { const id = `cap-${++srvSeq}`; pending.set(id, s.answer); send({ id, method: s.serverRequest, params: s.params ?? {} }); }
    }
  };
  const status = () => ({ build: capture.build, session: label, position: pos, steps: script.length, done: pos === script.length && pending.size === 0, pendingAnswers: pending.size, refusals });
  advance();
  return (m) => {
    if (m.method === undefined && m.id !== undefined) {   // the client's answer to a captured server request
      if (!pending.has(m.id)) return refuse('response', String(m.id), 'no captured server request has this id');
      const want = pending.get(m.id); pending.delete(m.id);
      if (want !== undefined && !contains(m.result, want)) refuse('response', String(m.id), `the answer differs from the captured one (${JSON.stringify(want)})`);
      return undefined;
    }
    const next = script[pos];
    if (m.id === undefined) {   // a client notification
      if (next && next.clientNotification === m.method && (next.params === undefined || contains(m.params ?? {}, next.params))) { pos++; return advance(); }
      return refuse('notification', m.method, `off-script: the capture expects ${describe(next)}`);
    }
    if (m.method === 'fake/replay/status') return reply(m.id, status());
    if (m.method === 'fake/refusals') return reply(m.id, { refusals });
    if (m.method === 'fake/exit') { reply(m.id, {}); return setTimeout(() => process.exit(m.params?.code ?? 0), 10); }
    if (next && next.client === m.method && (next.params === undefined || contains(m.params ?? {}, next.params))) {
      pos++;
      if ('error' in next) fail(m.id, next.error.code, next.error.message); else reply(m.id, next.result);
      return advance();
    }
    const why = next && next.client === m.method ? `its params differ from the captured ones (${JSON.stringify(next.params)})` : `the capture expects ${describe(next)}`;
    return refuse('request', m.method, `off-script: ${why}`, m.id);
  };
}

// ------------------------------------------------------------------ MODELLED mode
const T0 = 1792540000;   // fake Unix seconds; values are placeholders, shapes are the build's
/** A Thread with every field the schema requires; `at` is its createdAt and updatedAt (fake Unix seconds). */
const threadOf = (id, cwd, at = T0) => ({
  id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, projectId: null, modelProvider: 'openai', model: 'fake',
  reasoningEffort: null, createdAt: at, updatedAt: at, status: { type: 'idle' }, path: null, cwd, cliVersion: '0.0.0-fake', source: 'vscode',
  agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
});
/** thread/start, thread/resume and thread/fork answer with the thread and its session settings. */
const sessionOf = (thread) => ({
  thread, model: 'fake', modelProvider: 'openai', serviceTier: null, cwd: thread.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
  sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null,
});
const turnOf = (id, status) => ({ id, items: [], status, error: null });
const SORT_FIELD = { created_at: 'createdAt', updated_at: 'updatedAt', recency_at: 'recencyAt' };   // ThreadSortKey; section_position has no field here
/** A Model with every field the schema requires. */
const modelOf = (id, o = {}) => ({
  id, model: id, displayName: o.displayName ?? id, description: o.description ?? `The ${id} model`, hidden: o.hidden ?? false, isDefault: o.isDefault ?? false,
  defaultReasoningEffort: o.defaultReasoningEffort ?? 'medium',
  supportedReasoningEfforts: (o.efforts ?? ['low', 'medium', 'high']).map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` })),
});
const CATALOG = () => [
  modelOf('fake', { displayName: 'Fake', description: 'The fake app-server\'s default model', isDefault: true }),
  modelOf('fake-mini', { displayName: 'Fake mini', description: 'A smaller fake model', efforts: ['low'], defaultReasoningEffort: 'low' }),
  modelOf('fake-old', { displayName: 'Fake old', description: 'A model the picker no longer offers', hidden: true, efforts: [] }),
];
const GOAL_STATUS = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];   // ThreadGoalStatus

function modelled() {
  let initialized = false, threadSeq = 0, turnSeq = 0, serverReqSeq = 0;
  const threads = new Map();   // id → Thread
  const holdNext = new Set();  // thread ids whose next turn is held
  let nextPreview = null;      // fake/next-preview: the next started thread's first message (the real app's chats say it once their turn starts)
  const held = new Map();      // thread id → held turn id
  const pendingServer = new Map();
  const history = new Map();   // thread id → turn records, oldest first: {id, status, startedAt, completedAt, items: ThreadItem[]}
  const goals = new Map();     // thread id → ThreadGoal
  let models = CATALOG();      // what model/list serves
  let account = { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' };
  const snapshot = ({ primary = 12, secondary = 40, reached = null } = {}) => ({
    limitId: 'codex', limitName: null, planType: 'pro', credits: null, rateLimitReachedType: reached,
    primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1792003600 }, secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: 1792600000 },
  });
  let limits = snapshot();
  const subscribed = new Set();   // thread ids this connection started, resumed or forked (thread/unsubscribe)
  let tick = 0;
  const stamp = () => T0 + ++tick;
  const historyOf = (id) => { let h = history.get(id); if (!h) history.set(id, h = []); return h; };
  const recordOf = (threadId, turnId) => history.get(threadId)?.find((r) => r.id === turnId);
  const finish = (threadId, turnId, status) => { const r = recordOf(threadId, turnId); if (r) { r.status = status; r.completedAt = T0; } };
  /** The thread named by params.threadId, or null after replying with the error: -32602 for a bad id, -32600 for one this process does not know (as thread/read). */
  const threadFor = (m, p) => {
    if (typeof p.threadId !== 'string' || !p.threadId) { fail(m.id, -32602, 'Invalid params: threadId must be a non-empty string'); return null; }
    const t = threads.get(p.threadId);
    if (!t) fail(m.id, -32600, `thread not found: ${p.threadId}`);
    return t ?? null;
  };
  /** Page of `list` (already in the requested order) from an anchor cursor: `after:<id>` starts after that entry, `from:<id>` at it. */
  const pageOf = (list, idOf, cursor, limit) => {
    let start = 0;
    if (cursor !== undefined && cursor !== null) {
      const match = typeof cursor === 'string' ? /^(after|from):(.+)$/.exec(cursor) : null;
      const at = match ? list.findIndex((e) => idOf(e) === match[2]) : -1;
      if (at < 0) return { error: `invalid cursor: ${JSON.stringify(cursor)}` };
      start = match[1] === 'after' ? at + 1 : at;
    }
    const data = list.slice(start, typeof limit === 'number' ? start + Math.max(1, limit) : undefined);
    return { data, nextCursor: start + data.length < list.length ? `after:${idOf(data.at(-1))}` : null, backwardsCursor: data.length ? `from:${idOf(data[0])}` : null };
  };
  /** A recorded turn as thread/turns/list shows it under an itemsView. */
  const turnView = (r, view) => {
    const first = r.items.find((i) => i.type === 'userMessage'), last = r.items.findLast((i) => i.type === 'agentMessage');
    const items = view === 'full' ? r.items : view === 'summary' ? r.items.filter((i) => i === first || i === last) : [];
    return { id: r.id, items: structuredClone(items), status: r.status, error: null, itemsView: view, startedAt: r.startedAt, completedAt: r.completedAt, durationMs: null, rootTurnId: null };
  };
  const cwdOf = (p) => (typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd());
  const newThread = (cwd) => { const t = threadOf(`thr-${name}-${++threadSeq}`, cwd, T0 + 10 * threadSeq); threads.set(t.id, t); return t; };
  /** The threads in the order thread/list gives them (see the header). Null after replying with the error for a bad sortKey or sortDirection. */
  const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
  const listed = (m, p) => {
    if (![undefined, null, ...Object.keys(SORT_FIELD), 'section_position'].includes(p.sortKey)) { fail(m.id, -32602, `Invalid params: sortKey '${p.sortKey}'`); return null; }
    if (![undefined, null, 'asc', 'desc'].includes(p.sortDirection)) { fail(m.id, -32602, `Invalid params: sortDirection '${p.sortDirection}'`); return null; }
    // Every thread here is an interactive one recorded under the default provider, so the filters only need to be well formed.
    if (p.sourceKinds != null && !(Array.isArray(p.sourceKinds) && p.sourceKinds.every((k) => SOURCE_KINDS.includes(k)))) { fail(m.id, -32602, 'Invalid params: sourceKinds'); return null; }
    if (p.modelProviders != null && !(Array.isArray(p.modelProviders) && p.modelProviders.every((x) => typeof x === 'string'))) { fail(m.id, -32602, 'Invalid params: modelProviders'); return null; }
    const sign = p.sortDirection === 'asc' ? 1 : -1;
    const field = SORT_FIELD[p.sortKey ?? 'created_at'];
    const value = (t) => (field === 'recencyAt' ? t.recencyAt ?? t.updatedAt : t[field]);
    const all = [...threads.values()].filter((t) => !t.ephemeral).map((t, i) => ({ t, i }));
    if (field === undefined) return all.map((e) => e.t);   // section_position: no sections, so creation order
    return all.sort((a, b) => sign * (value(a.t) - value(b.t)) || sign * (a.i - b.i)).map((e) => e.t);
  };
  /** fake/notify and fake/serverRequest send only what the build's protocol declares, or a synthetic name. */
  const sendable = (kind, method) => {
    if (typeof method !== 'string' || !method) return 'no method';
    const p = protocolOf();
    if (kind === 'notification' ? p.serverNotification.has(method) || SYNTHETIC.notification.has(method) : p.serverRequest.has(method) || SYNTHETIC.serverRequest.has(method)) return null;
    return `not a server ${kind} of build ${p.build}, nor a synthetic one`;
  };

  /** What an area module (fake-areas/) gets: this process's state and senders. */
  const areaContext = Object.freeze({
    name, T0, reply, fail, notify, refuse, isObject, sendable, stamp, cwdOf, newThread, threadFor, threadOf, sessionOf, turnOf, pageOf,
    threads, subscribed, history, historyOf,
  });
  const areaMethods = {};
  for (const make of AREAS) for (const [method, fn] of Object.entries(make(areaContext))) if (typeof fn === 'function' && !Object.hasOwn(areaMethods, method)) areaMethods[method] = fn;
  const fsWatches = new Map();   // watchId -> path
  const attachments = new Map(); // threadId -> ThreadAttachment[]
  function fsRequest(m, p) {
    if (m.method === 'fs/unwatch') { fsWatches.delete(p.watchId); return reply(m.id, {}); }
    if (typeof p.path !== 'string' || !isAbsolute(p.path)) return fail(m.id, -32602, `path must be absolute: ${JSON.stringify(p.path)}`);
    try {
      if (m.method === 'fs/readDirectory') {
        return reply(m.id, { entries: readdirSync(p.path).map((fileName) => { const st = statSync(join(p.path, fileName)); return { fileName, isDirectory: st.isDirectory(), isFile: st.isFile() }; }) });
      }
      if (m.method === 'fs/createDirectory') { mkdirSync(p.path, { recursive: p.recursive !== false }); return reply(m.id, {}); }
      if (m.method === 'fs/writeFile') {
        if (typeof p.dataBase64 !== 'string') return fail(m.id, -32602, 'dataBase64 is required');
        writeFileSync(p.path, Buffer.from(p.dataBase64, 'base64'));
        return reply(m.id, {});
      }
      if (m.method === 'fs/getMetadata') {
        const st = statSync(p.path);
        return reply(m.id, { isDirectory: st.isDirectory(), isFile: st.isFile(), isSymlink: lstatSync(p.path).isSymbolicLink(), createdAtMs: Math.round(st.birthtimeMs), modifiedAtMs: Math.round(st.mtimeMs) });
      }
      if (typeof p.watchId !== 'string' || !p.watchId) return fail(m.id, -32602, 'watchId is required');
      if (fsWatches.has(p.watchId)) return fail(m.id, -32600, `watch already exists: ${p.watchId}`);
      const real = realpathSync(p.path);
      fsWatches.set(p.watchId, p.path);
      return reply(m.id, { path: real });
    } catch (e) { return fail(m.id, -32600, `${m.method} ${p.path}: ${e.code ?? e.message}`); }
  }

  return async (m) => {
    if (m.method === undefined && m.id !== undefined) {           // client's response to our server request
      const resolve = pendingServer.get(m.id);
      if (!resolve) return refuse('response', String(m.id), 'no server request has this id');
      pendingServer.delete(m.id); return resolve(m);
    }
    if (m.id === undefined) {                                      // a client notification
      if (m.method === 'initialized' || SYNTHETIC.clientNotification.has(m.method)) return undefined;
      return refuse('notification', m.method, 'not modelled');
    }
    const p = isObject(m.params) ? m.params : {};
    if (m.method === 'initialize') {
      initialized = true;
      return reply(m.id, { userAgent: `fake/${name}`, codexHome: process.env.CODEX_HOME || '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'macos' });
    }
    if (!initialized) return fail(m.id, -32002, 'Not initialized');
    switch (m.method) {
      case 'thread/start': {
        const t = newThread(cwdOf(p));
        if (p.ephemeral === true) t.ephemeral = true;   // never materialized: not listed, no history to read
        if (nextPreview !== null) { t.preview = nextPreview; nextPreview = null; }
        subscribed.add(t.id);
        reply(m.id, sessionOf(t));
        return notify('thread/started', { thread: t });
      }
      case 'thread/resume': case 'thread/fork': {
        if (m.method === 'thread/fork') { const t = newThread(cwdOf(p)); t.forkedFromId = p.threadId ?? null; subscribed.add(t.id); return reply(m.id, sessionOf(t)); }
        let t = threads.get(p.threadId);
        if (!t) { t = p.threadId ? threadOf(p.threadId, cwdOf(p)) : newThread(cwdOf(p)); threads.set(t.id, t); }   // resuming loads it
        subscribed.add(t.id);
        return reply(m.id, sessionOf(t));
      }
      case 'thread/read': {
        const t = threads.get(p.threadId);
        if (!t) return fail(m.id, -32600, `thread not found: ${p.threadId}`);
        return reply(m.id, { thread: t });
      }
      case 'thread/list': {
        const all = listed(m, p);
        if (!all) return undefined;
        if (p.cursor !== undefined && p.cursor !== null && !/^\d+$/.test(String(p.cursor))) return fail(m.id, -32600, `invalid cursor: ${JSON.stringify(p.cursor)}`);
        if (p.archived === true) return reply(m.id, { data: [], nextCursor: null });   // the fake models no archiving: no archived threads
        if (typeof p.limit !== 'number') return reply(m.id, { data: all, nextCursor: null });
        const from = Number(p.cursor) || 0;
        const page = all.slice(from, from + p.limit).map((t) => ({ ...t, status: { type: 'notLoaded' } }));
        return reply(m.id, from + p.limit < all.length ? { data: page, nextCursor: String(from + p.limit) } : { data: page });
      }
      case 'model/list': {
        if (p.includeHidden != null && typeof p.includeHidden !== 'boolean') return fail(m.id, -32602, 'Invalid params: includeHidden must be a boolean or null');
        if (p.limit != null && !(Number.isInteger(p.limit) && p.limit >= 0)) return fail(m.id, -32602, 'Invalid params: limit must be a non-negative integer or null');
        if (p.cursor != null && !/^\d+$/.test(String(p.cursor))) return fail(m.id, -32600, `invalid cursor: ${JSON.stringify(p.cursor)}`);
        const all = models.filter((x) => p.includeHidden === true || !x.hidden);
        if (p.limit == null) return reply(m.id, { data: structuredClone(all) });
        const from = Number(p.cursor) || 0, size = Math.max(1, p.limit);
        const data = structuredClone(all.slice(from, from + size));
        return reply(m.id, from + size < all.length ? { data, nextCursor: String(from + size) } : { data });
      }
      case 'thread/loaded/list': return reply(m.id, { data: [...subscribed], nextCursor: null });   // loaded = subscribed here
      case 'thread/compact/start': reply(m.id, {}); return notify('thread/compacted', { threadId: p.threadId, turnId: `turn-${turnSeq}` });
      case 'turn/start': {
        const turn = `turn-${++turnSeq}`;
        const record = { id: turn, status: 'inProgress', startedAt: T0, completedAt: null, items: [{ type: 'userMessage', id: `${turn}-user`, content: Array.isArray(p.input) ? p.input : [] }] };
        historyOf(p.threadId).push(record);
        reply(m.id, { turn: turnOf(turn, 'inProgress') });
        notify('turn/started', { threadId: p.threadId, turn: turnOf(turn, 'inProgress') });
        if (holdNext.delete(p.threadId)) { held.set(p.threadId, turn); return undefined; }
        let text = '';
        for (const d of ['a', 'b', 'c']) { text += d; notify('item/agentMessage/delta', { threadId: p.threadId, turnId: turn, itemId: `${turn}-msg`, delta: d }); }
        record.items.push({ type: 'agentMessage', id: `${turn}-msg`, text });
        finish(p.threadId, turn, 'completed');
        return notify('turn/completed', { threadId: p.threadId, turn: turnOf(turn, 'completed') });
      }
      case 'turn/steer': {
        const turnId = p.expectedTurnId ?? held.get(p.threadId) ?? `turn-${turnSeq}`;
        const record = recordOf(p.threadId, turnId);
        if (record?.status === 'inProgress') record.items.push({ type: 'userMessage', id: `${turnId}-steer-${record.items.length}`, content: Array.isArray(p.input) ? p.input : [] });
        return reply(m.id, { turnId });
      }
      case 'turn/interrupt': {
        // a turn that runs in another chat than the one named: refused, as the real server refuses it
        if ([...held].some(([thread, turn]) => turn === p.turnId && thread !== p.threadId)) return fail(m.id, -32600, `turn ${p.turnId} is not running in ${p.threadId}`);
        reply(m.id, {});
        if (held.get(p.threadId) === p.turnId) { held.delete(p.threadId); finish(p.threadId, p.turnId, 'interrupted'); notify('turn/completed', { threadId: p.threadId, turn: turnOf(p.turnId, 'interrupted') }); }
        return undefined;
      }
      case 'thread/revert': case 'thread/rollback': {
        const t = threadFor(m, p);
        if (!t) return undefined;
        const h = historyOf(t.id);
        const from = m.method === 'thread/revert' ? h.findIndex((r) => r.id === p.beforeTurnId) : Number.isInteger(p.numTurns) && p.numTurns > 0 ? Math.max(0, h.length - p.numTurns) : -1;
        if (from < 0) return fail(m.id, -32600, m.method === 'thread/revert' ? `turn not found: ${p.beforeTurnId}` : 'Invalid params: numTurns must be a positive integer');
        h.splice(from);
        return reply(m.id, { thread: { ...t, turns: [] }, ...(m.method === 'thread/revert' ? { itemsBackwardsCursor: null, turnsBackwardsCursor: null } : {}) });
      }
      case 'thread/turns/list': {
        const t = threadFor(m, p); if (!t) return undefined;
        if (t.ephemeral) return fail(m.id, -32600, 'ephemeral threads do not support thread/turns/list');
        if (![undefined, null, 'asc', 'desc'].includes(p.sortDirection)) return fail(m.id, -32602, `Invalid params: sortDirection '${p.sortDirection}'`);
        if (![undefined, null, 'notLoaded', 'summary', 'full'].includes(p.itemsView)) return fail(m.id, -32602, `Invalid params: itemsView '${p.itemsView}'`);
        const ordered = [...historyOf(t.id)]; if (p.sortDirection !== 'asc') ordered.reverse();
        const page = pageOf(ordered, (r) => r.id, p.cursor, p.limit);
        if (page.error) return fail(m.id, -32600, page.error);
        return reply(m.id, { ...page, data: page.data.map((r) => turnView(r, p.itemsView ?? 'summary')) });
      }
      case 'thread/items/list': {
        const t = threadFor(m, p); if (!t) return undefined;
        if (![undefined, null, 'asc', 'desc'].includes(p.sortDirection)) return fail(m.id, -32602, `Invalid params: sortDirection '${p.sortDirection}'`);
        const turnId = typeof p.turnId === 'string' && p.turnId ? p.turnId : null;
        const turns = historyOf(t.id).filter((r) => turnId === null || r.id === turnId);
        if (turnId !== null && !turns.length) return fail(m.id, -32600, `turn not found: ${turnId}`);
        const entries = turns.flatMap((r) => r.items.map((item) => ({ item: structuredClone(item), turnId: r.id, startedAtMs: T0 * 1000, completedAtMs: T0 * 1000 })));
        if (p.sortDirection === 'desc') entries.reverse();
        let cursor = p.cursor;
        if (isObject(cursor)) {   // an exclusive item anchor, within the one turn
          if (cursor.type !== 'item' || typeof cursor.itemId !== 'string' || turnId === null) return fail(m.id, -32600, 'an item anchor needs type "item", an itemId and a turnId');
          cursor = `after:${cursor.itemId}`;
        }
        const page = pageOf(entries, (e) => e.item.id, cursor, p.limit);
        if (page.error) return fail(m.id, -32600, page.error);
        return reply(m.id, page);
      }
      case 'thread/archive': {   // the fake keeps no archived list: the thread is only marked, and the notification sent
        const t = threadFor(m, p); if (!t) return undefined;
        t.archived = true;
        reply(m.id, {});
        return notify('thread/archived', { threadId: t.id });
      }
      case 'thread/name/set': {
        const t = threadFor(m, p); if (!t) return undefined;
        if (typeof p.name !== 'string') return fail(m.id, -32602, 'Invalid params: name must be a string');
        const name = p.name.trim();
        if (!name) return fail(m.id, -32600, 'thread name must not be empty');
        t.name = name;
        reply(m.id, {});
        return notify('thread/name/updated', { threadId: t.id, threadName: name });
      }
      case 'thread/goal/set': {
        const t = threadFor(m, p); if (!t) return undefined;
        if (p.objective != null && typeof p.objective !== 'string') return fail(m.id, -32602, 'Invalid params: objective must be a string or null');
        if (p.status != null && !GOAL_STATUS.includes(p.status)) return fail(m.id, -32602, `Invalid params: status '${p.status}'`);
        if (p.tokenBudget != null && !Number.isInteger(p.tokenBudget)) return fail(m.id, -32602, 'Invalid params: tokenBudget must be an integer or null');
        const objective = typeof p.objective === 'string' ? p.objective.trim() : undefined;
        if (objective === '') return fail(m.id, -32600, 'goal objective must not be empty');
        const prev = goals.get(t.id);
        if (objective === undefined && !prev) return fail(m.id, -32600, `cannot set a goal without an objective: thread ${t.id} has none`);
        const at = stamp();
        const goal = prev && (objective === undefined || objective === prev.objective)
          ? { ...prev, updatedAt: at }
          : { threadId: t.id, objective, status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: at, updatedAt: at };
        if (p.status != null) goal.status = p.status;
        if (p.tokenBudget !== undefined) goal.tokenBudget = p.tokenBudget;
        goals.set(t.id, goal);
        reply(m.id, { goal });
        return notify('thread/goal/updated', { threadId: t.id, turnId: held.get(t.id) ?? null, goal });
      }
      case 'thread/goal/get': {
        const t = threadFor(m, p); if (!t) return undefined;
        return reply(m.id, { goal: goals.get(t.id) ?? null });
      }
      case 'thread/goal/clear': {
        const t = threadFor(m, p); if (!t) return undefined;
        const cleared = goals.delete(t.id);
        reply(m.id, { cleared });
        return cleared ? notify('thread/goal/cleared', { threadId: t.id }) : undefined;
      }
      case 'thread/unsubscribe': {
        if (typeof p.threadId !== 'string' || !p.threadId) return fail(m.id, -32602, 'Invalid params: threadId must be a non-empty string');
        return reply(m.id, { status: subscribed.delete(p.threadId) ? 'unsubscribed' : threads.has(p.threadId) ? 'notSubscribed' : 'notLoaded' });
      }
      case 'account/login/start':
        return reply(m.id, p.type === 'chatgpt' ? { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/oauth/authorize?fake=1' } : { type: 'apiKey' });
      case 'account/logout':
        account = null;
        reply(m.id, {});
        return notify('account/updated', { authMode: null, planType: null });
      case 'account/read': return reply(m.id, { account: structuredClone(account), requiresOpenaiAuth: true });
      case 'account/rateLimits/read': return reply(m.id, { rateLimits: structuredClone(limits), rateLimitsByLimitId: { codex: structuredClone(limits) } });
      case 'fake/account':
        account = p.account === null ? null : { ...account, ...(p.account ?? {}) };
        reply(m.id, {});
        return notify('account/updated', { authMode: account ? 'chatgpt' : null, planType: account?.planType ?? null });
      case 'fake/rateLimits':
        limits = snapshot(p);
        reply(m.id, {});
        return notify('account/rateLimits/updated', { rateLimits: structuredClone(limits) });
      case 'fake/models':
        if (!Array.isArray(p.models)) return fail(m.id, -32602, 'Invalid params: models must be a list');
        models = structuredClone(p.models);
        return reply(m.id, {});
      case 'fake/hold': holdNext.add(p.threadId); return reply(m.id, {});
      case 'fake/next-preview': nextPreview = typeof p.text === 'string' ? p.text : null; return reply(m.id, {});
      case 'fake/forget': {
        if (p.turnId) { const h = historyOf(p.threadId); const i = h.findIndex((r) => r.id === p.turnId); if (i >= 0) h.splice(i, 1); }
        else { threads.delete(p.threadId); history.delete(p.threadId); subscribed.delete(p.threadId); }
        return reply(m.id, {});
      }
      case 'fake/finishTurn': {
        reply(m.id, {});
        const turn = held.get(p.threadId);
        if (turn) { held.delete(p.threadId); finish(p.threadId, turn, 'completed'); notify('turn/completed', { threadId: p.threadId, turn: turnOf(turn, 'completed') }); }
        return undefined;
      }
      case 'fake/serverRequest': {
        const no = sendable('request', p.method);
        if (no) return refuse('server request', p.method, no, m.id);
        const id = `srv-${++serverReqSeq}`;
        const answer = new Promise((r) => pendingServer.set(id, r));
        send({ id, method: p.method, params: p.params ?? {} });
        const a = await answer;
        if (p.resolve) notify('serverRequest/resolved', { threadId: p.params?.threadId, requestId: id });
        return reply(m.id, { answer: a });
      }
      case 'fs/readDirectory': case 'fs/getMetadata': case 'fs/createDirectory': case 'fs/writeFile': case 'fs/watch': case 'fs/unwatch': return fsRequest(m, p);
      case 'thread/attachment/list': return reply(m.id, { data: attachments.get(p.threadId) ?? [], nextCursor: null });
      case 'fake/attach': {
        const a = { id: `att-${attachments.size + 1}`, attachmentType: String(p.attachmentType), identityKey: String(p.identityKey), createdAt: 1792000000, payload: p.payload ?? null };
        attachments.set(p.threadId, [...(attachments.get(p.threadId) ?? []), a]);
        reply(m.id, {});
        return notify('thread/attachment/updated', { threadId: p.threadId, attachmentId: a.id, attachmentType: a.attachmentType, identityKey: a.identityKey, operation: 'created' });
      }
      case 'fake/fsChanged': {
        reply(m.id, {});
        for (const [watchId, path] of fsWatches) if (path === p.path || path === dirname(p.path)) notify('fs/changed', { watchId, changedPaths: [p.path] });
        return undefined;
      }
      case 'fake/notify': {
        const no = sendable('notification', p.method);
        if (no) return refuse('server notification', p.method, no, m.id);
        reply(m.id, {}); return notify(p.method, p.params ?? {});
      }
      case 'fake/exit': reply(m.id, {}); return setTimeout(() => process.exit(p.code ?? 0), 10);
      case 'fake/slow': return setTimeout(() => reply(m.id, { slept: p.ms }), p.ms);
      case 'fake/error': return fail(m.id, p.code ?? -32000, p.message ?? 'fake error');
      case 'fake/refusals': return reply(m.id, { refusals });
      default:
        if (typeof m.method === 'string' && Object.hasOwn(areaMethods, m.method)) return areaMethods[m.method](m, p);
        if (typeof m.method === 'string' && syntheticRequest(m.method)) return reply(m.id, { echo: { method: m.method, params: m.params ?? {} } });
        return refuse('request', m.method, 'not modelled', m.id);
    }
  };
}

/** The area modules (fake-areas/*.mjs), in name order. */
const AREAS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fake-areas');
const AREAS = [];
for (const f of (() => { try { return readdirSync(AREAS_DIR).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs')).sort(); } catch { return []; } })()) {
  const mod = await import(pathToFileURL(join(AREAS_DIR, f)).href);
  if (typeof mod.default === 'function') AREAS.push(mod.default);
}
const handle = process.env.FAKE_APP_SERVER_CAPTURE ? replay(process.env.FAKE_APP_SERVER_CAPTURE) : modelled();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (log) appendFileSync(log, `${name} ${line}\n`);
  let m; try { m = JSON.parse(line); } catch { return refuse('line', null, 'not JSON'); }
  if (!isObject(m)) return refuse('line', null, 'not a JSON-RPC message');
  return handle(m);
});
