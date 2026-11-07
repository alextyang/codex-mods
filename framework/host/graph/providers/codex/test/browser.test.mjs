// Browser tabs through the source, graph, real mux and fake app-server; main operations and reports stand in for the app's windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as browser from '../areas/browser.mjs';
import { produced } from './areas/browser.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.a' }, user = { kind: 'user', id: 'user', owner: 'app' };
const detail = 'The in-app browser loads it with its own sign-ins and cookies.';
const tab = (conversationId, browserTabId, fields = {}) => ({ conversationId, browserTabId, url: 'https://example.com/', title: 'Example',
  loading: true, canGoBack: true, canGoForward: true, agent: false, ...fields });

async function setup({ main = true, initialAnswers = [] } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-browser-'));
  const ops = [], prompts = [], events = [], changes = [], warnings = [], answers = new Map(initialAnswers);
  let clock = 100_000, approved = true, feed, context, tabs = [];
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), now: () => clock, log,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let mainOps;
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'browser');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        let answer;
        if (answers.has(m.op)) {
          const value = answers.get(m.op);
          answer = typeof value === 'function' ? await value(m.args) : value;
        } else if (m.op === 'tabs') answer = { ok: true, result: { tabs: structuredClone(tabs) } };
        else {
          if (m.op === 'close') tabs = tabs.filter((t) => t.conversationId !== m.args.conversationId || t.browserTabId !== m.args.browserTabId);
          else if (m.op === 'command') {
            const t = tabs.find((t) => t.conversationId === m.args.conversationId && t.browserTabId === m.args.browserTabId);
            if (m.args.command.type === 'navigate') { t.url = m.args.command.url; t.loading = true; }
            if (m.args.command.type === 'reload') t.loading = true;
          } else assert.equal(m.op, 'open-external');
          answer = { ok: true, result: {} };
        }
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: e.refused === true, error: e.message }); }
    });
  } });
  const area = { ...browser, createFeed(ctx) { context = ctx; feed = browser.createFeed(ctx); return feed; } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, now: () => clock, mainOps, areas: { browser: area } });
  graph.onEvent((e) => {
    if (e.ref?.type !== 'BrowserTab') return;
    if (e.kind === 'event') events.push({ ref: e.ref, name: e.name, gone: graph.resolve(e.ref)?.gone === true });
    else changes.push(e);
  });
  const threadId = (await h.app.request(1, 'thread/start', { cwd: '/repo' })).result.thread.id;
  await until(() => graph.resolve(refs.thread(threadId)), 3000, 'the browser tab thread');
  tabs = [tab(threadId, 'you'), tab('new-chat', 'unattached', { title: '', loading: false, canGoBack: false, canGoForward: false }), tab(threadId, 'agent', { agent: true })];
  await source.start();
  await feed.observe(refs.browserTab(threadId, 'you'), 'BrowserTab');
  return {
    graph, source, feed, context, mainOps, ops, prompts, events, changes, warnings, answers, threadId,
    ref: (id = 'you', conversationId = threadId) => refs.browserTab(conversationId, id),
    invoke: (ref, operation, args = [], caller = mod) => graph.invoke({ ref, operation, args, caller }),
    report: (report = { event: 'invalidated' }) => mainOps?.report({ type: 'area-report', area: 'browser', report }),
    tabs: () => structuredClone(tabs),
    setTabs(next) { tabs = structuredClone(next); },
    clock(value) { clock = value; },
    approve(value) { approved = value; },
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const reads = (s) => s.ops.filter(([op]) => op === 'tabs').length;
const state = (s, ref = s.ref()) => s.graph.resolve(ref)?.state;

test('tab data and samples include every state field and the thread link, including a tab outside a resident thread', () => {
  const samples = produced();
  assert.deepEqual(samples[0], { ref: refs.browserTab('t', 'one'), state: { url: 'https://example.com/', title: 'Example', loading: false,
    canGoBack: true, canGoForward: false, controlledBy: 'you' }, links: { thread: refs.thread('t') } });
  assert.deepEqual(samples[1].links, { thread: null });
  assert.equal(samples[1].state.controlledBy, 'agent');
});

test('the first read syncs tabs and their inverse Thread.browserTabs; an unchanged read puts nothing again', async () => {
  const s = await setup();
  try {
    assert.equal(s.graph.list('BrowserTab').length, 3);
    assert.deepEqual(state(s), { url: 'https://example.com/', title: 'Example', loading: true, canGoBack: true, canGoForward: true, controlledBy: 'you' });
    assert.equal(state(s, s.ref('agent')).controlledBy, 'agent');
    assert.deepEqual(s.graph.resolve(s.ref()).links, { thread: refs.thread(s.threadId) });
    assert.deepEqual(s.graph.resolve(s.ref('unattached', 'new-chat')).links, { thread: null });
    assert.deepEqual(s.graph.related(refs.thread(s.threadId), 'browserTabs').map((t) => t.ref.id).sort(), [s.ref().id, s.ref('agent').id].sort());
    assert.deepEqual(s.graph.related(s.ref(), 'webLookups'), []);
    assert.deepEqual(s.events, []);
    s.changes.length = 0;
    await s.feed.read();
    assert.deepEqual(s.changes, []);
    const known = s.tabs();
    s.setTabs(known.map((t) => t.browserTabId === 'unattached' ? { ...t, conversationId: s.threadId } : t));
    await s.feed.read();
    assert.deepEqual(s.graph.resolve(s.ref('unattached')).links, { thread: refs.thread(s.threadId) });
  } finally { await s.close(); }
});

test('later reads emit navigated and loaded on transitions, and closed after removal; title changes and new tabs just sync', async () => {
  const s = await setup();
  try {
    s.setTabs(s.tabs().map((t) => t.browserTabId === 'you' ? { ...t, title: 'Next', url: 'https://next.example/', loading: false } : t));
    await s.feed.read();
    assert.deepEqual(s.events, [{ ref: s.ref(), name: 'navigated', gone: false }, { ref: s.ref(), name: 'loaded', gone: false }]);
    assert.equal(state(s).title, 'Next');
    await s.feed.read();
    s.setTabs(s.tabs().map((t) => t.browserTabId === 'you' ? { ...t, title: 'Retitled', loading: true } : t));
    await s.feed.read();
    assert.equal(s.events.length, 2, 'neither a title change nor starting a load is a named event');
    s.setTabs([...s.tabs().filter((t) => t.browserTabId !== 'you'), tab(s.threadId, 'new', { loading: false })]);
    await s.feed.read();
    assert.deepEqual(s.events.at(-1), { ref: s.ref(), name: 'closed', gone: true });
    assert.equal(s.graph.resolve(s.ref()).gone, true);
    assert.equal(s.events.length, 3, 'a newly discovered tab has no earlier URL or loading transition');
  } finally { await s.close(); }
});

test('every operation sends its exact main op and arguments, then reads; close observes closed and only navigate has an external intent', async () => {
  const s = await setup();
  try {
    s.ops.length = 0;
    const operations = [
      ['navigate', ['https://next.example/'], 'command', { command: { type: 'navigate', url: 'https://next.example/' } }],
      ['reload', [], 'command', { command: { type: 'reload' } }],
      ['back', [], 'command', { command: { type: 'go-back' } }],
      ['forward', [], 'command', { command: { type: 'go-forward' } }],
      ['openExternally', [], 'open-external', { url: 'https://next.example/' }],
      ['close', [], 'close', {}],
    ];
    for (const [operation, args, op, extra] of operations) {
      const out = await s.invoke(s.ref(), operation, args);
      assert.equal(out.status, 'done', JSON.stringify(out));
      assert.equal(out.value, null);
      if (operation === 'navigate') assert.ok(out.intent, 'navigation is external');
      else assert.equal(out.intent, undefined, `${operation} is local`);
      assert.deepEqual(s.ops.slice(-2), [[op, op === 'open-external' ? extra : { conversationId: s.threadId, browserTabId: 'you', ...extra }], ['tabs', {}]]);
    }
    assert.equal(s.graph.resolve(s.ref()).gone, true);
    assert.deepEqual(s.events.map((e) => e.name), ['navigated', 'closed']);
    assert.deepEqual(s.prompts, [{ action: 'open https://next.example/ in the browser tab “Example”', detail }]);
  } finally { await s.close(); }
});

test('invalid navigation, an agent tab and unavailable history refuse without calling main or asking the user', async () => {
  const s = await setup();
  try {
    s.ops.length = 0;
    for (const url of [undefined, null, '', 3, {}, 'example.com', 'file:///tmp/page', 'javascript:alert(1)', 'ftp://example.com', `https://example.com/${'x'.repeat(8_000)}`]) {
      const out = await s.invoke(s.ref(), 'navigate', [url]);
      assert.deepEqual([out.status, out.reason], ['refused', 'invalid']);
    }
    const agent = await s.invoke(s.ref('agent'), 'navigate', ['https://next.example/']);
    assert.deepEqual([agent.status, agent.reason, agent.message], ['refused', 'unavailable', 'Codex is using this tab']);
    for (const op of ['back', 'forward']) {
      const out = await s.invoke(s.ref('unattached', 'new-chat'), op);
      assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    }
    assert.deepEqual(s.ops, []);
    assert.deepEqual(s.prompts, []);
    const prefix = 'http://localhost/';
    const out = await s.invoke(s.ref(), 'navigate', [prefix + 'x'.repeat(8_000 - prefix.length)], user);
    assert.equal(out.status, 'done');
  } finally { await s.close(); }
});

test('R17 uses the title or current URL for mods, skips user callers, and denial sends nothing', async () => {
  const s = await setup();
  try {
    assert.equal((await s.invoke(s.ref('unattached', 'new-chat'), 'navigate', ['https://target.example/'])).status, 'done');
    assert.deepEqual(s.prompts, [{ action: 'open https://target.example/ in the browser tab “https://example.com/”', detail }]);
    s.prompts.length = 0;
    assert.equal((await s.invoke(s.ref(), 'navigate', ['http://example.com/user'], user)).status, 'done');
    assert.deepEqual(s.prompts, []);
    s.approve(false);
    const count = s.ops.length;
    const out = await s.invoke(s.ref(), 'navigate', ['https://denied.example/']);
    assert.deepEqual([out.status, out.reason], ['refused', 'notAllowed']);
    assert.equal(s.ops.length, count);
    assert.deepEqual(s.prompts, [{ action: 'open https://denied.example/ in the browser tab “Example”', detail }]);
  } finally { await s.close(); }
});

test('main refusals become unavailable and attempted failures throw; every attempted operation still refreshes', async () => {
  const s = await setup();
  try {
    for (const [operation, op, args] of [['navigate', 'command', ['https://next.example/']], ['reload', 'command', []], ['back', 'command', []],
      ['forward', 'command', []], ['close', 'close', []], ['openExternally', 'open-external', []]]) {
      s.answers.set(op, { ok: false, refused: true, error: 'page-unavailable' });
      const count = reads(s);
      const no = await s.invoke(s.ref(), operation, args, user);
      assert.deepEqual([no.status, no.reason, no.message], ['refused', 'unavailable', 'page-unavailable']);
      s.answers.set(op, { ok: false, error: 'the page crashed' });
      const failed = await s.invoke(s.ref(), operation, args, user);
      assert.equal(failed.status, 'failed', JSON.stringify(failed));
      assert.equal(failed.error.message, 'the page crashed');
      assert.equal(reads(s), count + 2);
      await assert.rejects(s.feed.run(s.ref(), operation, args[0]), /the page crashed/, 'the feed throws attempted failures');
      s.answers.delete(op);
    }
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('unknown and gone tabs refuse without main calls or R17 prompts, including a resident tab this feed did not read', async () => {
  const s = await setup();
  try {
    const unknown = s.ref('unknown'), data = browser.tabData(tab(s.threadId, 'unread'), { thread: refs.thread(s.threadId) });
    s.source.provider.put(data.ref, { state: data.state, links: data.links });
    s.setTabs(s.tabs().filter((t) => t.browserTabId !== 'you'));
    await s.feed.read();
    const count = s.ops.length;
    for (const ref of [unknown, data.ref, s.ref()]) for (const operation of browser.realizes.operations.BrowserTab) {
      const out = await s.invoke(ref, operation, operation === 'navigate' ? ['https://next.example/'] : []);
      assert.deepEqual([out.status, out.reason], ['refused', 'unavailable']);
    }
    assert.equal(s.ops.length, count);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('failed or malformed reads log and keep instances, and the first successful read after a failure is a sync', async () => {
  const s = await setup();
  try {
    const before = s.graph.list('BrowserTab');
    for (const answer of [{ ok: false, refused: true, error: 'manager unavailable' }, { ok: false, error: 'read failed' }, { ok: true, result: {} }]) {
      s.answers.set('tabs', answer);
      await s.feed.read();
      assert.deepEqual(s.graph.list('BrowserTab'), before);
      assert.deepEqual(s.events, []);
    }
    assert.equal(s.warnings.length, 3);
    s.answers.delete('tabs');
    await s.feed.read();
    assert.deepEqual(s.graph.list('BrowserTab'), before);
  } finally { await s.close(); }
  const first = await setup({ initialAnswers: [['tabs', { ok: false, error: 'not ready' }]] });
  try {
    assert.deepEqual(first.graph.list('BrowserTab'), []);
    first.answers.delete('tabs'); await first.feed.read();
    assert.equal(first.graph.list('BrowserTab').length, 3);
    assert.deepEqual(first.events, []);
  } finally { await first.close(); }
  const absent = await setup({ main: false });
  try {
    assert.deepEqual(absent.graph.list('BrowserTab'), []);
    assert.equal(absent.warnings[0][1].message, 'framework-main is not running');
  } finally { await absent.close(); }
});

test('reads coalesce and serialize; observe shares the running read or refreshes only when more than five seconds old', async () => {
  const s = await setup();
  const gate = Promise.withResolvers();
  try {
    let count = reads(s);
    s.clock(105_000); await s.feed.observe(s.ref(), 'BrowserTab');
    assert.equal(reads(s), count);
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    s.clock(105_001);
    const view = s.graph.subscribe({ ref: s.ref() }, () => {});
    await view.loaded; view.dispose();
    assert.equal(reads(s), ++count);
    let calls = 0, active = 0, peak = 0;
    s.answers.set('tabs', async () => {
      calls++; active++; peak = Math.max(peak, active);
      try { if (calls === 1) await gate.promise; return { ok: true, result: { tabs: s.tabs() } }; } finally { active--; }
    });
    const first = s.feed.read();
    assert.equal(s.feed.observe(s.ref(), 'BrowserTab'), first);
    assert.equal(s.feed.read(), first);
    assert.equal(s.feed.read(), first);
    await until(() => calls === 1, 2000, 'the held browser read');
    gate.resolve(); await first;
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal(reads(s), count + 2);
  } finally { gate.resolve(); await s.close(); }
});

test('invalidations debounce for 300 ms, ignore other reports and stop after disposal', async (t) => {
  const s = await setup();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const count = reads(s);
    s.report(null); s.report({ event: 'other' });
    t.mock.timers.tick(300);
    assert.equal(reads(s), count);
    s.report(); t.mock.timers.tick(200); s.report(); t.mock.timers.tick(299);
    assert.equal(reads(s), count);
    t.mock.timers.tick(1);
    await s.feed.observe(s.ref(), 'BrowserTab');
    assert.equal(reads(s), count + 1);
    s.report(); s.feed.dispose();
    t.mock.timers.tick(300); s.report(); t.mock.timers.tick(300);
    assert.equal(reads(s), count + 1);
  } finally { t.mock.timers.reset(); await s.close(); }
});

test('the fifteen-second timer reads; disposal clears it and prevents an in-flight read from restoring tabs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = await setup(), gate = Promise.withResolvers();
  try {
    const count = reads(s);
    s.setTabs(s.tabs().map((t) => ({ ...t, title: 'Timer update' })));
    t.mock.timers.tick(14_999); assert.equal(reads(s), count);
    t.mock.timers.tick(1); await s.feed.observe(s.ref(), 'BrowserTab');
    assert.equal(reads(s), count + 1);
    assert.equal(state(s).title, 'Timer update');
    const before = s.graph.list('BrowserTab');
    s.answers.set('tabs', () => gate.promise);
    const running = s.feed.read();
    s.feed.dispose();
    gate.resolve({ ok: true, result: { tabs: [] } }); await running;
    t.mock.timers.tick(60_000);
    await s.feed.read(); await s.feed.start(); await s.feed.observe(s.ref(), 'BrowserTab');
    assert.equal(reads(s), count + 2);
    assert.deepEqual(s.graph.list('BrowserTab'), before);
    assert.deepEqual(await s.feed.run(s.ref(), 'reload'), { status: 'refused', reason: 'unavailable', message: 'the browser tab is gone' });
    assert.equal(s.feed.prompt(s.ref(), 'https://example.com/'), null);
  } finally { gate.resolve({ ok: true, result: { tabs: [] } }); await s.close(); }
});
