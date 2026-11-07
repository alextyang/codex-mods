import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeHarness, installMod } from './helpers.mjs';
import { writeJsonAtomic } from '../../fsutil.mjs';

async function setup(script, { name = 'migrate.mjs', schema } = {}) {
  const h = await makeHarness();
  const mod = await installMod(h.layout, { id: 'test.mig', host: 'export default {};', files: { [name]: script }, settings: schema, data: { schemaVersion: 2, migrate: name } });
  const staged = join(h.root, 'staged');
  await mkdir(join(staged, 'files'), { recursive: true });
  await writeJsonAtomic(join(staged, 'store.json'), { format: 1, data: { count: 1, 'old/key': 'x' } });
  await writeJsonAtomic(join(staged, 'settings.json'), { prompt: 'hi' });
  const run = (timeoutMs = 5000, script2 = name) => h.runtime.runMigration({ mod, script: join(mod.packageDir, script2), stagedDataDir: staged, from: 1, to: 2, timeoutMs });
  return { h, mod, staged, run };
}

test('runMigration: the script gets {from,to,storage,settings,files} over the staged copy and nothing else', async () => {
  const { h, staged, run } = await setup(`
    export async function migrate(input) {
      if (input.from !== 1 || input.to !== 2) throw new Error('bad versions');
      if (JSON.stringify(Object.keys(input).sort()) !== '["files","from","settings","storage","to"]') throw new Error('unexpected keys ' + Object.keys(input));
      await input.storage.set('migrated', true);
      await input.storage.delete('old/key');
      await input.storage.transaction((tx) => tx.set('count', tx.get('count') + 41));
      const s = input.settings.get();
      input.settings.set({ ...s, version: 2, defaulted: s.limit });
      await import('node:fs/promises').then((fs) => fs.writeFile(input.files + '/note.txt', 'moved'));
    }`, { schema: [{ key: 'limit', kind: 'number', title: 'Limit', default: 9 }, { key: 'prompt', kind: 'text', title: 'Prompt', default: 'x' }] });
  try {
    await run();
    assert.deepEqual(JSON.parse(await readFile(join(staged, 'store.json'), 'utf8')).data, { count: 42, migrated: true });
    assert.deepEqual(JSON.parse(await readFile(join(staged, 'settings.json'), 'utf8')), { prompt: 'hi', limit: 9, version: 2, defaulted: 9 });
    assert.equal(await readFile(join(staged, 'files', 'note.txt'), 'utf8'), 'moved');
  } finally { await h.close(); }
});

test('runMigration: a throwing script rejects (the staged data is the Host\'s to discard); a relative script path works', async () => {
  const { h, mod, staged, run } = await setup(`export function migrate() { throw new Error('cannot migrate'); }`);
  try {
    await assert.rejects(run(), (e) => e.code === 'Invalid' && /cannot migrate/.test(e.message));
    await assert.rejects(h.runtime.runMigration({ mod, script: 'migrate.mjs', stagedDataDir: staged, from: 1, to: 2, timeoutMs: 5000 }), /cannot migrate/);
    await assert.rejects(h.runtime.runMigration({ mod, script: '../../../../etc/passwd', stagedDataDir: staged, from: 1, to: 2, timeoutMs: 5000 }), (e) => e.code === 'Invalid');
    await writeFile(join(mod.packageDir, 'nofn.mjs'), 'export const x = 1;');
    await assert.rejects(run(5000, 'nofn.mjs'), /exports no migrate function/);
  } finally { await h.close(); }
});

test('runMigration: a script that never finishes is terminated and rejects Timeout (busy loop and hung promise)', async () => {
  const busy = await setup(`export function migrate() { for (;;) {} }`);
  try {
    const t0 = Date.now();
    await assert.rejects(busy.run(400), (e) => e.code === 'Timeout');
    assert.ok(Date.now() - t0 < 400 + 10000, `rejected after ${Date.now() - t0} ms: the busy worker was terminated, not waited for`);
  } finally { await busy.h.close(); }
  const hung = await setup(`export function migrate() { return new Promise(() => {}); }`);
  try { await assert.rejects(hung.run(300), (e) => e.code === 'Timeout'); } finally { await hung.h.close(); }
});

test('runMigration: resource limits apply (a runaway allocation kills the worker, not the Host)', async () => {
  const { h, run } = await setup(`export function migrate() { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); }`);
  try {
    const before = process.memoryUsage().rss;
    await assert.rejects(run(30000), (e) => e.code === 'Invalid' && /crashed|exited/.test(e.message));
    assert.ok(process.memoryUsage().rss - before < 1500 * 1024 * 1024);
  } finally { await h.close(); }
});

// ARCHITECTURE §8.5 as amended in v1.1: isolation is API-only. This test pins down what that means in practice.
test('runMigration: Node itself is NOT blocked (API-only isolation): child_process is importable and works', async () => {
  const esm = await setup(`
    import { createRequire } from 'node:module';
    export async function migrate({ storage }) {
      // 1. dynamic import of a Node module works
      const cp = await import('node:child_process');
      await storage.set('spawned', cp.execFileSync('/bin/echo', ['from-migration']).toString().trim());
      // 2. so does createRequire
      const require = createRequire(import.meta.url);
      await storage.set('required', typeof require('node:child_process').spawn);
      // 3. the framework itself is simply not handed over
      await storage.set('framework-api', [typeof globalThis.ctx, typeof globalThis.appServer].join());
    }`);
  try {
    await esm.run();
    assert.deepEqual(JSON.parse(await readFile(join(esm.staged, 'store.json'), 'utf8')).data,
      { count: 1, 'old/key': 'x', spawned: 'from-migration', required: 'function', 'framework-api': 'undefined,undefined' });
  } finally { await esm.h.close(); }

  // a bare `require` does not exist in an ES module, so a naive script fails with ReferenceError (it is not a sandbox, just ESM)
  const bare = await setup(`export function migrate() { require('node:child_process'); }`);
  try { await assert.rejects(bare.run(), (e) => /require is not defined/.test(e.message)); } finally { await bare.h.close(); }

  // a CommonJS script (.cjs) does have require, and child_process works there too
  const cjs = await setup(`exports.migrate = async ({ storage }) => { await storage.set('cjs', require('node:child_process').execFileSync('/bin/echo', ['cjs']).toString().trim()); };`, { name: 'migrate.cjs' });
  try {
    await cjs.run();
    assert.equal(JSON.parse(await readFile(join(cjs.staged, 'store.json'), 'utf8')).data.cjs, 'cjs');
  } finally { await cjs.h.close(); }
});
