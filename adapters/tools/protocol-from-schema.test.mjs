import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProtocol, methodsOfSchema, protocolFromDir } from './protocol-from-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(here, '..', '..', 'contracts', 'upstream', '26.1007.21159-20052', 'schema');

test('method counts match the 20052 schema (105, 1, 10, 84)', () => {
  const p = protocolFromDir(SCHEMA);
  assert.equal(p.methods.clientRequests.length, 105);
  assert.equal(p.methods.clientNotifications.length, 1);
  assert.equal(p.methods.serverRequests.length, 10);
  assert.equal(p.methods.serverNotifications.length, 84);
  assert.deepEqual(p.handshake, { request: 'initialize', notification: 'initialized' });
  assert.deepEqual(p.affinityKeyPaths, ['params.threadId']);
  assert.deepEqual(p.affinityCreators.map((c) => c.method), ['thread/start', 'thread/resume', 'thread/fork']);
  assert.ok(p.affinityCreators.every((c) => c.resultPath === 'thread.id'));
  assert.ok(p.methods.clientRequests.includes('turn/start'));
  assert.equal(new Set(p.methods.serverNotifications).size, 84);
});

test('the committed adapter.json protocol is exactly what the generator produces', () => {
  const file = join(here, '..', '26.1007.21159-20052', 'adapter.json');
  if (!existsSync(file)) return; // generated later in the milestone order
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).protocol, protocolFromDir(SCHEMA));
});

test('malformed schemas fail loudly', () => {
  assert.throws(() => methodsOfSchema({}, 'X'), /no oneOf/);
  assert.throws(() => methodsOfSchema({ oneOf: [{ properties: { method: { enum: ['a', 'b'] } } }] }, 'X'), /single method/);
  assert.throws(() => methodsOfSchema({ oneOf: [{ properties: { method: { enum: ['a'] } } }, { properties: { method: { enum: ['a'] } } }] }, 'X'), /duplicate/);
  assert.throws(() => buildProtocol(() => ({ oneOf: [{ properties: { method: { enum: ['x'] } } }] })), /initialize/);
});
