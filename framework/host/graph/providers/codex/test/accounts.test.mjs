// Account, ChatGPTAccount and Usage in the native provider (breadth step D4; accounts.mjs): the signed-in account from the protocol and the
// app's account facts, its usage from the protocol's rate limits with their events, the agent's account, and signIn, signOut (asking the
// user first, R17) and manage. The real mux with the fake app-server, the graph runtime and the codex source; the test plays
// framework-main's answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import { createAppState } from '../../../app-state.mjs';
import { accountData, usageState, snapshotOf } from '../accounts.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('accountData and usageState: a ChatGPT account by its id, named by its workspace; the server\'s snapshots as given, by limitId, times in ms', () => {
  const a = accountData({ type: 'chatgpt', email: 'q@example.com', planType: 'pro' }, { accountId: 'acct-1', workspace: { structure: 'workspace', name: 'QA Team' } });
  assert.deepEqual(a, { ref: refs.chatgptAccount('acct-1'), state: { service: 'chatgpt', name: 'QA Team', signedIn: true, email: 'q@example.com', plan: 'pro', workspace: 'QA Team' }, links: { usage: refs.usage('acct-1') } });
  assert.equal(accountData({ type: 'chatgpt', email: 'q@example.com', planType: 'plus' }, { accountId: 'a', workspace: { structure: 'personal', name: null } }).state.name, 'q@example.com', 'a personal account: its email');
  assert.deepEqual(accountData({ type: 'apiKey' }, null), { ref: refs.account('openai-api'), state: { service: 'openai-api', name: 'OpenAI API key', signedIn: true }, links: {} });
  assert.equal(accountData(null, null), null);
  // nothing named, computed or classified (graph-integrity G1.2): the windows as the server reports them, keyed by the source's identity
  const u = usageState({ ordinaryUsageAllowed: true, rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792003600 }, secondary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: null },
      credits: { hasCredits: true, unlimited: false, balance: '4.20' }, planType: 'pro', rateLimitReachedType: null, someNewField: 7 },
    spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 100, windowDurationMins: 1440 }, rateLimitReachedType: 'rateLimitReached' } } });
  assert.deepEqual(u, { ordinaryUsageAllowed: true, snapshots: {
    codex: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792003600000 }, secondary: { usedPercent: 91, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: '4.20' }, extra: { someNewField: 7 } },
    spark: { limitId: 'spark', limitName: 'Spark', rateLimitReachedType: 'rateLimitReached', primary: { usedPercent: 100, windowDurationMins: 1440 } } } });
  // the backward-compatible single-bucket view, when the server gives no map
  assert.deepEqual(Object.keys(usageState({ rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } } }).snapshots), ['codex']);
  assert.equal(snapshotOf(null), null);
});

async function setup({ available = true } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-accounts-'));
  const prompts = [];
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet, approvals: { ask: async (q) => { prompts.push(q.action); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const ops = [];
  let store = null;
  store = createAppState({ log: quiet, timeoutMs: 2000, send: (m) => queueMicrotask(() => {
    ops.push([m.op, m.path]);
    const result = m.op === 'account' ? { signedIn: true, accountId: 'acct-1', userId: 'user-1', plan: 'pro', workspace: { name: 'QA Team', structure: 'workspace', role: 'standard-user' } } : undefined;
    store.settle({ type: 'app-state-op-done', requestId: m.requestId, ok: true, ...(result ? { result } : {}) });
  }) });
  store.apply({ type: 'app-state', available, reset: true, values: { appearanceTheme: { effective: 'system' } },
    definitions: [{ key: 'appearanceTheme', agentAccess: 'read-write', default: 'system', description: 'Theme.', schema: { type: 'string', enum: ['system', 'light', 'dark'] } }],
    app: { version: '26.1016.62342', buildNumber: '21477', appName: 'ChatGPT', onboarded: true, launchedAt: 0 } });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 2, log: quiet, appState: store });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event' && (e.ref.type === 'ChatGPTAccount' || e.ref.type === 'CodexUsage')) events.push([e.ref.type, e.name, e.payload]); });
  await source.start?.();
  await until(() => graph.resolve(refs.usage(available ? 'acct-1' : 'chatgpt')), 5000, 'the account and its usage');
  return { h, graph, store, ops, events, prompts, async close() { await source.dispose(); graph.close(); store.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const mod = { kind: 'mod', id: 'mod.a' };

test('the signed-in account and its usage; the agent\'s account; a rate-limit push is reported as given, and an account change says what moved', async () => {
  const s = await setup();
  try {
    const acct = s.graph.resolve(refs.chatgptAccount('acct-1'));
    assert.deepEqual(acct.state, { service: 'chatgpt', name: 'QA Team', signedIn: true, email: 'fake@example.com', plan: 'pro', workspace: 'QA Team' });
    assert.deepEqual(s.graph.resolve(refs.agent()).links.account, refs.chatgptAccount('acct-1'));
    assert.deepEqual(s.graph.referrers(refs.chatgptAccount('acct-1'), 'account').map((x) => x.ref.type).sort(), ['CodexAgent', 'CodexUsage'], 'Account.agents (inverse) and the usage');
    assert.deepEqual(s.graph.resolve(refs.app())?.links.accounts, [refs.chatgptAccount('acct-1')], 'App.accounts: the signed-in account');
    const usage = s.graph.resolve(refs.usage('acct-1'));
    assert.deepEqual([usage.ref.type, usage.state.snapshots.codex.primary.usedPercent, usage.state.snapshots.codex.secondary.usedPercent], ['CodexUsage', 12, 40]);
    // each push is reported as given, the same one twice too; the usage follows it
    for (const id of [901, 902]) await s.h.app.request(id, 'fake/rateLimits', { primary: 95, secondary: 40 });
    await until(() => s.events.filter(([, n]) => n === 'reported').length === 2, 3000, 'two reports');
    const reported = s.events.filter(([, n]) => n === 'reported').map(([, , p]) => p.snapshot.primary.usedPercent);
    assert.deepEqual([reported, s.graph.resolve(refs.usage('acct-1')).state.snapshots.codex.primary.usedPercent], [[95, 95], 95]);
    assert.deepEqual(s.events.filter(([t, n]) => t === 'CodexUsage' && n === 'changed').length, 1, 'changed once: the repeat changed nothing');
    await s.h.app.request(903, 'fake/account', { account: { planType: 'plus' } });
    await until(() => s.events.some(([, n]) => n === 'planChanged'), 3000, 'planChanged');
    assert.equal(s.graph.resolve(refs.chatgptAccount('acct-1')).state.plan, 'plus');
  } finally { await s.close(); }
});

test('signOut asks the user first and signs the app out; signIn starts the sign-in and opens its page; manage opens the account settings', async () => {
  const s = await setup();
  try {
    const ref = refs.chatgptAccount('acct-1');
    assert.equal((await s.graph.invoke({ ref, operation: 'manage', args: [], caller: mod })).status, 'done');
    assert.deepEqual(s.ops.at(-1), ['navigate', '/settings/account']);
    assert.equal((await s.graph.invoke({ ref, operation: 'signIn', args: [], caller: mod })).status, 'done');
    assert.equal(s.ops.filter(([op]) => op === 'open-login').length, 0, 'signed in already: nothing');
    assert.equal((await s.graph.invoke({ ref, operation: 'signOut', args: [], caller: mod })).status, 'done');
    assert.deepEqual(s.prompts, ['sign out of ChatGPT in Codex']);
    await until(() => s.graph.resolve(ref).state.signedIn === false, 3000, 'signed out');
    assert.ok(s.events.some(([, n]) => n === 'signedOut'));
    assert.equal((await s.graph.invoke({ ref, operation: 'signIn', args: [], caller: mod })).status, 'done');
    assert.deepEqual(s.ops.filter(([op]) => op === 'open-login'), [['open-login', 'https://auth.openai.com/oauth/authorize?fake=1']]);
  } finally { await s.close(); }
});

test('before framework-main can say the account\'s id, the account is `chatgpt`; once it can, the same account under its id, no event', async () => {
  const s = await setup({ available: false });
  try {
    assert.equal(s.graph.resolve(refs.chatgptAccount('chatgpt')).state.name, 'fake@example.com');
    assert.deepEqual(s.graph.resolve(refs.agent()).links.account, refs.chatgptAccount('chatgpt'));
    s.store.apply({ type: 'app-state', available: true });
    await until(() => s.graph.resolve(refs.usage('acct-1')), 5000, 'the account under its id');
    assert.deepEqual(s.graph.list('Account').map((x) => x.ref.id), ['acct-1'], 'one account: the placeholder went');
    assert.equal(s.graph.resolve(refs.usage('chatgpt'))?.gone, true, 'its usage went too');
    assert.deepEqual(s.graph.resolve(refs.agent()).links.account, refs.chatgptAccount('acct-1'));
    assert.deepEqual(s.events, [], 'nobody signed in or out');
  } finally { await s.close(); }
});
