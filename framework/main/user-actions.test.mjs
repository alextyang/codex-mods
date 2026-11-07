// The user's own pins and automations held in framework-main (public-hooks.md §3.5, H6h): the app's shared services' methods are held on
// their class while something holds the operation; what is not the user's (the app's archive pins, the agent's tool, framework-main's own
// calls) goes as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUserActions, own, specOf } = require('./user-actions.cjs');
const { createUserHolds } = require('./user-holds.cjs');

/** The app's two services as classes (one instance each, shared by the windows), recording what ran. */
function services() {
  const ran = [];
  class Pins { async set(req) { ran.push(['set', req]); return { ok: true }; } }
  const items = [{ id: 'a1', kind: 'cron', name: 'Daily', prompt: 'Go', status: 'ACTIVE', rrule: 'FREQ=DAILY', target: { type: 'project', projectId: 'p1' }, model: 'm', reasoningEffort: 'low',
    notificationPolicy: 'all', executionEnvironment: 'local', autoArchive: false }];
  class Automations {
    async list() { return { items }; }
    async create(item) { ran.push(['create', item]); return { item: { id: 'new' } }; }
    async update(item) { ran.push(['update', item]); return {}; }
    async delete(req) { ran.push(['delete', req]); return { success: true }; }
    async runNow(req) { ran.push(['runNow', req]); return { success: true }; }
    async readHistory(req) { return { items: [{ threadId: 'own-1', automationId: 'a1', createdAt: 50 }].filter((r) => !req?.threadId || r.threadId === req.threadId), unreadRunCounts: { total: 0 } }; }
    async archiveRun(req) { ran.push(['archiveRun', req]); return { success: true }; }
    async executeUpdateTool(req) { return this.update(req); }
  }
  return { ran, services: { pinnedThreads: new Pins(), localAutomations: new Automations() } };
}
/** The Host as framework-main's holds see it: it holds `held`, and answers each hold with `decide(msg)` (null: it never answers). */
function host(held, decide = () => ({ go: true })) {
  const asked = [], did = [];
  let holds;
  const send = (msg) => {
    if (msg.type === 'user-hold') { asked.push(msg); const d = decide(msg); if (d) queueMicrotask(() => holds.answer({ requestId: msg.requestId, ...d })); }
    if (msg.type === 'user-did') did.push(msg);
  };
  holds = createUserHolds({ send });
  holds.set({ held, observed: [] });
  return { holds, asked, did, observe(keys) { holds.set({ held, observed: keys }); } };
}

test('an unpin of the user\'s is held while something holds Thread.unpin; refused, it is not done and the pages read the pins again; a pin is only observed', async () => {
  const { ran, services: s } = services();
  let answer = { go: true };
  const h = host(['Thread.pin', 'Thread.unpin'], () => answer);
  const told = [];
  createUserActions({ holds: h.holds, toWindows: (m) => told.push(m) }).hold(s);
  await s.pinnedThreads.set({ threadId: 't1', pinned: false, hostId: 'local', useAppServerPins: true });
  assert.deepEqual(h.asked.map((m) => [m.ref, m.operation, m.args, m.changes]), [[{ type: 'CodexThread', provider: 'codex', id: 't1' }, 'unpin', [], false]]);
  assert.equal(ran.length, 1);
  answer = { go: false, message: 'pins are frozen' };
  assert.equal(await s.pinnedThreads.set({ threadId: 't1', pinned: false, hostId: 'local', useAppServerPins: true }), undefined);
  assert.equal(ran.length, 1, 'refused: the app\'s own did not run');
  assert.deepEqual(told, [{ type: 'pinned-threads-updated' }], 'the pages read the pins again (the row goes back)');
  // a pin: the app's own at once, told to the mods after (undoing the app's pin breaks its page)
  await s.pinnedThreads.set({ threadId: 't1', pinned: true, hostId: 'local', useAppServerPins: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.asked.length, 2);
  assert.equal(ran.length, 2);
  assert.deepEqual(h.did.map((m) => [m.operation, m.outcome.status]), [['pin', 'done']]);
  // the app's archive (no useAppServerPins) and framework-main's own: never held
  await s.pinnedThreads.set({ threadId: 't1', pinned: false });
  await own(s.pinnedThreads, 'set', { threadId: 't2', pinned: false, hostId: 'local', useAppServerPins: true });
  assert.equal(h.asked.length, 2);
  assert.equal(ran.length, 4);
  // a second window's service of the same class is held once
  answer = { go: true };
  createUserActions({ holds: h.holds }).hold(s);
  await s.pinnedThreads.set({ threadId: 't3', pinned: false, hostId: 'local', useAppServerPins: true });
  assert.equal(h.asked.length, 3);
});

test('nothing holds it: the app\'s own at once; a mod observing it is told what it did', async () => {
  const { ran, services: s } = services();
  const h = host([]);
  createUserActions({ holds: h.holds }).hold(s);
  await s.pinnedThreads.set({ threadId: 't1', pinned: false, hostId: 'local', useAppServerPins: true });
  assert.deepEqual([h.asked.length, ran.length, h.did.length], [0, 1, 0]);
  h.observe(['Thread.unpin']);
  await s.pinnedThreads.set({ threadId: 't1', pinned: false, hostId: 'local', useAppServerPins: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.did.map((m) => [m.operation, m.outcome.status]), [['unpin', 'done']]);
});

test('automations: a create is the project\'s, the agent\'s or the chat\'s newAutomation/automate with its spec; a status alone is enable or disable, other fields an edit', async () => {
  const { ran, services: s } = services();
  const h = host(['Project.newAutomation', 'Agent.newAutomation', 'Thread.automate', 'Automation.edit', 'Automation.enable', 'Automation.disable', 'Automation.delete', 'Automation.runNow']);
  createUserActions({ holds: h.holds }).hold(s);
  const svc = s.localAutomations;
  await svc.create({ kind: 'cron', name: 'Nightly', prompt: 'Check', status: 'ACTIVE', rrule: 'FREQ=DAILY', projectId: 'p1', executionEnvironment: 'worktree', model: 'm', reasoningEffort: 'high', autoArchive: true, notificationPolicy: 'failed_runs_only' });
  await svc.create({ kind: 'cron', name: 'Anywhere', prompt: 'Check', status: 'PAUSED', rrule: 'FREQ=HOURLY', projectId: null });
  await svc.create({ kind: 'heartbeat', name: 'Watch', prompt: 'Look', status: 'ACTIVE', rrule: 'FREQ=MINUTELY;INTERVAL=30', targetThreadId: 't9' });
  assert.deepEqual(h.asked.map((m) => [m.ref.type, m.ref.id, m.operation]), [['LocalProject', 'p1', 'newAutomation'], ['CodexAgent', 'codex', 'newAutomation'], ['CodexThread', 't9', 'automate']]);
  assert.deepEqual(h.asked[0].args[0], { name: 'Nightly', prompt: 'Check', schedule: { rrule: 'FREQ=DAILY' }, enabled: true, project: { type: 'LocalProject', provider: 'codex', id: 'p1' },
    settings: { model: 'm', effort: 'high' }, where: 'worktree', archiveRuns: true, notifications: 'failures' });
  assert.equal(h.asked[2].args[0].watches.id, 't9');
  const base = { id: 'a1', kind: 'cron', name: 'Daily', prompt: 'Go', status: 'ACTIVE', rrule: 'FREQ=DAILY', projectId: 'p1', model: 'm', reasoningEffort: 'low', notificationPolicy: 'all', executionEnvironment: 'local', autoArchive: false };
  await svc.update({ ...base, status: 'PAUSED' });
  await svc.update({ ...base, name: 'Daily check', rrule: 'FREQ=WEEKLY' });
  await svc.delete({ id: 'a1' });
  await svc.runNow({ id: 'a1', collaborationMode: null, permissions: null });
  assert.deepEqual(h.asked.slice(3).map((m) => [m.ref.type, m.ref.id, m.operation, m.args]), [
    ['Automation', 'a1', 'disable', []], ['Automation', 'a1', 'edit', [{ name: 'Daily check', schedule: { rrule: 'FREQ=WEEKLY' } }]], ['Automation', 'a1', 'delete', []], ['Automation', 'a1', 'runNow', []]]);
  assert.equal(ran.length, 7);
  // the agent's own tool and framework-main's own calls are not the user's
  await svc.executeUpdateTool({ ...base, name: 'By the agent' });
  await own(svc, 'delete', { id: 'a1' });
  assert.equal(h.asked.length, 7);
  assert.equal(ran.length, 9);
});

test('an automation the mods refuse is not made, and the page says why', async () => {
  const { ran, services: s } = services();
  const h = host(['Agent.newAutomation', 'Automation.runNow'], () => ({ go: false, message: 'no automations at night' }));
  createUserActions({ holds: h.holds }).hold(s);
  await assert.rejects(s.localAutomations.create({ kind: 'cron', name: 'x', prompt: 'p', status: 'ACTIVE', rrule: 'FREQ=DAILY' }), /Not created: no automations at night/);
  await assert.rejects(s.localAutomations.runNow({ id: 'a1' }), /Not started: no automations at night/);
  assert.equal(ran.length, 0);
});

test('specOf is the provider\'s spec of an item (defaults: local, every notification)', () => {
  assert.deepEqual(specOf({ kind: 'cron', name: 'n', prompt: 'p', status: 'ACTIVE', rrule: 'R' }), { name: 'n', prompt: 'p', schedule: { rrule: 'R' }, enabled: true, where: 'local', archiveRuns: false, notifications: 'all' });
});

test('framework-main\'s own call reaches a service whose class keeps private fields through the object it is handed (21477: a stand-in)', async () => {
  class Pins { #count = 0; async set() { this.#count += 1; return { count: this.#count }; } }
  const real = new Pins();
  const handed = new Proxy(real, { get: (t, k) => { const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
  const h = host(['Thread.unpin']);
  createUserActions({ holds: h.holds }).hold({ pinnedThreads: handed });
  assert.deepEqual(await own(handed, 'set', { threadId: 't1', pinned: false, hostId: 'local', useAppServerPins: true }), { count: 1 });
  assert.equal(h.asked.length, 0, 'not held: framework-main\'s own');
  assert.deepEqual(await handed.set({ threadId: 't1', pinned: false, hostId: 'local', useAppServerPins: true }), { count: 2 });
  assert.equal(h.asked.length, 1, 'the user\'s: held');
});

test('review round 1: an update that changes the watched chat or clears a field is an edit that says so; one of the same automation at a time, a stale one refused', async () => {
  const ran = [];
  const items = [{ id: 'h1', kind: 'heartbeat', name: 'Watch', prompt: 'p', status: 'ACTIVE', rrule: 'R', targetThreadId: 't1', notificationPolicy: 'all' },
    { id: 'c1', kind: 'cron', name: 'Daily', prompt: 'p', status: 'ACTIVE', rrule: 'R', target: { type: 'project', projectId: 'p1' }, model: 'm', reasoningEffort: 'low', notificationPolicy: 'all', executionEnvironment: 'local', autoArchive: false }];
  class Automations {
    async list() { return { items: structuredClone(items) }; }
    async create(item) { ran.push(['create', item]); return { item: { id: 'made' } }; }
    async update(item) { ran.push(['update', item.id]); const i = items.findIndex((x) => x.id === item.id); const { projectId, ...rest } = item; items[i] = { ...rest, ...(projectId !== undefined ? { target: projectId ? { type: 'project', projectId } : null } : {}) }; return {}; }
    async delete() { return { success: true }; }
    async runNow() { return { success: true }; }
  }
  const svc = new Automations();
  const h = host(['Automation.edit', 'Automation.disable', 'Agent.newAutomation']);
  createUserActions({ holds: h.holds }).hold({ localAutomations: svc });
  await svc.update({ ...items[0], targetThreadId: 't2' });
  assert.deepEqual(h.asked.at(-1).args, [{ watches: { type: 'CodexThread', provider: 'codex', id: 't2' } }]);
  await svc.update({ id: 'c1', kind: 'cron', name: 'Daily', prompt: 'p', status: 'ACTIVE', rrule: 'R', projectId: null, model: null, reasoningEffort: null, notificationPolicy: 'all', executionEnvironment: 'local', autoArchive: false });
  assert.deepEqual(h.asked.at(-1).args, [{ project: null, settings: { model: null, effort: null } }], 'cleared: said as null');
  assert.deepEqual(ran.map(([, id]) => id), ['h1', 'c1']);
});

test('review round 1: two updates of one automation go one at a time; one whose automation changed while it was held is refused', async () => {
  const items = [{ id: 'a', kind: 'cron', name: 'A', prompt: 'p', status: 'ACTIVE', rrule: 'R', notificationPolicy: 'all', executionEnvironment: 'local', autoArchive: false }];
  const ran = [];
  class Automations {
    async list() { return { items: structuredClone(items) }; }
    async update(item) { ran.push(item); Object.assign(items[0], item); return {}; }
    async create() { return {}; }
  }
  const svc = new Automations();
  const gates = [], asked = [];
  let holds;
  const send = (msg) => { if (msg.type === 'user-hold') { asked.push([msg.operation, msg.args]); gates.push(() => holds.answer({ requestId: msg.requestId, go: true })); } };
  holds = createUserHolds({ send });
  holds.set({ held: ['Automation.edit', 'Automation.disable'], observed: [] });
  createUserActions({ holds }).hold({ localAutomations: svc });
  const pause = svc.update({ ...items[0], status: 'PAUSED' });
  const rename = svc.update({ ...items[0], name: 'A2' });   // decided only after the pause went: against PAUSED
  await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 1, 'the second waits for the first');
  gates.shift()();
  await pause;
  await new Promise((r) => setImmediate(r));
  gates.shift()();
  await rename;
  // the rename, decided after the pause went, shows the mods what it writes back: its status too (`enabled: true`)
  assert.deepEqual(asked, [['disable', []], ['edit', [{ name: 'A2', enabled: true }]]]);
  assert.deepEqual(ran.map((x) => [x.status, x.name]), [['PAUSED', 'A'], ['ACTIVE', 'A2']]);
  // the automation changed elsewhere while one was held: refused, nothing written
  const held = svc.update({ ...items[0], name: 'A3' });
  await new Promise((r) => setImmediate(r));
  items[0].prompt = 'changed elsewhere';
  gates.shift()();
  await assert.rejects(held, /Not changed: it changed while you were asked/);
  assert.equal(ran.length, 2);
});

test('review round 1: a create\'s Automation goes to the mods once made; a mod that made it in the app\'s place answers the app with it', async () => {
  const items = [{ id: 'm1', kind: 'cron', name: 'By the mod', prompt: 'p', status: 'ACTIVE', rrule: 'R' }];
  class Automations { async list() { return { items }; } async create() { return { item: { id: 'made' } }; } }
  const svc = new Automations();
  const done = [];
  let holds, decision = { go: true };
  holds = createUserHolds({ send: (msg) => {
    if (msg.type === 'user-hold') queueMicrotask(() => holds.answer({ requestId: msg.requestId, ...decision }));
    if (msg.type === 'user-hold-done') done.push(msg.outcome);
  } });
  holds.set({ held: ['Agent.newAutomation'], observed: [] });
  createUserActions({ holds }).hold({ localAutomations: svc });
  await svc.create({ kind: 'cron', name: 'n', prompt: 'p', status: 'ACTIVE', rrule: 'R' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(done, [{ status: 'done', value: { type: 'Automation', provider: 'codex', id: 'made' } }]);
  decision = { go: false, handled: true, value: { type: 'Automation', provider: 'codex', id: 'm1' } };
  assert.deepEqual(await svc.create({ kind: 'cron', name: 'n', prompt: 'p', status: 'ACTIVE', rrule: 'R' }), { item: items[0] });
  decision = { go: false, handled: true, value: { type: 'Note', provider: 'mod.x', id: 'n' } };
  await assert.rejects(svc.create({ kind: 'cron', name: 'n', prompt: 'p', status: 'ACTIVE', rrule: 'R' }), /a mod made it its own way/);
  // review round 2: another provider's Automation of the same id is not the app's
  decision = { go: false, handled: true, value: { type: 'Automation', provider: 'mod.x', id: 'm1' } };
  await assert.rejects(svc.create({ kind: 'cron', name: 'n', prompt: 'p', status: 'ACTIVE', rrule: 'R' }), /a mod made it its own way/);
});

test('review round 2: every writer of an automation takes its write lock: nothing lands inside a user\'s checked write, a change before it refuses it, and a mod writing it in the user\'s place does not wait on it', async () => {
  const items = [{ id: 'a', kind: 'heartbeat', name: 'A', prompt: 'p', status: 'ACTIVE', rrule: 'R', targetThreadId: 't', notificationPolicy: 'all' }];
  const ran = [];
  let validate = null;   // the native update's own check before it writes (21477: a heartbeat's chat read)
  class Automations {
    async list() { return { items: structuredClone(items) }; }
    async update(item) { if (validate) await validate; ran.push([item.status, item.name]); Object.assign(items[0], item); return {}; }
    async create() { return {}; }
    async executeUpdateTool(req) { return this.update(req); }
  }
  const svc = new Automations();
  const gates = [];
  let holds;
  holds = createUserHolds({ send: (msg) => { if (msg.type === 'user-hold') gates.push((d = { go: true }) => holds.answer({ requestId: msg.requestId, ...d })); } });
  holds.set({ held: ['Automation.edit'], observed: [] });
  createUserActions({ holds }).hold({ localAutomations: svc });
  const tick = () => new Promise((r) => setImmediate(r));
  // the user's rename goes; while its native call waits on its own check, the agent's pause waits for it
  const rename = svc.update({ ...items[0], name: 'A2' });
  await tick();
  let release;
  validate = new Promise((r) => { release = r; });
  gates.shift()();
  await tick(); await tick();
  const pause = svc.executeUpdateTool({ ...items[0], status: 'PAUSED' });
  await tick();
  assert.deepEqual(ran, [], 'the agent\'s write waits for the user\'s');
  validate = null; release();
  await rename; await pause;
  assert.deepEqual(ran, [['ACTIVE', 'A2'], ['PAUSED', 'A']], 'one after the other, never inside');
  // the agent pauses while the user's edit is being decided: the user's is refused once let go
  const edit = svc.update({ ...items[0], prompt: 'p2' });
  await tick();
  await svc.executeUpdateTool({ ...items[0], status: 'ACTIVE' });
  gates.shift()();
  await assert.rejects(edit, /Not changed: it changed while you were asked/);
  // a mod that writes it in the user's place (framework-main's own call) while the user's is held: not held behind it
  const replaced = svc.update({ ...items[0], name: 'A4' });
  await tick();
  await own(svc, 'update', { ...items[0], name: 'by the mod' });
  gates.shift()({ go: false, handled: true });
  await replaced;
  assert.equal(items[0].name, 'by the mod');
});

test('H7pa: a mod\'s automations are in what the app\'s pages read, never in framework-main\'s own reads or the agent\'s; the user\'s acts on one go to the Host, never to the app\'s service', async () => {
  const { createProvided } = require('./provided-automations.cjs');
  const { ran, services: s } = services();
  const acts = [];
  let answer = { go: false, handled: true };
  let holds;
  // the Host answers an update with the item as its provider made it
  holds = createUserHolds({ send: (msg) => { if (msg.type === 'provided-act') { acts.push(msg); queueMicrotask(() => holds.answer({ requestId: msg.requestId, ...answer,
    ...(msg.operation === 'update' && answer.handled ? { value: { id: msg.item.id, kind: 'cron', name: 'Check in', status: msg.item.status, rrule: 'FREQ=HOURLY' } } : {}) })); } } });
  holds.set({ held: [], observed: [] });
  const provided = createProvided();
  const told = [];
  createUserActions({ holds, provided, toWindows: (m) => told.push(m) }).hold(s);
  const P = 'codexmods-dW5pdC5hZ2VudApBdXRvbWF0aW9uCmNoZWNrLWlu';
  assert.equal(provided.set({ items: [{ id: P, kind: 'cron', name: 'Check in', status: 'ACTIVE', rrule: 'FREQ=HOURLY' }] }), true);
  assert.equal(provided.set({ items: [{ id: P, kind: 'cron', name: 'Check in', status: 'ACTIVE', rrule: 'FREQ=HOURLY' }] }), false, 'the same: unchanged');
  const svc = s.localAutomations;
  assert.deepEqual((await svc.list()).items.map((x) => x.id), ['a1', P], 'the app\'s own first, then the mods\'');
  assert.deepEqual((await svc.readHistory({ limit: 10 })).items.map((x) => x.threadId), ['own-1'], 'the history: the app\'s own runs only (a mod\'s are its chats)');
  assert.deepEqual((await own(svc, 'list')).items.map((x) => x.id), ['a1'], 'framework-main\'s own read: the app\'s only');
  // the user's acts: the Host's, answered as the app's service answers; nothing of the app's ran
  assert.deepEqual(await svc.update({ id: P, status: 'PAUSED' }), { item: { id: P, kind: 'cron', name: 'Check in', status: 'PAUSED', rrule: 'FREQ=HOURLY' } }, 'as its provider made it');
  assert.deepEqual(await svc.runNow({ id: P, collaborationMode: null, permissions: null }), { success: true });
  assert.equal((await svc.delete({ id: P })).success, true);
  assert.deepEqual(acts.map((a) => [a.operation, a.id, a.item?.status ?? null]), [['update', P, 'PAUSED'], ['runNow', P, null], ['delete', P, null]]);
  assert.deepEqual(ran, [], 'never the app\'s own call');
  assert.ok(told.every((m) => m.type === 'automation-runs-updated') && told.length === 3, 'the pages read them again');
  // refused by the Host: thrown, as the app's service fails (the page says it could not)
  answer = { go: false, message: 'the mod is not running' };
  await assert.rejects(svc.runNow({ id: P }), /the mod is not running/);
  // the Host gone: never the app's own call
  const lone = createUserHolds({ send: () => { throw new Error('no Host'); } });
  const s2 = services();
  createUserActions({ holds: lone, provided }).hold(s2.services);
  await assert.rejects(s2.services.localAutomations.delete({ id: P }), /not running/);
  assert.deepEqual(s2.ran, []);
  // the app's own run archived as before
  await svc.archiveRun({ threadId: 'own-1' });
  assert.deepEqual(ran, [['archiveRun', { threadId: 'own-1' }]]);
});

test('H7pa review: only an id the Host said is a mod\'s goes to it (a native one that looks alike is the app\'s); one gone since is refused, never the app\'s; the Host away refuses at once; a timeout aborts it there', async () => {
  const { createProvided } = require('./provided-automations.cjs');
  const { ran, services: s } = services();
  const posted = [];
  let holds;
  holds = createUserHolds({ holdMs: 30, send: (msg) => { posted.push(msg); if (msg.type === 'provided-act' && msg.operation !== 'runNow') queueMicrotask(() => holds.answer({ requestId: msg.requestId, go: false, message: 'no such automation of a mod' })); } });
  holds.set({ held: [], observed: [] });
  const provided = createProvided();
  createUserActions({ holds, provided }).hold(s);
  const svc = s.localAutomations;
  const P = 'codexmods-WyJ1bml0LmFnZW50IiwiQXV0b21hdGlvbiIsImNoZWNrLWluIl0';
  provided.set({ items: [{ id: P, kind: 'cron', name: 'Check in', status: 'ACTIVE', rrule: 'FREQ=HOURLY' }] });
  await svc.delete({ id: 'codexmods-backup' });
  assert.deepEqual(ran, [['delete', { id: 'codexmods-backup' }]], 'the app\'s own automation named like one: the app\'s');
  // its mod removed: not listed, still the Host's to refuse
  provided.set({ items: [] });
  assert.deepEqual((await svc.list()).items.map((x) => x.id), ['a1']);
  await assert.rejects(svc.update({ id: P, status: 'PAUSED' }), /no such automation/);
  assert.equal(ran.length, 1, 'never the app\'s own call');
  // the Host's call not answered in time: refused here, and it is told to abort it
  await assert.rejects(svc.runNow({ id: P }), /did not answer in time; it may have been done all the same/, 'it may have started there (built review H7pa round 2)');
  assert.deepEqual(posted.filter((m) => m.type === 'provided-act-cancel').map((m) => m.requestId), [posted.find((m) => m.operation === 'runNow').requestId]);
  // the Host away: refused at once (nothing sent); back (it says what it holds): sent again
  holds.hostGone();
  const before = posted.length;
  await assert.rejects(svc.delete({ id: P }), /not running/);
  assert.equal(posted.length, before);
  holds.set({ held: [], observed: [] });
  await assert.rejects(svc.delete({ id: P }), /no such automation/);
  assert.equal(posted.length, before + 1);
});

test('H7pa review: the Host away hides them; their ids stay a mod\'s, for the Host to refuse', () => {
  const { createProvided } = require('./provided-automations.cjs');
  const p = createProvided();
  const A = 'codexmods-x';
  p.set({ items: [{ id: A, name: 'Mine' }] });
  assert.equal(p.addToList({ items: [{ id: 'a1' }] }).items.length, 2);
  assert.equal(p.hostDown(), true);
  assert.equal(p.addToList({ items: [{ id: 'a1' }] }).items.length, 1);
  assert.equal(p.isProvided(A), true, 'still a mod\'s id: the Host refuses it');
});

// ---------------------------------------------------------------- H6m2: projects, git, skills and instructions
/** The app's projects, git, skills and instructions services as 21477 shapes them (one instance each), recording what ran. */
function more() {
  const ran = [];
  class Projects {
    getLocalProjects() { return { p1: { id: 'p1', name: 'One', rootPaths: ['/w/one'] }, p2: { id: 'p2', name: 'Nested', rootPaths: ['/w/one/sub'] } }; }
    async renameLocal(req) { ran.push(['renameLocal', req]); }
    async removeLocal(id) { ran.push(['removeLocal', id]); }
  }
  // gitRepository: methods that hand back a disposable handle, over a handlers object (the app's main's, shared)
  class Handle { constructor(fn) { this.result = fn(new AbortController().signal); } wait() { return this.result; } }
  const handlers = {
    push: async (req, source) => { ran.push(['push', req.cwd, source]); return { status: 'success' }; },
    createBranch: async (req) => { ran.push(['createBranch', req.branch]); return { status: 'success' }; },
    checkoutBranch: async (req) => { ran.push(['checkoutBranch', req.branch]); return { status: 'success' }; },
  };
  class Git { constructor(h) { this.handlers = h; } push(e, t) { return new Handle((n) => this.handlers.push(e, t, n)); } createBranch(e, t) { return new Handle((n) => this.handlers.createBranch(e, t, n)); } checkoutBranch(e, t) { return new Handle((n) => this.handlers.checkoutBranch(e, t, n)); } }
  class Skills {
    async install(req) { ran.push(['install', req.skillId]); return { success: true, destination: `/h/skills/${req.skillId}/SKILL.md`, error: null }; }
    async remove(req) { ran.push(['remove', req.skillPath]); return { success: true, deletedPath: req.skillPath, error: null }; }
  }
  class Instructions { async write(req) { ran.push(['write', req.contents]); } }
  class Files { async saveText(req) { ran.push(['saveText', req.path]); return { outcome: 'saved' }; } }
  return { ran, services: { projects: new Projects(), gitRepository: new Git(handlers), recommendedSkills: new Skills(), agentInstructions: new Instructions(), workspaceFiles: new Files() } };
}

test('H6m2: the user\'s project renamed and removed, a push, a new branch and a switch on the project of their folder, a skill installed and removed, and instructions saved pass the mods first; refused, nothing runs and the app is answered as it answers a failure', async () => {
  const { ran, services: s } = more();
  const no = new Set();
  const h = host(['Project.rename', 'Project.remove', 'Repository.push', 'Repository.createBranch', 'Repository.switchBranch', 'Skill.install', 'Skill.delete', 'Instructions.edit'],
    (m) => (no.has(m.operation) ? { go: false, message: `no ${m.operation}` } : { go: true }));
  process.env.CODEX_HOME = '/codex-home';
  createUserActions({ holds: h.holds }).hold(s);
  await s.projects.renameLocal({ projectId: 'p1', name: 'Uno' });
  await s.gitRepository.push({ cwd: '/w/one/sub/x', hostId: 'local', refspec: 'HEAD:refs/heads/topic', setUpstream: true }, 'use_git_push_mutation').wait();
  await s.gitRepository.createBranch({ cwd: '/w/one', branch: 'feature', hostId: 'local' }, 'src').wait();
  await s.gitRepository.checkoutBranch({ cwd: '/w/one', branch: 'main', hostId: 'local' }, 'src').wait();
  await s.recommendedSkills.install({ hostId: 'local', skillId: 'beta', repoPath: 'skills/beta' });
  await s.agentInstructions.write({ hostId: 'local', contents: 'Be brief.' });
  await s.workspaceFiles.saveText({ hostId: 'local', path: '/w/one/AGENTS.md', content: 'Use tabs.', expectedMtimeMs: 1 });
  await s.workspaceFiles.saveText({ hostId: 'local', path: '/w/one/notes.md', content: 'not instructions', expectedMtimeMs: 1 });
  await s.gitRepository.push({ cwd: '/elsewhere', hostId: 'local' }, 'src').wait();
  assert.deepEqual(h.asked.map((m) => [m.ref.type, m.ref.id, m.operation, m.args]), [
    ['LocalProject', 'p1', 'rename', ['Uno']],
    ['GitRepository', 'p2', 'push', [{ type: 'Branch', provider: 'codex', id: 'p2:topic' }]],
    ['GitRepository', 'p1', 'createBranch', ['feature']],
    ['GitRepository', 'p1', 'switchBranch', [{ type: 'Branch', provider: 'codex', id: 'p1:main' }]],
    ['Skill', 'library:beta', 'install', []],
    ['Instructions', '/codex-home/AGENTS.md', 'edit', [{ parts: [{ kind: 'text', text: 'Be brief.' }] }]],
    ['Instructions', '/w/one/AGENTS.md', 'edit', [{ parts: [{ kind: 'text', text: 'Use tabs.' }] }]],
  ], 'the nested project\'s folder names it; a file that is not instructions, and a folder of no project, are not held');
  assert.equal(ran.length, 9, 'let through: each ran');
  // refused: not run, answered as the app answers a failure
  for (const op of ['rename', 'remove', 'push', 'createBranch', 'switchBranch', 'install', 'delete', 'edit']) no.add(op);
  ran.length = 0;
  await assert.rejects(s.projects.renameLocal({ projectId: 'p1', name: 'X' }), /Not renamed: no rename/);
  await assert.rejects(s.projects.removeLocal('p1'), /Not removed: no remove/);
  assert.deepEqual(await s.gitRepository.push({ cwd: '/w/one' }, 'src').wait(), { status: 'error', error: 'Not pushed: no push', execOutput: 'Not pushed: no push' });
  assert.equal((await s.gitRepository.checkoutBranch({ cwd: '/w/one', branch: 'x' }, 'src').wait()).status, 'error');
  assert.deepEqual(await s.recommendedSkills.install({ skillId: 'beta' }), { success: false, destination: null, error: 'Not installed: no install' });
  assert.deepEqual(await s.recommendedSkills.remove({ skillPath: '/h/skills/a/SKILL.md' }), { success: false, deletedPath: null, error: 'Not removed: no delete' });
  await assert.rejects(s.agentInstructions.write({ hostId: 'local', contents: 'x' }), /Not saved/);
  await assert.rejects(s.workspaceFiles.saveText({ hostId: 'local', path: '/w/one/AGENTS.override.md', content: 'x' }), /Not saved/);
  assert.deepEqual(ran, [], 'nothing refused ran');
  // framework-main's own calls (the graph's, which passed the mods already) are never held as the user's
  const asked = h.asked.length;
  await own(s.projects, 'renameLocal', { projectId: 'p1', name: 'Graph' });
  await own(s.gitRepository, 'push', { cwd: '/w/one' }, 'src').wait();
  await own(s.recommendedSkills, 'remove', { skillPath: '/h/skills/a/SKILL.md' });
  await own(s.workspaceFiles, 'saveText', { hostId: 'local', path: '/w/one/AGENTS.md', content: 'graph' });
  assert.equal(h.asked.length, asked);
  assert.equal(ran.length, 4);
  delete process.env.CODEX_HOME;
});

test('H6m2b: a commit the page asks the git worker for passes the mods first, on the project of its folder: refused, the page is answered as the worker answers a failure (with the reason); let go, the worker\'s answer (its Commit) is what the mods hear; one the page cancelled or left while held never goes on', async () => {
  const { services: s } = more();
  let answer = { go: true };
  const h = host(['Repository.commit'], () => answer);
  const done = [];
  const holds = h.holds;
  const origDone = holds.done.bind(holds);
  holds.done = (id, outcome) => { done.push(outcome); return origDone(id, outcome); };
  const ua = createUserActions({ holds });
  const heard = new Set();
  const goners = new Set();
  const page = {
    replies: (channel, fn) => { const x = [channel, fn]; heard.add(x); return () => heard.delete(x); },
    gone: (fn) => { goners.add(fn); return () => goners.delete(fn); },
  };
  const reply = (m) => { for (const x of [...heard]) if (x[1](m) === true) heard.delete(x); };
  const commit = (id, cwd = '/w/one', more = {}) => ({ type: 'worker-request', workerId: 'git', request: { id, method: 'commit', params: { cwd, message: 'Fix it', includeUnstaged: true, ...more } } });
  const servicesOf = () => s;
  // let go: the request goes on, and the worker's answer is heard: the Commit it made
  const m1 = commit('r1');
  assert.equal(await ua.gitRequest(7, m1, page, servicesOf), m1);
  assert.deepEqual(h.asked.map((m) => [m.ref.id, m.operation, m.args]), [['p1', 'commit', ['Fix it']]]);
  assert.deepEqual([...heard].map((x) => x[0]), ['codex_desktop:worker:git:for-view']);
  reply({ type: 'worker-response', workerId: 'git', response: { id: 'other', method: 'commit', result: { type: 'ok', value: { status: 'success' } } } });
  assert.equal(heard.size, 1, 'another request\'s answer');
  reply({ type: 'worker-response', workerId: 'git', response: { id: 'r1', method: 'commit', result: { type: 'ok', value: { status: 'success', commitSha: 'abc123' } } } });
  assert.deepEqual(done.at(-1), { status: 'done', value: { type: 'Commit', provider: 'codex', id: 'p1:abc123' } }, 'built review H6m2b: its Commit');
  assert.deepEqual([heard.size, goners.size], [0, 0], 'nothing more listened for');
  // refused: answered as the worker answers a git failure (the page shows its reason), never delivered
  answer = { go: false, message: 'not on Fridays' };
  assert.deepEqual(await ua.gitRequest(7, commit('r2'), page, servicesOf), { reply: ['codex_desktop:worker:git:for-view',
    { type: 'worker-response', workerId: 'git', response: { id: 'r2', method: 'commit', result: { type: 'ok', value: { status: 'error', error: 'Not committed: not on Fridays', execOutput: 'Not committed: not on Fridays' } } } }] });
  // its cancel is not the worker's: it never had the request (round 2)
  const cancel = (id) => ({ type: 'worker-request-cancel', workerId: 'git', id });
  assert.equal(ua.gitCancel(cancel('r2')), null);
  // cancelled by the page while held: never goes on, and the Host is told (a mod's replacement is not done)
  answer = null;
  const asked = h.asked.length;
  const p = ua.gitRequest(7, commit('r3'), page, servicesOf);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.asked.length, asked + 1);
  assert.equal(ua.gitCancel(cancel('r3')), null, 'held: absorbed');
  assert.equal(await p, null);
  // the page gone while held: the same
  const p2 = ua.gitRequest(7, commit('r3b'), page, servicesOf);
  await new Promise((r) => setImmediate(r));
  for (const fn of [...goners]) fn();
  assert.equal(await p2, null);
  assert.deepEqual([heard.size, goners.size], [0, 0]);
  // let go, then cancelled: no longer listened for, and its record says it may have been done
  answer = { go: true };
  const m6 = commit('r6');
  assert.equal(await ua.gitRequest(7, m6, page, servicesOf), m6);
  assert.equal(heard.size, 1);
  const c6 = cancel('r6');
  assert.equal(ua.gitCancel(c6), c6, 'let go: the worker has it, so its cancel goes on');
  assert.deepEqual([heard.size, goners.size, done.at(-1)], [0, 0, { status: 'uncertain' }]);
  const other = cancel('never-seen');
  assert.equal(ua.gitCancel(other), other, 'one framework-main never held goes on');
  // a mod that committed in the app's place: the page is answered with its commit
  answer = { go: false, handled: true, value: { type: 'Commit', provider: 'codex', id: 'p1:fff000' } };
  assert.deepEqual((await ua.gitRequest(7, commit('r7'), page, servicesOf)).reply[1].response.result, { type: 'ok', value: { status: 'success', commitSha: 'fff000' } });
  // not a commit, a folder of no project, another host's (its config), or framework-main's own: not held
  answer = { go: true };
  const before = h.asked.length;
  const fetchMsg = { type: 'worker-request', workerId: 'git', request: { id: 'r4', method: 'status', params: { cwd: '/w/one' } } };
  assert.equal(await ua.gitRequest(7, fetchMsg, page, servicesOf), fetchMsg);
  const elsewhere = commit('r5', '/elsewhere');
  assert.equal(await ua.gitRequest(7, elsewhere, page, servicesOf), elsewhere);
  const remote = commit('r8', '/w/one', { hostConfig: { id: 'ssh:box', kind: 'ssh' } });
  assert.equal(await ua.gitRequest(7, remote, page, servicesOf), remote);
  const mine = commit('r9', '/w/one', { hostConfig: { id: 'local', kind: 'local' } });
  assert.equal(await ua.gitRequest(7, mine, page, servicesOf), mine);
  assert.equal(h.asked.length, before + 1, 'only the local one');
  assert.deepEqual([heard.size, goners.size], [1, 1]);
});

test('H6m2b: a pull request merged from its panel passes the mods first (the window\'s github service, the pull request by its identity, as the page names it); refused, the page is answered as the service answers a failure; other requests, another host\'s and framework-main\'s own are not held', async () => {
  const ran = [];
  const github = { handleRequest: async (method) => { ran.push(method); return { status: 'success' }; } };
  let answer = { go: true };
  const h = host(['PullRequest.merge'], () => answer);
  createUserActions({ holds: h.holds }).hold({ github });
  // 21477's merge: the identity (no url) spread with the account, the method and the expected head (built review H6m2b)
  const account = { hostId: 'local', login: 'me' };
  const pr = { hostname: 'GitHub.com.', owner: 'Owner', repository: 'Repo', number: 7 };
  assert.deepEqual(await github.handleRequest('gh-pr-merge', { account, pullRequest: pr, expectedHeadRevision: 'abc', mergeMethod: 'squash' }, { source: 'pull_requests_page' }), { status: 'success' });
  assert.deepEqual(h.asked.map((m) => [m.ref.type, m.ref.id, m.operation]), [['GitHubPullRequest', 'https://github.com/Owner/Repo/pull/7', 'merge']]);
  answer = { go: false, message: 'needs review' };
  assert.deepEqual(await github.handleRequest('gh-pr-merge', { account, pullRequest: pr }, 'src'), { status: 'error', error: 'Not merged: needs review' });
  await github.handleRequest('gh-pr-reviews', { account, pullRequest: pr }, 'src');
  await github.handleRequest('gh-pr-merge', { account: { hostId: 'ssh:box' }, pullRequest: pr }, 'src');
  await github.handleRequest('gh-pr-merge', { account, pullRequest: { ...pr, owner: '../x' } }, 'src');
  await own(github, 'handleRequest', 'gh-pr-merge', { account, pullRequest: pr }, 'src');
  assert.equal(h.asked.length, 2);
  assert.deepEqual(ran, ['gh-pr-merge', 'gh-pr-reviews', 'gh-pr-merge', 'gh-pr-merge', 'gh-pr-merge']);
});

test('H6m2a review: a worktree\'s git action is its repository\'s project\'s; another host\'s and the app\'s naming of a project it just made are not held; a disposed handle gives its hold up; what the app answered is what it did; a mod\'s save answers as the app\'s', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path'); const { execFileSync } = await import('node:child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ua-wt-')));
  const repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'a'), 'a'); git('add', 'a'); git('commit', '-qm', 'a'); git('worktree', 'add', '-q', wt);
  const ran = [];
  const handlers = { push: async (req) => { ran.push(['push', req.cwd]); return { status: 'error', execOutput: 'rejected' }; } };
  class Git { constructor(h) { this.handlers = h; } }
  const listed = { p1: { id: 'p1', rootPaths: [repo], createdAt: 0 } };
  class Projects {
    getLocalProjects() { return { ...listed }; }
    async createOrSelectLocalProjects(roots) { await new Promise((r) => setTimeout(r, 20)); listed.fresh = { id: 'fresh', rootPaths: roots, createdAt: Date.now() - 60_000 }; return [listed.fresh]; }
    async renameLocal(req) { ran.push(['rename', req.projectId]); }
  }
  const projects = new Projects();
  let answer = { go: true };
  const h = host(['Repository.push', 'Project.rename', 'Instructions.edit'], () => answer);
  const done = [];
  const origDone = h.holds.done.bind(h.holds);
  h.holds.done = (id, o) => { done.push(o); return origDone(id, o); };
  const services = { gitRepository: new Git(handlers), projects };
  createUserActions({ holds: h.holds }).hold(services);
  // a worktree of the project's repository: the project's, the push naming the worktree's branch (round 2)
  await handlers.push({ cwd: wt, hostId: 'local' }, 'src', new AbortController().signal);
  assert.deepEqual(h.asked.map((m) => [m.ref.id, m.operation, m.args]), [['p1', 'push', [{ type: 'Branch', provider: 'codex', id: 'p1:wt' }]]]);
  await new Promise((r) => setImmediate(r));
  assert.equal(done.at(-1).status, 'failed', 'the worker said no: the record says failed');
  // another host's: not held
  await handlers.push({ cwd: repo, hostId: 'ssh:box' }, 'src');
  assert.equal(h.asked.length, 1);
  // the primary checkout's push names its branch as git says
  await handlers.push({ cwd: repo, hostId: 'local' }, 'src');
  const head = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo }).toString().trim();
  assert.deepEqual(h.asked.at(-1).args, [{ type: 'Branch', provider: 'codex', id: `p1:${head}` }]);
  h.asked.pop();
  // the app's naming of the project it has just made (in the turn its creation answers, however long it took): not the user's rename;
  // a rename after it is the user's, however young the project (round 2)
  const [made] = await services.projects.createOrSelectLocalProjects(['/x']);
  await services.projects.renameLocal({ projectId: made.id, name: 'Named' });
  assert.equal(h.asked.length, 1);
  await new Promise((r) => setImmediate(r));
  await services.projects.renameLocal({ projectId: 'fresh', name: 'Mine' });
  assert.deepEqual(h.asked.slice(1).map((m) => [m.ref.id, m.operation, m.args]), [['fresh', 'rename', ['Mine']]]);
  await services.projects.createOrSelectLocalProjects(['/x']);   // one it had: selected, not made
  await services.projects.renameLocal({ projectId: 'fresh', name: 'Again' });
  assert.equal(h.asked.length, 3);
  // disposed while held: refused here, the Host told, the app's call never made
  let release;
  answer = new Promise((r) => { release = r; });
  const h2 = host(['Repository.push'], () => ({ go: true }));
  const told = [];
  const holds2 = createUserHolds({ send: (m) => { told.push(m.type); } });
  holds2.set({ held: ['Repository.push'], observed: [] });
  const handlers2 = { push: async () => { ran.push(['push2']); return { status: 'success' }; } };
  createUserActions({ holds: holds2 }).hold({ gitRepository: new Git(handlers2), projects });
  const ac = new AbortController();
  const pending = handlers2.push({ cwd: repo, hostId: 'local' }, 'src', ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  const out = await pending;
  assert.equal(out.status, 'error');
  assert.match(out.error, /cancelled/);
  assert.ok(told.includes('user-hold-cancel'));
  assert.equal(ran.filter((r) => r[0] === 'push2').length, 0);
  release?.(); void h2;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('H6m2a review: a mod that saved instructions in the app\'s place answers as the app\'s own save does', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ua-ins-')));
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, 'x');
  class Instructions { async write() { return { path: 'never' }; } }
  class Files { async saveText() { return { outcome: 'saved', mtimeMs: 1 }; } }
  const s = { agentInstructions: new Instructions(), workspaceFiles: new Files() };
  const h = host(['Instructions.edit'], () => ({ go: false, handled: true }));
  process.env.CODEX_HOME = dir;
  createUserActions({ holds: h.holds }).hold(s);
  assert.deepEqual(await s.agentInstructions.write({ hostId: 'local', contents: 'y' }), { path: file });
  const r = await s.workspaceFiles.saveText({ hostId: 'local', path: file, content: 'y' });
  assert.equal(r.outcome, 'saved');
  assert.equal(r.mtimeMs, fs.statSync(file).mtimeMs, 'the file\'s time now: the editor\'s next save is checked against it');
  // the file gone meanwhile (its time not read): never answered as saved (round 2)
  fs.rmSync(file);
  await assert.rejects(s.workspaceFiles.saveText({ hostId: 'local', path: file, content: 'y' }), /Not saved/);
  delete process.env.CODEX_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('H6m3a review: a command run from the floating palette (its window\'s spotlight.runCommand) is the user\'s Command.run, held while something holds it; refused, the palette is answered false', async () => {
  const ran = [];
  class Spotlight { async runCommand(id) { ran.push(id); return true; } }
  const spotlight = new Spotlight();
  let answer = { go: true };
  const h = host(['Command.run'], () => answer);
  createUserActions({ holds: h.holds }).hold({ spotlight });
  assert.equal(await spotlight.runCommand('toggleSidebar'), true);
  assert.deepEqual([h.asked.map((m) => [m.ref, m.operation, m.args]), ran], [[[{ type: 'Command', provider: 'codex', id: 'toggleSidebar' }, 'run', []]], ['toggleSidebar']]);
  answer = { go: false, message: 'not now' };
  assert.equal(await spotlight.runCommand('newTask'), false);
  assert.deepEqual(ran, ['toggleSidebar'], 'refused: not run');
  // nothing holds it: at once
  h.holds.set({ held: [], observed: [] });
  assert.equal(await spotlight.runCommand('newTask'), true);
  assert.equal(h.asked.length, 2);
});

