// Mux addition 10 (docs/design/integration.md §7; model batch 3, D8): the mux numbers server requests itself (`s:<n>`), so
// `serverRequest/resolved` must name the id the owning client saw. The app drops a pending request card only on an exact id match,
// so a request resolved anywhere but the app's own answer (an interrupt, a timeout, a mod's answer) would otherwise stay on screen.
// Headless: the real mux and the strict fake app-server (`fake/serverRequest`, `fake/notify`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { harness, until, sleep } from './helpers.mjs';

const A = 'mod:a';
const Q = 'item/tool/requestUserInput';
const questions = [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
const ANSWER = { answers: { color: { answers: ['Blue'] } } };
const RESOLVED = 'serverRequest/resolved';

/** Records every frame the mux writes to a backend. */
function recordingSpawn(written) {
  return (cmd, args, o) => {
    const p = nodeSpawn(cmd, args, o);
    const real = p.stdin.write.bind(p.stdin);
    p.stdin.write = (data, cb) => { try { written.push(JSON.parse(String(data))); } catch { /* not a frame */ } return real(data, cb); };
    return p;
  };
}
async function withHarness(fn) {
  const written = [];
  const h = await harness({ spawn: recordingSpawn(written) });
  try { await h.up(); await fn(h, written); } finally { await h.close(); }
}
const ask = (h, id, extra = {}) => h.app.send({ id, method: 'fake/serverRequest', params: { method: Q, params: { threadId: 'thr-A', turnId: 'turn-1', questions }, ...extra } });
const resolveOnBackend = (h, id, requestId) => h.app.send({ id, method: 'fake/notify', params: { method: RESOLVED, params: { threadId: 'thr-A', requestId } } });
const answersTo = (written, id) => written.filter((m) => m.id === id && m.method === undefined);

test('A10 1: when the app answers itself, serverRequest/resolved names the id the app saw', async () => {
  await withHarness(async (h) => {
    ask(h, 10, { resolve: true });
    const q = await h.app.waitFor((m) => m.method === Q, 5000);
    assert.match(q.id, /^s:\d+$/);
    h.app.send({ id: q.id, result: ANSWER });
    assert.deepEqual((await h.app.reply(10)).result.answer, { id: 'srv-1', result: ANSWER }, 'the backend got the answer under its own id');
    const r = await h.app.waitFor((m) => m.method === RESOLVED, 5000);
    assert.deepEqual(r.params, { threadId: 'thr-A', requestId: q.id });
  });
});

test('A10 2: a request resolved elsewhere (interrupt, timeout) reaches the app, observers and interceptors under the app\'s id; a late answer is dropped quietly', async () => {
  await withHarness(async (h, written) => {
    const mod = h.mux.client(A);
    const observed = [], intercepted = [];
    mod.observe({ kinds: ['serverNotification'], methods: [RESOLVED] }, (m) => observed.push(m));
    mod.intercept('serverNotification', [RESOLVED], (m) => { intercepted.push(m); return { pass: true }; });
    ask(h, 10);
    const q = await h.app.waitFor((m) => m.method === Q, 5000);
    resolveOnBackend(h, 11, 'srv-1');
    const r = await h.app.waitFor((m) => m.method === RESOLVED, 5000);
    assert.deepEqual(r.params, { threadId: 'thr-A', requestId: q.id }, 'the app can drop its card: the id matches exactly');
    await until(() => observed.length === 1 && intercepted.length === 1, 5000, 'observer and interceptor');
    assert.equal(intercepted[0].params.requestId, q.id);
    assert.equal(observed[0].params.requestId, q.id);
    // The app's answer arrives after the backend resolved the request: nothing reaches the backend, nothing is logged.
    const warnsBefore = h.entries.filter((e) => e.level === 'warn').length;
    h.app.send({ id: q.id, result: ANSWER });
    await sleep(150);
    assert.equal(answersTo(written, 'srv-1').length, 0, 'no answer is written for a finished request');
    assert.equal(h.entries.filter((e) => e.level === 'warn').length, warnsBefore, 'dropped quietly');
    // A second late answer under the same id is an unknown response again (the quiet drop is once).
    h.app.send({ id: q.id, result: ANSWER });
    await until(() => h.logged('warn', /response to an unknown server request dropped/), 2000, 'second answer warned');
  });
});

test('A10 3: a resolved id the mux does not know passes through unchanged', async () => {
  await withHarness(async (h) => {
    resolveOnBackend(h, 11, 'srv-99');
    const r = await h.app.waitFor((m) => m.method === RESOLVED, 5000);
    assert.equal(r.params.requestId, 'srv-99');
  });
});

test('A10 4: a deferred request is still cancelled on the backend id, and the notification names the mux id the mod was given', async () => {
  await withHarness(async (h) => {
    const mod = h.mux.client(A);
    const deferred = [], resolved = [], observed = [];
    mod.onDeferred((d) => deferred.push(d));
    mod.onResolved((token, reason) => resolved.push({ token, reason }));
    mod.intercept('serverRequest', [Q], () => ({ defer: true }), { timeoutMs: 2000 });
    mod.observe({ kinds: ['serverNotification'], methods: [RESOLVED] }, (m) => observed.push(m));
    ask(h, 10);
    await until(() => deferred.length === 1, 5000, 'onDeferred');
    resolveOnBackend(h, 11, 'srv-1');
    await until(() => resolved.length === 1 && observed.length === 1, 5000, 'cancelled');
    assert.deepEqual(resolved, [{ token: deferred[0].token, reason: 'cancelled' }]);
    assert.equal(observed[0].params.requestId, deferred[0].message.id);
    assert.match(observed[0].params.requestId, /^s:\d+$/);
  });
});

test('A10 5: a released deferred request resolved elsewhere names the id the app saw', async () => {
  await withHarness(async (h) => {
    const mod = h.mux.client(A);
    const deferred = [];
    mod.onDeferred((d) => deferred.push(d));
    mod.intercept('serverRequest', [Q], () => ({ defer: true }), { timeoutMs: 2000 });
    ask(h, 10);
    await until(() => deferred.length === 1, 5000, 'onDeferred');
    assert.deepEqual(await mod.release(deferred[0].token), { released: true });
    const q = await h.app.waitFor((m) => m.method === Q, 5000);
    resolveOnBackend(h, 11, 'srv-1');
    const r = await h.app.waitFor((m) => m.method === RESOLVED, 5000);
    assert.equal(r.params.requestId, q.id);
  });
});
