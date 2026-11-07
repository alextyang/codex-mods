// The fake's skills: globals in every cwd, repo skills in their own, config writes by path or name, replacement and invalidation. Every
// protocol payload it sends is checked against the schemas of every supported build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startInitialized, shapeIssues } from '../fake-client.mjs';

test('skills: defaults, per-cwd lists, config selectors, changes, and every protocol shape', async () => {
  const f = await startInitialized();
  const issues = [];
  const ask = async (method, params) => {
    issues.push(...shapeIssues('params', method, params));
    const r = await f.request(method, params);
    assert.equal(r.error, undefined);
    issues.push(...shapeIssues('result', method, r.result));
    return r.result;
  };
  try {
    const defaults = (await ask('skills/list', {})).data;
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].cwd, process.cwd());
    assert.deepEqual(defaults[0].skills.map((s) => [s.name, s.scope, s.enabled]), [['alpha', 'user', true], ['system', 'system', true]]);
    const alpha = defaults[0].skills[0];
    assert.equal(alpha.path, '/tmp/fake-home/skills/alpha/SKILL.md');
    assert.deepEqual(defaults[0].errors, []);
    assert.deepEqual(await ask('skills/config/write', { path: alpha.path, enabled: false }), { effectiveEnabled: false });
    assert.equal((await ask('skills/list', { cwds: [], forceReload: true })).data[0].skills[0].enabled, false);

    const plugin = { ...alpha, name: 'plug:skill', path: '/tmp/plugin/SKILL.md', scope: 'admin', pluginId: 'plug@library', enabled: true };
    const repo = { ...alpha, name: 'repo', scope: 'repo', path: '/r/.codex/skills/repo/SKILL.md', cwd: '/r', enabled: false };
    await f.request('fake/skills', { skills: [alpha, plugin, repo, { ...repo, path: '/s/.codex/skills/repo/SKILL.md', cwd: '/s' }] });
    const list = await ask('skills/list', { cwds: ['/r', '/s', '/r-other'], forceReload: false });
    assert.deepEqual(list.data.map((r) => [r.cwd, r.skills.map((s) => s.path)]), [
      ['/r', [alpha.path, plugin.path, repo.path]],
      ['/s', [alpha.path, plugin.path, '/s/.codex/skills/repo/SKILL.md']],
      ['/r-other', [alpha.path, plugin.path]],
    ]);
    assert.ok(list.data.every((r) => r.skills.every((s) => !Object.hasOwn(s, 'cwd'))));
    assert.deepEqual(await ask('skills/config/write', { name: plugin.name, enabled: false }), { effectiveEnabled: false });
    assert.deepEqual(await ask('skills/config/write', { path: repo.path, enabled: true }), { effectiveEnabled: true });
    const written = (await ask('skills/list', { cwds: ['/r', '/s'] })).data;
    assert.deepEqual(written.map((r) => r.skills.find((s) => s.name === plugin.name).enabled), [false, false]);
    assert.deepEqual(written.map((r) => r.skills.find((s) => s.name === 'repo').enabled), [true, false]);
    for (const selector of [{ path: '/absent' }, { name: 'absent' }]) {
      const params = { ...selector, enabled: true };
      issues.push(...shapeIssues('params', 'skills/config/write', params));
      assert.equal((await f.request('skills/config/write', params)).error.code, -32600);
    }
    await f.request('fake/skillsChanged', {});
    await f.until(() => f.inbox.some((m) => m.method === 'skills/changed'));
    const note = f.inbox.find((m) => m.method === 'skills/changed');
    assert.deepEqual(note.params, {});
    issues.push(...shapeIssues('notification', note.method, note.params));

    await f.request('fake/skills', { skills: [{ ...repo, cwd: undefined }] });
    assert.equal((await ask('skills/list', {})).data[0].skills.length, 1, 'a repo entry without cwd belongs to the fake cwd');
    assert.deepEqual((await ask('skills/list', { cwds: ['/r'] })).data[0].skills, []);
    await f.request('fake/skills', { skills: [] });
    assert.deepEqual((await ask('skills/list', {})).data[0].skills, []);
    assert.deepEqual(issues, []);
  } finally { await f.close(); }
});

test('skills rejects invalid list, write and replacement parameters', async () => {
  const f = await startInitialized();
  try {
    for (const [method, params] of [
      ['skills/list', { cwds: 'r' }], ['skills/list', { cwds: [1] }], ['skills/list', { forceReload: 'yes' }],
      ['skills/config/write', { enabled: true }], ['skills/config/write', { path: '/x', enabled: 'yes' }],
      ['fake/skills', {}],
    ]) assert.equal((await f.request(method, params)).error.code, -32602);
  } finally { await f.close(); }
});
