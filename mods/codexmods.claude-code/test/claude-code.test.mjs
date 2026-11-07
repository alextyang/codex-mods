// codexmods.claude-code: Claude Code's tool calls as steps and approvals, its input lines, and its chats run as real sessions of a stand-in
// `claude` (fake-claude.mjs, which speaks stream-json as Claude Code does): the answer streaming, an approval asked and answered, Stop,
// the session going on (`--resume`) with the model chosen, a session's place given up when as many run as the manifest allows, and its
// chats kept over a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepOf, diffOf, requestOf, userLine, answerLine, interruptLine, BASE_ARGS } from '../host.mjs';
import rendererMod from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });
const said = (c) => (c?.parts ?? []).map((p) => p.text ?? '').join('');

/** A folder with a `claude` that runs the stand-in, a project folder, and the stand-in's log of its starts. */
function place(t, { instances } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claude-')));
  const bin = path.join(root, 'bin'), work = path.join(root, 'work'), log = path.join(root, 'starts.log');
  fs.mkdirSync(bin); fs.mkdirSync(work);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  let dir = here;
  if (instances !== undefined) {
    // the mod as it is, but declaring fewer instances of its session
    dir = path.join(root, 'mod');
    fs.cpSync(here, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}test`) });
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
    m.processes.claude.instances = instances;
    fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(m));
  }
  const before = process.env.FAKE_CLAUDE_LOG;
  process.env.FAKE_CLAUDE_LOG = log;
  t.after(() => { if (before === undefined) delete process.env.FAKE_CLAUDE_LOG; else process.env.FAKE_CLAUDE_LOG = before; fs.rmSync(root, { recursive: true, force: true }); });
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, work, path: `${bin}:/usr/bin:/bin`, starts };
}
/** A graph with the mod running, a project at `work` and its new chat's draft. */
async function running(t, p) {
  const g = await createTestGraph({ path: p.path });
  t.after(() => g.close());
  const app = g.provider('app', { Project: {}, Draft: {} });
  const project = { type: 'Project', provider: 'app', id: 'p1' }, draft = { type: 'Draft', provider: 'app', id: 'd1' };
  await app.put(project, { state: { name: 'work', location: p.work }, links: {} });
  await app.put(draft, { state: { content: text(''), dictating: false, target: { project, settings: {} } }, links: {} });
  const mod = await g.mod(p.dir);
  const [agent] = g.graph.list('ClaudeAgent');
  const chat = async () => { const out = await g.invoke(agent.ref, 'newThread', [draft]); assert.equal(out.status, 'done', out.message); return out.value; };
  // a chat takes a message once it is idle again (its last turn's end, then the chat's)
  const send = async (c, words) => {
    await g.waitFor(() => (g.graph.resolve(c)?.state.status === 'idle' ? true : null), { what: 'the chat idle' });
    const out = await g.invoke(c, 'send', [text(words)]);
    assert.equal(out.status, 'done', out.message ?? out.error?.message);
    return out.value;
  };
  const ended = (turn, what) => g.waitFor(() => (g.graph.resolve(turn)?.state.status !== 'running' ? g.graph.resolve(turn) : null), { what });
  return { g, mod, agent, project, chat, send, ended };
}

test('a tool call as a step: a command in its folder, an edit with its diff, another tool by what it names', () => {
  assert.deepEqual(stepOf('Bash', { command: 'ls -la', description: 'List the folder' }, '/w'),
    { type: 'CommandRun', state: { title: 'List the folder', command: 'ls -la', directory: '/w', output: '' } });
  const edit = stepOf('Edit', { file_path: '/w/a.txt', old_string: 'x', new_string: 'y' }, '/w');
  assert.equal(edit.type, 'ClaudeEdit');
  assert.equal(edit.state.title, 'Edited a.txt');
  assert.equal(edit.state.diff, '--- a//w/a.txt\n+++ b//w/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y');
  assert.equal(stepOf('Write', { file_path: '/w/new.md', content: 'hi' }, '/w').state.title, 'Wrote new.md');
  assert.equal(diffOf('MultiEdit', { file_path: '/w/b', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).diff.split('@@').length, 5);
  assert.deepEqual(stepOf('Grep', { pattern: 'TODO' }, '/w'), { type: 'ClaudeTool', state: { title: 'Grep TODO', tool: 'Grep' } });
});

test('an approval by its tool: a command\'s, an edit\'s file, another tool\'s input; the lines Claude Code reads', () => {
  assert.deepEqual(requestOf('Bash', { command: 'rm x' }, '/w'), { type: 'CommandApproval', state: { command: 'rm x', directory: '/w' } });
  assert.deepEqual(requestOf('Write', { file_path: '/w/n.txt', content: '' }, '/w'), { type: 'EditApproval', state: { files: [{ path: '/w/n.txt', change: 'add' }] } });
  assert.deepEqual(requestOf('Edit', { file_path: '/w/n.txt' }, '/w').state.files[0].change, 'update');
  assert.deepEqual(requestOf('WebFetch', { url: 'https://example.com' }, '/w'), { type: 'ToolApproval', state: { input: text('{"url":"https://example.com"}') } });
  assert.deepEqual(JSON.parse(userLine('hi')), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual(JSON.parse(answerLine('r1', true, { a: 1 })).response, { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { a: 1 } } });
  assert.equal(JSON.parse(answerLine('r1', false)).response.response.behavior, 'deny');
  assert.deepEqual(JSON.parse(interruptLine('s1')), { type: 'control_request', request_id: 's1', request: { subtype: 'interrupt' } });
  assert.ok(BASE_ARGS.includes('--permission-prompt-tool') && !BASE_ARGS.includes('--permission-mode'), 'its approvals come to the chat; the user\'s own permission mode applies');
});

test('a chat is a Claude Code session in its project\'s folder: the answer streams in, a command runs once allowed, the next message goes on in the session', async (t) => {
  const p = place(t);
  const { g, agent, project, chat, send, ended } = await running(t, p);
  assert.equal(agent.state.name, 'Claude Code');
  assert.deepEqual(g.graph.related(agent.ref, 'models').map((m) => m.ref.id).sort(), ['haiku', 'opus', 'sonnet']);
  const c = await chat();
  assert.deepEqual(g.graph.resolve(c).links.project, project);
  assert.equal(g.graph.resolve(c).state.cwd, p.work);
  const bySpec = await g.invoke(agent.ref, 'newThread', [{ project }]);
  assert.equal(g.graph.resolve(bySpec.value).state.cwd, p.work, 'or a spec naming the project');

  const first = await send(c, 'hello there');
  assert.equal((await ended(first, 'the first turn')).state.status, 'completed');
  const answer = g.graph.related(first, 'answer');
  assert.deepEqual([said(answer.state.content), answer.state.streaming], ['Hello from sonnet', false]);
  assert.deepEqual(g.graph.related(first, 'steps').map((s) => [s.ref.type, said(s.state.thinking)]), [['Reasoning', 'A greeting.']]);
  assert.deepEqual(g.graph.related(first, 'input').map((m) => said(m.state.content)), ['hello there']);
  await g.waitFor(() => g.graph.resolve(c).state.status === 'idle', { what: 'the chat idle' });
  const st = g.graph.resolve(c).state;
  assert.equal(st.title, 'hello there');
  assert.equal(st.unread, true);
  assert.match(st.sessionId, /^[0-9a-f-]{36}$/);

  const second = await send(c, 'please run it');
  const ask = await g.waitFor(() => g.graph.list('CommandApproval', { status: 'pending' })[0], { what: 'the approval' });
  assert.deepEqual([ask.state.command, ask.state.directory, ask.state.reason], ['echo hi', p.work, 'Claude Code wants to use Bash: Say hi']);
  assert.deepEqual(ask.links.turn, second);
  assert.equal(g.graph.resolve(c).state.status, 'waitingForYou');
  assert.equal((await g.invoke(ask.ref, 'answer', ['once'])).status, 'done');
  assert.equal((await ended(second, 'the second turn')).state.status, 'completed');
  const [run] = g.graph.related(second, 'steps');
  assert.deepEqual([run.ref.type, run.state.status, run.state.output, run.state.directory], ['CommandRun', 'done', 'hi', p.work]);
  assert.equal(said(g.graph.related(second, 'answer').state.content), 'Ran it.');
  const answered = g.graph.resolve(ask.ref).state;
  assert.deepEqual([answered.status, answered.outcome, answered.answeredBy.kind], ['answered', { decision: 'approved', scope: 'once', option: 'once' }, 'user']);

  const starts = p.starts();
  assert.equal(starts.length, 1, 'one session for both messages');
  assert.equal(starts[0].cwd, p.work);
  assert.deepEqual(starts[0].args.slice(starts[0].args.indexOf('--model'), starts[0].args.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.equal(starts[0].args[starts[0].args.indexOf('--session-id') + 1], st.sessionId);
});

test('Stop ends the turn stopped (Claude Code ends after an interrupt); the next message resumes the session with the model chosen', async (t) => {
  const p = place(t);
  const { g, chat, send, ended } = await running(t, p);
  const c = await chat();
  const turn = await send(c, 'count for me');
  await g.waitFor(() => g.graph.related(turn, 'answer'), { what: 'the answer streaming' });
  assert.equal((await g.invoke(c, 'stop', [])).status, 'done');
  const stopped = await ended(turn, 'the stopped turn');
  assert.deepEqual([stopped.state.status, stopped.state.stoppedBy?.kind], ['stopped', 'user']);
  await g.waitFor(() => g.graph.resolve(c).state.status === 'idle', { what: 'the chat idle' });
  const sid = g.graph.resolve(c).state.sessionId;

  const model = (id) => ({ type: 'Model', provider: 'codexmods.claude-code', id });
  const chose = await g.invoke(c, 'setModel', [model('opus')]);
  assert.equal(chose.status, 'done', chose.message);
  assert.equal(g.graph.resolve(c).links.model.id, 'opus');
  assert.equal((await g.invoke(c, 'setModel', [model('gpt')])).status, 'refused');
  const next = await send(c, 'hello again');
  assert.equal((await ended(next, 'the next turn')).state.status, 'completed');
  assert.equal(said(g.graph.related(next, 'answer').state.content), 'Hello from opus');
  const [, again] = p.starts();
  assert.equal(again.args[again.args.indexOf('--resume') + 1], sid, 'the same session goes on');
  assert.equal(again.args[again.args.indexOf('--model') + 1], 'opus');
});

test('an edit allowed for the chat is not asked again; a command not allowed is not run', async (t) => {
  const p = place(t);
  const { g, chat, send, ended } = await running(t, p);
  const c = await chat();
  const first = await send(c, 'edit the notes');
  const ask = await g.waitFor(() => g.graph.list('EditApproval', { status: 'pending' })[0], { what: 'the edit\'s approval' });
  assert.deepEqual(ask.state.files, [{ path: path.join(p.work, 'notes.txt'), change: 'update' }]);
  assert.deepEqual(ask.state.options.map((o) => o.id), ['once', 'thread', 'deny']);
  await g.invoke(ask.ref, 'answer', ['thread']);
  await ended(first, 'the edit');
  const [edit] = g.graph.related(first, 'steps');
  assert.deepEqual([edit.ref.type, edit.state.title, edit.state.status], ['ClaudeEdit', 'Edited notes.txt', 'done']);
  assert.match(edit.state.diff, /^-old line\n\+new line$/m);

  const second = await send(c, 'edit it again');
  assert.equal((await ended(second, 'the second edit, not asked')).state.status, 'completed');
  assert.equal(g.graph.list('EditApproval').length, 1);

  const third = await send(c, 'run something');
  const cmd = await g.waitFor(() => g.graph.list('CommandApproval', { status: 'pending' })[0], { what: 'the command\'s approval' });
  await g.invoke(cmd.ref, 'answer', ['deny']);
  await ended(third, 'the denied command');
  const [run] = g.graph.related(third, 'steps');
  assert.deepEqual([run.state.status, g.graph.resolve(cmd.ref).state.status], ['failed', 'declined']);
  assert.equal(said(g.graph.related(third, 'answer').state.content), 'Not run.');
});

test('as many sessions run as the manifest declares: the one idle longest gives its place, and its chat resumes it', async (t) => {
  const p = place(t, { instances: 1 });
  const { g, chat, send, ended } = await running(t, p);
  const [a, b] = [await chat(), await chat()];
  await ended(await send(a, 'hello'), 'a\'s turn');
  await ended(await send(b, 'hello'), 'b\'s turn');
  const back = await send(a, 'hello again');
  assert.equal((await ended(back, 'a\'s turn again')).state.status, 'completed');
  const starts = p.starts();
  assert.equal(starts.length, 3);
  assert.equal(starts[2].args[starts[2].args.indexOf('--resume') + 1], g.graph.resolve(a).state.sessionId);
});

test('its chats are kept: after a restart they are there, and go on in their sessions', async (t) => {
  const p = place(t);
  const { g, mod, chat, send, ended } = await running(t, p);
  const c = await chat();
  await ended(await send(c, 'hello'), 'the turn');
  await g.waitFor(() => g.graph.resolve(c).state.status === 'idle', { what: 'idle' });
  const sid = g.graph.resolve(c).state.sessionId;
  await mod.stop();
  assert.equal(g.graph.list('ClaudeThread').length, 0);
  await g.mod(p.dir);
  const [kept] = g.graph.list('ClaudeThread');
  assert.deepEqual([kept.ref.id, kept.state.sessionId, kept.state.title], [c.id, sid, 'hello']);
  assert.equal(g.graph.related(kept.ref, 'turns').length, 1);
  const next = await g.invoke(kept.ref, 'send', [text('hello again')]);
  assert.equal((await ended(next.value, 'the turn after')).state.status, 'completed');
  assert.ok(p.starts().at(-1).args.includes(sid));
});

test('its chats open to its own view, drawn with the parts the framework lends; shown, a chat is read', async (t) => {
  const p = place(t);
  const { g, mod, chat, send, ended } = await running(t, p);
  const c = await chat();
  await ended(await send(c, 'please run it').then(async (turn) => {
    const ask = await g.waitFor(() => g.graph.list('CommandApproval', { status: 'pending' })[0], { what: 'the approval' });
    await g.invoke(ask.ref, 'answer', ['once']);
    return turn;
  }), 'the turn');
  await g.waitFor(() => g.graph.resolve(c).state.unread === true, { what: 'unread' });
  const { control } = createFakeRendererContext({ manifest: mod.manifest, graph: mod.renderer().graph });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  const view = control.rules.get('view');
  assert.deepEqual([view.kind, view.target, view.spec.for], ['replace', 'ThreadView', 'ClaudeThread']);
  const root = await control.render('view', { subject: g.graph.resolve(c) });
  await root.until(() => /Ran it\./.test(root.text()) && /please run it/.test(root.text()) && /Say hi/.test(root.text()));
  await g.waitFor(() => g.graph.resolve(c).state.unread === false, { what: 'read once shown' });
  // its command starts a chat in the project of the window's new chat
  assert.equal(control.commands.get('new').spec.title, 'New Claude Code chat');
  await control.runCommand('new', { draft: { type: 'Draft', provider: 'app', id: 'd1' }, window: null, asUser: undefined });
  const made = await g.waitFor(() => g.graph.list('ClaudeThread').find((x) => x.ref.id !== c.id), { what: 'the new chat' });
  assert.deepEqual([made.state.cwd, made.links.project?.id], [p.work, 'p1']);
});
