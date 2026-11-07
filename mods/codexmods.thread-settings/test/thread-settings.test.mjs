// codexmods.thread-settings: the skills' convention, the chat's skill settings as contributed Settings, what the agent is told, and the panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parametersOf, declarationOf, contextOf, coerce } from '../host.mjs';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const MOD = 'codexmods.thread-settings';

const PDF = `---
name: pdf-report
description: Build a PDF report from the project's data.
metadata:
  x-codexmods-settings: {
    "version": 1,
    "settings": [
      { "key": "detail", "title": "Detail level", "kind": "choice", "control": "segmented",
        "options": ["brief", "normal", { "value": "thorough", "label": "Thorough" }], "default": "normal" },
      { "key": "charts", "title": "Include charts", "kind": "toggle", "default": true },
      { "key": "maxPages", "title": "Page limit", "kind": "number", "min": 1, "max": 50, "default": 10, "unit": "pages" }
    ]
  }
---
Write the report as the user asks.
`;
const PLAIN = '---\nname: notes\ndescription: Take notes.\n---\nTake notes.\n';

test('a skill declares its parameters in its frontmatter; a skill without the block has none; an invalid one says why', () => {
  const ok = parametersOf(PDF);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.params.map((p) => [p.key, p.kind, p.default]), [['detail', 'choice', 'normal'], ['charts', 'toggle', true], ['maxPages', 'number', 10]]);
  assert.deepEqual(ok.params[0].options.map((o) => o.label), ['brief', 'normal', 'Thorough']);
  assert.deepEqual(parametersOf(PLAIN), { params: [], error: null });
  assert.equal(declarationOf('no frontmatter'), null);
  const bad = (settings) => parametersOf(`---\nname: x\nmetadata:\n  x-codexmods-settings: ${JSON.stringify({ version: 1, settings })}\n---\n`).error;
  assert.match(bad([{ key: 'a', title: 'A', kind: 'color', default: '#000000' }]), /kind is one of/);
  assert.match(bad([{ key: 'a', title: 'A', kind: 'number', min: 1, max: 5, default: 9 }]), /default is not a valid number/);
  assert.match(bad([{ key: 'a', title: 'A', kind: 'toggle', default: true }, { key: 'a', title: 'B', kind: 'toggle', default: false }]), /declared twice/);
  assert.match(bad([{ key: 'enabled', title: 'A', kind: 'toggle', default: true }]), /not "enabled"/);
  assert.match(parametersOf('---\nmetadata:\n  x-codexmods-settings: { "version": 1,\n---\n').error, /not closed/);
  assert.equal(coerce(ok.params[0], 'thorough'), 'thorough');
  assert.equal(coerce(ok.params[2], 51), undefined);
});

test('the agent is told of skills turned off and parameters changed, and nothing while every choice is its default', () => {
  const { params } = parametersOf(PDF);
  const defaults = { enabled: true, detail: 'normal', charts: true, maxPages: 10 };
  assert.equal(contextOf([{ name: 'pdf-report', params, values: defaults }]), null);
  const said = contextOf([{ name: 'pdf-report', params, values: { ...defaults, detail: 'thorough' } }, { name: 'notes', params: [], values: { enabled: false } }]);
  assert.match(said, /Do not use these skills in this chat unless the user names one: notes\./);
  assert.match(said, /- pdf-report: detail = "thorough", charts = true, maxPages = 10\./);
});

/** A test graph with Codex's agent, one chat, and two skills on disk (one declaring parameters). */
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of [['pdf-report', PDF], ['notes', PLAIN]]) { await mkdir(join(dir, name)); await writeFile(join(dir, name, 'SKILL.md'), text); }
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  const chat = agent.thread('t1');
  const skills = g.provider('skills', { Skill: {} });
  const skill = (name) => ({ type: 'Skill', provider: 'skills', id: join(dir, name) });
  for (const name of ['pdf-report', 'notes']) {
    await skills.put(skill(name), { state: { name, description: `The ${name} skill`, scope: 'global', source: 'yours', installed: true, enabled: true } });
  }
  const mod = await g.mod(here);
  return { g, agent, chat, skill, mod, renderer: mod.renderer() };
}
const settingsOf = async (renderer, chat) => (await renderer.graph.related(chat, 'settings')).filter((s) => s.ref.provider === MOD);

test('each skill is a group of the chat\'s settings: its switch and its parameters, defined by the skill; values go to the agent', async (t) => {
  const { agent, chat, skill, renderer } = await setup(t);
  const settings = await settingsOf(renderer, chat);
  const row = (name, key) => settings.find((s) => s.links.definedBy.id === skill(name).id && s.state.key === key);
  assert.deepEqual(settings.map((s) => s.state.key).sort(), ['charts', 'detail', 'enabled', 'enabled', 'maxPages']);
  assert.deepEqual([row('pdf-report', 'detail').state.kind, row('pdf-report', 'detail').state.value, row('pdf-report', 'detail').state.choices.map((c) => [c.id, c.value])],
    ['choice', 'normal', [['brief', 'brief'], ['normal', 'normal'], ['thorough', 'thorough']]]);
  assert.deepEqual([row('notes', 'enabled').state.title, row('notes', 'enabled').state.description], ['notes', 'The notes skill'], 'a skill\'s switch is titled by the skill');
  assert.equal(row('notes', 'enabled').links.thread.id, chat.id);

  // nothing to tell while every choice is its default
  assert.equal((await agent.send('t1', 'hello')).params.additionalContext?.[`mod:${MOD}`], undefined);

  // the user changes a parameter and turns a skill off for this chat
  assert.equal((await renderer.graph.invoke(row('pdf-report', 'detail').ref, 'set', ['thorough'])).status, 'done');
  assert.equal((await renderer.graph.invoke(row('notes', 'enabled').ref, 'set', [false])).status, 'done');
  assert.equal((await renderer.graph.invoke(row('pdf-report', 'maxPages').ref, 'set', [99])).status, 'refused', 'outside its bounds');
  const said = (await agent.send('t1', 'make the report')).params.additionalContext?.[`mod:${MOD}`]?.value;
  assert.match(said, /notes/);
  assert.match(said, /detail = "thorough"/);
  const after = await settingsOf(renderer, chat);
  assert.equal(after.find((s) => s.ref.id === row('pdf-report', 'detail').ref.id).state.overridden, true);

  // back to its default: nothing to tell again
  await renderer.graph.invoke(row('pdf-report', 'detail').ref, 'reset', []);
  await renderer.graph.invoke(row('notes', 'enabled').ref, 'set', [true]);
  assert.equal((await agent.send('t1', 'thanks')).params.additionalContext?.[`mod:${MOD}`], undefined);
});

test('the values are the chat\'s own and survive a restart of the mod', async (t) => {
  const { g, agent, chat, skill, mod, renderer } = await setup(t);
  const other = agent.thread('t2');
  const detail = (await settingsOf(renderer, chat)).find((s) => s.links.definedBy.id === skill('pdf-report').id && s.state.key === 'detail');
  await renderer.graph.invoke(detail.ref, 'set', ['brief']);
  assert.equal((await settingsOf(renderer, other)).find((s) => s.state.key === 'detail').state.value, 'normal', 'another chat keeps its default');
  await mod.stop();
  const again = (await g.mod(here)).renderer();
  assert.equal((await settingsOf(again, chat)).find((s) => s.state.key === 'detail').state.value, 'brief');
  assert.match((await agent.send('t1', 'again')).params.additionalContext?.[`mod:${MOD}`]?.value ?? '', /detail = "brief"/);
});

test('the panel groups a chat\'s settings by what defines them, each drawn with the framework\'s setting row', async (t) => {
  const { chat, mod, renderer } = await setup(t);
  const { control } = createFakeRendererContext({ manifest: mod.manifest, graph: renderer.graph });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  assert.ok(control.panels.has('chat'));
  assert.equal(control.rules.get('open').kind, 'decorate');
  assert.ok(control.commands.has('open'));
  const root = await control.render('chat', { thread: chat });
  await root.until(() => /pdf-report/.test(root.text()) && /notes/.test(root.text()));
  assert.match(root.text(), /Skills/);
  assert.match(root.text(), /Detail level/, 'a skill on for the chat shows its parameters');
  const empty = await control.render('chat', { thread: null });
  assert.match(empty.text(), /Open a chat to see its settings/);
});
