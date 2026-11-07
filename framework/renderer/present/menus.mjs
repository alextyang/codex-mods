// The thread menus (docs/design/presentations.md V7: a rule, not a Presentation instance). The app builds the sidebar row's and the thread
// header's menus for its own chats, and the menus seam passes their items through the kernel's `menuItems(args, items)`: the mods' part
// rules on the app's entries, the mods' choices of external apps, then the mods' own entries. A chat the app does not hold has the menu
// of the row the framework draws for it (bindings/sidebar-sections.mjs: the shared actions it supports, graph-integrity G2.1). NO NODE API.

import { applyParts } from './rules.mjs';
import { applyChoices, madeOf } from './choices.mjs';

/** The app's thread and project menu item ids (21477) and the parts they are (public-hooks.md §3.10, framework/shared/parts.mjs). */
export const MENU_PARTS = Object.freeze({
  'rename-thread': 'rename', 'pin-thread': 'pin', 'unpin-thread': 'pin', 'mark-thread-read': 'markUnread', 'mark-thread-unread': 'markUnread',
  'move-thread-to-project': 'moveToProject', 'move-to-custom-section': 'moveToSection', 'open-side-chat': 'newSideChat', fork: 'fork',
  'scheduled-task': 'automate', 'share-thread': 'share', 'copy-actions': 'copy', 'copy-deeplink': 'copyLink',
  'copy-conversation-markdown': 'copyMarkdown', 'copy-working-directory': 'copyPath', 'open-workspace-in': 'openIn',
  'open-in-new-window': 'openInNewWindow', 'archive-thread': 'archive', 'delete-thread': 'delete',
  'pin-project': 'pin', 'unpin-project': 'pin', 'edit-project': 'edit', 'reveal-project-folder': 'revealFolder',
  'new-chat-in-project-worktree': 'newChatInWorktree', 'edit-connection': 'editConnection', 'mark-project-threads-read': 'markRead',
  'archive-project-threads': 'archiveChats', 'remove-project': 'remove',
});
const partOfItem = (x) => (x && typeof x.id === 'string' ? MENU_PARTS[x.id] ?? null : null);
const SUBMENU_KEYS = ['items', 'children', 'submenu', 'additionalItems'];
/** A menu entry relabelled by a mod (its label only: the app draws its own icon). */
const relabelItem = (x, { label }, rule) => (typeof label === 'string' && label.trim()
  ? { ...x, message: { id: `codexmods:label:${rule.mod}/${rule.id}/${x.id}`, defaultMessage: label.trim(), description: `${rule.mod}: a mod's label for the app's entry` } }
  : x);
/**
 * A menu's app entries with the mods' part rules applied (hide, relabel, reorder), in its submenus too; separators tidied once entries
 * are gone. No rule: the items as they are.
 */
export function withParts(items, partRules) {
  if (!Array.isArray(items) || !Array.isArray(partRules) || !partRules.length) return items;
  const walk = (list) => tidy(applyParts(partRules, 'items', list, partOfItem, relabelItem).map((x) => {
    const key = x && typeof x === 'object' ? SUBMENU_KEYS.find((k) => Array.isArray(x[k])) : undefined;
    return key ? { ...x, [key]: walk(x[key]) } : x;
  }));
  return walk(items);
}

/** The external app (ExternalApp, `ui.choices`) an "Open in" entry opens: a thread's (`open-workspace-in-<id>`), a file's (`<menu>-target-<id>`). */
const targetOf = (x) => {
  const id = x && typeof x.id === 'string' ? x.id : null;
  const m = id ? /^open-workspace-in-(.+)$/.exec(id) ?? /-target-(.+)$/.exec(id) : null;
  return m ? m[1] : null;
};
/**
 * A menu's "Open in" entries with the mods' choices of external apps (public-hooks.md §3.11): in each list of them (a thread's "Open in",
 * a file's), hidden, ordered and relabelled by the app's target id, the mods' entries after them (their choice runs the mod's callback).
 * The menus' other entries (a file's "Open in <preferred>") stay as they are.
 */
export function withOpenIn(items, plan, env = {}) {
  if (!plan || !Array.isArray(items)) return items;
  const walk = (list) => {
    const mapped = list.map((x) => {
      const key = x && typeof x === 'object' ? SUBMENU_KEYS.find((k) => Array.isArray(x[k])) : undefined;
      return key ? { ...x, [key]: walk(x[key]) } : x;
    });
    if (!mapped.some((x) => targetOf(x) != null)) return mapped;
    const sample = mapped.find((x) => targetOf(x) != null);
    return applyChoices(mapped, plan, {
      idOf: targetOf, instanceOf: (x) => madeOf('ExternalApp', targetOf(x), { title: x.message?.defaultMessage }),
      relabel: (x, l) => (l.title ? { ...x, message: { id: `codexmods:choice:${x.id}`, defaultMessage: l.title }, messageValues: undefined } : x),
      // a mod's entry runs with what the menu was opened on (the chat, or the file's path)
      make: (a) => ({ ...(sample.type ? { type: sample.type } : {}), id: a.id, message: { id: `codexmods:choice:${a.id}`, defaultMessage: a.title }, onSelect: () => a.run?.(env) }),
    });
  };
  return walk(items);
}

const isSeparator = (x) => !!x && x.type === 'separator';
/** No separator first, last or twice in a row once entries are gone; of two in a row the second stays (it heads the group after). */
function tidy(items) {
  const out = [];
  for (const x of items) {
    if (isSeparator(x) && !out.length) continue;
    if (isSeparator(x) && isSeparator(out[out.length - 1])) { out[out.length - 1] = x; continue; }
    out.push(x);
  }
  while (out.length && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

/**
 * @param {(args: object) => object[][]} [extra]  the mods' entries for this menu (docs/design/systems.md E2), in groups (one per rule, E7.3),
 *   each after a separator
 * @param {(args: object) => object[]} [partsFor]  the mods' rules on the menu's own entries (public-hooks.md §3.10)
 * @returns {(args: object, items: object[]) => object[]}
 */
export function threadMenus(extra = () => [], partsFor = () => []) {
  return (args, items) => {
    let own = items;
    try { own = withParts(own, partsFor(args)); } catch { /* a rule's fault is its own: the app's entries as they were */ }
    let groups;
    try { groups = extra(args) ?? []; } catch { groups = []; }
    return withGroups(own, groups);
  };
}

/** A menu's items with the mods' groups after the app's own, each behind a separator of its own (an id: the app's DOM menu keys by it). */
export function withGroups(items, groups) {
  const added = (Array.isArray(groups) ? groups : []).filter((g) => Array.isArray(g) && g.length);
  if (!added.length) return items;   // the app's own items as they are
  const out = [...items];
  added.forEach((g, i) => out.push({ id: `codexmods:separator:${i}`, type: 'separator' }, ...g));
  return out;
}
