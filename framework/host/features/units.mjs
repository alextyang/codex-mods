// The units of the framework's code that reach the app, for the feature log (docs/design/systems.md S16, "E4 in detail"): the files of
// each unit, the features it serves, and what its scan cannot know. scripts/features.mjs scans the files (method literals at call sites;
// framework-main's area-kit calls) and joins the result with these declarations into log.json; a test keeps the log equal to it.
// - `serves`: the features the unit's mechanics are for: `graph:<Type>` and `graph:<DeclaringType>.<operation>`. An area's are its own
//   `realizes` (`area`); a core module's are listed.
// - `assign`: a mechanic used by some of those features only (an operation's method, an item type's notifications), with the features
//   that need it. Any mechanic not assigned is needed by every feature the unit serves.
// - `prefers`: mechanics used for best effort (observing the app's own traffic, a cleanup that may fail, a fallback): never a status.
// - `anyOf`: alternatives (one of them is enough), each a list of mechanics.
// - `notMechanics`: method-shaped literals that are not the app's (the framework's own bus topics).
// - `dynamic`: call sites whose method or target is not a literal, with what they reach (`mechanics`) or why nothing is checked.
// - `unchecked`: what the unit reaches that no build evidence can check (a service's methods, app action types, follower requests,
//   Electron calls), for the reader.
// Node built-ins only (none needed).

const HOST = 'framework/host/graph/providers/codex';
const MAIN = 'framework/main';

/** The framework's own bus topics, which look like methods. */
export const NOT_MECHANICS = Object.freeze(['appServer/ready', 'appServer/exited', 'framework/theme', 'window/shown', 'window/closed', 'window/newChat', 'window/attachments', 'codex/toolSurface']);

const CONVERSATION_TYPES = ['CodexAgent', 'Model', 'Draft', 'CodexThread', 'CodexTurn', 'UserMessage', 'Attachment', 'Mention', 'AgentMessage', 'CodexStep',
  'CodexReasoning', 'Plan', 'PlanTask', 'CodexCommandRun', 'FileEdit', 'Search', 'WebLookup', 'CodexToolCall', 'ComputerAction', 'Delegation', 'Approval',
  'CodexCommandApproval', 'EditApproval', 'NetworkApproval', 'ToolApproval', 'ComputerUseApproval', 'CodexQuestion'];
const PROJECT_FEATURES = ['graph:LocalProject', 'graph:Project.open', 'graph:Project.rename', 'graph:Project.remove', 'graph:Project.openIn', 'graph:Project.newTerminal', 'graph:LocalProject.reveal',
  'graph:LocalEnvironment'];
const FILE_FEATURES = ['graph:Folder', 'graph:File', 'graph:Folder.reveal', 'graph:Folder.openIn', 'graph:File.open', 'graph:File.reveal', 'graph:File.openIn'];
const APP_FEATURES = ['graph:ExternalApp', 'graph:ExternalApp.open', 'graph:ExternalApp.setComputerUse'];
const GIT_FEATURES = ['graph:GitRepository', 'graph:Branch', 'graph:Repository.switchBranch', 'graph:Repository.createBranch', 'graph:Repository.push', 'graph:Repository.workingChanges', 'graph:Branch.switch'];
const WORKTREE_FEATURES = ['graph:WorktreeEnvironment', 'graph:WorktreeEnvironment.remove'];
const INSTRUCTION_FEATURES = ['graph:CodexInstructions', 'graph:Instructions.edit', 'graph:Instructions.open'];
const ACTION_FEATURES = ['graph:ProjectAction', 'graph:Command.run'];
const CLOUD_FEATURES = ['graph:CloudEnvironment', 'graph:CloudEnvironment.manage'];
const APP_STATE_FEATURES = ['graph:App', 'graph:Theme', 'graph:Setting', 'graph:SettingsSection', 'graph:Setting.set', 'graph:Setting.reset', 'graph:Theme.set',
  'graph:App.openHelp', 'graph:App.quit', 'graph:App.sendFeedback'];
const ACCOUNT_FEATURES = ['graph:Account', 'graph:ChatGPTAccount', 'graph:CodexUsage', 'graph:Account.signIn', 'graph:Account.signOut', 'graph:Account.manage'];

/** @type {readonly object[]} */
export const UNITS = Object.freeze([
  // ---- the native provider's core (realizes.mjs CORE)
  { id: 'core:conversation', files: [`${HOST}/index.mjs`, `${HOST}/map.mjs`],
    serves: [...CONVERSATION_TYPES.map((t) => `graph:${t}`), 'graph:Thread.rename', 'graph:CodexThread.setGoal', 'graph:CodexThread.clearGoal', 'graph:Thread.markRead', 'graph:Thread.markUnread', 'graph:Thread.moveTo',
      'graph:Approval.answer', 'graph:Question.answer', 'graph:Question.skip'],
    assign: {}, prefers: [], anyOf: [], dynamic: [], unchecked: [] },
  { id: 'core:projects', files: [`${HOST}/projects.mjs`], serves: PROJECT_FEATURES },
  { id: 'core:files', files: [`${HOST}/files.mjs`], serves: FILE_FEATURES },
  { id: 'core:apps', files: [`${HOST}/apps.mjs`], serves: APP_FEATURES },
  { id: 'core:git', files: [`${HOST}/git.mjs`], serves: GIT_FEATURES },
  { id: 'core:worktrees', files: [`${HOST}/worktrees.mjs`], serves: WORKTREE_FEATURES },
  { id: 'core:instructions', files: [`${HOST}/instructions.mjs`], serves: INSTRUCTION_FEATURES },
  { id: 'core:actions', files: [`${HOST}/actions.mjs`], serves: ACTION_FEATURES },
  { id: 'core:cloud', files: [`${HOST}/cloud.mjs`], serves: CLOUD_FEATURES },
  { id: 'core:app-state', files: [`${HOST}/app-state.mjs`, `${HOST}/settings-catalog.mjs`], serves: APP_STATE_FEATURES },
  { id: 'core:accounts', files: [`${HOST}/accounts.mjs`], serves: ACCOUNT_FEATURES },
  // ---- framework-main's modules the core reaches (appProjects, appState, the read state)
  { id: 'main:projects', files: [`${MAIN}/projects.cjs`],
    serves: [...PROJECT_FEATURES, ...FILE_FEATURES, ...APP_FEATURES, ...GIT_FEATURES, ...WORKTREE_FEATURES, ...INSTRUCTION_FEATURES, ...ACTION_FEATURES, ...CLOUD_FEATURES, 'graph:Thread.moveTo'],
    // the persisted atoms' container (the census lists the atoms, not the key that holds them)
    notMechanics: ['electron-persisted-atom-state'], unchecked: ['stored electron-persisted-atom-state (the persisted atoms\' container)'] },
  { id: 'main:app-state', files: [`${MAIN}/app-state.cjs`], serves: [...APP_STATE_FEATURES, ...ACCOUNT_FEATURES] },
  { id: 'main:read-state', files: [`${MAIN}/read-state.cjs`], serves: ['graph:Thread.markRead', 'graph:Thread.markUnread'] },
  // a new window: framework-main asks a window's page, whose preload sends the app's main its own request (App.openWindow)
  { id: 'page:new-window', files: ['framework/preload/preload.cjs'], serves: ['graph:App.openWindow'], needs: ['fromView:open-in-new-window'],
    notMechanics: ['text/plain', 'text/html'] },   // the clipboard's formats a selection's copy sets (the copy seam's kernel side)
  // ---- the feature areas: each host area (its realizes) with framework-main's module of the same name
  ...['agent-config', 'automations', 'browser', 'changes', 'commands', 'comments', 'composer', 'computer-use', 'history', 'notifications', 'plugins',
    'pull-requests', 'queue', 'review', 'run-control', 'skills', 'terminals', 'thread-settings', 'threads', 'tool-servers'].flatMap((a) => [
    { id: `area:${a}`, area: a, files: [`${HOST}/areas/${a}.mjs`] },
    { id: `main:${a}`, area: a, files: [`${MAIN}/areas/${a}.cjs`], optional: true },
  ]),
]);
