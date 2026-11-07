// The object graph plan (docs/graph/) stays consistent: features, type cards, presentation cards and diagrams name each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGraph, GRAPH_DIR, REALIZATION } from '../scripts/graph-check.mjs';

test('docs/graph has no cross-check problems', () => {
  const r = checkGraph();
  assert.deepEqual(r.problems, []);
  assert.ok(r.types.concepts > 0 && r.presentations > 0);
  // The DetailView is the developer inspector, and a Page and a Region are a mod's own: none is a feature of the app (03, "Main views").
  assert.deepEqual(r.unusedPresentations, ['DetailView', 'Region', 'Page']);
});

test('the cross-check reports planted errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-graph-'));
  try {
    cpSync(GRAPH_DIR, dir, { recursive: true });
    const edit = (file, from, to) => {
      const p = join(dir, file);
      const text = readFileSync(p, 'utf8');
      assert.ok(text.includes(from), `${file} contains ${from}`);
      writeFileSync(p, text.replace(from, to));
    };
    edit('02-types.md', 'Subtypes: Approval, Question; mod-defined', 'Subtypes: Approval; mod-defined');
    edit('02-types.md', '· StatusItem · SidePanel', '· StatusItem · SidePanl');
    edit('02-types.md', 'turns: Turn (*) · draft', 'turns: Turnn (*) · draft');
    edit('01-features.md', '| Dictate | Draft | Composer |', '| Dictate | Drafts | Composer |');
    assert.deepEqual(checkGraph(dir).problems.sort(), [
      '01 names unknown type: Drafts',
      '02 Request does not list subtype Question',
      '02 Thread: relation to unknown type Turnn',
      '02 Thread: unknown presentation SidePanl',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the cross-check reports gaps in the realization map', { skip: !existsSync(REALIZATION) && 'this tree has no realization map (a published tree)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-realization-'));
  try {
    const p = join(dir, 'README.md');
    const text = readFileSync(REALIZATION, 'utf8');
    for (const from of ['| Delegation |', '| NotificationBanner, Dialog,']) assert.ok(text.includes(from), `the map contains ${from}`);
    writeFileSync(p, text.replace('| Delegation |', '| Delegaton |').replace(/^\| NotificationBanner, Dialog,/m, '| NotificationBanner,'));
    assert.deepEqual(checkGraph(GRAPH_DIR, p).problems.sort(), [
      'realization has no row for Delegation',
      'realization has no row for Dialog',
      'realization names unknown Delegaton',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
