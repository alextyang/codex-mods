import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, installMod, attachWindow, waitFor, sleep, EVAL_HOST, inWorker } from './helpers.mjs';

async function withMod(spec, fn, harnessOpts) {
  const h = await makeHarness(harnessOpts);
  try {
    const mod = await installMod(h.layout, { host: EVAL_HOST, ...spec });
    await h.runtime.activate(mod);
    await fn(h, mod, (body, args) => inWorker(h.runtime, mod.manifest.id, body, args));
  } finally { await h.close(); }
}
const expectCode = async (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); return true; });

// ---------------------------------------------------------------- storage
test('storage: get/set/delete/list in the worker; file is 0600 under data/<id>; retained is separate', async () => {
  await withMod({ id: 'test.st' }, async (h, mod, run) => {
    assert.deepEqual(await run(`
      await ctx.storage.set('a/1', { n: 1 }); await ctx.storage.set('a/2', null); await ctx.storage.set('b', 'x');
      await ctx.storage.retained.set('r', 'kept');
      return { one: await ctx.storage.get('a/1'), nul: await ctx.storage.get('a/2'), missing: (await ctx.storage.get('zzz')) === undefined,
               list: await ctx.storage.list('a/'), all: await ctx.storage.list(), retained: await ctx.storage.retained.get('r'),
               retainedList: await ctx.storage.retained.list() };`),
    { one: { n: 1 }, nul: null, missing: true, list: ['a/1', 'a/2'], all: ['a/1', 'a/2', 'b'], retained: 'kept', retainedList: ['r'] });
    await run(`await ctx.storage.delete('a/1');`);
    assert.deepEqual(await run(`return await ctx.storage.list();`), ['a/2', 'b']);
    const file = join(mod.dataDir, 'store.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(mod.dataDir)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).data, { 'a/2': null, b: 'x' });
    assert.deepEqual(JSON.parse(await readFile(join(mod.retainedDir, 'store.json'), 'utf8')).data, { r: 'kept' });
    assert.deepEqual((await readdir(mod.dataDir)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });
});

test('storage persists across deactivate/activate and rejects non-JSON values', async () => {
  await withMod({ id: 'test.st2' }, async (h, mod, run) => {
    await run(`await ctx.storage.set('k', [1, 2, 3]);`);
    await expectCode(inWorker(h.runtime, mod.manifest.id, `await ctx.storage.set('k', undefined);`), 'Invalid');
    await expectCode(inWorker(h.runtime, mod.manifest.id, `await ctx.storage.set('', 1);`), 'Invalid');
    await h.runtime.deactivate(mod.manifest.id, 'test');
    await h.runtime.activate(mod);
    assert.deepEqual(await run(`return await ctx.storage.get('k');`), [1, 2, 3]);
  });
});

test('storage.transaction: runs in the realm against a snapshot, reads its own writes, commits atomically', async () => {
  await withMod({ id: 'test.tx' }, async (h, mod, run) => {
    await run(`await ctx.storage.set('x', 1); await ctx.storage.set('y', 2);`);
    const out = await run(`
      const r = await ctx.storage.transaction((tx) => {
        const x = tx.get('x'); tx.set('x', x + 10); tx.delete('y'); tx.set('z', tx.get('x') + 1);
        return { sawOwnWrite: tx.get('x'), list: tx.list() };
      });
      return { r, x: await ctx.storage.get('x'), y: (await ctx.storage.get('y')) === undefined, z: await ctx.storage.get('z') };`);
    assert.deepEqual(out, { r: { sawOwnWrite: 11, list: ['x', 'z'] }, x: 11, y: true, z: 12 });
    // a throwing transaction commits nothing
    await expectCode(inWorker(h.runtime, mod.manifest.id, `await ctx.storage.transaction((tx) => { tx.set('x', 999); throw new Error('abort'); });`), null);
    assert.equal(await run(`return await ctx.storage.get('x');`), 11);
    // an async function is refused
    await expectCode(inWorker(h.runtime, mod.manifest.id, `await ctx.storage.transaction(async (tx) => { tx.set('x', 5); });`), 'Invalid');
    assert.equal(await run(`return await ctx.storage.get('x');`), 11);
  });
});

test('storage Conflict race: a commit based on a stale snapshot is refused; the winner is intact', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.race', renderer: 'export default {};' });
    await h.runtime.activate(mod);
    const a = attachWindow(h.runtime, 1); const b = attachWindow(h.runtime, 2);
    const ca = a.ctx('test.race'); const cb = b.ctx('test.race');
    await ca.storage.set('n', 0);
    a.realmPort.hold = (m) => m.t === 'call' && m.method === 'commit'; // delay A's commit until B has written
    const slow = ca.storage.transaction((tx) => { tx.set('n', tx.get('n') + 100); });
    await waitFor(() => a.realmPort.held.length === 1, { what: 'held commit' });
    await cb.storage.set('n', 5);                 // a concurrent commit from another realm wins
    a.realmPort.release();
    await assert.rejects(slow, (e) => e.code === 'Conflict');
    assert.equal(await cb.storage.get('n'), 5);
    // retrying against the new snapshot succeeds
    a.realmPort.hold = undefined;
    await ca.storage.transaction((tx) => { tx.set('n', tx.get('n') + 100); });
    assert.equal(await cb.storage.get('n'), 105);
  } finally { await h.close(); }
});

test('storage: concurrent increments from several transactions end exact (conflicts are retried by the caller)', async () => {
  await withMod({ id: 'test.inc' }, async (h, mod, run) => {
    const out = await run(`
      let conflicts = 0;
      const inc = async () => { for (;;) { try { await ctx.storage.transaction((tx) => { tx.set('n', (tx.get('n') ?? 0) + 1); }); return; }
        catch (e) { if (e.code !== 'Conflict') throw e; conflicts++; } } };
      await Promise.all(Array.from({ length: 12 }, inc));
      return { n: await ctx.storage.get('n'), conflicts };`);
    assert.equal(out.n, 12);
    assert.ok(out.conflicts >= 1, 'at least one transaction raced and was refused');
  });
});

test('storage.watch fires after commits from any realm, filtered by prefix', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.watch', host: EVAL_HOST, renderer: 'export default {};' });
    await h.runtime.activate(mod);
    const w = attachWindow(h.runtime);
    const c = w.ctx('test.watch');
    const seen = [];
    const d = c.storage.watch('items/', (keys) => seen.push(keys));
    const retainedSeen = [];
    c.storage.retained.watch('', (keys) => retainedSeen.push(keys));
    await sleep(30);
    await inWorker(h.runtime, 'test.watch', `await ctx.storage.set('items/1', 1); await ctx.storage.set('other', 1); await ctx.storage.retained.set('q', 1);
      await ctx.storage.transaction((tx) => { tx.set('items/2', 2); tx.set('items/3', 3); tx.set('zzz', 0); });`);
    await waitFor(() => seen.length >= 2, { what: 'watch events' });
    assert.deepEqual(seen, [['items/1'], ['items/2', 'items/3']]);
    assert.deepEqual(retainedSeen, [['q']]);
    d.dispose();
    await inWorker(h.runtime, 'test.watch', `await ctx.storage.set('items/9', 1);`);
    await sleep(50);
    assert.equal(seen.length, 2);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- settings
test('settings: one flat document, defaults from the declarations, file values win, settingsChanged fans out to every realm', async () => {
  const h = await makeHarness();
  try {
    const schema = [{ key: 'prompt', kind: 'text', title: 'Prompt', default: 'hello' }, { key: 'limit', kind: 'number', title: 'Limit', default: 3 }, { group: 'Nested', items: [{ key: 'on', kind: 'toggle', title: 'On', default: true }] }];
    const mod = await installMod(h.layout, { id: 'test.set', host: EVAL_HOST, renderer: 'export default {};', settings: schema });
    await h.runtime.activate(mod);
    const run = (body, args) => inWorker(h.runtime, 'test.set', body, args);
    assert.deepEqual(await run(`return await ctx.settings.get();`), { prompt: 'hello', limit: 3, on: true });
    await run(`ctx.settings.onChange((v) => ctx.storage.set('seen', v));`);
    const w = attachWindow(h.runtime);
    const c = w.ctx('test.set');
    const got = []; c.settings.onChange((v) => got.push(v));
    await sleep(30);
    h.runtime.settingsChanged('test.set', { prompt: 'bye', limit: 3, on: false });
    await waitFor(() => got.length === 1, { what: 'renderer onChange' });
    assert.deepEqual(got[0], { prompt: 'bye', limit: 3, on: false });
    assert.deepEqual(w.control.filter((m) => m.t === 'settings').at(-1), { t: 'settings', modId: 'test.set', value: got[0] });
    await waitFor(async () => (await run(`return await ctx.storage.get('seen');`)) !== null);
    assert.deepEqual(await run(`return await ctx.storage.get('seen');`), got[0]);
    assert.deepEqual(await run(`return await ctx.settings.get();`), got[0]);
    assert.deepEqual(await c.settings.get(), got[0]);
  } finally { await h.close(); }
});

test('settings: a settings.json written by Operations is read, with defaults filled in', async () => {
  const h = await makeHarness();
  try {
    const { writeJsonAtomic } = await import('../../fsutil.mjs');
    const mod = await installMod(h.layout, { id: 'test.set2', host: EVAL_HOST, settings: [{ key: 'a', kind: 'text', title: 'A', default: 'A' }, { key: 'b', kind: 'number', title: 'B', default: 2 }] });
    await writeJsonAtomic(join(mod.dataDir, 'settings.json'), { b: 9 });
    await h.runtime.activate(mod);
    assert.deepEqual(await inWorker(h.runtime, 'test.set2', `return await ctx.settings.get();`), { a: 'A', b: 9 });
  } finally { await h.close(); }
});

test('settings (SDK v2, systems.md E3): a key\'s effective value at a thread through its project, set and reset as the mod, and onChange with what changed', async () => {
  const T = { type: 'CodexThread', provider: 'codex', id: 't1' }, P = { type: 'LocalProject', provider: 'codex', id: 'p1' };
  // The graph needs a ref's type: a thread given as {provider, id} is resolved as the Thread concept.
  const graph = { resolve: (ref) => (ref.id === 't1' && typeof ref.type === 'string' ? { ref: T, links: { project: P } } : null) };
  const h = await makeHarness({ graph });
  try {
    const { writeJsonAtomic } = await import('../../fsutil.mjs');
    const settings = [{ key: 'model', kind: 'choice', title: 'Model', description: 'Which', default: 'a', scope: 'thread', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }];
    const mod = await installMod(h.layout, { id: 'test.set3', host: EVAL_HOST, renderer: 'export default {};', settings });
    await writeJsonAtomic(join(mod.dataDir, 'settings.scopes.json'), { 'project:codex:p1': { model: 'b' } });
    const writes = [];
    h.runtime.setSettingsWriter(async (modId, patches) => { writes.push([modId, patches]); return { id: 'op-0000000000000001', outcome: patches[0].value === 'x' ? 'failed' : 'succeeded', error: { code: 'Invalid', message: 'no' } }; });
    await h.runtime.activate(mod);
    const run = (body) => inWorker(h.runtime, 'test.set3', body);
    assert.deepEqual(await run(`return await ctx.settings.get();`), { model: 'a' }, 'the document: every declared key');
    assert.equal(await run(`return await ctx.settings.get('model', { thread: ${JSON.stringify(T)} });`), 'b', 'the thread\'s project\'s');
    assert.equal(await run(`return await ctx.settings.get('model', { thread: { provider: 'codex', id: 't1' } });`), 'b', 'a thread given without its type');
    assert.equal(await run(`return await ctx.settings.get('model', { project: ${JSON.stringify({ ...P, id: 'p2' })} });`), 'a');
    await assert.rejects(run(`return await ctx.settings.get('model', { thread: ${JSON.stringify(T)}, project: ${JSON.stringify(P)} });`), /brings its own project/);
    assert.deepEqual(await run(`return await ctx.settings.set('model', 'b', { scope: { thread: ${JSON.stringify(T)} } });`), { opId: 'op-0000000000000001' });
    await run(`return await ctx.settings.reset('model');`);
    assert.deepEqual(writes.map(([m, p]) => [m, p[0].unset === true, p[0].scope]), [['test.set3', false, { thread: T }], ['test.set3', true, 'app']], 'as the mod itself');
    await assert.rejects(run(`return await ctx.settings.set('model', 'x');`), /no/, 'the operation\'s refusal');
    // A renderer realm hears what changed: the document, and the key, the scope and the new effective value there.
    const w = attachWindow(h.runtime);
    const c = w.ctx('test.set3');
    const got = []; c.settings.onChange((doc, change) => got.push([doc, change]));
    await sleep(30);
    await writeJsonAtomic(join(mod.dataDir, 'settings.scopes.json'), { 'thread:codex:t1': { model: 'a' } });
    await h.runtime.settingsChanged('test.set3', { model: 'a' }, [{ key: 'model', scope: 'thread:codex:t1' }]);
    await waitFor(() => got.length === 1, { what: 'onChange' });
    assert.deepEqual(got[0], [{ model: 'a' }, { key: 'model', scope: { thread: { provider: 'codex', id: 't1' } }, value: 'a' }]);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- events
test('events: emit only under mod/<ownId>/; on() with exact and prefix patterns, state replay, state()', async () => {
  const h = await makeHarness();
  try {
    const a = await installMod(h.layout, { id: 'test.ea', host: EVAL_HOST });
    const b = await installMod(h.layout, { id: 'test.eb', host: EVAL_HOST });
    await h.runtime.activate(a); await h.runtime.activate(b);
    const runA = (body, args) => inWorker(h.runtime, 'test.ea', body, args);
    const runB = (body, args) => inWorker(h.runtime, 'test.eb', body, args);
    h.bus.publish('framework/compat', { status: 'compatible' }, { state: true });
    await runB(`globalThis.got = []; ctx.events.on('mod/test.ea/*', (d, t) => globalThis.got.push([t, d]));
                globalThis.st = []; ctx.events.on('framework/compat', (d, t) => globalThis.st.push(d), { replay: 'state' });`);
    await runA(`ctx.events.emit('mod/test.ea/hello', { x: 1 }); ctx.events.emit('mod/test.ea/again', 2);`);
    await expectCode(runA(`ctx.events.emit('mod/test.eb/steal', 1);`), 'Denied');
    await expectCode(runA(`ctx.events.emit('framework/fault', 1);`), 'Denied');
    await expectCode(runA(`ctx.events.emit('mod/test.ea/*', 1);`), 'Denied');
    await waitFor(async () => (await runB(`return globalThis.got.length;`)) === 2, { what: 'events' });
    assert.deepEqual(await runB(`return globalThis.got;`), [['mod/test.ea/hello', { x: 1 }], ['mod/test.ea/again', 2]]);
    assert.deepEqual(await runB(`return globalThis.st;`), [{ status: 'compatible' }]);
    assert.deepEqual(await runB(`return await ctx.events.state('framework/compat');`), { status: 'compatible' });
    assert.equal(await runB(`return (await ctx.events.state('nothing/here')) === undefined;`), true);
    // the Host also enforces it, whatever the client does
    attachWindow(h.runtime);
    await h.runtime.deactivate('test.eb', 'x');
    assert.ok(h.events.some((e) => e.topic === 'mod/test.ea/hello'));
  } finally { await h.close(); }
});

test('events: a Host-side refusal reaches a realm that bypasses the client check', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.eh', renderer: 'export default {};' });
    await h.runtime.activate(mod);
    const w = attachWindow(h.runtime);
    const replies = [];
    w.realmPort.onMessage((m) => { if (m.t === 'result') replies.push(m); });
    w.post({ t: 'call', id: 1, modId: 'test.eh', ns: 'events', method: 'emit', args: ['mod/other.mod/x', 1] });
    await waitFor(() => replies.length === 1);
    assert.equal(replies[0].error.code, 'Denied');
    w.post({ t: 'call', id: 2, modId: 'test.eh', ns: 'nope', method: 'x', args: [] });
    w.post({ t: 'call', id: 3, modId: 'test.eh', ns: 'events', method: 'constructor', args: [] });
    w.post({ t: 'call', id: 4, modId: 'not.installed', ns: 'events', method: 'state', args: ['x'] });
    await waitFor(() => replies.length === 4);
    assert.deepEqual(replies.slice(1).map((r) => r.error.code), ['Invalid', 'Invalid', 'Unavailable']);
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- services
test('services: provide/call between mods, Unavailable when absent or disabled, Conflict on duplicate, error codes cross', async () => {
  const h = await makeHarness();
  try {
    const p = await installMod(h.layout, { id: 'test.prov', host: EVAL_HOST });
    const c = await installMod(h.layout, { id: 'test.cons', host: EVAL_HOST });
    await h.runtime.activate(p); await h.runtime.activate(c);
    const runP = (body, args) => inWorker(h.runtime, 'test.prov', body, args);
    const runC = (body, args) => inWorker(h.runtime, 'test.cons', body, args);
    await runP(`ctx.services.provide('math', {
      add: ({ a, b }) => a + b,
      slow: async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return 'done'; },
      busy: () => { const e = new Error('too many'); e.code = 'Busy'; throw e; },
      plain: () => { throw new Error('plain failure'); },
    });`);
    assert.equal(await runC(`return await ctx.services.call('test.prov', 'math', 'add', { a: 2, b: 3 });`), 5);
    assert.equal(await runC(`return await ctx.services.call('test.prov', 'math', 'slow', { ms: 30 });`), 'done');
    await expectCode(runC(`return await ctx.services.call('test.prov', 'math', 'nope');`), 'Invalid');
    await expectCode(runC(`return await ctx.services.call('test.prov', 'ghost', 'add');`), 'Unavailable');
    await expectCode(runC(`return await ctx.services.call('test.nobody', 'math', 'add');`), 'Unavailable');
    await expectCode(runC(`return await ctx.services.call('framework', 'ghost', 'add');`), 'Unavailable');
    await expectCode(runC(`return await ctx.services.call('test.prov', 'math', 'plain');`), 'Invalid');
    await expectCode(runP(`ctx.services.provide('math', { add: () => 1 }); await new Promise((r) => setTimeout(r, 50)); throw new Error('unreachable');`), null);
    // the duplicate registration surfaced asynchronously (as a worker fault) and did not replace the original
    assert.equal(await runC(`return await ctx.services.call('test.prov', 'math', 'add', { a: 1, b: 1 });`), 2);
    await sleep(50);
    assert.ok(h.topic('framework/fault').some((f) => f.modId === 'test.prov' && /already provided/.test(f.message)));
    // a lease may call only its owner's services
    assert.equal(await h.runtime.callServiceForLease('mod:test.prov', { name: 'math', method: 'add', args: { a: 4, b: 4 } }), 8);
    await expectCode(h.runtime.callServiceForLease('mod:test.cons', { name: 'math', method: 'add', args: { a: 4, b: 4 } }), 'Unavailable');
    // disabled provider → Unavailable
    await h.runtime.deactivate('test.prov', 'disable');
    await expectCode(runC(`return await ctx.services.call('test.prov', 'math', 'add', { a: 1, b: 2 });`), 'Unavailable');
    await expectCode(h.runtime.callServiceForLease('mod:test.prov', { name: 'math', method: 'add', args: {} }), 'Unavailable');
  } finally { await h.close(); }
});

test('services: framework services via provideFrameworkService, with the caller identity', async () => {
  await withMod({ id: 'test.fw' }, async (h, mod, run) => {
    const d = h.runtime.provideFrameworkService('updates', { check: (args, caller) => ({ args, caller }) });
    assert.throws(() => h.runtime.provideFrameworkService('updates', {}), { code: 'Conflict' });
    assert.deepEqual(await run(`return await ctx.services.call('framework', 'updates', 'check', { v: 1 });`), { args: { v: 1 }, caller: 'mod:test.fw' });
    d.dispose();
    await expectCode(inWorker(h.runtime, 'test.fw', `return await ctx.services.call('framework', 'updates', 'check');`), 'Unavailable');
  });
});

test('services: a renderer realm can provide and call services', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.rs', host: EVAL_HOST, renderer: 'export default {};' });
    await h.runtime.activate(mod);
    const w1 = attachWindow(h.runtime, 1); const w2 = attachWindow(h.runtime, 2);
    const c1 = w1.ctx('test.rs'); const c2 = w2.ctx('test.rs');
    c1.services.provide('ui', { who: () => 'window-1' });
    c2.services.provide('ui', { who: () => 'window-2' }); // another window may also provide it
    await sleep(50);
    assert.equal(await c2.services.call('test.rs', 'ui', 'who'), 'window-1');
    assert.equal(await inWorker(h.runtime, 'test.rs', `return await ctx.services.call('test.rs', 'ui', 'who');`), 'window-1');
    w1.disposable.dispose();
    assert.equal(await c2.services.call('test.rs', 'ui', 'who'), 'window-2');
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- permissions and app-server
test('permissions: every guarded method is Denied without its grant', async () => {
  await withMod({ id: 'test.deny' }, async (h, mod, run) => {
    for (const [what, body] of [
      ['secrets.get', `await ctx.secrets.get('x')`], ['secrets.set', `await ctx.secrets.set('x', 'y')`], ['secrets.delete', `await ctx.secrets.delete('x')`],
      ['request', `await ctx.appServer.request('thread/list')`],
      ['intercept', `ctx.appServer.intercept('clientRequest', ['thread/list'], () => {}); await new Promise((r) => setTimeout(r, 50));`],
      ['backends.define', `await ctx.appServer.backends.define('b')`], ['backends.remove', `await ctx.appServer.backends.remove('b')`], ['backends.list', `await ctx.appServer.backends.list()`],
      ['clients.issue', `await ctx.appServer.clients.issue({ name: 'x' })`], ['clients.revoke', `await ctx.appServer.clients.revoke('l')`],
      ['processes.start', `await ctx.processes.start('p')`], ['processes.call', `await ctx.processes.call('p', 'm')`],
    ]) {
      if (what === 'intercept') {
        // a refused registration cannot throw synchronously; it surfaces as a fault in the worker
        await run(body);
        await waitFor(() => h.topic('framework/fault').some((f) => /not been granted/.test(f.message)), { what: 'intercept refusal' });
        continue;
      }
      await expectCode(inWorker(h.runtime, 'test.deny', body), 'Denied');
    }
    // observe/notify cannot throw synchronously: a refused observe surfaces as a worker fault, a refused notify is dropped
    await run(`ctx.appServer.observe({ methods: '*' }, () => {}); ctx.appServer.notify('thread/list'); return 1;`);
    await waitFor(() => h.topic('framework/fault').filter((f) => /not been granted/.test(f.message)).length >= 2, { what: 'observe refusal' });
    assert.equal(h.mux.clients.get('mod:test.deny').notifies.length, 0);
    assert.equal(h.mux.clients.get('mod:test.deny').requests.length, 0);
    assert.equal(h.mux.clients.get('mod:test.deny').observers.length, 0);
    assert.equal(h.mux.clients.get('mod:test.deny').interceptors.length, 0);
  });
});

test('appServer: request/notify within the granted methods; Denied outside; calls reach the MuxClient', async () => {
  await withMod({ id: 'test.req', grants: ['appServer.request:thread/,turn/start', 'appServer.observe:thread/'] }, async (h, mod, run) => {
    assert.deepEqual(await run(`return await ctx.appServer.request('thread/list', { a: 1 }, { timeoutMs: 500 });`), { echo: { method: 'thread/list', params: { a: 1 } } });
    await run(`ctx.appServer.notify('turn/start', { t: 1 }); await ctx.appServer.request('turn/start'); return 1;`);
    await expectCode(inWorker(h.runtime, 'test.req', `await ctx.appServer.request('account/read')`), 'Denied');
    await run(`ctx.appServer.notify('account/read'); await ctx.appServer.request('turn/start'); return 1;`);
    const c = h.mux.clients.get('mod:test.req');
    assert.equal(c.requests[0].o.timeoutMs, 500);
    // a mod cannot pass the graph's internal `intent` (it would skip the mux's journal claim): only backend and timeoutMs reach the mux
    await run(`return await ctx.appServer.request('thread/list', {}, { intent: 'forged', backend: 'b1', timeoutMs: 9, extra: 1 });`);
    assert.deepEqual(c.requests.at(-1).o, { backend: 'b1', timeoutMs: 9 });
    assert.deepEqual(c.notifies.map((n) => n.method), ['turn/start']);
  });
});

test('appServer.observe: events (including Gap) reach the realm; disposal and deactivation dispose the Mux registration', async () => {
  await withMod({ id: 'test.obs', grants: ['appServer.observe'] }, async (h, mod, run) => {
    await run(`globalThis.seen = []; globalThis.d = ctx.appServer.observe({ kinds: ['serverNotification'], methods: ['turn/'] }, (m, info) => globalThis.seen.push([m, info]), { queue: 8 });`);
    const c = h.mux.clients.get('mod:test.obs');
    await waitFor(() => c.observers.length === 1);
    assert.deepEqual(c.observers[0].filter, { kinds: ['serverNotification'], methods: ['turn/'] });
    assert.equal(c.observers[0].o.queue, 8);
    c.observers[0].listener({ method: 'turn/started', params: { threadId: 't1' } }, { kind: 'serverNotification', method: 'turn/started', origin: 'app', backend: 'primary' });
    c.observers[0].listener({ gap: { from: 2, to: 4, reason: 'overflow' } }, null);
    await waitFor(async () => (await run(`return globalThis.seen.length;`)) === 2);
    const seen = await run(`return globalThis.seen;`);
    assert.equal(seen[0][0].method, 'turn/started'); assert.equal(seen[0][1].backend, 'primary');
    assert.deepEqual(seen[1], [{ gap: { from: 2, to: 4, reason: 'overflow' } }, null]);
    await run(`globalThis.d.dispose();`);
    await waitFor(() => c.observers[0].disposed, { what: 'observer disposed' });
  });
});

test('appServer.intercept: the handler runs in the worker; results, pass, deadline and errors', async () => {
  await withMod({ id: 'test.int', grants: ['appServer.intercept:thread/compact/start,thread/list'] }, async (h, mod, run) => {
    await run(`
      ctx.appServer.intercept('clientRequest', ['thread/compact/start'], (m, info) => {
        if (m.params?.pass) return undefined;
        return { respond: { result: { handledBy: 'mod', origin: info.origin, id: m.id } } };
      }, { priority: 5, timeoutMs: 300, onError: 'reject' });
      ctx.appServer.intercept('clientRequest', ['thread/list'], async (m) => { if (m.params?.hang) await new Promise(() => {}); if (m.params?.throw) throw new Error('handler broke'); return { replace: { ...m, params: { replaced: true } } }; },
        { timeoutMs: 200 });`);
    const c = h.mux.clients.get('mod:test.int');
    await waitFor(() => c.interceptors.length === 2);
    assert.equal(c.interceptors[0].o.priority, 5); assert.equal(c.interceptors[0].o.onError, 'reject'); assert.equal(c.interceptors[0].o.timeoutMs, 300);
    const r1 = await h.mux.runInterceptors('mod:test.int', 'clientRequest', { id: 7, method: 'thread/compact/start', params: {} }, { kind: 'clientRequest', method: 'thread/compact/start', origin: 'app', backend: 'primary' });
    assert.deepEqual(r1, { respond: { result: { handledBy: 'mod', origin: 'app', id: 7 } } });
    assert.equal(await h.mux.runInterceptors('mod:test.int', 'clientRequest', { id: 8, method: 'thread/compact/start', params: { pass: true } }), undefined);
    const r3 = await c.interceptors[1].handler({ id: 9, method: 'thread/list', params: {} }, {});
    assert.deepEqual(r3, { replace: { id: 9, method: 'thread/list', params: { replaced: true } } });
    await assert.rejects(c.interceptors[1].handler({ id: 10, method: 'thread/list', params: { throw: true } }, {}), (e) => e.code === 'Invalid' && /handler broke/.test(e.message));
    const t0 = Date.now();
    await assert.rejects(c.interceptors[1].handler({ id: 11, method: 'thread/list', params: { hang: true } }, {}), (e) => e.code === 'OutcomeUnknown');
    assert.ok(Date.now() - t0 < 200 + 10000);
    // not within the grant
    await run(`ctx.appServer.intercept('clientRequest', ['account/read'], () => {});`);
    await waitFor(() => h.topic('framework/fault').some((f) => /not granted for account\/read/.test(f.message)));
    assert.equal(c.interceptors.length, 2);
    await run(`ctx.appServer.intercept('clientRequest', '*', () => {});`);
    await waitFor(() => h.topic('framework/fault').some((f) => /needs the bare/.test(f.message)));
    // deactivating disposes the registrations and the client
    await h.runtime.deactivate('test.int', 'test');
    assert.ok(c.disposed);
    assert.deepEqual(h.mux.calls.at(-1), ['disposeOwner', 'mod:test.int']);
  });
});

test('appServer.intercept: the timeout is clamped to 30 s and defaults to 1 s', async () => {
  await withMod({ id: 'test.clamp', grants: ['appServer.intercept'] }, async (h, mod, run) => {
    await run(`ctx.appServer.intercept('serverNotification', '*', () => {}, { timeoutMs: 999999 }); ctx.appServer.intercept('serverNotification', ['a/'], () => {});`);
    const c = h.mux.clients.get('mod:test.clamp');
    await waitFor(() => c.interceptors.length === 2);
    assert.equal(c.interceptors[0].o.timeoutMs, 30000);
    assert.equal(c.interceptors[1].o.timeoutMs, 1000);
  });
});

test('appServer.backends: define creates the mod-relative CODEX_HOME, list strips the owner, remove can delete data; paths cannot escape', async () => {
  await withMod({ id: 'test.be', grants: ['appServer.backends'] }, async (h, mod, run) => {
    await run(`await ctx.appServer.backends.define('work', { env: { A: '1' }, args: ['--x'], idleStopMs: 5000 });
               await ctx.appServer.backends.define('other', { codexHome: 'nested/home' });`);
    const def = h.mux.backends.get('mod:test.be/work').def;
    assert.equal(def.codexHome, join(mod.backendsDir, 'work')); assert.deepEqual(def.env, { A: '1' }); assert.equal(def.idleStopMs, 5000);
    assert.equal(h.mux.backends.get('mod:test.be/other').def.codexHome, join(mod.backendsDir, 'nested/home'));
    assert.equal((await stat(def.codexHome)).mode & 0o777, 0o700);
    assert.deepEqual((await run(`return await ctx.appServer.backends.list();`)).map((b) => b.key).sort(), ['other', 'work']);
    await expectCode(inWorker(h.runtime, 'test.be', `await ctx.appServer.backends.define('x', { codexHome: '../../escape' })`), 'Invalid');
    await expectCode(inWorker(h.runtime, 'test.be', `await ctx.appServer.backends.define('x', { codexHome: '/abs' })`), 'Invalid');
    await expectCode(inWorker(h.runtime, 'test.be', `await ctx.appServer.backends.define('bad key!')`), 'Invalid');
    await run(`await ctx.appServer.backends.remove('work', { deleteData: true });`);
    await assert.rejects(stat(def.codexHome));
    assert.deepEqual(await run(`return (await ctx.appServer.backends.list()).map((b) => b.key);`), ['other']);
  });
});

test('appServer.clients: leases are issued to the mod, only its own can be revoked, and deactivation revokes them via disposeOwner', async () => {
  await withMod({ id: 'test.cl', grants: ['appServer.clients'] }, async (h, mod, run) => {
    const lease = await run(`return await ctx.appServer.clients.issue({ name: 'imessage' });`);
    assert.deepEqual(Object.keys(lease).sort(), ['id', 'socketPath', 'token']);
    assert.deepEqual(h.mux.calls.find((c) => c[0] === 'issueLease'), ['issueLease', 'mod:test.cl', 'imessage']);
    await expectCode(inWorker(h.runtime, 'test.cl', `await ctx.appServer.clients.revoke('somebody-elses')`), 'Denied');
    await run(`await ctx.appServer.clients.revoke(args);`, lease.id);
    assert.ok(h.mux.calls.some((c) => c[0] === 'revokeLease' && c[1] === lease.id));
    await expectCode(inWorker(h.runtime, 'test.cl', `await ctx.appServer.clients.issue({})`), 'Invalid');
  });
});

// ---------------------------------------------------------------- log
test('log: JSONL under layout.logs/<modId>.log', async () => {
  await withMod({ id: 'test.log' }, async (h, mod, run) => {
    await run(`ctx.log.info('hello', { a: 1 }); ctx.log.warn('careful'); ctx.log.debug('d'); ctx.log.error('bad', { code: 5 }); return 1;`);
    await sleep(100);
    await h.runtime.deactivate('test.log', 'flush');
    const lines = (await readFile(join(h.layout.logs, 'test.log.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.level, l.msg]), [['info', 'hello'], ['warn', 'careful'], ['debug', 'd'], ['error', 'bad']]);
    assert.deepEqual(lines[0].data, { a: 1 });
    assert.equal(lines[0].realm, 'host');
    assert.equal((await stat(join(h.layout.logs, 'test.log.log'))).mode & 0o777, 0o600);
  });
});

test('log: rotates at 1 MB and rate-limits a flood', async () => {
  const { createModLogger } = await import('../../ctx/log.mjs');
  const { makeRoot } = await import('./helpers.mjs');
  const r = await makeRoot();
  try {
    const file = join(r.layout.logs, 'rot.log');
    const l = createModLogger({ file, maxBytes: 2000, ratePerSecond: 1e9 });
    for (let i = 0; i < 100; i++) l.write('info', `line ${i} ${'x'.repeat(50)}`);
    await l.flush();
    const names = await readdir(r.layout.logs);
    assert.deepEqual(names.sort(), ['rot.log', 'rot.log.1']);
    assert.ok((await stat(file)).size <= 2000 && (await stat(`${file}.1`)).size <= 2000);
    assert.equal(l.recent().length, 100);

    let t = 0;
    const f = createModLogger({ file: join(r.layout.logs, 'flood.log'), ratePerSecond: 5, clock: () => t });
    for (let i = 0; i < 50; i++) f.write('info', `x${i}`);
    t = 2000; f.write('info', 'later'); await f.flush();
    const lines = (await readFile(join(r.layout.logs, 'flood.log'), 'utf8')).trim().split('\n').map((x) => JSON.parse(x).msg);
    assert.deepEqual(lines.slice(0, 5), ['x0', 'x1', 'x2', 'x3', 'x4']);
    assert.match(lines[5], /45 line\(s\) dropped/);
    assert.equal(lines[6], 'later');
  } finally { await r.cleanup(); }
});

test('service calls: Unavailable only if never dispatched; OutcomeUnknown once dispatched (deadline or provider gone)', async () => {
  const h = await makeHarness({ internals: { serviceDeadlineMs: 300 } });
  try {
    const p = await installMod(h.layout, { id: 'test.op', host: EVAL_HOST });
    const c = await installMod(h.layout, { id: 'test.oc', host: EVAL_HOST });
    await h.runtime.activate(p); await h.runtime.activate(c);
    const runP = (body) => inWorker(h.runtime, 'test.op', body);
    const runC = (body) => inWorker(h.runtime, 'test.oc', body);
    await runP(`ctx.services.provide('s', { hang: () => new Promise(() => {}), die: () => { process.exit(4); }, ok: () => 'ok' });`);
    // never dispatched: no such provider / method
    await expectCode(runC(`return await ctx.services.call('test.nobody', 's', 'ok');`), 'Unavailable');
    // dispatched, no reply before the deadline
    const t0 = Date.now();
    await expectCode(runC(`return await ctx.services.call('test.op', 's', 'hang');`), 'OutcomeUnknown');
    assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 300 + 10000);
    // dispatched, then the provider's realm disappears
    await expectCode(runC(`return await ctx.services.call('test.op', 's', 'die');`), 'OutcomeUnknown');
    await waitFor(() => h.runtime.status('test.op') === 'inactive');
    // provider now gone: nothing is dispatched
    await expectCode(runC(`return await ctx.services.call('test.op', 's', 'ok');`), 'Unavailable');
  } finally { await h.close(); }
});
