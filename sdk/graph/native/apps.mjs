// Native types, area G of docs/graph/02-types.md: ExternalApp (breadth step D3). One definition per card, with the same builders a mod uses
// (define.mjs). Conventions are in threads.mjs. What is particular to this card:
// - `opens` is a list of the kinds of target it opens; `open(target)` takes a Project, File or Folder ref or a url: the schemas have no
//   union, so the argument is any JSON value and the provider checks it.
// - `setComputerUse(level)` changes a lasting permission: a provider asks the user before a mod's call (runtime-core.md R17).
// - Identity is the app's bundle; a provider names an app by its bundle id where it knows it (see the provider for the rest).
import { defineConcept, ev, op, r, s } from '../define.mjs';

export const ExternalApp = defineConcept('ExternalApp', {
  state: {
    name: s.string(),
    icon: s.string(), // an Image: a symbol name or an image url
    opens: s.list(s.enum('project', 'file', 'folder', 'url')),
    computerUse: s.enum('always', 'ask', 'never', 'unsupported'),
  },
  relations: {
    sessions: r.many('ComputerUseSession').inverse('app'),
  },
  operations: {
    open: op({ args: [s.json()] }), // a Project, File or Folder ref, or a url
    setComputerUse: op({ args: [s.enum('always', 'ask', 'never', 'unsupported')] }),
  },
  events: { changed: ev() },
  summary: { title: 'name', icon: 'icon' },
});
