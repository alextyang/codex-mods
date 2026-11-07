# Split view (`codexmods.multi-panel`)

Two or more chats open at once (GOAL.md goal 19), with no split-view code in the core.

## What it does

- **The split view**: a region at the window's right edge, beside the chat you are in and the sidebar, with one to three panes (setting
  `panes`, two by default). Each pane is one of your chats, live, with its own composer, approvals and questions (`ui.host.thread`).
  Drag a chat from the sidebar onto a pane, or choose **Open in split view** in a chat's menu or the palette: it goes to the first empty
  pane, or takes the last one. Drag the line between two panes to share their height. Each pane's menu opens its chat in the main view or
  closes the pane. The panes and their sizes are kept in this mod's storage, so they come back after a relaunch and follow in every window.
- **Open chat beside**: `CmdOrCtrl+\`, the palette, and a chat's context menu. The framework opens the chat as a tab of the app's own side
  panel (`Window.open(thread, {placement: 'side'})`), kept with the chat you are in.
- **Show or hide split view**: `CmdOrCtrl+Shift+\`. **Next pane** and **Previous pane** move the keyboard between the chat you are in and the
  panes (`Window.focusPane`).
- The keys follow the setting `keyboardShortcut` (default on); with it off the commands stay in the palette without keys.
- When the window cannot do what was asked, the mod says so in a toast.

**Permissions:** `ui`, `graph`, `graph.read` (the chats it shows, the window's regions), `graph.act:Window.open,Window.setRegion,
Window.focusPane,Thread.open` and `graph.present:Palette,Menu,Window` (the commands, their menu entries, the region).
