// Native types, area A of docs/graph/02-types.md: App, Theme and Update (breadth step D4). One definition per card, with the same builders a
// mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - App is one instance (the running app); Theme and Update belong to it. App.theme and Theme.app are both written (a relation of one to
//   one has no inverse in the runtime), as are App.update and Update.app.
// - App.openWindow takes a ref to any type (what the window shows): the schemas have no union, so it is any JSON value here and the
//   provider checks it. App.windows is derived: the Windows whose subject is the App (a Window presents the App; sdk/graph/presentations.mjs).
// - Theme.accent is a Color: a string here. Theme.tokens maps a token's name to its value (any JSON: the app's colors, spacing, type).
import { defineConcept, ev, op, r, s } from '../define.mjs';

export const App = defineConcept('App', {
  state: {
    version: s.string(),
    onboarded: s.boolean().optional(),
  },
  relations: {
    windows: r.many('Window').inverse('subject'),
    accounts: r.many('Account'),
    agents: r.many('Agent'),
    projects: r.many('Project'),
    automations: r.many('Automation'),
    externalApps: r.many('ExternalApp'),
    settings: r.many('Setting'),
    theme: r.one('Theme'),
    update: r.maybe('Update'),
    newChatDraft: r.maybe('Draft'),   // the new chat's Draft without a project (graph-layers.md §3.2)
  },
  operations: {
    openWindow: op({ args: [s.json().optional()], returns: r.one('Window') }),
    checkForUpdates: op(),
    frontWindow: op({ returns: s.json() }).optional(),   // the Window the user is in, or null (graph-layers.md §3.3; asked, never stale)
    sendFeedback: op({ args: [s.content()] }),
    openHelp: op(),
    quit: op(),
    // the app's own desktop notification, as it is about to show (public-hooks.md §3.5, §3.14): interceptable (a policy may keep it from
    // showing, or rewrite its title and body); what mods show themselves is `ui.notify`
    notify: op({ args: [s.object({ title: s.string(), body: s.string().optional(), kind: s.string().optional(), thread: s.ref('Thread').optional() })] }).optional(),
    addProject: op({ args: [s.object({ path: s.string(), name: s.string().optional() })], returns: r.one('Project') }).optional(), // a folder added as a project
  },
  events: {
    launched: ev(),
    quitting: ev(),
    windowOpened: ev(),
    windowClosed: ev(),
  },
  summary: { title: 'version' },
});

export const Theme = defineConcept('Theme', {
  state: {
    mode: s.enum('light', 'dark', 'system'),
    appearance: s.enum('light', 'dark'), // resolved
    accent: s.string(), // a Color
    density: s.enum('compact', 'comfortable').optional(),
    fonts: s.object({ ui: s.string(), code: s.string(), size: s.number() }),
    tokens: s.json(), // name -> value
  },
  relations: {
    app: r.one('App'),
    settings: r.many('Setting'),
  },
  operations: { set: op({ args: [s.string(), s.json()] }) }, // a field and its value
  events: { changed: ev() },
  summary: { title: 'mode', subtitle: 'appearance' },
});

export const Update = defineConcept('Update', {
  state: {
    version: s.string(),
    state: s.enum('available', 'downloading', 'ready', 'installing'),
    notes: s.content().optional(),
  },
  relations: { app: r.one('App') },
  operations: { download: op(), install: op(), later: op() },
  events: { stateChanged: ev() },
  summary: { title: 'version', status: 'state' },
});
