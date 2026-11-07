# 06 Review

## Decisions

The first draft left 15 questions open, and its self-review found 7 gaps. Each is decided below, with the cards it shapes. If the owner
overrules one, the listed cards change.

| # | Question or gap | Decision | Cards |
|---|---|---|---|
| D1 | Is Agent a concept? | Yes. Every thread has an agent, and a mod adds an agent by subtyping Agent and Thread and providing both. Agent's core is what the shared surfaces need: its name, icon, availability, threads and `newThread`. What an agent is made of (models, thread settings, tool servers, plugins, skills, instructions, an account) is its subtype's, CodexAgent's for Codex (revised 2026-11-04 by README rule 8). | Agent, CodexAgent, Thread |
| D2 | Is git the only version control? | No. Repository and PullRequest are generic concepts with GitRepository and GitHubPullRequest as native subtypes. Branch and Commit are common to version control and stay concepts. | Repository, GitRepository, Branch, Commit, PullRequest, GitHubPullRequest |
| D3 | Threads without projects? | Allowed: `Thread.project` is 0..1, and the sidebar has a section for them. | Thread, Sidebar |
| D4 | Editing an earlier message? | `Turn.rewind?(content)`: edit and continue from that turn. It is optional because not every agent supports it. | Turn, MessageBlock, TurnView |
| D5 | Keep and undo granularity? | ChangeSet, FileChange and Hunk all have `apply?` and `revert?`; the provider declares which it supports. | ChangeSet, FileChange, Hunk |
| D6 | Are local changes applied or proposed? | Local threads change files as they work: their changes are applied, and you revert. Cloud threads propose changes, and you apply them. A change set can be mixed. | ChangeSet |
| D7 | Is a review its own thread? | A review by an agent runs as a turn of a thread (the current one or a new one) and records that turn. Reviews can also be provided by mods, for example from a linter. | Review, Thread |
| D8 | Which cloud features does the app show? | Status and results in the app; setup on the web (`CloudEnvironment.manage()`); results come in through `ChangeSet.apply()`. | CloudEnvironment, ChangeSet |
| D9 | Usage per agent? | Usage belongs to an Account, and its core is that account. Codex's limits are CodexUsage's facts, unreduced, and a thread's usage is CodexThread's. A mod's agent shows its own usage; no shared surface shows it (revised by README rule 8). | Usage, CodexUsage, Account, CodexThread |
| D10 | Access and effort for other agents? | They are not fixed values. Each agent defines its own thread settings. Codex's are Settings with thread scope that CodexAgent defines: reasoning effort, access, personality, mode and web search (on the subtype: README rule 8). Effort choices come from the model (`Model.efforts`). AccessMode and ReasoningEffort are removed. | Setting, Agent, CodexAgent, Model, ComposerPicker |
| D11 | Sub-agents? | A Delegation step, and `Thread.parent` and `children` with origin delegation. | Delegation, Thread |
| D12 | Automations? | Included: Automation is a concept, its runs are threads, and mods can subtype it for other triggers. | Automation, AutomationView |
| D13 | Voice? | Dictation into the draft. A spoken conversation mode is a server-side ChatGPT feature and out of scope. | Draft |
| D14 | Several accounts? | One ChatGPT sign-in. Account is generalized so that the app's other connections (GitHub, a plugin's service, a tool server) are Accounts too. A mod's agent keeps its own account (revised by README rule 8). | Account, ChatGPTAccount |
| D15 | Per-window themes? | No: the Theme is app-wide. | Theme |
| D16 | Gap: presentation was thin | Presentations are graph objects (03): a Presentation concept and its presentation types, each with a subject, slots and operations. Shared surfaces render concepts; a main view is its provider's, a mod's registered for its own types, and the DetailView is a developer inspector (revised by README rule 8). | 03, 04 §8 |
| D17 | Gap: no tiers or capabilities | Three tiers per concept (README rule 2). Providers declare their support for optional members (04 §4), and presentations offer only what is supported. | every concept, 04 §4 |
| D18 | Gap: no way to add a concept | `define` (04 §7). A defined concept gets everything a concept gets, and its mod registers the views that show it (revised by README rule 8). | 04 §7 |
| D19 | Gap: the agent asking a question | Request is the concept for everything the agent needs from you. Approval and Question are its subtypes, and a mod can add others. A thread is waiting for you while a request is pending. | Request, Approval, Question, RequestCard |
| D20 | Gap: missing features | Added: automations, comments on lines, "Open in" other apps, project actions, delegations, rewind, connected accounts, threads from other clients. | Automation, Comment, ExternalApp, ProjectAction, Delegation, Turn, Account, Thread |
| D21 | Gap: Codex values outside subtypes | AccessMode and ReasoningEffort are removed (D10). Account and Usage are generalized (D9, D14). AppAccess becomes ExternalApp, which also serves "Open in". | as listed |
| D22 | Gap: git as the concept | Resolved by D2. | as D2 |
| D23 | Who serves a thread's parts? | The thread's provider (04 §7, containment): the parts others address (its requests and turns), and its messages, steps and changes when it wants other mods to read or intercept them. Its own view draws from its own data with the lent parts (revised by README rule 8). | Turn, Message, Step, Request, ChangeSet |
| D24 | Two mods replacing the same thing | The user's priority order decides, and the other mod is told (04 §7, order). | 04 §7 |

## The checklist

For every type:
1. **Feature:** it traces to a feature in 01, and that feature lists it.
2. **Small core:** its required members are what its shared surfaces and cross-provider authority need of every instance (README rule 8).
3. **Specifics in subtypes:** nothing specific to Codex, or to one implementation, sits in a concept's core or among its standard optional
   members. What one implementation is made of, or reports beyond the core, is its subtype's (README rule 8).
4. **Standard optional members:** each `?` member has the same meaning for every provider.
5. **Extensible like native:** a mod can define, subtype, provide, attach, decorate, intercept or replace it with the mechanisms the native
   app uses.
6. **Presented:** every presentation it names exists in 03.
7. **No exception:** nothing about it is special-cased.
8. **Kinds from the concept:** each member's kind and cardinality are justified by the concept, never by a presentation that draws it
   (graph-integrity G4.5). Added with GI4 (2026-11-05); the members it caught changed with GI1 and GI4: a Question's prompts (a list, not
   one), a Setting's kinds at every scope (not only what the composer draws), `ui.ask`'s fields (the settings' schema, not the dialog's
   own kinds) and a Window's `shows` (all it presents, not one `current`). The table's columns record rules 1 to 7; rule 8 applies to every
   review from now on.

✓ passes · ~ passes with a note · ✗ fails · — does not apply (subtypes have no core of their own; values have no extension or
presentation of their own).

| Type | Kind | Features | 1 | 2 | 3 | 4 | 5 | 6 | 7 | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| App | concept, one | F14 | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | One instance: extended (attach, decorate, intercept), not subtyped or provided. Intended. |
| Account | concept | F9, F13 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | The app's connections. A mod's agent keeps its own account (rule 8). |
| ChatGPTAccount | subtype | F13 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | |
| Usage | concept | F13 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | Its core is its account (rule 8). |
| CodexUsage | subtype | F13 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | The server's snapshots, unreduced; every report an event. Realized with GI1. |
| Update | concept | F14 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| Theme | concept, one | F14 | ✓ | ✓ | ✓ | — | ~ | ✓ | ✓ | One instance, as App. Mods follow its tokens. |
| Project | concept | F1 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| LocalProject | subtype | F1 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | |
| Environment | concept | F1, F2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| LocalEnvironment, WorktreeEnvironment, CloudEnvironment | subtypes | F2 | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Instructions | concept | F1, F9 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Where they live is each agent's own (rule 8). |
| CodexInstructions | subtype | F9 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | Scope and file. Realized with GI1. |
| Agent | concept | F2, F13 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Its core is what shared surfaces need (rule 8). |
| CodexAgent | subtype | F2, F4, F6, F13 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | What Codex's agent is made of (rule 8). Its thread settings are Settings, not fields. |
| Model | concept | F4, F13 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ~ | `efforts` may be empty for a model without reasoning levels. |
| Thread | concept | F2–F5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Model and pinning are optional. Codex's goal, context, usage, client and send options are CodexThread's (rule 8). Access and effort are the agent's settings. |
| CodexThread | subtype | F2 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | Environments, the cloud task link, Codex's settings, and what Codex reports beyond the core (rule 8). |
| Turn | concept | F3, F5 | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | Provided by its thread's provider (D23). `startedBy` is attribution (rule 8). |
| CodexTurn | subtype | F5 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | Why Codex's app started it. Realized with GI1. |
| Message, UserMessage, AgentMessage | concept, subtypes | F3 | ✓ | ✓ | ✓ | — | ~ | ✓ | ✓ | As Turn. |
| Content | value | F3 | ✓ | — | ✓ | — | — | ✓ | ✓ | Rendered by ContentView, whose part renderers are a slot. |
| Attachment | concept | F3, F4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Mention | concept | F3, F4 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | Any mentionable type can be its target. |
| Draft | concept | F4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| QueuedMessage | concept | F4 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| Automation | concept | F10 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Step | concept | F3 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| Reasoning, Plan, CommandRun, FileEdit, Search, WebLookup, ToolCall, ComputerAction, Delegation | subtypes | F2, F3, F8, F9 | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | |
| CodexReasoning, CodexCommandRun, CodexToolCall, CodexStep | subtypes | F3 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | The server's items at its fidelity; a kind with no concept kept as given. Realized with GI1. |
| PlanTask | concept | F3 | ✓ | ✓ | ✓ | — | ~ | ✓ | ✓ | Provided with its plan (D23). |
| Request | concept | F6, F11 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Approval and its five subtypes | subtypes | F6 | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | The provider's own options, one answer (G1.6). |
| CodexCommandApproval | subtype | F6 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | The request as the server asks it. Realized with GI1. |
| Question | subtype | F6 | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | Every prompt, answered by its id; a secret answer never recorded (G1.5). |
| CodexQuestion | subtype | F6 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | Its question tool's or a tool server's, as given. Realized with GI1. |
| AccessRule | concept | F6 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| ChangeSet, FileChange, Hunk | concepts | F2, F7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Comment | concept | F7 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| Review, Finding | concepts | F5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Repository | concept | F1, F7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Staging is in GitRepository. |
| GitRepository | subtype | F1, F7 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | |
| Branch, Commit | concepts | F1, F5, F7 | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | Common to version control systems, but not to all of them. A system without branches provides none. |
| PullRequest | concept | F5, F7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| GitHubPullRequest | subtype | F7 | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | |
| File, Folder | concepts | F4, F8 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| Terminal | concept | F8 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| BrowserTab | concept | F8 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| ComputerUseSession | concept | F8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| ExternalApp | concept | F1, F7, F8, F14 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| ToolServer, Tool, Plugin, Skill | concepts | F9 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Command | concept | F12 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| SlashCommand, ProjectAction | subtypes | F1, F4 | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Shortcut | concept | F12 | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | Attached to commands; it is not subtyped. |
| Notification | concept | F11 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | |
| Setting, SettingsSection | concepts | F1, F4, F13, F14 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `definedBy` lets agents, plugins and mods define settings. |

No ✗ remain. The ~ marks are intended limits, explained in their notes. The mechanical part of the check (columns 1 and 6) is done by
the cross-check below.

## Cross-check

[`scripts/graph-check.mjs`](../../scripts/graph-check.mjs) checks the plan, and `npm test` runs it (`tests/graph-docs.test.mjs`):
- every type card in 02 appears in 01, and every type 01 names has a card;
- every relation in 02 points at a type that has a card;
- every subtype names its concept, and the concept lists it;
- every presentation named in 01 and 02 has a card in 03, and every presentation card is used;
- every name in 03's Presents, In and Contains lines, and in the 05 diagrams, has a card.

Last result (2026-11-04, after the ownership review): 86 types (51 concepts, 33 subtypes, 2 values), 45 presentation types and the Presentation concept,
**0 problems**. The presentations no feature names are the DetailView, the developer inspector (03), and a Page and a Region, which are a
mod's own. The
test also plants four errors in a copy (an unknown type in 01, an unknown presentation and an unknown relation target in 02, a subtype
missing from its concept's list) and expects all four to be reported.

## What changed from the first draft

**Added:**
- Concepts: Request, Automation, Comment, ExternalApp (replacing AppAccess).
- Subtypes: ChatGPTAccount, LocalProject, Question, Delegation, GitRepository, GitHubPullRequest, ProjectAction.
- Features: project actions, "Open in", threads without a project, threads from other clients, delegations, questions, rewind, comments
  on lines, apply and revert per hunk, staging, pull request state, connected accounts, the skill library, automations, back and
  forward.
- Presentations: 37 presentation-type cards replace the 11 surface cards.
- Protocols: tiers and capabilities, `define`, deeper subtypes, containment, search and reflection, summaries, `presentations`, navigation,
  priority order.

**Removed:** AccessMode, ReasoningEffort and AppAccess (D10, D21).

**Changed:**
- Thread has a smaller core: its optional members are marked, and Codex's settings moved to the agent.
- Approval became a subtype of Request.
- Account, Usage, Repository and PullRequest were generalized.
- Model moved under agents and gained `efforts`.
- Setting gained thread scope, `definedBy` and dynamic choices.
- Step's waiting status became `waitingForYou`.

## Out of scope here

- **Server-side ChatGPT features outside Codex.**
- **The framework's own objects** (installed mods, consent, recovery, updates of mods). They get their own graph, built the same way.
