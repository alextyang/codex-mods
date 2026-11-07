// From the app-server protocol to the graph (docs/design/runtime-core.md R10, R11): pure functions that turn protocol objects (Thread,
// Turn, ThreadItem, server requests) into `{ref, state, links}` for the native provider. The graph's types are planned from what a user
// sees (docs/graph/02-types.md); this file is where the protocol's shapes meet them, so it is the only place that knows both.
// Protocol times: Thread and Turn in seconds, items and requests in milliseconds (`startedAtMs`); the graph's times are milliseconds.

export const PROVIDER = 'codex';
const ref = (type, id) => Object.freeze({ type, provider: PROVIDER, id: String(id) });
export const refs = {
  thread: (id) => ref('CodexThread', id),
  turn: (id) => ref('CodexTurn', id),
  /** Items are unique per thread in the protocol, so their graph ids carry the thread. */
  item: (type, threadId, itemId) => ref(type, `${threadId}:${itemId}`),
  agent: () => ref('CodexAgent', 'codex'),
  /** A mod's tool, as a thread took it at its start: `<namespace>/<tool>` (graph-integrity G3.5). */
  modTool: (namespace, tool) => ref('Tool', `${namespace}/${tool}`),
  draft: (threadId) => ref('Draft', threadId),
  /** A draft's mention by its place among the draft's mentions (the card's identity: draft + position). */
  draftMention: (draftId, i) => ref('Mention', `draft:${draftId}:${i}`),
  /** The app's projects (projects.mjs): every one is a LocalProject, by the app's id. */
  project: (id) => ref('LocalProject', id),
  /** A project's own environment (its folder on this Mac: the app's "This computer"). */
  localEnvironment: (projectId) => ref('LocalEnvironment', `local:${projectId}`),
  /** A project's repository (its identity is the project) and one of its branches. */
  repository: (projectId) => ref('GitRepository', projectId),
  branch: (projectId, name) => ref('Branch', `${projectId}:${name}`),
  commit: (projectId, sha) => ref('Commit', `${projectId}:${sha}`),
  /** A Codex worktree a thread runs in, by its git root. */
  worktreeEnvironment: (gitRoot) => ref('WorktreeEnvironment', gitRoot),
  /** A cloud environment of the signed-in account, by its config's id. */
  cloudEnvironment: (id) => ref('CloudEnvironment', id),
  /** A folder on this Mac, by its path. */
  folder: (path) => ref('Folder', path),
  /** An instructions file (AGENTS.md, AGENTS.override.md), by its path. */
  instructions: (path) => ref('CodexInstructions', path),
  /** The app (one), its theme (one), one of its settings (by its key) and one of its settings pages (by its slug). */
  app: () => ref('App', 'codex'),
  theme: () => ref('Theme', 'codex'),
  setting: (key) => ref('Setting', key),
  settingsSection: (slug) => ref('SettingsSection', slug),
  /** The signed-in account: a ChatGPT account by its account id, another by its service; its usage by the account's id. */
  chatgptAccount: (id) => ref('ChatGPTAccount', id),
  account: (service) => ref('Account', service),
  usage: (accountId) => ref('CodexUsage', accountId),
  /** A project's action, by its project, its environment config and its place in the config. */
  projectAction: (projectId, configPath, index) => ref('ProjectAction', `${projectId}:${configPath}#${index}`),
  model: (id) => ref('Model', id),
  file: (path) => ref('File', path),
  /** The changes of a turn (`scope` 'turn', its id) or of a thread (the union of its turns'; 'thread', its id) (breadth.md D7). */
  changeSet: (scope, id) => ref('ChangeSet', `${scope}:${id}`),
  review: (turnId) => ref('Review', turnId),
  finding: (turnId, index) => ref('Finding', `${turnId}#${index}`),
  comment: (threadId, key) => ref('Comment', `${threadId}:${key}`),
  /** One file's change in a change set, by the set's ref id and the file's path. */
  fileChange: (changeSetId, path) => ref('FileChange', `${changeSetId}:${path}`),
  /** One hunk of a file's change, by the FileChange's ref id and its index in the diff. */
  hunk: (fileChangeId, index) => ref('Hunk', `${fileChangeId}#${index}`),
  tool: (server, tool) => ref('Tool', server ? `${server}/${tool}` : tool),
  /** What extends the agent (breadth.md D10): a tool server by its config key (its name), a plugin by its id (`name@marketplace`), a skill by
   *  its SKILL.md path (a library skill not installed: `library:<id>`), and a project's own setting by its project and its config key. */
  toolServer: (name) => ref('ToolServer', name),
  plugin: (id) => ref('Plugin', id),
  skill: (id) => ref('Skill', id),
  projectSetting: (projectId, key) => ref('Setting', `project:${projectId}:${key}`),
  /** One of the agent's own defaults in the user's Codex config (`model`, `sandbox_mode`, ...: the Configuration page's "Codex defaults"). */
  configSetting: (key) => ref('Setting', `config:${key}`),
  /** One of a thread's own settings (its model, effort, speed, mode, access: breadth.md D5), by the thread and the setting's key. */
  threadSetting: (threadId, key) => ref('Setting', `thread:${threadId}:${key}`),
  /** A custom prompt's slash command (`/prompts:<id>`), by the prompt's id. */
  slashCommand: (id) => ref('SlashCommand', `prompts:${id}`),
  /** A follow-up waiting in a thread's queue (breadth.md D5), by its thread and the app-server's id for it. */
  queuedMessage: (threadId, id) => ref('QueuedMessage', `${threadId}:${id}`),
  /** An app on the Mac, by bundle id (or its name when that is all the request gives). */
  externalApp: (id) => ref('ExternalApp', id),
  /** A thread's computer-use session (no protocol object: one per thread). */
  computerUseSession: (threadId) => ref('ComputerUseSession', threadId),
  terminal: (sessionId) => ref('Terminal', sessionId),
  agentTerminal: (threadId, itemId) => ref('Terminal', `agent:${threadId}:${itemId}`),
  browserTab: (threadId, tabId) => ref('BrowserTab', `${threadId}:${tabId}`),
  /** One of the app's own commands (breadth.md D6), by its command id. */
  command: (id) => ref('Command', id),
  /** One key binding of a command, by the command and the binding's index among its bindings (a rebind changes the same instance). */
  shortcut: (commandId, index) => ref('Shortcut', `${commandId}#${index}`),
  /** An automation (breadth.md D9), by the app's id for it. */
  automation: (id) => ref('Automation', id),
  /** A notification the app showed (breadth.md D9), by the app's notification id. */
  notification: (id) => ref('Notification', id),
};

/** The path a protocol file change ends at: an update with a move ends at its `move_path` (breadth.md D7; the FileChange's path). */
export function changedPath(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.kind?.type === 'update' && typeof c.kind.move_path === 'string' && c.kind.move_path) return c.kind.move_path;
  return typeof c.path === 'string' && c.path ? c.path : null;
}
const sec = (s) => (typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 1000) : undefined);
const text = (t) => Object.freeze({ parts: Object.freeze([Object.freeze({ kind: 'text', text: String(t ?? '') })]) });
const nonEmpty = (s) => (typeof s === 'string' && s.trim() ? s : undefined);

// ---------------------------------------------------------------- the agent and its models
/**
 * CodexAgent: the one native agent. Its name and icon are the framework's constants (the protocol has no record of either; the icon is a
 * symbol name, drawn by the theme). `available` follows the app-server, which the source knows (index.mjs).
 */
export function agentData({ available = true, reason } = {}) {
  const state = { name: 'Codex', icon: 'codex', available };
  if (!available && nonEmpty(reason)) state.unavailableReason = reason;
  return { ref: refs.agent(), state, links: {} };
}

// the app's own names of the levels (22943's reasoning select: low is Light, xhigh is Extra High)
const EFFORT_LABELS = { none: 'None', minimal: 'Minimal', low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra', persistent: 'Persistent' };
/** The name of a reasoning level: the protocol gives its id and a sentence about it, not a name. */
export function effortLabel(id) {
  if (Object.hasOwn(EFFORT_LABELS, id)) return EFFORT_LABELS[id];
  const words = String(id).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A protocol Model (model/list) -> the Model instance, or null when it names nothing. Its id is the model's slug, which is what a thread
 * reports as its model (Thread.model links by it); `hidden` models are the ones the picker does not offer, so they are not available.
 */
export function modelData(m) {
  const id = nonEmpty(m?.model) ?? nonEmpty(m?.id);
  if (!id) return null;
  const seen = new Set();
  const efforts = [];
  for (const e of Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []) {
    const effort = nonEmpty(e?.reasoningEffort);
    if (effort && !seen.has(effort)) { seen.add(effort); efforts.push({ id: effort, label: effortLabel(effort) }); }
  }
  const state = { name: nonEmpty(m.displayName) ?? id, description: typeof m.description === 'string' ? m.description : '', efforts, default: m.isDefault === true, available: m.hidden !== true };
  const inputs = (Array.isArray(m.inputModalities) ? m.inputModalities : []).filter((x) => x === 'text' || x === 'image');
  if (inputs.length) state.inputs = [...new Set(inputs)];
  return { ref: refs.model(id), state, links: { agent: refs.agent() } };
}

// ---------------------------------------------------------------- threads
/** ThreadStatus `{type, activeFlags?}` -> Thread.status. Waiting on an approval or an answer is `waitingForYou` (card note). */
export function threadStatus(status) {
  const type = typeof status === 'string' ? status : status?.type;
  if (type === 'active') {
    const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
    return flags.some((f) => /^waitingOn/.test(f)) ? 'waitingForYou' : 'working';
  }
  if (type === 'systemError') return 'error';
  return 'idle';   // idle, notLoaded
}
/** ThreadStatus -> Thread.waitingOn: an approval (first, when it waits on both) or a question's answer; undefined when it waits on neither. */
export function threadWaitingOn(status) {
  const flags = status?.type === 'active' && Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'question' : undefined;
}

/** Thread.origin from where the thread came from. */
export function threadOrigin(t) {
  if (t.threadSource === 'automation') return 'automation';
  if (t.parentThreadId) return 'delegation';
  if (t.forkedFromId) return 'fork';
  return 'user';
}

const GOAL_STATUS = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
/** ThreadGoal -> CodexThread.goal as the source reports it (times in ms), or undefined when the thread has none. */
export function goalState(goal) {
  if (!goal || typeof goal.objective !== 'string') return undefined;
  return { objective: goal.objective, status: GOAL_STATUS.has(goal.status) ? goal.status : 'paused', tokensUsed: goal.tokensUsed ?? 0,
    ...(typeof goal.tokenBudget === 'number' ? { tokenBudget: goal.tokenBudget } : {}), timeUsed: Math.round((goal.timeUsedSeconds ?? 0) * 1000),
    createdAt: sec(goal.createdAt) ?? 0, updatedAt: sec(goal.updatedAt) ?? sec(goal.createdAt) ?? 0 };
}

const BREAKDOWN = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const tokens = (b) => Object.fromEntries(BREAKDOWN.filter((k) => typeof b?.[k] === 'number' || k !== 'cacheWriteInputTokens').map((k) => [k, typeof b?.[k] === 'number' ? b[k] : 0]));
/** ThreadTokenUsage as the source gives it (its total, the last request's, the model's context window), or null when it says nothing. */
export function tokenUsage(u) {
  if (!u?.total) return null;
  return { total: tokens(u.total), last: tokens(u.last ?? u.total), ...(typeof u.modelContextWindow === 'number' ? { modelContextWindow: u.modelContextWindow } : {}) };
}

/**
 * A protocol Thread -> the CodexThread instance: the concept's core, and the source's own fields under their own names (graph-integrity
 * G1). `archived` comes from where it was read (thread/list `archived`, notifications). `unread` is not in the protocol (the app ignores
 * its read receipts); it is the app's own read state, which the source passes in (read-state.mjs). `project` is the ref of the app project
 * the app put the thread in (projects.mjs), or null; `environment` the ref of the environment it runs in.
 */
export function threadData(t, { archived = false, unread = false, project = null, environment = null } = {}) {
  const title = nonEmpty(t.name) ?? nonEmpty(t.preview)?.split('\n')[0]?.slice(0, 200) ?? 'New thread';
  const state = {
    title, status: threadStatus(t.status), unread: unread === true, archived, origin: threadOrigin(t),
    createdAt: sec(t.createdAt) ?? 0, updatedAt: sec(t.updatedAt) ?? sec(t.createdAt) ?? 0,
  };
  const waitingOn = threadWaitingOn(t.status);
  if (waitingOn) state.waitingOn = waitingOn;
  if (nonEmpty(t.preview)) state.preview = t.preview;
  for (const k of ['cwd', 'sessionId', 'modelProvider', 'cliVersion', 'originator', 'agentNickname', 'agentRole']) if (nonEmpty(t[k])) state[k] = t[k];
  if (typeof t.ephemeral === 'boolean') state.ephemeral = t.ephemeral;
  if (nonEmpty(t.reasoningEffort)) state.reasoningEffort = t.reasoningEffort;
  if (nonEmpty(t.threadSource)) state.threadSource = t.threadSource;
  if (t.source !== undefined && t.source !== null) state.source = t.source;
  if (typeof t.recencyAt === 'number') state.recencyAt = sec(t.recencyAt);
  if (t.gitInfo && typeof t.gitInfo === 'object') {
    const g = Object.fromEntries(['branch', 'sha', 'originUrl'].filter((k) => nonEmpty(t.gitInfo[k])).map((k) => [k, t.gitInfo[k]]));
    if (Object.keys(g).length) state.gitInfo = g;
  }
  const links = { agent: refs.agent() };   // its draft is the composer's Draft, whose `thread` names it (Thread.draft is derived)
  if (project) links.project = project;   // the app's assignment (projects.mjs), never the protocol's projectId (another id space)
  if (environment) links.environment = environment;
  if (nonEmpty(t.model)) links.model = refs.model(t.model);
  if (t.parentThreadId) links.parent = refs.thread(t.parentThreadId);
  return { ref: refs.thread(t.id), state, links };
}

// ---------------------------------------------------------------- the agent's task list
const TASK_STATUS = { pending: 'pending', inProgress: 'inProgress', completed: 'done' };
/**
 * turn/plan/updated -> the turn's task list: a Plan step (one per turn, its title the explanation) and its PlanTasks by position (the
 * list is replaced wholesale on each update; realization map D).
 */
export function planData(threadId, turnId, params, { startedAt = 0 } = {}) {
  const steps = Array.isArray(params?.plan) ? params.plan : [];
  const plan = refs.item('Plan', threadId, `plan-${turnId}`);
  const tasks = steps.map((p, i) => ({ ref: ref('PlanTask', `${plan.id}:${i}`), state: { text: String(p.step ?? ''), status: TASK_STATUS[p.status] ?? 'pending' }, links: { plan } }));
  const done = tasks.length > 0 && tasks.every((x) => x.state.status === 'done');
  const title = String(params?.explanation ?? '').trim() || 'Plan';
  return [{ ref: plan, state: stepBase(title, done ? 'completed' : 'inProgress', startedAt, done), links: { turn: refs.turn(turnId) } }, ...tasks];
}

// ---------------------------------------------------------------- turns
const TURN_STATUS = { inProgress: 'running', completed: 'completed', interrupted: 'stopped', failed: 'failed' };
/**
 * A protocol Turn -> the CodexTurn instance. `startedBy` is the provider's (who started it is not in the protocol: the client that sent its
 * turn/start, or the server); the error is kept as the server gives it beside its message.
 */
export function turnData(threadId, turn, { startedBy = { kind: 'unknown' } } = {}) {
  const state = { status: TURN_STATUS[turn.status] ?? 'running', startedAt: sec(turn.startedAt) ?? 0, startedBy };
  if (turn.completedAt) state.endedAt = sec(turn.completedAt);
  if (turn.error?.message) { state.error = String(turn.error.message); state.errorInfo = turn.error; }
  if (typeof turn.durationMs === 'number') state.durationMs = turn.durationMs;
  if (nonEmpty(turn.rootTurnId)) state.rootTurnId = turn.rootTurnId;
  return { ref: refs.turn(turn.id), state, links: { thread: refs.thread(threadId) } };
}

// ---------------------------------------------------------------- items
const STEP_STATUS = { inProgress: 'running', completed: 'done', failed: 'failed', declined: 'cancelled' };
const basename = (p) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
/** What a mention points at: an app's connector (`app://<id>`) is a Plugin, a skill a Skill (by its SKILL.md, the skills area's id), anything
 *  else a File by its path. */
function mentionTarget(c) {
  const path = String(c.path ?? '');
  if (c.type === 'skill') return refs.skill(path || String(c.name ?? ''));
  if (path.startsWith('app://')) return { type: 'Plugin', provider: PROVIDER, id: path.slice(6) };
  return refs.file(path);
}
const stepBase = (title, status, startedAt, done) => ({
  status: STEP_STATUS[status] ?? (done ? 'done' : 'running'), title: String(title || 'Step').slice(0, 500), startedAt: startedAt ?? 0,
});
/** The app's UserInput[] (a user message's content, a turn/start's input) as graph content: text as text, mentions and skills by name,
 *  media by where they are. */
const SHELL = /^(?:.*[/\\])?(?:bash|cmd(?:\.exe)?|fish|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|zsh)(?:\s|$)/i;
/** A command as the app shows it (21477 `command-execution-command`): the last of its parsed actions that is not a bare shell wrapper, else
 *  the command unless it is one (then ''). `/bin/zsh -lc 'ls -la'` with the action `ls -la` reads `ls -la`. */
export function displayCommand(item) {
  const actions = Array.isArray(item?.commandActions) ? item.commandActions : [];
  for (let i = actions.length - 1; i >= 0; i--) {
    const c = String(actions[i]?.command ?? '').trim();
    if (c && !SHELL.test(c)) return c;
  }
  const c = String(item?.command ?? '').trim();
  return SHELL.test(c) ? '' : c;
}

export function userContent(content) {
  const parts = (Array.isArray(content) ? content : []).map((c) => {
    if (c?.type === 'text') return { kind: 'text', text: String(c.text ?? '') };
    if (c?.type === 'mention' || c?.type === 'skill') return { kind: 'text', text: `@${c.name ?? c.path ?? ''}` };
    if (c?.type === 'image' || c?.type === 'localImage') return { kind: 'image', source: c.url ?? c.path ?? '' };
    return { kind: 'text', text: `[${c?.type ?? 'input'}]` };
  });
  return { parts };
}
/** A content part's text in the app's own send (inputOfContent): code fenced on its own lines, a link as markdown, a mention by its id. */
function partText(p) {
  switch (p?.kind) {
    case 'text': return typeof p.text === 'string' ? p.text : '';
    case 'code': return `\n\`\`\`${typeof p.language === 'string' ? p.language : ''}\n${typeof p.text === 'string' ? p.text : ''}\n\`\`\`\n`;
    case 'link': return p.text ? `[${p.text}](${typeof p.url === 'string' ? p.url : ''})` : typeof p.url === 'string' ? p.url : '';
    case 'mention': return `@${typeof p.target?.id === 'string' ? p.target.id : ''}`;
    case 'fileLink': return (typeof p.path === 'string' ? p.path : '') + (p.line ? `:${p.line}` : '');
    default: return typeof p?.text === 'string' ? p.text : '';
  }
}
/**
 * Graph content as the app's own UserInput[], the inverse of `userContent`: a send of the app's whose content an interceptor changed
 * (app-ops). Adjacent text-like parts become one text input, as the app sends it; an image is its own input (a local one by its path).
 * Never empty.
 */
export function inputOfContent(content) {
  const out = [];
  let run = '';
  const flush = () => { if (run !== '') out.push({ type: 'text', text: run, text_elements: [] }); run = ''; };
  for (const p of Array.isArray(content?.parts) ? content.parts : []) {
    if (p?.kind === 'image') {
      const at = typeof p.source === 'string' ? p.source : p.source?.url ?? p.source?.path;
      if (typeof at !== 'string' || !at) continue;
      flush();
      out.push(at.startsWith('/') ? { type: 'localImage', path: at } : { type: 'image', url: at });
    } else run += partText(p);
  }
  flush();
  return out.length ? out : [{ type: 'text', text: '', text_elements: [] }];
}
/**
 * Graph content (a message a mod sends: Thread.send, steer, enqueue) as the app's UserInput[]: its text in one text input (code fenced on
 * its own lines, a link as markdown, a file link as its path, a mention by its label), then one input per mention of a File or Folder
 * (`mention`, by path) or a Skill (`skill`, by its SKILL.md path). Empty when it says nothing. Images are not sent this way yet.
 */
export function userInput(content) {
  const text = [];
  const extra = [];
  for (const p of Array.isArray(content?.parts) ? content.parts : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.kind === 'text') text.push(String(p.text ?? ''));
    else if (p.kind === 'code') text.push(`\n\`\`\`${p.language ?? ''}\n${String(p.text ?? '')}\n\`\`\`\n`);
    else if (p.kind === 'link') text.push(p.text ? `[${p.text}](${p.url})` : String(p.url ?? ''));
    else if (p.kind === 'fileLink') text.push(`${p.path}${p.line ? `:${p.line}` : ''}`);
    else if (p.kind === 'mention') {
      const t = p.target;
      const name = String(p.label ?? (typeof t?.id === 'string' ? t.id.split('/').filter(Boolean).at(t.type === 'Skill' ? -2 : -1) : '') ?? '');
      text.push(`@${name}`);
      if ((t?.type === 'File' || t?.type === 'Folder') && typeof t.id === 'string') extra.push({ type: 'mention', name, path: t.id });
      else if (t?.type === 'Skill' && typeof t.id === 'string') extra.push({ type: 'skill', name, path: t.id });
    }
  }
  const joined = text.join('').trim();
  return [...(joined ? [{ type: 'text', text: joined, text_elements: [] }] : []), ...extra];
}
const ITEM_TITLES = {
  hookPrompt: 'Hook', functionCallOutput: 'Tool output', imageView: 'Viewed an image', sleep: 'Waited', imageGeneration: 'Generated an image',
  enteredReviewMode: 'Started reviewing', exitedReviewMode: 'Finished reviewing', contextCompaction: 'Compacted the context', subAgentActivity: 'Sub-agent',
};

/**
 * A ThreadItem -> graph instances (a file change gives one FileEdit per file). `done` is true for item/completed or a loaded history.
 * @returns {{ref: object, state: object, links: object}[]}
 */
export function itemData(threadId, turnId, item, { startedAt = 0, done = true } = {}) {
  const turn = refs.turn(turnId);
  const id = item.id;
  const one = (type, state, links = {}) => [{ ref: refs.item(type, threadId, id), state, links: { turn, ...links } }];
  switch (item.type) {
    case 'userMessage': {
      // Its attachments (images, audio) and mentions (files, apps, skills) are instances of their own, which it lists.
      const msg = refs.item('UserMessage', threadId, id);
      const attachments = [], mentions = [];
      (Array.isArray(item.content) ? item.content : []).forEach((c, i) => {
        const at = ref('Attachment', `${threadId}:${id}:${i}`);
        if (c?.type === 'image' || c?.type === 'localImage' || c?.type === 'audio' || c?.type === 'localAudio') {
          const where = c.path ?? c.url ?? c.fileId ?? '';
          attachments.push({ ref: at, state: { name: basename(String(where)) || c.type, kind: c.type.endsWith('udio') ? 'file' : 'image', ...(c.url && c.type === 'image' ? { preview: String(c.url) } : {}) },
            links: { message: msg, ...(c.path ? { file: refs.file(c.path) } : {}) } });
        } else if (c?.type === 'mention' || c?.type === 'skill') {
          mentions.push({ ref: ref('Mention', `${threadId}:${id}:${i}`), state: { label: String(c.name ?? c.path ?? ''), target: mentionTarget(c) }, links: {} });
        }
      });
      return [{ ref: msg, state: { content: userContent(item.content), createdAt: startedAt, steering: false },
        links: { turn, attachments: attachments.map((a) => a.ref), mentions: mentions.map((m) => m.ref) } }, ...attachments, ...mentions];
    }
    case 'agentMessage':
      return one('AgentMessage', { content: text(item.text), createdAt: startedAt, phase: item.phase === 'final_answer' ? 'final' : 'update', streaming: !done });
    case 'reasoning': {
      // as shown: its summary; as given: the summary and the content, part by part
      const summaryParts = (Array.isArray(item.summary) ? item.summary : typeof item.summary === 'string' ? [item.summary] : []).map(String);
      const contentParts = (Array.isArray(item.content) ? item.content : []).map(String);
      return one('CodexReasoning', { ...stepBase('Reasoning', done ? 'completed' : 'inProgress', startedAt, done), thinking: text(summaryParts.join('\n')), summaryParts, contentParts });
    }
    case 'plan':
      return one('Plan', stepBase('Plan', done ? 'completed' : 'inProgress', startedAt, done));
    case 'commandExecution': {
      const command = displayCommand(item) || String(item.command ?? '');
      const state = { ...stepBase(command, item.status, startedAt, done), command, directory: String(item.cwd ?? ''), output: String(item.aggregatedOutput ?? '') };
      if (typeof item.exitCode === 'number') state.exitCode = item.exitCode;
      if (typeof item.durationMs === 'number') state.duration = item.durationMs;
      // as given: the whole invocation and the actions the server parsed from it
      state.shellCommand = String(item.command ?? '');
      state.commandActions = Array.isArray(item.commandActions) ? item.commandActions : [];
      for (const k of ['processId', 'source', 'pluginId', 'scriptPath']) if (nonEmpty(item[k])) state[k] = item[k];
      return one('CodexCommandRun', state);
    }
    case 'fileChange':
      return (Array.isArray(item.changes) ? item.changes : []).map((c, i) => ({
        ref: refs.item('FileEdit', threadId, `${id}:${i}`),
        state: stepBase(`Edited ${c.path ?? 'a file'}`, item.status, startedAt, done),
        links: { turn, file: refs.file(c.path ?? `${id}:${i}`), change: refs.fileChange(refs.changeSet('turn', turn.id).id, changedPath(c) ?? `${id}:${i}`) },
      }));
    case 'webSearch': {
      const action = item.action;
      if (action?.type === 'openPage' && action.url) return one('WebLookup', { ...stepBase(`Opened ${action.url}`, done ? 'completed' : 'inProgress', startedAt, done), url: action.url });
      const results = (Array.isArray(item.results) ? item.results : []).filter((r) => r?.url).map((r) => ({ title: String(r.title ?? r.url), location: String(r.url) }));
      return one('Search', { ...stepBase(`Searched "${item.query ?? ''}"`, done ? 'completed' : 'inProgress', startedAt, done), query: String(item.query ?? action?.query ?? ''), scope: 'web', results });
    }
    case 'mcpToolCall': case 'dynamicToolCall': {
      // A computer-use tool call on an app is an action on that app (realization map D: the computer-use server). The protocol has no session
      // object: the session is the thread's, by id. A call on no app (list_apps) stays a tool call. The unified path (21477: the
      // `unified-computer-use` plugin's `cua_repl` server, tool `js`) is computer use whatever it drives, as the app's own "using computer"
      // shows it from the call's start (its result, which names the app, comes only at the end): the type does not change on completion.
      const app = /^computer-use/.test(String(item.server ?? '')) ? item.arguments?.app ?? item.arguments?.bundle_id : null;
      if (app) {
        return one('ComputerAction', { ...stepBase(`${item.tool} ${app}`, item.status, startedAt, done), action: String(item.tool ?? '') },
          { app: refs.externalApp(String(app)), session: refs.computerUseSession(threadId) });
      }
      if (item.server === 'cua_repl' && item.tool === 'js') {
        const surface = item.result?._meta?.['codex/toolSurface'];
        const appId = surface?.kind === 'computerUse' && surface.app?.kind === 'appId' && typeof surface.app.appId === 'string' ? surface.app.appId : null;
        const name = surface?.app?.kind === 'displayName' ? surface.app.displayName : appId;
        return one('ComputerAction', { ...stepBase(name ? `Used ${name}` : 'Used the computer', item.status, startedAt, done), action: 'js' },
          { app: appId ? refs.externalApp(appId) : null, session: refs.computerUseSession(threadId) });
      }
      const state = { ...stepBase(`${item.server ? `${item.server}: ` : ''}${item.tool}`, item.status, startedAt, done), input: text(JSON.stringify(item.arguments ?? null)) };
      if (item.result !== undefined && item.result !== null) state.output = text(typeof item.result === 'string' ? item.result : JSON.stringify(item.result));
      if (item.error) state.error = String(item.error?.message ?? item.error);
      // as given: the tool by its name, its arguments and result as the server reports them
      Object.assign(state, { toolName: String(item.tool ?? ''), arguments: item.arguments ?? null });
      if (nonEmpty(item.server)) state.server = item.server;
      if (nonEmpty(item.namespace)) state.namespace = item.namespace;
      if (item.result !== undefined && item.result !== null) state.result = item.result;
      if (item.contentItems !== undefined && item.contentItems !== null) state.contentItems = item.contentItems;
      if (typeof item.success === 'boolean') state.success = item.success;
      if (typeof item.durationMs === 'number') state.durationMs = item.durationMs;
      return one('CodexToolCall', state, { tool: refs.tool(item.server, item.tool) });
    }
    case 'collabAgentToolCall': {
      const child = item.receiverThreadIds?.[0];
      if (!child) break;
      return one('Delegation', { ...stepBase(`Delegated: ${item.tool}`, item.status, startedAt, done), task: text(item.prompt ?? item.tool ?? '') }, { child: refs.thread(child) });
    }
    default: break;
  }
  // a kind with no concept here: the item as given, under its own type
  return one('CodexStep', { ...stepBase(ITEM_TITLES[item.type] ?? item.type, done ? 'completed' : 'inProgress', startedAt, done), itemType: String(item.type ?? 'unknown'), item });
}

// ---------------------------------------------------------------- requests
/**
 * What an approval offers (graph-integrity G1.6): the server's own decisions, each an option `{id, label, kind, scope?}` whose id names the
 * decision (`accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment:<i>`, `decline`, `cancel`; for a
 * permissions request `grant:turn`, `grant:session`, `decline`; for a tool server's request `accept`, `accept:session`, `accept:always`,
 * `decline`, `cancel`). Where the request lists the decisions it takes (`availableDecisions`), those are the options, in its order.
 */
const LABELS = {
  accept: 'Allow once', acceptForSession: 'Allow for this chat', decline: "Don't allow", cancel: "Don't allow and stop",
};
const decisionKey = (d) => (typeof d === 'string' ? d : d && typeof d === 'object' ? Object.keys(d)[0] ?? '' : '');
function decisionOption(d, i, p) {
  const key = decisionKey(d);
  if (key === 'accept') return { id: 'accept', label: LABELS.accept, kind: 'approve', scope: 'once' };
  if (key === 'acceptForSession') return { id: 'acceptForSession', label: LABELS.acceptForSession, kind: 'approve', scope: 'thread' };
  if (key === 'decline') return { id: 'decline', label: LABELS.decline, kind: 'deny' };
  if (key === 'cancel') return { id: 'cancel', label: LABELS.cancel, kind: 'cancel' };
  if (key === 'acceptWithExecpolicyAmendment') {
    const prefix = (d?.acceptWithExecpolicyAmendment?.execpolicy_amendment ?? p.proposedExecpolicyAmendment ?? []).map(String).join(' ');
    return { id: 'acceptWithExecpolicyAmendment', label: prefix ? `Always allow commands that start with ${prefix}` : 'Always allow similar commands', kind: 'approve', scope: 'always' };
  }
  if (key === 'applyNetworkPolicyAmendment') {
    const a = d?.applyNetworkPolicyAmendment?.network_policy_amendment ?? {};
    const allow = a.action !== 'deny';
    return { id: `applyNetworkPolicyAmendment:${i}`, label: `${allow ? 'Always allow' : 'Always block'} ${a.host ?? 'this host'}`, kind: allow ? 'approve' : 'deny', scope: 'always' };
  }
  return null;
}
/** A command request's decisions: those it lists, else what it proposes (once, for the chat, its standing rules) and the declines. */
function commandDecisions(p) {
  if (Array.isArray(p.availableDecisions) && p.availableDecisions.length) return p.availableDecisions;
  const out = ['accept', 'acceptForSession'];
  const prefix = Array.isArray(p.proposedExecpolicyAmendment) ? p.proposedExecpolicyAmendment.filter((x) => typeof x === 'string') : [];
  if (prefix.length) out.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } });
  for (const a of Array.isArray(p.proposedNetworkPolicyAmendments) ? p.proposedNetworkPolicyAmendments : []) {
    if (a && typeof a === 'object' && nonEmpty(a.host)) out.push({ applyNetworkPolicyAmendment: { network_policy_amendment: a } });
  }
  return [...out, 'decline', 'cancel'];
}
/** The options of a request by its method and params (empty for a request that is not an approval). */
export function requestOptions(method, p = {}) {
  const fromDecisions = (list) => list.map((d, i) => decisionOption(d, i, p)).filter(Boolean);
  switch (method) {
    case 'item/commandExecution/requestApproval': return fromDecisions(commandDecisions(p));
    case 'item/fileChange/requestApproval': return [
      { id: 'accept', label: LABELS.accept, kind: 'approve', scope: 'once' }, { id: 'acceptForSession', label: 'Allow all edits in this chat', kind: 'approve', scope: 'thread' },
      { id: 'decline', label: LABELS.decline, kind: 'deny' }, { id: 'cancel', label: LABELS.cancel, kind: 'cancel' }];
    case 'item/permissions/requestApproval': return [
      { id: 'grant:turn', label: 'Allow for this turn', kind: 'approve', scope: 'once' }, { id: 'grant:session', label: 'Allow for this chat', kind: 'approve', scope: 'thread' },
      { id: 'decline', label: LABELS.decline, kind: 'deny' }];
    case 'mcpServer/elicitation/request': {
      const persist = Array.isArray(p._meta?.persist) ? p._meta.persist : [];
      return [{ id: 'accept', label: LABELS.accept, kind: 'approve', scope: 'once' },
        ...(persist.includes('session') ? [{ id: 'accept:session', label: LABELS.acceptForSession, kind: 'approve', scope: 'thread' }] : []),
        ...(persist.includes('always') ? [{ id: 'accept:always', label: 'Always allow', kind: 'approve', scope: 'always' }] : []),
        { id: 'decline', label: LABELS.decline, kind: 'deny' }, { id: 'cancel', label: LABELS.cancel, kind: 'cancel' }];
    }
    default: return [];
  }
}

/**
 * The protocol's answer to an approval with one of its options (null for an option it does not offer). "Always" writes a standing
 * permission the app and the command line share: the option says so (`scope: always`), and the operation asks the user first (R17).
 */
export function optionAnswer(method, params, optionId) {
  const p = params ?? {};
  const option = requestOptions(method, p).find((o) => o.id === optionId);
  if (!option) return null;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const [key, index] = optionId.split(':');
      if (key === 'applyNetworkPolicyAmendment') {
        const listed = commandDecisions(p)[Number(index)];
        return listed ? { decision: listed } : null;
      }
      if (key === 'acceptWithExecpolicyAmendment') return { decision: commandDecisions(p).find((d) => decisionKey(d) === key) ?? null };
      return { decision: key };
    }
    case 'item/fileChange/requestApproval': return { decision: optionId };
    case 'item/permissions/requestApproval':
      return optionId === 'decline' ? { permissions: {} } : { permissions: p.permissions ?? {}, scope: optionId === 'grant:session' ? 'session' : 'turn' };
    case 'mcpServer/elicitation/request':
      if (optionId === 'decline' || optionId === 'cancel') return { action: optionId, content: null, _meta: null };
      return { action: 'accept', content: {}, _meta: optionId === 'accept:always' ? { persist: 'always' } : optionId === 'accept:session' ? { persist: 'session' } : null };
    default: return null;
  }
}

/** A requestUserInput question's prompts, as the source asked them: a choice's id is its label (the source names choices by label). */
function promptsOf(questions) {
  return (Array.isArray(questions) ? questions : []).filter((q) => q && typeof q === 'object').map((q, i) => ({
    id: String(q.id ?? i),
    ...(nonEmpty(q.header) ? { header: q.header } : {}),
    prompt: text(q.question ?? q.header ?? ''),
    choices: (Array.isArray(q.options) ? q.options : []).filter((o) => o && nonEmpty(o.label)).map((o) => ({ id: o.label, label: o.label, ...(nonEmpty(o.description) ? { description: o.description } : {}) })),
    other: q.isOther === true || !(Array.isArray(q.options) && q.options.length),
    secret: q.isSecret === true,
  }));
}

/**
 * A server request -> a Request instance, or null when it is not a request to the user (attestation, auth refresh, the time...).
 * `key` identifies it for answers and resolution (the request id the clients saw).
 */
export function requestData(method, params, key, { now = Date.now, item = null } = {}) {
  const p = params ?? {};
  if (!p.threadId) return null;
  const askedAt = typeof p.startedAtMs === 'number' ? p.startedAtMs : now();
  const id = `${p.threadId}:${p.approvalId ?? `${p.itemId ?? 'request'}:${key}`}`;
  const base = { status: 'pending', from: 'agent', askedAt };
  const links = { thread: refs.thread(p.threadId), turn: refs.turn(p.turnId ?? 'unknown') };
  const step = (type) => (p.itemId ? { step: refs.item(type, p.threadId, p.itemId) } : {});
  const reason = nonEmpty(p.reason) ? { reason: p.reason } : {};
  const options = requestOptions(method, p);
  switch (method) {
    case 'item/commandExecution/requestApproval':
      if (p.networkApprovalContext?.host) return { ref: ref('NetworkApproval', id), state: { ...base, ...reason, options, host: String(p.networkApprovalContext.host) }, links: { ...links, ...step('CodexCommandRun') } };
      return { ref: ref('CodexCommandApproval', id), state: { ...base, ...reason, options, command: String(p.command ?? ''), directory: String(p.cwd ?? ''),
        display: displayCommand(p) || String(p.command ?? ''),
        commandActions: Array.isArray(p.commandActions) ? p.commandActions : [],
        ...(Array.isArray(p.availableDecisions) ? { availableDecisions: p.availableDecisions } : {}),
        ...(Array.isArray(p.proposedExecpolicyAmendment) && p.proposedExecpolicyAmendment.length ? { proposedExecpolicyAmendment: p.proposedExecpolicyAmendment.map(String) } : {}),
        ...(Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length ? { proposedNetworkPolicyAmendments: p.proposedNetworkPolicyAmendments } : {}),
        ...(p.networkApprovalContext ? { networkApprovalContext: p.networkApprovalContext } : {}),
        ...(nonEmpty(p.approvalId) ? { approvalId: p.approvalId } : {}), ...(nonEmpty(p.itemId) ? { itemId: p.itemId } : {}) }, links: { ...links, ...step('CodexCommandRun') } };
    case 'item/fileChange/requestApproval':
      // what it would apply is its fileChange step's (the request names it by item id; the step comes first: editFiles(item) when known)
      return { ref: ref('EditApproval', id), state: { ...base, ...reason, options, files: editFiles(item), ...(nonEmpty(p.grantRoot) ? { grantRoot: String(p.grantRoot) } : {}) },
        links: { ...links, edits: editRefs(p.threadId, p.itemId, item) } };
    case 'item/permissions/requestApproval': {
      const host = p.permissions?.network?.host ?? p.permissions?.network?.hosts?.[0];
      if (host) return { ref: ref('NetworkApproval', id), state: { ...base, ...reason, options, host: String(host) }, links };
      return { ref: ref('Approval', id), state: { ...base, ...reason, options }, links };
    }
    case 'mcpServer/elicitation/request': {
      const meta = p._meta ?? {};
      const tool = meta.tool_name ? refs.tool(p.serverName, meta.tool_name) : null;
      if (String(meta.connector_id ?? '').startsWith('computer-use')) {
        const app = String(meta.tool_params?.app ?? meta.tool_params_display?.find?.((x) => x.name === 'app')?.value ?? 'unknown');
        return { ref: ref('ComputerUseApproval', id), state: { ...base, from: 'tool', options, action: String(meta.tool_name ?? '') }, links: { ...links, app: refs.externalApp(app), ...(tool ? { tool } : {}) } };
      }
      if (meta.codex_approval_kind === 'mcp_tool_call' && tool) {
        return { ref: ref('ToolApproval', id), state: { ...base, from: 'tool', options, input: text(JSON.stringify(meta.tool_params ?? null)) }, links: { ...links, tool } };
      }
      // a tool server's own question: its message, and its form (or the page it sends the user to) as given
      return { ref: ref('CodexQuestion', id), state: { ...base, from: 'tool', blocking: true, source: 'elicitation', serverName: String(p.serverName ?? ''),
        prompts: [{ id: 'message', prompt: text(p.message ?? ''), choices: [], other: true, secret: false }],
        ...(p.requestedSchema !== undefined && p.requestedSchema !== null ? { requestedSchema: p.requestedSchema } : {}), ...(nonEmpty(p.url) ? { url: p.url } : {}) }, links };
    }
    case 'item/tool/requestUserInput': {
      const prompts = promptsOf(p.questions);
      if (!prompts.length) return null;
      return { ref: ref('CodexQuestion', id), state: { ...base, prompts, blocking: p.isBlocking !== false, source: 'requestUserInput',
        ...(typeof p.autoResolutionMs === 'number' ? { autoResolveAfterMs: p.autoResolutionMs } : {}), ...(nonEmpty(p.itemId) ? { itemId: p.itemId } : {}) }, links };
    }
    default: return null;
  }
}

/** The files a fileChange item would change, as an EditApproval lists them: `{path, change, movedTo?, added?, removed?}` (lines of its diff). */
export function editFiles(item) {
  return (Array.isArray(item?.changes) ? item.changes : []).filter((c) => c && typeof c.path === 'string').map((c) => {
    const kind = typeof c.kind === 'string' ? c.kind : c.kind?.type;
    const lines = typeof c.diff === 'string' ? c.diff.split('\n') : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // an update's diff is unified (`+` and `-` lines); an added or deleted file's is its content (every line added, or removed)
    const unified = lines.some((l) => l.startsWith('@@'));
    const added = !unified && kind === 'add' ? lines.length : lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = !unified && kind === 'delete' ? lines.length : lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    return { path: c.path, change: kind === 'add' || kind === 'delete' ? kind : 'update', ...(nonEmpty(c.kind?.move_path) ? { movedTo: String(c.kind.move_path) } : {}),
      ...(lines.length ? { added, removed } : {}) };
  });
}
/** The FileEdit steps of a fileChange item (one per change, as itemData puts them). */
const editRefs = (threadId, itemId, item) => (Array.isArray(item?.changes) && itemId ? item.changes.map((c, i) => refs.item('FileEdit', threadId, `${itemId}:${i}`)) : []);

/**
 * The answer a client sent to a server request, as the graph says it: `{decision: approved | denied | cancelled | answered, scope?,
 * option?}` (the scope an approval was given for, the option that was picked). A question's typed text is never kept (it may be secret).
 */
export function answerOf(method, result, params = null) {
  const r = result ?? {};
  const status = answerStatus(method, r);
  if (method === 'item/tool/requestUserInput') return status === 'answered' ? { decision: 'answered' } : { decision: status === 'declined' ? 'denied' : 'cancelled' };
  const option = optionOf(method, r, params);
  const picked = option ? requestOptions(method, params ?? {}).find((o) => o.id === option) : null;
  if (status === 'declined') return { decision: 'denied', ...(option ? { option } : {}) };
  if (status === 'cancelled') return { decision: 'cancelled', ...(option ? { option } : {}) };
  if (method === 'mcpServer/elicitation/request' && !r._meta && r.content && Object.keys(r.content).length) return { decision: 'answered' };
  return { decision: 'approved', scope: picked?.scope ?? 'once', ...(option ? { option } : {}) };
}
/** Which of the request's options an answer is (null when none of them). */
function optionOf(method, r, params) {
  const p = params ?? {};
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const d = r.decision;
      const key = decisionKey(d);
      if (key === 'applyNetworkPolicyAmendment') {
        const i = commandDecisions(p).findIndex((x) => decisionKey(x) === key && JSON.stringify(x) === JSON.stringify(d));
        return i >= 0 ? `applyNetworkPolicyAmendment:${i}` : null;
      }
      return key || null;
    }
    case 'item/fileChange/requestApproval': return decisionKey(r.decision) || null;
    case 'item/permissions/requestApproval': return r.permissions && Object.keys(r.permissions).length ? (r.scope === 'session' ? 'grant:session' : 'grant:turn') : 'decline';
    case 'mcpServer/elicitation/request': {
      if (r.action !== 'accept') return r.action === 'decline' || r.action === 'cancel' ? r.action : null;
      return r._meta?.persist === 'always' ? 'accept:always' : r._meta?.persist === 'session' ? 'accept:session' : 'accept';
    }
    default: return null;
  }
}

/** The answer a client sent to a server request -> the request's final status. */
export function answerStatus(method, result) {
  const r = result ?? {};
  const decision = r.decision ?? r.action;
  if (decision === 'decline' || decision === 'deny' || decision === 'reject') return 'declined';
  if (decision === 'cancel') return 'cancelled';
  if (r.permissions && typeof r.permissions === 'object' && !Object.keys(r.permissions).length) return 'declined';   // nothing granted
  return 'answered';
}

/**
 * What the user is asked before a mod answers a request with an `always` option (runtime-core.md R17): it writes a standing permission the
 * app and the command line share. `{action, detail}` for the prompt ("“Mod” wants to <action>.").
 */
export function alwaysPrompt(instance, option) {
  const s = instance?.state ?? {};
  const quoted = (v, max = 120) => `“${String(v).length > max ? `${String(v).slice(0, max)}…` : String(v)}”`;
  const shared = 'It is saved in your Codex settings, which the app and the command line share.';
  const label = option?.label ? ` (${option.label})` : '';
  switch (instance?.ref?.type) {
    case 'CodexCommandApproval': case 'CommandApproval': return { action: `always let Codex run ${quoted(s.command)} and commands like it without asking${label}`, detail: `Codex will run matching commands without asking you. ${shared}` };
    case 'NetworkApproval': return { action: `${option?.kind === 'deny' ? 'always block' : 'always let Codex reach'} ${quoted(s.host)}${option?.kind === 'deny' ? '' : ' without asking'}`, detail: `${option?.kind === 'deny' ? 'Codex will not reach this host.' : 'Codex will reach this host without asking you.'} ${shared}` };
    case 'ComputerUseApproval': return { action: `always let Codex use ${quoted(instance.links?.app?.id ?? 'this app')} without asking`, detail: 'Codex will use this app on your Mac without asking you first. You can change it in Settings, Computer Use.' };
    case 'ToolApproval': return { action: `always let Codex use the tool ${quoted(instance.links?.tool?.id ?? 'this tool')} without asking`, detail: `Codex will use this tool without asking you. ${shared}` };
    default: return { action: `answer this request for good${label}`, detail: shared };
  }
}

/**
 * The user's approval of a mod approving a request once or for the chat, or answering a question (public-hooks.md §3.6: an automatic
 * answer is the mod's automatic action, R17 otherwise). A decline needs none.
 */
export function answerPrompt(instance, option) {
  const s = instance?.state ?? {};
  // one no longer waiting is not asked about (graph-integrity G6.4: answered first in the app, a later answer is refused as it is, never
  // put to the user first)
  if (s.status !== undefined && s.status !== 'pending') return null;
  const quoted = (v, max = 120) => `“${String(v).length > max ? `${String(v).slice(0, max)}…` : String(v)}”`;
  const forChat = option?.scope === 'thread' ? ' for the rest of this chat' : '';
  switch (instance?.ref?.type) {
    case 'CodexCommandApproval': case 'CommandApproval': return { action: `let Codex run ${quoted(s.display || s.command)}${forChat}`, detail: 'Codex runs it with this chat\'s permissions.' };
    case 'EditApproval': return { action: `let Codex change ${(s.files ?? []).length === 1 ? quoted(s.files[0].path) : `${(s.files ?? []).length || 'some'} files`}${forChat}`, detail: 'Codex writes the changes it asked for.' };
    case 'NetworkApproval': return { action: `let Codex reach ${quoted(s.host)}${forChat}`, detail: 'Codex connects to that host from this chat.' };
    case 'CodexQuestion': case 'Question': return { action: 'answer Codex\'s question for you', detail: 'Codex goes on with that answer.' };
    default: return { action: `approve Codex's request${forChat}`, detail: 'Codex goes on with what it asked for.' };
  }
}

/**
 * The protocol's answer to a question asked with item/tool/requestUserInput: each prompt's own answer, by its id (the labels of the choices
 * picked, then the words typed), or null when an answer names a prompt or a choice the question does not have.
 */
export function questionAnswer(params, prompts, answers) {
  const byId = new Map((Array.isArray(prompts) ? prompts : []).map((x) => [x.id, x]));
  const out = {};
  for (const [id, a] of Object.entries(answers && typeof answers === 'object' ? answers : {})) {
    const prompt = byId.get(id);
    if (!prompt) return null;
    const picked = Array.isArray(a?.choices) ? a.choices.map(String) : [];
    if (picked.some((c) => !prompt.choices.some((x) => x.id === c))) return null;
    const words = typeof a?.text === 'string' && a.text ? [a.text] : [];
    if (words.length && !prompt.other) return null;
    out[id] = { answers: [...picked.map((c) => prompt.choices.find((x) => x.id === c).label), ...words] };
  }
  return { answers: out };
}
