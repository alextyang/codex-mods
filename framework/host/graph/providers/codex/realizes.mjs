// What the native provider realizes (docs/design/breadth.md §3, coverage accounting): the types it puts, the operations it handles, the
// optional members it supports and the relations it links, by instance type. The provider registers from it (index.mjs), scripts/coverage.mjs
// counts from it, and tests keep it equal to what the provider and the map do (codex.test.mjs, map.test.mjs). The feature areas in their own
// modules (areas.mjs) declare their parts there; they are merged in here. Node built-ins only (none).
import { AREAS } from './areas.mjs';

/** The optional members each type's instances support (the provider's per-type declaration, T5): the core's, then each area's. */
const CORE_SUPPORTS = Object.freeze({
  CodexAgent: ['unavailableReason', 'accounts', 'startAccount'],
  Model: ['contextWindow'],   // once a turn's usage told it (Codex says no pricing)
  Thread: ['waitingOn', 'preview', 'model', 'account'],
  CodexThread: ['cwd', 'gitInfo', 'sessionId', 'ephemeral', 'modelProvider', 'reasoningEffort', 'cliVersion', 'source', 'originator', 'threadSource',
    'agentNickname', 'agentRole', 'recencyAt', 'usage', 'goal'],
  Turn: ['endedAt', 'error', 'stoppedBy'],
  CodexTurn: ['trigger', 'triggerBy', 'triggerDetail', 'errorInfo', 'durationMs', 'rootTurnId', 'diff'],
  Step: ['endedAt'],
  CommandRun: ['exitCode', 'duration'],
  CodexCommandRun: ['processId', 'source', 'pluginId', 'scriptPath'],
  ToolCall: ['output', 'error'],
  CodexToolCall: ['server', 'namespace', 'result', 'contentItems', 'success', 'durationMs'],
  WebLookup: [],
  Request: ['answeredAt', 'outcome', 'answeredBy'],
  Approval: ['reason'],
  CommandApproval: ['display'],
  CodexCommandApproval: ['availableDecisions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'networkApprovalContext', 'approvalId', 'itemId'],
  EditApproval: ['grantRoot'],
  Question: ['autoResolveAfterMs'],
  CodexQuestion: ['serverName', 'requestedSchema', 'url', 'itemId'],
  CodexUsage: ['ordinaryUsageAllowed', 'rateLimitResetCredits'],
  Repository: ['currentBranch'],
  Branch: ['ahead', 'upstream'],
  CodexInstructions: ['location'],
  ProjectAction: ['icon'],
  WorktreeEnvironment: ['setup'],
  Setting: ['key', 'description', 'choices', 'overridden', 'configured'],
  App: ['onboarded'],
  Account: ['email', 'plan'],
  ChatGPTAccount: ['workspace', 'added'],
});

const REQUEST_LINKS = ['thread', 'turn'];

export const CORE = Object.freeze({
  /** The types whose instances it puts. */
  types: Object.freeze([
    'CodexAgent', 'Model', 'Draft', 'CodexThread', 'CodexTurn', 'UserMessage', 'Attachment', 'Mention', 'AgentMessage',
    'CodexStep', 'CodexReasoning', 'Plan', 'PlanTask', 'CodexCommandRun', 'FileEdit', 'Search', 'WebLookup', 'CodexToolCall', 'ComputerAction', 'Delegation',
    'Approval', 'CodexCommandApproval', 'EditApproval', 'NetworkApproval', 'ToolApproval', 'ComputerUseApproval', 'CodexQuestion',
    'LocalProject', 'Folder', 'File', 'ExternalApp', 'LocalEnvironment', 'CloudEnvironment', 'WorktreeEnvironment', 'GitRepository', 'Branch',
    'CodexInstructions', 'ProjectAction', 'App', 'Theme', 'Setting', 'SettingsSection',
    'Account', 'ChatGPTAccount', 'CodexUsage',
  ]),
  /** Operation handlers, by the type that declares them. Thread.markRead and markUnread need the app's read state, Thread.moveTo and the
   *  project operations the app's projects (the Host always has both). */
  operations: Object.freeze({
    Thread: Object.freeze(['rename', 'markRead', 'markUnread', 'moveTo', 'moveToAccount']),
    CodexAgent: Object.freeze(['addAccount', 'setStartAccount']),
    CodexThread: Object.freeze(['setGoal', 'clearGoal']),
    Request: Object.freeze(['ask']),
    Approval: Object.freeze(['answer']),
    Question: Object.freeze(['answer', 'skip']),
    Project: Object.freeze(['open', 'rename', 'remove', 'openIn', 'newTerminal', 'findFiles']),
    LocalProject: Object.freeze(['reveal', 'addInstructions']),
    Folder: Object.freeze(['reveal', 'openIn']),
    File: Object.freeze(['open', 'reveal', 'openIn']),
    ExternalApp: Object.freeze(['open', 'setComputerUse']),
    Repository: Object.freeze(['switchBranch', 'createBranch', 'push', 'workingChanges']),
    Branch: Object.freeze(['switch']),
    Instructions: Object.freeze(['edit', 'open']),
    Command: Object.freeze(['run']),
    WorktreeEnvironment: Object.freeze(['remove']),
    CloudEnvironment: Object.freeze(['manage']),
    Setting: Object.freeze(['set', 'reset']),
    Theme: Object.freeze(['set']),
    Account: Object.freeze(['signIn', 'signOut', 'manage', 'remove']),
    App: Object.freeze(['openHelp', 'quit', 'sendFeedback', 'addProject', 'frontWindow', 'openWindow']),
  }),
  supports: CORE_SUPPORTS,
  /** The named events it emits, by the type that declares them. */
  events: Object.freeze({
    Agent: ['availabilityChanged'], Model: ['availabilityChanged'],
    Thread: ['created', 'titleChanged', 'statusChanged', 'turnStarted', 'turnFinished', 'requestOpened', 'archived', 'restored', 'deleted'],
    CodexThread: ['tokenUsageReported', 'compacted', 'reverted', 'hookStarted', 'hookCompleted', 'guardianWarning', 'warning', 'predicted'],
    Turn: ['started', 'stepAdded', 'completed', 'stopped', 'failed'],
    CodexTurn: ['errored', 'modelRerouted', 'verified', 'approvalReviewStarted', 'approvalReviewCompleted', 'strictReviewRequired', 'safetyBuffering', 'moderated'],
    Step: ['started', 'updated', 'finished'],
    Plan: ['tasksChanged'],
    AgentMessage: ['updated', 'completed'],
    Request: ['opened', 'answered', 'cancelled'],
    Project: ['added', 'opened', 'renamed', 'removed'],
    File: ['changed', 'deleted'],
    ExternalApp: ['changed'],
    Environment: ['statusChanged'],
    Repository: ['branchChanged', 'statusChanged', 'pushed'],
    Instructions: ['changed'],
    Command: ['ran'],
    Setting: ['changed'], Theme: ['changed'], App: ['launched', 'quitting', 'windowOpened', 'windowClosed'],
    Account: ['signedIn', 'signedOut', 'planChanged'], Usage: ['changed'], CodexUsage: ['reported'],
  }),
  /** The relations it links, by instance type (inverse relations follow from these). */
  links: Object.freeze({
    Model: ['agent'], CodexAgent: ['account', 'accounts', 'startAccount'],
    CodexThread: ['agent', 'project', 'environment', 'model', 'parent', 'account'],
    CodexTurn: ['thread', 'answer'],
    UserMessage: ['turn', 'attachments', 'mentions'], Attachment: ['message', 'file'], Mention: [], AgentMessage: ['turn'],
    PlanTask: ['plan'], ComputerAction: ['turn', 'app', 'session'],
    CodexStep: ['turn'], CodexReasoning: ['turn'], Plan: ['turn'], CodexCommandRun: ['turn', 'request'], Search: ['turn'], WebLookup: ['turn'], CodexToolCall: ['turn', 'tool', 'request'],
    Delegation: ['turn', 'child'], FileEdit: ['turn', 'file', 'change', 'request'],
    CodexCommandApproval: [...REQUEST_LINKS, 'step'], NetworkApproval: [...REQUEST_LINKS, 'step'], Approval: REQUEST_LINKS, EditApproval: [...REQUEST_LINKS, 'edits'],
    CodexQuestion: REQUEST_LINKS, ToolApproval: [...REQUEST_LINKS, 'tool'], ComputerUseApproval: [...REQUEST_LINKS, 'app', 'tool'],
    Folder: ['project', 'parent'], File: ['project', 'folder'], ExternalApp: [], LocalEnvironment: ['project', 'folder'], CloudEnvironment: ['project'], WorktreeEnvironment: ['project', 'branch', 'base'],
    GitRepository: ['project', 'currentBranch'], Branch: ['repository'], LocalProject: ['folder', 'root', 'repository', 'draft'],
    CodexInstructions: ['project', 'folder', 'agents'],
    ProjectAction: ['project'],
    Setting: ['section', 'definedBy'], SettingsSection: [], Theme: ['app', 'settings'], App: ['theme', 'agents', 'accounts', 'settings', 'projects', 'externalApps', 'newChatDraft'],
    ChatGPTAccount: ['usage'], Account: [], CodexUsage: ['account'],
  }),
});

/** The core's declaration with each area's part (areas.mjs) merged in: lists join, without repeats. */
function merged() {
  const parts = Object.values(AREAS).map((a) => a.realizes ?? {});
  const join = (...lists) => Object.freeze([...new Set(lists.flat())]);
  const byType = (key) => {
    const out = {};
    for (const part of [CORE[key], ...parts.map((x) => x[key] ?? {})]) for (const [type, list] of Object.entries(part)) out[type] = join(out[type] ?? [], list);
    return Object.freeze(out);
  };
  return Object.freeze({
    types: join(CORE.types, ...parts.map((x) => x.types ?? [])),
    operations: byType('operations'), supports: byType('supports'), events: byType('events'), links: byType('links'),
  });
}
export const REALIZES = merged();
export const SUPPORTS = REALIZES.supports;
