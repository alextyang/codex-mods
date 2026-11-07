// The SDK's entry points as features of the log (docs/design/systems.md S16, "E4 in detail"): what a mod may name in `requires` and
// `optional` beside the graph's types and presentations. Most need nothing of the app; those that do say so. A feature's `version` is
// an epoch, raised when its contract breaks; `accepts` lists the epochs still honoured (by default the current one). A test keeps the
// namespaces equal to sdk/index.d.ts's contexts.
// Node built-ins only (none needed).

/** The components the app has: drawn with the app's own where the copy exposes it, else with the runtime's primitive, which needs React. */
export const COMPONENTS = Object.freeze(['Button', 'Switch', 'TextField', 'Menu', 'Dialog', 'SettingsSection', 'SettingsCard', 'SettingsRow', 'Tooltip', 'Icon']);
/** The framework's own (present/kit): they need only React, and draw through the app's Button and Menu where it has them. */
export const KIT_COMPONENTS = Object.freeze(['Badge', 'Banner', 'Checkbox', 'EmptyState', 'Glyph', 'IconTile', 'MenuButton', 'SearchField', 'SegmentedControl', 'Select', 'Tabs']);

export const SDK_FEATURES = Object.freeze([
  { id: 'mod', title: 'ctx.mod (the mod\'s own facts)' },
  { id: 'log', title: 'ctx.log' },
  { id: 'settings', title: 'ctx.settings (a mod\'s settings at the app, a project or a thread)' },
  { id: 'storage', title: 'ctx.storage' },
  { id: 'secrets', title: 'ctx.secrets' },
  { id: 'permissions', title: 'ctx.permissions' },
  { id: 'events', title: 'ctx.events' },
  { id: 'services', title: 'ctx.services' },
  { id: 'intelligence', title: 'ctx.intelligence (model use, through mod intelligence)' },
  { id: 'appServer', title: 'ctx.appServer (the app-server\'s methods a mod names are judged one by one)' },
  { id: 'processes', title: 'ctx.processes' },
  { id: 'scheduler', title: 'ctx.scheduler' },
  { id: 'graph', title: 'ctx.graph' },
  // graph-integrity G3.5: the agent's inputs as acts mods intercept (a thread's start and resume, a fork's and a send's parameters, the
  // skill roots) and a mod's tools routed to it (Tool._call); the SDK's helpers (sdk/agent.mjs) are built on them
  { id: 'agent.inputs', title: 'the agent\'s inputs mods add to (instructions, tools, skills), and a mod\'s tools answered by it',
    needs: ['protocol:thread/start', 'protocol:thread/resume', 'protocol:thread/fork', 'protocol:turn/start', 'protocol:item/tool/call', 'protocol:skills/extraRoots/set', 'protocol:skills/list'] },
  { id: 'ui', title: 'ctx.ui\'s presentation rules', needs: ['seam:jsx', 'exposure:react'] },
  { id: 'ui.menus', title: 'ctx.ui\'s menu entries', needs: ['seam:jsx', 'seam:menuItems', 'exposure:react'] },
  { id: 'ui.content', title: 'ctx.ui\'s message content (part renderers: code, inline code, links, directives at every markdown site)', needs: ['seam:jsx', 'seam:markdown', 'exposure:react'] },
  { id: 'ui.panel', title: 'ctx.ui\'s panel views (tabs of the app\'s panels, restored like its own)', needs: ['seam:jsx', 'exposure:react', 'exposure:tabRegistry', 'exposure:panelControllers', 'exposure:useScope', 'exposure:RouteScope'], prefers: ['seam:launcher'] },
  { id: 'ui.commands', title: 'ctx.ui\'s commands', needs: ['seam:taps'] },
  ...COMPONENTS.map((c) => ({ id: `component.${c}`, title: `The ${c} component`, needs: ['exposure:react'], prefers: [`exposure:${c}`] })),
  ...KIT_COMPONENTS.map((c) => ({ id: `component.${c}`, title: `The kit's ${c} component`, needs: ['exposure:react'], prefers: ['exposure:Button', 'exposure:Menu'] })),
]);
