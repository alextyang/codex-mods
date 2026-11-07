// App, Theme, Setting and SettingsSection in the native provider (breadth step D4; app-state.mjs): the app's registry settings with their
// kinds, choices, titles and sections, `changed`, writes the app's way (a mod's write of a setting the app's own agent may only read asks
// the user first, R17), reset, the Theme from the settings and a window's theme report, and the App. The graph runtime with the feed and
// the Host's app-state store; the test plays framework-main's reports and answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../../index.mjs';
import { refs } from '../map.mjs';
import { createAppState } from '../../../app-state.mjs';
import { kindOf, choicesOf, settingData, fits, appStateTypes, createAppStateFeed } from '../app-state.mjs';
import { createBus } from '../../../../runtime/bus.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const DEFS = [
  { key: 'appearanceTheme', agentAccess: 'read-write', default: 'system', description: 'The app theme.', schema: { type: 'string', enum: ['system', 'light', 'dark'] } },
  { key: 'sansFontSize', agentAccess: 'read-write', default: 14, description: 'UI font size.', schema: { type: 'number', minimum: 11, maximum: 16 } },
  { key: 'git-commit-instructions', agentAccess: 'read-only', default: '', description: 'Commit instructions.', schema: { type: 'string' } },
  { key: 'appearanceDarkChromeTheme', agentAccess: 'read-write', description: 'Dark theme.', schema: { type: 'object', properties: {} } },
  { key: 'some-new-key', agentAccess: 'read-write', default: false, description: 'New.', schema: { type: 'boolean' } },
];

test('kinds and choices from the setting\'s JSON Schema; title and section from the catalog, else the key and `other`', () => {
  assert.deepEqual([{ type: 'boolean' }, { type: 'integer' }, { type: ['string', 'null'] }, { type: 'array', items: {} }, { type: 'object' }, { anyOf: [{ type: 'string', enum: ['a'] }, { type: 'object' }] }].map(kindOf),
    ['toggle', 'number', 'text', 'list', 'record', 'choice']);
  assert.deepEqual(choicesOf({ anyOf: [{ type: 'string', enum: ['keyboardOnly', 'never'] }, { const: 'always' }] }), [{ id: 'keyboardOnly', label: 'Keyboard only' }, { id: 'never', label: 'Never' }, { id: 'always', label: 'Always' }]);
  const theme = settingData(DEFS[0], { configured: 'dark', effective: 'dark' });
  assert.deepEqual([theme.state.title, theme.state.kind, theme.state.value, theme.state.default, theme.state.scope, theme.links.section], ['Theme', 'choice', 'dark', 'system', 'app', refs.settingsSection('appearance')]);
  const other = settingData(DEFS[4], null);
  assert.deepEqual([other.state.title, other.state.value, other.links.section.id], ['Some new key', false, 'other']);
  assert.deepEqual(settingData(DEFS[3], null).state.value, null, 'no value and no default: null');
});

const front = { id: 7 };
const opened = [];
function setup() {
  const prompts = [];
  const graph = createGraph({ log: quiet, approvals: { ask: async (q) => { prompts.push(q.action); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  let feed = null;
  const handle = graph.registerProvider('native', 'codex', { types: appStateTypes({
    prompt: (...a) => feed.prompt(...a), write: (...a) => feed.write(...a), reset: (...a) => feed.reset(...a), setTheme: (...a) => feed.setTheme(...a),
    openHelp: () => feed.openHelp(), quit: () => feed.quit(), feedbackPrompt: (...a) => feed.feedbackPrompt(...a), sendFeedback: (...a) => feed.sendFeedback(...a),
    frontWindow: async () => front.id,
    openWindow: async (target, call) => { opened.push([target ?? null, call.caller.id]); return { status: 'done', value: { type: 'Window', provider: 'codexmods.windows', id: '8' } }; },
  }) });
  const writes = [], told = [];
  let store = null;
  store = createAppState({ log: quiet, timeoutMs: 2000, send: (m) => queueMicrotask(() => {
    if (m.op === 'setting-defaults') { told.push(m.defaults); return store.settle({ type: 'app-state-op-done', requestId: m.requestId, ok: true }); }
    writes.push([m.op, m.key, m.value]);
    if (m.op === 'write-setting' && m.key === 'appearanceTheme' && !['system', 'light', 'dark'].includes(m.value)) return store.settle({ type: 'app-state-op-done', requestId: m.requestId, ok: false, refused: true, error: 'Invalid enum value' });
    if (m.op === 'write-setting') store.apply({ type: 'app-state', available: true, values: { [m.key]: { configured: m.value, effective: m.value } } });
    store.settle({ type: 'app-state-op-done', requestId: m.requestId, ok: true });
  }) });
  const bus = createBus({ log: quiet });
  const events = [];
  graph.onEvent((e) => { if (e.kind === 'event') events.push([e.ref.type, e.name, e.ref.id]); });
  const resident = (r) => { const x = graph.resolve(r); return x && !x.gone ? x : null; };
  const rpcs = [];
  feed = createAppStateFeed({ handle, graph, appState: store, bus, resident, safe: (w, fn) => fn(), emitEvent: (r, name) => handle.emit(r, name), log: quiet,
    rpc: async (method, params) => { rpcs.push([method, params]); return {}; } });
  store.apply({ type: 'app-state', available: true, reset: true, definitions: DEFS,
    values: { appearanceTheme: { configured: 'dark', effective: 'dark' }, sansFontSize: { effective: 14 }, 'git-commit-instructions': { effective: '' } },
    app: { version: '26.1016.62342', buildNumber: '21477', appName: 'ChatGPT', onboarded: true, launchedAt: Date.now() - 2000 }, appearance: 'dark' });
  return { graph, store, feed, bus, writes, told, rpcs, events, prompts, close() { feed.dispose(); store.dispose(); graph.close(); } };
}
const mod = { kind: 'mod', id: 'mod.a' };

test('settings and their sections are put from a reset, quietly; a change says changed', async () => {
  const s = setup();
  try {
    assert.deepEqual(s.graph.list('Setting').map((x) => x.ref.id).sort(), ['appearanceDarkChromeTheme', 'appearanceTheme', 'git-commit-instructions', 'sansFontSize', 'some-new-key']);
    assert.deepEqual(s.graph.list('SettingsSection').map((x) => [x.ref.id, x.state.title]).sort(), [['appearance', 'Appearance'], ['git-settings', 'Git'], ['other', 'Other']]);
    assert.deepEqual(s.graph.referrers(refs.settingsSection('appearance'), 'section').map((x) => x.ref.id).sort(), ['appearanceDarkChromeTheme', 'appearanceTheme', 'sansFontSize'], 'SettingsSection.settings');
    assert.equal(s.events.filter(([t]) => t !== 'App').length, 0, 'a reset is a sync (the App says launched)');
    s.store.apply({ type: 'app-state', available: true, values: { sansFontSize: { configured: 15, effective: 15 } } });
    assert.deepEqual([s.graph.resolve(refs.setting('sansFontSize')).state.value, s.events.filter(([t]) => t === 'Setting')], [15, [['Setting', 'changed', 'sansFontSize']]]);
  } finally { s.close(); }
});

test('set and reset write the app\'s way; a mod\'s write of a setting the app\'s agent may only read asks the user first', async () => {
  const s = setup();
  try {
    assert.equal((await s.graph.invoke({ ref: refs.setting('appearanceTheme'), operation: 'set', args: ['light'], caller: mod })).status, 'done');
    assert.deepEqual([s.writes.at(-1), s.prompts], [['write-setting', 'appearanceTheme', 'light'], []], 'the app lets its agent write it: no prompt');
    assert.equal((await s.graph.invoke({ ref: refs.setting('git-commit-instructions'), operation: 'set', args: ['Use the imperative.'], caller: mod })).status, 'done');
    assert.deepEqual(s.prompts, ['change the setting “Commit instructions”']);
    const bad = await s.graph.invoke({ ref: refs.setting('appearanceTheme'), operation: 'set', args: ['purple'], caller: mod });
    assert.deepEqual([bad.status, bad.reason, bad.message], ['refused', 'invalid', 'Invalid enum value']);
    // reset takes the user's value away (its default holds then), never writes the default as theirs (H7y review)
    assert.equal((await s.graph.invoke({ ref: refs.setting('appearanceTheme'), operation: 'reset', args: [], caller: mod })).status, 'done');
    assert.deepEqual(s.writes.at(-1), ['unset-setting', 'appearanceTheme', undefined]);
    assert.equal((await s.graph.invoke({ ref: refs.setting('appearanceDarkChromeTheme'), operation: 'reset', args: [], caller: mod })).status, 'done');
    assert.deepEqual(s.writes.at(-1), ['unset-setting', 'appearanceDarkChromeTheme', undefined], 'no default: back to no value (the app\'s built-in one)');
  } finally { s.close(); }
});

test('the Theme from the settings and a window\'s theme report; set(mode | size); the App with its links; window events', async () => {
  const s = setup();
  try {
    s.bus.publish('window/shown', { windowId: 4 });
    s.bus.publish('framework/theme', { windowId: 3, tokens: { accent: '#000', text: '#fff' }, appearance: 'dark' });   // a hidden window's own look
    s.bus.publish('framework/theme', { windowId: 4, tokens: { accent: '#3a83f7', fontFamily: '-apple-system', codeFontFamily: 'ui-monospace', text: '#1a1c1f' }, appearance: 'dark' });
    s.bus.publish('framework/theme', { windowId: 3, tokens: { accent: '#111', text: '#eee' }, appearance: 'dark' });
    await until(() => s.graph.resolve(refs.theme())?.state.accent === '#3a83f7', 2000, 'the shown window\'s theme');
    await new Promise((r) => setTimeout(r, 20));   // the hidden window's later report too
    const t = s.graph.resolve(refs.theme());
    assert.deepEqual(t.state, { mode: 'dark', appearance: 'dark', accent: '#3a83f7', fonts: { ui: '-apple-system', code: 'ui-monospace', size: 14 }, tokens: { accent: '#3a83f7', fontFamily: '-apple-system', codeFontFamily: 'ui-monospace', text: '#1a1c1f' } });
    const app = s.graph.resolve(refs.app());
    assert.deepEqual([app.state, app.links.theme, app.links.agents, app.links.settings.length], [{ version: '26.1016.62342', onboarded: true }, refs.theme(), [refs.agent()], 5]);
    assert.equal((await s.graph.invoke({ ref: refs.theme(), operation: 'set', args: ['mode', 'light'], caller: mod })).status, 'done');
    assert.deepEqual([s.writes.at(-1), s.graph.resolve(refs.theme()).state.mode], [['write-setting', 'appearanceTheme', 'light'], 'light']);
    assert.ok(s.events.some(([type, name]) => type === 'Theme' && name === 'changed'));
    assert.equal((await s.graph.invoke({ ref: refs.theme(), operation: 'set', args: ['size', 15], caller: mod })).status, 'done');
    assert.deepEqual(s.writes.at(-1), ['write-setting', 'sansFontSize', 15]);
    for (const [f, v, reason] of [['density', 'compact', 'unsupported'], ['mode', 'sepia', 'invalid']]) assert.equal((await s.graph.invoke({ ref: refs.theme(), operation: 'set', args: [f, v], caller: mod })).reason, reason, f);
    s.bus.publish('window/created', { windowId: 3 });   // a hidden window (the hotkey window): not one the user sees
    s.bus.publish('window/closed', { windowId: 3 });
    s.bus.publish('window/created', { windowId: 2 });
    s.bus.publish('window/shown', { windowId: 2 });
    s.bus.publish('window/shown', { windowId: 2 });     // replayed to a restarted Host, or shown again
    s.bus.publish('window/closed', { windowId: 2 });
    await until(() => s.events.filter(([type]) => type === 'App').length >= 4, 2000, 'the window events');
    assert.deepEqual(s.events.filter(([type]) => type === 'App').map(([, name]) => name), ['launched', 'windowOpened', 'windowOpened', 'windowClosed'],
      'launched: the App came within minutes of the app\'s start; windows 4 and 2 opened, 2 closed, the hidden 3 neither');
    s.store.apply({ type: 'app-state', available: true, quitting: true });
    assert.equal(s.events.at(-1)[1], 'quitting');
  } finally { s.close(); }
});

test('App: openHelp the app\'s way; quit and sendFeedback ask the user first; feedback is sent as text without logs', async () => {
  const s = setup();
  try {
    await until(() => s.graph.resolve(refs.app()), 2000, 'the app');
    assert.equal((await s.graph.invoke({ ref: refs.app(), operation: 'openHelp', args: [], caller: mod })).status, 'done');
    assert.equal((await s.graph.invoke({ ref: refs.app(), operation: 'quit', args: [], caller: mod })).status, 'done');
    assert.deepEqual(s.writes.slice(-2).map(([op]) => op), ['open-help', 'quit']);
    const text = { parts: [{ kind: 'text', text: 'The sidebar is slow.' }] };
    assert.equal((await s.graph.invoke({ ref: refs.app(), operation: 'sendFeedback', args: [text], caller: mod })).status, 'done');
    assert.deepEqual(s.prompts, ['quit Codex', 'send feedback about Codex to OpenAI']);
    assert.deepEqual(s.rpcs, [['feedback/upload', { classification: 'other', reason: 'The sidebar is slow.', includeLogs: false, tags: { source: 'codexmods' } }]]);
    assert.equal((await s.graph.invoke({ ref: refs.app(), operation: 'sendFeedback', args: [{ parts: [] }], caller: mod })).reason, 'invalid');
  } finally { s.close(); }
});

test('graph-layers L3: App.frontWindow answers the Window the user is in, or null', async () => {
  const s = setup();
  try {
    await until(() => s.graph.resolve(refs.app()), 2000, 'the app');
    assert.deepEqual((await s.graph.invoke({ ref: refs.app(), operation: 'frontWindow', args: [], caller: mod })).value, { type: 'Window', provider: 'codexmods.windows', id: '7' });
    front.id = null;
    assert.equal((await s.graph.invoke({ ref: refs.app(), operation: 'frontWindow', args: [], caller: mod })).value, null);
    front.id = 7;
  } finally { await s.close?.(); }
});

test('App.openWindow: the windows provider\'s new window, with what it shows and who asked; its Window is the answer', async () => {
  const s = setup();
  try {
    await until(() => s.graph.resolve(refs.app()), 2000, 'the app');
    const thread = { type: 'CodexThread', provider: 'codex', id: 't1' };
    assert.deepEqual((await s.graph.invoke({ ref: refs.app(), operation: 'openWindow', args: [thread], caller: mod })).value, { type: 'Window', provider: 'codexmods.windows', id: '8' });
    assert.equal((await s.graph.invoke({ ref: refs.app(), operation: 'openWindow', args: [], caller: mod })).status, 'done');
    assert.deepEqual(opened, [[thread, mod.id], [null, mod.id]]);
  } finally { await s.close?.(); }
});

test('H6i (§3.8): a mod\'s default of a setting is its shown default and is given to the app; one that does not fit the schema is not; reset returns to it', async () => {
  const s = setup();
  try {
    await until(() => s.graph.resolve({ type: 'Setting', provider: 'codex', id: 'sansFontSize' }), 2000, 'the settings');
    s.graph.defaults('mod:mod.a', { id: 'size', of: 'Setting', key: 'sansFontSize', value: 16 });
    s.graph.defaults('mod:mod.b', { id: 'size', of: 'Setting', key: 'sansFontSize', value: 18 });   // after mod.a's: not taken
    s.graph.defaults('mod:mod.b', { id: 'theme', of: 'Setting', key: 'appearanceTheme', value: 'sepia' });   // not one of its choices
    await until(() => s.told.length && s.told.at(-1).sansFontSize === 16, 2000, 'told the app');
    assert.deepEqual(s.told.at(-1), { sansFontSize: 16 });
    assert.equal(s.graph.resolve({ type: 'Setting', provider: 'codex', id: 'sansFontSize' }).state.default, 16);
    assert.equal(s.graph.resolve({ type: 'Setting', provider: 'codex', id: 'appearanceTheme' }).state.default, 'system');
    // the user's reset: their value taken away, so the mod's default holds (not written as theirs: it goes when the mod's default does)
    assert.equal((await s.graph.invoke({ ref: { type: 'Setting', provider: 'codex', id: 'sansFontSize' }, operation: 'reset', args: [], caller: { kind: 'user', id: 'user' } })).status, 'done');
    assert.deepEqual(s.writes.at(-1), ['unset-setting', 'sansFontSize', undefined]);
    // taken back: the app is told none
    s.graph.disposeOwner('mod:mod.a');
    s.graph.disposeOwner('mod:mod.b');
    await until(() => JSON.stringify(s.told.at(-1)) === '{}', 2000, 'told none');
  } finally { s.close(); }
});

test('H6i review round 2: a default fits only the whole schema (an object\'s required and other fields, a pattern, exactly one branch); a keyword it cannot check takes nothing', () => {
  const chrome = { type: 'object', properties: { accent: { type: 'string', pattern: '^#[0-9a-f]{6}$' }, contrast: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['accent', 'contrast'], additionalProperties: false };
  assert.equal(fits(chrome, {}), false, 'its required fields');
  assert.equal(fits(chrome, { accent: '#00ff00', contrast: 40 }), true);
  assert.equal(fits(chrome, { accent: '#00ff00', contrast: 40, extra: 1 }), false, 'no other fields');
  assert.equal(fits(chrome, { accent: 'green', contrast: 40 }), false, 'its pattern');
  assert.equal(fits(chrome, { accent: '#00ff00', contrast: 140 }), false, 'its bounds');
  assert.equal(fits({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3), false, 'oneOf: exactly one');
  assert.equal(fits({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3.5), true);
  assert.equal(fits({ type: 'string', minLength: 2 }, 'a'), false);
  assert.equal(fits({ type: 'string', format: 'color' }, 'red'), false, 'a format it cannot check');
  assert.equal(fits({ type: 'string', unevaluatedProperties: false }, 'a'), false, 'a keyword it cannot check');
  assert.equal(fits({ $defs: { c: { type: 'string' } }, type: 'object', properties: { a: { $ref: '#/$defs/c' } } }, { a: 1 }), false, 'a $ref within it');
  assert.equal(fits({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null), true);
  assert.equal(fits({ type: 'number' }, NaN), false, 'not JSON');
  assert.equal(fits({ description: 'anything' }, { a: [1, 'b'] }), true, 'annotations only: any JSON value');
});

test('layouts D4: the window\'s kept sizes are Settings (titled, in other); the sidebar\'s width takes a mod\'s default, the panels\' sizes none (read only when a panel is made); the user\'s value wins', async () => {
  const s = setup();
  const L = (key, def, schema) => ({ key, agentAccess: 'read-only', default: def, description: key, schema });
  const ref = (id) => ({ type: 'Setting', provider: 'codex', id });
  try {
    const defs = [...DEFS, L('layout.sidebarWidth', 340, { type: 'number', minimum: 240, maximum: 520 }), L('layout.panelShare', null, { type: 'number', minimum: 0, maximum: 1 }),
      L('layout.bottomHeight', 280, { type: 'number', minimum: 160 })];
    s.store.apply({ type: 'app-state', available: true, reset: true, definitions: defs, values: { 'layout.sidebarWidth': {}, 'layout.panelShare': {}, 'layout.bottomHeight': {} } });
    await until(() => s.graph.resolve(ref('layout.bottomHeight')), 2000, 'the settings');
    assert.deepEqual(['title', 'value', 'overridden'].map((k) => s.graph.resolve(ref('layout.sidebarWidth')).state[k]), ['Sidebar width', 340, false]);
    s.graph.defaults('mod:mod.a', { id: 'w', of: 'Setting', key: 'layout.sidebarWidth', value: 400 });
    s.graph.defaults('mod:mod.a', { id: 'h', of: 'Setting', key: 'layout.bottomHeight', value: 300 });
    s.graph.defaults('mod:mod.a', { id: 'x', of: 'Setting', key: 'layout.sidebarWidth', value: 900 });
    await until(() => s.graph.resolve(ref('layout.sidebarWidth')).state.value === 400, 2000, 'the default');
    assert.equal(s.graph.resolve(ref('layout.bottomHeight')).state.value, 280, 'no default: the app reads it only when the panel is made');
    // the user dragged: their width wins
    s.store.apply({ type: 'app-state', available: true, values: { 'layout.sidebarWidth': { configured: 420 } } });
    await until(() => s.graph.resolve(ref('layout.sidebarWidth')).state.value === 420, 2000, 'the user\'s');
    assert.equal(s.graph.resolve(ref('layout.sidebarWidth')).state.overridden, true);
  } finally { s.close(); }
});

test('H6i review round 2: a setting the app reads past its store takes no default; every reset tells framework-main the defaults again', async () => {
  const s = setup();
  try {
    const defs = [...DEFS, { key: 'confirm-before-close', agentAccess: 'read-write', default: 'keyboardOnly', description: 'Close.', schema: { type: 'string', enum: ['always', 'keyboardOnly', 'never'] } }];
    s.store.apply({ type: 'app-state', available: true, reset: true, definitions: defs, values: {} });
    await until(() => s.graph.resolve({ type: 'Setting', provider: 'codex', id: 'confirm-before-close' }), 2000, 'the setting');
    s.graph.defaults('mod:mod.a', { id: 'close', of: 'Setting', key: 'confirm-before-close', value: 'never' });
    s.graph.defaults('mod:mod.a', { id: 'size', of: 'Setting', key: 'sansFontSize', value: 12 });
    await until(() => s.told.length && s.told.at(-1).sansFontSize === 12, 2000, 'told the app');
    assert.deepEqual(s.told.at(-1), { sansFontSize: 12 });
    assert.equal(s.graph.resolve({ type: 'Setting', provider: 'codex', id: 'confirm-before-close' }).state.default, 'keyboardOnly');
    // framework-main read everything anew (a window again, or it started again): told again, though nothing changed
    const n = s.told.length;
    s.store.apply({ type: 'app-state', available: true, reset: true, definitions: defs, values: {} });
    await until(() => s.told.length > n, 2000, 'told again');
    assert.deepEqual(s.told.at(-1), { sansFontSize: 12 });
  } finally { s.close(); }
});
