// The native provider's protocol source (docs/design/runtime-core.md R10, R11; integration.md §4): CodexAgent and its Models, Thread, Turn,
// Message, Step and Request from the app-server, through the mux.
// - It is an in-process mux client (`graph:codex`, experimentalApi via the app's session). Its one notification feed is the mux's
//   observer stream, which sees every frame of the app's primary backends once, in order, whichever client it goes to; the app's own
//   reads (thread/list, thread/read, ...) refresh it for free. Its own client sends requests only: reads, and C2's operations.
// - The Thread collection is partial until every page of thread/list (active and archived, every source kind and model provider) has been
//   read. A complete read is authoritative: the threads it no longer lists are removed, with everything in them, except those put while it
//   ran. A backend restart or an observer gap marks the instances stale until they are read again (contract rules Completeness,
//   Freshness, Reconciliation; boundary review R1).
// - A thread's turns, messages and steps load when a realm observes the thread or its relations (onObserve, which returns the loading
//   promise), and stay live from the notifications. A full load replaces the thread's turns. The app-server sends a thread's notifications
//   only while a client is subscribed to it, and nothing happens on a thread nobody is subscribed to; so when a loaded thread is subscribed
//   again (the mux says so), its newest turns are read once to catch up. Requests come from server requests; their answers and resolutions
//   from the client responses and serverRequest/resolved.
// - The one native agent, CodexAgent, is put when the source is created: its name and icon are constants, and it is available while the
//   app-server is (it is unavailable from a backend crash until the next read succeeds). Its models come from model/list (every page,
//   hidden ones too: they are the ones not available), read with the thread list whenever the app-server is ready and again on
//   account/updated and account/login/completed, since the catalog depends on the account. A model the catalog no longer lists is removed.
// - Thread.unread is the app's own read state, not the protocol's (the app ignores the protocol's read receipts): it comes from the Host's
//   read-state store (../../read-state.mjs, fed by framework-main's `threadReadState` session) when the Host hands one in, when a thread is
//   put and whenever the store changes; without a store it is false.
// - Named events (docs/graph/04 §3) follow the protocol's notifications, never a read: Thread created, titleChanged, statusChanged,
//   turnStarted, turnFinished, requestOpened, archived, restored, deleted; Turn started, stepAdded, completed, stopped, failed; Step started
//   and finished; AgentMessage updated and completed; Request opened, answered, cancelled; Agent and Model availabilityChanged.
// Requests are answered at the mux, as the app would answer them (breadth.md D2): Approval.approve(once | thread | always: a mod's "always"
// needs the user's approval, runtime-core.md R17) and deny, Question.answer;
// Question.skip does what dismissing the question does in the app (it interrupts the turn). The answer is observed like the app's, and the
// app's own later answer is dropped.
// Operations: Thread.rename, setGoal and clearGoal (protocol-backed, nothing added around them by the app), and Thread.markRead (through the
// read-state store, effect local; refused `unavailable` while the app has no read-state session). The other core operations need the app's
// own path and are refused `unavailable` until those bindings land. While the app-server is down (from a crash until it is ready again) the
// protocol-backed operations are refused `unavailable`: nothing was attempted.
// The app's projects (breadth.md D3, projects.mjs) come from the app, not the protocol: LocalProject instances, each thread's `project`
// link, and Project.rename, Project.remove and LocalProject.reveal run by the app (refused `unavailable` while framework-main has no store).
// Feature areas in their own modules (areas.mjs: breadth.md D5, D10) add their types' operations and their feeds, which hear every
// notification, the answers to the app's own requests, observations, the start, app-server restarts and the disposal.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTS } from './realizes.mjs';
import { UNVERIFIED } from './unverified.mjs';
import { AREAS } from './areas.mjs';
import { triggerOf } from './turn-params.mjs';
import { createAbort } from '../../abort.mjs';
import { contentItems } from '../../../agent/index.mjs';
import { PREFIX as TOOL_PREFIX } from '../../../agent/namespace.mjs';
import { PROVIDER, refs, agentData, modelData, threadData, threadStatus, threadWaitingOn, turnData, itemData, planData, requestData, answerStatus, answerOf, optionAnswer, alwaysPrompt, answerPrompt, questionAnswer, goalState, tokenUsage } from './map.mjs';

const pick = (o, ...keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
/** The mod whose surface the user acted in, for a call that is the user's through it (graph-integrity G7.3): named with the user. */
const throughOf = (caller) => (caller?.kind === 'user' && typeof caller.through === 'string' && caller.through ? { through: caller.through } : {});
/** Who answers through one of this provider's operations: its graph caller (a mod, the user acting in the app or the framework's pages). */
// a request policy's answer (the runtime tells the handler which) names the rule it answered by (public-hooks.md §3.6: "Approved by <mod>:
// <policy title>")
const byCaller = (caller, policy = null) => (caller?.kind === 'mod' && typeof caller.id === 'string'
  ? { kind: 'mod', id: caller.id, via: policy ? 'policy' : 'operation', ...(policy && typeof policy.title === 'string' ? { rule: policy.title } : {}) }
  : caller?.kind === 'user' || caller?.kind === 'framework' ? { kind: 'user', via: caller.kind === 'framework' ? 'framework' : 'operation', ...throughOf(caller) } : { kind: 'unknown' });
/** A call approved by its mod's automatic action, not by the user (graph runtime `approvedBy`). */
const automaticAnswer = (approvedBy) => typeof approvedBy === 'string' && approvedBy.startsWith('automatic:');
/** How long a turn's `stopped` waits for the answer to an interrupt of it that was still in flight when it ended. */
const STOP_WAIT_MS = 3000;
// how far an answer reaches: a change of the user's or a mod's answer may narrow it, never widen it (public-hooks.md §3.5): a decline is
// narrower than any approval, and an approval reaches as far as its scope
const reach = (o) => (!o ? -1 : o.kind !== 'approve' ? 0 : ({ once: 1, thread: 2, always: 3 })[o.scope] ?? 1);
const optionIn = (instance, id) => (Array.isArray(instance?.state?.options) ? instance.state.options.find((x) => x?.id === id) ?? null : null);
const reachWords = (o) => (o?.kind !== 'approve' ? 'declines' : o.scope === 'thread' ? 'approves for the chat' : `approves ${o.scope ?? 'once'}`);
/** Who started a turn, from why it started (its turn/start's trigger): the app's composer, queue, retries and edits are the user's. */
const USER_TRIGGERS = new Set(['composer', 'queue', 'retry', 'edit', 'review', 'reply', 'handoff']);
function startedByOf(why, by = null) {
  const key = by?.key ?? null;
  // a mod's, with the key of the call that started it when it had one (graph-integrity G6.3)
  if (why?.trigger === 'mod' && typeof why.triggerBy === 'string') return { kind: 'mod', id: why.triggerBy, ...(typeof key === 'string' && key ? { key } : {}) };
  // the user's own send through the graph (the framework's pages, or a mod's surface: `through` it, G7.3)
  if (by?.kind === 'user') return { kind: 'user', ...throughOf(by) };
  if (USER_TRIGGERS.has(why?.trigger)) return { kind: 'user' };
  if (why?.trigger === 'automation' || why?.trigger === 'app') return { kind: 'app' };
  return { kind: 'unknown' };
}
/** The client requests that make the server start a turn: until each is answered, a turn that starts on its thread is its client's. */
const STARTS_TURN = new Set(['turn/start', 'review/start', 'thread/compact/start']);
/** Who answered by the connection the answer came on (the mux's origin): the app's is the user's; a mod's client, that mod. */
const byOrigin = (origin) => (origin === 'app' ? { kind: 'user' }
  : typeof origin === 'string' && origin.startsWith('mod:') ? { kind: 'mod', id: origin.slice(4) } : { kind: 'unknown', ...(typeof origin === 'string' ? { via: origin } : {}) });
import { createProjectFeed, projectTypes } from './projects.mjs';
import { createFileFeed, fileTypes } from './files.mjs';
import { createAppFeed, appTypes } from './apps.mjs';
import { createCloudFeed, cloudTypes } from './cloud.mjs';
import { createGitFeed, gitTypes } from './git.mjs';
import { createInstructionsFeed, instructionsTypes } from './instructions.mjs';
import { createActionFeed, actionTypes } from './actions.mjs';
import { createAppStateFeed, appStateTypes } from './app-state.mjs';
import { createAccountFeed, accountTypes } from './accounts.mjs';
import { createAddedFeeds } from './added-accounts.mjs';
import { createWorktreeFeed, worktreeTypes } from './worktrees.mjs';

const ADD_MS = 5 * 60 * 1000;   // App.addProject: framework-main waits this long for the user's answer to the app's trust dialog
const READ_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'thread/list']);
/** Every ThreadSourceKind: thread/list without them lists the interactive ones only, and a read meant to be complete must list them all. */
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
/** What an added account's backend says that no key ties to a thread and that is still about one: a new thread's start and its notice. */
const KEYLESS_CHAT = new Set(['thread/start', 'thread/started']);
const DOWN = Object.freeze({ status: 'refused', reason: 'unavailable', message: 'the Codex app-server is not running' });
const NO_APP_STATE = Object.freeze({ status: 'refused', reason: 'unavailable', message: 'the app\'s own state is not available' });

/**
 * @param {{ graph: object, mux: object, bus?: object, log?: object, now?: () => number, pageSize?: number, clientId?: string, filesDir?: string,
 *   readState?: ReturnType<typeof import('../../read-state.mjs').createReadState>,
 *   appProjects?: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   mainOps?: ReturnType<typeof import('../../main-ops.mjs').createMainOps>, areas?: typeof AREAS }} o
 *   `readState` is the app's read state (Thread.unread, Thread.markRead); `appProjects` the app's projects; `filesDir`
 *   the framework's folder for files an operation makes (a Draft's attached text).
 */
/**
 * What one app request is, from what each area read of it: the one area's reading; several (a batch write with a plugin's and a server's),
 * or a refusal among them: refused while anything holds any of what they read (built review H6m1 round 2).
 */
export function combineAppOperations(found) {
  if (found.length < 2 && !(found[0]?.refuse)) return found[0] ?? null;
  const key = (x) => [x.pending?.type ?? x.ref?.type, x.pending?.operation ?? x.operation];
  const held = found.flatMap((x) => (x.refuse ? x.held ?? [[x.type, x.operation]] : [key(x)]));
  const refusal = found.find((x) => x.refuse);
  return refusal ? { ...refusal, held } : { refuse: 'several changes at once: make them one at a time', type: held[0][0], operation: held[0][1], held };
}

export function createCodexSource(o) {
  const { graph, mux } = o;
  const log = o.log ?? graph.log;
  const now = o.now ?? Date.now;
  const pageSize = o.pageSize ?? 50;
  const readState = o.readState ?? null;
  const appProjects = o.appProjects ?? null;
  const client = mux.client(o.clientId ?? 'graph:codex');
  const requestsBySid = new Map();   // the id the clients saw -> request ref
  const requestParams = new Map();   // the id the clients saw -> {method, params} of a pending request
  const answeredByNext = new Map();  // the id the clients saw -> who this provider is answering it for (its graph caller), until the answer is seen
  const fileItems = new Map();       // `${threadId}:${itemId}` -> a fileChange item (what an EditApproval would apply), the newest few hundred
  const pendingEdits = new Map();    // `${threadId}:${itemId}` -> an EditApproval asked before its step came
  const held = new Map();            // the id the clients saw -> its mux token, while held for Request.ask (public-hooks.md §3.6)
  // Why each turn started (Turn.trigger, H5): a turn/start seen at the mux (its client and `turnTrigger`), joined to its turn by the answer
  const turnStarts = new Map();      // reqKey(request) -> {raw, origin, cid}
  const sendsBy = new Map();         // clientUserMessageId -> the graph caller this provider sent it for
  const stopsNext = new Map();       // turn id -> the graph caller this provider interrupts it for (until its turn/interrupt is seen)
  const stopsBy = new Map();         // turn id -> who interrupted it (Turn.stoppedBy, when it ends stopped)
  const interrupts = new Map();      // reqKey(request) -> {turnId, by}: a turn/interrupt not answered yet (only an accepted one counts)
  const stopsWaiting = new Map();    // turn id -> timer: it stopped while an interrupt of it awaited its answer
  const triggers = new Map();        // turn id -> {trigger, triggerBy?, triggerDetail?}
  // Who started each turn (Turn.startedBy, graph-integrity G1.7): the turn-starting requests not answered yet, by thread (oldest first), so
  // a turn that starts while one is open is that client's, and one that starts while none is open is the agent's own (the server's)
  const openStarts = new Map();      // threadId -> [{key, origin, method, raw}]
  const startedBys = new Map();      // turn id -> {kind, id?}
  const turnModels = new Map();      // turn id -> the model it ran with (its turn/start's, else its chat's then; a reroute's after)
  const loaded = new Set();          // threads whose turns and items are loaded
  const ephemeral = new Set();       // threads the app-server never materializes: no history to read, never in a list; they end with thread/closed
  const loading = new Map();         // threadId -> promise
  const pendingText = new Map();     // agent message key -> {ref, text, threadId, turnId, id, startedAt}
  let listing = null, modelListing = null, modelsDirty = false, disposed = false;
  let needsRead = true, resyncTimer = null, resyncFailures = 0;   // read the list when the app-server is (again) ready
  let serverUp = true;               // false from a backend crash until the app-server is ready again
  let listSeen = null;               // while the thread list is read: the threads put since it started
  const turnsSeen = new Map();       // threadId -> Set of turn ids put while the thread is loading
  const cwds = new Map();            // threadId -> working directory (the protocol's Thread.cwd): which project the app shows it in
  const historyEdits = new Map();    // threadId -> the params of a thread/revert or thread/rollback asked for, applied when it is answered

  const supports = (t) => SUPPORTS[t] ?? [];
  const areaDefs = Object.entries(o.areas ?? AREAS);
  const areaFeeds = new Map();   // area name -> its feed
  /** The core's types with each area's operation handlers added (two areas, or an area and the core, never define the same operation). */
  function withAreas(core) {
    const out = { ...core };
    for (const [name, a] of areaDefs) {
      for (const [type, def] of Object.entries(a.types?.(() => areaFeeds.get(name)) ?? {})) {
        const cur = out[type] ?? {};
        for (const op of Object.keys(def.operations ?? {})) if (cur.operations?.[op]) throw new Error(`area ${name}: ${type}.${op} is defined twice`);
        out[type] = { ...cur, supports: cur.supports ?? supports(type), operations: { ...(cur.operations ?? {}), ...(def.operations ?? {}) } };
      }
    }
    return out;
  }
  const handle = graph.registerProvider('native', PROVIDER, {
    types: withAreas({
      Thread: {
        supports: supports('Thread'),
        operations: {
          // The thread may have no subscriber to be told (thread/name/updated): the title follows the answer.
          rename: { effect: 'external', handler: async ({ ref, args, intent }) => { if (!serverUp) return DOWN; await request('thread/name/set', { threadId: ref.id, name: args[0] }, intent); updateThread(ref.id, { title: args[0] }); return null; } },
          // The app's read state, through the store: it changes the app's own state (a local effect), and the thread's `unread` follows at once.
          ...(readState ? { markRead: { effect: 'local', handler: ({ ref }) => markRead(ref, false) }, markUnread: { effect: 'local', handler: ({ ref }) => markRead(ref, true) } } : {}),
          // The app's own project membership (its "Move to project"); the thread's `project` follows the report framework-main sends first.
          ...(appProjects ? { moveTo: { effect: 'external', handler: ({ ref, args }) => moveTo(ref, args[0]) } } : {}),
          // RM10: its next turns on another account, between turns (added-accounts.mjs); a mod's call asks the user unless it is the mod's
          // automatic action
          moveToAccount: { effect: 'external', approval: ({ instance, args }) => movePrompt(instance, args[0]), handler: ({ ref, args, intent }) => (serverUp ? addedFeeds.move(ref, args[0], intent) : DOWN) },
        },
      },
      // What Codex adds to its threads (docs/design/graph-boundary.md B3): the goal the agent keeps working toward.
      CodexThread: {
        supports: supports('CodexThread'),
        operations: {
          setGoal: { effect: 'external', handler: async ({ ref, args, intent }) => { if (!serverUp) return DOWN; const r = await request('thread/goal/set', { threadId: ref.id, objective: args[0] }, intent); applyGoal(ref.id, r?.goal); return null; } },
          clearGoal: { effect: 'external', handler: async ({ ref, intent }) => { if (!serverUp) return DOWN; await request('thread/goal/clear', { threadId: ref.id }, intent); applyGoal(ref.id, null); return null; } },
        },
      },
      CodexAgent: {
        supports: supports('CodexAgent'),
        operations: {
          // RM10: another ChatGPT account beside the app's, added signed out with its sign-in opened; and where new chats start
          addAccount: { effect: 'external', approval: () => ({ action: 'add a ChatGPT account to Codex', detail: 'Its sign-in opens in your browser. Chats can then run on it.' }),
            handler: () => addedFeeds.addAccount() },
          // where the user's new chats run (their usage): a mod's call asks the user, unless it is the mod's automatic action
          setStartAccount: { effect: 'external', approval: ({ args }) => startPrompt(args[0]), handler: ({ args }) => addedFeeds.setStart(args[0]) },
        },
      },
      Model: {}, Draft: {},
      Turn: { supports: supports('Turn') }, Message: {}, Step: { supports: supports('Step') }, CommandRun: { supports: supports('CommandRun') },
      ToolCall: { supports: supports('ToolCall') },
      // Request.ask (public-hooks.md §3.6): what runs before the user is asked; its own part is showing the request (a held one is released)
      Request: { supports: supports('Request'), operations: { ask: { effect: 'local', handler: ({ ref }) => show(sidOf(ref)) } } },
      Approval: {
        supports: supports('Approval'),
        operations: {
          // One of the options the server offers (graph-integrity G1.6). "Always" writes a standing rule the app and the command line share,
          // to allow or to block: the user is asked whatever its kind (review 2026-11-05 #7); a mod's approval once or for the chat is its
          // automatic action or asks the user (R17, public-hooks.md §3.6); a decline for now needs no consent.
          answer: {
            effect: 'external',
            approval: ({ instance, args: [id] }) => {
              const opt = optionIn(instance, id);
              if (instance?.state?.status !== 'pending') return null;
              if (opt?.scope === 'always') return alwaysPrompt(instance, opt);
              return opt?.kind !== 'approve' ? null : answerPrompt(instance, opt);
            },
            // "always" creates a standing rule, which stays the user's: no automatic action gives it (§3.6)
            alwaysAsks: ({ instance, args: [id] }) => (optionIn(instance, id)?.scope === 'always' ? '"always" stays the user\'s' : null),
            widens: ({ instance, original: [was], args: [now] }) => { const a = optionIn(instance, was), b = optionIn(instance, now); return reach(b) > reach(a) ? `it ${reachWords(b)} where the answer ${reachWords(a)}` : null; },
            handler: ({ ref, instance, args: [id, feedback], caller, approvedBy, policy, whileHeld }) => {
              const opt = optionIn(instance, id);
              if (!opt) return { status: 'refused', reason: 'unsupported', message: `this request does not offer ${id}` };
              if (feedback !== undefined && feedback !== null) return { status: 'refused', reason: 'unsupported', message: 'Codex takes no feedback with an answer: send it as a message' };
              return answerRequest(ref, instance, (q) => optionAnswer(q.method, q.params, id), undefined, byCaller(caller, policy),
                whileHeld === true || (opt.kind === 'approve' && automaticAnswer(approvedBy)));
            },
          },
        },
      },
      ...(appProjects ? projectTypes(projectOp, (app, target) => apps.open(app, target), (ref, spec) => newTerminal(ref, spec), (ref, query, opts) => findFiles(ref, query, opts),
        (ref, text) => (instructions ? instructions.add(ref.id, text) : { status: 'refused', reason: 'unavailable', message: 'the instructions are not read on this build' })) : {}),
      ...(appProjects ? fileTypes(fileOp, (app, target) => apps.open(app, target)) : {}),
      ...(appProjects ? appTypes({ open: (...a) => apps.open(...a), prompt: (...a) => apps.prompt(...a), setComputerUse: (...a) => apps.setComputerUse(...a) }) : {}),
      ...(appProjects ? gitTypes({ run: (...a) => git.run(...a), create: (...a) => git.create(...a), branchName: (...a) => git.branchName(...a), workingChanges: (...a) => git.workingChanges(...a) }) : {}),
      ...(appProjects ? instructionsTypes({ prompt: (...a) => instructions.prompt(...a), edit: (...a) => instructions.edit(...a), open: (...a) => instructions.open(...a) }) : {}),
      ...(appProjects ? actionTypes({ run: (...a) => actions.run(...a) }) : {}),
      ...(appProjects ? worktreeTypes({ prompt: (...a) => worktrees.prompt(...a), remove: (...a) => worktrees.remove(...a) }) : {}),
      ...(appProjects ? cloudTypes(appProjects) : {}),
      ...accountTypes({
        prompt: (inst) => (addedFeeds.feedOf(inst.ref) ?? accounts).prompt(inst),
        signIn: (ref) => (addedFeeds.feedOf(ref) ?? accounts).signIn(ref),
        signOut: (ref) => (addedFeeds.feedOf(ref) ? addedFeeds.signOut(ref) : accounts.signOut(ref)),
        manage: (inst) => (addedFeeds.feedOf(inst.ref) ?? accounts).manage(inst),
        remove: (ref) => addedFeeds.remove(ref),
        removePrompt: (inst) => (addedFeeds.feedOf(inst.ref) ? addedFeeds.removePrompt(inst) : null),
      }),
      // Setting.set and reset: a Setting a feature area owns (its feed's `settings.owns(ref)`) is the area's; any other is the app's
      // registry (app-state.mjs). Without the app's state only the areas' settings can change.
      ...appStateTypes({
        prompt: (instance, change) => { const own = settingOwner(instance.ref); return own ? own.prompt(instance, change) : appStateFeed ? appStateFeed.prompt(instance) : null; },
        write: (key, value) => { const own = settingOwner(refs.setting(key)); return own ? own.write(refs.setting(key), value) : appStateFeed ? appStateFeed.write(key, value) : NO_APP_STATE; },
        reset: (key) => { const own = settingOwner(refs.setting(key)); return own ? own.reset(refs.setting(key)) : appStateFeed ? appStateFeed.reset(key) : NO_APP_STATE; },
        setTheme: (...a) => (appStateFeed ? appStateFeed.setTheme(...a) : NO_APP_STATE), openHelp: () => (appStateFeed ? appStateFeed.openHelp() : NO_APP_STATE),
        quit: () => (appStateFeed ? appStateFeed.quit() : NO_APP_STATE),
        feedbackPrompt: (...a) => appStateFeed?.feedbackPrompt(...a) ?? null, sendFeedback: (...a) => (appStateFeed ? appStateFeed.sendFeedback(...a) : NO_APP_STATE),
        ...(appProjects ? { addProject: (spec) => addProject(spec) } : {}),
        ...(typeof o.frontWindow === 'function' ? { frontWindow: () => Promise.resolve(o.frontWindow()).catch(() => null) } : {}),
        ...(typeof o.openWindow === 'function' ? { openWindow: (target, call) => o.openWindow(target, call) } : {}),
      }),
      Question: {
        supports: supports('Question'),
        operations: {
          // each prompt's answer by its id (graph-integrity G1.5); what a secret prompt was answered never leaves the call (the runtime)
          answer: { effect: 'external', approval: ({ instance }) => answerPrompt(instance),
            handler: ({ ref, instance, args: [answers], caller, approvedBy, policy, whileHeld }) => answerRequest(ref, instance, (q) => {
              if (q.method !== 'item/tool/requestUserInput') return null;
              return questionAnswer(q.params, instance.state.prompts, answers) ?? { status: 'refused', reason: 'invalid', message: 'answers are per prompt id: the choices it offers, and words where it takes them' };
            }, undefined, byCaller(caller, policy), whileHeld === true || automaticAnswer(approvedBy)) },
          // The app has no "skip": dismissing a question interrupts the turn, and the request ends with it.
          skip: { effect: 'external', handler: ({ ref, instance, intent, caller }) => answerRequest(ref, instance, (q) => (q.method === 'item/tool/requestUserInput'
            ? { interrupt: { threadId: q.params.threadId, turnId: q.params.turnId } }
            : { action: 'cancel', content: null, _meta: null }), intent, byCaller(caller)) },
        },
      },
    }),
    /**
     * The chats' own search (public-hooks.md §3.2): the app-server's `thread/search` (the app's sidebar search), which matches what the
     * chats say; each chat it finds is put in the graph, a match in what was said only for a reader of messages (`content: 'Message'`).
     */
    searchContent: 'Message',
    async search(text, { types, limit }) {
      if (!serverUp || !types.some((t) => graph.type('CodexThread')?.chain?.includes(t))) return [];
      const r = await client.request('thread/search', { cursor: null, limit: Math.min(limit, 50), sortKey: 'updated_at', archived: false, searchTerm: text });
      const out = [];
      for (const row of Array.isArray(r?.data) ? r.data : []) {
        const t = row?.thread;
        if (!t?.id) continue;
        putThread(t);
        out.push({ ref: refs.thread(t.id), content: 'Message', ...(typeof row.snippet === 'string' ? { snippet: row.snippet } : {}) });
      }
      return out;
    },
    /** The view's `loaded` waits for it (the runtime reports a failure). */
    onObserve(query) {
      const ref = query.ref;
      if (ref?.provider !== PROVIDER) return undefined;
      const concept = graph.type(ref.type)?.concept;
      // A core view (a page's binding) asks for an instance that is not resident yet, never for what it needs beyond its core: only a
      // message or a step makes something load (its thread, the one way to have it); a thread's row loads no turns.
      if (query.depth === 'core') {
        if (concept !== 'Message' && concept !== 'Step') return undefined;
        const thread = threadOf(ref);
        return thread ? loadThread(thread) : undefined;
      }
      if (concept === 'Folder' || concept === 'File') return files?.observe(query);
      if (concept === 'ExternalApp') return apps?.observe();
      if (ref.type === 'CloudEnvironment') return cloud?.observe();
      if (concept === 'Repository' || concept === 'Branch') return git?.observe(ref);
      if (concept === 'Instructions') return instructions?.observe(ref);
      if (concept === 'Account' || concept === 'Usage') return addedFeeds.observe(ref) ?? accounts.observe();
      if (ref.type === 'ProjectAction') return actions?.observe(ref);
      for (const [name, f] of areaFeeds) {
        const loading = safe(`area ${name} observe`, () => f.observe?.(ref, concept));
        if (loading !== undefined && loading !== null) return loading;
      }
      const thread = threadOf(ref);
      return thread ? loadThread(thread) : undefined;
    },
    // what it realizes that no native check has shown yet (graph-integrity G9.3): the framework's own surfaces do not offer it
    unverified: UNVERIFIED,
  });

  /** The agent is a constant (name, icon); only `available` varies, with the app-server. */
  function putAgent(available, reason) {
    const d = agentData({ available, reason });
    const was = resident(d.ref)?.state.available;
    // The links areas set on the agent (its skills, tool servers, plugins, instructions) stay.
    safe('agent', () => handle.put(d.ref, { state: d.state, links: { ...(resident(d.ref)?.links ?? {}), ...d.links, account: accounts?.current() ?? null, ...(addedFeeds?.agentLinks() ?? {}) } }));
    if (was !== undefined && was !== available) emitEvent(d.ref, 'availabilityChanged');
  }
  /** A named event of a native instance (never throws into the feed). */
  /** A named event; `sourceAt` the source's own time for it, when the protocol gives one (graph-integrity G1.3). */
  function emitEvent(r, name, payload, sourceAt) { safe(`event ${name}`, () => handle.emit(r, name, payload ?? null, Number.isFinite(sourceAt) ? { sourceAt } : undefined)); }
  const conceptOfType = (typeId) => graph.type(typeId)?.concept ?? null;

  /**
   * Answer a pending request at the mux, as the app would (the observed answer then updates the request). `build(q)` gives the protocol's
   * answer from the request's method and params, a refusal, null (it cannot be answered so), or {interrupt} to interrupt its turn instead.
   */
  // `onlyHeld`: an automatic answer, or one given in the request's ask, is for the request while it is held (public-hooks.md §3.6)
  async function answerRequest(ref, instance, build, intent, by = null, onlyHeld = false) {
    if (!serverUp) return DOWN;
    const sid = [...requestsBySid].find(([, r]) => r.id === ref.id && r.type === ref.type)?.[0];
    const q = sid ? requestParams.get(sid) : null;
    if (!q || instance.state.status !== 'pending') return { status: 'refused', reason: 'unavailable', message: 'the request is no longer pending' };
    // an automatic answer is given only while the request is held (Request.ask): once shown, the user answers it (public-hooks.md §3.6)
    if (onlyHeld && !held.has(sid)) return { status: 'refused', reason: 'notAllowed', message: 'the request was shown to the user: it is theirs to answer now' };
    const answer = build(q);
    if (answer?.status) return answer;
    if (!answer) return { status: 'refused', reason: 'unsupported', message: `the native provider cannot answer ${q.method} this way` };
    if (by) answeredByNext.set(sid, by);   // the answer this provider sends is seen as the framework's: it was this caller's
    if (answer.interrupt) { await request('turn/interrupt', answer.interrupt, intent); return null; }
    // held while mods are asked (Request.ask): answered there, once; an uncertain answer is never sent again, nor the request shown
    const token = held.get(sid);
    if (token) {
      const out = await client.respond(token, { result: answer });
      if (out?.outcome === 'delivered') { held.delete(sid); return null; }
      if (out?.outcome === 'uncertain') { held.delete(sid); throw Object.assign(new Error('the answer may not have reached Codex'), { code: 'OutcomeUnknown' }); }
      answeredByNext.delete(sid);
      return { status: 'refused', reason: 'unavailable', message: `the request is no longer pending (${out?.reason ?? 'not delivered'})` };
    }
    if (!mux.answerServerRequest?.(sid, { result: answer })) { answeredByNext.delete(sid); return { status: 'refused', reason: 'unavailable', message: 'the request is no longer pending' }; }
    return null;
  }

  /** A project operation the app runs (framework-main): refused when nothing was tried, a failure when the app's own call failed. */
  async function appOp(op, projectId, args) {
    const r = await appProjects.op(op, projectId, args);
    if (r.ok) return null;
    if (r.refused) return { status: 'refused', reason: 'unavailable', message: r.error };
    throw new Error(r.error);
  }
  function projectOp(op, ref, args) { return appOp(op, ref.id, args); }
  /** App.addProject (E8.9 creation audit): the folder added the app's own way; its Project once the app reports it (by its folder). */
  async function addProject(spec) {
    const p = spec && typeof spec.path === 'string' ? spec.path.trim() : '';
    if (!p.startsWith('/') || p.length > 4096) return { status: 'refused', reason: 'invalid', message: 'an absolute folder path is needed' };
    if (spec.name !== undefined && (typeof spec.name !== 'string' || spec.name.length > 200)) return { status: 'refused', reason: 'invalid', message: 'a name of at most 200 characters' };
    // its folder as the app will store it (normalized: `/repo/.` is `/repo`), so the project the app reports is found by it
    let folder = path.posix.resolve(p);
    const rootOf = (x) => path.posix.resolve(x.roots?.[0] ?? '/');
    const hasIt = () => appProjects.list().find((x) => (x.roots?.[0] ? rootOf(x) === folder : false) || (madeId !== null && x.id === madeId)) ?? null;
    let madeId = null;
    const before = hasIt();
    if (before) return { status: 'refused', reason: 'invalid', message: `the folder is already the project “${before.name}”` };
    // the app asks the user to trust a new folder and waits: framework-main gives it ADD_MS, the Host a little more (E8 third review)
    const r = await appProjects.op('add', null, { path: folder, ...(spec.name !== undefined ? { name: spec.name } : {}) }, { timeoutMs: ADD_MS + 10_000 });
    if (!r.ok) return r.refused ? { status: 'refused', reason: 'unavailable', message: r.error } : (() => { throw new Error(r.error); })();
    if (typeof r.result?.folder === 'string' && r.result.folder.startsWith('/')) folder = r.result.folder;
    if (typeof r.result?.id === 'string' && r.result.id) madeId = r.result.id;
    // the app reports its projects after the change: wait for this folder's (a refused trust leaves none)
    const found = hasIt() ?? await new Promise((resolve) => {
      const sub = appProjects.onChange(() => { const x = hasIt(); if (x) { sub.dispose(); clearTimeout(t); resolve(x); } });
      const t = setTimeout(() => { sub.dispose(); resolve(null); }, 15000);
      t.unref?.();
    });
    if (!found) return { status: 'refused', reason: 'unavailable', message: 'the app did not add the folder (its trust was declined, or the app changed nothing)' };
    return { status: 'done', value: refs.project(found.id) };
  }
  /** A folder's or a file's operation, in the project that holds it. */
  function fileOp(op, ref) {
    const at = files?.projectOfPath(ref.id);
    if (!at) return { status: 'refused', reason: 'unavailable', message: 'the path is not in a project the app has' };
    return appOp(op, at.id, { path: ref.id });
  }

  function markRead(ref, unread) {
    if (!readState.available) return { status: 'refused', reason: 'unavailable', message: 'the app\'s read state is not available' };
    readState.set(ref.id, unread);
    return null;
  }
  /** Project.newTerminal({thread?, path?}): a terminal the app's way (framework-main); its Terminal once the terminals area lists it. */
  async function newTerminal(ref, spec) {
    const bad = spec != null && (typeof spec !== 'object' || (spec.path !== undefined && typeof spec.path !== 'string')
      || (spec.thread !== undefined && !(spec.thread?.provider === PROVIDER && graph.type(spec.thread.type)?.chain.includes('Thread'))));
    if (bad) return { status: 'refused', reason: 'invalid', message: 'newTerminal takes nothing, or { thread?, path? }: a Codex chat to show it beside, a folder in the project' };
    const r = await appProjects.op('new-terminal', ref.id, { ...(spec?.path !== undefined ? { path: spec.path } : {}), ...(spec?.thread ? { threadId: spec.thread.id } : {}) });
    if (!r.ok) { if (r.refused) return { status: 'refused', reason: 'unavailable', message: r.error }; throw new Error(r.error); }
    const t = refs.terminal(r.result?.sessionId);
    for (let i = 0; i < 50 && !resident(t); i++) await new Promise((res) => { const x = setTimeout(res, 100); x.unref?.(); });
    return resident(t) ? t : { status: 'uncertain', operation: 'newTerminal' };
  }
  /** Project.findFiles(query, {limit?}): the app-server's fuzzy file search over the project's folders, best first: Files and Folders. */
  async function findFiles(ref, query, opts) {
    if (!serverUp) return DOWN;
    if (typeof query !== 'string' || !query.trim() || query.length > 200) return { status: 'refused', reason: 'invalid', message: 'a query of 1 to 200 characters' };
    const limit = opts?.limit === undefined ? 50 : opts.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return { status: 'refused', reason: 'invalid', message: 'limit is 1 to 200' };
    const roots = appProjects.list().find((p) => p.id === ref.id)?.roots ?? [];
    if (!roots.length) return { status: 'refused', reason: 'unavailable', message: 'the project has no folder' };
    const r = await request('fuzzyFileSearch', { query, roots: [...roots], cancellationToken: null });
    // the repository's own internals are not the project's files (the search lists `.git`'s)
    return (Array.isArray(r?.files) ? r.files : []).filter((f) => typeof f?.path === 'string' && typeof f.root === 'string' && !f.path.split('/').includes('.git'))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit)
      .map((f) => { const abs = path.isAbsolute(f.path) ? f.path : path.join(f.root, f.path); return f.match_type === 'directory' ? refs.folder(abs) : refs.file(abs); });
  }
  /** Thread.moveTo: into one of the app's projects, or (no project) out of every project, into its own section. */
  function moveTo(ref, project) {
    if (project !== undefined && !(project.provider === PROVIDER && project.type === 'LocalProject')) return { status: 'refused', reason: 'invalid', message: 'a project the app has is needed' };
    const at = resident(ref)?.links.project ?? null;
    if (project === undefined ? at === null && appProjects.factsOf(ref.id)?.projectless === true : at?.id === project.id) return null;
    return appOp('move-thread', project?.id ?? null, { threadId: ref.id });
  }

  /** A request to the backend; an operation passes the graph intent it carries out, so the mux does not claim it again (addition 8). */
  function request(method, params, intent) {
    return client.request(method, params, intent ? { intent } : undefined);
  }
  /** The thread an observed ref belongs to (the thread itself, or the thread a turn, item or request is in). */
  function threadOf(ref) {
    const inst = graph.resolve(ref);
    if (!inst || inst.gone) {
      if (ref.type === 'CodexThread' || ref.type === 'Thread') return ref.id;
      // A message or a step not loaded yet: its id is its thread's and its own (refs.item), so observing it loads its thread (a page's
      // binding asks for the message it shows, docs/design/systems.md E2).
      const concept = graph.type(ref.type)?.concept;
      const at = typeof ref.id === 'string' ? ref.id.indexOf(':') : -1;
      return (concept === 'Message' || concept === 'Step') && at > 0 ? ref.id.slice(0, at) : null;
    }
    if (graph.type(inst.ref.type)?.concept === 'Thread') return inst.ref.id;
    const t = inst.links?.thread ?? (inst.links?.turn ? graph.resolve(inst.links.turn)?.links?.thread : null);
    return t ? t.id : null;
  }

  // ---------------------------------------------------------------- writing to the graph (never throws into the feed)
  function safe(what, fn) { try { return fn(); } catch (e) { log.warn(`codex source: ${what} failed`, { message: String(e?.message ?? e) }); return null; } }
  const resident = (r) => { const x = graph.resolve(r); return x && !x.gone ? x : null; };
  function putThread(t, extra = {}) {
    if (!t?.id) return;
    listSeen?.add(t.id);
    if (t.ephemeral === true) ephemeral.add(t.id);
    if (typeof t.cwd === 'string' && t.cwd) cwds.set(t.id, t.cwd);
    safe('thread', () => {
      const data = threadData(t, { archived: extra.archived ?? resident(refs.thread(t.id))?.state.archived ?? false, unread: readState?.has(t.id) === true, project: projects?.linkOf(t.id) ?? null, environment: projects?.environmentOf(t.id) ?? worktrees?.environmentOf(t.id) ?? null });
      const cur = resident(data.ref);
      // Keep what other notifications set (goal, usage, context) and the title a rename set when the read has no name yet.
      const keep = {};
      if (cur) for (const f of ['goal', 'usage', 'context']) if (cur.state[f] !== undefined) keep[f] = cur.state[f];
      handle.put(data.ref, { state: { ...data.state, ...keep, ...(extra.state ?? {}) }, links: { ...data.links, account: addedFeeds?.accountOf(t.id) ?? null } });
    });
    for (const turn of Array.isArray(t.turns) ? t.turns : []) putTurn(t.id, turn, { items: true });
    worktrees?.check(t.id);   // a thread outside its project's folder may run in a worktree
  }
  function updateThread(threadId, state) {
    const r = refs.thread(threadId);
    if (!resident(r)) return;
    safe('thread update', () => handle.update(r, { state }));
  }
  function applyGoal(threadId, goal) { updateThread(threadId, { goal: goalState(goal) }); }
  /** The app's read state changed (the user read or unread a thread; markRead): a live thread follows. A stale one is not made live by it;
   *  it takes the store's value when it is read again. */
  const readSub = readState?.onChange(({ threadId, unread }) => {
    if (disposed) return;
    const cur = resident(refs.thread(threadId));
    if (cur && cur.liveness === 'live') updateThread(threadId, { unread });
  });
  /** The app's projects; a live thread whose project changed links again (a stale one takes it when it is read again). */
  const projects = appProjects ? createProjectFeed({
    handle, appProjects, resident, safe, emitEvent,
    threads: () => cwds.keys(),
    cwdOf: (threadId) => cwds.get(threadId) ?? null,
    relink: (threadId) => relinkThread(threadId),
  }) : null;
  /** A live thread takes the project and the environment the app shows it in (a stale one takes them when it is read again). */
  function relinkThread(threadId) {
    if (disposed || !projects) return;
    const r = refs.thread(threadId);
    const cur = resident(r);
    if (!cur || cur.liveness !== 'live') return;
    worktrees?.check(threadId);
    const want = projects.linkOf(threadId), env = projects.environmentOf(threadId) ?? worktrees?.environmentOf(threadId) ?? null;
    if ((cur.links?.project?.id ?? null) === (want?.id ?? null) && (cur.links?.environment?.id ?? null) === (env?.id ?? null)) return;
    safe('thread project', () => handle.update(r, { links: { project: want, environment: env } }));
  }
  /** A project's folders and files, read the app's way when a realm observes them (files.mjs). */
  const files = appProjects ? createFileFeed({ handle, graph, appProjects, resident, safe, emitEvent, log, rpc: (method, params) => client.request(method, params), listed: (...a) => instructions?.listed(...a) }) : null;
  /** The apps on this Mac: open-in targets and computer-use approvals (apps.mjs). */
  const apps = appProjects ? createAppFeed({ handle, graph, appProjects, resident, safe, emitEvent, log, projectOfPath: (p) => files.projectOfPath(p) }) : null;
  /** The signed-in account's cloud environments (cloud.mjs). */
  const cloud = appProjects ? createCloudFeed({ handle, graph, appProjects, resident, safe, emitEvent, log }) : null;
  /** Each project's repository and branches (git.mjs). */
  const git = appProjects ? createGitFeed({ handle, graph, appProjects, resident, safe, emitEvent, log }) : null;
  /** The instructions Codex follows: the global ones, each project's and its folders' (instructions.mjs). */
  const instructions = appProjects ? createInstructionsFeed({ handle, appProjects, resident, safe, emitEvent, log, rpc: (method, params) => client.request(method, params) }) : null;
  /** The signed-in account and its usage (accounts.mjs); the Codex agent links to the account. */
  let addedFeeds = null;   // below: it needs `accounts`
  const accounts = createAccountFeed({ handle, appState: o.appState ?? null, rpc: (method, params) => client.request(method, params), resident, safe, emitEvent, log,
    relinkAgent: () => { relinkAgentAccounts(); appStateFeed?.relink(); addedFeeds?.relinkPrimaryThreads(); } });
  /** The accounts the user added (RM10, added-accounts.mjs): their feeds, every chat's account, moving a chat between them. */
  addedFeeds = createAddedFeeds({ added: o.addedAccounts ?? null, mux, client, handle, appState: o.appState ?? null, resident, safe, emitEvent, log, primary: accounts, bus: o.bus,
    threads: () => cwds.keys(), ephemeral: (id) => ephemeral.has(id), loaded: (id) => loaded.has(id), relinkAgent: () => relinkAgentAccounts() });
  function relinkAgentAccounts() {
    if (resident(refs.agent())) safe('agent account', () => handle.update(refs.agent(), { links: { account: accounts.current(), ...(addedFeeds?.agentLinks() ?? {}) } }));
  }
  /** What the user is asked when a mod changes where new chats start. */
  function startPrompt(account) {
    const a = account?.provider === PROVIDER ? resident(account) : null;
    return { action: a ? `start new chats on the account ${a.state.name}` : 'start new chats on the app\'s own account', detail: 'New chats use that account\'s usage.' };
  }
  /** What the user is asked when a mod moves a chat to another account. */
  function movePrompt(instance, account) {
    const a = account?.provider === PROVIDER ? resident(account) : null;
    return { action: `move "${instance.state.title || 'a chat'}" to the account ${a?.state.name ?? 'another account'}`, detail: 'Its next messages use that account\'s usage. It is the same chat, with its history and settings.' };
  }
  /** The app's own state: its settings, its theme and the App (app-state.mjs). */
  const appStateFeed = o.appState ? createAppStateFeed({ handle, graph, appState: o.appState, appProjects, bus: o.bus, resident, safe, emitEvent, log, rpc: (method, params) => client.request(method, params),
    account: () => accounts.current() }) : null;
  /** Each project's own actions (actions.mjs). */
  const actions = appProjects ? createActionFeed({ handle, appProjects, resident, safe, emitEvent, log, rpc: (method, params) => client.request(method, params), cwdOf: (id) => cwds.get(id) ?? null }) : null;
  /** The worktrees threads run in (worktrees.mjs). */
  const worktrees = appProjects ? createWorktreeFeed({ handle, appProjects, resident, safe, log, cwdOf: (id) => cwds.get(id) ?? null, threads: () => cwds.keys(), rpc: (method, params) => client.request(method, params), relink: (id) => relinkThread(id),
    // Thread.archive of the threads area when it is there (the app's recipe), else the protocol's archive alone.
    archive: async (id) => { const t = areaFeeds.get('threads'); if (t) return t.archive(refs.thread(id)); await client.request('thread/archive', { threadId: id }); return null; } }) : null;
  /** `fn()` (a request that needs the thread loaded in the app-server: turn/start, thread/compact/start, thread/settings/update,
   *  thread/queue/start); on "thread not found" (or, from thread/queue/start, "resume the thread before …") the thread is resumed as the
   *  app does when it opens a chat, then `fn()` runs once more. */
  async function withLoadedThread(threadId, fn, intent) {
    try { return await fn(); } catch (e) {
      if (!/thread not found|resume the thread/i.test(String(e?.message ?? e))) throw e;
      await request('thread/resume', { threadId, excludeTurns: true }, intent);
      return fn();
    }
  }
  // The app's requests that are the graph's own call, carried out by the app's page (a Turn's rewind and retry: the app's edit of the
  // message, then its send): never held again as the user's (app-ops.mjs `appOwn`; built review H6m1). Each a few seconds long.
  const expected = [];   // {method, match: {key: value}, until}
  const expectApp = (list, ms = 15_000) => {
    const until = now() + ms;
    const mine = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.method === 'string').map((x) => ({ method: x.method, match: { ...(x.match ?? {}) }, until }));
    expected.push(...mine);
    return { dispose() { for (const e of mine) { const i = expected.indexOf(e); if (i >= 0) expected.splice(i, 1); } } };
  };
  // `take`: the request is the one expected (taken: one expectation is one request, so a like request of the user's is held: review H6m1 r2)
  const appOwn = (method, params, take = false) => {
    const t = now();
    for (let i = expected.length - 1; i >= 0; i--) if (expected[i].until <= t) expected.splice(i, 1);
    const i = expected.findIndex((e) => e.method === method && Object.entries(e.match).every(([k, v]) => params?.[k] === v));
    if (i < 0) return false;
    if (take) expected.splice(i, 1);
    return true;
  };
  /** What an area's feed is given (areas.mjs). */
  const areaContext = (name) => Object.freeze({
    expectApp,
    handle, graph, refs, log, now, resident, safe, emitEvent, request, serverUp: () => serverUp, DOWN,
    appState: o.appState ?? null, appProjects, readState, bus: o.bus ?? null,
    /** The installed mod whose tools' namespace this is (`{id, name}`), or null (graph-integrity G3.5: a call of its tool while it is off). */
    modOfNamespace: (ns) => { try { return o.modOfNamespace?.(ns) ?? null; } catch { return null; } },
    /** The framework's own folder for files an operation makes (a Draft's attached text), or null: none is written. */
    filesDir: typeof o.filesDir === 'string' && o.filesDir ? o.filesDir : null,
    /** Where the new chat's choices of a provided agent's settings are kept (public-hooks.md §3.15), or null: for this run only. */
    mainOp: (op, args) => (o.mainOps ? o.mainOps.op(name, op, args) : Promise.resolve({ ok: false, error: 'framework-main is not running', refused: true })),
    onMainReport: (fn) => o.mainOps?.onReport(name, fn) ?? { dispose() {} },
    /** A page operation on the presentation of `type` that shows `subject` now: its outcome, or null when none is shown (E8.3b). */
    pageAct: (type, subject, op, args, windowId) => (typeof o.pageAct === 'function' ? Promise.resolve(o.pageAct(type, subject, op, args, windowId)).catch(() => null) : Promise.resolve(null)),
    // an operation that names a pane, and the panes showing something in a window (layouts.md D8)
    withPane: (pane, fn) => (typeof o.withPane === 'function' ? o.withPane(pane, fn) : fn()),
    capturePane: (windowId, token) => o.capturePane?.(windowId, token),
    heldPane: () => o.heldPane?.(),
    panesOf: (windowId, type, subject) => (typeof o.panesOf === 'function' ? o.panesOf(windowId, type, subject) : []),
    // the one window an operation of several steps keeps to (graph-layers.md §2): `{windowId}` (null: no window), or `{refused}`
    chooseWindow: (type, subject) => (typeof o.chooseWindow === 'function' ? Promise.resolve(o.chooseWindow(type, subject)).catch(() => null) : Promise.resolve(null)),
    showsIn: typeof o.showsIn === 'function' ? (windowId, type, subject) => { try { return o.showsIn(windowId, type, subject) === true; } catch { return false; } } : undefined,
    cwdOf: (id) => cwds.get(id) ?? null, threadIds: () => [...cwds.keys()], loadThread, updateThread, withLoadedThread,
    /** A thread the app-server never materializes (a side chat: an ephemeral fork shown in the side panel). */
    isEphemeral: (id) => ephemeral.has(id),
    /** A send this provider makes for a graph caller (its turn's trigger names it): by the send's clientUserMessageId. */
    noteSend: (cid, by) => { if (typeof cid === 'string') { sendsBy.set(cid, by); capped(sendsBy, 500); } },
    /** A turn this provider interrupts for a graph caller (Turn.stoppedBy names it). */
    noteStop: (turnId, caller) => { if (typeof turnId === 'string') { stopsNext.set(turnId, byCaller(caller)); capped(stopsNext, 500); } },
    readRepository: (projectId) => git?.read(projectId) ?? Promise.resolve(),
    pushRepository: (projectId, branch = null) => git ? git.run('push', projectId, branch) : Promise.resolve({ status: 'refused', reason: 'unavailable', message: 'the app\'s projects are not available' }),
    account: () => accounts.current(),
    area: (other) => areaFeeds.get(other) ?? null,
  });
  for (const [name, a] of areaDefs) {
    const f = safe(`area ${name}`, () => a.createFeed?.(areaContext(name)));
    if (f) areaFeeds.set(name, f);
  }
  /** The area that owns a Setting (its feed's `settings.owns(ref)`), or null: the app's registry. */
  function settingOwner(r) {
    for (const f of areaFeeds.values()) if (f.settings && typeof f.settings.owns === 'function' && safe('area setting', () => f.settings.owns(r)) === true) return f.settings;
    return null;
  }
  /** Each area's feed, a failure logged and kept from the others. */
  const eachArea = (fn) => { for (const [name, f] of areaFeeds) safe(`area ${name}`, () => fn(f)); };
  // The areas start once: with the source's start() (tests), or at the first appServer/ready, which is how the Host's source begins
  // (it never calls start()); a later ready is serverUp().
  let areasStarted = false;
  const startAreas = () => { if (areasStarted) return; areasStarted = true; eachArea((f) => f.start?.()); };
  /**
   * Who started a turn: known from its turn/start (startedBys), else the client of the oldest turn-starting request open on its thread when it
   * started live, else, when it started live with none open, the agent itself (the server started it: a goal's continuation, a sub-agent's
   * turn); a turn read from the history is as it was, or not known.
   */
  function startedByFor(threadId, turnId, live) {
    const known = startedBys.get(turnId);
    if (known) return known;
    if (!live) return resident(refs.turn(turnId))?.state.startedBy ?? { kind: 'unknown' };
    const open = openStarts.get(threadId);
    if (open?.length) {
      const first = open[0];
      return first.method === 'turn/start' ? { kind: 'unknown' } : byOrigin(first.origin).kind === 'user' ? { kind: 'user' } : byOrigin(first.origin).kind === 'mod' ? { kind: 'mod', id: byOrigin(first.origin).id } : { kind: 'unknown' };
    }
    return { kind: 'agent' };
  }
  function putTurn(threadId, turn, { items = false, live = false } = {}) {
    if (!turn?.id) return;
    turnsSeen.get(threadId)?.add(turn.id);
    const startedBy = startedByFor(threadId, turn.id, live);
    if (live && !startedBys.has(turn.id) && startedBy.kind !== 'unknown') { startedBys.set(turn.id, startedBy); capped(startedBys); }
    const d = turnData(threadId, turn, { startedBy });
    // A turn is put again at turn/completed, after its final message linked `answer` (and areas linked `changes` or `automation`): keep them.
    const cur = resident(d.ref);
    const links = { ...(cur?.links ?? {}), ...d.links };
    const why = triggers.get(turn.id) ?? (cur?.state.trigger ? { trigger: cur.state.trigger, ...pick(cur.state, 'triggerBy', 'triggerDetail') } : null);
    // a stopped turn: who stopped it (an accepted interrupt; an interrupt nobody here saw: another client's, or the app-server's own; one
    // still awaiting its answer says so once answered: stoppedEnded)
    const stoppedBy = d.state.status === 'stopped' ? stopsBy.get(turn.id) ?? cur?.state.stoppedBy ?? { kind: 'unknown' } : null;
    // what reports added since (its aggregate diff) stays
    const kept = cur?.state.diff !== undefined ? { diff: cur.state.diff } : {};
    safe('turn', () => handle.put(d.ref, { state: { ...kept, ...d.state, ...(why ?? {}), ...(stoppedBy ? { stoppedBy } : {}) }, links }));
    if (items) for (const item of Array.isArray(turn.items) ? turn.items : []) putItem(threadId, turn.id, item, { done: true, startedAt: (turn.startedAt ?? 0) * 1000 });
  }
  // A step's request (Step.request: the Request whose `step` names it) and the steps an item made (for Step.updated), by `<threadId>:<itemId>`.
  const stepRequests = new Map();
  const itemSteps = new Map();
  const stepUpdatedAt = new Map();
  const STEP_DELTAS = new Set(['item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated', 'item/mcpToolCall/progress', 'item/plan/delta', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta']);
  const capped = (m, max = 5000) => { while (m.size > max) m.delete(m.keys().next().value); };
  /** `updated` on the steps an item made, at most every 250 ms for each (output and summary deltas stream). */
  function stepUpdated(threadId, itemId) {
    for (const r of itemSteps.get(`${threadId}:${itemId}`) ?? []) {
      const t = now();
      if (!resident(r) || t - (stepUpdatedAt.get(r.id) ?? -Infinity) < 250) continue;
      stepUpdatedAt.set(r.id, t);
      capped(stepUpdatedAt);
      emitEvent(r, 'updated');
    }
  }
  function putItem(threadId, turnId, item, opts) {
    if (!item?.id || !turnId) return [];
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      const k = `${threadId}:${item.id}`;
      fileItems.set(k, item);
      capped(fileItems);
      const asked = pendingEdits.get(k);
      if (asked) {
        pendingEdits.delete(k);
        const d = requestData('item/fileChange/requestApproval', { threadId, itemId: item.id }, 'x', { now, item });
        if (resident(asked)) safe('edit files', () => handle.update(asked, { state: { files: d.state.files }, links: { edits: d.links.edits } }));
      }
    }
    const out = [];
    for (const d of itemData(threadId, turnId, item, opts)) {
      out.push(d.ref);
      const cur = resident(d.ref);
      const state = cur && cur.state.createdAt && d.state.createdAt === 0 ? { ...d.state, createdAt: cur.state.createdAt } : d.state;
      const request = stepRequests.get(d.ref.id);
      safe(`item ${item.type}`, () => handle.put(d.ref, { state: cur?.state.startedAt && !state.startedAt ? { ...state, startedAt: cur.state.startedAt } : state, links: request ? { ...d.links, request } : d.links }));
      if (conceptOfType(d.ref.type) === 'Step') {
        const k = `${threadId}:${item.id}`;
        const list = itemSteps.get(k) ?? [];
        if (!list.some((x) => x.id === d.ref.id && x.type === d.ref.type)) itemSteps.set(k, [...list, d.ref]);
        capped(itemSteps);
      }
      if (d.ref.type === 'AgentMessage' && d.state.phase === 'final' && opts.done) safe('turn answer', () => resident(refs.turn(turnId)) && handle.update(refs.turn(turnId), { links: { answer: d.ref } }));
    }
    return out;
  }
  /** An item and the parts it owns: a plan's tasks, a message's attachments and mentions. */
  function removeItem(x) {
    for (const part of [...graph.referrers(x.ref, 'plan'), ...graph.referrers(x.ref, 'message')]) if (part.ref.provider === PROVIDER) safe('removal', () => handle.remove(part.ref));
    for (const m of Array.isArray(x.links?.mentions) ? x.links.mentions : []) safe('removal', () => handle.remove(m));
    safe('removal', () => handle.remove(x.ref));
  }
  /** A turn and everything in it (messages, steps, requests). */
  function removeTurn(r) {
    for (const x of graph.referrers(r, 'turn')) if (x.ref.provider === PROVIDER) removeItem(x);
    safe('removal', () => handle.remove(r));
  }
  /** turn/plan/updated: the turn's task list, replaced wholesale (a task it no longer lists goes). */
  function putPlan(threadId, turnId, p) {
    if (!threadId || !turnId) return;
    const [plan, ...tasks] = planData(threadId, turnId, p, { startedAt: now() });
    const cur = resident(plan.ref);
    safe('plan', () => handle.put(plan.ref, { state: cur?.state.startedAt ? { ...plan.state, startedAt: cur.state.startedAt } : plan.state, links: plan.links }));
    if (!resident(plan.ref)) return;
    for (const d of tasks) safe('plan task', () => handle.put(d.ref, { state: d.state, links: d.links }));
    const keep = new Set(tasks.map((d) => d.ref.id));
    for (const x of graph.referrers(plan.ref, 'plan')) if (!keep.has(x.ref.id)) safe('plan task removal', () => handle.remove(x.ref));
    if (!cur) { emitEvent(plan.ref, 'started'); if (resident(refs.turn(turnId))) emitEvent(refs.turn(turnId), 'stepAdded', plan.ref); }
    emitEvent(plan.ref, 'tasksChanged');
  }
  /** A thread's history was cut (thread/revert from a turn on, or thread/rollback of its last turns: the app's Edit of the last message):
   *  the turns it dropped, and everything in them, go. Files are not reverted by it, so nothing else changes. */
  function historyEdited(threadId) {
    const p = historyEdits.get(threadId);
    historyEdits.delete(threadId);
    if (!p) return;
    const turns = graph.referrers(refs.thread(threadId), 'thread').filter((x) => conceptOfType(x.ref.type) === 'Turn' && x.ref.provider === PROVIDER)
      .sort((a, b) => (a.state.startedAt ?? 0) - (b.state.startedAt ?? 0));
    const from = typeof p.beforeTurnId === 'string' ? turns.findIndex((t) => t.ref.id === p.beforeTurnId)
      : Number.isSafeInteger(p.numTurns) && p.numTurns > 0 ? Math.max(0, turns.length - p.numTurns) : -1;
    if (from >= 0) for (const t of turns.slice(from)) removeTurn(t.ref);
  }
  /** A thread Codex no longer has, and everything in it. */
  function removeThread(threadId) {
    const r = refs.thread(threadId);
    for (const x of graph.referrers(r, 'thread')) if (x.ref.provider === PROVIDER) { if (conceptOfType(x.ref.type) === 'Turn') removeTurn(x.ref); else safe('removal', () => handle.remove(x.ref)); }
    safe('removal', () => handle.remove(r));
    loaded.delete(threadId);
    ephemeral.delete(threadId);
    cwds.delete(threadId);
    historyEdits.delete(threadId);
  }

  // ---------------------------------------------------------------- reading
  /**
   * Read every page of thread/list, active then archived, of every source kind and model provider. The collection is complete when both are
   * read, and the read replaces it: a thread it did not list, and that was not put while it ran, is removed.
   */
  function listThreads() {
    if (listing) return listing;
    handle.setComplete('Thread', false);
    const seen = new Set();
    listSeen = seen;
    listing = (async () => {
      for (const archived of [false, true]) {
        let cursor = null;
        do {
          const r = await request('thread/list', { limit: pageSize, archived, sourceKinds: SOURCE_KINDS, modelProviders: [], ...(cursor ? { cursor } : {}) });
          for (const t of r?.data ?? []) putThread(t, { archived });
          cursor = r?.nextCursor ?? null;
        } while (cursor && !disposed);
      }
      if (disposed) return;
      for (const t of graph.list('Thread')) if (t.ref.provider === PROVIDER && !seen.has(t.ref.id) && !ephemeral.has(t.ref.id)) removeThread(t.ref.id);
      handle.setComplete('Thread', true); needsRead = false;
    })().finally(() => { listing = null; if (listSeen === seen) listSeen = null; });
    return listing;
  }
  // Each model's context window, as a turn's token usage told it (model/list does not say it; public-hooks.md §4 F13): kept across reads.
  // The model is the one the turn ran with (its turn/start's, else its chat's model then, a reroute's after it); a turn whose model is not
  // known teaches nothing (built review: never the chat's model as it was read, which a change or an override has left behind).
  const contextWindows = new Map();   // model id -> tokens
  /** A turn's token usage told its model's context window: the Model says it. */
  function learnContextWindow(turnId, usage) {
    const n = usage?.modelContextWindow;
    const id = typeof turnId === 'string' ? turnModels.get(turnId) : undefined;
    if (!Number.isSafeInteger(n) || n <= 0 || typeof id !== 'string' || !id || contextWindows.get(id) === n) return;
    contextWindows.set(id, n);
    const model = refs.model(id);
    if (resident(model)) safe('model context window', () => handle.update(model, { state: { contextWindow: n } }));
  }
  /** Read every page of model/list (hidden models too), then drop the models it no longer lists. The collection is complete when all is read. */
  function listModels() {
    return (async () => {
      handle.setComplete('Model', false);
      const seen = new Set();
      let cursor = null;
      do {
        const r = await request('model/list', { limit: pageSize, includeHidden: true, ...(cursor ? { cursor } : {}) });
        for (const m of r?.data ?? []) {
          const d = modelData(m);
          if (!d) continue;
          seen.add(d.ref.id);
          const was = resident(d.ref)?.state.available;
          const window = contextWindows.get(d.ref.id);
          safe('model', () => handle.put(d.ref, { state: window ? { ...d.state, contextWindow: window } : d.state, links: d.links }));
          if (was !== undefined && was !== d.state.available) emitEvent(d.ref, 'availabilityChanged');
        }
        cursor = r?.nextCursor ?? null;
      } while (cursor && !disposed);
      if (disposed) return;
      for (const m of graph.list('Model')) if (m.ref.provider === PROVIDER && !seen.has(m.ref.id)) safe('model removal', () => handle.remove(m.ref));
      handle.setComplete('Model', true);
    })();
  }
  /** The models are read on their own: a failure leaves them stale (or partial) and never stops the thread list. A request that comes
   *  while one is running (the account changed) runs again after it. */
  function readModels() {
    if (modelListing) { modelsDirty = true; return modelListing; }
    modelListing = listModels().catch((e) => log.warn('codex source: reading the models failed', { message: String(e?.message ?? e) })).finally(() => {
      modelListing = null;
      if (modelsDirty) { modelsDirty = false; if (!disposed) readModels(); }
    });
    return modelListing;
  }
  /**
   * Load a thread's turns with their items (every page), once; notifications keep it live afterwards. The read replaces the thread's turns:
   * one it did not list, and that was not put while it ran, is removed with what is in it.
   */
  function loadThread(threadId) {
    if (ephemeral.has(threadId)) loaded.add(threadId);   // nothing on disk to read: its turns come from the notifications
    if (loaded.has(threadId)) return Promise.resolve();
    if (loading.has(threadId)) return loading.get(threadId);
    const seen = new Set();
    turnsSeen.set(threadId, seen);
    const p = (async () => {
      let cursor = null;
      do {
        const r = await request('thread/turns/list', { threadId, itemsView: 'full', limit: pageSize, ...(cursor ? { cursor } : {}) });
        for (const turn of r?.data ?? []) putTurn(threadId, turn, { items: true });
        cursor = r?.nextCursor ?? null;
      } while (cursor && !disposed);
      if (disposed) return;
      for (const x of graph.referrers(refs.thread(threadId), 'thread')) if (conceptOfType(x.ref.type) === 'Turn' && x.ref.provider === PROVIDER && !seen.has(x.ref.id)) removeTurn(x.ref);
      loaded.add(threadId);
    })().finally(() => { loading.delete(threadId); if (turnsSeen.get(threadId) === seen) turnsSeen.delete(threadId); });
    loading.set(threadId, p);
    return p;
  }
  /** A loaded thread is subscribed again: read its newest turns once, for anything that happened while nobody was subscribed. */
  function catchUp(threadId) {
    if (!loaded.has(threadId) || loading.has(threadId) || disposed || ephemeral.has(threadId)) return;
    request('thread/turns/list', { threadId, itemsView: 'full', limit: pageSize })
      .then((r) => { for (const turn of r?.data ?? []) putTurn(threadId, turn, { items: true }); })
      .catch((e) => log.warn('codex source: catching up a thread failed', { thread: threadId, message: String(e?.message ?? e) }));
  }
  /** After a restart or a gap: everything is stale until read again. Resolves true when the list was read. */
  function resync(why) {
    log.info('codex source: re-reading', { why });
    handle.markStale();
    const threads = [...loaded];
    loaded.clear();
    const models = readModels();
    return listThreads().then(() => { putAgent(true); return Promise.all([models, ...threads.map((t) => loadThread(t).catch(() => {}))]); }).then(() => { needsRead = false; resyncFailures = 0; return true; }, (e) => {
      log.warn('codex source: re-read failed', { message: String(e?.message ?? e), attempt: resyncFailures + 1 });
      if (++resyncFailures < 5) scheduleResync(why, 3000);
      return false;
    });
  }
  /** One re-read after a burst of ready events (the app opens several short-lived connections at launch). */
  function scheduleResync(why, delayMs = 1500) {
    if (disposed) return;
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => { resyncTimer = null; if (!disposed) resync(why); }, delayMs);
    resyncTimer.unref?.();
  }

  // ---------------------------------------------------------------- the feed
  /** A thread's event, when the thread is resident. */
  const threadEvent = (threadId, name, payload) => { const r = refs.thread(threadId); if (resident(r)) emitEvent(r, name, payload); };
  /** A report's params as given, less the ids that name where it is (the event is on that thread or turn). */
  const withoutIds = (p) => { const { threadId: _t, turnId: _u, ...rest } = p ?? {}; return rest; };
  /** A turn's event, when the turn is resident. */
  const turnEvent = (turnId, name, payload) => { if (typeof turnId !== 'string') return; const r = refs.turn(turnId); if (resident(r)) emitEvent(r, name, payload); };
  /**
   * The reasoning as it streams (graph-integrity G1.1): a summary part added, text added to a summary part (`summaryIndex`) or to the content
   * (`contentIndex`), kept part by part on the step, its summary also as shown (`thinking`).
   */
  function reasoningDelta(method, p) {
    const r = refs.item('CodexReasoning', p?.threadId, p?.itemId);
    const cur = resident(r);
    if (!cur) return;
    const summaryParts = [...(cur.state.summaryParts ?? [])], contentParts = [...(cur.state.contentParts ?? [])];
    const at = (list, i) => { const n = Number.isSafeInteger(i) && i >= 0 ? i : Math.max(0, list.length - 1); while (list.length <= n) list.push(''); return n; };
    if (method === 'item/reasoning/summaryPartAdded') at(summaryParts, p.summaryIndex);
    else if (method === 'item/reasoning/summaryTextDelta') { const i = at(summaryParts, p.summaryIndex); summaryParts[i] += String(p.delta ?? ''); }
    else { const i = at(contentParts, p.contentIndex); contentParts[i] += String(p.delta ?? ''); }
    safe('reasoning', () => handle.update(r, { state: { summaryParts, contentParts, thinking: { parts: [{ kind: 'text', text: summaryParts.join('\n') }] } } }));
  }
  const TURN_ENDS = { completed: 'completed', interrupted: 'stopped', failed: 'failed' };
  /** A thread just created (thread/started, or the answer to a thread/start or thread/fork, which its creator gets instead): once. */
  function createdThread(th) {
    if (!th?.id) return;
    const had = !!resident(refs.thread(th.id));
    putThread(th);
    if (!had) threadEvent(th.id, 'created');
  }
  function onNotification(method, p) {
    coreNotification(method, p);
    eachArea((f) => f.notified?.(method, p));
  }
  function coreNotification(method, p) {
    switch (method) {
      case 'thread/started': return createdThread(p?.thread);
      case 'fs/changed': files?.changed(p); instructions?.changed(p); return actions?.changed(p);   // a watch of the file, instructions or action feed (or the app's own, which they ignore)
      case 'thread/attachment/updated': return worktrees?.attachmentUpdated(p);
      case 'thread/status/changed': updateThread(p.threadId, { status: threadStatus(p.status), waitingOn: threadWaitingOn(p.status) }); return threadEvent(p.threadId, 'statusChanged');
      case 'thread/name/updated': updateThread(p.threadId, { title: p.threadName || resident(refs.thread(p.threadId))?.state.preview || 'New thread' }); return threadEvent(p.threadId, 'titleChanged');
      case 'thread/archived': updateThread(p.threadId, { archived: true }); return threadEvent(p.threadId, 'archived');
      case 'thread/unarchived': updateThread(p.threadId, { archived: false }); return threadEvent(p.threadId, 'restored');
      case 'thread/closed': {   // an ephemeral thread ends here (a materialized one is only unloaded: it stays a thread)
        if (!ephemeral.has(p.threadId) || !resident(refs.thread(p.threadId))) return undefined;
        removeThread(p.threadId);
        return emitEvent(refs.thread(p.threadId), 'deleted');
      }
      case 'thread/deleted': {
        if (!resident(refs.thread(p.threadId))) return undefined;
        removeThread(p.threadId);
        return emitEvent(refs.thread(p.threadId), 'deleted');
      }
      case 'thread/goal/updated': return applyGoal(p.threadId, p.goal);
      case 'thread/goal/cleared': return applyGoal(p.threadId, null);
      case 'model/rerouted': {   // the turn runs with another model from here on
        if (typeof p.turnId === 'string' && typeof p.toModel === 'string' && p.toModel) { turnModels.set(p.turnId, p.toModel); capped(turnModels); }
        return turnEvent(p.turnId, 'modelRerouted', { fromModel: String(p.fromModel ?? ''), toModel: String(p.toModel ?? ''), reason: String(p.reason ?? '') });
      }
      case 'thread/tokenUsage/updated': {
        // every report as given (graph-integrity G1.3): the thread's last one is its usage, and each one is an event, repeats included
        learnContextWindow(p.turnId, p.tokenUsage);
        const u = tokenUsage(p.tokenUsage);
        if (!u) return undefined;
        updateThread(p.threadId, { usage: u });
        return threadEvent(p.threadId, 'tokenUsageReported', { tokenUsage: u, turnId: String(p.turnId ?? '') });
      }
      case 'error': return turnEvent(p.turnId, 'errored', { error: p.error ?? null, willRetry: p.willRetry === true });
      case 'turn/diff/updated': { const r = refs.turn(p.turnId); return resident(r) && typeof p.diff === 'string' ? safe('turn diff', () => handle.update(r, { state: { diff: p.diff } })) : undefined; }
      case 'model/verification': return turnEvent(p.turnId, 'verified', { verifications: Array.isArray(p.verifications) ? p.verifications : [] });
      case 'thread/compacted': return threadEvent(p.threadId, 'compacted', typeof p.turnId === 'string' ? { turnId: p.turnId } : {});
      case 'thread/reverted': return threadEvent(p.threadId, 'reverted');
      case 'hook/started': case 'hook/completed':
        return threadEvent(p.threadId, method === 'hook/started' ? 'hookStarted' : 'hookCompleted', { run: p.run ?? null, ...(typeof p.turnId === 'string' ? { turnId: p.turnId } : {}) });
      case 'guardianWarning': return threadEvent(p.threadId, 'guardianWarning', { message: String(p.message ?? '') });
      case 'warning': return p.threadId ? threadEvent(p.threadId, 'warning', { message: String(p.message ?? '') }) : undefined;
      case 'thread/prediction/updated': return threadEvent(p.threadId, 'predicted', withoutIds(p));
      case 'item/autoApprovalReview/started': return turnEvent(p.turnId, 'approvalReviewStarted', withoutIds(p));
      case 'item/autoApprovalReview/completed': return turnEvent(p.turnId, 'approvalReviewCompleted', withoutIds(p));
      case 'autoApprovalReview/strictReviewRequired': return turnEvent(p.turnId, 'strictReviewRequired', withoutIds(p));
      case 'model/safetyBuffering/updated': return turnEvent(p.turnId, 'safetyBuffering', withoutIds(p));
      case 'turn/moderationMetadata': return turnEvent(p.turnId, 'moderated', withoutIds(p));
      case 'turn/started': case 'turn/completed': {
        putTurn(p.threadId, p.turn, { live: method === 'turn/started' });
        const r = p.turn?.id ? refs.turn(p.turn.id) : null;
        if (!r || !resident(r)) return undefined;
        const at = (x) => (Number.isFinite(x) ? x * 1000 : undefined);
        if (method === 'turn/started') { emitEvent(r, 'started', null, at(p.turn.startedAt)); return threadEvent(p.threadId, 'turnStarted', r); }
        if (TURN_ENDS[p.turn.status] === 'stopped') stoppedEnded(r);
        else if (TURN_ENDS[p.turn.status]) emitEvent(r, TURN_ENDS[p.turn.status], null, at(p.turn.completedAt));
        accounts.turnEnded();   // the usage moved
        return threadEvent(p.threadId, 'turnFinished', r);
      }
      case 'item/started': {
        for (const r of putItem(p.threadId, p.turnId, p.item, { done: false, startedAt: p.startedAtMs ?? now() })) {
          if (conceptOfType(r.type) !== 'Step' || !resident(r)) continue;
          emitEvent(r, 'started');
          if (resident(refs.turn(p.turnId))) emitEvent(refs.turn(p.turnId), 'stepAdded', r);
        }
        return undefined;
      }
      case 'item/completed': {
        pendingText.delete(`${p.threadId}:${p.item?.id}`);
        for (const r of putItem(p.threadId, p.turnId, p.item, { done: true, startedAt: p.startedAtMs ?? 0 })) {
          if (!resident(r)) continue;
          if (conceptOfType(r.type) === 'Step') emitEvent(r, 'finished');
          else if (r.type === 'AgentMessage') emitEvent(r, 'completed');
        }
        return undefined;
      }
      case 'item/agentMessage/delta': return onDelta(p);
      case 'turn/plan/updated': return putPlan(p.threadId, p.turnId, p);
      case 'serverRequest/resolved': return onResolved(p);
      case 'account/updated': case 'account/login/completed': accounts.notified(method, p); return void readModels();   // the catalog depends on the account
      case 'account/rateLimits/updated': return void accounts.notified(method, p);
      case 'item/reasoning/summaryTextDelta': case 'item/reasoning/summaryPartAdded': case 'item/reasoning/textDelta':
        reasoningDelta(method, p);
        if (p?.threadId && p?.itemId) stepUpdated(p.threadId, p.itemId);
        return undefined;
      default:
        if (STEP_DELTAS.has(method) && p?.threadId && p?.itemId) stepUpdated(p.threadId, p.itemId);
        return undefined;
    }
  }
  /** Streaming text: coalesced, one update per turn of the event loop. */
  function onDelta(p) {
    const k = `${p.threadId}:${p.itemId}`;
    const r = refs.item('AgentMessage', p.threadId, p.itemId);
    let e = pendingText.get(k);
    if (!e) {
      const cur = resident(r);
      e = { text: cur ? cur.state.content.parts.map((x) => x.text ?? '').join('') : '', scheduled: false };
      pendingText.set(k, e);
    }
    e.text += String(p.delta ?? '');
    if (e.scheduled) return;
    e.scheduled = true;
    setImmediate(() => {
      e.scheduled = false;
      if (!pendingText.has(k) || !resident(r)) return;
      safe('streaming text', () => handle.update(r, { state: { content: { parts: [{ kind: 'text', text: e.text }] }, streaming: true } }));
      emitEvent(r, 'updated');
    });
  }
  function onRequest(method, params, sid) {
    const itemKey = params?.threadId && params?.itemId ? `${params.threadId}:${params.itemId}` : null;
    const d = requestData(method, params, sid, { now, item: itemKey ? fileItems.get(itemKey) ?? null : null });
    if (!d) return;
    // one held while mods were asked and now shown to the user (Request.ask): already put and opened
    if (requestsBySid.get(sid)?.id === d.ref.id && resident(d.ref)) return;
    // an edit asked before its step came: its files follow when the step does
    if (d.ref.type === 'EditApproval' && itemKey && !fileItems.has(itemKey)) { pendingEdits.set(itemKey, d.ref); capped(pendingEdits); }
    requestsBySid.set(sid, d.ref);
    requestParams.set(sid, { method, params });
    safe('request', () => handle.put(d.ref, { state: d.state, links: d.links, ...(Number.isFinite(params?.startedAtMs) ? { sourceAt: params.startedAtMs } : {}) }));
    if (!resident(d.ref)) return;
    if (d.links.step) {   // Step.request: the step the request is about links back to it, now and after the step is put again
      stepRequests.set(d.links.step.id, d.ref);
      capped(stepRequests);
      if (resident(d.links.step)) safe('step request', () => handle.update(d.links.step, { links: { request: d.ref } }));
    }
    emitEvent(d.ref, 'opened', null, Number.isFinite(params?.startedAtMs) ? params.startedAtMs : undefined);
    threadEvent(params.threadId, 'requestOpened', d.ref);
  }
  /**
   * An answer seen at the mux (public-hooks.md §3.6, H5): what was answered and who answered. This provider's own answers are its graph
   * caller's; every other one is told by the connection it came on: the app's (the user, in a card, a notification or a key: one
   * connection), a mod's client (that mod), else not known.
   */
  function onAnswer(sid, result, info) {
    const q = requestParams.get(sid);
    requestParams.delete(sid);
    const by = answeredByNext.get(sid) ?? byOrigin(info?.origin);
    answeredByNext.delete(sid);
    const r = requestsBySid.get(sid);
    if (!r || !resident(r)) return;
    const cur = resident(r);
    if (cur.state.status !== 'pending') return;
    const outcome = answerOf(q?.method, result, q?.params);
    const answeredBy = { ...by, at: now() };
    safe('answer', () => handle.update(r, { state: { status: answerStatus(cur.ref.type, result), answeredAt: answeredBy.at, outcome, answeredBy } }));
    emitEvent(r, 'answered', { outcome, answeredBy });
    if (cur.ref.type === 'ComputerUseApproval') apps?.read();   // an "always" adds an approval: the apps' levels change
  }
  /** A turn/interrupt seen: who asked, this provider's caller or else the connection's (the app's is the user's stop); kept until answered. */
  function interrupting(key, turnId, origin) {
    const by = stopsNext.get(turnId) ?? byOrigin(origin);
    stopsNext.delete(turnId);
    interrupts.set(key, { turnId, by });
    capped(interrupts, 500);
  }
  /** Its answer: an accepted interrupt says who stopped the turn (the first accepted one); a refused one says nothing. */
  function interrupted(key, ok) {
    const i = interrupts.get(key);
    interrupts.delete(key);
    if (!i) return;
    if (ok && !stopsBy.has(i.turnId)) { stopsBy.set(i.turnId, i.by); capped(stopsBy, 500); }
    // the turn stopped while this awaited its answer: said now, once no other interrupt of it is waiting
    const w = stopsWaiting.get(i.turnId);
    if (w && ![...interrupts.values()].some((x) => x.turnId === i.turnId)) { clearTimeout(w); stopsWaiting.delete(i.turnId); stopped(refs.turn(i.turnId)); }
  }
  /** A turn ended stopped: its `stopped` event, with who stopped it; while an interrupt of it awaits its answer, once answered (at most STOP_WAIT_MS). */
  function stoppedEnded(r) {
    if (stopsBy.has(r.id) || ![...interrupts.values()].some((i) => i.turnId === r.id)) return stopped(r);
    const t = setTimeout(() => { stopsWaiting.delete(r.id); stopped(r); }, STOP_WAIT_MS);
    t.unref?.();
    stopsWaiting.set(r.id, t);
    capped(stopsWaiting, 500);
  }
  function stopped(r) {
    const cur = resident(r);
    if (!cur) return;
    const by = stopsBy.get(r.id) ?? cur.state.stoppedBy ?? { kind: 'unknown' };
    if (JSON.stringify(cur.state.stoppedBy) !== JSON.stringify(by)) safe('turn stopped by', () => handle.update(r, { state: { stoppedBy: by } }));
    emitEvent(r, 'stopped', { by });
  }
  /** A turn/start answered: why its turn started, kept for the turn (and set on it when it is here already). */
  function started(key, turnId) {
    const s = turnStarts.get(key);
    turnStarts.delete(key);
    if (!s || typeof turnId !== 'string') return;
    const by = s.cid ? sendsBy.get(s.cid) ?? null : null;
    if (s.cid) sendsBy.delete(s.cid);
    const why = triggerOf(s.raw, s.origin, by);
    triggers.set(turnId, why);
    capped(triggers);
    const startedBy = startedByOf(why, by);
    startedBys.set(turnId, startedBy);
    capped(startedBys);
    if (s.model && !turnModels.has(turnId)) { turnModels.set(turnId, s.model); capped(turnModels); }
    const r = refs.turn(turnId);
    if (resident(r)) safe('turn trigger', () => handle.update(r, { state: { ...why, startedBy } }));
  }
  /** A turn-starting request answered: no turn that starts on its thread from now on is its client's. */
  function closeStart(key) {
    for (const [threadId, list] of openStarts) {
      const i = list.findIndex((x) => x.key === key);
      if (i < 0) continue;
      list.splice(i, 1);
      if (!list.length) openStarts.delete(threadId);
      return;
    }
  }
  function onResolved(p) {
    const r = requestsBySid.get(p?.requestId);
    requestsBySid.delete(p?.requestId);
    requestParams.delete(p?.requestId);
    answeredByNext.delete(p?.requestId);
    const cur = r ? resident(r) : null;
    if (cur?.state.status !== 'pending') return;
    // ended with nobody's answer (its turn stopped, the server withdrew it)
    const answeredBy = { kind: 'app', via: 'server', at: now() };
    safe('resolution', () => handle.update(r, { state: { status: 'cancelled', answeredAt: answeredBy.at, outcome: { decision: 'cancelled' }, answeredBy } }));
    emitEvent(r, 'cancelled', { outcome: { decision: 'cancelled' }, answeredBy });
  }

  putAgent(true);
  handle.setComplete('Agent', true);   // this one agent is the whole native collection from the start

  /** A request's key, its answer's too: who sent it (its connection and app session, two sessions' ids can be the same) and its id. */
  /** The backends whose threads are Codex's: the app's, and an added account's (RM10). */
  const codexBackend = (b) => b === 'primary' || addedFeeds.keyOf(b) !== null;
  const reqKey = (info, id) => `${info.origin}\0${info.session?.id ?? ''}\0${typeof id}:${id}`;
  const sub = client.observe({}, (m, info) => {
    if (disposed) return;
    if (!info) { needsRead = true; scheduleResync('observer gap', 0); return; }
    // a mod's own backends are not Codex's threads; an added account's are (RM10), and what it says of its account is its feed's
    const addedKey = addedFeeds.keyOf(info.backend);
    if (info.backend !== 'primary' && !addedKey) return;
    if (addedKey && info.affinityKey === undefined && !KEYLESS_CHAT.has(info.method)) {
      if (info.kind === 'serverNotification') addedFeeds.notified(addedKey, info.method, m?.params ?? {});
      return;
    }
    if (addedKey && info.kind === 'serverNotification' && info.method === 'turn/completed') addedFeeds.turnEnded(addedKey);
    switch (info.kind) {
      case 'serverNotification': return onNotification(info.method, m?.params ?? {});
      case 'serverRequest': return onRequest(info.method, m?.params, m?.id);
      case 'clientResponse': return onAnswer(m?.id, m?.result, info);
      case 'clientRequest':
        if ((info.method === 'thread/revert' || info.method === 'thread/rollback') && typeof m?.params?.threadId === 'string') historyEdits.set(m.params.threadId, m.params);
        if (STARTS_TURN.has(info.method) && m?.id !== undefined && typeof m?.params?.threadId === 'string') {
          const list = openStarts.get(m.params.threadId) ?? [];
          list.push({ key: reqKey(info, m.id), origin: info.origin, method: info.method });
          openStarts.set(m.params.threadId, list);
          capped(openStarts, 500);
        }
        if (info.method === 'turn/start' && m?.id !== undefined) {
          // the model it runs with, as the server takes it: its collaboration mode's, else its own, else its chat's as it is now
          const named = [m.params?.collaborationMode?.settings?.model, m.params?.model].find((x) => typeof x === 'string' && x);
          const model = named ?? (typeof m.params?.threadId === 'string' ? resident(refs.threadSetting(m.params.threadId, 'model'))?.state.value ?? null : null);
          turnStarts.set(reqKey(info, m.id), { raw: m.params?.turnTrigger ?? null, origin: info.origin, cid: m.params?.clientUserMessageId ?? null, model: typeof model === 'string' ? model : null });
          capped(turnStarts, 500);
        }
        if (info.method === 'turn/interrupt' && typeof m?.params?.turnId === 'string' && m?.id !== undefined) interrupting(reqKey(info, m.id), m.params.turnId, info.origin);
        return undefined;
      case 'serverResponse':
        if (STARTS_TURN.has(info.method)) closeStart(reqKey(info, m?.id));
        if (info.method === 'turn/start') started(reqKey(info, m?.id), m?.result?.turn?.id);
        if (info.method === 'turn/interrupt') interrupted(reqKey(info, m?.id), !m?.error);
        if (!m?.result) return undefined;
        if (info.method === 'thread/revert' || info.method === 'thread/rollback') historyEdited(m.result.thread?.id);
        if (READ_METHODS.has(info.method)) {
          if (info.method === 'thread/list') { for (const t of m.result.data ?? []) putThread(t, {}); }
          else if (info.method === 'thread/start' || info.method === 'thread/fork') createdThread(m.result.thread);
          else putThread(m.result.thread);
        }
        return eachArea((f) => f.responded?.(info.method, m.result));   // after the core: a thread the answer names is put
      default: return undefined;
    }
  }, { queue: 100_000 });

  // ---------------------------------------------------------------- Request.ask (public-hooks.md §3.6, H6)
  // A request some mod's interceptor of `ask` would see (on its type or a supertype) is held at the mux before the app shows it: it is put
  // and opened at once, its `ask` runs through the graph as this provider's, and the chain's end (the default: show it), its deadline or
  // any fault releases it to the app's card. An answer meanwhile (a mod's approve, deny or answer) settles it at the mux, once. A request
  // nobody intercepts is never held.
  const ASK_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
    'mcpServer/elicitation/request', 'item/tool/requestUserInput'];
  const NATIVE = Object.freeze({ kind: 'native', id: PROVIDER });
  const holdSub = typeof client.intercept === 'function' ? client.intercept('serverRequest', ASK_METHODS, (m, info) => {
    if (disposed || !serverUp || !codexBackend(info?.backend) || typeof graph.intercepted !== 'function') return undefined;
    const d = requestData(m?.method ?? info?.method, m?.params, m?.id, { now });
    return d && graph.intercepted(d.ref.type, 'ask') ? { defer: true } : undefined;
  }, { timeoutMs: 1000 }) : null;
  // ---------------------------------------------------------------- a mod's tools (graph-integrity G3.5)
  // The agent's call of a tool of a `mod_` namespace (the framework's names, each a mod's) is Tool._call on that tool, through the graph
  // as this provider's: its mod answers it (a replacing interceptor, its own namespace only); unanswered, this provider's own handler says
  // the mod is not running. So every such call reaches the mod's code, across restarts, or fails with a reason; never the app's.
  const toolSub = typeof client.intercept === 'function' ? client.intercept('serverRequest', ['item/tool/call'], (m, info) => {
    if (disposed || !codexBackend(info?.backend)) return undefined;
    const ns = m?.params?.namespace;
    return typeof ns === 'string' && ns.startsWith(TOOL_PREFIX) ? { defer: true } : undefined;
  }, { timeoutMs: 1000, priority: 1000 }) : null;
  const toolCalls = new Map();   // the call's token -> its abort, while the mod runs it
  async function callTool(token, p) {
    const ns = String(p?.namespace ?? ''), name = String(p?.tool ?? '');
    const ref = refs.modTool(ns, name);
    const failure = (text) => ({ success: false, contentItems: [{ type: 'inputText', text: String(text).slice(0, 2000) }] });
    let result;
    const { signal, abort } = createAbort();
    toolCalls.set(token, abort);
    try {
      if (!resident(ref)) handle.put(ref, { state: { name, description: '', enabled: true, source: 'mod' }, links: {} });
      const env = { thread: refs.thread(String(p?.threadId ?? '')), turn: refs.turn(String(p?.turnId ?? '')), call: String(p?.callId ?? '') };
      const out = await graph.invoke({ ref, operation: '_call', args: [p?.arguments ?? null, env], caller: NATIVE, signal });
      if (out.status === 'done') {
        try { result = { success: true, contentItems: contentItems(out.value) }; } catch (e) { result = failure(`${name} answered what is not a tool's result: ${e?.message ?? e}`); }
      } else result = failure(out.message ?? out.error?.message ?? `${name} failed`);
    } catch (e) { result = failure(`${name} failed: ${e?.message ?? e}`); }
    finally { toolCalls.delete(token); }
    if (signal.aborted) return;
    try { await client.respond(token, { result }); } catch (e) { log.warn('codex: a tool call was not answered', { message: String(e?.message ?? e) }); }
  }
  const deferSub = typeof client.onDeferred === 'function' ? client.onDeferred(({ token, message, info }) => {
    if ((info?.method ?? message?.method) === 'item/tool/call') { void callTool(token, message?.params ?? {}); return; }
    const sid = message?.id;
    held.set(sid, token);
    if (disposed) { void show(sid); return; }
    onRequest(info?.method ?? message?.method, message?.params, sid);
    void askAbout(sid);
  }) : null;
  const resolvedSub = typeof client.onResolved === 'function' ? client.onResolved((token) => {
    for (const [sid, t] of held) if (t === token) held.delete(sid);
    toolCalls.get(token)?.('resolved');   // the turn ended first: the call is let go
  }) : null;
  /** A held request's `ask` through the graph; whatever its end, a request still held is shown. */
  async function askAbout(sid) {
    const ref = requestsBySid.get(sid);
    try { if (ref && resident(ref)?.state.status === 'pending') await graph.invoke({ ref, operation: 'ask', args: [], caller: NATIVE }); }
    catch (e) { log.warn('codex: a request\'s ask failed', { message: String(e?.message ?? e) }); }
    finally { await show(sid); }
  }
  /** A held request goes to the app's card (once); null when it was not held. */
  async function show(sid) {
    const token = held.get(sid);
    if (!token) return null;
    held.delete(sid);
    try { const r = await client.release(token); if (!r?.released) log.info('codex: a held request was not shown', { reason: r?.reason ?? null }); }
    catch (e) { log.warn('codex: a held request could not be shown', { message: String(e?.message ?? e) }); }
    return null;
  }
  const sidOf = (ref) => [...requestsBySid].find(([, r]) => r.id === ref.id && r.type === ref.type)?.[0];

  const busSubs = [];
  if (o.bus?.subscribe) {
    // A session the app closes itself (its startup probe, a computer-use connection) loses nothing: the threads live in the Codex
    // home. A backend that went away otherwise (a crash) stops the live feed: stale until read again.
    busSubs.push(o.bus.subscribe('appServer/exited', (d) => {
      if (disposed || d?.reason === 'app-disconnected') return;
      needsRead = true;
      serverUp = false;
      putAgent(false, 'The Codex app-server stopped');   // before markStale: a write makes an instance live again
      for (const id of [...ephemeral]) removeThread(id);   // never materialized: they ended with the backend
      files?.serverDown();
      instructions?.serverDown();
      actions?.serverDown();
      eachArea((f) => f.serverDown?.());
      handle.markStale();
    }));
    busSubs.push(o.bus.subscribe('appServer/ready', () => { serverUp = true; void addedFeeds.readAll(); files?.serverUp(); instructions?.serverUp(); actions?.serverUp(); if (areasStarted) eachArea((f) => f.serverUp?.()); else startAreas(); if (!disposed && needsRead) scheduleResync('app-server ready'); }));
  }
  // A loaded thread subscribed again catches up (a backend restart re-reads it in full instead: it is no longer loaded until then).
  const subChanges = mux.onSubscription?.(({ backend, key, open }) => { if (open && codexBackend(backend)) catchUp(key); }) ?? null;

  return {
    /** Read the thread list and the models (every page). The models never fail it. */
    start: async () => { projects?.sync(); files?.sync(); apps?.read(); cloud?.read(); git?.readAll(); instructions?.readAll(); actions?.readAll(); startAreas(); addedFeeds.sync(); await Promise.all([listThreads(), readModels(), accounts.read(), addedFeeds.readAll()]); putAgent(true); },
    loadThread,
    resync,
    /** The Request instance of a pending server request, by the id the clients saw (the page's request cards, breadth.md D2). */
    requestRefOf: (sid) => requestsBySid.get(sid) ?? null,
    /** A repository read again now (its branch, its changes), after any read under way: what a user's git action held is decided on
     * (built review H6m2a); true once read. */
    readRepository: (projectId) => git?.fresh(projectId) ?? Promise.resolve(false),
    /**
     * The repository of a folder (a page's git action names the folder it acts in: H6m4), or null: its checkout's own (git's common folder:
     * a worktree's is its repository's, wherever the worktree is), as the project whose folder holds it; a folder git does not know, none.
     */
    async repositoryOfPath(p) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || !appProjects) return null;
      const run = (args) => new Promise((resolve, reject) => {
        execFile('git', ['-C', p, ...args], { timeout: 3000, maxBuffer: 64 * 1024 }, (err, out, errOut) => {
          if (!err) { resolve(String(out).trim()); return; }
          // a folder git does not know (or one with no working tree): none; anything else (git missing, a timeout): it could not be read
          if (/not a git repository|must be run in a work tree/i.test(String(errOut))) resolve(null); else reject(err);
        });
      });
      const [top, common] = await Promise.all([run(['rev-parse', '--show-toplevel']), run(['rev-parse', '--path-format=absolute', '--git-common-dir'])]);
      if (!top || !common) return null;
      const real = (x) => { try { return fs.realpathSync.native(x); } catch { return x.length > 1 ? x.replace(/\/+$/, '') : x; } };
      const at = real(p), checkout = real(top);
      // the checkout's own project: the one whose folder is the checkout or inside it, and holds the folder (the nearest); never one around
      // the checkout (a submodule's superproject, a worktree's parent folder)
      let own = null;
      for (const pr of appProjects.list()) {
        for (const r of pr.roots) {
          const root = real(r);
          const inCheckout = root === checkout || root.startsWith(`${checkout}/`);
          const holds = at === root || at.startsWith(`${root}/`);
          if (inCheckout && holds && (!own || root.length > own.root.length)) own = { id: pr.id, root };
        }
      }
      if (own) return git?.has(own.id) ? { ref: refs.repository(own.id), checkout: 'own' } : null;
      // another worktree of a project's repository: git's common folder is that checkout's `.git`
      const mainCheckout = path.basename(common) === '.git' ? real(path.dirname(common)) : null;
      const main = mainCheckout ? appProjects.list().find((pr) => pr.roots.some((r) => real(r) === mainCheckout)) : null;
      return main && git?.has(main.id) ? { ref: refs.repository(main.id), checkout: 'worktree' } : null;
    },
    /** A pull request the app named by its identity, as its listed ref (a merge held from its panel: built review H6m2b). */
    pullRequestRef(ref) {
      for (const f of areaFeeds.values()) if (typeof f?.pullRequestRef === 'function') return f.pullRequestRef(ref) ?? ref;
      return ref;
    },
    /**
     * An app request as the operation of an instance an area feeds (public-hooks.md §3.5, H6m: a plugin's install, a tool server's config,
     * a skill turned on): `{ref, operation, args}`, or null. The first area that says so.
     */
    appOwn,
    appOperation(method, params) {
      const found = [];
      for (const [name, f] of areaFeeds) {
        if (typeof f?.appOperation !== 'function') continue;
        try { const x = f.appOperation(method, params && typeof params === 'object' ? params : {}); if (x) found.push(x); }
        catch (e) { log.warn(`codex: area ${name} could not read an app request`, { method, message: String(e?.message ?? e) }); }
      }
      return combineAppOperations(found);
    },
    get provider() { return handle; },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(resyncTimer);
      for (const t of stopsWaiting.values()) clearTimeout(t);
      stopsWaiting.clear();
      sub.dispose();
      holdSub?.dispose(); deferSub?.dispose(); resolvedSub?.dispose(); toolSub?.dispose();
      for (const abort of toolCalls.values()) abort('closed');
      for (const sid of [...held.keys()]) await show(sid);   // what was held goes to the app as it would have
      readSub?.dispose();
      projects?.dispose();
      files?.dispose();
      apps?.dispose();
      cloud?.dispose();
      instructions?.dispose();
      actions?.dispose();
      appStateFeed?.dispose();
      accounts.dispose();
      addedFeeds.dispose();
      git?.dispose();
      worktrees?.dispose();
      eachArea((f) => f.dispose?.());
      subChanges?.dispose();
      for (const s of busSubs) s.dispose();
      handle.dispose();
      await client.dispose();
    },
  };
}
