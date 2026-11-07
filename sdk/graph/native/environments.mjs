// Native types, area B of docs/graph/02-types.md: Environment and its subtypes LocalEnvironment, WorktreeEnvironment and CloudEnvironment
// (breadth step D3). One definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is
// particular to these cards:
// - Environment.threads is the inverse of Thread.environment; Project.environments is the inverse of Environment.project, which is optional
//   (a cloud environment serves repositories, not one project: card change of 2026-10-24).
// - WorktreeEnvironment.branch is optional: a new Codex worktree starts detached at its base's commit, and the app shows no branch for it
//   (card change of 2026-10-24).
// - CloudEnvironment.location is optional (the newer cloud environments have no address), and manage() opens where the app manages it.
import { defineConcept, defineSubtype, ev, op, r, s } from '../define.mjs';

export const Environment = defineConcept('Environment', {
  state: {
    name: s.string(),
    status: s.enum('ready', 'preparing', 'unavailable'),
    description: s.string().optional(),
  },
  relations: {
    project: r.maybe('Project'),
    threads: r.many('Thread').inverse('environment'),
  },
  events: { statusChanged: ev() },
  summary: { title: 'name', status: 'status' },
});

export const LocalEnvironment = defineSubtype(Environment, 'LocalEnvironment', {
  relations: { folder: r.one('Folder') }, // the project folder itself
});

export const WorktreeEnvironment = defineSubtype(Environment, 'WorktreeEnvironment', {
  state: {
    path: s.string(),
    setup: s.content().optional(), // the commands run when the worktree was created
  },
  relations: {
    branch: r.maybe('Branch'), // none while it is detached
    base: r.one('Branch'),
  },
  operations: { open: op(), mergeBack: op(), remove: op() },
});

export const CloudEnvironment = defineSubtype(Environment, 'CloudEnvironment', {
  state: { location: s.url().optional() },
  operations: { manage: op() }, // opens where the app manages it
});
