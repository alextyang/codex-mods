// A mod's Automations in the app's Scheduled page (public-hooks.md §3.15, H7pa): what framework-main is told (the app's own items; their
// runs are the mod's chats, not the page's history), and the user's acts on one there as its provider's operations, invoked as the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../graph/index.mjs';
import { toDescriptor } from '../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../sdk/graph/native/index.mjs';
import { createProvidedAutomations, appIdOf, refOfAppId, itemOf, actOfUpdate, PREFIX } from '../provided-automations.mjs';

const until = (fn, ms = 2000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (fn()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('timed out')); setTimeout(tick, 10); }; tick(); });
const AUTO = { type: 'Automation', provider: 'unit.agent', id: 'check-in' };
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });

function setup() {
  const graph = createGraph({});
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const calls = [];
  let slow = null;   // the provider's next disable waits for it
  const state = { name: 'Check in', prompt: text('Say hello'), schedule: { kind: 'interval', every: 60 }, enabled: true, lastRunAt: 5 };
  const agent0 = { type: 'Agent', provider: 'unit.agent', id: 'a' };
  const op = (name) => ({ effect: 'local', handler: async ({ ref, caller, args }) => {
    calls.push([ref.type, ref.id, name, caller.kind, args]);
    if (name === 'disable' && slow) await slow;
    if (ref.type === 'Automation' && (name === 'enable' || name === 'disable' || name === 'edit')) {
      Object.assign(state, name === 'edit' ? { ...args[0], ...(args[0].name ? { name: args[0].name.trim() } : {}) } : { enabled: name === 'enable' });
      p.put(AUTO, { state: { ...state }, links: { agent: agent0, project: null } });
    }
    return name === 'runNow' ? { type: 'Thread', provider: 'unit.agent', id: 'run-2' } : null;
  } });
  const p = graph.registerProvider('mod:unit.agent', 'unit.agent', { types: { Automation: { operations: Object.fromEntries(['runNow', 'enable', 'disable', 'edit', 'delete'].map((n) => [n, op(n)])) }, Thread: { operations: { archive: op('archive') } } } });
  const codex = graph.registerProvider('native', 'codex', { types: { Automation: {} } });
  const agent = { type: 'Agent', provider: 'unit.agent', id: 'a' };
  p.put(AUTO, { state: { ...state }, links: { agent, project: null } });
  codex.put({ type: 'Automation', provider: 'codex', id: 'mine' }, { state: { name: 'Codex own', prompt: text('x'), schedule: { kind: 'once', rrule: 'FREQ=DAILY;COUNT=1' }, enabled: true }, links: { agent: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
  const run = { type: 'Thread', provider: 'unit.agent', id: 'run-1' };
  p.put(run, { state: { title: 'Check in', status: 'idle', unread: true, archived: false, origin: 'automation', createdAt: 100, updatedAt: 100 }, links: { agent, automation: AUTO } });
  const sent = [];
  const pa = createProvidedAutomations({ graph, send: (x) => { sent.push(x); }, debounceMs: 5 });
  return { graph, p, calls, sent, pa, run, slowly: (promise) => { slow = promise; } };
}

test('H7pa: a mod\'s Automation is the app\'s own cron item, its runs none of the app\'s history; Codex\'s own are not', async () => {
  const s = setup();
  await until(() => s.sent.length);
  const told = s.sent.at(-1);
  const { items } = told;
  assert.deepEqual(Object.keys(told), ['items'], 'no history rows: its runs are the mod\'s chats');
  assert.deepEqual(items.map((x) => [x.id, x.kind, x.name, x.prompt, x.status, x.rrule, x.lastRunAt, x.target]), [[appIdOf(AUTO), 'cron', 'Check in', 'Say hello', 'ACTIVE', 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=0', 5, { type: 'projectless' }]]);
  assert.match(items[0].id, /^codexmods-[A-Za-z0-9_-]+$/, 'safe in the app\'s paths');
  assert.deepEqual(refOfAppId(items[0].id), AUTO);
  assert.equal(refOfAppId('d3b07384'), null, 'one of the app\'s own: none of ours');
  // it changes: told again
  s.p.put(AUTO, { state: { name: 'Check in', prompt: text('Say hello'), schedule: { kind: 'interval', every: 60 }, enabled: false }, links: { agent: { type: 'Agent', provider: 'unit.agent', id: 'a' }, project: null } });
  await until(() => s.sent.at(-1).items[0]?.status === 'PAUSED');
  assert.equal(itemOf({ ref: AUTO, state: { name: 'x', schedule: { kind: 'calendar' } } }), null, 'a schedule the app cannot say: not listed');
  s.pa.dispose();
});

test('H7pa: the user\'s acts on one in the page are its provider\'s operations, as the user: pause and resume, an edit, run now, delete', async () => {
  const s = setup();
  await until(() => s.sent.length);
  const id = appIdOf(AUTO);
  const item = s.sent.at(-1).items[0];
  assert.equal((await s.pa.act({ id, operation: 'update', item: { ...item, status: 'PAUSED' } })).status, 'done');
  assert.equal((await s.pa.act({ id, operation: 'update', item: { ...item, name: 'Check in daily', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' } })).status, 'done');
  assert.equal((await s.pa.act({ id, operation: 'runNow' })).status, 'done');
  assert.equal((await s.pa.act({ id, operation: 'delete' })).status, 'done');
  assert.deepEqual(s.calls.map(([t, i, n, by]) => [t, i, n, by]), [['Automation', 'check-in', 'disable', 'user'], ['Automation', 'check-in', 'edit', 'user'], ['Automation', 'check-in', 'runNow', 'user'],
    ['Automation', 'check-in', 'delete', 'user']]);
  assert.deepEqual(s.calls[1][4][0], { name: 'Check in daily', enabled: true, schedule: { kind: 'calendar', days: ['mo'], hours: [9], minutes: [0], rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' } });
  for (const bad of [{ id: `${PREFIX}nope`, operation: 'runNow' }, { id: 'd3b07384', operation: 'delete' }, { id, operation: 'create' }, { operation: 'archiveRun', threadId: 'run-1' }]) {
    assert.equal((await s.pa.act(bad)).status, 'refused', JSON.stringify(bad));
  }
  assert.equal(actOfUpdate({ name: 'a', status: 'ACTIVE' }, { name: 'a', status: 'ACTIVE' }), null, 'nothing it can say changed: nothing asked');
  s.pa.dispose();
});

// ---------------------------------------------------------------- built review H7pa round 1
test('H7pa review: ids name any ref both ways (one too long is not listed); one Automation\'s acts happen one at a time, each against what it is then', async () => {
  for (const id of ['plain', 'with\nnewline', 'x'.repeat(200)]) assert.deepEqual(refOfAppId(appIdOf({ type: 'Automation', provider: 'unit.p', id })), { type: 'Automation', provider: 'unit.p', id });
  assert.equal(itemOf({ ref: { type: 'Automation', provider: 'unit.p', id: 'y'.repeat(500) }, state: { name: 'Long', schedule: { kind: 'interval', every: 60 }, enabled: true } }), null, 'its id too long for the app: not listed');
  const s = setup();
  await until(() => s.sent.length);
  const id = appIdOf(AUTO);
  const item = s.sent.at(-1).items[0];
  let go;
  s.slowly(new Promise((r) => { go = r; }));
  // a pause in one window, a resume in another while the pause is under way: both happen, in turn
  const pause = s.pa.act({ id, operation: 'update', item: { ...item, status: 'PAUSED' } });
  const resume = s.pa.act({ id, operation: 'update', item: { ...item, status: 'ACTIVE' } });
  await new Promise((r) => setTimeout(r, 10));
  go();
  await Promise.all([pause, resume]);
  assert.deepEqual(s.calls.map((c) => c[2]), ['disable', 'enable'], 'the resume, decided after the pause, is not lost');
  s.pa.dispose();
});

test('H7pa review: an edit maps what it can say, refuses what it cannot, and answers the item as its provider made it; a schedule the user wrote is kept as written', async () => {
  const s = setup();
  await until(() => s.sent.length);
  const id = appIdOf(AUTO);
  const item = s.sent.at(-1).items[0];
  const no = await s.pa.act({ id, operation: 'update', item: { ...item, kind: 'heartbeat', targetThreadId: 't9' } });
  assert.deepEqual([no.status, /no kind, targetThreadId/.test(no.message)], ['refused', true], 'never answered as saved');
  // round 2: the app's editor fills in its own model and effort for an item that names none; a save of the name alone is an edit of it
  const named = await s.pa.act({ id, operation: 'update', item: { ...item, name: 'Renamed', model: 'gpt-5.3-codex', reasoningEffort: 'medium' } });
  assert.equal(named.status, 'done');
  assert.deepEqual(s.calls.at(-1)[4][0], { name: 'Renamed' });
  assert.deepEqual([named.value.model, named.value.reasoningEffort], [null, null], 'answered as its provider has it: no model of the app\'s');
  const out = await s.pa.act({ id, operation: 'update', item: { ...item, name: '  Daily  ', rrule: 'FREQ=HOURLY;INTERVAL=2;BYMINUTE=30', autoArchive: true, notificationPolicy: 'failed_runs_only', executionEnvironment: 'worktree' } });
  assert.equal(out.status, 'done');
  assert.deepEqual(s.calls.at(-1)[4][0], { name: '  Daily  ', schedule: { kind: 'interval', every: 120, rrule: 'FREQ=HOURLY;INTERVAL=2;BYMINUTE=30' }, where: 'worktree', notifications: 'failures', archiveRuns: true });
  assert.deepEqual([out.value.name, out.value.rrule], ['Daily', 'FREQ=HOURLY;INTERVAL=2;BYMINUTE=30'], 'its provider\'s own name; the user\'s schedule as written');
  s.pa.dispose();
});
