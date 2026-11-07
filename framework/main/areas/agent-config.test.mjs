// Configuration's project-file writes use the app's roots and workspaceFiles, preserving unrelated config text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { register, projectEnabled } = createRequire(import.meta.url)('./agent-config.cjs');
const root = '/workspace/project', file = `${root}/.codex/config.toml`;
const refusal = (e) => e.refused === true;

// the app's workspaceFiles as 21477's: a read gives the file's etag (`missing` when there is none); a write with `ifMatch` writes only that
// version, else says `conflict`; writeText makes the folder and writes as it is
function setup(text = '', options = {}) {
  const reads = [], writes = [], invalidated = [], cleared = [];
  let handler, version = 1, exists = !options.readError;
  const etag = () => (exists ? `v${version}` : 'missing');
  const files = {
    async read(args) { reads.push(args); if (options.readError && !exists) throw options.readError; const r = { text, etag: etag() }; await options.afterRead?.(); return r; },
    async write(args) {
      const contents = Buffer.from(args.bytes).toString('utf8');
      writes.push({ path: args.path, hostId: args.hostId, contents });
      if (options.writeError) throw options.writeError;
      if (!exists && options.noFolder && !fs.existsSync(path.dirname(args.path))) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      if (args.ifMatch !== etag()) return { etag: etag(), outcome: 'conflict' };
      text = contents; exists = true; version++;
      return { etag: etag(), outcome: 'saved' };
    },
    async writeText(args) { writes.push(args); if (options.writeError) throw options.writeError; text = args.contents; exists = true; version++; },
  };
  const services = {
    projects: { globalState: { get(key) { assert.equal(key, 'local-projects'); return options.projects ?? { p: { rootPaths: [root, '/workspace/second'] } }; } } },
    workspaceFiles: options.files === false ? {} : files,
    queryCache: { async invalidateQueryCache(args) { invalidated.push(args); } },
  };
  // the window's AppView: its clientCoordination (the prewarmed chats are the page's)
  const view = { services: { clientCoordination: { async clearPrewarmedThreads(args) { cleared.push(args); } } } };
  const hooks = {
    onAreaOp(area, fn) { assert.equal(area, 'agent-config'); handler = fn; },
    appHost: { first: () => options.window === false ? null : { host: { services }, view }, windows: () => (options.window === false ? [] : [{ id: 1, host: { services }, view }]) },
  };
  register(hooks);
  return { hooks, handler, reads, writes, invalidated, cleared, text: () => text, edit: (t) => { text = t; version++; },
    write: (key, value, at = root) => handler('project-config-write', { root: at, key, value }) };
}

test('refresh invalidates the requested app queries and unknown operations are refused', async () => {
  const s = setup();
  const keys = [['config'], ['user-saved-config']];
  assert.deepEqual(await s.handler('refresh', { keys }), { refreshed: 2 });
  assert.deepEqual(s.invalidated, keys.map((queryKey) => ({ queryKey, reset: false })));
  assert.deepEqual(await s.handler('refresh', { keys: [['unknown'], []] }), { refreshed: 0 });
  await assert.rejects(s.handler('nope'), (e) => e.refused && e.message === 'unknown operation nope');
});

test('only exact project roots and the six allowed keys with their allowed values reach workspaceFiles', async () => {
  const s = setup();
  for (const at of [undefined, null, 1, '', 'relative', '/workspace', `${root}/child`, `${root}/../project`, `${root}/`]) await assert.rejects(s.write('web_search', 'live', at === undefined ? null : at), refusal);
  for (const key of ['model', 'model_reasoning_effort', 'other', '__proto__', 'constructor', 'toString', undefined]) await assert.rejects(s.write(key, null), refusal);
  const cases = [
    ['approval_policy', ['on-request', 'never']],
    ['sandbox_mode', ['read-only', 'workspace-write', 'danger-full-access']],
    ['sandbox_workspace_write.network_access', [true, false]],
    ['web_search', ['disabled', 'cached', 'indexed', 'live']],
    ['model_verbosity', ['low', 'medium', 'high']],
    ['model_reasoning_summary', ['auto', 'concise', 'detailed', 'none']],
  ];
  for (const [key] of cases) for (const value of [undefined, '', 'invalid', 0, [], {}]) await assert.rejects(s.write(key, value), refusal);
  for (const [key] of cases.filter(([key]) => key !== 'sandbox_workspace_write.network_access')) for (const value of [true, false]) await assert.rejects(s.write(key, value), refusal);
  await assert.rejects(s.write('sandbox_workspace_write.network_access', 'true'), refusal);
  assert.deepEqual(s.reads, []);
  for (const [key, values] of cases) {
    for (const value of values) assert.deepEqual(await s.write(key, value), { written: true });
    assert.deepEqual(await s.write(key, null), { written: true });
  }
  assert.deepEqual(await s.write('web_search', 'live', '/workspace/second'), { written: true });
  assert.equal(s.writes.at(-1).path, '/workspace/second/.codex/config.toml');
  await assert.rejects(setup('', { projects: { bad: { rootPaths: root } } }).write('web_search', 'live'), refusal);
});

test('top-level edits replace, insert before tables or at the end, and remove only the top-level line', async () => {
  const cases = [
    ['# keep\n web_search = "cached" # old\n[other]\nweb_search = "disabled"\n', 'live', '# keep\nweb_search = "live"\n[other]\nweb_search = "disabled"\n'],
    ['# keep\n[other]\nweb_search = "cached"\n', 'indexed', '# keep\nweb_search = "indexed"\n[other]\nweb_search = "cached"\n'],
    ['# keep\n', 'live', '# keep\nweb_search = "live"\n'],
    ['# keep', 'live', '# keep\nweb_search = "live"\n'],
    ['', 'cached', 'web_search = "cached"\n'],
    ['web_search = "live"\n[other]\nweb_search = "cached"\n', null, '[other]\nweb_search = "cached"\n'],
    ['web_search = "cached"', null, ''],
    ['# keep\r\n[other]\r\nx = true\r\n', 'live', '# keep\r\nweb_search = "live"\r\n[other]\r\nx = true\r\n'],
  ];
  for (const [before, value, after] of cases) {
    const s = setup(before);
    assert.deepEqual(await s.write('web_search', value), { written: true });
    assert.equal(s.text(), after);
    assert.deepEqual(s.reads, [{ hostId: 'local', path: file, representation: 'text', maxBytes: 1_048_576 }]);
    assert.deepEqual(s.writes, [{ path: file, hostId: 'local', contents: after }]);
  }
});

test('network access edits stay in its table, insert after the header, append a missing table, and refuse an inline table', async () => {
  const key = 'sandbox_workspace_write.network_access';
  const cases = [
    ['network_access = false\n[sandbox_workspace_write]\n# keep\nnetwork_access = false\n[other]\nnetwork_access = false\n', true,
      'network_access = false\n[sandbox_workspace_write]\n# keep\nnetwork_access = true\n[other]\nnetwork_access = false\n'],
    ['[sandbox_workspace_write] # keep\nother = true\n[next]\nx = 1\n', false, '[sandbox_workspace_write] # keep\nnetwork_access = false\nother = true\n[next]\nx = 1\n'],
    ['[other]\nnetwork_access = true\n', false, '[other]\nnetwork_access = true\n\n[sandbox_workspace_write]\nnetwork_access = false\n'],
    ['', true, '\n[sandbox_workspace_write]\nnetwork_access = true\n'],
    ['[sandbox_workspace_write]\nnetwork_access = true\nkeep = true\n', null, '[sandbox_workspace_write]\nkeep = true\n'],
    ['[sandbox_workspace_write]', true, '[sandbox_workspace_write]\nnetwork_access = true'],
  ];
  for (const [before, value, after] of cases) {
    const s = setup(before);
    assert.deepEqual(await s.write(key, value), { written: true });
    assert.equal(s.text(), after);
  }
  for (const value of [true, false, null]) {
    const s = setup('# keep\nsandbox_workspace_write = {network_access = true}\n[other]\nx = 1\n');
    await assert.rejects(s.write(key, value), (e) => e.refused && /inline/.test(e.message));
    assert.deepEqual(s.writes, []);
  }
  const nested = setup('[other]\nsandbox_workspace_write = {network_access = true}\n');
  assert.deepEqual(await nested.write(key, true), { written: true }, 'an unrelated table is not a top-level inline table');
});

test('unchanged values and absent removals never write; missing files start empty and other failures retain their errors', async () => {
  for (const [text, key, value] of [
    ['web_search = "live"\n', 'web_search', 'live'],
    ['[other]\nweb_search = "cached"\n', 'web_search', null],
    ['[sandbox_workspace_write]\nnetwork_access = false\n', 'sandbox_workspace_write.network_access', false],
    ['[other]\nx = 1\n', 'sandbox_workspace_write.network_access', null],
    ['[sandbox_workspace_write]\nother = true\n', 'sandbox_workspace_write.network_access', null],
  ]) {
    const s = setup(text);
    assert.deepEqual(await s.write(key, value), { written: false });
    assert.deepEqual(s.writes, []);
  }
  for (const error of [Object.assign(new Error('missing'), { code: 'ENOENT' }), Object.assign(new Error('missing'), { code: 'ENOTDIR' }), new Error('ENOENT: no such file')]) {
    const s = setup('', { readError: error });
    assert.deepEqual(await s.write('approval_policy', 'never'), { written: true });
    assert.equal(s.text(), 'approval_policy = "never"\n');
  }
  const readError = new Error('read failed'), writeError = new Error('write failed');
  const s = setup('', { readError });
  await assert.rejects(s.write('web_search', 'live'), (e) => e === readError);
  assert.deepEqual(s.writes, []);
  await assert.rejects(setup('', { writeError }).write('web_search', 'live'), (e) => e === writeError);
  await assert.rejects(setup('', { files: false }).write('web_search', 'live'), refusal);
  await assert.rejects(setup('', { window: false }).write('web_search', 'live'), refusal);
});

test('scoped enable (F9): a table\'s `enabled` in a project\'s config, set, replaced and taken away (its table too when empty); other ways of saying the entry refused', async () => {
  const { setTableEnabled } = createRequire(import.meta.url)('./agent-config.cjs');
  const set = (text, value, table = 'mcp_servers', name = 'qa-scope') => setTableEnabled(text, table, name, value);
  // a new table at the end, a name that needs quoting quoted
  assert.equal(set('', false), '[mcp_servers.qa-scope]\nenabled = false\n');
  assert.equal(set('model = "x"\n', true, 'plugins', 'pdf@openai-primary-runtime'), 'model = "x"\n\n[plugins."pdf@openai-primary-runtime"]\nenabled = true\n');
  // its own table, written bare or quoted: the line replaced, or added under the header; other keys kept
  const t = '[mcp_servers."qa-scope"]\ncommand = "x" # mine\nenabled = false\n\n[other]\nenabled = true\n';
  assert.equal(set(t, true), '[mcp_servers."qa-scope"]\ncommand = "x" # mine\nenabled = true\n\n[other]\nenabled = true\n');
  assert.equal(set('[mcp_servers.qa-scope]\ncommand = "x"\n', false), '[mcp_servers.qa-scope]\nenabled = false\ncommand = "x"\n');
  // taken away: the line; the table too when nothing is left in it
  assert.equal(set(t, null), '[mcp_servers."qa-scope"]\ncommand = "x" # mine\n\n[other]\nenabled = true\n');
  assert.equal(set('a = 1\n\n[mcp_servers.qa-scope]\nenabled = false\n', null), 'a = 1\n');
  assert.equal(set('a = 1\n', null), 'a = 1\n', 'nothing to take away: the same text');
  assert.equal(set('[mcp_servers.qa-scope]\r\nenabled = false\r\n', true), '[mcp_servers.qa-scope]\r\nenabled = true\r\n', 'CRLF kept');
  // a subtable is its own: [mcp_servers.qa-scope.env] is not the server's table
  assert.equal(set('[mcp_servers.qa-scope.env]\nA = "1"\n', false), '[mcp_servers.qa-scope.env]\nA = "1"\n\n[mcp_servers.qa-scope]\nenabled = false\n');
  // a multi-line string's lines are not tables or keys
  assert.equal(set('note = """\n[mcp_servers.qa-scope]\n"""\n', false), 'note = """\n[mcp_servers.qa-scope]\n"""\n\n[mcp_servers.qa-scope]\nenabled = false\n');
  for (const [text, re] of [
    ['[mcp_servers]\nqa-scope = { enabled = false }\n', /dotted key or an inline table/],
    ['mcp_servers.qa-scope.enabled = false\n', /dotted key or an inline table/],
    ['[mcp_servers]\n"qa-scope".command = "x"\n', /dotted key or an inline table/],
    ['[[mcp_servers.qa-scope]]\nx = 1\n', /array of tables/],
    ['[mcp_servers.qa-scope]\nenabled = true\n[mcp_servers."qa-scope"]\nx = 1\n', /two \[mcp_servers.qa-scope\] tables/],
  ]) assert.throws(() => set(text, false), re, text);
});

test('scoped enable (F9, built review round 1): one pass reads strings, comments, arrays and escaped keys as such; a parent said inline is refused; what is written is read again', () => {
  const { setTableEnabled } = createRequire(import.meta.url)('./agent-config.cjs');
  const set = (text, value, name = 'qa') => setTableEnabled(text, 'mcp_servers', name, value);
  // an `enabled` line inside a multi-line string, or an array, is not the table's
  assert.equal(set('[mcp_servers.qa]\nargs = """\nenabled = true\n"""\nenabled = true\n', false), '[mcp_servers.qa]\nargs = """\nenabled = true\n"""\nenabled = false\n');
  assert.equal(set('[mcp_servers.qa]\nargs = [\n  "a", # c ]\n  "enabled = true",\n]\n', true), '[mcp_servers.qa]\nenabled = true\nargs = [\n  "a", # c ]\n  "enabled = true",\n]\n');
  // a comment holding """ is a comment
  assert.equal(set('# a """ note\n[mcp_servers.qa]\nenabled = true # mine\n', false), '# a """ note\n[mcp_servers.qa]\nenabled = false # mine\n');
  // a key's escapes decoded: "qa\u002dscope" is qa-scope
  assert.equal(set('[mcp_servers."qa\\u002dscope"]\nenabled = true\n', false, 'qa-scope'), '[mcp_servers."qa\\u002dscope"]\nenabled = false\n');
  assert.equal(set('[mcp_servers."qa\\u002dscope"]\nenabled = true\n', null, 'qa-scope'), '');
  for (const [text, re] of [
    ['mcp_servers = { qa = { enabled = true } }\n', /mcp_servers with an inline table/],
    ['[[mcp_servers]]\nx = 1\n', /array of tables/],
    ['[mcp_servers.qa]\nenabled = true\nenabled = false\n', /enabled twice/],
    ['x = "unterminated\n', /not TOML/],
    ['[mcp_servers.qa]\nenabled = true\nx = "\\q"\n', /not TOML/],
    // `enabled` said as a table (round 2): a value beside it would be invalid TOML
    ['[mcp_servers.qa]\nenabled . "detail" = true\n', /enabled as a table/],
    ['[mcp_servers.qa.enabled]\nx = 1\n', /enabled as a table/],
  ]) assert.throws(() => set(text, false), re, text);
  // a header on the last line with no line end (round 2)
  assert.equal(set('[mcp_servers.qa]', false), '[mcp_servers.qa]\nenabled = false\n');
  assert.equal(set('a = 1\r\n[mcp_servers.qa]', true), 'a = 1\r\n[mcp_servers.qa]\r\nenabled = true\r\n');
});

test('scoped enable (F9, built review round 1): a write is of the file as it was read (a change since is a conflict, nothing overwritten); the framework\'s writes to one file go one at a time; a missing folder is made; written, the prewarmed chats are dropped', async () => {
  const args = (name, value) => ({ root, name, value });
  // two changes at once, a server's and a plugin's: both kept
  const s = setup('model = "x"\n');
  await Promise.all([projectEnabled(s.hooks, 'mcp_servers', args('qa', false)), projectEnabled(s.hooks, 'plugins', args('pdf@x', true))]);
  assert.equal(s.text(), 'model = "x"\n\n[mcp_servers.qa]\nenabled = false\n\n[plugins."pdf@x"]\nenabled = true\n');
  assert.deepEqual(s.cleared, [{ hostId: 'local' }, { hostId: 'local' }], 'each write drops the windows\' prewarmed chats');
  // the file changed between its read and the write (the user saved it): refused, their text kept
  const c = setup('[mcp_servers.qa]\nenabled = true\n', { afterRead: () => c.edit('[mcp_servers.qa]\nenabled = true\ncommand = "mine"\n') });
  await assert.rejects(projectEnabled(c.hooks, 'mcp_servers', args('qa', false)), (e) => refusal(e) && /changed since it was read/.test(e.message));
  assert.equal(c.text(), '[mcp_servers.qa]\nenabled = true\ncommand = "mine"\n');
  assert.deepEqual(c.cleared, []);
  // no file and no .codex folder: the folder made, then the same conditional write
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codex-'));
  try {
    const m = setup('', { readError: Object.assign(new Error('missing'), { code: 'ENOENT' }), noFolder: true, projects: { p: { rootPaths: [dir] } } });
    assert.deepEqual(await projectEnabled(m.hooks, 'mcp_servers', { root: dir, name: 'qa', value: false }), { written: true });
    assert.equal(m.text(), '[mcp_servers.qa]\nenabled = false\n');
    assert.ok(fs.statSync(path.join(dir, '.codex')).isDirectory());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // nothing to change: nothing written, nothing dropped
  const n = setup('a = 1\n');
  assert.deepEqual(await projectEnabled(n.hooks, 'mcp_servers', args('qa', null)), { written: false });
  assert.deepEqual([n.writes, n.cleared], [[], []]);
});
