// The protocol-plane report (graph-integrity G8.1): every mod's appServer.* use is in the ledger with its gap and part, or is low-level by intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problems, ledger } from '../scripts/protocol-plane.mjs';

test('the ledger and the manifests agree on every protocol-plane use', () => {
  assert.deepEqual(problems(), []);
});

test('a gap is closed by one of the plan\'s parts', () => {
  for (const [id, kinds] of Object.entries(ledger())) {
    for (const [kind, e] of Object.entries(kinds)) if (e.closedBy) assert.match(e.closedBy, /^GI[0-9][ab]?$/, `${id} ${kind}`);
  }
});
