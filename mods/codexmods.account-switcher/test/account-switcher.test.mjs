// codexmods.account-switcher: an account's limit and standing, the account new usage goes to, where a chat runs after its turn (after a
// compaction, near a limit, out of one, the cooldown); and on a test graph with the framework's accounts stood in for, new chats placed on
// the account whose limit resets soonest, and chats moved between turns only while its automatic action is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { limitOf, standingOf, preferredOf, decide } from '../host.mjs';

const { createTestGraph } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const ref = (type, id) => ({ type, provider: 'codex', id });
const usage = (used, resetsAt, extra = {}) => ({ snapshots: { codex: { limitId: 'codex', primary: { usedPercent: Math.min(used, 10), windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt }, ...extra } } });
const acct = (id, used, resetsAt, o = {}) => ({ ref: ref('ChatGPTAccount', id), name: id, signedIn: o.signedIn ?? true, added: id !== 'A', limit: used === null ? null : limitOf(usage(used, resetsAt, o.snap)) });

test('a limit: its most used window, its weekly reset; its standing; the account new usage goes to', () => {
  assert.deepEqual(limitOf(usage(40, 5000)), { used: 40, resetsAt: 5000, reached: false });
  assert.equal(limitOf(usage(40, 5000, { rateLimitReachedType: 'rateLimitReached' })).reached, true);
  assert.equal(limitOf({ snapshots: {} }), null);
  const near = 90;
  assert.deepEqual([acct('A', 50, 1).limit && standingOf(acct('A', 50, 1), near), standingOf(acct('A', 92, 1), near), standingOf(acct('A', 100, 1), near),
    standingOf(acct('A', 10, 1, { signedIn: false }), near), standingOf(acct('A', null), near)], ['ok', 'near', 'out', 'out', 'unknown']);
  const accounts = [acct('A', 30, 9000), acct('B', 70, 3000), acct('C', 95, 1000), acct('D', null)];
  assert.equal(preferredOf(accounts, near).ref.id, 'B', 'the soonest reset with room; a near one is not');
  assert.equal(preferredOf(accounts, near, ref('ChatGPTAccount', 'B')).ref.id, 'A');
  assert.equal(preferredOf([acct('C', 95, 1000)], near), null);
});

test('where a chat runs after its turn: after a compaction, near a limit, out of one; the cooldown', () => {
  const near = 90, now = 10_000_000;
  const A = ref('ChatGPTAccount', 'A');
  const roomy = [acct('A', 30, 9000), acct('B', 40, 3000)];
  const chat = (o = {}) => ({ account: A, justCompacted: false, firstTurn: false, movedAt: null, context: 50_000, ...o });
  assert.equal(decide({ chat: chat({ justCompacted: true }), accounts: roomy, near, now })?.id, 'B', 'soon after a compaction: to the soonest reset');
  assert.equal(decide({ chat: chat({ firstTurn: true }), accounts: roomy, near, now })?.id, 'B', 'and after a first turn');
  assert.equal(decide({ chat: chat(), accounts: roomy, near, now }), null, 'otherwise it keeps its cache');
  assert.equal(decide({ chat: chat({ justCompacted: true }), accounts: [acct('A', 30, 1000), acct('B', 40, 3000)], near, now }), null, 'its own resets soonest');
  // right before its account runs out
  const nearly = [acct('A', 93, 9000), acct('B', 40, 3000)];
  assert.equal(decide({ chat: chat(), accounts: nearly, near, now, peers: [{ justCompacted: true, context: 10 }] })?.id, 'B', 'one not just compacted moves off');
  assert.equal(decide({ chat: chat({ justCompacted: true }), accounts: nearly, near, now }), null, 'one just compacted stays and uses the rest');
  assert.equal(decide({ chat: chat({ context: 1000 }), accounts: nearly, near, now, peers: [{ justCompacted: false, context: 90_000 }] }), null, 'the smallest context stays when none was compacted');
  assert.equal(decide({ chat: chat({ context: 90_000 }), accounts: nearly, near, now, peers: [{ justCompacted: false, context: 1000 }] })?.id, 'B');
  // out of it: off, even within the cooldown; otherwise the cooldown holds
  const out = [acct('A', 100, 9000), acct('B', 40, 3000)];
  assert.equal(decide({ chat: chat({ movedAt: now - 1000 }), accounts: out, near, now })?.id, 'B');
  assert.equal(decide({ chat: chat({ justCompacted: true, movedAt: now - 1000 }), accounts: roomy, near, now }), null);
  assert.equal(decide({ chat: chat(), accounts: [acct('A', 100, 9000), acct('B', 99, 3000)], near, now }), null, 'nowhere with room: it stays');
});

test('on the graph: new chats placed on the soonest reset; a chat moved after it compacts, only while its automatic action is on', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const moves = [], starts = [];
  const codex = g.provider('codex', {
    CodexAgent: { operations: { setStartAccount: { effect: 'external', approval: () => ({ action: 'start new chats elsewhere' }), handler: ({ args }) => { starts.push(args[0]?.id ?? null); codex.update(AGENT, { links: { startAccount: args[0] ?? null } }); return null; } } } },
    // as the framework's: a mod's call asks the user, unless it is the mod's automatic action
    Thread: { operations: { moveToAccount: { effect: 'external', approval: () => ({ action: 'move a chat to another account' }), handler: ({ ref: r, args }) => { moves.push([r.id, args[0].id]); codex.update(r, { links: { account: args[0] } }); return null; } } } },
    CodexThread: {}, ChatGPTAccount: { supports: ['added'] }, CodexUsage: {},
  });
  const AGENT = ref('CodexAgent', 'codex'), A = ref('ChatGPTAccount', 'A'), B = ref('ChatGPTAccount', 'B');
  await codex.put(A, { state: { service: 'chatgpt', name: 'me@example.com', signedIn: true }, links: { usage: ref('CodexUsage', 'A') } });
  await codex.put(B, { state: { service: 'chatgpt', name: 'other@example.com', signedIn: true, added: true }, links: { usage: ref('CodexUsage', 'B') } });
  await codex.put(ref('CodexUsage', 'A'), { state: usage(30, 9_000_000_000_000), links: { account: A } });
  await codex.put(ref('CodexUsage', 'B'), { state: usage(40, 3_000_000_000_000), links: { account: B } });
  await codex.put(AGENT, { state: { name: 'Codex', icon: 'codex', available: true }, links: { account: A, accounts: [A, B] } });
  const T = ref('CodexThread', 't1');
  const thread = (status) => ({ state: { title: 'Refactor', status, unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent: AGENT, account: A } });
  await codex.put(T, thread('idle'));
  const mod = await g.mod(here);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(starts, [], 'not without its automatic action `place`');
  g.automatic(mod.id, 'place');
  await codex.update(ref('CodexUsage', 'B'), { state: usage(41, 3_000_000_000_000) });   // a change it looks again at
  await g.waitFor(() => (starts.includes('B') ? true : null), { what: 'new chats placed on the soonest reset' });
  // a turn that compacts, with the automatic action off: it stays
  const turn = async (compact) => {
    await codex.update(T, { state: { status: 'working' } });
    await new Promise((r) => setTimeout(r, 50));
    if (compact) codex.emit(T, 'compacted', { turnId: 'u1' });
    await new Promise((r) => setTimeout(r, 50));
    await codex.update(T, { state: { status: 'idle' } });
    await new Promise((r) => setTimeout(r, 150));
  };
  await turn(false);   // its first turn (a first turn moves too, when allowed)
  assert.deepEqual(moves, [], 'never without its automatic action');
  g.automatic(mod.id, 'switch');
  await turn(false);
  assert.deepEqual(moves, [], 'a turn that did not compact keeps its account');
  await turn(true);
  await g.waitFor(() => (moves.length ? true : null), { what: 'moved after its compaction' });
  assert.deepEqual(moves, [['t1', 'B']]);
  const page = await mod.call('switcher', 'status');
  assert.deepEqual(page.accounts.map((a) => [a.ref.id, a.standing, a.chats]), [['A', 'ok', 0], ['B', 'ok', 1]]);
  assert.equal(page.start, 'B');
});
