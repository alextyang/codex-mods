// codexmods.smart-composer: the review read leniently, the effort among the model's, the continuation as a suggestion, the answers written
// into the message; and with a stand-in for mod intelligence, a send stopped for its questions then sent with its answers, and a message's
// effort set as the review chose while the chat keeps its model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewOf, effortFor, REVIEW } from '../host.mjs';
import rendererMod, { completionOf, clarified, COMPLETE } from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../mod.json', import.meta.url), 'utf8'));
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });

test('the review read leniently; the effort among those the model offers', () => {
  assert.deepEqual(reviewOf('Sure: {"questions": ["Which file?", " "], "effort": "high", "size": "large"} done'), { questions: ['Which file?'], effort: 'high', size: 'large' });
  assert.deepEqual(reviewOf('no json'), { questions: [], effort: null, size: null });
  assert.deepEqual(reviewOf('{"questions": ["a","b","c","d"], "effort": "extreme"}').questions.length, 3);
  assert.equal(effortFor('high', ['low', 'medium', 'high']), 'high');
  assert.equal(effortFor('xhigh', ['low', 'medium', 'high']), 'high', 'the nearest it offers');
  assert.equal(effortFor('low', ['medium', 'xhigh']), 'medium');
  assert.equal(effortFor('high', []), null);
});

test('a continuation as a suggestion: one line, no quotes, spaced as the text needs; the answers written into the message', () => {
  assert.equal(completionOf('"the parser module."\nmore', 'Write a test for'), ' the parser module.');
  assert.equal(completionOf('the parser', 'Write a test for '), 'the parser');
  assert.equal(completionOf('.', 'Done'), '.');
  assert.equal(completionOf('  ', 'x'), null);
  assert.equal(completionOf('for', 'Write a test for'), null, 'only what was typed');
  assert.equal(clarified('Fix it', ['Which bug?', 'Which file?'], { q0: { text: 'the crash' }, q1: { text: ' ' } }), 'Fix it\n\nAnswers to questions about this request:\n- Which bug? the crash');
  assert.equal(clarified('Fix it', ['Which bug?'], {}), 'Fix it');
});

/** A stand-in for mod intelligence (its `model` service): the review's JSON for a review, words for a continuation. */
function standIn(t, review) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-intel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id: 'codexmods.intelligence', version: '1.0.0', name: 'Stand-in', framework: '>=1 <2', entry: { host: 'host.mjs' }, permissions: [] }));
  fs.writeFileSync(path.join(dir, 'host.mjs'), `
export default { host(ctx) {
  const asked = [];
  ctx.services.provide('model', {
    start(args, { caller }) {
      asked.push({ caller, instructions: args.instructions, prompt: args.prompt });
      const answer = args.instructions === ${JSON.stringify(REVIEW)} ? ${JSON.stringify(JSON.stringify(review))} : 'the parser';
      setTimeout(() => { ctx.services.call(caller.id, args.service, 'done', { text: answer, usage: { tokens: 10 } }).catch(() => {}); }, 5);
      return { status: 'started', id: String(asked.length) };
    },
    status: () => ({ enabled: true }),
  });
  ctx.services.provide('seen', { asked: () => asked });
} };`);
  return dir;
}

test('a send is stopped for its questions; answered, the message goes with the answers, as the user\'s', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const sends = [];
  const chats = g.agent();
  chats.thread('t1');
  const app = g.provider('codex-drafts', { Draft: { operations: {
    send: { effect: 'external', handler: ({ ref }) => { sends.push(ref.id); return null; } },
    setContent: ({ ref, args: [content] }) => { app.update(ref, { state: { content } }); return null; },
  } } });
  const draft = { type: 'Draft', provider: 'codex-drafts', id: 'd1' };
  await app.put(draft, { state: { content: text('Fix the bug'), dictating: false }, links: { thread: { type: 'CodexThread', provider: 'codex', id: 't1' } } });
  const fresh = { type: 'Draft', provider: 'codex-drafts', id: 'new' };
  await app.put(fresh, { state: { content: text('Fix the bug'), dictating: false }, links: {} });
  const intel = await g.mod(standIn(t, { questions: ['Which bug?'], effort: 'medium' }));
  const mod = await g.mod(here);
  // clarifying is off by default: the send goes
  assert.equal((await g.invoke(draft, 'send', [])).status, 'done');
  assert.deepEqual(sends, ['d1']);
  // on: stopped quietly, its questions kept for the composer
  const r = mod.renderer();
  await r.settings.set('clarify', true);
  await g.waitFor(async () => ((await mod.call('clarify', 'get', { draft: 'd1' })) === null ? true : null), { what: 'nothing waiting yet' });
  const stopped = await g.invoke(draft, 'send', []);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(sends, ['d1']);
  const q = await mod.call('clarify', 'get', { draft: 'd1' });
  assert.deepEqual(q, { text: 'Fix the bug', questions: ['Which bug?'] });
  assert.ok((await intel.call('seen', 'asked')).some((a) => a.caller.id === mod.id && a.prompt === 'Fix the bug'), 'asked as the mod');
  // the message is what the send names (the composer's text as it is then), not the Draft's content saved a moment later
  assert.equal((await g.invoke(draft, 'send', [{ content: text('Fix the crash on save') }])).status, 'stopped');
  assert.equal((await mod.call('clarify', 'get', { draft: 'd1' })).text, 'Fix the crash on save');
  // the user's send from its own question card goes as they chose it
  const viaCard = await g.invoke(draft, 'send', [], { as: { kind: 'user', id: 'user', owner: 'app', through: mod.id } });
  assert.equal(viaCard.status, 'done', viaCard.message);
  assert.deepEqual(sends, ['d1', 'd1']);
  sends.pop();
  // a new chat's first message goes as it is (the app makes the chat as it is sent: a stop would leave an empty chat)
  assert.equal((await g.invoke(fresh, 'send', [])).status, 'done');
  assert.deepEqual(sends, ['d1', 'new']);
  sends.pop();
  // answered (the renderer's acts): the answered text goes as it is
  const answered = clarified(q.text, q.questions, { q0: { text: 'the crash on save' } });
  await mod.call('clarify', 'clear', { draft: 'd1', text: answered });
  await g.invoke(draft, 'setContent', [text(answered)]);
  assert.equal((await g.invoke(draft, 'send', [])).status, 'done');
  assert.deepEqual(sends, ['d1', 'd1']);
  assert.equal(await mod.call('clarify', 'get', { draft: 'd1' }), null);
});

test('a message\'s effort as the review chose, among the model\'s; the chat keeps its model', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  const models = g.provider('models', { Model: {} });
  const model = { type: 'Model', provider: 'models', id: 'gpt-x' };
  await models.put(model, { state: { name: 'X', description: 'A model', efforts: ['low', 'medium', 'high'].map((id) => ({ id, label: id })), default: true, available: true }, links: { agent: agent.ref } });
  agent.thread('t1', {}, { model });
  await g.mod(standIn(t, { questions: [], effort: 'xhigh', size: 'small' }));
  const mod = await g.mod(here);
  // off until the user turns its automatic action on: the message goes as it is, never asking
  const before = await agent.send('t1', 'Redesign the storage layer');
  assert.deepEqual(before.params, {});
  g.automatic(mod.id, 'effort');
  const out = await agent.send('t1', 'Redesign the storage layer');
  assert.ok(out.params, JSON.stringify(out));
  assert.deepEqual(out.params.settings, { effort: 'high' }, 'xhigh asked, high the nearest the model offers; no model change');
});

test('its renderer offers a suggestion source and the questions above the composer', async (t) => {
  const { control } = createFakeRendererContext({ manifest });
  t.after(() => control.cleanup());
  control.intelligence.answer((spec) => (spec.instructions === COMPLETE ? 'the parser' : ''));
  await control.activate(rendererMod);
  const suggest = control.rules.get('complete');
  assert.deepEqual([suggest.kind, suggest.spec.debounceMs, suggest.spec.minChars], ['composer.suggest', 700, 12]);
  const questions = control.rules.get('questions');
  assert.deepEqual([questions.kind, questions.spec.place], ['composer.control', 'aboveInput']);
  // its source asks Luna and gives the continuation, spaced as the text needs
  assert.equal(await suggest.spec.provide({ before: 'Write a test for', after: '' }), ' the parser');
  assert.deepEqual(control.intelligence.asks().map((a) => [a.prompt, a.instructions === COMPLETE]), [['Write a test for', true]]);
});
