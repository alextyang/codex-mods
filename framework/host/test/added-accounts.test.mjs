// The added accounts' homes and record (framework/host/added-accounts.mjs, RM10): a private home with the app's chats and setup linked in
// and its own sign-in only; its backend's definition (file-backed sign-in, the app's sqlite stores, never idle-stopped); where chats run and
// where new chats start, kept and restored; and a removal that deletes the account's home and nothing of the app's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAddedAccounts, sqliteHomeOf, backendIdOf, keyOfBackend, SHARED_DIRS } from '../added-accounts.mjs';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
function fakeMux() {
  const m = { defined: [], removed: [], placed: [], start: null, listeners: new Set() };
  m.api = {
    async defineBackend(owner, key, def) { m.defined.push({ owner, key, def }); },
    async removeBackend(owner, key) { m.removed.push({ owner, key }); },
    place(key, to) { m.placed.push([key, to]); return true; },
    onPlaced(fn) { m.listeners.add(fn); return { dispose() { m.listeners.delete(fn); } }; },
    setStartBackend(id) { m.start = id; },
  };
  m.tell = (c) => { for (const fn of m.listeners) fn(c); };
  return m;
}
function homes(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'added-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appHome = path.join(root, 'codex-home');
  fs.mkdirSync(path.join(appHome, 'sessions', '2026'), { recursive: true });
  fs.writeFileSync(path.join(appHome, 'sessions', '2026', 'rollout.jsonl'), '{}\n');
  fs.mkdirSync(path.join(appHome, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(appHome, 'config.toml'), 'model = "gpt-5.5"\n[projects."/x"]\nsqlite_home = "/nope"\n');
  fs.writeFileSync(path.join(appHome, 'auth.json'), '{"secret":"the app\'s"}');
  fs.writeFileSync(path.join(appHome, 'models_cache.json'), '{}');
  return { root, appHome, dir: path.join(root, 'backends', 'framework') };
}

test('an added account: a private home of its own sign-in, the app\'s chats and setup linked in; its backend\'s definition', async (t) => {
  const { appHome, dir } = homes(t);
  const m = fakeMux();
  const a = createAddedAccounts({ mux: m.api, dir, appHome, log: quiet, env: {} });
  await a.start();
  const { key, backend } = await a.add();
  assert.match(key, /^acct-[0-9a-f]{8}$/);
  assert.equal(backend, backendIdOf(key));
  assert.equal(keyOfBackend(backend), key);
  assert.equal(keyOfBackend('mod:x/acct-12345678'), null);
  const home = a.homeOf(key);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  for (const d of [...SHARED_DIRS, 'skills', 'config.toml', 'AGENTS.md']) assert.equal(fs.lstatSync(path.join(home, d)).isSymbolicLink(), true, `${d} is linked`);
  assert.equal(fs.readlinkSync(path.join(home, 'sessions')), path.join(appHome, 'sessions'));
  assert.ok(fs.existsSync(path.join(appHome, 'archived_sessions')), 'a shared folder the app home lacked is made there');
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false, 'never the app\'s sign-in');
  assert.equal(fs.existsSync(path.join(home, 'models_cache.json')), false, 'nor what is the account\'s own');
  const def = m.defined.at(-1);
  assert.deepEqual([def.owner, def.key], ['framework', key]);
  assert.deepEqual(def.def, { codexHome: path.relative(dir, home), env: { CODEX_SQLITE_HOME: appHome }, config: { cli_auth_credentials_store: 'file' }, idleStopMs: null });
  // a table's sqlite_home is not the top-level key; a top-level one is left to the shared config
  assert.equal(sqliteHomeOf(appHome, {}), appHome);
  assert.equal(sqliteHomeOf(appHome, { CODEX_SQLITE_HOME: '/db' }), '/db');
  fs.writeFileSync(path.join(appHome, 'config.toml'), 'sqlite_home = "/somewhere"\n');
  assert.equal(sqliteHomeOf(appHome, {}), null);
  a.dispose();
});

test('where chats run and where new chats start are kept and restored; a removal deletes the account\'s home only', async (t) => {
  const { appHome, dir } = homes(t);
  const m = fakeMux();
  const a = createAddedAccounts({ mux: m.api, dir, appHome, log: quiet, env: {} });
  await a.start();
  const { key, backend } = await a.add();
  m.tell({ key: 'thr-1', backend });
  m.tell({ key: 'thr-2', backend });
  m.tell({ key: 'thr-2', backend: 'primary' });   // moved back
  m.tell({ key: 'thr-3', backend: 'mod:x/k' });   // not an account's: not kept
  assert.equal(a.placementOf('thr-1'), key);
  assert.equal(a.placementOf('thr-2'), null);
  assert.deepEqual(a.threadsOn(key), ['thr-1']);
  assert.equal(a.setStart('acct-00000000'), false);
  assert.equal(a.setStart(key), true);
  assert.equal(m.start, backend);
  a.dispose();
  // a new Host: the account's backend defined again, its chat placed, new chats starting on it
  const m2 = fakeMux();
  const b = createAddedAccounts({ mux: m2.api, dir, appHome, log: quiet, env: {} });
  await b.start();
  assert.deepEqual(b.list().map((x) => x.key), [key]);
  assert.deepEqual(m2.defined.map((d) => d.key), [key]);
  assert.deepEqual(m2.placed, [['thr-1', backend]]);
  assert.equal(m2.start, backend);
  assert.equal(b.startKey, key);
  // removed: its backend, its record and its home go; the app's chats and setup stay
  assert.equal(await b.remove(key), true);
  assert.deepEqual(m2.removed, [{ owner: 'framework', key }]);
  assert.equal(fs.existsSync(path.join(dir, 'accounts', key)), false);
  assert.ok(fs.existsSync(path.join(appHome, 'sessions', '2026', 'rollout.jsonl')), 'the app\'s chats are untouched');
  assert.ok(fs.existsSync(path.join(appHome, 'skills', 'mine')));
  assert.ok(fs.existsSync(path.join(appHome, 'config.toml')));
  assert.deepEqual([b.list(), b.placementOf('thr-1'), b.startKey], [[], null, null]);
  assert.equal(await b.remove(key), false);
  b.dispose();
});
