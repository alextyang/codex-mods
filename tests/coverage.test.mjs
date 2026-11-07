// Coverage accounting (scripts/coverage.mjs; docs/design/breadth.md §3): the ledger names real members with their proofs, nothing is counted
// verified that is not implemented, and the cards' members are read with their tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverage, LEDGER, slotId } from '../scripts/coverage.mjs';

test('the ledger is consistent: real members, proofs that exist, nothing verified that is not implemented', () => {
  const r = coverage();
  assert.deepEqual(r.problems, []);
  assert.equal(r.areas.length, 15, 'F1 to F14 (01) and the framework\'s F15 (07)');
  for (const x of [r.total, ...r.areas]) assert.ok(x.verified <= x.implemented && x.implemented <= x.declared && x.declared <= x.members, JSON.stringify(x));
});

test('members come from the cards, with their sections and tiers', () => {
  const thread = coverage().members.filter((m) => m.card === 'Thread');
  const get = (name, section) => thread.find((m) => m.name === name && m.section === section);
  assert.deepEqual([get('title', 'state').tier, get('preview', 'state').tier, get('turns', 'relations').tier], ['core', 'optional', 'core']);
  assert.deepEqual([get('rename', 'operations').tier, get('fork', 'operations').tier, get('created', 'events').tier], ['core', 'optional', 'core']);
  // Implemented: core state of a type the provider puts, a supported optional member, a handled operation, a linked relation and its inverse.
  assert.deepEqual(['title', 'preview'].map((n) => get(n, 'state').implemented), [true, true]);
  assert.deepEqual([get('rename', 'operations').implemented, get('review', 'operations').implemented], [true, false]);
  assert.deepEqual([get('agent', 'relations').implemented, get('turns', 'relations').implemented, get('terminals', 'relations').implemented], [true, true, true]);
  const delegated = coverage().members.find((m) => m.card === 'Delegation' && m.name === 'agent');
  assert.deepEqual([delegated.tier, delegated.implemented], ['optional', false], 'a relation it does not link');
  // The framework's cards (07) count with its provider's declarations (docs/design/systems.md S3).
  const disable = coverage().members.find((m) => m.card === 'Mod' && m.name === 'disable');
  assert.deepEqual([disable.declared, disable.implemented], [true, true]);
  const behind = coverage().members.find((m) => m.card === 'Branch' && m.name === 'behind' && m.section === 'state');
  assert.deepEqual([behind.tier, behind.implemented], ['optional', false], 'an optional member it does not support');
});

test('presentations: the framework\'s own types, the Presentation concept with the generic operations, slots by the card\'s name (E7.0)', () => {
  const r = coverage();
  const get = (card, name, section) => r.members.find((m) => m.kind === 'presentation' && m.card === card && m.name === name && (!section || m.section === section));
  // A slot's identifier is the card's name in camelCase without "the".
  assert.deepEqual(['trailing actions', 'after the answer', 'above the input', 'toolbar', 'title bar'].map(slotId), ['trailingActions', 'afterAnswer', 'aboveInput', 'toolbar', 'titleBar']);
  assert.ok(get('SidebarItem', 'trailingActions', 'slots'), 'the card\'s slot under its identifier');
  assert.equal(get('SidebarItem', 'badges', 'slots').implemented, true, 'a binding\'s slot of the card\'s name');
  // The framework's own presentations (E6.5) are put by the windows provider: their types count as implemented.
  for (const t of ['SettingsRow', 'Dialog', 'NotificationBanner', 'ComposerPicker', 'DetailView']) assert.equal(get(t, '', 'type').implemented, true, t);
  assert.equal(get('Dialog', '_confirm', 'operations').implemented, true, 'a mod\'s Dialog is settled by the mod that asked (E7.6c)');
  assert.equal(get('DiffView', '_setLayout', 'operations').implemented, false, 'not every operation');
  // The concept counts once: its state, relations and events as the windows provider realizes them, and 03's generic operations.
  assert.deepEqual(['hidden', 'decorations', 'selected', 'expanded', 'order', 'visible'].map((n) => get('Presentation', n, 'state').implemented), [true, true, true, true, false, false], 'order once a binding can tell it');
  assert.deepEqual(['subject', 'parent', 'children'].map((n) => get('Presentation', n, 'relations').implemented), [true, true, true]);
  assert.deepEqual(['_read', 'add', 'decorate', 'replace', 'hide', 'reorder', '_act', 'style', 'host'].map((n) => get('Presentation', n, 'operations')?.implemented), Array(9).fill(true));
  assert.equal(get('Presentation', 'acted', 'events').implemented, true);
  const p = r.members.filter((m) => m.kind === 'presentation');
  assert.equal(r.presentations.members, p.length);
  assert.equal(r.presentations.implemented, p.filter((m) => m.implemented).length);
});

test('investment tiers (graph-layers.md §4): every card has one; a presentation\'s instance members and `_` members are mechanism', () => {
  const r = coverage();
  const get = (card, name, section) => r.members.find((m) => m.card === card && m.name === name && (!section || m.section === section));
  assert.deepEqual([get('Thread', 'rename', 'operations').invest, get('ChangeSet', 'apply', 'operations').invest], ['supported', 'asBuilt']);
  assert.deepEqual([get('Composer', '', 'type').invest, get('Composer', 'toolbar', 'slots').invest, get('Composer', '_insert', 'operations').invest], ['supported', 'supported', 'mechanism'], 'a component and its slots are declared into; its instances\' operations are mechanism');
  assert.equal(get('Window', 'open', 'operations').invest, 'supported', 'the Window is addressable');
  assert.deepEqual(['decorate', 'host', '_read', '_act'].map((n) => get('Presentation', n, 'operations').invest), ['supported', 'supported', 'mechanism', 'mechanism']);
  assert.deepEqual([get('DiffView', '', 'type').invest, get('Step', '_expand', 'operations').invest, get('Model', '_select', 'operations').invest], ['mechanism', 'mechanism', 'mechanism']);
  const t = r.total;
  assert.equal(t.supported.members + t.asBuilt.members + t.mechanism, t.members);
});

test('the checks report a planted error of each kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-coverage-'));
  try {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
    ledger.verified.push(
      { member: 'Thread.nosuch', build: 'b', date: '2026-10-23', proof: 'docs/design/breadth.md' },
      { member: 'Thread.review', build: 'b', date: '2026-10-23', proof: 'docs/design/breadth.md' },
      { member: 'Turn', build: 'b', date: 'yesterday', proof: 'docs/nope.md' },
    );
    ledger.excluded.push({ member: 'Terminal' }, { member: 'Nope.x', reason: 'r' });
    const file = join(dir, 'verified.json');
    writeFileSync(file, JSON.stringify(ledger));
    const problems = coverage({ ledger: file }).problems;
    for (const re of [/unknown member: Thread\.nosuch/, /verified but not implemented: Thread\.review/, /Turn: needs build, date and proof/, /excluded Terminal: needs a reason/, /excluded names an unknown member: Nope\.x/]) {
      assert.ok(problems.some((p) => re.test(p)), `${re} in ${problems.join('; ')}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('graph-integrity G9.3: the native provider declares unverified exactly what it realizes that no census or ledger entry shows', async () => {
  const { unverifiedNative } = await import('../scripts/coverage.mjs');
  const { UNVERIFIED } = await import('../framework/host/graph/providers/codex/unverified.mjs');
  assert.deepEqual(JSON.parse(JSON.stringify(UNVERIFIED)), unverifiedNative(),
    'regenerate framework/host/graph/providers/codex/unverified.mjs from `node scripts/coverage.mjs --unverified` (a native check verified something, or the provider realizes more)');
});
