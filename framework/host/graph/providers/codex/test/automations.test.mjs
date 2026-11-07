// Local automations through the real source, graph and mux. The fake app-server owns threads; framework-main's area ops are answered
// here. Its thread/start does not retain threadSource, so run rows associate its threads; fake/notify exercises tagged notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppState } from '../../../app-state.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as automationsArea from '../areas/automations.mjs';
import { produced } from './areas/automations.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.a' }, user = { kind: 'user', id: 'user' };
const cron = () => ({ id: 'daily', kind: 'cron', name: 'Daily', prompt: 'Check the repo', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  projectId: 'p', targetThreadId: null, model: 'fake', reasoningEffort: 'low', nextRunAt: 1_700_086_400_000, lastRunAt: 1_700_000_000_000 });
const watch = (threadId) => ({ id: 'watch', kind: 'heartbeat', name: 'Watch', prompt: 'Keep watch', status: 'PAUSED', rrule: 'FREQ=MINUTELY;INTERVAL=5',
  projectId: null, targetThreadId: threadId, nextRunAt: null, lastRunAt: null });
const turn = (id, status = 'completed', items = []) => ({ id, status, items, error: null });
const heartbeatText = (id = 'watch') => `<heartbeat><automation_id>${id}</automation_id><instructions>Check</instructions></heartbeat>`;
const flush = () => new Promise(setImmediate);

async function setup({ main = true, migrated = false, history = false, beforeStart = () => {} } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-automations-'));
  const prompts = [], events = [], ops = [], warnings = [], answers = new Map();
  let clock = 100_000, sequence = 8000, feed, context, approved = true, runSequence = 0, askWith = null;
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ log, now: () => clock, journalFile: path.join(dir, 'intents.jsonl'), approvals: {
    ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return askWith ? askWith(q) : { approved, reason: 'declined' }; },
  } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const control = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const watched = (await control('thread/start', { cwd: '/r' })).thread.id;
  const runThread = (await control('thread/start', { cwd: '/r', threadSource: 'automation' })).thread.id;
  let items = [cron(), watch(watched)];
  let rows = [{ threadId: runThread, automationId: 'daily', status: 'PENDING_REVIEW', createdAt: 1_700_000_000_000 }];
  const turns = {};
  if (history) for (const [key, threadId, text] of [
    ['first', runThread, 'Automation: Daily'], ['later', runThread, 'Follow up'],
    ['user', watched, 'A normal message'], ['heartbeat', watched, heartbeatText()], ['unknown', watched, heartbeatText('unknown')],
    ['embedded', watched, `A quote: ${heartbeatText()}`],
  ]) turns[key] = (await control('turn/start', { threadId, input: [{ type: 'text', text }] })).turn.id;
  const appProjects = createAppProjects({ log });
  appProjects.apply({ type: 'projects', available: true, reset: true, projects: [{ id: 'p', name: 'Repo', roots: ['/r'] }] });
  const appState = createAppState({ log });
  appState.apply({ type: 'app-state', available: true, reset: true, app: { version: 'test' },
    definitions: [{ key: 'appearanceTheme', default: 'system', schema: { type: 'string' } }], values: {} });
  let mainOps = null;
  const snapshot = () => ({ automations: structuredClone(items), runs: structuredClone(rows), migrated });
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'automations');
    ops.push([m.op, structuredClone(m.args)]);
    queueMicrotask(async () => {
      try {
        let result;
        if (answers.has(m.op)) {
          const answer = answers.get(m.op);
          if (typeof answer === 'function') result = await answer(m.args);
          else { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer }); return; }
        } else if (m.op === 'list') result = snapshot();
        else if (m.op === 'update') {
          items = items.map((item) => item.id === m.args.id ? { ...item, ...m.args.changes } : item);
          result = {};
        } else if (m.op === 'delete') {
          items = items.filter((item) => item.id !== m.args.id);
          rows = rows.filter((row) => row.automationId !== m.args.id);
          result = {};
        } else if (m.op === 'run-now') {
          const thread = (await control('thread/start', { cwd: '/r', threadSource: 'automation' })).thread;
          rows.push({ threadId: thread.id, automationId: m.args.id, status: 'IN_PROGRESS', createdAt: clock });
          items = items.map((item) => item.id === m.args.id ? { ...item, lastRunAt: clock + ++runSequence } : item);
          await control('fake/notify', { method: 'thread/started', params: { thread: { ...thread, threadSource: 'automation' } } });
          result = {};
        } else throw new Error(`unexpected main operation ${m.op}`);
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true, result });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: e.refused === true, error: e.message }); }
    });
  } });
  const area = { ...automationsArea, createFeed(ctx) { context = ctx; feed = automationsArea.createFeed(ctx); return feed; } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, now: () => clock, appState, appProjects, mainOps, areas: { automations: area } });
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'Automation') events.push({ id: e.ref.id, name: e.name, payload: e.payload }); });
  beforeStart();
  await source.start();
  await feed.observe(refs.automation('daily'), 'Automation');
  return {
    setAsk(fn) { askWith = fn; },
    h, graph, feed, context, ops, prompts, events, warnings, answers, control, watched, runThread, turns, snapshot,
    setItems(next) { items = structuredClone(next); }, setRows(next) { rows = structuredClone(next); }, setMigrated(value) { migrated = value; },
    setClock(value) { clock = value; }, approve(value) { approved = value; },
    instance: (id = 'daily') => graph.resolve(refs.automation(id)),
    invoke: (id, operation, args = [], caller = mod) => graph.invoke({ ref: refs.automation(id), operation, args, caller }),
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); appProjects.dispose(); appState.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const lists = (s) => s.ops.filter(([op]) => op === 'list').length;
const mutationOps = (s) => s.ops.filter(([op]) => op !== 'list');

test('scheduleOf preserves RRULE text for once, minute/hour intervals, daily/weekly calendars and unknown rules', () => {
  for (const [rrule, expected] of [
    ['DTSTART:20261025T090000\r\nRRULE:FREQ=DAILY;COUNT=1', { kind: 'once' }],
    ['FREQ=MINUTELY', { kind: 'interval', every: 1 }], ['FREQ=MINUTELY;INTERVAL=5', { kind: 'interval', every: 5 }],
    ['RRULE:FREQ=HOURLY', { kind: 'interval', every: 60 }], ['FREQ=HOURLY;INTERVAL=24', { kind: 'interval', every: 1440 }],
    ['FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30', { kind: 'calendar', days: [], hours: [9, 17], minutes: [0, 30] }],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=15', { kind: 'calendar', days: ['mo', 'we', 'fr'], hours: [9], minutes: [15] }],
    ['FREQ=DAILY', { kind: 'calendar', days: [], hours: [], minutes: [] }], ['FREQ=MONTHLY;BYMONTHDAY=1', { kind: 'calendar' }],
    ['', { kind: 'calendar' }], ['DTSTART:20261025T090000', { kind: 'calendar' }],
  ]) assert.deepEqual(automationsArea.scheduleOf(rrule), { ...expected, rrule });
});

test('automationData and samples keep milliseconds, optional times, content, all link keys and defaults', () => {
  const data = automationsArea.automationData(cron());
  assert.deepEqual(data, { ref: refs.automation('daily'), state: { name: 'Daily', prompt: { parts: [{ kind: 'text', text: 'Check the repo' }] },
    schedule: { kind: 'calendar', days: [], hours: [9], minutes: [0], rrule: cron().rrule }, enabled: true, lastRunAt: 1_700_000_000_000, nextRunAt: 1_700_086_400_000,
    where: 'local', archiveRuns: false, notifications: 'all' },
  links: { agent: refs.agent(), project: refs.project('p'), watches: null } });
  const samples = produced().filter((d) => d.ref.type === 'Automation');
  assert.equal(samples.length, 6);
  assert.ok(samples.every((d) => Object.keys(d.links).sort().join() === ['agent', 'project', 'watches'].join()));
  assert.deepEqual(samples[1].links.watches, refs.thread('watched'));
  assert.equal(samples[1].links.project, null);
  assert.deepEqual(samples[1].state.prompt, { parts: [{ kind: 'text', text: '' }] });
  assert.equal(samples[1].state.lastRunAt, undefined);
  assert.equal(samples[1].state.nextRunAt, undefined);
  assert.equal(samples[2].state.lastRunAt, 0);
  assert.equal(samples[2].state.nextRunAt, 0);
  assert.deepEqual(samples[5].state.schedule, { kind: 'calendar', rrule: '' });
});

test('E7 rework: a mod creates an automation (Agent.newAutomation, Project.newAutomation, Thread.automate) as the user sets one up, asked first; open shows it', async () => {
  const s = await setup();
  try {
    const created = [];
    s.answers.set('create', (args) => {
      created.push(args.item);
      const id = `new-${created.length}`;
      s.setItems([...s.snapshot().automations, { id, ...args.item, projectId: args.item.projectId ?? null, nextRunAt: null, lastRunAt: null }]);
      return { id };
    });
    const agent = refs.agent(), project = refs.project('p');
    const out = await s.graph.invoke({ ref: agent, operation: 'newAutomation', caller: mod,
      args: [{ prompt: 'Summarize the day', schedule: { kind: 'calendar', days: ['mo', 'fr'], hours: [9], minutes: [30] }, settings: { effort: 'high' }, notifications: 'failures' }] });
    assert.equal(out.status, 'done', JSON.stringify(out));
    assert.deepEqual(out.value, refs.automation('new-1'));
    assert.deepEqual(created[0], { kind: 'cron', name: 'Summarize the day', prompt: 'Summarize the day', status: 'ACTIVE', projectId: null, executionEnvironment: 'local',
      model: null, reasoningEffort: 'high', autoArchive: false, notificationPolicy: 'failed_runs_only', rrule: 'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30' });
    assert.equal(s.instance('new-1').state.name, 'Summarize the day');
    assert.match(s.prompts.at(-1).action, /create the automation “Summarize the day”/);
    // the project's: its project fixed, a worktree, created off, every two hours
    const p2 = await s.graph.invoke({ ref: project, operation: 'newAutomation', caller: mod,
      args: [{ name: 'Lint', prompt: { parts: [{ kind: 'text', text: 'Lint it' }] }, schedule: { kind: 'interval', every: 120 }, enabled: false, where: 'worktree', archiveRuns: true }] });
    assert.equal(p2.status, 'done', JSON.stringify(p2));
    assert.deepEqual(created[1], { kind: 'cron', name: 'Lint', prompt: 'Lint it', status: 'PAUSED', projectId: 'p', executionEnvironment: 'worktree', model: null, reasoningEffort: null,
      autoArchive: true, rrule: 'FREQ=HOURLY;INTERVAL=2;BYMINUTE=0' });
    // a chat's own: each run a turn in it
    const t = await s.graph.invoke({ ref: refs.thread(s.watched), operation: 'automate', caller: mod, args: [{ prompt: 'Check in', schedule: { kind: 'interval', every: 15 } }] });
    assert.equal(t.status, 'done', JSON.stringify(t));
    assert.deepEqual(created[2], { kind: 'heartbeat', name: 'Check in', prompt: 'Check in', status: 'ACTIVE', targetThreadId: s.watched, rrule: 'FREQ=MINUTELY;INTERVAL=15' });
    // refused before anything is created
    for (const [ref, op, spec, re] of [
      [agent, 'newAutomation', { prompt: ' ', schedule: { kind: 'interval', every: 5 } }, /prompt/],
      [agent, 'newAutomation', { prompt: 'x', schedule: { kind: 'once' } }, /schedule/],
      [refs.thread(s.watched), 'automate', { prompt: 'x', schedule: { kind: 'interval', every: 5 }, project }, /takes no project/],
      [agent, 'newAutomation', { prompt: 'x', schedule: { kind: 'interval', every: 5 }, where: 'worktree' }, /worktree needs a project/],
    ]) {
      const r = await s.graph.invoke({ ref, operation: op, args: [spec], caller: mod });
      assert.equal(r.status, 'refused', JSON.stringify(spec));
      assert.match(r.message, re);
    }
    assert.equal(created.length, 3);
    // open: where the user manages it (a heartbeat: the chat it watches)
    s.answers.set('open', () => ({}));
    assert.equal((await s.invoke('new-1', 'open')).status, 'done');
    assert.equal((await s.invoke('new-3', 'open')).status, 'done');
    assert.deepEqual(s.ops.filter(([op]) => op === 'open').map(([, a]) => a), [{ id: 'new-1' }, { id: 'new-3', threadId: s.watched }]);
  } finally { await s.close(); }
});

test('H6i (§3.8): a new automation takes the mods\' defaults of what its spec leaves out, where they hold on it; its own choices and a watched chat\'s fields stay', async () => {
  const s = await setup();
  try {
    const created = [];
    s.answers.set('create', (args) => { created.push(args.item); return { id: `d-${created.length}` }; });
    // where holds on the automation to be (its spec's fields; a path through its project needs that project in the graph, readable by the mod)
    s.graph.defaults('mod:mod.d', { id: 'lint', of: 'Automation', where: { prompt: 'Lint' }, values: { where: 'worktree', archiveRuns: true, notifications: 'failures' } });
    s.graph.defaults('mod:mod.d', { id: 'all', of: 'Automation', values: { settings: { effort: 'low' }, enabled: false } });
    const project = refs.project('p');
    await s.graph.invoke({ ref: project, operation: 'newAutomation', caller: mod, args: [{ prompt: 'Lint', schedule: { kind: 'interval', every: 60 }, where: 'local' }] });
    assert.deepEqual([created[0].executionEnvironment, created[0].autoArchive, created[0].notificationPolicy, created[0].reasoningEffort, created[0].status],
      ['local', true, 'failed_runs_only', 'low', 'PAUSED'], 'its own where stays; the rest are the defaults');
    assert.match(s.prompts.at(-1).detail, /starts turned off/i, 'the user is asked about it as it will be');
    await s.graph.invoke({ ref: refs.agent(), operation: 'newAutomation', caller: mod, args: [{ prompt: 'Daily', schedule: { kind: 'interval', every: 60 } }] });
    assert.deepEqual([created[1].executionEnvironment, created[1].autoArchive, created[1].reasoningEffort], ['local', false, 'low'], 'another prompt: the where does not hold');
    await s.graph.invoke({ ref: refs.thread(s.watched), operation: 'automate', caller: mod, args: [{ prompt: 'Check', schedule: { kind: 'interval', every: 15 } }] });
    assert.equal(created[2].kind, 'heartbeat');
    assert.equal(created[2].status, 'PAUSED', 'enabled is a heartbeat\'s too');
    assert.equal(created[2].reasoningEffort, undefined, 'a chat run\'s settings are not');
  } finally { await s.close(); }
});

test('H6i review round 2: the defaults are filled in once, before the policies and the approval, which see them; a where reads the automation\'s own project', async () => {
  const s = await setup();
  try {
    const created = [];
    s.answers.set('create', (args) => { created.push(args.item); return { id: `r-${created.length}` }; });
    const project = refs.project('p');
    // a where through the automation to be's project (resident and readable): it holds; through a project it does not have: unknown
    s.graph.defaults('mod:mod.d', { id: 'repo', of: 'Automation', where: { project: project }, values: { archiveRuns: true } });
    s.graph.defaults('mod:mod.d', { id: 'off', of: 'Automation', where: { project: { $exists: false } }, values: { enabled: false } });
    await s.graph.invoke({ ref: project, operation: 'newAutomation', caller: mod, args: [{ prompt: 'Lint', schedule: { kind: 'interval', every: 60 } }] });
    assert.deepEqual([created[0].autoArchive, created[0].status], [true, 'ACTIVE'], 'its project is the one named; it has a project');
    // a policy refusing what a default supplies refuses the call (the defaults are its arguments)
    const pol = s.graph.policy('mod:mod.p', { id: 'no-off', title: 'No paused ones', on: { type: 'Agent', operation: 'newAutomation' }, args: { 0: { enabled: false } }, then: { refuse: 'Not paused' } });
    const r = await s.graph.invoke({ ref: refs.agent(), operation: 'newAutomation', caller: mod, args: [{ prompt: 'Daily', schedule: { kind: 'interval', every: 60 } }] });
    assert.deepEqual([r.status, created.length], ['refused', 1]);
    assert.match(r.message, /Not paused/);
    pol.dispose();
    // the user approves what they are shown: a default changed while they are asked does not change what is made
    let release;
    const asked = new Promise((r2) => { release = r2; });
    s.setAsk(async () => { await asked; return { approved: true }; });
    const call = s.graph.invoke({ ref: refs.agent(), operation: 'newAutomation', caller: mod, args: [{ prompt: 'Nightly', schedule: { kind: 'interval', every: 60 } }] });
    await new Promise((r2) => setTimeout(r2, 20));
    s.graph.disposeOwner('mod:mod.d');
    release();
    assert.equal((await call).status, 'done');
    assert.equal(created.at(-1).status, 'PAUSED', 'as the user was asked: it starts turned off');
    assert.match(s.prompts.at(-1).detail, /starts turned off/i);
  } finally { await s.close(); }
});

test('first read syncs instances, agent/project/watches and App links; later reads emit changed and each new run started once', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.ops[0], ['list', {}]);
    assert.equal(s.graph.list('Automation').length, 2);
    assert.deepEqual(s.instance().state, automationsArea.automationData(cron()).state);
    assert.deepEqual(s.instance().links, { agent: refs.agent(), project: refs.project('p'), watches: null });
    assert.deepEqual(s.instance('watch').links, { agent: refs.agent(), project: null, watches: refs.thread(s.watched) });
    assert.deepEqual(s.graph.resolve(refs.app()).links.automations, [refs.automation('daily'), refs.automation('watch')]);
    assert.deepEqual(s.graph.related(refs.project('p'), 'automations').map((x) => x.ref), [refs.automation('daily')]);
    assert.deepEqual(s.graph.related(refs.automation('daily'), 'runs').map((x) => x.ref), [refs.thread(s.runThread)]);
    assert.equal(s.graph.resolve(refs.thread(s.watched)).links.automation, undefined, 'a watched thread is not a run');
    assert.deepEqual(s.events, []);
    s.setItems([{ ...cron(), name: 'Renamed' }, watch(s.watched)]);
    const next = (await s.control('thread/start', { cwd: '/r', threadSource: 'automation' })).thread.id;
    s.setRows([...s.snapshot().runs, { threadId: next, automationId: 'daily', status: 'IN_PROGRESS', createdAt: 10 },
      { threadId: s.watched, automationId: 'watch', status: 'IN_PROGRESS', createdAt: 11 }]);
    await s.feed.read();
    await until(() => s.graph.resolve(refs.thread(next))?.links.automation, 3000, 'the new run link');
    assert.deepEqual(s.events.map((e) => [e.id, e.name]), [['daily', 'changed'], ['daily', 'started']]);
    assert.deepEqual(s.events[1].payload, { thread: refs.thread(next) }, 'not due yet (a run asked for): no scheduledAt');
    assert.equal(s.graph.resolve(refs.thread(s.watched)).links.automation, undefined);
    await s.feed.read();
    assert.equal(s.events.length, 2);
    // due when it ran (a schedule missed while the app was closed runs once when it starts again): when it was due
    s.setClock(1_700_086_400_000 + 3_600_000);
    const late = (await s.control('thread/start', { cwd: '/r', threadSource: 'automation' })).thread.id;
    s.setRows([...s.snapshot().runs, { threadId: late, automationId: 'daily', status: 'IN_PROGRESS', createdAt: 12 }]);
    await s.feed.read();
    assert.deepEqual(s.events.at(-1), { id: 'daily', name: 'started', payload: { thread: refs.thread(late), scheduledAt: 1_700_086_400_000 } });
    s.events.length = 2;
    s.setRows([]);
    await s.feed.read();
    assert.deepEqual(s.graph.resolve(refs.thread(s.runThread)).links.automation, refs.automation('daily'), 'remember runs outside the 200-row history window');
    s.setItems([watch(s.watched)]);
    await s.feed.read();
    assert.equal(s.instance().gone, true);
    assert.equal(s.events.length, 2, 'removal has no Automation event');
    assert.deepEqual(s.graph.resolve(refs.app()).links.automations, [refs.automation('watch')]);
    assert.equal(s.graph.resolve(refs.thread(s.runThread)).links.automation, null);
  } finally { await s.close(); }
});

test('run threads and their first turns, and heartbeat turns only, keep automation links after core history reads', async () => {
  const s = await setup({ history: true });
  try {
    await s.context.loadThread(s.runThread);
    await s.context.loadThread(s.watched);
    await until(() => s.graph.resolve(refs.turn(s.turns.first))?.links.automation && s.graph.resolve(refs.turn(s.turns.heartbeat))?.links.automation, 3000, 'turn links');
    assert.deepEqual(s.graph.resolve(refs.turn(s.turns.first)).links.automation, refs.automation('daily'));
    for (const key of ['later', 'user', 'unknown', 'embedded']) assert.equal(s.graph.resolve(refs.turn(s.turns[key])).links.automation ?? null, null, key);
    assert.deepEqual(s.graph.resolve(refs.turn(s.turns.heartbeat)).links.automation, refs.automation('watch'));
    for (const method of ['thread/read', 'thread/resume', 'thread/list', 'thread/turns/list']) {
      await s.control(method, method === 'thread/list' ? { limit: 200 } : { threadId: s.runThread, itemsView: 'full' });
      await until(() => s.graph.resolve(refs.thread(s.runThread)).links.automation, 3000, `${method} preserved the thread link`);
      assert.deepEqual(s.graph.resolve(refs.turn(s.turns.first)).links.automation, refs.automation('daily'));
    }
    s.context.handle.update(refs.turn(s.turns.later), { state: { startedAt: 1 } });
    s.feed.responded('thread/read', {});
    assert.deepEqual(s.graph.resolve(refs.turn(s.turns.later)).links.automation, refs.automation('daily'), 'earliest startedAt, not insertion order');
    assert.equal(s.graph.resolve(refs.turn(s.turns.first)).links.automation, null);
    s.context.handle.update(refs.thread(s.runThread), { links: { automation: null } });
    for (const method of ['thread/start', 'thread/fork']) {
      s.feed.responded(method, {});
      assert.deepEqual(s.graph.resolve(refs.thread(s.runThread)).links.automation, refs.automation('daily'));
      s.context.handle.update(refs.thread(s.runThread), { links: { automation: null } });
    }
    s.feed.responded('unrelated', {});
    assert.equal(s.graph.resolve(refs.thread(s.runThread)).links.automation, null);
    s.feed.responded('thread/read', {});
    const before = s.graph.resolve(refs.thread(s.runThread));
    s.feed.responded('thread/list', {});
    assert.deepEqual(s.graph.resolve(refs.thread(s.runThread)), before, 'matching links cause no graph update');
  } finally { await s.close(); }
});

test('a run\'s own turn (a run chat\'s first, a heartbeat\'s) starts, runs and fails; a later turn in a run\'s chat is not the run', async () => {
  const s = await setup({ history: true });
  try {
    await s.context.loadThread(s.watched);
    await until(() => s.graph.resolve(refs.turn(s.turns.heartbeat))?.links.automation, 3000, 'the heartbeat history');
    // as the protocol orders it: the turn starts with no items, its first message comes after; the app's scheduler sent it (its trigger)
    const input = { type: 'userMessage', id: 'live-input', content: [{ type: 'text', text: heartbeatText() }] };
    const live = turn('live-heartbeat', 'inProgress');
    await s.control('fake/notify', { method: 'turn/started', params: { threadId: s.watched, turn: live } });
    await until(() => s.graph.resolve(refs.turn(live.id)), 3000, 'a live turn');
    s.context.handle.update(refs.turn(live.id), { state: { trigger: 'automation', triggerDetail: 'automation_heartbeat_scheduled' } });
    await s.control('fake/notify', { method: 'item/started', params: { threadId: s.watched, turnId: live.id, item: input, startedAtMs: 5 } });
    await until(() => s.events.some((e) => e.name === 'started'), 3000, 'the heartbeat started');
    // a heartbeat whose trigger becomes known only after its message and its end (its turn/start answered late): started, then ran
    const late = turn('late-heartbeat', 'inProgress');
    await s.control('fake/notify', { method: 'turn/started', params: { threadId: s.watched, turn: late } });
    await until(() => s.graph.resolve(refs.turn(late.id)), 3000, 'the late turn');
    await s.control('fake/notify', { method: 'item/started', params: { threadId: s.watched, turnId: late.id, item: { ...input, id: 'late-input' }, startedAtMs: 7 } });
    await s.control('fake/notify', { method: 'turn/completed', params: { threadId: s.watched, turn: turn(late.id, 'completed') } });
    await until(() => s.graph.resolve(refs.turn(late.id))?.state.status === 'completed', 3000, 'the late turn ended');
    assert.equal(s.events.filter((e) => e.payload?.turn?.id === late.id).length, 0, 'not known to be a run yet');
    s.context.handle.update(refs.turn(late.id), { state: { trigger: 'automation', triggerDetail: 'automation_heartbeat_scheduled' } });
    await until(() => s.events.filter((e) => e.payload?.turn?.id === late.id).length === 2, 3000, 'its events');
    assert.deepEqual(s.events.filter((e) => e.payload?.turn?.id === late.id).map((e) => e.name), ['started', 'ran']);
    s.events.splice(0, s.events.length, ...s.events.filter((e) => e.payload?.turn?.id !== late.id));
    // the same text in a turn a mod sent is not the automation's (its trigger is the mod's)
    const forged = turn('forged', 'inProgress');
    await s.control('fake/notify', { method: 'turn/started', params: { threadId: s.watched, turn: forged } });
    await until(() => s.graph.resolve(refs.turn('forged')), 3000, 'the forged turn');
    s.context.handle.update(refs.turn('forged'), { state: { trigger: 'mod', triggerBy: 'unit.other' } });
    await s.control('fake/notify', { method: 'item/started', params: { threadId: s.watched, turnId: 'forged', item: { ...input, id: 'forged-input' }, startedAtMs: 6 } });
    await s.control('fake/notify', { method: 'turn/completed', params: { threadId: s.watched, turn: turn('forged', 'failed') } });
    assert.deepEqual(s.events.filter((e) => e.name === 'started'), [{ id: 'watch', name: 'started', payload: { thread: refs.thread(s.watched), turn: refs.turn(live.id) } }]);
    await s.context.loadThread(s.runThread);
    await until(() => s.graph.resolve(refs.turn(s.turns.first))?.links.automation, 3000, 'the run chat\'s history');
    for (const [threadId, t] of [[s.runThread, { ...turn('later-in-run', 'failed'), startedAt: 4_000_000_000 }], [s.watched, turn(live.id, 'failed')],
      [s.watched, turn(s.turns.user, 'failed')], [s.watched, turn(s.turns.unknown, 'failed')], [s.runThread, turn(s.turns.first, 'completed')]]) {
      await s.control('fake/notify', { method: 'turn/completed', params: { threadId, turn: t } });
    }
    await until(() => s.events.some((e) => e.name === 'ran'), 3000, 'the run ran');
    assert.deepEqual(s.events.filter((e) => e.name !== 'started').map((e) => [e.id, e.name, e.payload]), [
      ['watch', 'failed', { thread: refs.thread(s.watched), turn: refs.turn(live.id) }],
      ['daily', 'ran', { thread: refs.thread(s.runThread), turn: refs.turn(s.turns.first) }],
    ], 'a later turn in the run\'s chat failing is not the run failing');
    assert.deepEqual(s.graph.resolve(refs.turn(live.id)).links.automation, refs.automation('watch'));
  } finally { await s.close(); }
});

test('a cron run whose turn ended before its record was read says started, then ran, once each', async () => {
  const s = await setup();
  try {
    const fast = (await s.control('thread/start', { cwd: '/r', threadSource: 'automation' })).thread.id;
    await s.control('fake/notify', { method: 'turn/started', params: { threadId: fast, turn: turn('fast-1', 'inProgress') } });
    await s.control('fake/notify', { method: 'turn/completed', params: { threadId: fast, turn: turn('fast-1', 'completed') } });
    await until(() => s.graph.resolve(refs.turn('fast-1'))?.state.status === 'completed', 3000, 'the turn ended');
    assert.deepEqual(s.events.filter((e) => e.name !== 'changed'), [], 'not known to be a run yet');
    s.setRows([...s.snapshot().runs, { threadId: fast, automationId: 'daily', status: 'ACCEPTED', createdAt: 20 }]);
    await s.feed.read();
    assert.deepEqual(s.events.filter((e) => e.name !== 'changed').map((e) => [e.name, e.payload]), [
      ['started', { thread: refs.thread(fast) }], ['ran', { thread: refs.thread(fast), turn: refs.turn('fast-1') }],
    ]);
    await s.feed.read();
    assert.equal(s.events.filter((e) => e.name !== 'changed').length, 2, 'once');
  } finally { await s.close(); }
});

test('all operations use the area channel, re-read, return the new run thread, and ask a mod with the R17 prompts', async () => {
  const s = await setup();
  try {
    const ran = await s.invoke('daily', 'runNow');
    assert.equal(ran.status, 'done', JSON.stringify(ran));
    assert.equal(ran.value.type, 'CodexThread');
    assert.notEqual(ran.value.id, s.runThread);
    assert.deepEqual(s.graph.resolve(ran.value).links.automation, refs.automation('daily'));
    assert.equal((await s.invoke('daily', 'disable')).status, 'done');
    assert.equal(s.instance().state.enabled, false);
    assert.equal((await s.invoke('daily', 'enable')).status, 'done');
    assert.equal(s.instance().state.enabled, true);
    const fields = { name: 'Changed', prompt: { parts: [{ kind: 'text', text: 'One' }, { kind: 'image', source: '/image' }, { kind: 'text', text: ' two' }] }, schedule: { kind: 'interval', rrule: 'FREQ=HOURLY;INTERVAL=2' } };
    assert.equal((await s.invoke('daily', 'edit', [fields])).status, 'done');
    assert.equal(s.instance().state.prompt.parts[0].text, 'One two');
    assert.deepEqual(s.instance().state.schedule, { kind: 'interval', every: 120, rrule: fields.schedule.rrule });
    assert.equal((await s.invoke('daily', 'delete')).status, 'done');
    assert.equal(s.instance().gone, true);
    assert.deepEqual(mutationOps(s), [
      ['run-now', { id: 'daily' }], ['update', { id: 'daily', changes: { status: 'PAUSED' } }], ['update', { id: 'daily', changes: { status: 'ACTIVE' } }],
      ['update', { id: 'daily', changes: { name: 'Changed', prompt: 'One two', rrule: fields.schedule.rrule } }], ['delete', { id: 'daily' }],
    ]);
    assert.equal(lists(s), 6, 'initial sync and one read after each successful operation');
    assert.deepEqual(s.prompts, [
      { action: 'run the automation “Daily” now', detail: 'It starts a chat with its prompt, which counts toward your usage.' },
      { action: 'turn off the automation “Daily”', detail: 'It changes when or how it runs from now on.' },
      { action: 'turn on the automation “Daily”', detail: 'It changes when or how it runs from now on.' },
      { action: 'change the automation “Daily”', detail: 'It changes when or how it runs from now on.' },
      { action: 'delete the automation “Changed”', detail: 'Its definition and its memory are deleted; its chats stay.' },
    ]);
    assert.deepEqual(s.events.map((e) => e.name), ['changed', 'started', 'changed', 'changed', 'changed']);
    assert.ok(s.graph.resolve(ran.value) && !s.graph.resolve(ran.value).gone, 'deleting the definition keeps its chats');
  } finally { await s.close(); }
});

test('no-op and invalid edits, heartbeat runNow and unknown automations make no main call or R17 prompt', async () => {
  const s = await setup();
  try {
    const count = s.ops.length;
    for (const [id, op, args] of [['daily', 'enable', []], ['watch', 'disable', []], ['daily', 'edit', [{}]],
      ['daily', 'edit', [{ name: cron().name, prompt: cron().prompt, schedule: { rrule: cron().rrule } }]]]) {
      assert.equal((await s.invoke(id, op, args)).status, 'done');
    }
    for (const fields of [null, [], 'name', { name: '' }, { name: '  ' }, { name: 1 }, { prompt: 1 }, { prompt: null }, { prompt: { parts: [{ kind: 'text', text: 1 }] } },
      { prompt: {} }, { schedule: {} }, { schedule: { rrule: 1 } }, { schedule: [] }, { model: 'fake' }]) {
      const result = await s.invoke('daily', 'edit', [fields]);
      assert.deepEqual([result.status, result.reason], ['refused', 'invalid'], JSON.stringify(fields));
    }
    const heartbeat = await s.invoke('watch', 'runNow');
    assert.deepEqual([heartbeat.status, heartbeat.reason, heartbeat.message], ['refused', 'unsupported', "a heartbeat runs in the thread it watches, with that chat's mode: run it from the app"]);
    const data = automationsArea.automationData({ ...cron(), id: 'unknown' });
    s.context.handle.put(data.ref, { state: data.state, links: data.links });
    for (const op of ['runNow', 'enable', 'disable', 'edit', 'delete']) {
      const result = await s.invoke('unknown', op, op === 'edit' ? [{ name: 'X' }] : []);
      assert.deepEqual([result.status, result.reason, result.message], ['refused', 'unavailable', 'the automation is gone']);
    }
    assert.deepEqual(s.prompts, []);
    assert.equal(s.ops.length, count);
  } finally { await s.close(); }
});

test('a user caller gets no R17 prompt; denied mod calls do nothing; string prompts are editable', async () => {
  const s = await setup();
  try {
    for (const [op, args] of [['runNow', []], ['disable', []], ['enable', []], ['edit', [{ prompt: 'New text' }]], ['delete', []]]) {
      assert.equal((await s.invoke('daily', op, args, user)).status, 'done');
    }
    assert.deepEqual(s.prompts, []);
    s.approve(false);
    const count = s.ops.length;
    const result = await s.invoke('watch', 'enable');
    assert.deepEqual([result.status, result.reason], ['refused', 'notAllowed']);
    assert.equal(s.ops.length, count);
    assert.equal(s.instance('watch').state.enabled, false);
  } finally { await s.close(); }
});

test('migrated accounts refuse lasting changes, including no-ops, without a prompt; cron runNow still works', async () => {
  const s = await setup({ migrated: true });
  try {
    const count = s.ops.length;
    for (const op of ['enable', 'disable', 'edit', 'delete']) {
      const result = await s.invoke('daily', op, op === 'edit' ? [{ name: 'New' }] : []);
      assert.deepEqual([result.status, result.reason, result.message], ['refused', 'unavailable', "this account's automations are kept online by the app: change them in its Automations page"]);
    }
    assert.equal(s.ops.length, count);
    assert.deepEqual(s.prompts, []);
    assert.equal((await s.invoke('daily', 'runNow', [], user)).status, 'done');
    s.setMigrated(false);
    await s.feed.read();
    assert.equal((await s.invoke('daily', 'disable', [], user)).status, 'done');
  } finally { await s.close(); }
});

test('main refusals are unavailable, service failures throw, and failed reads preserve the last instances and links', async () => {
  const s = await setup();
  try {
    for (const [op, args, mainOp] of [['runNow', [], 'run-now'], ['disable', [], 'update'], ['edit', [{ name: 'New' }], 'update'], ['delete', [], 'delete']]) {
      for (const refused of [true, false]) {
        s.answers.set(mainOp, { ok: false, refused, error: 'main failed' });
        const count = lists(s);
        const result = await s.invoke('daily', op, args, user);
        assert.equal(result.status, refused ? 'refused' : 'failed');
        assert.equal(refused ? result.reason : result.error.message, refused ? 'unavailable' : 'main failed');
        assert.equal(lists(s), count);
      }
      s.answers.delete(mainOp);
    }
    const before = s.graph.list('Automation'), app = s.graph.resolve(refs.app());
    s.setItems([]);
    for (const refused of [true, false]) {
      s.answers.set('list', { ok: false, refused, error: 'cannot list' });
      await s.feed.read();
      assert.deepEqual(s.graph.list('Automation'), before);
      assert.deepEqual(s.graph.resolve(refs.app()), app);
    }
    assert.equal(s.warnings.filter(([m]) => m.startsWith('automations:')).length, 2);
    assert.deepEqual(s.events, []);
    s.answers.delete('list');
    await s.feed.read();
    assert.equal(s.instance().gone, true);
  } finally { await s.close(); }
});

test('without framework-main reads log and preserve instances; operations on a missing definition refuse', async () => {
  const s = await setup({ main: false });
  try {
    assert.equal(s.graph.list('Automation').length, 0);
    // the start's read and the read for the automation it was asked for and does not have: each logged
    assert.equal(s.warnings.filter(([m]) => m.startsWith('automations:')).length, 2);
    assert.deepEqual(await s.feed.runNow(refs.automation('daily')), { status: 'refused', reason: 'unavailable', message: 'the automation is gone' });
  } finally { await s.close(); }
});

test('runNow catches a tagged notification during the service call, ignores older or untagged starts, and times out to null after 15s', async (t) => {
  const s = await setup();
  try {
    assert.equal((await s.invoke('daily', 'runNow', [], user)).value.type, 'CodexThread', 'the service notifies before replying');
    s.answers.set('run-now', () => ({}));
    s.feed.notified('thread/started', { thread: { id: 'old', threadSource: 'automation' } });
    await sleep(550);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const count = lists(s);
    let done = false;
    const pending = s.invoke('daily', 'runNow', [], user).then((r) => { done = true; return r; });
    await flush(); await flush();
    s.feed.notified('thread/started', { thread: { id: 'unrelated', threadSource: 'user' } });
    t.mock.timers.tick(14_999);
    await flush();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.deepEqual([result.status, result.value], ['done', null]);
    assert.equal(lists(s), count + 1);
  } finally { t.mock.timers.reset(); await s.close(); }
});

test('read coalesces overlapping calls once, observe reuses it and refreshes only after 30 seconds, and ready re-reads', async () => {
  const s = await setup();
  let release;
  try {
    let count = lists(s), active = 0, peak = 0, held = false;
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    s.setClock(130_000);
    await s.feed.observe(refs.automation('daily'), 'Automation');
    assert.equal(lists(s), count);
    s.setClock(130_001);
    await s.feed.observe(refs.automation('daily'), 'Automation');
    assert.equal(lists(s), ++count);
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('list', async () => {
      active++; peak = Math.max(peak, active);
      if (!held) { held = true; await gate; }
      active--;
      return s.snapshot();
    });
    const reading = s.feed.read();
    assert.equal(s.feed.observe(refs.automation('daily'), 'Automation'), reading);
    assert.equal(s.feed.read(), reading);
    assert.equal(s.feed.read(), reading);
    release();
    await reading;
    assert.equal(lists(s), count + 2);
    assert.equal(peak, 1);
    s.answers.delete('list');
    count = lists(s);
    s.h.bus.publish('appServer/exited', { reason: 'crash' });
    const result = await s.invoke('daily', 'runNow');
    assert.deepEqual([result.status, result.reason], [s.context.DOWN.status, s.context.DOWN.reason]);
    assert.deepEqual(s.prompts, []);
    s.h.bus.publish('appServer/ready', {});
    await until(() => lists(s) > count, 3000, 'server ready reads');
    await s.feed.observe(refs.automation('daily'), 'Automation');
  } finally { release?.(); await s.close(); }
});

test('automation thread starts debounce a read, other notifications do not; dispose cancels timers and ignores an in-flight result', async () => {
  const s = await setup();
  let release;
  try {
    let count = lists(s);
    const thread = (await s.control('thread/read', { threadId: s.runThread })).thread;
    for (let i = 0; i < 3; i++) await s.control('fake/notify', { method: 'thread/started', params: { thread: { ...thread, threadSource: 'automation' } } });
    await sleep(100);
    assert.equal(lists(s), count);
    await until(() => lists(s) > count, 3000, 'the debounced read');
    await s.feed.observe(refs.automation('daily'), 'Automation');
    assert.equal(lists(s), count + 1);
    count = lists(s);
    s.feed.notified('other', {});
    s.feed.notified('thread/started', { thread: { id: 'ordinary' } });
    await sleep(550);
    assert.equal(lists(s), count);
    const before = s.graph.list('Automation');
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('list', async () => { await gate; return { automations: [], runs: [], migrated: false }; });
    s.feed.notified('thread/started', { thread: { id: 'cancelled', threadSource: 'automation' } });
    const reading = s.feed.read();
    s.feed.dispose();
    release();
    await reading;
    await sleep(550);
    assert.equal(lists(s), count + 1);
    assert.deepEqual(s.graph.list('Automation'), before);
    await s.feed.serverUp();
    assert.equal(lists(s), count + 1);
  } finally { release?.(); await s.close(); }
});

test('start installs one minute polling timer and disposal clears it', async (t) => {
  const s = await setup({ beforeStart() { t.mock.timers.enable({ apis: ['setInterval'] }); } });
  try {
    const count = lists(s);
    t.mock.timers.tick(59_999);
    await flush();
    assert.equal(lists(s), count);
    t.mock.timers.tick(1);
    await s.feed.observe(refs.automation('daily'), 'Automation');
    assert.equal(lists(s), count + 1);
    s.feed.dispose();
    t.mock.timers.tick(120_000);
    await flush();
    assert.equal(lists(s), count + 1);
  } finally { t.mock.timers.reset(); await s.close(); }
});
