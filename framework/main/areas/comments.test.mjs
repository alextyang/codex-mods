// The in-memory AppHost comment service, without Electron or a running app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./comments.cjs');
const comment = (text = 'Keep the guard', extra = {}) => ({ type: 'comment', content: [{ content_type: 'text', text }], position: { side: 'right', path: 'a', line: 4 }, ...extra });
const window = (id, svc) => ({ id, host: { services: { commentAttachments: svc } } });

class Service {
  constructor(entries = []) { this.comments = new Map(entries); this.calls = []; this.revision = 0; this.listeners = new Map(); this.unsubscribed = 0; }
  snapshot(id, editId = null) { return { comments: this.comments.get(id) ?? [], revision: this.revision, editId }; }
  changed(id, editId) {
    this.revision++;
    const snapshot = this.snapshot(id, editId);
    for (const cb of this.listeners.get(id) ?? []) cb(snapshot);
    return snapshot;
  }
  edit(id, edit) {
    this.calls.push(['edit', id, edit]);
    const comments = [...(this.comments.get(id) ?? [])];
    for (const removed of edit.removed) {
      const index = comments.findIndex((c) => isDeepStrictEqual(c, removed));
      if (index === -1 && edit.added.length) return this.snapshot(id, edit.id);
      if (index !== -1) comments.splice(index, 1);
    }
    for (const { comment, index } of edit.added) comments.splice(index, 0, comment);
    this.comments.set(id, comments);
    return this.changed(id, edit.id);
  }
  transfer(from, to) {
    this.calls.push(['transfer', from, to]);
    this.comments.set(to, [...(this.comments.get(to) ?? []), ...(this.comments.get(from) ?? [])]);
    this.comments.set(from, []);
    return [from, to].map((id) => ({ conversationId: id, snapshot: this.changed(id, null) }));
  }
  removeReviewThread(reviewThreadId, key) {
    this.calls.push(['removeReviewThread', reviewThreadId, key]);
    const out = [];
    for (const [id, comments] of this.comments) {
      const next = comments.filter((c) => c.reviewThreadId !== reviewThreadId || (key !== undefined && c.localPullRequestReviewKey !== key));
      if (next.length !== comments.length) {
        this.comments.set(id, next);
        out.push({ conversationId: id, snapshot: this.changed(id, null) });
      }
    }
    return out;
  }
  subscribe(id, cb) {
    assert.equal(cb.dup(), cb);
    assert.equal(typeof cb.onRpcBroken, 'function');
    assert.equal(typeof cb[Symbol.dispose], 'function');
    cb.onRpcBroken(() => {}); cb[Symbol.dispose]();
    const set = this.listeners.get(id) ?? new Set();
    set.add(cb); this.listeners.set(id, set);
    cb(this.snapshot(id));
    const unsubscribe = () => { this.unsubscribed++; set.delete(cb); };
    return { unsubscribe, [Symbol.dispose]: unsubscribe };
  }
}

function setup(windows) {
  const svc = new Service(), reports = [], warnings = [], listeners = new Set();
  const state = { windows: windows ?? [window(1, svc)] };
  let run;
  const hooks = {
    appHost: { first: () => state.windows[0], windows: () => state.windows, subscribe(fn) { listeners.add(fn); } },
    onAreaOp(area, fn) { assert.equal(area, 'comments'); run = fn; },
    areaReport(area, report) { assert.equal(area, 'comments'); reports.push(report); },
    log: { warn(...args) { warnings.push(args); } },
  };
  register(hooks);
  return { hooks, svc, state, reports, warnings, run,
    add(w) { state.windows.push(w); for (const fn of listeners) fn({ type: 'added', id: w.id }); },
    changed() { for (const fn of listeners) fn({ type: 'changed' }); },
  };
}

test('binding reports every stored conversation, ignores pending chats, and wraps distinct services exactly once', () => {
  const a = comment(), b = comment('Other');
  const one = new Service([['a', [a]], ['client-new-thread:pending', [b]], ['b', [b]]]), two = new Service([['c', []]]);
  const original = one.edit, s = setup([window(1, one), window(2, one), window(3, two)]);
  assert.notEqual(one.edit, original);
  assert.notEqual(two.edit, original);
  assert.deepEqual(s.reports, [{ conversationId: 'a', comments: [a] }, { conversationId: 'b', comments: [b] }, { conversationId: 'c', comments: [] }]);
  const wrapped = one.edit;
  s.add(window(4, one)); register(s.hooks);
  assert.equal(one.edit, wrapped);
  assert.equal(s.reports.length, 3);
  const three = new Service([['d', [a]]]);
  s.add(window(5, three));
  assert.notEqual(three.edit, original);
  const late = { id: 6, host: { services: {} } };
  s.add(late); late.host.services.commentAttachments = new Service([['late', []]]); s.changed();
  assert.deepEqual(s.reports.slice(3), [{ conversationId: 'd', comments: [a] }, { conversationId: 'late', comments: [] }]);
});

test('edit, transfer and review removal preserve app receivers, arguments and answers, reporting their resulting lists', () => {
  const s = setup(), a = comment(), b = comment('Review', { reviewThreadId: 'review', localPullRequestReviewKey: 'key' });
  const edit = { id: 'app-edit', removed: [], added: [{ comment: a, index: 0 }, { comment: b, index: 1 }] };
  const answer = s.svc.edit('one', edit);
  assert.deepEqual(answer, { comments: [a, b], revision: 1, editId: 'app-edit' });
  assert.deepEqual(s.svc.calls[0], ['edit', 'one', edit]);
  assert.deepEqual(s.reports, [{ conversationId: 'one', comments: answer.comments }]);
  assert.deepEqual(s.svc.transfer('one', 'two').map((e) => e.snapshot.comments), [[], [a, b]]);
  assert.deepEqual(s.reports.slice(1), [{ conversationId: 'one', comments: [] }, { conversationId: 'two', comments: [a, b] }]);
  const removed = s.svc.removeReviewThread('review', 'key');
  assert.deepEqual(removed[0].snapshot.comments, [a]);
  assert.deepEqual(s.reports.at(-1), { conversationId: 'two', comments: [a] });
  assert.deepEqual(s.svc.calls.slice(1), [['transfer', 'one', 'two'], ['removeReviewThread', 'review', 'key']]);
  const raw = { subscribe() {}, edit() {}, transfer() { return [{ conversationId: 'raw', snapshot: [a] }]; }, removeReviewThread() { return [{ conversationId: 'raw', snapshot: [] }]; } };
  s.add(window(2, raw)); raw.transfer(); raw.removeReviewThread();
  assert.deepEqual(s.reports.slice(-2), [{ conversationId: 'raw', comments: [a] }, { conversationId: 'raw', comments: [] }]);
});

test('our binding and reporting errors are contained and logged once; app errors still reach the caller', () => {
  const svc = new Service([['t', []]]), s = setup([window(1, Object.freeze(new Service())), window(2, svc)]);
  assert.equal(s.warnings.length, 1);
  assert.deepEqual(s.reports, [{ conversationId: 't', comments: [] }]);
  s.hooks.areaReport = () => { throw new Error('report failed'); };
  s.hooks.log.warn = () => { throw new Error('log failed'); };
  assert.doesNotThrow(() => svc.edit('t', { id: 'e', removed: [], added: [] }));
  assert.doesNotThrow(() => svc.transfer('t', 'u'));
  assert.equal(s.warnings.length, 1);
  const bad = setup(); let logs = 0;
  bad.hooks.areaReport = () => { throw new Error('report failed'); };
  bad.hooks.log.warn = () => { logs++; throw new Error('logger failed'); };
  assert.doesNotThrow(() => bad.svc.edit('t', { removed: [], added: [] }));
  assert.doesNotThrow(() => bad.svc.edit('t', { removed: [], added: [] }));
  assert.equal(logs, 1);
  const malformed = new Service(); malformed.transfer = () => ({ not: 'iterable' });
  const other = setup([window(3, malformed)]);
  assert.deepEqual(malformed.transfer(), { not: 'iterable' });
  assert.equal(other.warnings.length, 1);
  for (const name of ['edit', 'transfer', 'removeReviewThread']) {
    const original = new Service(), error = new Error('app failed'); original[name] = () => { throw error; };
    const s = setup([window(4, original)]);
    assert.throws(() => original[name](), (e) => e === error);
    assert.deepEqual(s.warnings, []);
  }
});

test('read uses the first subscription snapshot and immediately unsubscribes, without needing the public Map', async () => {
  const s = setup(), a = comment();
  s.svc.comments.set('t', [a]);
  assert.deepEqual(await s.run('read', { threadId: 't' }), { comments: [a] });
  assert.equal(s.svc.unsubscribed, 1);
  assert.equal(s.svc.listeners.get('t').size, 0);
  assert.deepEqual(await s.run('read', { threadId: 'empty' }), { comments: [] });
  const svc = { edit() {}, subscribe(id, cb) {
    assert.equal(id, 'hidden'); assert.equal(cb.dup(), cb);
    cb({ comments: [a] }); cb({ comments: [] });
    return { unsubscribe() { svc.closed = true; } };
  } };
  s.add(window(2, svc)); s.state.windows.shift();
  assert.deepEqual(await s.run('read', { threadId: 'hidden' }), { comments: [a] });
  assert.equal(svc.closed, true);
});

test('edit supplies fresh UUIDs, preserves removal equality and insertion positions, and returns only comments', async () => {
  const s = setup(), a = comment(), b = comment('Replacement');
  assert.deepEqual(await s.run('edit', { threadId: 't', removed: [], added: [{ comment: a, index: 0 }] }), { comments: [a] });
  assert.deepEqual(await s.run('edit', { threadId: 't', removed: [structuredClone(a)], added: [{ comment: b, index: 0 }] }), { comments: [b] });
  assert.deepEqual(await s.run('edit', { threadId: 't', removed: [a], added: [{ comment: a, index: 0 }] }), { comments: [b] }, 'a missing removal cancels an addition');
  assert.deepEqual(await s.run('edit', { threadId: 't', removed: [b], added: [] }), { comments: [] });
  const ids = s.svc.calls.map(([, , e]) => e.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.every((id) => /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id)));
});

test('thread, list and index guards and unknown operations refuse before trying the service', async () => {
  const s = setup(), a = comment();
  const edit = { removed: [], added: [] };
  for (const op of ['read', 'edit']) {
    for (const id of [null, undefined, '', '  ', 5, {}, 'x'.repeat(201), 'client-new-thread:uuid']) {
      await assert.rejects(s.run(op, { ...edit, threadId: id }), (e) => e.refused && /thread id/.test(e.message));
    }
    await assert.rejects(s.run(op, null), (e) => e.refused);
  }
  for (const invalid of [
    {}, { removed: null, added: [] }, { removed: [], added: {} }, { removed: [null], added: [] }, { removed: [[]], added: [] },
    { removed: Array(101).fill(a), added: [] }, { removed: [], added: Array(101).fill({ comment: a, index: 0 }) },
    { removed: [], added: [null] }, { removed: [], added: [{ comment: a, index: 1.5 }] },
    { removed: [], added: [{ comment: a, index: '1' }] }, { removed: [], added: [{ comment: null, index: 0 }] },
    { removed: [], added: [{ comment: [], index: 0 }] },
  ]) await assert.rejects(s.run('edit', { threadId: 't', ...invalid }), (e) => e.refused);
  for (const op of ['unknown', '__proto__']) await assert.rejects(s.run(op), (e) => e.refused && e.message === `unknown operation ${op}`);
  assert.equal(s.svc.calls.length, 0);
  assert.deepEqual(await s.run('read', { threadId: 'x'.repeat(200) }), { comments: [] });
  assert.equal((await s.run('edit', { threadId: 't', removed: [], added: Array.from({ length: 100 }, (_, index) => ({ comment: a, index })) })).comments.length, 100);
  await s.run('edit', { threadId: 't', removed: Array(100).fill(a), added: [] });
});

test('missing windows and service methods refuse; attempted subscribe and edit failures propagate', async () => {
  const s = setup([]);
  await assert.rejects(s.run('read', { threadId: 't' }), (e) => e.refused && /window/.test(e.message));
  s.add({ id: 1, host: { services: {} } });
  await assert.rejects(s.run('read', { threadId: 't' }), (e) => e.refused && /commentAttachments/.test(e.message));
  for (const missing of ['subscribe', 'edit']) {
    s.state.windows[0] = window(1, { subscribe() {}, edit() {}, [missing]: null });
    await assert.rejects(s.run('read', { threadId: 't' }), (e) => e.refused && e.message.includes(missing));
  }
  const error = new Error('service failed');
  s.state.windows[0] = window(1, { subscribe() { throw error; }, edit() { throw error; } });
  await assert.rejects(s.run('read', { threadId: 't' }), (e) => e === error);
  await assert.rejects(s.run('edit', { threadId: 't', removed: [], added: [] }), (e) => e === error);
});
