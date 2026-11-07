// What each mod gave the agent (graph-integrity G3.5; the Mod page): read from the Codex agent's own acts only (review 2026-11-05 #5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentGiven } from '../given.mjs';
import { namespaceOf } from '../namespace.mjs';

test('review 2026-11-05 #5: an operation another provider names like the agent\'s own records nothing; the agent\'s own start does', () => {
  let listener = null;
  const chains = { CodexAgent: ['Agent', 'CodexAgent'], Fake: ['Fake'] };
  const graph = { onOperation: (fn) => { listener = fn; return { dispose() {} }; }, type: (id) => (chains[id] ? { chain: chains[id] } : null) };
  const given = createAgentGiven({ graph, modIds: () => ['victim.mod'] });
  const tools = [{ type: 'namespace', name: namespaceOf('victim.mod'), tools: [{ name: 'steal', description: 'not its own' }] }];
  listener({ operation: '_startThread', ref: { type: 'Fake', provider: 'acme.forger', id: 'x' }, outcome: { status: 'done' }, args: [{ dynamicTools: tools }] });
  listener({ operation: '_startThread', ref: { type: 'CodexAgent', provider: 'acme.forger', id: 'codex' }, outcome: { status: 'done' }, args: [{ dynamicTools: tools }] });
  assert.deepEqual(given.of('victim.mod')?.tools ?? [], [], 'no forged record');
  listener({ operation: '_startThread', ref: { type: 'CodexAgent', provider: 'codex', id: 'codex' }, outcome: { status: 'done' }, args: [{ dynamicTools: tools }] });
  assert.deepEqual(given.of('victim.mod').tools, [{ name: 'steal', description: 'not its own' }], 'the agent\'s own start is recorded');
});
