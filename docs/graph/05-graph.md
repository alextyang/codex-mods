# 05 Overview graph

For review only: the cards in 02 and 03 are the source of truth. `<|--` means "is a subtype of", and other arrows are relations with
cardinality. `Mod…` boxes stand for subtypes a mod defines.

## Agents, threads and the conversation

```mermaid
classDiagram
  direction LR
  App "1" --> "*" Account
  App "1" --> "*" Agent
  App "1" --> "*" Project
  App "1" --> "*" Automation
  Account "1" --> "0..1" Usage
  Account <|-- ChatGPTAccount
  Usage <|-- CodexUsage
  Agent <|-- CodexAgent
  Agent <|-- ModAgent
  CodexAgent "1" --> "*" Model
  CodexAgent "*" --> "0..1" Account
  Project <|-- LocalProject
  Project "1" --> "*" Environment
  Project "1" --> "0..1" Repository
  Project "1" --> "*" Instructions
  Instructions <|-- CodexInstructions
  Project "1" --> "*" ProjectAction
  Environment <|-- LocalEnvironment
  Environment <|-- WorktreeEnvironment
  Environment <|-- CloudEnvironment
  Thread <|-- CodexThread
  Thread <|-- ModThread
  Thread "*" --> "1" Agent
  Thread "*" --> "0..1" Project
  Thread "*" --> "0..1" Environment
  Thread "0..1" --> "*" Thread : children
  Thread "1" --> "*" Turn
  Turn <|-- CodexTurn
  Thread "1" --> "1" Draft
  Thread "1" --> "*" QueuedMessage
  Thread "1" --> "*" Setting : thread scope
  Thread "1" --> "0..1" ChangeSet
  Automation "1" --> "*" Thread : runs
  Automation "*" --> "0..1" Thread : watches
  Turn "1" --> "1..*" UserMessage
  Turn "1" --> "*" Step
  Turn "1" --> "*" Request
  Turn "1" --> "0..1" AgentMessage
  Message <|-- UserMessage
  Message <|-- AgentMessage
  UserMessage "1" --> "*" Attachment
  UserMessage "1" --> "*" Mention
  class ModAgent { mod-defined }
  class ModThread { mod-defined }
```

## Agent activity and requests

```mermaid
classDiagram
  direction LR
  Step <|-- Reasoning
  Step <|-- Plan
  Step <|-- CommandRun
  Step <|-- FileEdit
  Step <|-- Search
  Step <|-- WebLookup
  Step <|-- ToolCall
  Step <|-- ComputerAction
  Step <|-- Delegation
  Step <|-- ModStep
  Step <|-- CodexStep
  Reasoning <|-- CodexReasoning
  CommandRun <|-- CodexCommandRun
  ToolCall <|-- CodexToolCall
  Plan "1" --> "*" PlanTask
  Step "1" --> "0..1" Request
  Request <|-- Approval
  Request <|-- Question
  Request <|-- ModRequest
  Approval <|-- CommandApproval
  Approval <|-- EditApproval
  Approval <|-- NetworkApproval
  Approval <|-- ToolApproval
  Approval <|-- ComputerUseApproval
  CommandApproval <|-- CodexCommandApproval
  Question <|-- CodexQuestion
  Approval "1" --> "0..1" AccessRule : always
  CommandRun "*" --> "0..1" Terminal
  FileEdit "1" --> "1" FileChange
  WebLookup "*" --> "0..1" BrowserTab
  ToolCall "*" --> "1" Tool
  ComputerAction "*" --> "1" ComputerUseSession
  ComputerAction "*" --> "1" ExternalApp
  Delegation "1" --> "1" Thread : child
  class ModStep { mod-defined }
  class ModRequest { mod-defined }
```

## Changes, review and version control

```mermaid
classDiagram
  direction LR
  ChangeSet "1" --> "*" FileChange
  FileChange "1" --> "*" Hunk
  FileChange "*" --> "0..1" File
  FileChange "1" --> "*" Comment
  Review "1" --> "*" Finding
  Finding "1" --> "*" Comment
  Review "*" --> "1" ChangeSet : target (or Branch, Commit, PullRequest)
  Repository <|-- GitRepository
  Repository "1" --> "*" Branch
  Repository "1" --> "*" Commit
  Repository "1" --> "*" PullRequest
  Branch "1" --> "0..1" PullRequest
  PullRequest <|-- GitHubPullRequest
  PullRequest "*" --> "0..1" Account : host
```

## Tools, extensions, commands and settings

```mermaid
classDiagram
  direction LR
  Folder "1" --> "*" File
  Folder "1" --> "*" Folder
  Terminal "*" --> "1" Project
  BrowserTab "*" --> "0..1" Thread
  ComputerUseSession "*" --> "1" Thread
  ExternalApp "1" --> "*" ComputerUseSession
  CodexAgent "*" --> "*" ToolServer
  CodexAgent "*" --> "*" Plugin
  CodexAgent "*" --> "*" Skill
  ToolServer "1" --> "*" Tool
  Plugin "1" --> "*" Tool
  Plugin "1" --> "*" Skill
  Plugin "1" --> "*" ToolServer
  Plugin "*" --> "0..1" Account
  ToolServer "*" --> "0..1" Account
  Command <|-- SlashCommand
  Command <|-- ProjectAction
  Command "1" --> "0..1" Shortcut
  SettingsSection "1" --> "*" Setting
  Setting "*" --> "1" CodexAgent : definedBy (or App, Plugin, a mod)
  Notification "*" --> "1" Thread : source (or Request, Usage, Update, Automation)
```

## Presentations and what they present

Containment in a window is in 03 ("The tree"). Here, each presentation points at the concepts it presents.

```mermaid
flowchart LR
  Any[any type]
  Window & Sidebar & Palette & DockBadge --> App
  SidebarSection --> Project & Automation
  SidebarItem --> Thread & Automation
  Menu --> Any
  MenuEntry --> Command & ExternalApp
  PaletteResult & Chip & Dialog & DetailView & PanelTab --> Any
  ThreadView & ThreadHeader & SidePanel --> Thread
  TurnView --> Turn
  MessageBlock --> Message
  ContentView --> Content
  StepBlock --> Step
  RequestCard --> Request
  Composer & NewThreadView --> Draft
  ComposerPicker --> Agent & Model & Environment & Branch & Setting
  QueueItem --> QueuedMessage
  AutomationView --> Automation
  ChangesView --> ChangeSet & Repository & PullRequest
  DiffView --> FileChange & Hunk & Comment
  ReviewView --> Review & Finding
  TerminalView --> Terminal
  BrowserView --> BrowserTab
  FilesView --> Folder & File
  FilePreview --> File
  SettingsPage --> SettingsSection
  SettingsRow --> Setting & Account & ToolServer & Plugin & Skill & AccessRule
  NotificationBanner --> Notification
  StatusItem --> Usage & Thread
```
