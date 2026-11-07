// Tests of the native type library: its structure (order, ids, inverses, enums) and a spot check of the cards in docs/graph/02-types.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANY_TYPE, toDescriptor } from '../define.mjs';
import { NATIVE_TYPES } from './index.mjs';
import { PRESENTATION_TYPES } from '../presentations.mjs';
import { FRAMEWORK_TYPES } from '../framework.mjs';

const descriptors = NATIVE_TYPES.map(toDescriptor);
const byId = new Map(descriptors.map((d) => [d.id, d]));
// The presentation types are a library of their own that a native relation may name (App.windows, App.openWindow's Window).
const others = new Map([...PRESENTATION_TYPES, ...FRAMEWORK_TYPES].map(toDescriptor).map((d) => [d.id, d]));   // targets kept elsewhere (a Setting's Mod)
const known = (id) => byId.has(id) || others.has(id);
const get = (id) => byId.get(id) ?? others.get(id);

/** Relation and ref targets the library keeps by id although their types are not defined yet (docs/graph/02-types.md). */
const NOT_YET = new Set(['AccessRule']);

/** A type and its ancestors, the type first. */
function chain(id) {
  const out = [];
  for (let d = get(id); d; d = d.parent === null ? undefined : get(d.parent)) out.push(d);
  return out;
}
/** A member by name in the type or the nearest ancestor that has it. */
function member(id, section, name) {
  for (const d of chain(id)) if (d.spec[section]?.[name]) return d.spec[section][name];
  return undefined;
}
function* schemasOf(descriptor) {
  const { spec } = descriptor;
  for (const f of Object.values(spec.state ?? {})) yield f.schema;
  for (const o of Object.values(spec.operations ?? {})) { yield* o.args; if (o.returns) yield o.returns; }
  for (const e of Object.values(spec.events ?? {})) if (e.payload) yield e.payload;
}
function* walk(schema) {
  yield schema;
  if (schema.t === 'list') yield* walk(schema.of);
  if (schema.t === 'object') for (const f of Object.values(schema.fields)) yield* walk(f.schema);
}

const EXPECTED = [
  'Agent', 'CodexAgent', 'Model',
  'Thread', 'CodexThread', 'Turn', 'CodexTurn', 'Message', 'UserMessage', 'Attachment', 'Mention', 'AgentMessage', 'Draft', 'QueuedMessage',
  'Step', 'Reasoning', 'PlanTask', 'Plan', 'CommandRun', 'FileEdit', 'Search', 'WebLookup', 'ToolCall', 'ComputerAction', 'Delegation',
  'CodexCommandRun', 'CodexToolCall', 'CodexReasoning', 'CodexStep',
  'Request', 'Approval', 'CommandApproval', 'CodexCommandApproval', 'EditApproval', 'NetworkApproval', 'ToolApproval', 'ComputerUseApproval', 'Question', 'CodexQuestion',
  'Project', 'LocalProject', 'Folder', 'File', 'ExternalApp',
  'Environment', 'LocalEnvironment', 'WorktreeEnvironment', 'CloudEnvironment', 'Repository', 'GitRepository', 'Branch', 'Instructions', 'CodexInstructions',
  'Command', 'ProjectAction', 'SlashCommand', 'Shortcut',
  'App', 'Theme', 'Update', 'Setting', 'SettingsSection', 'Account', 'ChatGPTAccount', 'Usage', 'CodexUsage',
  'ToolServer', 'Tool', 'Plugin', 'Skill',
  'ChangeSet', 'FileChange', 'Hunk', 'Comment', 'Review', 'Finding', 'Commit', 'PullRequest', 'GitHubPullRequest',
  'Terminal', 'BrowserTab', 'ComputerUseSession', 'Automation', 'Notification',
];

test('the library has the C2 types, with unique ids', () => {
  assert.equal(NATIVE_TYPES.length, 84);
  assert.deepEqual(new Set(NATIVE_TYPES.map((d) => d.id)), new Set(EXPECTED));
  assert.equal(new Set(NATIVE_TYPES.map((d) => d.id)).size, NATIVE_TYPES.length);
  assert.ok(Object.isFrozen(NATIVE_TYPES));
  for (const value of ['Content', 'Path', 'Duration', 'Url', 'Image', 'Time']) assert.ok(!byId.has(value), `${value} is a value, not a type`);
});

test('a concept has no parent, and a subtype comes after its parent', () => {
  const seen = new Set();
  for (const d of descriptors) {
    if (d.kind === 'concept') assert.equal(d.parent, null, d.id);
    else {
      assert.equal(d.kind, 'subtype');
      assert.ok(seen.has(d.parent), `${d.id}: parent ${d.parent} is defined earlier`);
    }
    seen.add(d.id);
  }
  assert.deepEqual(
    descriptors.filter((d) => d.kind === 'concept').map((d) => d.id),
    ['Agent', 'Model', 'Thread', 'Turn', 'Message', 'Attachment', 'Mention', 'Draft', 'QueuedMessage', 'Step', 'PlanTask', 'Request', 'Project', 'Folder', 'File', 'ExternalApp', 'Environment', 'Repository', 'Branch', 'Instructions', 'Command', 'Shortcut', 'App', 'Theme', 'Update', 'Setting', 'SettingsSection', 'Account', 'Usage', 'ToolServer', 'Tool', 'Plugin', 'Skill',
      'ChangeSet', 'FileChange', 'Hunk', 'Comment', 'Review', 'Finding', 'Commit', 'PullRequest', 'Terminal', 'BrowserTab', 'ComputerUseSession', 'Automation', 'Notification'],
  );
  assert.equal(get('CodexAgent').parent, 'Agent');
  assert.equal(get('ToolApproval').parent, 'Approval');
  assert.equal(get('Approval').parent, 'Request');
  assert.equal(get('Plan').parent, 'Step');
});

test('every descriptor is JSON-serializable and frozen', () => {
  for (const d of descriptors) {
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d, d.id);
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.spec), d.id);
  }
});

test('a subtype only adds: no member name repeats along a chain', () => {
  for (const d of descriptors) {
    const names = [];
    for (const c of chain(d.id)) for (const section of ['state', 'relations', 'operations']) names.push(...Object.keys(c.spec[section] ?? {}));
    assert.equal(new Set(names).size, names.length, `${d.id}: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  }
});

test('every relation target is a library type or a type kept by id, and every inverseOf points back', () => {
  for (const d of descriptors) {
    for (const [name, rel] of Object.entries(d.spec.relations ?? {})) {
      const where = `${d.id}.${name}`;
      // a list names concepts (G3.3): each a library type or one kept by id
      for (const target of Array.isArray(rel.target) ? rel.target : [rel.target]) assert.ok(known(target) || NOT_YET.has(target), `${where}: unknown target ${target}`);
      if (rel.inverseOf === undefined) continue;
      assert.ok(rel.cardinality === 'many' || rel.cardinality === 'maybe', `${where}: a derived relation is many or maybe (a derived one is never required)`);
      assert.ok(known(rel.target), `${where}: the inverse is declared only where the target is in a library`);
      const back = member(rel.target, 'relations', rel.inverseOf);
      assert.ok(back, `${where}: ${rel.target} has no relation ${rel.inverseOf}`);
      assert.ok(back.cardinality === 'one' || back.cardinality === 'maybe', `${where}: ${rel.target}.${rel.inverseOf} is ${back.cardinality}`);
      assert.ok(back.target === ANY_TYPE || chain(d.id).some((c) => (Array.isArray(back.target) ? back.target.includes(c.id) : c.id === back.target)), `${where}: ${rel.target}.${rel.inverseOf} points at ${back.target}, not back at ${d.id}`);
      assert.equal(back.inverseOf, undefined, `${where}: the other side is not itself derived`);
    }
  }
});

test('every ref in an argument, result, payload or field names a known type', () => {
  for (const d of descriptors) {
    for (const schema of schemasOf(d)) {
      for (const s of walk(schema)) if (s.t === 'ref') assert.ok(known(s.to) || NOT_YET.has(s.to), `${d.id}: ref to ${s.to}`);
    }
  }
});

test('every enum has values, and no value repeats', () => {
  let enums = 0;
  for (const d of descriptors) {
    for (const schema of schemasOf(d)) {
      for (const s of walk(schema)) {
        if (s.t !== 'enum') continue;
        enums++;
        assert.ok(s.values.length > 0, `${d.id}: empty enum`);
        assert.equal(new Set(s.values).size, s.values.length, `${d.id}: ${s.values}`);
      }
    }
  }
  assert.ok(enums > 10);
});

test('every summary names state fields of the type or of an ancestor', () => {
  for (const d of descriptors) {
    if (!d.spec.summary) continue;
    for (const [slot, name] of Object.entries(d.spec.summary)) assert.ok(member(d.id, 'state', name), `${d.id}.summary.${slot}: ${name}`);
  }
  for (const concept of ['Agent', 'Model', 'Thread', 'Turn', 'Message', 'Draft', 'Step', 'PlanTask', 'Request']) assert.ok(get(concept).spec.summary, `${concept} has a summary`);
});

test('only Thread is searchable and mentionable', () => {
  assert.deepEqual(descriptors.filter((d) => d.spec.searchable).map((d) => d.id), ['Thread']);
  assert.deepEqual(descriptors.filter((d) => d.spec.mentionable).map((d) => d.id), ['Thread']);
});

test('containment: owned parts are marked and derived from the part\'s own relation', () => {
  const owned = descriptors.flatMap((d) => Object.entries(d.spec.relations ?? {}).filter(([, rel]) => rel.owned).map(([name]) => `${d.id}.${name}`));
  assert.deepEqual(owned.sort(), ['Plan.tasks', 'Thread.queue', 'Thread.requests', 'Thread.turns', 'Turn.answer', 'Turn.input', 'Turn.steps']);
  // The two sides of an agent's links: written once, from the model and from the thread.
  const agent = get('Agent').spec.relations, codex = get('CodexAgent').spec.relations;
  assert.deepEqual([codex.models.target, codex.models.cardinality, codex.models.inverseOf], ['Model', 'many', 'agent']);
  assert.deepEqual([agent.threads.target, agent.threads.cardinality, agent.threads.inverseOf], ['Thread', 'many', 'agent']);
  const turns = get('Thread').spec.relations.turns;
  assert.deepEqual([turns.target, turns.cardinality, turns.owned, turns.inverseOf], ['Turn', 'many', true, 'thread']);
  assert.equal(get('Turn').spec.relations.steps.inverseOf, 'turn');
  assert.equal(get('Turn').spec.relations.input.inverseOf, 'turn');
  assert.equal(get('Thread').spec.relations.requests.inverseOf, 'thread');
  assert.equal(get('Thread').spec.relations.children.inverseOf, 'parent');
  assert.equal(get('Plan').spec.relations.tasks.inverseOf, 'plan');
  assert.equal(get('Turn').spec.relations.requests.owned, false);
});

test('card spot check: Thread', () => {
  const { state, relations, operations, events } = get('Thread').spec;
  assert.deepEqual(state.title, { member: 'state', schema: { t: 'string' }, tier: 'core' });
  // Codex's own (docs/design/graph-boundary.md B3): on CodexThread, not the concept's core
  for (const name of ['goal', 'context', 'usage', 'client']) assert.equal(state[name], undefined, name);
  assert.deepEqual(state.status.schema.values, ['idle', 'working', 'waitingForYou', 'error']);
  assert.deepEqual(state.origin.schema.values, ['user', 'fork', 'delegation', 'automation']);
  for (const name of ['preview', 'pinned']) assert.equal(state[name].tier, 'optional', name);
  for (const name of ['title', 'status', 'unread', 'archived', 'origin', 'createdAt', 'updatedAt']) assert.equal(state[name].tier, 'core', name);
  assert.deepEqual(operations.fork, {
    member: 'operation', args: [{ t: 'ref', to: 'Turn' }, { t: 'json' }], minArgs: 0, returns: { t: 'ref', to: 'Thread' }, tier: 'optional',
  });
  assert.deepEqual(operations.send.returns, { t: 'ref', to: 'Turn' });
  assert.deepEqual(operations.send.args, [{ t: 'content' }, { t: 'json' }], 'the options are the provider\'s own');
  assert.equal(operations.send.tier, 'core');
  for (const name of ['stop', 'rename', 'archive', 'restore', 'markRead', 'open']) assert.equal(operations[name].tier, 'core', name);
  for (const name of ['steer', 'enqueue', 'fork', 'delete', 'compact', 'setModel', 'review', 'pin', 'unpin', 'export']) {
    assert.equal(operations[name].tier, 'optional', name);
  }
  assert.deepEqual(relations.project, { member: 'relation', target: 'Project', cardinality: 'maybe', tier: 'core', owned: false });
  assert.equal(relations.agent.cardinality, 'one');
  assert.equal(relations.model.tier, 'optional');
  assert.equal(relations.queue.target, 'QueuedMessage');
  assert.deepEqual(Object.keys(events), ['created', 'titleChanged', 'statusChanged', 'turnStarted', 'turnFinished', 'requestOpened', 'archived', 'restored', 'deleted']);
  assert.deepEqual(events.turnStarted.payload, { t: 'ref', to: 'Turn' });
  assert.deepEqual(get('Thread').spec.summary, { title: 'title', subtitle: 'preview', status: 'status', time: 'updatedAt' });
});

test('card spot check: CodexThread, Turn, Message', () => {
  const codex = get('CodexThread').spec;
  // the source's own facts under its own names (graph-integrity G1), every one optional, and its reports as events
  assert.deepEqual(Object.keys(codex.state), ['cloudTask', 'cwd', 'gitInfo', 'sessionId', 'ephemeral', 'modelProvider', 'reasoningEffort', 'cliVersion', 'source',
    'originator', 'threadSource', 'agentNickname', 'agentRole', 'recencyAt', 'usage', 'goal']);
  for (const name of Object.keys(codex.state)) assert.equal(codex.state[name].tier, 'optional', name);
  assert.deepEqual(Object.keys(codex.state.usage.schema.fields), ['total', 'last', 'modelContextWindow']);
  assert.deepEqual(Object.keys(codex.state.usage.schema.fields.total.schema.fields), ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']);
  assert.deepEqual(Object.keys(codex.state.goal.schema.fields), ['objective', 'status', 'tokensUsed', 'tokenBudget', 'timeUsed', 'createdAt', 'updatedAt']);
  assert.deepEqual(codex.state.goal.schema.fields.status.schema.values, ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
  // G3.5: its resume as the source's act (mechanism), the app's own held for interceptors
  assert.deepEqual(Object.keys(codex.operations), ['setGoal', 'clearGoal', '_resume']);
  for (const name of ['setGoal', 'clearGoal']) assert.equal(codex.operations[name].tier, 'optional', name);
  assert.deepEqual(Object.keys(codex.events), ['tokenUsageReported', 'compacted', 'reverted', 'hookStarted', 'hookCompleted', 'guardianWarning', 'warning', 'predicted']);
  const turn = get('Turn').spec;
  assert.deepEqual(turn.relations.thread, { member: 'relation', target: 'Thread', cardinality: 'one', tier: 'core', owned: false });
  assert.equal(turn.state.endedAt.tier, 'optional');
  assert.equal(turn.state.error.tier, 'optional');
  assert.deepEqual([turn.state.startedBy.tier, turn.state.startedBy.schema.fields.kind.schema.values], ['core', ['user', 'app', 'mod', 'agent', 'unknown']]);
  for (const gone of ['usage', 'trigger', 'triggerBy', 'triggerDetail']) assert.equal(turn.state[gone], undefined, gone);
  const codexTurn = get('CodexTurn');
  assert.equal(codexTurn.parent, 'Turn');
  assert.deepEqual(Object.keys(codexTurn.spec.state), ['trigger', 'triggerBy', 'triggerDetail', 'errorInfo', 'durationMs', 'rootTurnId', 'diff']);
  assert.deepEqual(Object.keys(codexTurn.spec.events), ['errored', 'modelRerouted', 'verified', 'approvalReviewStarted', 'approvalReviewCompleted', 'strictReviewRequired', 'safetyBuffering', 'moderated']);
  assert.equal(turn.operations.copy.tier, 'core');
  assert.equal(turn.operations.retry.tier, 'optional');
  assert.deepEqual(turn.operations.rewind.args, [{ t: 'content' }]);
  assert.equal(turn.operations.rewind.minArgs, 0);
  assert.deepEqual(Object.keys(turn.events), ['started', 'stepAdded', 'completed', 'stopped', 'failed']);
  assert.equal(get('Message').spec.state.content.schema.t, 'content');
  assert.equal(get('Message').spec.relations.turn.cardinality, 'one');
  assert.deepEqual(get('AgentMessage').spec.state.phase.schema.values, ['update', 'final']);
  assert.equal(get('UserMessage').spec.state.steering.schema.t, 'boolean');
});

test('card spot check: Step and its subtypes', () => {
  const step = get('Step').spec;
  assert.deepEqual(step.state.status.schema.values, ['running', 'done', 'failed', 'cancelled', 'waitingForYou']);
  assert.deepEqual(Object.keys(step.operations), ['_expand', '_collapse', 'copy']);
  assert.equal(step.state._expanded.tier, 'optional', 'UI state');
  assert.equal(step.relations.request.cardinality, 'maybe');
  const run = get('CommandRun');
  assert.equal(run.parent, 'Step');
  assert.deepEqual(run.spec.state.command, { member: 'state', schema: { t: 'string' }, tier: 'core' });
  assert.equal(run.spec.state.exitCode.tier, 'optional');
  assert.equal(run.spec.state.duration.tier, 'optional');
  assert.deepEqual(['copyCommand', 'copyOutput', 'stop', 'openInTerminal'].map((n) => run.spec.operations[n].tier), ['core', 'core', 'optional', 'optional']);
  assert.deepEqual(get('PlanTask').spec.state.status.schema.values, ['pending', 'inProgress', 'done']);
  assert.equal(get('PlanTask').spec.relations.plan.target, 'Plan');
  assert.deepEqual(get('Search').spec.state.scope.schema.values, ['files', 'web']);
  assert.equal(get('Search').spec.state.results.schema.t, 'list');
  assert.equal(get('WebLookup').spec.state.url.schema.t, 'url');
  assert.equal(get('ToolCall').spec.relations.tool.target, 'Tool');
  assert.equal(get('ToolCall').spec.state.output.tier, 'optional');
  assert.equal(get('ComputerAction').spec.state.screenshot.tier, 'optional');
  assert.equal(get('ComputerAction').spec.relations.session.cardinality, 'one');
  assert.equal(get('Delegation').spec.relations.child.target, 'Thread');
  assert.equal(get('Delegation').spec.relations.agent.tier, 'optional');
  assert.equal(get('FileEdit').spec.relations.change.target, 'FileChange');
  assert.deepEqual(Object.keys(get('Plan').spec.events), ['tasksChanged']);
});

test('card spot check: Request, Approval and Question', () => {
  const request = get('Request').spec;
  assert.deepEqual(request.state.status.schema.values, ['pending', 'answered', 'declined', 'expired', 'cancelled']);
  assert.deepEqual(request.state.from.schema.values, ['agent', 'tool']);
  assert.equal(request.state.answeredAt.tier, 'optional');
  assert.equal(request.relations.thread.cardinality, 'one');
  assert.equal(request.relations.step.cardinality, 'maybe');
  const approval = get('Approval').spec;
  // the provider's own options, each approving (of a scope) or declining, and one answer that picks one (graph-integrity G1.6)
  assert.deepEqual(Object.keys(approval.state.options.schema.of.fields), ['id', 'label', 'kind', 'scope']);
  assert.deepEqual(approval.state.options.schema.of.fields.kind.schema.values, ['approve', 'deny', 'cancel']);
  assert.equal(approval.state.reason.tier, 'optional');
  assert.deepEqual(Object.keys(approval.operations), ['answer']);
  assert.deepEqual([approval.operations.answer.args, approval.operations.answer.minArgs], [[{ t: 'string' }, { t: 'content' }], 1]);
  assert.equal(approval.relations.rule.cardinality, 'maybe');
  assert.deepEqual(Object.keys(get('CommandApproval').spec.state), ['command', 'directory', 'display']);
  assert.equal(get('CodexCommandApproval').parent, 'CommandApproval');
  assert.deepEqual(Object.keys(get('CodexCommandApproval').spec.state), ['commandActions', 'availableDecisions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments',
    'networkApprovalContext', 'approvalId', 'itemId']);
  assert.deepEqual(get('EditApproval').spec.state.files.schema.of.t, 'object');
  assert.equal(get('EditApproval').spec.relations.edits.cardinality, 'many');
  assert.equal(get('NetworkApproval').spec.state.host.schema.t, 'string');
  assert.equal(member('ToolApproval', 'relations', 'tool').cardinality, 'maybe');
  assert.equal(get('ComputerUseApproval').spec.relations.app.target, 'ExternalApp');
  // every prompt the source asked, answered by its id (G1.5)
  const question = get('Question').spec;
  assert.deepEqual(Object.keys(question.state), ['prompts', 'blocking', 'autoResolveAfterMs']);
  assert.deepEqual(Object.keys(question.state.prompts.schema.of.fields), ['id', 'header', 'prompt', 'choices', 'other', 'secret']);
  assert.deepEqual(question.operations.answer.args[0].t, 'record');
  assert.equal(question.operations.answer.minArgs, 1);
  assert.equal(question.operations.skip.tier, 'core');
  assert.deepEqual([get('CodexQuestion').parent, get('CodexQuestion').spec.state.source.schema.values], ['Question', ['requestUserInput', 'elicitation']]);
});

test('the card members that had to be renamed are where the comments say', () => {
  assert.ok(member('Reasoning', 'state', 'thinking'));
  assert.ok(!member('Reasoning', 'state', 'summary'));
  assert.ok(member('WebLookup', 'state', 'pageTitle'));
  assert.equal(member('WebLookup', 'state', 'title').schema.t, 'string', 'the inherited step title');
  assert.ok(member('Thread', 'operations', 'enqueue'));
  assert.equal(member('Thread', 'relations', 'queue').cardinality, 'many');
});

test('card spot check: Agent and CodexAgent', () => {
  const { state, relations, operations, events, summary } = get('Agent').spec;
  assert.deepEqual(Object.keys(state), ['name', 'icon', 'available', 'unavailableReason']);
  for (const name of ['name', 'icon', 'available']) assert.equal(state[name].tier, 'core', name);
  assert.equal(state.unavailableReason.tier, 'optional');
  assert.equal(state.icon.schema.t, 'string', 'an Image is a string: a symbol name or a url, never a color');
  // the core is what shared surfaces need of any agent (docs/design/graph-boundary.md B3)
  assert.deepEqual(Object.keys(relations), ['threads']);
  assert.deepEqual(Object.keys(operations), ['newThread', 'newAutomation']);
  assert.deepEqual(operations.newThread, { member: 'operation', args: [{ t: 'json' }], minArgs: 1, returns: { t: 'json' }, tier: 'core' }, 'a Draft or a spec; the Thread or, unsent, the Draft');
  assert.deepEqual(Object.keys(events), ['availabilityChanged']);
  assert.deepEqual(summary, { title: 'name', icon: 'icon' });   // 04 §8: an agent's summary carries its icon
  assert.equal(get('Agent').spec.searchable, undefined);
  // CodexAgent adds what Codex's agent is made of; its thread settings are Settings reached through CodexAgent.settings.
  const codex = get('CodexAgent').spec;
  assert.deepEqual(Object.keys(codex.relations), ['models', 'account', 'accounts', 'startAccount', 'settings', 'instructions', 'skills', 'toolServers', 'plugins']);
  assert.deepEqual(Object.values(codex.relations).map((rel) => rel.cardinality), ['many', 'maybe', 'many', 'maybe', 'many', 'many', 'many', 'many', 'many']);
  assert.deepEqual([codex.relations.accounts.tier, codex.relations.startAccount.tier], ['optional', 'optional'], 'several accounts (RM10)');
  // G3.5: a thread's start and the session's skill roots as the source's acts (mechanism), the app's own held for interceptors
  assert.deepEqual(Object.keys(codex.operations), ['addToolServer', 'addSkill', 'addAccount', 'setStartAccount', '_startThread', '_setSkillRoots']);
  for (const name of ['addToolServer', 'addSkill', 'addAccount', 'setStartAccount']) assert.equal(codex.operations[name].tier, 'optional', name);
  assert.equal(get('Thread').spec.relations.agent.target, 'Agent');
  assert.equal(get('Thread').spec.relations.agent.cardinality, 'one');
});

test('card spot check: Model', () => {
  const { state, relations, operations, events, summary } = get('Model').spec;
  assert.deepEqual(Object.keys(state), ['name', 'description', 'efforts', 'default', 'available', 'inputs', 'contextWindow', 'pricing']);
  for (const [k, f] of Object.entries(state)) assert.equal(f.tier, ['inputs', 'contextWindow', 'pricing'].includes(k) ? 'optional' : 'core');
  assert.deepEqual(state.efforts.schema.of.fields.id, { schema: { t: 'string' }, optional: false });
  assert.deepEqual(Object.keys(state.efforts.schema.of.fields), ['id', 'label']);
  assert.deepEqual(relations.agent, { member: 'relation', target: 'Agent', cardinality: 'one', tier: 'core', owned: false });
  assert.deepEqual(Object.keys(operations), ['_select', 'makeDefault']);
  assert.equal(operations._select.minArgs, 1);
  assert.equal(operations.makeDefault.tier, 'core');
  assert.deepEqual(Object.keys(events), ['availabilityChanged']);
  assert.deepEqual(summary, { title: 'name', subtitle: 'description' });
  assert.equal(get('Thread').spec.relations.model.target, 'Model');
});

test('card spot check: Draft', () => {
  const { state, relations, operations, events, summary } = get('Draft').spec;
  assert.deepEqual(Object.keys(state), ['content', 'dictating', 'target']);
  assert.equal(state.content.schema.t, 'content');
  assert.equal(state.dictating.schema.t, 'boolean');
  assert.equal(state.target.tier, 'optional', 'new threads only');
  assert.deepEqual(Object.keys(state.target.schema.fields), ['project', 'agent', 'environment', 'branch', 'model', 'settings']);
  for (const name of ['project', 'agent', 'environment', 'branch', 'model']) assert.equal(state.target.schema.fields[name].optional, true, name);
  assert.deepEqual(state.target.schema.fields.model.schema, { t: 'ref', to: 'Model' });
  assert.equal(state.target.schema.fields.settings.optional, false);
  assert.deepEqual(relations.thread, { member: 'relation', target: 'Thread', cardinality: 'maybe', tier: 'core', owned: false });
  assert.deepEqual([relations.attachments.target, relations.attachments.cardinality], ['Attachment', 'many']);
  assert.deepEqual([relations.mentions.target, relations.mentions.cardinality], ['Mention', 'many']);
  assert.deepEqual(Object.keys(operations), ['setContent', 'insert', 'attach', 'clear', 'send', 'setTarget', 'startDictation', 'stopDictation']);
  for (const o of Object.values(operations)) assert.equal(o.tier, 'core');
  // setTarget changes any part of the target (E8.3): each member optional, the project also null (no project)
  assert.deepEqual(Object.keys(operations.setTarget.args[0].fields), Object.keys(state.target.schema.fields));
  assert.ok(Object.values(operations.setTarget.args[0].fields).every((f) => f.optional));
  assert.deepEqual(Object.keys(events), ['changed', 'sent', 'cleared']);
  assert.deepEqual(summary, { title: 'content' });
  assert.equal(get('Thread').spec.relations.draft.target, 'Draft');
});

test('card spot check: Project and LocalProject', () => {
  const { state, relations, operations, events, summary } = get('Project').spec;
  assert.deepEqual(Object.keys(state), ['name', 'location', 'lastOpenedAt']);
  assert.deepEqual([state.name.tier, state.location.tier, state.lastOpenedAt.tier], ['core', 'core', 'optional']);
  assert.deepEqual([relations.threads.target, relations.threads.cardinality, relations.threads.inverseOf], ['Thread', 'many', 'project']);
  assert.deepEqual([relations.root.target, relations.root.cardinality], ['Folder', 'maybe']);
  assert.deepEqual(Object.keys(relations), ['threads', 'root', 'repository', 'draft', 'environments', 'actions', 'automations', 'terminals', 'settings']);
  assert.deepEqual(Object.keys(operations), ['open', 'rename', 'remove', 'newThread', 'newAutomation', 'openIn', 'newTerminal', 'findFiles']);
  for (const [name, o] of Object.entries(operations)) assert.equal(o.tier, ['newAutomation', 'newTerminal', 'findFiles'].includes(name) ? 'optional' : 'core');
  assert.equal(operations.newThread.minArgs, 0, 'the draft is optional');
  assert.deepEqual(Object.keys(events), ['added', 'opened', 'renamed', 'removed']);
  assert.deepEqual(summary, { title: 'name', subtitle: 'location' });
  const local = get('LocalProject');
  assert.equal(local.parent, 'Project');
  assert.deepEqual(local.spec.relations.folder, { member: 'relation', target: 'Folder', cardinality: 'one', tier: 'core', owned: false });
  assert.deepEqual(Object.keys(local.spec.operations), ['reveal', 'addInstructions']);
  assert.equal(get('Thread').spec.relations.project.target, 'Project');
});

test('card spot check: Folder and File', () => {
  const folder = get('Folder').spec;
  assert.deepEqual(Object.keys(folder.state), ['path', 'name', '_expanded']);
  assert.equal(folder.state._expanded.tier, 'optional', 'a files view\'s state');
  assert.deepEqual(Object.entries(folder.relations).map(([n, m]) => [n, m.target, m.cardinality, m.inverseOf ?? null]),
    [['project', 'Project', 'one', null], ['parent', 'Folder', 'maybe', null], ['files', 'File', 'many', 'folder'], ['folders', 'Folder', 'many', 'parent']]);
  assert.deepEqual(Object.keys(folder.operations), ['open', 'reveal', 'openIn', 'mentionIn']);
  const file = get('File').spec;
  assert.deepEqual(Object.keys(file.state), ['path', 'name', 'size', 'modifiedAt', 'kind']);
  for (const f of Object.values(file.state)) assert.equal(f.tier, 'core');
  assert.deepEqual(Object.keys(file.operations), ['open', 'openIn', 'reveal', 'attachTo', 'mentionIn']);
  assert.deepEqual(Object.keys(file.events), ['changed', 'deleted']);
  assert.deepEqual([file.relations.project.cardinality, file.relations.folder.cardinality], ['one', 'one']);
  assert.equal(get('FileEdit').spec.relations.file.target, 'File');
});

test('card spot check: ExternalApp', () => {
  const { state, relations, operations, events, summary } = get('ExternalApp').spec;
  assert.deepEqual(Object.keys(state), ['name', 'icon', 'opens', 'computerUse']);
  assert.deepEqual(state.computerUse.schema.values, ['always', 'ask', 'never', 'unsupported']);
  assert.deepEqual(state.opens.schema.of.values, ['project', 'file', 'folder', 'url']);
  assert.deepEqual(Object.keys(operations), ['open', 'setComputerUse']);
  assert.deepEqual(Object.keys(events), ['changed']);
  assert.deepEqual([relations.sessions.target, relations.sessions.cardinality], ['ComputerUseSession', 'many']);
  assert.deepEqual(summary, { title: 'name', icon: 'icon' });
  assert.equal(get('ComputerUseApproval').spec.relations.app.target, 'ExternalApp');
});

test('card spot check: Environment and its subtypes', () => {
  const env = get('Environment').spec;
  assert.deepEqual(Object.keys(env.state), ['name', 'status', 'description']);
  assert.deepEqual(env.state.status.schema.values, ['ready', 'preparing', 'unavailable']);
  assert.deepEqual([env.relations.project.cardinality, env.relations.threads.inverseOf], ['maybe', 'environment']);
  assert.equal(get('Project').spec.relations.environments.inverseOf, 'project');
  assert.deepEqual(get('LocalEnvironment').spec.relations.folder.target, 'Folder');
  const wt = get('WorktreeEnvironment').spec;
  assert.deepEqual([Object.keys(wt.state), Object.keys(wt.relations), Object.keys(wt.operations)], [['path', 'setup'], ['branch', 'base'], ['open', 'mergeBack', 'remove']]);
  assert.equal(wt.state.setup.tier, 'optional');
  const cloud = get('CloudEnvironment').spec;
  assert.deepEqual([cloud.state.location.tier, Object.keys(cloud.operations)], ['optional', ['manage']]);
});

test('card spot check: Repository, GitRepository and Branch', () => {
  const repo = get('Repository').spec;
  assert.deepEqual(Object.keys(repo.state), ['kind', 'dirty', 'remotes']);
  assert.deepEqual([repo.relations.currentBranch.target, repo.relations.currentBranch.tier, repo.relations.branches.inverseOf], ['Branch', 'optional', 'repository']);
  assert.deepEqual(Object.keys(repo.operations), ['commit', 'switchBranch', 'createBranch', 'push', 'pull', 'fetch', 'workingChanges', 'discard']);
  assert.deepEqual(['push', 'pull', 'fetch', 'workingChanges', 'discard'].map((n) => repo.operations[n].tier), ['optional', 'optional', 'optional', 'optional', 'optional']);
  assert.equal(repo.operations.workingChanges.content, true, 'its answer is content');
  assert.deepEqual(Object.keys(repo.events), ['branchChanged', 'statusChanged', 'committed', 'pushed']);
  assert.deepEqual([Object.keys(get('GitRepository').spec.state), Object.keys(get('GitRepository').spec.operations)], [['staged'], ['stage', 'unstage']]);
  const branch = get('Branch').spec;
  assert.deepEqual(Object.keys(branch.state), ['name', 'current', 'ahead', 'behind', 'upstream']);
  assert.deepEqual([branch.operations.switch.tier, branch.operations.push.tier, branch.operations.delete.tier, branch.operations.openPullRequest.tier], ['core', 'optional', 'optional', 'optional']);
  assert.deepEqual([get('WorktreeEnvironment').spec.relations.branch.target, get('WorktreeEnvironment').spec.relations.branch.cardinality], ['Branch', 'maybe']);
});

test('card spot check: Instructions', () => {
  const ins = get('Instructions').spec;
  // the core is any agent's; where they live is Codex's own (graph-boundary.md B3)
  assert.deepEqual([Object.keys(ins.state), Object.keys(ins.relations)], [['text', 'enabled'], ['agents']]);
  assert.deepEqual([Object.keys(ins.operations), ins.operations.open.tier, Object.keys(ins.events)], [['edit', 'enable', 'disable', 'open'], 'optional', ['changed']]);
  const codex = get('CodexInstructions');
  assert.deepEqual([codex.parent, Object.keys(codex.spec.state), codex.spec.state.scope.schema.values, codex.spec.state.location.tier], ['Instructions', ['scope', 'location'], ['global', 'project', 'folder'], 'optional']);
  assert.deepEqual(Object.keys(codex.spec.relations), ['project', 'folder']);
  const local = get('LocalProject').spec;
  assert.deepEqual([local.relations.instructions.target, local.relations.instructions.inverseOf, local.operations.addInstructions.tier], ['CodexInstructions', 'project', 'optional']);
});

test('card spot check: Command and ProjectAction', () => {
  const cmd = get('Command').spec;
  assert.deepEqual([Object.keys(cmd.state), cmd.state.appliesTo.tier, Object.keys(cmd.operations), Object.keys(cmd.events)], [['title', 'category', 'enabled', 'appliesTo'], 'optional', ['run'], ['ran']]);
  assert.deepEqual([cmd.operations.run.args, cmd.operations.run.minArgs], [[{ t: 'json' }], 0]);
  const pa = get('ProjectAction');
  assert.deepEqual([pa.parent, Object.keys(pa.spec.state), pa.spec.state.icon.tier, pa.spec.relations.project.cardinality], ['Command', ['command', 'icon'], 'optional', 'one']);
  assert.equal(get('Project').spec.relations.actions.inverseOf, 'project');
});

test('card spot check: App, Theme, Update, Setting, SettingsSection, Account, ChatGPTAccount and Usage', () => {
  const app = get('App').spec;
  assert.deepEqual([Object.keys(app.state), app.state.onboarded.tier, Object.keys(app.operations), Object.keys(app.events)],
    [['version', 'onboarded'], 'optional', ['openWindow', 'checkForUpdates', 'frontWindow', 'sendFeedback', 'openHelp', 'quit', 'notify', 'addProject'], ['launched', 'quitting', 'windowOpened', 'windowClosed']]);
  assert.deepEqual([app.relations.theme.cardinality, app.relations.update.cardinality], ['one', 'maybe']);
  const theme = get('Theme').spec;
  assert.deepEqual([Object.keys(theme.state), theme.state.mode.schema.values, theme.state.density.tier], [['mode', 'appearance', 'accent', 'density', 'fonts', 'tokens'], ['light', 'dark', 'system'], 'optional']);
  assert.deepEqual(get('Update').spec.state.state.schema.values, ['available', 'downloading', 'ready', 'installing']);
  const setting = get('Setting').spec;
  assert.deepEqual([setting.state.scope.schema.values, setting.state.kind.schema.values], [['app', 'project', 'thread'], ['toggle', 'choice', 'text', 'number', 'shortcut', 'list', 'record', 'color', 'time', 'timerange']]);
  assert.deepEqual([Object.keys(setting.operations), get('SettingsSection').spec.relations.settings.inverseOf], [['set', 'reset'], 'section']);
  assert.deepEqual([get('Project').spec.relations.settings.inverseOf, get('Thread').spec.relations.settings.inverseOf], ['project', 'thread']);
  const account = get('Account').spec;
  assert.deepEqual([Object.keys(account.state), account.operations.manage.tier, account.relations.agents.inverseOf], [['service', 'name', 'signedIn', 'email', 'plan'], 'optional', 'account']);
  assert.deepEqual([account.operations.remove.tier, account.relations.threads.inverseOf, get('Thread').spec.relations.account.tier], ['optional', 'account', 'optional'], 'several accounts (RM10)');
  assert.deepEqual([get('ChatGPTAccount').parent, Object.keys(get('ChatGPTAccount').spec.state)], ['Account', ['workspace', 'added']]);
  // Usage's core is its account; the server's snapshots, as given, are Codex's (graph-integrity G1.2)
  assert.deepEqual([Object.keys(get('Usage').spec.state ?? {}), Object.keys(get('Usage').spec.events)], [[], ['changed']]);
  const codexUsage = get('CodexUsage');
  assert.deepEqual([codexUsage.parent, Object.keys(codexUsage.spec.state), codexUsage.spec.state.snapshots.schema.t, Object.keys(codexUsage.spec.events)],
    ['Usage', ['snapshots', 'ordinaryUsageAllowed', 'rateLimitResetCredits'], 'record', ['reported']]);
});
