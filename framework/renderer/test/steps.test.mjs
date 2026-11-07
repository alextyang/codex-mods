// The app's own steps (docs/design/public-hooks.md §3.15): each kind's binding names its Step from the item the app gives it; the
// shared activity row finds it through its kind's site and takes the mods' badges, actions and regions; the parts each draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { stepCommand, stepReasoning, stepTool, stepDelegation, stepFileEdit, stepRow } from '../present/bindings/steps.mjs';
import { SIBLINGS } from '../present/bindings/slots.mjs';

const ctx = { protocol: (id, native) => native(id), react: () => null };
const step = (id) => ({ type: 'Step', provider: 'codex', id });

test('each kind names its Step from its item, in the conversation it is in', () => {
  assert.deepEqual(stepCommand.subject({ conversationId: 't1', item: { type: 'exec', commandExecutionItemId: 'c9', callId: 'c9:0' } }, ctx), step('t1:c9'));
  assert.deepEqual(stepCommand.subject({ conversationId: 't1', item: { type: 'exec', callId: 'call_4' } }, ctx), step('t1:call_4'), 'the call id when the item has no item id');
  assert.equal(stepCommand.subject({ item: { callId: 'x' } }, ctx), null, 'no conversation: none');
  assert.deepEqual(stepReasoning.subject({ conversationId: 't1', item: { sourceItemId: 'r1' } }, ctx), step('t1:r1'));
  assert.deepEqual(stepTool.subject({ conversationId: 't1', item: { threadId: 't2', callId: 'm1' } }, ctx), step('t2:m1'), 'an MCP call names its own thread');
  assert.equal(stepTool.subject({ conversationId: 't1', item: { threadId: 'chatgpt', callId: 'm1' } }, ctx), null, 'remote work is not ours');
  assert.deepEqual(stepDelegation.subject({ conversationId: 't1', items: [{ id: 'd1' }] }, ctx), step('t1:d1'));
  const edit = { binding: 'step.edits', props: { item: { callId: 'p1', changes: { 'a.js': {}, 'b.js': {} } } } };
  const route = { routeKind: 'local-thread', conversationId: 't1' };
  assert.deepEqual(stepFileEdit.subject({ path: 'b.js' }, ctx, route, edit), step('t1:p1:1'), 'a file edit: its path\'s index in its container\'s call');
  assert.equal(stepFileEdit.subject({ path: 'c.js' }, ctx, route, edit), null);
  assert.equal(stepFileEdit.subject({ path: 'a.js' }, ctx, null, edit), null, 'no chat shown: none');
});

test('the parts each kind draws by its own props', () => {
  const item = { type: 'exec', durationMs: 3000, startedAtMs: 1, cmd: ['ls'] };
  assert.equal(stepCommand.appParts.icon({ item }).showSummaryIcon, false);
  assert.equal(stepCommand.appParts.details({ item }).hideRawCommand, true, 'the chevron and the output');
  assert.deepEqual(stepCommand.appParts.duration({ item }).item, { type: 'exec', cmd: ['ls'] });
  assert.equal(stepReasoning.appParts.code({}).hideCodeBlocks, true);
  assert.equal(stepTool.appParts.app({}).renderMcpApps, false);
  assert.equal(stepFileEdit.appParts.details({}).showDiffDetails, false);
  assert.deepEqual(stepRow.appParts.details({ disclosure: {}, body: 'b' }), { disclosure: undefined, body: null });
  assert.equal(stepRow.appParts.icon({ icon: 'i' }).icon, null);
});

test('the activity row: the Step of the kind above it; the mods\' badges and actions in its accessory, their regions in its body', () => {
  const { React: R } = createFakeReact();
  const c = { protocol: (id, native) => native(id), react: () => R, exports: () => ({}), token: () => null, local: { read() {}, touch() {} } };
  const kindProps = { conversationId: 't1', item: { type: 'exec', callId: 'c1' } };
  stepCommand.subject(kindProps, c);   // the kind's mount names its Step first
  const near = { binding: 'step.command', site: 'step', props: kindProps };
  assert.deepEqual(stepRow.subject({}, c, null, near), step('t1:c1'));
  assert.equal(stepRow.subject({}, c, null, { binding: 'message.agent', props: {} }), null, 'a group\'s header, under no kind: none');
  const factory = (type, props) => ({ type, props });
  const env = { R, ctx: c };
  const entry = (item) => ({ rule: { mod: 'unit.s', id: 'r' }, item });
  let p = stepRow.slots.badges.apply({ accessory: 'auto-review', summary: 'Ran ls', disclosure: { expanded: true }, body: 'output' }, [entry({ id: 'b', text: 'slow' })], env);
  p = stepRow.slots.actions.apply(p, [entry({ id: 'a', title: 'Rerun', run() {} })], env);
  p = stepRow.slots.body.apply(p, ['region'], env);
  const out = stepRow.render('Row', p, factory, c, null, near);
  assert.equal(out.type, 'Row');
  const acc = [].concat(out.props.accessory.props.children);
  assert.equal(acc[0], 'auto-review', 'the app\'s own accessory first');
  assert.equal(acc.length, 3);
  assert.deepEqual([].concat(out.props.body.props.children), ['output', 'region'], 'in the app\'s open body');
  assert.ok(!Object.keys(out.props).some((k) => k.startsWith('__codexmods')), 'nothing private reaches the app');
  // a row with no chevron of its own: the page's, closed at first
  const bare = stepRow.render('Row', stepRow.slots.body.apply({ summary: 'Read file' }, ['region'], env), factory, c, null, near);
  assert.deepEqual([bare.props.disclosure.expanded, bare.props.body], [false, null]);
  bare.props.disclosure.onToggle();
  const opened = stepRow.render('Row', stepRow.slots.body.apply({ summary: 'Read file' }, ['region'], env), factory, c, null, near);
  assert.deepEqual([opened.props.disclosure.expanded, [].concat(opened.props.body.props.children)], [true, [null, 'region']]);
  assert.equal(stepRow.render('Row', { summary: 'x' }, factory, c, null, near), undefined, 'no entries: the app\'s row as it is');
  assert.equal(SIBLINGS in out.props, false);
});

test('public hooks H6 (§3.6): a step whose request a mod answered in the user\'s place says who, in the framework\'s words; the user\'s answers say nothing', () => {
  const { React: R } = createFakeReact();
  const kindProps = { conversationId: 't1', item: { type: 'exec', callId: 'c9' } };
  const req = { type: 'CommandApproval', provider: 'codex', id: 'r9' };
  const subjects = new Map();
  const c = { protocol: (id, native) => native(id), react: () => R, exports: () => ({}), token: () => 'grey', local: { read() {}, touch() {} },
    subject: (ref) => subjects.get(`${ref.type}:${ref.id}`) ?? null };
  stepCommand.subject(kindProps, c);
  const near = { binding: 'step.command', site: 'step', props: kindProps };
  const factory = (type, props) => ({ type, props });
  subjects.set('Step:t1:c9', { ref: step('t1:c9'), state: {}, links: { request: req } });
  subjects.set('Mod:qa.hooks', { state: { name: 'QA hooks' } });
  const says = (answeredBy, outcome) => {
    subjects.set('CommandApproval:r9', { ref: req, state: { status: 'answered', answeredBy, outcome } });
    const out = stepRow.render('Row', { summary: 'Ran ls', accessory: 'own' }, factory, c, null, near);
    if (!out) return null;
    const note = [].concat(out.props.accessory.props.children).find((x) => x?.props?.['data-codexmods-answered']);
    return note ? [note.props.children, note.props.style.color] : null;
  };
  assert.deepEqual(says({ kind: 'mod', id: 'qa.hooks' }, { decision: 'approved', scope: 'once' }), ['Approved by QA hooks', 'grey']);
  assert.deepEqual(says({ kind: 'mod', id: 'qa.hooks' }, { decision: 'denied' }), ['Declined by QA hooks', 'grey']);
  assert.deepEqual(says({ kind: 'mod', id: 'qa.hooks', via: 'policy', rule: 'Approve reads' }, { decision: 'approved', scope: 'once' }), ['Approved by QA hooks: Approve reads', 'grey'], 'by which rule');
  assert.deepEqual(says({ kind: 'mod', id: 'unit.other' }, { decision: 'answered' }), ['Answered by unit.other', 'grey'], 'a mod the page does not know: its id');
  assert.equal(says({ kind: 'user' }, { decision: 'approved', scope: 'once' }), null, 'the user\'s own answer: the app\'s row as it is');
});
