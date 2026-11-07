import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../codexmods.mjs';
import { makeRoot, makeIo, startFakeHost, op } from './fake-host.mjs';

async function withHost(t, handlers, opts) {
  const { root, cleanup } = await makeRoot();
  const host = await startFakeHost(root, handlers, opts);
  t.after(async () => { await host.close(); await cleanup(); });
  return { root, host, io: (extra) => makeIo(root, extra) };
}
const ID = 'op-0000000000000001';

test('no Host running: exit 2 with "Host not running"', async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const io = makeIo(root);
  assert.equal(await main(['mods', 'list'], io), 2);
  assert.match(io.err, /Host not running/);
  // a token left behind by a crashed Host but no listener
  const lay = (await import('../../contracts/layout.mjs')).layout(root, 'default');
  await mkdir(lay.run, { recursive: true });
  await writeFile(join(lay.run, 'mgmt.token'), 'x');
  const io2 = makeIo(root);
  assert.equal(await main(['ops', 'list'], io2), 2);
  assert.match(io2.err, /Host not running/);
});

test('--root and --profile override CODEX_MODS_ROOT and CODEX_MODS_PROFILE', async (t) => {
  const { root: other, cleanup } = await makeRoot();
  t.after(cleanup);
  const { root, host } = await withHost(t, { 'mods.list': () => ({ mods: [] }) }, { profile: 'qa' });
  const io = makeIo(other, { env: { CODEX_MODS_ROOT: other, CODEX_MODS_PROFILE: 'default' } });
  assert.equal(await main(['mods', 'list'], io), 2, 'the env points at a root with no Host');
  const io2 = makeIo(other, { env: { CODEX_MODS_ROOT: other } });
  assert.equal(await main(['--root', root, '--profile', 'qa', 'mods', 'list'], io2), 0, io2.err);
  const io3 = makeIo(other);
  assert.equal(await main(['mods', 'list', '--root', root, '--profile', 'qa'], io3), 0, io3.err);
  const io4 = makeIo(root, { env: { CODEX_MODS_ROOT: root, CODEX_MODS_PROFILE: 'qa' } });
  assert.equal(await main(['mods', 'list'], io4), 0);
  assert.ok(host.calls.length >= 3);
});

test('mods list: human table and --json', async (t) => {
  const mods = [{ id: 'acme.demo', name: 'Demo', version: '1.0.0', status: 'enabled', dev: false, publisherFingerprint: 'abcd1234abcd1234', compatibility: 'compatible', hasSettings: true, pendingUpdate: null, quarantine: null },
    { id: 'dev.mod', name: 'Dev', version: '0.1.0', status: 'pending-consent', dev: true, publisherFingerprint: null, compatibility: 'degraded', hasSettings: false, pendingUpdate: { version: '0.2.0', addedPermissions: [] }, quarantine: null }];
  const { io } = await withHost(t, { 'mods.list': () => ({ mods }) });
  const a = io();
  assert.equal(await main(['mods', 'list'], a), 0);
  assert.match(a.out, /ID\s+NAME\s+VERSION\s+STATUS/);
  assert.match(a.out, /acme\.demo\s+Demo\s+1\.0\.0\s+enabled\s+compatible\s+abcd1234abcd1234/);
  assert.match(a.out, /dev\.mod .*update 0\.2\.0 awaiting consent.*degraded\s+dev/);
  const b = io();
  assert.equal(await main(['mods', 'list', '--json'], b), 0);
  assert.deepEqual(JSON.parse(b.out), { mods });
});

test('mods inspect prints permissions grouped by risk', async (t) => {
  const detail = { id: 'acme.demo', name: 'Demo', version: '1.0.0', status: 'enabled', dev: false, publisherFingerprint: 'ff', compatibility: 'compatible',
    permissionText: [{ risk: 'high', text: 'Can run its own programs on your Mac' }, { risk: 'low', text: 'Can add controls to the Codex interface' }],
    versionsInStore: ['0.9.0', '1.0.0'], snapshots: [{ fromVersion: '0.9.0', at: new Date().toISOString() }], dataBytes: 2048,
    recentOps: [op({ outcome: 'succeeded' })], quarantine: null, publisherChange: { oldFingerprint: 'aa', newFingerprint: 'bb' }, pendingUpdate: null };
  const { io, host } = await withHost(t, { 'mods.inspect': () => detail });
  const a = io();
  assert.equal(await main(['mods', 'inspect', 'acme.demo'], a), 0);
  assert.match(a.out, /\[high\] Can run its own programs/);
  assert.match(a.out, /PUBLISHER CHANGE: aa -> bb/);
  assert.match(a.out, /data:\s+2\.0 KiB/);
  assert.deepEqual(host.calls.at(-1), { method: 'mods.inspect', params: { modId: 'acme.demo' } });
});

function scriptedOp(host, finalPatch, { delay = 20 } = {}) {
  // The mutation returns the opId; the op ends a little later with events (the CLI must wait for them).
  return () => {
    setTimeout(() => host.emit({ event: 'op', data: op({ phases: [{ name: 'verify', at: 'x' }] }) }), delay);
    setTimeout(() => { state.current = op(finalPatch); host.emit({ event: 'op', data: state.current }); }, delay * 2);
    return { opId: ID };
  };
}
const state = { current: op() };

test('mutations wait for their op: succeeded → 0 with progress, failed/reverted/needs-attention → 1', async (t) => {
  const ref = {};
  const { io, host } = await withHost(t, {
    'mods.enable': () => ref.start(),
    'ops.get': () => state.current,
  });
  ref.start = scriptedOp(host, { outcome: 'succeeded', note: 'enabled' });
  state.current = op();
  let a = io();
  assert.equal(await main(['mods', 'enable', 'acme.demo'], a), 0, a.err);
  assert.match(a.out, /verify\.\.\./);
  assert.match(a.out, /enable acme\.demo\s+succeeded/);
  assert.match(a.out, /enabled/);

  for (const [patch, text] of [
    [{ outcome: 'failed', error: { code: 'Incompatible', message: 'needs anchor composer' } }, /error \[Incompatible\]: needs anchor composer/],
    [{ outcome: 'reverted', note: 'activation failed; the old version is running' }, /reverted[\s\S]*old version is running/],
    [{ outcome: 'needs-attention', note: 'external effects possible' }, /needs-attention[\s\S]*external effects possible/],
  ]) {
    ref.start = scriptedOp(host, patch);
    state.current = op();
    a = io();
    assert.equal(await main(['mods', 'enable', 'acme.demo'], a), 1);
    assert.match(a.out, text);
  }
});

test('an op that already ended before the CLI subscribed is still reported (no race)', async (t) => {
  const { io } = await withHost(t, {
    'mods.disable': () => { state.current = op({ outcome: 'succeeded' }); return { opId: ID }; },
    'ops.get': () => state.current,
  });
  const a = io();
  assert.equal(await main(['mods', 'disable', 'acme.demo', '--json'], a), 0);
  assert.equal(JSON.parse(a.out).outcome, 'succeeded');
});

test('--no-wait prints the opId and does not subscribe', async (t) => {
  const { io, host } = await withHost(t, { 'mods.enable': () => ({ opId: ID }) });
  const a = io();
  assert.equal(await main(['mods', 'enable', 'acme.demo', '--no-wait'], a), 0);
  assert.equal(a.out.trim(), ID);
  assert.deepEqual(host.calls.map((c) => c.method), ['mods.enable']);
  const b = io();
  assert.equal(await main(['mods', 'enable', 'acme.demo', '--no-wait', '--json'], b), 0);
  assert.deepEqual(JSON.parse(b.out), { opId: ID });
});

test('an install that stops at consent succeeds and tells the user what to run', async (t) => {
  const { io, host } = await withHost(t, {
    'mods.install': () => { state.current = op({ input: { type: 'install', source: '/work/dir/x.codexmod' }, outcome: 'succeeded', awaiting: 'consent', note: 'consent required' }); return { opId: ID }; },
    'ops.get': () => state.current,
  });
  const a = io();
  assert.equal(await main(['mods', 'install', 'x.codexmod', '--enable'], a), 0);
  assert.match(a.out, /Consent required: codexmods mods consent/);
  assert.deepEqual(host.calls.find((c) => c.method === 'mods.install').params, { source: '/work/dir/x.codexmod', enable: true });
});

test('mods subcommands send the right management calls', async (t) => {
  const log = [];
  const done = () => { state.current = op({ outcome: 'succeeded' }); return { opId: ID }; };
  const handlers = Object.fromEntries(['install', 'consent', 'enable', 'disable', 'configure', 'update', 'rollback', 'remove', 'reattach', 'clearQuarantine', 'setPermission']
    .map((m) => [`mods.${m}`, (p) => { log.push([`mods.${m}`, p]); return done(); }]));
  handlers['ops.get'] = () => state.current;
  handlers['mods.inspect'] = () => ({ settings: { a: { b: 1 }, keep: true } });
  const { io } = await withHost(t, handlers);
  const run = async (...argv) => { const i = io(); const code = await main(argv, i); assert.equal(code, 0, `${argv.join(' ')}: ${i.err}${i.out}`); };
  await run('mods', 'install', '/abs/dir', '--dev');
  await run('mods', 'consent', 'acme.demo', '--approve', '--enable');
  await run('mods', 'consent', 'acme.demo', '--deny');
  await run('mods', 'disable', 'acme.demo');
  await run('mods', 'update', 'acme.demo', 'new.codexmod');
  await run('mods', 'rollback', 'acme.demo', '1.0.0', '--restore-data');
  await run('mods', 'rollback', 'acme.demo', '0.9.0');
  await run('mods', 'remove', 'acme.demo');
  await run('mods', 'remove', 'acme.demo', '--delete-data');
  await run('mods', 'reattach', 'acme.demo');
  await run('mods', 'reattach', 'acme.demo', '--generation', '2026-10-11T09:30:00.000Z');
  await run('mods', 'clear-quarantine', 'acme.demo');
  await run('mods', 'permission', 'acme.demo', 'secrets', 'deny');
  await run('mods', 'configure', 'acme.demo', '--set', 'a.b=2', '--set', 'name=hi', '--set', 'list=[1,2]');
  assert.deepEqual(log, [
    ['mods.install', { source: '/abs/dir', dev: true }],
    ['mods.consent', { modId: 'acme.demo', approve: true, enable: true }],
    ['mods.consent', { modId: 'acme.demo', approve: false }],
    ['mods.disable', { modId: 'acme.demo' }],
    ['mods.update', { modId: 'acme.demo', source: '/work/dir/new.codexmod' }],
    ['mods.rollback', { modId: 'acme.demo', toVersion: '1.0.0', restoreData: true }],
    ['mods.rollback', { modId: 'acme.demo', toVersion: '0.9.0', restoreData: false }],
    ['mods.remove', { modId: 'acme.demo', deleteData: false }],
    ['mods.remove', { modId: 'acme.demo', deleteData: true }],
    ['mods.reattach', { modId: 'acme.demo' }],
    ['mods.reattach', { modId: 'acme.demo', generation: '2026-10-11T09:30:00.000Z' }],
    ['mods.clearQuarantine', { modId: 'acme.demo' }],
    ['mods.setPermission', { modId: 'acme.demo', grant: 'secrets', decision: 'deny' }],
    // --set: one operation of app-scope patches (systems.md E3), never a read-modify-write of the whole document.
    ['mods.configure', { modId: 'acme.demo', patches: [{ key: 'a.b', value: 2, scope: 'app' }, { key: 'name', value: 'hi', scope: 'app' }, { key: 'list', value: [1, 2], scope: 'app' }] }],
  ]);
});

test('usage errors exit 2 without contacting a Host', async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const cases = [
    ['mods'], ['mods', 'bogus'], ['mods', 'enable'], ['mods', 'consent', 'acme.demo'], ['mods', 'consent', 'acme.demo', '--approve', '--deny'],
    ['mods', 'install'], ['mods', 'configure', 'acme.demo'],  ['mods', 'enable', 'a', '--bogus'],
    ['ops', 'wait'], ['bogus-command'], [],
  ];
  for (const argv of cases) {
    const io = makeIo(root);
    assert.equal(await main(argv, io), 2, argv.join(' '));
    assert.doesNotMatch(io.err, /^Host not running/m, argv.join(' '));
  }
  const help = makeIo(root);
  assert.equal(await main(['--help'], help), 0);
  assert.match(help.out, / {2}mods list\|inspect/);
  const mh = makeIo(root);
  assert.equal(await main(['mods', '--help'], mh), 0);
});

test('Management errors print code and message, exit 1', async (t) => {
  const { io } = await withHost(t, { 'mods.enable': () => { throw { code: 'Conflict', message: 'acme.demo already has an operation running' }; } });
  const a = io();
  assert.equal(await main(['mods', 'enable', 'acme.demo'], a), 1);
  assert.match(a.err, /error \[Conflict\]: acme\.demo already has an operation running/);
});

test('ops get / list / wait', async (t) => {
  const finished = op({ outcome: 'succeeded', phases: [{ name: 'a', at: 'x' }, { name: 'b', at: 'y' }] });
  const ref = { cur: op() };
  const { io, host } = await withHost(t, {
    'ops.get': (p) => (p.opId === ID ? ref.cur : (() => { throw { code: 'Unavailable', message: `ops.get: no operation "${p.opId}"` }; })()),
    'ops.list': (p) => ({ ops: [finished].filter((o) => (p.modId ?? o.input.modId) === o.input.modId) }),
  });
  ref.cur = finished;
  let a = io();
  assert.equal(await main(['ops', 'get', ID], a), 0);
  assert.match(a.out, /succeeded/);
  assert.match(a.out, /phases: a > b/);
  a = io();
  assert.equal(await main(['ops', 'list', '--mod', 'acme.demo'], a), 0);
  assert.match(a.out, new RegExp(`${ID}\\s+enable\\s+acme\\.demo\\s+succeeded`));
  a = io();
  assert.equal(await main(['ops', 'get', 'op-ffffffffffffffff'], a), 1);
  assert.match(a.err, /Unavailable/);

  // wait follows events until the op ends
  ref.cur = op({ phases: [{ name: 'a', at: 'x' }] });
  setTimeout(() => host.emit({ event: 'op', data: op({ outcome: 'failed', error: { code: 'Timeout', message: 'too slow' } }) }), 150);
  a = io();
  assert.equal(await main(['ops', 'wait', ID], a), 1);
  assert.match(a.out, /error \[Timeout\]: too slow/);

  ref.cur = op();
  setTimeout(() => host.emit({ event: 'op', data: op({ outcome: 'succeeded' }) }), 150);
  a = io();
  assert.equal(await main(['ops', 'wait', ID], a), 0);
  // events for other ops are ignored
  ref.cur = op();
  setTimeout(() => host.emit({ event: 'op', data: op({ id: 'op-00000000000000ff', outcome: 'failed' }) }), 100);
  setTimeout(() => host.emit({ event: 'op', data: op({ outcome: 'succeeded' }) }), 200);
  a = io();
  assert.equal(await main(['ops', 'wait', ID, '--json'], a), 0);
  assert.equal(JSON.parse(a.out).id, ID);
});

test('ops wait reports a lost connection instead of hanging', async (t) => {
  const ref = {};
  const { io, host } = await withHost(t, { 'ops.get': () => op() });
  ref.host = host;
  setTimeout(() => host.close(), 150);
  const a = io();
  assert.equal(await main(['ops', 'wait', ID], a), 1);
  assert.match(a.err, /Host connection closed/);
});

test('keygen and pack call the pack module (injected)', async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const modPath = join(root, 'fakepack.mjs');
  await writeFile(modPath, `
    export const calls = [];
    export async function keygen() { return { publicKey: 'UFVCTElD', privateKeyPem: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' }; }
    export async function packMod(dir, pem, out) { (globalThis.__packCalls ??= []).push([dir, pem, out]); return { contentHash: 'h'.repeat(64) }; }
  `);
  const work = await mkdtemp(join(tmpdir(), 'cw-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const io = (x) => makeIo(root, { cwd: work, modules: { pack: modPath }, ...x });

  let a = io();
  assert.equal(await main(['keygen', '--out', 'pub.pem'], a), 0, a.err);
  assert.equal((await stat(join(work, 'pub.pem'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(work, 'pub.pem'), 'utf8'), /BEGIN PRIVATE KEY/);
  assert.match(a.out, /Public key:\s+UFVCTElD/);
  assert.match(a.out, /Fingerprint:\s+[0-9a-f]{16}/);
  assert.doesNotMatch(a.out, /BEGIN PRIVATE KEY/);
  a = io();
  assert.equal(await main(['keygen', '--out', 'pub.pem'], a), 1, 'never overwrites an existing key');
  a = io();
  assert.equal(await main(['keygen', '--json'], a), 0);
  assert.equal(JSON.parse(a.out).publicKey, 'UFVCTElD');

  await mkdir(join(work, 'mymod'));
  a = io();
  assert.equal(await main(['pack', 'mymod', '--key', 'pub.pem', '--out', 'out/x.codexmod'], a), 0, a.err);
  assert.deepEqual(globalThis.__packCalls[0], [join(work, 'mymod'), await readFile(join(work, 'pub.pem'), 'utf8'), join(work, 'out/x.codexmod')]);
  assert.match(a.out, /Packed .*x\.codexmod/);
  a = io();
  assert.equal(await main(['pack', 'mymod'], a), 2);
  a = io();
  assert.equal(await main(['pack', 'nodir', '--key', 'pub.pem'], a), 2);
  a = io({ modules: { pack: join(root, 'missing.mjs') } });
  assert.equal(await main(['pack', 'mymod', '--key', 'pub.pem'], a), 1);
  assert.match(a.err, /packaging module is not available/);
});

test('new scaffolds from the template, substituting the id', async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const tpl = join(root, 'tpl');
  await mkdir(join(tpl, 'test'), { recursive: true });
  await mkdir(join(tpl, 'node_modules'));
  await writeFile(join(tpl, 'mod.json'), '{"id":"example.starter","name":"example.starter"}');
  await writeFile(join(tpl, 'host.mjs'), "export default 'example.starter';\n");
  await writeFile(join(tpl, 'test', 'starter.test.mjs'), "// example.starter\n");
  await writeFile(join(tpl, 'node_modules', 'x'), 'no');
  await writeFile(join(tpl, 'logo.bin'), Buffer.from([0, 1, 2, 0x65, 0x78]));
  const work = await mkdtemp(join(tmpdir(), 'cw-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const io = () => makeIo(root, { cwd: work, templateDir: tpl });

  let a = io();
  assert.equal(await main(['new', 'acme.cool-mod'], a), 0, a.err);
  const dir = join(work, 'acme.cool-mod');
  assert.equal(JSON.parse(await readFile(join(dir, 'mod.json'), 'utf8')).id, 'acme.cool-mod');
  assert.equal(await readFile(join(dir, 'host.mjs'), 'utf8'), "export default 'acme.cool-mod';\n");
  assert.match(await readFile(join(dir, 'test', 'starter.test.mjs'), 'utf8'), /acme\.cool-mod/);
  assert.deepEqual([...await readFile(join(dir, 'logo.bin'))], [0, 1, 2, 0x65, 0x78]);
  assert.ok(!(await readdir(dir)).includes('node_modules'));

  a = io();
  assert.equal(await main(['new', 'acme.cool-mod'], a), 2, 'refuses a non-empty directory');
  a = io();
  assert.equal(await main(['new', 'other.mod', '--dir', 'sub/here'], a), 0);
  assert.equal(JSON.parse(await readFile(join(work, 'sub/here/mod.json'), 'utf8')).id, 'other.mod');
  for (const bad of ['X', 'ab', '../x', 'Has Space', '..']) {
    a = io();
    assert.equal(await main(['new', bad], a), 2, bad);
  }
  a = makeIo(root, { cwd: work, templateDir: join(root, 'nope') });
  assert.equal(await main(['new', 'fine.mod'], a), 2);
});

test('new: each starter (graph-integrity G8.3) by its kind, the panel by default; an unknown kind is refused', async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const work = await mkdtemp(join(tmpdir(), 'cw-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const io = () => makeIo(root, { cwd: work });
  for (const [kind, entries] of [['panel', ['renderer.mjs']], ['rule', ['renderer.mjs']], ['contribution', ['host.mjs', 'renderer.mjs']], ['agent', ['host.mjs', 'renderer.mjs']]]) {
    const a = io();
    assert.equal(await main(['new', `acme.${kind}`, '--kind', kind], a), 0, a.err);
    const dir = join(work, `acme.${kind}`);
    const m = JSON.parse(await readFile(join(dir, 'mod.json'), 'utf8'));
    assert.equal(m.id, `acme.${kind}`);
    assert.deepEqual(Object.values(m.entry).sort(), entries, kind);
    assert.ok((await readdir(join(dir, 'test'))).some((f) => f.endsWith('.test.mjs')), `${kind} has its test`);
    assert.ok(!(m.permissions ?? []).some((p) => p.startsWith('appServer.')), `${kind} leads with the graph`);
    // its test loads this checkout's testing kit (no @codexmods/sdk is installed where it was made)
    const testFile = (await readdir(join(dir, 'test'))).find((f) => f.endsWith('.test.mjs'));
    const kit = /import\('(file:[^']+\/sdk\/testing\/index\.mjs)'\)/.exec(await readFile(join(dir, 'test', testFile), 'utf8'))?.[1];
    assert.ok(kit && (await stat(new URL(kit))).isFile(), `${kind}'s test finds the kit`);
  }
  const a = io();
  assert.equal(await main(['new', 'acme.default'], a), 0, a.err);
  assert.ok((await readFile(join(work, 'acme.default', 'renderer.mjs'), 'utf8')).includes("ctx.ui.panel("), 'the panel by default');
  assert.equal(await main(['new', 'acme.other', '--kind', 'widget'], io()), 2);
});

test('dev installs as a dev package, then disables and enables on change', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'cw-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, 'mod.json'), JSON.stringify({ id: 'acme.devmod', version: '0.0.1' }));
  await writeFile(join(work, 'host.mjs'), 'export default 1;\n');
  const ops = new Map();
  let n = 0;
  const mk = (input, patch = {}) => { const id = `op-${String(++n).padStart(16, '0')}`; const o = op({ id, input, outcome: 'succeeded', ...patch }); ops.set(id, o); return { opId: id }; };
  const status = { v: 'enabled' };
  const { io, host } = await withHost(t, {
    'mods.install': (p) => mk({ type: 'install', source: p.source }, { awaiting: 'consent' }),
    'mods.consent': (p) => { status.v = 'enabled'; return mk({ type: 'consent', modId: p.modId }); },
    'mods.disable': (p) => { status.v = 'disabled'; return mk({ type: 'disable', modId: p.modId }); },
    'mods.enable': (p) => { status.v = 'enabled'; return mk({ type: 'enable', modId: p.modId }); },
    'mods.clearQuarantine': (p) => mk({ type: 'clear-quarantine', modId: p.modId }),
    'mods.inspect': () => ({ status: status.v }),
    'ops.get': (p) => ops.get(p.opId),
  });
  const ac = new AbortController();
  const i = io({ cwd: work, signal: ac.signal, debounceMs: 30 });
  const done = main(['dev', '.', '--approve'], i);
  const waitFor = async (pred, what) => { for (let k = 0; k < 200; k++) { if (pred()) return; await new Promise((r) => setTimeout(r, 25)); } assert.fail(`timed out waiting for ${what}`); };
  await waitFor(() => host.calls.some((c) => c.method === 'mods.consent'), 'initial install + approve');
  assert.deepEqual(host.calls.find((c) => c.method === 'mods.install').params, { source: work, dev: true, enable: true });
  assert.deepEqual(host.calls.find((c) => c.method === 'mods.consent').params, { modId: 'acme.devmod', approve: true, enable: true });
  await waitFor(() => /Watching/.test(i.out), 'watcher');
  host.calls.length = 0;

  await writeFile(join(work, 'host.mjs'), 'export default 2;\n');
  await writeFile(join(work, 'host.mjs'), 'export default 3;\n'); // two quick writes → one reload
  await waitFor(() => host.calls.filter((c) => c.method === 'mods.enable').length === 1, 'reload');
  const methods = host.calls.map((c) => c.method).filter((m) => m.startsWith('mods.') && m !== 'mods.inspect');
  assert.deepEqual(methods, ['mods.disable', 'mods.enable']);

  // after a failed reload the mod is disabled; the next change just enables it
  status.v = 'disabled';
  host.calls.length = 0;
  await writeFile(join(work, 'host.mjs'), 'export default 4;\n');
  await waitFor(() => host.calls.some((c) => c.method === 'mods.enable'), 'second reload');
  assert.ok(!host.calls.some((c) => c.method === 'mods.disable'));

  // changes under node_modules are ignored
  await new Promise((r) => setTimeout(r, 300)); // let trailing file-system events settle
  await mkdir(join(work, 'node_modules'), { recursive: true });
  host.calls.length = 0;
  await writeFile(join(work, 'node_modules', 'x.js'), 'x');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(host.calls.length, 0);

  ac.abort();
  assert.equal(await done, 0);
});

test('dev without --approve leaves consent to the user; usage errors', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'cw-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const { io, host } = await withHost(t, {
    'mods.install': () => { state.current = op({ outcome: 'succeeded', awaiting: 'consent' }); return { opId: ID }; },
    'ops.get': () => state.current,
  });
  let a = io({ cwd: work });
  assert.equal(await main(['dev', '.'], a), 2, 'no mod.json');
  await writeFile(join(work, 'mod.json'), JSON.stringify({ id: 'acme.devmod' }));
  const ac = new AbortController();
  a = io({ cwd: work, signal: ac.signal });
  const done = main(['dev', work], a);
  for (let k = 0; k < 100 && !/Watching/.test(a.out); k++) await new Promise((r) => setTimeout(r, 25));
  assert.match(a.out, /Consent required/);
  assert.ok(!host.calls.some((c) => c.method === 'mods.consent'));
  ac.abort();
  assert.equal(await done, 0);
});

test('features: what is not present on the running build, everything with --all, one status with --status (E4)', async (t) => {
  const list = { build: '26.1013.40934-20770', log: { hash: 'abc', reference: [] }, evidence: { census: true, stale: [] },
    features: [{ id: 'graph:Repository.push', kind: 'feature', title: 'the Repository.push operation', version: 1, status: 'missing', because: [{ id: 'service:gitRepository', status: 'missing', why: 'it is not in this build' }], needs: [] },
      { id: 'graph:Thread', kind: 'feature', title: 'the Thread type', version: 1, status: 'present', because: [], needs: [] }],
    mechanics: [{ id: 'service:gitRepository', kind: 'mechanic', title: 'the app\'s gitRepository service', status: 'missing', why: 'it is not in this build', units: [] }] };
  const { io } = await withHost(t, { 'features.list': () => list });
  let a = io();
  assert.equal(await main(['features'], a), 0);
  assert.match(a.out, /^Build 26\.1013\.40934-20770 · log abc · 2 missing, 1 present\n/);
  assert.match(a.out, /graph:Repository\.push\s+missing\s+service:gitRepository: it is not in this build/);
  assert.match(a.out, /service:gitRepository\s+missing\s+it is not in this build/);
  assert.doesNotMatch(a.out, /graph:Thread\s/);
  a = io();
  assert.equal(await main(['features', '--status', 'present'], a), 0);
  assert.match(a.out, /graph:Thread\s+present/);
  a = io();
  assert.equal(await main(['features', '--status', 'gone'], a), 2);
  a = io();
  assert.equal(await main(['features', '--json'], a), 0);
  assert.deepEqual(JSON.parse(a.out), list);
});

test('update: the status, a held plan refused without --anyway, applied with it until the switch (E5)', async (t) => {
  const plan = { hash: 'e'.repeat(32), build: '27.1-101', framework: null, mods: [{ id: 'acme.demo', from: '1.0.0', to: '1.1.0' }], held: true, checked: 'static',
    risks: [{ mod: 'acme.risky', status: 'atRisk', sentences: ['It needs the Select.'] }], consentNeeded: [] };
  const status = { offer: { id: 'x', build: '27.1-101', copyBuild: '27.0-100', framework: null, dismissed: false }, staging: null, problem: null, plan, policy: 'offer', unknown: [] };
  const switching = op({ id: 'op-00000000000000e1', input: { type: 'copy-update', plan: plan.hash, anyway: true }, outcome: 'running', note: 'switching to the new copy; its first healthy boot completes the update' });
  const { io } = await withHost(t, { 'updates.status': () => status, 'updates.apply': () => ({ opId: switching.id }), 'ops.get': () => switching });
  let a = io();
  assert.equal(await main(['update', 'status'], a), 0);
  assert.match(a.out, /Offer: ChatGPT 27\.1-101 \(this copy: 27\.0-100\)/);
  assert.match(a.out, /Plan e{32}: held \(static\)/);
  assert.match(a.out, /at risk: acme\.risky: It needs the Select\./);
  a = io();
  assert.equal(await main(['update', 'apply'], a), 1);
  assert.match(a.err, /The update is held:[\s\S]*--anyway/);
  a = io();
  assert.equal(await main(['update', 'apply', '--anyway'], a), 0);
  assert.match(a.out, /running|switching/);
  assert.equal(await main(['update', 'policy', 'sometimes'], io()), 2);
});
