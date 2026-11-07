// Native types, area C of docs/graph/02-types.md: Thread, Turn, Message and Draft with their subtypes. One definition per card, written with
// the same builders a mod uses (define.mjs). Type ids are the card names; relations name their target by id, and targets outside this library
// are resolved when their types are added.
//
// Conventions of the native library (see index.mjs for the deviations from the cards):
// - A `?` on a card member is `.optional()`.
// - Path is a string, Duration is a number of milliseconds, Url is `s.url()`, and a card type that is a concept (Model, Agent, ...) is a
//   relation, even where the card lists it among the state fields.
// - A relation that is the inverse of a `one` relation on its target says so with `.inverse()`, so a provider writes each link once (a
//   `many` one lists every instance that links to it, a `maybe` one names the earliest); it is declared only where the target type is in
//   this library. `.parts()` marks owned parts (docs/graph/04 §7, containment).
// - Events carry a payload only where the card names one worth carrying. A state change reaches subscribers with its old and new value
//   through `watch` (04 §3), so `titleChanged` and `statusChanged` need none.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';
import { AutomationSpec } from './attention.mjs';

// who stopped a turn (public-hooks.md H8): the user (the app's stop, or an operation of theirs), a mod (`id`), the app on its own, or not
// known (another client); `via` how; `through` the mod whose surface the user stopped it in (graph-integrity G7.3)
const STOPPED_BY = s.object({ kind: s.enum('user', 'mod', 'app', 'unknown'), id: s.string().optional(), via: s.string().optional(), through: s.string().optional() });

export const Thread = defineConcept('Thread', {
  state: {
    title: s.string(),
    status: s.enum('idle', 'working', 'waitingForYou', 'error'),
    // what a waitingForYou thread waits on: an approval or an answer to a question (an approval first when it waits on both)
    waitingOn: s.enum('approval', 'question').optional(),
    unread: s.boolean(),
    archived: s.boolean(),
    origin: s.enum('user', 'fork', 'delegation', 'automation'),
    createdAt: s.time(),
    updatedAt: s.time(),
    preview: s.string().optional(), // the last line shown in lists
    pinned: s.boolean().optional(),
  },
  relations: {
    agent: r.one('Agent'),
    project: r.maybe('Project'),
    environment: r.maybe('Environment'),
    // The card lists `model?: Model` among the state fields; Model is a concept, so it is a relation (an optional one).
    model: r.maybe('Model').optional(),
    turns: r.many('Turn').parts().inverse('thread'),
    // its composer's draft: the app's composer writes it, whoever provides the thread (public-hooks.md §3.15)
    draft: r.maybe('Draft').inverse('thread'),
    queue: r.many('QueuedMessage').parts().inverse('thread'),
    requests: r.many('Request').parts().inverse('thread'),
    changes: r.maybe('ChangeSet'),
    settings: r.many('Setting').inverse('thread'), // thread scope, defined by its agent
    parent: r.maybe('Thread'),
    children: r.many('Thread').inverse('parent'), // its forks and delegations
    automation: r.maybe('Automation'),
    terminals: r.many('Terminal').inverse('thread'),
    browserTabs: r.many('BrowserTab').inverse('thread'),
    account: r.maybe('Account').optional(), // the account its turns use (Codex's: the app's, or one the user added, RM10)
  },
  operations: {
    // (content, options?): the options are the thread's provider's own (CodexThread's: {settings?: {model?, effort?, mode?, access?} (this
    // send's, the thread's Setting keys), sticky?, additionalContext? (the turn's additional context as the source has it, G3.5: what mods
    // add for the agent in the interceptor chain)}), checked by its handler; the card also takes a Draft; the schemas have no union
    // (Draft.send sends a draft)
    send: op({ args: [s.content(), s.json().optional()], returns: r.one('Turn') }),
    stop: op(),
    rename: op({ args: [s.string()] }),
    archive: op(),
    restore: op(),
    markRead: op(),
    markUnread: op().optional(),
    // into a project the app has, or out of every project with none (its own section); the app's "Move to project"
    moveTo: op({ args: [s.ref('Project').optional()] }).optional(),
    // its next turns on another of its agent's accounts, between turns (refused while it works); the same chat, history and settings
    moveToAccount: op({ args: [s.ref('Account')] }).optional(),
    open: op({ returns: r.one('Window') }),
    steer: op({ args: [s.content()] }).optional(),
    enqueue: op({ args: [s.content()], returns: r.one('QueuedMessage') }).optional(),
    // (turn?, options?): the options are the provider's own (CodexThread's: the source's fork parameters, its developer instructions and
    // config among them, G3.5)
    fork: op({ args: [s.ref('Turn').optional(), s.json().optional()], returns: r.one('Thread') }).optional(),
    automate: op({ args: [AutomationSpec], returns: r.one('Automation') }).optional(), // each run a turn in this chat (a heartbeat)
    delete: op().optional(),
    compact: op().optional(),
    setModel: op({ args: [s.ref('Model')] }).optional(),
    // The target is a ChangeSet, a Branch or a Commit: a ref to one of them. The schema has no union of refs, so it is any JSON value
    // here and the provider checks the ref's type.
    review: op({ args: [s.json()], returns: r.one('Review') }).optional(),
    pin: op().optional(),
    unpin: op().optional(),
    export: op({ returns: s.content() }).optional(),
  },
  events: {
    created: ev(),
    titleChanged: ev(),
    statusChanged: ev(),
    turnStarted: ev(r.one('Turn')),
    turnFinished: ev(r.one('Turn')),
    requestOpened: ev(r.one('Request')),
    archived: ev(),
    restored: ev(),
    deleted: ev(),
  },
  summary: { title: 'title', subtitle: 'preview', status: 'status', time: 'updatedAt' },
  searchable: true,
  mentionable: true,
});

// What Codex reports of its threads beyond the concept's core (docs/design/graph-boundary.md B3), at the source's fidelity: the protocol's
// own fields under its own names (graph-integrity G1). The card also adds CodexAgent's thread settings (Setting instances, reached through
// Thread.settings) and its environments (Thread.environment). Its events carry the source's reports as given, every one, repeats included.
const TOKENS = s.object({
  inputTokens: s.number(), cachedInputTokens: s.number(), cacheWriteInputTokens: s.number().optional(), outputTokens: s.number(),
  reasoningOutputTokens: s.number(), totalTokens: s.number(),
});
const TOKEN_USAGE = s.object({ total: TOKENS, last: TOKENS, modelContextWindow: s.number().optional() });
export const CodexThread = defineSubtype(Thread, 'CodexThread', {
  state: {
    cloudTask: s.url().optional(), // a cloud thread's page on the web
    cwd: s.string().optional(), // its working directory (a Path)
    gitInfo: s.object({ branch: s.string().optional(), sha: s.string().optional(), originUrl: s.string().optional() }).optional(),
    sessionId: s.string().optional(), // shared by the threads of one session tree
    ephemeral: s.boolean().optional(),
    modelProvider: s.string().optional(),
    reasoningEffort: s.string().optional(),
    cliVersion: s.string().optional(),
    source: s.json().optional(), // where it was started (the protocol's SessionSource: cli, vscode, exec, appServer, {custom}, {subAgent})
    originator: s.string().optional(),
    threadSource: s.string().optional(),
    agentNickname: s.string().optional(), // a sub-agent's
    agentRole: s.string().optional(),
    recencyAt: s.time().optional(), // what the app orders its recent chats by
    usage: TOKEN_USAGE.optional(), // the last token report: the thread's total and the last request's, and the model's context window
    // What the agent keeps working toward, as the source reports it (times in milliseconds).
    goal: s.object({
      objective: s.string(),
      status: s.enum('active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'),
      tokensUsed: s.number(), tokenBudget: s.number().optional(), timeUsed: s.number(),
      createdAt: s.time(), updatedAt: s.time(),
    }).optional(),
  },
  operations: {
    setGoal: op({ args: [s.string()] }).optional(),
    clearGoal: op().optional(),
    // G3.5 (mechanism): the thread resumed with the source's own parameters (ThreadResumeParams as given), the app's own held for interceptors
    _resume: op({ args: [s.json()], returns: s.json() }),
  },
  events: {
    // every token report the agent gets, as given, with the turn it is about
    tokenUsageReported: ev(s.object({ tokenUsage: TOKEN_USAGE, turnId: s.string() })),
    compacted: ev(s.object({ turnId: s.string().optional() })), // its context was compacted
    reverted: ev(), // its history was put back to an earlier point
    // a hook the user configured ran (the protocol's HookRunSummary as given), for a turn or the thread
    hookStarted: ev(s.object({ run: s.json(), turnId: s.string().optional() })),
    hookCompleted: ev(s.object({ run: s.json(), turnId: s.string().optional() })),
    guardianWarning: ev(s.object({ message: s.string() })),
    warning: ev(s.object({ message: s.string() })), // a warning the server shows in the chat
    predicted: ev(s.json()), // the server's prediction for the chat ({result, sourceTurnId}, as given)
  },
});

export const Turn = defineConcept('Turn', {
  state: {
    status: s.enum('running', 'completed', 'stopped', 'failed'),
    startedAt: s.time(),
    endedAt: s.time().optional(),
    error: s.string().optional(),
    // who started it (graph-integrity G1.7): the user (the app's composer, its queue, a retry, an edit), the app on its own (an automation),
    // a mod (`id`), the agent (its own continuation, which the server starts), or not known (another client, a turn from before)
    // `key`: the mod's own key for the call that started it (graph-integrity G6.3: `invoke(..., {key})`); `through`: the mod whose surface
    // the user sent it from (G7.3)
    startedBy: s.object({ kind: s.enum('user', 'app', 'mod', 'agent', 'unknown'), id: s.string().optional(), key: s.string().optional(), through: s.string().optional() }),
    stoppedBy: STOPPED_BY.optional(),   // a stopped turn's
  },
  relations: {
    thread: r.one('Thread'),
    input: r.many('UserMessage').parts().inverse('turn'), // the first message, then any steering
    steps: r.many('Step').parts().inverse('turn'),
    answer: r.maybe('AgentMessage').parts(),
    requests: r.many('Request').inverse('turn'), // owned by the thread (Thread.requests), shown here by turn
    changes: r.maybe('ChangeSet'),
    automation: r.maybe('Automation'), // when an automation sent it
  },
  operations: {
    copy: op(),
    retry: op({ returns: r.one('Turn') }).optional(),
    rewind: op({ args: [s.content().optional()], returns: r.one('Turn') }).optional(),
  },
  events: {
    started: ev(),
    stepAdded: ev(r.one('Step')),
    completed: ev(),
    stopped: ev(s.object({ by: STOPPED_BY.optional() })),
    failed: ev(),
  },
  // A turn has no text of its own (what you asked is its input, a relation, and a summary draws on state), so its status is the title
  // and the error, when it failed, the subtitle.
  summary: { title: 'status', subtitle: 'error', time: 'startedAt' },
});

// What Codex reports of its turns beyond the concept's core, at the source's fidelity (graph-integrity G1): why the app started it (its own
// `turnTrigger`, as the app sent it), the error as the server gives it, and the turn's aggregate diff. Its events carry each report.
export const CodexTurn = defineSubtype(Turn, 'CodexTurn', {
  state: {
    // why the app started it: the composer, the queue, a retry, an edit, an automation, a review, a notification's reply, a handoff, a mod
    // (triggerBy: which), the app otherwise (triggerDetail: its own name for it), or not known
    trigger: s.enum('composer', 'queue', 'retry', 'edit', 'automation', 'review', 'reply', 'handoff', 'mod', 'app', 'unknown').optional(),
    triggerBy: s.string().optional(),
    triggerDetail: s.string().optional(),
    errorInfo: s.json().optional(), // the protocol's TurnError: {message, codexErrorInfo?, additionalDetails?, misalignment?}
    durationMs: s.number().optional(),
    rootTurnId: s.string().optional(),
    diff: s.string().optional(), // the turn's aggregate unified diff, as last reported
  },
  events: {
    errored: ev(s.object({ error: s.json(), willRetry: s.boolean() })), // an error; `willRetry`: the server tries again by itself
    modelRerouted: ev(s.object({ fromModel: s.string(), toModel: s.string(), reason: s.string() })),
    verified: ev(s.object({ verifications: s.list(s.json()) })), // the model's verification results
    // the guardian's review of an action the agent asked to take (the user's auto-review mode), as given: started, then completed with its
    // decision; and a turn whose further actions it must review strictly
    approvalReviewStarted: ev(s.json()), approvalReviewCompleted: ev(s.json()), strictReviewRequired: ev(s.json()),
    safetyBuffering: ev(s.json()), // the server holds the answer back for a safety check (its model, the faster one, its reasons, as given)
    moderated: ev(s.json()), // the server's moderation metadata for the turn, as given
  },
});

export const Message = defineConcept('Message', {
  state: { content: s.content(), createdAt: s.time() },
  relations: { turn: r.one('Turn') },
  operations: { copy: op() },
  // A message is told apart by what it says, so the title is its content (a runtime shows a content field as its plain text).
  summary: { title: 'content', time: 'createdAt' },
});

export const UserMessage = defineSubtype(Message, 'UserMessage', {
  state: { steering: s.boolean() }, // sent while the agent was working
  relations: {
    attachments: r.many('Attachment'),
    mentions: r.many('Mention'),
  },
});

// What a message carries besides its text (area C, F3): the files and images attached to it, and the things it mentions.
export const Attachment = defineConcept('Attachment', {
  state: {
    name: s.string(),
    kind: s.enum('file', 'image'),
    size: s.number().optional(), // in bytes, when known (the protocol gives none)
    preview: s.string().optional(), // an Image: a url
  },
  operations: { open: op(), remove: op() }, // remove: from a draft
  relations: { message: r.maybe('UserMessage'), draft: r.maybe('Draft'), file: r.maybe('File') },
  summary: { title: 'name' },
});

export const Mention = defineConcept('Mention', {
  state: {
    label: s.string(),
    target: s.json(), // a ref to any mentionable type (File, Folder, Skill, Plugin, Thread, ...): the schemas have no union
  },
  summary: { title: 'label' },
});

export const AgentMessage = defineSubtype(Message, 'AgentMessage', {
  state: {
    phase: s.enum('update', 'final'),
    streaming: s.boolean(),
  },
  events: {
    updated: ev(), // while streaming
    completed: ev(),
  },
});

// The message you are writing. The card is whole; where a member names a union or a type that is not in the library yet, the member keeps
// the card's shape as far as the schemas reach: a relation or a ref by type id (File, Attachment, Mention, Project, Environment, Branch),
// resolved when the type is added.
const DraftTarget = s.object({
  project: s.ref('Project').optional(),
  agent: s.ref('Agent').optional(),
  environment: s.json().optional(), // an Environment's ref, or 'worktree': a new worktree of the project, made when the chat is sent
  branch: s.ref('Branch').optional(),
  model: s.ref('Model').optional(),
  settings: s.json(), // { settingId: value }: a record has no schema of its own
});
/** What setTarget changes: any part of the target; `project: null` starts the chat without a project (E8.3). */
const DraftTargetChange = s.object({
  project: s.json().optional(), // a Project's ref, or null: no project (a ref schema has no null)
  agent: s.ref('Agent').optional(),
  environment: s.json().optional(), // an Environment's ref, or 'worktree': a new worktree of the project, made when the chat is sent
  branch: s.ref('Branch').optional(),
  model: s.ref('Model').optional(),
  settings: s.json().optional(),
});

export const Draft = defineConcept('Draft', {
  state: {
    content: s.content(),
    dictating: s.boolean(),
    target: DraftTarget.optional(), // new threads only
  },
  relations: {
    thread: r.maybe('Thread'),
    attachments: r.many('Attachment'),
    mentions: r.many('Mention'),
  },
  operations: {
    // `{window}` (an env's Window): the operation stays in that window (graph-layers.md §2)
    setContent: op({ args: [s.content(), s.json().optional()] }), // {window?, ifEmpty?}: ifEmpty writes only while the draft holds nothing
    insert: op({ args: [s.content(), s.json().optional()] }), // the card says text | mention: content holds both
    // a File or Folder, a Skill (its chip), {text, name?} or {image: data URL, name?} (a file of the framework's), {url, title?} (a link)
    attach: op({ args: [s.json(), s.json().optional()] }),
    clear: op({ args: [s.json().optional()] }),
    // a ref to a Turn (a thread's draft) or to a Thread (a new-thread draft); the user's send from a composer names what it sends
    // (`{content}`, the composer's text as it is then), which the Draft's own content shows a moment later
    send: op({ args: [s.json().optional()], returns: s.json() }),
    setTarget: op({ args: [DraftTargetChange, s.json().optional()] }),
    startDictation: op(),
    stopDictation: op(),
  },
  events: { changed: ev(), sent: ev(), cleared: ev() },
  // A draft is told apart by what it says, as a message is.
  summary: { title: 'content' },
});

// A follow-up waiting to be sent when the agent finishes (breadth step D5). Thread.queue is its inverse.
export const QueuedMessage = defineConcept('QueuedMessage', {
  state: { content: s.content() },
  relations: {
    thread: r.one('Thread'),
    attachments: r.many('Attachment'),
  },
  operations: {
    edit: op({ args: [s.content()] }),
    sendNow: op(),
    remove: op(),
    move: op({ args: [s.number()] }), // to a position in the thread's queue, 0 first
  },
  events: { queued: ev(), sent: ev(), removed: ev() },
  summary: { title: 'content' },
});
