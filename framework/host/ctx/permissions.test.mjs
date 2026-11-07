// ctx under a grant decided `ask` (docs/design/framework-ui.md F8): a secret and a request to Codex wait for the user, the held grants go through as they always did, the framework
// scope never asks; ctx.permissions says what the mod holds, asks for an optional one, and hears what it gains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admit, createPermissionsNs } from './permissions.mjs';
import { createSecretsNs } from './secrets.mjs';
import { createAppServerNs } from './appserver.mjs';

const scopeOf = (grants, o = {}) => ({ state: { id: 'm.one', grants, status: 'active', mod: { manifest: o.manifest ?? {}, record: { publisher: null } }, ...(o.framework ? { framework: true } : {}), mux: o.mux }, realm: 'host' });
function gate(answers = {}) {
  const held = [];
  const p = {
    askFor: (modId, grants, test) => ['secrets', 'appServer.request:thread/start'].find((g) => test([...grants, g])) ?? null,
    hold: async (modId, grant, o) => { held.push([modId, grant, o.what]); if (answers[grant] === 'deny') throw Object.assign(new Error(`you did not allow ${o.what}`), { code: 'Denied' }); },
  };
  return { p, held, permissions: () => p };
}

test('a call the held grants admit goes through without asking; one only an ask admits waits for the user; one nothing admits is refused as before', async () => {
  const g = gate();
  await admit(scopeOf(['secrets']), g.permissions, (gr) => { if (!gr.includes('secrets')) throw new Error('not granted'); }, 'x');
  assert.deepEqual(g.held, []);
  await admit(scopeOf([]), g.permissions, (gr) => { if (!gr.includes('secrets')) throw new Error('not granted'); }, 'read its secret');
  assert.deepEqual(g.held, [['m.one', 'secrets', 'read its secret']]);
  await assert.rejects(admit(scopeOf([]), g.permissions, (gr) => { if (!gr.includes('graph.read')) throw new Error('graph.read is not granted'); }, 'x'), /graph\.read is not granted/);
  await assert.rejects(admit(scopeOf([], { framework: true }), g.permissions, (gr) => { if (!gr.includes('secrets')) throw new Error('not granted'); }, 'x'), /not granted/, 'the framework scope never asks');
  assert.equal(g.held.length, 1);
});

test('a secret and a request to Codex under ask: held, then done; the user\'s Deny refuses them and nothing is read or sent', async () => {
  const keychain = { get: async (id, fp, name) => `value of ${name}`, set: async () => {}, delete: async () => {} };
  const yes = gate();
  const secrets = createSecretsNs({ keychain, permissions: yes.permissions });
  assert.equal(await secrets.calls.get(scopeOf([]), 'token'), 'value of token');
  assert.deepEqual(yes.held, [['m.one', 'secrets', 'read its secret token']]);
  const no = gate({ secrets: 'deny' });
  await assert.rejects(createSecretsNs({ keychain, permissions: no.permissions }).calls.get(scopeOf([]), 'token'), /you did not allow read its secret token/);
  const sent = [];
  const mux = { request: async (method) => { sent.push(method); return { ok: true }; }, notify: (method) => sent.push(method) };
  const app = createAppServerNs({ permissions: yes.permissions });
  assert.deepEqual(await app.calls.request(scopeOf([], { mux }), 'thread/start', {}), { ok: true });
  assert.deepEqual(yes.held.at(-1), ['m.one', 'appServer.request:thread/start', 'send thread/start to Codex']);
  const blocked = createAppServerNs({ permissions: gate({ 'appServer.request:thread/start': 'deny' }).permissions });
  await assert.rejects(blocked.calls.request(scopeOf([], { mux }), 'thread/start', {}), /did not allow/);
  await assert.rejects(blocked.calls.request(scopeOf([], { mux }), 'turn/start', {}), /not granted|appServer\.request/, 'nothing admits it: refused as before');
  assert.deepEqual(sent, ['thread/start'], 'nothing sent when it was not allowed');
});

test('ctx.permissions: what it holds, a request, a change it hears; never the framework scope, never while it starts', async () => {
  const told = [];
  let listener = null;
  const p = {
    state: (id, grant) => (grant === 'secrets' ? 'ask' : 'allow'),
    request: async (id, grant, manifest, text) => { told.push([grant, text]); return { granted: true }; },
    onChange: (id, fn) => { listener = fn; return { dispose() {} }; },
  };
  const ns = createPermissionsNs({ permissions: () => p });
  assert.equal(ns.calls.state(scopeOf([]), 'secrets'), 'ask');
  assert.deepEqual(await ns.calls.request(scopeOf([]), 'secrets', { title: 'Keep your token?' }), { granted: true });
  assert.deepEqual(told, [['secrets', { title: 'Keep your token?', subtitle: undefined, body: undefined }]]);
  assert.throws(() => ns.calls.request(scopeOf([]), 'secrets', { title: 'x'.repeat(201) }), /title is text of at most 200/);
  assert.throws(() => ns.calls.request({ ...scopeOf([]), state: { ...scopeOf([]).state, status: 'activating' } }, 'secrets'), /not while the mod starts/);
  assert.throws(() => ns.calls.state(scopeOf([], { framework: true }), 'secrets'), /no permissions of a mod/);
  assert.throws(() => ns.calls.state(scopeOf([]), 5), /a grant is a permission string/);
  const heard = [];
  ns.subs.onChange(scopeOf([]), [], (e) => heard.push(e));
  listener('secrets', 'allow');
  assert.deepEqual(heard, [{ grant: 'secrets', decision: 'allow' }]);
});
