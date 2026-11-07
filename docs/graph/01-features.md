# 01 Feature index

Every user-facing feature of the Codex app, from the user's point of view, with the types (02) and the presentations (03) that realize it.
Read it in both directions: no feature without types, and no type without a feature (06 checks both).

**Features:**
- [F1 Projects](#f1-projects)
- [F2 Threads](#f2-threads)
- [F3 The conversation](#f3-the-conversation)
- [F4 The composer](#f4-the-composer)
- [F5 Controlling a run](#f5-controlling-a-run)
- [F6 Requests and access](#f6-requests-and-access)
- [F7 Changes and version control](#f7-changes-and-version-control)
- [F8 Tools shared with the agent](#f8-tools-shared-with-the-agent)
- [F9 Extending the agent](#f9-extending-the-agent)
- [F10 Automations](#f10-automations)
- [F11 Attention](#f11-attention)
- [F12 Navigation and layout](#f12-navigation-and-layout)
- [F13 Accounts, agents and models](#f13-accounts-agents-and-models)
- [F14 Settings and the app](#f14-settings-and-the-app)

## F1 Projects
Where the work happens: a codebase the agent works in.

| Feature | Types | Presentations |
|---|---|---|
| Add a folder as a project, open it, rename it, remove it from the app | Project, LocalProject, Folder | Sidebar, SidebarSection, Dialog, Menu, MenuEntry, PaletteResult |
| See each project's threads; switch between projects | Project, Thread | SidebarSection, SidebarItem, PaletteResult |
| A project's instructions to the agent | Instructions | SettingsRow, FilesView |
| A project's repository and current branch | Repository, GitRepository, Branch | SidebarSection, ThreadHeader, ChangesView |
| A project's environments and defaults | Environment, Setting | SettingsPage, ComposerPicker |
| A project's actions (Run, Test, …), run in a terminal | ProjectAction | ThreadHeader, MenuEntry, PaletteResult, TerminalView |
| Open the project in another app: an editor, a terminal, Finder | ExternalApp, Project | MenuEntry, ThreadHeader |

## F2 Threads
A piece of work with an agent: the central unit of the app.

| Feature | Types | Presentations |
|---|---|---|
| Start a thread in a project, or without one; it gets a title, or you give it one | Thread, CodexThread, Draft, Project | NewThreadView, Composer, Sidebar, PaletteResult |
| Choose the agent that works in it: Codex, or another agent a mod adds | Agent, CodexAgent | ComposerPicker, ThreadHeader, Chip |
| Follow its status: working, waiting for you, error; unread results | Thread | SidebarItem, ThreadHeader, StatusItem, NotificationBanner |
| Give a thread a goal the agent keeps working toward; see its progress; clear it | Thread | Composer, ThreadHeader, StatusItem |
| Rename, pin, archive, restore, delete | Thread | SidebarItem, Menu, Dialog |
| Fork a thread, from its end or from a turn | Thread, Turn | TurnView, Menu |
| Continue a thread started in the command line or an editor | Thread | SidebarItem, ThreadHeader |
| Search and filter threads | Thread | Sidebar, Palette, PaletteResult |
| Where it runs: the project folder, a worktree, the cloud | Environment, LocalEnvironment, WorktreeEnvironment, CloudEnvironment | ComposerPicker, ThreadHeader |
| Bring worktree or cloud results back into the project | WorktreeEnvironment, CloudEnvironment, ChangeSet | ChangesView, ThreadHeader |
| See the work an agent delegated to sub-agents, as child threads | Delegation, Thread | StepBlock, SidebarItem, ThreadView |
| Export a thread | Thread, Content | Menu |

## F3 The conversation
What happens inside a thread.

| Feature | Types | Presentations |
|---|---|---|
| Your messages: text, attached files and images, mentions | Turn, Message, UserMessage, Content, Attachment, Mention | TurnView, MessageBlock, ContentView, Chip |
| The agent's work as it streams: reasoning, plan, commands, edits, searches, web pages, tool calls, actions in other apps, delegations | Step, Reasoning, Plan, PlanTask, CommandRun, FileEdit, Search, WebLookup, ToolCall, ComputerAction, Delegation, CodexReasoning, CodexCommandRun, CodexToolCall, CodexStep | StepBlock |
| Its updates and the final answer, with code, links and file links that open the file | AgentMessage, Content | MessageBlock, ContentView |
| Expand and collapse steps; copy; find text in a thread | Step, Message, Turn | StepBlock, TurnView, ThreadView |

## F4 The composer
How you instruct the agent.

| Feature | Types | Presentations |
|---|---|---|
| Write a message; it is kept as a draft per thread | Draft | Composer |
| Attach files and images; mention files, folders, skills, plugins and threads | Attachment, Mention, File, Folder, Skill, Plugin | Composer, Chip, Palette, PaletteResult |
| Slash commands, including your own saved prompts | SlashCommand | Palette, PaletteResult |
| For a new thread: choose the project, agent, environment and branch | Draft, Project, Agent, Environment, Branch | NewThreadView, ComposerPicker |
| Choose the model and the agent's thread settings: reasoning effort, access, personality, plan mode, web search | Model, Setting, CodexAgent | ComposerPicker |
| Send; stop; steer while it works; queue follow-ups and edit, reorder or send them now | Draft, Thread, QueuedMessage | Composer, QueueItem |
| Dictate | Draft | Composer |

## F5 Controlling a run

| Feature | Types | Presentations |
|---|---|---|
| Stop, continue after a stop, retry a turn | Thread, Turn, CodexTurn | Composer, TurnView |
| Edit an earlier message and continue from there | Turn, UserMessage | MessageBlock, TurnView |
| See how full the context is; compact the conversation | Thread | StatusItem, Composer |
| See usage per thread and per turn | CodexThread, Turn | TurnView, StatusItem |
| Ask for a code review of changes, a branch, a commit or a pull request; see and act on its findings | Review, Finding, ChangeSet, Branch, Commit, PullRequest | ReviewView, TurnView, PaletteResult, DiffView |

## F6 Requests and access
The agent asks you, and you decide what it may do.

| Feature | Types | Presentations |
|---|---|---|
| The agent asks before running a command, editing files, using the network, calling a tool or operating an app | Request, Approval, CommandApproval, CodexCommandApproval, EditApproval, NetworkApproval, ToolApproval, ComputerUseApproval | RequestCard, NotificationBanner, Dialog |
| Approve once, for this thread, or always; deny with feedback | Approval, AccessRule | RequestCard |
| The agent asks you a question, with choices or free text | Question, CodexQuestion | RequestCard, NotificationBanner |
| Threads waiting for you stand out | Request, Thread | SidebarItem, DockBadge |
| Access per thread, with project and app defaults: read-only, workspace, full access | Setting, CodexAgent | ComposerPicker, SettingsRow |
| Review and remove "always" rules | AccessRule | SettingsRow |

## F7 Changes and version control
What the agent did to your code, and what you do with it.

| Feature | Types | Presentations |
|---|---|---|
| See which files changed, for the thread or for one turn; read the diffs | ChangeSet, FileChange, Hunk | ChangesView, DiffView, TurnView, SidebarItem, StepBlock |
| Apply proposed changes; revert everything, a file or a hunk | ChangeSet, FileChange, Hunk | ChangesView, DiffView |
| Comment on lines and send the comments to the agent | Comment, Hunk, FileChange | DiffView, MessageBlock |
| Open a changed file, or open it in your editor | FileChange, File, ExternalApp | DiffView, MenuEntry |
| Stage, commit (the agent can write the message), switch and create branches, push and pull | Repository, GitRepository, Branch, Commit, ChangeSet | ChangesView, ComposerPicker, PaletteResult |
| Open a pull request; follow its state and checks | PullRequest, GitHubPullRequest, Account | ChangesView, TurnView, SidebarItem |

## F8 Tools shared with the agent

| Feature | Types | Presentations |
|---|---|---|
| Terminals: run commands yourself, and see and reuse the agent's | Terminal, CommandRun | TerminalView, PanelTab, StepBlock |
| A browser: preview what is being built; the agent browses and you watch | BrowserTab, WebLookup | BrowserView, PanelTab |
| Computer use: the agent operates other apps on your Mac, with permission per app | ComputerUseSession, ComputerAction, ExternalApp, ComputerUseApproval | StepBlock, StatusItem, SettingsRow, Dialog |
| Browse and preview the project's files | File, Folder | FilesView, FilePreview, PaletteResult |

## F9 Extending the agent

| Feature | Types | Presentations |
|---|---|---|
| Connect tool servers (MCP), sign in to them, see their tools | ToolServer, Tool, Account | SettingsPage, SettingsRow |
| Install plugins and connect them to your accounts | Plugin, Account | SettingsPage, SettingsRow, Dialog, Chip |
| Skills: yours, built in, or installed from the library; use one in a message | Skill | SettingsRow, PaletteResult, Chip |
| Instructions: global, per project, per folder | Instructions, CodexInstructions | SettingsRow, FilesView |
| See tool use in the conversation | ToolCall, Tool | StepBlock |

## F10 Automations
Work that runs on its own.

| Feature | Types | Presentations |
|---|---|---|
| Create an automation: a prompt, a project, an agent and a schedule | Automation, Setting | AutomationView, Dialog |
| Run it now, pause it, edit it, delete it | Automation | AutomationView, SidebarItem, Menu |
| Its runs arrive as unread threads, or as turns in the thread it watches | Automation, Thread, Turn | SidebarSection, SidebarItem, NotificationBanner, TurnView |

## F11 Attention

| Feature | Types | Presentations |
|---|---|---|
| Notified when a thread finishes or fails, needs approval or an answer, an automation ran, or a limit is near | Notification, Thread, Request, Automation, Usage | NotificationBanner |
| Answer or open from the notification | Notification, Request | NotificationBanner |
| A Dock badge for threads that need you | Thread, Request | DockBadge |

## F12 Navigation and layout

| Feature | Types | Presentations |
|---|---|---|
| Sidebar, main view and side panel | (presentations) | Window, Sidebar, SidePanel, PanelTab |
| The title bar, the app's rail, the main region and the bottom panel (the window's arrangement) | (presentations) | Window, TitleBar, Rail, MainRegion, BottomPanel |
| Go to anything; back and forward | Thread, Project, File, … | Window, Palette, PaletteResult |
| The command palette and menus | Command | Palette, Menu, MenuEntry |
| Keyboard shortcuts, and rebinding them | Shortcut, Command | SettingsRow, MenuEntry |
| Several windows | (presentations) | Window |

## F13 Accounts, agents and models

| Feature | Types | Presentations |
|---|---|---|
| Sign in to ChatGPT and out; see your plan | Account, ChatGPTAccount | SettingsRow, Dialog, MenuEntry |
| Usage, limits and when they reset | Usage, CodexUsage | SettingsRow, StatusItem, NotificationBanner |
| Other accounts connected through plugins, tool servers, GitHub or a mod's agent | Account | SettingsRow, Dialog |
| Agents: which are available, and their settings | Agent, CodexAgent, Setting | SettingsPage, ComposerPicker |
| Models and reasoning effort: defaults and per thread | Model, Setting | SettingsRow, ComposerPicker, ThreadHeader |

## F14 Settings and the app

| Feature | Types | Presentations |
|---|---|---|
| Appearance: light or dark, accent, density, fonts | Theme, Setting | SettingsPage |
| General preferences, notifications, defaults, experimental features | Setting, SettingsSection | SettingsPage, SettingsRow |
| Default apps to open things in; computer use per app | ExternalApp | SettingsRow |
| Onboarding | App | Dialog, Window |
| Updates | App, Update | MenuEntry, Dialog, NotificationBanner |
| Help, feedback, about | App | Menu, Dialog |
