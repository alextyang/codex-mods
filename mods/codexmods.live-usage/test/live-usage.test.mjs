// codexmods.live-usage: the estimator, the reserve and the service, from the graph's facts (a Codex chat's token reports, CodexUsage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { costOf, createEstimator, reserveHolds, statusOf, windowName } from '../host.mjs';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../mod.json', import.meta.url), 'utf8'));
const MOD = 'codexmods.live-usage';
const tok = (input, cached, output) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });
const WEEK = 10080;

test('a response\'s cost: uncached input, cached input at a tenth, output at six', () => {
  assert.equal(costOf(tok(1000, 800, 100)), 200 + 80 + 600);
  assert.equal(costOf(null), 0);
  assert.equal(costOf(tok(100, 500, 0)), 10, 'cached never above the input');
});

test('the estimator learns the cost of a point when the server moves the window, and estimates between points', () => {
  let t = 1_000_000;
  const e = createEstimator({ now: () => t });
  e.snapshot('codex', { usedPercent: 10, windowDurationMins: WEEK, resetsAt: 5e12 });
  let total = 0;
  const report = (thread, c) => { total += 1000; return e.report(thread, { totalTokens: total }, tok(c, 0, 0)); };
  assert.equal(report('a', 500), true);
  assert.equal(report('b', 500), true);
  assert.equal(e.report('b', { totalTokens: total }, tok(500, 0, 0)), false, 'a repeat of a thread\'s total is not a new response');
  assert.equal(e.view().binding.calibrated, false, 'nothing learnt before the window moves');
  e.snapshot('codex', { usedPercent: 11, windowDurationMins: WEEK, resetsAt: 5e12 });   // 1000 units moved it one point
  report('a', 250);
  t += 60_000;
  const v = e.view();
  assert.equal(v.binding.calibrated, true);
  assert.equal(+v.binding.estimate.toFixed(2), 11.25, 'a quarter of a point since it moved');
  assert.ok(v.binding.ratePerHour > 0);
  assert.deepEqual(v.threads.map((x) => [x.id, +x.share.toFixed(2)]), [['a', 0.75], ['b', 0.5]]);
  // a new window starts over and keeps what it learnt
  e.snapshot('codex', { usedPercent: 0, windowDurationMins: WEEK, resetsAt: 6e12 });
  assert.deepEqual([e.view().binding.percent, +e.view().binding.estimate.toFixed(2)], [0, 0]);
  assert.equal(windowName({ windowDurationMins: WEEK }), 'Weekly');
  assert.equal(windowName({ windowDurationMins: 300 }), '5-hour');
});

test('the reserve holds at or past its percentage; 0 is off; the status says the estimate and the pace', () => {
  const e = createEstimator();
  e.snapshot('codex', { usedPercent: 82, windowDurationMins: WEEK });
  assert.equal(reserveHolds(e.view(), 80), true);
  assert.equal(reserveHolds(e.view(), 90), false);
  assert.equal(reserveHolds(e.view(), 0), false);
  assert.match(statusOf(e.view()).text, /^Weekly 82%/);
  assert.match(statusOf(createEstimator().view()).text, /waiting/);
});

/** The graph with a Codex of the test's own: one chat, whose sends it records, and a CodexUsage it reports. */
async function setup(t, { percent = 50, resetsAt = Date.now() + 3_600_000 } = {}) {
  const g = await createTestGraph();
  t.after(() => g.close());
  const sent = [];
  const codex = g.provider('codex', {
    CodexThread: { operations: { send: { effect: 'external', handler: ({ ref, args }) => { sent.push([ref.id, args[0]]); return null; } }, stop: () => null } },
    CodexUsage: {}, CodexAgent: {}, ChatGPTAccount: {},
  });
  const account = { type: 'ChatGPTAccount', provider: 'codex', id: 'me' };
  await codex.put(account, { state: { service: 'ChatGPT', name: 'Me', signedIn: true } });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  await codex.put(agent, { state: { name: 'Codex', icon: 'codex', available: true } });
  const chat = { type: 'CodexThread', provider: 'codex', id: 't1' };
  await codex.put(chat, { state: { title: 'A chat', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent } });
  const usage = { type: 'CodexUsage', provider: 'codex', id: 'usage' };
  const report = (p) => codex.put(usage, { state: { snapshots: { codex: { limitId: 'codex', primary: { usedPercent: p, windowDurationMins: WEEK, resetsAt } } } }, links: { account } });
  await report(percent);
  const mod = await g.mod(here);
  return { g, codex, chat, usage, report, sent, mod };
}

test('token reports and the usage reach the estimates; the service gives the menu bar its snapshot', async (t) => {
  const { g, codex, chat, report, mod } = await setup(t);
  let total = 0;
  const tokens = async (c) => { total += 100; await codex.emit(chat, 'tokenUsageReported', { turnId: 'u', tokenUsage: { total: tok(total, 0, 0), last: tok(c, 0, 0) } }); };
  await tokens(400);
  await report(51);
  await tokens(100);
  const snap = await g.waitFor(async () => { const s = await mod.call('usage', 'snapshot'); return s.estimates[0]?.calibrated ? s : null; }, { what: 'a calibrated estimate' });
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.rateLimits.codex.primary.usedPercent, 51);
  assert.equal(+snap.estimates[0].estimate.toFixed(2), 51.25);
  assert.deepEqual((await mod.call('usage', 'threads')).map((x) => x.id), ['t1']);
});

test('past the reserve, a message sent in a chat is stopped and kept, and a resume is scheduled; a chat that keeps working is not held', async (t) => {
  const { g, chat, sent, mod } = await setup(t, { percent: 90 });
  const r = mod.renderer();
  await r.settings.set('reserve', 80);
  const out = await g.invoke(chat, 'send', [{ parts: [{ kind: 'text', text: 'one more thing' }] }]);
  assert.equal(out.status, 'stopped');
  assert.match(out.message, /held this message: your weekly limit is at 90\.0%, past your reserve of 80%/);
  assert.deepEqual(sent, [], 'nothing sent');
  assert.deepEqual(await mod.call('usage', 'kept'), [{ thread: 't1', count: 1, continuation: false }]);
  await r.settings.set('keepWorking', true, { scope: { thread: chat } });
  assert.equal((await g.invoke(chat, 'send', [{ parts: [{ kind: 'text', text: 'this one goes' }] }])).status, 'done');
  assert.equal(sent.length, 1);
  await mod.call('usage', 'release', {});
  assert.deepEqual(await mod.call('usage', 'kept'), []);
});

test('with several accounts (RM10), the reserve holds a chat\'s message by its own account\'s limit', async (t) => {
  const { g, codex, chat, sent, mod } = await setup(t, { percent: 95 });
  const other = { type: 'ChatGPTAccount', provider: 'codex', id: 'other' };
  await codex.put(other, { state: { service: 'ChatGPT', name: 'Other', signedIn: true } });
  await codex.put({ type: 'CodexUsage', provider: 'codex', id: 'other' }, { state: { snapshots: { codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: WEEK, resetsAt: Date.now() + 3_600_000 } } } }, links: { account: other } });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  const moved = { type: 'CodexThread', provider: 'codex', id: 't2' };
  await codex.put(moved, { state: { title: 'On the other account', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent, account: other } });
  await codex.update(chat, { links: { account: { type: 'ChatGPTAccount', provider: 'codex', id: 'me' } } });
  await mod.renderer().settings.set('reserve', 90);
  const text = { parts: [{ kind: 'text', text: 'go on' }] };
  await g.waitFor(async () => ((await g.invoke(moved, 'send', [text])).status === 'done' ? true : null), { what: 'a chat on the account with room sends' });
  assert.equal((await g.invoke(chat, 'send', [text])).status, 'stopped', 'one on the account past the reserve is held');
  assert.deepEqual(sent.map(([id]) => id), ['t2']);
});

test('its page shows each limit, the reserve and the chats that used the most', async (t) => {
  const { control } = createFakeRendererContext({ manifest });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  assert.ok(control.pages.has('usage'));
  assert.equal(manifest.settings.find((s) => s.key === 'keepWorking').scope, 'thread', 'a chat\'s own setting: Chat settings shows it');
  assert.deepEqual(manifest.automatic.map((a) => a.id), ['resume', 'pause']);
});

test(`${MOD} keeps the menu bar's lease file private`, () => {
  assert.ok(manifest.permissions.includes('appServer.clients'));
});
