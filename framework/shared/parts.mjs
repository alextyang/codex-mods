// The app's own parts (docs/design/public-hooks.md §3.10): the kinds of entry the app draws in a component's slot, named in the user's
// words, whatever the build. A part is a kind (never an instance): "Delete" in a chat's menu, the dictate button in every composer. A
// build's bindings say which parts they support (addresses.json `parts`) and map each to what that build draws; the rules name parts:
//   ui.hide(C, {part})          not drawn
//   ui.decorate(C, {part, label?, icon?, tooltip?})   relabelled
//   ui.replace(C, {part, render})                     drawn by the mod's component (renderer realm)
//   ui.reorder(C, {slot, order: [part names]})        the named ones first, in that order; the others after, as they were
// Protected parts are never hidden, relabelled or replaced (a pending effect, a way out, the framework's own); a request's optional scopes
// may be hidden, never reworded. A component that holds a protected part is never hidden or replaced as a whole. NO NODE API.

/** presentation -> slot -> part -> { title, for?: subject concepts the part is drawn for, operation?, protected?, optional? } */
export const PARTS = Object.freeze({
  Menu: {
    items: {
      // a chat's menu (its sidebar row's and its header's)
      rename: { title: 'Rename', for: ['Thread'], operation: 'rename' },
      pin: { title: 'Pin or unpin', for: ['Thread', 'Project'], operation: 'pin' },
      markUnread: { title: 'Mark as read or unread', for: ['Thread'], operation: 'markUnread' },
      moveToProject: { title: 'Move to project', for: ['Thread'] },
      moveToSection: { title: 'Move to section', for: ['Thread', 'Project'] },
      newSideChat: { title: 'Open side chat', for: ['Thread'] },
      fork: { title: 'Fork', for: ['Thread'], operation: 'fork' },
      automate: { title: 'Add scheduled task', for: ['Thread'], operation: 'automate' },
      share: { title: 'Share chat', for: ['Thread'] },
      copy: { title: 'Copy', for: ['Thread'] },
      copyLink: { title: 'Copy link', for: ['Thread'] },
      copyMarkdown: { title: 'Copy as Markdown', for: ['Thread'], operation: 'export' },
      copyPath: { title: 'Copy working directory', for: ['Thread'] },
      openIn: { title: 'Open in', for: ['Thread'] },
      openInNewWindow: { title: 'Open in new window', for: ['Thread'] },
      archive: { title: 'Archive', for: ['Thread'], operation: 'archive' },
      delete: { title: 'Delete', for: ['Thread'], operation: 'delete' },
      // a project's menu (its sidebar group's)
      edit: { title: 'Edit', for: ['Project'] },
      revealFolder: { title: 'Show in Finder', for: ['Project'], operation: 'reveal' },
      newChatInWorktree: { title: 'New chat in a worktree', for: ['Project'] },
      editConnection: { title: 'Edit connection', for: ['Project'] },
      markRead: { title: 'Mark chats as read', for: ['Project'] },
      archiveChats: { title: 'Archive chats', for: ['Project'] },
      remove: { title: 'Remove project', for: ['Project'], operation: 'remove' },
    },
  },
  TitleBar: {
    actions: {
      sidebarToggle: { title: 'Show or hide the sidebar' },
      history: { title: 'Back and forward' },
      newChat: { title: 'New chat' },
      threadActions: { title: 'The chat\'s actions' },
      workspaceControls: { title: 'Layout and panels' },
      newTab: { title: 'New tab in the side panel' },
      bottomPanelToggle: { title: 'Show or hide the bottom panel' },
      sidePanelClose: { title: 'Close the side panel' },
    },
  },
  // the panels' tab kinds (layouts.md §4.1; scout wl2-tab-kinds.md §4.2): hidden in that panel (a tab that needs the user stays) and ordered
  // in its new-tab launcher; the New tab page, a saved tab's placeholder and the framework's own kind are never parts
  SidePanel: {
    kinds: {
      files: { title: 'Files' }, changes: { title: 'Changes' }, terminal: { title: 'Terminal' }, browser: { title: 'Browser' },
      sideChat: { title: 'Side chat' }, desktop: { title: 'Desktop' }, newPage: { title: 'New page' }, apps: { title: 'Apps' },
      plan: { title: 'Plan' }, subagents: { title: 'Subagents' }, goal: { title: 'Goal' },
    },
  },
  BottomPanel: {
    kinds: { terminal: { title: 'Terminal' } },
  },
  Sidebar: {
    // the app's groups of chats (layouts.md §4.1, D9; scout wl2-groups-footer.md §1): hidden (a group holding a chat that needs the user stays)
    // or ordered while the user has placed none of them; the user's custom sections are theirs, not parts
    groups: {
      pinned: { title: 'Pinned chats' },
      projects: { title: 'Projects' },
      chats: { title: 'Recent chats' },
      agents: { title: 'Agents' },
    },
    // the app's banners and buttons in the sidebar's footer (layouts.md §4.1; scout wl2-groups-footer.md §2): the account control is also
    // the way to settings, and the update button the way to install the app's update: never hidden
    footerParts: {
      account: { title: 'Account and settings', protected: true },
      update: { title: 'Update button', protected: true },
      usage: { title: 'Usage alert' },
      gettingStarted: { title: 'Getting-started checklist' },
      announcement: { title: 'Update announcement' },
      updateBanner: { title: 'Time-to-update banner' },
      invite: { title: 'Invite team members' },
    },
  },
  SidebarItem: {
    indicators: {
      status: { title: 'Working, waiting or error mark' },
      unread: { title: 'Unread mark' },
      time: { title: 'Time' },
      activeDot: { title: 'Active mark' },
      automation: { title: 'Event subscriptions mark' },
    },
    hover: {
      pin: { title: 'Pin', operation: 'pin' },
    },
  },
  MessageBlock: {
    actions: {
      copy: { title: 'Copy response' },
      fork: { title: 'Fork from here', operation: 'fork' },
      edit: { title: 'Edit message' },
    },
  },
  StepBlock: {
    // the row of one of the app's own steps (public-hooks.md §3.15): what each kind draws
    row: {
      icon: { title: 'Icon' },
      details: { title: 'Chevron and what it opens (a command\'s output, a file\'s inline diff)' },
      duration: { title: 'Duration (a command\'s)' },
      app: { title: 'Inline app (an MCP tool call\'s)' },
      code: { title: 'Code blocks (reasoning\'s)' },
    },
  },
  Palette: {
    // the app's command groups (a Command's `category`), in the order the palette draws them; their commands are hidden by
    // ui.hide('Command', {where: {category}})
    groups: {
      thread: { title: 'Chat' },
      navigation: { title: 'Navigation' },
      panels: { title: 'Panels' },
      workspace: { title: 'Project' },
      skills: { title: 'Skills' },
      configure: { title: 'Configure' },
      app: { title: 'App' },
    },
    // the app's commands in their group, named by their Command id (not listed here: every command the app has)
    commands: {},
  },
  RequestCard: {
    answers: {
      allowOnce: { title: 'Allow once', protected: true },
      allowThread: { title: 'Allow for this chat', optional: true },
      allowAlways: { title: 'Always allow', optional: true },
      deny: { title: 'Deny', protected: true },
    },
  },
  Composer: {
    toolbar: {
      attach: { title: 'Add files and more' },
      dictate: { title: 'Dictate' },
      send: { title: 'Send' },
      stop: { title: 'Stop', protected: true },
    },
    pickers: {
      model: { title: 'Model and effort' },
      access: { title: 'Access' },
      runLocation: { title: 'Where it runs' },
      branch: { title: 'Branch' },
    },
    aboveInput: {
      attachments: { title: 'Attachments', protected: true },
      queue: { title: 'Queued messages', protected: true },
    },
  },
});

/** Components that hold a protected part: never hidden or replaced as a whole. */
export const PROTECTED_HOLDERS = Object.freeze(new Set(['Window', 'ThreadView', 'NewThreadView', 'Composer', 'RequestCard', 'QueueItem',
  // the sidebar: its groups, the chats that need the user in them and its footer's account and settings (layouts.md D9); a group hidden
  // or replaced whole keeps such a chat (its binding's `keeps`)
  'Sidebar']));
/** The rule kinds that take a part, and what each does to one. */
export const PART_KINDS = Object.freeze(new Set(['hide', 'decorate', 'replace', 'reorder']));
const RELABEL_FIELDS = new Set(['label', 'icon', 'tooltip']);

/** The parts of a component (in one slot, or all), as reflection gives them: [{slot, part, title, for?, operation?, protected?, optional?}]. */
export function partsOf(presentation, slot) {
  const slots = PARTS[presentation] ?? {};
  const out = [];
  for (const [s, parts] of Object.entries(slots)) {
    if (slot !== undefined && s !== slot) continue;
    for (const [part, info] of Object.entries(parts)) out.push({ slot: s, part, ...info });
  }
  return out;
}

/** The slot a part is in (the one given, or the only one that has it), or null. */
export function slotOfPart(presentation, part, slot) {
  const slots = PARTS[presentation] ?? {};
  if (slot !== undefined) return slots[slot]?.[part] ? slot : null;
  const found = Object.keys(slots).filter((s) => slots[s][part]);
  return found.length === 1 ? found[0] : null;
}

/**
 * Why a rule on parts is refused, or null: `{kind, presentation, slot?, part?, data?}` (a reorder names its parts in `data.order`).
 * Also refuses hiding or replacing a protected holder as a whole.
 */
export function partRuleWhy({ kind, presentation, slot, part, data }) {
  if (part === undefined) {
    if ((kind === 'hide' || kind === 'replace') && PROTECTED_HOLDERS.has(presentation)) {
      return `${presentation} holds protected parts (public-hooks.md §3.10): hide or replace its parts, never the whole of it`;
    }
    if (kind === 'reorder' && Array.isArray(data?.order)) {
      for (const name of data.order) {
        if (typeof name !== 'string') return 'a reorder\'s order names parts (or a mod\'s entries) as strings';
      }
    }
    return null;
  }
  if (!PART_KINDS.has(kind)) return `a ${kind} rule takes no part`;
  if (kind === 'reorder') return 'a reorder names its parts in order, not in part';
  const names = Array.isArray(part) ? part : [part];
  if (!names.length || names.length > 32 || !names.every((n) => typeof n === 'string' && n)) return 'part is a part name or a list of them (at most 32)';
  for (const name of names) {
    const s = slotOfPart(presentation, name, slot);
    if (!s) return `${presentation} has no part ${name}${slot !== undefined ? ` in ${slot}` : ''} (ui.parts lists them)`;
    const info = PARTS[presentation][s][name];
    if (info.protected) return `${presentation} ${name} is protected: it is never hidden, relabelled or replaced`;
    if (info.optional && kind !== 'hide') return `${presentation} ${name} may be hidden, never relabelled or replaced`;
  }
  if (kind === 'decorate') {
    const keys = Object.keys(data ?? {});
    if (!keys.length || !keys.every((k) => RELABEL_FIELDS.has(k))) return 'a decoration of a part relabels it: label, icon or tooltip';
  }
  return null;
}
