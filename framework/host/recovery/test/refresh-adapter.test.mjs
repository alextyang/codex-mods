import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { refreshAdapter, openAsar, selectorTokens } from '../../../../builder/refresh-adapter.mjs';
import { tempRoot, makeApp, baseAdapter } from './helpers.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Writes a small asar (files: {path: string}) in the real header layout. */
async function writeAsar(path, files) {
  const tree = { files: {} }; const chunks = []; let offset = 0;
  for (const [p, content] of Object.entries(files)) {
    const parts = p.split('/'); let n = tree;
    for (const part of parts.slice(0, -1)) n = n.files[part] ??= { files: {} };
    const buf = Buffer.from(content);
    n.files[parts.at(-1)] = { size: buf.length, offset: String(offset) };
    chunks.push(buf); offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(8 + padded, 4); head.writeUInt32LE(4 + padded, 8); head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  await writeFile(path, Buffer.concat([head, ...chunks]));
}
async function stock(dir, files) {
  const app = join(dir, 'Stock.app');
  await makeApp(app, '27.0', '777');
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true });
  await writeAsar(join(app, 'Contents', 'Resources', 'app.asar'), files);
  return app;
}
const T = (id, file, find, text, op = 'replace-once') => ({ id, seam: 'other', file, sha256Before: 'old', sha256After: 'old', op, find, text });

test('openAsar reads files out of the real header layout', async () => {
  const t = await tempRoot();
  try {
    await writeAsar(join(t.dir, 'a.asar'), { 'package.json': '{"main":"x"}', 'webview/assets/a.js': 'console.log(1)' });
    const a = await openAsar(join(t.dir, 'a.asar'));
    assert.equal((await a.read('webview/assets/a.js')).toString(), 'console.log(1)');
    assert.equal(await a.read('nope.js'), null);
    assert.deepEqual(a.files().map(([p]) => p).sort(), ['package.json', 'webview/assets/a.js']);
    await a.close();
  } finally { await t.cleanup(); }
});

test('selectorTokens extracts attribute values, classes and ids; tag-only selectors have none', () => {
  assert.deepEqual(selectorTokens('[data-testid="settings-nav"]').sort(), ['settings-nav']);
  assert.deepEqual(selectorTokens('nav.sidebar #main [aria-label=Settings]').sort(), ['Settings', 'main', 'sidebar']);
  assert.deepEqual(selectorTokens('[hidden]'), ['hidden']);
  assert.deepEqual(selectorTokens('div > section'), []);
});

test('refresh re-anchors transforms with chained hashes, drops misses, checks anchors and keeps the previous protocol on tool failure', async () => {
  const t = await tempRoot();
  try {
    const main = 'AAA const x=1; BBB const y=2; CCC dup dup';
    const other = 'nothing to see';
    const app = await stock(t.dir, { 'package.json': '{}', '.vite/build/main.js': main, '.vite/build/other.js': other,
      'webview/assets/index.js': 'const a="settings-nav";const b="composer-bar";' });
    const previous = baseAdapter({
      transforms: [
        T('t1', '.vite/build/main.js', 'const x=1;', 'const x=1;/*one*/'),
        T('t2', '.vite/build/main.js', 'BBB', '/*two*/', 'insert-before-once'),
        T('t3', '.vite/build/main.js', 'const GONE=0;', 'x'),
        T('t4', '.vite/build/main.js', 'dup', 'x'),
        T('t5', 'missing/file.js', 'a', 'b'),
        T('t6', '.vite/build/other.js', 'see', '!', 'insert-after-once'),
      ],
      anchors: {
        'settings.section': { selectors: ['[data-testid="settings-nav"]', '.gone-class'], placement: 'inside' },
        'composer.toolbar': { selectors: ['.not-there', '[role="nope-nope"]'], placement: 'after' },
        'sidebar.footer': { selectors: ['footer'], placement: 'inside' },
      },
    });
    const outDir = join(t.dir, 'adapters', '27.0-777');
    await mkdir(join(t.dir, 'adapters'), { recursive: true });
    const gen = async () => { throw new Error('generator not available'); };
    const res = await refreshAdapter({ previous, stockApp: app, outDir, protocolFromSchema: gen, runCodex: async () => {}, allowNoBaseline: true });
    const ids = res.adapter.transforms.map((x) => x.id);
    assert.deepEqual(ids, ['t1', 't2', 't6']);
    const [t1, t2, t6] = res.adapter.transforms;
    const after1 = main.replace('const x=1;', 'const x=1;/*one*/');
    assert.equal(t1.sha256Before, sha(main));
    assert.equal(t1.sha256After, sha(after1));
    assert.equal(t2.sha256Before, t1.sha256After, 'chained per file, the way the builder applies them');
    assert.equal(t2.sha256After, sha(after1.replace('BBB', '/*two*/BBB')));
    assert.equal(t6.sha256Before, sha(other));
    assert.equal(t6.sha256After, sha('nothing to see!'));
    assert.deepEqual(Object.entries(res.report.transforms).filter(([, v]) => v.missed).map(([k]) => k), ['t3', 't4', 't5']);
    assert.match(res.report.transforms.t4.reason, /occurs 2 times/);
    assert.deepEqual([res.report.anchors['settings.section'].missed, res.report.anchors['composer.toolbar'].missed, res.report.anchors['sidebar.footer'].missed], [false, true, false]);
    assert.equal(res.report.anchors['sidebar.footer'].selectors[0].status, 'unverified');
    assert.deepEqual(res.report.anchors['settings.section'].selectors.map((s) => s.status), ['found', 'missed']);
    assert.equal(res.report.protocol.regenerated, false);
    assert.match(res.report.protocol.reason, /generator not available/);
    assert.deepEqual(res.adapter.protocol, previous.protocol, 'previous catalog kept');
    assert.deepEqual(Object.keys(res.adapter.anchors), Object.keys(previous.anchors), 'the pack keeps every anchor; the runtime probe decides');
    assert.deepEqual([res.adapter.build.version, res.adapter.build.bundleVersion], ['27.0', '777']);
    assert.equal(res.adapter.build.asarSha256, sha(await readFile(join(app, 'Contents', 'Resources', 'app.asar'))));
    assert.equal(res.adapter.adapterVersion, '1.0.0+refresh.777');
    // files written atomically
    assert.deepEqual((await readdir(outDir)).sort(), ['NOTES.md', 'adapter.json', 'refresh-report.json']);
    assert.deepEqual((await readdir(join(t.dir, 'adapters'))), ['27.0-777']);
    assert.match(await readFile(join(outDir, 'NOTES.md'), 'utf8'), /missed t3/);
    assert.deepEqual(JSON.parse(await readFile(join(outDir, 'adapter.json'), 'utf8')), res.adapter);
    // refusing to overwrite
    await assert.rejects(refreshAdapter({ previous, stockApp: app, outDir, protocolFromSchema: gen, allowNoBaseline: true }), { code: 'Conflict' });
  } finally { await t.cleanup(); }
});

test('refresh regenerates the protocol from the new binary\'s schema with an isolated CODEX_HOME', async () => {
  const t = await tempRoot();
  try {
    const app = await stock(t.dir, { 'package.json': '{}' });
    const calls = [];
    const runCodex = async (codex, args, env) => { calls.push({ codex, args, home: env.CODEX_HOME }); };
    const protocolFromSchema = async (schemaDir, o) => {
      assert.equal(schemaDir, calls[0].args[3]);
      assert.deepEqual(o.previous, baseAdapter().protocol);
      return { handshake: { request: 'initialize', notification: 'initialized' }, affinityKeyPaths: ['params.threadId'], affinityCreators: [],
        methods: { clientRequests: ['a', 'b'], clientNotifications: ['c'], serverRequests: [], serverNotifications: ['d', 'e', 'f'] } };
    };
    await mkdir(join(t.dir, 'adapters'));
    const res = await refreshAdapter({ previous: baseAdapter(), stockApp: app, outDir: join(t.dir, 'adapters', 'n'), runCodex, protocolFromSchema, allowNoBaseline: true });
    assert.equal(calls[0].codex, join(app, 'Contents', 'Resources/codex-cli/bin/codex'));
    assert.deepEqual(calls[0].args.slice(0, 3), ['app-server', 'generate-json-schema', '--out']);
    assert.notEqual(calls[0].home, process.env.CODEX_HOME);
    assert.ok(calls[0].home.includes('codexmods-schema-'));
    const { census, ...protocol } = res.report.protocol;
    assert.deepEqual(protocol, { regenerated: true, counts: { clientRequests: 2, clientNotifications: 1, serverRequests: 0, serverNotifications: 3 } });
    // the census needs the experimental schema too (same isolated home); on this fixture app it cannot run, which is reported, not fatal
    assert.deepEqual(calls[1].args.slice(0, 4), ['app-server', 'generate-json-schema', '--experimental', '--out']);
    assert.equal(calls[1].home, calls[0].home);
    assert.equal(census.written, false);
    assert.match(census.reason, /main-process bundle/);
    assert.deepEqual(res.adapter.protocol.methods.clientRequests, ['a', 'b']);
  } finally { await t.cleanup(); }
});
