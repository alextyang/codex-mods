// What the native provider maps of the app-server's protocol, and what it leaves out and why (docs/design/graph-integrity.md G1.8), for the
// pinned build's schema (contracts/upstream/<PINNED>). test/fidelity.test.mjs diffs the schema against these lists: a notification, a field
// of a mapped definition, an item kind or a field of one that is neither mapped nor left out with a reason fails it, and so does a name the
// schema no longer has. A new build's additions are noticed that way, never dropped unseen.
// - `mapped`: the field reaches the graph, under its own name on a Codex subtype or through the concept's core (map.mjs, accounts.mjs, the
//   areas). `unmapped`: the field does not, with why. A Codex subtype that keeps a whole object as given (CodexStep's `item`, CodexTurn's
//   `errorInfo`) maps every field of it.
// Node built-ins only (none needed).

export const PINNED = '26.1027.30824-22943';

const RAW = 'kept whole as given (CodexStep.item)';

/** The server's notifications: those the provider realizes (a fact, an event or a read again), and those it leaves out, with why. */
export const NOTIFICATIONS = Object.freeze({
  mapped: Object.freeze([
    'error', 'thread/started', 'thread/status/changed', 'thread/archived', 'thread/deleted', 'thread/unarchived', 'thread/closed', 'thread/reverted',
    'skills/changed', 'thread/name/updated', 'thread/attachment/updated', 'thread/goal/updated', 'thread/prediction/updated', 'thread/goal/cleared',
    'thread/queue/changed', 'thread/settings/updated', 'thread/tokenUsage/updated', 'turn/started', 'hook/started', 'turn/completed', 'hook/completed',
    'turn/diff/updated', 'turn/plan/updated', 'item/started', 'item/autoApprovalReview/started', 'item/autoApprovalReview/completed',
    'autoApprovalReview/strictReviewRequired', 'item/completed', 'item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta',
    'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated', 'serverRequest/resolved',
    'item/mcpToolCall/progress', 'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated', 'account/updated', 'account/rateLimits/updated',
    'app/list/updated', 'fs/changed', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
    'thread/compacted', 'model/rerouted', 'model/verification', 'turn/moderationMetadata', 'model/safetyBuffering/updated', 'warning',
    'guardianWarning', 'account/login/completed',
  ]),
  unmapped: Object.freeze({
    'thread/readState/changed': 'the server\'s read receipts, which the app ignores: Thread.unread is the app\'s own read state (read-state.mjs)',
    'project/changed': 'the server\'s own project ids, another id space: the app\'s projects are read from the app (projects.mjs)',
    'thread/project/updated': 'the server\'s own project ids: a thread\'s project is the app\'s assignment (projects.mjs)',
    'thread/environment/connected': 'the server\'s remote execution environments, a different concept from Environment',
    'thread/environment/disconnected': 'the server\'s remote execution environments, a different concept from Environment',
    'command/exec/outputDelta': 'a client\'s own command/exec runs, not the agent\'s: the app\'s terminals are read through framework-main',
    'process/outputDelta': 'a client\'s own processes, not the agent\'s',
    'process/exited': 'a client\'s own processes, not the agent\'s',
    'mcpServer/event/stream/notification': 'a tool server\'s event stream for the UI it embeds in a message, which the app draws',
    'account/gatewayOAuth/changed': 'a model provider gateway\'s sign-in: no graph type is about a gateway',
    'remoteControl/status/changed': 'controlling the app from another device: a server-side feature, out of the graph\'s scope',
    'externalAgentConfig/import/progress': 'importing another agent\'s settings: an onboarding flow of the app\'s own',
    'externalAgentConfig/import/completed': 'importing another agent\'s settings: an onboarding flow of the app\'s own',
    'modelProvider/authRecoveryStarted': 'the app\'s own recovery of a model provider\'s sign-in',
    'modelProvider/authRecoveryCompleted': 'the app\'s own recovery of a model provider\'s sign-in',
    'deprecationNotice': 'an app-wide notice about the user\'s Codex config, shown in the app\'s banner: no graph type is about the config file',
    'configWarning': 'an app-wide notice about the user\'s Codex config, shown in the app\'s banner: no graph type is about the config file',
    'fuzzyFileSearch/sessionUpdated': 'the app\'s own file search session: Project.findFiles answers through its own request',
    'fuzzyFileSearch/sessionCompleted': 'the app\'s own file search session: Project.findFiles answers through its own request',
    'thread/realtime/started': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/itemAdded': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/item/started': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/item/transcript/delta': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/item/completed': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/transcript/delta': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/transcript/done': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/outputAudio/delta': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/sdp': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/error': 'realtime voice conversations: the graph has no concept for voice',
    'thread/realtime/closed': 'realtime voice conversations: the graph has no concept for voice',
    'windows/worldWritableWarning': 'Windows only: this app runs on macOS',
    'windowsSandbox/setupCompleted': 'Windows only: this app runs on macOS',
  }),
});

/** The fields of the definitions the provider maps into state, per definition (the v2 bundle's names). */
export const FIELDS = Object.freeze({
  Thread: {
    mapped: ['id', 'name', 'preview', 'status', 'createdAt', 'updatedAt', 'model', 'parentThreadId', 'forkedFromId', 'threadSource', 'source', 'originator',
      'cwd', 'gitInfo', 'sessionId', 'ephemeral', 'modelProvider', 'cliVersion', 'reasoningEffort', 'agentNickname', 'agentRole', 'recencyAt', 'turns'],
    unmapped: {
      projectId: 'the server\'s own project id, another id space: the thread\'s project is the app\'s assignment',
      path: 'marked unstable by the protocol: where the server keeps the thread on disk',
      historyMode: 'the server\'s persisted history contract, a storage detail',
      section: 'the server\'s own section for the thread: the app\'s sections (pinned) are read from the app',
      sectionEnteredAt: 'the server\'s own section for the thread: the app\'s sections (pinned) are read from the app',
    },
  },
  GitInfo: { mapped: ['branch', 'sha', 'originUrl'], unmapped: {} },
  ThreadGoal: { mapped: ['objective', 'status', 'tokensUsed', 'tokenBudget', 'timeUsedSeconds', 'createdAt', 'updatedAt'], unmapped: { threadId: 'the goal\'s thread, which carries it' } },
  Turn: {
    mapped: ['id', 'items', 'status', 'startedAt', 'completedAt', 'error', 'durationMs', 'rootTurnId'],
    unmapped: { itemsView: 'how much of `items` a read loaded: the provider reads the rest' },
  },
  TurnError: { mapped: ['message', 'codexErrorInfo', 'additionalDetails', 'misalignment'], unmapped: {} },   // CodexTurn.errorInfo keeps it whole
  ThreadTokenUsage: { mapped: ['total', 'last', 'modelContextWindow'], unmapped: {} },
  TokenUsageBreakdown: { mapped: ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'], unmapped: {} },
  RateLimitSnapshot: { mapped: ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'planType', 'rateLimitReachedType', 'individualLimit', 'spendControlReached', 'normalModelSlug'], unmapped: {} },
  RateLimitWindow: { mapped: ['usedPercent', 'windowDurationMins', 'resetsAt'], unmapped: {} },
  CreditsSnapshot: { mapped: ['hasCredits', 'unlimited', 'balance'], unmapped: {} },
  GetAccountRateLimitsResponse: {
    mapped: ['rateLimits', 'rateLimitsByLimitId', 'ordinaryUsageAllowed', 'rateLimitResetCredits'],
    unmapped: {
      accountId: 'the account the snapshot is for: the Usage links to the account the app signed in',
      rateLimitUpsell: 'a banner the backend offers in the app\'s own usage page: an offer, not a fact of usage',
    },
  },
  ToolRequestUserInputQuestion: { mapped: ['id', 'header', 'question', 'isOther', 'isSecret', 'options'], unmapped: {} },
  ToolRequestUserInputOption: { mapped: ['label', 'description'], unmapped: {} },
});

/** The request params files (per schema file): their fields, mapped or not. */
export const REQUESTS = Object.freeze({
  'ToolRequestUserInputParams.json': { mapped: ['threadId', 'turnId', 'itemId', 'questions', 'isBlocking', 'autoResolutionMs'], unmapped: {} },
  'CommandExecutionRequestApprovalParams.json': {
    mapped: ['threadId', 'turnId', 'itemId', 'approvalId', 'command', 'commandActions', 'cwd', 'networkApprovalContext', 'proposedExecpolicyAmendment',
      'proposedNetworkPolicyAmendments', 'reason', 'startedAtMs'],
    unmapped: {
      environmentId: 'the server\'s remote execution environment, a different concept from Environment',
      kind: 'what kind of action is reviewed; a network kind is told by its context (a NetworkApproval)',
    },
  },
  'FileChangeRequestApprovalParams.json': { mapped: ['threadId', 'turnId', 'itemId', 'grantRoot', 'reason', 'startedAtMs'], unmapped: {} },
});

/** Each thread item kind: the step or message it becomes, and its fields mapped or not. */
export const ITEMS = Object.freeze({
  userMessage: { type: 'UserMessage', mapped: ['id', 'content', 'clientId'], unmapped: {} },
  agentMessage: {
    type: 'AgentMessage', mapped: ['id', 'text', 'phase'],
    unmapped: {
      delivery: 'how the message reached the client, a transport detail',
      memoryCitation: 'the memory an answer cites, drawn in the message by the app: the library has no member for it',
      questions: 'questions a plan asks in its message: their answers come as a requestUserInput request, which is mapped',
    },
  },
  reasoning: { type: 'CodexReasoning', mapped: ['id', 'summary', 'content'], unmapped: {} },
  plan: { type: 'Plan', mapped: ['id'], unmapped: { text: 'the plan item\'s prose: the Plan\'s title and tasks come from turn/plan/updated' } },
  commandExecution: { type: 'CodexCommandRun', mapped: ['id', 'command', 'commandActions', 'cwd', 'aggregatedOutput', 'exitCode', 'durationMs', 'processId', 'source', 'pluginId', 'scriptPath', 'status'], unmapped: {} },
  fileChange: { type: 'FileEdit', mapped: ['id', 'changes', 'status'], unmapped: {} },
  mcpToolCall: {
    type: 'CodexToolCall', mapped: ['id', 'server', 'tool', 'arguments', 'result', 'error', 'durationMs', 'status'],
    unmapped: {
      appContext: 'an MCP app\'s context for the UI it embeds, which the app draws',
      mcpAppResourceUri: 'an MCP app\'s UI resource, which the app draws',
      mcpAppUi: 'an MCP app\'s UI, which the app draws',
      pluginId: 'the plugin that supplied the tool server: its Tool and ToolServer say so',
      readOnlyHint: 'the tool server\'s hint about the tool, the Tool\'s own',
    },
  },
  dynamicToolCall: { type: 'CodexToolCall', mapped: ['id', 'namespace', 'tool', 'arguments', 'contentItems', 'success', 'durationMs', 'status'], unmapped: {} },
  collabAgentToolCall: {
    type: 'Delegation', mapped: ['id', 'tool', 'prompt', 'receiverThreadIds', 'status'],
    unmapped: {
      senderThreadId: 'the step\'s own thread',
      agentsStates: 'the child threads report their own state (their CodexThread)',
      model: 'the child thread\'s own model (its Thread.model)',
      reasoningEffort: 'the child thread\'s own effort (its CodexThread.reasoningEffort)',
    },
  },
  webSearch: { type: 'Search', mapped: ['id', 'query', 'action', 'results'], unmapped: {} },
  hookPrompt: { type: 'CodexStep', mapped: ['id', 'fragments'], unmapped: {}, note: RAW },
  functionCallOutput: { type: 'CodexStep', mapped: ['id', 'name', 'namespace', 'output'], unmapped: {}, note: RAW },
  subAgentActivity: { type: 'CodexStep', mapped: ['id', 'agentPath', 'agentThreadId', 'kind', 'model', 'reasoningEffort'], unmapped: {}, note: RAW },
  imageView: { type: 'CodexStep', mapped: ['id', 'path'], unmapped: {}, note: RAW },
  sleep: { type: 'CodexStep', mapped: ['id', 'durationMs'], unmapped: {}, note: RAW },
  imageGeneration: { type: 'CodexStep', mapped: ['id', 'failure', 'generationId', 'inputImages', 'revisedPrompt', 'savedPath', 'status', 'transparentBackground'], unmapped: {}, note: RAW },
  enteredReviewMode: { type: 'CodexStep', mapped: ['id', 'review'], unmapped: {}, note: RAW },
  exitedReviewMode: { type: 'CodexStep', mapped: ['id', 'review'], unmapped: {}, note: RAW },
  contextCompaction: { type: 'CodexStep', mapped: ['id'], unmapped: {}, note: RAW },
});
