// The user's intent a page attests for a mod (graph-integrity G7.1, G7.2): minted by the page, taken once by that mod's call from the same
// page, within its time; another mod's, another page's, an expired one or one used already is not taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttestations, ATTEST_MS } from './attestations.mjs';

const TOKEN = (n) => `att-${String(n).padStart(32, '0')}`;

test('G7.2: an attestation is taken once, by its mod, from its page, within its time', () => {
  let t = 1000;
  const a = createAttestations({ now: () => t });
  const page = {}, other = {};
  assert.equal(a.mint(page, TOKEN(1), 'mod.a'), true);
  assert.equal(a.take(page, TOKEN(1), 'mod.a'), null, 'taken');
  assert.match(a.take(page, TOKEN(1), 'mod.a'), /not one this window attested \(or it was used\)/, 'once');
  a.mint(page, TOKEN(2), 'mod.a');
  assert.match(a.take(page, TOKEN(2), 'mod.b'), /another mod/, 'another mod cannot take it');
  assert.match(a.take(page, TOKEN(2), 'mod.a'), /not one/, 'and it is gone with that try');
  a.mint(page, TOKEN(3), 'mod.a');
  assert.match(a.take(other, TOKEN(3), 'mod.a'), /not one/, 'another page has none of this page\'s');
  t += ATTEST_MS + 1;
  assert.match(a.take(page, TOKEN(3), 'mod.a'), /expired/);
  assert.equal(a.mint(page, 'not-a-token', 'mod.a'), false);
  assert.equal(a.mint(null, TOKEN(4), 'mod.a'), false, 'a page\'s channel names it');
});
