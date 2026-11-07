// Native types, area E of docs/graph/02-types.md: Request, Approval and its subtypes, and Question, with Codex's own (CodexCommandApproval,
// CodexQuestion: graph-integrity G1). Conventions are in threads.mjs.
// - An approval offers its provider's choices as they are (`options`), and is answered by one of them: a mod answering any provider's
//   approval meets one shape (graph-boundary.md §4, refereeing), and nothing is reduced to the scopes the framework once guessed.
// - A question has every prompt its source asked, each answered by its id; an answer to a `secret` prompt is never kept or emitted.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

// `option`: the provider's id of the option an approval was answered with
const OUTCOME = s.object({ decision: s.enum('approved', 'denied', 'cancelled', 'answered'), scope: s.enum('once', 'thread', 'always').optional(), option: s.string().optional() });
// `rule`: the title of the policy a mod answered by (public-hooks.md §3.6); `through`: the mod whose surface the user answered in
// (graph-integrity G7.3)
const ANSWERED_BY = s.object({ kind: s.enum('user', 'mod', 'app', 'unknown'), id: s.string().optional(), via: s.string().optional(), rule: s.string().optional(), through: s.string().optional(), at: s.time() });

export const Request = defineConcept('Request', {
  state: {
    status: s.enum('pending', 'answered', 'declined', 'expired', 'cancelled'),
    from: s.enum('agent', 'tool'),
    askedAt: s.time(),
    answeredAt: s.time().optional(),
    // what was answered (an approval's scope; a question's typed text is never kept) and who answered (public-hooks.md §3.6, H5)
    outcome: OUTCOME.optional(),
    answeredBy: ANSWERED_BY.optional(),
  },
  relations: {
    thread: r.one('Thread'),
    turn: r.one('Turn'),
    step: r.maybe('Step'),
    tool: r.maybe('Tool'), // when a tool asked
  },
  // answered and cancelled say what and who when the provider knows (a mod's provider may give neither)
  events: { opened: ev(), answered: ev(s.object({ outcome: OUTCOME.optional(), answeredBy: ANSWERED_BY.optional() })), expired: ev(),
    cancelled: ev(s.object({ outcome: OUTCOME.optional(), answeredBy: ANSWERED_BY.optional() })) },
  // `ask` (public-hooks.md §3.6): what runs before the user is asked. Its own part shows the request; a mod's interceptor of it may answer
  // first (as its own approve, deny or answer) or let it through (`next()`).
  operations: { ask: op() },
  // A request has no text of its own (each subtype defines what is asked), so its status is the title.
  summary: { title: 'status', time: 'askedAt' },
});

// `options`: what the provider offers, as it labels them: approving (`once`, for the chat, or `always`, which makes a standing rule) or
// declining (`deny`; `cancel` also stops the turn). `answer(option, feedback?)` picks one; feedback goes with a decline.
export const Approval = defineSubtype(Request, 'Approval', {
  state: {
    reason: s.string().optional(),
    options: s.list(s.object({ id: s.string(), label: s.string(), kind: s.enum('approve', 'deny', 'cancel'), scope: s.enum('once', 'thread', 'always').optional() })),
  },
  relations: { rule: r.maybe('AccessRule') }, // made by an `always` option
  operations: {
    answer: op({ args: [s.string(), s.content().optional()] }), // (option id, feedback?)
  },
});

// `command` as it will run (a shell wrapper kept), `display` as the app shows it.
export const CommandApproval = defineSubtype(Approval, 'CommandApproval', {
  state: {
    command: s.string(), directory: s.string(), // a Path
    display: s.string().optional(),
  },
});

// Codex's command approval, as the server asks it: the actions it parsed from the command, the rules it proposes for "always", and the
// decisions it offers, as given (graph-integrity G1.1).
export const CodexCommandApproval = defineSubtype(CommandApproval, 'CodexCommandApproval', {
  state: {
    commandActions: s.list(s.json()),
    availableDecisions: s.list(s.json()).optional(),
    proposedExecpolicyAmendment: s.list(s.string()).optional(),
    proposedNetworkPolicyAmendments: s.list(s.json()).optional(),
    networkApprovalContext: s.json().optional(),
    approvalId: s.string().optional(),
    itemId: s.string().optional(),
  },
});

// `files`: what it would apply (from its fileChange step); `grantRoot`: a request to write under that folder for the session.
export const EditApproval = defineSubtype(Approval, 'EditApproval', {
  state: {
    files: s.list(s.object({ path: s.string(), change: s.enum('add', 'update', 'delete'), movedTo: s.string().optional(), added: s.number().optional(), removed: s.number().optional() })),
    grantRoot: s.string().optional(),
  },
  relations: { edits: r.many('FileEdit') },
});

export const NetworkApproval = defineSubtype(Approval, 'NetworkApproval', {
  state: { host: s.string() },
});

// Its tool is the inherited Request.tool, which a provider always sets for a tool approval.
export const ToolApproval = defineSubtype(Approval, 'ToolApproval', {
  state: { input: s.content() },
});

export const ComputerUseApproval = defineSubtype(Approval, 'ComputerUseApproval', {
  state: { action: s.string() },
  relations: { app: r.one('ExternalApp') },
});

// Each prompt as the source asked it: its own id, a short `header`, the `prompt`, its `choices`, whether an answer of the user's own words
// is taken (`other`) and whether that answer is `secret`. `blocking`: the agent waits for the answer (else it goes on and takes it later);
// `autoResolveAfterMs`: the source answers by itself after that long. `answer(answers)`: per prompt id, the choices picked and the words
// typed.
export const Question = defineSubtype(Request, 'Question', {
  state: {
    prompts: s.list(s.object({
      id: s.string(), header: s.string().optional(), prompt: s.content(),
      choices: s.list(s.object({ id: s.string(), label: s.string(), description: s.string().optional() })),
      other: s.boolean(), secret: s.boolean(),
    })),
    blocking: s.boolean(),
    autoResolveAfterMs: s.number().optional(),
  },
  operations: {
    answer: op({ args: [s.record(s.object({ choices: s.list(s.string()).optional(), text: s.string().optional() }))] }),
    skip: op(),
  },
});

// Codex's question, as the server asks it: from its question tool (`requestUserInput`) or a tool server's elicitation, with the tool
// server's form (`requestedSchema`, JSON Schema) or the page it sends the user to (`url`) as given.
export const CodexQuestion = defineSubtype(Question, 'CodexQuestion', {
  state: {
    source: s.enum('requestUserInput', 'elicitation'),
    serverName: s.string().optional(),
    requestedSchema: s.json().optional(),
    url: s.string().optional(),
    itemId: s.string().optional(),
  },
});
