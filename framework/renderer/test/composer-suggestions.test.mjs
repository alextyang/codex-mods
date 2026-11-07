// Mods' inline suggestions in the composer (present/composer-suggestions.mjs; reference-mods.md RM8): a source asked at a pause at the end
// of a line, its answer drawn as ghost text after the caret, taken with Tab through the composer's own controller, left with Escape,
// cleared by typing; an answer to changed text dropped; nothing while a mention or a slash command is typed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestOf, contextAt, suggestionOf, createComposerSuggestions } from '../present/composer-suggestions.mjs';

/** A composer's editor, as far as the suggestions read it: its text, its caret, its element. */
function editor(text, caret = text.length) {
  const listeners = new Map();
  const created = [];
  const doc = {
    createElement: () => { const el = { style: {}, attrs: {}, textContent: '', setAttribute(k, v) { el.attrs[k] = v; }, remove() { el.removed = true; } }; created.push(el); return el; },
    body: { appendChild() {} },
    defaultView: { getComputedStyle: () => ({ fontFamily: 'Editor Sans', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: 'normal' }) },
  };
  const dom = {
    ownerDocument: doc,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    getBoundingClientRect: () => ({ right: 600 }),
  };
  const ed = {
    text, caret, inserted: [], created,
    view: {
      dom,
      get state() { return { selection: { empty: true, from: ed.caret }, doc: { content: { size: ed.text.length }, textBetween: (a, b) => ed.text.slice(a, b) } }; },
      coordsAtPos: () => ({ left: 100, top: 40 }),
    },
    fire(type, e = {}) { for (const fn of listeners.get(type) ?? []) fn({ preventDefault() { e.prevented = true; }, stopPropagation() {}, ...e }); return e; },
    type(s) { ed.text = ed.text.slice(0, ed.caret) + s + ed.text.slice(ed.caret); ed.caret += s.length; ed.fire('input'); },
    listening: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
  ed.controller = { view: ed.view, insertTextAtSelection: (t) => { ed.inserted.push(t); ed.type(t); } };
  return ed;
}
const rule = (provide, extra = {}) => ({ mod: 'acme.complete', id: 'next', kind: 'add', presentation: 'Palette', for: 'Draft', data: { suggest: { provide, ...extra } } });
function setup(provide, extra) {
  const queue = [];
  const s = createComposerSuggestions({ guard: (r, fn) => fn, env: (draft, thread) => ({ draft, thread }), schedule: (fn) => { queue.push(fn); return queue.length; }, cancel() {}, log() {} });
  s.setSources([rule(provide, extra)]);
  const flush = async () => { while (queue.length) queue.shift()(); await new Promise((r) => setImmediate(r)); };
  return { s, flush };
}

test('a source as its rule says it; the context at a caret only at a line\'s end, never in a mention or a slash command', () => {
  assert.deepEqual(Object.keys(suggestOf(rule(() => null))).sort(), ['debounceMs', 'key', 'minChars', 'provide', 'rule']);
  assert.equal(suggestOf(rule(() => null, { debounceMs: 99999 })).debounceMs, 3000);
  assert.equal(suggestOf({ data: { suggest: {} } }), null);
  assert.deepEqual(contextAt(editor('Write a test for').view), { before: 'Write a test for', after: '', at: 16 });
  assert.equal(contextAt(editor('Write a test', 5).view), null, 'mid-line: none');
  assert.equal(contextAt(editor('Ask @fo').view), null);
  assert.equal(contextAt(editor('/rev').view), null);
  assert.deepEqual(contextAt(editor('first line\nsecond', 10).view)?.after, '\nsecond', 'at the end of a line with more after it');
  assert.equal(suggestionOf('  '), null);
  assert.equal(suggestionOf({ text: 'x'.repeat(900) }).length, 500);
});

test('a pause asks the source; its answer is ghost text after the caret, in the editor\'s font; Tab takes it through the controller', async () => {
  const asked = [];
  const { s, flush } = setup((env) => { asked.push(env); return ' the parser'; });
  const ed = editor('Write a test for');
  const e = s.engine(ed.controller, { current: { draft: { type: 'Draft', provider: 'codex', id: 'd1' }, thread: null } });
  ed.type('');
  await flush();
  assert.deepEqual([asked.length, asked[0].before, asked[0].after, asked[0].via, asked[0].draft.id], [1, 'Write a test for', '', 'suggest', 'd1']);
  assert.equal(e.shown, ' the parser');
  const [ghost] = ed.created;
  assert.deepEqual([ghost.textContent, ghost.style.left, ghost.style.top, ghost.style.fontFamily, ghost.style.color, ghost.style.display],
    [' the parser', '100px', '40px', 'Editor Sans', 'var(--color-text-tertiary)', 'block']);
  const tab = ed.fire('keydown', { key: 'Tab' });
  assert.equal(tab.prevented, true);
  assert.deepEqual(ed.inserted, [' the parser']);
  assert.equal(ed.text, 'Write a test for the parser');
  assert.equal(e.shown, null);
  e.dispose();
  assert.equal(ed.listening(), 0);
});

test('Escape leaves it; typing clears it; an answer to text that changed is dropped; nothing in a mention or under minChars', async () => {
  let answer = ' world';
  const { s, flush } = setup(() => answer, { minChars: 3 });
  const ed = editor('hello');
  const e = s.engine(ed.controller, { current: { draft: null, thread: null } });
  ed.type(' ');
  await flush();
  assert.equal(e.shown, ' world');
  const esc = ed.fire('keydown', { key: 'Escape' });
  assert.equal(esc.prevented, true);
  assert.equal(e.shown, null);
  ed.fire('keydown', { key: 'Tab' });
  assert.deepEqual(ed.inserted, [], 'Tab with no ghost is the app\'s');
  // an answer that arrives after the text changed
  let release;
  answer = new Promise((r) => { release = r; });
  ed.type('x');
  const queued = flush();
  ed.text += 'y'; ed.caret += 1;   // typed while the source was being asked
  release(' late');
  await queued;
  assert.equal(e.shown, null, 'dropped');
  // a mention being typed, and too little text: not asked
  answer = ' no';
  const quiet = editor('');
  const q = s.engine(quiet.controller, { current: { draft: null, thread: null } });
  quiet.type('@fo');
  await flush();
  assert.equal(q.shown, null);
  const short = editor('');
  const sh = s.engine(short.controller, { current: { draft: null, thread: null } });
  short.type('hi');
  await flush();
  assert.equal(sh.shown, null);
});
