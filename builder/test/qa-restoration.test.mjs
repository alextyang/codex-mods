import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildCopy } from '../build.mjs';
import { makeStockApp, makeBuildInputs, tmpdir, readPlist } from './helpers.mjs';

test('D22: only an explicit QA build seals NSDisablePersistence in its Info.plist before signing', async (t) => {
  const dir = tmpdir(t);
  const stock = makeStockApp(dir);
  const inputs = makeBuildInputs(dir);
  const opts = { stock: stock.app, adapter: inputs.adapterPath, loader: inputs.loader, relay: inputs.relay, root: dir, identity: '-', allowNoBaseline: true,
    dumpSignedEntitlements: async () => [], readTeamIdentifier: async () => null, findCertificateSubject: () => null };
  for (const qaNoRestore of [true, false]) {
    let atSign;
    const { appPath, report } = await buildCopy({ ...opts, out: path.join(dir, qaNoRestore ? 'qa' : 'ordinary'), qaNoRestore,
      sign: async (app) => { atSign = readPlist(path.join(app, 'Contents/Info.plist')).NSDisablePersistence; return { signed: 1, verified: true, targets: [] }; } });
    assert.equal(readPlist(path.join(appPath, 'Contents/Info.plist')).NSDisablePersistence, qaNoRestore ? true : undefined);
    assert.equal(atSign, qaNoRestore ? true : undefined);
    assert.equal(report.infoPlist.qaNoRestore, qaNoRestore);
  }
  assert.equal(readPlist(path.join(stock.app, 'Contents/Info.plist')).NSDisablePersistence, undefined);
});
