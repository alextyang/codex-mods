'use strict';
// The app's own state in framework-main (breadth step D4; docs/graph/02-types.md Setting, SettingsSection, Theme, App; scout
// docs/design/realization/scouting/D4-21477.md): the app's settings, its version, whether its onboarding is done, and the system's
// appearance, held from the first live window's AppHost and reported to the Host.
// - Settings are the app's registry, served in main by the AppHost service `settings` (one store for the app): `readForAgent()` gives the
//   definitions of every setting that is not hidden (key, default, description, `agentAccess`: read-write | read-only, and a JSON Schema
//   of its value) with the configured and effective values; `read(key)` -> `{configured, effective}`; `onDidChange(key, fn)` (in-process)
//   returns the unsubscribe; `write(key, value)` is the UI's own path (the value is checked, its side effects run, it is saved under
//   `[desktop]` of the Codex config and pushed to every open Settings page).
// - The window's kept sizes (layouts.md D4) are settings no registry has: the app keeps them as persisted atoms (in the global state key
//   `electron-persisted-atom-state`), written when the user's drag of a divider ends and read when a window or a panel is made. They are
//   reported with the registry's (`layout.sidebarWidth`, `layout.panelShare`, `layout.bottomHeight`; read-only to the app's own agent,
//   so a mod's write asks), their value the user's when they dragged, else none (the default holds); written the app's way (its own
//   persisted-atom write, every window told), and unset by taking the key away (the app's built-in size holds again).
// - The version is the window's `appInfo.get()` (`version`, `buildNumber`, `appName`); `launchedAt` when this process started; a report
//   with `quitting: true` goes out at once when the app starts to quit (Electron's before-quit).
// - Onboarded is the app's own rule (its renderer derives it, no flag is stored): the persisted atom
//   `electron:onboarding-projectless-completed` (in the global state key `electron-persisted-atom-state`) is true, or there is a project.
// - The appearance is the one the system resolves for the app (Electron's nativeTheme, which the app sets from its theme mode).
// - The signed-in account's ids, plan and workspace (`account`, on request): the AppHost service `accountInfo` (the app's `accessInputs`):
//   `readAccountInfo()` decodes them from the session without returning it, and `readAccounts(language)` lists the account's workspaces
//   (the app's own request, which it caches). Only the fields below leave: never a token (its other methods, such as the local auth read,
//   are not used).
// Reports (`app-state`, debounced): everything on a reset (the first report, another window's services, the Host's `ready`), otherwise
// the settings whose values changed and the facts that changed. Operations (`app-state-op`, answered with `app-state-op-done` after the
// report of what they changed; `refused` when nothing was tried): `write-setting {key, value}` (a key the registry shows), `account` (the
// account's ids, plan and workspace: `{signedIn, accountId, userId, plan, workspace: {name, structure, role} | null}`), `navigate {path}`
// (one of a few of the app's pages, as the app's main opens them: a `navigate-to-route` to the window), `open-help` (the first item of
// the app's Help menu, Documentation, clicked as its menu service's `invokeItem` does, straight from the application menu: the service's
// ids are cleared by the page's own next snapshot, and the app rebuilds its menu as focus moves, so a snapshot's id can miss), `quit` (as Cmd+Q
// does: the app's own before-quit gate decides, with its dialog when chats are running), `open-login {path}` (the
// app-server's ChatGPT sign-in page, opened in the browser as the app opens it: an https page of openai.com or chatgpt.com only).
// Without a window or its services nothing happens: reports say `available: false`, the reason is logged once, nothing throws.

const OP_TIMEOUT_MS = 15_000;
const MAX_ID = 200;
const ONBOARDED_ATOM = 'electron:onboarding-projectless-completed';
const ATOMS_KEY = 'electron-persisted-atom-state';
const VIEW_CHANNEL = 'codex_desktop:message-for-view';
const ROUTES = new Set(['/settings/account', '/settings/usage']);
const PROJECTS_KEY = 'local-projects';
const HELP_MENU = 'help-menu';   // the id the app gives its Help menu (21477; its menu service's snapshot keys)
/** The window's kept sizes: setting key -> its persisted atom, the app's built-in value (none: the app fits one), its schema. */
const LAYOUT = Object.freeze({
  'layout.sidebarWidth': { atom: 'sidebar-width', default: 340, schema: { type: 'number', minimum: 240, maximum: 520 },
    description: 'The width of the sidebar (px) a new window starts with. Dragging its divider keeps the width dragged to.' },
  'layout.panelShare': { atom: 'app-shell:right-panel-width:v3', default: null, schema: { type: 'number', minimum: 0, maximum: 1 },
    description: 'The share of the workspace the side panel takes when it opens. Dragging its divider keeps the share dragged to; with none, the app fits one.' },
  'layout.bottomHeight': { atom: 'app-shell:bottom-panel-height', default: 280, schema: { type: 'number', minimum: 160 },
    description: 'The height of the bottom panel (px) when it opens. Dragging its divider keeps the height dragged to.' },
});

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const { createUserHolds, userHoldsOf, outcomeOf } = require('./user-holds.cjs');

const LAUNCHED_AT = Math.round(Date.now() - process.uptime() * 1000);   // when this process (the app) started
const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** A setting's values, without the ones it does not have. */
const valueOf = (configured, effective) => ({ ...(configured === undefined ? {} : { configured: json(configured) }), ...(effective === undefined ? {} : { effective: json(effective) }) });

/**
 * @param {{ appHost: ReturnType<typeof import('./apphost.cjs').installAppHost>, send(msg: object): void,
 *   systemAppearance?: (() => 'light' | 'dark') | null, onSystemAppearance?: ((fn: (a: 'light' | 'dark') => void) => () => void) | null,
 *   toView?: ((windowId: number, msg: object) => void) | null, openExternal?: ((url: string) => unknown) | null,
 *   quitApp?: (() => void) | null, onBeforeQuit?: ((fn: () => void) => () => void) | null,
 *   clickAppMenuItem?: ((menuId: string, windowId: number) => string | null) | null,
 *   log?: { info(m: string, d?: unknown): void, error(m: string, d?: unknown): void, warn?(m: string, d?: unknown): void },
 *   debounceMs?: number, opTimeoutMs?: number, holds?: ReturnType<typeof createUserHolds> }} o  `holds`: framework-main's holds of the
 *   user's own actions (user-holds.cjs), shared with the other areas that hold; its own over `send` when none is given
 */
function createAppState(o) {
  const { appHost, send } = o;
  const holds = o.holds ?? createUserHolds({ send });
  const debounceMs = o.debounceMs ?? 100;
  const opTimeoutMs = o.opTimeoutMs ?? OP_TIMEOUT_MS;
  const say = (level, m, d) => { try { (o.log?.[level] ?? o.log?.info)?.call(o.log, m, d); } catch { /* logging never breaks this module */ } };
  const message = (e) => String((e && e.message) || e).slice(0, 500);

  let bound = null;           // {winId, settings, appInfo, store, keys: Set, offs}
  let noted = false;
  let resetNext = true;
  let sent = null;            // what the last report said: {available, app (JSON), appearance}
  const changed = new Set();  // setting keys changed since the last report
  let sentLayout = {};        // the kept sizes' values the last report said, by key (JSON)
  let timer = null;
  let disposed = false;

  function post(msg) {
    try { send(msg); return true; } catch (e) { say('error', 'app state: the report to the Host failed', { message: message(e) }); return false; }
  }
  // ---- the user's own setting changes, held before the app writes them (public-hooks.md §3.5): every Settings page writes through this
  // service's `write` (21477: the renderer's settings bridge). While something holds Setting.set, a write passes the mods' interceptors
  // and policies as the user's Setting.set first: a refused one throws (the page puts its control back), one a mod did in the app's place
  // is not written again, and a change of the value is refused (the page could not show who changed it). Otherwise the write is the app's
  // own, at once, as before (reported after while a mod observes it). This module's own writes (the graph's Setting.set, whose call
  // already passed them) go to the service as it was.
  // the app's port to its windows calls a service's own methods, those of its class (an override on the instance is refused there), so the
  // hold is on the class's `write`: every instance of it is the app's settings
  const originals = new Map();   // a settings service's class (its prototype) -> its own write
  const SET = 'Setting.set';
  function holdWrites(settings) {
    const proto = settings ? Object.getPrototypeOf(settings) : null;
    if (!proto || proto === Object.prototype || originals.has(proto) || typeof proto.write !== 'function' || Object.hasOwn(settings, 'write')) return;
    const own = proto.write;
    originals.set(proto, own);
    proto.write = function write(key, value, ...rest) {
      if (disposed || typeof key !== 'string') return own.call(this, key, value, ...rest);
      const ref = { type: 'Setting', provider: 'codex', id: key }, args = [json(value)];
      if (!holds.held(SET)) {
        const r = own.call(this, key, value, ...rest);
        if (holds.observed(SET)) void outcomeOf(r).then((outcome) => holds.did({ ref, operation: 'set', args, outcome }));
        return r;
      }
      const self = this;
      return holds.ask({ prefix: 'uh', ref, operation: 'set', args, changes: false }).then((a) => {
        if (a.handled || a.stopped) return undefined;   // a mod set it in the app's place, or stopped it (graph-integrity G6.2: no error)
        if (a.go === false) throw new Error(`Not changed: ${a.message ?? 'not allowed'}`);
        const r = own.call(self, key, value, ...rest);
        void outcomeOf(r).then((outcome) => holds.done(a.requestId, outcome));
        return r;
      });
    };
  }
  // ---- the mods' defaults of the app's settings (public-hooks.md §3.8, H6i): the Host gives them by key (each fits the setting's schema);
  // the settings store's `getEffective`, which every read reaches (the windows' through the service's read, main's own directly: the
  // theme at start, the sound, the window backdrops), answers a mod's default where the user set none (a value they set, null too, is
  // theirs: the app's own way). Held on the store's class, once. The service's own `getEffective` answers some keys past the store's
  // (21477: `autoArchiveAfterDays` from what the user set, else Statsig; its archival worker reads it there): held on its class too, for
  // those, where the user set none (one the app decides by its own policy, such as `conversationDetailMode`, stays the app's). Kept with no
  // window open; the Host's going takes them away.
  const modDefaults = new Map();   // key -> value
  const storeOriginals = new WeakMap();   // a settings store's class -> its own getEffective
  const SERVICE_KEYS = new Set(['autoArchiveAfterDays']);
  const unset = (store, key) => { try { return store.get(key) === undefined; } catch { return false; } };
  function holdDefaults(settings) {
    const store = settings && settings.store;
    const proto = store ? Object.getPrototypeOf(store) : null;
    if (!proto || proto === Object.prototype || typeof proto.getEffective !== 'function' || typeof store.get !== 'function') return;
    if (!storeOriginals.has(proto)) {
      const own = proto.getEffective;
      storeOriginals.set(proto, own);
      proto.getEffective = function getEffective(key, ...rest) {
        if (!disposed && modDefaults.has(key) && unset(this, key)) return modDefaults.get(key);
        return own.call(this, key, ...rest);
      };
    }
    const sproto = Object.getPrototypeOf(settings);
    if (!sproto || sproto === Object.prototype || storeOriginals.has(sproto) || typeof sproto.getEffective !== 'function') return;
    const ownService = sproto.getEffective;
    storeOriginals.set(sproto, ownService);
    sproto.getEffective = function getEffective(key, ...rest) {
      if (!disposed && SERVICE_KEYS.has(key) && modDefaults.has(key) && this.store && unset(this.store, key)) return Promise.resolve(modDefaults.get(key));
      return ownService.call(this, key, ...rest);
    };
  }
  /** The mods' defaults now: the keys whose default changed are applied the app's way (its side effects, its listeners) and reported. */
  function setDefaults(next) {
    const keys = new Set([...modDefaults.keys(), ...Object.keys(next)]);
    const moved = [...keys].filter((k) => JSON.stringify(modDefaults.get(k)) !== JSON.stringify(next[k]));
    modDefaults.clear();
    for (const [k, v] of Object.entries(next)) modDefaults.set(k, v);
    const settings = bound && bound.settings;
    for (const key of moved) {
      // as after a write of it: the app's own effects of the value (the theme, the backdrops), then every window reads it again
      try { if (settings && typeof settings.afterWrite === 'function') settings.afterWrite(key, settings.store.getEffective(key)); } catch (e) { say('warn', 'app state: a default\'s effects failed', { key, message: message(e) }); }
      try { if (settings && settings.store && typeof settings.store.notifyChangeListeners === 'function') settings.store.notifyChangeListeners(key); } catch { /* the windows read it later */ }
      changed.add(key);
    }
    return moved;
  }
  /** Every window's settings service held (one service may serve several windows; its class is held once). */
  function holdAll() { for (const w of appHost.windows()) { try { holdWrites(servicesOf(w.host)?.settings); holdDefaults(servicesOf(w.host)?.settings); } catch { /* that window has none */ } } }
  /** This module's own write of a setting: the service's write as it was (the graph's call passed the policies already). */
  const writeOwn = (settings, key, value) => (originals.get(Object.getPrototypeOf(settings)) ?? settings.write).call(settings, key, value);
  /** The settings store under the service (its state, config, pending writes and saves: 21477 and 20770 alike), or null. */
  const storeOf = (settings) => {
    const store = settings && settings.store;
    return store && store.state instanceof Map && store.pendingWrites instanceof Map && typeof store.notifyChangeListeners === 'function'
      && typeof store.persistPendingSettings === 'function' && typeof store.flush === 'function' && typeof store.getEffective === 'function' ? store : null;
  };
  /**
   * A setting's value saved (H7y): the service's write keeps it in memory and saves it in the background (its store's queue, which says
   * nothing of a failure but keeps the write pending); answered once that queue has gone past it.
   */
  async function saved(settings, key) {
    const store = storeOf(settings);
    if (!store) return;
    await store.flush();
    if (store.pendingWrites.has(key)) throw new Error('the app has it but could not save it yet');
  }
  /**
   * No value for a setting, as the user never set it (the app's own built-in one, or a mod's default): the service's write parses every
   * value with the setting's schema, which has no "unset", so this is its write one level down, the store's own way (built review H7y round
   * 2): it forgets the value (its state, its config) and keeps a pending write of null, which its save turns into the key's removal from
   * the config file (its serializer gives null, the config writer clears it), in order with every other save, a write after it the newest;
   * then its listeners and the service's effects of the value now in effect. Asked again when it has none, it saves the removal again.
   */
  async function unsetOwn(settings, key) {
    const store = storeOf(settings);
    if (!store) throw new Error('the app\'s settings store cannot be reached');
    const had = store.state.has(key);
    store.state.delete(key);
    if (store.desktopConfig && typeof store.desktopConfig === 'object') delete store.desktopConfig[key];
    store.pendingWrites.set(key, null);
    if (had) {
      store.notifyChangeListeners(key);
      if (typeof settings.afterWrite === 'function') settings.afterWrite(key, store.getEffective(key));
    }
    void store.persistPendingSettings();
    await saved(settings, key);
  }
  function servicesOf(host) {
    const s = host && host.services;
    const settings = s && s.settings;
    if (!settings || typeof settings.readForAgent !== 'function' || typeof settings.read !== 'function' || typeof settings.write !== 'function'
      || typeof settings.onDidChange !== 'function') return null;
    const store = s.projects && s.projects.globalState;
    const accounts = s.accountInfo || s.accessInputs;
    return { settings, appInfo: s.appInfo && typeof s.appInfo.get === 'function' ? s.appInfo : null, store: store && typeof store.get === 'function' ? store : null,
      accounts: accounts && typeof accounts.readAccountInfo === 'function' ? accounts : null };
  }
  async function bind() {
    if (bound || disposed) return;
    for (const w of appHost.windows()) {
      const s = servicesOf(w.host);
      if (!s) continue;
      let defs;
      try { defs = await withTimeout(s.settings.readForAgent()); } catch (e) { say('warn', 'app state: the app\'s settings could not be read', { window: w.id, message: message(e) }); continue; }
      if (bound || disposed) return;
      const keys = new Set((Array.isArray(defs && defs.definitions) ? defs.definitions : []).map((d) => d && d.key).filter((k) => str(k, MAX_ID)));
      const offs = [];
      for (const key of keys) {
        try { const off = s.settings.onDidChange(key, () => { changed.add(key); schedule(); }); if (typeof off === 'function') offs.push(off); } catch { /* that key is not watched */ }
      }
      if (s.store && typeof s.store.onDidChange === 'function') {
        for (const key of [ATOMS_KEY, PROJECTS_KEY]) { try { const off = s.store.onDidChange(key, schedule); if (typeof off === 'function') offs.push(off); } catch { /* not watched */ } }
      }
      if (typeof o.onSystemAppearance === 'function') { try { offs.push(o.onSystemAppearance(() => schedule())); } catch { /* not watched */ } }
      bound = { winId: w.id, ...s, keys, offs };
      holdAll();
      resetNext = true;
      say('info', 'app state: holding the app\'s settings', { window: w.id, settings: keys.size });
      schedule();
      return;
    }
    if (!noted && appHost.windows().length) { noted = true; say('info', 'app state: no window has the settings service; the app\'s settings are not reported'); }
  }
  function unbind() {
    if (!bound) return;
    for (const off of bound.offs) { try { off(); } catch { /* already gone */ } }
    bound = null;
  }
  const sub = appHost.subscribe((e) => {
    if (disposed) return;
    if (e.type === 'removed' && bound && bound.winId === e.id) { unbind(); bind().then(() => { if (!bound) schedule(); }); }
    else if (e.type === 'added' && !bound) bind();
  });

  function schedule() {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    if (timer.unref) timer.unref();
  }
  function withTimeout(p) {
    let t = null;
    return Promise.race([
      Promise.resolve(p).finally(() => clearTimeout(t)),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`the app did not answer in ${opTimeoutMs} ms`)), opTimeoutMs); if (t.unref) t.unref(); }),
    ]);
  }
  /** The kept sizes as settings' values: the user's (what they dragged to), else none. */
  function layoutValues() {
    let atoms = null;
    try { atoms = bound && bound.store ? bound.store.get(ATOMS_KEY) : null; } catch { atoms = null; }
    return Object.fromEntries(Object.entries(LAYOUT).map(([key, l]) => [key, valueOf(atoms && typeof atoms[l.atom] === 'number' ? atoms[l.atom] : undefined, undefined)]));
  }
  /** One persisted atom written as the app writes it (its own handler, which tells every window), or taken away (`undefined`): the store,
   *  then every window told as the app tells them. */
  async function writeAtom(key, value) {
    const handler = (() => { for (const w of appHost.windows()) { const h = w.host && w.host.services && w.host.services.browserHost && w.host.services.browserHost.messageHandler; if (h && typeof h.updatePersistedAtomState === 'function') return h; } return null; })();
    if (value !== undefined && handler) { await handler.updatePersistedAtomState(null, key, value); return; }
    if (!bound.store || typeof bound.store.set !== 'function') throw new Error('the app\'s state cannot be written from here');
    const atoms = { ...(bound.store.get(ATOMS_KEY) ?? {}) };
    if (value === undefined) delete atoms[key]; else atoms[key] = value;
    await bound.store.set(ATOMS_KEY, atoms);
    if (typeof o.toView === 'function') for (const w of appHost.windows()) { try { o.toView(w.id, { type: 'persisted-atom-updated', key, value: value ?? null, deleted: value === undefined }); } catch { /* that window is gone */ } }
  }
  async function appFacts() {
    let info;
    try { info = bound.appInfo ? await withTimeout(bound.appInfo.get()) : null; } catch { info = null; }
    let onboarded = null;
    if (bound.store) {
      try {
        const atoms = bound.store.get(ATOMS_KEY);
        const projects = bound.store.get(PROJECTS_KEY);
        onboarded = (atoms && typeof atoms === 'object' && atoms[ONBOARDED_ATOM] === true) || (projects && typeof projects === 'object' && Object.keys(projects).length > 0);
      } catch { onboarded = null; }
    }
    return {
      version: info && str(info.version, 100) ? info.version : null,
      buildNumber: info && (typeof info.buildNumber === 'number' || str(info.buildNumber, 50)) ? String(info.buildNumber) : null,
      appName: info && str(info.appName, 200) ? info.appName : null,
      onboarded,
      launchedAt: LAUNCHED_AT,
    };
  }
  /** Report what changed (everything when `reset`). `force`: report even when nothing did (the Host asked). One report at a time. */
  let flushing = Promise.resolve();
  function flush(force = false) {
    clearTimeout(timer); timer = null;
    flushing = flushing.then(() => report(force), () => report(force));
    return flushing;
  }
  async function report(force) {
    if (disposed) return;
    if (!bound) {
      if (force || !sent || sent.available) { if (post({ type: 'app-state', available: false })) sent = { available: false, app: null, appearance: null }; }
      return;
    }
    const reset = resetNext || !sent || !sent.available;
    const msg = { type: 'app-state', available: true };
    try {
      if (reset) {
        changed.clear();
        const all = await withTimeout(bound.settings.readForAgent());
        msg.definitions = (Array.isArray(all.definitions) ? all.definitions : []).filter((d) => d && str(d.key, MAX_ID))
          .map((d) => ({ key: d.key, agentAccess: d.agentAccess === 'read-only' ? 'read-only' : 'read-write', default: json(d.default), description: str(d.description, 4000) ? d.description : null, schema: json(d.schema) ?? null }));
        msg.values = Object.fromEntries(msg.definitions.map((d) => [d.key, valueOf(all.settings && all.settings[d.key], all.effectiveSettings && all.effectiveSettings[d.key])]));
        for (const [key, l] of Object.entries(LAYOUT)) msg.definitions.push({ key, agentAccess: 'read-only', default: l.default, description: l.description, schema: l.schema });
        sentLayout = {};
        msg.reset = true;
      } else if (changed.size) {
        const keys = [...changed]; changed.clear();
        const read = await Promise.all(keys.map(async (k) => { try { const r = await withTimeout(bound.settings.read(k)); return [k, valueOf(r && r.configured, r && r.effective)]; } catch { return null; } }));
        msg.values = Object.fromEntries(read.filter(Boolean));
      }
      const layout = layoutValues();
      for (const [key, v] of Object.entries(layout)) {
        if (sentLayout[key] === JSON.stringify(v)) continue;
        (msg.values ??= {})[key] = v;
      }
      sentLayout = Object.fromEntries(Object.entries(layout).map(([k, v]) => [k, JSON.stringify(v)]));
    } catch (e) { say('warn', 'app state: reading the app\'s settings failed', { message: message(e) }); return; }
    const app = await appFacts();
    const appKey = JSON.stringify(app);
    if (reset || !sent || sent.app !== appKey) msg.app = app;
    const appearance = typeof o.systemAppearance === 'function' ? o.systemAppearance() : null;
    if (reset || !sent || sent.appearance !== appearance) msg.appearance = appearance;
    if (!reset && !force && !msg.values && msg.app === undefined && msg.appearance === undefined) return;
    if (!post(msg)) return;
    resetNext = false;
    sent = { available: true, app: appKey, appearance };
  }

  /** A Host operation (`app-state-op`); the answer follows the report of what it changed. */
  async function run(msg) {
    const requestId = msg && msg.requestId;
    if (!str(requestId, MAX_ID)) return;
    const answer = (fields) => post({ type: 'app-state-op-done', requestId, ...fields });
    const refuse = (error) => answer({ ok: false, error, refused: true });
    try {
      // the mods' defaults, with or without a window (one taken back must not stay until a window opens)
      if (msg.op === 'setting-defaults') {
        const given = msg.defaults && typeof msg.defaults === 'object' && !Array.isArray(msg.defaults) ? msg.defaults : null;
        if (!given) return void refuse('the defaults are an object by key');
        const next = Object.fromEntries(Object.entries(given).filter(([k, v]) => str(k, MAX_ID) && (!bound || bound.keys.has(k)) && v !== undefined && v !== null));
        holdAll();
        const moved = setDefaults(next);
        if (moved.length && bound) await flush();
        return void answer({ ok: true, result: { applied: Object.keys(next), moved } });
      }
      if (!bound) return void refuse('the app\'s settings are not available');
      if ((msg.op === 'write-setting' || msg.op === 'unset-setting') && LAYOUT[msg.key]) {
        const l = LAYOUT[msg.key];
        const v = msg.value;
        if (msg.op === 'write-setting' && !(typeof v === 'number' && Number.isFinite(v) && (l.schema.minimum === undefined || v >= l.schema.minimum)
          && (l.schema.maximum === undefined || v <= l.schema.maximum))) return void refuse(`${msg.key} is a number within ${JSON.stringify(l.schema)}`);
        await withTimeout(writeAtom(l.atom, msg.op === 'write-setting' ? v : undefined));
        await flush();
        return void answer({ ok: true });
      }
      if (msg.op === 'write-setting') {
        if (!str(msg.key, MAX_ID) || !bound.keys.has(msg.key)) return void refuse('the app has no such setting');
        if (msg.value === undefined) return void refuse('a value is needed');
        await withTimeout(writeOwn(bound.settings, msg.key, msg.value));
        await withTimeout(saved(bound.settings, msg.key));
        changed.add(msg.key);
        await flush();
        return void answer({ ok: true });
      }
      // a setting with no default back to no value (the app's own built-in look: a chrome theme the user never set; H7y)
      if (msg.op === 'unset-setting') {
        if (!str(msg.key, MAX_ID) || !bound.keys.has(msg.key)) return void refuse('the app has no such setting');
        if (!storeOf(bound.settings)) return void refuse('the app keeps a value for it: its settings store cannot be reached');
        await withTimeout(unsetOwn(bound.settings, msg.key));   // not saved: the operation fails (it may have changed what the app holds)
        changed.add(msg.key);
        await flush();
        return void answer({ ok: true });
      }

      if (msg.op === 'account') return void answer({ ok: true, result: await readAccount() });
      if (msg.op === 'open-help') {
        if (typeof o.clickAppMenuItem !== 'function') return void refuse('the app\'s menu cannot be reached');
        const label = o.clickAppMenuItem(HELP_MENU, bound.winId);
        if (label === null) return void refuse('the app\'s Help menu has no item');
        return void answer({ ok: true, result: { label: str(label, 200) ? label : null } });
      }
      if (msg.op === 'quit') {
        if (typeof o.quitApp !== 'function') return void refuse('the app cannot be quit from here');
        answer({ ok: true });
        o.quitApp();
        return undefined;
      }
      if (msg.op === 'open-login') {
        let u = null;
        try { u = new URL(String(msg.path)); } catch { u = null; }
        if (!u || u.protocol !== 'https:' || !/(^|\.)(openai\.com|chatgpt\.com)$/.test(u.hostname)) return void refuse('only a ChatGPT sign-in page opens here');
        if (typeof o.openExternal !== 'function') return void refuse('the browser cannot be reached');
        await withTimeout(o.openExternal(u.href));
        return void answer({ ok: true });
      }
      if (msg.op === 'navigate') {
        if (!ROUTES.has(msg.path)) return void refuse('the app cannot be sent to that page');
        if (typeof o.toView !== 'function') return void refuse('the app\'s pages cannot be reached');
        o.toView(bound.winId, { type: 'navigate-to-route', path: msg.path });
        return void answer({ ok: true });
      }
      return void refuse(`unknown operation ${String(msg.op).slice(0, 50)}`);
    } catch (e) {
      answer({ ok: false, error: message(e), refused: e && e.refused === true });
    }
  }

  /** The signed-in account's ids, plan and workspace, read the app's way; only these fields leave. */
  async function readAccount() {
    if (!bound.accounts) throw Object.assign(new Error('the app\'s account service is not available'), { refused: true });
    const env = await withTimeout(bound.accounts.readAccountInfo());
    const data = env && env.status === 'ready' && env.data && typeof env.data === 'object' ? env.data : null;
    if (!data) return { signedIn: false, reason: env && str(env.reason, 100) ? env.reason : null };
    let workspace = null;
    if (str(data.accountId, MAX_ID) && typeof bound.accounts.readAccounts === 'function') {
      try {
        const list = await withTimeout(bound.accounts.readAccounts('en'));
        const a = (Array.isArray(list && list.accounts) ? list.accounts : []).find((x) => x && x.id === data.accountId);
        if (a) workspace = { name: str(a.name, 300) ? a.name : null, structure: a.structure === 'workspace' ? 'workspace' : 'personal', role: str(a.account_user_role, 50) ? a.account_user_role : null };
      } catch { workspace = null; }
    }
    return { signedIn: true, accountId: str(data.accountId, MAX_ID) ? data.accountId : null, userId: str(data.userId, MAX_ID) ? data.userId : null, plan: str(data.plan, 100) ? data.plan : null, workspace };
  }

  const offQuit = typeof o.onBeforeQuit === 'function' ? o.onBeforeQuit(() => { if (!disposed && bound) post({ type: 'app-state', available: true, quitting: true }); }) : null;

  bind();
  return {
    run,
    /** The Host (re)started: it knows nothing yet. */
    resend() { resetNext = true; holdAll(); flush(true); },
    /** The Host went: its mods' defaults go with it (the next Host gives its own). */
    hostGone() { if (!disposed && modDefaults.size) setDefaults({}); },
    /** The holds of the user's own actions this module asks (user-holds.cjs). */
    holds,
    state: () => ({ bound: !!bound, window: bound ? bound.winId : null, settings: bound ? bound.keys.size : 0 }),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      sub.dispose();
      unbind();
      for (const [proto, own] of originals) { try { proto.write = own; } catch { /* the class went */ } }
      originals.clear();
      try { offQuit?.(); } catch { /* gone */ }
    },
  };
}

/** framework-main module entry (contracts/main-hooks.d.ts): must not throw. */
function register(hooks) {
  try {
    if (!hooks.appHost) { hooks.log.info('app state: no AppHost hold; the app\'s settings are not reported'); return; }
    const electron = hooks.electron;
    const st = createAppState({
      appHost: hooks.appHost, send: hooks.sendToHost, log: hooks.log, holds: userHoldsOf(hooks),
      systemAppearance: electron && typeof electron.systemAppearance === 'function' ? () => electron.systemAppearance() : null,
      onSystemAppearance: electron && typeof electron.onSystemAppearance === 'function' ? (fn) => electron.onSystemAppearance(fn) : null,
      toView: electron && typeof electron.postToWindow === 'function' ? (id, msg) => electron.postToWindow(id, VIEW_CHANNEL, msg) : null,
      openExternal: electron && typeof electron.openExternal === 'function' ? (url) => electron.openExternal(url) : null,
      quitApp: electron && typeof electron.quitApp === 'function' ? () => electron.quitApp() : null,
      clickAppMenuItem: electron && typeof electron.clickAppMenuItem === 'function' ? (menuId, id) => electron.clickAppMenuItem(menuId, id) : null,
      onBeforeQuit: electron && typeof electron.onBeforeQuit === 'function' ? (fn) => electron.onBeforeQuit(fn) : null,
    });
    hooks.onHostMessage('app-state-op', (msg) => { st.run(msg); });
    hooks.onHostMessage('ready', () => st.resend());
    hooks.onHostState?.((up) => { if (!up) st.hostGone(); });
  } catch (e) {
    try { hooks.log.error('app state register failed', { message: String((e && e.message) || e) }); } catch { /* nothing left to do */ }
  }
}

module.exports = { register, createAppState };
