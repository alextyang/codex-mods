// framework-main's MCP area: refresh the app's own query cache and open only an HTTPS OAuth page in its external browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('./tool-servers.cjs');

function setup({ browser = true, window = true } = {}) {
  const invalidated = [], opened = [];
  let handler;
  register({
    onAreaOp(area, fn) { assert.equal(area, 'tool-servers'); handler = fn; },
    appHost: { first: () => window ? { host: { services: { queryCache: { async invalidateQueryCache(args) { invalidated.push(args); } } } } } : null },
    electron: browser ? { async openExternal(url) { opened.push(url); } } : {},
  });
  return { handler, invalidated, opened };
}

test('refresh invalidates the config, saved config and MCP status queries; open-url opens the HTTPS page', async () => {
  const s = setup();
  const keys = [['config'], ['user-saved-config'], ['mcp', 'servers', 'status']];
  assert.deepEqual(await s.handler('refresh', { keys }), { refreshed: 3 });
  assert.deepEqual(s.invalidated, keys.map((queryKey) => ({ queryKey, reset: false })));
  assert.deepEqual(await s.handler('open-url', { url: 'https://auth.example.com/login' }), {});
  assert.deepEqual(await s.handler('open-url', { url: 'http://127.0.0.1:18765/authorize?x=1' }), {});
  assert.deepEqual(s.opened, ['https://auth.example.com/login', 'http://127.0.0.1:18765/authorize?x=1'], 'HTTP only on the loopback');
  assert.deepEqual(await s.handler('refresh', { keys: [['nope'], []] }), { refreshed: 0 });
});

test('unsafe or missing URLs, missing browser/window and unknown operations are refusals; an attempted browser failure throws', async () => {
  const s = setup();
  const refusal = (e) => e.refused === true;
  for (const url of [undefined, '', 'invalid', 'http://auth.example.com', 'http://127.0.0.2.example.com', 'http://localhost.example.com', 'file:///tmp/a', 'javascript:alert(1)', '//auth.example.com']) {
    await assert.rejects(s.handler('open-url', { url }), refusal);
  }
  assert.deepEqual(s.opened, []);
  await assert.rejects(setup({ browser: false }).handler('open-url', { url: 'https://auth.example.com' }), refusal);
  await assert.rejects(setup({ window: false }).handler('refresh', { keys: [['config']] }), refusal);
  await assert.rejects(s.handler('unknown'), (e) => e.refused && e.message === 'unknown operation unknown');
  let failing;
  register({ onAreaOp(_area, fn) { failing = fn; }, electron: { async openExternal() { throw new Error('browser failed'); } } });
  await assert.rejects(failing('open-url', { url: 'https://auth.example.com' }), /browser failed/);
});
