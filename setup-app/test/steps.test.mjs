// The setup app's steps with the Mac stood in for: what it checks, the order it sets up in and what it refuses, and an uninstall that
// removes the copy and the framework's code only, never what the user made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, readlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSteps, REMOVED, supportedBuilds, backupCodex } from '../steps.mjs';
import { createSetupServer } from '../server.mjs';

const exists = (p) => lstat(p).then(() => true, () => false);

async function world(o = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cm-setup-'));
  const root = join(home, 'root');
  const source = join(home, 'src');
  await mkdir(join(source, 'adapters', '26.1027.30824-22943'), { recursive: true });
  await writeFile(join(source, 'adapters', '26.1027.30824-22943', 'adapter.json'), '{}');
  await mkdir(join(source, 'adapters', '26.1016.62342-21477'), { recursive: true });
  await writeFile(join(source, 'adapters', '26.1016.62342-21477', 'adapter.json'), '{}');
  await writeFile(join(source, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  if (o.codex !== false) { await mkdir(join(home, '.codex'), { recursive: true }); await writeFile(join(home, '.codex', 'config.toml'), 'x'); }
  const seen = { setup: [], dock: [], copies: [], opened: [] };
  let dock = { t: 'dict', v: [['persistent-apps', { t: 'array', v: [] }]] };
  const procs = o.processes ?? [];
  const deps = {
    readBuild: () => (o.build ?? { short: '26.1027.30824', bundle: '22943', build: '26.1027.30824-22943' }),
    identities: async () => o.identities ?? ['Apple Development: Me (TEAM)'],
    processes: async () => procs,
    du: async () => 412e6,
    backup: async (from, base) => { const to = join(base, `codex-test-${seen.copies.length}`); seen.copies.push([from, to]); await mkdir(to, { recursive: true }); return to; },
    readDock: async () => dock,
    // what uninstall needs to put the Dock back is kept before the Dock changes
    writeDock: async (d) => { seen.dock.push(d); seen.recordAtWrite = await readFile(join(root, 'setup.json'), 'utf8').then(JSON.parse, () => null); dock = d; },
    open: async (p) => { seen.opened.push(p); },
    // the setup command, as it leaves the root: the profile, the framework, a copy and the launch path
    setup: o.setup ?? (async (argv, io) => {
      seen.setup.push(argv);
      await io.deps.runBuilder(['build']);
      await mkdir(join(root, 'profiles', 'default', 'data', 'acme.focus'), { recursive: true });
      await writeFile(join(root, 'profiles', 'default', 'profile.json'), JSON.stringify({ codexHome: argv.includes('--daily') ? join(home, '.codex') : join(root, 'profiles', 'default', 'codex-home'), appPath: join(home, 'Applications', 'ChatGPT Mods.app') }));
      await mkdir(join(root, 'framework', '1.2.3', 'framework', 'main'), { recursive: true }); await writeFile(join(root, 'framework', '1.2.3', 'framework', 'main', 'index.cjs'), '');
      await writeFile(join(root, 'framework', 'current'), '1.2.3');
      await mkdir(join(root, 'adapters', '26.1027.30824-22943'), { recursive: true }); await writeFile(join(root, 'adapters', '26.1027.30824-22943', 'adapter.json'), '{}');
      for (const d of ['updates/stock', 'store/acme.focus/1.0.0']) await mkdir(join(root, d), { recursive: true });
      const copy = join(root, 'apps', '26.1027.30824-22943-0123456789abcdef', 'ChatGPT Mods.app');
      await mkdir(copy, { recursive: true });
      await mkdir(join(home, 'Applications'), { recursive: true });
      await symlink(copy, join(home, 'Applications', 'ChatGPT Mods.app')).catch(() => {});
      return 0;
    }),
    runBuilder: async () => ({ tail: '' }),
  };
  const steps = createSteps({ home, env: { CODEX_MODS_ROOT: root }, sourceRoot: source, stockApp: '/Applications/ChatGPT.app', deps, nodeVersion: o.node ?? '24.21.0' });
  return { home, root, steps, seen, procs, dockNow: () => dock, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('check: this ChatGPT and whether a pack supports it, the newest supported, Node, certificates, the Codex data and what runs', async () => {
  const w = await world({ processes: [[11, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'], [12, '/opt/homebrew/bin/codex'], [13, '/bin/zsh']] });
  try {
    const c = await w.steps.check();
    assert.deepEqual(c.stock, { path: '/Applications/ChatGPT.app', found: true, version: '26.1027.30824', bundle: '22943', build: '26.1027.30824-22943', supported: true });
    assert.equal(c.newest, '26.1027.30824');
    assert.deepEqual(c.node, { version: '24.21.0', ok: true });
    assert.deepEqual(c.identities, ['Apple Development: Me (TEAM)']);
    assert.deepEqual(c.codex, { path: join(w.home, '.codex'), exists: true, bytes: 412e6 });
    assert.deepEqual(c.running, { chatgpt: [11], codex: [12], copy: [] });
    assert.equal(c.installed, null);
    assert.match(c.framework, /^1\.2\.3\+[0-9a-f]+$/, 'its version and content');
  } finally { await w.cleanup(); }
  const old = await world({ build: { short: '26.1104.1', bundle: '23510', build: '26.1104.1-23510' }, node: '22.1.0' });
  try {
    const c = await old.steps.check();
    assert.equal(c.stock.supported, false, 'no pack for this build');
    assert.equal(c.node.ok, false);
  } finally { await old.cleanup(); }
  assert.deepEqual(await supportedBuilds('/nowhere'), []);
});

test('everyday use: the backup, the setup command (daily, the certificate), the copy in ChatGPT\'s place, the update policy and the record, in that order', async () => {
  const w = await world();
  try {
    const order = [];
    const out = await w.steps.install({ mode: 'daily', identity: 'Apple Development: Me (TEAM)', backup: true, autoUpdate: true, dock: true }, (id, st) => order.push(`${id}:${st}`));
    assert.deepEqual(order, ['backup:running', 'backup:done', 'framework:running', 'framework:done', 'copy:running', 'copy:done', 'dock:running', 'dock:done', 'updates:running', 'updates:done']);
    assert.deepEqual(w.seen.setup, [['--json', '--daily', '--identity', 'Apple Development: Me (TEAM)']]);
    assert.equal(w.seen.copies.length, 1);
    assert.equal(w.seen.copies[0][0], join(w.home, '.codex'));
    assert.ok(w.seen.copies[0][1].startsWith(join(w.home, 'CodexModsBackup') + '/'));
    assert.equal(out.backup, w.seen.copies[0][1]);
    assert.equal(w.seen.dock.length, 1, 'the Dock written once');
    assert.ok(w.seen.recordAtWrite?.dock, 'the record to put it back was kept first');
    const policy = JSON.parse(await readFile(join(w.root, 'profiles', 'default', 'updates', 'state.json'), 'utf8')).policy;
    assert.equal(policy, 'auto');
    const rec = JSON.parse(await readFile(join(w.root, 'setup.json'), 'utf8'));
    assert.equal(rec.mode, 'daily');
    assert.equal(rec.backup, out.backup);
    assert.ok(await exists(join(w.root, 'setup-dock-before.json')), 'the Dock as it was is kept');
    const again = await w.steps.check();
    assert.equal(again.installed.daily, true);
    assert.equal(again.installed.framework, '1.2.3');
  } finally { await w.cleanup(); }
});

test('refused before anything changes: everyday use without a certificate; a backup or everyday use while ChatGPT or codex runs; anything while the copy runs', async () => {
  const w = await world({ processes: [[11, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT']] });
  try {
    await assert.rejects(w.steps.install({ mode: 'daily', identity: '-', backup: false }), /needs your Apple Development certificate/);
    await assert.rejects(w.steps.install({ mode: 'try', identity: '-', backup: true }), /Quit ChatGPT and any codex sessions first/);
    await assert.rejects(w.steps.install({ mode: 'daily', identity: 'Apple Development: Me (TEAM)', backup: false }), /Quit ChatGPT/);
    assert.deepEqual([w.seen.setup, w.seen.copies, w.seen.dock], [[], [], []]);
    // to try it, without a backup, ChatGPT may stay open
    await w.steps.install({ mode: 'try', identity: '-', backup: false, autoUpdate: null, dock: false });
    assert.deepEqual(w.seen.setup, [['--json', '--try', '--identity', '-']]);
    await w.steps.install({ mode: 'try', identity: 'Apple Development: Me (TEAM)', backup: false, autoUpdate: null, dock: false });
    assert.deepEqual(w.seen.setup[1], ['--json', '--try', '--identity', '-'], 'a copy to try is signed ad hoc, whatever certificate there is: no Keychain prompt');
    assert.deepEqual(w.seen.dock, [], 'not chosen');
    assert.equal(await exists(join(w.root, 'profiles', 'default', 'updates', 'state.json')), false, 'the policy as it is');
    w.procs.push([20, join(w.root, 'apps', '26.1027.30824-22943-0123456789abcdef', 'ChatGPT Mods.app', 'Contents', 'MacOS', 'ChatGPT Mods')]);
    await assert.rejects(w.steps.install({ mode: 'try', identity: '-' }), /Quit ChatGPT Mods first/);
    await assert.rejects(w.steps.uninstall(), /Quit ChatGPT Mods first/);
  } finally { await w.cleanup(); }
});

test('a setup that fails says what the setup command said, at the step it failed in', async () => {
  const w = await world({ setup: async (argv, io) => { await io.deps.runBuilder(['x']); io.stderr.write(JSON.stringify({ error: { code: 'Unavailable', message: 'the builder failed (exit 1): no space' } })); return 1; } });
  try {
    const order = [];
    await assert.rejects(w.steps.install({ mode: 'try', identity: '-' }, (id, st, detail) => order.push([id, st, detail])), /the builder failed \(exit 1\): no space/);
    assert.deepEqual(order.at(-1), ['copy', 'failed', 'the builder failed (exit 1): no space']);
  } finally { await w.cleanup(); }
});

test('uninstall: the Dock put back, the launch path and the framework\'s code gone; the mods, their data, the profile and the backup stay', async () => {
  const w = await world();
  try {
    const before = JSON.parse(JSON.stringify(w.dockNow()));
    const out = await w.steps.install({ mode: 'try', identity: '-', backup: true, autoUpdate: false, dock: true });
    assert.notDeepEqual(w.dockNow(), before);
    await writeFile(join(w.root, 'adapters', 'my-notes.txt'), 'mine');
    await mkdir(join(w.root, 'apps', 'Other.app'), { recursive: true });
    const r = await w.steps.uninstall();
    assert.equal(await readFile(join(w.root, 'adapters', 'my-notes.txt'), 'utf8'), 'mine', 'only what the framework makes goes');
    assert.ok(await exists(join(w.root, 'apps', 'Other.app')));
    await rm(join(w.root, 'adapters'), { recursive: true }); await rm(join(w.root, 'apps'), { recursive: true });
    assert.deepEqual(w.dockNow(), before, 'the Dock as it was');
    assert.equal(await exists(join(w.home, 'Applications', 'ChatGPT Mods.app')), false);
    for (const name of REMOVED) assert.equal(await exists(join(w.root, name)), false, name);
    for (const kept of ['store/acme.focus/1.0.0', 'profiles/default/data/acme.focus', 'profiles/default/profile.json']) assert.ok(await exists(join(w.root, kept)), kept);
    assert.ok(await exists(out.backup), 'the backup');
    assert.ok(await exists(join(w.home, '.codex', 'config.toml')), 'the Codex data');
    assert.equal(r.kept, w.root);
    assert.ok(r.removed.includes(join(w.home, 'Applications', 'ChatGPT Mods.app')));
    assert.equal((await w.steps.check()).installed, null, 'not set up any more');
  } finally { await w.cleanup(); }
});

test('uninstall leaves a launch path that is not a link into the root\'s copies, and refuses a root that is a link or missing', async () => {
  const w = await world();
  try {
    await mkdir(join(w.home, 'Applications'), { recursive: true });
    await mkdir(join(w.home, 'elsewhere', 'X.app'), { recursive: true });
    await symlink(join(w.home, 'elsewhere', 'X.app'), join(w.home, 'Applications', 'ChatGPT Mods.app'));
    await assert.rejects(w.steps.uninstall(), /not set up here/, 'no root yet');
    await mkdir(join(w.root, 'apps'), { recursive: true });
    await assert.rejects(w.steps.uninstall(), /not set up here/, 'a folder Codex Mods did not set up');
    await writeFile(join(w.root, 'setup.json'), '{}');
    await w.steps.uninstall();
    assert.equal(await readlink(join(w.home, 'Applications', 'ChatGPT Mods.app')), join(w.home, 'elsewhere', 'X.app'), 'not ours: left');
    await rm(w.root, { recursive: true });
    await mkdir(join(w.home, 'real-root'));
    await symlink(join(w.home, 'real-root'), w.root);
    await assert.rejects(w.steps.uninstall(), /not set up here/);
  } finally { await w.cleanup(); }
});

test('setup refuses a folder with other files in it that Codex Mods did not set up, before anything changes', async () => {
  const w = await world();
  try {
    await mkdir(join(w.root, 'framework'), { recursive: true });
    await writeFile(join(w.root, 'framework', 'README.md'), 'a project of mine');
    await assert.rejects(w.steps.install({ mode: 'try', identity: '-', backup: true }), /has other files in it/);
    assert.deepEqual([w.seen.setup, w.seen.copies], [[], []]);
  } finally { await w.cleanup(); }
});

test('a backup is a new folder of its own each time, complete, and follows a Codex data folder that is a link', async () => {
  const w = await world({ codex: false });
  try {
    await mkdir(join(w.home, 'elsewhere', 'sessions'), { recursive: true });
    await writeFile(join(w.home, 'elsewhere', 'sessions', 'a.jsonl'), 'chat');
    await symlink(join(w.home, 'elsewhere'), join(w.home, '.codex'));
    const base = join(w.home, 'CodexModsBackup');
    const [a, b] = await Promise.all([backupCodex(join(w.home, '.codex'), base), backupCodex(join(w.home, '.codex'), base)]);
    assert.notEqual(a, b);
    for (const dir of [a, b]) {
      assert.equal((await lstat(dir)).isSymbolicLink(), false);
      assert.equal(await readFile(join(dir, 'sessions', 'a.jsonl'), 'utf8'), 'chat', 'the data, not the link');
    }
  } finally { await w.cleanup(); }
});

test('reveal shows only the root or a backup', async () => {
  const w = await world();
  try {
    await w.steps.reveal(w.root);
    await w.steps.reveal(join(w.home, 'CodexModsBackup', 'codex-20261107-120000'));
    await assert.rejects(w.steps.reveal('/etc/passwd'), /not a path/);
    await assert.rejects(w.steps.reveal(join(w.home, 'CodexModsBackup', '..', '.ssh')), /not a path/);
    assert.equal(w.seen.opened.length, 2);
  } finally { await w.cleanup(); }
});

test('the server: its page for anyone at its own address; its API only with this run\'s token, from its own origin; one job at a time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = { check: async () => ({ ok: 1 }), install: async (choice, onStep) => { onStep('backup', 'running'); await gate; onStep('backup', 'done', 'x'); return { choice }; }, uninstall: async () => ({}), open: async () => {}, reveal: async () => {} };
  const s = createSetupServer({ steps: fake, token: 't'.repeat(48) });
  const url = await s.listen();
  const base = url.split('#')[0].replace(/\/$/, '');
  const host = new URL(base).host;
  const call = (path, o = {}) => fetch(`${base}${path}`, { ...o, headers: { ...(o.headers ?? {}) } });
  try {
    assert.equal(url.split('#')[1], 't'.repeat(48));
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.equal((await call('/api/check')).status, 403, 'no token');
    assert.equal((await call('/api/check', { headers: { 'X-Setup-Token': 'u'.repeat(48) } })).status, 403, 'another token');
    assert.equal((await call('/api/check', { headers: { 'X-Setup-Token': 't'.repeat(48), Origin: 'https://evil.example' } })).status, 403, 'another origin');
    const ok = await call('/api/check', { headers: { 'X-Setup-Token': 't'.repeat(48), Origin: `http://${host}` } });
    assert.deepEqual(await ok.json(), { ok: 1 });
    // a page elsewhere that names this address another way (a rebound name) is not this server
    const { request } = await import('node:http');
    const status = await new Promise((res) => request({ host: '127.0.0.1', port: new URL(base).port, path: '/', headers: { Host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); }).end());
    assert.equal(status, 421);
    const H = { 'X-Setup-Token': 't'.repeat(48), 'Content-Type': 'application/json' };
    const started = await call('/api/install', { method: 'POST', headers: H, body: JSON.stringify({ choice: { mode: 'daily', identity: 'A', backup: true, autoUpdate: 'yes', dock: 1 } }) });
    assert.equal(started.status, 200);
    assert.equal((await call('/api/uninstall', { method: 'POST', headers: H })).status, 409, 'one job at a time');
    release();
    let job;
    for (let i = 0; i < 50; i++) { job = await (await call('/api/job', { headers: H })).json(); if (job.done) break; await new Promise((r) => setTimeout(r, 10)); }
    assert.deepEqual(job.steps, [{ id: 'backup', status: 'done', detail: 'x' }]);
    assert.deepEqual(job.result.choice, { mode: 'daily', identity: 'A', backup: true, autoUpdate: null, dock: false }, 'only what each choice may be');
    assert.equal((await call('/api/nothing', { headers: H })).status, 404);
  } finally { await s.close(); }
});
