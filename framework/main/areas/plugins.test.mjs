// The plugins area uses the window's own cache and browser plugin service, and opens only plugin pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('./plugins.cjs');
const kit = require('../area-kit.cjs');

function setup(services = {}, { window = true, pages = true } = {}) {
  let run;
  const sent = [];
  register({
    appHost: { first: () => window ? { id: 17, host: { services } } : null },
    ...(pages ? { electron: { postToWindow: (...args) => sent.push(args) } } : {}),
    onAreaOp(name, fn) { assert.equal(name, 'plugins'); run = fn; },
  });
  return { run, sent };
}
const refusal = (re) => (e) => e.refused === true && re.test(e.message);

test('refresh invalidates the requested query prefixes in order and returns the count', async () => {
  const seen = [];
  const { run } = setup({ queryCache: { invalidateQueryCache: async (q) => seen.push(q) } });
  const keys = [['plugins'], ['apps'], ['mcp', 'servers', 'status'], ['skills'], ['config']];
  assert.deepEqual(await run('refresh', { keys }), { refreshed: 5 });
  assert.deepEqual(seen, keys.map((queryKey) => ({ queryKey, reset: false })));
  assert.deepEqual(await run('refresh', { keys: [['unknown'], [], 'plugins'] }), { refreshed: 0 });
  assert.deepEqual(await run('refresh'), { refreshed: 0 });
  await assert.rejects(setup().run('refresh', { keys }), refusal(/queryCache/));
  await assert.rejects(setup({}, { window: false }).run('refresh', { keys }), refusal(/no window/));
  const failed = setup({ queryCache: { invalidateQueryCache: async () => { throw new Error('cache failed'); } } });
  await assert.rejects(failed.run('refresh', { keys }), /cache failed/);
});

test('plugin-sync awaits the browser plugin service, requires its method and propagates failures', async () => {
  let finish, called = false;
  const svc = { syncAfterPluginChange() { assert.equal(this, svc); called = true; return new Promise((r) => { finish = r; }); } };
  const { run } = setup({ browserPluginConfig: svc });
  let done = false;
  const pending = run('plugin-sync', {}).then((r) => { done = true; return r; });
  assert.equal(called, true);
  assert.equal(done, false);
  finish();
  assert.deepEqual(await pending, {});
  await assert.rejects(setup().run('plugin-sync', {}), refusal(/browserPluginConfig/));
  await assert.rejects(setup({ browserPluginConfig: {} }).run('plugin-sync', {}), refusal(/syncAfterPluginChange/));
  await assert.rejects(setup({}, { window: false }).run('plugin-sync', {}), refusal(/no window/));
  const failed = setup({ browserPluginConfig: { syncAfterPluginChange: async () => { throw new Error('sync failed'); } } });
  await assert.rejects(failed.run('plugin-sync', {}), /sync failed/);
});

test('navigate opens the plugin catalog or one encoded plugin id in the first window', async () => {
  const { run, sent } = setup();
  for (const path of ['/plugins', '/plugins/alpha%40fake-local', '/plugins/a%2Fb']) assert.deepEqual(await run('navigate', { path }), {});
  assert.deepEqual(sent, ['/plugins', '/plugins/alpha%40fake-local', '/plugins/a%2Fb'].map((path) => [17, kit.VIEW_CHANNEL, { type: 'navigate-to-route', path }]));
  for (const path of [undefined, null, 7, '', '/settings', '/plugins/', '/plugins/a/b', 'https://example.com/plugins']) {
    await assert.rejects(run('navigate', { path }), refusal(/plugin page/));
  }
  assert.equal(sent.length, 3);
  await assert.rejects(setup({}, { window: false }).run('navigate', { path: '/plugins' }), refusal(/no window/));
  await assert.rejects(setup({}, { pages: false }).run('navigate', { path: '/plugins' }), refusal(/cannot be reached/));
});

test('an unknown operation is refused', async () => {
  await assert.rejects(setup().run('install', {}), refusal(/^unknown operation install$/));
});
