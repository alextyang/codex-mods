// Private threads (docs/design/reference-mods.md §2, RM7): a client given a `hiddenRoot` (the Host gives one to internal mods only) owns
// the threads it starts in a folder under it. Their frames and the client's own traffic are observed, intercepted and delivered to it only:
// the app never hears of them, nor does another mod. Headless: the real mux, the strict fake app-server and the app's connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { harness, until, sleep, catalog } from './helpers.mjs';

const PRIVATE = 'mod:codexmods.intelligence';

// the shipped catalogs key frames by `params.threadId` only: thread/started (`params.thread.id`) is not keyed, as on 22943
const REAL_KEYS = { ...catalog, affinityKeyPaths: ['params.threadId'] };

test('a hidden client\'s thread under its root is its own: the app and other mods never see it, and its requests skip their interceptors', async () => {
  const h = await harness({ catalog: REAL_KEYS });
  try {
    await h.up();
    const root = join(h.dir, 'intelligence', 'threads');
    const priv = h.mux.client(PRIVATE, { hiddenRoot: root });
    const other = h.mux.client('mod:other');
    const byOther = [], byPriv = [], intercepted = [];
    other.observe({}, (m, info) => { if (info) byOther.push({ method: info.method, kind: info.kind, m }); });
    priv.observe({}, (m, info) => { if (info) byPriv.push({ method: info.method, kind: info.kind, m }); });
    other.intercept('clientRequest', ['thread/start', 'turn/start'], (m) => { intercepted.push(m.method); });
    other.intercept('serverNotification', '*', (m) => { intercepted.push(m.method); });

    // its thread: started in its root, a turn run on it
    // not ephemeral, so the fake lists it (the real server lists an ephemeral thread too while it is loaded)
    const started = await priv.request('thread/start', { cwd: join(root, 'call-1') });
    const t = started.thread.id;
    await priv.request('turn/start', { threadId: t, input: [{ type: 'text', text: 'private words' }] });
    await until(() => byPriv.some((x) => x.method === 'turn/completed'), 10000, 'its turn completed, seen by it');
    assert.ok(byPriv.some((x) => x.method === 'thread/started' && x.m.params.thread.id === t), 'it sees its thread start');
    assert.ok(byPriv.some((x) => x.kind === 'clientRequest' && x.method === 'turn/start'), 'and its own requests');

    // the app's own thread, for contrast: everyone sees it
    const mine = await h.app.request(10, 'thread/start', { cwd: h.dir });
    await h.app.request(11, 'turn/start', { threadId: mine.result.thread.id, input: [{ type: 'text', text: 'hello' }] });
    await h.app.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === mine.result.thread.id, 10000);
    await until(() => byOther.some((x) => x.method === 'turn/completed'), 10000, 'the app\'s turn, seen by the other mod');
    await sleep(100);

    // a thread list answered to the app or another mod leaves it out (an ephemeral thread is listed while it is loaded); its owner's has it
    const listed = (r) => (r.result ?? r).data.map((x) => x.id);
    assert.equal(listed(await h.app.request(12, 'thread/list', {})).includes(t), false, 'not in the app\'s thread list');
    assert.equal(listed(await other.request('thread/list', {})).includes(t), false, 'nor in another mod\'s');
    assert.equal(listed(await priv.request('thread/list', {})).includes(t), true, 'its owner\'s list has it');
    assert.equal((await h.app.request(13, 'thread/loaded/list', {})).result?.data?.includes?.(t) ?? false, false);
    const mentions = (frames) => frames.some((x) => JSON.stringify(x.m ?? x).includes(t) || JSON.stringify(x.m ?? x).includes('private words'));
    assert.equal(mentions(h.app.inbox), false, 'the app never hears of the private thread');
    assert.equal(mentions(byOther), false, 'another mod never observes it');
    assert.deepEqual(intercepted.filter((x) => x === 'turn/start').length, 1, 'another mod\'s interceptors saw only the app\'s turn');
    assert.ok(!intercepted.includes('thread/started') || h.app.inbox.some((m) => m.method === 'thread/started'), 'its notifications skipped them too');
  } finally { await h.close(); }
});

test('a thread another client starts beside the hidden root is not private', async () => {
  const h = await harness();
  try {
    await h.up();
    h.mux.client(PRIVATE, { hiddenRoot: join(h.dir, 'intelligence', 'threads') });
    const plain = h.mux.client('mod:plain');
    const byPlain = [];
    plain.observe({ kinds: ['serverNotification'] }, (m, info) => { if (info) byPlain.push(m); });
    const near = await plain.request('thread/start', { cwd: join(h.dir, 'intelligence', 'threads-elsewhere') });
    await until(() => byPlain.some((m) => m.method === 'thread/started' && m.params.thread.id === near.thread.id), 10000, 'a thread beside the root, seen');
    const app = await h.app.request(1, 'thread/start', { cwd: join(h.dir, 'intelligence') });
    await h.app.waitFor((m) => m.method === 'thread/started' && m.params?.thread?.id === app.result.thread.id, 10000);
  } finally { await h.close(); }
});
