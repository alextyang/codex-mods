// The method-class table (R15) against the newest build's protocol schemas: complete, no stale entries, well-formed, and consistent with the
// mux's SECRET_METHODS. A new build's methods fail here until they are classified in method-classes.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD_CLASSES, classOf } from './method-classes.mjs';
import { SECRET_METHODS } from './observers.mjs';
import { newestBuild, protocolMethods } from '../../../tests/fixtures/captures.mjs';
import { schemaRoot } from '../../../tests/fixtures/schema-check.mjs';

const build = newestBuild();
const protocol = protocolMethods(build);

/** The client requests of the build's root bundle (schemaRoot prefers the experimental bundle, a superset of the stable one). */
function bundleClientRequests() {
  const union = schemaRoot(build).definitions.ClientRequest;
  return new Set((union.oneOf ?? union.anyOf).map((b) => b?.properties?.method?.enum?.[0] ?? b?.properties?.method?.const).filter((m) => typeof m === 'string'));
}

test(`client requests of build ${build}: the two readings of the schema agree and include the experimental methods`, () => {
  const fromBundle = bundleClientRequests();
  assert.ok(protocol.clientRequest.size > 100, `read ${protocol.clientRequest.size} client requests`);
  assert.ok(protocol.experimental.size > 0, 'the experimental bundle contributes methods');
  assert.deepEqual([...fromBundle].sort(), [...protocol.clientRequest].sort());
});

test('every client request of the newest build has a class, and every entry names a client request of it', () => {
  const methods = protocol.clientRequest;
  const missing = [...methods].filter((m) => classOf(m) === null).sort();
  const stale = Object.keys(METHOD_CLASSES).filter((m) => !methods.has(m)).sort();
  assert.deepEqual(missing, [], `classify these methods of build ${build} in method-classes.mjs`);
  assert.deepEqual(stale, [], `these entries are not client requests of build ${build}`);
  assert.equal(Object.keys(METHOD_CLASSES).length, methods.size);
});

test('every record has exactly effect, secret and replaySafe, with valid values', () => {
  assert.ok(Object.isFrozen(METHOD_CLASSES));
  for (const [method, c] of Object.entries(METHOD_CLASSES)) {
    assert.deepEqual(Object.keys(c).sort(), ['effect', 'replaySafe', 'secret'], method);
    assert.ok(['read', 'mutate', 'external'].includes(c.effect), `${method}: effect ${c.effect}`);
    assert.equal(typeof c.secret, 'boolean', `${method}: secret`);
    assert.equal(typeof c.replaySafe, 'boolean', `${method}: replaySafe`);
    assert.ok(Object.isFrozen(c), `${method}: record is frozen`);
    if (c.effect === 'read') assert.equal(c.replaySafe, true, `${method}: a read can always be sent twice`);
  }
});

test('every SECRET_METHODS member that is a client request is marked secret', () => {
  // SECRET_METHODS (observers.mjs) covers frames in any direction. Its members that are client requests of this build must be secret here; the others
  // are server requests (account/chatgptAuthTokens/refresh, attestation/generate) or no longer exist (getAuthStatus) and are not classified.
  const classified = [...SECRET_METHODS].filter((m) => classOf(m) !== null);
  assert.ok(classified.length >= 4, `classified secret methods: ${classified.join(', ')}`);
  for (const m of SECRET_METHODS) {
    if (classOf(m)) assert.equal(classOf(m).secret, true, `${m} is in SECRET_METHODS`);
    else assert.equal(protocol.clientRequest.has(m), false, `${m} is a client request but has no class`);
  }
});

test('every client request marked secret is redacted in the boot ring (SECRET_METHODS derives from the classes)', () => {
  for (const [m, c] of Object.entries(METHOD_CLASSES)) if (c.secret) assert.ok(SECRET_METHODS.has(m), `${m} is secret but the ring would keep its content`);
  assert.ok(SECRET_METHODS.has('environment/add') && SECRET_METHODS.has('remoteControl/pairing/start'));
});

test('the QA recorder redacts every method the ring redacts (it repeats the list: a mod cannot import it)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../../scripts/qa/mods/qa.record/host.mjs', import.meta.url), 'utf8');
  for (const m of SECRET_METHODS) assert.ok(src.includes(`'${m}'`), `qa.record does not redact ${m}`);
});

test('the secret client requests are the ones whose params or result carry credentials', () => {
  const secrets = Object.entries(METHOD_CLASSES).filter(([, c]) => c.secret).map(([m]) => m).sort();
  assert.deepEqual(secrets, [
    'account/bedrock/setup', 'account/gatewayOAuth/login', 'account/login/start', 'environment/add', 'mcpServer/oauth/login',
    'remoteControl/pairing/start', 'remoteControl/pairing/status', 'userVerification/verify',
  ]);
});

test('spot checks', () => {
  assert.deepEqual(classOf('thread/list'), { effect: 'read', secret: false, replaySafe: true });
  assert.deepEqual(classOf('thread/name/set'), { effect: 'mutate', secret: false, replaySafe: true });
  assert.deepEqual(classOf('turn/start'), { effect: 'external', secret: false, replaySafe: false });
  assert.deepEqual(classOf('account/login/start'), { effect: 'external', secret: true, replaySafe: false });
  // replaySafe: resume and unsubscribe yes; anything that creates, starts, sends or appends no
  assert.equal(classOf('thread/resume').replaySafe, true);
  assert.equal(classOf('thread/unsubscribe').replaySafe, true);
  for (const m of ['thread/start', 'thread/fork', 'thread/queue/add', 'thread/inject_items', 'turn/steer', 'review/start', 'thread/compact/start', 'command/exec', 'process/spawn']) {
    assert.equal(classOf(m).replaySafe, false, m);
  }
  // external: model traffic, processes, file writes, network and login flows
  for (const m of ['turn/steer', 'review/start', 'thread/compact/start', 'thread/shellCommand', 'command/exec', 'process/spawn', 'fs/writeFile', 'mcpServer/oauth/login', 'marketplace/add', 'feedback/upload']) {
    assert.equal(classOf(m).effect, 'external', m);
  }
  // read: lists, reads, gets
  for (const m of ['thread/read', 'thread/turns/list', 'model/list', 'config/read', 'account/read', 'fs/readFile', 'thread/goal/get', 'mcpServerStatus/list']) {
    assert.equal(classOf(m).effect, 'read', m);
  }
});

test('classOf returns null for an unknown method, for a non-client-request method and for names on the prototype chain', () => {
  assert.equal(classOf('no/such/method'), null);
  assert.equal(classOf('turn/started'), null); // a server notification
  assert.equal(classOf('item/commandExecution/requestApproval'), null); // a server request
  assert.equal(classOf('constructor'), null);
  assert.equal(classOf('__proto__'), null);
  assert.equal(classOf(undefined), null);
});
