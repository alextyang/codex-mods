# Writing a mod

A mod is a folder: a `mod.json` manifest and one or two entries. Its **host entry** (`host.mjs`) runs in a worker thread of its own in the
Host, the framework's process beside the app. Its **renderer entry** (`renderer.mjs`) runs in the app's page, in every window. Both get a
`ctx`: `ctx.graph` is the app as a graph of instances (chats, turns, messages, settings, windows) that a mod reads, acts on, adds to and
intercepts under the grants the user gave it; `ctx.ui` adds to what the app shows. The types are in [`sdk/index.d.ts`](../sdk/index.d.ts);
the graph's types are in [docs/graph/](graph/).

## Start from a starter

Each starter is a working mod with its test. Pick the one closest to what you want:

| Kind | What it is | Entries |
|---|---|---|
| `panel` (the default) | A tab of the side panel beside a chat, reading that chat from the graph and following it live | renderer |
| `rule` | A presentation rule: badges on the app's chats, wherever the app shows them | renderer |
| `contribution` | A setting of each chat, given to the agent with every message sent in that chat | host, renderer |
| `agent` | An agent of your own: its chats listed with the app's, answered by your code, opened to your own view | host, renderer |

```bash
node cli/codexmods.mjs new acme.my-mod --kind panel
```

That creates `./acme.my-mod` (or `--dir <path>`), with the starter's id replaced by yours everywhere. Then:

```bash
cd acme.my-mod && node --test
```

```bash
node cli/codexmods.mjs dev ./acme.my-mod
```

`dev` installs it into your modded copy as a development package and reads it again whenever its files change; `--approve` grants
its permissions at the first install (you wrote it), otherwise approve it in the app. Its test loads `@codexmods/sdk/testing` when that
is installed, else the testing kit of the checkout that made it. There is no npm package yet: `@codexmods/sdk` is this repository's
`sdk/` folder, and a mod's entries are single files that import nothing (Node built-ins only in the host entry), so a mod runs as it
is, without a bundler.

## Testing

`@codexmods/sdk/testing` (`sdk/testing/` in this repository) tests a mod without the app:

- **`createTestGraph()`** is the graph a mod meets in the app, offline: the real runtime (types, store, grants, policies,
  interception), with the app's own instances coming from providers the test declares (`provider('codex', types)`). It refuses what the
  app refuses your grants (a link to another provider's instance needs `graph.read` and `graph.contribute` for it), and
  `createTestGraph({path})` runs a session's program from a PATH of your own (a stand-in for `claude`, say). `mod(dir)` installs
  and starts a mod from its folder, its host entry in a worker as the Host runs it; `renderer()` is its renderer realm's ctx. `invoke`
  acts as the user (or the app). `agent()` is the agent's side: a message sent there runs the interceptors as the app's own send does and
  answers what the agent would be given.
- **`createFakeRendererContext({manifest, graph})`** draws what a renderer entry declares (panel tabs, regions, pages, presentation
  rules) with the framework's kit and lent parts, reading the graph you give it as the mod. `control.render(id, props)` renders a
  declaration; `control.rules`, `control.panels` and `control.hostRules` are what it declared. A rule without its grant is refused as the
  app would refuse it.
- **`createFakeHostContext`** fakes the app-server plane, for a mod that is low-level by intent.

## The manifest

`mod.json` says what the mod is, what it runs and what it may do. The validator is `framework/host/packages/manifest.mjs` (the same one
`codexmods dev` and `pack` run); the full shape, with a comment on each field, is [`contracts/manifest.d.ts`](../contracts/manifest.d.ts).

```json
{
  "id": "acme.my-mod",
  "version": "1.0.0",
  "name": "My mod",
  "description": "One sentence for the Mods list.",
  "author": "Acme",
  "glyph": "sparkle",
  "framework": ">=1 <2",
  "entry": { "host": "host.mjs", "renderer": "renderer.mjs" },
  "about": ["A paragraph for its page."],
  "permissions": ["ui", "graph.read:CodexThread", "graph.present:SidePanel"],
  "settings": [{ "key": "verbose", "kind": "toggle", "default": false, "title": "Say more" }]
}
```

| Field | What it is |
|---|---|
| `id`, `version`, `name`, `description` | Reverse-DNS id (lowercase letters, digits, `.` and `-`; `codexmods.*` ids of the framework's own are reserved), strict semver, and what the Mods list shows |
| `author`, `glyph`, `about`, `media` | Its page: who made it, a glyph of the kit's set (`framework/renderer/present/kit/glyphs.mjs`), up to 20 paragraphs, up to 12 images |
| `framework`, `testedWith`, `requires`, `optional` | The framework versions it runs on (a semver range), the app builds it was tested with, and the capabilities and features it needs or can do without (Settings → Mods says when a build lacks one) |
| `entry` | `host`, `renderer` or both |
| `permissions`, `optionalPermissions`, `permissionNotes` | What the user consents to (below); optional ones the user may leave off, asked for with `ctx.permissions.request`; a note per permission saying why |
| `settings` | Its settings, drawn by the framework on its page (kinds `toggle`, `choice`, `text`, `number`, `shortcut`, `list`, `record`, `color`, `time`, `timerange`; controls `select`, `segmented`, `thumbnails`, `stepper`, `slider`, `line`, `area`; `scope` `app`, `project` or `thread`; `requires` another setting to show) |
| `automatic` | Its automatic actions (below) |
| `intelligence` | Its model use (below) |
| `processes` | Its processes (below) |
| `data` | `schemaVersion` of its storage and `migrate` (a module run when an update changes it, before the new version starts; `Migrate` in `sdk/index.d.ts`) |

## Grants

`permissions` in `mod.json` are what the user consents to; consent says each in plain words. Ask for what the mod uses, scoped to the
types and operations it needs:

- `graph`: its own types and instances (an agent's chats).
- `graph.read:<Types>`, `graph.act:<Type.op>`, `graph.intercept:<Type.op>`: others' instances (the app's chats, turns, messages). A
  concept covers its subtypes; act and intercept name `<Type>.<operation>`.
- `graph.attach:<Types>`: its own values kept on others' instances (`ctx.graph.attach`). `graph.contribute:<Concepts>`: its own instances
  linked to others' (a setting of each chat).
- `graph.present:<Presentations>`: where it draws or adds (`SidePanel`, `SidebarItem`, `ThreadHeader`, `Composer`, `ThreadView`,
  `SettingsPage`, `Menu`, ...).
- `ui`: controls in the interface. `secrets`: its own secrets (`ctx.secrets`). `network`: it reaches the network.
- `processes`, `processes.exec:<programs>`: processes (below).
- `appServer.observe|request|intercept[:<methods>]`, `appServer.backends`, `appServer.clients`: the app-server protocol itself, for a mod
  that is low-level by intent (most mods need none: the graph has the app's features).

## Acting as the user, and on its own

A mod acting alone on something the user owns (sending in their chat, stopping it, signing out) is asked of the user, each time, in the
window they are in. Two things change that:

- **The user's own act.** A control the framework draws for the mod (a kit or lent part, an answer to its `ui.ask`, a `SettingRow`) carries
  the user's intent: its callback's last argument is `{asUser}` (after the event, if any). Pass it on from the renderer realm,
  `ctx.graph.invoke(ref, op, args, {asUser})`, and the act is the user's, through the mod (`caller.through`): nothing is asked. A context
  menu entry or a command gets it as `env.asUser`. An intent is good once, for a few seconds, from the window it was made in; the host
  realm never has one. The app's native menus (a project's or a chat's context menu) cannot attest: an act from them asks.
- **Automatic actions.** An act the mod makes on its own while the user lets it, without asking each time. Declare it:
  `"automatic": [{ "id": "switch", "operation": "Thread.moveToAccount", "why": "…", "perHour": 60 }]` (optionally bounded by `where` on the
  instance and `args`). The user turns it on on the mod's page (or `codexmods mods automatic <mod> <id> on`). Make the call with
  `invoke(ref, op, args, {automatic: 'switch'})`, or from an interceptor `next({args, automatic: 'switch'})`. Check first with
  `ctx.graph.assess(ref, op, args, {automatic})` (`status: 'allowed'` when it would go through without asking) so a mod that is not
  allowed simply does nothing.

## The ctx

Both realms have most namespaces; the types and every member's contract are in [`sdk/index.d.ts`](../sdk/index.d.ts).

| Namespace | For | Members | An example |
|---|---|---|---|
| `ctx.mod`, `ctx.log` | Its id, version and data folder; its log (Settings → Mods → its page) | `debug`, `info`, `warn`, `error` | every mod |
| `ctx.settings` | Its declared settings, at the app, a project or a chat | `get(key?, {project?, thread?})`, `set`, `reset`, `onChange` | `live-usage` |
| `ctx.storage` | Its own data (JSON), kept with its data and migrated by `data.migrate`; `retained` is never snapshotted or migrated | `get`, `set`, `delete`, `list`, `transaction`, `watch` | `live-usage`, `multi-panel` |
| `ctx.secrets` | Its secrets, kept in the macOS Keychain under the mod's own name (grant `secrets`) | `get`, `set`, `delete` | `better-questions` |
| `ctx.permissions` | Its optional permissions | `state`, `request`, `onChange` | `better-questions` |
| `ctx.events` | Topics between its realms (`mod/<its id>/…` to emit) and the framework's state topics | `on(topic, fn, {replay})`, `emit`, `state` | `account-switcher` |
| `ctx.services` | Calls between mods, realms and apps of yours outside Codex; each handler is told its caller | `provide(name, handlers)`, `call(modId, name, method, args)` | `project-orchestrator` |
| `ctx.scheduler` | Jobs at a time, kept across restarts; a job interrupted by a crash comes back once as `uncertain` (look up keyed calls with `graph.made`) | `schedule`, `cancel`, `on`, `get`, `list` | `live-usage` |
| `ctx.intelligence` | Model use (below) | `ask`, `status` | `smart-composer` |
| `ctx.processes` | Its processes (host realm; below) | `call`, `start`, `write`, `stop`, `on` | `claude-code` |
| `ctx.graph` | The app as a graph (below) | host: `subscribe`, `resolve`, `list`, `query`, `search`, `related`, `invoke`, `invokeAll`, `assess`, `can`, `made`, `intercept`, `policy`, `defaults`, `override`, `after`, `attach`, `attached`, `registerTypes`, `provide`; renderer: the reads, `subscribe` and `invoke` | every mod |
| `ctx.ui` | What it adds to what the app shows: data rules in both realms (`decorate`, `hide`, `reorder`, `add`, `style`, `status`, `notify`, `ask`, `contextMenu`, `commands`, `composer.*`, `palette.source`, `banner`, `settings.section`, …), components in the renderer realm (`panel`, `regions`, `replace`, `settings.page`, `components`, `react`) | see `DataRules` and `Ui` in `sdk/index.d.ts` | `ui-tweaks`, `multi-panel`, `thread-settings` |
| `ctx.appServer` | The protocol itself (grants `appServer.*`) | `request`, `notify`, `observe`, `intercept`, `backends`, `clients` | `live-usage` (`clients.issue` for its menu bar app) |

**The graph.** `subscribe(query, fn)` is a view: a snapshot, then deltas (`{type: 'delta', event}`), for an instance (`{ref}`), a
relation (`{ref, relation}`) or a type (`{type, where?}`), each instance's `state` and `links`. `invoke(ref, op, args)` runs an operation
with every check (grants, policies, interceptors, the user's approval). The types, their members and their operations are the cards in
[docs/graph/02-types.md](graph/02-types.md).

## Interceptors

`ctx.graph.intercept(type, op, (call, next) => …, opts)` runs before the operation, in the user's order of mods. Return `next()` (or
nothing after calling it) to let it go on, `next({args})` to change it (the change is this mod's call: checked and asked about as its
own, unless it names an automatic action), `{status: 'refused', reason, message}` to refuse it, or `{status: 'stopped', message}` to stop
it quietly: the operation does not happen, the caller is not told it failed, and an app place keeps its input (a composer keeps its
draft). Write what you need to act later before you stop it. `opts.replaces` lets it answer without calling `next`; `deadlineMs` bounds
its own time; `onFailure: 'refuse'` makes its failure refuse the call (by default a failing interceptor is passed over). `call.ask(spec)`
asks the user about this call; `call.signal` aborts when the call is cancelled. A mod never sees its own calls.

## Types of your own

A mod that provides instances (an agent, its chats, its own kinds) registers its types with `ctx.graph.registerTypes(defs)` and provides
them with `ctx.graph.provide({types})` (`put`, `update`, `remove`, `emit`). A type is a subtype of a concept (`Agent`, `Thread`, `Step`,
…) or a concept of its own, given as a descriptor: `{id, kind: 'subtype', parent, spec: {state, relations, operations, events}}` (the
agent starter has one). In tests and tooling, the builders in `sdk/graph/define.mjs` (`defineConcept`, `defineSubtype`, `s`, `r`, `op`,
`ev`, and `toDescriptor`) write the same descriptors.

## The panel starter

`renderer.mjs` declares a tab of the side panel (`ctx.ui.panel({id, title, render})`). The tab's component gets the chat beside it as
`thread`, follows the chat's `turns` with `ctx.graph.subscribe({ref, relation})` and each turn's `input` (what was asked), and draws with
the kit (`ctx.ui.components`: `EmptyState`, `Badge`, ...), which takes the app's own look in both themes. Grants: `graph.read` for the
types it reads, `graph.present:SidePanel`.

Change it: read another relation of the chat (`requests`, `changes`, `settings`); draw a lent part (`Message`, `StepRow`, `DiffView`); act
from it with `ctx.graph.invoke`.

## The rule starter

`renderer.mjs` declares one presentation rule: `ctx.ui.decorate('Thread', {id, badges})`. The framework applies it wherever the app
shows a chat (its sidebar row and its header), with the app's own badge, in every window, as the chat changes. `badges` is a function of
the chat (its `ref`, `state` and `links`), so the rule decides per chat; the test checks that function. Grants: `graph.present` for the
places it draws in.

Other rules: `label`, `tooltip`, `actions` and `summary` on a subject; `hide`, `reorder`, `add` on a presentation's slots; `style` the
app's own CSS variables with theme tokens. A host entry may give the same rules as data (`when` on each badge, live text such as
`'{{title}}'`).

## The contribution starter

`mod.json` declares a setting with `"scope": "thread"`: each chat has its own value, kept with the chat (attached data), read with
`ctx.settings.get(key, {thread})`. `host.mjs` adds it to the agent's inputs: it intercepts the send of Codex's chats
(`ctx.graph.intercept('CodexThread', 'send', ...)`) and adds its part to the turn's additional context under `mod:<id>`. Other mods'
parts come in the user's order with it; the provider refuses a change that is not the mod's own. `renderer.mjs` draws the setting above
the chat's composer with `SettingRow` (the framework's own control, reset and errors). Grants: `graph.intercept:CodexThread.send`,
`graph.act:CodexThread.send`, `graph.present:Composer`.

For a mod built in this repository, `@codexmods/sdk/agent` (`sdk/agent.mjs`) has helpers built on the same acts: `instructions(ctx,
text)` (a thread's developer instructions at its start, resume and fork, or a turn's context; `{scope: {where}}` limits it to the chats a
where keeps, attached data included), `tool(ctx, {name, description, input, run})` (a tool the agent can call, answered in the mod) and
`skills(ctx, folder)`. The helpers import framework code, so a mod packaged on its own intercepts the same operations itself
(`CodexAgent._startThread`, `CodexThread.send`, `Tool._call`), as the project orchestrator does.

## The agent starter

`host.mjs` registers its kinds, `EchoAgent` (an Agent) and `EchoThread` (a Thread), and provides their instances
(`ctx.graph.provide({types})`, then `put` and `update`): the agent, its model, its chats, each turn with its message and its streamed
reply (an `AgentMessage` linked as the turn's `answer`). The operations it handles are the chat's (`send`, `stop`, `rename`, `archive`,
`restore`, `markRead`) and the agent's `newThread`. It keeps what it provides in its storage, so its chats survive a restart.
`renderer.mjs` registers the view its chats open to (`ctx.ui.replace('ThreadView', {for: 'EchoThread'})`), drawn with the parts the
framework lends (`ThreadHeader`, `Transcript`, `Turn`, `Message`, `Composer`). The framework lists its chats with the app's (the
sidebar's group for the agent, search, the palette) and opens them there. Grants: `graph`, `graph.present:ThreadView`.

Change it: answer with a model of your own (a session process, below), add steps (`CommandRun`, `Reasoning`, a Step subtype of yours),
ask the user (`CommandApproval`, `Question`, answered through their own `answer`), give its chats settings (`Setting` instances linked to
the chat). The framework's test agent (`tests/fixtures/mods/test-agent`) does each of these.

## Session processes

A process the mod declares runs beside the Host, in its process group. A **worker** (the default) answers the mod's calls
(`ctx.processes.call`) and stops when idle. A **session** is long-lived: never stopped for being idle, restarted after a failure only with
`"restart": "on-failure"`, started with arguments and a folder (`ctx.processes.start(name, {args, cwd})`), fed through its input
(`ctx.processes.write(name, data)`; wait for each write: past 4 MiB not yet taken, a write is `Busy`), its output given line by line (`ctx.processes.on(name, 'output', fn)`). One that ends cleanly (code 0) is done. A session may run a program
installed on the Mac by its name:

```json
"permissions": ["processes", "processes.exec:claude"],
"processes": { "cc": { "kind": "session", "executable": "claude", "args": ["--print"], "start": "on-demand" } }
```

A session declared with `"instances": n` (at most 16) runs as several at once, each addressed as `name#key` (`cc#chat-1`; a key is
letters, digits, `_` and `-`), as an agent runs one per chat; starting one more than `n` is `Busy`. The program is named in a
`processes.exec` permission, so consent shows it ("Runs claude on your Mac") and an update that adds one asks again. It is found on the user's PATH (their login shell's) at each start, runs in their home folder unless the mod gives another, and
gets none of the framework's connection: it is the user's program, not the mod's code. A session that is the mod's own code (`command`)
connects back and gets a `ctx` with the graph's reads and `invoke`, as the mod.

## Accounts

The Codex agent can use several ChatGPT accounts: the app's own (`CodexAgent.account`) and the ones the user adds
(`CodexAgent.accounts`, each a `ChatGPTAccount` with `added: true` and its own `CodexUsage`). Every Codex chat links to the account its
turns use (`Thread.account`). `Thread.moveToAccount(account)` moves a chat to another account between turns: the same chat, history and
settings; refused (`unavailable`) while it works, and asked of the user unless it is the user's act or the mod's automatic action.
`CodexAgent.addAccount()` adds one (its sign-in opens in the browser), `CodexAgent.setStartAccount(account?)` sets where new chats start
(asked of the user too, unless it is the user's act or an automatic action),
`Account.remove()` removes an added one after moving its chats to the app's account. An account's credentials never reach a mod. Grants:
`graph.read:CodexAgent,ChatGPTAccount,CodexUsage,CodexThread`, `graph.act:Thread.moveToAccount` and the others you call. The account
switcher (`mods/codexmods.account-switcher`) is the worked example.

## Composer suggestions

`ctx.ui.composer.suggest({id, provide})` offers text after the caret: when the user pauses at the end of a line in a composer,
`provide(env)` gets the text before and after the caret (`env.before`, `env.after`, with the draft it is in) and returns a suggestion or
null; the framework draws it as ghost text in the composer's own font, Tab takes
it and Escape leaves it, and an answer that comes after the user typed on is dropped. The smart composer (`mods/codexmods.smart-composer`)
asks a model for it.

## Model use

A mod can use models through the framework (mod intelligence, [its README](../framework/mods/codexmods.intelligence/README.md)). Declare
it in `mod.json`, saying why: `"intelligence": { "why": "It drafts commit messages" }`. Then call `ctx.intelligence.ask({ prompt, tools,
storage, settings, onText })` from any realm. The user turns it on on your mod's page, with the model and the token allowances they give
it. Until then, or past an allowance, a call throws and says why. The model gets no tools but yours: those you pass, your storage and
settings if you ask (`storage: true`, `settings: true`), each answered in your own realm. Other kinds (`"tools": ["web"]` in the
declaration) are the user's to allow. In a test, `control.intelligence.answer(fn)` plays the model.

## Package and install

```bash
node cli/codexmods.mjs keygen --out acme.pem                         # once: your publisher key (keep it private)
node cli/codexmods.mjs pack ./acme.my-mod --key acme.pem              # a signed acme.my-mod.codexmod
node cli/codexmods.mjs mods install ./acme.my-mod.codexmod --enable
```

A package is signed with your key; the mod's page shows its publisher, and an update signed by another key asks the user again. A folder
installs only as a development package (`--dev`, in Developer mode). Users install a package from Settings → Mods, or from a GitHub
repository's latest release.

## Worked examples

The maintained mods in [`mods/`](../mods/) are each a worked example of a part of the SDK; [ARCHITECTURE.md](../ARCHITECTURE.md) §17 maps
each to what it is built from.

| Topic | Mod |
|---|---|
| Automatic actions, `assess`, the user's intent from a page, accounts | `codexmods.account-switcher` |
| `ui.composer.suggest`, a composer control, `ctx.intelligence`, an interceptor that changes a send | `codexmods.smart-composer` |
| An agent of its own: types, `provide`, `ui.replace('ThreadView')`, lent parts, a session process | `codexmods.claude-code` |
| Attached data, services with their caller, `Tool._call` and `_startThread` interceptors, a skill | `codexmods.project-orchestrator` |
| A chat's settings (`contributes`), `SettingRow`, a panel | `codexmods.thread-settings` |
| The scheduler, keyed sends and `graph.made`, `ui.status`, a stop that keeps the message, a lease client | `codexmods.live-usage` |
| Secrets, optional permissions, `ui.notify`, a panel opened on demand | `codexmods.better-questions` |
| Regions, hosted chats, drop targets, storage shared across windows | `codexmods.multi-panel` |
| `ui.style`, `ui.hide`, `graph.defaults`, a settings page | `codexmods.ui-tweaks` |

No maintained mod uses these yet; their contracts are in `sdk/index.d.ts`: `data.migrate`, `graph.policy`, `override`, `invokeAll`,
`after`, `ui.palette.source`, slash commands and mentions, `ui.links.route`, content renderers, themes, layouts, `appServer.observe` and
`intercept`. docs/design/public-hooks.md says what a mod can do with each of the app's features.
