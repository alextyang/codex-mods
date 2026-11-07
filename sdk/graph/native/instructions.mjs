// Native types, area B of docs/graph/02-types.md: Instructions and Codex's own, CodexInstructions (breadth step D3; graph-boundary.md B3).
// One definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - The core is what any agent's standing instructions have: their text, whether they are on, and the agents that follow them. Where they
//   live and how far they reach is each agent's own: Codex's are AGENTS.md files at three levels (CodexInstructions).
// - `location` is the instructions file's path; with `scope` it is the identity (a provider names an instance by its path).
// - LocalProject.instructions is the inverse of CodexInstructions.project: a provider writes each link once, from the instructions.
// - `agents` (the agents that follow them) is written here; CodexAgent.instructions is not its inverse (a relation of many to many has none in
//   the runtime): a provider writes it from the agent when it does.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

export const Instructions = defineConcept('Instructions', {
  state: {
    text: s.content(),
    enabled: s.boolean(),
  },
  relations: {
    agents: r.many('Agent'),
  },
  operations: {
    edit: op({ args: [s.content()] }),
    enable: op(),
    disable: op(),
    open: op().optional(), // where they are kept
  },
  events: { changed: ev() },
});

export const CodexInstructions = defineSubtype(Instructions, 'CodexInstructions', {
  state: {
    scope: s.enum('global', 'project', 'folder'),
    location: s.string().optional(), // a Path: its AGENTS.md
  },
  relations: {
    project: r.maybe('LocalProject'),
    folder: r.maybe('Folder'),
  },
  summary: { title: 'scope', subtitle: 'location' },
});
