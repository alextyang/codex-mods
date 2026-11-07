// framework-main's app-state module (app-state.cjs) against a fake AppHost whose `settings` service behaves like the app's (21477:
// `readForAgent()` -> the visible definitions with configured and effective values; `read(key)`; `write(key, value)` parses, stores and
// calls the key's listeners; `onDidChange(key, fn)` returns the unsubscribe), `appInfo.get()` and the projects manager's global state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installAppHost } = require('./apphost.cjs');
const { createAppState } = require('./app-state.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(3); }
}
const quiet = () => ({ info() {}, warn() {}, error() {} });

const DEFS = [
  { key: 'appearanceTheme', agentAccess: 'read-write', default: 'system', description: 'The app theme.', schema: { type: 'string', enum: ['system', 'light', 'dark'] } },
  { key: 'git-commit-instructions', agentAccess: 'read-only', default: '', description: 'Commit instructions.', schema: { type: 'string' } },
];
function fakeApp() {
  const configured = new Map([['appearanceTheme', 'dark']]);
  const listeners = new Map();
  const calls = [];
  // the app's settings service is a class's instance (its methods on the prototype, as the app's port to its windows calls them)
  const settings = Object.create({
    async readForAgent() {
      calls.push(['readForAgent']);
      return { filePath: '/h/config.toml', settings: Object.fromEntries(configured), effectiveSettings: Object.fromEntries(DEFS.map((d) => [d.key, configured.get(d.key) ?? d.default])), definitions: DEFS };
    },
    async read(key) { const d = DEFS.find((x) => x.key === key); return { configured: configured.get(key), effective: configured.get(key) ?? d?.default }; },
    async write(key, value) {
      calls.push(['write', key, value]);
      if (key === 'appearanceTheme' && !['system', 'light', 'dark'].includes(value)) throw new Error('Invalid enum value');
      configured.set(key, value);
      for (const fn of listeners.get(key) ?? []) fn();
    },
    onDidChange(key, fn) { const set = listeners.get(key) ?? new Set(); set.add(fn); listeners.set(key, set); return () => set.delete(fn); },
  });
  const state = new Map([['local-projects', {}], ['electron-persisted-atom-state', { 'electron:onboarding-projectless-completed': false }]]);
  const glisteners = new Map();
  const globalState = {
    get: (k) => state.get(k) ?? null,
    onDidChange(k, fn) { const s = glisteners.get(k) ?? new Set(); s.add(fn); glisteners.set(k, s); return () => s.delete(fn); },
    set(k, v) { state.set(k, v); for (const fn of glisteners.get(k) ?? []) fn(); },
  };
  return { settings, calls, configured, globalState, services: { settings, appInfo: { async get() { return { version: '26.1016.62342', buildNumber: 21477, appName: 'ChatGPT', appIconMedium: 'data:...' }; } }, projects: { globalState } } };
}
function sender(id) {
  const s = { id, handlers: [], destroyed: false, once(ev, fn) { if (ev === 'destroyed') s.handlers.push(fn); }, isDestroyed: () => s.destroyed, destroy() { s.destroyed = true; for (const fn of s.handlers.splice(0)) fn(); } };
  return s;
}
function setup(app = fakeApp(), opts = {}) {
  const g = {};
  const hold = installAppHost({ log: quiet(), global: g });
  const sent = [];
  let appearance = 'dark';
  const appearanceFns = new Set();
  const st = createAppState({ appHost: hold, send: (m) => sent.push(structuredClone(m)), log: quiet(), debounceMs: 8,
    systemAppearance: () => appearance, onSystemAppearance: (fn) => { appearanceFns.add(fn); return () => appearanceFns.delete(fn); }, ...opts });
  const windows = new Map();
  return {
    app, st, sent,
    open(id, services) { const s = sender(id); windows.set(id, s); g.__codexmods.appHost({ services: services ?? app.services }, s); return s; },
    close(id) { windows.get(id).destroy(); },
    reports: () => sent.filter((m) => m.type === 'app-state'),
    answers: () => sent.filter((m) => m.type === 'app-state-op-done'),
    setAppearance(a) { appearance = a; for (const fn of appearanceFns) fn(a); },
    dispose() { st.dispose(); hold.dispose(); },
  };
}

test('the first window\'s settings are held: a reset report with the definitions, the values, the app\'s facts and the appearance', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1, 2000, 'the first report');
    const r = t.reports()[0];
    assert.deepEqual(r.definitions.map((d) => [d.key, d.agentAccess]), [['appearanceTheme', 'read-write'], ['git-commit-instructions', 'read-only'],
      ['layout.sidebarWidth', 'read-only'], ['layout.panelShare', 'read-only'], ['layout.bottomHeight', 'read-only']]);
    assert.deepEqual(r.values, { appearanceTheme: { configured: 'dark', effective: 'dark' }, 'git-commit-instructions': { effective: '' },
      'layout.sidebarWidth': {}, 'layout.panelShare': {}, 'layout.bottomHeight': {} }, 'the kept sizes: none the user dragged to');
    const { launchedAt, ...facts } = r.app;
    assert.deepEqual([r.reset, facts, r.appearance], [true, { version: '26.1016.62342', buildNumber: '21477', appName: 'ChatGPT', onboarded: false }, 'dark']);
    assert.ok(launchedAt <= Date.now() && launchedAt > Date.now() - 3_600_000, 'when this process started');
    // A change of a setting (the app's own, or ours) reports that setting only; the appearance and the onboarding when they change.
    await t.app.settings.write('appearanceTheme', 'light');
    await until(() => t.reports().length >= 2, 2000, 'the change');
    assert.deepEqual(t.reports()[1], { type: 'app-state', available: true, values: { appearanceTheme: { configured: 'light', effective: 'light' } } });
    t.setAppearance('light');
    t.app.globalState.set('local-projects', { p1: { id: 'p1' } });
    await until(() => t.reports().length >= 3, 2000, 'the facts');
    assert.deepEqual([t.reports()[2].appearance, t.reports()[2].app.onboarded], ['light', true]);
  } finally { t.dispose(); }
});

test('layouts D4: the window\'s kept sizes are settings of their own: the app\'s persisted atoms, reported when they change, written the app\'s way (its handler, else the store and every window told), unset by taking the key away', async () => {
  const views = [];
  const t = setup(fakeApp(), { toView: (id, m) => views.push([id, m]) });
  const atoms = () => t.app.globalState.get('electron-persisted-atom-state');
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    // the user drags the sidebar's divider: the app writes its atom, the setting is theirs
    t.app.globalState.set('electron-persisted-atom-state', { ...atoms(), 'sidebar-width': 420 });
    await until(() => t.reports().length >= 2, 2000, 'the drag');
    assert.deepEqual(t.reports()[1].values, { 'layout.sidebarWidth': { configured: 420 } });
    // a write without the app's handler: the store, then every window told
    await t.st.run({ type: 'app-state-op', requestId: 'w1', op: 'write-setting', key: 'layout.bottomHeight', value: 300 });
    assert.deepEqual([t.answers().at(-1).ok, atoms()['app-shell:bottom-panel-height']], [true, 300]);
    assert.deepEqual(views.at(-1), [1, { type: 'persisted-atom-updated', key: 'app-shell:bottom-panel-height', value: 300, deleted: false }]);
    assert.deepEqual(t.reports().at(-1).values['layout.bottomHeight'], { configured: 300 });
    await t.st.run({ type: 'app-state-op', requestId: 'u1', op: 'unset-setting', key: 'layout.bottomHeight' });
    assert.equal('app-shell:bottom-panel-height' in atoms(), false, 'the key taken away: the app\'s built-in height holds');
    assert.deepEqual(views.at(-1)[1], { type: 'persisted-atom-updated', key: 'app-shell:bottom-panel-height', value: null, deleted: true });
    for (const [key, value] of [['layout.sidebarWidth', 600], ['layout.panelShare', 1.2], ['layout.sidebarWidth', '300']]) {
      await t.st.run({ type: 'app-state-op', requestId: `x${t.sent.length}`, op: 'write-setting', key, value });
      assert.equal(t.answers().at(-1).refused, true, `${key} ${value}`);
    }
    assert.equal(atoms()['sidebar-width'], 420, 'nothing written');
    // the app's own ratio may be either end (a drag to the panel's minimum or maximum): a value a restore must be able to write back
    for (const value of [0, 1]) {
      await t.st.run({ type: 'app-state-op', requestId: `e${value}`, op: 'write-setting', key: 'layout.panelShare', value });
      assert.deepEqual([t.answers().at(-1).ok, atoms()['app-shell:right-panel-width:v3']], [true, value]);
    }
  } finally { t.dispose(); }
  // the app's own handler where a window has it (it tells every window itself)
  const app = fakeApp();
  const handled = [];
  const services = { ...app.services, browserHost: { messageHandler: { async updatePersistedAtomState(_s, key, value) { handled.push([key, value]); app.globalState.set('electron-persisted-atom-state', { ...app.globalState.get('electron-persisted-atom-state'), [key]: value }); } } } };
  const u = setup(app, { toView: (id, m) => views.push([id, m]) });
  try {
    u.open(1, services);
    await until(() => u.reports().length >= 1);
    const told = views.length;
    await u.st.run({ type: 'app-state-op', requestId: 'w2', op: 'write-setting', key: 'layout.panelShare', value: 0.4 });
    assert.deepEqual([u.answers().at(-1).ok, handled, views.length], [true, [['app-shell:right-panel-width:v3', 0.4]], told]);
    assert.deepEqual(u.reports().at(-1).values['layout.panelShare'], { configured: 0.4 });
  } finally { u.dispose(); }
});

test('write-setting: through the app\'s settings store, answered after the report; unknown keys and invalid values are refused', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    await t.st.run({ type: 'app-state-op', requestId: 'r1', op: 'write-setting', key: 'appearanceTheme', value: 'system' });
    assert.deepEqual(t.app.calls.filter((c) => c[0] === 'write'), [['write', 'appearanceTheme', 'system']]);
    const i = t.sent.findIndex((m) => m.type === 'app-state-op-done');
    assert.equal(t.sent[i - 1].values.appearanceTheme.effective, 'system', 'the report of the change comes first');
    assert.deepEqual(t.sent[i], { type: 'app-state-op-done', requestId: 'r1', ok: true });
    for (const [m, why] of [[{ key: 'nope', value: 1 }, 'no such setting'], [{ key: 'appearanceTheme' }, 'a value is needed']]) {
      await t.st.run({ type: 'app-state-op', requestId: `x${t.sent.length}`, op: 'write-setting', ...m });
      assert.deepEqual([t.answers().at(-1).refused, t.answers().at(-1).error.includes(why)], [true, true], why);
    }
    await t.st.run({ type: 'app-state-op', requestId: 'r9', op: 'write-setting', key: 'appearanceTheme', value: 'purple' });
    assert.deepEqual([t.answers().at(-1).ok, t.answers().at(-1).error], [false, 'Invalid enum value']);
    await t.st.run({ type: 'app-state-op', requestId: 'r10', op: 'nope' });
    assert.equal(t.answers().at(-1).refused, true);
  } finally { t.dispose(); }
});

test('H7y: unset-setting: no value, as the user never set it, through the store\'s own pending writes (a null its save turns into the key\'s removal): in order with every save, a write after it the newest; its effects get the value in effect', async () => {
  const app = fakeApp();
  const disk = new Map([['git-commit-instructions', 'Be brief.']]), effects = [];
  app.configured.set('git-commit-instructions', 'Be brief.');
  // the app's store under the service, as 21477 and 20770 have it: a save takes the pending writes as they are when it runs
  const store = { state: new Map(app.configured), desktopConfig: Object.fromEntries(app.configured), pendingWrites: new Map(), persistQueued: Promise.resolve(),
    persistPendingSettings() {
      this.persistQueued = this.persistQueued.then(async () => {
        const r = new Map(this.pendingWrites);
        for (const [k, v] of r) { if (v === null) disk.delete(k); else disk.set(k, v); }
        for (const [k, v] of r) if (this.pendingWrites.get(k) === v) this.pendingWrites.delete(k);
      });
      return this.persistQueued;
    },
    flush() { return this.persistQueued.then(() => this.persistPendingSettings()); },
    set(k, v) { this.state.set(k, v); this.pendingWrites.set(k, v); this.persistPendingSettings(); },
    get(k) { return this.state.get(k); },
    getEffective(k) { return this.state.get(k) ?? 'a mod\'s default'; },
    notifyChangeListeners(k) { app.configured.delete(k); } };
  app.settings.store = store;
  app.settings.afterWrite = (k, v) => effects.push([k, v]);
  const t = setup(app);
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    // an earlier save is queued; the unset; the user writes it again before that save runs
    let go;
    store.persistQueued = new Promise((r) => { go = r; });
    const run = t.st.run({ type: 'app-state-op', requestId: 'u1', op: 'unset-setting', key: 'git-commit-instructions' });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([store.state.has('git-commit-instructions'), 'git-commit-instructions' in store.desktopConfig, effects], [false, false, [['git-commit-instructions', 'a mod\'s default']]], 'forgotten at once; its effects get the value in effect');
    store.set('git-commit-instructions', 'Newer.');
    go();
    await run;
    assert.deepEqual([store.state.get('git-commit-instructions'), disk.get('git-commit-instructions')], ['Newer.', 'Newer.'], 'the write after it is the one saved');
    // one with no value: its removal saved again
    store.state.delete('git-commit-instructions');
    await t.st.run({ type: 'app-state-op', requestId: 'u2', op: 'unset-setting', key: 'git-commit-instructions' });
    assert.deepEqual([t.answers().at(-1).ok, disk.has('git-commit-instructions')], [true, false]);
    assert.equal(t.app.calls.filter((c) => c[0] === 'write').length, 0, 'not the service\'s write');
    // a save that fails: the operation fails (not a refusal: it may have changed what the app holds)
    store.persistPendingSettings = function persistPendingSettings() { return this.persistQueued; };
    await t.st.run({ type: 'app-state-op', requestId: 'u3', op: 'unset-setting', key: 'git-commit-instructions' });
    assert.deepEqual([t.answers().at(-1).ok, t.answers().at(-1).refused ?? false], [false, false]);
    // a store the framework cannot reach: refused, the app keeps its value
    delete app.settings.store.pendingWrites;
    await t.st.run({ type: 'app-state-op', requestId: 'u4', op: 'unset-setting', key: 'appearanceTheme' });
    assert.deepEqual([t.answers().at(-1).refused, /keeps a value/.test(t.answers().at(-1).error)], [true, true]);
    await t.st.run({ type: 'app-state-op', requestId: 'u5', op: 'unset-setting', key: 'nope' });
    assert.match(t.answers().at(-1).error, /no such setting/);
  } finally { t.dispose(); }
});

test('H7y: write-setting is answered once the app has saved it; one it keeps pending (its save failed) is not done', async () => {
  const app = fakeApp();
  let failing = false;
  const store = { state: new Map(), pendingWrites: new Map(), persistQueued: Promise.resolve(), persistPendingSettings: async () => {},
    async flush() { if (!failing) this.pendingWrites.clear(); }, get(k) { return this.state.get(k); }, getEffective(k) { return this.state.get(k); }, notifyChangeListeners() {} };
  app.settings.store = store;
  const own = Object.getPrototypeOf(app.settings).write;
  Object.getPrototypeOf(app.settings).write = async function write(key, value) { store.pendingWrites.set(key, value); return own.call(this, key, value); };
  const t = setup(app);
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    await t.st.run({ type: 'app-state-op', requestId: 'w1', op: 'write-setting', key: 'appearanceTheme', value: 'light' });
    assert.equal(t.answers().at(-1).ok, true);
    failing = true;
    await t.st.run({ type: 'app-state-op', requestId: 'w2', op: 'write-setting', key: 'appearanceTheme', value: 'dark' });
    assert.deepEqual([t.answers().at(-1).ok, /could not save/.test(t.answers().at(-1).error)], [false, true]);
  } finally { Object.getPrototypeOf(app.settings).write = own; t.dispose(); }
});

test('without a window or its settings service: unavailable, operations refused; the window closes: unavailable again', async () => {
  const t = setup();
  try {
    t.open(1, { appInfo: t.app.services.appInfo });
    await sleep(30);
    assert.equal(t.reports().length, 0, 'a window without the service is not held');
    t.st.resend();
    await until(() => t.reports().length >= 1);
    assert.deepEqual(t.reports().at(-1), { type: 'app-state', available: false });
    await t.st.run({ type: 'app-state-op', requestId: 'r1', op: 'write-setting', key: 'appearanceTheme', value: 'dark' });
    assert.equal(t.answers().at(-1).refused, true);
    t.open(2);
    await until(() => t.reports().some((m) => m.available && m.reset));
    t.close(2);
    await until(() => t.reports().at(-1).available === false, 2000, 'unavailable');
  } finally { t.dispose(); }
});

test('account, navigate, open-help, quit, open-login: the app\'s way, only allowed fields and pages; a quit is reported at once', async () => {
  const app = fakeApp();
  const calls = [];
  const accountInfo = {
    async readAccountInfo() { return { status: 'ready', data: { accountId: 'acct-1', userId: 'user-1', authenticatedUserId: 'u', plan: 'pro', email: 'q@example.com', computeResidency: 'us', hasChatGptToken: true } }; },
    async readAccounts(lang) { calls.push(['readAccounts', lang]); return { accounts: [{ id: 'acct-1', name: 'QA Team', structure: 'workspace', account_user_role: 'standard-user', profile_picture_url: 'https://x/p.png' }] }; },
    async readLocalChatGptAuth() { throw new Error('not to be called'); },
  };
  let quitFn = null;
  const t = setup(app, {
    toView: (id, msg) => calls.push(['toView', id, msg]), openExternal: async (url) => calls.push(['openExternal', url]), quitApp: () => calls.push(['quit']),
    clickAppMenuItem: (menuId, id) => { calls.push(['clickAppMenuItem', menuId, id]); return menuId === 'help-menu' ? 'Documentation' : null; },
    onBeforeQuit: (fn) => { quitFn = fn; return () => { quitFn = null; }; },
  });
  try {
    t.open(1, { ...app.services, accountInfo });
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.st.run({ type: 'app-state-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    assert.deepEqual((await ask({ op: 'account' })).result, { signedIn: true, accountId: 'acct-1', userId: 'user-1', plan: 'pro', workspace: { name: 'QA Team', structure: 'workspace', role: 'standard-user' } }, 'no email, picture or token');
    assert.equal((await ask({ op: 'navigate', path: '/settings/account' })).ok, true);
    assert.equal((await ask({ op: 'navigate', path: '/settings/../x' })).refused, true);
    assert.deepEqual((await ask({ op: 'open-help' })).result, { label: 'Documentation' });
    assert.equal((await ask({ op: 'open-login', path: 'https://auth.openai.com/oauth/authorize?x=1' })).ok, true);
    for (const bad of ['http://auth.openai.com/x', 'https://evil.example/openai.com', 'https://openai.com.evil.example/']) assert.equal((await ask({ op: 'open-login', path: bad })).refused, true, bad);
    assert.equal((await ask({ op: 'quit' })).ok, true);
    assert.deepEqual(calls.filter(([c]) => c !== 'readAccounts'), [
      ['toView', 1, { type: 'navigate-to-route', path: '/settings/account' }], ['clickAppMenuItem', 'help-menu', 1], ['openExternal', 'https://auth.openai.com/oauth/authorize?x=1'], ['quit'],
    ]);
    quitFn();
    assert.deepEqual(t.sent.at(-1), { type: 'app-state', available: true, quitting: true });
  } finally { t.dispose(); }
});

test('public hooks H6 (§3.5): the user\'s own setting change is held first (the Host answers): refused, it throws and nothing is written; allowed, it is; this module\'s own writes are not held again; put back at dispose', async () => {
  const t = setup();
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    const settings = t.app.services.settings;
    const holds = () => t.sent.filter((m) => m.type === 'user-hold');
    // nothing holds Setting.set: the app's own write, at once
    const w0 = settings.write('appearanceTheme', 'dark');
    assert.equal(holds().length, 0);
    await w0;
    t.st.holds.set({ held: ['Setting.set'], observed: [] });
    // the page writes (the app's settings bridge): held; the Host refuses
    const w1 = settings.write('appearanceTheme', 'light');
    await until(() => holds().length === 1, 2000, 'the hold');
    assert.deepEqual(holds()[0].ref, { type: 'Setting', provider: 'codex', id: 'appearanceTheme' });
    assert.deepEqual([holds()[0].operation, holds()[0].args, holds()[0].changes], ['set', ['light'], false], 'a change of the value cannot be shown on the page: the Host refuses one');
    t.st.holds.answer({ type: 'user-hold-answer', requestId: holds()[0].requestId, go: false, message: 'Theme is fixed (“House theme”, a policy of qa.team)' });
    await assert.rejects(w1, /Not changed: Theme is fixed/);
    assert.deepEqual(t.app.calls.filter((c) => c[0] === 'write'), [['write', 'appearanceTheme', 'dark']], 'nothing written');
    // allowed: written
    const w2 = settings.write('appearanceTheme', 'light');
    await until(() => holds().length === 2, 2000, 'the second hold');
    t.st.holds.answer({ type: 'user-hold-answer', requestId: holds()[1].requestId, go: true });
    await w2;
    assert.deepEqual(t.app.calls.filter((c) => c[0] === 'write'), [['write', 'appearanceTheme', 'dark'], ['write', 'appearanceTheme', 'light']]);
    await until(() => t.sent.some((m) => m.type === 'user-hold-done'), 2000, 'the report of what it did');
    assert.deepEqual(t.sent.find((m) => m.type === 'user-hold-done'), { type: 'user-hold-done', requestId: holds()[1].requestId, outcome: { status: 'done' } });
    // a mod set it in the app's place: not written again, no error
    const w3 = settings.write('appearanceTheme', 'system');
    await until(() => holds().length === 3, 2000, 'the third hold');
    t.st.holds.answer({ type: 'user-hold-answer', requestId: holds()[2].requestId, go: false, handled: true });
    assert.equal(await w3, undefined);
    assert.equal(t.app.calls.filter((c) => c[0] === 'write').length, 2);
    // the graph's own Setting.set (through this module): its call passed the policies already, so it is not held again
    await t.st.run({ type: 'app-state-op', requestId: 'r1', op: 'write-setting', key: 'appearanceTheme', value: 'system' });
    assert.equal(holds().length, 3);
    assert.deepEqual(t.answers().at(-1), { type: 'app-state-op-done', requestId: 'r1', ok: true });
    t.st.holds.answer({ type: 'user-hold-answer', requestId: 'nobody', go: false });   // an answer to nothing: ignored
  } finally { t.dispose(); }
  // disposed: the service's write as it was (held on its class: the app's port calls only those)
  const app = fakeApp();
  const u = setup(app);
  const proto = Object.getPrototypeOf(app.services.settings);
  const original = proto.write;
  u.open(1);
  await until(() => u.reports().length >= 1);
  assert.notEqual(proto.write, original);
  assert.equal(Object.hasOwn(app.services.settings, 'write'), false, 'never an override on the instance');
  u.dispose();
  assert.equal(proto.write, original);
});

test('H6i (§3.8): the mods\' defaults are the settings store\'s value where the user set none, applied the app\'s way; the user\'s value wins; gone when taken back', async () => {
  const app = fakeApp();
  // the app's settings store (21477 `Oi`): its own value, else the definition's default; the service reads through it
  const effects = [], notified = [];
  class Store {
    get(key) { return app.configured.get(key); }
    getEffective(key) { return this.get(key) ?? DEFS.find((d) => d.key === key)?.default; }
    notifyChangeListeners(key) { notified.push(key); }
  }
  const store = new Store();
  const proto = Object.getPrototypeOf(app.settings);
  proto.read = async function read(key) { return { configured: store.get(key), effective: store.getEffective(key) }; };
  app.settings.store = store;
  app.settings.afterWrite = (key, value) => { effects.push([key, value]); };
  app.configured.delete('appearanceTheme');
  const t = setup(app);
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.st.run({ type: 'app-state-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    const a = await ask({ op: 'setting-defaults', defaults: { appearanceTheme: 'dark', unknownKey: 1 } });
    assert.deepEqual(a.result, { applied: ['appearanceTheme'], moved: ['appearanceTheme'] });
    assert.equal(store.getEffective('appearanceTheme'), 'dark');
    assert.deepEqual([effects, notified], [[['appearanceTheme', 'dark']], ['appearanceTheme']], 'applied as after a write, and every window reads it again');
    assert.deepEqual(t.reports().at(-1).values.appearanceTheme, { effective: 'dark' });
    // the user's own value wins; the default stays the default
    app.configured.set('appearanceTheme', 'light');
    assert.equal(store.getEffective('appearanceTheme'), 'light');
    app.configured.delete('appearanceTheme');
    // the same defaults again: nothing moves; taken back: the app's own default again
    assert.deepEqual((await ask({ op: 'setting-defaults', defaults: { appearanceTheme: 'dark' } })).result.moved, []);
    assert.deepEqual((await ask({ op: 'setting-defaults', defaults: {} })).result.moved, ['appearanceTheme']);
    assert.equal(store.getEffective('appearanceTheme'), 'system');
    assert.equal((await ask({ op: 'setting-defaults', defaults: 'x' })).refused, true);
  } finally { t.dispose(); }
});

test('H6i review round 2: a value the user set (null too) is theirs; a key the service answers past its store takes the default there; kept with no window open, gone with the Host', async () => {
  const app = fakeApp();
  const defs = [...DEFS, { key: 'autoArchiveAfterDays', agentAccess: 'read-write', default: null, description: 'Auto-archive.', schema: { type: ['number', 'null'] } }];
  class Store {
    get(key) { return app.configured.get(key); }
    getEffective(key) { return this.get(key) ?? defs.find((d) => d.key === key)?.default; }
    notifyChangeListeners() {}
  }
  const store = new Store();
  const proto = Object.getPrototypeOf(app.settings);
  proto.readForAgent = async function readForAgent() { return { filePath: '/h/config.toml', settings: {}, effectiveSettings: {}, definitions: defs }; };
  // 21477's service: auto-archive is what the user set, else Statsig's (here 30), past the store's own effective value
  proto.getEffective = async function getEffective(key) { if (key === 'autoArchiveAfterDays') { const v = this.store.get(key); return v !== undefined ? v : 30; } return this.store.getEffective(key); };
  proto.read = async function read(key) { return { configured: store.get(key), effective: await this.getEffective(key) }; };
  app.settings.store = store;
  app.settings.afterWrite = () => {};
  app.configured.set('appearanceTheme', null);   // the user's own choice
  const t = setup(app);
  try {
    t.open(1);
    await until(() => t.reports().length >= 1);
    const ask = async (m) => { await t.st.run({ type: 'app-state-op', requestId: `r${t.sent.length}`, ...m }); return t.answers().at(-1); };
    await ask({ op: 'setting-defaults', defaults: { appearanceTheme: 'dark', autoArchiveAfterDays: 0 } });
    assert.equal(store.getEffective('appearanceTheme'), 'system', 'the user\'s null is theirs: the app\'s own way');
    assert.equal(await app.settings.getEffective('autoArchiveAfterDays'), 0, 'the service\'s own answer (its archival worker\'s too) takes it');
    app.configured.set('autoArchiveAfterDays', 5);
    assert.equal(await app.settings.getEffective('autoArchiveAfterDays'), 5, 'the user\'s value wins');
    app.configured.delete('autoArchiveAfterDays');
    app.configured.delete('appearanceTheme');
    assert.equal(store.getEffective('appearanceTheme'), 'dark');
    // no window open: given and taken back all the same
    t.close(1);
    await until(() => t.reports().at(-1).available === false, 2000, 'unavailable');
    assert.equal((await ask({ op: 'setting-defaults', defaults: { appearanceTheme: 'light' } })).ok, true);
    assert.equal(store.getEffective('appearanceTheme'), 'light');
    // the Host goes: its mods' defaults with it
    t.st.hostGone();
    assert.equal(store.getEffective('appearanceTheme'), 'system');
    assert.equal(await app.settings.getEffective('autoArchiveAfterDays'), 30);
  } finally { t.dispose(); }
});
