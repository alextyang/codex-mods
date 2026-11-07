'use strict';
// framework-main: UI plane glue (contracts/main-hooks.d.ts). framework-main calls `register(hooks)` once, synchronously, after starting
// the Host. This module must not throw: failures go to hooks.log and leave the app running unmodded.
//   - registers the framework preload for the app's sessions;
//   - on each page load's `codexmods:hello` (sent by the preload): creates that load's renderer and management channels, gives one end
//     of each to the window (`codexmods:port`) and the other to hooks.bridgeRealm, and returns the bundled
//     renderer runtime plus the adapter's UI data;
//   - serves `codexmods:log` (renderer/preload startup failures → hooks.log.error), `codexmods:framework-module` (bundled privileged modules, allow-listed) and `codexmods:pick-file` (native open dialog);
const fs = require('node:fs');
const path = require('node:path');
const { bundle } = require('./bundle.cjs');

/** Privileged built-in renderer modules the preload may request, by name → entry relative to framework/renderer/. */
const FRAMEWORK_MODULES = Object.freeze({ 'recovery/index.mjs': 'recovery/index.mjs' });   // Adjustments went with E6.6d: the Mods pages are the framework's UI
const EXT = /^[A-Za-z0-9]{1,16}$/;
/** The paths the framework's own navigation opens (E6.4): its Mods pages, and Settings › General where the recovery entry is. */
const FRAMEWORK_PATH = /^\/settings\/(codexmods(\/~(detail|update|developer)|\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/(permissions|activity|~[A-Za-z0-9][A-Za-z0-9._-]{0,127}))?)?|general-settings)$/;
/** A mod's own page (layouts.md D7): its route is in the app's tree only where the pack has the seam; a path with no route blanks the window. */
const PAGE_PATH = /^\/codexmods\/page\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// an instance's registered view (graph-integrity G2.2): its provider, then `view~` and its ref in base64url (renderer/present/main-pages.mjs)
const VIEW_PATH = /^\/codexmods\/page\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/view~[A-Za-z0-9_-]{1,1395}$/;

/** The UI-relevant part of the adapter pack (the page never sees transforms, protocol or backend). */
function uiBoot(adapter) {
  return {
    adapter: { build: adapter.build, anchors: adapter.anchors, components: adapter.components, react: adapter.react, theme: adapter.theme, ...(adapter.seams ? { seams: adapter.seams } : {}) },
    appBuild: `${adapter.build.version}-${adapter.build.bundleVersion}`,
  };
}

/** What of a binding's `needs` (seams, exposures) the pack's seams.hooks does not deliver. */
function missingNeeds(needs, hooks) {
  if (!needs || typeof needs !== 'object') return [];
  const out = [];
  for (const s of Array.isArray(needs.seams) ? needs.seams : []) if (!hooks || !hooks[s]) out.push(`seam ${s}`);
  for (const x of Array.isArray(needs.exposures) ? needs.exposures : []) if (!hooks || !hooks.exposures || !hooks.exposures[x]) out.push(`exposure ${x}`);
  return out;
}

/**
 * The kernel's boot: the bindings armed on this build (their prop-key addresses and canaries) and the command taps (none until mods add
 * commands). A binding is armed only when the pack's seams.hooks delivers everything it needs (boundary review 4a).
 */
function kernelBootOf(rendererDir, log, seams) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(rendererDir, 'present', 'addresses.json'), 'utf8'));
    const hooks = seams && typeof seams === 'object' ? seams.hooks : null;
    const bindings = [];
    for (const b of Array.isArray(a.bindings) ? a.bindings : []) {
      const byKeys = Array.isArray(b?.keys) && b.keys.length > 0;
      const byExposure = typeof b?.exposure === 'string' && b.exposure.length > 0;   // matched by identity (docs/design/systems.md E0)
      if (!b || typeof b.id !== 'string' || (!byKeys && !byExposure)) continue;
      const scope = typeof b.scope === 'string' && b.scope.length > 0 ? b.scope : null;   // read through useScope (docs/design/systems.md E2)
      const context = typeof b.context === 'string' && b.context.length > 0 ? b.context : null;   // optional: without it the binding has no live controller
      // a dotted exposure (`appShell.PageBanner`) needs the exposure it reaches into
      const exposures = [...(b.needs?.exposures ?? []), ...(byExposure ? [b.exposure.split('.')[0]] : []), ...(scope ? ['useScope', scope] : [])];
      const missing = missingNeeds({ ...b.needs, exposures: [...new Set(exposures)] }, hooks);
      if (missing.length) { log.info('presentation binding not armed: this build does not deliver what it needs', { binding: b.id, missing }); continue; }
      const canary = b.canary && typeof b.canary === 'object' ? Object.fromEntries(Object.entries(b.canary).filter(([, v]) => typeof v === 'string')) : null;
      bindings.push({ id: b.id, ...(byExposure ? { exposure: b.exposure } : { keys: b.keys.filter((k) => typeof k === 'string') }), ...(b.exact === true ? { exact: true, ...(Array.isArray(b.optional) && b.optional.length ? { optional: b.optional.filter((k) => typeof k === 'string') } : {}) } : {}), ...(canary ? { canary } : {}), ...(scope ? { scope } : {}),
        ...(typeof b.site === 'string' && /^[a-z][a-z-]{0,39}$/.test(b.site) ? { site: b.site } : {}),   // a site its descendants read (E8.8)
        ...(b.readsSite === true ? { readsSite: true } : {}),   // it reads the nearest site (E8.7b)
        ...(b.element === true && byKeys && !byExposure ? { element: true } : {}),   // a generic component's: matched per element (E8.3f)
        ...(b.rematch === true && byKeys && !byExposure ? { rematch: true } : {}),   // tried after the type's misses too (H7x review 1)
        ...(context ? { context } : {}) });   // the app's context its component sits in, an exposure (E8.3b)
    }
    return { abi: a.abi ?? 1, bindings, taps: { commands: [], handlers: [], messages: {} }, pageRoute: !!hooks?.pageRoute };   // the framework's route for a mod's page
  } catch (e) {
    log.error('presentation addresses unreadable: no bindings armed', { message: String(e?.message ?? e) });
    return { abi: 1, bindings: [], taps: { commands: [], handlers: [], messages: {} } };
  }
}

/**
 * @param {import('../../../contracts/main-hooks.d.ts').MainHooks} hooks
 * @param {{ rendererDir?: string, preloadPath?: string }} [opts]  test overrides
 */
function register(hooks, opts = {}) {
  try {
    const frameworkRoot = path.resolve(__dirname, '..', '..');             // …/framework
    const rendererDir = opts.rendererDir ?? path.join(frameworkRoot, 'renderer');
    const preloadPath = opts.preloadPath ?? path.join(frameworkRoot, 'preload', 'preload.cjs');
    const baseDir = path.resolve(rendererDir, '..', '..');                  // module ids are relative to the tree root (framework/ and sdk/ live under it)
    const { electron, log } = hooks;
    const boot = uiBoot(hooks.adapter);

    let runtimeExpr = null;
    const runtime = () => {
      if (runtimeExpr === null) runtimeExpr = bundle({ entry: path.join(rendererDir, 'runtime.mjs'), baseDir });
      return runtimeExpr;
    };
    const frameworkModules = new Map();
    const frameworkModule = (name) => {
      const rel = FRAMEWORK_MODULES[name];
      if (!rel) return null;
      const entry = path.join(rendererDir, rel);
      if (!fs.existsSync(entry)) return null;
      if (!frameworkModules.has(name)) frameworkModules.set(name, bundle({ entry, baseDir }));
      return frameworkModules.get(name);
    };

    electron.session.registerPreloadScript({ type: 'frame', filePath: preloadPath });

    // The presentation kernel's boot (docs/design/presentations.md V3), asked synchronously by the preload at document start: the armed
    // bindings' addresses and the command taps. Nothing here may be slow: the page waits for it.
    const kernelBoot = kernelBootOf(rendererDir, log, hooks.adapter && hooks.adapter.seams);
    electron.handleSync?.('codexmods:kernel', () => kernelBoot);

    electron.handle('codexmods:hello', (windowId) => {
      try {
        const expr = runtime();                                              // may throw: logged below, page runs unmodded
        // The Host is a separate Node process (no port transfer): the main-side end of each channel goes to framework-main's bridge.
        const renderer = electron.createChannel();
        electron.postToWindow(windowId, 'codexmods:port', { kind: 'renderer' }, [renderer.port2]);
        hooks.bridgeRealm(windowId, 'renderer', renderer.port1);
        const management = electron.createChannel();
        electron.postToWindow(windowId, 'codexmods:port', { kind: 'management' }, [management.port2]);
        hooks.bridgeRealm(windowId, 'management', management.port1);
        return { runtime: expr, boot };
      } catch (e) {
        log.error('hello failed', { message: String(e?.message ?? e) });
        return null;
      }
    });

    electron.handle('codexmods:framework-module', (windowId, name) => {
      try { return typeof name === 'string' ? frameworkModule(name) : null; } catch (e) { log.error('framework module bundle failed', { name: String(name), message: String(e?.message ?? e) }); return null; }
    });

    // Renderer/preload startup failures land here so a broken UI plane is never silent (hooks.log is the Host-visible log).
    const logCounts = new Map();
    electron.handle('codexmods:log', (windowId, rec) => {
      const n = (logCounts.get(windowId) ?? 0) + 1;
      logCounts.set(windowId, n);
      if (n > 50) return null;
      const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
      log.error('renderer startup failure', { windowId, phase: str(rec?.phase, 60), message: str(rec?.message, 500), stack: str(rec?.stack, 2000), documentState: rec?.documentState && typeof rec.documentState === 'object' ? { readyState: str(rec.documentState.readyState, 20), hasRoot: rec.documentState.hasRoot === true } : undefined });
      return null;
    });

    // The framework's own navigation (E6.4): the band opens the framework's pages, or the recovery entry, in the window that asked, as the
    // app's main does (navigate-to-route); only those paths, and no mod's interceptor is on this path.
    electron.handle('codexmods:navigate', async (windowId, req) => {
      const target = typeof req?.path === 'string' ? req.path : '';
      const allowed = FRAMEWORK_PATH.test(target) || ((PAGE_PATH.test(target) || VIEW_PATH.test(target)) && !!hooks.adapter?.seams?.hooks?.pageRoute);
      if (!allowed || typeof electron.postToWindow !== 'function') return false;
      electron.postToWindow(windowId, 'codex_desktop:message-for-view', { type: 'navigate-to-route', path: target });
      return true;
    });

    // A file (a mod package, filtered by extension) or, with `directory`, a folder (a development package, E6.2).
    electron.handle('codexmods:pick-file', async (windowId, req) => {
      const directory = req?.directory === true;
      const extensions = !directory && Array.isArray(req?.extensions) ? req.extensions.filter((x) => typeof x === 'string' && EXT.test(x)).slice(0, 16) : [];
      const picked = await electron.showOpenDialog(windowId, {
        ...(extensions.length ? { filters: [{ name: 'Mod package', extensions }] } : {}),
        properties: [directory ? 'openDirectory' : 'openFile'],
      });
      return Array.isArray(picked) && typeof picked[0] === 'string' ? picked[0] : null;
    });

    log.info('views registered');
  } catch (e) {
    try { hooks.log.error('views register failed', { message: String((e && e.message) || e) }); } catch { /* nothing left to do */ }
  }
}

module.exports = { register, uiBoot, FRAMEWORK_MODULES };
