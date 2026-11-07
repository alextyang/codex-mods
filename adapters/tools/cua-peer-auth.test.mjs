// cua-peer-auth.mjs (decision N9): the peer-authorizer factory is located by its log name, its macOS check and its build-flavor read, and fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCuaPeerAuthTransform, locatePeerAuthorizer, PEER_AUTH_ID, ALLOW_ALL } from './cua-peer-auth.mjs';
import { applyOp } from './transform.mjs';
import { locateStock } from './stock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = '.vite/build/main-AAAAAAAA.js';
// the shape of the stock factory (names are made up; the strings are the app's)
const FACTORY = 'var Bd=p.a(`browser-use-native-pipe-peer-authorizer`),woe=(0,ce.createRequire)(__filename);function Vd(){if(process.platform!==`darwin`)return()=>({authorized:!0});let e=n.i.readFromPackageMetadata(),t=e!=null&&n.i.shouldIncludeBrowserUsePeerAuthorization(e,process.platform),r=!t&&Coe(process.env);if(D.app?.isPackaged===!0&&e==null)return Bd().warning(`browser-use native pipe peer authorization disabled`,{safe:{reason:`missing-package-build-flavor`},sensitive:{}}),()=>({authorized:!1,reason:`missing-package-build-flavor`});if(!t&&!r)return()=>({authorized:!0});return(e)=>({authorized:Zz(e)})}';
const src = (files) => ({ list: (p) => Object.keys(files).filter((f) => f.startsWith(p)), read: (f) => files[f], size: (f) => files[f].length });
const files = (main = FACTORY) => ({ [MAIN]: `${main};module.exports={Vd:typeof Vd==='function'?Vd:null}` });

test('derives one insert-after-once at the factory head: the allow-all authorizer first, the stock body as dead code', () => {
  const r = deriveCuaPeerAuthTransform(src(files()));
  assert.deepEqual(r.missing, []);
  const [d] = r.drafts;
  assert.deepEqual([d.id, d.seam, d.file, d.op, d.find, d.text], [PEER_AUTH_ID, 'other', MAIN, 'insert-after-once', 'function Vd(){', ALLOW_ALL]);
  // the patched factory is allow-all for every platform and build flavor
  const run = (text) => { const m = { exports: {} }; vm.runInNewContext(`(function(module,p,ce,__filename,n,Coe,D,Zz){${text}})`, { process: { platform: 'darwin', env: {} } })(m, { a: () => () => ({ warning() {} }) }, { createRequire: () => () => ({}) }, '/x', { i: { readFromPackageMetadata: () => ({}), shouldIncludeBrowserUsePeerAuthorization: () => true } }, () => false, { app: { isPackaged: true } }, () => false); return m.exports.Vd; };
  const stock = run(files()[MAIN]); const patched = run(applyOp(files()[MAIN], d));
  assert.equal(JSON.stringify(stock()({})), '{"authorized":false}', 'the stock authorizer denies a peer it cannot verify');
  assert.equal(JSON.stringify(patched()({})), '{"authorized":true}');
});

test('fail closed: a missing, duplicated or changed anchor is a mandatory miss and derives nothing', () => {
  const miss = (text, why) => { const r = deriveCuaPeerAuthTransform(src(files(text))); assert.deepEqual(r.drafts, [], why); assert.equal(r.missing.length, 1, why); assert.deepEqual([r.missing[0].item, r.missing[0].mandatory], [`transform:${PEER_AUTH_ID}`, true], why); return r.missing[0].tried; };
  miss(FACTORY.replace('browser-use-native-pipe-peer-authorizer', 'other-logger'), 'logger renamed');
  miss(FACTORY.replace('process.platform!==`darwin`', 'process.platform!==`linux`'), 'macOS check changed');
  miss(FACTORY.replace('browser-use native pipe peer authorization disabled', 'x'), 'the disabled log is gone');
  miss(FACTORY.replace('shouldIncludeBrowserUsePeerAuthorization(', 'other('), 'build flavor read is gone');
  miss(FACTORY.replace('authorized:!1', 'authorized:!2'), 'no deny result');
  assert.match(miss(`${FACTORY};${FACTORY.replace('var Bd=p.a(`browser-use-native-pipe-peer-authorizer`),woe=(0,ce.createRequire)(__filename);', '')}`, 'two factories'), /macOS check/);
  assert.match(miss(`${FACTORY};var z=\`browser-use-native-pipe-peer-authorizer\``, 'logger twice'), /occurs 2 times/);
  assert.match(deriveCuaPeerAuthTransform(src({})).missing[0].tried, /0 main bundles/);
  assert.match(deriveCuaPeerAuthTransform(src({ [MAIN]: FACTORY, '.vite/build/main-BBBBBBBB.js': FACTORY })).missing[0].tried, /2 main bundles/);
  // a head that is not unique cannot be the find
  assert.match(miss(`${FACTORY};function Vd(){}`, 'head twice'), /occurs 2 times/);
  // a result that does not compile is refused (the dry run parses the whole bundle)
  assert.match(miss(`${FACTORY.replace('function Vd(){', 'function Vd(){')};)`, 'broken bundle'), /does not compile/);
  assert.deepEqual(locatePeerAuthorizer('x'), { error: '`browser-use-native-pipe-peer-authorizer` occurs 0 times (expected exactly 1)' });
});

const PACK = JSON.parse(readFileSync(join(here, '..', '26.1013.40934-20770', 'adapter.json'), 'utf8'));
test('real 20770: the derived edit is exactly the one in the pack (id, file by role, op, find, text)', { skip: !locateStock({ bundleVersion: '20770', version: '26.1013.40934' }) && 'stock 20770 not available' }, () => {
  const s = locateStock({ bundleVersion: '20770', version: '26.1013.40934' });
  const [d] = deriveCuaPeerAuthTransform(s.source).drafts;
  const ref = PACK.transforms.find((t) => t.id === PEER_AUTH_ID);
  assert.deepEqual({ id: d.id, seam: d.seam, file: d.file, op: d.op, find: d.find, text: d.text }, { id: ref.id, seam: ref.seam, file: ref.file, op: ref.op, find: ref.find, text: ref.text });
  s.close();
});

test('real 21477 and 20156 (the design mirror): the factory is found once', (t) => {
  const mirror = join(here, '..', '..', '.tmp', 'mirror-20261012', 'asar');
  const found = [['21477', locateStock({ bundleVersion: '21477', version: '26.1016.62342' })?.source]];
  const have = found.filter(([, source]) => source);
  if (!have.length) t.skip('no stock 21477');
  for (const [b, source] of have) { const r = deriveCuaPeerAuthTransform(source); assert.deepEqual(r.missing, [], b); assert.equal(r.drafts.length, 1, b); }
  t.diagnostic(`mirror at ${mirror} is covered by the seams drift report`);
});
