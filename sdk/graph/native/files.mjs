// Native types, area G of docs/graph/02-types.md: Folder and File (breadth step D3). One definition per card, with the same builders a
// mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these cards:
// - A folder's contents are two relations, `files` and `folders` (the card's `children: File | Folder` before 2026-10-24: a relation has one
//   target type); they are the inverses of File.folder and Folder.parent, so a provider writes each link once, from the child.
// - Folder._expanded is optional (card note): it is a files view's state, known only while one shows the folder.
// - Identity is project + path; a provider names both by the absolute path, which is unique on the machine.
import { defineConcept, ev, op, r, s } from '../define.mjs';

export const Folder = defineConcept('Folder', {
  state: {
    path: s.string(),
    name: s.string(),
    _expanded: s.boolean().optional(),
  },
  relations: {
    project: r.one('Project'),
    parent: r.maybe('Folder'),
    files: r.many('File').inverse('folder'),
    folders: r.many('Folder').inverse('parent'),
  },
  operations: {
    open: op(),
    reveal: op(), // in Finder
    openIn: op({ args: [s.ref('ExternalApp')] }),
    mentionIn: op({ args: [s.ref('Draft')] }),
  },
  summary: { title: 'name', subtitle: 'path' },
});

export const File = defineConcept('File', {
  state: {
    path: s.string(),
    name: s.string(),
    size: s.number(), // in bytes
    modifiedAt: s.time(),
    kind: s.string(), // text, image, binary, ...
  },
  relations: {
    project: r.one('Project'),
    folder: r.one('Folder'),
  },
  operations: {
    open: op(), // a preview
    openIn: op({ args: [s.ref('ExternalApp')] }),
    reveal: op(), // in Finder
    attachTo: op({ args: [s.ref('Draft')] }),
    mentionIn: op({ args: [s.ref('Draft')] }),
  },
  events: {
    changed: ev(),
    deleted: ev(),
  },
  summary: { title: 'name', subtitle: 'path', time: 'modifiedAt' },
});
