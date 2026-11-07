// Command and Shortcut through the real source, graph, mux and fake app-server (breadth step D6). Framework-main's operations are
// answered on the real area channel; the app's command table and keymap are supplied here. No app, Codex home or network is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs } from '../map.mjs';
import * as commandsArea from '../areas/commands.mjs';
import { produced } from './areas/commands.samples.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const mod = { kind: 'mod', id: 'mod.a' }, user = { kind: 'user', id: 'user' };
const entry = (id, extra = {}) => ({ id, title: null, group: null, palette: true, kind: 'webview', configurable: true, defaults: [], ...extra });
const catalog = () => [
  entry('toggleFileTreePanel', { group: 'panels', defaults: ['Command+1', 'Control+1'] }),
  entry('archiveThread', { title: 'Archive chat', group: 'thread', defaults: ['Command+E'] }),
  entry('newWindow', { title: 'New window', kind: 'electron-only', defaults: ['Command+N'] }),
  entry('editor.thread1', { kind: 'vscode-only', defaults: ['F1'] }),
  entry('fixed', { title: 'Fixed shortcut', configurable: false, defaults: ['F2'] }),
  entry('custom', { defaults: ['F3'] }),
  entry('unbound', { defaults: ['F4'] }),
  entry('noShortcut', { kind: null }),
];
const initialBindings = () => [{ command: 'custom', key: 'F5' }, { command: 'custom', key: null }, { command: 'custom', key: 'F6' }, { command: 'unbound', key: null }];
const detail = 'Codex keeps your shortcuts in keybindings.json in its home: every window and the menu use them.';

async function setup({ entries = catalog(), bindings = initialBindings(), main = true, initialAnswers = [] } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-commands-'));
  const ops = [], prompts = [], events = [], warnings = [];
  const answers = new Map(initialAnswers);
  let clock = 100_000, approved = true, feed, context;
  let keymap = structuredClone(bindings);
  const log = { ...quiet, warn: (message, data) => warnings.push([message, data]) };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), now: () => clock, log,
    approvals: { ask: async (q) => { prompts.push({ action: q.action, detail: q.detail }); return { approved, reason: 'declined' }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let mainOps = null;
  if (main) mainOps = createMainOps({ log, send: (m) => {
    assert.equal(m.area, 'commands');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        let result;
        if (answers.has(m.op)) {
          const answer = answers.get(m.op);
          if (typeof answer === 'function') result = await answer(m.args);
          else { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...answer }); return; }
        } else if (m.op === 'catalog') result = { commands: structuredClone(entries) };
        else if (m.op === 'keymap') result = { bindings: structuredClone(keymap) };
        else if (m.op === 'rebind') {
          const { commandId, previous, keys } = m.args;
          const overrides = keymap.filter((binding) => binding.command === commandId);
          const before = overrides.length ? overrides.filter((binding) => binding.key !== null).map((binding) => binding.key) : entries.find((entry) => entry.id === commandId).defaults;
          keymap = [...keymap.filter((binding) => binding.command !== commandId), ...before.map((key) => ({ command: commandId, key: key === previous ? keys : key }))];
          result = { bindings: structuredClone(keymap) };
        } else if (m.op === 'reset') {
          keymap = keymap.filter((binding) => binding.command !== m.args.commandId);
          result = { bindings: structuredClone(keymap) };
        } else if (m.op === 'run') result = {};
        else throw new Error(`unexpected main operation ${m.op}`);
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: true, result });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, refused: e.refused === true, error: e.message }); }
    });
  } });
  const area = { ...commandsArea, createFeed(ctx) { context = ctx; feed = commandsArea.createFeed(ctx); return feed; } };
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, now: () => clock, log, mainOps, areas: { commands: area } });
  graph.onEvent((e) => {
    if (e.kind === 'event' && ['Command', 'Shortcut'].includes(e.ref.type)) events.push({ ref: e.ref, name: e.name });
  });
  await source.start();
  await feed.observe(refs.command('toggleFileTreePanel'), 'Command');
  return {
    h, graph, source, feed, context, ops, prompts, events, warnings, answers,
    command: (id) => graph.resolve(refs.command(id)),
    shortcut: (id, i = 0) => graph.resolve(refs.shortcut(id, i)),
    invoke: (ref, operation, args = [], caller = mod) => graph.invoke({ ref, operation, args, caller }),
    setBindings(next) { keymap = structuredClone(next); },
    setClock(next) { clock = next; },
    approve(value) { approved = value; },
    async close() { await source.dispose(); graph.close(); mainOps?.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const keymapReads = (s) => s.ops.filter(([op]) => op === 'keymap').length;

test('command data, readable titles and samples cover kinds, defaults, overrides, unbound commands and both links', () => {
  for (const [id, title] of [['toggleFileTreePanel', 'Toggle file tree panel'], ['app.toggleFileTreePanel', 'Toggle file tree panel'], ['thread1', 'Thread 1'], ['app.Thread42Title', 'Thread 42 title']]) {
    assert.equal(commandsArea.titleOf(id), title);
  }
  assert.deepEqual(commandsArea.commandData(entry('plain')), { ref: refs.command('plain'), state: { title: 'Plain', category: 'other', enabled: true }, links: {} });
  assert.deepEqual(commandsArea.commandData(entry('literal', { title: '', group: '' })).state, { title: '', category: '', enabled: true });
  for (const id of ['archiveThread', 'copyDeeplink', 'copyConversationMarkdown', 'copyWorkingDirectory', 'markThreadUnread', 'openThreadInNewWindow', 'openSideChat', 'toggleThreadPin', 'renameThread']) {
    assert.equal(commandsArea.commandData(entry(id)).state.appliesTo, 'Thread');
  }
  const data = produced();
  const commands = data.filter((data) => data.ref.type === 'Command'), shortcuts = data.filter((data) => data.ref.type === 'Shortcut');
  assert.deepEqual(commands[0].state, { title: 'Archive chat', category: 'thread', enabled: true, appliesTo: 'Thread' });
  assert.equal(commands[1].state.title, 'Thread 1');
  assert.equal(commands[1].links.shortcut, null);
  assert.equal(commands[2].state.enabled, false);
  assert.equal(commands[3].links.shortcut, null);
  assert.deepEqual(shortcuts.map((data) => data.state), [{ keys: 'Command+E', custom: false }, { keys: 'Control+E', custom: false }, { keys: 'F2', custom: true }]);
  assert.deepEqual(shortcuts[0].links.command, commands[0].ref);
  assert.deepEqual(commands[0].links.shortcut, shortcuts[0].ref);
});

test('the first read syncs every command, defaults and overrides; unbound commands have no shortcut and no changed events fire', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.ops, [['catalog', {}], ['keymap', {}]]);
    assert.equal(s.graph.list('Command').length, 8);
    assert.equal(s.graph.list('Shortcut').length, 8);
    assert.deepEqual(s.command('toggleFileTreePanel').state, { title: 'Toggle file tree panel', category: 'panels', enabled: true });
    assert.deepEqual(s.command('archiveThread').state, { title: 'Archive chat', category: 'thread', enabled: true, appliesTo: 'Thread' });
    assert.equal(s.command('editor.thread1').state.enabled, false);
    assert.equal(s.command('newWindow').state.enabled, true);
    assert.equal(s.command('noShortcut').state.enabled, true);
    assert.deepEqual(s.shortcut('toggleFileTreePanel', 1).state, { keys: 'Control+1', custom: false });
    assert.deepEqual(s.shortcut('custom').state, { keys: 'F5', custom: true });
    assert.deepEqual(s.shortcut('custom', 1).state, { keys: 'F6', custom: true });
    assert.deepEqual(s.command('custom').links.shortcut, refs.shortcut('custom', 0));
    assert.deepEqual(s.shortcut('custom').links.command, refs.command('custom'));
    for (const id of ['unbound', 'noShortcut']) {
      assert.equal(s.shortcut(id), null);
      assert.equal(s.command(id).links.shortcut, null);
    }
    assert.deepEqual(s.events, []);
    assert.deepEqual(s.warnings, []);
  } finally { await s.close(); }
});

test('later reads emit changed for keys, custom status and new shortcuts, remove vanished bindings and retain other instances', async () => {
  const s = await setup();
  try {
    const other = refs.command('another-area');
    s.context.handle.put(other, { state: { title: 'Other', category: 'other', enabled: true }, links: {} });
    s.setBindings([
      { command: 'toggleFileTreePanel', key: 'Command+1' }, { command: 'toggleFileTreePanel', key: 'Control+1' },
      { command: 'custom', key: 'F7' }, { command: 'unbound', key: 'F8' }, { command: 'archiveThread', key: null },
    ]);
    await s.feed.read();
    assert.deepEqual(s.events, [
      { ref: refs.shortcut('toggleFileTreePanel', 0), name: 'changed' },
      { ref: refs.shortcut('toggleFileTreePanel', 1), name: 'changed' },
      { ref: refs.shortcut('custom', 0), name: 'changed' },
      { ref: refs.shortcut('unbound', 0), name: 'changed' },
    ]);
    assert.equal(s.shortcut('custom', 1).gone, true);
    assert.equal(s.shortcut('archiveThread').gone, true);
    assert.equal(s.command('archiveThread').links.shortcut, null);
    assert.deepEqual(s.command('unbound').links.shortcut, refs.shortcut('unbound', 0));
    assert.equal(s.graph.resolve(other).gone, undefined);
    assert.equal(s.ops.filter(([op]) => op === 'catalog').length, 1, 'the catalog is read once');
    s.events.length = 0;
    await s.feed.read();
    assert.deepEqual(s.events, []);
  } finally { await s.close(); }
});

test('run sends the catalog kind, ignores arguments and emits ran; unknown commands refuse before a main call', async () => {
  const s = await setup();
  try {
    const before = s.ops.length;
    for (const id of ['toggleFileTreePanel', 'newWindow']) {
      assert.equal((await s.invoke(refs.command(id), 'run', [{ ignored: true }])).status, 'done');
    }
    assert.deepEqual(s.ops.slice(before), [
      ['run', { commandId: 'toggleFileTreePanel', kind: 'webview' }], ['run', { commandId: 'newWindow', kind: 'electron-only' }],
    ]);
    assert.deepEqual(s.events, [{ ref: refs.command('toggleFileTreePanel'), name: 'ran' }, { ref: refs.command('newWindow'), name: 'ran' }]);
    const unknown = refs.command('unknown');
    s.context.handle.put(unknown, { state: { title: 'Unknown', category: 'other', enabled: true }, links: {} });
    const result = await s.invoke(unknown, 'run');
    assert.deepEqual([result.status, result.reason, result.message], ['refused', 'unavailable', 'this command is not known']);
    assert.equal(s.ops.length, before + 2);
    assert.deepEqual(s.prompts, []);
  } finally { await s.close(); }
});

test('rebind replaces this binding and reset restores all command defaults, applying the returned keymap without rereading the catalog', async () => {
  const s = await setup();
  try {
    const ref = refs.shortcut('toggleFileTreePanel', 1), before = s.ops.length;
    assert.equal((await s.invoke(ref, 'rebind', ['Control+2'])).status, 'done');
    assert.deepEqual(s.ops.slice(before), [['rebind', { commandId: 'toggleFileTreePanel', previous: 'Control+1', keys: 'Control+2' }]]);
    assert.deepEqual(s.shortcut('toggleFileTreePanel').state, { keys: 'Command+1', custom: true });
    assert.deepEqual(s.shortcut('toggleFileTreePanel', 1).state, { keys: 'Control+2', custom: true });
    assert.deepEqual(s.events, [{ ref: refs.shortcut('toggleFileTreePanel', 0), name: 'changed' }, { ref, name: 'changed' }]);
    s.events.length = 0;
    assert.equal((await s.invoke(ref, 'reset')).status, 'done');
    assert.deepEqual(s.ops.slice(before), [
      ['rebind', { commandId: 'toggleFileTreePanel', previous: 'Control+1', keys: 'Control+2' }], ['reset', { commandId: 'toggleFileTreePanel' }],
    ]);
    assert.deepEqual(s.shortcut('toggleFileTreePanel', 1).state, { keys: 'Control+1', custom: false });
    assert.deepEqual(s.events, [{ ref: refs.shortcut('toggleFileTreePanel', 0), name: 'changed' }, { ref, name: 'changed' }]);
    assert.deepEqual(s.prompts, [
      { action: 'change the shortcut of “Toggle file tree panel” to Control+2', detail },
      { action: 'reset the shortcuts of “Toggle file tree panel”', detail },
    ]);
    assert.equal((await s.invoke(refs.shortcut('custom', 1), 'reset')).status, 'done');
    assert.deepEqual(s.shortcut('custom').state, { keys: 'F3', custom: false });
    assert.equal(s.shortcut('custom', 1).gone, true, 'resetting any binding resets the command');
  } finally { await s.close(); }
});

test('invalid and unconfigurable rebinds refuse; unchanged rebinds and default resets have no effects or approval prompt', async () => {
  const s = await setup();
  try {
    const before = s.ops.length;
    const ref = refs.shortcut('toggleFileTreePanel', 0);
    assert.equal((await s.invoke(ref, 'rebind', ['Command+1'])).status, 'done');
    assert.equal((await s.invoke(ref, 'reset')).status, 'done');
    for (const args of [[], [''], [null], [1]]) {
      const result = await s.invoke(ref, 'rebind', args);
      assert.deepEqual([result.status, result.reason], ['refused', 'invalid']);
    }
    const fixed = await s.invoke(refs.shortcut('fixed', 0), 'rebind', ['F9']);
    assert.deepEqual([fixed.status, fixed.reason, fixed.message], ['refused', 'unsupported', 'the app does not let you change this shortcut']);
    assert.deepEqual(s.events, []);
    assert.deepEqual(s.prompts, []);
    assert.equal(s.ops.length, before);
  } finally { await s.close(); }
});

test('user calls need no R17 prompts; a mod denied approval writes nothing', async () => {
  const s = await setup();
  try {
    const ref = refs.shortcut('archiveThread', 0);
    assert.equal((await s.invoke(ref, 'rebind', ['Command+Shift+E'], user)).status, 'done');
    assert.equal((await s.invoke(ref, 'reset', [], user)).status, 'done');
    assert.deepEqual(s.prompts, []);
    s.approve(false);
    const before = s.ops.length;
    const result = await s.invoke(ref, 'rebind', ['Command+Shift+E']);
    assert.deepEqual([result.status, result.reason], ['refused', 'notAllowed']);
    assert.equal(s.ops.length, before);
    assert.deepEqual(s.shortcut('archiveThread').state, { keys: 'Command+E', custom: false });
    assert.deepEqual(s.prompts, [{ action: 'change the shortcut of “Archive chat” to Command+Shift+E', detail }]);
  } finally { await s.close(); }
});

test('main refusals become unavailable, failures fail without retries, and failed operations preserve state and events', async () => {
  const s = await setup();
  try {
    for (const [op, ref, args] of [
      ['run', refs.command('newWindow'), []], ['rebind', refs.shortcut('custom', 0), ['F9']], ['reset', refs.shortcut('custom', 0), []],
    ]) {
      for (const refused of [true, false]) {
        s.answers.set(op, { ok: false, refused, error: 'app failed' });
        const before = s.ops.length, bindings = s.graph.list('Shortcut');
        const result = await s.invoke(ref, op, args, user);
        assert.equal(result.status, refused ? 'refused' : 'failed');
        if (refused) assert.deepEqual([result.reason, result.message], ['unavailable', 'app failed']);
        else assert.equal(result.error.message, 'app failed');
        assert.equal(s.ops.length, before + 1);
        assert.deepEqual(s.graph.list('Shortcut'), bindings);
        assert.deepEqual(s.events, []);
      }
    }
  } finally { await s.close(); }
});

test('failed catalog and keymap reads log and preserve instances; catalog retries until it succeeds, then remains cached', async () => {
  for (const refused of [true, false]) {
    const s = await setup({ initialAnswers: [['catalog', { ok: false, refused, error: 'no catalog' }]] });
    try {
      assert.deepEqual(s.graph.list('Command'), []);
      assert.deepEqual(s.graph.list('Shortcut'), []);
      assert.deepEqual(s.warnings, [['commands: the commands could not be read', { message: 'no catalog' }]]);
      s.answers.delete('catalog');
      await s.feed.read();
      assert.equal(s.graph.list('Command').length, 8);
      assert.deepEqual(s.events, [], 'the first successful read is still a sync');
      const before = [...s.graph.list('Command'), ...s.graph.list('Shortcut')];
      s.answers.set('keymap', { ok: false, refused, error: 'no keymap' });
      await s.feed.read();
      assert.deepEqual([...s.graph.list('Command'), ...s.graph.list('Shortcut')], before);
      assert.deepEqual(s.warnings.at(-1), ['commands: the commands could not be read', { message: 'no keymap' }]);
      assert.equal(s.ops.filter(([op]) => op === 'catalog').length, 2);
    } finally { await s.close(); }
  }
  const s = await setup({ main: false });
  try {
    assert.deepEqual(s.graph.list('Command'), []);
    assert.equal(s.warnings[0][1].message, 'framework-main is not running');
  } finally { await s.close(); }
});

test('reads serialize and coalesce; observation loads exact Commands and Shortcuts when stale and leaves command subtypes to their areas', async () => {
  const s = await setup();
  let release;
  try {
    let count = keymapReads(s);
    s.setClock(130_000);
    await s.feed.observe(refs.command('toggleFileTreePanel'), 'Command');
    assert.equal(keymapReads(s), count, '30 seconds is still fresh');
    s.setClock(130_001);
    const commandView = s.graph.subscribe({ ref: refs.command('toggleFileTreePanel') }, () => {});
    await commandView.loaded; commandView.dispose();
    assert.equal(keymapReads(s), ++count);
    s.setClock(160_002);
    const shortcutView = s.graph.subscribe({ ref: refs.shortcut('custom', 0) }, () => {});
    await shortcutView.loaded; shortcutView.dispose();
    assert.equal(keymapReads(s), ++count);
    s.setClock(200_000);
    assert.equal(s.feed.observe({ type: 'ProjectAction', provider: 'codex', id: 'p#0' }, 'Command'), undefined);
    assert.equal(s.feed.observe({ type: 'SlashCommand', provider: 'codex', id: 'compact' }, 'Command'), undefined);
    assert.equal(s.feed.observe(refs.agent(), 'Agent'), undefined);
    assert.equal(keymapReads(s), count);

    let active = 0, peak = 0, calls = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('keymap', async () => {
      active++; peak = Math.max(peak, active); calls++;
      try { if (calls === 1) await gate; return { bindings: initialBindings() }; } finally { active--; }
    });
    const first = s.feed.read();
    assert.strictEqual(s.feed.observe(refs.command('toggleFileTreePanel'), 'Command'), first);
    assert.strictEqual(s.feed.observe(refs.shortcut('custom', 0), 'Shortcut'), first);
    assert.strictEqual(s.feed.read(), first);
    assert.strictEqual(s.feed.read(), first);
    await until(() => calls === 1, 2000, 'the held keymap read');
    release(); await first;
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal(keymapReads(s), count + 2);
    s.answers.delete('keymap');
    s.h.bus.publish('appServer/ready', {});
    await until(() => keymapReads(s) === count + 3, 2000, 'the ready read');
    await s.feed.observe(refs.command('toggleFileTreePanel'), 'Command');
    assert.equal(s.ops.filter(([op]) => op === 'catalog').length, 1);
  } finally { release?.(); await s.close(); }
});

test('the unrefd minute timer refreshes the keymap, and disposal clears it and prevents an in-flight read from putting instances', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = await setup();
  let release;
  try {
    let count = keymapReads(s);
    s.setBindings([{ command: 'custom', key: 'F9' }]);
    t.mock.timers.tick(59_999);
    assert.equal(keymapReads(s), count);
    t.mock.timers.tick(1);
    await s.feed.observe(refs.shortcut('custom', 0), 'Shortcut');
    assert.equal(keymapReads(s), ++count);
    assert.deepEqual(s.shortcut('custom').state, { keys: 'F9', custom: true });
    const before = s.graph.list('Shortcut');
    s.events.length = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    s.answers.set('keymap', async () => { await gate; return { bindings: initialBindings() }; });
    const running = s.feed.read();
    s.feed.dispose();
    release(); await running;
    t.mock.timers.tick(120_000);
    await s.feed.read();
    await s.feed.start();
    await s.feed.serverUp();
    assert.equal(keymapReads(s), count + 1, 'only the in-flight read, no later timer or start');
    assert.deepEqual(s.graph.list('Shortcut'), before);
    assert.deepEqual(s.events, []);
  } finally { release?.(); await s.close(); }
});
