// Skill through the real codex source, graph, mux and fake app-server (breadth step D10). Framework-main's library and operations are
// answered on the real area channel. No real app, Codex home, skill files or network are touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createAppProjects } from '../../../app-projects.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as skillsArea from '../areas/skills.mjs';
import { produced } from './areas/skills.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until, sleep } from '../../../../mux/test/helpers.mjs';
import { createAppOps } from '../../../app-ops.mjs';
import { refused as refuse } from '../../../index.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.a' };
const user = { kind: 'user', id: 'user' };
const alphaPath = '/tmp/fake-home/skills/alpha/SKILL.md';
const systemPath = '/tmp/fake-system/skills/system/SKILL.md';
const pluginPath = '/tmp/fake-plugin/skill/SKILL.md';
const repoPath = '/r/.codex/skills/repo/SKILL.md';
const meta = (name, p, extra = {}) => ({ name, path: p, description: `${name} description`, shortDescription: null, scope: 'user', enabled: true, interface: null, dependencies: null, pluginId: null, ...extra });
const installed = () => [meta('alpha', alphaPath), meta('system', systemPath, { scope: 'system' }), meta('plug:skill', pluginPath, { pluginId: 'plug@library', enabled: false })];
const catalog = () => [
  { id: 'alpha-library', name: 'alpha', description: 'Already installed globally', repoPath: 'skills/.curated/alpha' },
  { id: 'beta', name: 'beta', description: 'Long beta', shortDescription: 'Short beta', repoPath: 'skills/.curated/beta' },
];

async function setup({ projects = null, initial = installed(), library = catalog(), main = true, home = null } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-skills-'));
  const prompts = [], events = [], requests = [], ops = [], warnings = [];
  let clock = 100_000, sequence = 8000, feed, context, intercept = null, approved = true;
  let state = structuredClone(initial), entries = structuredClone(library);
  const answers = new Map();
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log, now: () => clock,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  const control = async (method, params) => {
    const r = await h.app.request(++sequence, method, params);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    return r.result;
  };
  const replace = async (next) => { state = structuredClone(next); await control('fake/skills', { skills: state }); };
  await replace(state);
  // framework-main's projects channel, for a test that names a Codex home: the home (`instructions`), and `add-skill` made on this disk
  // as framework-main makes it (exclusively), then listed by the fake server as it would after a forced read
  const appOps = [];
  const addOnDisk = async (m) => {
    const root = m.projectId ? projects.find((p) => p.id === m.projectId).roots[0] : null;
    const dir = root ? path.join(root, '.codex', 'skills', m.name) : path.join(home, 'skills', m.name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.mkdirSync(dir);   // EEXIST: refused
    fs.writeFileSync(path.join(dir, 'SKILL.md'), m.text, { flag: 'wx' });
    await replace([...state, meta(m.name, path.join(dir, 'SKILL.md'), root ? { scope: 'repo', cwd: root } : {})]);
    return { path: path.join(dir, 'SKILL.md') };
  };
  const appProjects = projects ? createAppProjects({ log, ...(home ? { send: (m) => queueMicrotask(async () => {
    appOps.push([m.op, m.projectId ?? null, m.name]);
    try { appProjects.settle({ type: 'app-op-done', requestId: m.requestId, ok: true, result: m.op === 'add-skill' ? await addOnDisk(m) : { home, files: [] } }); }
    catch (e) { appProjects.settle({ type: 'app-op-done', requestId: m.requestId, ok: false, refused: true, error: e.code === 'EEXIST' ? `a skill named ${m.name} is there already` : e.message }); }
  }) } : {}) }) : null;
  appProjects?.apply({ type: 'projects', available: true, reset: true, projects });
  let mainOps = null;
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'skills');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        let result;
        if (answers.has(m.op)) {
          const answer = answers.get(m.op);
          if (typeof answer === 'function') result = await answer(m.args);
          else {
            mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer });
            return;
          }
        } else if (m.op === 'library') result = { skills: entries, error: null };
        else if (m.op === 'refresh') result = { refreshed: 2 };
        else if (m.op === 'remove') {
          await replace(state.filter((s) => s.path !== m.args.skillPath));
          result = { success: true, deletedPath: m.args.skillPath, error: null };
        } else if (m.op === 'install') {
          const entry = entries.find((e) => e.id === m.args.skillId);
          const destination = `/tmp/fake-home/skills/${entry.id}/SKILL.md`;
          await replace([...state, meta(entry.name, destination)]);
          result = { success: true, destination, error: null };
        } else if (m.op === 'open') result = {};
        else throw new Error(`unexpected main operation ${m.op}`);
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true, result });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: e.refused === true, error: e.message }); }
    });
  } });
  const area = { ...skillsArea, createFeed(ctx) {
    context = ctx;
    feed = skillsArea.createFeed({ ...ctx, request(method, params, intent) {
      requests.push({ method, params, intent });
      const forward = () => ctx.request(method, params, intent);
      return intercept ? intercept(method, params, intent, forward) : forward();
    } });
    return feed;
  } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log, now: () => clock, appProjects, mainOps, areas: { skills: area } });
  graph.onEvent((e) => {
    if (e.kind === 'event' && e.ref.type === 'Skill') events.push({ id: e.ref.id, name: e.name, present: !!graph.resolve(e.ref) && !graph.resolve(e.ref).gone });
  });
  await source.start();
  await feed.observe(refs.skill(alphaPath), 'Skill');
  return {
    h, graph, source, appProjects, appOps, feed, context, ops, requests, prompts, events, warnings, answers, control, replace,
    setLibrary(next) { entries = structuredClone(next); },
    setClock(next) { clock = next; },
    intercept(fn) { intercept = fn; },
    approve(value) { approved = value; },
    instance: (p) => graph.resolve(refs.skill(p)),
    invoke: (p, operation, caller = mod) => graph.invoke({ ref: refs.skill(p), operation, args: [], caller }),
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); appProjects?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const lists = (s) => s.requests.filter((r) => r.method === 'skills/list');
const writes = (s) => s.requests.filter((r) => r.method === 'skills/config/write');
const refreshed = ['refresh', { keys: [['skills'], ['recommendedSkills']] }];

test('skill data and samples cover scopes, sources, descriptions, links and library defaults', () => {
  const data = produced();
  assert.deepEqual(data[0], { ref: refs.skill('/skills/user/SKILL.md'), state: { name: 'user', description: 'User skill', scope: 'global', source: 'yours', installed: true, enabled: true }, links: { agents: [refs.agent()] } });
  assert.equal(data[1].state.source, 'builtIn');
  assert.equal(data[1].state.description, 'Short');
  assert.deepEqual(data[2].links.project, refs.project('p'));
  assert.deepEqual([data[2].state.scope, data[2].state.description, data[2].state.enabled], ['project', '', false]);
  assert.equal(data[3].links.project, undefined);
  assert.deepEqual([data[4].state.scope, data[4].state.source, data[4].links.plugin], ['global', 'library', refs.plugin('plug@library')]);
  assert.deepEqual(data[5], { ref: refs.skill('library:one'), state: { name: 'one', description: 'Library skill', scope: 'global', source: 'library', installed: false, enabled: false }, links: { agents: [] } });
  assert.equal(data[6].state.description, 'Short');
  assert.equal(data[7].state.description, '');
  assert.equal(skillsArea.skillData(meta('global', alphaPath), { projectId: 'p' }).links.project, undefined);
});

test('read installed and library skills across all project roots; deduplicate paths, hide globally installed names and sync without events', async () => {
  const s = await setup({
    projects: [{ id: 'p', name: 'Repo', roots: ['/r', '/second'] }, { id: 'q', name: 'Nested', roots: ['/r/nested'] }],
    initial: [...installed(), meta('repo', repoPath, { scope: 'repo', cwd: '/r' }), meta('repo', repoPath, { scope: 'repo', cwd: '/second' }), meta('nested', '/r/nested/skills/n/SKILL.md', { scope: 'repo', cwd: '/r/nested' })],
    library: [...catalog(), { id: 'repo', name: 'repo', description: 'Still available globally', repoPath: 'skills/.curated/repo' }],
  });
  try {
    assert.deepEqual(lists(s)[0].params, { cwds: ['/r', '/second', '/r/nested'], forceReload: false });
    assert.deepEqual(s.ops[0], ['library', {}]);
    assert.equal(s.graph.list('Skill').length, 7);
    assert.deepEqual(s.instance(alphaPath).state, { name: 'alpha', description: 'alpha description', scope: 'global', source: 'yours', installed: true, enabled: true });
    assert.equal(s.instance(systemPath).state.source, 'builtIn');
    assert.deepEqual(s.instance(repoPath).links, { agents: [refs.agent()], project: refs.project('p') });
    assert.deepEqual(s.instance('/r/nested/skills/n/SKILL.md').links.project, refs.project('q'));
    assert.deepEqual(s.instance(pluginPath).links.plugin, refs.plugin('plug@library'));
    assert.equal(s.instance(pluginPath).state.source, 'library');
    assert.equal(s.instance('library:beta').state.description, 'Short beta');
    assert.deepEqual(s.instance('library:beta').links.agents, []);
    assert.equal(s.instance('library:alpha-library'), null);
    assert.equal(s.instance('library:repo').state.installed, false, 'a project skill does not hide the global library entry');
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('successive reads emit added, changed and removed; links alone do not emit changed, and removal is emitted while resident', async () => {
  const s = await setup({ projects: [{ id: 'p', name: 'Repo', roots: ['/r'] }], initial: [...installed(), meta('repo', repoPath, { scope: 'repo', cwd: '/r' })] });
  try {
    const added = '/tmp/fake-home/skills/new/SKILL.md';
    await s.replace([meta('alpha', alphaPath, { shortDescription: 'Updated', enabled: false }), meta('new', added), meta('repo', repoPath, { scope: 'repo', cwd: '/r' })]);
    await s.feed.read();
    assert.deepEqual(s.events.map((e) => [e.id, e.name]).sort(), [[alphaPath, 'changed'], [added, 'added'], [systemPath, 'removed'], [pluginPath, 'removed']].sort());
    assert.ok(s.events.every((e) => e.present));
    assert.equal(s.instance(systemPath).gone, true);
    s.events.length = 0;
    await s.feed.read();
    assert.deepEqual(s.events, []);
    s.appProjects.apply({ type: 'projects', available: true, projects: [{ id: 'new-p', name: 'Same root', roots: ['/r'] }] });
    await until(() => s.instance(repoPath).links.project?.id === 'new-p', 3000, 'the changed project link');
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('enable and disable use path or plugin name, pass the intent, refresh and force-reload; redundant operations do nothing', async () => {
  const s = await setup();
  try {
    assert.deepEqual(lists(s)[0].params, { cwds: [], forceReload: false });
    const opsBefore = s.ops.length;
    assert.equal((await s.invoke(alphaPath, 'enable')).status, 'done');
    assert.equal((await s.invoke(pluginPath, 'disable')).status, 'done');
    assert.equal((await s.invoke(alphaPath, 'install')).status, 'done');
    assert.equal(s.ops.length, opsBefore);
    assert.equal(writes(s).length, 0);
    assert.deepEqual(s.prompts, []);

    const off = await s.invoke(alphaPath, 'disable');
    assert.equal(off.status, 'done');
    assert.deepEqual(writes(s).at(-1), { method: 'skills/config/write', params: { path: alphaPath, enabled: false }, intent: off.intent });
    assert.ok(off.intent);
    assert.equal(s.instance(alphaPath).state.enabled, false);
    assert.deepEqual(s.ops.slice(-2), [refreshed, ['library', {}]]);
    assert.equal(lists(s).at(-1).params.forceReload, true);
    assert.equal((await s.invoke(alphaPath, 'enable')).status, 'done');
    assert.deepEqual(writes(s).at(-1).params, { path: alphaPath, enabled: true });
    const on = await s.invoke(pluginPath, 'enable');
    assert.equal(on.status, 'done');
    assert.deepEqual(writes(s).at(-1), { method: 'skills/config/write', params: { name: 'plug:skill', enabled: true }, intent: on.intent });
    assert.equal(s.instance(pluginPath).state.enabled, true);
    assert.deepEqual(s.prompts, [
      { action: 'turn off the skill “alpha”', detail: "Codex's config.toml records it: new threads use it." },
      { action: 'turn on the skill “alpha”', detail: "Codex's config.toml records it: new threads use it." },
      { action: 'turn on the skill “plug:skill”', detail: "Codex's config.toml records it: new threads use it." },
    ]);
  } finally { await s.close(); }
});

test('delete and install use the main area channel, refresh and re-read; R17 describes the lasting change', async () => {
  const s = await setup();
  try {
    assert.equal((await s.invoke(alphaPath, 'delete')).status, 'done');
    assert.deepEqual(s.ops.slice(-3), [['remove', { skillPath: alphaPath }], refreshed, ['library', {}]]);
    assert.equal(s.instance(alphaPath).gone, true);
    assert.equal(s.instance('library:alpha-library').state.installed, false);
    assert.equal(lists(s).at(-1).params.forceReload, true);
    assert.equal((await s.invoke('library:beta', 'install')).status, 'done');
    assert.deepEqual(s.ops.slice(-3), [['install', { skillId: 'beta', repoPath: 'skills/.curated/beta' }], refreshed, ['library', {}]]);
    assert.equal(s.instance('library:beta').gone, true);
    assert.equal(s.instance('/tmp/fake-home/skills/beta/SKILL.md').state.installed, true);
    assert.equal(lists(s).at(-1).params.forceReload, true);
    assert.deepEqual(s.prompts, [
      { action: 'delete the skill “alpha”', detail: 'Its folder is deleted from this Mac.' },
      { action: 'install the skill “beta”', detail: "It is copied from OpenAI's skills library into your Codex home." },
    ]);
  } finally { await s.close(); }
});

test('edit opens SKILL.md beside a thread from either a file or folder path, with no approval or refresh', async () => {
  const folder = '/tmp/fake-home/skills/folder';
  const s = await setup({ initial: [...installed(), meta('folder', folder)] });
  try {
    const before = lists(s).length;
    assert.equal((await s.invoke(alphaPath, 'edit')).status, 'done');
    assert.equal((await s.invoke(folder, 'edit')).status, 'done');
    assert.deepEqual(s.ops.slice(-2), [['open', { path: alphaPath }], ['open', { path: `${folder}/SKILL.md` }]]);
    assert.equal(lists(s).length, before);
    assert.deepEqual(s.prompts, []);
    s.answers.set('open', { ok: false, refused: true, error: 'the app shows a file beside a thread, and no thread is open' });
    const r = await s.invoke(alphaPath, 'edit');
    assert.deepEqual([r.status, r.reason, r.message], ['refused', 'unavailable', 'the app shows a file beside a thread, and no thread is open']);
  } finally { await s.close(); }
});

test('unsupported library operations and protected deletions are refused before a call or an approval', async () => {
  const s = await setup();
  try {
    const before = s.ops.length;
    for (const op of ['enable', 'disable', 'delete', 'edit']) {
      const r = await s.invoke('library:beta', op);
      assert.deepEqual([r.status, r.reason], ['refused', 'unsupported']);
    }
    const builtin = await s.invoke(systemPath, 'delete');
    assert.deepEqual([builtin.status, builtin.reason, builtin.message], ['refused', 'unsupported', "Codex's own skill"]);
    const plugin = await s.invoke(pluginPath, 'delete');
    assert.deepEqual([plugin.status, plugin.reason, plugin.message], ['refused', 'unsupported', 'it comes with the plugin plug@library: uninstall the plugin']);
    assert.equal(s.ops.length, before);
    assert.equal(writes(s).length, 0);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('a user caller has no R17 prompts; a mod denied approval makes no change', async () => {
  const s = await setup();
  try {
    for (const [p, op] of [[alphaPath, 'disable'], [alphaPath, 'enable'], ['library:beta', 'install'], [alphaPath, 'delete']]) {
      assert.equal((await s.invoke(p, op, user)).status, 'done');
    }
    assert.deepEqual(s.prompts, []);
    s.approve(false);
    const before = s.ops.length;
    const r = await s.invoke('library:alpha-library', 'install');
    assert.deepEqual([r.status, r.reason], ['refused', 'notAllowed']);
    assert.equal(s.ops.length, before);
    assert.equal(s.instance('library:alpha-library').state.installed, false);
  } finally { await s.close(); }
});

test('main refusals are unavailable; transport, service and protocol failures fail; failed refreshes only log and still read', async () => {
  const s = await setup();
  try {
    for (const [op, p, mainOp] of [['delete', alphaPath, 'remove'], ['install', 'library:beta', 'install'], ['edit', alphaPath, 'open']]) {
      for (const answer of [
        { ok: false, refused: true, error: 'cannot reach the app' },
        { ok: false, refused: false, error: 'service threw' },
        { ok: true, result: { success: false, error: 'service reported failure' } },
      ]) {
        s.answers.set(mainOp, answer);
        const count = lists(s).length;
        const r = await s.invoke(p, op, user);
        assert.equal(r.status, answer.refused ? 'refused' : 'failed');
        assert.equal(r.reason ?? r.error?.message, answer.refused ? 'unavailable' : answer.error ?? answer.result.error);
        assert.equal(lists(s).length, count, 'a failed mutation does not refresh or re-read');
      }
      s.answers.delete(mainOp);
    }
    await s.replace(installed().filter((m) => m.path !== alphaPath));
    const missing = await s.invoke(alphaPath, 'disable', user);
    assert.equal(missing.status, 'failed');
    assert.match(missing.error.message, /skill not found/);
    assert.equal(s.instance(alphaPath).state.enabled, true, 'failed protocol write leaves the graph as it was');
    await s.replace(installed());
    for (const answer of [{ ok: false, refused: true, error: 'no cache' }, { ok: false, refused: false, error: 'cache failed' }]) {
      s.answers.set('refresh', answer);
      const enabled = s.instance(alphaPath).state.enabled;
      const count = s.warnings.length;
      assert.equal((await s.invoke(alphaPath, enabled ? 'disable' : 'enable', user)).status, 'done');
      assert.equal(s.instance(alphaPath).state.enabled, !enabled);
      assert.equal(lists(s).at(-1).params.forceReload, true);
      assert.equal(s.warnings.length, count + 1);
    }
  } finally { await s.close(); }
});

test('a failed read preserves instances; a refused or failed library leaves installed skills and logs once per read', async () => {
  const s = await setup();
  try {
    const before = s.graph.list('Skill');
    s.intercept((method, _params, _intent, forward) => method === 'skills/list' ? s.context.request('fake/error', { message: 'list failed' }) : forward());
    await s.feed.read();
    assert.deepEqual(s.graph.list('Skill'), before);
    assert.equal(s.warnings.length, 1);
    assert.deepEqual(s.events, []);
    s.intercept(null);
    for (const answer of [
      { ok: false, refused: true, error: 'no library' },
      { ok: false, refused: false, error: 'library failed' },
      { ok: true, result: { skills: catalog(), error: 'catalog failed' } },
    ]) {
      s.answers.set('library', answer);
      const count = s.warnings.length;
      await s.feed.read();
      assert.equal(s.warnings.length, count + 1);
      assert.deepEqual(s.graph.list('Skill').map((d) => d.ref.id).sort(), installed().map((m) => m.path).sort());
    }
    s.answers.delete('library');
    await s.feed.read();
    assert.equal(s.instance('library:beta').gone, undefined);
  } finally { await s.close(); }
});

test('without framework-main, installed skills still read and main operations are refused', async () => {
  const s = await setup({ main: false });
  try {
    assert.equal(s.graph.list('Skill').length, 3);
    assert.equal(s.warnings.length, 1);
    const r = await s.invoke(alphaPath, 'delete', user);
    assert.deepEqual([r.status, r.reason], ['refused', 'unavailable']);
    assert.equal((await s.invoke(alphaPath, 'disable', user)).status, 'done', 'a failed cache refresh cannot undo a protocol write');
    assert.equal(s.instance(alphaPath).state.enabled, false);
  } finally { await s.close(); }
});

test('skills/changed and responded refreshes debounce, ignore other methods, and the source hears app writes', async () => {
  const s = await setup();
  try {
    let count = lists(s).length;
    await s.replace([...installed(), meta('delta', '/tmp/fake-home/skills/delta/SKILL.md')]);
    for (let i = 0; i < 3; i++) await s.control('fake/skillsChanged', {});
    await sleep(100);
    assert.equal(lists(s).length, count, 'not read before the debounce');
    await until(() => s.instance('/tmp/fake-home/skills/delta/SKILL.md'), 3000, 'skills/changed read');
    assert.equal(lists(s).length, count + 1);
    assert.equal(lists(s).at(-1).params.forceReload, true);

    for (const method of ['skills/config/write', 'plugin/install', 'plugin/uninstall']) {
      count = lists(s).length;
      s.feed.responded(method);
      s.feed.responded(method);
      await until(() => lists(s).length > count, 3000, `${method} read`);
      await s.feed.observe(refs.skill(alphaPath), 'Skill');
      assert.equal(lists(s).length, count + 1);
    }
    count = lists(s).length;
    s.feed.responded('skills/list');
    s.feed.notified('other');
    await sleep(550);
    assert.equal(lists(s).length, count);
    await s.control('skills/config/write', { path: alphaPath, enabled: false });
    await until(() => s.instance(alphaPath).state.enabled === false, 3000, 'the app config write was re-read');
    assert.equal(lists(s).length, count + 1);
  } finally { await s.close(); }
});

test('reads coalesce without overlap, retain queued forceReload, observe only when old, and wake on server/project changes', async () => {
  const s = await setup({ projects: [{ id: 'p', name: 'Repo', roots: ['/r'] }] });
  let release;
  try {
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    let count = lists(s).length;
    await s.feed.observe(refs.skill(alphaPath), 'Skill');
    s.setClock(130_000);
    await s.feed.observe(refs.skill(alphaPath), 'Skill');
    assert.equal(lists(s).length, count, '30s is still fresh');
    s.setClock(130_001);
    await s.feed.observe(refs.skill(alphaPath), 'Skill');
    assert.equal(lists(s).length, ++count);
    let active = 0, peak = 0, held = false;
    const gate = new Promise((resolve) => { release = resolve; });
    s.intercept(async (method, _params, _intent, forward) => {
      if (method !== 'skills/list') return forward();
      active++; peak = Math.max(peak, active);
      if (!held) { held = true; await gate; }
      try { return await forward(); } finally { active--; }
    });
    const first = s.feed.read();
    assert.equal(s.feed.observe(refs.skill(alphaPath), 'Skill'), first, 'observe returns the running promise without queueing another');
    assert.equal(s.feed.read(), first);
    assert.equal(s.feed.read({ forceReload: true }), first);
    assert.equal(s.feed.read(), first);
    assert.equal(lists(s).length, count + 1);
    release();
    await first;
    assert.equal(lists(s).length, count + 2);
    assert.equal(peak, 1);
    assert.equal(lists(s).at(-1).params.forceReload, true);
    s.intercept(null);
    count = lists(s).length;
    await s.feed.serverUp();
    assert.equal(lists(s).length, count + 1);
    s.appProjects.apply({ type: 'projects', available: true, projects: [{ id: 'p', name: 'Repo', roots: ['/r', '/second'] }] });
    await until(() => lists(s).at(-1).params.cwds.includes('/second'), 3000, 'a project change');
    await s.feed.observe(refs.skill(alphaPath), 'Skill');
  } finally { release?.(); await s.close(); }
});

test('while the server is down every operation refuses without approval; ready re-reads', async () => {
  const s = await setup();
  try {
    const count = lists(s).length, ops = s.ops.length;
    s.h.bus.publish('appServer/exited', { reason: 'crash' });
    for (const op of ['enable', 'disable', 'delete', 'install', 'edit']) {
      const r = await s.invoke(op === 'install' ? 'library:beta' : alphaPath, op);
      assert.deepEqual([r.status, r.reason], [s.context.DOWN.status, s.context.DOWN.reason]);
    }
    assert.deepEqual(s.prompts, []);
    assert.equal(s.ops.length, ops);
    await s.feed.read();
    assert.equal(lists(s).length, count);
    s.h.bus.publish('appServer/ready', {});
    await until(() => lists(s).length > count, 3000, 'ready re-read');
    await s.feed.observe(refs.skill(alphaPath), 'Skill');
  } finally { await s.close(); }
});

test('dispose clears the debounce and project subscription, and an in-flight read puts nothing after disposal', async () => {
  const s = await setup({ projects: [{ id: 'p', name: 'Repo', roots: ['/r'] }] });
  let release;
  try {
    const count = lists(s).length;
    const before = s.graph.list('Skill');
    s.feed.notified('skills/changed');
    const gate = new Promise((resolve) => { release = resolve; });
    s.intercept(async (_method, _params, _intent, forward) => { await gate; return forward(); });
    const running = s.feed.read();
    s.feed.dispose();
    s.appProjects.apply({ type: 'projects', available: true, projects: [] });
    release();
    await running;
    await sleep(550);
    assert.equal(lists(s).length, count + 1, 'no timer or project read after disposal');
    assert.deepEqual(s.graph.list('Skill'), before);
    assert.deepEqual(s.events, []);
  } finally { release?.(); await s.close(); }
});

test('CodexAgent.addSkill: SKILL.md in a new folder of the Codex home\'s or a project\'s skills folder, by framework-main, after the user is asked; then its Skill', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'add-skill-')));
  const home = path.join(tmp, 'home'), root = path.join(tmp, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(root);
  const s = await setup({ projects: [{ id: 'p', name: 'Repo', roots: [root] }], home });
  try {
    const add = (spec, caller = mod) => s.graph.invoke({ ref: refs.agent(), operation: 'addSkill', args: [spec], caller });
    const spec = { name: 'tidy-imports', description: 'Sorts imports: "stdlib" first', text: 'Sort the imports.\n\nThen stop.\n' };
    const out = await add(spec);
    const file = path.join(home, 'skills', 'tidy-imports', 'SKILL.md');
    assert.deepEqual([out.status, out.value], ['done', refs.skill(file)]);
    assert.equal(fs.readFileSync(file, 'utf8'), '---\nname: tidy-imports\ndescription: "Sorts imports: \\"stdlib\\" first"\n---\n\nSort the imports.\n\nThen stop.\n');
    assert.deepEqual(s.prompts.at(-1), { action: 'add the skill “tidy-imports”', detail: `Codex will use it in every chat, here and in the command line: it is written to your Codex home's skills folder (${home}/skills/tidy-imports).` });
    assert.deepEqual(s.appOps.filter(([op]) => op === 'add-skill'), [['add-skill', null, 'tidy-imports']]);
    assert.equal(s.requests.some((r) => r.method.startsWith('fs/')), false, 'nothing written through the server');
    assert.deepEqual(lists(s).at(-1).params.forceReload, true);
    assert.deepEqual(s.ops.filter(([op]) => op === 'refresh').at(-1), refreshed);
    assert.equal(s.instance(file).state.source, 'yours');
    // in a project: its .codex/skills
    const inProject = await add({ name: 'repo-style', description: 'The repo style', text: 'Use tabs.', project: refs.project('p') });
    const pfile = path.join(root, '.codex', 'skills', 'repo-style', 'SKILL.md');
    assert.deepEqual([inProject.status, inProject.value], ['done', refs.skill(pfile)]);
    assert.match(s.prompts.at(-1).detail, /in the chats of the project at .*: it is written to .*\/\.codex\/skills\/repo-style\./);
    assert.deepEqual(s.instance(pfile).links.project, refs.project('p'));
    // an invalid spec is refused before the user is asked; nothing is made
    const asked = s.prompts.length, made = s.appOps.length;
    for (const [bad, message] of [
      [{ ...spec, name: 'Has Space' }, /lowercase letters/], [{ ...spec, name: 'a--b' }, /lowercase letters/], [{ ...spec, description: 'uses <tags>' }, /without < or >/],
      [{ ...spec, description: 'two\nlines' }, /one line/], [{ ...spec, text: ' ' }, /needs its text/], [{ ...spec, name: 'other', project: refs.project('gone') }, /one of the app's projects/], ['x', /a skill is/],
    ]) {
      const r = await add(bad);
      assert.equal(r.status, 'refused', JSON.stringify(bad));
      assert.match(r.message, message);
    }
    assert.deepEqual([s.prompts.length, s.appOps.length], [asked, made]);
    // a name Codex lists already: asked (every valid call is), then refused; one on disk only: framework-main refuses it, the file kept
    assert.match((await add({ ...spec, name: 'alpha' })).message, /there is a skill “alpha” already/);
    assert.equal(s.prompts.length, asked + 1);
    fs.mkdirSync(path.join(home, 'skills', 'on-disk'), { recursive: true });
    const onDisk = await add({ ...spec, name: 'on-disk' });
    assert.deepEqual([onDisk.reason, onDisk.message], ['invalid', 'a skill named on-disk is there already']);
    // declined: nothing made; the user's own call is not asked
    s.approve(false);
    assert.equal((await add({ ...spec, name: 'declined' })).status, 'refused');
    assert.equal(fs.existsSync(path.join(home, 'skills', 'declined')), false);
    s.approve(true);
    const before = s.prompts.length;
    assert.equal((await add({ ...spec, name: 'by-user' }, user)).status, 'done');
    assert.equal(s.prompts.length, before);
  } finally { await s.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('H6m: the user turning a skill on or off in the app passes its interceptors first, by its path or (a plugin\'s skill) its name; refused, Codex never writes it', async () => {
  const s = await setup();
  const ops = createAppOps({ graph: s.graph, mux: s.h.mux, log: s.h.log, appOperation: (m, p) => s.source.appOperation(m, p) });
  let n = 7000;
  const seen = [];
  try {
    s.graph.intercept('mod:qa', 'Skill', 'disable', (c) => { seen.push(['disable', c.ref.id, c.caller.kind]); return refuse('notAllowed', 'keep it on'); });
    s.graph.intercept('mod:qa', 'Skill', 'enable', (c, next) => { seen.push(['enable', c.ref.id]); return next(); });
    assert.match((await s.h.app.request(`page-${++n}`, 'skills/config/write', { path: alphaPath, enabled: false })).error?.message ?? '', /keep it on/);
    assert.equal(s.instance(alphaPath).state.enabled, true);
    assert.equal((await s.h.app.request(`page-${++n}`, 'skills/config/write', { name: 'plug:skill', enabled: true })).error, undefined);
    assert.deepEqual(seen, [['disable', alphaPath, 'user'], ['enable', pluginPath]]);
  } finally { await ops.dispose(); await s.close(); }
});

test('H6m review: a skill named by two installed skills is refused while something holds it (which one is not known)', async () => {
  const s = await setup();
  const ops = createAppOps({ graph: s.graph, mux: s.h.mux, log: s.h.log, appOperation: (m, p) => s.source.appOperation(m, p) });
  try {
    await s.replace([...installed(), meta('plug:skill', '/tmp/other-plugin/skill/SKILL.md', { pluginId: 'other@library', enabled: false })]);
    await s.feed.read(true);
    await until(() => s.instance('/tmp/other-plugin/skill/SKILL.md'), 3000, 'the second one read');
    s.graph.intercept('mod:qa', 'Skill', 'enable', (c, next) => next());
    assert.match((await s.h.app.request('page-amb', 'skills/config/write', { name: 'plug:skill', enabled: true })).error?.message ?? '', /more than one skill/);
  } finally { await ops.dispose(); await s.close(); }
});
