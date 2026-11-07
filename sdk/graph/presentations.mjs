// The presentation types (docs/graph/03-presentations.md; docs/design/systems.md S10, "E2c in detail"): the Presentation concept, the Window
// (the root of a window's presentations) and the presentation types the framework's bindings present, with the builders a mod uses
// (define.mjs). E7 adds the others with their bindings. They belong to the base graph, as 02's types do (owner `native`): they are not the
// framework's own instances (07, S4), so a mod reads and acts on them with the graph's grants. What is particular to these cards:
// - Presentation.subject is a relation to an instance of any type (`ANY_TYPE`), so the store's inverse index gives every instance its
//   `presentations` relation (04 §8), which the graph serves for every type.
// - Two members S10 adds to the card: `visible?` (only where a binding can tell it: mounted is not visible) and `order?` (its place in its
//   parent's slot, where its binding knows it).
// - A decoration is {by: the mod, kind, rule: the rule's id}.
// - Window's arrangement (docs/design/layouts.md §4, WL1): its navigation, sidebar, side and bottom panels and its layout, as its page shows
//   them; a size is there where the page can tell it.
// - Window.current and history are refs to any type, and Window.open, Composer.insert and FilesView.select take one: any JSON here (the
//   schemas have no union).
import { ANY_TYPE, defineConcept, defineSubtype, ev, op, r, s } from './define.mjs';

export const Presentation = defineConcept('Presentation', {
  state: {
    slot: s.string(),
    hidden: s.boolean(),
    decorations: s.list(s.object({ by: s.string(), kind: s.enum('badge', 'icon', 'label', 'tooltip', 'action'), rule: s.string() })),
    visible: s.boolean().optional(),
    order: s.number().optional(),
    selected: s.boolean().optional(),
    // its user-visible state, where its binding can tell (graph-integrity G5.1), each set by the operations the user performs: expanded
    // (`_expand`, `_collapse`), focused (the user is in it: a pane's chat, a window) and its size in px (`_resize`); a panel's `open`
    // (`_open`, `_close`) is its own
    expanded: s.boolean().optional(),
    focused: s.boolean().optional(),
    size: s.object({ width: s.number().optional(), height: s.number().optional() }).optional(),
  },
  relations: {
    subject: r.one(ANY_TYPE),
    window: r.maybe('Window'),
    parent: r.maybe('Presentation'),
    children: r.many('Presentation').inverse('parent'),
  },
  events: {
    shown: ev(),
    hidden: ev(),
    selected: ev(),
    acted: ev(s.object({ operation: s.string(), action: s.string().optional() })),   // a user action on it, with the operation it ran
  },
});

export const Window = defineSubtype(Presentation, 'Window', {
  state: {
    current: s.json(), // a ref: what the main region shows (null until known)
    // what it presents now (graph-integrity G4.3): its main region's subject, then each pane's chat; `focusedSubject` the one the user is
    // in (a pane's when one has focus, else its main region's). Its own `focused`: the app's window the user is in (G5.1).
    shows: s.list(s.json()).optional(),
    focusedSubject: s.json().optional(),
    // its title bar's title and its place on the screen, in points (G5.5); its `size` the window's outer size
    title: s.string().optional(),
    position: s.object({ x: s.number(), y: s.number() }).optional(),
    history: s.list(s.json()), // refs
    navigation: s.enum('sidebar', 'rail', 'rail-and-sidebar').optional(),   // the sidebar alone, the app's rail alone, or the rail beside it
    sidebar: s.object({ open: s.boolean(), width: s.number().optional(), edge: s.enum('right').optional() }),   // edge: at the right (layouts.md WL4c); absent: the app's left
    side: s.object({ open: s.boolean(), size: s.number().optional(), full: s.boolean().optional() }),   // the side panel (the app keeps it per thread)
    // the bottom panel: below the chat its height; beside it (layouts.md WL4b) `at` left or right, and its width
    bottom: s.object({ open: s.boolean(), height: s.number().optional(), width: s.number().optional(), at: s.enum('left', 'right').optional() }),
    layout: s.object({ mode: s.enum('chat', 'split', 'full').optional(), picked: s.string().optional(), partial: s.list(s.object({ region: s.string(), why: s.string() })).optional(), released: s.list(s.string()).optional() }).optional(),   // the chat alone, beside its tabs, or its tab filling the workspace
    suspended: s.list(s.string()).optional(),   // what the framework holds for space now (layouts.md D12): '<mod>/<id>', bottom, side, sidebar
    panes: s.list(s.object({ token: s.string(), thread: s.json() })).optional(),   // the chats it hosts in a mod's place (ui.host.thread, layouts.md D8), each a pane
    activePane: s.string().optional(),   // the pane the user is in; absent: the window's own page
    page: s.string().optional(),   // the mod's page it shows, '<mod>/<id>' (ui.pages.add, layouts.md D7)
    regions: s.json().optional(),   // the mods' regions as drawn: {'<mod>/<id>': {open, size?, edge, unsupported?: 'frame'}} (ui.regions.add, layouts.md WL4a)
    fullScreen: s.boolean(),
  },
  relations: {
    thread: r.maybe('Thread'),     // the chat it shows (its main region's), or none
    project: r.maybe('Project'),   // the project of what it shows: that chat's, the new chat's (the one it starts in), a project's own page
  },
  operations: {
    open: op({ args: [s.json(), s.json().optional()] }), // a ref to any type, or a mod's page {page: '<mod>/<id>'}; {placement?: 'main' | 'window' | 'side'}: here, in a new window, or a chat beside the one shown
    back: op(),
    forward: op(),
    close: op(),
    focus: op(),
    toggleSidebar: op(),
    togglePanel: op(),
    setSidebar: op({ args: [s.boolean()] }),   // open (true) or closed: nothing when it already is
    setPanel: op({ args: [s.boolean()] }),     // the right panel of the chat it shows, open or closed
    // how its workspace is laid out: the chat alone, the chat beside its tabs, or its tab filling it (the app's own layouts)
    setLayout: op({ args: [s.string()] }),   // the app's chat, split or full, or a mod's named layout '<mod>/<id>' (ui.layouts.add): done with {layout, partial}
    // one of its regions in this window now, never the sizes the app keeps (layouts.md D4): open or closed, and its size in px
    // (a mod's region by its '<mod>/<id>': ui.regions.add); the bottom panel's place too: below, or beside the chat at its left or right
    // (layouts.md WL4b: its size then its width); the sidebar's edge, left or right (WL4c: only where the app shows its rail)
    setRegion: op({ args: [s.string(), s.object({ open: s.boolean().optional(), size: s.number().optional(), at: s.enum('below', 'left', 'right').optional(), edge: s.enum('left', 'right').optional() })] }),
    openBrowser: op({ args: [s.url()], returns: r.one('BrowserTab') }),   // a page in a new tab of its in-app browser (http or https)
    openPalette: op({ args: [s.string().optional()] }),   // the app's palette in this window, searching the query (graph-layers.md §3.3)
    find: op({ args: [s.string(), s.json().optional()] }),   // the find bar of the chat this window shows; {pane?}: that hosted chat's (layouts.md D8)
    // the keyboard into one of its panes (G5.1): 'next' or 'previous' in their order on the page (its main region one of them), 'main', or
    // a pane's token (`panes`)
    focusPane: op({ args: [s.string()] }),
  },
  events: { opened: ev(), closed: ev(), navigated: ev() },
});

// Layouts WL1 (docs/design/layouts.md D1): the window's regions. The title bar (presents App: its slots are the app's six positions, its
// parts the app's own actions), the app's rail where the app shows it (App), the main region (what the window shows), the bottom panel
// (the chat it belongs to, open or closed). The sidebar and the side panel are Sidebar and SidePanel.
export const TitleBar = defineSubtype(Presentation, 'TitleBar', {});
export const Rail = defineSubtype(Presentation, 'Rail', {});
export const MainRegion = defineSubtype(Presentation, 'MainRegion', {});
// its `size` (its height below the chat; beside it, its width too) is the Presentation's
export const BottomPanel = defineSubtype(Presentation, 'BottomPanel', {
  state: { open: s.boolean(), at: s.enum('left', 'right').optional() },
});
// E7.3: the sidebar (presents App), its filter is not the app's (an exclusion candidate); the command palette while it is open.
export const Sidebar = defineSubtype(Presentation, 'Sidebar', {
  operations: { _filter: op({ args: [s.json()] }), _newThread: op() },
});
export const Palette = defineSubtype(Presentation, 'Palette', {
  operations: { _open: op({ args: [s.string().optional()] }), _close: op() },   // a query to search for
});
export const SidebarSection = defineSubtype(Presentation, 'SidebarSection', {
  operations: { _collapse: op(), _expand: op(), _showMore: op() },
});
export const SidebarItem = defineSubtype(Presentation, 'SidebarItem', {
  operations: { _select: op(), _rename: op() },
});
export const ThreadView = defineSubtype(Presentation, 'ThreadView', {
  operations: { _scrollTo: op({ args: [s.ref('Turn')] }), _jumpToLatest: op(), _find: op({ args: [s.string()] }) },
});
export const ThreadHeader = defineSubtype(Presentation, 'ThreadHeader', {
  operations: { _rename: op() },
});
// expanded: its steps unfolded
export const TurnView = defineSubtype(Presentation, 'TurnView', {
  operations: { _expand: op(), _collapse: op() },
});
export const MessageBlock = defineSubtype(Presentation, 'MessageBlock', {});
export const StepBlock = defineSubtype(Presentation, 'StepBlock', {
  operations: { _expand: op(), _collapse: op() },
});
export const RequestCard = defineSubtype(Presentation, 'RequestCard', {});   // its operations are the subject's own
export const Composer = defineSubtype(Presentation, 'Composer', {
  operations: { _focus: op(), _insert: op({ args: [s.json()] }) }, // text or a mention
});
export const Chip = defineSubtype(Presentation, 'Chip', {
  operations: { _open: op(), _remove: op() },
});
export const StatusItem = defineSubtype(Presentation, 'StatusItem', {
  operations: { _open: op() },
});
export const PaletteResult = defineSubtype(Presentation, 'PaletteResult', {
  operations: { _choose: op() },
});
export const FilesView = defineSubtype(Presentation, 'FilesView', {
  operations: { _select: op({ args: [s.json()] }), _filter: op({ args: [s.string()] }) }, // a ref to a file or a folder
});
export const NewThreadView = defineSubtype(Presentation, 'NewThreadView', {});
// E7.2: a queued follow-up (QueuedMessage) in its composer; `edit` puts it back in the composer, the others are its message's own.
export const QueueItem = defineSubtype(Presentation, 'QueueItem', {
  operations: { _edit: op(), _sendNow: op(), _remove: op(), _move: op({ args: [s.number()] }) },
});
// E7.4: the right side panel (presents the Thread), one of its tabs, a file's preview.
export const SidePanel = defineSubtype(Presentation, 'SidePanel', {
  state: { open: s.boolean().optional() },   // open or closed (its width the Presentation's `size`), as its window's arrangement says (G5.1)
  operations: { _open: op({ args: [s.json()] }), _close: op(), _resize: op({ args: [s.number()] }) },   // a ref: what to show in a tab
});
export const PanelTab = defineSubtype(Presentation, 'PanelTab', {
  operations: { _select: op(), _close: op(), _move: op({ args: [s.number()] }) },
});
export const FilePreview = defineSubtype(Presentation, 'FilePreview', {});
// E7.5: a terminal's view, the in-app browser's view.
export const TerminalView = defineSubtype(Presentation, 'TerminalView', {
  operations: { _focus: op(), _copySelection: op() },
});
export const BrowserView = defineSubtype(Presentation, 'BrowserView', {
  operations: { _focus: op() },
});
// E7.5b: the side panel's Changes (presents the chat's ChangeSet) and one file's diff (its FileChange). ReviewView has no presentation on
// 21477 (its findings show only as cards in the diffs).
export const ChangesView = defineSubtype(Presentation, 'ChangesView', {
  operations: { _selectFile: op({ args: [s.json()] }), _setScope: op({ args: [s.enum('thread', 'turn', 'uncommitted')] }) },   // a FileChange (or a File)
});
export const DiffView = defineSubtype(Presentation, 'DiffView', {
  state: { layout: s.enum('unified', 'split').optional() },   // absent while the app picks by width
  operations: { _commentOn: op({ args: [s.json()] }), _setLayout: op({ args: [s.enum('unified', 'split')] }), _openFile: op() },   // {start, end?, side?}
});
export const SettingsPage = defineSubtype(Presentation, 'SettingsPage', {});
export const Region = defineSubtype(Presentation, 'Region', {});   // a mod's region at the workspace's edge (ui.regions.add, layouts.md D10): its subject the Mod; its size and edge in the Window's `regions`
export const Page = defineSubtype(Presentation, 'Page', {});   // a mod's own page in the main region (ui.pages.add, layouts.md D7): its subject the Mod
// E7.6: an automation's view (its operations are the Automation's own).
export const AutomationView = defineSubtype(Presentation, 'AutomationView', {});
export const Menu = defineSubtype(Presentation, 'Menu', {});
// The framework's own presentations (docs/design/systems.md E6 decision 6, E6.5): reported read-only by the framework's pages, Dialogs,
// band and composer pickers; no one acts on what the framework renders ("E7 in detail" decision 6). ComposerPicker is also the app's own
// pickers (E7.2: open, and choose, the setting's own set).
export const SettingsRow = defineSubtype(Presentation, 'SettingsRow', {});
// A mod's Dialog (E7.6c, decision 7) is settled by the mod that asked: confirm chooses its first action. The framework's own take no act.
export const Dialog = defineSubtype(Presentation, 'Dialog', {
  operations: { _confirm: op(), _cancel: op() },
});
// A desktop notification's banner (E7.6b): open and dismiss are its Notification's own. The framework's band lines are its own (no act).
export const NotificationBanner = defineSubtype(Presentation, 'NotificationBanner', {
  operations: { _open: op(), _dismiss: op() },
});
export const ComposerPicker = defineSubtype(Presentation, 'ComposerPicker', {
  operations: { _open: op(), _choose: op({ args: [s.json()] }) },   // a value of the setting it shows
});
export const DetailView = defineSubtype(Presentation, 'DetailView', {});
// E7.6b: the app's badge in the Dock (presents the App, outside any window): a mod's value while it holds it (decision 5). `_attention`
// (public-hooks.md §3.14): the Dock icon bounces, once or until the app comes forward.
export const DockBadge = defineSubtype(Presentation, 'DockBadge', {
  operations: {
    // a count, text, {add: count} (the app's own and that), or null to let go; the caller's badge of that key (one mod may hold several)
    _set: op({ args: [s.json(), s.string().optional()] }),
    _attention: op({ args: [s.enum('informational', 'critical')] }),
  },
});

// E8.4b: one of the app's own menu bar entries (outside any window): its Command where its title names one, else the App; choose is a click
// on it. The system's (roles) and the protected ones (Settings, Quit, About) are never reported.
export const MenuEntry = defineSubtype(Presentation, 'MenuEntry', {
  state: {
    title: s.string(),
    menu: s.string(), // its menu's labels, "File › Open Recent"
    shortcut: s.string().optional(), // its accelerator, as the app names it
    enabled: s.boolean(),
    checked: s.boolean().optional(), // a check or radio entry
  },
  operations: { _choose: op() },
});

// H7s (public-hooks.md §3.13): a subject's entry in one of the app's own lists outside the sidebar and settings (a Skill's card on the
// Skills page, a Model's label in the model picker), where a mod's badges sit beside it.
export const ListItem = defineSubtype(Presentation, 'ListItem', {});
// H7x: a plan's tab in the side panel (its turn's plan), where a mod's actions sit in its header.
export const PlanView = defineSubtype(Presentation, 'PlanView', {});

/** Every definition, the concept first. */
export const PRESENTATION_TYPES = Object.freeze([
  Presentation, Window, TitleBar, Rail, MainRegion, BottomPanel, Sidebar, Palette, SidebarSection, SidebarItem, ThreadView, ThreadHeader, TurnView, MessageBlock, StepBlock, RequestCard, Composer,
  Chip, StatusItem, PaletteResult, FilesView, NewThreadView, QueueItem, SidePanel, PanelTab, FilePreview, TerminalView, BrowserView, AutomationView, ChangesView, DiffView, SettingsPage, Page, Region, Menu, SettingsRow, Dialog, NotificationBanner, ComposerPicker, DetailView, DockBadge, MenuEntry, ListItem, PlanView,
]);
