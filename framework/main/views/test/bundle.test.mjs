import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShimWindow } from '../../../renderer/test/dom-shim.mjs';
import { pack } from '../../../renderer/test/harness.mjs';

const require = createRequire(import.meta.url);
const { bundle } = require('../bundle.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');

const tree = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-bundle-'));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
};

test('bundle: named, default, namespace and re-exports, live bindings, side-effect imports, and a dynamic import left alone', () => {
  const dir = tree({
    'a/main.mjs': `import def, { f, g as gg, K } from './lib.mjs';
import * as ns from './lib.mjs';
import './side.mjs';
import {
  multi,
  line as renamed,
} from '../b/multi.mjs';
export { reexp } from '../b/multi.mjs';
export * from '../b/star.mjs';
export const out = [def, f(), gg(), K, ns.K, multi, renamed, globalThis.__side].join('|');
export const lazy = () => import('./never-loaded.mjs');
export default function entry() { return 'entry'; }
`,
    'a/lib.mjs': `export function f() { return 'f'; }
export async function h() {}
export class C {}
export let counter = 0;
export function bump() { counter++; }
const g = () => 'g';
export { g };
export const K = 'K';
export default 'D';
`,
    'a/side.mjs': `globalThis.__side = 'side';\n`,
    'b/multi.mjs': `export const multi = 'm';\nconst line = 'l';\nexport { line };\nexport const reexp = 'r';\n`,
    'b/star.mjs': `export const s1 = 's1';\nexport default 'ignored by export *';\n`,
  });
  try {
    const ctx = vm.createContext({ console });
    const m = vm.runInContext(bundle({ entry: join(dir, 'a/main.mjs'), baseDir: dir }), ctx);
    assert.equal(m.out, 'D|f|g|K|K|m|l|side');
    assert.equal(m.reexp, 'r');
    assert.equal(m.s1, 's1');
    assert.equal(m.default(), 'entry');
    assert.equal(typeof m.lazy, 'function');
    assert.equal(Object.keys(m).sort().join(), 'default,lazy,out,reexp,s1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: exports are live bindings (let counter) and each module runs once', () => {
  const dir = tree({
    'e.mjs': `import { counter, bump } from './l.mjs';\nimport { bump as bump2, read } from './l.mjs';\nexport function go() { bump(); bump2(); return read(); }\n`,
    'l.mjs': `globalThis.__runs = (globalThis.__runs ?? 0) + 1;\nexport let counter = 0;\nexport function bump() { counter++; }\nexport function read() { return counter; }\n`,
  });
  try {
    const ctx = vm.createContext({});
    const m = vm.runInContext(bundle({ entry: join(dir, 'e.mjs'), baseDir: dir }), ctx);
    assert.equal(m.go(), 2);
    assert.equal(ctx.__runs, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: unsupported syntax fails loudly with file and line', () => {
  const cases = [
    ['import x from "pkg";\n', /only relative imports/],
    ['export const a = import.meta.url;\n', /import\.meta/],
    ['export const { a, b } = obj;\n', /unsupported module syntax/],
    ['import { a } from "./self.mjs";\nawait 1;\n', /top-level await/],
  ];
  for (const [src, re] of cases) {
    const dir = tree({ 'm.mjs': src, 'self.mjs': 'export const a = 1;\n' });
    try { assert.throws(() => bundle({ entry: join(dir, 'm.mjs'), baseDir: dir }), re, src); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('bundle: import cycles are rejected', () => {
  const dir = tree({ 'a.mjs': `import './b.mjs';\nexport const a = 1;\n`, 'b.mjs': `import './a.mjs';\nexport const b = 1;\n` });
  try { assert.throws(() => bundle({ entry: join(dir, 'a.mjs'), baseDir: dir }), /import cycle/); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundle: a missing dependency is an error naming the importer', () => {
  const dir = tree({ 'a.mjs': `import { x } from './nope.mjs';\n` });
  try { assert.throws(() => bundle({ entry: join(dir, 'a.mjs'), baseDir: dir }), /nope\.mjs/); } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------- the real renderer graph
function copyRendererTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-renderer-'));
  mkdirSync(join(dir, 'framework', 'renderer'), { recursive: true });
  for (const f of readdirSync(join(repo, 'framework', 'renderer'))) if (f.endsWith('.mjs')) cpSync(join(repo, 'framework', 'renderer', f), join(dir, 'framework', 'renderer', f));
  cpSync(join(repo, 'framework', 'renderer', 'present'), join(dir, 'framework', 'renderer', 'present'), { recursive: true });   // the presentation runtime (presentations.md)
  mkdirSync(join(dir, 'framework', 'shared'), { recursive: true });
  cpSync(join(repo, 'framework', 'shared', 'graph-replica.mjs'), join(dir, 'framework', 'shared', 'graph-replica.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'ui-rules-client.mjs'), join(dir, 'framework', 'shared', 'ui-rules-client.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'bounded-pattern.mjs'), join(dir, 'framework', 'shared', 'bounded-pattern.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'draft-text.mjs'), join(dir, 'framework', 'shared', 'draft-text.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'where.mjs'), join(dir, 'framework', 'shared', 'where.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'parts.mjs'), join(dir, 'framework', 'shared', 'parts.mjs'));
  cpSync(join(repo, 'framework', 'shared', 'internal-mods.mjs'), join(dir, 'framework', 'shared', 'internal-mods.mjs'));
  mkdirSync(join(dir, 'sdk'), { recursive: true });
  cpSync(join(repo, 'sdk', 'errors.mjs'), join(dir, 'sdk', 'errors.mjs'));
  // A stub of framework/shared/realm-client.mjs with its documented interface.
  mkdirSync(join(dir, 'framework', 'shared'), { recursive: true });
  writeFileSync(join(dir, 'framework', 'shared', 'realm-client.mjs'), `export function createRealmClient(port) { (globalThis.__realmPorts ??= []).push(port); return { context: (modId, realm, info) => ({ marker: 'stub:' + modId, mod: info }) }; }\n`);
  return dir;
}

test('the real runtime graph bundles into one classic script that starts in a fresh context and speaks the preload protocol', async () => {
  const dir = copyRendererTree();
  try {
    const expr = bundle({ entry: join(dir, 'framework', 'renderer', 'runtime.mjs'), baseDir: dir });
    assert.ok(!/^\s*(import|export)\s/m.test(expr), 'no module syntax left');
    const win = createShimWindow({ html: '<main data-app-shell-main-surface="x"><div data-app-shell-workspace-layout="w"></div></main>', search: '' });
    const ctx = vm.createContext({ console, URL, URLSearchParams, queueMicrotask, setTimeout, clearTimeout });
    const E = vm.runInContext(expr, ctx);
    assert.equal(Object.keys(E).sort().join(), 'loadFrameworkModule,startRuntime,whenDocumentReady');
    const ui = { adapter: { build: pack.build, anchors: pack.anchors, components: pack.components, react: pack.react, theme: pack.theme }, appBuild: '26.1007.21159-20052', nonce: 'N' };
    E.startRuntime(ui, win);
    assert.equal(JSON.stringify(win.posted.at(-1).data), JSON.stringify({ __codexmods: 'N', dir: 'to-preload', op: 'runtime-ready' }));

    // wrong nonce / wrong source are ignored
    win.deliverMessage({ data: { __codexmods: 'X', dir: 'to-runtime', kind: 'port', port: 'renderer' }, ports: [{}] });
    win.deliverMessage({ data: { __codexmods: 'N', dir: 'to-runtime', kind: 'port', port: 'renderer' }, ports: [{}], source: {} });
    assert.equal(ctx.__realmPorts, undefined);

    // a real port from the preload
    const sent = []; const ls = [];
    const port = { postMessage: (m) => sent.push(m), addEventListener: (t, f) => { if (t === 'message') ls.push(f); }, start() {}, close() {} };
    win.deliverMessage({ data: { __codexmods: 'N', dir: 'to-runtime', kind: 'port', port: 'renderer' }, ports: [port] });
    assert.equal(ctx.__realmPorts.length, 1);
    ls[0]({ data: { t: 'modules', modules: [{ modId: 'm', url: 'codexmod://m/1/r.mjs', version: '1', dataDir: '/d' }] } });
    await new Promise((r) => setTimeout(r, 30));
    win.clock.tick(25_000);                                    // the app React never appears here: readiness gives up after 20 s
    await new Promise((r) => setTimeout(r, 30));
    for (const ms of [250, 500, 1000, 100]) { win.clock.tick(ms); await new Promise((r) => setTimeout(r, 30)); }   // the import is retried 3 times first
    assert.ok(sent.some((m) => m.t === 'fault' && m.modId === 'm'), `a module that cannot be imported is a fault with its modId: ${JSON.stringify(sent)}`);

    // framework-module bridge: runtime → preload request, preload → runtime reply
    const mport = { postMessage() {}, addEventListener() {}, start() {}, close() {} };
    win.deliverMessage({ data: { __codexmods: 'N', dir: 'to-runtime', kind: 'port', port: 'management' }, ports: [mport] });
    win.clock.tick(50);
    await new Promise((r) => setTimeout(r, 30));
    const reqs = win.posted.filter((p) => p.data.op === 'framework-module');
    assert.deepEqual(reqs.map((p) => p.data.spec), ['recovery/index.mjs'], 'the recovery entry is requested through the preload (Adjustments went, E6.6d)');
    const req = reqs[0];
    let ctxGot;
    win.__codexmods_fwm = { 'k1': { default: (c) => { ctxGot = c; } } };
    win.deliverMessage({ data: { __codexmods: 'N', dir: 'to-runtime', reply: req.data.reqId, ok: true, key: 'k1' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(ctxGot && ctxGot.management && ctxGot.ui && ctxGot.pickFile && ctxGot.mountSettings);
    assert.equal(win.__codexmods_fwm.k1, undefined, 'the registry entry is consumed');

    // a pick-file round trip
    const picked = ctxGot.pickFile({ extensions: ['codexmod'] });
    const preq = win.posted.find((p) => p.data.op === 'pick-file');
    assert.equal(preq.data.extensions.join(), 'codexmod');
    win.deliverMessage({ data: { __codexmods: 'N', dir: 'to-runtime', reply: preq.data.reqId, ok: true, path: '/tmp/x.codexmod' } });
    assert.equal(await picked, '/tmp/x.codexmod');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function bundledRuntime(dir) {
  const expr = bundle({ entry: join(dir, 'framework', 'renderer', 'runtime.mjs'), baseDir: dir });
  const ctx = vm.createContext({ console, URL, URLSearchParams, queueMicrotask, setTimeout, clearTimeout });
  return vm.runInContext(expr, ctx);
}
const uiBoot = { adapter: { build: pack.build, anchors: pack.anchors, components: pack.components, react: pack.react, theme: pack.theme }, appBuild: '26.1007.21159-20052', nonce: 'N' };

test('startup while <html> does not exist yet (readyState loading): nothing throws, the runtime starts when the document appears', () => {
  const dir = copyRendererTree();
  try {
    const E = bundledRuntime(dir);
    const win = createShimWindow({ html: '<main data-app-shell-main-surface="x"></main>' });
    const doc = win.document;
    const html = doc.documentElement;
    doc.removeChild(html);
    doc.documentElement = null;                                  // what the native QA machine saw: documentElement null while loading
    const docListeners = [];
    doc.addEventListener = (t, f) => docListeners.push([t, f]);
    doc.removeEventListener = () => {};
    assert.doesNotThrow(() => E.startRuntime(uiBoot, win));
    assert.equal(win.posted.filter((p) => p.data.op === 'runtime-ready').length, 0, 'not ready before the document exists');
    assert.equal(win.posted.filter((p) => p.data.op === 'log').length, 0, 'and no failure either');
    doc.documentElement = html;
    doc.appendChild(html);                                       // <html> appears → MutationObserver wakes the runtime
    return new Promise((resolve) => setImmediate(() => {
      assert.equal(win.posted.filter((p) => p.data.op === 'runtime-ready').length, 1);
      // the DOMContentLoaded / readystatechange paths also exist and are idempotent
      for (const [, f] of docListeners) f();
      assert.equal(win.posted.filter((p) => p.data.op === 'runtime-ready').length, 1);
      resolve();
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startup before <html> also wakes on readystatechange when no MutationObserver fires', () => {
  const dir = copyRendererTree();
  try {
    const E = bundledRuntime(dir);
    const win = createShimWindow({});
    const doc = win.document; const html = doc.documentElement;
    doc.documentElement = null;
    win.MutationObserver = undefined;
    const ls = [];
    doc.addEventListener = (t, f) => ls.push(f);
    E.startRuntime(uiBoot, win);
    assert.equal(win.posted.filter((p) => p.data.op === 'runtime-ready').length, 0);
    doc.documentElement = html;
    for (const f of ls) f();
    assert.equal(win.posted.filter((p) => p.data.op === 'runtime-ready').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a construction failure is reported to the preload (op log) instead of being swallowed', () => {
  const dir = copyRendererTree();
  try {
    const E = bundledRuntime(dir);
    const win = createShimWindow({});
    E.startRuntime({ ...uiBoot, get adapter() { throw new Error('adapter exploded'); } }, win);
    const log = win.posted.find((p) => p.data.op === 'log');
    assert.ok(log, 'a log request reached the preload');
    assert.equal(log.data.phase, 'construct');
    assert.match(log.data.message, /adapter exploded/);
    assert.equal(log.data.dir, 'to-preload');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
