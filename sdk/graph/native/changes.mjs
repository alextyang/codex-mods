// Native types, area F of docs/graph/02-types.md: ChangeSet, FileChange, Hunk, Comment, Review and Finding, the changes a thread made and
// their review (breadth step D7). One definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs.
// What is particular to these cards:
// - ChangeSet.files, FileChange.hunks and comments, Review.findings and Finding.comments are the inverses of FileChange.changeSet,
//   Hunk.fileChange, Comment.fileChange, Finding.review and Comment.finding. Thread.changes and Turn.changes (threads.mjs) name a thread's
//   and a turn's ChangeSet: a turn's ChangeSet also has the thread, so they are not inverses.
// - Review.target is a ChangeSet, a Branch, a Commit or a PullRequest, and Review.reviewer an Agent or a name: any JSON value (a ref or a
//   string), since the schemas have no union.
// - A line range is `{start, lines}` (Hunk) and a place in a file `{path, line?, endLine?}` (Comment.anchor, Finding.location).
import { defineConcept, ev, op, r, s } from '../define.mjs';

const range = () => s.object({ start: s.number(), lines: s.number() });

export const ChangeSet = defineConcept('ChangeSet', {
  state: {
    fileCount: s.number(), // the card's count of files (renamed: `files` is its relation)
    added: s.number(),
    removed: s.number(),
    state: s.enum('proposed', 'applied', 'reverted', 'mixed'),
  },
  relations: {
    thread: r.one('Thread'),
    turn: r.maybe('Turn'),
    files: r.many('FileChange').inverse('changeSet'),
    environment: r.maybe('Environment'),
  },
  operations: {
    review: op({ returns: r.one('Review') }),
    apply: op().optional(), // proposed changes, for example from the cloud
    revert: op().optional(),
    commit: op({ args: [s.string().optional()], returns: r.one('Commit') }).optional(), // without a message, the agent writes one
    patch: op({ returns: s.string(), content: true }).optional(), // its changes as one unified diff
    openPullRequest: op({ args: [s.string().optional(), s.string().optional()], returns: r.one('PullRequest') }).optional(),
  },
  events: { changed: ev(), applied: ev(), reverted: ev(), committed: ev() },
  summary: { title: 'state' },
});

export const FileChange = defineConcept('FileChange', {
  state: {
    path: s.string(),
    kind: s.enum('added', 'modified', 'deleted', 'renamed'),
    from: s.string().optional(),
    added: s.number(),
    removed: s.number(),
    state: s.enum('proposed', 'applied', 'reverted'),
  },
  relations: {
    changeSet: r.one('ChangeSet'),
    file: r.maybe('File'),
    hunks: r.many('Hunk').inverse('fileChange'),
    comments: r.many('Comment').inverse('fileChange'),
  },
  operations: {
    viewDiff: op(),
    openFile: op(),
    openIn: op({ args: [s.ref('ExternalApp')] }),
    apply: op().optional(),
    revert: op().optional(),
    diff: op({ returns: s.string(), content: true }).optional(), // the file's change as a unified diff
  },
  events: { changed: ev() },
  summary: { title: 'path', subtitle: 'kind' },
});

export const Hunk = defineConcept('Hunk', {
  state: {
    before: range(),
    after: range(),
    state: s.enum('proposed', 'applied', 'reverted'),
  },
  relations: { fileChange: r.one('FileChange') },
  operations: {
    comment: op({ args: [s.content()], returns: r.one('Comment') }),
    apply: op().optional(),
    revert: op().optional(),
  },
  summary: { title: 'state' },
});

export const Comment = defineConcept('Comment', {
  state: {
    content: s.content(),
    author: s.enum('you', 'agent', 'reviewer'),
    anchor: s.object({ path: s.string(), line: s.number().optional(), endLine: s.number().optional() }),
    state: s.enum('draft', 'sent', 'resolved'),
  },
  relations: {
    thread: r.maybe('Thread'),
    fileChange: r.maybe('FileChange'),
    finding: r.maybe('Finding'),
  },
  operations: {
    edit: op({ args: [s.content()] }),
    send: op(), // into the thread's draft, or straight to the agent
    resolve: op(),
    delete: op(),
  },
  events: { sent: ev(), resolved: ev() },
  summary: { title: 'author', subtitle: 'state' },
});

export const Review = defineConcept('Review', {
  state: {
    status: s.enum('running', 'done', 'failed'),
    target: s.json(), // a ref to a ChangeSet, a Branch, a Commit or a PullRequest
    reviewer: s.json(), // a ref to an Agent, or a name
    overview: s.content().optional(), // the card's summary (renamed: every instance has a summary)
  },
  relations: {
    thread: r.maybe('Thread'),
    turn: r.maybe('Turn'),
    findings: r.many('Finding').inverse('review'),
  },
  operations: { stop: op(), rerun: op().optional() },
  events: { started: ev(), findingAdded: ev(), done: ev() },
  summary: { title: 'status' },
});

export const Finding = defineConcept('Finding', {
  state: {
    title: s.string(),
    detail: s.content(),
    severity: s.enum('high', 'medium', 'low'),
    state: s.enum('open', 'fixed', 'dismissed'),
    location: s.object({ path: s.string(), line: s.number() }).optional(),
  },
  relations: {
    review: r.one('Review'),
    comments: r.many('Comment').inverse('finding'),
  },
  operations: {
    open: op(),
    dismiss: op(),
    comment: op({ args: [s.content()], returns: r.one('Comment') }),
    fix: op().optional(), // asks the agent to fix it
  },
  summary: { title: 'title', subtitle: 'severity' },
});
