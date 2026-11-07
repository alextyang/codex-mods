import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeHostContext, createFakeRendererContext } from '../../../sdk/testing/index.mjs';
import mod, { KEYS, SPLIT_KEYS, arrangementOf, placed, resized } from '../renderer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'mod.json'), 'utf8'));
const WINDOW = { type: 'Window', provider: 'codexmods.windows', id: '1' };
const CHAT = { type: 'CodexThread', provider: 'codex', id: 't1' };
const OTHER = { type: 'CodexThread', provider: 'codex', id: 't2' };
const MINE = { type: 'EchoThread', provider: 'example.agent', id: 'e1' };

async function boot(t, { settings } = {}) {
  const { ctx, control } = createFakeRendererContext({ manifest, settings });
  t.after(() => control.cleanup());
  await control.activate(mod);
  return { ctx, control };
}

test('the arrangement: as many panes as the setting, shares that sum to one, a chat placed once, dividers bounded', () => {
  assert.deepEqual(arrangementOf(null, 2), { panes: [null, null], shares: [0.5, 0.5] });
  assert.deepEqual(arrangementOf({ panes: [CHAT, 'junk', OTHER], shares: [0.5, 0.25, 0.25] }, 3).panes, [CHAT, null, OTHER]);
  assert.deepEqual(arrangementOf({ panes: [CHAT], shares: [0.2, 0.3, 0.5] }, 2).shares, [0.5, 0.5], 'shares of another count start even');
  assert.deepEqual(arrangementOf({ panes: [CHAT], shares: [2, 2] }, 2).shares, [0.5, 0.5], 'kept shares sum to one');
  assert.equal(arrangementOf(null, 9).panes.length, 3);
  const a = placed(arrangementOf(null, 2), CHAT);
  assert.deepEqual(a.panes, [CHAT, null]);
  assert.equal(placed(a, CHAT), a, 'already there');
  assert.deepEqual(placed(placed(a, OTHER), MINE).panes, [CHAT, MINE], 'full: the last pane takes it');
  assert.deepEqual(resized([0.5, 0.5], 0, 0.2).map((x) => +x.toFixed(2)), [0.7, 0.3]);
  assert.deepEqual(resized([0.5, 0.5], 0, 0.9).map((x) => +x.toFixed(2)), [0.85, 0.15], 'never below the minimum');
});

test('its commands: beside (with its key), open in split view (a chat\'s menu), show or hide, next and previous pane', async (t) => {
  const { control } = await boot(t);
  assert.deepEqual([...control.commands.keys()].sort(), ['beside', 'next', 'open-split', 'previous', 'toggle']);
  assert.equal(control.commands.get('beside').spec.keys, KEYS);
  assert.equal(control.commands.get('toggle').spec.keys, SPLIT_KEYS);
  assert.equal(control.commands.get('open-split').spec.appliesTo, 'Thread', 'any chat, a mod\'s too');
  await control.runCommand('beside', { window: WINDOW, subject: CHAT });
  assert.deepEqual(control.invoked.at(-1), { ref: WINDOW, operation: 'open', args: [CHAT, { placement: 'side' }] });
  await control.runCommand('next', { window: WINDOW });
  assert.deepEqual(control.invoked.at(-1), { ref: WINDOW, operation: 'focusPane', args: ['next'] });
});

test('"Open in split view" puts the chat in a pane, keeps the arrangement in storage and shows the region', async (t) => {
  const { ctx, control } = await boot(t);
  await control.runCommand('open-split', { window: WINDOW, subject: CHAT });
  assert.deepEqual(control.invoked.at(-1), { ref: WINDOW, operation: 'setRegion', args: ['codexmods.multi-panel/split', { open: true }] });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await ctx.storage.get('panes')).panes, [CHAT, null]);
  await control.runCommand('open-split', { window: WINDOW, subject: MINE });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await ctx.storage.get('panes')).panes, [CHAT, MINE]);
  await control.runCommand('open-split', { window: WINDOW, subject: null });
  assert.match(control.notifications.at(-1).title, /Choose a chat/);
});

test('the region draws a pane per chat, hosted with its composer, and an empty pane that takes a dropped chat', async (t) => {
  const { ctx, control } = await boot(t);
  await ctx.storage.set('panes', { panes: [CHAT, null], shares: [0.5, 0.5] });
  assert.ok(control.regions.has('split'));
  const root = await control.render('split', { region: { key: 'codexmods.multi-panel/split', edge: 'right', size: 560 } });
  await root.until(() => /Drop a chat here/.test(root.text()));
  assert.deepEqual(control.hosted.map((h) => [h.kind, h.thread?.id, h.composer]), [['thread', 't1', true]]);
});

test('with no chat, or when the window cannot, it says so', async (t) => {
  const { control } = await boot(t);
  await control.runCommand('beside', { window: WINDOW, subject: null });
  assert.match(control.notifications.at(-1).title, /Open a chat first/);
  control.onInvoke(() => ({ status: 'refused', reason: 'unavailable', message: 'the window shows no route with panels' }));
  await control.runCommand('beside', { window: WINDOW, subject: CHAT });
  assert.match(control.notifications.at(-1).title, /could not open beside this one: the window shows no route with panels/);
  await control.runCommand('toggle', { window: WINDOW });
  assert.match(control.notifications.at(-1).title, /split view could not open: the window shows no route with panels/);
});

test('the shortcut setting registers the commands again, with or without their keys', async (t) => {
  const host = createFakeHostContext({ manifest });
  t.after(() => host.control.cleanup());
  const ui = createFakeRendererContext({ manifest, host: host.control });
  await ui.control.activate(mod);
  host.control.settings.patch({ keyboardShortcut: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ui.control.commands.get('beside').spec.keys, undefined);
  assert.equal(ui.control.commands.get('toggle').spec.keys, undefined);
  host.control.settings.patch({ keyboardShortcut: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ui.control.commands.get('beside').spec.keys, KEYS);
  assert.equal(ui.control.commands.size, 5);
});

test('disposal leaves nothing registered', async (t) => {
  const { control } = await boot(t);
  await control.deactivate();
  assert.equal(control.commands.size, 0);
  assert.deepEqual(control.registrations(), { total: 0 });
});

test('the manifest asks for the operations it uses', () => {
  assert.deepEqual(manifest.permissions, ['ui', 'graph', 'graph.read', 'graph.act:Window.open,Window.setRegion,Window.focusPane,Thread.open', 'graph.present:Palette,Menu,Window']);
});
