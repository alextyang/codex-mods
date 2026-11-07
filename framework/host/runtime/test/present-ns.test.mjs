// ctx.present (docs/design/presentations.md V6): the page's own runtime looks up the Request behind a request card; a mod has no such
// member, and a raw call from a mod is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, installMod, attachWindow, waitFor } from './helpers.mjs';
import { createGraph } from '../../graph/index.mjs';

const FW = 'codexmods.framework';

test('the framework scope gets the Request behind a pending request card by the id the app was asked with (others null); a mod gets no ctx.present and a raw call is refused', async () => {
  const pending = { 's:3': { type: 'CommandApproval', provider: 'codex', id: 't:e1:s:3' } };
  const h = await makeHarness({ graph: createGraph(), requests: { refOf: (id) => pending[id] ?? null } });
  try {
    await h.runtime.activate(await installMod(h.layout, { id: 'test.r', renderer: 'export default {};', grants: ['graph', 'graph.read', 'graph.act', 'graph.intercept'] }));
    const w = attachWindow(h.runtime, 1);
    const fw = w.client.context(FW, 'renderer', { id: FW, version: '0', dataDir: '' });
    assert.deepEqual(await fw.present.requestsOf(['s:3', 's:9', 5]), { 's:3': pending['s:3'], 's:9': null });
    const mod = w.ctx('test.r');
    assert.equal(mod.present, undefined);
    const replies = [];
    w.realmPort.onMessage((m) => { if (m.t === 'result' && m.id === 9001) replies.push(m); });
    w.post({ t: 'call', id: 9001, modId: 'test.r', ns: 'present', method: 'requestsOf', args: [['s:3']] });
    await waitFor(() => replies.length === 1, { what: 'the reply' });
    assert.equal(replies[0].error?.code, 'Denied');
  } finally { await h.close(); }
});
