import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { register, CHOICES, safeModeMessage } = createRequire(import.meta.url)('../../../main/recovery/index.cjs');

function hooks(over = {}) {
  const sent = []; const windows = []; const appHandlers = {}; const calls = []; const logs = [];
  const electron = {
    app: { on: (e, fn) => { appHandlers[e] = fn; }, relaunch: () => calls.push('relaunch'), exit: (c) => calls.push(`exit:${c}`), quit() {}, getAppPath: () => '/x' },
    onWindowCreated: (fn) => windows.push(fn),
    showMessageBox: async (o) => { calls.push(['box', o]); return over.choice ?? 0; },
  };
  return { sent, windows, appHandlers, calls, logs, h: { electron, layout: { flags: over.flags ?? '/nonexistent' }, safe: !!over.safe,
    sendToHost: (m) => sent.push(m), onHostMessage() {}, log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) }, adapter: {}, frameworkDir: '/f' } };
}

test('the first ready-to-show of any app window sends exactly one window-rendered health signal', () => {
  const x = hooks();
  register(x.h);
  const w1 = new EventEmitter(), w2 = new EventEmitter();
  x.windows[0](w1, 1); x.windows[0](w2, 2);
  assert.deepEqual(x.sent, []);
  w2.emit('ready-to-show'); w1.emit('ready-to-show'); w2.emit('ready-to-show');
  assert.deepEqual(x.sent, [{ type: 'health', signal: 'window-rendered' }]);
});

test('no safe-mode dialog when not in safe mode', () => {
  const x = hooks();
  register(x.h);
  assert.equal(x.appHandlers.ready, undefined);
});

test('safe mode: Continue does nothing further, Restore asks the Host for lkg-restore', async () => {
  let x = hooks({ safe: true, choice: 0 });
  register(x.h);
  await x.appHandlers.ready();
  assert.deepEqual(x.calls[0][1].buttons, CHOICES);
  assert.deepEqual(CHOICES, ['Continue in safe mode', 'Restore last-known-good', 'Disable framework']);
  assert.deepEqual(x.sent, []);
  x = hooks({ safe: true, choice: 1 });
  register(x.h);
  await x.appHandlers.ready();
  assert.deepEqual(x.sent, [{ type: 'recovery', action: 'lkg-restore' }]);
});

test('safe mode: Disable framework writes flags/disabled then relaunches; the dialog shows once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cm-main-'));
  try {
    const x = hooks({ safe: true, choice: 2, flags: join(dir, 'flags') });
    register(x.h);
    await x.appHandlers.ready();
    x.windows[0](new EventEmitter(), 1);     // a window shows up later: no second dialog
    await new Promise((r) => setImmediate(r));
    assert.equal(x.calls.filter((c) => Array.isArray(c)).length, 1);
    assert.ok(JSON.parse(await readFile(join(dir, 'flags', 'disabled'), 'utf8')).at);
    assert.deepEqual(x.calls.filter((c) => typeof c === 'string'), ['relaunch', 'exit:0']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('register never throws: a broken electron adapter is logged', () => {
  const x = hooks();
  x.h.electron.onWindowCreated = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => register(x.h));
  assert.ok(x.logs.some((l) => l.startsWith('ERR')));
  assert.doesNotThrow(() => register({}));
});

test('safe mode you chose (CLI, the recovery entry, the overview, Adjustments) holds no start: the app says it; its text stays', async () => {
  for (const reason of ['cli', 'manual', 'safe-mode-op', 'adjustments']) {
    const dir = await mkdtemp(join(tmpdir(), 'cm-main-'));
    try {
      await mkdir(join(dir, 'flags'));
      await writeFile(join(dir, 'flags', 'safe'), JSON.stringify({ reason }));
      const x = hooks({ safe: true, choice: 0, flags: join(dir, 'flags') });
      register(x.h);
      await x.appHandlers.ready();
      assert.equal(x.calls.filter((c) => Array.isArray(c) && c[0] === 'box').length, 0, `${reason}: no message box`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  assert.match(safeModeMessage('cli'), /^Safe mode is on \(turned on by you\)\. Third-party mods are off\.$/);
});

test('the safe-mode dialog text follows the reason in flags/safe; the three buttons never change', async () => {
  const cases = [
    ['unhealthy-boots', /^Codex Mods started in safe mode because the previous start did not complete\. Third-party mods are off\.$/],
    ['offline-lkg', /restoring the last-known-good version.*not restored yet.*Third-party mods are off.*codexmods recovery lkg/],
    ['host-crash', /background process kept crashing/],
    ['some-future-reason', /^Codex Mods is in safe mode\. Third-party mods are off\.$/],
    [undefined, /^Codex Mods is in safe mode\./],          // no reason field
  ];
  for (const [reason, re] of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'cm-main-'));
    try {
      await mkdir(join(dir, 'flags'));
      await writeFile(join(dir, 'flags', 'safe'), JSON.stringify(reason === undefined ? {} : { reason }));
      const x = hooks({ safe: true, choice: 0, flags: join(dir, 'flags') });
      register(x.h);
      await x.appHandlers.ready();
      const box = x.calls.find((c) => Array.isArray(c))[1];
      assert.match(box.message, re, String(reason));
      assert.deepEqual(box.buttons, CHOICES, 'the three choices are unchanged');
      assert.ok(!/previous start did not complete/.test(box.message) || reason === 'unhealthy-boots', `${reason} must not claim an incomplete start`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  // missing or malformed flag file -> neutral
  assert.match(safeModeMessage(undefined), /^Codex Mods is in safe mode\./);
  const x = hooks({ safe: true, flags: '/nonexistent/flags' });
  register(x.h);
  await x.appHandlers.ready();
  assert.match(x.calls.find((c) => Array.isArray(c))[1].message, /^Codex Mods is in safe mode\./);
});
