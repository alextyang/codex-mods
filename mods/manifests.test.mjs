// Structural checks on every mod package (and the SDK's starters) against contracts/manifest.d.ts and the entry
// rules of ARCHITECTURE §7: single-file ESM entries, a default-exported definition with the declared realms, and a
// manifest the Host's own validator takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGrants } from '../sdk/testing/core.mjs';
import { validateManifest } from '../framework/host/packages/manifest.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const maintained = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('codexmods.')).map((d) => path.join(root, d.name));
// the SDK's starters (graph-integrity G8.3): what `codexmods new` makes a mod from
const templates = path.join(root, '..', 'sdk', 'templates');
const starters = fs.readdirSync(templates, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(templates, d.name));
const packages = [...maintained, ...starters];
const EXPECTED = ['codexmods.account-switcher', 'codexmods.better-questions', 'codexmods.claude-code', 'codexmods.live-usage', 'codexmods.multi-panel', 'codexmods.project-orchestrator', 'codexmods.smart-composer', 'codexmods.thread-settings', 'codexmods.ui-tweaks'];

test('the SDK has its four starters', () => {
  assert.deepEqual(starters.map((p) => path.basename(p)).sort(), ['agent', 'contribution', 'panel', 'rule']);
});

test('exactly the maintained mods exist and the retired ones do not', () => {
  const names = maintained.map((p) => path.basename(p)).sort();
  assert.deepEqual(names, [...EXPECTED].sort());
  assert.equal(fs.existsSync(path.join(root, 'codexmods.mod-manager')), false);
  assert.equal(fs.existsSync(path.join(root, 'codexmods.update-guardian')), false);
});

for (const dir of packages) {
  const name = path.relative(path.join(root, '..'), dir);
  test(`${name}: manifest, entries and README satisfy the package rules`, async () => {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
    assert.match(m.id, /^[a-z0-9][a-z0-9.-]{2,127}$/);
    assert.match(m.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    assert.ok(m.name && m.framework === '>=1 <2');
    assert.equal(m.publisher, undefined, 'unsigned developer package');
    if (name.startsWith('mods')) { assert.equal(m.id, path.basename(dir)); assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md'); }
    assert.ok(m.entry.host || m.entry.renderer);
    for (const group of [m.requires, m.optional]) for (const [k, v] of Object.entries(group ?? {})) {
      assert.ok(['methods', 'anchors', 'components', 'actions'].includes(k), `unknown requires/optional key ${k}`);
      assert.ok(Array.isArray(v) && v.every((x) => typeof x === 'string'));
    }
    parseGrants(m.permissions ?? []);                    // throws on an unknown permission
    assert.deepEqual(validateManifest(m), m, 'the Host\'s own check, its settings too');
    for (const [realm, rel] of Object.entries(m.entry)) {
      const file = path.join(dir, rel);
      const src = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(src, /^\s*import[^'"]*['"]\.{1,2}\//m, `${rel}: relative imports (entries are single-file)`);
      assert.doesNotMatch(src, /^\s*(?:import|export)\b[^;\n]*\sfrom\s+['"](?!node:)/m, `${rel}: only node: built-ins may be imported`);
      assert.doesNotMatch(src, /legacy\//, `${rel}: no reference to legacy`);
      const def = (await import(pathToFileURL(file).href)).default;
      assert.equal(typeof def[realm], 'function', `${rel} default export has ${realm}()`);
    }
    if (m.entry.renderer) assert.doesNotMatch(fs.readFileSync(path.join(dir, m.entry.renderer), 'utf8'), /node:/, 'renderer entries run in the page: no node: imports');
    if (m.permissions?.includes('ui')) assert.ok(m.entry.renderer, 'the ui permission needs a renderer entry');
  });
}

test('the Recommended catalog lists every maintained mod once, with its own name, description and glyph', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '..', 'framework', 'catalog.json'), 'utf8'));
  assert.match(catalog.repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
  assert.deepEqual(catalog.mods.map((m) => m.id).sort(), [...EXPECTED].sort());
  for (const m of catalog.mods) {
    const own = JSON.parse(fs.readFileSync(path.join(root, m.id, 'mod.json'), 'utf8'));
    assert.deepEqual({ name: m.name, description: m.description, glyph: m.glyph }, { name: own.name, description: own.description, glyph: own.glyph }, m.id);
  }
});
