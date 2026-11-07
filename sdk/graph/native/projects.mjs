// Native types, area B of docs/graph/02-types.md: Project and LocalProject (breadth step D3). One definition per card, with the same
// builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - `location: Path | Url` is a string: a local project's is its folder's path, a mod's workspace may give a url.
// - `lastOpenedAt` is optional (card note): the app records no time a project was opened.
// - Project.threads is the inverse of Thread.project: a provider writes each link once, from the thread.
// - Project.environments, Project.actions and Project.settings are the inverses of Environment.project, ProjectAction.project and
//   Setting.project; LocalProject.instructions is the inverse of CodexInstructions.project (where Codex keeps its AGENTS.md files is its own:
//   graph-boundary.md B3).
// - automations and terminals are the inverses of Automation.project (attention.mjs) and Terminal.project (tools.mjs).
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';
import { AutomationSpec } from './attention.mjs';

export const Project = defineConcept('Project', {
  state: {
    name: s.string(),
    location: s.string(), // a Path or a Url
    lastOpenedAt: s.time().optional(),
  },
  relations: {
    threads: r.many('Thread').inverse('project'),
    root: r.maybe('Folder'),
    repository: r.maybe('Repository'),
    draft: r.maybe('Draft'),   // the new chat's Draft in this project: on 21477 the same Draft for every project (an alias; graph-layers.md §3.2)
    environments: r.many('Environment').inverse('project'),
    actions: r.many('ProjectAction').inverse('project'),
    automations: r.many('Automation').inverse('project'),
    terminals: r.many('Terminal').inverse('project'),
    settings: r.many('Setting').inverse('project'), // the project's defaults
  },
  operations: {
    open: op(),
    rename: op({ args: [s.string()] }),
    remove: op(), // from the app; its files are untouched
    newThread: op({ args: [s.json().optional()], returns: s.json() }),   // a Draft, or a chat's spec (Agent.newThread's)
    newAutomation: op({ args: [AutomationSpec], returns: r.one('Automation') }).optional(), // each run a new chat in this project
    openIn: op({ args: [s.ref('ExternalApp')] }),
    // a terminal in its folder, or a folder in it (`path`), its tab beside a chat (`thread`, else the one the window shows)
    newTerminal: op({ args: [s.json().optional()], returns: r.one('Terminal') }).optional(),
    // its files and folders whose names match the query, best first ({limit?}: 50, at most 200): File and Folder refs
    findFiles: op({ args: [s.string(), s.json().optional()], returns: s.list(s.json()), content: true }).optional(),
  },
  events: {
    added: ev(),
    opened: ev(),
    renamed: ev(),
    removed: ev(),
  },
  summary: { title: 'name', subtitle: 'location' },
});

export const LocalProject = defineSubtype(Project, 'LocalProject', {
  relations: {
    folder: r.one('Folder'), // the folder on this Mac
    instructions: r.many('CodexInstructions').inverse('project'), // its AGENTS.md files: the project's and its folders'
  },
  operations: {
    reveal: op(), // in Finder
    // its instructions file (AGENTS.md in its folder) made with this text, where it has none (else Instructions.edit)
    addInstructions: op({ args: [s.content()], returns: r.one('CodexInstructions') }).optional(),
  },
});
