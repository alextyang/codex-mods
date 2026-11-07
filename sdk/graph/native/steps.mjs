// Native types, area D of docs/graph/02-types.md: Step and its subtypes, and PlanTask. Conventions are in threads.mjs.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

export const Step = defineConcept('Step', {
  state: {
    status: s.enum('running', 'done', 'failed', 'cancelled', 'waitingForYou'),
    title: s.string(),
    startedAt: s.time(),
    endedAt: s.time().optional(),
    _expanded: s.boolean().optional(),   // UI state: mechanism (graph-layers.md §2), no provider must put it
  },
  relations: {
    turn: r.one('Turn'),
    request: r.maybe('Request'),
  },
  operations: { _expand: op(), _collapse: op(), copy: op() },
  events: { started: ev(), updated: ev(), finished: ev() },
  // The card's default block shows the title and the status.
  summary: { title: 'title', status: 'status', time: 'startedAt' },
});

export const Reasoning = defineSubtype(Step, 'Reasoning', {
  state: { thinking: s.content() }, // what the agent is thinking, as shown
});

export const PlanTask = defineConcept('PlanTask', {
  state: {
    text: s.string(),
    status: s.enum('pending', 'inProgress', 'done'),
  },
  relations: { plan: r.one('Plan') },
  summary: { title: 'text', status: 'status' },
});

export const Plan = defineSubtype(Step, 'Plan', {
  relations: { tasks: r.many('PlanTask').parts().inverse('plan') },
  events: { tasksChanged: ev() },
});

export const CommandRun = defineSubtype(Step, 'CommandRun', {
  state: {
    command: s.string(),
    directory: s.string(), // a Path
    output: s.string(), // streams
    exitCode: s.number().optional(),
    duration: s.number().optional(), // milliseconds
  },
  relations: { terminal: r.maybe('Terminal') },
  operations: {
    copyCommand: op(),
    copyOutput: op(),
    stop: op().optional(),
    openInTerminal: op().optional(),
  },
});

export const FileEdit = defineSubtype(Step, 'FileEdit', {
  relations: {
    file: r.one('File'),
    change: r.one('FileChange'),
  },
  operations: { openDiff: op(), openFile: op() },
});

export const Search = defineSubtype(Step, 'Search', {
  state: {
    query: s.string(),
    scope: s.enum('files', 'web'),
    // `location` is a Path or a Url: both are strings.
    results: s.list(s.object({ title: s.string(), location: s.string() })),
  },
});

export const WebLookup = defineSubtype(Step, 'WebLookup', {
  state: { url: s.url(), pageTitle: s.string().optional() },
  relations: { tab: r.maybe('BrowserTab') },
  operations: { open: op() }, // in the browser panel
});

export const ToolCall = defineSubtype(Step, 'ToolCall', {
  state: {
    input: s.content(),
    output: s.content().optional(),
    error: s.string().optional(),
  },
  relations: { tool: r.one('Tool') },
});

export const ComputerAction = defineSubtype(Step, 'ComputerAction', {
  state: {
    action: s.string(),
    // An Image has no schema of its own yet: any JSON value stands for it until the library has one.
    screenshot: s.json().optional(),
  },
  relations: {
    app: r.maybe('ExternalApp'), // none until the action names its app (or it drives none)
    session: r.one('ComputerUseSession'),
  },
});

export const Delegation = defineSubtype(Step, 'Delegation', {
  state: { task: s.content() },
  relations: {
    child: r.one('Thread'), // the delegated work, with origin delegation
    agent: r.maybe('Agent').optional(), // when another agent does it
  },
});

// Codex's own steps, at the source's fidelity (graph-integrity G1.1): the protocol's item fields under their own names, beside the core the
// concept's surfaces draw. An item kind with no concept is a CodexStep that keeps the item as given.

// A command as the server ran it: `shellCommand` the whole invocation (the core's `command` is what the app shows), the actions it parsed.
export const CodexCommandRun = defineSubtype(CommandRun, 'CodexCommandRun', {
  state: {
    shellCommand: s.string(),
    commandActions: s.list(s.json()),
    processId: s.string().optional(),
    source: s.string().optional(),
    pluginId: s.string().optional(),
    scriptPath: s.string().optional(),
  },
});

// A tool call as the server made it: a tool server's (`server`) or one the client provided (`namespace`), the tool by its name (`toolName`:
// the core's `tool` is its Tool), its arguments and result as given.
export const CodexToolCall = defineSubtype(ToolCall, 'CodexToolCall', {
  state: {
    server: s.string().optional(),
    namespace: s.string().optional(),
    toolName: s.string(),
    arguments: s.json(),
    result: s.json().optional(),
    contentItems: s.json().optional(),
    success: s.boolean().optional(),
    durationMs: s.number().optional(),
  },
});

// The agent's reasoning as the server reports it, part by part: its summary (`summaryParts`: `summary` is every instance's own) and its
// content.
export const CodexReasoning = defineSubtype(Reasoning, 'CodexReasoning', {
  state: { summaryParts: s.list(s.string()), contentParts: s.list(s.string()) },
});

// An item of a kind the graph has no concept for (a hook's prompt, an image the agent viewed, a wait, a generated image, review mode
// entered or left, a compaction, a sub-agent's activity, or a kind newer than this library): its `itemType` and the item as given.
export const CodexStep = defineSubtype(Step, 'CodexStep', {
  state: { itemType: s.string(), item: s.json() },
});
