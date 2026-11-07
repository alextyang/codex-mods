// The parts the framework lends (graph-integrity G2.3), against the testing kit's fixtures: each draws its props; markdown is built as
// elements (text stays text); a step expands to its output and its diff; a card's answers and a composer's send call back into the mod; the
// pickers draw through the app's composer dropdown where it is exposed and the kit's select otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from './fake-react.mjs';
import { createLentParts, LENT_NAMES } from '../present/lent/index.mjs';
import { createKit } from '../present/kit/index.mjs';
import { LENT_FIXTURES as F } from '../../../sdk/testing/lent-fixtures.mjs';

function setup(exports = {}) {
  const { React, ReactDOM } = createFakeReact();
  const kit = createKit({ react: () => React, parts: () => ({}), document: () => null });
  const parts = createLentParts({ react: () => React, kit, exports: () => exports, document: () => null });
  const draw = (name, props) => { const root = ReactDOM.createRoot({}); root.render(React.createElement(parts[name], props)); return root; };
  const nodes = (root, pred) => root.trees().flatMap((t) => findAll(t, pred));
  return { React, parts, draw, nodes };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('every lent part is there, and each draws its fixture', () => {
  const { parts, draw } = setup();
  assert.deepEqual(LENT_NAMES.filter((n) => typeof parts[n] !== 'function'), []);
  assert.match(rootText(draw('ThreadHeader', F.ThreadHeader)), /Fix the flaky test.*Claude · repo/);
  assert.match(rootText(draw('Message', F.userMessage)), /Why does the suite fail on CI\?/);
  assert.match(rootText(draw('FileChip', F.FileChip)), /^clock\.mjs$/, 'a file by its name');
  assert.match(rootText(draw('DiffView', F.DiffView)), /clock\.mjs[\s\S]*-export const now = \(\) => Date\.now\(\);/, 'its file by name, then its lines');
});

test('an agent\'s message is markdown built as elements: lists, code, emphasis, a link; text that looks like HTML stays text', () => {
  const { draw, nodes } = setup();
  const root = draw('Message', F.agentMessage);
  assert.equal(nodes(root, (n) => n.type === 'li').length, 2);
  assert.equal(nodes(root, (n) => n.type === 'pre').length, 1);
  assert.equal(nodes(root, (n) => n.type === 'strong').length, 1);
  assert.deepEqual(nodes(root, (n) => n.type === 'a').map((n) => n.props.href), ['https://example.com/docs']);
  const unsafe = draw('Message', { role: 'agent', text: '<img src=x onerror=alert(1)> [x](javascript:alert(1))' });
  assert.equal(nodes(unsafe, (n) => n.type === 'img' || n.type === 'a').length, 0, 'no element from its text, no script link');
  assert.match(rootText(unsafe), /<img src=x onerror=alert\(1\)>/);
});

test('a step expands to its command\'s output or its edit\'s diff; a running one says so; one with nothing to show does not expand', async () => {
  const { draw, nodes } = setup();
  const step = draw('StepRow', F.commandStep);
  assert.doesNotMatch(rootText(step), /41 passed/, 'folded');
  nodes(step, (n) => n.props?.['aria-expanded'] === false)[0].props.onClick();
  await tick();
  assert.match(rootText(step), /41 passed/);
  const edit = draw('StepRow', { ...F.editStep, expanded: true });
  assert.deepEqual(nodes(edit, (n) => n.props?.['data-change'] === 'add' || n.props?.['data-change'] === 'remove').map((n) => n.props['data-change']), ['remove', 'add']);
  assert.equal(nodes(draw('StepRow', F.runningStep), (n) => n.type === 'button')[0].props.disabled, true);
});

test('a card\'s answer and a composer\'s send call back into the mod', async () => {
  const { draw, nodes } = setup();
  const answered = [];
  const approval = draw('ApprovalCard', { ...F.ApprovalCard, onAnswer: (id) => answered.push(id) });
  nodes(approval, (n) => n.type === 'button' && /Allow this chat/.test(rootText({ trees: () => [n] })))[0].props.onClick();
  const question = draw('QuestionCard', { ...F.QuestionCard, onAnswer: (a) => answered.push(a) });
  nodes(question, (n) => n.props?.role === 'radio')[1].props.onClick();
  await tick();
  nodes(question, (n) => n.type === 'input' && n.props.type === 'password')[0].props.onChange({ target: { value: 's3cret' } });
  await tick();
  nodes(question, (n) => n.type === 'button' && /Answer/.test(rootText({ trees: () => [n] })))[0].props.onClick();
  assert.deepEqual(answered, ['acceptForSession', { scope: { choices: ['changed'] }, token: { text: 's3cret' } }]);
  const sent = [];
  const composer = draw('Composer', { ...F.Composer, onSubmit: (t) => sent.push(t) });
  nodes(composer, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: 'Run them all' } });
  await tick();
  nodes(composer, (n) => n.type === 'textarea')[0].props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
  assert.deepEqual(sent, ['Run them all']);
  // its attachments are the mod's: chips it can take away, and an attach button that asks it for one
  const acts = [];
  const withFiles = draw('Composer', { ...F.Composer, attachments: [{ id: 'a1', name: 'notes.txt' }], onAttach: () => acts.push('attach'), onRemoveAttachment: (id) => acts.push(`remove ${id}`) });
  assert.match(rootText(withFiles), /notes\.txt/);
  nodes(withFiles, (n) => n.props?.['aria-label'] === 'Remove notes.txt')[0].props.onClick();
  nodes(withFiles, (n) => n.props?.['aria-label'] === 'Attach')[0].props.onClick();
  assert.deepEqual(acts, ['remove a1', 'attach']);
});

test('the pickers: the app\'s composer dropdown where it is exposed, the kit\'s select otherwise', async () => {
  const chosen = [];
  const { React } = createFakeReact();
  const Item = ({ children, onClick }) => React.createElement('button', { 'data-item': true, onClick }, children);
  const ComposerDropdown = ({ children, value }) => React.createElement('div', { 'data-dropdown': value }, children);
  const app = setup({ ComposerDropdown, MenuParts: { Item } });
  const root = app.draw('ModelPicker', { ...F.ModelPicker, onChange: (v) => chosen.push(v) });
  assert.equal(app.nodes(root, (n) => n.props?.['data-dropdown'] === 'Fast').length, 1);
  app.nodes(root, (n) => n.props?.['data-item'])[1].props.onClick();
  assert.deepEqual(chosen, ['deep']);
  const plain = setup();
  assert.match(rootText(plain.draw('EffortPicker', F.EffortPicker)), /Medium/, 'the kit\'s select, labelled');
});

test('graph-integrity G5.3: a DropTarget is a place of the page\'s that takes the concepts it accepts while it is drawn; a ChatRow given its chat\'s ref is dragged as that chat', async () => {
  const targets = [], started = [], gone = [];
  const drops = { target: (el, spec) => { targets.push([el, spec]); return () => gone.push(el); }, dragStart: (e, ref) => started.push(ref) };
  const { React, ReactDOM } = createFakeReact();
  const kit = createKit({ react: () => React, parts: () => ({}), document: () => null });
  const parts = createLentParts({ react: () => React, kit, exports: () => ({}), document: () => null, drops: () => drops });
  const root = ReactDOM.createRoot({});
  const got = [];
  root.render(React.createElement(parts.DropTarget, { accepts: ['Thread'], onDrop: (x) => got.push(x.ref.id) }, 'Drop a chat here'));
  const place = () => root.trees().flatMap((t) => findAll(t, (n) => n.type === 'div' && typeof n.props?.ref === 'function'))[0];
  const el = { id: 'the place' };
  place().props.ref(el);
  assert.deepEqual([targets.length, targets[0][0], targets[0][1].accepts], [1, el, ['Thread']]);
  targets[0][1].drop({ ref: { type: 'CodexThread', provider: 'codex', id: 't1' } });
  targets[0][1].over(true);
  await tick();
  assert.deepEqual([got, place().props['data-over']], [['t1'], ''], 'its drop is the mod\'s; while one would be taken it says so');
  place().props.ref(null);
  assert.deepEqual(gone, [el], 'gone with its element');
  const row = ReactDOM.createRoot({});
  row.render(React.createElement(parts.ChatRow, { title: 'One', drag: { type: 'CodexThread', provider: 'codex', id: 't2' } }));
  const node = row.trees().flatMap((t) => findAll(t, (n) => n.props?.draggable === true))[0];
  node.props.onDragStart({ dataTransfer: {} });
  assert.deepEqual(started, [{ type: 'CodexThread', provider: 'codex', id: 't2' }]);
  const plain = ReactDOM.createRoot({});
  plain.render(React.createElement(parts.ChatRow, { title: 'Two' }));
  assert.equal(plain.trees().flatMap((t) => findAll(t, (n) => n.props?.draggable === true)).length, 0, 'without its ref it is not dragged');
});
