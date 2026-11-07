// Review dismissal and diff opening use supplied app services; no app or real global state is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./review.cjs');
const ATOMS = 'electron-persisted-atom-state';
const prefix = (client) => `dismissed-model-diff-comments-v3:${client}:`;

function setup({ atoms, writable = true, services, windows = [{ id: 7 }, { id: 9 }] } = {}) {
  const writes = [], posts = [], actions = [];
  const store = { get(key) { assert.equal(key, ATOMS); return atoms; } };
  if (writable) store.set = async (key, value) => { writes.push([key, value]); atoms = value; };
  let run;
  register({
    onAreaOp(area, fn) { assert.equal(area, 'review'); run = fn; },
    appHost: { first: () => services === null ? null : { id: 7, host: { services: services ?? { projects: { globalState: store }, appActions: { async runInPrimaryWindow(action) { actions.push(action); } } } } }, windows: () => windows },
    electron: { postToWindow(...args) { posts.push(args); } },
  });
  return { run, store, writes, posts, actions, atoms: () => atoms };
}
const refused = (pattern) => (e) => e.refused === true && pattern.test(e.message);

test('dismissed reads true values only, uses the app client id when it is a string and otherwise the local id', async () => {
  const threadId = 'thread / #';
  for (const client of [undefined, 42, 'client-1', '']) {
    const resolved = typeof client === 'string' ? client : `local:${threadId}`;
    const atoms = {
      [`thread-client-id-v1:${encodeURIComponent(`local:${threadId}`)}`]: client,
      [`${prefix(resolved)}yes`]: true, [`${prefix(resolved)}false`]: false, [`${prefix(resolved)}truthy`]: 1,
      [`${prefix('another')}other`]: true,
    };
    const s = setup({ atoms });
    assert.deepEqual(await s.run('dismissed', { threadId, keys: ['yes', 'false', 'truthy', 'other', 'missing'] }), { dismissed: ['yes'] });
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.posts, []);
  }
  assert.deepEqual(await setup().run('dismissed', { threadId, keys: [] }), { dismissed: [] });
});

test('dismiss writes the same client key both ways, broadcasts to every window, and an already dismissed key does nothing', async () => {
  for (const client of [undefined, 'app-client']) {
    const atoms = { unrelated: { keep: true }, ...(client ? { [`thread-client-id-v1:${encodeURIComponent('local:t')}`]: client } : {}) };
    const s = setup({ atoms });
    const key = `${prefix(client ?? 'local:t')}a|right|1|Title\n\nBody`;
    assert.deepEqual(await s.run('dismiss', { threadId: 't', key: 'a|right|1|Title\n\nBody' }), {});
    assert.deepEqual(s.writes, [[ATOMS, { ...atoms, [key]: true }]]);
    assert.equal(Object.hasOwn(atoms, key), false, 'the stored object is copied before writing');
    assert.deepEqual(s.posts, [7, 9].map((id) => [id, 'codex_desktop:message-for-view', { type: 'persisted-atom-updated', key, value: true, deleted: false }]));
    assert.deepEqual(await s.run('dismiss', { threadId: 't', key: 'a|right|1|Title\n\nBody' }), {});
    assert.equal(s.writes.length, 1);
    assert.equal(s.posts.length, 2);
    assert.deepEqual(await s.run('dismissed', { threadId: 't', keys: ['a|right|1|Title\n\nBody'] }), { dismissed: ['a|right|1|Title\n\nBody'] });
  }
});

test('a write evicts the oldest own dismissal keys beyond 999 for that thread, preserving other state', async () => {
  const p = prefix('local:t');
  const atoms = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`${p}old-${i}`, true]));
  atoms[`${prefix('local:other')}keep`] = true;
  atoms.settings = 3;
  const s = setup({ atoms });
  await s.run('dismiss', { threadId: 't', key: 'new' });
  const next = s.atoms();
  assert.equal(Object.keys(next).filter((key) => key.startsWith(p)).length, 1000);
  assert.equal(Object.hasOwn(next, `${p}old-0`), false);
  assert.equal(Object.hasOwn(next, `${p}old-1`), false);
  assert.equal(next[`${p}old-2`], true);
  assert.equal(next[`${p}new`], true);
  assert.equal(next[`${prefix('local:other')}keep`], true);
  assert.equal(next.settings, 3);
  const absent = setup();
  await absent.run('dismiss', { threadId: 't', key: 'new' });
  assert.deepEqual(absent.atoms(), { [`${p}new`]: true });
});

test('a read-only global store refuses a write, and genuine store failures propagate without broadcasting', async () => {
  const s = setup({ writable: false });
  await assert.rejects(s.run('dismiss', { threadId: 't', key: 'k' }), refused(/^the app's state cannot be written from here$/));
  assert.deepEqual(await s.run('dismissed', { threadId: 't', keys: ['k'] }), { dismissed: [] });
  assert.deepEqual(s.posts, []);
  const failure = new Error('store failed');
  for (const method of ['get', 'set']) {
    const f = setup();
    f.store[method] = async () => { throw failure; };
    await assert.rejects(f.run('dismiss', { threadId: 't', key: 'k' }), (e) => e === failure && !e.refused);
    assert.deepEqual(f.posts, []);
  }
});

test('open runs the app review action; a missing visible chat is refused and other failures propagate', async () => {
  const s = setup();
  for (const view of ['unstaged', 'branch']) assert.deepEqual(await s.run('open', { threadId: 't', path: '/r/a.js', view }), {});
  assert.deepEqual(s.actions, ['unstaged', 'branch'].flatMap((view) => [{ action: { type: 'windows.show_thread', windowId: 'current', threadId: 't' } },
    { action: { type: 'windows.tabs.open', windowId: 'current', target: { type: 'review', view, path: '/r/a.js' }, threadId: 't' } }]));
  const closed = setup({ services: { appActions: { async runInPrimaryWindow() { throw new Error('windows.tabs.open requires a visible thread'); } } } });
  await assert.rejects(closed.run('open', { threadId: 't', path: '/r/a', view: 'branch' }), refused(/^the app shows a diff beside a chat, and no chat is open$/));
  const failure = new Error('open failed');
  const failed = setup({ services: { appActions: { async runInPrimaryWindow() { throw failure; } } } });
  await assert.rejects(failed.run('open', { threadId: 't', path: '/r/a', view: 'branch' }), (e) => e === failure && !e.refused);
});

test('guards reject invalid thread ids, keys, paths and views before using app services; unknown operations refuse', async () => {
  const s = setup({ services: null });
  for (const op of ['dismissed', 'dismiss', 'open']) for (const threadId of [undefined, null, '', ' ', 1, 't'.repeat(201)]) {
    await assert.rejects(s.run(op, { threadId }), refused(/thread id/));
  }
  for (const keys of [undefined, null, {}, ['x', 1], ['x'.repeat(20_001)], Array(1), Array(1001).fill('x')]) await assert.rejects(s.run('dismissed', { threadId: 't', keys }), refused(/comment keys/));
  for (const key of [undefined, null, 1, 'x'.repeat(20_001)]) await assert.rejects(s.run('dismiss', { threadId: 't', key }), refused(/comment key/));
  for (const path of [undefined, null, 1, '', ' ']) await assert.rejects(s.run('open', { threadId: 't', path, view: 'branch' }), refused(/file path/));
  for (const view of [undefined, null, 1, 'last-turn', '']) await assert.rejects(s.run('open', { threadId: 't', path: '/r/a', view }), refused(/view/));
  await assert.rejects(s.run('other', {}), refused(/^unknown operation other$/));
  const valid = setup();
  assert.deepEqual(await valid.run('dismissed', { threadId: 't'.repeat(200), keys: Array(1000).fill('x'.repeat(20_000)) }), { dismissed: [] });
});

test('missing windows and global state refuse, and service calls have finite timeouts', async (t) => {
  for (const services of [null, {}, { projects: { globalState: {} } }]) {
    const s = setup({ services });
    await assert.rejects(s.run('dismissed', { threadId: 't', keys: [] }), refused(/window|global state/));
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.store.get = () => new Promise(() => {});
  const done = assert.rejects(s.run('dismissed', { threadId: 't', keys: [] }), (e) => !e.refused && /did not answer/.test(e.message));
  t.mock.timers.tick(15_000);
  await done;
});
