// The main composer area with fake AppHost/electron services and a temporary Codex home. No native app or real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./composer.cjs');
const ATOMS = 'electron-persisted-atom-state', DRAFTS = 'composer-prompt-drafts-v2';
const CHANNEL = 'codex_desktop:message-for-view';
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function store(atoms = {}, selected = null) {
  const listeners = new Set(), reads = [], watched = [];
  return {
    atoms, reads, watched, listeners, selected,
    get(key) { reads.push(key); assert.ok(key === ATOMS || key === 'selected-project'); return key === ATOMS ? this.atoms : this.selected; },
    set() { assert.fail('the global state must be read-only'); },
    onDidChange(key, fn) { watched.push(key); listeners.add(fn); return () => listeners.delete(fn); },
    change(atoms) { this.atoms = atoms; for (const fn of listeners) fn(); },
  };
}

function setup(windows) {
  const calls = [], reports = [], messages = new Map(), listeners = new Set();
  let run;
  const services = { appActions: { async runInPrimaryWindow(a) { calls.push(['action', a]); } } };
  const state = { windows: windows ?? [{ id: 7, host: { services } }] };
  const hooks = {
    appHost: { first: () => state.windows[0] ?? null, windows: () => state.windows, subscribe(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } },
    electron: { postToWindow(id, channel, message) { calls.push(['view', id, channel, message]); } },
    onAreaOp(area, fn) { assert.equal(area, 'composer'); run = fn; },
    onHostMessage(type, fn) { messages.set(type, fn); },
    areaReport(area, report) { assert.equal(area, 'composer'); reports.push(report); },
  };
  register(hooks);
  return { hooks, calls, reports, services, state, run, ready: () => messages.get('ready')(),
    add(w) { state.windows.push(w); for (const fn of listeners) fn({ type: 'added', id: w.id }); },
    remove(id) { state.windows = state.windows.filter((w) => w.id !== id); for (const fn of listeners) fn({ type: 'removed', id }); },
  };
}
const view = (message, id = 7) => ['view', id, CHANNEL, message];
const show = (threadId = 't') => ['action', { action: { type: 'windows.show_thread', windowId: 'current', threadId } }];
async function complete(t, promise, ms = 600) {
  await drain();
  t.mock.timers.tick(ms);
  await drain();
  return promise;
}

test('the drafts report includes only local prompt documents at most 64 KB, debounces changes and resends on ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const overhead = Buffer.byteLength(JSON.stringify(doc('')));
  const boundary = doc('x'.repeat(64 * 1024 - overhead));
  const st = store({ [DRAFTS]: {
    'local:a': { prompt: { document: doc('A'), plainTextMode: true }, pullRequestChecks: 'private' },
    'local:b': { prompt: { document: boundary } },
    'local:big': { prompt: { document: doc('x'.repeat(64 * 1024 - overhead + 1)) } },
    'local:unicode': { prompt: { document: doc('é'.repeat(33 * 1024)) } },
    'new:home': { prompt: { document: doc('home') } },
    'new-conversation': { prompt: { document: doc('a new chat') } },
    'remote:r': { prompt: { document: doc('remote') } },
    'local:missing': { pullRequestChecks: 'no document' },
  }, other: 'private atom' }, { type: 'local', projectId: 'p1' });
  const s = setup([{ id: 7, host: { services: { projects: { globalState: st } } } }]);
  t.mock.timers.tick(299);
  assert.equal(s.reports.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(s.reports, [{ drafts: [{ threadId: 'a', doc: doc('A') }, { threadId: 'b', doc: boundary }, { threadId: 'new:app:new-conversation', doc: doc('a new chat') }], newChat: { project: 'p1', clientId: null, cloud: null } }]);
  assert.deepEqual(st.watched, [ATOMS, 'selected-project'], 'the drafts and the new chat\'s project');
  assert.deepEqual(st.reads, [ATOMS, 'selected-project']);
  st.change({ [DRAFTS]: { 'local:a': { prompt: { document: doc('first') } } } });
  st.change({ [DRAFTS]: { 'local:a': { prompt: { document: doc('last') } } } });
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1), { drafts: [{ threadId: 'a', doc: doc('last') }], newChat: { project: 'p1', clientId: null, cloud: null } });
  assert.equal(s.reports.length, 2);
  s.ready();
  t.mock.timers.tick(300);
  assert.equal(s.reports.length, 3);
  assert.deepEqual(s.reports.at(-1), s.reports.at(-2));
  st.selected = null;
  st.change({});
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1), { drafts: [], newChat: { project: null, clientId: null, cloud: null } }, 'no project: a project-less new chat');
});

test('drafts hold the first live window with a store, unwatch on close and rebind as windows come and go', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = store({ [DRAFTS]: { 'local:a': { prompt: { document: doc('first') } } } });
  const next = store({ [DRAFTS]: { 'local:b': { prompt: { document: doc('next') } } } });
  const s = setup([{ id: 1, host: { services: {} } }, { id: 2, host: { services: { projects: { globalState: first } } } }]);
  s.add({ id: 3, host: { services: { projects: { globalState: next } } } });
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1), { drafts: [{ threadId: 'a', doc: doc('first') }], newChat: { project: null, clientId: null, cloud: null } });
  assert.equal(next.listeners.size, 0, 'keep the held store while its window lives');
  s.remove(1);
  s.remove(2);
  assert.equal(first.listeners.size, 0);
  assert.equal(next.listeners.size, 1);
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1), { drafts: [{ threadId: 'b', doc: doc('next') }], newChat: { project: null, clientId: null, cloud: null } });
  const count = s.reports.length;
  first.change({});
  t.mock.timers.tick(300);
  assert.equal(s.reports.length, count);
  s.remove(3);
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1), { drafts: [], newChat: { project: null, clientId: null, cloud: null } });
  s.add({ id: 4, host: { services: { projects: { globalState: first } } } });
  t.mock.timers.tick(300);
  assert.equal(first.listeners.size, 1);
  s.ready();
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1), { drafts: [], newChat: { project: null, clientId: null, cloud: null } });
});

test('thread operations show the chat, wait for its composer, and send the exact clear, text, skill, attach and submit messages in order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  const skills = [{ name: 'one', path: '/skills/one/SKILL.md' }, { name: 'two', path: '/skills/two/SKILL.md' }];
  // Every attribute of the composer's mention node.
  const full = (skill) => ({ ...skill, displayName: skill.name, description: '', iconSmall: null });
  const setting = s.run('set-text', { threadId: 't', text: 'Hello', skills });
  await drain();
  assert.deepEqual(s.calls, [show()]);
  t.mock.timers.tick(599);
  await drain();
  assert.deepEqual(s.calls, [show()]);
  t.mock.timers.tick(1);
  assert.deepEqual(await setting, {});
  assert.deepEqual(s.calls, [show(), view({ type: 'run-command', id: 'composer.clear' }), view({ type: 'codex-micro-insert-composer-text', text: 'Hello' }), ...skills.map((skill) => view({ type: 'codex-micro-insert-skill-mention', skill: full(skill) }))]);
  s.calls.length = 0;
  assert.deepEqual(await complete(t, s.run('insert', { threadId: 't', text: 'More', skills: [skills[0]] })), {});
  assert.deepEqual(s.calls, [show(), view({ type: 'codex-micro-insert-composer-text', text: 'More' }), view({ type: 'codex-micro-insert-skill-mention', skill: full(skills[0]) })]);
  s.calls.length = 0;
  await complete(t, s.run('set-text', { threadId: 't', text: '', skills: [skills[1]] }));
  assert.deepEqual(s.calls, [show(), view({ type: 'run-command', id: 'composer.clear' }), view({ type: 'codex-micro-insert-skill-mention', skill: full(skills[1]) })]);
  s.calls.length = 0;
  await complete(t, s.run('insert', { threadId: 't', text: '', skills: [] }));
  assert.deepEqual(s.calls, [show()], 'empty text produces no insert message');
  s.calls.length = 0;
  await complete(t, s.run('attach', { threadId: 't', path: '/repo/a file.mjs' }));
  await complete(t, s.run('clear', { threadId: 't' }));
  await complete(t, s.run('submit', { threadId: 't' }));
  assert.deepEqual(s.calls, [show(), view({ type: 'add-context-file', file: { label: 'a file.mjs', path: '/repo/a file.mjs', fsPath: '/repo/a file.mjs' } }), show(), view({ type: 'run-command', id: 'composer.clear' }), show(), view({ type: 'run-command', id: 'composer.submit' })]);
});

test('messages after show go to the window the chat was shown in, not to one that became first meanwhile; a closed window is a refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  const sent = s.run('clear', { threadId: 't' });
  await drain();
  s.state.windows.unshift({ id: 9, host: { services: {} } });
  assert.deepEqual(await complete(t, sent), {});
  assert.deepEqual(s.calls, [show(), view({ type: 'run-command', id: 'composer.clear' })]);
  s.calls.length = 0;
  s.state.windows.shift();
  const gone = s.run('clear', { threadId: 't' });
  await drain();
  s.state.windows.shift();
  await assert.rejects(complete(t, gone), (e) => e.refused === true && /window closed/.test(e.message));
  assert.deepEqual(s.calls.filter((c) => JSON.stringify(c).includes('composer.clear')), [], 'nothing reached another window');
});

test('new-chat navigates with the optional project and text; submit-new waits 800 ms before submitting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 12345 });
  const s = setup();
  // each answers the window it showed the new chat in (the rest of an operation stays there)
  assert.deepEqual(await s.run('new-chat', { projectId: 'p', text: 'Work here' }), { windowId: 7 });
  assert.deepEqual(await s.run('new-chat', {}), { windowId: 7 });
  assert.deepEqual(await s.run('new-chat', { projectId: null }), { windowId: 7 }, 'no project (E8.3)');
  await assert.rejects(s.run('new-chat', { projectId: 3 }), /project id/);
  // where it runs (E8.3b): the app's route seeds
  assert.deepEqual(await s.run('new-chat', { projectId: 'p', mode: 'local' }), { windowId: 7 });
  assert.deepEqual(await s.run('new-chat', { mode: 'cloud' }), { windowId: 7 });
  await assert.rejects(s.run('new-chat', { mode: 'moon' }), /local, worktree or cloud/);
  assert.deepEqual(s.calls, [view({ type: 'navigate-to-route', path: '/', state: { focusComposerNonce: 12345, project: { type: 'local', projectId: 'p' }, prefillPrompt: 'Work here' } }), view({ type: 'navigate-to-route', path: '/', state: { focusComposerNonce: 12345 } }),
    view({ type: 'navigate-to-route', path: '/', state: { focusComposerNonce: 12345, project: null } }),
    view({ type: 'navigate-to-route', path: '/', state: { focusComposerNonce: 12345, project: { type: 'local', projectId: 'p' }, prefillComposerMode: 'local', prefillLocalExecution: true } }),
    view({ type: 'navigate-to-route', path: '/', state: { focusComposerNonce: 12345, prefillComposerMode: 'cloud' } })]);
  s.calls.length = 0;
  const sent = s.run('submit-new', {});
  t.mock.timers.tick(799);
  await drain();
  assert.deepEqual(s.calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(await sent, {});
  assert.deepEqual(s.calls, [view({ type: 'run-command', id: 'composer.submit' })]);
});

test('thread ids, attach paths and unknown operations refuse before any app action', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  for (const op of ['set-text', 'insert', 'attach', 'clear', 'submit']) {
    for (const threadId of [undefined, null, '', '  ', 3, {}, 't'.repeat(201)]) await assert.rejects(s.run(op, { threadId, path: '/repo/a' }), (e) => e.refused === true && /threadId/.test(e.message));
    await assert.rejects(s.run(op, null), (e) => e.refused === true);
  }
  for (const file of [undefined, null, '', 'relative/a', 3, {}]) await assert.rejects(s.run('attach', { threadId: 't', path: file }), (e) => e.refused === true && /absolute path/.test(e.message));
  for (const op of ['unknown', '__proto__']) await assert.rejects(s.run(op), (e) => e.refused === true && e.message === `unknown operation ${op}`);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(await complete(t, s.run('clear', { threadId: 't'.repeat(200) })), {});
});

test('missing windows, services and pages refuse; an attempted app action failure throws and never posts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup([]);
  await assert.rejects(s.run('clear', { threadId: 't' }), (e) => e.refused && /window/.test(e.message));
  await assert.rejects(s.run('new-chat'), (e) => e.refused && /window/.test(e.message));
  await assert.rejects(complete(t, s.run('submit-new'), 800), (e) => e.refused && /window/.test(e.message));
  s.state.windows.push({ id: 7, host: { services: s.services } });
  delete s.services.appActions;
  await assert.rejects(s.run('clear', { threadId: 't' }), (e) => e.refused && /appActions/.test(e.message));
  s.services.appActions = { runInPrimaryWindow: async () => { throw new Error('show failed'); } };
  await assert.rejects(s.run('clear', { threadId: 't' }), (e) => !e.refused && e.message === 'show failed');
  assert.deepEqual(s.calls, []);
  s.services.appActions = { runInPrimaryWindow: async () => {} };
  delete s.hooks.electron;
  await assert.rejects(complete(t, s.run('clear', { threadId: 't' })), (e) => e.refused && /pages/.test(e.message));
});

test('an app action has the kit deadline and cannot leave a late composer message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.services.appActions.runInPrimaryWindow = () => new Promise(() => {});
  const failed = assert.rejects(s.run('clear', { threadId: 't' }), /the app did not answer in 15000 ms/);
  t.mock.timers.tick(15_000);
  await failed;
  assert.deepEqual(s.calls, []);
});

test('prompts read a temporary Codex home, sort markdown files, parse optional front matter and bound UTF-8 content to 16 KB', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'composer-prompts-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const s = setup([]);
    assert.deepEqual(await s.run('prompts'), { prompts: [] }, 'a missing prompts directory is empty');
    await fs.mkdir(path.join(home, 'prompts'));
    await Promise.all([
      fs.writeFile(path.join(home, 'prompts', 'b.md'), 'Plain\nbody\n'),
      fs.writeFile(path.join(home, 'prompts', 'a.md'), '---\ndescription: "Review changes"\nargument-hint: \'PATH [DETAIL]\'\nignored: private\n---\nReview $ARGUMENTS\n'),
      fs.writeFile(path.join(home, 'prompts', 'c.md'), '---\r\ndescription: Windows lines\r\nargument-hint: FILE\r\n---\r\nCRLF body'),
      fs.writeFile(path.join(home, 'prompts', 'empty.md'), '---\n---\nEmpty front matter'),
      fs.writeFile(path.join(home, 'prompts', 'large.md'), 'x'.repeat(20 * 1024)),
      fs.writeFile(path.join(home, 'prompts', 'unicode.md'), 'x' + 'é'.repeat(9000)),
      fs.writeFile(path.join(home, 'prompts', 'ignored.txt'), 'ignored'),
      fs.mkdir(path.join(home, 'prompts', 'directory.md')),
    ]);
    const { prompts } = await s.run('prompts', {});
    assert.deepEqual(prompts.slice(0, 3), [
      { id: 'a', description: 'Review changes', argumentHint: 'PATH [DETAIL]', content: 'Review $ARGUMENTS\n' },
      { id: 'b', description: '', argumentHint: '', content: 'Plain\nbody\n' },
      { id: 'c', description: 'Windows lines', argumentHint: 'FILE', content: 'CRLF body' },
    ]);
    assert.deepEqual(prompts.map((p) => p.id), ['a', 'b', 'c', 'empty', 'large', 'unicode']);
    assert.deepEqual(prompts[3], { id: 'empty', description: '', argumentHint: '', content: 'Empty front matter' });
    assert.equal(prompts[4].content, 'x'.repeat(16 * 1024));
    assert.equal(prompts[5].content, 'x' + 'é'.repeat(8191));
    assert.ok(Buffer.byteLength(prompts[5].content) <= 16 * 1024);
    assert.deepEqual(s.calls, []);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('graph-layers L2: the new chat\'s own client id is reported, and its send\'s thread is read from the app\'s bindings', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const st = store({ [DRAFTS]: {}, 'draft-thread-identities-v1': { 'new-conversation': 'client-new-thread:1111' }, 'client-thread-bindings-v1': { 'client-new-thread:0000': 'th-old' } });
  const s = setup([{ id: 7, host: { services: { projects: { globalState: st } } } }]);
  t.mock.timers.tick(300);
  assert.deepEqual(s.reports.at(-1).newChat, { project: null, clientId: 'client-new-thread:1111', cloud: null });
  assert.deepEqual(await s.run('bound', { clientId: 'client-new-thread:1111' }), { threadId: null }, 'not sent yet');
  st.change({ ...st.atoms, 'client-thread-bindings-v1': { 'client-new-thread:0000': 'th-old', 'client-new-thread:1111': 'th-new' } });
  assert.deepEqual(await s.run('bound', { clientId: 'client-new-thread:1111' }), { threadId: 'th-new' });
  await assert.rejects(s.run('bound', {}), /client id/);
  // a new chat in the window the operation chose, or none
  await assert.rejects(s.run('new-chat', { windowId: 9 }), /not open/);
  assert.deepEqual(await s.run('new-chat', { windowId: 7 }), { windowId: 7 });
});

test('graph-layers L2d: set-access writes the local host\'s selection as the permissions menu does, through the app\'s own write when it is there', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written = [];
  const handler = { updatePersistedAtomState: (wc, key, value) => written.push([key, value]) };
  const st = store({ [DRAFTS]: {}, 'agent-mode-by-host-id': { remote1: 'auto', local: 'auto' } });
  const s = setup([{ id: 7, host: { services: { projects: { globalState: st }, browserHost: { messageHandler: handler } } } }]);
  t.mock.timers.tick(300);
  assert.deepEqual(await s.run('set-access', { access: 'approve' }), { by: 'app' });
  assert.deepEqual(written, [['permission-selection-by-host-id:local', { kind: 'agent-mode', agentMode: 'guardian-approvals' }], ['agent-mode-by-host-id', { remote1: 'auto', local: 'guardian-approvals' }]]);
  for (const bad of ['full', 'custom', undefined]) await assert.rejects(s.run('set-access', { access: bad }), /ask or approve/);
  // without the app's own write: the store, and the broadcast every window hears
  const sets = [];
  const st2 = { ...store({ [DRAFTS]: {} }), set(key, value) { sets.push([key, value]); } };
  const s2 = setup([{ id: 8, host: { services: { projects: { globalState: st2 } } } }]);
  t.mock.timers.tick(300);
  const done = s2.run('set-access', { access: 'ask' });
  assert.deepEqual(await done, { by: 'store' });
  assert.deepEqual(sets.at(-1)[1]['permission-selection-by-host-id:local'], { kind: 'agent-mode', agentMode: 'auto' });
  assert.ok(s2.calls.some(([k, id, , m]) => k === 'view' && id === 8 && m.type === 'persisted-atom-updated' && m.key === 'permission-selection-by-host-id:local'));
});

