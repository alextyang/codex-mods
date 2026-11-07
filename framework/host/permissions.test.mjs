// A mod's permissions as the user decides them (docs/design/framework-ui.md F8): what each grant may be, what a record holds, what a restore keeps, and the prompt behind a call
// held under `ask`: one per mod at a time, its answers, a Deny that keeps it from asking again, its end on a decision changing, never while the mod starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askable, enforced, choicesOf, defaultOf, overlaps, decisionsFor, grantsFor, asksOf, requiredOf, restoredDecisions, createPermissionGate } from './permissions.mjs';

test('what a grant may be: by what can be enforced and whether its call can wait', () => {
  assert.deepEqual(['graph.act:Thread.archive', 'secrets', 'appServer.request:thread/start'].map(choicesOf), [['allow', 'ask', 'deny'], ['allow', 'ask', 'deny'], ['allow', 'ask', 'deny']]);
  assert.deepEqual(['graph.read', 'graph.intercept:Thread', 'graph.present:SidebarItem', 'ui', 'appServer.observe', 'graph.contribute:Thread', 'processes'].map(choicesOf).map((c) => c.join(',')), Array(7).fill('allow,deny'));
  assert.deepEqual(choicesOf('network'), [], 'nothing enforces it');
  assert.equal(enforced('network'), false);
  assert.deepEqual(['graph.act', 'secrets', 'ui', 'graph.read'].map(defaultOf), ['ask', 'ask', 'deny', 'deny']);
  assert.equal(askable('graph.actually'), false, 'by family, not by prefix');
});

test('two grants overlap when one is bare, or they share a type, an operation of it, or a method under a prefix', () => {
  assert.equal(overlaps('graph.act', 'graph.act:Thread'), true);
  assert.equal(overlaps('graph.act:Thread', 'graph.act:Thread.archive'), true);
  assert.equal(overlaps('graph.act:Draft,Thread.archive', 'graph.act:Thread'), true);
  assert.equal(overlaps('graph.act:Thread', 'graph.act:Draft'), false);
  assert.equal(overlaps('graph.act:Thread', 'graph.read:Thread'), false, 'another family');
  assert.equal(overlaps('appServer.request:thread/', 'appServer.request:thread/start'), true);
  assert.equal(overlaps('appServer.request:turn/start', 'appServer.request:thread/start'), false);
  assert.equal(overlaps('secrets', 'secrets'), true);
  assert.equal(overlaps('graph.act:Thread.*', 'graph.act:Thread.archive'), true, 'Type.* is every operation of it, as the policy reads it (FU5/FU6 review)');
  assert.equal(overlaps('graph.act:Thread.archive', 'graph.act:Thread.*'), true);
  assert.equal(overlaps('graph.act:Thread.*', 'graph.act:Draft.send'), false);
});

test('a record: the decisions of its optional grants, what it holds outright, its asks, its required; a restore never raises a decision', () => {
  const m = { permissions: ['ui'], optionalPermissions: ['graph.act:Thread.archive', 'graph.read', 'secrets'] };
  const d = decisionsFor(m);
  assert.deepEqual(d, { 'graph.act:Thread.archive': 'ask', 'graph.read': 'deny', secrets: 'ask' });
  assert.deepEqual(decisionsFor(m, { 'graph.read': 'allow', secrets: 'deny', gone: 'allow', 'graph.act:Thread.archive': 'ask-ish' }), { 'graph.act:Thread.archive': 'ask', 'graph.read': 'allow', secrets: 'deny' }, 'kept where still a choice');
  const rec = { grants: grantsFor(m.permissions, { ...d, 'graph.read': 'allow' }), decisions: { ...d, 'graph.read': 'allow' } };
  assert.deepEqual(rec.grants, ['ui', 'graph.read'], 'an ask is not held outright');
  assert.deepEqual(asksOf(rec), ['graph.act:Thread.archive', 'secrets']);
  assert.deepEqual(requiredOf(rec), ['ui']);
  assert.deepEqual(restoredDecisions({ a: 'allow', b: 'deny', c: 'allow', d: 'ask' }, { a: 'deny', b: 'allow', d: 'allow' }), { a: 'deny', b: 'deny', c: 'allow', d: 'ask' }, 'a later deny wins over an older allow');
});

function gateSetup(o = {}) {
  const records = { 'm.one': { grants: ['ui'], decisions: { secrets: 'ask', 'graph.act:Thread.archive': 'deny', 'graph.read': 'deny' } } };
  const asked = [], withdrawn = [], decided = [];
  let answer = o.answer ?? (() => ({ choice: 'once', by: 'user' }));
  const windows = {
    ask: async (q) => { asked.push(q); return answer(q); },
    askWithdraw: (modId, token) => withdrawn.push([modId, token]),
  };
  let status = o.status ?? 'active';
  const gate = createPermissionGate({
    record: (id) => records[id], status: () => status, safeMode: () => o.safeMode === true, windows: () => (o.noWindow ? null : windows), nameOf: () => 'One', ...(o.promptMs ? { promptMs: o.promptMs } : {}),
    decide: async (modId, grant, decision) => { decided.push([modId, grant, decision]); records[modId].decisions[grant] = decision; },
  });
  return { gate, records, asked, withdrawn, decided, setAnswer: (f) => { answer = f; }, setStatus: (s) => { status = s; } };
}

test('a held call: Allow once lets it through and keeps asking; Always allow writes the decision and stops asking; Deny refuses and keeps it from asking again while the mod runs', async () => {
  const t = gateSetup();
  assert.equal(t.gate.askFor('m.one', ['ui'], (g) => g.includes('secrets')), 'secrets');
  assert.equal(t.gate.askFor('m.one', ['ui'], (g) => g.includes('ui')), null, 'held outright: nothing to ask');
  assert.equal(t.gate.askFor('m.one', ['ui'], (g) => g.includes('graph.read')), null, 'a deny is not asked');
  await t.gate.hold('m.one', 'secrets', { what: 'read its secret' });
  await t.gate.hold('m.one', 'secrets', { what: 'read its secret' });
  assert.equal(t.asked.length, 2);
  assert.deepEqual(t.asked[0].actions.map((a) => a.id), ['once', 'always', 'deny']);
  assert.deepEqual([t.asked[0].requester.id, t.asked[0].purpose, t.asked[0].subject.type], ['m.one', 'permission', 'Mod']);
  assert.ok(t.asked[0].until > Date.now() + 50_000, 'it ends on its own time');
  t.setAnswer(() => ({ choice: 'always', by: 'user' }));
  await t.gate.hold('m.one', 'secrets');
  assert.deepEqual(t.decided, [['m.one', 'secrets', 'allow']]);
  await t.gate.hold('m.one', 'secrets');
  assert.equal(t.asked.length, 3, 'allowed now: not asked');
  assert.equal(t.gate.askFor('m.one', ['ui'], (g) => g.includes('secrets')), 'secrets', 'allowed since it started: its own copy lacks it, so the gate still finds it');
  const d = gateSetup({ answer: () => ({ choice: 'deny', by: 'user' }) });
  await assert.rejects(d.gate.hold('m.one', 'secrets', { what: 'read its secret' }), /you did not allow read its secret/);
  await assert.rejects(d.gate.hold('m.one', 'secrets'), /did not allow/);
  assert.equal(d.asked.length, 1, 'a Deny is not asked again while it runs');
  d.gate.ended('m.one');
  d.setAnswer(() => ({ choice: 'once', by: 'user' }));
  await d.gate.hold('m.one', 'secrets');
  assert.equal(d.asked.length, 2, 'it asks again after it started again');
});

test('a prompt not answered, no window, safe mode, or a mod starting: refused, and never asked while it starts', async () => {
  const t = gateSetup({ answer: () => ({ cancelled: true, by: 'framework', reason: 'its time passed' }) });
  await assert.rejects(t.gate.hold('m.one', 'secrets', { what: 'x' }), /x was not answered/);
  await assert.rejects(gateSetup({ noWindow: true }).gate.hold('m.one', 'secrets'), /not answered|did not allow/);
  const s = gateSetup({ status: 'activating' });
  await assert.rejects(s.gate.hold('m.one', 'secrets'), /cannot wait while it starts/);
  assert.equal(s.asked.length, 0);
  const safe = gateSetup({ safeMode: true });
  await assert.rejects(safe.gate.hold('m.one', 'secrets'));
  assert.equal(safe.asked.length, 0);
  const thrown = gateSetup({ answer: () => { throw new Error('no window is open to ask in'); } });
  await assert.rejects(thrown.gate.hold('m.one', 'secrets'), /not answered/);
});

test('one prompt per mod at a time: the second waits for the first, and reads the decision again when its turn comes', async () => {
  let release;
  const t = gateSetup({ answer: () => new Promise((r) => { release = () => r({ choice: 'always', by: 'user' }); }) });
  const first = t.gate.hold('m.one', 'secrets');
  const second = t.gate.hold('m.one', 'secrets');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.asked.length, 1, 'one at a time');
  release();
  await first; await second;
  assert.equal(t.asked.length, 1, 'allowed by the first answer: the second is not asked');
});

test('a decision changing ends the prompts waiting on it, and a running mod hears what it gains', async () => {
  const t = gateSetup({ answer: () => new Promise(() => {}) });
  const heard = [];
  const sub = t.gate.onChange('m.one', (g, d) => heard.push([g, d]));
  void t.gate.hold('m.one', 'secrets').catch(() => {});
  await new Promise((r) => setTimeout(r, 5));
  t.gate.changed('m.one', 'secrets', 'deny');
  assert.equal(t.withdrawn.length, 1);
  assert.equal(t.withdrawn[0][0], 'm.one');
  assert.deepEqual(heard, [['secrets', 'deny']]);
  sub.dispose();
  t.gate.changed('m.one', 'graph.read', 'allow');
  assert.equal(heard.length, 1);
});

test('the mod asks itself: Allow and Don\'t allow only; Allow is written; a required grant is held; one it does not declare is refused without a prompt', async () => {
  const m = { permissions: ['ui'], optionalPermissions: ['secrets', 'graph.read'] };
  const t = gateSetup({ answer: () => ({ choice: 'always', by: 'user' }) });
  assert.equal(t.gate.state('m.one', 'ui', m), 'allow');
  assert.equal(t.gate.state('m.one', 'graph.read', m), 'deny');
  assert.throws(() => t.gate.state('m.one', 'network', m), /not a permission this mod declares/);
  assert.deepEqual(await t.gate.request('m.one', 'ui', m), { granted: true });
  assert.deepEqual(await t.gate.request('m.one', 'graph.read', m, { title: 'Read your chats?' }), { granted: true });
  assert.deepEqual(t.asked[0].actions.map((a) => a.id), ['always', 'deny']);
  assert.equal(t.asked[0].title, 'Read your chats?');
  assert.deepEqual(t.decided, [['m.one', 'graph.read', 'allow']]);
  // from deny the mod starts again to hold it: it is answered before that, not after
  let finish;
  const slow = createPermissionGate({ record: () => ({ grants: [], decisions: { 'graph.read': 'deny' } }), status: () => 'active', safeMode: () => false, nameOf: () => 'One',
    windows: () => ({ ask: async () => ({ choice: 'always', by: 'user' }) }), decide: () => new Promise((r) => { finish = r; }) });
  assert.deepEqual(await slow.request('m.one', 'graph.read', m), { granted: true });
  finish();
  const n = gateSetup({ answer: () => ({ choice: 'deny', by: 'user' }) });
  assert.deepEqual(await n.gate.request('m.one', 'secrets', m), { granted: false });
  assert.deepEqual(await n.gate.request('m.one', 'secrets', m), { granted: false });
  assert.equal(n.asked.length, 1, 'not asked again while it runs');
  await assert.rejects(n.gate.request('m.one', 'network', m), /not a permission this mod declares/);
});

test('an answer lets a held call through only into the run that asked: one stopping, started again or denied since is refused; Always allow is still written; a prompt ends on its own time (FU5/FU6 review)', async () => {
  const later = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
  const t = gateSetup();
  let q = later();
  t.setAnswer(() => q.p);
  let held = t.gate.hold('m.one', 'secrets', { what: 'delete its secret' });
  await new Promise((r) => setImmediate(r));
  t.setStatus('stopping');
  q.resolve({ choice: 'once', by: 'user' });
  await assert.rejects(held, /stopped, or the permission changed, while it waited/);
  t.setStatus('active');
  q = later();
  held = t.gate.hold('m.one', 'secrets');
  await new Promise((r) => setImmediate(r));
  t.gate.ended('m.one');
  q.resolve({ choice: 'always', by: 'user' });
  await assert.rejects(held, /while it waited/, 'stopped and started again: another run');
  assert.deepEqual(t.decided, [['m.one', 'secrets', 'allow']], 'Always allow is still the user\'s decision');
  t.records['m.one'].decisions.secrets = 'ask';
  q = later();
  held = t.gate.hold('m.one', 'secrets');
  await new Promise((r) => setImmediate(r));
  t.records['m.one'].decisions.secrets = 'deny';
  q.resolve({ choice: 'once', by: 'user' });
  await assert.rejects(held, /while it waited/, 'denied since');
  const slow = gateSetup({ promptMs: 20, answer: () => new Promise(() => {}) });
  await assert.rejects(slow.gate.hold('m.one', 'secrets'), /was not answered/, 'not the window\'s timer alone');
  assert.equal(slow.withdrawn.length, 1, 'and its question is withdrawn');
});
