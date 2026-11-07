// Child process for seams.test.mjs (needs --experimental-vm-modules): evaluates the patched renderer chunks app-shared, app-initial and app-primary as ES modules in a
// vm context (the stock rolldown runtime, a minimal DOM stub, nothing else) and reports what every exposure of `globalThis.__codexmods.exports` resolves to.
// Argument: a JSON file {runtime, shared, initial, primary, activity?, chunks?} of chunk paths (`chunks`: stem -> path, the lazy chunk `activity`'s imports).
// Reads those files only; launches nothing, loads no other module of the app.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const files = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const read = (p) => readFileSync(p, 'utf8');
const el = () => new Proxy({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {}, querySelector() { return null; } }, { get: (t, k) => (k in t ? t[k] : () => el()) });
const doc = Object.assign(el(), { documentElement: el(), head: el(), body: el(), createElement: el, getElementsByTagName: () => [] });
const sandbox = {
  crypto: globalThis.crypto, btoa, atob, Blob, EventTarget, Event, CustomEvent, AbortController, AbortSignal, structuredClone,
  console, setTimeout, clearTimeout, queueMicrotask, MessageChannel, TextEncoder, TextDecoder, URL, URLSearchParams, performance, Intl,
  navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/155', language: 'en-US', languages: ['en-US'], hardwareConcurrency: 4, maxTouchPoints: 0 },
  document: doc, localStorage: { getItem() { return null; }, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  location: { href: 'app://-/index.html', search: '', pathname: '/index.html', origin: 'app://-' }, history: {},
  addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
};
const ctx = vm.createContext(sandbox);
ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
const mods = new Map();
const mk = (name, code) => {
  const m = new vm.SourceTextModule(code, { context: ctx, identifier: name, initializeImportMeta(meta) { meta.url = `app://-/assets/${name}.js`; meta.resolve = (x) => `app://-/assets/${x}`; }, importModuleDynamically: async () => { throw new Error('dynamic import blocked'); } });
  mods.set(name, m);
  return m;
};
mk('rolldown-runtime', read(files.runtime)); mk('app-shared', read(files.shared)); mk('app-initial', read(files.initial));
const primary = mk('app-primary', read(files.primary));
const link = async (spec) => {
  const stem = spec.replace(/^\.\//, '').replace(/-[0-9a-f]{12}\.js$/, '');
  const m = mods.get(stem) ?? (files.chunks?.[stem] ? mk(stem, read(files.chunks[stem])) : null);
  if (!m) throw new Error(`unexpected import ${spec}`);
  if (m.status === 'unlinked') await m.link(link);
  return m;
};
await primary.link(link);
await primary.evaluate();
if (files.activity) { const a = mk('agent-activity-item', read(files.activity)); await a.link(link); await a.evaluate(); }
const ex = ctx.__codexmods.exports;
const tag = (v) => Object.prototype.toString.call(v).slice(8, -1);
const out = { keys: Object.keys(ex) };
const probe = (label, f) => { try { out[label] = f(); } catch (e) { out[label] = { threw: String(e.message).slice(0, 160) }; } };
probe('scopes', () => [ex.AppScope, ex.ComposerScope, ex.RouteScope, ex.ThreadScope].map((s) => s.__scopeBrand));
probe('toast', () => { const t = ex.toast.get(); return { api: Object.keys(t), atom: typeof ex.toast.atom }; });
probe('bus', () => { const i = ex.bus.getInstance(); return { dispatchHostMessage: typeof i.dispatchHostMessage, dispatchMessage: typeof i.dispatchMessage, same: i === ex.bus.getInstance() }; });
probe('react', () => ({ version: ex.react.version, useState: typeof ex.react.useState, cached: ex.react === ex.react }));
probe('useScope', () => typeof ex.useScope);
probe('appShell', () => ({ members: Object.keys(ex.appShell), headerActionTag: tag(ex.appShell.HeaderAction) }));
probe('headerSlots', () => Object.fromEntries(Object.entries(ex.headerSlots).map(([k, v]) => [k, Object.keys(v)])));
probe('tabRegistry', () => ({ register: typeof ex.tabRegistry.register, registry: tag(ex.tabRegistry.registry) }));
probe('panelControllers', () => ({ openTab: typeof ex.panelControllers.openTab, right: typeof ex.panelControllers.right.openTab, bottom: typeof ex.panelControllers.bottom.openTab, distinct: ex.panelControllers.right !== ex.panelControllers.bottom }));
probe('modal', () => ({ fns: ['open', 'close', 'closeAll', 'isOpen'].map((k) => typeof ex.modal[k]), atom: typeof ex.modal.atom }));
probe('commandStack', () => {
  const c = ex.commandStack; const calls = [];
  const before = c.hasDefault('newTask');
  const un = c.register('qa.cmd', (...a) => { calls.push(a); return true; }, { isActive: () => true, priority: 'normal' });
  const r1 = c.run('qa.cmd', 'palette', { ev: 1 }); un(); const r2 = c.run('qa.cmd', 'palette', { ev: 1 });
  return { stack: tag(c.stack), defaults: tag(c.defaults), defaultNewTask: [before, c.defaults.has('newTask'), c.hasDefault('nope')], handled: [calls.length, calls[0]?.[0], r1, r2], fns: ['runKeyboard', 'runner', 'defaultHandler'].map((k) => typeof c[k]) };
});
probe('commandRegistered', () => {
  const r = ex.commandRegistered; const item = { m: 1 };
  const added = r.addRegistered({}, 'a', item);
  return { useHandler: typeof r.useHandler, added: Object.keys(added), item: added.a[0] === item, removed: Object.keys(r.removeRegistered(added, 'a', item)), atom: typeof r.atom };
});
probe('slashRegistry', () => ({ atoms: ['appAtom', 'composerAtom', 'openCountAtom', 'mergedAtom'].map((k) => typeof ex.slashRegistry[k]), sortItems: typeof ex.slashRegistry.sortItems }));
probe('slashHooks', () => Object.fromEntries(Object.entries(ex.slashHooks).map(([k, v]) => [k, typeof v])));
probe('routes', () => ({ array: Array.isArray(ex.routes), length: ex.routes.length }));
probe('panelSlots', () => ({ publish: typeof ex.panelSlots.publish, pairs: ex.panelSlots.pairs.length, shape: ex.panelSlots.pairs.every(([f, a]) => typeof f === 'function' && a && typeof a === 'object'), inShell: ex.panelSlots.pairs.filter(([f]) => Object.values(ex.appShell).some((v) => v && v.type === f)).length }));
probe('shellSignals', () => ({ Signal: typeof ex.shellSignals.Signal, header: Object.keys(ex.shellSignals.header), pageBanner: Object.keys(ex.shellSignals.pageBanner) }));
probe('composerBanners', () => {
  const b = ex.composerBanners;
  return { first: b.order[0].id, count: b.order.length, candidate: b.candidate('x', 'c'), selected: b.select([{ id: 'misalignment-policy', isEligible: true, isLoading: false, content: 'c' }], 'home')?.id, List: typeof b.List };
});
probe('transcriptReveal', () => ({ atom: typeof ex.transcriptReveal.atom, register: typeof ex.transcriptReveal.register }));
probe('terminalManager', () => ({ renderers: tag(ex.terminalManager.renderers), getOrCreateRenderer: typeof ex.terminalManager.getOrCreateRenderer, same: ex.terminalManager === ex.terminalManager }));
probe('markdownComponents', () => typeof ex.markdownComponents);
probe('activityRow', () => typeof ex.activityRow);
// E8.5: the palette's parts
probe('commandMenu', () => ['List', 'Item', 'Input', 'Group', 'Separator', 'Empty', 'Loading'].every((k) => ex.commandMenu[k] != null) && (typeof ex.commandMenu === 'function' || typeof ex.commandMenu === 'object'));
probe('commandMenuItem', () => typeof ex.commandMenuItem);
probe('commandMenuSections', () => typeof ex.commandMenuSections);
probe('commandMenuState', () => typeof ex.commandMenuState);
probe('commandMenuPages', () => typeof ex.commandMenuPages);
probe('commandMenuAsyncValue', () => ex.commandMenuAsyncValue('x'));
// a React context: its Provider and Consumer, as createContext makes them
probe('CodexButton', () => typeof ex.CodexButton);
probe('panelWidth', () => Object.fromEntries(['toRatio', 'persist', 'config', 'unified'].map((k) => [k, typeof ex.panelWidth?.[k]])));
probe('workspaceLayout', () => ({ setFull: typeof ex.workspaceLayout?.setFull, setPanel: typeof ex.workspaceLayout?.setPanel, activeTab: typeof ex.workspaceLayout?.activeTab, preference: typeof ex.workspaceLayout?.preference }));
probe('ResizeDivider', () => typeof ex.ResizeDivider);
probe('responsive', () => ({ closeSide: typeof ex.responsive?.closeSide, restoreSide: typeof ex.responsive?.restoreSide, setSidebar: typeof ex.responsive?.setSidebar }));
probe('panelMaths', () => (typeof ex.panelMaths?.bounds === 'function' ? [ex.panelMaths.bounds(1000, 'regular').maximum, ex.panelMaths.bounds(1000, 'full').maximum] : null));
probe('windowRegions', () => ({ sidebarWidth: typeof ex.windowRegions?.sidebarWidth, clampSidebar: typeof ex.windowRegions?.clampSidebar, setBottom: typeof ex.windowRegions?.setBottom }));
probe('bottomHeight', () => ({ clamp: typeof ex.bottomHeight?.clamp, range: typeof ex.bottomHeight?.clamp === 'function' ? [ex.bottomHeight.clamp(0, 800), ex.bottomHeight.clamp(1e9, 800)] : null }));
probe('sidebarOrderState', () => Object.fromEntries(['prefs', 'pinnedSortMode', 'projectOrder'].map((k) => [k, typeof ex.sidebarOrderState?.[k]])));
probe('navigationShell', () => ({ provider: !!ex.navigationShell && typeof ex.navigationShell === 'object' && 'Provider' in ex.navigationShell }));
probe('hosted', () => { const v = ex.composerScopeValue?.('c1', 'main', 'c1'); return { routeScopes: typeof ex.routeScopes, ScopeProvider: typeof ex.ScopeProvider, composerScopeValue: typeof ex.composerScopeValue, hostClient: typeof ex.hostClient, composerValue: { kind: v?.kind, placement: v?.placement } }; });
probe('conversationTab', () => (typeof ex.conversationTab?.prefetch === 'function' ? 'function' : typeof ex.conversationTab));
probe('sidebarFooter', () => Object.fromEntries(['usageAlert', 'checklist', 'financeChecklist', 'announcement', 'updateBanner', 'invite', 'stack', 'row', 'account', 'update'].map((k) => [k, !!ex.sidebarFooter?.[k] && ['function', 'object'].includes(typeof ex.sidebarFooter[k])])));
probe('sidebarShowAll', () => ({ set: typeof ex.sidebarShowAll?.set, atom: typeof ex.sidebarShowAll?.atom }));
probe('threadFind', () => { const f = ex.threadFind; return { fns: ['open', 'close', 'setDomain', 'setQuery', 'next', 'previous'].every((k) => typeof f?.[k] === 'function'), atoms: Object.keys(f?.atoms ?? {}).filter((k) => f.atoms[k] && typeof f.atoms[k] === 'object') }; });
probe('ComposerControllerContext', () => { const c = ex.ComposerControllerContext; return !!c && typeof c === 'object' && 'Provider' in c && ('Consumer' in c || '_currentValue' in c); });
probe('KeysLabel', () => typeof ex.KeysLabel);
probe('dynamicToolRenderers', () => { const d = ex.dynamicToolRenderers; return { list: Array.isArray(d.list), shape: d.list.length > 0 && d.list.every((r) => 'namespace' in r && typeof r.tool === 'string'), find: d.find(d.list[0]) === d.list[0] }; });   // a tool without a namespace has null
console.log(JSON.stringify(out));
process.exit(0); // the stock modules leave timers/observers behind
