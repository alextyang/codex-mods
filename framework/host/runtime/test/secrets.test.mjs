import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { makeHarness, installMod, EVAL_HOST, inWorker } from './helpers.mjs';
import { createKeychain, runSecurity } from '../../ctx/secrets.mjs';
import { publisherFingerprint } from '../../../../contracts/layout.mjs';

const exec = promisify(execFile);
const PREFIX = 'codexmods-test';   // the only service prefix the suite may touch
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

function fakeSecurity() {
  const items = new Map(); const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === '-i') {
      const m = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(input);
      if (!m) return { code: 1, stdout: '', stderr: 'bad line' };
      items.set(`${m[1]}\0${m[2]}`, m[3]); return { code: 0, stdout: '', stderr: '' };
    }
    const get = (flag) => args[args.indexOf(flag) + 1];
    const s = get('-s'), a = args.includes('-a') ? get('-a') : null;
    if (args[0] === 'find-generic-password') { const v = items.get(`${s}\0${a}`); return v === undefined ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: `${v}\n`.trim(), stderr: '' }; }
    if (args[0] === 'delete-generic-password') {
      const key = a === null ? [...items.keys()].find((k) => k.startsWith(`${s}\0`)) : (items.has(`${s}\0${a}`) ? `${s}\0${a}` : undefined);
      if (key === undefined) return { code: 44, stdout: '', stderr: '' }; items.delete(key); return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return { items, calls, run };
}

test('secrets (fake security): service name, stdin-only value, per-publisher isolation, deleteSecrets', async () => {
  const fake = fakeSecurity();
  const h = await makeHarness({ internals: { secretsServicePrefix: PREFIX, securityRun: fake.run } });
  try {
    const grants = ['secrets'];
    const a = await installMod(h.layout, { id: 'test.sec', host: EVAL_HOST, grants, publisher: KEY_A });
    await h.runtime.activate(a);
    const run = (body, args) => inWorker(h.runtime, 'test.sec', body, args);
    const secret = 'sup3r-s3cret-ünï';
    await run(`await ctx.secrets.set('token', args); await ctx.secrets.set('empty', '');`, secret);
    const fp = publisherFingerprint(KEY_A);
    assert.match(fp, /^[0-9a-f]{16}$/);
    const service = `${PREFIX}.default.test.sec.${fp}`;
    assert.deepEqual([...fake.items.keys()].sort(), [`${service}\0empty`, `${service}\0token`]);
    assert.equal(await run(`return await ctx.secrets.get('token');`), secret);
    assert.equal(await run(`return await ctx.secrets.get('empty');`), '');
    assert.equal(await run(`return (await ctx.secrets.get('missing')) === undefined;`), true);
    // the value travelled over stdin, never in argv, and not in the clear
    for (const c of fake.calls) assert.ok(!c.args.join(' ').includes(secret) && !c.args.join(' ').includes('cm1:'), `argv leaked: ${c.args}`);
    const add = fake.calls.find((c) => c.args[0] === '-i');
    assert.deepEqual(add.args, ['-i']);
    assert.ok(add.input.includes(Buffer.from(secret).toString('hex')));
    // overwrite and delete
    await run(`await ctx.secrets.set('token', 'second');`);
    assert.equal(await run(`return await ctx.secrets.get('token');`), 'second');
    await run(`await ctx.secrets.delete('empty'); await ctx.secrets.delete('never-existed');`);
    assert.equal(await run(`return (await ctx.secrets.get('empty')) === undefined;`), true);
    // names are validated (they travel on a command line)
    for (const bad of ['', 'has space', '-flag', 'a\nb', 'x'.repeat(200), '$(id)']) {
      await assert.rejects(inWorker(h.runtime, 'test.sec', `await ctx.secrets.get(args)`, bad), (e) => e.code === 'Invalid', JSON.stringify(bad));
    }
    await assert.rejects(inWorker(h.runtime, 'test.sec', `await ctx.secrets.set('big', 'x'.repeat(5000))`), (e) => e.code === 'Invalid');

    // a replacement publisher (same mod id, different pinned key) has another service and never sees the old secrets
    await h.runtime.deactivate('test.sec', 'replace');
    const b = await installMod(h.layout, { id: 'test.sec', host: EVAL_HOST, grants, publisher: KEY_B });
    await h.runtime.activate(b);
    assert.equal(await run(`return (await ctx.secrets.get('token')) === undefined;`), true);
    await run(`await ctx.secrets.set('token', 'mine');`);
    assert.equal(fake.items.size, 2);
    // developer packages use 'dev'
    await h.runtime.deactivate('test.sec', 'dev');
    const dev = await installMod(h.layout, { id: 'test.sec', host: EVAL_HOST, grants, publisher: null });
    await h.runtime.activate(dev);
    await run(`await ctx.secrets.set('token', 'dev-secret');`);
    assert.ok(fake.items.has(`${PREFIX}.default.test.sec.dev\0token`));
    await h.runtime.deactivate('test.sec', 'done');

    // deleteSecrets removes every account under the (mod, publisher) service and nothing else
    await h.runtime.deleteSecrets('test.sec', publisherFingerprint(KEY_A));
    assert.deepEqual([...fake.items.keys()].map((k) => k.replace('\0', ' ')).sort(),
      [`${PREFIX}.default.test.sec.${publisherFingerprint(KEY_B)} token`, `${PREFIX}.default.test.sec.dev token`].sort());
    await h.runtime.deleteSecrets('test.sec', publisherFingerprint(KEY_B));
    await h.runtime.deleteSecrets('test.sec', 'dev');
    assert.equal(fake.items.size, 0);
  } finally { await h.close(); }
});

test('secrets: Denied without the secrets grant; Keychain failures are Unavailable', async () => {
  const fake = fakeSecurity();
  const h = await makeHarness({ internals: { secretsServicePrefix: PREFIX, securityRun: fake.run } });
  try {
    const m = await installMod(h.layout, { id: 'test.nosec', host: EVAL_HOST });
    await h.runtime.activate(m);
    await assert.rejects(inWorker(h.runtime, 'test.nosec', `await ctx.secrets.get('x')`), (e) => e.code === 'Denied');
    assert.equal(fake.calls.length, 0, 'the Keychain was never touched');
    const k = createKeychain({ servicePrefix: PREFIX, profile: 'default', run: async () => ({ code: 36, stdout: '', stderr: 'User interaction is not allowed' }) });
    await assert.rejects(k.get('test.x', 'dev', 'n'), (e) => e.code === 'Unavailable');
    await assert.rejects(k.set('test.x', 'dev', 'n', 'v'), (e) => e.code === 'Unavailable');
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- the real /usr/bin/security
// The login keychain of the ssh-run UID 503 session is usually locked ("User interaction is not allowed"), so the main
// integration test uses a temporary keychain FILE (created, used and deleted by the test). Every item uses the
// codexmods-test. service prefix.
async function withTempKeychain(fn) {
  const path = `/tmp/cm-test-${process.pid}-${Date.now()}.keychain-db`;
  const sec = (...a) => exec('/usr/bin/security', a);
  await sec('create-keychain', '-p', 'pw', path);
  try {
    await sec('set-keychain-settings', path);
    await sec('unlock-keychain', '-p', 'pw', path);
    const run = (args, input) => (args[0] === '-i'
      ? runSecurity(['-i'], input.replace(/\n$/, ` ${path}\n`))
      : runSecurity([...args, path], input));
    await fn(run, path);
  } finally {
    await sec('delete-keychain', path).catch(() => {});
    await rm(path, { force: true });
  }
}

test('secrets (real /usr/bin/security, temporary keychain): round trip, overwrite, delete, deleteAll', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  await withTempKeychain(async (run) => {
    const k = createKeychain({ servicePrefix: PREFIX, profile: 'default', run });
    const fp = publisherFingerprint(KEY_A);
    await k.set('test.real', fp, 'api-key', 'value with spaces "quotes" $HOME `x` ünï');
    await k.set('test.real', fp, 'empty', '');
    await k.set('test.real', fp, 'other', 'o');
    assert.equal(await k.get('test.real', fp, 'api-key'), 'value with spaces "quotes" $HOME `x` ünï');
    assert.equal(await k.get('test.real', fp, 'empty'), '');
    assert.equal(await k.get('test.real', publisherFingerprint(KEY_B), 'api-key'), undefined, 'another publisher sees nothing');
    assert.equal(await k.get('test.other', fp, 'api-key'), undefined, 'another mod sees nothing');
    await k.set('test.real', fp, 'api-key', 'replaced');
    assert.equal(await k.get('test.real', fp, 'api-key'), 'replaced');
    await k.delete('test.real', fp, 'other');
    assert.equal(await k.get('test.real', fp, 'other'), undefined);
    await k.delete('test.real', fp, 'other'); // deleting a missing item is fine
    await k.deleteAll('test.real', fp);
    assert.equal(await k.get('test.real', fp, 'api-key'), undefined);
    assert.equal(await k.get('test.real', fp, 'empty'), undefined);
    await k.deleteAll('test.real', fp); // nothing left: fine
  });
});

// Opt-in only: it writes (and then deletes) an item in the running user's real login keychain.
test('secrets (real security, default keychain): round trip when the login keychain is unlocked, cleaned up', async (t) => {
  if (process.env.CODEXMODS_TEST_LOGIN_KEYCHAIN !== '1') { t.skip('set CODEXMODS_TEST_LOGIN_KEYCHAIN=1 to use the real login keychain'); return; }
  const k = createKeychain({ servicePrefix: PREFIX, profile: `probe${process.pid}` });
  try {
    try { await k.set('test.login', 'dev', 'probe', 'v'); }
    catch (e) { t.skip(`login keychain not usable in this session: ${e.message}`); return; }
    assert.equal(await k.get('test.login', 'dev', 'probe'), 'v');
  } finally { await k.deleteAll('test.login', 'dev').catch(() => {}); }
});
