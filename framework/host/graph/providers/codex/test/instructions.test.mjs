// Instructions in the native provider (breadth step D3; instructions.mjs): the global, project and folder AGENTS.md files as Instructions, which
// of them Codex follows, `changed`, the files feed's listings, watches, and edit and open the app's way (a mod's global edit asks the user
// first, R17). The graph runtime with the feed; the test plays framework-main's answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { refs } from '../map.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { instructionsData, instructionsTypes, createInstructionsFeed } from '../instructions.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HOME = '/Users/q/.codex';
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });

test('instructionsData: one instance per file; a non-empty override is followed in place of AGENTS.md; the global AGENTS.md is always there', () => {
  const at = { projectId: 'p1', folder: '/r' };
  const both = instructionsData('project', [{ path: '/r/AGENTS.md', exists: true, text: 'a' }, { path: '/r/AGENTS.override.md', exists: true, text: 'b' }], at);
  assert.deepEqual(both.map((d) => [d.ref.id, d.state.enabled]), [['/r/AGENTS.md', false], ['/r/AGENTS.override.md', true]]);
  assert.deepEqual(both[0].links, { project: refs.project('p1'), folder: refs.folder('/r'), agents: [refs.agent()] });
  assert.deepEqual(both[0].state, { scope: 'project', text: text('a'), enabled: false, location: '/r/AGENTS.md' });
  const empty = instructionsData('folder', [{ path: '/r/s/AGENTS.md', exists: true, text: 'a' }, { path: '/r/s/AGENTS.override.md', exists: true, text: '  \n' }], at);
  assert.deepEqual(empty.map((d) => d.state.enabled), [true, false], 'an empty override is not followed');
  assert.deepEqual(instructionsData('project', [{ path: '/r/AGENTS.md', exists: false }, { path: '/r/AGENTS.override.md', exists: false }], at), []);
  const global = instructionsData('global', [{ path: `${HOME}/AGENTS.md`, exists: false }, { path: `${HOME}/AGENTS.override.md`, exists: false }]);
  assert.deepEqual(global.map((d) => [d.ref.id, d.state.text, d.links.project]), [[`${HOME}/AGENTS.md`, text(''), null]]);
  assert.deepEqual(instructionsData('project', [{ path: '/r/AGENTS.md', exists: true, tooLarge: true }], at), [], 'too large to read: none');
});

function setup() {
  const asked = [];
  const approvals = { ask: async (q) => { asked.push(q); return { approved: true }; } };
  const graph = createGraph({ log: quiet, approvals });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  let feed = null;
  const handle = graph.registerProvider('native', 'codex', { types: instructionsTypes({ prompt: (...a) => feed.prompt(...a), edit: (...a) => feed.edit(...a), open: (...a) => feed.open(...a) }) });
  const disk = { [`${HOME}/AGENTS.md`]: 'Be brief.', '/r/AGENTS.md': 'Use tabs.' };
  const calls = [];
  const rpcs = [];
  let store = null;
  const filesOf = (dir) => ['AGENTS.md', 'AGENTS.override.md'].map((n) => { const p = `${dir}/${n}`; return p in disk ? { path: p, exists: true, text: disk[p], modifiedAt: 1 } : { path: p, exists: false }; });
  store = createAppProjects({ log: quiet, timeoutMs: 2000, send: (m) => queueMicrotask(() => {
    calls.push([m.op, m.projectId ?? null, m.path, m.text]);
    const done = (fields) => store.settle({ type: 'app-op-done', requestId: m.requestId, ...fields });
    if (m.op === 'instructions') return done({ ok: true, result: m.projectId ? { files: filesOf(m.path) } : { home: HOME, files: filesOf(HOME) } });
    if (m.op === 'edit-instructions') { disk[m.path] = m.text; return done({ ok: true }); }
    if (m.op === 'create-instructions') {   // framework-main's exclusive create in the project's root
      const f = `${{ p1: '/r', p2: '/n' }[m.projectId]}/AGENTS.md`;
      if (f in disk) return done({ ok: false, refused: true, error: 'the project has its instructions already: edit them' });
      disk[f] = m.text;
      return done({ ok: true, result: { path: f } });
    }
    return done({ ok: true, result: { status: 'opened' } });
  }) });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event' && e.ref.type === 'CodexInstructions') events.push([e.name, e.ref.id]); });
  const resident = (r) => { const x = graph.resolve(r); return x && !x.gone ? x : null; };
  feed = createInstructionsFeed({ handle, appProjects: store, resident, safe: (w, fn) => fn(), emitEvent: (r, name) => handle.emit(r, name), log: quiet, rpc: async (method, params) => { rpcs.push([method, params]); return {}; } });
  store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/r'] }], selected: null, threads: {}, reset: true });
  return { graph, feed, store, disk, calls, rpcs, events, asked, close() { feed.dispose(); store.dispose(); graph.close(); } };
}
const mod = { kind: 'mod', id: 'mod.a' };
const user = { kind: 'user', id: 'user' };

test('the global and each project\'s instructions are read when the app\'s projects come; watched; read again on a change, which says changed', async () => {
  const s = setup();
  try {
    const g = refs.instructions(`${HOME}/AGENTS.md`), p = refs.instructions('/r/AGENTS.md');
    await until(() => s.graph.resolve(g) && s.graph.resolve(p), 2000, 'the instructions');
    assert.deepEqual([s.graph.resolve(g).state.scope, s.graph.resolve(p).state.scope, s.graph.resolve(p).links.folder], ['global', 'project', refs.folder('/r')]);
    assert.deepEqual(s.graph.referrers(refs.project('p1'), 'project').map((x) => x.ref.id), ['/r/AGENTS.md'], 'Project.instructions, its inverse');
    const watched = s.rpcs.filter(([m]) => m === 'fs/watch').map(([, q]) => q.path).sort();
    assert.deepEqual(watched, [`${HOME}/AGENTS.md`, '/r/AGENTS.md']);
    // An override appears and the file changes: read again on its watch; AGENTS.md is no longer followed.
    s.disk['/r/AGENTS.override.md'] = 'Only this.';
    const watchId = s.rpcs.find(([m, q]) => m === 'fs/watch' && q.path === '/r/AGENTS.md')[1].watchId;
    s.feed.changed({ watchId, changedPaths: ['/r/AGENTS.md'] });
    await until(() => s.graph.resolve(refs.instructions('/r/AGENTS.override.md')), 2000, 'the override');
    assert.deepEqual([s.graph.resolve(p).state.enabled, s.graph.resolve(refs.instructions('/r/AGENTS.override.md')).state.enabled], [false, true]);
    assert.deepEqual(s.events, [['changed', '/r/AGENTS.md']]);
    // The override goes: its instance goes and its watch ends.
    delete s.disk['/r/AGENTS.override.md'];
    s.feed.changed({ watchId, changedPaths: ['/r/AGENTS.md'] });
    await until(() => !s.graph.resolve(refs.instructions('/r/AGENTS.override.md')) || s.graph.resolve(refs.instructions('/r/AGENTS.override.md')).gone, 2000, 'the override gone');
    assert.ok(s.rpcs.some(([m]) => m === 'fs/unwatch'));
  } finally { s.close(); }
});

test('a folder the files feed lists with an AGENTS.md has folder instructions; one without is not read', async () => {
  const s = setup();
  try {
    await until(() => s.graph.resolve(refs.instructions('/r/AGENTS.md')), 2000, 'the project instructions');
    s.disk['/r/src/AGENTS.md'] = 'In src.';
    s.feed.listed('p1', '/r/docs', [{ path: '/r/docs/a.md', type: 'file' }]);
    s.feed.listed('p1', '/r/src', [{ path: '/r/src/AGENTS.md', type: 'file' }, { path: '/r/src/x.js', type: 'file' }]);
    await until(() => s.graph.resolve(refs.instructions('/r/src/AGENTS.md')), 2000, 'the folder instructions');
    const f = s.graph.resolve(refs.instructions('/r/src/AGENTS.md'));
    assert.deepEqual([f.state.scope, f.state.text, f.links.project, f.links.folder], ['folder', text('In src.'), refs.project('p1'), refs.folder('/r/src')]);
    assert.equal(s.calls.filter(([op, , path]) => op === 'instructions' && path === '/r/docs').length, 0);
  } finally { s.close(); }
});

test('an instructions file observed in a folder never read is its innermost project\'s, any of that project\'s folders (built review H6m2a)', async () => {
  const s = setup();
  try {
    s.store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/r'] }, { id: 'p2', name: 'nested', roots: ['/x', '/r/nested'] }], selected: null, threads: {}, reset: true });
    await until(() => s.graph.resolve(refs.instructions('/r/AGENTS.md')), 2000, 'the project instructions');
    s.disk['/r/nested/deep/AGENTS.md'] = 'Deep.';
    s.feed.observe(refs.instructions('/r/nested/deep/AGENTS.md'));
    await until(() => s.graph.resolve(refs.instructions('/r/nested/deep/AGENTS.md')), 2000, 'the nested folder instructions');
    assert.deepEqual(s.graph.resolve(refs.instructions('/r/nested/deep/AGENTS.md')).links.project, refs.project('p2'), 'the nested project, from its second folder');
    assert.deepEqual(s.calls.find(([op, , path]) => op === 'instructions' && path === '/r/nested/deep').slice(0, 2), ['instructions', 'p2']);
  } finally { s.close(); }
});

test('edit: a mod\'s edit of the global instructions asks the user first, a project\'s does not; open shows the file the app\'s way', async () => {
  const s = setup();
  try {
    const g = refs.instructions(`${HOME}/AGENTS.md`), p = refs.instructions('/r/AGENTS.md');
    await until(() => s.graph.resolve(g) && s.graph.resolve(p), 2000, 'the instructions');
    const out = await s.graph.invoke({ ref: g, operation: 'edit', args: [text('Be kind.')], caller: mod });
    assert.equal(out.status, 'done');
    assert.deepEqual(s.asked.map(({ signal, ...q }) => q), [{ modId: 'mod.a', operation: 'Instructions.edit', action: 'change the instructions Codex follows in every thread', detail: `This replaces the text of ${HOME}/AGENTS.md, which Codex reads for every thread on this Mac, in the app and in the command line.` }]);
    assert.deepEqual(s.calls.find(([op]) => op === 'edit-instructions'), ['edit-instructions', null, `${HOME}/AGENTS.md`, 'Be kind.']);
    assert.deepEqual([s.graph.resolve(g).state.text, s.events.at(-1)], [text('Be kind.'), ['changed', `${HOME}/AGENTS.md`]]);
    assert.equal((await s.graph.invoke({ ref: p, operation: 'edit', args: [text('Use spaces.')], caller: mod })).status, 'done');
    assert.equal(s.asked.length, 1, 'a project\'s instructions: no prompt');
    assert.deepEqual(s.calls.filter(([op]) => op === 'edit-instructions').at(-1), ['edit-instructions', 'p1', '/r/AGENTS.md', 'Use spaces.']);
    assert.equal((await s.graph.invoke({ ref: g, operation: 'edit', args: [text('By the user.')], caller: user })).status, 'done');
    assert.equal(s.asked.length, 1, 'the user is not asked about their own edit');
    assert.equal((await s.graph.invoke({ ref: p, operation: 'edit', args: [{ parts: [{ kind: 'image', url: 'x' }] }], caller: mod })).reason, 'invalid');
    await s.graph.invoke({ ref: g, operation: 'open', args: [], caller: mod });
    await s.graph.invoke({ ref: p, operation: 'open', args: [], caller: mod });
    assert.deepEqual(s.calls.filter(([op]) => op === 'open' || op === 'open-instructions'), [['open-instructions', null, `${HOME}/AGENTS.md`, undefined], ['open', 'p1', '/r/AGENTS.md', undefined]]);
  } finally { s.close(); }
});

test('Project.addInstructions: the project\'s AGENTS.md written the app\'s way where it has none, then its Instructions; one it has is edited instead', async () => {
  const s = setup();
  try {
    s.store.apply({ type: 'projects', available: true, projects: [{ id: 'p1', name: 'repo', roots: ['/r'] }, { id: 'p2', name: 'new', roots: ['/n/'] }], selected: null, threads: {}, reset: true });
    await until(() => s.graph.resolve(refs.instructions('/r/AGENTS.md')), 2000, 'the instructions');
    assert.deepEqual(await s.feed.add('p1', text('Again.')), { status: 'refused', reason: 'invalid', message: 'the project has its instructions already: edit them' });
    assert.equal(s.disk['/r/AGENTS.md'], 'Use tabs.');
    assert.deepEqual(await s.feed.add('p2', text('Use the new style.')), refs.instructions('/n/AGENTS.md'));
    assert.deepEqual(s.calls.filter(([op]) => op === 'create-instructions'), [['create-instructions', 'p2', undefined, 'Use the new style.']]);
    const made = s.graph.resolve(refs.instructions('/n/AGENTS.md'));
    assert.deepEqual([made.state.scope, made.state.text, made.links.project], ['project', text('Use the new style.'), refs.project('p2')]);
    assert.equal((await s.feed.add('p2', text(' '))).reason, 'invalid');
    assert.equal((await s.feed.add('p2', { parts: [{ kind: 'image', url: 'x' }] })).reason, 'invalid');
    assert.equal((await s.feed.add('gone', text('x'))).reason, 'unavailable');
  } finally { s.close(); }
});
