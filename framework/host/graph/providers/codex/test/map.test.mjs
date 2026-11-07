// The protocol-to-graph mapping (providers/codex/map.mjs): the branches the captures do not reach, checked against the native types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { threadStatus, threadWaitingOn, threadOrigin, goalState, tokenUsage, itemData, planData, requestData, requestOptions, optionAnswer, answerOf, answerStatus, questionAnswer, threadData, agentData, modelData, effortLabel, userInput, userContent, refs } from '../map.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';

const g = createGraph();
g.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
const p = g.registerProvider('native', 'codex', { types: { Thread: {}, Turn: {}, Message: {}, Attachment: {}, Mention: {}, Step: {}, PlanTask: {}, Request: {} } });
/** Every mapped instance must fit its type (the store validates state and links). */
const fits = (d) => { p.put(d.ref, { state: d.state, links: d.links }); return g.resolve(d.ref); };

test('map: thread status (waiting on you), origin, goal and usage', () => {
  assert.equal(threadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'waitingForYou');
  assert.equal(threadStatus({ type: 'active', activeFlags: [] }), 'working');
  assert.equal(threadStatus({ type: 'systemError' }), 'error');
  assert.equal(threadStatus({ type: 'notLoaded' }), 'idle');
  // what it waits on: an approval first, then an answer; nothing while it waits on neither
  assert.equal(threadWaitingOn({ type: 'active', activeFlags: ['waitingOnUserInput', 'waitingOnApproval'] }), 'approval');
  assert.equal(threadWaitingOn({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'question');
  assert.equal(threadWaitingOn({ type: 'active', activeFlags: [] }), undefined);
  assert.equal(threadWaitingOn({ type: 'idle' }), undefined);
  assert.equal(threadOrigin({ threadSource: 'automation' }), 'automation');
  assert.equal(threadOrigin({ parentThreadId: 'p' }), 'delegation');
  assert.equal(threadOrigin({ forkedFromId: 'f' }), 'fork');
  // the goal as the source reports it (graph-integrity G1): its own status names and counts, times in ms
  assert.deepEqual(goalState({ objective: 'o', status: 'usageLimited', tokensUsed: 5, tokenBudget: 9, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 }),
    { objective: 'o', status: 'usageLimited', tokensUsed: 5, tokenBudget: 9, timeUsed: 2000, createdAt: 1000, updatedAt: 2000 });
  assert.equal(goalState(null), undefined);
  // a token report as given: every count of the total and of the last request, and the context window; nothing computed
  const report = { total: { inputTokens: 1, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 3 }, last: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 20, cacheWriteInputTokens: 7 }, modelContextWindow: 100 };
  assert.deepEqual(tokenUsage(report), { total: { inputTokens: 1, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 3 },
    last: { inputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 7, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 20 }, modelContextWindow: 100 });
  assert.equal(tokenUsage({}), null);
  const t = fits(threadData({ id: 't', name: null, preview: 'first line\nsecond', status: { type: 'idle' }, createdAt: 10, updatedAt: 11, source: 'vscode', projectId: 'srv-9', model: 'gpt-6-luna',
    cwd: '/r', gitInfo: { branch: 'main', sha: null, originUrl: 'git@x:y' }, sessionId: 'sess', ephemeral: false, modelProvider: 'openai', cliVersion: '1.2', reasoningEffort: 'high', recencyAt: 12, turns: [] }, { project: refs.project('p1') }));
  assert.deepEqual([t.state.title, t.state.createdAt, t.state.source, t.links.project, t.links.model.id], ['first line', 10000, 'vscode', refs.project('p1'), 'gpt-6-luna']);
  assert.deepEqual([t.state.cwd, t.state.gitInfo, t.state.sessionId, t.state.ephemeral, t.state.modelProvider, t.state.cliVersion, t.state.reasoningEffort, t.state.recencyAt],
    ['/r', { branch: 'main', originUrl: 'git@x:y' }, 'sess', false, 'openai', '1.2', 'high', 12000], 'the source\'s own facts under their names');
  // The protocol's projectId is the app-server's id for a project, not the app's: it never makes a link (projects.mjs).
  assert.equal(threadData({ id: 't', status: { type: 'idle' }, createdAt: 1, projectId: 'srv-9', turns: [] }).links.project, undefined);
  // `unread` is the app's own read state, passed in by the source (the protocol has none); it is false unless said to be true.
  const bare = { id: 't', status: { type: 'idle' }, createdAt: 1, turns: [] };
  assert.deepEqual([threadData(bare).state.unread, threadData(bare, { unread: true }).state.unread, threadData(bare, { unread: 'yes' }).state.unread], [false, true, false]);
  // A complete thread/list returns sub-agent and custom threads too, whose source is an object (SessionSource): found natively on 21477.
  const sub = fits(threadData({ ...bare, id: 's1', source: { subAgent: { thread_spawn: { depth: 1, parent_thread_id: 't' } } }, originator: 'codex_desktop', parentThreadId: 't', agentRole: 'explorer' }));
  assert.deepEqual([sub.state.source, sub.state.originator, sub.state.agentRole, sub.state.origin, sub.links.parent.id],
    [{ subAgent: { thread_spawn: { depth: 1, parent_thread_id: 't' } } }, 'codex_desktop', 'explorer', 'delegation', 't'], 'the source as given, never reduced');
  assert.deepEqual(fits(threadData({ ...bare, id: 's2', source: { custom: 'my-tool' } })).state.source, { custom: 'my-tool' });
});

test('map: items to steps and messages (file changes per file, web lookups, tool calls, unknown kinds as plain steps)', () => {
  const edits = itemData('t', 'u', { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.txt' }, { path: 'b.txt' }] });
  assert.deepEqual(edits.map((d) => [d.ref.type, d.links.file.id]), [['FileEdit', 'a.txt'], ['FileEdit', 'b.txt']]);
  edits.forEach(fits);
  assert.equal(fits(itemData('t', 'u', { type: 'webSearch', id: 'w', query: 'q', action: { type: 'openPage', url: 'https://x' } })[0]).ref.type, 'WebLookup');
  assert.equal(fits(itemData('t', 'u', { type: 'webSearch', id: 'w2', query: 'q', action: { type: 'search', query: 'q' }, results: [{ title: 'T', url: 'https://y' }] })[0]).state.results[0].location, 'https://y');
  const tool = fits(itemData('t', 'u', { type: 'mcpToolCall', id: 'm', server: 's', tool: 'echo', status: 'failed', arguments: { a: 1 }, error: { message: 'no' } })[0]);
  assert.deepEqual([tool.ref.type, tool.state.status, tool.state.error, tool.links.tool.id], ['CodexToolCall', 'failed', 'no', 's/echo']);
  assert.deepEqual([tool.state.server, tool.state.toolName, tool.state.arguments], ['s', 'echo', { a: 1 }], 'its arguments as given, not stringified');
  assert.equal(fits(itemData('t', 'u', { type: 'collabAgentToolCall', id: 'c', tool: 'spawn', status: 'completed', receiverThreadIds: ['child'], senderThreadId: 't', agentsStates: {} })[0]).links.child.id, 'child');
  // a kind with no concept keeps its item as given (G1.4)
  const plain = fits(itemData('t', 'u', { type: 'contextCompaction', id: 'x' })[0]);
  assert.deepEqual([plain.ref.type, plain.state.title, plain.state.status, plain.state.itemType, plain.state.item], ['CodexStep', 'Compacted the context', 'done', 'contextCompaction', { type: 'contextCompaction', id: 'x' }]);
  assert.equal(fits(itemData('t', 'u', { type: 'aKindFromTomorrow', id: 'z', extra: 1 })[0]).state.item.extra, 1);
  const run = fits(itemData('t', 'u', { type: 'commandExecution', id: 'e', command: '/bin/zsh -lc ls', cwd: '/', status: 'inProgress', commandActions: [{ type: 'listFiles', command: 'ls' }], processId: 'p9' }, { done: false })[0]);
  assert.deepEqual([run.ref.type, run.state.status, run.state.output, run.state.command, run.state.shellCommand, run.state.commandActions, run.state.processId],
    ['CodexCommandRun', 'running', '', 'ls', '/bin/zsh -lc ls', [{ type: 'listFiles', command: 'ls' }], 'p9']);
  const thinking = fits(itemData('t', 'u', { type: 'reasoning', id: 'r', summary: ['a', 'b'], content: ['raw'] })[0]);
  assert.deepEqual([thinking.ref.type, thinking.state.summaryParts, thinking.state.contentParts, thinking.state.thinking.parts[0].text], ['CodexReasoning', ['a', 'b'], ['raw'], 'a\nb']);
});

test('map: server requests to the request subtypes; requests that are not for the user are not mapped', () => {
  const base = { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1 };
  const net = fits(requestData('item/commandExecution/requestApproval', { ...base, networkApprovalContext: { host: 'example.com' } }, 's:1'));
  assert.deepEqual([net.ref.type, net.state.host], ['NetworkApproval', 'example.com']);
  // the server's own decisions as options, in its order (graph-integrity G1.6)
  const cmd = fits(requestData('item/commandExecution/requestApproval', { ...base, approvalId: 'ap', command: 'ls', cwd: '/', availableDecisions: ['accept', 'acceptForSession', 'cancel'] }, 's:2'));
  assert.deepEqual([cmd.ref.type, cmd.ref.id, cmd.state.options.map((o) => [o.id, o.kind, o.scope ?? null])], ['CodexCommandApproval', 't:ap', [['accept', 'approve', 'once'], ['acceptForSession', 'approve', 'thread'], ['cancel', 'cancel', null]]]);
  assert.deepEqual(cmd.state.availableDecisions, ['accept', 'acceptForSession', 'cancel'], 'as given, on the subtype');
  const cu = fits(requestData('mcpServer/elicitation/request', { threadId: 't', turnId: 'u', serverName: 'cua_repl', _meta: { connector_id: 'computer-use', tool_name: 'get_app_state', tool_params: { app: 'com.apple.finder' }, persist: ['session', 'always'] } }, 's:3'));
  assert.deepEqual([cu.ref.type, cu.links.app.id, cu.state.action, cu.state.options.map((o) => o.id), cu.state.from], ['ComputerUseApproval', 'com.apple.finder', 'get_app_state', ['accept', 'accept:session', 'accept:always', 'decline', 'cancel'], 'tool']);
  const ta = fits(requestData('mcpServer/elicitation/request', { threadId: 't', turnId: 'u', serverName: 'srv', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'echo', tool_params: { x: 1 } } }, 's:4'));
  assert.deepEqual([ta.ref.type, ta.links.tool.id], ['ToolApproval', 'srv/echo']);
  // every prompt, each with its header, choices, whether words are taken and whether they are secret (G1.5)
  const q = fits(requestData('item/tool/requestUserInput', { ...base, isBlocking: false, autoResolutionMs: 60000, questions: [
    { id: 'c', header: 'Color', question: 'Which?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: '' }] },
    { id: 'k', header: 'Key', question: 'Your key?', isOther: true, isSecret: true, options: null }] }, 's:5'));
  assert.deepEqual([q.ref.type, q.state.blocking, q.state.autoResolveAfterMs, q.state.source], ['CodexQuestion', false, 60000, 'requestUserInput']);
  assert.deepEqual(q.state.prompts.map((x) => [x.id, x.header, x.choices.map((c) => c.id), x.other, x.secret]), [['c', 'Color', ['Red', 'Blue'], false, false], ['k', 'Key', [], true, true]]);
  assert.equal(q.state.prompts[0].choices[0].description, 'warm');
  assert.equal(requestData('attestation/generate', { threadId: 't' }, 's:6'), null);
  assert.equal(requestData('item/commandExecution/requestApproval', {}, 's:7'), null, 'no thread, no request');
  assert.equal(answerStatus('x', { decision: 'decline' }), 'declined');
  assert.equal(answerStatus('x', { decision: 'cancel' }), 'cancelled');
  assert.equal(answerStatus('x', { action: 'accept' }), 'answered');
});

test('map: the agent is a constant that says whether it is available; a model keeps its slug, its levels get names and a hidden one is not available', () => {
  const up = fits(agentData());
  assert.deepEqual([up.ref.type, up.ref.id, up.state], ['CodexAgent', 'codex', { name: 'Codex', icon: 'codex', available: true }]);
  assert.equal(agentData({ available: true, reason: 'not shown while it works' }).state.unavailableReason, undefined);
  const down = fits(agentData({ available: false, reason: 'The Codex app-server stopped' }));
  assert.deepEqual([down.state.available, down.state.unavailableReason], [false, 'The Codex app-server stopped']);
  assert.equal(agentData({ available: false }).state.unavailableReason, undefined, 'a reason is optional');

  const m = fits(modelData({
    id: 'catalog-id', model: 'gpt-x', displayName: 'GPT X', description: 'The best', hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'fast' }, { reasoningEffort: 'low', description: 'again' }, { reasoningEffort: 'xhigh', description: '' }, { description: 'no id' }],
  }));
  assert.deepEqual([m.ref.type, m.ref.id, m.links.agent.id], ['Model', 'gpt-x', 'codex'], 'the model slug is the id: it is what a thread reports as its model');
  assert.deepEqual(m.state, { name: 'GPT X', description: 'The best', efforts: [{ id: 'low', label: 'Light' }, { id: 'xhigh', label: 'Extra High' }], default: true, available: true });
  const hidden = fits(modelData({ id: 'only-id', hidden: true, isDefault: false, supportedReasoningEfforts: [] }));
  assert.deepEqual([hidden.ref.id, hidden.state.name, hidden.state.description, hidden.state.efforts, hidden.state.available], ['only-id', 'only-id', '', [], false], 'no model slug: the id; no name: the id');
  // what a message to it may hold (H5x): the catalog's input modalities, the graph's two kinds only
  assert.deepEqual(modelData({ model: 'seeing', inputModalities: ['text', 'image', 'audio', 'image'] }).state.inputs, ['text', 'image']);
  assert.equal(modelData({ model: 'plain' }).state.inputs, undefined, 'none said: none put');
  assert.equal(modelData({}), null);
  assert.equal(modelData(null), null);
  assert.deepEqual(['none', 'minimal', 'medium', 'high', 'max', 'someNewLevel', 'deep-think'].map(effortLabel), ['None', 'Minimal', 'Medium', 'High', 'Max', 'Some new level', 'Deep think']);
  assert.equal(effortLabel('toString'), 'To string', 'an id is never looked up on the prototype');
});

test('map: an option is answered as the server takes it, per request kind; a question per prompt; answers become a request\'s status', () => {
  assert.deepEqual(optionAnswer('item/fileChange/requestApproval', {}, 'acceptForSession'), { decision: 'acceptForSession' });
  assert.deepEqual(optionAnswer('item/commandExecution/requestApproval', {}, 'decline'), { decision: 'decline' });
  // a proposed rule is answered as the server proposed it, untouched
  const proposed = { proposedExecpolicyAmendment: ['npm', 'test'], proposedNetworkPolicyAmendments: [{ host: 'a.dev', action: 'allow' }, { host: 'b.dev', action: 'deny' }] };
  assert.deepEqual(requestOptions('item/commandExecution/requestApproval', proposed).map((o) => [o.id, o.kind, o.scope ?? null]),
    [['accept', 'approve', 'once'], ['acceptForSession', 'approve', 'thread'], ['acceptWithExecpolicyAmendment', 'approve', 'always'],
      ['applyNetworkPolicyAmendment:3', 'approve', 'always'], ['applyNetworkPolicyAmendment:4', 'deny', 'always'], ['decline', 'deny', null], ['cancel', 'cancel', null]]);
  assert.deepEqual(optionAnswer('item/commandExecution/requestApproval', proposed, 'acceptWithExecpolicyAmendment'), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } } });
  assert.deepEqual(optionAnswer('item/commandExecution/requestApproval', proposed, 'applyNetworkPolicyAmendment:4'), { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'b.dev', action: 'deny' } } } });
  assert.equal(optionAnswer('item/commandExecution/requestApproval', {}, 'acceptWithExecpolicyAmendment'), null, 'not offered: not sent');
  const perms = { network: { enabled: true } };
  assert.deepEqual(optionAnswer('item/permissions/requestApproval', { permissions: perms }, 'grant:session'), { permissions: perms, scope: 'session' });
  assert.deepEqual(optionAnswer('item/permissions/requestApproval', { permissions: perms }, 'decline'), { permissions: {} });
  assert.deepEqual(optionAnswer('mcpServer/elicitation/request', { _meta: { persist: ['session'] } }, 'accept:session'), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.equal(optionAnswer('item/tool/requestUserInput', {}, 'accept'), null);
  // what was answered, with the option
  assert.deepEqual(answerOf('item/commandExecution/requestApproval', { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } } }, proposed),
    { decision: 'approved', scope: 'always', option: 'acceptWithExecpolicyAmendment' });
  assert.deepEqual(answerOf('item/commandExecution/requestApproval', { decision: 'decline' }, {}), { decision: 'denied', option: 'decline' });
  // a question: each prompt's own answer by its id, choices by their labels, then the words; a prompt or choice it lacks is refused
  const prompts = [{ id: 'a', choices: [{ id: 'X', label: 'X' }], other: true }, { id: 'b', choices: [], other: false }];
  assert.deepEqual(questionAnswer({}, prompts, { a: { choices: ['X'], text: 'free' } }), { answers: { a: { answers: ['X', 'free'] } } });
  assert.equal(questionAnswer({}, prompts, { b: { text: 'words' } }), null, 'b takes no words');
  assert.equal(questionAnswer({}, prompts, { c: { text: 'x' } }), null, 'no prompt c');
  assert.deepEqual(['accept', 'decline', 'cancel'].map((d) => answerStatus('CommandApproval', { decision: d })), ['answered', 'declined', 'cancelled']);
  assert.equal(answerStatus('Approval', { permissions: {} }), 'declined', 'nothing granted');
});

test('map: a user message\'s attachments and mentions are instances it lists; a task list is a Plan with its tasks; computer use is a ComputerAction', () => {
  const [msg, image, audio, app, skill, file] = itemData('t', 'u', { type: 'userMessage', id: 'm', content: [
    { type: 'text', text: 'look' }, { type: 'localImage', path: '/tmp/shot.png' }, { type: 'audio', url: 'https://x/a.mp3' },
    { type: 'mention', name: 'Figma', path: 'app://figma' }, { type: 'skill', name: 'review', path: '/skills/review' }, { type: 'mention', name: 'notes', path: '/tmp/notes.md' },
  ] });
  for (const d of [msg, image, audio, app, skill, file]) fits(d);
  assert.deepEqual(msg.links.attachments.map((x) => x.id), [image.ref.id, audio.ref.id]);
  assert.deepEqual(msg.links.mentions.map((x) => x.id), [app.ref.id, skill.ref.id, file.ref.id]);
  assert.deepEqual([image.state.name, image.state.kind, image.links.message.id, image.links.file.id], ['shot.png', 'image', msg.ref.id, '/tmp/shot.png']);
  assert.deepEqual([audio.state.kind, audio.state.name], ['file', 'a.mp3']);
  assert.deepEqual([app.state.target.type, app.state.target.id, skill.state.target.type, file.state.target.type], ['Plugin', 'figma', 'Skill', 'File']);
  assert.deepEqual(skill.state.target, refs.skill('/skills/review'), 'a Skill by its SKILL.md, as the skills area names it');
  const [plan, ...tasks] = planData('t', 'u', { explanation: 'Fix it', plan: [{ step: 'read', status: 'completed' }, { step: 'edit', status: 'inProgress' }, { step: 'test', status: 'pending' }] });
  for (const d of [plan, ...tasks]) fits(d);
  assert.deepEqual([plan.ref.type, plan.state.title, plan.state.status], ['Plan', 'Fix it', 'running']);
  assert.deepEqual(tasks.map((x) => [x.state.text, x.state.status, x.links.plan.id]), [['read', 'done', plan.ref.id], ['edit', 'inProgress', plan.ref.id], ['test', 'pending', plan.ref.id]]);
  assert.equal(planData('t', 'u', { plan: [{ step: 'a', status: 'completed' }] })[0].state.status, 'done', 'every task done: the plan is done');
  const act = fits(itemData('t', 'u', { type: 'mcpToolCall', id: 'c', server: 'computer-use', tool: 'click', status: 'completed', arguments: { app: 'com.apple.finder' } })[0]);
  assert.deepEqual([act.ref.type, act.state.action, act.links.app.id], ['ComputerAction', 'click', 'com.apple.finder']);
  // The unified path: every cua_repl js call, before its result too (the type never changes); the app from the result's surface.
  const running = fits(itemData('t', 'u', { type: 'mcpToolCall', id: 'r', server: 'cua_repl', tool: 'js', status: 'inProgress', arguments: { code: '1' }, result: null })[0]);
  assert.deepEqual([running.ref.type, running.state.title, running.links.app, running.links.session.id], ['ComputerAction', 'Used the computer', null, 't']);
  const surface = { _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { kind: 'appId', appId: 'com.apple.calculator' } } } };
  const used = fits(itemData('t', 'u', { type: 'mcpToolCall', id: 'r', server: 'cua_repl', tool: 'js', status: 'completed', arguments: { code: '1' }, result: surface })[0]);
  assert.deepEqual([used.ref.id, used.state.title, used.links.app.id], [running.ref.id, 'Used com.apple.calculator', 'com.apple.calculator']);
});

test('userInput: content a mod sends as the app\'s input: text with code, links and file links, then the mentioned files, folders and skills', () => {
  const file = { type: 'File', provider: 'codex', id: '/r/src/a.js' };
  const folder = { type: 'Folder', provider: 'codex', id: '/r/src' };
  const skill = { type: 'Skill', provider: 'codex', id: '/h/skills/review/SKILL.md' };
  const input = userInput({ parts: [
    { kind: 'text', text: 'Look at ' }, { kind: 'mention', target: file }, { kind: 'text', text: ' and ' }, { kind: 'mention', target: folder, label: 'the src folder' },
    { kind: 'code', language: 'js', text: 'x()' }, { kind: 'link', url: 'https://x.dev', text: 'docs' }, { kind: 'fileLink', path: '/r/b.js', line: 3 },
    { kind: 'mention', target: skill }, { kind: 'mention', target: { type: 'Thread', provider: 'codex', id: 't1' }, label: 'old chat' }, { kind: 'image', source: '/tmp/a.png' },
  ] });
  assert.deepEqual(input, [
    { type: 'text', text: 'Look at @a.js and @the src folder\n```js\nx()\n```\n[docs](https://x.dev)/r/b.js:3@review@old chat', text_elements: [] },
    { type: 'mention', name: 'a.js', path: '/r/src/a.js' },
    { type: 'mention', name: 'the src folder', path: '/r/src' },
    { type: 'skill', name: 'review', path: '/h/skills/review/SKILL.md' },
  ]);
  assert.deepEqual(userInput({ parts: [{ kind: 'text', text: '  ' }] }), []);
  assert.deepEqual(userInput(null), []);
  assert.deepEqual(userContent(userInput({ parts: [{ kind: 'text', text: 'hi' }] })), { parts: [{ kind: 'text', text: 'hi' }] }, 'and back');
});
