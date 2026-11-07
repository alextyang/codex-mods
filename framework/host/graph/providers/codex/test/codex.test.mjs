// Contract tests of the native protocol source (docs/design/runtime-core.md R10, R11): the real mux, the strict fake app-server (modelled
// methods, and the C0 captures replayed), the graph runtime and the codex source. Headless; no model traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraph } from '../../../index.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, tokenUsage as tokenUsageOf } from '../map.mjs';
import { REALIZES } from '../realizes.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, fakeLaunch, makeApp, until, sleep } from '../../../../mux/test/helpers.mjs';
import { loadCapture, replayEnv, newestBuild } from '../../../../../../tests/fixtures/captures.mjs';
import { frameIssues } from '../../../../../../tests/fixtures/schema-check.mjs';

const NATIVE = NATIVE_TYPES.map(toDescriptor);
const user = { kind: 'user', id: 'user' };
const CAPTURES = fileURLToPath(new URL('../../../../../../tests/fixtures/captures/', import.meta.url));

async function setup(o = {}) {
  const h = await harness(o.harness);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-'));
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), ...(o.approvals ? { approvals: o.approvals } : {}), ...(o.automaticOf ? { automaticOf: o.automaticOf } : {}) });
  graph.registerTypes(NATIVE, 'native');
  if (!o.noUp) await h.up();
  const source = createCodexSource({ graph, mux: o.mux?.(h.mux) ?? h.mux, bus: h.bus, pageSize: 2 });
  return {
    h, graph, source, dir,
    async close() { await source.dispose(); graph.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const thread = (g, id) => g.resolve(refs.thread(id));
const model = (g, id) => g.resolve(refs.model(id));
/** A protocol Model with every field the schema requires. */
const protocolModel = (id, o = {}) => ({
  id, model: id, displayName: o.displayName ?? id, description: o.description ?? '', hidden: o.hidden ?? false, isDefault: o.isDefault ?? false,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: (o.efforts ?? ['medium']).map((reasoningEffort) => ({ reasoningEffort, description: '' })),
});

test('codex source: threads the app starts appear from its frames; start() reads every page and marks the collection complete', async () => {
  const s = await setup();
  try {
    const t1 = (await s.h.app.request(1, 'thread/start', { cwd: '/tmp/a' })).result.thread.id;
    await until(() => thread(s.graph, t1), 5000, 'the app\'s thread appears');
    assert.equal(thread(s.graph, t1).ref.type, 'CodexThread');
    assert.equal(s.graph.isComplete('Thread'), false, 'not complete before the list is read');
    for (let i = 2; i <= 5; i++) await s.h.app.request(i, 'thread/start', {});
    await s.source.start();
    assert.equal(s.graph.list('Thread').length, 5);
    assert.equal(s.graph.isComplete('Thread'), true, 'complete after every page (page size 2)');
    const st = thread(s.graph, t1).state;
    assert.deepEqual([st.status, st.archived, st.origin, st.unread], ['idle', false, 'user', false]);
  } finally { await s.close(); }
});

test('codex source: a live turn is a Turn of its thread; observing the thread loads its history (turns, messages)', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.h.app.request(2, 'turn/start', { threadId: t, input: [{ type: 'text', text: 'hello', text_elements: [] }] });
    await until(() => s.graph.related(refs.thread(t), 'turns')?.length === 1 && s.graph.related(refs.thread(t), 'turns')[0].state.status === 'completed', 5000, 'the turn completes');
    const got = [];
    s.graph.subscribe({ ref: refs.thread(t), relation: 'turns' }, (m) => got.push(m));
    const turn = s.graph.related(refs.thread(t), 'turns')[0];
    await until(() => s.graph.related(turn.ref, 'input')?.length === 1, 5000, 'history loaded on observe');
    assert.equal(s.graph.related(turn.ref, 'input')[0].state.content.parts[0].text, 'hello');
    assert.ok(s.graph.list('AgentMessage').some((m) => m.state.content.parts[0].text === 'abc'));
  } finally { await s.close(); }
});

test('codex source: streaming text updates an agent message, coalesced; its completion as a final answer becomes the turn\'s answer', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const n = (method, params, id) => s.h.app.request(id, 'fake/notify', { method, params });
    await n('turn/started', { threadId: t, turn: { id: 'u1', items: [], status: 'inProgress', startedAt: 1, completedAt: null, error: null } }, 2);
    await n('item/started', { threadId: t, turnId: 'u1', startedAtMs: 1000, item: { type: 'agentMessage', id: 'm1', text: '', phase: 'final_answer' } }, 3);
    for (const [i, d] of ['Hel', 'lo'].entries()) await n('item/agentMessage/delta', { threadId: t, turnId: 'u1', itemId: 'm1', delta: d }, 10 + i);
    const r = refs.item('AgentMessage', t, 'm1');
    await until(() => s.graph.resolve(r)?.state.content.parts[0].text === 'Hello', 5000, 'streamed text');
    assert.equal(s.graph.resolve(r).state.streaming, true);
    await n('item/completed', { threadId: t, turnId: 'u1', item: { type: 'agentMessage', id: 'm1', text: 'Hello!', phase: 'final_answer' } }, 20);
    await until(() => s.graph.resolve(r)?.state.streaming === false, 5000, 'completed');
    assert.equal(s.graph.resolve(r).state.phase, 'final');
    assert.equal(s.graph.related(refs.turn('u1'), 'answer').ref.id, r.id);
  } finally { await s.close(); }
});

test('codex source: Thread.waitingOn follows the status: a question, an approval (first), then nothing once it works again', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await until(() => thread(s.graph, t), 5000, 'thread');
    const n = (status, id) => s.h.app.request(id, 'fake/notify', { method: 'thread/status/changed', params: { threadId: t, status } });
    const at = () => [thread(s.graph, t).state.status, thread(s.graph, t).state.waitingOn];
    await n({ type: 'active', activeFlags: ['waitingOnUserInput'] }, 2);
    await until(() => at()[1] === 'question', 5000, 'a question');
    assert.deepEqual(at(), ['waitingForYou', 'question']);
    await n({ type: 'active', activeFlags: ['waitingOnUserInput', 'waitingOnApproval'] }, 3);
    await until(() => at()[1] === 'approval', 5000, 'an approval');
    await n({ type: 'active', activeFlags: [] }, 4);
    await until(() => at()[0] === 'working', 5000, 'working');
    assert.deepEqual(at(), ['working', undefined]);
  } finally { await s.close(); }
});

test('codex source: Thread.rename, setGoal and clearGoal go through the one path: claimed in the journal, reflected from the protocol', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await until(() => thread(s.graph, t), 5000, 'thread');
    const r = await s.graph.invoke({ ref: refs.thread(t), operation: 'rename', args: ['Renamed'], caller: user, origin: 'test' });
    assert.equal(r.status, 'done');
    assert.ok(r.intent, 'an external effect is claimed');
    await until(() => thread(s.graph, t).state.title === 'Renamed', 5000, 'title from thread/name/updated');
    assert.match(fs.readFileSync(path.join(s.dir, 'intents.jsonl'), 'utf8'), new RegExp(`"id":"${r.intent}","phase":"done"`));
    assert.ok(s.graph.can(refs.thread(t), 'setGoal'));
    assert.equal((await s.graph.invoke({ ref: refs.thread(t), operation: 'setGoal', args: ['Ship C2'], caller: user })).status, 'done');
    await until(() => thread(s.graph, t).state.goal?.objective === 'Ship C2', 5000, 'goal');
    assert.equal(thread(s.graph, t).state.goal.status, 'active');
    assert.equal((await s.graph.invoke({ ref: refs.thread(t), operation: 'clearGoal', args: [], caller: user })).status, 'done');
    await until(() => thread(s.graph, t).state.goal === undefined, 5000, 'goal cleared');
    const review = await s.graph.invoke({ ref: refs.thread(t), operation: 'review', args: [{ type: 'Branch', provider: 'codex', id: 'p:main' }], caller: user });
    assert.equal(review.status, 'refused', 'review comes with D7');
    // The provider handles exactly the operations its declaration says (coverage counts from it); markRead and markUnread need a read
    // state and moveTo the app's projects, absent here.
    const NEEDS_APP = ['markRead', 'markUnread', 'moveTo'];
    const declared = REALIZES.operations.Thread.filter((op) => !NEEDS_APP.includes(op));
    for (const op of Object.keys(NATIVE_TYPES.find((d) => d.id === 'Thread').spec.operations)) {
      if (NEEDS_APP.includes(op)) continue;
      assert.equal(s.graph.can(refs.thread(t), op), declared.includes(op), `can ${op}`);
    }
  } finally { await s.close(); }
});

test('codex source: a command approval is a pending CommandApproval; the app\'s answer declines it; one resolved elsewhere is cancelled', async () => {
  const s = await setup();
  const events = [];
  s.graph.onEvent((e) => { if (e.kind === 'event') events.push(e); });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const params = { threadId: t, turnId: 'u1', itemId: 'exec-1', startedAtMs: 5000, command: 'touch x', cwd: '/tmp', reason: 'May I?' };
    s.h.app.send({ id: 2, method: 'fake/serverRequest', params: { method: 'item/commandExecution/requestApproval', params } });
    const ask = await s.h.app.waitFor((m) => m.method === 'item/commandExecution/requestApproval', 5000);
    await until(() => s.graph.list('CommandApproval').length === 1, 5000, 'request');
    const req = s.graph.list('CommandApproval')[0];
    assert.deepEqual([req.state.status, req.state.command, req.state.directory, req.state.reason, req.state.askedAt], ['pending', 'touch x', '/tmp', 'May I?', 5000]);
    assert.equal(s.graph.related(refs.thread(t), 'requests').length, 1);
    s.h.app.send({ id: ask.id, result: { decision: 'decline' } });
    await until(() => s.graph.resolve(req.ref).state.status === 'declined', 5000, 'declined');
    // Named events: the request was opened (and its thread says so), then answered.
    assert.deepEqual(events.filter((e) => e.ref.id === req.ref.id).map((e) => e.name), ['opened', 'answered']);
    assert.deepEqual(events.filter((e) => e.name === 'requestOpened').map((e) => [e.ref.id, e.payload.id]), [[t, req.ref.id]]);
    // Resolved by the backend without an answer (an interrupt): cancelled.
    s.h.app.send({ id: 3, method: 'fake/serverRequest', params: { method: 'item/commandExecution/requestApproval', params: { ...params, itemId: 'exec-2' } } });
    await s.h.app.waitFor((m) => m.method === 'item/commandExecution/requestApproval' && m.params.itemId === 'exec-2', 5000);
    await until(() => s.graph.list('CommandApproval').length === 2, 5000, 'second request');
    await s.h.app.request(4, 'fake/notify', { method: 'serverRequest/resolved', params: { threadId: t, requestId: 'srv-2' } });
    await until(() => s.graph.list('CommandApproval', { status: 'cancelled' }).length === 1, 5000, 'cancelled');
    assert.equal(events.at(-1).name, 'cancelled');
  } finally { await s.close(); }
});

test('codex source: turn/plan/updated is the turn\'s task list, replaced wholesale; tasksChanged on each update', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.h.app.request(2, 'turn/start', { threadId: t, input: [{ type: 'text', text: 'plan', text_elements: [] }] });
    const [turn] = await until(() => (s.graph.related(refs.thread(t), 'turns')?.length ? s.graph.related(refs.thread(t), 'turns') : null), 5000, 'the turn');
    const named = [];
    s.graph.onEvent((e) => { if (e.kind === 'event') named.push(e); });
    const update = (id, plan) => s.h.app.request(id, 'fake/notify', { method: 'turn/plan/updated', params: { threadId: t, turnId: turn.ref.id, explanation: 'Doing it', plan } });
    await update(3, [{ step: 'read', status: 'completed' }, { step: 'edit', status: 'inProgress' }]);
    const plan = await until(() => s.graph.list('Plan')[0], 5000, 'the plan');
    assert.deepEqual(s.graph.related(plan.ref, 'tasks').map((x) => [x.state.text, x.state.status]), [['read', 'done'], ['edit', 'inProgress']]);
    await update(4, [{ step: 'read', status: 'completed' }]);
    await until(() => s.graph.related(plan.ref, 'tasks').length === 1, 5000, 'replaced');
    assert.deepEqual(named.filter((e) => e.ref.id === plan.ref.id).map((e) => e.name), ['started', 'tasksChanged', 'tasksChanged']);
    assert.ok(named.some((e) => e.name === 'stepAdded' && e.payload.id === plan.ref.id), 'the turn says a step was added');
    assert.equal(s.graph.resolve(plan.ref).state.status, 'done', 'every task done');
  } finally { await s.close(); }
});

test('codex source: an option, a question\'s answers and skip answer the request at the mux as the app would; the app\'s own late answer is dropped', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const ask = (id, method, params, resolve = true) => s.h.app.request(id, 'fake/serverRequest', { method, params, resolve });
    const pending = async (type) => until(() => s.graph.list(type, { status: 'pending' })[0], 5000, `a pending ${type}`);
    const invoke = (r, operation, args) => s.graph.invoke({ ref: r.ref, operation, args, caller: user, origin: 'test' });
    // A command approval, approved once: the backend gets "accept"; the request is answered, and so says its event.
    const cmdAnswer = ask(10, 'item/commandExecution/requestApproval', { threadId: t, turnId: 'u1', itemId: 'e1', command: 'ls', cwd: '/', availableDecisions: ['accept', 'decline'] });
    const appSaw = await s.h.app.waitFor((m) => m.method === 'item/commandExecution/requestApproval', 5000);
    const cmd = await pending('CodexCommandApproval');
    // A request card names it by the id the app saw: the mux says it is the primary backend's, the source which Request it is.
    assert.equal(s.h.mux.serverRequestOf(appSaw.id).backend, 'primary');
    assert.deepEqual(s.source.requestRefOf(appSaw.id), cmd.ref);
    // the server's own decisions are the options (graph-integrity G1.6): an option it does not offer is refused
    assert.deepEqual(cmd.state.options.map((o) => o.id), ['accept', 'decline']);
    assert.deepEqual([(await invoke(cmd, 'answer', ['acceptWithExecpolicyAmendment'])).reason, (await invoke(cmd, 'answer', ['acceptForSession'])).reason], ['unsupported', 'unsupported'], 'not offered here (no rule proposed, no session decision)');
    assert.equal((await invoke(cmd, 'answer', ['accept', { parts: [{ kind: 'text', text: 'why' }] }])).reason, 'unsupported', 'Codex takes no feedback with an answer');
    const out = await invoke(cmd, 'answer', ['accept']);
    assert.equal(out.status, 'done');
    assert.ok(out.intent, 'an external effect, claimed');
    assert.deepEqual((await cmdAnswer).result.answer.result, { decision: 'accept' });
    await until(() => s.graph.resolve(cmd.ref).state.status === 'answered', 5000, 'answered');
    s.h.app.send({ id: appSaw.id, result: { decision: 'decline' } });           // the app answers too, late: dropped
    await sleep(100);
    assert.equal(s.graph.resolve(cmd.ref).state.status, 'answered');
    assert.equal((await invoke(cmd, 'answer', ['decline'])).reason, 'unavailable', 'no longer pending');
    // A tool approval (an elicitation), denied: decline, no content.
    const toolAnswer = ask(11, 'mcpServer/elicitation/request', { threadId: t, turnId: 'u1', serverName: 'srv', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'echo', tool_params: {}, persist: ['session'] } });
    const tool = await pending('ToolApproval');
    assert.equal((await invoke(tool, 'answer', ['decline'])).status, 'done');
    assert.deepEqual((await toolAnswer).result.answer.result, { action: 'decline', content: null, _meta: null });
    await until(() => s.graph.resolve(tool.ref).state.status === 'declined', 5000, 'declined');
    // A question of two prompts, each answered by its id: a choice for one, words for the other (G1.5); the words of a secret prompt never
    // leave the call
    const records = [];
    s.graph.onOperation((e) => { if (e.operation === 'answer') records.push(e.args); });
    const qAnswer = ask(12, 'item/tool/requestUserInput', { threadId: t, turnId: 'u1', itemId: 'q1', isBlocking: true, questions: [
      { id: 'color', header: 'Color', question: 'Which?', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] },
      { id: 'pin', header: 'PIN', question: 'Your PIN?', isOther: true, isSecret: true, options: null }] });
    const q = await pending('CodexQuestion');
    assert.deepEqual(q.state.prompts.map((x) => x.id), ['color', 'pin']);
    assert.equal((await invoke(q, 'answer', [{ color: { choices: ['Blue'] }, pin: { text: '1234' } }])).status, 'done');
    assert.deepEqual((await qAnswer).result.answer.result, { answers: { color: { answers: ['Blue'] }, pin: { answers: ['1234'] } } });
    assert.deepEqual(records.at(-1), [{ color: { choices: ['Blue'] }, pin: { text: '[secret]' } }], 'the record keeps the choice, never the secret words');
    // Skipping a question does what dismissing it does in the app: the turn is interrupted.
    const reads = [];
    s.h.mux.client('test:observer').observe({ kinds: ['clientRequest'], methods: ['turn/interrupt'] }, (m, info) => reads.push([info.origin, m.params]));
    // (The real backend resolves the question when the turn is interrupted; the fake does not, so its request is left to time out.)
    ask(13, 'item/tool/requestUserInput', { threadId: t, turnId: 'u2', itemId: 'q2', questions: [{ id: 'x', header: 'X', question: 'X?', options: [] }] }).catch(() => null);
    const q2 = await until(() => s.graph.list('CodexQuestion', { status: 'pending' }).find((x) => x.ref.id !== q.ref.id), 5000, 'the second question');
    assert.equal((await invoke(q2, 'skip', [])).status, 'done');
    await until(() => reads.length === 1, 5000, 'the interrupt');
    assert.deepEqual(reads[0][1], { threadId: t, turnId: 'u2' });
  } finally { await s.close(); }
});

test('codex source: a mod approves "always" only with the user\'s approval; the answer is the standing rule the request proposed', async () => {
  const asked = [];
  let answer = { approved: false, reason: 'the user did not allow it' };
  const s = await setup({ approvals: { ask: async (q) => { asked.push(q); return answer; } } });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const ask = (id, method, params) => s.h.app.request(id, 'fake/serverRequest', { method, params, resolve: true });
    const mod = { kind: 'mod', id: 'mod.a' };
    const cmdAnswer = ask(10, 'item/commandExecution/requestApproval', { threadId: t, turnId: 'u1', itemId: 'e1', command: 'git status', cwd: '/', proposedExecpolicyAmendment: ['git', 'status'] });
    const cmd = await until(() => s.graph.list('CodexCommandApproval', { status: 'pending' })[0], 5000, 'the approval');
    assert.deepEqual(cmd.state.options.map((o) => [o.id, o.scope ?? null]), [['accept', 'once'], ['acceptForSession', 'thread'], ['acceptWithExecpolicyAmendment', 'always'], ['decline', null], ['cancel', null]],
      'always is offered: the request proposes a rule');
    const no = await s.graph.invoke({ ref: cmd.ref, operation: 'answer', args: ['acceptWithExecpolicyAmendment'], caller: mod });
    assert.deepEqual([no.status, no.reason], ['refused', 'notAllowed']);
    assert.deepEqual(asked.map(({ signal, ...q }) => q), [{ modId: 'mod.a', operation: 'Approval.answer', action: 'always let Codex run “git status” and commands like it without asking (Always allow commands that start with git status)', detail: 'Codex will run matching commands without asking you. It is saved in your Codex settings, which the app and the command line share.' }]);
    assert.equal(s.graph.resolve(cmd.ref).state.status, 'pending', 'nothing was answered');
    // The user allows it: the request is answered with the rule it proposed.
    answer = { approved: true };
    const yes = await s.graph.invoke({ ref: cmd.ref, operation: 'answer', args: ['acceptWithExecpolicyAmendment'], caller: mod });
    assert.equal(yes.status, 'done');
    assert.deepEqual((await cmdAnswer).result.answer.result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } } });
    // what was answered names the option and its scope (found natively on 22943: the scope said once)
    await until(() => s.graph.resolve(cmd.ref).state.status === 'answered', 5000, 'answered');
    assert.deepEqual(s.graph.resolve(cmd.ref).state.outcome, { decision: 'approved', scope: 'always', option: 'acceptWithExecpolicyAmendment' });
    // A computer-use request: "always" is persist always, as the app answers it.
    const cuAnswer = ask(11, 'mcpServer/elicitation/request', { threadId: t, turnId: 'u1', serverName: 'cua_repl', _meta: { connector_id: 'computer-use', tool_name: 'click', tool_params: { app: 'com.apple.finder' }, persist: ['session', 'always'] } });
    const cu = await until(() => s.graph.list('ComputerUseApproval', { status: 'pending' })[0], 5000, 'the computer-use approval');
    assert.equal((await s.graph.invoke({ ref: cu.ref, operation: 'answer', args: ['accept:always'], caller: mod })).status, 'done');
    assert.match(asked.at(-1).action, /always let Codex use “com\.apple\.finder” without asking/);
    assert.deepEqual((await cuAnswer).result.answer.result, { action: 'accept', content: {}, _meta: { persist: 'always' } });
    // The user (the framework's own UI) is not asked; a network request without a proposed rule offers no "always".
    const netAnswer = ask(12, 'item/commandExecution/requestApproval', { threadId: t, turnId: 'u1', itemId: 'e2', command: 'curl x', cwd: '/', networkApprovalContext: { host: 'example.com', protocol: 'https' } });
    const net = await until(() => s.graph.list('NetworkApproval', { status: 'pending' })[0], 5000, 'the network approval');
    assert.deepEqual(net.state.options.map((o) => o.id), ['accept', 'acceptForSession', 'decline', 'cancel']);
    assert.equal((await s.graph.invoke({ ref: net.ref, operation: 'answer', args: ['acceptWithExecpolicyAmendment'], caller: user })).reason, 'unsupported');
    const n = asked.length;
    assert.equal((await s.graph.invoke({ ref: net.ref, operation: 'answer', args: ['accept'], caller: user })).status, 'done');
    await netAnswer;
    assert.equal(asked.length, n);
  } finally { await s.close(); }
});

test('review 2026-11-05 #7: a mod\'s "always block" is a standing rule too: asked of the user first, as "always allow" is', async () => {
  const asked = [];
  let answer = { approved: false, reason: 'the user did not allow it' };
  const s = await setup({ approvals: { ask: async (q) => { asked.push(q); return answer; } } });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const mod = { kind: 'mod', id: 'mod.a' };
    const netAnswer = s.h.app.request(10, 'fake/serverRequest', { method: 'item/commandExecution/requestApproval', resolve: true, params: { threadId: t, turnId: 'u1', itemId: 'e1', command: 'curl b.dev', cwd: '/',
      networkApprovalContext: { host: 'b.dev', protocol: 'https' }, proposedNetworkPolicyAmendments: [{ host: 'b.dev', action: 'deny' }] } });
    const net = await until(() => s.graph.list('NetworkApproval', { status: 'pending' })[0], 5000, 'the network approval');
    const block = net.state.options.find((o) => o.kind === 'deny' && o.scope === 'always');
    assert.ok(block, 'the request offers to block for good');
    const no = await s.graph.invoke({ ref: net.ref, operation: 'answer', args: [block.id], caller: mod });
    assert.deepEqual([no.status, no.reason], ['refused', 'notAllowed']);
    assert.match(asked.at(-1)?.action ?? '', /always block “b\.dev”/);
    assert.equal(s.graph.resolve(net.ref).state.status, 'pending', 'no rule written');
    answer = { approved: true };
    assert.equal((await s.graph.invoke({ ref: net.ref, operation: 'answer', args: [block.id], caller: mod })).status, 'done');
    await netAnswer;
    // a decline for now still needs no consent
    const n = asked.length;
    const again = s.h.app.request(11, 'fake/serverRequest', { method: 'item/commandExecution/requestApproval', resolve: true, params: { threadId: t, turnId: 'u1', itemId: 'e2', command: 'curl c.dev', cwd: '/',
      networkApprovalContext: { host: 'c.dev', protocol: 'https' } } });
    const net2 = await until(() => s.graph.list('NetworkApproval', { status: 'pending' }).find((x) => x.ref.id !== net.ref.id), 5000, 'the second approval');
    assert.equal((await s.graph.invoke({ ref: net2.ref, operation: 'answer', args: ['decline'], caller: mod })).status, 'done');
    await again;
    assert.equal(asked.length, n);
  } finally { await s.close(); }
});

test('codex source: a backend restart makes its instances stale until it has re-read them', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.source.start();
    const states = [], completes = [];
    s.graph.subscribe({ ref: refs.thread(t) }, (m) => { if (m.type === 'delta' && m.event.fields?.includes('liveness')) states.push(m.event.new.liveness); });
    s.graph.onEvent((e) => { if (e.kind === 'completeness' && e.concept === 'Thread') completes.push(e.complete); });
    const agentEvents = [];
    s.graph.onEvent((e) => { if (e.kind === 'event' && e.name === 'availabilityChanged' && e.ref.type === 'CodexAgent') agentEvents.push(e); });
    assert.equal(model(s.graph, 'fake').liveness, 'live');
    s.h.app.send({ id: 2, method: 'fake/exit', params: { code: 1 } });
    await until(() => states.includes('stale'), 15000, 'stale on exit');
    // The agent says why it cannot be used, and it and its models are stale like the threads.
    const down = s.graph.resolve(refs.agent());
    assert.deepEqual([down.state.available, down.state.unavailableReason, down.liveness], [false, 'The Codex app-server stopped', 'stale']);
    assert.equal(model(s.graph, 'fake').liveness, 'stale');
    // While it is down, the protocol-backed operations are refused `unavailable`: nothing was attempted.
    const refusal = await s.graph.invoke({ ref: refs.thread(t), operation: 'rename', args: ['While down'], caller: user, origin: 'test' });
    assert.deepEqual([refusal.status, refusal.reason], ['refused', 'unavailable']);
    await until(() => s.h.bus.count('appServer/ready') >= 2, 20000, 'restarted');
    // The re-read sets the collection partial, then complete again. The restarted fake (fresh, no threads) does not list the old thread:
    // a complete read replaces the collection, so it is removed (R1). (No thread is started after the restart: the fake would reuse the old id.)
    await until(() => completes.includes(false) && completes.at(-1) === true, 15000, 'list re-read');
    assert.equal(s.graph.resolve(refs.thread(t))?.gone, true, 'the restarted backend did not list it: removed');
    // The agent and the catalog are read again with the list: available, live and complete.
    await until(() => s.graph.resolve(refs.agent()).state.available && model(s.graph, 'fake').liveness === 'live' && s.graph.isComplete('Model'), 15000, 'agent and models read again');
    const up = s.graph.resolve(refs.agent());
    assert.deepEqual([up.state.unavailableReason, up.liveness], [undefined, 'live']);
    assert.equal(agentEvents.length, 2, 'availabilityChanged when it went and when it came back');
  } finally { await s.close(); }
});

test('codex source: a complete list read replaces the collection: a thread Codex no longer has goes, with its turns and what is in them', async () => {
  const s = await setup();
  try {
    const t1 = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const t2 = (await s.h.app.request(2, 'thread/start', {})).result.thread.id;
    await s.h.app.request(3, 'turn/start', { threadId: t1, input: [{ type: 'text', text: 'hello', text_elements: [] }] });
    const reads = [];
    s.h.mux.client('test:observer').observe({ kinds: ['clientRequest'], methods: ['thread/list'] }, (m, info) => { if (info.origin !== 'app') reads.push(m.params); });
    await s.source.start();
    await s.graph.subscribe({ ref: refs.thread(t1) }, () => {}).loaded;
    const [turn] = s.graph.related(refs.thread(t1), 'turns');
    assert.equal(s.graph.related(turn.ref, 'input')?.length, 1, 'the turn and its message');
    // The read is meant to be complete: every source kind (not only the interactive ones the default lists) and every model provider.
    assert.equal(reads[0].sourceKinds.length, 10);
    assert.deepEqual(reads[0].modelProviders, []);
    await s.h.app.request(4, 'fake/forget', { threadId: t1 });
    assert.equal(await s.source.resync('test'), true);
    assert.equal(thread(s.graph, t1)?.gone, true, 'no longer listed: removed');
    assert.equal(s.graph.resolve(turn.ref)?.gone, true, 'with its turn');
    assert.equal(s.graph.list('UserMessage').length, 0, 'and what was in it');
    assert.equal(thread(s.graph, t2).liveness, 'live');
    assert.equal(s.graph.isComplete('Thread'), true);
  } finally { await s.close(); }
});

test('codex source: an ephemeral thread has no history to read and is never in a list: observing it reads nothing, a complete list keeps it, thread/closed ends it', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', { ephemeral: true })).result.thread.id;
    await until(() => thread(s.graph, t), 5000, 'the ephemeral thread');
    const reads = [];
    s.h.mux.client('test:observer').observe({ kinds: ['clientRequest'], methods: ['thread/turns/list'] }, (m, info) => { if (info.origin !== 'app') reads.push(m.params.threadId); });
    await s.graph.subscribe({ ref: refs.thread(t) }, () => {}).loaded;
    assert.deepEqual(reads, [], 'no history read (the backend would refuse it)');
    await s.source.resync('test');
    assert.equal(thread(s.graph, t).gone, undefined, 'not removed by a complete list that cannot list it (stale: it cannot be read again)');
    await s.h.app.request(2, 'fake/notify', { method: 'thread/closed', params: { threadId: t } });
    await until(() => thread(s.graph, t)?.gone, 5000, 'closed: gone');
  } finally { await s.close(); }
});

test('codex source: onObserve returns its load, so a view\'s loaded settles with the history resident; a full load replaces the turns', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    for (const [i, text] of ['one', 'two', 'three'].entries()) await s.h.app.request(10 + i, 'turn/start', { threadId: t, input: [{ type: 'text', text, text_elements: [] }] });
    await until(() => s.graph.related(refs.thread(t), 'turns')?.length === 3, 5000, 'three turns');
    const turns = s.graph.related(refs.thread(t), 'turns').map((x) => x.ref.id);
    const view = s.graph.subscribe({ ref: refs.thread(t) }, () => {});
    await view.loaded;
    assert.ok(turns.every((id) => s.graph.related({ type: 'Turn', provider: 'codex', id }, 'input')?.length === 1), 'every turn\'s message is resident once loaded settles');
    view.dispose();
    // A turn Codex no longer has (a revert elsewhere) goes at the next full load (after a gap or restart re-read).
    await s.h.app.request(20, 'fake/forget', { threadId: t, turnId: turns[1] });
    await s.source.resync('test');
    assert.deepEqual(s.graph.related(refs.thread(t), 'turns').map((x) => x.ref.id).sort(), [turns[0], turns[2]].sort());
  } finally { await s.close(); }
});

test('codex source: observing a message not loaded yet loads its thread (its id is the thread\'s and its own): a page\'s binding asks for it', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.h.app.request(2, 'turn/start', { threadId: t, input: [{ type: 'text', text: 'hello', text_elements: [] }] });
    await until(() => s.graph.related(refs.thread(t), 'turns')?.[0]?.state.status === 'completed', 5000, 'the turn completes');
    const turn = s.graph.related(refs.thread(t), 'turns')[0];
    assert.ok(!s.graph.related(turn.ref, 'input')?.length, 'its message is not loaded yet');
    const view = s.graph.subscribe({ ref: { type: 'Message', provider: 'codex', id: `${t}:not-loaded` } }, () => {});
    await view.loaded;
    assert.equal(s.graph.related(turn.ref, 'input')?.length, 1, 'the thread\'s history loaded');
    view.dispose();
  } finally { await s.close(); }
});

test('codex source: a loaded thread subscribed again catches up with one read of its newest turns', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.h.app.request(2, 'turn/start', { threadId: t, input: [{ type: 'text', text: 'hi', text_elements: [] }] });
    await s.graph.subscribe({ ref: refs.thread(t) }, () => {}).loaded;
    const reads = [];
    s.h.mux.client('test:observer').observe({ kinds: ['clientRequest'], methods: ['thread/turns/list'] }, (m, info) => { if (info.origin !== 'app') reads.push(m.params); });
    await s.h.app.request(3, 'thread/unsubscribe', { threadId: t });
    await sleep(50);
    assert.equal(reads.length, 0, 'closing reads nothing');
    await s.h.app.request(4, 'thread/resume', { threadId: t });
    await until(() => reads.length === 1, 5000, 'the catch-up read');
    assert.deepEqual([reads[0].threadId, reads[0].cursor], [t, undefined]);
    await sleep(50);
    assert.equal(reads.length, 1, 'once');
  } finally { await s.close(); }
});

test('codex source: a second app connection that opens and closes (the app\'s startup probe) leaves the instances live and causes no re-read', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.source.start();
    const reads = [];
    s.h.mux.client('test:observer').observe({ kinds: ['clientRequest'], methods: ['thread/list'] }, (m, info) => reads.push(info.origin));
    const probe = makeApp();
    s.h.mux.attachApp(probe.stream);
    await probe.handshake({ clientInfo: { name: 'codex_desktop', version: '0' } });
    await until(() => s.h.bus.count('appServer/ready') >= 2, 12000, 'the probe session is ready');
    probe.end();
    await until(() => s.h.bus.events.some((e) => e.topic === 'appServer/exited' && e.data.reason === 'app-disconnected'), 12000, 'the probe closed');
    await sleep(2000);
    assert.equal(thread(s.graph, t).liveness, 'live');
    assert.equal(reads.filter((o) => o !== 'app').length, 0, 'no re-read');
  } finally { await s.close(); }
});

/** Replay a capture through the mux: the app sends its client steps and answers its server requests; the source only listens. */
async function replay(name, check, { before } = {}) {
  const file = path.join(CAPTURES, name);
  const script = Object.values(loadCapture(file).sessions)[0];
  const dirForLaunch = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-replay-'));
  const s = await setup({ noUp: true, harness: { launchFor: fakeLaunch(dirForLaunch, replayEnv(file)) } });
  try {
    s.h.attach();
    before?.(s);
    let id = 0;
    for (const step of script) {
      if ('client' in step) await s.h.app.request(`c${++id}`, step.client, step.params);
      else if ('clientNotification' in step) s.h.app.send({ method: step.clientNotification, ...(step.params === undefined ? {} : { params: step.params }) });
      else if ('serverRequest' in step) {
        const m = await s.h.app.waitFor((x) => x.method === step.serverRequest && x.id !== undefined, 5000);
        s.h.app.send({ id: m.id, result: step.answer ?? {} });
      }
    }
    await sleep(200);
    await check(s);
  } finally { await s.close(); fs.rmSync(dirForLaunch, { recursive: true, force: true }); }
}

test('codex source: the thread-lifecycle capture builds the thread, its turn and messages, usage, the rename, the archive and the unarchive', async () => {
  const archived = [], named = [];
  await replay('thread-lifecycle-26.1013.40934-20770.json', (s) => {
    const [t] = s.graph.list('Thread');
    assert.ok(t, 'one thread');
    assert.equal(t.state.title, 'QA capture thread', 'renamed');
    assert.equal(t.state.archived, false, 'unarchived at the end');
    assert.ok(t.state.usage?.total?.totalTokens > 0 && t.state.usage?.modelContextWindow > 0, 'the token report as given, from thread/tokenUsage/updated');
    const [turn] = s.graph.related(t.ref, 'turns');
    assert.equal(turn.state.status, 'completed');
    assert.equal(s.graph.related(turn.ref, 'input').length, 1);
    assert.ok(s.graph.list('AgentMessage').some((m) => m.state.content.parts[0].text === 'ok'));
    assert.ok(archived.includes(true) && archived.at(-1) === false, 'the archive and the unarchive were seen');
    // Named events from the notifications (never from reads): the thread's life, its turn's, and its agent message's.
    const of = (id) => named.filter((e) => e.ref.id === id).map((e) => e.name);
    assert.deepEqual(of(t.ref.id).filter((n) => ['created', 'turnStarted', 'turnFinished', 'titleChanged', 'archived', 'restored'].includes(n)),
      ['created', 'turnStarted', 'turnFinished', 'titleChanged', 'archived', 'restored']);
    // the capture's moderation report is the turn's event too (graph-integrity G1.4)
    assert.deepEqual(of(turn.ref.id).filter((n) => n !== 'stepAdded'), ['started', 'moderated', 'completed']);
    const reply = s.graph.list('AgentMessage').find((m) => m.state.content.parts[0].text === 'ok');
    assert.equal(of(reply.ref.id).at(-1), 'completed');
  }, { before: (s) => s.graph.onEvent((e) => { if (e.fields?.includes('archived')) archived.push(e.new.archived); if (e.kind === 'event') named.push(e); }) });
});

test('codex source: the command-approval capture, replayed through the mux, builds the thread, its turn, its steps and the cancelled request', async () => {
  const named = [];
  await replay('command-approval-26.1013.40934-20770.json', (s) => {
    const threads = s.graph.list('Thread');
    assert.equal(threads.length, 1);
    const t = threads[0];
    const turns = s.graph.related(t.ref, 'turns');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].state.status, 'stopped', 'the turn was interrupted');
    const runs = s.graph.list('CommandRun');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state.status, 'cancelled', 'the command was declined');
    assert.match(runs[0].state.command, /touch/);
    const reqs = s.graph.list('CommandApproval');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].state.status, 'cancelled', 'answered cancel');
    assert.equal(s.graph.related(reqs[0].ref, 'step').ref.id, runs[0].ref.id, 'the request links its step');
    assert.ok(s.graph.related(turns[0].ref, 'input').length >= 1);
    // The step's events, the turn's (a stopped turn), and the request's.
    const of = (id) => named.filter((e) => e.ref.id === id).map((e) => e.name);
    assert.deepEqual(of(runs[0].ref.id), ['started', 'finished']);
    assert.ok(named.some((e) => e.ref.id === turns[0].ref.id && e.name === 'stepAdded' && e.payload.id === runs[0].ref.id));
    assert.deepEqual(of(turns[0].ref.id).filter((n) => n !== 'stepAdded'), ['started', 'moderated', 'stopped']);
    assert.deepEqual(of(reqs[0].ref.id), ['opened', 'answered']);
  }, { before: (s) => s.graph.onEvent((e) => { if (e.kind === 'event') named.push(e); }) });
});

// ---------------------------------------------------------------- the agent and its models
test('codex source: CodexAgent is put at once; start() reads model/list (every page, hidden models too) into Models linked to it', async () => {
  const s = await setup();
  try {
    const agent = s.graph.resolve(refs.agent());
    assert.deepEqual([agent.ref.type, agent.ref.id, agent.liveness], ['CodexAgent', 'codex', 'live']);
    assert.deepEqual(agent.state, { name: 'Codex', icon: 'codex', available: true });
    assert.equal(agent.summary.title, 'Codex');
    assert.equal(s.graph.isComplete('Agent'), true, 'the one native agent is the whole collection');
    assert.equal(s.graph.isComplete('Model'), false, 'no models before they are read');
    assert.equal(s.graph.list('Model').length, 0);
    await s.source.start();
    assert.equal(s.graph.isComplete('Model'), true, 'complete after every page (page size 2)');
    assert.deepEqual(s.graph.list('Model').map((m) => m.ref.id).sort(), ['fake', 'fake-mini', 'fake-old']);
    const fake = model(s.graph, 'fake');
    assert.deepEqual(fake.state, {
      name: 'Fake', description: 'The fake app-server\'s default model', default: true, available: true,
      efforts: [{ id: 'low', label: 'Light' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
    });
    assert.deepEqual([fake.ref.type, fake.ref.provider, fake.links.agent], ['Model', 'codex', refs.agent()]);
    assert.deepEqual(fake.summary, { title: 'Fake', subtitle: 'The fake app-server\'s default model' });
    assert.deepEqual(model(s.graph, 'fake-mini').state.efforts, [{ id: 'low', label: 'Light' }]);
    assert.deepEqual(model(s.graph, 'fake-mini').state.default, false);
    const old = model(s.graph, 'fake-old');
    assert.deepEqual([old.state.available, old.state.efforts], [false, []], 'hidden: not offered, and it lists no levels');
    assert.deepEqual(s.graph.related(agent.ref, 'models').map((m) => m.ref.id).sort(), ['fake', 'fake-mini', 'fake-old'], 'Agent.models is derived from Model.agent');
    assert.ok(s.h.serverLog().some((l) => /"method":"model\/list".*"includeHidden":true/.test(l) && /"limit":2/.test(l)), 'asked for the hidden models too, a page at a time');
    // The thread's model and agent links resolve to the instances.
    const t = (await s.h.app.request(90, 'thread/start', {})).result.thread.id;
    await until(() => thread(s.graph, t), 5000, 'thread');
    assert.equal(s.graph.related(refs.thread(t), 'model').ref.id, 'fake');
    assert.equal(s.graph.related(refs.thread(t), 'agent').ref.id, 'codex');
    assert.deepEqual(s.graph.related(agent.ref, 'threads').map((x) => x.ref.id), [t], 'Agent.threads is derived from Thread.agent');
    // What the fake serves matches the build's schema (the mapping reads the real fields).
    const served = (await s.h.app.request(91, 'model/list', { includeHidden: true })).result;
    assert.deepEqual(frameIssues(newestBuild(), 'result', 'model/list', served), []);
    assert.equal(served.data.length, 3);
  } finally { await s.close(); }
});

test('the strict fake models model/list: the build\'s schema, hidden models only on request, offset paging, and errors for bad params', async () => {
  const s = await setup();
  try {
    const ask = async (id, params) => s.h.app.request(id, 'model/list', params);
    const shown = (await ask(1, {})).result;
    assert.deepEqual(shown.data.map((m) => m.id), ['fake', 'fake-mini'], 'hidden models are not in the picker\'s list');
    assert.equal(shown.nextCursor, undefined);
    const all = (await ask(2, { includeHidden: true })).result;
    assert.deepEqual(all.data.map((m) => m.id), ['fake', 'fake-mini', 'fake-old']);
    for (const result of [shown, all]) assert.deepEqual(frameIssues(newestBuild(), 'result', 'model/list', result), []);
    const page1 = (await ask(3, { includeHidden: true, limit: 2 })).result;
    assert.deepEqual([page1.data.map((m) => m.id), page1.nextCursor], [['fake', 'fake-mini'], '2']);
    const page2 = (await ask(4, { includeHidden: true, limit: 2, cursor: '2' })).result;
    assert.deepEqual([page2.data.map((m) => m.id), page2.nextCursor], [['fake-old'], undefined]);
    assert.equal((await ask(5, { limit: 0, includeHidden: true })).result.data.length, 1, 'a limit below 1 counts as 1');
    assert.equal((await ask(6, { cursor: 'after:fake' })).error.code, -32600);
    assert.equal((await ask(7, { limit: -1 })).error.code, -32602);
    assert.equal((await ask(8, { includeHidden: 'yes' })).error.code, -32602);
    assert.equal((await ask(9, { cursor: null, limit: null, includeHidden: null })).result.data.length, 2, 'null means the default');
    assert.equal((await s.h.app.request(10, 'fake/models', { models: 'none' })).error.code, -32602);
  } finally { await s.close(); }
});

test('codex source: the catalog is read again on account/updated; a model it no longer lists is removed, a new one appears', async () => {
  const s = await setup();
  try {
    await s.source.start();
    assert.equal(model(s.graph, 'fake-old').liveness, 'live');
    const catalog = [protocolModel('fake', { displayName: 'Fake', efforts: ['low', 'xhigh', 'mystery_level'] }), protocolModel('fake-next', { displayName: 'Fake next', isDefault: true })];
    await s.h.app.request(1, 'fake/models', { models: catalog });
    await s.h.app.request(2, 'fake/notify', { method: 'account/updated', params: { authMode: null, planType: null } });
    await until(() => model(s.graph, 'fake-next') && model(s.graph, 'fake-old')?.gone, 5000, 'the new catalog');
    assert.equal(model(s.graph, 'fake-mini')?.gone, true, 'removed');
    assert.deepEqual(s.graph.list('Model').map((m) => m.ref.id).sort(), ['fake', 'fake-next']);
    assert.deepEqual(model(s.graph, 'fake').state.efforts, [{ id: 'low', label: 'Light' }, { id: 'xhigh', label: 'Extra High' }, { id: 'mystery_level', label: 'Mystery level' }]);
    assert.deepEqual([model(s.graph, 'fake').state.default, model(s.graph, 'fake-next').state.default], [false, true]);
    assert.equal(s.graph.isComplete('Model'), true);
    assert.deepEqual(s.graph.related(refs.agent(), 'models').map((m) => m.ref.id).sort(), ['fake', 'fake-next']);
    // The same through a login.
    await s.h.app.request(3, 'fake/models', { models: [protocolModel('fake-login')] });
    await s.h.app.request(4, 'fake/notify', { method: 'account/login/completed', params: { success: true } });
    await until(() => model(s.graph, 'fake-login') && model(s.graph, 'fake')?.gone, 5000, 'the catalog after the login');
  } finally { await s.close(); }
});

test('codex source: a turn\'s model, for its context window, is its turn/start\'s collaboration mode\'s, else its own (built review: the server takes the mode\'s first)', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    await s.source.start();
    await until(() => model(s.graph, 'fake') && model(s.graph, 'fake-mini'), 5000, 'the models');
    const turnOf = async (id, params) => (await s.h.app.request(id, 'turn/start', { threadId: t, input: [{ type: 'text', text: 'hi', text_elements: [] }], ...params })).result.turn.id;
    const usage = (n) => ({ total: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 }, last: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: n });
    const u1 = await turnOf(2, { model: 'fake', collaborationMode: { mode: 'plan', settings: { model: 'fake-mini', reasoning_effort: null, developer_instructions: null } } });
    await s.h.app.request(3, 'fake/notify', { method: 'thread/tokenUsage/updated', params: { threadId: t, turnId: u1, tokenUsage: usage(4000) } });
    await until(() => model(s.graph, 'fake-mini')?.state.contextWindow === 4000, 5000, 'the mode\'s model');
    assert.equal(model(s.graph, 'fake').state.contextWindow, undefined, 'never the top-level model the mode overrides');
    const u2 = await turnOf(4, { model: 'fake' });
    await s.h.app.request(5, 'fake/notify', { method: 'thread/tokenUsage/updated', params: { threadId: t, turnId: u2, tokenUsage: usage(9000) } });
    await until(() => model(s.graph, 'fake')?.state.contextWindow === 9000, 5000, 'its own model');
  } finally { await s.close(); }
});

test('codex source: a model/list that fails leaves the Model collection incomplete and never stops the thread list; the next read completes it', async () => {
  let fail = true;
  const s = await setup({
    mux: (mux) => ({
      keyInfo: (...a) => mux.keyInfo(...a),
      client: (id) => new Proxy(mux.client(id), {
        get: (c, k) => (k === 'request' ? (method, ...rest) => (fail && method === 'model/list' ? Promise.reject(new Error('no catalog')) : c.request(method, ...rest)) : Reflect.get(c, k)),
      }),
    }),
  });
  try {
    await s.h.app.request(1, 'thread/start', {});
    await s.source.start();
    assert.equal(s.graph.list('Thread').length, 1, 'the threads were read');
    assert.equal(s.graph.isComplete('Thread'), true);
    assert.equal(s.graph.list('Model').length, 0);
    assert.equal(s.graph.isComplete('Model'), false);
    assert.equal(s.graph.resolve(refs.agent()).state.available, true, 'the app-server answers');
    // The next read (an account change) succeeds.
    fail = false;
    await s.h.app.request(2, 'fake/notify', { method: 'account/updated', params: {} });
    await until(() => s.graph.isComplete('Model') && s.graph.list('Model').length === 3, 5000, 'models after the retry');
  } finally { await s.close(); }
});

test('codex source: a step links its request and keeps it, streams say updated (at most every 250 ms); every report the server makes is observable, repeats included', async () => {
  const s = await setup();
  const events = [];
  s.graph.onEvent((e) => { if (e.kind === 'event') events.push(e); });
  const n = (id, method, params) => s.h.app.request(id, 'fake/notify', { method, params });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const turn = { id: 'u9', status: 'inProgress', items: [], error: null, startedAt: 1 };
    await n(2, 'turn/started', { threadId: t, turn });
    const item = { type: 'commandExecution', id: 'exec-9', command: 'ls', cwd: '/tmp', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null };
    await n(3, 'item/started', { threadId: t, turnId: 'u9', item, startedAtMs: 10 });
    const step = refs.item('CodexCommandRun', t, 'exec-9');
    await until(() => s.graph.resolve(step), 5000, 'the step');
    s.h.app.send({ id: 4, method: 'fake/serverRequest', params: { method: 'item/commandExecution/requestApproval', params: { threadId: t, turnId: 'u9', itemId: 'exec-9', command: 'ls', cwd: '/tmp' } } });
    await until(() => s.graph.list('CommandApproval').length === 1, 5000, 'the request');
    const req = s.graph.list('CommandApproval')[0].ref;
    assert.equal(req.type, 'CodexCommandApproval');
    await until(() => s.graph.resolve(step).links.request?.id === req.id, 5000, 'Step.request');
    await n(5, 'item/completed', { threadId: t, turnId: 'u9', item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'a' } });
    await until(() => s.graph.resolve(step).state.status === 'done', 5000, 'the step done');
    assert.equal(s.graph.resolve(step).links.request?.id, req.id, 'kept when the step is put again');
    await n(6, 'item/commandExecution/outputDelta', { threadId: t, turnId: 'u9', itemId: 'exec-9', delta: 'a' });
    await n(7, 'item/commandExecution/outputDelta', { threadId: t, turnId: 'u9', itemId: 'exec-9', delta: 'b' });
    await until(() => events.some((e) => e.ref.id === step.id && e.name === 'updated'), 5000, 'updated');
    assert.equal(events.filter((e) => e.ref.id === step.id && e.name === 'updated').length, 1, 'two deltas in 250 ms: one updated');
    const usage = (total, last) => ({ total: { inputTokens: total[0], outputTokens: total[1], totalTokens: total[2], cachedInputTokens: 0, reasoningOutputTokens: 0 },
      last: { inputTokens: last[0], outputTokens: last[1], totalTokens: last[2], cachedInputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 1000 });
    // who started it: no turn/start was seen for it, and none was open on its chat, so the server started it (graph-integrity G1.7)
    assert.deepEqual(s.graph.resolve(refs.turn('u9')).state.startedBy, { kind: 'agent' });
    // every token report as given: the thread's last one is its usage; each is an event, the repeat too (G1.3); the turn has no computed usage
    const reports = () => events.filter((e) => e.ref.id === t && e.name === 'tokenUsageReported');
    await n(8, 'thread/tokenUsage/updated', { threadId: t, turnId: 'u9', tokenUsage: usage([100, 20, 120], [30, 5, 35]) });
    await until(() => reports().length === 1, 5000, 'the first report');
    assert.deepEqual(reports()[0].payload, { tokenUsage: tokenUsageOf(usage([100, 20, 120], [30, 5, 35])), turnId: 'u9' });
    assert.equal(s.graph.resolve(refs.turn('u9')).state.usage, undefined, 'no delta computed');
    // the model a turn ran with says the context window its usage told (public-hooks.md §4 F13), and keeps it when the models are read
    // again; a turn whose model is not known (u9 started with no turn/start seen) teaches nothing (built review)
    const model = refs.model('fake');
    await s.source.start();
    await until(() => s.graph.resolve(model), 5000, 'the models');
    assert.equal(s.graph.resolve(model).state.contextWindow, undefined);
    // a reroute names the model the turn runs with from then on, and is the turn's event as the server says it
    await n(79, 'model/rerouted', { threadId: t, turnId: 'u9', fromModel: 'other', toModel: 'fake', reason: 'highRiskCyberActivity' });
    await until(() => events.some((e) => e.ref.id === 'u9' && e.name === 'modelRerouted'), 5000, 'modelRerouted');
    assert.deepEqual(events.find((e) => e.name === 'modelRerouted').payload, { fromModel: 'other', toModel: 'fake', reason: 'highRiskCyberActivity' });
    await n(80, 'thread/tokenUsage/updated', { threadId: t, turnId: 'u9', tokenUsage: { ...usage([100, 20, 120], [30, 5, 35]), modelContextWindow: 2000 } });
    await until(() => s.graph.resolve(model)?.state.contextWindow === 2000, 5000, 'Model.contextWindow');
    assert.ok(s.graph.capabilities(model).includes('contextWindow'));
    await n(81, 'thread/tokenUsage/updated', { threadId: t, turnId: 'u-unknown', tokenUsage: { ...usage([100, 20, 120], [30, 5, 35]), modelContextWindow: 9 } });
    await n(82, 'thread/tokenUsage/updated', { threadId: t, tokenUsage: { ...usage([100, 20, 120], [30, 5, 35]), modelContextWindow: 9 } });
    await s.source.start();
    assert.equal(s.graph.resolve(model).state.contextWindow, 2000, 'kept across a read; nothing learned for a turn not known');
    const before = reports().length;
    await n(9, 'thread/tokenUsage/updated', { threadId: t, turnId: 'u9', tokenUsage: usage([140, 25, 165], [40, 5, 45]) });
    await n(10, 'thread/tokenUsage/updated', { threadId: t, turnId: 'u9', tokenUsage: usage([140, 25, 165], [40, 5, 45]) });
    await until(() => reports().length === before + 2, 5000, 'both reports, the repeat too');
    assert.deepEqual(s.graph.resolve(refs.thread(t)).state.usage, tokenUsageOf(usage([140, 25, 165], [40, 5, 45])), 'the last report, as given');
    // an error, with whether the server retries by itself; the turn's aggregate diff; a compaction and a hook run on the chat
    await n(12, 'error', { threadId: t, turnId: 'u9', willRetry: true, error: { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: null } });
    await n(13, 'turn/diff/updated', { threadId: t, turnId: 'u9', diff: 'diff --git a/x b/x' });
    await n(14, 'thread/compacted', { threadId: t, turnId: 'u9' });
    await n(15, 'hook/started', { threadId: t, turnId: 'u9', run: { id: 'h1', eventName: 'preToolUse', status: 'running' } });
    await until(() => events.some((e) => e.name === 'hookStarted'), 5000, 'the hook');
    assert.deepEqual(events.find((e) => e.name === 'errored').payload, { error: { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: null }, willRetry: true });
    assert.equal(s.graph.resolve(refs.turn('u9')).state.diff, 'diff --git a/x b/x');
    assert.deepEqual([events.find((e) => e.name === 'compacted').payload, events.find((e) => e.name === 'hookStarted').payload],
      [{ turnId: 'u9' }, { run: { id: 'h1', eventName: 'preToolUse', status: 'running' }, turnId: 'u9' }]);
    await n(11, 'turn/completed', { threadId: t, turn: { ...turn, status: 'completed', completedAt: 2 } });
    await until(() => s.graph.resolve(refs.turn('u9')).state.status === 'completed', 5000, 'the turn completed');
    assert.deepEqual([s.graph.resolve(refs.turn('u9')).state.startedBy, s.graph.resolve(refs.turn('u9')).state.diff], [{ kind: 'agent' }, 'diff --git a/x b/x'], 'kept when the turn is put again');
    // its completion carries the server's own time
    assert.equal(events.find((e) => e.ref.id === 'u9' && e.name === 'completed').sourceAt, 2000);
  } finally { await s.close(); }
});

test('codex source: the app\'s thread/revert drops that turn and the later ones (with what is in them); thread/rollback its last turns; a CommandRun reads as the app shows it', async () => {
  const s = await setup();
  const n = (id, method, params) => s.h.app.request(id, 'fake/notify', { method, params });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    for (let i = 0; i < 4; i++) await s.h.app.request(10 + i, 'turn/start', { threadId: t, input: [{ type: 'text', text: `m${i}`, text_elements: [] }] });
    await until(() => ['turn-1', 'turn-2', 'turn-3', 'turn-4'].every((id) => s.graph.resolve(refs.turn(id))?.state.status === 'completed'), 5000, 'four turns');
    const item = { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'ls -la'", cwd: '/tmp', status: 'completed', commandActions: [{ type: 'unknown', command: 'ls -la' }],
      aggregatedOutput: 'x', exitCode: 0, durationMs: 3, processId: null };
    await n(20, 'item/completed', { threadId: t, turnId: 'turn-3', item });
    const step = refs.item('CommandRun', t, 'exec-1');
    await until(() => s.graph.resolve(step), 5000, 'the step');
    assert.deepEqual([s.graph.resolve(step).state.command, s.graph.resolve(step).state.title], ['ls -la', 'ls -la'], 'the shell wrapper is not what the app shows');
    const r = await s.h.app.request(30, 'thread/revert', { threadId: t, beforeTurnId: 'turn-3' });
    assert.ok(r.result?.thread, 'the fake answers the revert');
    const gone = (r) => !s.graph.resolve(r) || s.graph.resolve(r).gone === true;
    await until(() => gone(refs.turn('turn-3')) && gone(refs.turn('turn-4')), 5000, 'the reverted turns go');
    assert.ok(gone(step), 'with their steps');
    assert.ok(!gone(refs.turn('turn-1')) && !gone(refs.turn('turn-2')), 'the earlier turns stay');
    await s.h.app.request(31, 'thread/rollback', { threadId: t, numTurns: 1 });
    await until(() => gone(refs.turn('turn-2')), 5000, 'the rolled back turn goes');
    assert.ok(!gone(refs.turn('turn-1')), 'the first turn stays');
    const bad = await s.h.app.request(32, 'thread/revert', { threadId: t, beforeTurnId: 'nope' });
    assert.ok(bad.error, 'an unknown turn is an error');
    assert.ok(!gone(refs.turn('turn-1')), 'a failed revert drops nothing');
  } finally { await s.close(); }
});

test('codex source: a live turn keeps its answer when it completes after its final message', async () => {
  const s = await setup();
  const n = (id, method, params) => s.h.app.request(id, 'fake/notify', { method, params });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const turn = { id: 'live-1', status: 'inProgress', items: [], error: null, startedAt: 1 };
    await n(2, 'turn/started', { threadId: t, turn });
    const msg = { type: 'agentMessage', id: 'msg-1', text: 'DONE', phase: 'final_answer', memoryCitation: null };
    await n(3, 'item/completed', { threadId: t, turnId: 'live-1', item: msg });
    await until(() => s.graph.resolve(refs.turn('live-1'))?.links.answer, 5000, 'the answer');
    await n(4, 'turn/completed', { threadId: t, turn: { ...turn, status: 'completed' } });
    await until(() => s.graph.resolve(refs.turn('live-1')).state.status === 'completed', 5000, 'the turn completed');
    assert.equal(s.graph.resolve(refs.turn('live-1')).links.answer?.id, refs.item('AgentMessage', t, 'msg-1').id, 'kept when the turn is put again');
  } finally { await s.close(); }
});

test('public hooks H5: every answer says what and who: the app\'s (the user), a mod\'s call, the server\'s withdrawal; an edit approval lists its files', async () => {
  const s = await setup();
  const events = [];
  s.graph.onEvent((e) => { if (e.kind === 'event' && e.name === 'answered') events.push(e); });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const ask = (id, method, params) => s.h.app.request(id, 'fake/serverRequest', { method, params, resolve: true }).catch(() => null);
    // the user answers in the app: once, for the session
    ask(10, 'item/commandExecution/requestApproval', { threadId: t, turnId: 'u1', itemId: 'e1', command: "/bin/zsh -lc 'ls -la src'", cwd: '/r',
      commandActions: [{ type: 'listFiles', command: 'ls -la src', path: 'src' }], availableDecisions: ['accept', 'acceptForSession', 'decline'] });
    const seen = await s.h.app.waitFor((m) => m.method === 'item/commandExecution/requestApproval', 5000);
    const cmd = await until(() => s.graph.list('CommandApproval', { status: 'pending' })[0], 5000, 'the command approval');
    // as the app shows it, and the server's parsed actions as given (graph-integrity G1.1): nothing classified by the framework
    assert.deepEqual([cmd.state.display, cmd.state.command, cmd.state.commandActions], ['ls -la src', "/bin/zsh -lc 'ls -la src'", [{ type: 'listFiles', command: 'ls -la src', path: 'src' }]]);
    s.h.app.send({ id: seen.id, result: { decision: 'acceptForSession' } });
    await until(() => s.graph.resolve(cmd.ref).state.status === 'answered', 5000, 'answered');
    const a = s.graph.resolve(cmd.ref).state;
    assert.deepEqual([a.outcome, a.answeredBy.kind], [{ decision: 'approved', scope: 'thread', option: 'acceptForSession' }, 'user']);
    assert.deepEqual((await until(() => events.find((e) => e.ref.id === cmd.ref.id), 5000, 'its event')).payload.outcome, { decision: 'approved', scope: 'thread', option: 'acceptForSession' }, 'the event carries it');
    // a mod denies through the graph: the answer is the framework's at the mux, the mod's in the graph
    ask(11, 'item/commandExecution/requestApproval', { threadId: t, turnId: 'u1', itemId: 'e2', command: 'touch x', cwd: '/r', availableDecisions: ['accept', 'decline'] });
    const cmd2 = await until(() => s.graph.list('CommandApproval', { status: 'pending' })[0], 5000, 'the second approval');
    assert.equal((await s.graph.invoke({ ref: cmd2.ref, operation: 'answer', args: ['decline'], caller: { kind: 'mod', id: 'unit.policy' }, origin: 'test' })).status, 'done');
    await until(() => s.graph.resolve(cmd2.ref).state.status === 'declined', 5000, 'declined');
    assert.deepEqual([s.graph.resolve(cmd2.ref).state.outcome, s.graph.resolve(cmd2.ref).state.answeredBy.kind, s.graph.resolve(cmd2.ref).state.answeredBy.id], [{ decision: 'denied', option: 'decline' }, 'mod', 'unit.policy']);
    // withdrawn by the server (the turn stopped): cancelled, by the app
    ask(12, 'item/commandExecution/requestApproval', { threadId: t, turnId: 'u1', itemId: 'e3', command: 'rm x', cwd: '/r' });
    const cmd3 = await until(() => s.graph.list('CommandApproval', { status: 'pending' })[0], 5000, 'the third approval');
    const sid = [...s.graph.list('CommandApproval')].length && (await s.h.app.waitFor((m) => m.method === 'item/commandExecution/requestApproval' && m.params.itemId === 'e3', 5000)).id;
    await s.h.app.request(13, 'fake/notify', { method: 'serverRequest/resolved', params: { threadId: t, requestId: sid } });
    await until(() => s.graph.resolve(cmd3.ref).state.status === 'cancelled', 5000, 'cancelled');
    assert.deepEqual([s.graph.resolve(cmd3.ref).state.answeredBy.kind, s.graph.resolve(cmd3.ref).state.answeredBy.via], ['app', 'server']);
    // an edit approval: its files from its fileChange step, whether the step came first or after
    await s.h.app.request(2, 'turn/start', { threadId: t, input: [{ type: 'text', text: 'edit', text_elements: [] }] });
    const [turn] = await until(() => (s.graph.related(refs.thread(t), 'turns')?.length ? s.graph.related(refs.thread(t), 'turns') : null), 5000, 'the turn');
    const change = { type: 'fileChange', id: 'p1', status: 'inProgress', changes: [{ path: '/r/a.js', kind: { type: 'update', move_path: null }, diff: '@@\n-old\n+new\n+more' }, { path: '/r/b.js', kind: { type: 'add' }, diff: 'x\ny\n' }] };
    await s.h.app.request(14, 'fake/notify', { method: 'item/started', params: { threadId: t, turnId: turn.ref.id, item: change } });
    ask(15, 'item/fileChange/requestApproval', { threadId: t, turnId: turn.ref.id, itemId: 'p1', grantRoot: '/r' });
    const edit = await until(() => s.graph.list('EditApproval', { status: 'pending' })[0], 5000, 'the edit approval');
    assert.deepEqual(edit.state.files, [{ path: '/r/a.js', change: 'update', added: 2, removed: 1 }, { path: '/r/b.js', change: 'add', added: 2, removed: 0 }]);
    assert.equal(edit.state.grantRoot, '/r');
    assert.deepEqual(s.graph.related(edit.ref, 'edits').map((x) => x.ref.id), [`${t}:p1:0`, `${t}:p1:1`]);
    ask(16, 'item/fileChange/requestApproval', { threadId: t, turnId: turn.ref.id, itemId: 'p2' });
    const late = await until(() => s.graph.list('EditApproval', { status: 'pending' }).find((x) => x.ref.id !== edit.ref.id), 5000, 'an edit asked first');
    assert.deepEqual(late.state.files, []);
    await s.h.app.request(17, 'fake/notify', { method: 'item/started', params: { threadId: t, turnId: turn.ref.id, item: { ...change, id: 'p2', changes: [{ path: '/r/c.js', kind: { type: 'delete' }, diff: '' }] } } });
    await until(() => s.graph.resolve(late.ref).state.files.length === 1, 5000, 'its files once its step came');
    assert.deepEqual(s.graph.resolve(late.ref).state.files, [{ path: '/r/c.js', change: 'delete' }], 'no diff: no counts');
  } finally { await s.close(); }
});

test('public hooks H5: a mod\'s send with its own settings (put back after its turn starts); each turn says why it started', async () => {
  const s = await setup({ approvals: { ask: async () => ({ approved: true }) } });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const seen = [];
    s.h.mux.client('test:observer').observe({ kinds: ['clientRequest'], methods: ['turn/start', 'thread/settings/update'] }, (m, info) => seen.push([info.method, m.params]));
    // the app's own turn, from its queue
    await s.h.app.request(2, 'turn/start', { threadId: t, turnTrigger: 'composer_queue', input: [{ type: 'text', text: 'queued', text_elements: [] }] });
    const first = await until(() => s.graph.related(refs.thread(t), 'turns')?.find((x) => x.state.trigger), 5000, 'the app\'s turn');
    assert.deepEqual([first.state.trigger, first.state.triggerDetail, first.state.startedBy], ['queue', 'composer_queue', { kind: 'user' }], 'the app\'s queue is the user\'s');
    await until(() => s.graph.related(refs.thread(t), 'turns').every((x) => x.state.status !== 'running'), 5000, 'it ends');
    // a mod's send: its settings ride this turn; the thread's go back after (the fake has no models: model and effort are refused, mode goes)
    const out = await s.graph.invoke({ ref: refs.thread(t), operation: 'send', args: [{ parts: [{ kind: 'text', text: 'hi' }] }, { settings: { effort: 'low' } }], caller: { kind: 'mod', id: 'unit.sender' }, origin: 'test' });
    assert.equal(out.status, 'done', 'no model known here: its efforts are not checked (the app-server judges)');
    assert.equal(seen.filter(([m]) => m === 'turn/start').at(-1)[1].effort, 'low', 'this send\'s effort');
    await until(() => s.graph.related(refs.thread(t), 'turns').every((x) => x.state.status !== 'running'), 5000, 'it ends');
    const sent = await s.graph.invoke({ ref: refs.thread(t), operation: 'send', args: [{ parts: [{ kind: 'text', text: 'plan it' }] }, { settings: { mode: 'plan' } }], caller: { kind: 'mod', id: 'unit.sender' }, origin: 'test' });
    assert.equal(sent.status, 'done');
    const start = seen.filter(([m]) => m === 'turn/start').at(-1)[1];
    assert.equal(start.collaborationMode.mode, 'plan', 'this send\'s mode');
    const turn = await until(() => s.graph.resolve(sent.value)?.state.trigger === 'mod' && s.graph.resolve(sent.value), 5000, 'the mod\'s turn');
    assert.deepEqual([turn.state.triggerBy, turn.state.startedBy], ['unit.sender', { kind: 'mod', id: 'unit.sender' }]);
  } finally { await s.close(); }
});

test('graph-integrity G7.3: the user\'s answer, send and stop through a mod\'s surface are the user\'s, naming the mod they acted through', async () => {
  const s = await setup();
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const viaForm = { kind: 'user', id: 'user', through: 'unit.form' };
    s.h.app.request(10, 'fake/serverRequest', { method: 'item/commandExecution/requestApproval', params: { threadId: t, turnId: 'u1', itemId: 'e1', command: 'touch x', cwd: '/r', availableDecisions: ['accept', 'decline'] }, resolve: true }).catch(() => null);
    const cmd = await until(() => s.graph.list('CommandApproval', { status: 'pending' })[0], 5000, 'the approval');
    assert.equal((await s.graph.invoke({ ref: cmd.ref, operation: 'answer', args: ['accept'], caller: viaForm, origin: 'unit.form' })).status, 'done');
    await until(() => s.graph.resolve(cmd.ref).state.status === 'answered', 5000, 'answered');
    const by = s.graph.resolve(cmd.ref).state.answeredBy;
    assert.deepEqual([by.kind, by.via, by.through, by.id], ['user', 'operation', 'unit.form', undefined], 'the user\'s, through the mod (no mod is its author)');
    const sent = await s.graph.invoke({ ref: refs.thread(t), operation: 'send', args: [{ parts: [{ kind: 'text', text: 'hi' }] }], caller: viaForm, origin: 'unit.form' });
    assert.equal(sent.status, 'done');
    const turn = await until(() => s.graph.resolve(sent.value)?.state.startedBy?.kind === 'user' && s.graph.resolve(sent.value), 5000, 'the user\'s turn');
    assert.deepEqual(turn.state.startedBy, { kind: 'user', through: 'unit.form' });
    // the framework's own pages acting for the user: theirs, through no mod
    await until(() => s.graph.related(refs.thread(t), 'turns').every((x) => x.state.status !== 'running'), 5000, 'it ends');
    const own = await s.graph.invoke({ ref: refs.thread(t), operation: 'send', args: [{ parts: [{ kind: 'text', text: 'again' }] }], caller: { kind: 'framework', id: 'framework' }, origin: null });
    assert.deepEqual((await until(() => s.graph.resolve(own.value)?.state.startedBy?.kind && s.graph.resolve(own.value), 5000, 'the framework\'s turn')).state.startedBy, { kind: 'user' });
  } finally { await s.close(); }
});

test('public hooks H6 (§3.6): a request some mod intercepts `ask` for is held before the app sees it; an answer in its place is the mod\'s (its automatic action, or asked); the chain\'s end shows it', async () => {
  const asked = [];
  const s = await setup({
    approvals: { ask: async (q) => { asked.push(q.action); return { approved: true }; } },
    automaticOf: (modId, id) => (modId === 'unit.ask' && id === 'approve-reads' ? { id, operation: 'Approval.answer', why: 'reads', perHour: 10, where: { display: { $prefix: 'ls' } } } : null),
  });
  try {
    const t = (await s.h.app.request(1, 'thread/start', {})).result.thread.id;
    const ask = (id, itemId, command, actions = []) => s.h.app.request(id, 'fake/serverRequest', { method: 'item/commandExecution/requestApproval', resolve: true,
      params: { threadId: t, turnId: 'u1', itemId, command, cwd: '/r', commandActions: actions, availableDecisions: ['accept', 'acceptForSession', 'decline'] } });
    const appSaw = (itemId) => s.h.app.inbox.some((m) => m.method === 'item/commandExecution/requestApproval' && m.params?.itemId === itemId);
    const reply = (r) => r.result.answer?.result ?? r.result.answer;   // what the server got back
    // nobody intercepts ask: never held
    const plain = ask(10, 'p0', 'ls');
    await s.h.app.waitFor((m) => m.params?.itemId === 'p0', 5000);
    const p0 = await until(() => s.graph.list('CommandApproval', { status: 'pending' })[0], 5000, 'the plain request');
    s.h.app.send({ id: s.h.app.inbox.find((m) => m.params?.itemId === 'p0').id, result: { decision: 'decline' } });
    await plain;
    await until(() => s.graph.resolve(p0.ref).state.status === 'declined', 5000, 'answered by the user');
    const mod = { kind: 'mod', id: 'unit.ask' };
    // a request policy's answer is recorded with the rule it answered by (public-hooks.md §3.6)
    const rule = s.graph.policy('mod:unit.ask', { id: 'no-wget', title: 'Never wget', on: { request: 'CommandApproval' }, where: { command: { $prefix: 'wget' } }, then: { answer: { deny: true } } });
    assert.deepEqual(reply(await ask(9, 'w1', 'wget x')), { decision: 'decline' });
    const w1 = await until(() => s.graph.list('CommandApproval').find((x) => x.state.command === 'wget x' && x.state.status !== 'pending'), 5000, 'the wget');
    assert.deepEqual([w1.state.answeredBy.id, w1.state.answeredBy.via, w1.state.answeredBy.rule], ['unit.ask', 'policy', 'Never wget']);
    rule.dispose();
    const seen = [];
    let late = null;
    s.graph.intercept('mod:unit.ask', 'Approval', 'ask', async (call, next) => {
      const cmd = call.instance.state.display;
      seen.push(cmd);
      if (cmd.includes('denylate')) { await next(); return { deny: true }; }
      if (cmd.includes('later')) { const out = await next(); late = await s.graph.invoke({ ref: call.ref, operation: 'answer', args: ['accept'], caller: mod, automatic: 'approve-reads' }); return out; }
      if (cmd.startsWith('ls')) return s.graph.invoke({ ref: call.ref, operation: 'answer', args: ['accept'], caller: mod, automatic: 'approve-reads' });
      if (cmd.startsWith('rm')) return s.graph.invoke({ ref: call.ref, operation: 'answer', args: ['decline'], caller: mod });
      if (cmd.startsWith('touch')) return s.graph.invoke({ ref: call.ref, operation: 'answer', args: ['accept'], caller: mod });
      if (cmd.startsWith('boom')) throw new Error('the interceptor failed');
      return next();
    }, { replaces: true });
    // a read the mod approves as its automatic action: the app never sees it, the backend has the answer, nobody was asked
    const read = await ask(11, 'h1', "/bin/zsh -lc 'ls -la'", [{ type: 'listFiles', command: 'ls -la', path: '.' }]);
    assert.deepEqual(reply(read), { decision: 'accept' });
    const h1 = await until(() => s.graph.list('CommandApproval').find((x) => x.state.command.includes('ls -la') && x.state.status !== 'pending'), 5000, 'the read');
    assert.deepEqual([h1.state.status, h1.state.answeredBy.kind, h1.state.answeredBy.id], ['answered', 'mod', 'unit.ask']);
    assert.equal(appSaw('h1'), false, 'held: the app never showed it');
    assert.deepEqual(asked, []);
    // denied in its place: no consent needed, never shown
    const denied = await ask(12, 'h2', 'rm -rf build');
    assert.deepEqual(reply(denied), { decision: 'decline' });
    assert.equal(appSaw('h2'), false);
    // approved outside its automatic action: the user is asked (R17), in the mod's words
    const touched = await ask(13, 'h3', 'touch x');
    assert.deepEqual(reply(touched), { decision: 'accept' });
    assert.deepEqual(asked, ['let Codex run “touch x”']);
    assert.equal(appSaw('h3'), false);
    // let through, or an interceptor that fails: shown to the user, who answers as today
    for (const [id, itemId, command] of [[14, 'h4', 'echo hi'], [16, 'h5', 'boom']]) {
      const shown = ask(id, itemId, command);
      const m = await s.h.app.waitFor((x) => x.params?.itemId === itemId, 5000);
      const r = await until(() => s.graph.list('CommandApproval', { status: 'pending' }).find((x) => x.state.command === command), 5000, `${command} pending`);
      s.h.app.send({ id: m.id, result: { decision: 'accept' } });
      assert.deepEqual(reply((await shown)), { decision: 'accept' });
      await until(() => s.graph.resolve(r.ref).state.answeredBy?.kind === 'user', 5000, `${command} answered by the user`);
    }
    // answered first by the user, a mod's later answer is refused as it is: the user is not asked about it first (graph-integrity G6.4)
    const askedBefore = asked.length;
    const answeredFirst = s.graph.list('CommandApproval').find((x) => x.state.command === 'echo hi');
    const lateMod = await s.graph.invoke({ ref: answeredFirst.ref, operation: 'answer', args: ['accept'], caller: mod });
    assert.deepEqual([lateMod.status, asked.length], ['refused', askedBefore]);
    // shown to the user (its next() released it), an automatic answer is refused: it is the user's now (public-hooks.md §3.6)
    const shownLate = ask(17, 'h6', "/bin/zsh -lc 'ls later'", [{ type: 'listFiles', command: 'ls later', path: '.' }]);
    const m6 = await s.h.app.waitFor((x) => x.params?.itemId === 'h6', 5000);
    await until(() => late, 5000, 'the late automatic answer');
    assert.deepEqual([late.status, late.reason], ['refused', 'notAllowed']);
    s.h.app.send({ id: m6.id, result: { decision: 'decline' } });
    assert.deepEqual(reply(await shownLate), { decision: 'decline' }, 'the user\'s answer, not the mod\'s');
    // nor a denial the ask gives after it showed the request: the user answers it
    const shownDeny = ask(18, 'h7', 'cat denylate');
    const m7 = await s.h.app.waitFor((x) => x.params?.itemId === 'h7', 5000);
    s.h.app.send({ id: m7.id, result: { decision: 'accept' } });
    assert.deepEqual(reply(await shownDeny), { decision: 'accept' }, 'the user\'s answer, not the late denial');
    const h7 = await until(() => s.graph.list('CommandApproval').find((x) => x.state.command === 'cat denylate' && x.state.status !== 'pending'), 5000, 'the late deny');
    assert.equal(h7.state.answeredBy.kind, 'user');
    assert.deepEqual(seen, ['ls -la', 'rm -rf build', 'touch x', 'echo hi', 'boom', 'ls later', 'cat denylate']);
    const opened = s.graph.list('CommandApproval').filter((x) => x.state.command === 'echo hi');
    assert.equal(opened.length, 1, 'shown after being held: one request, not two');
  } finally { await s.close(); }
});
