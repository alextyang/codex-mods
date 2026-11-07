// Generator contract: mandatory isolation edits are all-or-nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, MandatoryEditsMissing, mandatoryEditIds, deriveFrameworkPatches } from './generate-adapter.mjs';

const ARGS = ['--app', '/x/App.app', '--schema', '/x/schema', '--authored', fileURLToPath(new URL('../26.1007.30912-20156/authored.json', import.meta.url)), '--out', '/x/adapter.json', '--report', '/x/report.json'];
const io = () => { const writes = []; const out = []; const err = []; return { writes, out, err, deps: { write: (f, t) => writes.push([f, t]), log: (m) => out.push(m), error: (m) => err.push(m) } }; };

test('main refuses (exit 1, no pack file) when any mandatory isolation edit could not be derived, and names each one', async () => {
  for (const item of ['binaryPatches:keychain-service-name', 'binaryPatches:cua-container:SkyComputerUseService', 'transform:cua-container', 'transform:managed-config-no-persist', 'backend.configOverrides']) {
    const t = io();
    const code = await main(ARGS, { ...t.deps, generateFn: async () => { throw new MandatoryEditsMissing([{ item, mandatory: true, tried: 'pattern not found exactly twice' }]); } });
    assert.equal(code, 1, item);
    assert.ok(!t.writes.some(([f]) => f === '/x/adapter.json'), `${item}: the pack must not be written`);
    assert.ok(t.err.some((l) => l.includes(item) && l.includes('MANDATORY')), item);
  }
});

test('main writes the pack and exits 0 when generation succeeds; usage errors exit 2; unexpected errors propagate', async () => {
  const t = io();
  const pack = { transforms: [{ id: 'cua-relocate-dir' }], binaryPatches: [{ id: 'keychain-service-name' }], components: {}, mandatoryEdits: ['cua-relocate-dir', 'keychain-service-name'] };
  assert.equal(await main(ARGS, { ...t.deps, generateFn: async () => ({ pack, missing: [{ item: 'component:Select' }], evidence: {}, why: {}, asarHeaderSha256: 'h' }) }), 0);
  assert.equal(t.writes.filter(([f]) => f === '/x/adapter.json').length, 1);
  assert.equal(JSON.parse(t.writes.find(([f]) => f === '/x/adapter.json')[1]).mandatoryEdits.length, 2);
  assert.equal(await main(['--app', 'x'], io().deps), 2);
  await assert.rejects(main(ARGS, { ...io().deps, generateFn: async () => { throw new Error('disk on fire'); } }), /disk on fire/);
});

test('a non-mandatory miss (Select) does not block; mandatoryEditIds lists the cua-* transforms and every binary patch', () => {
  const ids = mandatoryEditIds([{ id: 'expose-components:app-shared' }, { id: 'cua-relocate-dir' }, { id: 'cua-bundle-id:worker.js:1' }, { id: 'managed-config-no-persist' }, { id: 'trusted-view-sender' }], [{ id: 'keychain-service-name' }, { id: 'aura-fallback-service' }, { id: 'cua-container:bin/node_repl:1' }]);
  assert.deepEqual(ids, ['cua-relocate-dir', 'cua-bundle-id:worker.js:1', 'managed-config-no-persist', 'keychain-service-name', 'aura-fallback-service', 'cua-container:bin/node_repl:1']);
});

test('deriveFrameworkPatches reports a mandatory miss (and no patches) for a framework that does not carry the Owl name code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-gen-'));
  try {
    const fw = join(dir, 'Contents', 'Frameworks', 'Other.framework', 'Versions', '1');
    mkdirSync(fw, { recursive: true });
    symlinkSync('1', join(dir, 'Contents', 'Frameworks', 'Other.framework', 'Versions', 'Current'));
    const b = Buffer.alloc(256); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4);
    writeFileSync(join(fw, 'Other'), b);
    const r = deriveFrameworkPatches(dir);
    assert.deepEqual(r.patches, []);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].mandatory, true);
    assert.match(r.missing[0].item, /keychain-service-name/);
    const none = deriveFrameworkPatches(join(dir, 'nothing'));
    assert.equal(none.missing[0].mandatory, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
