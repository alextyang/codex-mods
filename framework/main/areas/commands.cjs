'use strict';
// The app's command table and keymap (breadth step D6). Reads and changes use the app's services; commands follow the menu's own path.
const kit = require('../area-kit.cjs');

let catalog = null;

/** The app's command table by its shape: objects with a string id, each tagged with the kind of command it is or titled (by a message
 *  id, or a VS Code command's title: 21477's combined table of web, VS Code and Electron commands has all three), at least half of them
 *  with a title's message id. */
const KINDS = new Set(['webview', 'vscode-only', 'electron-only']);
function isTable(table) {
  if (!Array.isArray(table) || table.length < 50) return false;
  const entry = (item) => item && typeof item === 'object' && typeof item.id === 'string'
    && (KINDS.has(item.kind) || typeof item.titleIntlId === 'string' || (item.vscodeCommand && typeof item.vscodeCommand === 'object'));
  if (!table.every(entry)) return false;
  return table.filter((item) => typeof item.titleIntlId === 'string').length >= table.length / 2;
}

/** The app's loaded main-process modules: Node's own (a Vite build's chunk files) and, on a webpack build (22943), the runtime's module
 *  cache, which the adapter's main-modules seam hands over as `globalThis.__codexmods.mainModules` (the same `{ exports }` records). */
function appModules() {
  const out = Object.entries(require.cache).filter(([file]) => file.includes('/.vite/build/')).map(([, loaded]) => loaded);
  const cache = globalThis.__codexmods?.mainModules;
  if (cache && typeof cache === 'object') out.push(...Object.values(cache));
  return out;
}

function commandCatalog() {
  if (catalog) return catalog;
  const seen = { modules: 0, arrays: 0 };
  for (const loaded of appModules()) {
    if (!loaded || typeof loaded !== 'object') continue;
    seen.modules += 1;
    for (const name of Object.keys(loaded.exports ?? {})) {
      try {
        const table = loaded.exports[name];
        if (Array.isArray(table) && table.length >= 50) seen.arrays += 1;
        if (!isTable(table)) continue;
        catalog = { commands: table.map((item) => {
          const platform = item.electron?.platformDefaultKeybindings?.[process.platform];
          const defaults = Array.isArray(platform) ? platform : Array.isArray(item.electron?.defaultKeybindings) ? item.electron.defaultKeybindings : [];
          return {
            id: item.id,
            title: typeof item.electron?.menuTitle === 'string' && item.electron.menuTitle ? item.electron.menuTitle : null,
            group: typeof item.commandMenuGroupKey === 'string' ? item.commandMenuGroupKey : null,
            palette: item.commandMenu === true,
            kind: typeof item.kind === 'string' ? item.kind : item.kind == null && Array.isArray(item.availableIn) && item.availableIn.length === 1 && item.availableIn[0] === 'electron' ? 'electron-only' : null,
            configurable: item.shortcutConfigurable !== false,
            defaults: defaults.filter((binding) => typeof binding?.key === 'string').map((binding) => binding.key),
          };
        }) };
        return catalog;
      } catch { /* An app export can be a getter that throws. */ }
    }
  }
  throw kit.refusal(`the app's command table was not found (${seen.modules} app modules loaded, ${seen.arrays} long arrays among their exports)`);
}

function bindingsOf(result) {
  return { bindings: (Array.isArray(result?.bindings) ? result.bindings : [])
    .filter((binding) => typeof binding?.command === 'string' && (typeof binding.key === 'string' || binding.key === null))
    .map(({ command, key }) => ({ command, key })) };
}

function register(hooks) {
  hooks.onAreaOp('commands', async (op, args) => {
    if (op === 'catalog') return commandCatalog();
    if (op === 'keymap') {
      const { svc } = kit.service(hooks, 'commandKeybindings', ['get']);
      return bindingsOf(await kit.withTimeout(svc.get()));
    }
    if (op === 'rebind' || op === 'reset') {
      if (typeof args.commandId !== 'string' || !args.commandId || args.commandId.length > 200) throw kit.refusal('a command id of at most 200 characters is needed');
      if (op === 'rebind' && (typeof args.keys !== 'string' || !args.keys || args.keys.length > 200)) throw kit.refusal('shortcut keys of at most 200 characters are needed');
      const { svc } = kit.service(hooks, 'commandKeybindings', ['get', 'update']);
      const update = op === 'reset' ? { type: 'reset' } : typeof args.previous === 'string'
        ? { type: 'replace', previousAccelerator: args.previous, accelerator: args.keys }
        : { type: 'set', accelerator: args.keys };
      await kit.withTimeout(svc.update({ commandId: args.commandId, update }));
      // The Keyboard shortcuts page reads the keymap through its own query; the app's page refreshes it after its writes, so this does too.
      try { await kit.invalidate(hooks, [['vscode', 'codex-command-keymap-state']]); } catch { /* the keymap changed; the page catches up on its next read */ }
      return bindingsOf(await kit.withTimeout(svc.get()));
    }
    if (op === 'run') {
      if (args.kind === 'electron-only') {
        const { svc } = kit.service(hooks, 'applicationMenu', ['getSnapshot', 'invokeItem']);
        const snapshot = await kit.withTimeout(svc.getSnapshot());
        const pending = Object.values(snapshot ?? {});
        while (pending.length) {
          const item = pending.pop();
          if (item?.nativeCommandId === args.commandId) {
            await kit.withTimeout(svc.invokeItem(args.commandId));
            return {};
          }
          if (Array.isArray(item?.items)) pending.push(...item.items);
        }
        throw kit.refusal("it runs from the app's own menu only");
      }
      const { winId } = kit.windowServices(hooks);
      kit.runCommand(hooks, winId, args.commandId);
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
