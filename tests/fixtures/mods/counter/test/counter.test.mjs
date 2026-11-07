// The counter fixture's own test: the protocol plane's fakes (createFakeHostContext delivers app-server traffic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hostMod from '../host.mjs';
import rendererMod from '../renderer.mjs';

import { createFakeHostContext, createFakeRendererContext, rpcNotification } from '../../../../../sdk/testing/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'mod.json'), 'utf8'));

test('the host counts thread/started notifications, persists the count and serves it', async (t) => {
  const { ctx, control } = createFakeHostContext({ manifest });
  t.after(() => control.cleanup());
  await control.activate(hostMod);
  await control.deliver('serverNotification', rpcNotification('thread/started', { thread: { id: 'a' } }));
  await control.deliver('serverNotification', rpcNotification('thread/started', { thread: { id: 'b' } }));
  await control.deliver('serverNotification', rpcNotification('turn/started', {}));     // not observed
  assert.deepEqual(await ctx.services.call(manifest.id, 'counter', 'get'), { count: 2 });
  assert.equal(await ctx.storage.get('threads'), 2);
});

test('the renderer shows the greeting and the live count on a settings page', async (t) => {
  const host = createFakeHostContext({ manifest });
  t.after(() => host.control.cleanup());
  await host.control.activate(hostMod);
  const ui = createFakeRendererContext({ manifest, host: host.control });
  await ui.control.activate(rendererMod);
  assert.ok(ui.control.pages.has('counter'));
  const root = await ui.control.render('counter');
  await root.until(() => /New threads seen: 0/.test(root.text()));
  assert.match(root.text(), /Hello from the counter/);
  await host.control.deliver('serverNotification', rpcNotification('thread/started', { thread: { id: 'a' } }));
  await root.until(() => /New threads seen: 1/.test(root.text()));
  host.control.settings.patch({ greeting: 'Hi' });
  await root.until(() => /Hi/.test(root.text()));
});

test('disposing leaves nothing registered in either realm', async (t) => {
  const host = createFakeHostContext({ manifest });
  t.after(() => host.control.cleanup());
  await host.control.activate(hostMod);
  const ui = createFakeRendererContext({ manifest, host: host.control });
  await ui.control.activate(rendererMod);
  await ui.control.deactivate();
  await host.control.deactivate();
  assert.deepEqual(host.control.registrations(), { total: 0 });
  assert.equal(ui.control.pages.size, 0);
});
