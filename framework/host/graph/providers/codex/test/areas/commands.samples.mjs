// Every branch of Command and Shortcut data (breadth step D6), including both link directions, for realizes.test.mjs.
import { commandData, shortcutsData } from '../../areas/commands.mjs';

export function produced() {
  return [
    [{ id: 'archiveThread', title: 'Archive chat', group: 'thread', kind: 'webview', defaults: ['Command+E', 'Control+E'] }, { bindings: [] }],
    [{ id: 'app.thread1', title: null, group: null, kind: 'electron-only', defaults: [] }, {}],
    [{ id: 'editor.action', kind: 'vscode-only', defaults: ['F1'] }, { bindings: [{ command: 'other', key: 'F3' }, { command: 'editor.action', key: null }, { command: 'editor.action', key: 'F2' }] }],
    [{ id: 'unbound', title: '', group: '', kind: null, defaults: ['F4'] }, { bindings: [{ command: 'unbound', key: null }] }],
  ].flatMap(([entry, keymap]) => {
    const command = commandData(entry), shortcuts = shortcutsData(entry, keymap);
    command.links.shortcut = shortcuts[0]?.ref ?? null;
    return [command, ...shortcuts];
  });
}
