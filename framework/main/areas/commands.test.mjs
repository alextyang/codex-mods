// The commands area in framework-main: shaped exports in require.cache and fake AppHost services. No app, home or network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function freshRegister() {
  delete require.cache[require.resolve('./commands.cjs')];
  return require('./commands.cjs').register;
}

function setup(services = {}, register = freshRegister(), electron = { postToWindow() {} }) {
  let run;
  register({
    appHost: { first: () => services === null ? null : { id: 7, host: { services } } },
    electron,
    onAreaOp(area, fn) { assert.equal(area, 'commands'); run = fn; },
  });
  return run;
}

function cached(t, file, exports) {
  const before = require.cache[file];
  require.cache[file] = { filename: file, exports };
  t.after(() => { if (before) require.cache[file] = before; else delete require.cache[file]; });
}

const table = () => Array.from({ length: 50 }, (_, i) => ({ id: `command${i}`, titleIntlId: `title${i}` }));
const isRefusal = (message) => (e) => e.refused === true && (message === undefined || e.message === message);

test('catalog finds the first matching export only inside .vite/build, skips throwing getters and caches its public fields', async (t) => {
  cached(t, '/fake/outside/commands.js', { table: table() });
  const entries = table();
  entries[0] = { ...entries[0], electron: {
    menuTitle: 'Toggle files', defaultKeybindings: [{ key: 'Fallback' }],
    platformDefaultKeybindings: { [process.platform]: [{ key: 'Primary' }, { key: 'Secondary' }, {}, { key: 1 }, null] },
    private: 'hidden',
  }, kind: 'webview', commandMenuGroupKey: 'panels', commandMenu: true, shortcutConfigurable: false, private: 'hidden' };
  entries[1] = { ...entries[1], availableIn: ['electron'], electron: { menuTitle: '', defaultKeybindings: [{ key: 'Fallback' }, { key: null }] }, commandMenu: 'true' };
  entries[2] = { ...entries[2], kind: 'vscode-only', availableIn: ['electron'], commandMenuGroupKey: 1, electron: { menuTitle: 1, platformDefaultKeybindings: { [process.platform]: [] }, defaultKeybindings: [{ key: 'Ignored' }] } };
  entries[3] = { ...entries[3], kind: 'electron-only', availableIn: ['electron', 'vscode'], electron: { platformDefaultKeybindings: { [process.platform]: 'bad' }, defaultKeybindings: [{ key: 'Default' }] } };
  entries[4] = { ...entries[4], availableIn: ['electron', 'webview'], electron: { defaultKeybindings: 'bad' } };
  entries[5] = { ...entries[5], kind: 7, availableIn: ['electron'] };
  const exports = { get throws() { throw new Error('unavailable export'); }, short: entries.slice(0, 49), invalid: [...entries.slice(0, 49), { id: 'no-title-id' }], table: entries, later: table() };
  const file = '/fake/app/.vite/build/shared.js';
  cached(t, file, exports);
  const register = freshRegister(), run = setup(null, register);
  const answer = await run('catalog', {});
  assert.equal(answer.commands.length, 50);
  assert.deepEqual(answer.commands.slice(0, 6), [
    { id: 'command0', title: 'Toggle files', group: 'panels', palette: true, kind: 'webview', configurable: false, defaults: ['Primary', 'Secondary'] },
    { id: 'command1', title: null, group: null, palette: false, kind: 'electron-only', configurable: true, defaults: ['Fallback'] },
    { id: 'command2', title: null, group: null, palette: false, kind: 'vscode-only', configurable: true, defaults: [] },
    { id: 'command3', title: null, group: null, palette: false, kind: 'electron-only', configurable: true, defaults: ['Default'] },
    { id: 'command4', title: null, group: null, palette: false, kind: null, configurable: true, defaults: [] },
    { id: 'command5', title: null, group: null, palette: false, kind: null, configurable: true, defaults: [] },
  ]);
  assert.deepEqual(answer.commands[6], { id: 'command6', title: null, group: null, palette: false, kind: null, configurable: true, defaults: [] });
  delete require.cache[file];
  entries[0].electron.menuTitle = 'Changed after caching';
  assert.strictEqual(await run('catalog', {}), answer);
  assert.strictEqual(await setup({}, register)('catalog', {}), answer, 'shared by registrations in the process');
  assert.equal(answer.commands[0].title, 'Toggle files');
});

test('catalog refuses when no export has the shape, without loading another module', async (t) => {
  cached(t, '/fake/outside/shared.js', { table: table() });
  cached(t, '/fake/app/.vite/build/not-commands.js', {
    short: table().slice(1), wrongId: table().map((entry) => ({ ...entry, id: 1 })),
    notObjects: Array(50).fill(null), notArray: { length: 50 },
  });
  await assert.rejects(setup()('catalog', {}), (e) => e.refused === true && /^the app's command table was not found \(\d+ app modules loaded, \d+ long arrays among their exports\)$/.test(e.message));
});

test('catalog takes the app\'s combined table: VS Code commands titled by vscodeCommand, others tagged by kind', async (t) => {
  const entries = table();
  entries[3] = { ...entries[3], titleIntlId: undefined, vscodeCommand: { title: 'Add to Codex Chat' }, kind: 'vscode-only' };
  entries[4] = { ...entries[4], titleIntlId: undefined, kind: 'webview' };
  cached(t, '/fake/app/.vite/build/commands-few.js', { table: entries });
  const r = await setup()('catalog', {});
  assert.equal(r.commands.length, entries.length);
});

test('catalog reads a webpack build\'s module cache (the main-modules seam\'s globalThis.__codexmods.mainModules) beside require.cache', async (t) => {
  const had = Object.hasOwn(globalThis, '__codexmods'); const before = globalThis.__codexmods;
  t.after(() => { if (had) globalThis.__codexmods = before; else delete globalThis.__codexmods; });
  const entries = table(); entries[0] = { ...entries[0], kind: 'webview', commandMenu: true };
  globalThis.__codexmods = { ...(before ?? {}), mainModules: { 61071: { exports: { other: [1, 2] } }, 4482: { exports: { get Q() { return entries; } } }, 9: null } };
  const r = await setup(null, freshRegister())('catalog', {});
  assert.equal(r.commands.length, 50);
  assert.deepEqual(r.commands[0], { id: 'command0', title: null, group: null, palette: true, kind: 'webview', configurable: true, defaults: [] });
});

test('keymap, replace, set and reset use the app service, refresh the shortcuts page, and reread only public binding fields after a write', async () => {
  const calls = [];
  const page = { queryKey: ['vscode', 'codex-command-keymap-state'], reset: false };
  let bindings = [{ command: 'one', key: 'Control+1', version: 1 }, { command: 'unbound', key: null }, null, { command: 1, key: 'F1' }, { command: 'bad', key: 1 }, { command: 'missing' }];
  const run = setup({ commandKeybindings: {
    async get() { calls.push(['get']); return { bindings, keymapPath: '/private/home/keybindings.json', supported: true }; },
    async update(args) { calls.push(['update', args]); bindings = [{ command: args.commandId, key: args.update.accelerator ?? null, version: 1 }]; return { bindings: [{ command: 'ignored', key: 'F9' }] }; },
  }, queryCache: { async invalidateQueryCache(a) { calls.push(['invalidate', a]); } } });
  assert.deepEqual(await run('keymap', {}), { bindings: [{ command: 'one', key: 'Control+1' }, { command: 'unbound', key: null }] });
  assert.deepEqual(await run('rebind', { commandId: 'one', previous: 'Control+1', keys: 'Control+2' }), { bindings: [{ command: 'one', key: 'Control+2' }] });
  assert.deepEqual(await run('rebind', { commandId: 'one', previous: null, keys: 'Control+3' }), { bindings: [{ command: 'one', key: 'Control+3' }] });
  assert.deepEqual(await run('reset', { commandId: 'one' }), { bindings: [{ command: 'one', key: null }] });
  assert.deepEqual(calls, [
    ['get'], ['update', { commandId: 'one', update: { type: 'replace', previousAccelerator: 'Control+1', accelerator: 'Control+2' } }], ['invalidate', page], ['get'],
    ['update', { commandId: 'one', update: { type: 'set', accelerator: 'Control+3' } }], ['invalidate', page], ['get'],
    ['update', { commandId: 'one', update: { type: 'reset' } }], ['invalidate', page], ['get'],
  ]);
  for (const result of [{}, { bindings: null }, { bindings: {} }]) {
    assert.deepEqual(await setup({ commandKeybindings: { get: async () => result } })('keymap', {}), { bindings: [] });
  }
});

test('write guards reject invalid arguments before a service call, including the 200 character boundary', async () => {
  const calls = [];
  const run = setup({ commandKeybindings: { async get() { return {}; }, async update(args) { calls.push(args); } } });
  for (const commandId of [undefined, null, 1, '', 'x'.repeat(201)]) for (const op of ['rebind', 'reset']) {
    await assert.rejects(run(op, { commandId, keys: 'F1' }), isRefusal('a command id of at most 200 characters is needed'));
  }
  for (const keys of [undefined, null, 1, '', 'x'.repeat(201)]) {
    await assert.rejects(run('rebind', { commandId: 'one', keys }), isRefusal('shortcut keys of at most 200 characters are needed'));
  }
  assert.deepEqual(calls, []);
  const commandId = 'x'.repeat(200), keys = 'y'.repeat(200);
  await run('rebind', { commandId, keys, previous: '' });
  assert.deepEqual(calls, [{ commandId, update: { type: 'replace', previousAccelerator: '', accelerator: keys } }]);
});

test('run posts run-command to the first window, or takes a fresh application menu snapshot and invokes a nested native id', async () => {
  const posts = [], calls = [];
  const run = setup({ applicationMenu: {
    async getSnapshot() { calls.push(['snapshot']); return { 'file-menu': { items: [{ type: 'separator' }] }, 'view-menu': { items: [{ items: [{ items: [{ nativeCommandId: 'newWindow' }] }] }] } }; },
    async invokeItem(id) { calls.push(['invoke', id]); },
  } }, freshRegister(), { postToWindow: (...args) => posts.push(args) });
  for (const kind of ['webview', null, 'vscode-only']) assert.deepEqual(await run('run', { commandId: 'toggleFileTreePanel', kind }), {});
  assert.deepEqual(posts, Array.from({ length: 3 }, () => [7, 'codex_desktop:message-for-view', { type: 'run-command', id: 'toggleFileTreePanel' }]));
  assert.deepEqual(calls, []);
  assert.deepEqual(await run('run', { commandId: 'newWindow', kind: 'electron-only' }), {});
  assert.deepEqual(calls, [['snapshot'], ['invoke', 'newWindow']]);
  await assert.rejects(run('run', { commandId: 'missing', kind: 'electron-only' }), isRefusal("it runs from the app's own menu only"));
  assert.deepEqual(calls.at(-1), ['snapshot']);
  assert.equal(calls.filter(([op]) => op === 'invoke').length, 1);
  await assert.rejects(run('unknown', {}), isRefusal('unknown operation unknown'));
});

test('missing services refuse, while thrown service failures remain failures and are never retried', async () => {
  const ops = [['keymap', {}], ['rebind', { commandId: 'one', keys: 'F1' }], ['reset', { commandId: 'one' }], ['run', { commandId: 'newWindow', kind: 'electron-only' }]];
  for (const services of [null, {}, { commandKeybindings: {}, applicationMenu: {} }, { commandKeybindings: { get() {} }, applicationMenu: { getSnapshot() {} } }]) {
    const run = setup(services);
    for (const [op, args] of ops) {
      if (op === 'keymap' && typeof services?.commandKeybindings?.get === 'function') continue;
      await assert.rejects(run(op, args), isRefusal());
    }
  }
  await assert.rejects(setup(null)('run', { commandId: 'one' }), isRefusal('the app has no window'));
  await assert.rejects(setup({}, freshRegister(), null)('run', { commandId: 'one' }), isRefusal("the app's pages cannot be reached"));
  const error = new Error('service failed');
  let calls = 0;
  const fail = async () => { calls++; throw error; };
  const run = setup({ commandKeybindings: { get: fail, update: fail }, applicationMenu: { getSnapshot: fail, invokeItem: fail } });
  for (const [op, args] of ops) await assert.rejects(run(op, args), (e) => e === error && !e.refused);
  assert.equal(calls, ops.length);
  const invokeFailed = setup({ applicationMenu: { getSnapshot: async () => ({ file: { items: [{ nativeCommandId: 'one' }] } }), invokeItem: fail } });
  await assert.rejects(invokeFailed('run', { commandId: 'one', kind: 'electron-only' }), (e) => e === error && !e.refused);
  const readFailed = setup({ commandKeybindings: { update: async () => {}, get: fail } });
  await assert.rejects(readFailed('reset', { commandId: 'one' }), (e) => e === error && !e.refused);
});

test('every service call is bounded, including the reads and menu invocation after an earlier call succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = () => new Promise(() => {});
  const cases = [
    [{ commandKeybindings: { get: never } }, 'keymap', {}],
    [{ commandKeybindings: { get: never, update: never } }, 'rebind', { commandId: 'one', keys: 'F1' }],
    [{ commandKeybindings: { get: never, update: never } }, 'reset', { commandId: 'one' }],
    [{ commandKeybindings: { get: never, update: async () => {} } }, 'reset', { commandId: 'one' }],
    [{ applicationMenu: { getSnapshot: never, invokeItem: never } }, 'run', { commandId: 'one', kind: 'electron-only' }],
    [{ applicationMenu: { getSnapshot: async () => ({ file: { items: [{ nativeCommandId: 'one' }] } }), invokeItem: never } }, 'run', { commandId: 'one', kind: 'electron-only' }],
  ];
  for (const [services, op, args] of cases) {
    const done = assert.rejects(setup(services)(op, args), (e) => !e.refused && /did not answer/.test(e.message));
    // A successful first call settles before the second bounded call starts.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    t.mock.timers.tick(15_000);
    await done;
  }
});
