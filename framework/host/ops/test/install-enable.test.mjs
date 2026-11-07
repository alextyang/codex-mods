import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { harness, activationError, keygen } from './harness.mjs';
import { readZip, writeZip } from '../../../shared/zip.mjs';

const withH = (fn, o) => async () => { const H = await harness(o); try { await fn(H); } finally { await H.cleanup(); } };
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });

test('install: verifies, stores, records pending-consent with the pinned publisher and an installSeq; journals phases', withH(async (H) => {
  const seen = [];
  H.ops.subscribe((o) => seen.push(o));
  const archive = await H.pack({ permissions: ['ui'] });
  const id = await H.ops.start({ type: 'install', source: archive });
  assert.match(id, /^op-[0-9a-f]{16}$/);
  // durable before start() resolved
  const onDisk = JSON.parse(await readFile(join(H.L.ops, `${id}.json`), 'utf8'));
  assert.equal(onDisk.outcome, 'running');
  const op = await H.ops.whenSettled(id);
  assert.equal(op.outcome, 'succeeded');
  assert.equal(op.awaiting, 'consent');
  assert.deepEqual(op.phases.map((p) => p.name), ['verify', 'compatibility', 'store', 'record']);
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.status, 'pending-consent');
  assert.equal(r.publisher, H.key.publicKey);
  assert.deepEqual(r.grants, []);
  assert.equal(r.installSeq, 1);
  assert.equal(H.ops.state().nextInstallSeq, 2);
  assert.ok(await H.exists(join(H.L.store, 'test.alpha', '1.0.0', 'mod.json')));
  assert.deepEqual(await H.ls(join(H.L.store, '.staging')), []);
  assert.equal((await H.readState()).mods['test.alpha'].status, 'pending-consent');
  assert.equal(H.ops.installed('test.alpha').manifest.id, 'test.alpha');
  // every change was published to subscribers and the bus
  assert.ok(seen.length >= 5);
  assert.equal(H.bus.published.filter((p) => p.topic === 'framework/op').length, seen.length);
  assert.deepEqual(H.ops.list({ modId: 'test.alpha' }).map((o) => o.id), [id]);
  assert.deepEqual(H.ops.list({ running: true }), []);
  assert.equal(H.ops.get(id).outcome, 'succeeded');
}));

test('install: a tampered package is Denied and nothing is recorded', withH(async (H) => {
  const archive = await H.pack();
  const entries = readZip(await readFile(archive)).filter((e) => !e.directory);
  entries.find((e) => e.path === 'host.js').data = Buffer.from('evil()');
  await writeFile(archive, writeZip(entries.map((e) => ({ path: e.path, data: e.data, mode: e.mode }))));
  const op = await H.run({ type: 'install', source: archive });
  assert.equal(op.outcome, 'failed');
  assert.equal(op.error.code, 'Denied');
  assert.deepEqual(H.ops.state().mods, {});
  assert.deepEqual(await H.ls(join(H.L.store, '.staging')), []);
}));

test('install: same id from a different publisher is Denied; same publisher is a Conflict (use update)', withH(async (H) => {
  await H.installApprove();
  const other = keygen();
  const evil = await H.pack({}, {}, other);
  const op = await H.run({ type: 'install', source: evil });
  assert.equal(op.outcome, 'failed');
  assert.equal(op.error.code, 'Denied');
  assert.match(op.error.message, /publisher change is only allowed through update/);
  const same = await H.pack({ version: '1.1.0' });
  const op2 = await H.run({ type: 'install', source: same });
  assert.equal(op2.error.code, 'Conflict');
}));

test('install: a pending-consent install can be replaced; installSeq is never reused (also after remove and reinstall)', withH(async (H) => {
  const a1 = await H.pack();
  await H.run({ type: 'install', source: a1 });
  assert.equal(H.ops.state().mods['test.alpha'].installSeq, 1);
  await H.run({ type: 'install', source: a1 });
  assert.equal(H.ops.state().mods['test.alpha'].installSeq, 2);
  await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.run({ type: 'install', source: a1 });
  assert.equal(H.ops.state().mods['test.alpha'].installSeq, 3);
  assert.equal(H.ops.state().nextInstallSeq, 4);
}));

test('install: dev package replaces a dev package unless enabled; dev vs signed is Denied', withH(async (H) => {
  const dir = await H.devDir({ id: 'dev.mod' });
  let op = await H.run({ type: 'install', source: dir, dev: true });
  assert.equal(op.outcome, 'succeeded');
  let r = H.ops.state().mods['dev.mod'];
  assert.equal(r.publisher, null);
  assert.deepEqual(r.dev, { sourceDir: dir });
  assert.equal(H.ops.installed('dev.mod').packageDir, dir);
  await H.run({ type: 'consent', modId: 'dev.mod', approve: true });
  op = await H.run({ type: 'install', source: dir, dev: true });          // dev replaces dev (disabled)
  assert.equal(op.outcome, 'succeeded');
  assert.equal(H.ops.state().mods['dev.mod'].status, 'pending-consent');
  assert.equal(H.ops.state().mods['dev.mod'].installSeq, 2);
  await H.run({ type: 'consent', modId: 'dev.mod', approve: true, enable: true });
  op = await H.run({ type: 'install', source: dir, dev: true });          // enabled: refuse
  assert.equal(op.error.code, 'Conflict');
  const signed = await H.pack({ id: 'dev.mod' });
  op = await H.run({ type: 'install', source: signed });
  assert.equal(op.error.code, 'Denied');
  assert.deepEqual((await H.ls(H.L.store)).filter((n) => !n.startsWith('.')), []);   // dev packages are never stored
}));

test('install: what a mod needs judged against the build (E4): a missing required one is Incompatible with its sentence; one that cannot be checked is at risk; an optional one degrades', withH(async (H) => {
  const okMethods = await H.pack({ id: 'test.methods', requires: { methods: ['thread/start', 'initialized', 'item/approval', 'turn/completed'] } });
  const ok = await H.run({ type: 'install', source: okMethods });
  assert.deepEqual([ok.outcome, ok.note], ['succeeded', undefined], 'every one of the pack\'s four method lists counts');
  const blocked = await H.pack({ id: 'test.blocked', entry: { renderer: 'r.js' }, requires: { features: ['anchor:statusbar'] } }, { 'r.js': 'x' });
  const op = await H.run({ type: 'install', source: blocked });
  assert.equal(op.outcome, 'failed');
  assert.equal(op.error.code, 'Incompatible');
  assert.match(op.error.message, /It needs the statusbar anchor, which this build of the app lacks \(this build's pack has no such anchor\)/);
  assert.equal(H.ops.state().mods['test.blocked'], undefined);
  const risky = await H.pack({ id: 'test.risky', requires: { methods: ['no/such/method'] } });
  const op3 = await H.run({ type: 'install', source: risky });
  assert.equal(op3.outcome, 'succeeded', 'at risk is shown, never refused');
  assert.match(op3.note, /^At risk: It needs the app-server method no\/such\/method, which could not be checked on this build of the app/);
  const degraded = await H.pack({ id: 'test.degraded', optional: { methods: ['no/such/method'] } });
  const op2 = await H.run({ type: 'install', source: degraded });
  assert.equal(op2.outcome, 'succeeded');
  assert.match(op2.note, /^Degraded: It works without the app-server method no\/such\/method/);
}));

test('compatibility(): anchors by the pack and what a window saw; one the pack lacks blocks, one not seen yet is at risk, never missing (E4)', withH(async (H) => {
  H.adapter = { ...H.adapter, anchors: { sidebar: {}, composer: {} } };
  H.ops = H.create();
  const m = H.packages.validateManifest({ id: 'test.ui', version: '1.0.0', name: 'x', framework: '>=1 <2', entry: { renderer: 'r.js' },
    requires: { features: ['anchor:sidebar'] }, optional: { features: ['anchor:composer'] } });
  const before = H.ops.compatibility(m);
  assert.equal(before.status, 'atRisk', 'not seen yet: unknown, no longer missing');
  assert.deepEqual(before.reasons.map((r) => [r.id, r.status, r.required]), [['anchor:sidebar', 'unknown', true], ['anchor:composer', 'unknown', false]]);
  H.bus.publish('framework/probe', { appBuild: 'b', at: 'x', items: { 'anchor:sidebar': true, 'anchor:composer': false } }, { state: true });
  const seen = H.ops.compatibility(m);
  assert.deepEqual([seen.status, seen.missingRequired, seen.missingOptional], ['degraded', [], []], 'the sidebar seen; the composer not yet');
  assert.match(seen.reasons[0].sentence, /^It works without the composer anchor, which could not be checked on this build of the app/);
  const none = H.packages.validateManifest({ id: 'test.none', version: '1.0.0', name: 'x', framework: '>=1 <2', entry: { host: 'h.js' } });
  assert.deepEqual(H.ops.compatibility(none), { status: 'compatible', missingRequired: [], missingOptional: [], reasons: [], features: [] });
  const lacking = H.packages.validateManifest({ id: 'test.lacking', version: '1.0.0', name: 'x', framework: '>=1 <2', entry: { renderer: 'r.js' }, requires: { features: ['anchor:statusbar'] } });
  assert.deepEqual([H.ops.compatibility(lacking).status, H.ops.compatibility(lacking).missingRequired], ['blocked', ['anchor:statusbar']]);
}));

test('start: a second op for a mod with a running op is a Conflict; ops on other mods run concurrently', withH(async (H) => {
  await H.installApprove();
  await H.installApprove({ id: 'test.beta' });
  let release;
  H.runtime.activateGate = (mod) => (mod.record.id === 'test.alpha' ? new Promise((r) => { release = r; }) : undefined);
  const first = await H.ops.start({ type: 'enable', modId: 'test.alpha' });
  await rejectsCode(H.ops.start({ type: 'disable', modId: 'test.alpha' }), 'Conflict');
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'n', scope: 'app', value: 1 }] }), 'Conflict');
  const other = await H.run({ type: 'enable', modId: 'test.beta' });          // different mod is unaffected
  assert.equal(other.outcome, 'succeeded');
  assert.equal(H.ops.get(first).outcome, 'running');
  assert.deepEqual(H.ops.list({ running: true }).map((o) => o.id), [first]);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  release();
  assert.equal((await H.ops.whenSettled(first)).outcome, 'succeeded');
  await H.ops.whenSettled(await H.ops.start({ type: 'disable', modId: 'test.alpha' }));   // lock released
}));

test('start: invalid input and impossible requests throw Invalid', withH(async (H) => {
  await rejectsCode(H.ops.start({ type: 'bogus' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'enable', modId: '../etc' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'enable', modId: 'test.missing' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'install' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'rollback', modId: 'test.alpha', toVersion: 'x', restoreData: false }), 'Invalid');
  await H.run({ type: 'install', source: await H.pack() });
  await rejectsCode(H.ops.start({ type: 'enable', modId: 'test.alpha' }), 'Invalid');         // pending consent
  await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  await rejectsCode(H.ops.start({ type: 'disable', modId: 'test.alpha' }), 'Invalid');        // not enabled
  await rejectsCode(H.ops.start({ type: 'consent', modId: 'test.alpha', approve: true }), 'Invalid'); // nothing awaiting
  await rejectsCode(H.ops.start({ type: 'clear-quarantine', modId: 'test.alpha' }), 'Invalid');
}));

test('consent: approve grants the manifest permissions and disables; enable activates; deny removes the pending install', withH(async (H) => {
  const a = await H.pack({ permissions: ['ui', 'appServer.observe:turn/completed'] });
  await H.run({ type: 'install', source: a });
  let op = await H.run({ type: 'consent', modId: 'test.alpha', approve: false });
  assert.equal(op.outcome, 'succeeded');
  assert.equal(H.ops.state().mods['test.alpha'], undefined);
  assert.equal(H.ops.installed('test.alpha'), undefined);
  await H.run({ type: 'install', source: a });
  await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.status, 'disabled');
  assert.deepEqual(r.grants, ['ui', 'appServer.observe:turn/completed']);
  assert.deepEqual(H.runtime.names('activate'), []);
  // approve + enable
  const b = await H.pack({ id: 'test.beta' });
  await H.run({ type: 'install', source: b });
  op = await H.run({ type: 'consent', modId: 'test.beta', approve: true, enable: true });
  assert.equal(H.ops.state().mods['test.beta'].status, 'enabled');
  assert.deepEqual(H.runtime.names('activate'), [['test.beta', '1.0.0']]);
  assert.deepEqual(op.phases.map((p) => p.name), ['apply', 'compatibility', 'activate', 'commit']);
}));

test('enable/disable call the Runtime and persist status', withH(async (H) => {
  await H.installApprove();
  let op = await H.run({ type: 'enable', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded');
  assert.equal((await H.readState()).mods['test.alpha'].status, 'enabled');
  assert.deepEqual(H.runtime.names('activate'), [['test.alpha', '1.0.0']]);
  op = await H.run({ type: 'disable', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded');
  assert.equal((await H.readState()).mods['test.alpha'].status, 'disabled');
  assert.deepEqual(H.runtime.names('deactivate').at(-1), ['test.alpha', 'disable']);
}));

test('enable: activation failure leaves the mod disabled; effectsAttempted false → failed, true → needs-attention', withH(async (H) => {
  await H.installApprove();
  H.runtime.activateErrors.set('test.alpha', activationError(false, 'no side effects'));
  let op = await H.run({ type: 'enable', modId: 'test.alpha' });
  assert.equal(op.outcome, 'failed');
  assert.equal(op.error.code, 'Unavailable');
  assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
  H.runtime.activateErrors.set('test.alpha', activationError(true, 'it transmitted something'));
  op = await H.run({ type: 'enable', modId: 'test.alpha' });
  assert.equal(op.outcome, 'needs-attention');
  assert.match(op.note, /it transmitted something/);
  assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
  assert.equal((await H.readState()).mods['test.alpha'].status, 'disabled');
  H.runtime.activateErrors.delete('test.alpha');
  op = await H.run({ type: 'enable', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded');
}));

test('enable: a mod that became incompatible is refused', withH(async (H) => {
  H.adapter = { ...H.adapter, anchors: { sidebar: {} } };
  H.ops = H.create();
  await H.installApprove({ entry: { renderer: 'r.js' }, requires: { features: ['anchor:sidebar'] } }, { files: { 'r.js': 'x' } });
  // the app build changed under it: this one's pack has no sidebar anchor
  H.adapter = { ...H.adapter, anchors: {} };
  H.ops = H.create();
  const op = await H.run({ type: 'enable', modId: 'test.alpha' });
  assert.equal(op.outcome, 'failed');
  assert.equal(op.error.code, 'Incompatible');
  assert.match(op.error.message, /It needs the sidebar anchor, which this build of the app lacks/);
}));

test('configure: validates against its declarations, writes settings.json atomically, then notifies the Runtime', withH(async (H) => {
  const settings = [{ key: 'prompt', kind: 'text', title: 'Prompt', default: 'hi' }, { key: 'n', kind: 'number', title: 'N', default: 1, min: 1 }];
  const set = (key, value) => [{ key, scope: 'app', value }];
  await H.installApprove({ settings });
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: set('n', 0) }), 'Invalid');
  let op = await H.run({ type: 'configure', modId: 'test.alpha', patches: set('n', 2) });
  assert.equal(op.outcome, 'succeeded');
  assert.deepEqual(JSON.parse(await H.readData('test.alpha', 'settings.json')), { n: 2 });
  assert.deepEqual(H.runtime.names('settingsChanged'), [], 'not active: no notification');
  await H.run({ type: 'enable', modId: 'test.alpha' });
  op = await H.run({ type: 'configure', modId: 'test.alpha', patches: set('prompt', 'yo') });
  assert.deepEqual(H.runtime.names('settingsChanged').at(-1).slice(0, 2), ['test.alpha', { prompt: 'yo', n: 2 }], 'its whole document');
  assert.deepEqual(op.phases.map((p) => p.name), ['write', 'notify']);
  const noSettings = await H.installApprove({ id: 'test.plain' });
  await rejectsCode(H.ops.start({ type: 'configure', modId: noSettings, patches: set('n', 1) }), 'Invalid');
}));

test('clear-quarantine and quarantine(): quarantine deactivates, journals a disable op with a note; clearing sets disabled', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.ops.quarantine('test.alpha', 'repeated faults');
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.status, 'quarantined');
  assert.equal(r.quarantine.reason, 'repeated faults');
  assert.deepEqual(H.runtime.names('deactivate').at(-1), ['test.alpha', 'quarantine']);
  const q = H.ops.list({ modId: 'test.alpha' }).at(-1);
  assert.equal(q.input.type, 'disable');
  assert.equal(q.outcome, 'succeeded');
  assert.match(q.note, /repeated faults/);
  await rejectsCode(H.ops.start({ type: 'enable', modId: 'test.alpha' }), 'Invalid');
  const op = await H.run({ type: 'clear-quarantine', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded');
  const after = H.ops.state().mods['test.alpha'];
  assert.equal(after.status, 'disabled');
  assert.equal(after.quarantine, undefined);
}));

test('F5: reload stops and starts it as one operation, clearing a quarantine and keeping every choice', withH(async (H) => {
  const action = { id: 'go', operation: 'Thread.send', why: 'Keeps it going', perHour: 5 };
  await H.installApprove({ automatic: [action] }, { enable: true });
  await H.run({ type: 'set-automatic', modId: 'test.alpha', action: 'go', on: true });
  await H.run({ type: 'set-policy', modId: 'test.alpha', policy: 'quiet', on: false });
  const before = H.runtime.names('activate').length;
  const op = await H.run({ type: 'reload', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded');
  assert.deepEqual(H.runtime.names('deactivate').at(-1), ['test.alpha', 'reload']);
  assert.equal(H.runtime.names('activate').length, before + 1);
  const on = H.ops.state().mods['test.alpha'];
  assert.equal(on.status, 'enabled');
  assert.ok(on.automatic.go, 'its automatic action stays on, which turning it off and on would end');
  assert.deepEqual(on.policiesOff, ['quiet']);
  await H.ops.quarantine('test.alpha', 'repeated faults');
  assert.equal((await H.run({ type: 'reload', modId: 'test.alpha' })).outcome, 'succeeded');
  const back = H.ops.state().mods['test.alpha'];
  assert.equal(back.status, 'enabled');
  assert.equal(back.quarantine, undefined);
}));

test('F5: reload refused while it is off or awaiting consent; one that cannot start again is left stopped, saying why', withH(async (H) => {
  await H.run({ type: 'install', source: await H.pack() });
  await rejectsCode(H.ops.start({ type: 'reload', modId: 'test.alpha' }), 'Invalid');
  await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
  await rejectsCode(H.ops.start({ type: 'reload', modId: 'test.alpha' }), 'Invalid');
  await H.run({ type: 'enable', modId: 'test.alpha' });
  H.runtime.activateErrors.set('test.alpha', activationError(false, 'did not start'));
  const op = await H.run({ type: 'reload', modId: 'test.alpha' });
  assert.equal(op.outcome, 'failed');
  const r = H.ops.state().mods['test.alpha'];
  assert.equal(r.status, 'quarantined');
  assert.match(r.quarantine.reason, /It could not start again: .*did not start/);
  H.runtime.activateErrors.clear();
  assert.equal((await H.run({ type: 'reload', modId: 'test.alpha' })).outcome, 'succeeded');
  H.runtime.activateErrors.set('test.alpha', activationError(true, 'half started'));
  assert.equal((await H.run({ type: 'reload', modId: 'test.alpha' })).outcome, 'needs-attention', 'it may have acted on the outside world');
}));

test('F5: a stopped mod can be switched off: it stays off, with what stopped it, and turning it on again starts it and clears that', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  await H.ops.quarantine('test.alpha', 'repeated faults');
  assert.equal((await H.run({ type: 'disable', modId: 'test.alpha' })).outcome, 'succeeded');
  const off = H.ops.state().mods['test.alpha'];
  assert.equal(off.status, 'disabled');
  assert.equal(off.quarantine.reason, 'repeated faults');
  assert.equal((await H.run({ type: 'enable', modId: 'test.alpha' })).outcome, 'succeeded');
  const on = H.ops.state().mods['test.alpha'];
  assert.equal(on.status, 'enabled');
  assert.equal(on.quarantine, undefined);
}));

test('F9: its last fault is kept in its record, with where and its stack, and a Host restart does not lose it', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  const fault = (e) => { for (const f of H.runtime.faultFns) f(e); };
  fault({ modId: 'test.alpha', realm: 'renderer', kind: 'throw', message: 'It threw', where: 'ComposerBand (x)', stack: 'at line 1' });
  const r = H.ops.state().mods['test.alpha'];
  assert.deepEqual([r.lastFault.message, r.lastFault.where, r.lastFault.stack], ['It threw', 'ComposerBand (x)', 'at line 1']);
  fault({ modId: 'test.alpha', realm: 'host', kind: 'crash', message: 'gone' });
  assert.equal(H.ops.state().mods['test.alpha'].lastFault.where, 'host (crash)', 'a fault that says no place says its realm');
  fault({ modId: 'not.here', realm: 'host', kind: 'crash', message: 'x' });
  await H.ops.quarantine('test.alpha', 'faults');
  assert.equal(JSON.parse(await readFile(H.L.state, 'utf8')).mods['test.alpha'].lastFault.message, 'gone');
}));

test('F8: consent decides each optional permission by its default; a decision is set by an operation that restarts a running mod, unless it only gains', withH(async (H) => {
  const m = { permissions: ['ui'], optionalPermissions: ['secrets', 'graph.read'] };
  await H.installApprove(m, { enable: true });
  let r = H.ops.state().mods['test.alpha'];
  assert.deepEqual([r.grants, r.decisions], [['ui'], { secrets: 'ask', 'graph.read': 'deny' }], 'an ask is not held outright');
  const starts = () => H.runtime.names('activate').length;
  let before = starts();
  assert.equal((await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'graph.read', decision: 'allow' })).outcome, 'succeeded');
  r = H.ops.state().mods['test.alpha'];
  assert.deepEqual([r.grants, r.decisions['graph.read']], [['ui', 'graph.read'], 'allow']);
  assert.equal(starts(), before + 1, 'deny to allow: restarted, so what it holds at activation follows');
  before = starts();
  assert.equal((await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'secrets', decision: 'allow' })).outcome, 'succeeded');
  assert.equal(starts(), before, 'ask to allow takes nothing away: not restarted');
  assert.deepEqual(H.ops.state().mods['test.alpha'].grants, ['ui', 'secrets', 'graph.read']);
  before = starts();
  await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'secrets', decision: 'deny' });
  assert.equal(starts(), before + 1, 'taken away: restarted');
  assert.deepEqual(H.runtime.names('deactivate').at(-1), ['test.alpha', 'permission']);
  assert.deepEqual(H.ops.state().mods['test.alpha'].grants, ['ui', 'graph.read']);
  await rejectsCode(H.ops.start({ type: 'set-permission', modId: 'test.alpha', grant: 'ui', decision: 'deny' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'set-permission', modId: 'test.alpha', grant: 'graph.read', decision: 'ask' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'set-permission', modId: 'test.alpha', grant: 'network', decision: 'allow' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'set-permission', modId: 'test.alpha', grant: 'secrets', decision: 'maybe' }), 'Invalid');
  await H.run({ type: 'disable', modId: 'test.alpha' });
  before = starts();
  await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'secrets', decision: 'allow' });
  assert.equal(starts(), before, 'off: nothing to restart');
}));

test('F8: an update keeps a decision, gives a new optional permission its default, and asks consent for an optional one become required', withH(async (H) => {
  await H.installApprove({ permissions: ['ui'], optionalPermissions: ['secrets', 'graph.read'] }, { enable: true });
  await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'graph.read', decision: 'allow' });
  let op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0', permissions: ['ui'], optionalPermissions: ['secrets', 'graph.read', 'graph.act:Thread.archive'] }) });
  assert.equal(op.outcome, 'succeeded');
  let r = H.ops.state().mods['test.alpha'];
  assert.deepEqual(r.decisions, { secrets: 'ask', 'graph.read': 'allow', 'graph.act:Thread.archive': 'ask' });
  assert.deepEqual(r.grants, ['ui', 'graph.read']);
  op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.2.0', permissions: ['ui', 'graph.read'], optionalPermissions: ['secrets'] }) });
  assert.equal(op.awaiting, 'consent', 'allowed while optional, required now: asked again');
  assert.deepEqual(H.ops.state().mods['test.alpha'].pendingUpdate.addedPermissions, ['graph.read']);
}));

test('F8: a rollback never raises a decision', withH(async (H) => {
  await H.installApprove({ permissions: ['ui'], optionalPermissions: ['graph.read'] }, { enable: true });
  await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'graph.read', decision: 'allow' });
  await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.1.0', permissions: ['ui'], optionalPermissions: ['graph.read'] }) });
  await H.run({ type: 'set-permission', modId: 'test.alpha', grant: 'graph.read', decision: 'deny' });
  const op = await H.run({ type: 'rollback', modId: 'test.alpha', toVersion: '1.0.0', restoreData: false });
  assert.equal(op.outcome, 'succeeded', op.note ?? op.error?.message);
  const r = H.ops.state().mods['test.alpha'];
  assert.deepEqual([r.version, r.decisions, r.grants], ['1.0.0', { 'graph.read': 'deny' }, ['ui']]);
}));

test('quarantine during a running op is applied when the op ends', withH(async (H) => {
  await H.installApprove();
  let release;
  H.runtime.activateGate = () => new Promise((r) => { release = r; });
  const quarantined = new Promise((resolve) => { H.ops.subscribe((o) => { if (o.input.type === 'disable' && o.outcome === 'succeeded') resolve(o); }); });
  const id = await H.ops.start({ type: 'enable', modId: 'test.alpha' });
  while (!release) await new Promise((r) => setTimeout(r, 5));
  await H.ops.quarantine('test.alpha', 'faulted while starting');
  release();
  assert.equal((await H.ops.whenSettled(id)).outcome, 'succeeded');
  const q = await quarantined;                      // announced after its journal record is written
  assert.match(q.note, /faulted while starting/);
  assert.equal(H.ops.state().mods['test.alpha'].status, 'quarantined');
}));

test('activateAll: enabled mods in the user\'s order (the install order until one is set, E6); failure quarantines only that mod; skipped in safe mode', withH(async (H) => {
  for (const id of ['test.c', 'test.a', 'test.b']) await H.installApprove({ id }, { enable: true });
  H.runtime.calls.length = 0; H.runtime.active.clear();
  H.runtime.activateErrors.set('test.b', activationError(true, 'cannot start'));
  await H.ops.activateAll();
  assert.deepEqual(H.runtime.names('activate').map((a) => a[0]), ['test.c', 'test.a', 'test.b']);
  const mods = H.ops.state().mods;
  assert.equal(mods['test.a'].status, 'enabled');
  assert.equal(mods['test.b'].status, 'quarantined');
  assert.match(mods['test.b'].quarantine.reason, /cannot start/);
  assert.equal(mods['test.c'].status, 'enabled');
  // safe mode via state
  H.runtime.calls.length = 0;
  await H.ops.setSafeMode(true);
  assert.equal((await H.readState()).safeMode, true);
  await H.ops.activateAll();
  assert.deepEqual(H.runtime.names('activate'), []);
  await H.ops.setSafeMode(false);
  assert.equal((await H.readState()).safeMode, false);
}));

test('activateAll is skipped when the Host starts in safe mode (constructor flag)', async () => {
  const H = await harness({ safeMode: true });
  try {
    await H.installApprove({}, { enable: true });
    H.runtime.calls.length = 0;
    await H.ops.activateAll();
    assert.deepEqual(H.runtime.names('activate'), []);
    // enabling in safe mode only records the desire
    await H.installApprove({ id: 'test.beta' });
    const op = await H.run({ type: 'enable', modId: 'test.beta' });
    assert.equal(op.outcome, 'succeeded');
    assert.match(op.note, /Safe mode/);
    assert.deepEqual(H.runtime.names('activate'), []);
  } finally { await H.cleanup(); }
});

test('state survives a restart of Operations on the same root', withH(async (H) => {
  await H.installApprove({}, { enable: true });
  const again = H.create();
  assert.equal(again.state().mods['test.alpha'].status, 'enabled');
  assert.equal(again.list().length, H.ops.list().length);
  assert.equal(again.installed('test.alpha').packageDir, join(H.L.store, 'test.alpha', '1.0.0'));
}));

test('framework-level ops delegate to Recovery.runOp and copy result and note', withH(async (H) => {
  H.recovery.runOpImpl = async (op, journal) => { await journal('step-one'); return { outcome: 'succeeded', note: 'swapped', result: { candidate: '/x' } }; };
  const op = await H.run({ type: 'app-prepare' });
  assert.equal(op.outcome, 'succeeded');
  assert.equal(op.note, 'swapped');
  assert.deepEqual(op.result, { candidate: '/x' });
  assert.deepEqual(op.phases.map((p) => p.name), ['step-one']);
  assert.equal(H.recovery.ran[0].input.type, 'app-prepare');
  // one framework op at a time; an outcome of 'running' keeps the record (and the lock) open
  H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'awaiting swap receipt' });
  const id = await H.ops.start({ type: 'app-switch', candidate: '/a/b' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(H.ops.get(id).outcome, 'running');
  assert.equal(H.ops.get(id).note, 'awaiting swap receipt');
  await rejectsCode(H.ops.start({ type: 'safe-mode', enter: true }), 'Conflict');
  // failures are recorded
  const H2 = await harness();
  try {
    H2.recovery.runOpImpl = async () => { throw new Error('nope'); };
    const f = await H2.run({ type: 'lkg-restore' });
    assert.equal(f.outcome, 'failed');
    assert.match(f.error.message, /nope/);
  } finally { await H2.cleanup(); }
}));

test('restoreFromGeneration restores matching mods and settings, parks the rest, never touches data', withH(async (H) => {
  const settings = [{ key: 'v', kind: 'number', title: 'V', default: 1 }];
  await H.installApprove({ id: 'test.same', settings }, { enable: true });
  await H.installApprove({ id: 'test.schema', data: { schemaVersion: 2 } }, { enable: true });
  await H.installApprove({ id: 'test.extra' }, { enable: true });
  await H.installApprove({ id: 'test.gone' }, { enable: false });
  await H.writeData('test.same', 'keep-me', 'store.json');
  const gen = {
    n: 3, appBuild: 'b', frameworkVersion: '1', adapterVersion: '1', mods: [], settingsHash: '', createdAt: 'x',
    state: { schemaVersion: 1, safeMode: false, nextInstallSeq: 2, mods: {
      'test.same': { ...H.ops.state().mods['test.same'], status: 'disabled', installSeq: 99 },
      'test.schema': { ...H.ops.state().mods['test.schema'], dataSchemaVersion: 1 },
      'test.vanished': { ...H.ops.state().mods['test.same'], id: 'test.vanished' },
    } },
    settings: { 'test.same': { v: 7 } },
  };
  const res = await H.ops.restoreFromGeneration(gen);
  assert.deepEqual(res.restored, ['test.same']);
  const byId = Object.fromEntries(res.leftDisabled.map((d) => [d.modId, d.reason]));
  assert.match(byId['test.schema'], /schema 2.*expects 1/);
  assert.match(byId['test.vanished'], /not installed/);
  assert.match(byId['test.extra'], /not part of the generation/);
  const mods = H.ops.state().mods;
  assert.equal(mods['test.same'].status, 'disabled');                 // from the generation
  assert.equal(mods['test.same'].installSeq, 1, 'installSeq of the current install is kept');
  assert.equal(mods['test.schema'].status, 'disabled');
  assert.equal(mods['test.extra'].status, 'disabled');
  assert.deepEqual(JSON.parse(await H.readData('test.same', 'settings.json')), { v: 7 });
  assert.equal(await H.readData('test.same', 'store.json'), 'keep-me');
  assert.equal((await H.readState()).mods['test.extra'].status, 'disabled');
  assert.deepEqual(H.runtime.names('deactivate').map((d) => d[0]).sort(), ['test.extra', 'test.same', 'test.schema']);
}));

test('install (dev) from an unreadable directory fails Unavailable with the path and errno, not "file not found" (F9)', withH(async (H) => {
  const dir = await H.devDir({ id: 'dev.locked' });
  await chmod(dir, 0o000);
  try {
    const op = await H.run({ type: 'install', source: dir, dev: true });
    assert.equal(op.outcome, 'failed');
    assert.equal(op.error.code, 'Unavailable');
    assert.match(op.error.message, /^cannot read .*mod\.json: EACCES$/);
  } finally { await chmod(dir, 0o700); }
  const missing = join(H.root, 'no mod json here');
  await mkdir(missing);
  const op2 = await H.run({ type: 'install', source: missing, dev: true });
  assert.equal(op2.error.code, 'Invalid');
  assert.match(op2.error.message, /^mod\.json missing in /);
  assert.equal(H.ops.state().mods['dev.locked'], undefined);
}));

test('F10: an install records where it came from: a GitHub release as management found it (checked), a file, a folder', withH(async (H) => {
  const digest = `sha256:${'c'.repeat(64)}`;
  await rejectsCode(H.ops.start({ type: 'install', source: await H.pack(), github: { repo: 'acme/focus', repoId: '42', tag: 'v1', digest } }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'install', source: await H.pack(), github: { repo: '../x', repoId: 42, tag: 'v1', digest } }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'install', source: await H.pack(), github: { repo: 'acme/focus', repoId: 42, tag: 'v1', digest: 'sha256:short' } }), 'Invalid');
  const pkg = await H.pack();
  let op = await H.run({ type: 'install', source: pkg, github: { repo: 'acme/focus', repoId: 42, tag: 'v1', digest } });
  assert.equal(op.outcome, 'failed', 'not the package found: its digest');
  assert.equal(op.error.code, 'Denied');
  const real = `sha256:${createHash('sha256').update(await readFile(pkg)).digest('hex')}`;
  op = await H.run({ type: 'install', source: pkg, github: { repo: 'acme/focus', repoId: 42, tag: 'v1', digest: real, extra: 'dropped' } });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(H.ops.state().mods['test.alpha'].source, { kind: 'github', repo: 'acme/focus', repoId: 42, tag: 'v1', digest: real });
  op = await H.run({ type: 'install', source: await H.pack({ id: 'test.file' }) });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(H.ops.state().mods['test.file'].source, { kind: 'file' });
  const dir = await H.devDir({ id: 'test.dev' });
  op = await H.run({ type: 'install', source: dir, dev: true });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.equal(H.ops.state().mods['test.dev'].source.kind, 'folder');
  await rejectsCode(H.ops.start({ type: 'consent', modId: 'test.alpha', approve: true, allow: 'secrets' }), 'Invalid');
}));

test('F12: Developer mode is one stored flag: written, kept by a restart, and nothing changes when the write fails', withH(async (H) => {
  assert.equal(H.ops.state().developerMode, undefined);
  assert.deepEqual(await H.ops.setDeveloperMode(true), { developerMode: true });
  assert.equal((await H.readState()).developerMode, true);
  assert.deepEqual(await H.ops.setDeveloperMode(true), { developerMode: true }, 'unchanged: no write');
  const again = H.create();
  await again.recover();
  assert.equal(again.state().developerMode, true, 'kept');
  assert.deepEqual(await again.setDeveloperMode(false), { developerMode: false });
  assert.equal((await H.readState()).developerMode, false);
}));

test('F8: a last-known-good restore never raises a decision: a grant the restored version required, optional now and set lower, leaves the mod as it is (FU5/FU6 review)', withH(async (H) => {
  await H.installApprove({ id: 'test.req', permissions: ['secrets'] }, { enable: false });
  const v1 = structuredClone(H.ops.state().mods['test.req']);
  let op = await H.run({ type: 'update', modId: 'test.req', source: await H.pack({ id: 'test.req', version: '1.1.0', permissions: [], optionalPermissions: ['secrets'] }) });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  op = await H.run({ type: 'set-permission', modId: 'test.req', grant: 'secrets', decision: 'deny' });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  const gen = { n: 4, appBuild: 'b', frameworkVersion: '1', adapterVersion: '1', mods: [], settingsHash: '', createdAt: 'x',
    state: { schemaVersion: 1, safeMode: false, nextInstallSeq: 2, mods: { 'test.req': v1 } } };
  const res = await H.ops.restoreFromGeneration(gen);
  assert.deepEqual(res.restored, []);
  assert.match(res.leftDisabled.find((d) => d.modId === 'test.req').reason, /would hold secrets again, which you set to deny/);
  const r = H.ops.state().mods['test.req'];
  assert.deepEqual([r.version, r.grants, r.decisions], ['1.1.0', [], { secrets: 'deny' }]);
}));
