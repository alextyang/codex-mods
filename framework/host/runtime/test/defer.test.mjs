// graph-integrity G6.4 through the real Runtime and the real Mux: no request is held for a mod. A mod's interceptor that answers
// `{defer: true}` is a fault and the request reaches the app, which answers it natively; ctx.appServer has nothing to answer a held
// request with. A mod stops an app action through the graph (`stopped`), and answers a request later through its instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, installMod, attachWindow } from './helpers.mjs';
import { harness as muxHarness } from '../../mux/test/helpers.mjs';

const Q = 'item/tool/requestUserInput';
const HOST = `
export default { host(ctx) {
  ctx.appServer.intercept('serverRequest', ['${Q}'], () => ({ defer: true }), { timeoutMs: 2000 });
  ctx.services.provide('t', { async run() {
    return { ok: ['respond', 'release', 'onDeferred', 'onResolved'].filter((m) => ctx.appServer[m] !== undefined) };
  } });
} };`;

test('G6.4: a mod\'s defer is a fault and the request reaches the app, which answers it; nothing in ctx.appServer answers a held request, in any realm', async () => {
  const m = await muxHarness();
  await m.up();
  const h = await makeHarness({ mux: m.mux });
  try {
    const mod = await installMod(h.layout, { id: 'test.defer', host: HOST, grants: [`appServer.intercept:${Q}`] });
    await h.runtime.activate(mod);
    m.app.send({ id: 10, method: 'fake/serverRequest', params: { method: Q, params: { threadId: 'thr-A', turnId: 't1', questions: [] } } });
    const q = await m.app.waitFor((x) => x.method === Q, 5000);
    m.app.send({ id: q.id, result: { answers: {} } });
    await m.app.reply(10);
    const r = await h.runtime.callServiceForLease('mod:test.defer', { name: 't', method: 'run', args: {} });
    assert.deepEqual(r.ok, [], 'the host realm has none of them');
    const win = attachWindow(h.runtime, 1);
    const rctx = win.ctx('test.defer');
    for (const name of ['respond', 'release', 'onDeferred', 'onResolved']) assert.equal(rctx.appServer[name], undefined, name);
  } finally { await h.close(); await m.close(); }
});
