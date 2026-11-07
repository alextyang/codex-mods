// The round-trip axis (graph-integrity G9.2): a row per lent part and per shared surface's concept, each well formed, and every concept the
// conformance mod gives its own kind of checked by some surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problems, lentNames, conformanceConcepts } from '../scripts/roundtrip.mjs';

test('the round-trip ledger agrees with the lent parts and the conformance mod, and its rows are well formed', () => {
  assert.ok(lentNames().length >= 14, 'the lent parts are read');
  assert.ok(conformanceConcepts().includes('Thread') && conformanceConcepts().includes('Question'), 'the conformance mod\'s concepts are read');
  assert.deepEqual(problems(), []);
});
