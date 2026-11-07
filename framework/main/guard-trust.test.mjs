import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { listTrusted, trust, untrust } = createRequire(import.meta.url)('./guard-trust.cjs');
const mk = (obj) => { const dir = mkdtempSync(join(tmpdir(), 'cm-gt-')); const f = join(dir, 'profile.json'); writeFileSync(f, JSON.stringify(obj)); return { dir, f }; };

test('list / trust / untrust keep every other profile field and are 1-based', () => {
  const { dir, f } = mk({ codexHome: '/h', guardStockApp: true, signingIdentity: '-', appPath: '/a', launchArgs: ['--x'] });
  try {
    assert.deepEqual(listTrusted(f), []);
    assert.deepEqual(trust(f, ['codex a', 'codex b', 'codex a']), ['codex a', 'codex b'], 'no duplicates');
    assert.deepEqual(listTrusted(f), ['codex a', 'codex b']);
    assert.equal(untrust(f, 1), 'codex a');
    assert.deepEqual(listTrusted(f), ['codex b']);
    const p = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(p.codexHome, '/h'); assert.deepEqual(p.launchArgs, ['--x']); assert.equal(p.signingIdentity, '-');
    for (const bad of [0, 2, -1, 'x', 1.5, undefined]) assert.throws(() => untrust(f, bad), RangeError);
    assert.deepEqual(listTrusted(f), ['codex b'], 'bad indexes change nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable profile is an error for trust/untrust and an empty list for list', () => {
  assert.deepEqual(listTrusted('/nonexistent/profile.json'), []);
  assert.throws(() => trust('/nonexistent/profile.json', ['x']), /cannot read/);
  assert.throws(() => untrust('/nonexistent/profile.json', 1), /cannot read/);
});

test('the file written by the loader (guardTrusted array of strings) is what list reads; non-strings are ignored', () => {
  const { dir, f } = mk({ codexHome: '/h', guardTrusted: ['a', 3, null, 'b'] });
  try { assert.deepEqual(listTrusted(f), ['a', 'b']); } finally { rmSync(dir, { recursive: true, force: true }); }
});
