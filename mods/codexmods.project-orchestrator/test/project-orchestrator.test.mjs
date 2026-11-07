// codexmods.project-orchestrator: a chat's change as an update, the orchestrator's context; and on the offline agent, its start with its
// instructions and tools (that start only), each of its turns carrying the project's chats and what changed, its tools answering only it,
// a finished chat told to it while its automatic action is on, and its grill-me skill among the session's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changeOf, contextOf, namespaceOf, inFolder, INSTRUCTIONS, KICKOFF } from '../host.mjs';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../mod.json', import.meta.url), 'utf8'));
const NS = namespaceOf('codexmods.project-orchestrator');
const chat = (id, status, extra = {}) => ({ ref: { type: 'CodexThread', provider: 'codex', id }, state: { title: `Chat ${id}`, status, ...extra }, links: {} });

test('a chat\'s change as an update; the orchestrator\'s context; a folder in a project\'s', () => {
  assert.equal(changeOf(chat('a', 'idle'), chat('a', 'working')), '"Chat a" started working');
  assert.equal(changeOf(chat('a', 'working'), chat('a', 'idle', { preview: 'Done: tests pass' })), '"Chat a" finished: Done: tests pass');
  assert.equal(changeOf(chat('a', 'working'), chat('a', 'waitingForYou', { waitingOn: 'approval' })), '"Chat a" is waiting for the user (approval)');
  assert.equal(changeOf(chat('a', 'idle'), chat('a', 'idle')), null);
  const c = contextOf(['"Chat a" finished'], [chat('b', 'working', { preview: 'Refactoring' })]);
  assert.match(c, /^Since your last message:\n- "Chat a" finished\n\nThe project's other chats now:\n- "Chat b" \(b\): working: Refactoring$/);
  assert.match(contextOf([], []), /no other chats/);
  assert.equal(NS, 'mod_codexmods_project-orchestrator');
  assert.deepEqual([inFolder('/p/x', '/p'), inFolder('/p', '/p'), inFolder('/px', '/p')], [true, true, false]);
});

test('an orchestrator: its start gets its instructions and tools; its turns the project\'s chats; its tools answer it only', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  const app = g.provider('projects', { Project: {} });
  const project = { type: 'Project', provider: 'projects', id: 'p1' };
  await app.put(project, { state: { name: 'Repo', location: '/repos/app' }, links: {} });
  const mod = await g.mod(here);
  // a start the user did not ask for as an orchestrator: nothing of it
  const plain = await agent.start({ cwd: '/repos/app' });
  assert.equal(plain.params.dynamicTools?.some((x) => x.name === NS) ?? false, false);
  // the renderer's acts around the user's "New project orchestrator"
  const r = mod.renderer();
  const ready = await r.services.call(mod.id, 'orchestrator', 'prepare', { project });
  assert.deepEqual([ready.ok, ready.prompt], [true, KICKOFF]);
  const started = await agent.start({ cwd: '/repos/app/sub' });
  assert.ok(started.params.developerInstructions.includes(INSTRUCTIONS));
  assert.deepEqual(started.params.dynamicTools.find((x) => x.name === NS).tools.map((x) => x.name), ['project_chats', 'chat_read', 'chat_message', 'chat_new']);
  const again = await agent.start({ cwd: '/repos/app' });
  assert.equal(again.params.dynamicTools?.some((x) => x.name === NS) ?? false, false, 'that start only');
  const orch = agent.thread('orch', { cwd: '/repos/app' });
  const worker = agent.thread('w1', { cwd: '/repos/app', title: 'Fix login', status: 'idle' });
  agent.thread('elsewhere', { cwd: '/other', title: 'Not this project' });
  assert.deepEqual(await r.services.call(mod.id, 'orchestrator', 'adopt', { thread: orch, project }), { ok: true });
  assert.deepEqual(g.graph.attachments.viewFor(mod.id, orch)?.[mod.id], { role: 'orchestrator' }, 'its role on the chat');
  // a worker chat starts and finishes: the orchestrator's next turn hears of it, with the project's chats now
  await g.waitFor(async () => ((await mod.call('orchestrator', 'list')).length === 1 ? true : null), { what: 'adopted' });
  // (a chat's states come seconds apart; here, each once the mod's view has had it)
  const pause = () => new Promise((r) => setTimeout(r, 300));
  await pause();
  agent.thread('w1', { cwd: '/repos/app', title: 'Fix login', status: 'working' });
  await pause();
  agent.thread('w1', { cwd: '/repos/app', title: 'Fix login', status: 'idle', preview: 'Login fixed' });
  await pause();
  const sent = await g.waitFor(async () => {
    const out = await agent.send('orch', 'What is going on?');
    const said = out.params?.additionalContext?.[`mod:${mod.id}`]?.value;
    return said && said.includes('finished') ? said : null;
  }, { what: 'the update in its context' });
  assert.match(sent, /"Fix login" started working/);
  assert.match(sent, /"Fix login" finished: Login fixed/);
  assert.match(sent, /"Fix login" \(w1\): idle/);
  assert.doesNotMatch(sent, /Not this project/);
  // its tools: the project's chats for it; refused to another chat
  const listed = await agent.call(NS, 'project_chats', {}, { thread: orch });
  assert.equal(listed.status, 'done');
  assert.deepEqual(JSON.parse(listed.value).map((x) => x.id), ['w1']);
  assert.equal((await agent.call(NS, 'project_chats', {}, { thread: worker })).status, 'refused');
});

test('its grill-me skill among the session\'s skills; its menu entry and badge', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const agent = g.agent();
  await g.mod(here);
  // none set yet: it sets its own at its start
  await g.waitFor(() => (agent.sent.some(([m, p]) => m === 'skills/extraRoots/set' && p.extraRoots.some((r) => r.endsWith('/codexmods.project-orchestrator/skills'))) ? true : null), { what: 'its roots set' });
  const set = await agent.setRoots(['/home/skills']);
  assert.ok(set.params.some((r) => r.endsWith('/codexmods.project-orchestrator/skills')), 'its skills folder joins the roots');
  assert.ok(fs.existsSync(new URL('../skills/grill-me/SKILL.md', import.meta.url)));
  const { control } = createFakeRendererContext({ manifest });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  const badge = control.rules.get('role');
  assert.deepEqual([badge.kind, badge.target, badge.spec.where], ['decorate', 'Thread', { '@codexmods.project-orchestrator/role': 'orchestrator' }]);
  assert.deepEqual(manifest.automatic.map((a) => [a.id, a.operation]), [['update', 'Thread.send']]);
});
