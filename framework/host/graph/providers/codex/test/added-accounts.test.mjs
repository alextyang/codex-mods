// Several accounts (RM10, added-accounts.mjs and framework/host/added-accounts.mjs): an added account with its own ChatGPTAccount and
// CodexUsage from its own backend; every chat's account; a chat moved to it between turns (refused while it works), whose turns then run
// there and are the graph's as ever; new chats started on it; and its removal, its chats moved home first. The real mux with the fake
// app-server (one process per backend), the graph runtime and the codex source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import { createAppState } from '../../../app-state.mjs';
import { createAddedAccounts } from '../../../../added-accounts.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.a' };

async function setup(t, { before } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-added-'));
  const appHome = path.join(dir, 'codex-home');
  fs.mkdirSync(appHome, { recursive: true });
  const prompts = [];
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet, approvals: { ask: async (q) => { prompts.push(q.action); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const ops = [];
  let store = null;
  store = createAppState({ log: quiet, timeoutMs: 2000, send: (m) => queueMicrotask(() => {
    ops.push([m.op, m.path]);
    const result = m.op === 'account' ? { signedIn: true, accountId: 'acct-app', userId: 'user-1', plan: 'pro', workspace: { name: null, structure: 'personal' } } : undefined;
    store.settle({ type: 'app-state-op-done', requestId: m.requestId, ok: true, ...(result ? { result } : {}) });
  }) });
  store.apply({ type: 'app-state', available: true, reset: true, values: {}, definitions: [],
    app: { version: '26.1027.30824', buildNumber: '22943', appName: 'ChatGPT', onboarded: true, launchedAt: 0 } });
  const added = createAddedAccounts({ mux: h.mux, dir: path.join(dir, 'backends', 'framework'), appHome, log: quiet, env: {} });
  await added.start();
  const early = before ? await before(added) : null;
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 50, log: quiet, appState: store, addedAccounts: added });
  t.after(async () => { await source.dispose(); added.dispose(); graph.close(); store.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (early) {
    // as the Host: it never calls start(); the source reads when the app-server says it is ready
    assert.equal(graph.resolve(refs.chatgptAccount(early.key))?.state.signedIn, false, 'a restored account is there at once, signed out until read');
    h.bus.publish('appServer/ready', {});
  } else {
    await source.start();
    await until(() => graph.resolve(refs.usage('acct-app')), 5000, 'the app\'s account');
  }
  return { h, graph, added, prompts, ops, source, early };
}
const invoke = (g, ref, operation, args = []) => g.invoke({ ref, operation, args, caller: mod });

test('an added account: its own account and usage, every chat\'s account, a chat moved to it between turns and its turns there', async (t) => {
  const { h, graph, added, prompts } = await setup(t);
  const app = refs.chatgptAccount('acct-app');
  const out = await invoke(graph, refs.agent(), 'addAccount');
  assert.equal(out.status, 'done');
  const acct = out.value;
  const key = acct.id;
  assert.match(key, /^acct-[0-9a-f]{8}$/);
  assert.deepEqual(prompts, ['add a ChatGPT account to Codex']);
  await until(() => graph.resolve(acct)?.state.signedIn && graph.resolve(refs.usage(key)), 5000, 'the added account read from its own backend');
  assert.deepEqual(graph.resolve(acct).state, { service: 'chatgpt', name: 'fake@example.com', signedIn: true, email: 'fake@example.com', plan: 'pro', added: true });
  assert.equal(graph.resolve(refs.usage(key)).state.snapshots.codex.secondary.usedPercent, 40);
  assert.deepEqual(graph.resolve(refs.agent()).links.accounts, [app, acct]);
  assert.deepEqual(graph.resolve(refs.agent()).links.account, app, 'the app\'s own account is still the agent\'s');
  // a chat the app starts runs on the app's account
  const started = await h.app.request('s1', 'thread/start', { cwd: '/tmp/p' });
  const T = started.result.thread.id;
  const thread = refs.thread(T);
  await until(() => graph.resolve(thread), 5000, 'the chat');
  assert.deepEqual(graph.resolve(thread).links.account, app);
  // moved to the added account: its next turns run there, the same chat in the graph
  assert.equal((await invoke(graph, thread, 'moveToAccount', [acct])).status, 'done');
  assert.match(prompts.at(-1), /^move ".*" to the account fake@example.com$/);
  assert.equal(h.mux.homeOf(T), `framework/${key}`);
  assert.equal(added.placementOf(T), key);
  assert.deepEqual(graph.resolve(thread).links.account, acct);
  assert.deepEqual(graph.referrers(acct, 'account').map((x) => x.ref.type).sort(), ['CodexThread', 'CodexUsage'], 'Account.threads (inverse)');
  const turn = await h.app.request('t1', 'turn/start', { threadId: T, input: [{ type: 'text', text: 'hi' }] });
  await until(() => graph.resolve(refs.turn(turn.result.turn.id))?.state.status === 'completed', 5000, 'its turn, from the added account\'s backend');
  // the same account again: nothing to do; a working chat does not move
  assert.equal((await invoke(graph, thread, 'moveToAccount', [acct])).status, 'done');
  const fake = h.mux.client('graph:test');
  const on = { backend: `framework/${key}` };
  const status = (type) => fake.request('fake/notify', { method: 'thread/status/changed', params: { threadId: T, status: { type, ...(type === 'active' ? { activeFlags: [] } : {}) } } }, on);
  await fake.request('fake/hold', { threadId: T }, on);
  h.app.send({ id: 't2', method: 'turn/start', params: { threadId: T, input: [{ type: 'text', text: 'long' }] } });
  await status('active');   // (the fake does not report its status itself)
  await until(() => graph.resolve(thread)?.state.status === 'working', 5000, 'working');
  const busy = await invoke(graph, thread, 'moveToAccount', [app]);
  assert.deepEqual([busy.status, busy.reason], ['refused', 'unavailable'], busy.message);
  assert.equal(h.mux.homeOf(T), `framework/${key}`);
  const t2 = await h.app.reply('t2');
  await fake.request('fake/finishTurn', { threadId: T, turnId: t2.result.turn.id }, on);
  await status('idle');
  await until(() => graph.resolve(thread)?.state.status === 'idle', 5000, 'idle again');
  // and back home
  assert.equal((await invoke(graph, thread, 'moveToAccount', [app])).status, 'done');
  assert.equal(h.mux.homeOf(T), 'primary');
  assert.equal(added.placementOf(T), null);
  assert.deepEqual(graph.resolve(thread).links.account, app);
  // an account of no agent is refused, and so is a mod's own instance with an added account's id
  assert.equal((await invoke(graph, thread, 'moveToAccount', [refs.chatgptAccount('nobody')])).reason, 'invalid');
  assert.equal((await invoke(graph, thread, 'moveToAccount', [{ type: 'ChatGPTAccount', provider: 'mod.x', id: key }])).reason, 'invalid');
  // a move that cannot be recorded is undone: the chat stays where it runs
  const flush = added.flush;
  added.flush = () => false;
  const unrecorded = await invoke(graph, thread, 'moveToAccount', [acct]);
  added.flush = flush;
  assert.deepEqual([unrecorded.status, h.mux.homeOf(T), added.placementOf(T)], ['refused', 'primary', null], unrecorded.message);
});

test('new chats start on the start account; removing an added account moves its chats home first, then it goes', async (t) => {
  const { h, graph, added } = await setup(t);
  const app = refs.chatgptAccount('acct-app');
  const acct = (await invoke(graph, refs.agent(), 'addAccount')).value;
  await until(() => graph.resolve(acct)?.state.signedIn, 5000, 'signed in');
  assert.equal((await invoke(graph, refs.agent(), 'setStartAccount', [acct])).status, 'done');
  assert.deepEqual(graph.resolve(refs.agent()).links.startAccount, acct);
  const started = await h.app.request('s1', 'thread/start', { cwd: '/tmp/p' });
  const T = started.result.thread.id;
  assert.match(T, new RegExp(`^thr-${acct.id}-`), 'started by the added account\'s app-server');
  await until(() => graph.resolve(refs.thread(T))?.links.account?.id === acct.id, 5000, 'a new chat on the start account');
  // the app's own account is not removed here
  assert.equal((await invoke(graph, app, 'remove')).status, 'refused');
  assert.equal((await invoke(graph, acct, 'remove')).status, 'done');
  assert.equal(h.mux.homeOf(T), 'primary', 'its chat moved home first');
  await until(() => graph.resolve(acct)?.gone === true || !graph.resolve(acct), 5000, 'the account gone');
  assert.deepEqual(added.list(), []);
  assert.deepEqual(graph.resolve(refs.agent()).links.accounts, [app]);
  assert.equal(graph.resolve(refs.agent()).links.startAccount ?? null, null);
  assert.deepEqual(graph.resolve(refs.thread(T)).links.account, app);
  // new chats start on the app's account again
  const plain = await h.app.request('s2', 'thread/start', { cwd: '/tmp/p' });
  assert.match(plain.result.thread.id, /^thr-primary-/);
});

test('after a restart: an added account is there at once and read when the app-server is ready; its chats run where they were placed', async (t) => {
  const { h, graph, added, early } = await setup(t, { before: async (a) => {
    const x = await a.add();
    return x;
  } });
  const acct = refs.chatgptAccount(early.key);
  await until(() => graph.resolve(acct)?.state.signedIn === true, 5000, 'read once the app-server is ready');
  await until(() => graph.resolve(refs.agent())?.links.accounts?.some((a) => a.id === early.key), 5000, 'among the agent\'s accounts');
  assert.deepEqual(added.list().map((x) => x.key), [early.key]);
  // a placement restored (as the Host does at start) routes the chat's requests to its account's backend
  const started = await h.app.request('s1', 'thread/start', { cwd: '/tmp/p' });
  const T = started.result.thread.id;
  h.mux.place(T, `framework/${early.key}`);
  assert.equal(h.mux.homeOf(T), `framework/${early.key}`);
  const resumed = await h.app.request('r1', 'thread/resume', { threadId: T });
  assert.equal(resumed.result.thread.id, T, 'resumed by the account\'s backend, where it runs');
});
