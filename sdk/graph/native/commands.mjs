// Native types, area L of docs/graph/02-types.md: Command and its subtypes ProjectAction (breadth step D3) and SlashCommand (the composer's
// commands, D5). One definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is
// particular to these cards:
// - `appliesTo` names a type by its id (a string); `icon` is an Image, a symbol name or an image url (agents.mjs).
// - Project.actions is the inverse of ProjectAction.project: a provider writes each link once, from the action.
// - ProjectAction's run() is Command's run(args?): what the card says of it (in a terminal of the thread or the project) is the provider's.
// - Shortcut (breadth step D6) is a key binding: one per binding of a command, so a command with several has several Shortcuts and
//   Command.shortcut names its first; Shortcut.command and Command.shortcut are both written by a provider (not inverses).
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

export const Command = defineConcept('Command', {
  state: {
    title: s.string(),
    category: s.string(),
    enabled: s.boolean(),
    appliesTo: s.string().optional(), // a type id: for a context menu, the type it acts on
  },
  relations: {
    shortcut: r.maybe('Shortcut'),
  },
  operations: {
    run: op({ args: [s.json().optional()] }),
  },
  events: { ran: ev() },
  summary: { title: 'title', subtitle: 'category' },
});

export const ProjectAction = defineSubtype(Command, 'ProjectAction', {
  state: {
    command: s.string(), // what it runs
    icon: s.string().optional(),
  },
  relations: { project: r.one('Project') },
});

export const SlashCommand = defineSubtype(Command, 'SlashCommand', {
  state: {
    name: s.string(), // typed after "/"
    arguments: s.string().optional(),
    custom: s.boolean(),
    prompt: s.content().optional(), // a saved prompt it inserts
  },
});

export const Shortcut = defineConcept('Shortcut', {
  state: {
    keys: s.string(),
    custom: s.boolean(), // the user set it (not the app's default)
  },
  relations: {
    command: r.one('Command'),
  },
  operations: {
    rebind: op({ args: [s.string()] }).optional(),
    reset: op().optional(),
  },
  events: { changed: ev() },
  summary: { title: 'keys' },
});
