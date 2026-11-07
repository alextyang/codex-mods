// Native types, areas D (Automation) and J (Notification) of docs/graph/02-types.md: what runs on its own and what tells you (breadth step
// D9). One definition per card, with the same builders a mod uses (define.mjs). Conventions are in threads.mjs. What is particular to these
// cards:
// - Automation.schedule is `{kind: once | interval | calendar, ...}`: an object whose other fields depend on the kind, so any JSON value
//   with a `kind`. edit(fields) takes the fields to change (any JSON value).
// - Automation.runs is the inverse of Thread.automation; Project.automations of Automation.project. App.automations (app.mjs) is every
//   automation: a provider writes it.
// - Notification.source is a ref to its source (a Thread, Request, Usage, Update, Automation, ...): any JSON value, since the schemas have
//   no union.
import { defineConcept, ev, op, r, s } from '../define.mjs';

/**
 * What a new automation is, as the user sets it up (E7 usefulness rework: the graph creates automations): its prompt and schedule, and
 * optionally its name, whether it starts on, its project (each run a new chat there) or the chat it watches (each run a turn in it), the
 * settings of its runs ({model?, effort?}), where it runs (local or a worktree), its notifications (all or failed runs only) and whether
 * successful runs are archived. The schedule is one of Automation.schedule's kinds, or {rrule} verbatim.
 */
export const AutomationSpec = s.object({
  name: s.string().optional(),
  prompt: s.json(), // text or Content
  schedule: s.json(),
  enabled: s.boolean().optional(),
  project: s.ref('Project').optional(),
  watches: s.ref('Thread').optional(),
  settings: s.json().optional(),
  where: s.enum('local', 'worktree').optional(),
  notifications: s.enum('all', 'failures').optional(),
  archiveRuns: s.boolean().optional(),
});

export const Automation = defineConcept('Automation', {
  state: {
    name: s.string(),
    prompt: s.content(),
    schedule: s.json(), // {kind: once | interval | calendar, ...}
    enabled: s.boolean(),
    lastRunAt: s.time().optional(),
    nextRunAt: s.time().optional(),
    where: s.enum('local', 'worktree').optional(), // a run's checkout: the project's folder or a worktree of it
    notifications: s.enum('all', 'failures').optional(), // which runs notify
    archiveRuns: s.boolean().optional(), // successful runs' chats are archived
  },
  relations: {
    agent: r.one('Agent'),
    project: r.maybe('Project'),
    settings: r.many('Setting'), // thread settings for its runs
    runs: r.many('Thread').inverse('automation'),
    watches: r.maybe('Thread'), // when set, each run is a turn in that thread
  },
  operations: {
    runNow: op({ returns: r.one('Thread') }),
    enable: op(),
    disable: op(),
    edit: op({ args: [s.json()] }),
    delete: op(),
    open: op({ args: [s.json().optional()] }).optional(), // show it where the user manages it; `{window}`: in that window
  },
  // a run's lifecycle: started (its chat, and its turn when it is a turn of the chat it watches; `scheduledAt` when it was due: a schedule
  // missed while the app was closed runs once when it starts again, late), then ran (its turn completed) or failed
  events: {
    started: ev(s.object({ thread: s.ref('Thread'), turn: s.ref('Turn').optional(), scheduledAt: s.time().optional() })),
    ran: ev(s.object({ thread: s.ref('Thread'), turn: s.ref('Turn') })),
    failed: ev(s.object({ thread: s.ref('Thread'), turn: s.ref('Turn') })),
    changed: ev(),
  },
  summary: { title: 'name' },
});

export const Notification = defineConcept('Notification', {
  state: {
    title: s.string(),
    body: s.string(),
    kind: s.enum('finished', 'failed', 'approval', 'question', 'limit', 'update', 'other'),
    createdAt: s.time(),
    read: s.boolean(), // opened or dismissed
    source: s.json().optional(), // a ref to what it is about
  },
  operations: { open: op(), dismiss: op() },
  events: { shown: ev(), opened: ev(), dismissed: ev() },
  summary: { title: 'title', subtitle: 'body' },
});
