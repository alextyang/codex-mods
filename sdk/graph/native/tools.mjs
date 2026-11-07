// Native types, area G of docs/graph/02-types.md: Terminal, BrowserTab and ComputerUseSession, the tools you share with the agent (breadth
// step D8). One definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to
// these cards:
// - Terminal.commandRuns, BrowserTab.webLookups and ComputerUseSession.actions are the inverses of CommandRun.terminal, WebLookup.tab and
//   ComputerAction.session (steps.mjs); Project.terminals, Thread.terminals and browserTabs, and ExternalApp.sessions are the inverses of
//   Terminal.project and thread, BrowserTab.thread and ComputerUseSession.app.
// - ComputerUseSession's `app?: ExternalApp` is on the card's state line; ExternalApp is a concept, so it is a relation.
import { defineConcept, ev, op, r, s } from '../define.mjs';

export const Terminal = defineConcept('Terminal', {
  state: {
    title: s.string(),
    directory: s.string(),
    running: s.boolean(),
    startedBy: s.enum('you', 'agent'),
    shell: s.string(),
  },
  relations: {
    project: r.maybe('Project'), // none for a terminal opened outside every project
    thread: r.maybe('Thread'),
    commandRuns: r.many('CommandRun').inverse('terminal'),
  },
  operations: {
    run: op({ args: [s.string()] }),
    write: op({ args: [s.string()] }),
    clear: op(),
    stop: op(),
    close: op(),
    focus: op(),
    // its last `lines` lines of output (default 100, at most 1000), as text: terminal output is content (a grant must name `tail`)
    tail: op({ args: [s.number().optional()], returns: s.string(), content: true }).optional(),
  },
  events: { output: ev(), exited: ev(), closed: ev() },
  summary: { title: 'title', subtitle: 'directory' },
});

export const BrowserTab = defineConcept('BrowserTab', {
  state: {
    url: s.url(),
    title: s.string(),
    loading: s.boolean(),
    canGoBack: s.boolean(),
    canGoForward: s.boolean(),
    controlledBy: s.enum('you', 'agent'),
  },
  relations: {
    thread: r.maybe('Thread'),
    webLookups: r.many('WebLookup').inverse('tab'),
  },
  operations: {
    navigate: op({ args: [s.url()] }),
    reload: op(),
    back: op(),
    forward: op(),
    close: op(),
    openExternally: op(),
  },
  events: { navigated: ev(), loaded: ev(), closed: ev() },
  summary: { title: 'title', subtitle: 'url' },
});

export const ComputerUseSession = defineConcept('ComputerUseSession', {
  state: {
    status: s.enum('running', 'paused', 'stopped'),
  },
  relations: {
    app: r.maybe('ExternalApp'), // the app in use
    thread: r.one('Thread'),
    actions: r.many('ComputerAction').inverse('session'),
  },
  operations: { pause: op(), resume: op(), stop: op() },
  events: { started: ev(), actionTaken: ev(), stopped: ev() },
  summary: { title: 'status' },
});
