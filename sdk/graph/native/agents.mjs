// Native types, area C of docs/graph/02-types.md: Agent, CodexAgent and Model (decision V14 of docs/design/presentations.md). One definition per
// card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - `icon: Image`: an Image is a string here. A provider gives the name of a symbol (the theme draws it, in its own colors) or the url of
//   an image it serves; never a color. The bindings that show an agent's mark decide the symbols they know.
// - Agent's core is what the shared surfaces need of any agent (docs/design/graph-boundary.md B3): its name, icon and availability for the
//   new-chat agent picker and the thread header, its threads, and starting one. What an agent is made of (models, thread settings,
//   instructions, skills, tool servers, plugins, an account) is its own: CodexAgent adds Codex's, and a mod's agent declares its own on its
//   subtype.
// - CodexAgent.models and Agent.threads are the inverses of Model.agent and Thread.agent: a provider writes each link once, from the model and
//   from the thread.
// - CodexAgent.skills, toolServers and plugins name types that are not in this library yet (04, areas H, K); CodexAgent.settings are the
//   thread settings it defines (Setting.definedBy names it), CodexAgent.instructions the instructions it follows.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';
import { AutomationSpec } from './attention.mjs';

export const Agent = defineConcept('Agent', {
  state: {
    name: s.string(),
    icon: s.string(), // an Image: a symbol name or an image url (see above)
    available: s.boolean(),
    unavailableReason: s.string().optional(),
  },
  relations: {
    threads: r.many('Thread').inverse('agent'),
  },
  operations: {
    // a Draft, or a chat's spec {prompt?, environment?, branch?, model?, effort?, mode?, access?, send?, open?, replace?}: the Thread
    // (sent) or the new chat's Draft (not sent) (graph-layers.md §3.2)
    newThread: op({ args: [s.json()], returns: s.json() }),
    newAutomation: op({ args: [AutomationSpec], returns: r.one('Automation') }).optional(), // a scheduled prompt for this agent
  },
  events: { availabilityChanged: ev() },
  summary: { title: 'name', icon: 'icon' },
});

// Codex's agent: what it is made of. Its thread settings (reasoning effort, access, personality, mode, web search) are Setting instances
// with thread scope, reached through CodexAgent.settings and Thread.settings.
export const CodexAgent = defineSubtype(Agent, 'CodexAgent', {
  state: {
    skillRoots: s.list(s.string()).optional(),   // the session's extra skill roots, as its server last took them (G3.5)
  },
  relations: {
    models: r.many('Model').inverse('agent'),
    account: r.maybe('Account'),   // the app's own account (signed in in the app)
    accounts: r.many('Account').optional(),   // every account it can use: the app's, then the ones the user added (RM10)
    startAccount: r.maybe('Account').optional(),   // the account new chats start on (none: the app's)
    settings: r.many('Setting'), // the thread settings it defines
    instructions: r.many('Instructions'),
    skills: r.many('Skill'),
    toolServers: r.many('ToolServer'),
    plugins: r.many('Plugin'),
  },
  operations: {
    // a tool server of its own (a name, and its config: one command or URL and the keys the app's settings take), as the user adds one
    addToolServer: op({ args: [s.string(), s.json()], returns: r.one('ToolServer') }).optional(),
    // a skill of the user's own ({name, description, text, project?}: global, or in the project), as one the user writes
    addSkill: op({ args: [s.json()], returns: r.one('Skill') }).optional(),
    // another ChatGPT account beside the app's (RM10): it is added signed out and its sign-in opens in the browser
    addAccount: op({ returns: r.one('Account') }).optional(),
    // where new chats start (an account of its own, or none for the app's)
    setStartAccount: op({ args: [s.ref('Account').optional()] }).optional(),
    // graph-integrity G3.5, the agent's inputs as the source's own acts (mechanism): a thread's start with the source's own parameters
    // (ThreadStartParams as given: its developer instructions, dynamic tools, config, folder...), the app's own held for interceptors,
    // which add to what they share in the user's order; it answers the source's answer (ThreadStartResponse)
    _startThread: op({ args: [s.json()], returns: s.json() }),
    // the session's extra skill roots set (the app's own held as above); `skillRoots` is what the server last took
    _setSkillRoots: op({ args: [s.list(s.string())] }),
  },
});

export const Model = defineConcept('Model', {
  state: {
    name: s.string(),
    description: s.string(),
    efforts: s.list(s.object({ id: s.string(), label: s.string() })), // the reasoning levels it offers; may be empty
    default: s.boolean(),
    available: s.boolean(),
    inputs: s.list(s.enum('text', 'image')).optional(), // what a message to it may hold (none said: text only)
    contextWindow: s.number().optional(), // how many tokens a chat with it may hold (Codex's: as a chat's usage tells it)
    // what it costs, per million tokens, in a currency (a mod's model may say; Codex's do not)
    pricing: s.object({ input: s.number().optional(), output: s.number().optional(), currency: s.string() }).optional(),
  },
  relations: { agent: r.one('Agent') },
  operations: {
    // `for` is a Thread, a Draft, a Project or an Automation: a ref to one of them. The schema has no union of refs, so it is any JSON
    // value here and the provider checks the ref's type (as Thread.review does).
    _select: op({ args: [s.json()] }),   // mechanism: a model is set where it applies (graph-layers.md §2)
    makeDefault: op(),
  },
  events: { availabilityChanged: ev() },
  summary: { title: 'name', subtitle: 'description' },
});
