// codexmods.better-questions: a form from the tool's arguments, answers read back, the iMessage text and reply, and the tool's round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { questionOf, answersOf, textOf, replyAnswers, namespaceOf, INSTRUCTIONS } from '../host.mjs';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../mod.json', import.meta.url), 'utf8'));
const MOD = 'codexmods.better-questions';
const ASK = { title: 'How should I ship it?', message: 'The build is green.', fields: [
  { key: 'channel', title: 'Channel', kind: 'choice', options: ['beta', 'stable'] },
  { key: 'notes', title: 'Release notes', kind: 'toggle' },
  { key: 'count', title: 'How many builds', kind: 'number' },
  { key: 'why', title: 'Anything else', kind: 'text' },
] };

test('a form from the tool\'s arguments: each field a prompt of the framework\'s question card; a bad form says why', () => {
  const { question } = questionOf(ASK);
  assert.deepEqual(question.prompts.map((p) => [p.id, p.kind, p.choices?.map((c) => c.label) ?? null, p.other ?? false]),
    [['channel', 'choice', ['beta', 'stable'], false], ['notes', 'toggle', ['Yes', 'No'], false], ['count', 'number', null, true], ['why', 'text', null, true]]);
  assert.match(questionOf({ title: 'x', fields: [] }).error, /1 to 12 fields/);
  assert.match(questionOf({ title: 'x', fields: [{ key: 'a', title: 'A', kind: 'choice', options: ['one'] }] }).error, /at least two options/);
  assert.match(questionOf({ title: 'x', fields: [{ key: 'a', title: 'A', kind: 'color' }] }).error, /kind is one of/);
});

test('the card\'s answers read back by field, each in its kind', () => {
  const { question } = questionOf(ASK);
  assert.deepEqual(answersOf(question, { channel: { choices: ['2'] }, notes: { choices: ['yes'] }, count: { text: '3' }, why: { text: ' soon ' } }),
    { channel: 'stable', notes: true, count: 3, why: 'soon' });
  assert.deepEqual(answersOf(question, {}), { channel: null, notes: null, count: null, why: null });
});

test('a question as a text, with its code; a reply read back, one answer per line, a number picking a choice', () => {
  const { question } = questionOf(ASK);
  const text = textOf(question, 'AB12');
  assert.match(text, /^Codex asks \(AB12\): How should I ship it\?/);
  assert.match(text, /1\. Channel: 1\) beta {2}2\) stable/);
  assert.deepEqual(answersOf(question, replyAnswers(question, '2\nyes\n4\nship it')), { channel: 'stable', notes: true, count: 4, why: 'ship it' });
  const one = questionOf({ title: 'Pick', fields: [{ key: 'c', title: 'Color', kind: 'choice', options: ['red', 'blue'] }] }).question;
  assert.deepEqual(replyAnswers(one, 'Blue'), { c: { choices: ['2'] } });
});

test('its tool joins each new thread with the instructions; a call waits for the answer given in the view', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  const chat = agent.thread('t1');
  const mod = await g.mod(here);
  const started = await agent.start({ cwd: '/tmp' });
  const ns = started.params.dynamicTools.find((x) => x.name === namespaceOf(MOD));
  assert.deepEqual(ns.tools.map((x) => x.name), ['ask_user']);
  assert.ok(started.params.developerInstructions.includes(INSTRUCTIONS));
  // the agent asks; the user answers in the view
  const asked = agent.call(namespaceOf(MOD), 'ask_user', ASK, { thread: chat, turn: { type: 'CodexTurn', provider: 'codex', id: 'u1' }, call: 'c1' });
  const [q] = await g.waitFor(async () => { const l = await mod.call('questions', 'list'); return l.length ? l : null; }, { what: 'the question kept' });
  assert.equal(q.title, 'How should I ship it?');
  assert.deepEqual((await mod.call('questions', 'answer', { id: q.id, answers: { channel: { choices: ['1'] }, notes: { choices: ['no'] } } })).status, 'done');
  const out = await asked;
  assert.equal(out.status, 'done');
  assert.deepEqual(JSON.parse(out.value).answers, { channel: 'beta', notes: false, count: null, why: null }, 'text, as a tool answers');
  assert.deepEqual(await mod.call('questions', 'list'), [], 'answered: no longer open');
});

test('the Questions view is a panel tab; the iMessage page keeps the key in the Keychain', async (t) => {
  const { control } = createFakeRendererContext({ manifest });
  t.after(() => control.cleanup());
  control.onInvoke(() => ({ status: 'done', value: null }));
  await control.activate(rendererMod);
  assert.ok(control.panels.has('questions'));
  assert.ok(control.pages.has('imessage'));
  assert.deepEqual(manifest.automatic.map((a) => [a.id, a.operation]), [['imessage', 'Thread.send']]);
});
