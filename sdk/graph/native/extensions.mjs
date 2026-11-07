// Native types, area H of docs/graph/02-types.md: ToolServer, Tool, Plugin and Skill, what extends an agent (breadth step D10). One
// definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - ToolServer.tools, Plugin.tools, Plugin.skills and Plugin.toolServers are the inverses of Tool.server, Tool.plugin, Skill.plugin and
//   ToolServer.plugin; Tool.calls is the inverse of ToolCall.tool; Account.toolServers and Account.plugins are the inverses of
//   ToolServer.account and Plugin.account (accounts.mjs). `agents` (on each) and CodexAgent.skills, toolServers and plugins are many to many:
//   a provider writes both sides.
// - Tool.source is where it comes from (the card's ToolServer | Plugin | built-in); the instance it comes from is its server or plugin.
// - A new ToolServer or Skill is made by its agent: CodexAgent.addToolServer(name, config) and CodexAgent.addSkill(spec) (agents.mjs); a server's
//   config is any JSON value (the shape is the agent's).
// - A ToolServer or a Plugin is on or off for the user (`enabled`, `status`), and a project may say otherwise for its own threads
//   (`enabledIn`, `disabledIn`: the projects whose own settings turn it on or off): `enable({project})` and `disable({project})` set it
//   there, `inherit({project})` takes the project's own setting away (it follows the user's again).
import { defineConcept, ev, op, r, s } from '../define.mjs';

/** Where an enable or disable applies: the user's (none given), or one project's own settings. */
const scope = () => s.object({ project: s.ref('Project') });

export const ToolServer = defineConcept('ToolServer', {
  state: {
    name: s.string(),
    status: s.enum('connected', 'starting', 'error', 'disabled'),
    transport: s.enum('local', 'remote'),
    auth: s.enum('none', 'signedIn', 'needsSignIn'),
    error: s.string().optional(),
    // where it is configured: only the user's config, a project's config (one defines or overrides any of its fields), or a plugin alone
    source: s.enum('user', 'project', 'plugin').optional(),
  },
  relations: {
    tools: r.many('Tool').inverse('server'),
    agents: r.many('Agent'),
    account: r.maybe('Account'),
    plugin: r.maybe('Plugin'), // when a plugin brought it
    enabledIn: r.many('Project').optional(),   // the projects whose own settings turn it on
    disabledIn: r.many('Project').optional(),  // the projects whose own settings turn it off
  },
  operations: {
    edit: op({ args: [s.json()] }),
    enable: op({ args: [scope().optional()] }),
    disable: op({ args: [scope().optional()] }),
    inherit: op({ args: [scope()] }).optional(),
    restart: op(),
    remove: op(),
    signIn: op().optional(),
    signOut: op().optional(),
  },
  events: { statusChanged: ev(), toolsChanged: ev() },
  summary: { title: 'name', subtitle: 'status' },
});

export const Tool = defineConcept('Tool', {
  state: {
    name: s.string(),
    description: s.string(),
    enabled: s.boolean(),
    source: s.enum('toolServer', 'plugin', 'builtIn', 'mod'),   // mod: a mod's own, which a thread took at its start (G3.5)
  },
  relations: {
    server: r.maybe('ToolServer'),
    plugin: r.maybe('Plugin'),
    calls: r.many('ToolCall').inverse('tool'),
  },
  operations: {
    enable: op(), disable: op(),
    // G3.5 (mechanism): the agent calls it (its arguments, and {thread, turn, call}); it answers the tool's result: text, {text}, {image}
    // or a list of them. A mod's tool is answered by that mod (a replacing interceptor, its own namespace only); while the mod is off, the
    // framework answers that it is not running.
    _call: op({ args: [s.json(), s.json().optional()], returns: s.json() }).optional(),
  },
  summary: { title: 'name', subtitle: 'description' },
});

export const Plugin = defineConcept('Plugin', {
  state: {
    name: s.string(),
    description: s.string(),
    installed: s.boolean(),
    enabled: s.boolean(),
    connected: s.boolean().optional(), // when it links an outside account
  },
  relations: {
    tools: r.many('Tool').inverse('plugin'),
    skills: r.many('Skill').inverse('plugin'),
    toolServers: r.many('ToolServer').inverse('plugin'),
    agents: r.many('Agent'),
    account: r.maybe('Account'),
    enabledIn: r.many('Project').optional(),   // the projects whose own settings turn it on
    disabledIn: r.many('Project').optional(),  // the projects whose own settings turn it off
  },
  operations: {
    install: op(),
    uninstall: op(),
    enable: op({ args: [scope().optional()] }),
    disable: op({ args: [scope().optional()] }),
    inherit: op({ args: [scope()] }).optional(),
    connect: op().optional(),
    disconnect: op().optional(),
  },
  events: { installed: ev(), uninstalled: ev(), enabled: ev(), disabled: ev(), connected: ev(), disconnected: ev() },
  summary: { title: 'name', subtitle: 'description' },
});

export const Skill = defineConcept('Skill', {
  state: {
    name: s.string(),
    description: s.string(),
    scope: s.enum('global', 'project'),
    source: s.enum('builtIn', 'yours', 'library'),
    installed: s.boolean(),
    enabled: s.boolean(),
  },
  relations: {
    project: r.maybe('Project'),
    agents: r.many('Agent'),
    plugin: r.maybe('Plugin'),
  },
  operations: {
    edit: op(),
    enable: op(),
    disable: op(),
    delete: op(),
    use: op({ args: [s.ref('Draft')] }), // invoke it in a message
    install: op().optional(), // from the library
  },
  events: { added: ev(), changed: ev(), removed: ev() },
  summary: { title: 'name', subtitle: 'description' },
});
