// Changes through the real graph, source, mux and fake app-server. Item notifications use fake/notify; recorded read replies are supplied
// on the mux for historical turns (the fake deliberately does not add synthetic notifications to its stored history).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as changes from '../areas/changes.mjs';
import { produced } from './areas/changes.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user' }, mod = { kind: 'mod', id: 'mod.a' };
const update = '@@ -1 +1 @@\n-old\n+new\n';
const second = '@@ -4 +4,2 @@\n-last\n+one\n+two\n';
const add = (p = 'a', diff = 'one\ntwo\n') => ({ path: p, kind: { type: 'add' }, diff });
const edit = (p = 'a', diff = update) => ({ path: p, kind: { type: 'update', move_path: null }, diff });
const item = (id, entries, status = 'completed') => ({ id, type: 'fileChange', changes: entries, status });
const turn = (id, items, startedAt = 1) => ({ id, items, startedAt, status: 'completed', completedAt: startedAt + 1, error: null });
const done = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const refused = (r, reason) => { assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(r.reason, reason); };

async function setup({ main = true } = {}) {
  const h = await harness(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-changes-'));
  const prompts = [], events = [], ops = [], puts = [], notes = [], warnings = [], reads = [], answers = new Map(), history = new Map();
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  let sequence = 6000, feed, context, approved = true, mainOps;
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const ask = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const replay = h.mux.client('test:changes-reads');
  replay.intercept('serverResponse', ['thread/read', 'thread/resume', 'thread/turns/list'], (m, info) => {
    const rows = history.get(info.affinityKey);
    reads.push({ method: info.method, threadId: info.affinityKey, recorded: !!rows });
    if (!rows) return;
    const result = info.method === 'thread/turns/list' ? { data: [...rows].reverse(), nextCursor: null }
      : { ...m.result, thread: { ...m.result.thread, turns: rows } };
    return { replace: { ...m, result } };
  });
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'changes');
    ops.push([m.op, m.args]);
    queueMicrotask(() => {
      const answer = answers.get(m.op), value = typeof answer === 'function' ? answer(m.args, ops.length) : answer;
      mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...(value ?? { ok: true, result: {} }) });
    });
  } });
  const area = { ...changes, createFeed(ctx) {
    context = ctx;
    feed = changes.createFeed({ ...ctx, handle: { ...ctx.handle, put(ref, data) { puts.push(ref); return ctx.handle.put(ref, data); } } });
    return { ...feed, notified(method, params) { try { feed.notified(method, params); } finally { notes.push([method, params]); } } };
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, mainOps, areas: { changes: area } });
  graph.onEvent((e) => { if (e.kind === 'event' && ['ChangeSet', 'FileChange'].includes(e.ref.type)) events.push([e.ref, e.name]); });
  await source.start();
  const threadId = (await ask('thread/start', { cwd: '/repo' })).thread.id;
  await ask('thread/name/set', { threadId, name: 'Chat' });
  await until(() => graph.resolve(refs.thread(threadId))?.state.title === 'Chat');
  const notify = async (method, params) => {
    const n = notes.length;
    await ask('fake/notify', { method, params });
    await until(() => notes.length > n && notes.slice(n).some(([m]) => m === method), 3000, method);
    assert.deepEqual(warnings, []);
  };
  const setRef = (id = 'u') => refs.changeSet('turn', id);
  const fileRef = (p = 'a', id = 'u') => refs.fileChange(setRef(id).id, p);
  return {
    h, graph, source, feed, context, threadId, prompts, events, ops, puts, notes, warnings, reads, answers, history, ask, notify, setRef, fileRef,
    threadSet: refs.changeSet('thread', threadId),
    state: (ref) => graph.resolve(ref)?.state,
    invoke: (ref, operation, caller = user, args = []) => graph.invoke({ ref, operation, caller, args }),
    approve: (value) => { approved = value; },
    startTurn: (id = 'u', startedAt = 1) => notify('turn/started', { threadId, turn: { ...turn(id, [], startedAt), status: 'inProgress' } }),
    send: (entries, { id = 'i', turnId = 'u', status = 'completed', method = 'item/completed' } = {}) => notify(method, { threadId, turnId, item: item(id, entries, status) }),
    async close() { await source.dispose(); mainOps?.dispose(); await replay.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('hunks retain ranges, context and exact text; counts distinguish content from update headers', () => {
  const diff = `diff --git a/a b/a\n--- a/a\n+++ b/a\n${update}@@ -8,2 +9,3 @@ heading\n same\n-old\n+new\n+extra\n`;
  assert.deepEqual(changes.parseHunks(diff), [
    { before: { start: 1, lines: 1 }, after: { start: 1, lines: 1 }, text: update },
    { before: { start: 8, lines: 2 }, after: { start: 9, lines: 3 }, text: '@@ -8,2 +9,3 @@ heading\n same\n-old\n+new\n+extra\n' },
  ]);
  assert.deepEqual(changes.parseHunks('no hunks'), []);
  assert.equal(changes.parseHunks('@@ -1 +1 @@\n--- old\n+++ new\n\\ No newline at end of file')[0].text, '@@ -1 +1 @@\n--- old\n+++ new\n\\ No newline at end of file\n');
  for (const [content, n] of [['', 0], ['one', 1], ['one\n', 1], ['one\n\n', 2]]) {
    assert.deepEqual(changes.countLines(add('a', content)), { added: n, removed: 0 });
    assert.deepEqual(changes.countLines({ ...add('a', content), kind: { type: 'delete' } }), { added: 0, removed: n });
  }
  assert.deepEqual(changes.countLines(edit('a', diff)), { added: 3, removed: 2 });
});

test('patches keep complete headers, relativize paths inside cwd, and build add, delete and move headers', () => {
  assert.equal(changes.patchOf(add('/repo/a'), '/repo'), '--- /dev/null\n+++ b/a\n@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.equal(changes.patchOf({ path: '/repo/a', kind: { type: 'delete' }, diff: 'gone' }, '/repo'), '--- a/a\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n');
  const move = { path: '/repo/old', kind: { type: 'update', move_path: '/repo/new' }, diff: update };
  assert.equal(changes.patchOf(move, '/repo', { reverse: true }), `diff --git a/old b/new\nrename from old\nrename to new\n--- a/old\n+++ b/new\n${update}`);
  assert.equal(changes.patchOf({ ...move, diff: '' }, '/repo'), 'diff --git a/old b/new\nrename from old\nrename to new\n');
  assert.equal(changes.patchOf(edit('/other/a', update.trimEnd()), '/repo'), `--- a//other/a\n+++ b//other/a\n${update}`);
  assert.equal(changes.patchOf(edit('/repository/a'), '/repo'), `--- a//repository/a\n+++ b//repository/a\n${update}`);
  for (const diff of ['diff --git a/a b/a\n--- a/a\n+++ b/a\n' + update, '--- a/a\n+++ b/a\n' + update]) {
    assert.equal(changes.patchOf(edit('ignored', diff.trimEnd()), '/repo'), diff);
  }
});

test('generated patches apply and reverse in a temporary repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-changes-patches-'));
  try {
    execFileSync('git', ['init', '--quiet', dir]);
    const cases = [add('added'), edit('edited'), { path: 'deleted', kind: { type: 'delete' }, diff: 'old\n' },
      { path: 'before', kind: { type: 'update', move_path: 'after' }, diff: update },
      { path: 'rename-only', kind: { type: 'update', move_path: 'renamed-only' }, diff: '' }];
    for (const c of cases) {
      if (c.kind.type !== 'add') fs.writeFileSync(path.join(dir, c.path), 'old\n');
      const patch = changes.patchOf(c, dir);
      execFileSync('git', ['apply', '--check', '-'], { cwd: dir, input: patch });
      execFileSync('git', ['apply', '-'], { cwd: dir, input: patch });
      const destination = c.kind.move_path ?? c.path;
      if (c.kind.type === 'delete') assert.equal(fs.existsSync(path.join(dir, destination)), false);
      else assert.equal(fs.readFileSync(path.join(dir, destination), 'utf8'), c.kind.type === 'add' ? c.diff : c.diff ? 'new\n' : 'old\n');
      if (c.kind.move_path) assert.equal(fs.existsSync(path.join(dir, c.path)), false);
      execFileSync('git', ['apply', '-R', '-'], { cwd: dir, input: patch });
      if (c.kind.type === 'add') assert.equal(fs.existsSync(path.join(dir, c.path)), false);
      else assert.equal(fs.readFileSync(path.join(dir, c.path), 'utf8'), 'old\n');
      if (c.kind.move_path) assert.equal(fs.existsSync(path.join(dir, destination)), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('data samples cover each kind, turn and thread aggregation, states, empty sets, parents and inverse links', () => {
  const data = produced(), set = data.find((d) => d.ref.id === 'turn:u');
  assert.deepEqual(set.state, { fileCount: 5, added: 7, removed: 5, state: 'mixed' });
  assert.deepEqual(set.links, { thread: refs.thread('t'), turn: refs.turn('u'), environment: refs.localEnvironment('p') });
  const byPath = (setId, p) => data.find((d) => d.ref.type === 'FileChange' && d.links.changeSet.id === setId && d.state.path === p);
  assert.deepEqual(byPath('turn:u', 'after').state, { path: 'after', kind: 'renamed', from: 'before', added: 1, removed: 1, state: 'applied' });
  assert.equal(byPath('turn:u', 'last-delete').state.kind, 'deleted');
  assert.deepEqual([byPath('thread:t', 'add').state.kind, byPath('thread:t', 'add').state.state, byPath('thread:t', 'add').state.added], ['modified', 'reverted', 3]);
  assert.deepEqual(byPath('turn:u', 'add').links.file, refs.file('/repo/add'));
  assert.deepEqual(data.find((d) => d.ref.id === 'turn:empty').state, { fileCount: 0, added: 0, removed: 0, state: 'applied' });
  const all = changes.changeSetData('thread', 't', [{ threadId: 't', turnId: 'u', change: add(), state: 'reverted' }]);
  assert.equal(all.changeSet.state.state, 'reverted');
  assert.equal(all.hunks.length, 1);
  assert.deepEqual(all.hunks[0].links.fileChange, all.files[0].ref);
});

test('item notifications build both sets, kinds, counts and hunks; FileEdit resolves its change; sync then changed, with no repeated puts', async () => {
  const s = await setup();
  try {
    await s.startTurn();
    await s.send([add()]);
    assert.deepEqual(s.state(s.setRef()), { fileCount: 1, added: 2, removed: 0, state: 'applied' });
    assert.deepEqual(s.events, [], 'first learning is a sync');
    assert.deepEqual(s.graph.related(refs.item('FileEdit', s.threadId, 'i:0'), 'change').ref, s.fileRef());
    assert.deepEqual(s.graph.related(s.setRef(), 'files').map((f) => f.ref), [s.fileRef()]);
    assert.deepEqual(s.state(refs.hunk(s.fileRef().id, 0)), { before: { start: 0, lines: 0 }, after: { start: 1, lines: 2 }, state: 'applied' });
    assert.deepEqual(s.graph.resolve(s.setRef()).links.environment, null);
    const entries = [{ path: 'old', kind: { type: 'update', move_path: 'moved' }, diff: update }, { path: 'deleted', kind: { type: 'delete' }, diff: 'one\ntwo\n' }, edit('twice'), edit('twice', second)];
    await s.send(entries, { id: 'j' });
    assert.deepEqual(s.state(s.setRef()), { fileCount: 4, added: 6, removed: 5, state: 'applied' });
    assert.deepEqual(s.state(s.threadSet), s.state(s.setRef()));
    assert.deepEqual(s.state(s.fileRef('moved')), { path: 'moved', kind: 'renamed', from: 'old', added: 1, removed: 1, state: 'applied' });
    assert.equal(s.state(s.fileRef('deleted')).kind, 'deleted');
    assert.deepEqual([s.state(s.fileRef('twice')).added, s.state(s.fileRef('twice')).removed], [3, 2]);
    assert.equal(s.graph.related(s.fileRef('twice'), 'hunks').length, 2);
    assert.equal(s.events.filter(([r, name]) => r.type === 'ChangeSet' && name === 'changed').length, 2);
    assert.equal(s.events.some(([r]) => r.id === s.fileRef().id), false, 'unchanged file counts and state emit nothing');
    const n = s.puts.length;
    s.events.length = 0;
    await s.send(entries, { id: 'j' });
    assert.equal(s.puts.length, n);
    assert.deepEqual(s.events, []);
    await s.notify('item/fileChange/patchUpdated', { threadId: s.threadId, turnId: 'u', itemId: 'j', changes: [edit('twice', second)] });
    assert.deepEqual(s.state(s.setRef()), { fileCount: 2, added: 4, removed: 1, state: 'applied' });
    assert.equal(s.graph.resolve(s.fileRef('moved')).gone, true);
    assert.equal(s.graph.resolve(refs.hunk(s.fileRef('twice').id, 1)).gone, true);
    await s.send([add('failed')], { id: 'fail', status: 'failed' });
    await s.send([add('declined')], { id: 'decline', status: 'declined' });
    assert.equal(s.state(s.setRef()).fileCount, 2);
  } finally { await s.close(); }
});

test('FileChange.diff and ChangeSet.patch: the turn\'s patches as unified diff text, a file\'s or every file\'s, in the order they ran', async () => {
  const s = await setup();
  try {
    await s.startTurn();
    await s.send([add(), edit('b')]);
    await s.send([edit('b', second)], { id: 'k' });
    const patchOf = (c) => changes.patchOf(c, '/repo');
    assert.equal(done(await s.invoke(s.fileRef('b'), 'diff', mod)), patchOf(edit('b')) + patchOf(edit('b', second)));
    assert.equal(done(await s.invoke(s.setRef(), 'patch', mod)), patchOf(add()) + patchOf(edit('b')) + patchOf(edit('b', second)));
    // the chat's own set (and its files): every turn's, in the order they ran
    await s.startTurn('u2', 2);
    await s.send([add('c'), edit('b', update)], { id: 'k2', turnId: 'u2' });
    const turn1 = done(await s.invoke(s.setRef(), 'patch', mod)), turn2 = done(await s.invoke(s.setRef('u2'), 'patch', mod));
    assert.equal(done(await s.invoke(s.threadSet, 'patch', mod)), turn1 + turn2);
    assert.equal(done(await s.invoke(refs.fileChange(s.threadSet.id, 'b'), 'diff', mod)), patchOf(edit('b')) + patchOf(edit('b', second)) + patchOf(edit('b', update)));
    assert.deepEqual(s.ops, [], 'read here: nothing asked of the app');
  } finally { await s.close(); }
});

test('thread union takes the latest turn kind and state and sums lines; reads restore the area links and unchanged reads do not put', async () => {
  const s = await setup();
  try {
    await s.startTurn(); await s.send([add()]);
    await s.startTurn('v', 2); await s.send([edit()], { turnId: 'v', id: 'v-edit' });
    const threadFile = refs.fileChange(s.threadSet.id, 'a');
    assert.deepEqual(s.state(threadFile), { path: 'a', kind: 'modified', added: 3, removed: 1, state: 'applied' });
    done(await s.invoke(s.fileRef('a', 'v'), 'revert'));
    assert.equal(s.state(threadFile).state, 'reverted');
    const rows = [turn('u', [item('i', [add()])]), turn('v', [item('v-edit', [edit()])], 2)];
    s.history.set(s.threadId, rows);
    const n = s.puts.length;
    s.events.length = 0;
    for (const method of ['thread/read', 'thread/resume', 'thread/turns/list', 'thread/list']) {
      await s.ask(method, method === 'thread/list' ? { limit: 10 } : { threadId: s.threadId, includeTurns: true, itemsView: 'full' });
      await until(() => s.graph.resolve(refs.thread(s.threadId)).links.changes?.id === s.threadSet.id);
      assert.deepEqual(s.graph.resolve(refs.turn('u')).links.changes, s.setRef());
      assert.deepEqual(s.graph.resolve(refs.turn('v')).links.changes, s.setRef('v'));
    }
    assert.equal(s.puts.length, n);
    assert.deepEqual(s.events, []);
    assert.equal(s.state(threadFile).state, 'reverted', 'a repeated read preserves the undo state');
    await s.send([edit('a', second)], { turnId: 'v', id: 'new' });
    assert.equal(s.state(threadFile).state, 'applied', 'the next edit of the path clears its undo state');
  } finally { await s.close(); }
});

test('observing change refs loads history from turns/list, including newly resident turns; read/resume also learn items and environment', async () => {
  const s = await setup();
  try {
    const environment = refs.localEnvironment('project');
    s.source.provider.update(refs.thread(s.threadId), { links: { environment } });
    s.history.set(s.threadId, [turn('historical', [item('history', [add('past')])])]);
    const sub = s.graph.subscribe({ ref: s.threadSet }, () => {});
    await sub.loaded; sub.dispose();
    assert.ok(s.reads.some((r) => r.method === 'thread/turns/list' && r.recorded), JSON.stringify({ reads: s.reads, warnings: s.warnings }));
    await until(() => s.state(s.setRef('historical')), 3000, 'the historical change set from the mux observer');
    assert.deepEqual(s.state(s.setRef('historical')), { fileCount: 1, added: 2, removed: 0, state: 'applied' });
    assert.deepEqual(s.graph.resolve(s.threadSet).links.environment, environment);
    assert.deepEqual(s.events, []);
    for (const ref of [s.setRef('historical'), s.fileRef('past', 'historical'), refs.hunk(s.fileRef('past', 'historical').id, 0)]) await s.feed.observe(ref, ref.type);
    assert.equal(s.feed.observe(refs.thread(s.threadId), 'Thread'), undefined);
    s.history.set(s.threadId, [turn('historical', [item('history', [add('past', 'three\nlines\nhere\n')])])]);
    await s.ask('thread/read', { threadId: s.threadId, includeTurns: true });
    await until(() => s.state(s.setRef('historical')).added === 3);
    assert.ok(s.events.some(([r, e]) => r.id === s.fileRef('past', 'historical').id && e === 'changed'));
    s.history.set(s.threadId, [turn('resumed', [item('resumed-item', [edit('next')])], 2)]);
    await s.ask('thread/resume', { threadId: s.threadId });
    await until(() => s.state(s.setRef('resumed'))?.removed === 1);
  } finally { await s.close(); }
});

test('a pending resident EditApproval makes an in-progress item proposed, and answering or completing it makes it applied', async () => {
  const s = await setup();
  try {
    await s.startTurn();
    s.h.app.send({ id: 9000, method: 'fake/serverRequest', params: { method: 'item/fileChange/requestApproval', params: { threadId: s.threadId, turnId: 'u', itemId: 'i', startedAtMs: 1000 } } });
    const request = await s.h.app.waitFor((m) => m.method === 'item/fileChange/requestApproval');
    await until(() => s.graph.list('EditApproval').length === 1);
    await s.send([add()], { status: 'inProgress', method: 'item/started' });
    assert.equal(s.state(s.fileRef()).state, 'proposed');
    assert.equal(s.state(s.setRef()).state, 'proposed');
    assert.equal(s.state(refs.hunk(s.fileRef().id, 0)).state, 'proposed');
    refused(await s.invoke(s.setRef(), 'revert', mod), 'unsupported');
    refused(await s.invoke(s.setRef(), 'apply', mod), 'unsupported');
    assert.deepEqual(s.prompts, []);
    s.h.app.send({ id: request.id, result: { decision: 'accept' } });
    await s.h.app.reply(9000);
    await until(() => s.state(s.fileRef()).state === 'applied');
    await s.send([add()]);
    assert.equal(s.state(s.setRef()).state, 'applied');
  } finally { await s.close(); }
});

test('set undo is newest first, reapply oldest first; file and hunk operations send their patches and change states and events', async () => {
  const s = await setup();
  try {
    await s.startTurn();
    const entries = [add('a'), add('b'), edit('a')];
    await s.send(entries);
    done(await s.invoke(s.setRef(), 'revert'));
    assert.deepEqual(s.ops, [...entries].reverse().map((c) => ['apply-patch', { cwd: '/repo', diff: changes.patchOf(c, '/repo'), revert: true, atomic: true }]));
    assert.equal(s.state(s.setRef()).state, 'reverted');
    assert.equal(s.state(s.threadSet).state, 'reverted');
    assert.equal(s.state(s.fileRef()).state, 'reverted');
    assert.equal(s.state(refs.hunk(s.fileRef().id, 0)).state, 'reverted');
    assert.deepEqual(s.events.at(-1), [s.setRef(), 'reverted']);
    s.ops.length = 0;
    done(await s.invoke(s.setRef(), 'apply'));
    assert.deepEqual(s.ops, entries.map((c) => ['apply-patch', { cwd: '/repo', diff: changes.patchOf(c, '/repo'), revert: false, atomic: true }]));
    assert.equal(s.state(s.setRef()).state, 'applied');
    assert.deepEqual(s.events.at(-1), [s.setRef(), 'applied']);
    s.ops.length = 0;
    done(await s.invoke(s.fileRef(), 'revert'));
    assert.deepEqual(s.ops.map(([, a]) => a.diff), [changes.patchOf(entries[2], '/repo'), changes.patchOf(entries[0], '/repo')]);
    assert.equal(s.state(s.setRef()).state, 'mixed');
    assert.equal(s.state(s.fileRef('b')).state, 'applied');
    done(await s.invoke(s.fileRef(), 'apply'));
    assert.equal(s.state(s.setRef()).state, 'applied');
    s.ops.length = 0;
    const hunk = refs.hunk(s.fileRef().id, 1);
    done(await s.invoke(hunk, 'revert'));
    assert.deepEqual(s.ops, [['apply-patch', { cwd: '/repo', diff: `--- a/a\n+++ b/a\n${update}`, revert: true, atomic: true }]]);
    assert.equal(s.state(hunk).state, 'reverted');
    done(await s.invoke(hunk, 'apply'));
    assert.deepEqual(s.ops.at(-1), ['apply-patch', { cwd: '/repo', diff: `--- a/a\n+++ b/a\n${update}`, revert: false, atomic: true }]);
    assert.equal(s.state(hunk).state, 'applied');
    assert.deepEqual(s.prompts, [], 'user calls ask nothing');
  } finally { await s.close(); }
});

test('thread mutations and redundant mutations refuse without calls or prompts; each mod mutation has the exact R17 wording', async () => {
  const s = await setup();
  try {
    await s.startTurn(); await s.send([add()]);
    for (const ref of [s.threadSet, refs.fileChange(s.threadSet.id, 'a'), refs.hunk(refs.fileChange(s.threadSet.id, 'a').id, 0)]) {
      for (const op of ['revert', 'apply']) refused(await s.invoke(ref, op, mod), 'unsupported');
    }
    refused(await s.invoke(s.setRef(), 'apply', mod), 'unsupported');
    assert.deepEqual(s.ops, []); assert.deepEqual(s.prompts, []);
    const hunk = refs.hunk(s.fileRef().id, 0);
    const objects = [[s.setRef(), 'the changes of a turn in “Chat”'], [s.fileRef(), 'the changes to a'], [hunk, 'a change in a']];
    for (const [ref, object] of objects) {
      done(await s.invoke(ref, 'revert', mod));
      const n = s.prompts.length, calls = s.ops.length;
      refused(await s.invoke(ref, 'revert', mod), 'unsupported');
      assert.equal(s.prompts.length, n); assert.equal(s.ops.length, calls);
      done(await s.invoke(ref, 'apply', mod));
      assert.deepEqual(s.prompts.slice(-2), ['undo', 'reapply'].map((v) => ({ action: `${v} ${object}`, detail: 'It changes the files in /repo with git apply.' })));
    }
    s.approve(false);
    const n = s.ops.length;
    refused(await s.invoke(s.setRef(), 'revert', mod), 'notAllowed');
    assert.equal(s.ops.length, n);
    assert.equal(s.state(s.setRef()).state, 'applied');
  } finally { await s.close(); }
});

test('a hunk operation sends only the selected hunk of a multi-hunk patch, keeping complete file headers', async () => {
  const s = await setup();
  try {
    await s.startTurn();
    const headers = 'diff --git a/a b/a\nindex 1111111..2222222 100644\n--- a/a\n+++ b/a\n';
    await s.send([edit('a', `${headers}${update}${second}`)]);
    const hunk = refs.hunk(s.fileRef().id, 1);
    assert.deepEqual(s.state(hunk), { before: { start: 4, lines: 1 }, after: { start: 4, lines: 2 }, state: 'applied' });
    done(await s.invoke(hunk, 'revert'));
    assert.deepEqual(s.ops, [['apply-patch', { cwd: '/repo', diff: headers + second, revert: true, atomic: true }]]);
    done(await s.invoke(hunk, 'apply'));
    assert.deepEqual(s.ops.at(-1), ['apply-patch', { cwd: '/repo', diff: headers + second, revert: false, atomic: true }]);
  } finally { await s.close(); }
});

test('a failed undo marks completed files, throws on partial-success/error, and stops without replaying or emitting reverted', async () => {
  const s = await setup();
  try {
    await s.startTurn(); await s.send([add('a'), add('b'), add('c')]);
    s.answers.set('apply-patch', (_args, n) => n === 2 ? { ok: false, error: 'git apply: partial-success; conflictedPaths: b; skippedPaths: b' } : { ok: true });
    const r = await s.invoke(s.setRef(), 'revert');
    assert.equal(r.status, 'failed'); assert.match(r.error.message, /partial-success.*b/);
    assert.equal(s.ops.length, 2);
    assert.equal(s.state(s.fileRef('c')).state, 'reverted');
    assert.equal(s.state(s.fileRef('b')).state, 'applied');
    assert.equal(s.state(s.setRef()).state, 'mixed');
    assert.equal(s.events.some(([, e]) => e === 'reverted'), false);
    s.answers.set('apply-patch', { ok: false, error: 'git apply: error; conflictedPaths: b' });
    const again = await s.invoke(s.fileRef('b'), 'revert');
    assert.equal(again.status, 'failed'); assert.match(again.error.message, /git apply: error/);
    s.answers.set('apply-patch', { ok: false, refused: true, error: 'no app window' });
    refused(await s.invoke(s.fileRef('b'), 'revert'), 'unavailable');
    assert.equal(s.state(s.fileRef('b')).state, 'applied');
  } finally { await s.close(); }
});

test('file diff, file tabs, external apps and FileEdit actions use the correct thread and absolute path, without R17 prompts', async () => {
  const s = await setup();
  try {
    await s.startTurn(); await s.send([add('src/a')]);
    const file = s.fileRef('src/a'), step = refs.item('FileEdit', s.threadId, 'i:0');
    done(await s.invoke(file, 'viewDiff', mod)); done(await s.invoke(file, 'openFile', mod));
    done(await s.invoke(file, 'openIn', mod, [refs.externalApp('editor')]));
    done(await s.invoke(step, 'openDiff', mod)); done(await s.invoke(step, 'openFile', mod));
    assert.deepEqual(s.ops, [
      ['view-diff', { threadId: s.threadId, path: '/repo/src/a' }], ['open-file', { threadId: s.threadId, path: '/repo/src/a' }],
      ['open-in', { path: '/repo/src/a', appId: 'editor' }], ['view-diff', { threadId: s.threadId, path: '/repo/src/a' }], ['open-file', { threadId: s.threadId, path: '/repo/src/a' }],
    ]);
    for (const app of [{ ...refs.externalApp('editor'), provider: 'other' }, refs.file('/repo/a')]) refused(await s.invoke(file, 'openIn', mod, [app]), 'invalid');
    assert.deepEqual(s.prompts, []);
    s.answers.set('view-diff', { ok: false, refused: true, error: 'the app shows a diff beside a chat, and no chat is open' });
    refused(await s.invoke(file, 'viewDiff'), 'unavailable');
    s.answers.set('open-file', { ok: false, error: 'tab failed' });
    const r = await s.invoke(step, 'openFile');
    assert.equal(r.status, 'failed'); assert.match(r.error.message, /tab failed/);
  } finally { await s.close(); }
});

test('missing framework-main refuses; thread deletion removes the sets and their files and hunks; disposal stops the feed', async () => {
  const s = await setup({ main: false });
  try {
    await s.startTurn(); await s.send([add()]);
    refused(await s.invoke(s.setRef(), 'revert'), 'unavailable');
    refused(await s.invoke(s.fileRef(), 'openFile'), 'unavailable');
    await s.notify('thread/deleted', { threadId: s.threadId });
    for (const type of ['ChangeSet', 'FileChange', 'Hunk']) assert.equal(s.graph.list(type).length, 0);
    const n = s.puts.length;
    s.feed.dispose();
    s.feed.notified('item/completed', { threadId: s.threadId, turnId: 'u', item: item('later', [add()]) });
    s.feed.responded('thread/read', { thread: { id: s.threadId, turns: [turn('u', [item('later', [add()])])] } });
    assert.equal(s.puts.length, n);
  } finally { await s.close(); }
});

test('a thread missing from the next learning takes its sets, files and hunks even without a deleted notification', async () => {
  const s = await setup();
  try {
    await s.startTurn(); await s.send([add()]);
    await s.ask('fake/forget', { threadId: s.threadId });
    await s.source.resync('thread disappeared');
    await until(() => s.graph.resolve(refs.thread(s.threadId))?.gone);
    const next = (await s.ask('thread/start', { cwd: '/repo' })).thread.id;
    await s.notify('turn/started', { threadId: next, turn: turn('next', [], 2) });
    await s.notify('item/completed', { threadId: next, turnId: 'next', item: item('next-edit', [add('next')]) });
    assert.equal(s.graph.resolve(s.fileRef()).gone, true);
    assert.equal(s.graph.resolve(refs.hunk(s.fileRef().id, 0)).gone, true);
    assert.ok(s.graph.list('ChangeSet').every((x) => x.links.thread.id === next));
  } finally { await s.close(); }
});
