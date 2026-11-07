# 03 Presentations

What is on screen is part of the graph. Each presentation is an instance of a **presentation type**, shows one **subject** (an instance from
02), and sits in a slot of its parent. The **shared surfaces** (the sidebar, search, the palette, notifications, the title, the Dock, the
new-chat agent picker) render **concepts**, so every subtype of a concept, native or from a mod, joins them. A **main view** is its
provider's: the app's own for Codex's instances, the view a mod registers for its own (README rule 4). The app's conversation components are
lent to mods as parts for those views (graph-integrity.md G2.3).

**Declared into, not held** (README rule 7, graph-layers.md). A presentation type is a component: a mod
declares what goes into it (a slot's entries, a decoration, a region, a renderer), with `ui.*`, and the declaration applies to every
instance, now and later, in every window. The instances themselves (their refs, their tree, the operations and state on the cards below)
are the **mechanism** layer: readable and callable through `ui._read` and `ui._act`, kept while they work, never promised. The **Window**
is the exception: an OS window the user can name, addressable with its operations. What a mod does through an instance it does through
data (`Draft.insert`, `Thread.rename`, `Window.open(ref)`) or a declaration; graph-layers.md §2 has the table, §3.4 the places each
subject's decorations draw in.

Card format:

```
## Name                                           presentation
Purpose     what it is for, in the user's terms
Presents    the concepts it shows (and so every subtype of them)
In          its parent presentation
Shows       what it draws from its subject
Contains    its child presentations
Slots       named places where others add content (04 §8)
Parts       the app's own entries in its slots, by name (public-hooks.md §3.10: `ui.parts` lists them; protected ones marked)
State       its own state, when it has any
Operations  what it adds beyond the generic operations
Events      what it adds beyond the generic events
Notes       decisions and boundaries
```

A card's `Presents` lists its subjects. A type's `Presented` line in 02 also lists the presentations that show it as part of another
subject: a thread's header shows its project and branch.

---

## Presentation                                    concept
Purpose     Something on screen that shows an instance of the graph.
Subtypes    the presentation types below; mod-defined (for example a new panel tab or a new kind of row)
Identity    window + parent + slot + subject
State       slot: string · hidden: boolean (hidden through hide()) · decorations: [{ by, kind: badge | icon | label | tooltip | action, rule }]
            · visible?: boolean (on screen now, where its binding can tell: mounted is not visible) · order?: number (its place in the
            slot, where its binding knows it) · selected?: boolean · expanded?: boolean · focused?: boolean (the user is in it: a window, a
            pane's chat) · size?: { width?, height? } (px) — its user-visible state, each where a binding can tell it, set by the user's
            operations (`_expand`, `_collapse`, `_focus`, `_resize`); a panel's `open` is its own (graph-integrity G5.1)
Defaults    a mod's `defaults({of: <type>, for?, where?, state: {expanded}})`: whether a new one is expanded until the user chooses, run
            once as it appears as that mod's `_expand` or `_collapse` (where its state differs or the app decides it by itself), never over
            what the user chose for it in that window (G5.2). Sizes and open panels are the app's to keep.
Operations  the generic operations (below)
Events      shown · hidden · selected · acted (a user action on it, with the operation it ran)
Relations   subject: Ref (1) · window: Window (0..1) (none for desktop notifications and the Dock) · parent: Presentation (0..1)
            · children: Presentation (*)
Extension   subtype · provide (a mod's presentation type shows its subjects) · attach · decorate · intercept (the operations a user action
            runs) · replace (render chosen subjects its own way)

**Generic operations**, on every presentation:

| Operation | Meaning |
|---|---|
| **_read** | What is shown, where and in what order: the tree of presentations in a window. |
| **add** | Place instances in a slot, one by one or by a rule ("every thread tagged X, in this section"). |
| **decorate** | Add a badge, an icon, a label suffix, a tooltip or an action to a presentation. |
| **replace** | Render a presentation, or a slot, your own way, for chosen subjects. |
| **hide** | Remove a presentation from view without touching its subject. |
| **reorder** | Change the order in a slot. |
| **_act** | Do what the user can do on it: select, open, expand, run one of its actions. The outcome and the origin are recorded as for the user. |
| **style** | Adjust appearance within the theme's tokens. |
| **host** | Place custom UI, built from the app's components, in a slot. |

**Rules:**
- **Concept rendering, in shared surfaces.** A shared surface draws on its subject's core, its standard optional members when present, and
  its summary (04 §8). Unsupported operations are not offered, and no provider's identity decides what is offered.
- **A subtype in shared surfaces** adds its marks by decoration (its row's badges, its own menu entries): presentation rules scoped to it.
- **A subtype's own content** (its kinds of Step and Request) is drawn in its own view, with the lent parts and their body slots.
- **Native placement.** Each card says what the app places natively. `add` places more.
- **Main views.** `Window.open(ref)` shows the main view of the instance's type in the main region: the app's own for its types, the view a
  mod registers for its subtypes and the concepts it defines. A type with none has no main view. The DetailView is a developer inspector,
  shown in developer mode, not a fallback.

## The tree

```
Window
├─ TitleBar ─ StatusItem · MenuEntry (toolbar)
├─ Rail (where the app shows it)
├─ Sidebar
│  ├─ SidebarSection (*) ─ SidebarItem (*)
│  └─ footer ─ StatusItem
├─ MainRegion: one main view
│  ├─ ThreadView
│  │  ├─ ThreadHeader
│  │  ├─ TurnView (*) ─ MessageBlock (*) ─ ContentView, Chip
│  │  │                ├ StepBlock (*)
│  │  │                └ RequestCard (*)
│  │  └─ Composer ─ ComposerPicker (*) · Chip (*) · QueueItem (*) · StatusItem · Palette (slash and mention menus)
│  ├─ NewThreadView ─ Composer
│  ├─ AutomationView
│  ├─ SettingsPage ─ SettingsRow (*)
│  ├─ Page (a mod's own)
│  ├─ Region (a mod's own)
│  └─ DetailView (developer mode)
├─ SidePanel ─ PanelTab (*) ─ ChangesView ─ DiffView
│                           ├ ReviewView
│                           ├ TerminalView
│                           ├ BrowserView
│                           └ FilesView ─ FilePreview
├─ BottomPanel ─ PanelTab (*)
└─ overlays ─ Palette ─ PaletteResult (*) · Menu ─ MenuEntry (*) · Dialog · NotificationBanner (in-app)

Outside a window: Menu (the menu bar) · NotificationBanner (desktop) · DockBadge
```

---

## Window and navigation

## Window                                          presentation
Purpose     A Codex window.
Presents    App
Shows       its title from the current subject's summary and project
Contains    TitleBar · Rail · Sidebar · MainRegion · SidePanel · BottomPanel · overlays
Slots       status (a mod's statuses on every page, in the title bar's right position: `ui.status`) · banner (a mod's region in the app's
            page banner, above every page; regions beside the main one are the SidePanel's tabs)
State       current: Ref (what the main region shows) · shows: Ref (*) (what it presents now: its main region's subject, then each pane's
            chat) · focusedSubject?: Ref (the one of them the user is in: a pane's when one has focus) · focused?: boolean (the app's
            window the user is in) · title?: string (its title bar's) · position?: { x, y } · size?: { width, height } (on the screen, in
            points: G5.5) · page?: '<mod>/<id>' (the mod's page it shows) · history: Ref (*) · navigation?: sidebar | rail | rail-and-sidebar (the app's
            sidebar alone, its rail alone, or the rail beside the sidebar) · sidebar: { open, width?, edge? } (edge: right; absent: the app's
            left) · side: { open, size?, full? }
            (the side panel; an app may keep it per thread) · bottom: { open, height?, width?, at? } (below the chat its height; beside
            it, `at: left | right`, its width) · layout?: { mode: chat | split | full } (its workspace as the app shows it) · regions?: {
            '<mod>/<id>': { open, size?, edge, unsupported?: frame } } (the mods' regions beside the main view, as drawn: `ui.regions.add`)
            · fullScreen: boolean
Relations   thread: Thread (0..1) (the chat it shows) · project: Project (0..1) (the project of what it shows: that chat's, the one the new
            chat starts in, a project's own page)
Operations  open(ref | { page: '<mod>/<id>' }, { placement?: main | window }) (show its main view, here or in a new window) · back() · forward() · close() · focus() · toggleSidebar() · togglePanel()
            · setSidebar(open) · setPanel(open) (as asked: nothing when it already is) · setLayout(chat | split | full) (the chat alone,
            beside its tabs, or its tab filling the workspace) · setRegion(sidebar | side | bottom | '<mod>/<id>', { open?, size?, at?, edge? })
            (this window now, never the sizes the app keeps: the user's own drag still keeps what they drag to; the bottom panel `at` below or
            beside the chat, its size its height below and its width beside; the sidebar's `edge` left or right, where the app shows its rail)
            · openBrowser(url) → BrowserTab (a new tab of its
            in-app browser) · openPalette(query?) (the app's palette here, searching) · find(text, { pane? }) (the find bar of the chat it shows, or of that pane's)
            · focusPane(next | previous | main | token) (the keyboard into one of its panes: next and previous in their order on the page,
            its main region the first of them; done once the user is in it: G5.1)
Events      opened · closed · navigated
Notes       Navigation is `open(ref)` for any type: a thread, a new-thread draft, an automation, a settings section, a file, a mod's object.
            Several windows can show different things. `App.openWindow(ref)` opens a new one.

## TitleBar                                        presentation
Purpose     The window's title bar: its own actions and a mod's, in the app's positions.
Presents    App
In          Window
Slots       left (the sidebar's top bar) · center · right · main (the page's toolbar in the title bar) · thread (a chat's toolbar) ·
            threadSummary (a chat's summary toolbar): each a mod's entries, drawn as the app's own title-bar actions in that position ·
            menu (the title bar's context menu: a mod's entries as the app's own items, beside the app's)
Parts       actions: sidebarToggle · history · newChat · threadActions · workspaceControls · newTab · bottomPanelToggle · sidePanelClose
            (the app's own title-bar actions; on 21477 the sidebar toggle's action holds the new-chat button)
Notes       The app's entries carry no label of their own (each is a drawn node): a part is relabelled through its component
            (layouts.md D3): sidebarToggle (its button's name and tooltip) on 22943 and 21477. history is two buttons and
            threadActions and workspaceControls are composites, so no one label is theirs; newChat and newTab draw theirs with no
            prop to change; bottomPanelToggle's button takes a label but the app shows it only behind a flag not seen on: `unsupported`.

## Rail                                            presentation
Purpose     The app's navigation rail: its destinations, where the app shows it (beside the sidebar, or alone).
Presents    App
In          Window
Slots       header · footer (`ui.rail.add`)
Notes       Shown by the app (a server switch of the app's); never forced on. The Window's `navigation` says whether it is.
            Its destinations are the Window's `destinations` slot (`ui.destinations.add`), which also fills the sidebar's navigation.

## MainRegion                                      presentation
Purpose     The window's main region: the page it shows.
Presents    what the window shows (its `current`), else App
In          Window
Contains    one main view: ThreadView · NewThreadView · AutomationView · SettingsPage · DetailView · Page (a mod's own)

## BottomPanel                                     presentation
Purpose     The panel below the workspace (terminals and other tabs).
Presents    Thread (the chat it belongs to: the app keeps it per chat) · App
In          Window
State       open: boolean · at?: left | right (beside the chat) · its `size` (its height below the chat; beside it, its width too)
Contains    PanelTab (*)
Slots       toolbar (after its tab strip) · stripBefore (before it) · empty (the panel while it has no tab)

## Sidebar                                         presentation
Purpose     Getting around: projects, threads and automations.
Presents    App
In          Window
Shows       natively, a section per project, one for threads without a project, one for pinned threads (when any) and one for
            automations
Contains    SidebarSection (*)
Slots       sections · footer · status (a mod's statuses, one row after the footer: `ui.status`)
            · filter (the mods' declared filters, on per window: `ui.filter('sidebar', ...)`) · order (the mods' declared orders of its lists:
            `ui.sidebar.order`) · section (the mods' sections, drawn with the app's own group and rows: `ui.sidebar.section`) · hidden
            (the chats and projects the mods hide from its listings, with each mod's notice: `ui.hide('Thread' | 'Project', ...)`)
            · views (its body while a mod's page whose destination names the view is shown: `ui.sidebar.view`)
Operations  _filter(text | { status, agent, … }) · _newThread()
Notes       A mod adds sections that group threads its own way, or sections for its own concepts. `filter` is the window's: the sidebar
            lists the chats whose title or preview has the text (or whose state has those values; a list is any of them), and a
            notice at its top names the mod and gives the user "Show all"; `filter(null)` shows all again.

## SidebarSection                                  presentation
Purpose     A group in the sidebar.
Presents    Project · Automation (the automations section) · a grouping (pinned, no project, or a mod's own)
In          Sidebar
Shows       the summary's title · the repository's current branch for a project · its items, newest first
Contains    SidebarItem (*)
Slots       header actions (new thread, menu) · items · footer (show more)
Operations  _collapse() · _expand() · _showMore()

## SidebarItem                                     presentation
Purpose     One thread, or one automation, in the sidebar.
Presents    Thread · Automation
In          SidebarSection
Shows       - for a thread: title, status (working, waiting for you, error), unread, time, the agent's icon when it is not the default,
              and badges for changes, a pull request and pending requests;
            - for an automation: name, next run, enabled.
Slots       badges · trailing actions (shown on hover) · context menu · summary (the title it shows, a mod's summary of its thread:
            decorate's `summary`)
Parts       indicators: status · unread (the mark only: the chat stays unread) · time · activeDot · automation; hover: pin
Operations  _select() (opens the subject) · _rename()

## Palette                                         presentation
Purpose     Find anything, run anything.
Presents    App (the command palette) · Draft (the slash and mention menus of a composer)
In          Window (overlay) · Composer
Shows       results from search (04 §2) over every searchable type, grouped by type
Contains    PaletteResult (*)
Slots       result sources · groups · hidden (the app's commands the mods hide, with the palette's own "Hidden" section:
            `ui.hide('Command', ...)`) · commands
Parts       groups: thread (Chat) · navigation · panels · workspace (Project) · skills · configure · app, reordered only
            (`ui.reorder('Palette', {slot: 'groups', order})`; the app's keyboard shortcut lists read the same order, which is the mods'
            only while the palette is open); commands: a group's commands by Command id, the named first in their group (while searching,
            the palette ranks rows by their match)
Operations  _open(query?) · _close()
Notes       The slash menu lists SlashCommands and Skills. The mention menu lists every mentionable type (04 §8). A mod adds result
            sources, and its searchable and mentionable types appear without more work. A composer's "+" and "@" list's leading "Add"
            section takes the mods' attachment sources (`ui.composer.attachSource`), each a result source that attaches.

## PaletteResult                                   presentation
Purpose     One result in the palette or a composer menu.
Presents    any searchable or mentionable type: Command, SlashCommand, Thread, Project, File, Folder, Skill, Plugin, Review, …
In          Palette
Shows       the summary (icon, title, subtitle) and a shortcut when it is a command
Operations  _choose() (runs a command, opens a thread, inserts a mention)

## Menu                                            presentation
Purpose     A menu: the menu bar, a context menu, a toolbar menu.
Presents    App (the menu bar) · any instance (its context menu)
Contains    MenuEntry (*)
Slots       groups · items (the app's own entries, by part)
Parts       items: a chat's menu: rename · pin · markUnread · moveToProject · moveToSection · newSideChat · fork · automate · share · copy
            (copyLink · copyMarkdown · copyPath) · openIn · openInNewWindow · archive · delete; a project's: pin · edit · moveToSection
            · revealFolder · newChatInWorktree · editConnection · markRead · archiveChats · remove
Notes       A context menu is built from the commands that apply to its subject's type (Command.appliesTo) and the subject's operations.
            An entry added for Thread appears on every thread, native or not.

## MenuEntry                                       presentation
Purpose     One entry in a menu.
Presents    Command · ExternalApp (an "Open in" target) · Project (recent projects) · Account · Update · App (an app menu bar entry
            that names no command)
In          Menu · title bar · ThreadHeader
Shows       title, icon, shortcut, enabled
Operations  _choose()
Notes       The app's own menu bar entries are reported outside any window, each its Command's where its title names one; the system's
            (roles) and the protected ones (Settings, Quit, About, signing out) never are. `choose` is a click on it, refused while the
            app has it turned off.

---

## Threads and the conversation

## ThreadView                                      presentation
Purpose     A thread's conversation: the main view of a thread.
Presents    Thread
In          Window (main region)
Shows       its turns in order, then the composer; requests waiting for you stay in view
Contains    ThreadHeader · TurnView (*) · Composer
Slots       header · transcript · above the composer · empty state · filter (the mods' declared filters of its records, on per
            window, with their notice in the header: `ui.filter('transcript', ...)`)
Operations  _scrollTo(turn) · _jumpToLatest() · _find(text)
Notes       The app's view of its own threads. A mod's thread opens in the view its mod registers, built from this view's components,
            which the framework lends (the transcript, turns, messages, step rows, request card shells, the header and the composer:
            graph-integrity G2.3). Rules declared into this view apply where the app draws it.

## ThreadHeader                                    presentation
Purpose     What a thread is and where it runs.
Presents    Thread
In          ThreadView
Shows       title, agent, project, environment, branch, status · model when present · the project's actions · an "Open in" menu
            · panel toggles
Slots       badges · actions · summary (the title it shows: decorate's `summary`) · status (a mod's statuses of this thread, in the title bar's right slot while its page shows: `ui.status`
            with `for`)
Operations  _rename()

## TurnView                                        presentation
Purpose     One round of a thread.
Presents    Turn
In          ThreadView
Shows       your message, the agent's steps (folded into "worked for …" once the turn is done), the answer, requests, a summary of the
            turn's changes, usage when present
Contains    MessageBlock (*) · StepBlock (*) · RequestCard (*)
Slots       actions (copy, retry, rewind, fork from here; each shown when supported) · after the answer
State       expanded: its steps unfolded, where the app says (until the user folds or unfolds it, the app decides by itself: not said)
Operations  _collapse() · _expand() (its steps folded or unfolded)

## MessageBlock                                    presentation
Purpose     One message.
Presents    Message (UserMessage, AgentMessage)
In          TurnView
Shows       its content, its attachments and mentions as chips · streaming while it streams · "steering" for a message sent mid-turn
Contains    ContentView · Chip (*)
Slots       actions (copy, edit for your messages when rewind is supported) · decorations
Parts       actions: copy (the agent's answer) · fork (from here) · edit (your message)

## ContentView                                     presentation
Purpose     Rich content, wherever it is shown.
Presents    Content (a value held by its subject: a message, a question, a comment, instructions, a finding)
In          MessageBlock · RequestCard · ReviewView · DiffView · AutomationView · SettingsRow
Shows       each part: text, code with highlighting, links, images, mentions as chips, file links that open the file, lists, tables, quotes
Slots       part renderers (one per part kind, for example code in a given language)
Notes       A mod renders a kind of part its own way through its slot, for example a diagram from a code block.

## StepBlock                                       presentation
Purpose     One thing the agent did.
Presents    Step (every subtype) · PlanTask (in a plan) · ComputerUseSession (its status in a computer-use step)
In          TurnView
Shows       title and status for every step, then a body for its subtype:
            - **Reasoning:** the summary;
            - **Plan:** the tasks as a checklist;
            - **CommandRun:** the command, its streaming output and its exit;
            - **FileEdit:** the file and its added and removed lines, with the diff inline;
            - **Search:** the query and results;
            - **WebLookup:** the page;
            - **ToolCall:** the tool, its input and output;
            - **ComputerAction:** the app, the action and a screenshot;
            - **Delegation:** the task and the child thread, with its status.
Slots       body (a mod's Step subtype's, in the lent step row of its own view; for the app's own steps, regions in the row's body)
            · actions · badges
Parts       row: icon · details (the chevron and what it opens: a command's output, a file's inline diff) · duration (a command's) ·
            app (an MCP call's inline app) · code (reasoning's code blocks). The app's own CommandRun, FileEdit, ToolCall, Reasoning and
            Delegation rows are StepBlocks of their Steps (hide, replace, decorate); a row in a group the app keeps collapsed is not drawn,
            and a hidden row stays in its group's counts.
State       expanded: the app's own row's chevron (its disclosure), where the row has one
Operations  _expand() · _collapse() (as the user's click on the chevron)

## RequestCard                                     presentation
Purpose     Something the agent needs from you, answered in place.
Presents    Request (every subtype)
In          TurnView · ThreadView (kept in view above the composer while pending)
Shows       - **Approval:** what it wants to do (the command, the files, the host, the tool, the app), the reason, one button per offered
              scope, and deny with feedback;
            - **Question:** the prompt, its choices (one or several) and a text field when free text is allowed.
            Once answered, it shows the answer.
Contains    ContentView
Slots       body (a mod's Request subtype's, in the lent card of its own view) · actions · answers (the app's own, by part)
Parts       answers: allowOnce (protected) · allowThread (optional: may be hidden) · allowAlways (optional) · deny (protected). The card
            holds protected parts: it is never hidden or replaced whole.
Operations  the subject's own (approve, deny, answer, skip)

## Composer                                        presentation
Purpose     Writing to the agent.
Presents    Draft
In          ThreadView · NewThreadView
Shows       the content with mention chips, attachments, the pickers, the queue, the context meter when present, send or stop
Contains    ComposerPicker (*) · Chip (*) · QueueItem (*) · StatusItem · Palette (slash and mention menus)
Slots       toolbar (attach, dictate, extra actions) · status (a mod's statuses in the footer's inline controls: `ui.status`) · pickers
            · above the input · below the input
Parts       toolbar: attach · dictate · send · stop (protected); pickers: model · access · runLocation · branch; aboveInput:
            attachments (protected) · queue (protected). It holds protected parts: never hidden or replaced whole.
Operations  _focus() · _insert(text | mention)
Notes       The pickers come from the draft's thread, or its target for a new thread: the agent's thread settings and its models. A mod's
            agent gets pickers for the settings it defines.

## ComposerPicker                                  presentation
Purpose     A choice made in the composer.
Presents    Agent · Model · Environment · Branch · Project (new threads) · Setting (thread scope: effort, access, mode, …)
In          Composer · NewThreadView
Shows       the current value and its choices
Operations  _open() · _choose(value)

## Chip                                            presentation
Purpose     A compact reference to something.
Presents    Attachment · Mention · Agent · and any mentionable type (File, Folder, Skill, Plugin, Thread, Instructions, …)
In          Composer · MessageBlock · ContentView
Shows       the summary's icon and title
Operations  _open() · _remove() (in a draft)

## QueueItem                                       presentation
Purpose     A follow-up waiting to be sent.
Presents    QueuedMessage
In          Composer
Shows       its content
Slots       actions (after the app's) · badges (in its secondary text)
Operations  _edit() · _sendNow() · _remove() · _move(position)

## ListItem                                        presentation
Purpose     A subject's entry in one of the app's own lists outside the sidebar and settings.
Presents    Skill (its card on the skills page) · Branch (its row in a branch picker) · Model (its row in the composer's model menu)
In          its page or picker
Shows       the subject as the app draws it
Slots       badges (after the app's)

## PlanView                                        presentation
Purpose     A plan's tab in the side panel.
Presents    Turn (the turn whose plan it shows)
In          PanelTab
Shows       the plan as the agent wrote it
Slots       actions (a header row)

## NewThreadView                                   presentation
Purpose     Starting a thread: the main view of a new-thread draft.
Presents    Draft (with a target)
In          Window (main region)
Shows       the composer with the target pickers: project, agent, environment, branch
Contains    Composer · ComposerPicker (*)
Slots       above the composer (for example suggested starts) · starters (the mods' starting points, a row of buttons above the
            composer: `ui.newThread.starter`)

## AutomationView                                  presentation
Purpose     An automation and its runs: its main view.
Presents    Automation
In          Window (main region)
Shows       its name, prompt, schedule, project, agent and settings · whether it is enabled · next run · its runs, as threads
Contains    ContentView · SidebarItem (its runs)
Slots       actions · details
Operations  the subject's own (run now, enable, disable, edit, delete)

## DetailView                                      presentation
Purpose     A developer inspector: any instance, from reflection, in developer mode.
Presents    any type
In          Window (main region)
Shows       from reflection (04 §2):
            - the summary;
            - the state fields;
            - the supported operations as actions;
            - the relations as lists of chips.
Slots       sections · actions
Notes       It is not a main view (README rule 4, graph-boundary.md B2): a type a mod defines is seen through the views its mod registers.
            Developers use it to see what their types hold.

---

## Side panel

## SidePanel                                       presentation
Purpose     Tools next to the conversation.
Presents    Thread · Project (when no thread is open)
In          Window
Shows       natively, tabs for changes, review, terminals, the browser and files, following the current thread and project
Contains    PanelTab (*)
Slots       tabs · toolbar (after the tab strip) · stripBefore (before it) · empty (the panel while it has no tab)
State       open?: boolean · its `size` (its width) — as its window's arrangement says (G5.1)
Operations  _open(tab) · _close() · _resize(width)

## PanelTab                                        presentation
Purpose     One tab of the side panel.
Presents    ChangeSet · Review · Terminal · BrowserTab · Project (files) · Turn (its plan) · any type a mod gives a panel view
In          SidePanel
Shows       the summary's icon and title · close for closable tabs
Contains    one of ChangesView, ReviewView, TerminalView, BrowserView, FilesView, or a mod's hosted view
Operations  _select() · _close() · _move(position)

## ChangesView                                     presentation
Purpose     What changed, and what to do with it.
Presents    ChangeSet · Repository · Branch · Commit · PullRequest · FileChange (rows)
In          PanelTab
Shows       - the changed files with their added and removed lines and states;
            - the totals;
            - the branch, ahead and behind when present;
            - the pull request and its checks;
            - the supported actions: apply, revert, commit, push, open a pull request, review.
Contains    DiffView (the selected file)
Slots       toolbar actions · file row actions · header · filter (the mods' declared filters of its files, the list's and the
            diffs', on per window, with their notice a header row: `ui.filter('changes', ...)`)
Operations  _selectFile(fileChange) · _setScope(thread | turn | uncommitted)

## DiffView                                        presentation
Purpose     One file's changes, line by line.
Presents    FileChange · Hunk · Comment (inline) · Finding (markers)
In          ChangesView · ReviewView · StepBlock (file edit)
Shows       the hunks · comments on their lines · findings at their lines · per-hunk apply and revert when supported
Contains    ContentView (comments)
Slots       line gutter · hunk actions · file actions
State       layout: unified | split
Operations  _commentOn(lines) · _setLayout(layout) · _openFile()

## ReviewView                                      presentation
Purpose     A review's findings.
Presents    Review · Finding · Comment
In          PanelTab · TurnView
Shows       status, summary, findings by severity with location and state
Contains    DiffView (the selected finding's location) · ContentView
Slots       finding actions · header
Operations  _selectFinding(finding)

## TerminalView                                    presentation
Purpose     A terminal.
Presents    Terminal
In          PanelTab
Shows       its output and input · who started it (you or the agent)
Slots       toolbar · actions (a header row of its tab)
Operations  _focus() · _copySelection()

## BrowserView                                     presentation
Purpose     The in-app browser.
Presents    BrowserTab
In          PanelTab
Shows       the page, its address and navigation · a marker while the agent controls it
Slots       toolbar
Operations  _focus()

## FilesView                                       presentation
Purpose     A project's files.
Presents    Project (its root folder) · Folder · File · Instructions (marked in the tree)
In          PanelTab
Shows       the folder tree
Contains    FilePreview (the selected file)
Slots       row actions · toolbar · filter (the mods' declared filters of the Files tab's tree, on per window, with their notice
            beside the search box: `ui.filter('files', ...)`)
Operations  _select(file | folder) · _filter(text)

## FilePreview                                     presentation
Purpose     A file's contents.
Presents    File
In          FilesView · Window (main region, when a file is opened)
Shows       text with highlighting, images, or a summary for other kinds
Slots       toolbar ("Open in", attach, mention)

---

## Settings

## Region                                          presentation
Purpose     A region of a mod's own at the workspace's edge, beside the main view.
Presents    Mod
In          Window
Shows       natively, none: a mod adds them (`ui.regions.add({ id, title, edge, width?, render, where? })`). Its size and edge are the Window's `regions`.
Notes       A switch per region in the framework's settings. The allocator holds it for space first (D12).

## Page                                            presentation
Purpose     A page of a mod's own in the main region, in the app's history like the app's pages.
Presents    Mod
In          Window (main region)
Shows       natively, none: a mod adds them (`ui.pages.add({ id, title, icon?, render, header?: { title?, actions? } })`). Its header is the app's,
            inline at its top. A page whose mod is off stays routable and says so with the mod's name.
Reached by  `Window.open({ page: '<mod>/<id>' })`, its handle's `open()`, a destination (`ui.destinations.add`), the palette
A build without the app's route for it says so: `open` is refused.

## SettingsPage                                    presentation
Purpose     A page of settings.
Presents    SettingsSection · Theme (appearance) · Project (its settings) · Agent (its settings) · ToolServer · Plugin (details)
In          Window (main region)
Shows       natively, pages for:
            - general, appearance, notifications and shortcuts;
            - accounts and usage;
            - agents and their models and defaults;
            - permissions;
            - tool servers, plugins and skills;
            - personalization (instructions);
            - computer use and other apps;
            - each project;
            - each mod.
Contains    SettingsRow (*)
Slots       section (a mod's section after the page's own, in the app's section with its title: its component or rows for the
            Settings it names, `ui.settings.section`) · sections · rows · page actions · pages (a mod's own page, its entry in a group
            of the navigation)

## SettingsRow                                     presentation
Purpose     One row of settings.
Presents    Setting · Account · Usage · Model · AccessRule · ToolServer · Tool · Plugin · Skill · Instructions · ExternalApp · Shortcut · Command
In          SettingsPage
Shows       - a Setting by its kind: toggle, choice, text, number, shortcut or list;
            - any other subject by its summary and its supported operations.
Contains    ContentView (descriptions)
Slots       trailing actions · badges (after its title)
Notes       A mod's settings are Settings in its own section, shown with the same rows. An app row presents the Setting whose title it
            shows on that page; on the MCP servers page, the ToolServer of this Mac its identity props name (its config key and host,
            added by the pack); a row whose title names none presents nothing.

---

## Attention and system

## NotificationBanner                              presentation
Purpose     Telling you something happened.
Presents    Notification · and, through it, its source: Thread, Request, Usage, Update, Automation, ComputerUseSession
In          the desktop · Window (in-app banner)
Shows       title, body, the source's icon · actions (open, approve or answer when the source is a request, dismiss)
Operations  _open() · _dismiss()

## Dialog                                          presentation
Purpose     A modal step: a confirmation, a sign-in, a flow.
Presents    any instance, with a purpose: confirm an operation (delete a thread, remove a project), sign in to an Account, connect a Plugin,
            grant computer use to an ExternalApp, add a Project, details of a Request, an Update, App (onboarding, feedback, about)
In          Window
Shows       its purpose's content
Slots       body · actions
Operations  _confirm() · _cancel()
Notes       An interceptor deciding an operation can ask the user with a Dialog (04 §5), within its deadline.

## StatusItem                                      presentation
Purpose     A small, always visible indicator.
Presents    Usage · Thread (its context window, its working state) · ComputerUseSession · Account
In          Window (title bar) · Sidebar (footer) · Composer
Shows       a value or a meter, with details on hover
Operations  _open() (goes to its subject)
Notes       A mod's status is not a StatusItem of the graph: it is an entry of its place's `status` slot (`ui.status`: Window, ThreadHeader,
            Sidebar, Composer), reading its place's subject or one it names.

## DockBadge                                       presentation
Purpose     The app's badge in the Dock.
Presents    App
Shows       the number of threads waiting for you or unread, as set in settings
Operations  _set(count | text) (the app's own count unless a mod replaces it)
