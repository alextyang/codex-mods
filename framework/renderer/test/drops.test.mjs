// Drops (graph-integrity G5.3): a mod's place that takes drops gets an instance of a concept it takes, dragged from the app's own sidebar
// rows (followed by the pointer's path, the app's own drag untouched) or from the framework's rows (the platform's drag, with the ref and
// its concepts as types). A fake document: elements with attributes and parents, its listeners, and what is under a point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrops, REF_TYPE, CONCEPT_TYPE, DROP_ATTR } from '../present/drops.mjs';

function element(attrs = {}, parent = null) {
  return {
    attrs: { ...attrs }, parent,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
    closest(sel) {
      const name = /^\[([^\]=]+)\]$/.exec(sel)?.[1];
      for (let e = this; e; e = e.parent) if (name && Object.hasOwn(e.attrs, name)) return e;
      return null;
    },
  };
}
function setup({ known = true } = {}) {
  const listeners = new Map();
  const doc = { under: [], addEventListener: (n, fn) => listeners.set(n, fn), removeEventListener: (n) => listeners.delete(n), elementsFromPoint: () => doc.under };
  const fire = (n, e) => { const ev = { button: 0, clientX: 0, clientY: 0, preventDefault() { this.prevented = true; }, ...e }; listeners.get(n)?.(ev); return ev; };
  const chains = { CodexThread: ['CodexThread', 'Thread'], Thread: ['Thread'], LocalProject: ['LocalProject', 'Project'] };
  const drops = createDrops({
    doc: () => doc, chainOf: (t) => chains[t] ?? [t], thread: (id) => (id.startsWith('local:') ? { type: 'Thread', provider: 'codex', id: id.slice(6) } : null),
    subject: (ref) => (known ? { ref: { type: 'CodexThread', provider: ref.provider, id: ref.id }, state: {} } : null),
  });
  return { doc, fire, drops, listeners };
}

test('a press on one of the app\'s chat rows that moves, let go over a place that takes chats: a drop of that chat (its instance\'s ref) there', () => {
  const { doc, fire, drops } = setup();
  const place = element(), inside = element({}, place);
  const got = [], overs = [];
  const off = drops.target(place, { accepts: ['Thread'], drop: (x) => got.push(x), over: (v) => overs.push(v) });
  assert.equal(place.getAttribute(DROP_ATTR), '');
  const row = element({ 'data-app-action-sidebar-thread-row': '', 'data-app-action-sidebar-thread-id': 'local:t1' }), label = element({}, row);
  doc.under = [inside];
  fire('pointerdown', { target: label, clientX: 10, clientY: 10 });
  fire('pointermove', { clientX: 12, clientY: 11 });
  assert.deepEqual(overs, [], 'not a drag until it moves a few px');
  fire('pointermove', { clientX: 200, clientY: 40 });
  assert.deepEqual(overs, [true], 'over a place that takes it: it says so');
  fire('pointerup', { clientX: 200, clientY: 40 });
  assert.deepEqual([got.map((x) => x.ref), overs], [[{ type: 'CodexThread', provider: 'codex', id: 't1' }], [true, false]]);
  // a click (no move), a press elsewhere, or Escape: nothing
  fire('pointerdown', { target: label, clientX: 10, clientY: 10 });
  fire('pointerup', { clientX: 10, clientY: 10 });
  fire('pointerdown', { target: element(), clientX: 10, clientY: 10 });
  fire('pointermove', { clientX: 200, clientY: 40 });
  fire('pointerup', { clientX: 200, clientY: 40 });
  fire('pointerdown', { target: label, clientX: 10, clientY: 10 });
  fire('pointermove', { clientX: 200, clientY: 40 });
  fire('keydown', { key: 'Escape' });
  fire('pointerup', { clientX: 200, clientY: 40 });
  assert.equal(got.length, 1);
  // a pointer that jumps (no moves between): let go away from where it was pressed is a drag too
  fire('pointerdown', { target: label, clientX: 10, clientY: 10 });
  fire('pointerup', { clientX: 200, clientY: 40 });
  assert.equal(got.length, 2);
  off();
  fire('pointerdown', { target: label, clientX: 10, clientY: 10 });
  fire('pointermove', { clientX: 200, clientY: 40 });
  fire('pointerup', { clientX: 200, clientY: 40 });
  assert.equal(got.length, 2, 'a place gone takes nothing');
});

test('a place takes only the concepts it accepts; the innermost place under the pointer decides', () => {
  const { doc, fire, drops } = setup();
  const outer = element(), inner = element({}, outer), deep = element({}, inner);
  const got = [];
  drops.target(outer, { accepts: ['Thread'], drop: (x) => got.push(['outer', x.ref.id]) });
  drops.target(inner, { accepts: ['Project'], drop: (x) => got.push(['inner', x.ref.id]) });
  const row = element({ 'data-app-action-sidebar-thread-row': '', 'data-app-action-sidebar-thread-id': 'local:t2' });
  doc.under = [deep];
  fire('pointerdown', { target: row, clientX: 0, clientY: 0 });
  fire('pointermove', { clientX: 100, clientY: 0 });
  fire('pointerup', { clientX: 100, clientY: 0 });
  assert.deepEqual(got, [], 'the place under it takes projects only');
  doc.under = [outer];
  fire('pointerdown', { target: row, clientX: 0, clientY: 0 });
  fire('pointermove', { clientX: 100, clientY: 0 });
  fire('pointerup', { clientX: 100, clientY: 0 });
  assert.deepEqual(got, [['outer', 't2']]);
});

test('the framework\'s rows: the platform\'s drag carries the ref and its concepts; a place that takes one allows the drop and gets it', () => {
  const { fire, drops } = setup();
  const data = new Map();
  const dt = { setData: (k, v) => data.set(k, v), getData: (k) => data.get(k) ?? '', get types() { return [...data.keys()]; }, effectAllowed: '', dropEffect: '' };
  drops.dragStart({ dataTransfer: dt }, { type: 'CodexThread', provider: 'codex', id: 't3' });
  assert.deepEqual([[...data.keys()], dt.effectAllowed], [[REF_TYPE, `${CONCEPT_TYPE}codexthread`, `${CONCEPT_TYPE}thread`], 'copyLink']);
  const place = element(), inside = element({}, place), other = element();
  const got = [], overs = [];
  drops.target(place, { accepts: ['Thread'], drop: (x) => got.push(x.ref), over: (v) => overs.push(v) });
  drops.target(other, { accepts: ['Project'], drop: () => got.push('wrong') });
  const over = fire('dragover', { target: inside, dataTransfer: dt });
  assert.deepEqual([over.prevented, dt.dropEffect, overs], [true, 'copy', [true]], 'allowed there');
  const no = fire('dragover', { target: other, dataTransfer: dt });
  assert.equal(no.prevented, undefined, 'a place that does not take it does not allow it');
  fire('drop', { target: inside, dataTransfer: dt });
  assert.deepEqual(got, [{ type: 'CodexThread', provider: 'codex', id: 't3' }]);
  fire('drop', { target: inside, dataTransfer: { types: ['text/plain'], getData: () => 'x' } });
  assert.equal(got.length, 1, 'a drag of something else is not taken');
});
