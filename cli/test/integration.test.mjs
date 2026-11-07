// The CLI against the real createManagement over a real socket, with fakes of Operations and friends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../codexmods.mjs';
import { createManagement } from '../../framework/host/management/index.mjs';
import { makeHarness, manifestOf, recordOf } from '../../framework/host/management/test/fakes.mjs';
import { SOCKETS } from '../../contracts/layout.mjs';
import { makeIo } from './fake-host.mjs';

test('CLI mods enable waits for the op that the real Management streams', async (t) => {
  const h = await makeHarness();
  t.after(() => rm(h.root, { recursive: true, force: true }));
  h.operations.addMod(recordOf({ status: 'disabled' }), manifestOf());
  const mgmt = createManagement(h);
  const server = await mgmt.listen(join(h.layout.run, SOCKETS.management), join(h.layout.run, 'mgmt.token'));
  t.after(() => server.dispose());

  // finish each op shortly after it starts, the way Operations would
  const start = h.operations.start.bind(h.operations);
  h.operations.start = async (input) => {
    const id = await start(input);
    setTimeout(() => h.operations.update(id, { phases: [{ name: 'activate', at: 'x' }] }), 20);
    setTimeout(() => { h.operations.state().mods['acme.demo'].status = 'enabled'; h.operations.update(id, { outcome: 'succeeded', note: 'Demo is on' }); }, 60);
    return id;
  };

  const io = makeIo(h.root, { env: { CODEX_MODS_ROOT: h.root, CODEX_MODS_PROFILE: 'p' } });
  assert.equal(await main(['mods', 'enable', 'acme.demo'], io), 0, io.err);
  assert.match(io.out, /activate\.\.\./);
  assert.match(io.out, /succeeded/);
  assert.match(io.out, /Demo is on/);

  const list = makeIo(h.root, { env: { CODEX_MODS_ROOT: h.root, CODEX_MODS_PROFILE: 'p' } });
  assert.equal(await main(['mods', 'list', '--json'], list), 0);
  assert.equal(JSON.parse(list.out).mods[0].status, 'enabled');

  const bad = makeIo(h.root, { env: { CODEX_MODS_ROOT: h.root, CODEX_MODS_PROFILE: 'p' } });
  assert.equal(await main(['mods', 'inspect', 'no.such'], bad), 1);
  assert.match(bad.err, /error \[Unavailable\]/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.operations.listenerCount, 0, 'no subscription left behind');
});
