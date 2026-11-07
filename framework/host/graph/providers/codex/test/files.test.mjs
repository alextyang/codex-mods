// Folder and File in the native provider (breadth step D3; files.mjs): a project's folder with the project, a folder's contents read when it
// is observed, a file when it is, and changes through the protocol's watches. The real mux with the strict fake app-server (which watches
// for real and sends fs/changed on fake/fsChanged), the graph runtime and the codex source; the test plays framework-main, answering
// `list` and `inspect` from the disk as the app's `workspaceFiles` does (dotfiles left out).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** framework-main's file operations, from the disk. */
function answerFromDisk(m, store, calls) {
  calls.push([m.op, m.path]);
  const done = (fields) => store.settle({ type: 'app-op-done', requestId: m.requestId, ...fields });
  try {
    if (m.op === 'list') {
      const entries = fs.readdirSync(m.path, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(m.path, d.name), type: d.isDirectory() ? 'directory' : 'file', isSymlink: false }));
      return done({ ok: true, result: { entries, truncated: false } });
    }
    if (m.op === 'inspect') {
      if (!fs.existsSync(m.path)) return done({ ok: true, result: { missing: true } });
      const st = fs.statSync(m.path);
      return done({ ok: true, result: { isFile: st.isFile(), size: st.size, modifiedAt: Math.round(st.mtimeMs), kind: m.path.endsWith('.png') ? 'image' : 'text' } });
    }
    return done({ ok: true });
  } catch (e) { return done({ ok: false, error: e.message, refused: false }); }
}

async function setup() {
  const h = await harness();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-files-')));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'logo.png'), 'png!');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'x');
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet });
  graph.registerTypes(NATIVE, 'native');
  await h.up();
  const calls = [];
  let appProjects = null;
  appProjects = createAppProjects({ log: quiet, timeoutMs: 2000, send: (m) => queueMicrotask(() => answerFromDisk(m, appProjects, calls)) });
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, pageSize: 2, log: quiet, appProjects });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'File') events.push([e.name, path.basename(e.ref.id)]); });
  appProjects.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: [`${root}/`] }], selected: null, threads: {}, reset: true });
  let seq = 0;
  return {
    h, graph, source, appProjects, calls, events, dir, root,
    /** Observe like a realm does, and wait for the provider's load. */
    async observe(query) { const v = graph.subscribe(query, () => {}); await v.loaded; return v; },
    fsChanged: (p) => h.app.request(`fs-${++seq}`, 'fake/fsChanged', { path: p }),
    async close() { await source.dispose(); graph.close(); appProjects.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const names = (list) => list.map((x) => x.state.name).sort();

test('a project\'s folder is put with it; observing a folder reads its files and folders as the app lists them', async () => {
  const s = await setup();
  try {
    const rootRef = refs.folder(s.root);
    const folder = s.graph.resolve(rootRef);
    assert.deepEqual([folder.ref.type, folder.state.name, folder.links.project.id, folder.links.parent], ['Folder', 'repo', 'p1', null]);
    assert.deepEqual(s.graph.resolve(refs.project('p1')).links.folder, rootRef, 'the project\'s folder is that instance (the root without its trailing slash)');
    assert.deepEqual(s.graph.related(rootRef, 'files'), [], 'nothing is read before a realm observes it');
    await s.observe({ ref: rootRef, relation: 'files' });
    assert.deepEqual(names(s.graph.related(rootRef, 'files')), ['a.txt', 'logo.png'], 'the dotfile is left out, as in the app\'s file tree');
    assert.deepEqual(names(s.graph.related(rootRef, 'folders')), ['src']);
    const a = s.graph.resolve(refs.file(path.join(s.root, 'a.txt')));
    assert.deepEqual([a.state.size, a.state.kind, a.state.modifiedAt > 0, a.links.project.id, a.links.folder], [5, 'text', true, 'p1', rootRef]);
    assert.equal(s.graph.resolve(refs.file(path.join(s.root, 'logo.png'))).state.kind, 'image');
    // A subfolder is read when it is observed.
    const src = refs.folder(path.join(s.root, 'src'));
    assert.deepEqual([s.graph.resolve(src).links.parent, s.graph.related(src, 'files')], [rootRef, []]);
    await s.observe({ ref: src });
    assert.deepEqual(names(s.graph.related(src, 'files')), ['main.js']);
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('a watched folder is read again when the app-server says it changed: changed, added and deleted files', async () => {
  const s = await setup();
  try {
    await s.observe({ ref: refs.folder(s.root), relation: 'files' });
    await until(() => s.calls.length >= 3, 2000, 'the first read');
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'hello, world');
    fs.writeFileSync(path.join(s.root, 'new.txt'), 'n');
    fs.rmSync(path.join(s.root, 'logo.png'));
    await s.fsChanged(path.join(s.root, 'a.txt'));
    await until(() => s.events.length >= 2, 3000, 'the events');
    assert.deepEqual(s.events.sort(), [['changed', 'a.txt'], ['deleted', 'logo.png']]);
    assert.equal(s.graph.resolve(refs.file(path.join(s.root, 'a.txt'))).state.size, 12);
    assert.equal(s.graph.resolve(refs.file(path.join(s.root, 'logo.png'))).gone, true);
    assert.deepEqual(names(s.graph.related(refs.folder(s.root), 'files')), ['a.txt', 'new.txt'], 'a new file is put, without an event');
    // A change the feed does not watch (another path) reads nothing.
    const n = s.calls.length;
    await s.fsChanged(path.join(s.dir, 'elsewhere.txt'));
    await sleep(300);
    assert.equal(s.calls.length, n);
  } finally { await s.close(); }
});

test('a file is read when it is observed; one that is not there, or outside every project, has no instance', async () => {
  const s = await setup();
  try {
    const main = refs.file(path.join(s.root, 'src', 'main.js'));
    await s.observe({ ref: main });
    const f = s.graph.resolve(main);
    assert.deepEqual([f.state.name, f.state.size, f.links.folder, f.links.project.id], ['main.js', 1, refs.folder(path.join(s.root, 'src')), 'p1']);
    await s.observe({ ref: refs.file(path.join(s.root, 'nope.txt')) });
    assert.equal(s.graph.resolve(refs.file(path.join(s.root, 'nope.txt'))), null);
    const n = s.calls.length;
    await s.observe({ ref: refs.file(path.join(s.dir, 'outside.txt')) });
    assert.equal(s.calls.length, n, 'the app is not asked about a path outside the projects');
  } finally { await s.close(); }
});

test('a project that goes takes its folders and files with it, without events; a project that comes brings its folder', async () => {
  const s = await setup();
  try {
    await s.observe({ ref: refs.folder(s.root), relation: 'files' });
    assert.ok(s.graph.resolve(refs.file(path.join(s.root, 'a.txt'))));
    s.appProjects.apply({ type: 'projects', available: true, projects: [] });
    for (const r of [refs.folder(s.root), refs.folder(path.join(s.root, 'src')), refs.file(path.join(s.root, 'a.txt'))]) assert.equal(s.graph.resolve(r).gone, true, r.id);
    assert.deepEqual(s.events, []);
    s.appProjects.apply({ type: 'projects', available: true, projects: [{ id: 'p2', name: 'src only', roots: [path.join(s.root, 'src')] }] });
    assert.deepEqual(s.graph.resolve(refs.folder(path.join(s.root, 'src'))).links, { project: refs.project('p2'), parent: null });
  } finally { await s.close(); }
});

test('Folder.reveal, File.reveal and File.open go to the app with the path, in the project that holds it', async () => {
  const s = await setup();
  try {
    const user = { kind: 'user', id: 'user' };
    const file = refs.file(path.join(s.root, 'a.txt'));
    await s.observe({ ref: file });
    for (const [ref, operation] of [[refs.folder(s.root), 'reveal'], [file, 'reveal'], [file, 'open']]) {
      const out = await s.graph.invoke({ ref, operation, args: [], caller: user });
      assert.deepEqual([out.status, out.intent], ['done', undefined], `${ref.type}.${operation}`);
    }
    assert.deepEqual(s.calls.slice(-3), [['reveal', s.root], ['reveal', path.join(s.root, 'a.txt')], ['open', path.join(s.root, 'a.txt')]]);
    assert.equal(s.graph.can(file, 'mentionIn'), false, 'not realized');
  } finally { await s.close(); }
});
