// ExternalApp in the native provider (breadth step D3; apps.mjs): the app's open-in targets and computer-use approvals as apps, identity by
// bundle id where known, open in a target the app's way, and setComputerUse('ask') only after the user approves a mod's call (R17). The real
// mux with the fake app-server, the graph runtime and the codex source; the test plays framework-main's answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { appsData } from '../apps.mjs';
import { createCloudFeed, cloudStatus, cloudTypes } from '../cloud.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const TARGETS = [
  { id: 'vscode', label: 'VS Code', icon: '/apps/vscode.png', kind: 'editor', bundleId: 'com.microsoft.VSCode' },
  { id: 'fileManager', label: 'Finder', icon: '/apps/finder.png', kind: 'fileManager', bundleId: 'com.apple.finder' },
  { id: 'ghostty', label: 'Ghostty', icon: '/apps/ghostty.png', kind: 'terminal', bundleId: null },
];

test('appsData: one app per bundle (or target id), its opens by kind, its computer-use level from the approvals', () => {
  const apps = appsData({ targets: TARGETS, approvals: { apps: [{ bundleId: 'com.apple.finder', name: 'Finder' }, { bundleId: 'com.example.Tool', name: 'Tool' }] } });
  assert.deepEqual([...apps.keys()], ['com.microsoft.VSCode', 'com.apple.finder', 'ghostty', 'com.example.Tool']);
  assert.deepEqual(apps.get('com.apple.finder'), { state: { name: 'Finder', icon: '/apps/finder.png', opens: ['project', 'file', 'folder'], computerUse: 'always' }, target: 'fileManager', bundleId: 'com.apple.finder' });
  assert.deepEqual([apps.get('ghostty').state.opens, apps.get('ghostty').state.computerUse], [['project', 'folder'], 'ask']);
  assert.deepEqual(apps.get('com.example.Tool'), { state: { name: 'Tool', icon: 'app', opens: [], computerUse: 'always' }, target: null, bundleId: 'com.example.Tool' });
  assert.equal(appsData({ targets: TARGETS, approvals: null }).get('com.microsoft.VSCode').state.computerUse, 'unsupported', 'no computer-use settings');
});

async function setup() {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-apps-'));
  const asked = [];
  let allow = true;
  const approvals = { ask: async (q) => { asked.push(q); return allow ? { approved: true } : { approved: false, reason: 'the user did not allow it' }; } };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet, approvals });
  graph.registerTypes(NATIVE, 'native');
  await h.up();
  const calls = [];
  let approved = ['com.apple.finder', 'com.example.Tool'];
  let store = null;
  store = createAppProjects({
    log: quiet, timeoutMs: 2000,
    send: (m) => queueMicrotask(() => {
      calls.push([m.op, m.projectId, m.path, m.target, m.bundleId]);
      const done = (fields) => store.settle({ type: 'app-op-done', requestId: m.requestId, ...fields });
      if (m.op === 'apps') return done({ ok: true, result: { targets: TARGETS, preferred: 'vscode', approvals: { apps: approved.map((b) => ({ bundleId: b, name: b === 'com.example.Tool' ? 'Tool' : b, icon: null })) } } });
      if (m.op === 'remove-app-approval') { approved = approved.filter((b) => b !== m.bundleId); return done({ ok: true, result: { approved: false } }); }
      return done({ ok: true });
    }),
  });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 2, log: quiet, appProjects: store });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'ExternalApp') events.push([e.name, e.ref.id]); });
  store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/Users/q/repo'] }], selected: null, threads: {}, reset: true });
  await until(() => graph.resolve(refs.externalApp('com.apple.finder')), 2000, 'the apps');
  return {
    graph, store, calls, events, asked, setAllow: (v) => { allow = v; },
    async close() { await source.dispose(); graph.close(); store.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const mod = { kind: 'mod', id: 'mod.a' };

test('the apps are read when the app\'s projects are available; open() opens a project\'s path in a target', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.graph.list('ExternalApp').map((x) => [x.ref.id, x.state.computerUse]).sort(), [['com.apple.finder', 'always'], ['com.example.Tool', 'always'], ['com.microsoft.VSCode', 'ask'], ['ghostty', 'ask']]);
    const vs = refs.externalApp('com.microsoft.VSCode');
    const out = await s.graph.invoke({ ref: vs, operation: 'open', args: [refs.project('p1')], caller: mod });
    assert.equal(out.status, 'done');
    assert.deepEqual(s.calls.at(-1), ['open-in', 'p1', '/Users/q/repo', 'vscode', undefined]);
    await s.graph.invoke({ ref: refs.externalApp('ghostty'), operation: 'open', args: [refs.folder('/Users/q/repo/src')], caller: mod });
    assert.deepEqual(s.calls.at(-1), ['open-in', 'p1', '/Users/q/repo/src', 'ghostty', undefined]);
    // The same through the target's own openIn (the project and its folder are resident; a File's works alike once observed).
    assert.equal((await s.graph.invoke({ ref: refs.project('p1'), operation: 'openIn', args: [vs], caller: mod })).status, 'done');
    assert.equal((await s.graph.invoke({ ref: refs.folder('/Users/q/repo'), operation: 'openIn', args: [refs.externalApp('ghostty')], caller: mod })).status, 'done');
    assert.deepEqual(s.calls.slice(-2), [['open-in', 'p1', '/Users/q/repo', 'vscode', undefined], ['open-in', 'p1', '/Users/q/repo', 'ghostty', undefined]]);
    for (const [arg, reason] of [['https://example.com', 'unsupported'], [refs.file('/elsewhere/x.txt'), 'unavailable'], [refs.thread('t'), 'invalid']]) {
      assert.equal((await s.graph.invoke({ ref: vs, operation: 'open', args: [arg], caller: mod })).reason, reason, JSON.stringify(arg));
    }
  } finally { await s.close(); }
});

test('setComputerUse: lowering to ask asks the user first and takes the approval back; always and never cannot be set', async () => {
  const s = await setup();
  try {
    const finder = refs.externalApp('com.apple.finder');
    s.setAllow(false);
    const no = await s.graph.invoke({ ref: finder, operation: 'setComputerUse', args: ['ask'], caller: mod });
    assert.deepEqual([no.status, no.reason], ['refused', 'notAllowed']);
    assert.deepEqual(s.asked.map(({ signal, ...q }) => q), [{ modId: 'mod.a', operation: 'ExternalApp.setComputerUse', action: 'stop letting Codex use “Finder” without asking', detail: 'Codex will ask you again before it uses this app. This changes your computer-use settings, which Codex keeps on this Mac.' }]);
    assert.equal(s.calls.filter(([op]) => op === 'remove-app-approval').length, 0);
    s.setAllow(true);
    const yes = await s.graph.invoke({ ref: finder, operation: 'setComputerUse', args: ['ask'], caller: mod });
    assert.equal(yes.status, 'done');
    assert.deepEqual(s.calls.filter(([op]) => op === 'remove-app-approval'), [['remove-app-approval', undefined, undefined, undefined, 'com.apple.finder']]);
    assert.equal(s.graph.resolve(finder).state.computerUse, 'ask');
    assert.deepEqual(s.events, [['changed', 'com.apple.finder']]);
    // An app that is only approved (not an open-in target) stays when its approval is taken back, at "ask".
    assert.equal((await s.graph.invoke({ ref: refs.externalApp('com.example.Tool'), operation: 'setComputerUse', args: ['ask'], caller: mod })).status, 'done');
    assert.deepEqual([s.graph.resolve(refs.externalApp('com.example.Tool')).state.name, s.graph.resolve(refs.externalApp('com.example.Tool')).state.computerUse], ['Tool', 'ask']);
    assert.deepEqual(s.events, [['changed', 'com.apple.finder'], ['changed', 'com.example.Tool']]);
    // Nothing to change asks nobody; "always" and "never" are not the app's to set this way.
    const n = s.asked.length;
    assert.equal((await s.graph.invoke({ ref: finder, operation: 'setComputerUse', args: ['ask'], caller: mod })).status, 'done');
    for (const level of ['always', 'never']) assert.equal((await s.graph.invoke({ ref: finder, operation: 'setComputerUse', args: [level], caller: mod })).reason, 'unsupported', level);
    assert.equal(s.asked.length, n);
  } finally { await s.close(); }
});

test('cloud environments: the account\'s configs as CloudEnvironments, their status mapped, statusChanged, manage, gone when no longer listed', async () => {
  const graph = createGraph({ log: quiet });
  graph.registerTypes(NATIVE, 'native');
  let envs = [{ id: 'acct~asenvcfg_1', name: 'qa-cloud', status: 'building', repositories: ['github-1'], setupThreadId: 't', shared: 'private' }];
  const sent = [];
  let store = null;
  store = createAppProjects({ log: quiet, send: (m) => queueMicrotask(() => { sent.push([m.op, m.path]); store.settle({ type: 'app-op-done', requestId: m.requestId, ok: true, result: { signedIn: true, environments: envs } }); }) });
  const handle = graph.registerProvider('native', 'codex', { types: { Environment: {}, ...cloudTypes(store) } });
  let clock = 1000;
  const events = [];
  const resident = (r) => { const x = graph.resolve(r); return x && !x.gone ? x : null; };
  const feed = createCloudFeed({ handle, graph, appProjects: store, resident, safe: (w, fn) => fn(), emitEvent: (r, name) => { events.push(name); handle.emit(r, name); }, log: quiet, now: () => clock });
  try {
    store.apply({ type: 'projects', available: true, projects: [], selected: null, threads: {}, reset: true });
    const ref = refs.cloudEnvironment('acct~asenvcfg_1');
    await until(() => graph.resolve(ref), 2000, 'the environment');
    assert.deepEqual([graph.resolve(ref).ref.type, graph.resolve(ref).state, graph.resolve(ref).links.project], ['CloudEnvironment', { name: 'qa-cloud', status: 'preparing' }, null]);
    envs = [{ ...envs[0], status: 'ready' }];
    assert.equal(feed.observe(), undefined, 'fresh: not read again');
    clock += 31_000;
    await feed.observe();
    assert.deepEqual([graph.resolve(ref).state.status, events], ['ready', ['statusChanged']]);
    assert.equal((await graph.invoke({ ref, operation: 'manage', args: [], caller: { kind: 'mod', id: 'mod.a' } })).status, 'done');
    assert.deepEqual(sent.at(-1), ['navigate', '/settings/codex-cloud'], 'the app\'s Codex Cloud settings');
    envs = [];
    clock += 31_000;
    await feed.observe();
    assert.equal(graph.resolve(ref).gone, true, 'no longer listed');
    assert.deepEqual(['ready', 'draft', 'failed', 'error'].map(cloudStatus), ['ready', 'preparing', 'unavailable', 'unavailable']);
  } finally { feed.dispose(); store.dispose(); graph.close(); }
});
