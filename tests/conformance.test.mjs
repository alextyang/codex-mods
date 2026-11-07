// The conformance mod (scripts/qa/mods/qa.conformance, graph-integrity G9.1), run offline by the testing kit: its own kind of each concept
// the shared surfaces show, listed under the concept as those surfaces list it, and acted on through the graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTestGraph } from '../sdk/testing/index.mjs';

const MOD = fileURLToPath(new URL('../scripts/qa/mods/qa.conformance', import.meta.url));
const KINDS = ['ConfCommandApproval', 'ConfEditApproval', 'ConfNetworkApproval', 'ConfToolApproval', 'ConfComputerUseApproval', 'ConfQuestion'];

test('each concept a shared surface shows lists the mod\'s own kind of it', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  await g.mod(MOD);
  const of = (concept) => g.graph.list(concept).filter((s) => s.ref.provider === 'qa.conformance').map((s) => s.ref.type);
  assert.deepEqual(of('Agent'), ['ConfAgent']);
  assert.deepEqual(of('Thread'), ['ConfThread']);
  assert.deepEqual(of('Automation'), ['ConfAutomation']);
  assert.deepEqual(of('Request').sort(), [...KINDS].sort());
  const [chat] = g.graph.list('Thread');
  assert.equal(g.graph.related(chat.ref, 'agent').state.name, 'Conformance');
  assert.equal(g.graph.related(chat.ref, 'requests').length, KINDS.length);
});

test('the user acts on the mod\'s instances through the graph: a send, an approval, an answer, an automation run', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  await g.mod(MOD);
  const [chat] = g.graph.list('ConfThread');
  const turn = await g.invoke(chat.ref, 'send', [{ parts: [{ kind: 'text', text: 'ping' }] }]);
  assert.equal(turn.status, 'done');
  assert.match(g.graph.related(turn.value, 'answer').state.content.parts[0].text, /ping/);
  const [cmd] = g.graph.list('ConfCommandApproval');
  assert.equal((await g.invoke(cmd.ref, 'answer', ['once'])).status, 'done');
  assert.equal(g.graph.resolve(cmd.ref).state.status, 'answered');
  const [q] = g.graph.list('ConfQuestion');
  assert.equal((await g.invoke(q.ref, 'answer', [{ which: { choices: ['a'] }, token: { text: 's3cret' } }])).status, 'done');
  const [auto] = g.graph.list('ConfAutomation');
  assert.equal((await g.invoke(auto.ref, 'runNow')).status, 'done');
});
