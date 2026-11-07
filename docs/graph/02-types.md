# 02 Types

One card per type, grouped by area. Kinds:
- **concept:** a virtual abstraction with a small core;
- **subtype:** extends a concept; the native Codex implementation is a subtype like any other;
- **value:** plain data with no identity.

Notation and tiers are in the [README](README.md). Extension mechanisms (04 §7) are abbreviated:

| Mechanism | Meaning |
|---|---|
| **subtype** | Define a new kind of it. |
| **provide** | Serve instances of it or of a subtype. |
| **attach** | Add namespaced data to any instance. |
| **decorate** | Contribute to its presentations. |
| **intercept** | Observe, change, stop or refuse its operations. |
| **replace** | Supply the implementation of an operation or a rendering for chosen instances. |

"All" means all six.

Shared values used below: `Ref` (04 §1), `Time`, `Duration`, `Path` (a location in a project or on disk), `Url`, `Image`, `Color`,
`Content` (§C), `Outcome` (04 §4).

**Areas:**
- [A. App and accounts](#a-app-and-accounts)
- [B. Projects and environments](#b-projects-and-environments)
- [C. Agents, threads and the conversation](#c-agents-threads-and-the-conversation)
- [D. Agent activity](#d-agent-activity)
- [E. Requests and access](#e-requests-and-access)
- [F. Changes, review and version control](#f-changes-review-and-version-control)
- [G. Tools shared with the agent](#g-tools-shared-with-the-agent)
- [H. Agent extensions](#h-agent-extensions)
- [I. Commands](#i-commands)
- [J. Attention](#j-attention)
- [K. Settings](#k-settings)

---

## A. App and accounts

## App                                             concept (one instance)
Purpose     The running Codex app.
Identity    one per installation
State       version: string · onboarded?: boolean
Operations  openWindow(target?: Ref) → Window · checkForUpdates() · sendFeedback(content: Content) · openHelp() · quit()
            · notify({title, body?, kind?, thread?}) (H6: the app's own notification as it is about to show; interceptable only: a policy
            keeps it from showing or rewrites its title and body)
            · addProject?(spec: { path: Path, name?: string }) → Project (a folder added as a project, as "Add new project" does)
            · frontWindow?() → Window | null (the window the user is in: asked, never stale; graph-layers.md §3.3)
Events      launched · quitting · windowOpened · windowClosed
Relations   windows: Window (*) · accounts: Account (*) · agents: Agent (*) · projects: Project (*) · automations: Automation (*)
            · externalApps: ExternalApp (*) · settings: Setting (*) · theme: Theme (1) · update: Update (0..1)
            · newChatDraft: Draft (0..1) (the new chat's, without a project: graph-layers.md §3.2)
Extension   attach · decorate · intercept (quit, openWindow)
Presented   Window · Sidebar · Palette · Menu (the menu bar) · Dialog (about, onboarding, feedback) · DockBadge
Notes       There is one App. It is extended, not subtyped or provided.

## Account                                         concept
Purpose     An identity with a service that the app, an agent, a plugin or a tool server uses.
Extends     —                                     Subtypes: ChatGPTAccount (native: the app's own sign-in); mod-defined (a service a mod connects)
Identity    service + account id
State       service: string · name: string · signedIn: boolean · email?: string · plan?: string
Operations  signIn() · signOut() · manage?() (opens the service's account page) · remove?() (an added account: signed out and removed; its
            chats move to the app's account)
Events      signedIn · signedOut · planChanged
Relations   usage: Usage (0..1) (its usage, when its provider reports one: what it holds is the Usage subtype's) · agents: CodexAgent (*) (the
            agents that use it: the inverse of CodexAgent.account) · plugins: Plugin (*) · toolServers: ToolServer (*)
            · pullRequests: PullRequest (*) (when it is a code host account) · threads?: Thread (*) (the chats that run on it: the inverse of
            Thread.account)
Extension   all
Presented   SettingsRow (accounts) · Dialog (sign-in) · MenuEntry · StatusItem
Notes       The app signs in to one ChatGPT account at a time. The framework adds others beside it (CodexAgent.addAccount, RM10): each is
            signed in in the copy itself, its sign-in kept by its own app-server and never given to a mod. Other accounts come from the
            app's connections: a GitHub account for pull requests, a plugin's service, a tool server that needs sign-in. A mod's agent keeps
            its own account: nothing in the app lists it beside these (graph-boundary.md B3).

## ChatGPTAccount                                  subtype of Account
Adds        workspace?: string (the team or organization the account works in) · added?: boolean (one the user added beside the app's own).
            Its usage is a CodexUsage.
Realized    natively

## Usage                                           concept
Purpose     How much of an account's limits is used, as the account's provider reports it.
Extends     —                                     Subtypes: CodexUsage (native); mod-defined
Identity    its account
Events      changed
Relations   account: Account (1)
Extension   all
Presented   SettingsRow (usage) · StatusItem (usage meter) · NotificationBanner
Notes       The core is its account. What limits are, and how they are reported, is each provider's own, on its subtype at the source's
            fidelity: no shared surface shows another provider's usage (graph-boundary.md B3). A mod's agent shows its own, and may
            provide Usage for other mods to read. Estimates, deltas, thresholds and resets are a mod's to derive from the reports
            (graph-integrity G1).

## CodexUsage                                      subtype of Usage
Adds        snapshots: { <limitId>: snapshot } (the server's rate-limit snapshots, unreduced, keyed by their `limitId`: `limitName?`, the
            `primary?` and `secondary?` windows ({ usedPercent, windowDurationMins?, resetsAt?: Time }), `credits?` ({ hasCredits,
            unlimited, balance? }), `planType?`, `rateLimitReachedType?`, `individualLimit?`, `spendControlReached?`, `normalModelSlug?`,
            and any field the library has no schema for in `extra`) · ordinaryUsageAllowed?: boolean · rateLimitResetCredits?: JSON
Events      reported { snapshot } (every report as given, repeats included)
Realized    natively (graph-integrity GI1)

## Update                                          concept
Purpose     An available update of the app.
Extends     —                                     Subtypes: CopyUpdate (the framework's update of the copy, 07); mod-defined
Identity    version
State       version: string · state: available | downloading | ready | installing · notes?: Content
Operations  download() · install() · later()
Events      stateChanged
Relations   app: App (1)
Extension   attach · decorate · intercept (install)
Presented   NotificationBanner · Dialog · MenuEntry
Notes       The framework's CopyUpdate (07) is the user's: no mod intercepts it (graph-boundary.md B5).

## Theme                                           concept (one instance)
Purpose     How the app looks; what mods follow to look native.
Identity    one per app; all windows share it
State       mode: light | dark | system · appearance: light | dark (resolved) · accent: Color · density?: compact | comfortable
            · fonts: { ui, code, size } · tokens: { name: value } (the colors, spacing and type the app uses)
Operations  set(field, value)
Events      changed
Relations   app: App (1) · settings: Setting (*)
Extension   attach · decorate · intercept (set)
Presented   SettingsPage (appearance)
Notes       Presentations from mods draw on the same tokens (04 §8), so they follow every change. A mod's theme (`ui.theme.add`) is
            listed on the Appearance page; one the user turns on is written as the app's own appearance settings (an override).

---

## B. Projects and environments

## Project                                         concept
Purpose     A codebase the agent works in.
Extends     —                                     Subtypes: LocalProject (native); mod-defined (for example a remote workspace)
Identity    id
State       name: string · location: Path | Url · lastOpenedAt?: Time (when known)
Operations  open() · rename(name) · remove() (from the app; files untouched) · newThread(draft? | spec?) → Thread | Draft (a chat's spec,
            graph-layers.md §3.2: the Thread sent, or the new chat's Draft prepared)
            · newAutomation?(spec: AutomationSpec) → Automation (each run a new thread in this project) · openIn(app: ExternalApp)
            · newTerminal?({ thread?, path? }) → Terminal (in its folder or a folder in it, its tab beside the chat: the one the window shows)
            · findFiles?(query, { limit? }) → (File | Folder)[] (by name, best first, as the composer's @ finds them)
Events      added · opened · renamed · removed
Relations   threads: Thread (*) · root: Folder (0..1) · repository: Repository (0..1)
            · environments: Environment (*) · actions: ProjectAction (*) · automations: Automation (*) · terminals: Terminal (*)
            · settings: Setting (*) (project defaults)
            · draft: Draft (0..1) (the new chat's in this project; on 21477 the same Draft for every project and none: an alias)
Extension   all
Presented   SidebarSection · PaletteResult · Window (title) · ThreadHeader · SettingsPage (project) · Dialog (add, remove) · MenuEntry

## LocalProject                                    subtype of Project
Adds        folder: Folder (the folder on this Mac) · instructions: CodexInstructions (*) (its AGENTS.md files: where Codex keeps its
            instructions is its own, graph-boundary.md B3)
Operations  reveal() (in Finder) · addInstructions?(text) → CodexInstructions (its AGENTS.md, where it has none; else the Instructions' edit)
Realized    natively

## Environment                                     concept
Purpose     Where a thread's agent does its work.
Extends     —                                     Subtypes: LocalEnvironment, WorktreeEnvironment, CloudEnvironment (native); mod-defined (for example a container or a remote machine)
Identity    id
State       name: string · status: ready | preparing | unavailable · description?: string
Events      statusChanged
Relations   project: Project (0..1) (a cloud environment serves repositories: a project's when it serves the project's) · threads: Thread (*)
Extension   all
Presented   ComposerPicker (where to run) · ThreadHeader · SettingsPage (project)

## LocalEnvironment                                subtype of Environment
Adds        folder: Folder (the project folder itself)
Realized    natively

## WorktreeEnvironment                             subtype of Environment
Adds        path: Path · branch: Branch (0..1: none while it is detached, as a new worktree starts at its base's commit) · base: Branch · setup?: Content (commands run when the worktree is created)
Operations  open() (a new thread in it) · mergeBack() (moves its work to the project's checkout) · remove()
Realized    natively; one per worktree, linked from the threads that run in it

## CloudEnvironment                                subtype of Environment
Adds        location?: Url (when it has an address)
Operations  manage() (opens where the app manages it)
Realized    natively
Notes       Changes made in the cloud arrive as a proposed ChangeSet; ChangeSet.apply() brings them into the project.

## Instructions                                    concept
Purpose     Standing instructions that agents follow.
Extends     —                                     Subtypes: CodexInstructions (native); mod-defined
Identity    its provider's
State       text: Content · enabled: boolean
Operations  edit(text) · enable() · disable() · open?() (where they are kept)
Events      changed
Relations   agents: Agent (*) (the agents that follow them)
Extension   all (an agent with its own instructions provides them)
Presented   SettingsRow (personalization) · FilesView · Chip (when a message includes them)
Notes       Where instructions live and how far they reach is each agent's own (graph-boundary.md B3): Codex's are files at three levels.

## CodexInstructions                               subtype of Instructions
Adds        scope: global | project | folder · location?: Path (its AGENTS.md) · project: LocalProject (0..1) · folder: Folder (0..1)
Realized    natively (graph-integrity GI1)

---

## C. Agents, threads and the conversation

## Agent                                           concept
Purpose     An assistant that works in threads.
Extends     —                                     Subtypes: CodexAgent (native); mod-defined (for example Claude Code)
Identity    id
State       name: string · icon: Image · available: boolean · unavailableReason?: string
Operations  newThread(draft | spec) → Thread | Draft (as Project's) · newAutomation?(spec: AutomationSpec) → Automation
Events      availabilityChanged
Relations   threads: Thread (*)
Extension   all
Presented   ComposerPicker (agent, when several are available) · ThreadHeader · SettingsPage (per agent) · Chip
Notes       The core is what the shared surfaces need of any agent: its mark and availability in the new-chat agent picker and a thread's
            header, its threads, and starting one (graph-boundary.md B3). What an agent is made of (its models, thread settings,
            instructions, skills, tool servers, plugins, an account) is its subtype's. A mod adds an agent by subtyping Agent and Thread
            and providing both: its threads join the shared surfaces and open in the view it registers (README rule 4).

## CodexAgent                                      subtype of Agent
Adds        models: Model (*) · account: Account (0..1) (the app's own) · settings: Setting (*) (the thread settings it defines)
            · instructions: Instructions (*) · skills: Skill (*) · toolServers: ToolServer (*) · plugins: Plugin (*)
            · accounts?: Account (*) (every account it can use: the app's, then the ones the user added) · startAccount?: Account (0..1)
            (where new chats start; none: the app's)
            · addAccount?() → Account (another ChatGPT account, added signed out; its sign-in opens in the browser)
            · setStartAccount?(account?: Account)
            · addToolServer?(name, config) → ToolServer (one command or URL and the keys the app's MCP settings take)
            · addSkill?({ name, description, text, project? }) → Skill (the user's own: global, or in the project)
            · skillRoots?: [Path] (the session's extra skill roots, as its server last took them)
            · _startThread(params) → JSON · _setSkillRoots(roots) (graph-integrity G3.5, the mechanism layer: a thread's start with the
            source's own parameters (developer instructions, dynamic tools, config, folder), and the session's skill roots; the app's own are
            held for interceptors, and a mod adds only its own part: its `mod_<id>` tools, never what the thread may reach)
            Its thread settings are Settings with thread scope and project or app defaults:
            - **reasoning effort:** choices from the selected model;
            - **access:** read-only, workspace or full access;
            - **personality,** where the build still offers it (optional);
            - **mode:** default or plan;
            - **web search:** on or off.
Realized    natively

## Model                                           concept
Purpose     A model an agent can use.
Identity    agent + id
State       name: string · description: string · efforts: [{ id, label }] (the reasoning levels it offers; may be empty) · default: boolean
            · available: boolean · inputs?: [text | image] (what a message to it may hold; none said: text only)
            · contextWindow?: number (tokens a chat with it may hold) · pricing?: { input?, output?: number per million tokens, currency }
Operations  _select(for: Thread | Draft | Project | Automation) (mechanism: a model is set where it applies, graph-layers.md §2) · makeDefault()
Events      availabilityChanged
Relations   agent: Agent (1)
Extension   all (an agent's provider provides its models)
Presented   ComposerPicker (model) · SettingsRow (models) · ThreadHeader

## Thread                                          concept
Purpose     A piece of work with an agent.
Extends     —                                     Subtypes: CodexThread (native); mod-defined (for example a Claude Code thread)
Identity    id
State       title: string · status: idle | working | waitingForYou | error · waitingOn?: approval | question (what a waitingForYou thread
            waits on; an approval first) · unread: boolean · archived: boolean
            · origin: user | fork | delegation | automation · createdAt: Time · updatedAt: Time
            · preview?: string (the last line shown in lists) · model?: Model · pinned?: boolean
Operations  send(message: Draft | Content, options?: JSON (its provider's own: CodexThread's settings and sticky)) → Turn · stop() · rename(title)
            · archive() · restore() · markRead() · open() → Window
            · steer?(message) · enqueue?(message) → QueuedMessage · fork?(at?: Turn, options?) → Thread (options: the provider's own; CodexThread's, the
            source's fork parameters) · delete?() · compact?() · setModel?(model)
            · review?(target: ChangeSet | Branch | Commit) → Review · pin?() · unpin?() · export?() → Content
            · automate?(spec: AutomationSpec) → Automation (each run a turn in this thread) · markUnread?()
            · moveTo?(project?: Project) (into a project, or out of every project with none: the app's "Move to project")
            · moveToAccount?(account: Account) (its next turns on another of its agent's accounts; between turns, refused while it works)
Events      created · titleChanged · statusChanged · turnStarted · turnFinished · requestOpened · archived · restored · deleted
Relations   agent: Agent (1) · project: Project (0..1) · environment: Environment (0..1) · turns: Turn (*) · draft: Draft (0..1; derived: the Draft
            whose thread it is, its composer's, for any provider's thread)
            · queue: QueuedMessage (*) · requests: Request (*) · changes: ChangeSet (0..1) · settings: Setting (*) (thread scope, defined by its agent)
            · parent: Thread (0..1) · children: Thread (*) (its forks and delegations) · automation: Automation (0..1)
            · terminals: Terminal (*) · browserTabs: BrowserTab (*) · account?: Account (0..1) (the account its turns use)
Extension   all
Presented   SidebarItem · ThreadView · ThreadHeader · PaletteResult · NotificationBanner · Menu (context menu) · Window (title) · StatusItem · SidePanel
Notes       - The status is waitingForYou while one of its requests is pending.
            - A thread without a project is shown in its own sidebar section.
            - Threads started in the command line or an editor appear too (CodexThread's client).
            - The core is what the sidebar, search, the palette, notifications, the title and the shared actions need; what one agent reports
              beyond it is its subtype's (graph-boundary.md B3). A mod's thread opens in the view its mod registers (README rule 4).

## CodexThread                                     subtype of Thread
Adds        - CodexAgent's thread settings (reasoning effort, access, personality, mode, web search);
            - environments: local, worktree or cloud;
            - cloudTask?: Url (a cloud thread's page on the web);
            - cwd?: Path · gitInfo?: { branch?, sha?, originUrl? } · sessionId?: string · ephemeral?: boolean · modelProvider?: string
              · reasoningEffort?: string · cliVersion?: string · source?: JSON (where it was started: cli, vscode, exec, appServer, { custom },
              { subAgent }) · originator?: string · threadSource?: string · agentNickname?: string · agentRole?: string (a sub-agent's)
              · recencyAt?: Time (the source's own facts, under its names: graph-integrity G1);
            - _resume(params) → JSON (G3.5, mechanism: its resume with the source's own parameters, the app's own held for interceptors);
              its send's options take `additionalContext` (the turn's context as the source has it: a mod adds only its own `mod:<id>`);
            - usage?: { total, last: { inputTokens, cachedInputTokens, cacheWriteInputTokens?, outputTokens, reasoningOutputTokens,
              totalTokens }, modelContextWindow? } (the last token report, as given);
            - goal?: { objective: string, status: active | paused | blocked | usageLimited | budgetLimited | complete, tokensUsed: number,
              tokenBudget?: number, timeUsed: Duration, createdAt: Time, updatedAt: Time } (what the agent keeps working toward, as the
              source reports it) · setGoal?(objective) · clearGoal?();
            - send's options: { settings?: { model?, effort?, mode?, access? } (this send's, the thread's own Setting keys; put back after
              its turn starts unless sticky; access only narrows, to read-only), sticky?: boolean }.
Events      tokenUsageReported { tokenUsage, turnId } (every token report, as given, repeats included) · compacted { turnId? } · reverted
            · hookStarted { run, turnId? } · hookCompleted { run, turnId? } (a hook the user configured: the source's run as given)
            · guardianWarning { message } · warning { message } · predicted (the server's prediction for the chat, as given)
Supports    every optional Thread operation
Notes       With a goal, the agent may start further turns on its own until the goal is complete.
Realized    natively by the Codex agent

## Turn                                            concept
Purpose     One round of a thread: what you asked and what the agent did.
Extends     —                                     Subtypes: CodexTurn (native); mod-defined
Identity    thread + position
State       status: running | completed | stopped | failed · startedAt: Time · endedAt?: Time · error?: string
            · startedBy: { kind: user | app | mod | agent | unknown, id?: string (the mod), key?: string (its call's), through?: string (the
            mod whose surface the user sent it from: graph-integrity G7.3) } (who started it: the app's composer is the user's; agent, its own
            continuation, which the server starts)
            · stoppedBy?: { kind: user | mod | app | unknown, id?: string (the mod), via?: string, through?: string (as startedBy's) } (a stopped
            turn's: the app's stop is the user's)
Operations  copy() · retry?() → Turn · rewind?(content?: Content) → Turn (edit this turn's message and continue from here; later turns are
            dropped, or kept in a fork first)
Events      started · stepAdded · completed · stopped { by?: as stoppedBy } · failed
Relations   thread: Thread (1) · input: UserMessage (1..*) (the first message, then any steering) · steps: Step (*) · answer: AgentMessage (0..1)
            · requests: Request (*) · changes: ChangeSet (0..1) · automation: Automation (0..1) (when an automation sent it)
Extension   subtype · provide (by its thread's provider) · attach · decorate · intercept · replace
Presented   TurnView · PlanView (its plan's tab)


## CodexTurn                                       subtype of Turn
Adds        trigger?: composer | queue | retry | edit | automation | review | reply | handoff | mod | app | unknown (why Codex's app started it)
            · triggerBy?: string (the mod, for `mod`) · triggerDetail?: string (the app's own name for it, as it sent it)
            · errorInfo?: JSON (the server's error as given: message, codexErrorInfo, additionalDetails) · durationMs?: number
            · rootTurnId?: string · diff?: string (the turn's aggregate diff, as last reported)
Events      errored { error, willRetry } (willRetry: the server tries again by itself) · modelRerouted { fromModel, toModel, reason }
            · verified { verifications } · approvalReviewStarted · approvalReviewCompleted · strictReviewRequired (the guardian's review of an
            action, in the user's auto-review mode) · safetyBuffering · moderated (each report as the server gives it)
Realized    natively (graph-integrity GI1)
## Message                                         concept
Purpose     Something said in a thread.
Extends     —                                     Subtypes: UserMessage, AgentMessage
Identity    turn + position
State       content: Content · createdAt: Time
Operations  copy()
Relations   turn: Turn (1)
Extension   subtype · provide (by its thread's provider) · attach · decorate · intercept · replace
Presented   MessageBlock

## UserMessage                                     subtype of Message
Adds        attachments: Attachment (*) · mentions: Mention (*) · steering: boolean (sent while the agent was working)

## AgentMessage                                    subtype of Message
Adds        phase: update | final · streaming: boolean
Events      updated (while streaming) · completed

## Content                                         value
Purpose     Rich text in messages, instructions, questions and comments.
State       parts: [ text | code { language, text } | link { url, text } | image { source } | mention (Mention) | fileLink { path, line? }
            | list | table | quote ]
Presented   ContentView (wherever content is shown)

## Attachment                                      concept
Purpose     A file or image attached to a message or a draft.
Identity    id
State       name: string · kind: file | image · size?: number (when known) · preview?: Image
Operations  open() · remove() (from a draft)
Relations   message: UserMessage (0..1) · draft: Draft (0..1) · file: File (0..1)
Extension   subtype · attach · decorate · intercept
Presented   Chip · MessageBlock

## Mention                                         concept
Purpose     A reference inside a message to something the agent should look at.
Identity    message or draft + position
State       label: string
Relations   target: Ref (any mentionable type: File, Folder, Skill, Plugin, Thread, …)
Extension   subtype · attach · decorate · provide (a type marked mentionable, 04 §8, appears in the mention menu)
Presented   Chip · PaletteResult (mention menu)

## Draft                                           concept
Purpose     The message you are writing, kept per thread. For a new thread, it also holds where the thread will run.
Identity    its thread (the app's draft key: a Codex chat's id, a provided chat's protocol id), or the new-thread draft of a window
State       content: Content · dictating: boolean
            · target?: { project?: Project, agent?: Agent, environment?: Environment, branch?: Branch, model?: Model, settings: { id: value } } (new threads only)
            (a new chat on a provided agent's model: `agent` is that model's and `settings` that agent's own, its Agent.settings by id,
            as the new chat holds them for the chat it starts, never set on the agent's Setting; `setTarget({settings: {id: null}})` takes
            one back to the agent's default; its `newThread` gets them in the Draft it is given)
Operations  setContent(content, { ifEmpty? }) · insert(text | mention) · attach(file | folder | skill | { text, name? } | { image, name? } | { url, title? })
            · clear() · send() → Turn | Thread · setTarget(target) · startDictation() · stopDictation()
            (setTarget's `environment` may also be `'worktree'`: a new worktree of the project, made when the thread is sent, from `branch`)
            (H5: `ifEmpty` writes only while the draft holds no text and no chip, read and written in one step where a composer shows it, else
            when the draft the app saved is empty; its attachments are not read. `attach({text, name})` writes a file of the framework's own
            (a week, then swept) and attaches it as a file, and `{image, name?}` (a PNG, JPEG, GIF or WebP data URL, at most 10 MB) the image's
            bytes the same way, or, where a composer shows the Draft, as the app's own paste there (its tray); `{url, title?}` inserts the
            link where the cursor is (`title: url`: the composer links it); a Skill inserts its chip. `attachments` are what its composers'
            trays show (images, files picked or dropped), each removable: Attachment.remove)
Events      changed · sent · cleared
Relations   thread: Thread (0..1) · attachments: Attachment (*) · mentions: Mention (*)
            (H5: `mentions` are the draft's chips the graph has a type for, in order: a file or folder, a skill, a plugin or app, a chat; a
            link, an MCP resource, a custom agent or a page are text only. Attachments are not read yet.)
Extension   attach · decorate · intercept (send, attach) · replace (dictation)
Presented   Composer · NewThreadView (a new thread's draft) · ComposerPicker · Palette (slash and mention menus)

## QueuedMessage                                   concept
Purpose     A follow-up waiting to be sent when the agent finishes.
Identity    thread + position
State       content: Content
Operations  edit(content) · sendNow() · remove() · move(position)
Events      queued · sent · removed
Relations   thread: Thread (1) · attachments: Attachment (*)
Extension   attach · decorate · intercept
Presented   QueueItem

## Automation                                      concept
Purpose     A task that runs on its own on a schedule. Each run starts a new thread, or continues the one thread it watches.
Extends     —                                     Subtypes: mod-defined (other triggers, for example "when a pull request opens")
Identity    id
State       name: string · prompt: Content · schedule: { kind: once | interval | calendar, … } · enabled: boolean · lastRunAt?: Time
            · nextRunAt?: Time · where?: local | worktree (a run's checkout) · notifications?: all | failures · archiveRuns?: boolean
Operations  runNow() → Thread · enable() · disable() · edit(fields) · delete() · open?() (where the user manages it)
Events      started { thread, turn?, scheduledAt? } · ran { thread, turn } · failed { thread, turn } · changed (a run's own turn: a run
            chat's first, or the turn in the thread it watches; `scheduledAt`: when it was due, as a schedule missed while the app was closed
            runs once, late, when it starts again)
Relations   agent: Agent (1) · project: Project (0..1) · settings: Setting (*) (thread settings for its runs) · runs: Thread (*)
            · watches: Thread (0..1) (when set, each run is a turn in that thread)
Extension   all
Presented   AutomationView · SidebarSection (automations) · SidebarItem · PaletteResult · NotificationBanner
Notes       A run in a new thread arrives unread, with origin automation. A run of an automation that watches a thread is a turn there,
            sent by the automation, and adds no unread state. An automation is created as the user sets one up: by its agent
            (Agent.newAutomation), a project (Project.newAutomation) or the thread it watches (Thread.automate), from an
            AutomationSpec: { name?, prompt: Content, schedule, enabled?, project?, watches?, settings?, where?, notifications?,
            archiveRuns? }; a mod's creation asks the user first.

---

## D. Agent activity

## Step                                            concept
Purpose     One thing the agent did during a turn.
Extends     —                                     Subtypes: Reasoning, Plan, CommandRun, FileEdit, Search, WebLookup, ToolCall, ComputerAction, Delegation, CodexStep (native); mod-defined
Identity    turn + position
State       status: running | done | failed | cancelled | waitingForYou · title: string · startedAt: Time · endedAt?: Time · _expanded?: boolean (UI state)
Operations  _expand() · _collapse() · copy()
Events      started · updated · finished
Relations   turn: Turn (1) · request: Request (0..1)
Extension   all
Presented   StepBlock
Notes       A step's block shows its title and status, and each native subtype's block what it adds. A mod's steps belong to its own
            threads and are drawn by its own view, with the lent step row (graph-integrity G2.3).

## Reasoning                                       subtype of Step
Subtypes    CodexReasoning (native)
Adds        thinking: Content (what the agent is thinking, as shown; every instance's `summary` is the generic one, 04 §8)

## CodexReasoning                                  subtype of Reasoning
Adds        summaryParts: string (*) · contentParts: string (*) (the server's summary and content, part by part, as they stream)
Realized    natively (graph-integrity GI1)

## Plan                                            subtype of Step
Adds        tasks: PlanTask (*)
Events      tasksChanged

## PlanTask                                        concept
Purpose     One item of the agent's plan.
Identity    plan + position
State       text: string · status: pending | inProgress | done
Relations   plan: Plan (1)
Extension   attach · decorate
Presented   StepBlock (plan)

## CommandRun                                      subtype of Step
Subtypes    CodexCommandRun (native)
Adds        command: string · directory: Path · output: text (streams) · exitCode?: number · duration?: Duration
Operations  copyCommand() · copyOutput() · stop?() · openInTerminal?()
Relations   terminal: Terminal (0..1)

## CodexCommandRun                                 subtype of CommandRun
Adds        shellCommand: string (the whole invocation; `command` is what the app shows) · commandActions: JSON (*) (the actions the server
            parsed) · processId?: string · source?: string · pluginId?: string · scriptPath?: Path
Realized    natively (graph-integrity GI1)

## FileEdit                                        subtype of Step
Adds        file: File · change: FileChange
Operations  openDiff() · openFile()

## Search                                          subtype of Step
Adds        query: string · scope: files | web · results: [{ title, location: Path | Url }]

## WebLookup                                       subtype of Step
Adds        url: Url · pageTitle?: string (the page's title; the step's own `title` names the step)
Operations  open() (in the browser panel)
Relations   tab: BrowserTab (0..1)

## ToolCall                                        subtype of Step
Subtypes    CodexToolCall (native)
Adds        tool: Tool · input: Content · output?: Content · error?: string

## CodexToolCall                                   subtype of ToolCall
Adds        server?: string · namespace?: string · toolName: string · arguments: JSON · result?: JSON · contentItems?: JSON · success?: boolean
            · durationMs?: number (the call as the server made it, its arguments and result as given)
Realized    natively (graph-integrity GI1)

## ComputerAction                                  subtype of Step
Adds        app: ExternalApp (0..1: none until the action names the app it uses, or for one that drives no app) · action: string
            · screenshot?: Image
Relations   session: ComputerUseSession (1)

## Delegation                                      subtype of Step
Adds        task: Content · child: Thread (the delegated work, with origin delegation) · agent?: Agent (when another agent does it)

## CodexStep                                       subtype of Step
Adds        itemType: string · item: JSON (an item of a kind the graph has no concept for, as given: a hook's prompt, an image viewed, a wait,
            a generated image, review mode, a compaction, a sub-agent's activity, or a kind newer than the library)
Realized    natively (graph-integrity GI1)

---

## E. Requests and access

## Request                                         concept
Purpose     The agent needs something from you before it continues.
Extends     —                                     Subtypes: Approval, Question; mod-defined
Identity    id
State       status: pending | answered | declined | expired | cancelled · from: agent | tool · askedAt: Time · answeredAt?: Time
            · outcome?: { decision: approved | denied | cancelled | answered, scope?: once | thread | always, option?: string (the
            provider's option) } (what was answered; a question's typed text is never kept) · answeredBy?: { kind: user | mod | app | unknown, id? (the mod), via?, through? (the mod whose surface the user answered in: G7.3), at: Time } (who:
            the app's answer is the user's, in a card, a notification or a key; a mod's, through the graph; the app's own, a request the
            server withdrew)
Operations  ask() (H6, public-hooks.md §3.6): what runs before the user is asked; its own part shows the request. A request some mod
            intercepts `ask` for is held before the app shows it; an interceptor answers in its place by returning `{approve: 'once' |
            'thread', automatic?}` or `{deny: true}` (the approval's own option of that kind), `{option: id, automatic?}`, or `{answers:
            {<prompt id>: {choices?, text?}}, automatic?}` (the mod's own answer: approving and answering are its automatic action or ask the
            user, declining needs no consent; an "always" option stays the user's), or lets it through (`next()`); the chain's end, its
            deadline or a fault shows it. The step's row then says who answered ("Approved by <mod>").
Events      opened · answered { outcome?, answeredBy? } · expired · cancelled { outcome?, answeredBy? }
Relations   thread: Thread (1) · turn: Turn (1) · step: Step (0..1) · tool: Tool (0..1) (when a tool asked)
Extension   all (intercepting the answer lets a mod answer by policy, or ask the user somewhere else)
Presented   RequestCard · NotificationBanner · Dialog · SidebarItem (status) · DockBadge
Notes       How to answer is defined by each subtype.

## Approval                                        subtype of Request
Purpose     Permission to do something.
Subtypes    CommandApproval, EditApproval, NetworkApproval, ToolApproval, ComputerUseApproval; mod-defined
Adds        reason?: string · options: [{ id, label, kind: approve | deny | cancel, scope?: once | thread | always }] (what its provider offers,
            as it labels it: approving once, for the chat, or always (a standing rule); declining; or declining and stopping the turn)
Operations  answer(option: id, feedback?: Content) (one of its options; feedback goes with a decline where the provider takes it)
Relations   rule: AccessRule (0..1, made by an `always` option)
Notes       Every provider's approvals are answered the same way, by a mod with the grant as by the app (graph-boundary.md §4, refereeing).
            The options are the provider's own, never reduced to scopes the framework guessed (graph-integrity G1.6).

## CommandApproval                                 subtype of Approval
Subtypes    CodexCommandApproval (native)
Adds        command: string (as it will run, a shell wrapper kept) · directory: Path · display?: string (as the app shows it)

## CodexCommandApproval                            subtype of CommandApproval
Adds        commandActions: JSON (*) (the actions the server parsed from the command) · availableDecisions?: JSON (*) · proposedExecpolicyAmendment?:
            string (*) (the rule its "always" would make) · proposedNetworkPolicyAmendments?: JSON (*) · networkApprovalContext?: JSON
            · approvalId?: string · itemId?: string (the request as the server asks it)
Realized    natively (graph-integrity GI1)

## EditApproval                                    subtype of Approval
Adds        files: [{ path: Path, change: add | update | delete, movedTo?: Path, added?: number, removed?: number }] (what it would apply,
            from its steps) · grantRoot?: Path (a request to write under that folder for the session)
Relations   edits: FileEdit (*) (its steps)

## NetworkApproval                                 subtype of Approval
Adds        host: string

## ToolApproval                                    subtype of Approval
Adds        input: Content (the tool is the request's `tool`, always set for a tool approval)

## ComputerUseApproval                             subtype of Approval
Adds        app: ExternalApp · action: string

## Question                                        subtype of Request
Purpose     A question you answer by picking or typing.
Subtypes    CodexQuestion (native); mod-defined
Adds        prompts: [{ id, header?: string, prompt: Content, choices: [{ id, label, description? }], other: boolean (your own words are
            taken), secret: boolean }] (every prompt it asks) · blocking: boolean (the agent waits for the answer) · autoResolveAfterMs?:
            number (it answers itself after that long)
Operations  answer(answers: { <prompt id>: { choices?: id[], text?: string } }) · skip()
Notes       An answer to a secret prompt is never kept or recorded: the runtime leaves its words out of every record (graph-integrity G1.5).

## CodexQuestion                                   subtype of Question
Adds        source: requestUserInput | elicitation (Codex's question tool, or a tool server's) · serverName?: string · requestedSchema?: JSON
            (a tool server's form, as given) · url?: Url · itemId?: string
Realized    natively (graph-integrity GI1)

## AccessRule                                      concept
Purpose     A standing permission, usually from "approve always".
Identity    id
State       kind: command | edit | network | tool | app · pattern: string · scope: project | global · createdAt: Time
Operations  remove()
Events      added · removed
Relations   project: Project (0..1) · approval: Approval (0..1) (where it came from)
Extension   all
Presented   SettingsRow (permissions)
Notes       Rules come from approvals. A mod can provide its own rules.

---

## F. Changes, review and version control

## ChangeSet                                       concept
Purpose     The changes a thread, or one of its turns, made to the code.
Identity    its thread or turn
State       fileCount: number · added: number · removed: number · state: proposed | applied | reverted | mixed
Operations  review() → Review · apply?() (proposed changes, for example from the cloud) · revert?() · patch?() → string (one unified diff: content)
            · commit?(message?: string) → Commit (without a message, the agent writes one) · openPullRequest?(title?, body?) → PullRequest
Events      changed · applied · reverted · committed
Relations   thread: Thread (1) · turn: Turn (0..1) · files: FileChange (*) · environment: Environment (0..1)
Extension   all
Presented   ChangesView · PanelTab · TurnView (summary) · SidebarItem (badge)
Notes       Local threads change your files as they work (applied; undo with revert). Cloud threads propose changes (proposed; apply to bring
            them in).

## FileChange                                      concept
Purpose     One file's change.
Identity    change set + path
State       path: Path · kind: added | modified | deleted | renamed · from?: Path · added: number · removed: number · state: proposed | applied | reverted
Operations  viewDiff() · openFile() · openIn(app: ExternalApp) · apply?() · revert?() · diff?() → string (its unified diff: content)
Events      changed
Relations   changeSet: ChangeSet (1) · file: File (0..1) · hunks: Hunk (*) · comments: Comment (*)
Extension   all
Presented   DiffView · ChangesView · StepBlock (file edit)

## Hunk                                            concept
Purpose     One contiguous change inside a file.
Identity    file change + position
State       before: { start, lines } · after: { start, lines } · state: proposed | applied | reverted
Operations  comment(content) → Comment · apply?() · revert?()
Relations   fileChange: FileChange (1)
Extension   attach · decorate · intercept
Presented   DiffView

## Comment                                         concept
Purpose     A note on lines of code or on a finding, for the agent or a reviewer.
Identity    id
State       content: Content · author: you | agent | reviewer · anchor: { path: Path, line?: number, endLine?: number } · state: draft | sent | resolved
Operations  edit(content) · send() (into the thread's draft, or straight to the agent) · resolve() · delete()
Events      sent · resolved
Relations   thread: Thread (0..1) · fileChange: FileChange (0..1) · finding: Finding (0..1)
Extension   all (a mod can provide comments, for example a pull request's review comments)
Presented   DiffView (inline) · ReviewView · MessageBlock (once sent)

## Review                                          concept
Purpose     A code review of changes, a branch or a pull request.
Identity    id
State       status: running | done | failed · target: ChangeSet | Branch | Commit | PullRequest · reviewer: Agent | string · overview?: Content
Operations  stop() · rerun?()
Events      started · findingAdded · done
Relations   thread: Thread (0..1) · turn: Turn (0..1) · findings: Finding (*)
Extension   all (a mod can provide reviews, for example from a linter or a human reviewer)
Presented   ReviewView · TurnView · PaletteResult
Notes       An agent's review runs as a turn of a thread: the current thread, or a new one. The review records that turn.

## Finding                                         concept
Purpose     One issue a review found.
Identity    review + position
State       title: string · detail: Content · severity: high | medium | low · state: open | fixed | dismissed
            · location?: { path: Path, line: number }
Operations  open() · dismiss() · comment(content) → Comment · fix?() (asks the agent to fix it)
Relations   review: Review (1) · comments: Comment (*)
Extension   all
Presented   ReviewView · DiffView (marker)

## Repository                                      concept
Purpose     A project's version control.
Extends     —                                     Subtypes: GitRepository (native); mod-defined (other version control systems)
Identity    its project
State       kind: string · dirty: boolean · remotes: [{ name, url }] · currentBranch?: Branch
Operations  commit(message?: string, files?: Path[]) → Commit · switchBranch(branch) · createBranch(name) → Branch · push?(branch?) · pull?()
            · fetch?() · workingChanges?(scope?: unstaged | staged | branch) → string (one unified diff, as the app's review shows it: content)
            · discard?(files: Path[], scope?: unstaged | staged) (their working changes thrown away, as the review reverts them)
Events      branchChanged · statusChanged · committed · pushed
Relations   project: Project (1) · branches: Branch (*) · commits: Commit (*) · pullRequests: PullRequest (*)
Extension   all
Presented   ChangesView · ThreadHeader (branch) · SidebarSection (branch label) · MenuEntry · PaletteResult

## GitRepository                                   subtype of Repository
Adds        staged: Path (*)
Operations  stage(files) · unstage(files)
Realized    natively

## Branch                                          concept
Purpose     A line of work in a repository.
Identity    repository + name
State       name: string · current: boolean · ahead?: number · behind?: number · upstream?: string
Operations  switch() · push?() · delete?() · openPullRequest?({base?, title?, body?, draft?}) → PullRequest
Relations   repository: Repository (1) · pullRequest: PullRequest (0..1)
Extension   all
Presented   ComposerPicker (branch) · ChangesView · ThreadHeader · PaletteResult

## Commit                                          concept
Purpose     A recorded set of changes.
Identity    repository + id
State       id: string · message: string · author: string · time: Time · files: number
Operations  open()
Relations   repository: Repository (1) · branch: Branch (0..1) · thread: Thread (0..1)
Extension   attach · decorate
Presented   ChangesView · TurnView

## PullRequest                                     concept
Purpose     A request to merge a branch, on a code host.
Extends     —                                     Subtypes: GitHubPullRequest (native); mod-defined (other code hosts)
Identity    url
State       title: string · state: draft | open | merged | closed · url: Url · number?: number · checks?: passing | failing | pending | none
            · reviewState?: approved | changesRequested | pending
Operations  open() (on the web) · refresh() · markReady?() · merge?()
Events      stateChanged · checksChanged
Relations   repository: Repository (1) · branch: Branch (1) · thread: Thread (0..1) · host: Account (0..1) · comments: Comment (*)
Extension   all
Presented   ChangesView · TurnView · SidebarItem (badge) · PaletteResult

## GitHubPullRequest                               subtype of PullRequest
Adds        GitHub's own fields as shown in the app (for example its reviewers)
Realized    natively, through the connected GitHub account

---

## G. Tools shared with the agent

## File                                            concept
Purpose     A file in a project.
Identity    project + path
State       path: Path · name: string · size: number · modifiedAt: Time · kind: string (text, image, binary, …)
Operations  open() (preview) · openIn(app: ExternalApp) · reveal() · attachTo(draft) · mentionIn(draft)
Events      changed · deleted
Relations   project: Project (1) · folder: Folder (1)
Extension   all
Presented   FilesView · FilePreview · PaletteResult · Chip

## Folder                                          concept
Purpose     A folder in a project.
Identity    project + path
State       path: Path · name: string · _expanded?: boolean (while a files view shows it)
Operations  open() · reveal() · openIn(app: ExternalApp) · mentionIn(draft)
Relations   project: Project (1) · parent: Folder (0..1) · files: File (*) · folders: Folder (*)
Extension   all
Presented   FilesView · Chip

## Terminal                                        concept
Purpose     A terminal session in a project or a thread, shared with the agent.
Identity    id
State       title: string · directory: Path · running: boolean · startedBy: you | agent · shell: string
Operations  run(command) · write(text) · clear() · stop() · close() · focus() · tail?(lines?) → string (its last lines of output: content)
Events      output · exited · closed
Relations   project: Project (0..1: none for a terminal opened outside every project) · thread: Thread (0..1) · commandRuns: CommandRun (*)
Extension   all
Presented   TerminalView · PanelTab

## BrowserTab                                      concept
Purpose     A page in the in-app browser.
Identity    id
State       url: Url · title: string · loading: boolean · canGoBack: boolean · canGoForward: boolean · controlledBy: you | agent
Operations  navigate(url) · reload() · back() · forward() · close() · openExternally()
Events      navigated · loaded · closed
Relations   thread: Thread (0..1) · webLookups: WebLookup (*)
Extension   all
Presented   BrowserView · PanelTab

## ComputerUseSession                              concept
Purpose     The agent operating other apps on your Mac during a turn.
Identity    id
State       status: running | paused | stopped · app?: ExternalApp (the app in use)
Operations  pause() · resume() · stop()
Events      started · actionTaken · stopped
Relations   thread: Thread (1) · actions: ComputerAction (*)
Extension   all
Presented   StepBlock · StatusItem · NotificationBanner

## ExternalApp                                     concept
Purpose     Another app on your Mac: one Codex opens things in, or one the agent can operate.
Identity    the app's bundle
State       name: string · icon: Image · opens: [project | file | folder | url] · computerUse: always | ask | never | unsupported
Operations  open(target: Project | File | Folder | Url) · setComputerUse(level)
Events      changed
Relations   sessions: ComputerUseSession (*)
Extension   all (a mod adds an "open in" target)
Presented   MenuEntry ("Open in") · SettingsRow (default editor, computer use) · Dialog (permission) · StepBlock

---

## H. Agent extensions

## ToolServer                                      concept
Purpose     A connected tool server (MCP) that gives agents tools.
Identity    name
State       name: string · status: connected | starting | error | disabled · transport: local | remote · auth: none | signedIn | needsSignIn
            · error?: string
Operations  edit(config) · enable(scope?) · disable(scope?) · inherit?(scope) · restart() · remove() · signIn?() · signOut?() (one is
            added by its agent: Agent.addToolServer); `scope` is `{project}`: on or off in that project's own settings (its threads), and
            inherit takes the project's own setting away (it follows the user's again)
Events      statusChanged · toolsChanged
Relations   tools: Tool (*) · agents: Agent (*) · account: Account (0..1) · plugin: Plugin (0..1) (when a plugin brought it)
            · enabledIn?: Project (*) · disabledIn?: Project (*) (the projects whose own settings turn it on, or off)
Extension   all
Presented   SettingsRow (tools) · SettingsPage

## Tool                                            concept
Purpose     Something an agent can call.
Identity    source + name
State       name: string · description: string · enabled: boolean · source: ToolServer | Plugin | built-in | mod (a mod's, as a thread took it)
Operations  enable() · disable() · _call?(args, env?) → result (G3.5, mechanism: the agent's call; a mod's tool, `mod_<id>/<name>`, is
            answered by its mod only, and while that mod is off the framework answers that it is not running)
Relations   server: ToolServer (0..1) · plugin: Plugin (0..1) · calls: ToolCall (*)
Extension   all
Presented   SettingsRow (tools) · StepBlock (tool call)

## Plugin                                          concept
Purpose     An installable package that adds tools, skills and connections.
Identity    id
State       name: string · description: string · installed: boolean · enabled: boolean · connected?: boolean (when it links an outside account)
Operations  install() · uninstall() · enable(scope?) · disable(scope?) · inherit?(scope) · connect?() · disconnect?() (`scope` as
            ToolServer's: one project's own settings)
Events      installed · uninstalled · enabled · disabled · connected · disconnected
Relations   tools: Tool (*) · skills: Skill (*) · toolServers: ToolServer (*) · agents: Agent (*) · account: Account (0..1)
            · enabledIn?: Project (*) · disabledIn?: Project (*) (the projects whose own settings turn it on, or off)
Extension   all
Presented   SettingsRow (plugins) · SettingsPage · Chip (mention) · Dialog (connect) · PaletteResult

## Skill                                           concept
Purpose     A packaged ability an agent can use.
Identity    scope + name
State       name: string · description: string · scope: global | project · source: built-in | yours | library · installed: boolean · enabled: boolean
Operations  edit() · enable() · disable() · delete() · use(draft) (invoke it in a message) · install?() (from the library)
            (a new one: its agent's addSkill)
Events      added · changed · removed
Relations   project: Project (0..1) · agents: Agent (*) · plugin: Plugin (0..1)
Extension   all
Presented   SettingsRow (skills) · ListItem (its card on the Skills page) · PaletteResult (slash menu) · Chip

---

## I. Commands

## Command                                         concept
Purpose     An action the user can trigger by name.
Extends     —                                     Subtypes: SlashCommand, ProjectAction; mod-defined
Identity    id
State       title: string · category: string · enabled: boolean · appliesTo?: type (for context menus: the type it acts on)
Operations  run(args?)
Events      ran
Relations   shortcut: Shortcut (0..1)
Extension   all
Presented   MenuEntry · PaletteResult · SettingsRow (shortcuts)
Notes       Every operation of every type can be offered as a command; the app's own menus and palette entries are commands. A mod's
            command (`ui.commands.add`) is a Command too (provider `codexmods.commands`, `<mod>/<id>`, its category the mod's name); its
            run is the mod's own, as its palette row runs it.

## SlashCommand                                    subtype of Command
Adds        name: string (typed after "/") · arguments?: string · custom: boolean · prompt?: Content (a saved prompt it inserts)
Presented   PaletteResult (slash menu in the composer)

## ProjectAction                                   subtype of Command
Purpose     A project's own button, such as Run or Test.
Adds        project: Project · command: string (what it runs) · icon?: Image
Presented   ThreadHeader (buttons) · MenuEntry · PaletteResult
Notes       Its run() is Command's: it runs in a terminal of the thread or the project.

## Shortcut                                        concept
Purpose     A key binding for a command.
Identity    keys
State       keys: string · command: Command · custom: boolean
Operations  rebind?(keys) · reset?()
Events      changed
Relations   command: Command (1)
Extension   attach · decorate · intercept
Presented   SettingsRow (shortcuts) · MenuEntry

---

## J. Attention

## Notification                                    concept
Purpose     Telling you something happened when you are not looking.
Identity    id
State       title: string · body: string · kind: finished | failed | approval | question | limit | update | other · createdAt: Time · read: boolean (opened or dismissed)
Operations  open() (go to its source) · dismiss()
Events      shown · opened · dismissed
Relations   source: Ref (Thread, Request, Usage, Update, Automation, …)
Extension   all
Presented   NotificationBanner

---

## K. Settings

## Setting                                         concept
Purpose     One preference.
Identity    key
State       title: string · value: any · default: any · scope: app | project | thread · kind: toggle | choice | text | number | shortcut | list | record | color | time | timerange
            · description?: string · choices?: [{ id, label, value?, description?, media? }] (a choice's `value` is the setting's value when it is chosen, its id when absent; may depend on other settings: an effort's choices follow the model)
            · control?: select | segmented | thumbnails | stepper | slider | line | area (how a mod's is drawn; `kind` stays what the value is) · icon?: string
            · min?, max?, step?: number · unit?, placeholder?, group?: string · structured?: boolean (a list whose items are more than text)
            · requires?: { key, not? } · active?: boolean (what it requires holds at this instance's scope; a row not active is not shown and keeps its value)
            · needs?: string (a permission its mod declares) · key?: string (its key within what defines it, the same at every scope: a chat's
            own instance is the one of `Thread.settings` with its `definedBy` and `key`)
            · overridden?: boolean (set at this scope, not inherited) · configured?: any (the value the user set, where the app uses
            another for now: its own policy; `value` is the one in effect) · scopes?: [app | project | thread] (where it may be set)
Operations  set(value) · reset() (the user's value taken away: the default holds then)
Events      changed
Relations   section: SettingsSection (1) · definedBy: App | Agent | Plugin | Skill | Mod (1: what defines it; its settings are a query, whoever provides them)
            · project: Project (0..1) · thread: Thread (0..1)
Extension   all (a mod adds its own settings; the app shows them like its own)
Presented   SettingsRow · ComposerPicker (thread-scope settings)
Notes       A thread-scope setting has project and app defaults: the composer sets it for one thread, and settings set the defaults.
            A mod changes some for a while with `ctx.graph.override` (public-hooks.md §3.14): the user's values are kept on this Mac and
            come back when it ends; one the user changes meanwhile stays theirs.

## SettingsSection                                 concept
Purpose     A group of settings.
Identity    id
State       title: string · description?: string · icon?: string · media?: { id, caption?, aspect? } (Mod.image gives it)
Operations  resetAll()? (every value stored at the app scope in it, hidden rows included; never a project's or a chat's)
Relations   settings: Setting (*) · parent: SettingsSection (0..1) · children: SettingsSection (*) (its subsections)
Extension   all
Presented   SettingsPage
