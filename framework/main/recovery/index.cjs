'use strict';
// framework-main recovery integration: the first health signal and the safe-mode dialog.
// Contract: contracts/main-hooks.d.ts (register(hooks)), contracts/ipc.d.ts section 1. Never requires 'electron'.
const fs = require('node:fs');
const path = require('node:path');

const CHOICES = ['Continue in safe mode', 'Restore last-known-good', 'Disable framework'];

const TAIL = 'Third-party mods are off.';
/** Safe mode you chose (the CLI, the recovery entry, the overview, Adjustments): the app says it in its Mods band and pages, so no
 * message box holds the start (E6.4); one the framework chose (unhealthy starts, Host crashes, no pack) still asks. */
const YOUR_CHOICE = new Set(['cli', 'manual', 'safe-mode-op', 'adjustments']);
/** Dialog text for the reason recorded in flags/safe ({reason}); unknown or unreadable reasons get a neutral text. */
function safeModeMessage(reason) {
  switch (reason) {
    case 'cli': case 'manual': case 'safe-mode-op': case 'adjustments':
      return `Safe mode is on (turned on by you). ${TAIL}`;
    case 'unhealthy-boots':
      return `Codex Mods started in safe mode because the previous start did not complete. ${TAIL}`;
    case 'host-crash':
      return `Codex Mods started in safe mode because its background process kept crashing. ${TAIL}`;
    case 'offline-lkg':
      return `Codex Mods is restoring the last-known-good version: the framework and app copy were switched back offline, but mod records and settings are not restored yet. ${TAIL} Finish with \`codexmods recovery lkg\` while the app is running.`;
    case 'no-adapter': case 'no-node':
      return `Codex Mods could not start its framework for this app (${reason === 'no-adapter' ? 'no compatibility pack for this ChatGPT build' : 'no runtime available'}), so it runs in safe mode. ${TAIL}`;
    default:
      return `Codex Mods is in safe mode. ${TAIL}`;
  }
}
function readSafeReason(flagsDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(flagsDir, 'safe'), 'utf8'));
    return v && typeof v.reason === 'string' ? v.reason : undefined;
  } catch (e) { return undefined; }
}

const DIALOG_FILE = 'startup-dialog.json';

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** While a blocking startup dialog is open this file names the live process holding it; host/recovery pauses its health window. */
function markDialogOpen(flagsDir, kind) {
  writeFileAtomic(path.join(flagsDir, DIALOG_FILE), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), kind }) + '\n');
}
function clearDialogMark(flagsDir) {
  try { fs.unlinkSync(path.join(flagsDir, DIALOG_FILE)); } catch (e) { /* none */ }
}
/**
 * An explicit decision made in the dialog (Restore, Disable, or quitting while it waits) is not a failed start: the boot marker
 * becomes {state:'healthy', unhealthyCount:0} so the loader does not count this boot as unfinished.
 */
function settleBootMarker(flagsDir, why) {
  const file = path.join(flagsDir, 'boot.json');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  writeFileAtomic(file, JSON.stringify({ ...marker, state: 'healthy', unhealthyCount: 0, resetBy: why }, null, 2) + '\n');
}

function writeDisabledFlag(flagsDir) {
  fs.mkdirSync(flagsDir, { recursive: true, mode: 0o700 });
  const file = path.join(flagsDir, 'disabled');
  fs.writeFileSync(file, JSON.stringify({ reason: 'safe-mode-dialog', at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return file;
}

/** @param {import('../../../contracts/main-hooks.js').MainHooks} hooks */
function register(hooks) {
  const log = hooks.log || { info() {}, error() {} };
  try {
    const { electron } = hooks;

    // Health: the first app window that fires ready-to-show has rendered.
    let rendered = false;
    electron.onWindowCreated((win) => {
      try {
        if (rendered || !win) return;
        const once = typeof win.once === 'function' ? win.once.bind(win) : typeof win.on === 'function' ? win.on.bind(win) : null;
        if (!once) { log.error('recovery: window object has no event API'); return; }
        once('ready-to-show', () => {
          if (rendered) return;
          rendered = true;
          hooks.sendToHost({ type: 'health', signal: 'window-rendered' });
        });
      } catch (e) { log.error('recovery: window hook failed', { message: e && e.message }); }
    });

    // Safe mode: ask the user what to do, once per start.
    if (hooks.safe) {
      let asked = false;
      const flags = hooks.layout.flags;
      clearDialogMark(flags);                                    // a leftover mark of a dead process
      const ask = async () => {
        if (asked) return;
        asked = true;
        if (YOUR_CHOICE.has(readSafeReason(flags))) { log.info('recovery: safe mode is your choice: no start-up dialog (the Mods band says it)'); return; }
        let dialogOpen = false;
        // Quitting while the dialog waits is not a failed start either.
        electron.app.on('before-quit', () => { if (dialogOpen) { try { settleBootMarker(flags, 'quit-during-dialog'); } catch (e) { /* best effort */ } } });
        try {
          try { markDialogOpen(flags, 'safe-mode'); } catch (e) { log.error('recovery: cannot mark the dialog open', { message: e && e.message }); }
          dialogOpen = true;
          const choice = await electron.showMessageBox({
            message: safeModeMessage(readSafeReason(flags)),
            buttons: CHOICES,
          });
          if (choice === 1) {
            settleBootMarker(flags, 'restore-lkg');                // an explicit choice, not an unfinished start; the mark stays until exit
            hooks.sendToHost({ type: 'recovery', action: 'lkg-restore' });
            log.info('recovery: user asked for last-known-good restore');
          } else if (choice === 2) {
            settleBootMarker(flags, 'disable-framework');
            writeDisabledFlag(flags);
            log.info('recovery: framework disabled by the user; relaunching');
            electron.app.relaunch();
            electron.app.exit(0);
          } else {
            dialogOpen = false;
            clearDialogMark(flags);                                // Continue: the health window resumes
          }
        } catch (e) {
          log.error('recovery: safe-mode dialog failed', { message: e && e.message });
          dialogOpen = false; clearDialogMark(flags);
        }
      };
      electron.app.on('ready', () => { void ask(); });
      // A dialog needs the app to be ready; the first window proves it even if 'ready' fired before we registered.
      electron.onWindowCreated(() => { void ask(); });
    }
  } catch (e) {
    log.error('recovery: register failed', { message: e && e.message });
  }
}

module.exports = { register, CHOICES, safeModeMessage };
