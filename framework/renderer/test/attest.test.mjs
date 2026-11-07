// The user's intent the page attests (graph-integrity G7.1): only while a genuine trusted input event is being dispatched, for the mod whose
// content a part is drawn in (its boundary names it), passed to the part's callback as its last argument; wrapped once. An object that says
// `isTrusted`, a script's event and an event kept after its dispatch count for nothing (review 2026-11-05 #8). Node's abort event is a
// genuine trusted event, so the tests dispatch one to stand for the user's input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, findAll } from './fake-react.mjs';
import { attestNow, setAttestor, withIntent, modContextOf, trustedNow, noteInput } from '../present/attest.mjs';
import { createLentParts } from '../present/lent/index.mjs';
import { createKit } from '../present/kit/index.mjs';

const minted = [];
const withAttestor = () => { minted.length = 0; let n = 0; setAttestor((mod) => { const token = `att-${String(++n).padStart(32, '0')}`; minted.push([token, mod]); return token; }); };
/** `fn(event)` while a genuine trusted event is being dispatched, the page's current event set to it, as the browser sets it. */
function duringTrusted(fn) {
  let out;
  const ac = new AbortController();
  ac.signal.addEventListener('abort', (ev) => { const was = globalThis.event; globalThis.event = ev; try { out = fn(ev); } finally { globalThis.event = was; } });
  ac.abort();
  return out;
}

test('G7.1: an attestation only while a genuine trusted event is being dispatched, for a named mod, while the page runs', () => {
  withAttestor();
  assert.equal(attestNow('mod.a', { isTrusted: true, eventPhase: 2 }), null, 'an object that says it is trusted');
  assert.equal(attestNow('mod.a', new Event('click')), null, 'a script\'s event');
  assert.equal(duringTrusted(() => attestNow(null)), null, 'no mod: none');
  assert.match(duringTrusted((ev) => attestNow('mod.a', ev)), /^att-/);
  assert.match(duringTrusted(() => attestNow('mod.b')), /^att-/, 'the page\'s current event when none is given');
  assert.equal(duringTrusted(() => trustedNow({ nativeEvent: { isTrusted: true } })), true, 'a forged event given still leaves the page\'s own');
  let kept = null;
  duringTrusted((ev) => { kept = ev; });
  assert.equal(attestNow('mod.a', kept), null, 'an event kept after its dispatch');
  const was = globalThis.event;
  globalThis.event = { isTrusted: true };
  try { assert.equal(attestNow('mod.a'), null, 'a page event replaced by a script'); } finally { globalThis.event = was; }
  assert.deepEqual(minted.map((m) => m[1]), ['mod.a', 'mod.b']);
  setAttestor(null);
  assert.equal(duringTrusted((ev) => attestNow('mod.a', ev)), null, 'none while no page runtime mints');
});

test('a callback a component calls from its own synthetic event inside the user\'s input (a menu\'s select) is the user\'s; after it, nothing', () => {
  withAttestor();
  let during = null;
  const ac = new AbortController();
  ac.signal.addEventListener('abort', (ev) => {
    noteInput(ev);   // the page saw the user's input at capture
    const select = new Event('menu.itemSelect');   // the library's own, untrusted, dispatched inside it
    const was = globalThis.event; globalThis.event = select;
    try { during = attestNow('mod.a', select); } finally { globalThis.event = was; }
  });
  ac.abort();
  assert.match(during, /^att-/, 'while the user\'s input is being dispatched');
  assert.equal(attestNow('mod.a', new Event('menu.itemSelect')), null, 'once it is over, nothing');
  noteInput(null);
  setAttestor(null);
});

test('G7.1: a part\'s callback gets {asUser} last, for its mod, wrapped once; called by a script with a forged event, nothing', () => {
  withAttestor();
  const got = [];
  const cb = withIntent((...a) => got.push(a), 'mod.a');
  duringTrusted((ev) => cb('x', ev));
  cb('y', { isTrusted: true });
  assert.deepEqual([got[0][0], typeof got[0][2].asUser, got[1][2]], ['x', 'string', {}]);
  assert.equal(withIntent(cb, 'mod.b'), cb, 'not wrapped again by a part it is passed on to');
  setAttestor(null);
});

test('G7.1: a lent card drawn in a mod\'s content answers with that mod\'s attestation; outside any mod\'s, none', () => {
  withAttestor();
  const { React, ReactDOM } = createFakeReact();
  const kit = createKit({ react: () => React, parts: () => ({}), document: () => null });
  const parts = createLentParts({ react: () => React, kit, exports: () => ({}), document: () => null });
  const M = modContextOf(React);
  const answers = [];
  const card = React.createElement(parts.ApprovalCard, { title: 'Run it?', options: [{ id: 'accept', label: 'Allow once', kind: 'approve' }], onAnswer: (id, intent) => answers.push([id, intent.asUser ?? null]) });
  const inMod = ReactDOM.createRoot({});
  inMod.render(React.createElement(M.Provider, { value: 'mod.a' }, card));
  const button = (root) => root.trees().flatMap((t) => findAll(t, (x) => x.type === 'button'))[0];
  duringTrusted(() => {
    button(inMod).props.onClick();
    const plain = ReactDOM.createRoot({});
    plain.render(card);
    button(plain).props.onClick();
  });
  button(inMod).props.onClick();   // a script's call, after the input
  assert.deepEqual([answers[0][0], minted[0][1], answers[1][1], answers[2][1]], ['accept', 'mod.a', null, null], 'its mod\'s; none outside; none from a script');
  setAttestor(null);
});
