// ctx.graph in the renderer realm and the framework's own scope on the renderer channel (docs/design/presentations.md V6):
//   - a mod's renderer has the reads (resolve, list, related, types, can, subscribe) and `invoke` as the mod, behind the `graph` grant;
//     everything else of ctx.graph is the host realm's, and the Host answers Denied; the process realm stays out;
//   - the page runtime (not a mod) names the reserved id codexmods.framework on the renderer channel: the graph's reads and `invoke` as
//     {kind: 'framework'}, no other namespace, and no way to claim the id from a worker, a process or as a mod;
//   - the page's replica (framework/shared/graph-replica.mjs) fed by a framework view over the real channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, installMod, attachWindow, waitFor, sleep, portPair, EVAL_HOST, inWorker } from './helpers.mjs';
import { createGraph } from '../../graph/index.mjs';
import { toDescriptor, defineConcept, s, op } from '../../../../sdk/graph/define.mjs';
import { createGraphNs } from '../../ctx/graph.mjs';
import { Channel, FLOW_WINDOW } from '../channel.mjs';
import { FRAMEWORK_MOD_ID } from '../index.mjs';
import { createReplica } from '../../../shared/graph-replica.mjs';

const FW = 'codexmods.framework';
const Doc = defineConcept('Doc', { state: { title: s.string() }, operations: { touch: op({ args: [s.string()] }) } });
const docRef = (id) => ({ type: 'Doc', provider: 'docs', id });

/** A graph with a Doc type and a provider `docs` that counts onObserve; a runtime over it; a window; and mods with a renderer. */
async function setup({ mods = [] } = {}) {
  const graph = createGraph();
  graph.registerTypes([toDescriptor(Doc)], 'native');
  const observed = [], touched = [];
  const provider = graph.registerProvider('native', 'docs', {
    types: { Doc: { operations: { touch: { effect: 'none', handler: ({ args, caller, origin }) => { touched.push({ arg: args[0], caller, origin }); return `touched ${args[0]}`; } } } } },
    onObserve: (query) => { observed.push(query); },
  });
  provider.put(docRef('d1'), { state: { title: 'One' } });
  const h = await makeHarness({ graph });
  for (const m of mods) await h.runtime.activate(await installMod(h.layout, { renderer: 'export default {};', ...m }));
  const w = attachWindow(h.runtime, 1);
  return { h, graph, provider, observed, touched, w };
}
const errorsOf = (w) => w.control.filter((m) => m.t === 'sub-error').map((m) => m.error);
/** Post a raw message from the window and return the reply to it (a `result` for calls, an error `event` for registrations). */
async function raw(w, msg) {
  const key = msg.t === 'call' ? 'id' : msg.t === 'sub' ? 'sub' : 'handler';
  const replies = [];
  const off = w.realmPort.onMessage((m) => replies.push(m));
  w.post(msg);
  const reply = await waitFor(() => replies.find((m) => (msg.t === 'call' ? m.t === 'result' : m.t === 'event') && (msg.t === 'call' ? m.id : m.sub) === msg[key]), { what: `a reply to ${msg.t}` });
  off.dispose();
  return reply;
}
let n = 5000;
const call = (modId, method, ...args) => ({ t: 'call', id: ++n, modId, ns: 'graph', method, args });

// ------------------------------------------------------------------ a mod's renderer realm
test('renderer realm: the reads and invoke work behind the graph grant; invoke is made as the mod, with the mod id as origin', async () => {
  const { h, graph, touched, w } = await setup({ mods: [{ id: 'test.gr', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }] });
  try {
    const c = w.ctx('test.gr');
    assert.deepEqual(Object.keys(c.graph).sort(), ['assess', 'attached', 'can', 'invoke', 'list', 'query', 'related', 'resolve', 'search', 'subscribe', 'types']);
    assert.equal((await c.graph.resolve(docRef('d1'))).state.title, 'One');
    assert.deepEqual((await c.graph.list('Doc')).map((x) => x.ref.id), ['d1']);
    assert.deepEqual((await c.graph.list('Doc', { title: 'Nope' })), []);
    const page = await c.graph.query({ type: 'Doc', where: { title: 'One' }, limit: 1 });
    assert.deepEqual([page.items.map((x) => x.ref.id), page.next], [['d1'], undefined], 'query in the renderer realm, as the mod reads');
    assert.equal(await c.graph.related(docRef('d1'), 'nothing').catch((e) => e.code), 'Invalid', 'an unknown relation is the graph\'s Invalid');
    assert.ok((await c.graph.types()).some((t) => t.id === 'Doc' && t.concept === 'Doc'));
    assert.equal(await c.graph.can(docRef('d1'), 'touch'), true);
    assert.equal(await c.graph.can(docRef('d1'), 'nope'), false);
    assert.equal(await c.graph.resolve({ type: 'Doc', provider: 'docs', id: 'zz' }), null);
    await assert.rejects(c.graph.resolve(null), (e) => e.code === 'Invalid');
    await assert.rejects(c.graph.can('d1', 'touch'), (e) => e.code === 'Invalid');
    const seen = [];
    graph.onOperation((e) => seen.push(e));
    const out = await c.graph.invoke(docRef('d1'), 'touch', ['a']);
    assert.equal(out.status, 'done');
    assert.equal(out.value, 'touched a');
    assert.deepEqual(touched.at(-1).caller, { kind: 'mod', id: 'test.gr', owner: 'mod:test.gr' });
    assert.equal(touched.at(-1).origin, 'test.gr');
    assert.deepEqual(seen.at(-1).caller, { kind: 'mod', id: 'test.gr', owner: 'mod:test.gr' });
    assert.equal((await c.graph.invoke(docRef('d1'), 'touch', [7])).reason, 'invalid', 'the graph validates the arguments as for any caller');
    assert.equal((await c.graph.invoke(docRef('d1'), 'nope')).reason, 'unsupported');
  } finally { await h.close(); }
});

test('renderer realm: subscribe is a view over the channel: a snapshot, then deltas, until disposed', async () => {
  const { h, provider, w } = await setup({ mods: [{ id: 'test.gr', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }] });
  try {
    const c = w.ctx('test.gr');
    const got = [];
    const sub = c.graph.subscribe({ ref: docRef('d1') }, (m) => got.push(m));
    await waitFor(() => got.length === 1);
    assert.equal(got[0].type, 'snapshot');
    assert.deepEqual(got[0].items.map((x) => x.state.title), ['One']);
    provider.update(docRef('d1'), { state: { title: 'Two' } });
    await waitFor(() => got.length === 2);
    assert.deepEqual([got[1].type, got[1].event.kind, got[1].event.new], ['delta', 'changed', { title: 'Two' }]);
    sub.dispose();
    await sleep(30);
    provider.update(docRef('d1'), { state: { title: 'Three' } });
    await sleep(30);
    assert.equal(got.length, 2, 'nothing after dispose');
    assert.deepEqual(errorsOf(w), []);
  } finally { await h.close(); }
});

test('renderer realm: a view\'s depth reaches the graph: core does not tell the provider, full does; a bad depth is refused', async () => {
  const { h, observed, w } = await setup({ mods: [{ id: 'test.gr', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }] });
  try {
    const c = w.ctx('test.gr');
    const got = [];
    c.graph.subscribe({ ref: docRef('d1'), depth: 'core' }, (m) => got.push(m));
    await waitFor(() => got.length === 1);
    assert.deepEqual(observed, []);
    c.graph.subscribe({ ref: docRef('d1') }, (m) => got.push(m));
    await waitFor(() => got.length === 2);
    assert.equal(observed.length, 1);
    c.graph.subscribe({ ref: docRef('d1'), depth: 'deep' }, () => {});
    await waitFor(() => errorsOf(w).length === 1);
    assert.equal(errorsOf(w)[0].code, 'Invalid');
    assert.match(errorsOf(w)[0].message, /depth/);
    assert.equal(observed.length, 1, 'a refused query asked nothing of the provider');
  } finally { await h.close(); }
});

test('renderer realm: without the graph grant every member is Denied, subscribe included; so is a mod without a renderer entry', async () => {
  const { h, w } = await setup({ mods: [{ id: 'test.plain', grants: ['ui'] }] });
  try {
    await h.runtime.activate(await installMod(h.layout, { id: 'test.hostonly', host: 'export default {};', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }));
    const c = w.ctx('test.plain');
    for (const [name, run] of [['resolve', () => c.graph.resolve(docRef('d1'))], ['list', () => c.graph.list('Doc')], ['related', () => c.graph.related(docRef('d1'), 'x')],
      ['types', () => c.graph.types()], ['can', () => c.graph.can(docRef('d1'), 'touch')], ['invoke', () => c.graph.invoke(docRef('d1'), 'touch', ['a'])]]) {
      await assert.rejects(run(), (e) => e.code === 'Denied' && /not been granted/.test(e.message), name);
    }
    c.graph.subscribe({ ref: docRef('d1') }, () => assert.fail('no view without the grant'));
    await waitFor(() => errorsOf(w).length === 1);
    assert.equal(errorsOf(w)[0].code, 'Denied');
    assert.equal((await raw(w, call('test.hostonly', 'list', 'Doc', null))).error.code, 'Denied', 'a host-only mod has no renderer');
  } finally { await h.close(); }
});

test('renderer realm: registering types, providing, writing, intercepting and next are the host realm\'s: the Host answers Denied and says so', async () => {
  const { h, graph, w } = await setup({ mods: [{ id: 'test.gr', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }] });
  try {
    const c = w.ctx('test.gr');
    for (const key of ['registerTypes', 'provide', 'intercept', 'put', 'update', 'remove', 'setComplete', 'markStale', 'markLive', 'next']) assert.equal(c.graph[key], undefined, key);
    const typesBefore = graph.types().length;
    for (const [method, args] of [['registerTypes', [[]]], ['put', [docRef('x'), { state: { title: 'x' } }]], ['update', [docRef('d1'), { state: { title: 'x' } }]], ['remove', [docRef('d1')]],
      ['setComplete', ['Doc', true]], ['markStale', [null]], ['markLive', [null]], ['next', ['token', null]]]) {
      const r = await raw(w, call('test.gr', method, ...args));
      assert.equal(r.error?.code, 'Denied', method);
      assert.match(r.error.message, new RegExp(`ctx\\.graph\\.${method} is available in the host realm only`), method);
    }
    for (const [method, args] of [['provide', [{ types: {} }]], ['intercept', ['Doc', 'touch', {}]]]) {
      const reply = await raw(w, { t: 'handler', handler: ++n, modId: 'test.gr', ns: 'graph', method, args });
      assert.equal(reply.error?.code, 'Denied', method);
      assert.match(reply.error.message, /host realm only/, method);
    }
    assert.equal(graph.resolve(docRef('d1')).state.title, 'One', 'nothing was written');
    assert.equal(graph.resolve(docRef('x')), null);
    assert.equal(graph.types().length, typesBefore);
    assert.equal(graph.intercepted('Doc', 'touch'), false);
  } finally { await h.close(); }
});

test('the guard in ctx/graph.mjs by scope: host has every member, renderer and a mod\'s process the reads and invoke (graph-integrity G8.2); the grant and the runtime are checked after', () => {
  let ran = 0;
  const fake = new Proxy({}, { get: () => () => { ran++; return null; } });
  const ns = createGraphNs({ graph: () => fake });
  const state = { id: 'unit.a', owner: 'mod:unit.a', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] };
  const READS = [['resolve', [docRef('d1')]], ['list', ['Doc']], ['related', [docRef('d1'), 'x']], ['types', []], ['can', [docRef('d1'), 'touch']], ['invoke', [docRef('d1'), 'touch', []]]];
  for (const [m, args] of READS) {
    assert.doesNotThrow(() => ns.calls[m]({ realm: 'renderer', state }, ...args), `renderer ${m}`);
    assert.doesNotThrow(() => ns.calls[m]({ realm: 'host', state }, ...args), `host ${m}`);
    assert.doesNotThrow(() => ns.calls[m]({ realm: 'process', state }, ...args), `process ${m}`);
    assert.throws(() => ns.calls[m]({ realm: 'process', state: { ...state, grants: [] } }, ...args), (e) => e.code === 'Denied' && /not been granted/.test(e.message), `process without grant ${m}`);
    assert.throws(() => ns.calls[m]({ realm: 'renderer', state: { ...state, grants: [] } }, ...args), (e) => e.code === 'Denied' && /not been granted/.test(e.message), `renderer without grant ${m}`);
  }
  assert.ok(ran > 0);
  assert.doesNotThrow(() => ns.subs.subscribe({ realm: 'renderer', state }, [{ ref: docRef('d1') }, {}], () => {}));
  assert.doesNotThrow(() => ns.subs.subscribe({ realm: 'process', state }, [{ ref: docRef('d1') }, {}], () => {}));
  assert.throws(() => ns.subs.subscribe({ realm: 'worker?', state }, [{ ref: docRef('d1') }, {}], () => {}), (e) => e.code === 'Denied', 'an unknown realm has none');
  const WRITES = [['registerTypes', [[]]], ['put', [docRef('d1'), {}]], ['update', [docRef('d1'), {}]], ['remove', [docRef('d1')]], ['emit', [docRef('d1'), 'touched', null]], ['setComplete', ['Doc', true]],
    ['markStale', [null]], ['markLive', [null]], ['next', ['t', null]]];
  for (const [m, args] of WRITES) {
    for (const realm of ['renderer', 'process']) assert.throws(() => ns.calls[m]({ realm, state }, ...args), (e) => e.code === 'Denied', `${realm} ${m}`);
  }
  for (const m of ['provide', 'intercept']) {
    for (const realm of ['renderer', 'process']) assert.throws(() => ns.handlers[m]({ realm, state }, [{ types: {} }], () => {}), (e) => e.code === 'Denied', `${realm} ${m}`);
  }
  const off = createGraphNs({ graph: () => null });
  assert.throws(() => off.calls.list({ realm: 'renderer', state }, 'Doc'), (e) => e.code === 'Unavailable', 'the graph is off');
});

test('subscribe reaches the channel after the channel has the subscription: the snapshot, and a change right behind it, go out in order', async () => {
  const graph = createGraph();
  graph.registerTypes([toDescriptor(Doc)], 'native');
  const p = graph.registerProvider('native', 'docs', { types: { Doc: {} } });
  p.put(docRef('d1'), { state: { title: 'One' } });
  const ns = createGraphNs({ graph: () => graph });
  const scope = { realm: 'renderer', state: { id: 'unit.a', owner: 'mod:unit.a', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] } };
  // The Channel drops what is emitted before it has recorded the subscription, which it does when subscribe returns; a view's snapshot
  // is produced inside graph.subscribe, so without the hold the first message of every realm view was lost.
  const got = [];
  let registered = false;
  const sub = ns.subs.subscribe(scope, [{ ref: docRef('d1') }, {}], (m) => { assert.ok(registered, 'emitted before the channel could take it'); got.push(m.type); });
  registered = true;
  p.update(docRef('d1'), { state: { title: 'Two' } });          // in the same tick, behind the snapshot
  assert.deepEqual(got, []);
  await Promise.resolve();
  assert.deepEqual(got, ['snapshot', 'delta']);
  p.update(docRef('d1'), { state: { title: 'Three' } });
  assert.deepEqual(got, ['snapshot', 'delta', 'delta'], 'afterwards messages go straight out');
  sub.dispose();
  p.update(docRef('d1'), { state: { title: 'Four' } });
  assert.equal(got.length, 3);
});

test('host realm: a mod\'s ctx.graph.subscribe gets its snapshot and deltas in the worker too', async () => {
  const { h, provider } = await setup();
  try {
    await h.runtime.activate(await installMod(h.layout, { id: 'test.hostsub', host: EVAL_HOST, grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }));
    await inWorker(h.runtime, 'test.hostsub', `globalThis.got = []; globalThis.sub = ctx.graph.subscribe({ ref: args.ref, depth: 'core' }, (m) => globalThis.got.push(m.type));`, { ref: docRef('d1') });
    await waitFor(async () => (await inWorker(h.runtime, 'test.hostsub', 'return globalThis.got;')).length === 1, { what: 'the snapshot' });
    provider.update(docRef('d1'), { state: { title: 'Two' } });
    await waitFor(async () => (await inWorker(h.runtime, 'test.hostsub', 'return globalThis.got;')).length === 2, { what: 'the delta' });
    assert.deepEqual(await inWorker(h.runtime, 'test.hostsub', 'return globalThis.got;'), ['snapshot', 'delta']);
  } finally { await h.close(); }
});

test('flow control: a realm that stops acknowledging pauses its view at the window; its acks resume it; a view past its bound resnapshots', async () => {
  const { h, provider, w } = await setup({ mods: [{ id: 'test.flow', grants: ['graph', 'graph.read'] }] });
  try {
    const got = [];
    const off = w.realmPort.onMessage((m) => { if (m.t === 'event' && m.sub === 9001) got.push(m.data.type); });
    // A raw crediting subscription that this test acknowledges by hand (the realm client acknowledges only its own).
    w.post({ t: 'sub', sub: 9001, modId: 'test.flow', ns: 'graph', method: 'subscribe', args: [{ type: 'Doc' }, { maxQueue: 500 }], credit: true });
    await waitFor(() => got.includes('snapshot'), { what: 'the snapshot' });
    for (let i = 0; i < 400; i++) provider.put(docRef(`n${i}`), { state: { title: `N${i}` } });
    await sleep(10);
    assert.equal(got.length, FLOW_WINDOW, 'the snapshot and deltas up to the window; the view holds the rest');
    w.post({ t: 'ack', sub: 9001, n: 200 });
    await waitFor(() => got.length === 401, { what: 'the held deltas after the ack' });
    // Unacknowledged again: the view pauses at the window, queues to its bound, then drops its queue for `stale` and a fresh snapshot.
    for (let i = 0; i < 800; i++) provider.update(docRef('d1'), { state: { title: `T${i}` } });
    await sleep(10);
    assert.deepEqual(got.slice(401).filter((x) => x !== 'delta'), ['stale', 'snapshot']);
    off.dispose();
  } finally { await h.close(); }
});

test('flow control: the realm client acknowledges in batches, so a realm that keeps up is never paused', async () => {
  const { h, provider, w } = await setup({ mods: [{ id: 'test.flow2', grants: ['graph', 'graph.read'] }] });
  try {
    const acks = [];
    const off = w.hostPort.onMessage((m) => { if (m.t === 'ack') acks.push(m.n); });
    const got = [];
    w.ctx('test.flow2').graph.subscribe({ type: 'Doc' }, (m) => got.push(m.type));
    await waitFor(() => got.includes('snapshot'), { what: 'the snapshot' });
    for (let i = 0; i < 2 * FLOW_WINDOW; i++) provider.update(docRef('d1'), { state: { title: `T${i}` } });
    await waitFor(() => got.length === 1 + 2 * FLOW_WINDOW, { what: 'every delta' });
    assert.ok(!got.includes('stale'));
    assert.ok(acks.length >= 8 && acks.every((n) => n === 32), `acknowledged in batches of 32 (${acks.length})`);
    off.dispose();
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the framework scope
test('framework scope: the page runtime reads the graph and invokes as {kind: framework} with no mod active and no grant', async () => {
  const { h, graph, touched, w } = await setup();
  try {
    assert.equal(FRAMEWORK_MOD_ID, FW);
    const f = w.ctx(FW);
    assert.equal((await f.graph.resolve(docRef('d1'))).state.title, 'One');
    assert.deepEqual((await f.graph.list('Doc')).map((x) => x.ref.id), ['d1']);
    assert.equal(await f.graph.can(docRef('d1'), 'touch'), true);
    assert.ok((await f.graph.types()).length > 0);
    assert.equal(await f.graph.related(docRef('d1'), 'nothing').catch((e) => e.code), 'Invalid');
    const seen = [];
    graph.onOperation((e) => seen.push(e));
    const out = await f.graph.invoke(docRef('d1'), 'touch', ['page']);
    assert.equal(out.status, 'done');
    assert.deepEqual(touched.at(-1).caller, { kind: 'framework', id: 'framework' });
    assert.equal(touched.at(-1).origin, 'framework');
    assert.deepEqual(seen.at(-1).caller, { kind: 'framework', id: 'framework' });
    // the framework is a caller no mod's own-interceptor exemption covers: an interceptor of a mod sees it
    const calls = [];
    graph.intercept('mod:watcher', 'Doc', 'touch', (c, next) => { calls.push(c.caller); return next(); });
    await f.graph.invoke(docRef('d1'), 'touch', ['seen']);
    assert.deepEqual(calls, [{ kind: 'framework', id: 'framework' }]);
    // and a view
    const got = [];
    f.graph.subscribe({ ref: docRef('d1'), depth: 'core' }, (m) => got.push(m));
    await waitFor(() => got.length === 1);
    assert.equal(got[0].type, 'snapshot');
  } finally { await h.close(); }
});

test('framework scope: only the graph namespace\'s reads and invoke: the writes and every other namespace are Denied', async () => {
  const { h, graph, w } = await setup({ mods: [{ id: 'test.other', grants: ['graph', 'secrets', 'appServer.request', 'appServer.observe', 'ui'] }] });
  try {
    const f = w.ctx(FW);
    // writes, as raw calls and registrations
    for (const [method, args] of [['registerTypes', [[]]], ['put', [docRef('x'), { state: { title: 'x' } }]], ['update', [docRef('d1'), {}]], ['remove', [docRef('d1')]],
      ['setComplete', ['Doc', true]], ['markStale', [null]], ['markLive', [null]], ['next', ['t', null]]]) {
      assert.equal((await raw(w, call(FW, method, ...args))).error?.code, 'Denied', method);
    }
    for (const method of ['provide', 'intercept']) {
      const r = await raw(w, { t: 'handler', handler: ++n, modId: FW, ns: 'graph', method, args: [{ types: {} }] });
      assert.equal(r.error?.code, 'Denied', method);
    }
    assert.equal(graph.resolve(docRef('x')), null);
    // the other namespaces, through the realm client the page would use
    for (const [name, run] of [
      ['storage.get', () => f.storage.get('k')], ['storage.set', () => f.storage.set('k', 1)], ['storage.retained.get', () => f.storage.retained.get('k')],
      ['settings.get', () => f.settings.get()], ['secrets.get', () => f.secrets.get('s')], ['events.state', () => f.events.state('framework/probe')],
      ['services.call', () => f.services.call('test.other', 'svc', 'm', null)], ['appServer.request', () => f.appServer.request('thread/list', {})],
      ['appServer.backends.list', () => f.appServer.backends.list()], ['appServer.clients.issue', () => f.appServer.clients.issue({ name: 'x' })],
    ]) {
      await assert.rejects(run(), (e) => e.code === 'Denied', name);
    }
    f.log.error('not recorded');                     // fire and forget: the Host refuses it, which is not an error to the caller
    f.events.on('framework/*', () => assert.fail('no subscription'));
    f.settings.onChange(() => assert.fail('no subscription'));
    f.storage.watch('', () => assert.fail('no subscription'));
    f.appServer.observe({}, () => assert.fail('no subscription'));
    f.services.provide('svc', { m: () => 1 });
    await waitFor(() => errorsOf(w).length === 5, { what: 'every registration refused' });
    assert.ok(errorsOf(w).every((e) => e.code === 'Denied'), errorsOf(w).map((e) => e.message).join(' | '));
    for (const [ns, method] of [['processes', 'start'], ['process', 'emit'], ['secrets', 'get'], ['appServer', 'request'], ['events', 'emit']]) {
      const r = await raw(w, { t: 'call', id: ++n, modId: FW, ns, method, args: ['mod/framework/x', 'y'] });
      assert.equal(r.error?.code, 'Denied', `${ns}.${method}`);
    }
    // nothing it asked took effect: no service under the framework's name, no topic emitted
    await assert.rejects(h.runtime.callServiceForLease('mod:framework', { name: 'svc', method: 'm', args: null }), { code: 'Unavailable' });
    assert.ok(!h.events.some((e) => e.topic.startsWith('mod/framework')));
  } finally { await h.close(); }
});

test('framework scope: one window\'s channel carries both the page runtime and the mods, each in its own scope', async () => {
  const { h, touched, w } = await setup({ mods: [{ id: 'test.gr', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }, { id: 'test.nogr', grants: [] }] });
  try {
    const mod = w.ctx('test.gr'), plain = w.ctx('test.nogr'), page = w.ctx(FW);
    await page.graph.invoke(docRef('d1'), 'touch', ['page']);
    await mod.graph.invoke(docRef('d1'), 'touch', ['mod']);
    await assert.rejects(plain.graph.invoke(docRef('d1'), 'touch', ['plain']), (e) => e.code === 'Denied');
    assert.deepEqual(touched.map((t) => [t.arg, t.caller.kind, t.caller.id]), [['page', 'framework', 'framework'], ['mod', 'mod', 'test.gr']]);
    // a mod whose renderer module is unloaded is gone to the channel; the page runtime is not
    await h.runtime.deactivate('test.gr', 'off');
    await assert.rejects(mod.graph.list('Doc'), (e) => e.code === 'Unavailable');
    assert.equal((await page.graph.list('Doc')).length, 1);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the reserved id
test('the reserved id is not a mod: activate refuses it, so no mod can shadow or be shadowed by the page runtime', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: FW, renderer: 'export default {};', host: 'export default {};', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] });
    await assert.rejects(h.runtime.activate(mod), (e) => e.code === 'Invalid' && /reserved/.test(e.message));
    assert.equal(h.runtime.status(FW), 'inactive');
    assert.deepEqual(h.runtime.active(), []);
  } finally { await h.close(); }
});

test('the reserved id cannot be claimed from a worker or a process channel: they are bound to their own mod', async () => {
  const { h } = await setup();
  try {
    // a real worker channel: the mod's worker posts a raw call naming the framework
    await h.runtime.activate(await installMod(h.layout, { id: 'test.w', host: EVAL_HOST, grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }));
    const reply = await inWorker(h.runtime, 'test.w', `
      const { parentPort } = await import('node:worker_threads');
      return await new Promise((resolve) => {
        const on = (m) => { if (m && m.t === 'result' && m.id === 987654) { parentPort.off('message', on); resolve(m); } };
        parentPort.on('message', on);
        parentPort.postMessage({ t: 'call', id: 987654, modId: '${FW}', ns: 'graph', method: 'list', args: ['Doc', null] });
      });`);
    assert.equal(reply.error.code, 'Denied');
    assert.match(reply.error.message, /bound to test\.w/);
    // a process channel (and a worker's) is a Channel with boundModId, which refuses before any scope is resolved
    for (const kind of ['process', 'worker']) {
      const [hostPort, realmPort] = portPair();
      const scopes = [];
      const channel = new Channel({ rt: { namespaces: { graph: { calls: { list: () => assert.fail('must not run') } } }, scopeFor: (c, id) => { scopes.push(id); throw new Error('no scope'); }, log: h.log }, port: hostPort, kind, boundModId: 'test.p', identity: { modId: 'test.p' } });
      const replies = [];
      realmPort.onMessage((m) => replies.push(m));
      realmPort.post({ t: 'call', id: 1, modId: FW, ns: 'graph', method: 'list', args: ['Doc', null] });
      realmPort.post({ t: 'sub', sub: 2, modId: FW, ns: 'graph', method: 'subscribe', args: [{ ref: docRef('d1') }, {}] });
      await waitFor(() => replies.length === 2, { what: `${kind} replies` });
      assert.equal(replies.find((m) => m.t === 'result').error.code, 'Denied', kind);
      assert.equal(replies.find((m) => m.t === 'event').error.code, 'Denied', kind);
      assert.deepEqual(scopes, [], `${kind}: scopeFor was never asked`);
      channel.close();
    }
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the replica over the real channel
test('replica over the framework scope: core views never load the provider, full views do; changes arrive; the linger holds the view; the end frees it', async () => {
  const { h, provider, observed, w } = await setup();
  try {
    const f = w.ctx(FW);
    const concept = new Map((await f.graph.types()).map((t) => [t.id, t.concept]));
    const replica = createReplica({ subscribe: (query, onMessage) => f.graph.subscribe(query, onMessage), conceptOf: (id) => concept.get(id), lingerMs: 300 });
    const events = () => w.hostPort.sent.filter((m) => m.t === 'event' && !m.error).length;
    const seen = [];
    replica.watch(docRef('d1'), (v) => seen.push(v === undefined ? 'unknown' : v.gone ? 'gone' : v.state.title));
    const a = replica.observe(docRef('d1'));
    await waitFor(() => replica.get(docRef('d1')), { what: 'the snapshot' });
    assert.equal(replica.get(docRef('d1')).state.title, 'One');
    assert.deepEqual(observed, [], 'a core view: the provider was not asked to load anything');
    provider.update(docRef('d1'), { state: { title: 'Two' } });
    await waitFor(() => replica.get(docRef('d1')).state.title === 'Two');
    // a second reader of the same instance shares the view
    const b = replica.observe({ ...docRef('d1'), type: 'Doc' });
    assert.equal(replica.stats().views, 1);
    a.dispose(); b.dispose();
    await sleep(20);
    provider.update(docRef('d1'), { state: { title: 'Three' } });
    await waitFor(() => replica.get(docRef('d1')).state.title === 'Three');   // lingering: still live
    const again = replica.observe(docRef('d1'));                              // inside the linger: the same view
    assert.equal(replica.stats().views, 1);
    assert.equal(replica.get(docRef('d1')).state.title, 'Three');
    again.dispose();
    await waitFor(() => replica.stats().views === 0, { what: 'the linger to end' });
    assert.equal(replica.get(docRef('d1')), undefined);
    const before = events();
    provider.update(docRef('d1'), { state: { title: 'Four' } });
    await sleep(40);
    assert.equal(events(), before, 'the Host view was disposed: no more messages for it');
    // a full view asks the provider
    const full = replica.observe(docRef('d1'), { depth: 'full' });
    await waitFor(() => replica.get(docRef('d1'))?.state.title === 'Four');
    assert.equal(observed.length, 1);
    // a removed instance
    provider.remove(docRef('d1'));
    await waitFor(() => replica.get(docRef('d1'))?.gone === true);
    assert.deepEqual(seen, ['One', 'Two', 'Three', 'unknown', 'Four', 'gone'], 'the watcher heard every state, in order');
    full.dispose();
    replica.close();
    assert.deepEqual(errorsOf(w), []);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the user's intent a page attests (graph-integrity G7)
test('G7.2, G7.3: a call carrying the user\'s intent the page attested for this mod is the user\'s through the mod: once, its own, from the page only', async () => {
  const { h, touched, w } = await setup({ mods: [{ id: 'test.gr', grants: ['graph', 'graph.read', 'graph.act'] }, { id: 'test.other', grants: ['graph', 'graph.read', 'graph.act'] }] });
  try {
    const token = `att-${'a'.repeat(32)}`;
    const told = await raw(w, { t: 'call', id: ++n, modId: FW, ns: 'present', method: 'attest', args: [token, 'test.gr'] });
    assert.equal(told.value, true, 'the page runtime tells the Host as it mints');
    const mine = await raw(w, { t: 'call', id: ++n, modId: 'test.gr', ns: 'present', method: 'attest', args: [`att-${'b'.repeat(32)}`, 'test.gr'] });
    assert.equal(mine.error?.code, 'Denied', 'only the page\'s own runtime tells one');
    const c = w.ctx('test.gr');
    const out = await c.graph.invoke(docRef('d1'), 'touch', ['as the user'], { asUser: token });
    assert.equal(out.status, 'done');
    assert.deepEqual([touched.at(-1).caller, touched.at(-1).origin], [{ kind: 'user', id: 'user', through: 'test.gr' }, 'test.gr'], 'the user, through the mod: both named');
    const again = await c.graph.invoke(docRef('d1'), 'touch', ['again'], { asUser: token });
    assert.deepEqual([again.status, again.reason], ['refused', 'notAllowed'], 'once');
    const token2 = `att-${'c'.repeat(32)}`;
    await raw(w, { t: 'call', id: ++n, modId: FW, ns: 'present', method: 'attest', args: [token2, 'test.gr'] });
    const theirs = await w.ctx('test.other').graph.invoke(docRef('d1'), 'touch', ['stolen'], { asUser: token2 });
    assert.deepEqual([theirs.status, /another mod/.test(theirs.message)], ['refused', true], 'another mod\'s is not its own');
    // a host-realm call never carries one
    const host = await installMod(h.layout, { id: 'test.host', host: EVAL_HOST, grants: ['graph', 'graph.read', 'graph.act'] });
    await h.runtime.activate(host);
    const fromHost = await inWorker(h.runtime, 'test.host', `return ctx.graph.invoke(args.ref, 'touch', ['host'], { asUser: args.token });`, { ref: docRef('d1'), token: `att-${'d'.repeat(32)}` });
    assert.deepEqual([fromHost.status, fromHost.reason], ['refused', 'notAllowed']);
    assert.ok(!touched.some((x) => x.arg === 'stolen' || x.arg === 'host' || x.arg === 'again'));
  } finally { await h.close(); }
});

test('graph-integrity G8.2: a mod\'s process reads the graph and invokes as its mod, under its grants; the host realm\'s members and the user\'s intent are not its', async () => {
  const { h, touched } = await setup({ mods: [{ id: 'test.proc', grants: ['graph', 'graph.read', 'graph.act', 'processes'],
    processes: { s: { kind: 'session', command: 'bin/s.sh', start: 'on-demand' } }, files: { 'bin/s.sh': '#!/bin/sh\nexec sleep 30\n' } }] });
  try {
    const [hostPort, realmPort] = portPair();
    const replies = [];
    realmPort.onMessage((m) => replies.push(m));
    const d = h.runtime.handleRealm('process', hostPort, { modId: 'test.proc', process: 's' });
    let id = 0;
    const ask = (method, ...args) => { const k = ++id; realmPort.post({ t: 'call', id: k, modId: 'test.proc', ns: 'graph', method, args }); return waitFor(() => replies.find((r) => r.t === 'result' && r.id === k), { what: method }); };
    assert.equal((await ask('resolve', docRef('d1'))).value?.state?.title, 'One', 'a read');
    const out = await ask('invoke', docRef('d1'), 'touch', ['from the process']);
    assert.equal(out.value?.status, 'done');
    assert.deepEqual([touched.at(-1).caller.kind, touched.at(-1).caller.id, touched.at(-1).origin], ['mod', 'test.proc', 'test.proc'], 'as its mod');
    assert.equal((await ask('registerTypes', [])).error?.code, 'Denied', 'registering is the host realm\'s');
    assert.equal((await ask('put', docRef('d2'), {})).error?.code, 'Denied', 'providing is the host realm\'s');
    const asUser = await ask('invoke', docRef('d1'), 'touch', ['as the user?'], { asUser: `att-${'a'.repeat(32)}` });
    assert.deepEqual([asUser.value?.status, asUser.value?.reason], ['refused', 'notAllowed'], 'the user\'s intent is the page\'s alone');
    d.dispose();
  } finally { await h.close(); }
});
