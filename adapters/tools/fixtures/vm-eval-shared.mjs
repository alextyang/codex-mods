// Child process for adapter.test.mjs (needs --experimental-vm-modules): applies the pack's transforms to the stock
// app-shared chunk, evaluates it as an ES module in a vm context with a minimal DOM stub, and reports what the
// `globalThis.__codexmods.exports` getters resolve to. Reads the stock asar only; launches nothing.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { openAsar } from '../asar.mjs';
import { applyAll } from '../transform.mjs';

const [asarPath, adapterPath] = process.argv.slice(2);
const pack = JSON.parse(readFileSync(adapterPath, 'utf8'));
const asar = openAsar(asarPath);
const read = (p) => asar.read(p).toString('utf8');
const sharedT = pack.transforms.filter((t) => t.seam === 'components' && /app-shared/.test(t.file));
const out = applyAll(sharedT, read);
const code = [...out.values()][0];
const runtime = read(asar.list().find((p) => /webview\/assets\/rolldown-runtime-[0-9a-f]{12}\.js$/.test(p)));
const el = () => new Proxy({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } }, { get: (t, k) => (k in t ? t[k] : undefined) });
const doc = Object.assign(el(), { documentElement: el(), head: el(), body: el(), createElement: el, getElementsByTagName: () => [] });
const sandbox = {
  console, setTimeout, clearTimeout, queueMicrotask, MessageChannel, TextEncoder, TextDecoder, URL, URLSearchParams, performance, Intl,
  navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/155', language: 'en-US', languages: ['en-US'], hardwareConcurrency: 4, maxTouchPoints: 0 },
  document: doc, localStorage: { getItem() { return null; }, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  location: { href: 'app://-/index.html', search: '', pathname: '/index.html', origin: 'app://-' }, history: {},
  addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
};
const ctx = vm.createContext(sandbox);
ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
const rt = new vm.SourceTextModule(runtime, { context: ctx, identifier: 'rolldown-runtime' });
const mod = new vm.SourceTextModule(code, { context: ctx, identifier: 'app-shared', importModuleDynamically: async () => { throw new Error('dynamic import blocked'); } });
await mod.link(async (spec) => { if (spec.includes('rolldown-runtime')) return rt; throw new Error(`unexpected import ${spec}`); });
await mod.evaluate();
const ex = ctx.__codexmods.exports;
const result = { reactVersion: ex.react.version, createRoot: typeof ex.reactDom.createRoot, createPortal: typeof ex.reactDom.createPortal };
for (const k of ['Button', 'Switch', 'Dialog', 'Tooltip', 'Icon', 'SettingsRow', 'Menu', 'MenuParts', 'DialogParts', 'RouteScope', 'ThreadScope', 'useScope']) result[k] = typeof ex[k];
// Parse-only checks for the other patched files: the app-initial chunk as an ES module, the main bundle as a CommonJS script.
const parsed = {};
const all = applyAll(pack.transforms, read);
for (const [file, text] of all) {
  try {
    if (file.startsWith('.vite/')) new vm.Script(text, { filename: file });
    else new vm.SourceTextModule(text, { context: ctx, identifier: file });
    parsed[file.split('/').pop().replace(/-[\w]{6,12}\.js$/, '')] = true;
  } catch (e) { parsed[file] = String(e.message).slice(0, 200); }
}
result.parsed = parsed;
console.log(JSON.stringify(result));
process.exit(0); // the stock module leaves timers/observers behind
