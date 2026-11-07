// framework-main's Thread services: exact app arguments, server pins without changing the pin source, and refusals before dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./threads.cjs');
const threadOps = ['pin', 'archive-prepare', 'archive-inactive', 'restore-prepare', 'delete', 'open'];

function setup() {
  const calls = [];
  const replies = { list: { threadIds: ['a', 3, 'b', null] }, deleteArchivedThread: { deletedThreadIds: ['t', 9] }, archiveInactiveThread: { archived: true } };
  const method = (name) => async (args) => { calls.push([name, args]); return replies[name]; };
  const services = {
    pinnedThreads: { list: method('list'), set: method('set') },
    managedWorktrees: { registerThreadArchive: method('registerThreadArchive'), registerThreadUnarchive: method('registerThreadUnarchive') },
    threadArchive: { archiveInactiveThread: method('archiveInactiveThread'), deleteArchivedThread: method('deleteArchivedThread') },
    appActions: { runInPrimaryWindow: method('runInPrimaryWindow') },
  };
  let handler;
  const hooks = { onAreaOp(area, fn) { assert.equal(area, 'threads'); handler = fn; }, appHost: { first: () => ({ id: 7, host: { services } }) } };
  register(hooks);
  return { handler, calls, services, replies, hooks };
}

test('every Thread main operation uses the app service and its local/server-pin arguments', async () => {
  const s = setup();
  assert.deepEqual(await s.handler('pinned'), { threadIds: ['a', 'b'] });
  assert.deepEqual(await s.handler('pin', { threadId: 't', pinned: true }), {});
  assert.deepEqual(await s.handler('pin', { threadId: 't', pinned: 'true' }), {});
  assert.deepEqual(await s.handler('archive-prepare', { threadId: 't', cwd: '/repo' }), {});
  assert.deepEqual(await s.handler('archive-prepare', { threadId: 't', cwd: 2 }), {});
  assert.deepEqual(await s.handler('archive-inactive', { threadId: 't' }), { archived: true });
  assert.deepEqual(await s.handler('restore-prepare', { threadId: 't' }), {});
  assert.deepEqual(await s.handler('delete', { threadId: 't' }), { deletedThreadIds: ['t'] });
  s.replies.deleteArchivedThread = ['a', false, 'b'];
  assert.deepEqual(await s.handler('delete', { threadId: 't' }), { deletedThreadIds: ['a', 'b'] });
  assert.deepEqual(await s.handler('open', { threadId: 't' }), {});
  assert.deepEqual(s.calls, [
    ['list', { hostId: 'local', useAppServerPins: true, preservePinSource: true }],
    ['set', { threadId: 't', pinned: true, hostId: 'local', useAppServerPins: true }],
    ['set', { threadId: 't', pinned: false, hostId: 'local', useAppServerPins: true }],
    ['registerThreadArchive', { hostId: 'local', threadId: 't', cwd: '/repo', cleanupWorktree: true }],
    ['registerThreadArchive', { hostId: 'local', threadId: 't', cwd: null, cleanupWorktree: true }],
    ['archiveInactiveThread', { hostId: 'local', threadId: 't', removeCatalogEntryIfMissing: true }],
    ['registerThreadUnarchive', { hostId: 'local', threadId: 't' }],
    ['deleteArchivedThread', { hostId: 'local', threadId: 't' }],
    ['deleteArchivedThread', { hostId: 'local', threadId: 't' }],
    ['runInPrimaryWindow', { action: { type: 'windows.show_thread', windowId: 'current', threadId: 't' } }],
  ]);
  s.replies.list = {};
  s.replies.deleteArchivedThread = null;
  assert.deepEqual(await s.handler('pinned'), { threadIds: [] });
  assert.deepEqual(await s.handler('delete', { threadId: 't' }), { deletedThreadIds: [] });
});

test('all operations that name a thread guard its id before calling services; unknown operations are refused', async () => {
  const s = setup();
  for (const op of threadOps) {
    for (const threadId of [undefined, null, '', '   ', 12, {}, 't'.repeat(201)]) {
      await assert.rejects(s.handler(op, { threadId }), (e) => e.refused === true && /threadId/.test(e.message));
    }
    await assert.rejects(s.handler(op, null), (e) => e.refused === true);
  }
  assert.deepEqual(s.calls, []);
  await assert.rejects(s.handler('unknown'), (e) => e.refused && e.message === 'unknown operation unknown');
  await assert.rejects(s.handler('__proto__', { threadId: 't' }), (e) => e.refused && e.message === 'unknown operation __proto__');
  assert.deepEqual(await s.handler('open', { threadId: 't'.repeat(200) }), {});
});

test('missing windows, services and methods refuse; an attempted service failure throws', async () => {
  for (const op of ['pinned', ...threadOps]) {
    const s = setup();
    s.hooks.appHost.first = () => null;
    await assert.rejects(s.handler(op, { threadId: 't' }), (e) => e.refused === true && /window/.test(e.message));
  }
  for (const [op, service, method] of [
    ['pinned', 'pinnedThreads', 'list'], ['pin', 'pinnedThreads', 'set'],
    ['archive-prepare', 'managedWorktrees', 'registerThreadArchive'], ['restore-prepare', 'managedWorktrees', 'registerThreadUnarchive'],
    ['archive-inactive', 'threadArchive', 'archiveInactiveThread'], ['delete', 'threadArchive', 'deleteArchivedThread'],
    ['open', 'appActions', 'runInPrimaryWindow'],
  ]) {
    const s = setup();
    const saved = s.services[service];
    delete s.services[service];
    await assert.rejects(s.handler(op, { threadId: 't' }), (e) => e.refused === true && e.message.includes(service));
    s.services[service] = saved;
    delete saved[method];
    await assert.rejects(s.handler(op, { threadId: 't' }), (e) => e.refused === true && e.message.includes(method));
    saved[method] = async () => { throw new Error('service failed'); };
    await assert.rejects(s.handler(op, { threadId: 't' }), (e) => !e.refused && e.message === 'service failed');
  }
});

test('a service that never answers has the kit deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.services.pinnedThreads.list = () => new Promise(() => {});
  const done = assert.rejects(s.handler('pinned'), /the app did not answer in 15000 ms/);
  t.mock.timers.tick(15_000);
  await done;
});
