// The framework's Dialogs (docs/design/systems.md E6 decision 3): the app's Dialog and its parts when the build has them, else a fallback
// that is modal and labelled, moves focus in, keeps it inside, gives it back, and closes on Escape or outside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll, rootText } from './fake-react.mjs';
import { createDialogs, trapTab, focusablesOf } from '../present/dialogs.mjs';

function render({ exports = {}, props = {}, useRef } = {}) {
  const { React, ReactDOM } = createFakeReact();
  if (useRef) React.useRef = useRef;
  const { ModsDialog } = createDialogs({ R: React, exports: () => exports });
  const closed = [];
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(ModsDialog, { title: 'Remove Demo?', subtitle: 'It cannot be undone', onClose: () => closed.push(true),
    footer: [React.createElement('button', { key: 'ok' }, 'Remove')], ...props }, React.createElement('p', { key: 'p' }, 'Its code goes.')));
  return { React, root, closed, text: () => rootText(root), all: (pred) => root.trees().flatMap((t) => findAll(t, pred)) };
}

test('with the app\'s Dialog and its parts: open, named for its content, closed through onOpenChange, header, body and footer', () => {
  const { React: X } = createFakeReact();
  const h = (tag) => ({ children, ...p }) => X.createElement(tag, p, children);
  const exports = { Dialog: h('dialog'), DialogParts: { Header: ({ title, subtitle }) => X.createElement('header', null, title, ' / ', subtitle), Body: h('section'), Footer: h('footer') } };
  const t = render({ exports });
  const dialog = t.all((n) => n.type === 'dialog')[0];
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.contentProps['aria-label'], 'Remove Demo?', 'the header draws its title as text: the content is named');
  assert.equal(dialog.props.contentProps['data-codexmods-dialog'], 'app');
  assert.equal(dialog.props.contentProps['data-codexmods-framework'], '', 'a framework root (E6.4b)');
  assert.match(t.text(), /Remove Demo\? \/ It cannot be undoneIts code goes\.Remove/);
  dialog.props.onOpenChange(true);
  assert.equal(t.closed.length, 0);
  dialog.props.onOpenChange(false);
  assert.equal(t.closed.length, 1, 'Escape, outside or its close button');
});

test('the app\'s Dialog gives focus back to what had it when it opened (it would give it only to its own trigger)', () => {
  const { React: X } = createFakeReact();
  const h = (tag) => ({ children, ...p }) => X.createElement(tag, p, children);
  const exports = { Dialog: h('dialog'), DialogParts: { Header: h('header'), Body: h('section'), Footer: h('footer') } };
  const focused = [];
  const opener = { focus: () => focused.push('opener'), isConnected: true };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { activeElement: opener };
  try {
    const t = render({ exports });
    globalThis.document.activeElement = null;   // the dialog moved focus in
    const dialog = t.all((n) => n.type === 'dialog')[0];
    let prevented = false;
    dialog.props.contentProps.onCloseAutoFocus({ preventDefault: () => { prevented = true; } });
    assert.deepEqual(focused, ['opener']);
    assert.equal(prevented, true, 'instead of the app\'s own return');
    opener.isConnected = false;
    prevented = false;
    dialog.props.contentProps.onCloseAutoFocus({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, 'an opener that is gone: the app\'s own');
  } finally {
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  }
});

test('without them, the fallback: modal, labelled by its title, closed on Escape and outside, not on a click inside', () => {
  const t = render({ exports: { Dialog: () => null } });   // a Dialog without its parts is not used
  const box = t.all((n) => n.props?.role === 'dialog')[0];
  assert.equal(box.props['aria-modal'], 'true');
  const title = t.all((n) => n.type === 'h2')[0];
  assert.equal(box.props['aria-labelledby'], title.props.id);
  assert.equal(rootText({ trees: () => [title] }), 'Remove Demo?');
  const overlay = t.all((n) => n.props?.['data-codexmods-dialog'] === 'fallback')[0];
  assert.doesNotMatch(String(overlay.props.className), /#|rgb/, 'theme classes only');
  assert.equal(overlay.props['data-codexmods-framework'], '');
  overlay.props.onMouseDown({ target: 'inside', currentTarget: 'overlay' });
  assert.equal(t.closed.length, 0);
  overlay.props.onMouseDown({ target: overlay, currentTarget: overlay });
  assert.equal(t.closed.length, 1);
  let prevented = false;
  box.props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation() {} });
  assert.equal(t.closed.length, 2);
  assert.equal(prevented, true);
});

test('the fallback moves focus to its first control, keeps Tab inside, and gives focus back when it goes', () => {
  const focused = [];
  const el = (name) => ({ name, focus() { focused.push(name); doc.activeElement = this; }, isConnected: true });
  const doc = { activeElement: null };
  const opener = el('opener');
  doc.activeElement = opener;
  const [a, b, c] = [el('a'), el('b'), el('c')];
  const node = { ownerDocument: doc, querySelectorAll: () => [a, b, c], focus() { focused.push('box'); } };
  const t = render({ useRef: (init) => ({ current: init === null ? node : init }) });
  assert.deepEqual(focused, ['a'], 'its first control');
  const box = t.all((n) => n.props?.role === 'dialog')[0];
  const tab = (shiftKey) => { let p = false; box.props.onKeyDown({ key: 'Tab', shiftKey, preventDefault: () => { p = true; } }); return p; };
  doc.activeElement = c;
  assert.equal(tab(false), true);
  assert.equal(doc.activeElement, a, 'from the last to the first');
  assert.equal(tab(true), true);
  assert.equal(doc.activeElement, c, 'and back with Shift');
  doc.activeElement = b;
  assert.equal(tab(false), false, 'in the middle, Tab is the browser\'s');
  t.root.unmount();
  assert.equal(focused.at(-1), 'opener', 'focus goes back to what opened it');
  assert.deepEqual(focusablesOf(null), []);
  let none = false;
  trapTab({ querySelectorAll: () => [] }, { key: 'Tab', preventDefault: () => { none = true; } });
  assert.equal(none, true, 'nothing to focus: Tab stays');
});
