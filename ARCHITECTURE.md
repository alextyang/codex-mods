# Architecture specification

The single, current specification of the framework. It is derived from GOAL.md, and every decision here is judged against those goals. Vocabulary is in [CONTEXT.md](CONTEXT.md). Public contracts live in `contracts/` and `sdk/index.d.ts`; operating the system is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md). Per-build facts (adapter packs) are in `adapters/*/NOTES.md`, and Keychain internals are in `builder/KEYCHAIN.md`.

## 0. Product scope

| Question | Decision | Consequences in this spec |
|---|---|---|
| Audience | The maintainer plus a few trusted people | The product is shared as the framework plus the builder, never as a prebuilt app. Each person builds their own modded copy from their own stock ChatGPT on their own Mac (§5), so no OpenAI bytes are redistributed and no notarization is needed. Mods are shared as signed `.codexmod` files with pinned publisher keys (§13). |
| Relationship to the stock app | The modded copy replaces the stock app for daily use and shares its history | The daily profile's primary backend uses `~/.codex`, so threads and config match the stock app and CLI (§5.2). QA profiles are fully isolated. |
| Signing identity | Apple Development certificate | The default is one Apple Development identity across the whole bundle. The identity is configured per installation: each person uses their own, or ad-hoc with `disable-library-validation` (§5.1). |

---

## 1. Decisions at a glance

| # | Decision | Goal served |
|---|---|---|
| D1 | The stock app is never modified or launched by the framework. Users run a **modded copy** rebuilt automatically from the stock app. | 2, 7 |
| D2 | The only framework code in the copy is a small **loader** in the app's main entry, plus the relay when binary replacement is needed (§6.1). Framework code, adapter packs and mods live outside the bundle, so framework and mod updates never rebuild or re-sign the app. | 2 |
| D3 | All Mach-O code in the copy is signed **uniformly with one identity**, inside out. Nested publisher signatures are never preserved. | 2 |
| D4 | One **Framework Host** process per running app, started by framework-main as an Electron utility process. It owns the mux, mod runtime, state and management API. Electron main runs no mod code. | 5, 6, 7 |
| D5 | One **mux** sits between the app and every app-server process. The app reaches it through a minimal stdio relay, which the app launches as its app-server. | 5 |
| D6 | One interceptor model covers every message kind in both directions: *pass, replace, drop, respond, route*. Interceptors fail open by default. | 4, 7 |
| D7 | Each mod's host code runs in its **own worker thread** inside the Host: terminable, memory-limited, no extra OS process. Mod processes exist only when a mod declares one. | 6, 7 |
| D8 | Mod UI runs in the app's page realm so it can use the app's real React components and theme. Components, anchors and theme tokens come from a per-build **adapter pack**. | 3 |
| D9 | The SDK is one small context object (about 40 methods). Feature policy such as accounts, compaction, routing, split views and update policy lives only in mods. | 4 |
| D10 | Every lifecycle change is a **journaled operation** with an id, phases and a truthful outcome. Data updates are snapshot, migrate, then activate, with automatic revert inside a health window. | 1, 2 |
| D11 | Recovery is a ladder of independent rungs: mod quarantine, Host restart, safe mode, last-known-good generation, framework disabled, stock app. The loader can reach each rung before any framework code runs. | 2, 7 |
| D12 | Consent is informed trust, enforced where enforcement is real (mux, processes, secrets, backends). It is never presented as a sandbox. | 1 |
| D13 | The management API is asynchronous: mutations return an operation id immediately, and clients follow progress. No client-side acknowledgement deadline ever turns into a false "unknown". | 1 |

---

## 2. Principles

1. **One owner per application seam.** Each way into the app (main process, each renderer, the app-server stream, the app's IPC) has exactly one framework owner. Mods register with that owner and never open their own path.
2. **Generic seams, feature-free core.** A seam exposes a capability, such as "intercept requests by method" or "mount at a named anchor". The core never knows what compaction, an account or a split view is. A proposed core API that names a product feature is rejected.
3. **Version knowledge is data.** Everything specific to one ChatGPT build (anchor locators, component locations, protocol method names, the app-server path, build-time transforms) lives in an adapter pack, not in framework code.
4. **Fail toward a working app.** A mod failure degrades that mod, never the app. Framework failures degrade toward safe mode and then toward the unmodified app.
5. **Truthful outcomes.** Every operation ends in *succeeded*, *failed with nothing applied*, or *outcome unknown*, and unknown is never silently retried or replayed. External effects are never claimed to be undone.
6. **Pay only for what is used.** Fixed cost is small. Per-mod cost is proportional to what the mod registers. Per-message cost is proportional to the registrations that match.
7. **Less mechanism.** A mechanism is built only when a real mod needs it or a goal requires it. Theoretical mods test expressiveness, not scope.
8. **Prove it in the real app.** Acceptance is a workflow in the real modded app, not a fixture tier.

---

## 3. Platform facts this design rests on

| Fact | Consequence |
|---|---|
| The app spawns `Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server` and speaks newline-delimited JSON-RPC over its stdio. | The mux attaches at that process boundary, with no reliance on app internals. |
| The app reads its backend path from the environment variable `CODEX_CLI_PATH`. | The loader points it at the relay when the framework is enabled. No binary is replaced. (The pack format also supports a `replace` method; no current pack uses it.) |
| The app runtime is Owl (Chromium-based): it has no Electron `utilityProcess`, and the RunAsNode fuse is off. | The Host is a child process of framework-main, run on the app's bundled Node (`Resources/cua_node/bin/node`) over a Node IPC channel. framework-main bridges the renderer and management channels. Mod processes use the same Node. |
| Owl injects `--user-data-dir` before any JS runs and ignores `app.setPath('userData')`. | The builder fixes the directory name in `Resources/owl-app.ini` (`ChatGPT Mods`). QA launches pass `--user-data-dir`. |
| Editing `app.asar` breaks Electron ASAR integrity: the Info.plist header hash and a digest compiled into the framework binary. | The builder rewrites both and re-signs, so any app edit means a full re-sign. |
| Under hardened runtime, library validation rejects a library whose Team ID differs from the loader's. Ad-hoc code has no Team ID. | Mixed signatures can never work. Sign uniformly (D3). |
| A copy signed by a different identity cannot use OpenAI's keychain groups, app groups or team entitlements. | Users sign in once inside the copy. Credentials are never copied. |
| The app opens several app-server connections and does not respawn a dead backend. | One mux session per connection (§6.2). A Host crash means a Host restart plus an app relaunch (§12.6). |
| Session preload registration injects the framework preload into app windows before page scripts run. Windows created by the framework need the app's own preload to boot. | No edit to the app's preload (§9.1). Framework-created views copy the app's web preferences (§9.4). |
| Some app components are reachable only through minified exports. | Export-exposure seam transforms in the adapter pack (§15). |
| `clonefile` needs an APFS volume. | Snapshots and builds clone on APFS and fall back to full copies elsewhere: slower, same semantics. |
| The stock app and CLI sharing one `CODEX_HOME` is not guaranteed safe by upstream. | The concurrency guard warns before the copy runs next to either (§5.4). |

---

## 4. System overview

```
/Applications/ChatGPT.app  (stock; read-only input; never launched by the framework)
        │  builder: APFS clone → loader + seam transforms → uniform re-sign
        ▼
~/Applications/ChatGPT Mods.app  (the modded copy: stable symlink into apps/; its own bundle id; updater disabled)
┌──────────────────────── Electron main ─────────────────────────────────────┐
│ loader (in asar): read flags → passthrough | framework/<current>/main     │
│ framework-main: windows, preload registration, Host supervision,         │
│                 app-route views, relaunch, recovery prompts                │
│ app main (upstream code, unchanged apart from the adapter's seam edits)   │
└───┬───────────────────────┬───────────────────────────────┬────────────────┘
    │ child process (Node)  │ spawns `codex app-server`      │ preload (per window)
    ▼                       ▼                                ▼
┌──────────── Framework Host ────────────────┐  relay ─UDS─▶ mux   Renderer windows
│ mux: framing · ids · interceptors ·         │               │     app UI + renderer runtime
│      observers · affinity · backends        │◀──────────────┘     + mods' renderer modules
│ mod runtime: one worker thread per mod      │  MessagePort ◀────▶ (main world, real components)
│ state: packages · ops journal · data ·      │
│        settings · secrets · snapshots       │
│ management API (MessagePort + CLI socket)   │
└───┬──────────────────────┬──────────────────┘
    │ stdio JSONL          │ UDS + per-process token
    ▼                      ▼
app-server (primary)    mod processes (declared only) · external clients (leases)
+ named backends (only when a mod defines them)
```

### 4.1 Components and ownership

| Component | Runs in | Owns | Does not own |
|---|---|---|---|
| Loader | Electron main, before app main | Instance lock, concurrency guard, boot decision, flags, boot markers, passthrough | Anything else; it stays tiny and rarely changes |
| framework-main | Electron main | Host lifecycle, preload registration, app-route views, relaunch, recovery dialogs, the MessagePort bridge to the Host, the AppHost hold, the app's read-state session, the app's projects and the app's own state | Mod code, state, policy |
| Renderer runtime | Each app renderer (main world) | Anchor resolution, mounting mod UI, theme and component access, commands | Persistent state (it asks the Host) |
| Framework Host | Child process of framework-main on the app's bundled Node | Mux, mod runtime, packages, ops journal, data, secrets, settings, management API, external client leases | Electron windows |
| Relay | Child of Electron main, at the backend path | Byte relay between the app's stdio and the mux socket | Parsing, policy |
| app-server(s) | Children of the Host | Upstream behavior | — |
| Mod processes | Children of the Host | A mod's declared external integration | App access, except through the SDK |
| Builder | Run by the CLI or the Host | Producing and verifying modded copies | Runtime behavior |

**The AppHost hold and the app's read state** (`framework/main/apphost.cjs`, `read-state.cjs`; docs/design/presentations.md V12). The adapter pack's `app-host` seam makes the app's main code call `globalThis.__codexmods.appHost(host, sender, view)` once per window, after it registers the window's AppView; `host` is the window's AppHost, the services main exports to the window (`host.services.<name>`), and `view` that AppView, the services the window exports to main (`view.services.<name>`, over the same Cap'n Web port: `clientCoordination` says which window owns a chat and takes the app's thread-follower requests, as the app's main sends them; `kit.followerRequest`). framework-main installs that hook in `start()`, before the app's main code runs (extending `__codexmods`, never replacing it), and keeps each live window's host by sender id, dropped when the sender is destroyed. On top of it the read-state module holds one `threadReadState` session, opened from the first live window's host and reopened on another window when that one closes (and when the app retires the session, for example when the account changes). It keeps the set of unread thread ids of the app's `local` host, sends it to the Host as `read-state` when it changes (debounced), and applies the Host's `read-state-set` requests in order with `session.set`, queueing them while it has no session. Its own writes are tagged while in flight, so their echo is not reported as a change of the app's, and the Host's store keeps its writes on top of the reports it hears until they are acked, so there is no loop. Without a window, an AppHost or the service, it logs once and does nothing; the account's identity (which may hold a token) is never logged or sent. Messages: `contracts/ipc.d.ts`.

**Approval prompts** (`framework/main/approvals.cjs`; runtime-core.md R17). The Host's `approval-ask` becomes the app's native dialog (the Electron adapter's `askUser`: on the focused app window, Don't Allow first, the default and the cancel, with a "don't ask again" checkbox); the user's choice goes back as `approval-answer`. `approval-close` closes a prompt nobody answered, which then gets no answer. Without the dialog every request is answered no.

**The app's projects** (`framework/main/projects.cjs`; docs/design/breadth.md D3). The app keeps its projects in its global state and serves them through the AppHost service `projects` (its projects manager, one for the app), whose store (`globalState`: `get(key)`, `onDidChange(key, fn)`) every write notifies. The module holds the store of the first live window's service (another window's when that one closes) and reports to the Host as `projects` (debounced): the local projects in the sidebar's order (`local-projects`, `project-order`) and the one the app opened (`selected-project`) when they change, and what the app records about each thread's project (`thread-project-assignments`, `projectless-thread-ids`, `thread-workspace-root-hints`) as what changed, all of it on a reset (the first report, another window's store, the Host's `ready`). It runs the Host's `app-op` the app's way: `select` with the manager's `createOrSelectLocalProjects` (the project's folder: what opening it again does, which selects it), `rename` with the manager's `renameLocal`, `remove` with `removeLocal` (the app's own removal: its threads become projectless, files untouched), `reveal` in Finder (the adapter's `revealPath`, on the project's first root from the app's record, or a path inside the project), and the project's files the app's way through the window's AppHost `workspaceFiles`: `list` (a folder as the app's file tree lists it: dotfiles left out) and `inspect` (size, modification time, and a content kind from a sample), and `open` (the app's own action `windows.tabs.open` through `appActions.runInPrimaryWindow`: a file tab beside the thread the window shows; the app refuses it while none is shown). `open-in` opens a project's path in one of the app's "open in" targets (`openIn.open`). A project's repository: `repository` reads it the app's way (its origins through `repositoryOrigins.read`; through the app's git worker, `openIn.requestGitWorker`: the current branch, the status counts, the upstream, the ahead count, the recent branches, the default branch and the staged files), `switch-branch`, `create-branch` (`mode: 'worktree'`, `failIfExists`) and `push` run through the app's `gitRepository` handles (`wait()`, disposed after), and `worktree{path}` says whether a folder is a worktree of the project's repository (the same git common directory, not its checkout) with its branch and its base (the branch metadata's, else the default branch); it is the one operation whose path may be outside the project's roots; it also gives the worktree's `setup`, the setup script of the environment config it was made with (the worktree's git config key `codex.localEnvironmentConfigPath`, read through the git worker, then `localEnvironments.read`). `remove-worktree{path}` deletes one of the app's own worktrees of the repository (under its worktree root: the `git-worktree-root` setting, else `<Codex home>/worktrees`) through `managedWorktrees.delete` (reason `settings-delete-targeted`, as its Worktrees settings' Delete). Instructions: `instructions{path}` reads a project folder's `AGENTS.md` and `AGENTS.override.md` (`workspaceFiles.inspect` and `read` as text, at most 1 MB) and `edit-instructions{path, text}` saves one (`workspaceFiles.saveText`, against the modification time it has: a file that changed meanwhile is not written); without a project they act on the global ones in the Codex home (the app's rule: `CODEX_HOME`, else `~/.codex`), read with node's fs because the app's own read (`agentInstructions.read`) creates an empty `AGENTS.md`, the global `AGENTS.md` edited through the app's `agentInstructions.write` (its override saved like a project's file), and `open-instructions{path}` shows one in a file tab, as `open` does a project's file. A project's actions: `actions` reads its environment configs with their `[[actions]]` (the window's `localEnvironments.list` for its folder) and the one the app selected for the folder (the persisted atom `local-env-selections-by-workspace`, in the global state key `electron-persisted-atom-state`; null there is "no environment"; none stored, the first, the default `environment.toml`); `run-action{path, index, threadId?, cwd?}` runs one, by its config and place (the command is read from the config again), the app's way: a session of the window's `terminal` service in the project's folder (or the named thread's folder, when it is in the project or a worktree of its repository), its tab shown in the thread's panel by the app's action `windows.tabs.open` (`{type: 'terminal', sessionId}`), then the command run in it (`terminal.runAction`); when no thread is shown the tab cannot open, so the session is closed and nothing runs (refused). App-level operations name no project: `pinned-threads` reads the chats the user pinned (`pinnedThreads.list`); `navigate{path}` opens one of a fixed set of the app's pages (Settings, Codex Cloud, Personalization, Worktrees) the way the app's main does, a `navigate-to-route` message to the window on the app's channel to its pages (`codex_desktop:message-for-view`, which the census of every supported build checks; the Electron adapter's `postToWindow`); `apps` reads the installed open-in targets (`openIn.getTargets`, with each target's bundle id read from the Info.plist of the `.app` its executable is in, through the open-in worker's `get-target-command`; Finder and Terminal are macOS's own) and the computer-use approvals (`computerUseSettings.getAppApprovals`), and `remove-app-approval` takes one back (`removeAppApproval`, the only change the app makes). `cloud-environments` reads the signed-in account's environment configs (`environmentConfigs.list`, its own and its workspace's), using only the account and user ids that `accountInfo.readAccountInfo` names. Every other path must be absolute and inside one of the named project's roots. The answer (`app-op-done`, `refused` when nothing was tried, with the op's `result`) follows a report of what the operation changed. Without a window, the service or its store it reports `available: false` and logs once.

**The app's own state** (`framework/main/app-state.cjs`; docs/design/breadth.md D4). The app's settings are its registry, the AppHost service `settings` (one store for the app): `readForAgent()` gives the definitions of every setting that is not hidden (key, default, description, `agentAccess`, a JSON Schema of its value) with the configured and effective values, and `write(key, value)` is the UI's own path (checked, its side effects run, saved under `[desktop]` of the Codex config, pushed to every open Settings page). The module holds the first live window's services (another window's when that one closes) and reports to the Host as `app-state` (debounced): the definitions and every value on a reset (the first report, another window's services, the Host's `ready`), otherwise the values that changed (`onDidChange` per key), with the app's facts when they change (`appInfo.get()`'s version, build and name; onboarded by the app's own rule, the persisted atom `electron:onboarding-projectless-completed` or a project; when this process started) and the appearance the system resolves for the app (Electron's nativeTheme). When the app starts to quit (Electron's before-quit) a report with `quitting: true` goes out at once. It runs the Host's `app-state-op` the app's way: `write-setting{key, value}` through the registry; `account`, the signed-in account's ids, plan and workspace from the AppHost `accountInfo` (`readAccountInfo()`, which decodes them without returning the session, and `readAccounts(language)` for the workspace's name): only those fields leave, never a token or an email; `navigate{path}` to the account or usage settings, as `navigate` above; `open-help`, the first item of the app's Help menu (Documentation), clicked as the app's menu service's `invokeItem` does but straight from the application menu (the Electron adapter's `clickAppMenuItem`; the service's ids last only until the window's page takes its next snapshot, and the app rebuilds its menu as focus moves, so a snapshot's id can miss: seen natively); `quit` as Cmd+Q does (the app's own before-quit gate decides); `open-login{path}`, the app-server's ChatGPT sign-in page in the browser (the Electron adapter's `openExternal`; an https page of openai.com or chatgpt.com only). The answer (`app-state-op-done`) follows the report of what it changed. Without a window or the service it reports `available: false` and logs once.

**Feature areas** (`framework/main/index.cjs`, `areas/`, `area-kit.cjs`; docs/design/breadth.md D5, D10). Every `areas/<name>.cjs` is loaded after the fixed modules. A module adds a feature area's operations without message types of its own: it registers them under the area's name (`hooks.onAreaOp(area, fn)`), the Host's `area-op {area, requestId, op, args}` runs `fn(op, args)` and is answered with `area-op-done` (`refused` when the error says nothing was tried; an area with no module is refused), and the module pushes what it reads from the app with `hooks.areaReport(area, report)` (`area-report`). The Host's side is `graph/main-ops.mjs` (§6.8).

One Host runs per app unless the framework is disabled. There is one relay per app-server spawn by the app (normally one), one primary backend per app session plus one per named backend in use (started lazily, stopped when idle), and mod processes only as declared and on demand. Enabling a mod adds **no process** unless that mod declares one, and one worker thread if it has host code.

---

## 5. The modded copy (builder)

The builder turns a stock build into a launchable modded copy. Inputs are the stock app, an adapter pack for that build, and a signing identity. Each run is re-runnable, idempotent and unattended, and takes minutes.

### 5.1 Build steps

1. **Clone** the stock bundle with APFS `clonefile` (near-zero disk). Never write into the stock path.
2. **Identify.** Give the copy its own bundle id (`dev.codexmods.app`) and name, and remove the self-updater and competing URL-scheme registrations (§5.3).
3. **Patch.**
   - Insert the loader into the app's main entry. Apart from the relay, this is the only framework code in the bundle.
   - Apply the adapter pack's **seam transforms** (§15): exact-input, hash-pinned edits that expose a generic seam and never implement a feature. Every patched script is parse-checked (`node --check`; renderer chunks as modules) before anything is signed or written; a failure stops the build (`TRANSFORM_PARSE`).
   - Apply the pack's **binary patches**: hash-guarded, exact-byte edits to Mach-O files outside the asar, before signing.
   - Rewrite ASAR integrity: the plist header hash and, where present, the digest embedded in the Electron framework binary.
   - Embed the exact `adapter.json` used at `Contents/Resources/codexmods-adapter.json`, sealed by the signature. framework-main reads that file, so a copy always runs with the adapter its seams were built from; `<root>/adapters/<build>/` is only the builder's input.
4. **Redirect the backend.** Install the relay at `Contents/Resources/codexmods-relay`. The loader points `CODEX_CLI_PATH` at it (§6.1).
5. **Isolate** from the stock app (§5.3): the isolation baseline, Computer Use edits and the locked-use payload removal.
6. **Sign uniformly.** Sign every Mach-O inside out with one identity. Strip team-scoped entitlements, and delete the stock provisioning profile and notarization ticket.
   - With an Apple team identity (Apple Development or Developer ID), library validation passes as-is. The identity's Team ID is read from its certificate and must match the signature (`TEAM_ID_MISMATCH` otherwise).
   - With an ad-hoc identity, every executable gets `disable-library-validation`.
   - The identity is configured per installation (`profile.json` `signingIdentity`). A daily profile requires a real identity (`--require-identity`).
7. **Verify** with `codesign --verify --deep --strict` and the post-sign isolation scans (§5.3). The QA harness smoke-launches the result (window, Host ready, handshake; docs/DEVELOPMENT.md).
8. **Stage.** Write the copy to `apps/<build>-<inputsHash>/` and `build-report.json` last; the report is the completeness marker, and a failed build leaves nothing behind. `inputsHash` covers the adapter bytes, loader, relay, signing identity and framework version, so any changed input yields a new candidate. A candidate is reused only if its report records exactly the current inputs. Making a candidate current is an update operation (§12.3).

### 5.2 Profiles

A profile is an Electron `userData` directory, a `CODEX_HOME` for the primary backend, and a framework state root. The loader sets the first two before app main loads, on every boot including passthrough, so a disabled framework or a safe-mode boot never touches stock state by accident.

`profile.json` (written by `codexmods setup`; later runs preserve fields they do not own) holds `codexHome`, `signingIdentity`, `appPath` (the stable launch symlink), `launchArgs`, `guardStockApp` and `guardTrusted[]`. Every launch and relaunch passes `launchArgs`, so a QA profile keeps its own `--user-data-dir` across app switches.

- **Daily profile** (`setup --daily`): the primary backend uses `~/.codex`, so threads, config and history are shared with the stock app and the CLI (§0). The concurrency guard is on (§5.4). `launchArgs` is empty.
- **QA profile**: fully isolated `codex-home` and `userData`. The guard is off, and the QA harness disables `computer_use` in its config.

Three rules apply to the shared home:

- **No direct edits.** The framework never edits `~/.codex`. Changes go only through the app-server, and §5.3 removes the copy's own config writes into it.
- **Mod data stays outside.** Named backends and all mod data live under the framework root.
- **Credentials are never copied.** The copy has its own login and Keychain item.

### 5.3 Isolation from the stock app

The copy must not read or write anything the stock app owns, and the stock app must not be able to use the copy's helper. Each point below is a **mandatory edit**: the pack lists its id in `mandatoryEdits`, and the pack generator and the builder refuse a pack in which any listed edit is missing or not applied. A refresh that drops one is a failed refresh, never "ship degraded".

**Keychain.** The Owl OSCrypt key service and account are hard-coded constants (`Codex Storage Key` / `Codex`), so the stock app and a copy would share one login-Keychain item. Binary patches rename them for the copy to `Codey Storage Key` / `Codey`, and rename the fallback item (`Aura Safe Storage` / `Aura`) the same way, so the copy never reads another OpenAI app's item (`keychain-service-name`, `keychain-service-name-account`, `aura-fallback-service`, `aura-fallback-account`). The daily copy is signed with a stable Apple Development identity: its designated requirement survives rebuilds, so one "Always Allow" covers every later build. QA launches pass `--use-mock-keychain`, which makes the OSCrypt key lookup use an in-memory keychain instead of the real one; the QA harness also stops and dismisses any prompt aimed at a QA process. Analysis: `builder/KEYCHAIN.md`.

**Computer Use.** The copy gets its own helper:

- **Own install.** The helper is installed under the profile's `computer-use/` directory (`layout.computerUse`), never under `<CODEX_HOME>/computer-use`. The loader exports `CODEX_MODS_COMPUTER_USE_DIR` on every boot.
- **Relocations.** Every path upstream derives from `CODEX_HOME/computer-use` moves to that directory: the helper bundle (install, refresh, discovery, spawn), the helper's `config.json` writer, the locked-use installer resolver, and the legacy approvals file (`cua-relocate-dir`, `-config`, `-installer`, `-approvals`). The node client's fallback lookup is renamed so it can never find the stock helper.
- **Own identity.** The helper's bundle id, preferences domain, `/tmp` IPC directory and Group Container are renamed (`com.openai.sky.CUAService` becomes `…CUAServicf`) at every site in the asar, helper binaries, plists and node client (`cua-bundle-id:*`, `cua-container`, `cua-container:*`). The environment variable `SKY_CUA_SERVICE_PATH` becomes `SKY_CUA_SERVICE_PATM`, so an ambient stock value is ignored (`cua-service-path-env`).
- **Team-matched container.** With a team identity, the container is `<TEAM>.com.openai.sky.CUAServicf`: the builder rewrites the 10-character team prefix in place at every site the `cua-container` edits produced, and signs the app and helpers with a matching `com.apple.security.application-groups` entitlement. A team-prefixed group whose team matches the signer needs no provisioning profile. Ad-hoc (QA) builds keep `2DC432GLL2.com.openai.sky.CUAServicf` and no group entitlement.
- **Team rewrite.** The helper accepts native-pipe clients only when they are signed by OpenAI's team id (a bare string in the helper executables, `*.coderequirement` and plists). For team builds the builder re-pins every such reference — across `Resources/cua_node` and the one native addon that gates main's app-tools/in-app-browser sockets — to the signer's team, in place and at the same length (completeness; no stock identity survives, and a missing or drifted site refuses the build), so the helper trusts the copy's own clients. Main's app-tools/in-app-browser sockets additionally authorize peers against OpenAI's own signing identity, which a re-signed copy cannot present; since those sockets are mode-0600 in the copy's private per-profile run directory (reachable only by the copy's own user), the copy relies on that location-based access control there in place of the stock identity pin (`cua-disable-cu-peer-auth`, adapter NOTES N9). Ad-hoc builds are unchanged.
- **Private helper `CODEX_HOME`.** The copy starts its helper with `CODEX_HOME` set to the profile directory, the parent of `computer-use/` (`cua-helper-private-home`). The helper's own config writes (the `notify` line, MCP and plugin entries) land in a private `profiles/<p>/config.toml` that nothing reads, and its overlay `config.json` resolves to `computer-use/config.json`. The native spawn runs on a worker thread, so the edit holds the environment until the spawn has happened (bounded to 500 ms).
- **Locked use removed.** The locked-use installer changes system-wide state shared with the stock app (the SecurityAgent authorization plugin, its backup directory, and the `system.login.screensaver` rule). Status, install and uninstall report "unavailable" and never run it (`cua-disable-locked-use`), and the builder deletes the nested `Codex Computer Use Installer.app` and the privileged installer tool from the copy (`removedLockedUsePayload` in the build report). The "Locked use" settings row is hidden.
- **When the helper starts.** The app's managed service starts the helper whenever any of three desktop features is on: Computer Use, appshots or Chronicle (`kie.enabled` is their OR). Only Computer Use follows `[features] computer_use`. Appshots and Chronicle are statsig gates plus requirements (`allowAppshots`, `featureRequirements.chronicle`) that come only from system, MDM or cloud sources, so no profile setting stops them. A copy therefore starts its own relocated helper with the private home on any account where one of them is on, including a profile with Computer Use off.
- **QA.** QA profiles set `[features] computer_use = false`, which turns off the Computer Use feature but not the helper (above). The QA isolation check runs at launch, +20 s and +45 s, and accepts exactly the copy's own helper: a helper process that runs from the profile's `computer-use/` directory, with the profile directory as `CODEX_HOME`. It refuses that `CODEX_HOME` on any other process, and refuses the service when it runs from anywhere else or without the private home. `cua-helper-private-home` is part of the isolation baseline for that reason (m3 session 2, D3).

**Managed tool config.** At every launch the upstream "managed tool sync" would rewrite entries in the shared `~/.codex/config.toml` and the shared plugin cache so that they point into the copy, and the stock app would rewrite them back on its own launch. The pack stops that:

- `managed-config-no-persist` removes the `mcp_servers.node_repl` and `mcp_servers.cua_repl` edits from the app's `config/batchWrite` and keeps the idempotent `shell_environment_policy` deletions.
- `managed-config-no-persist-cua-repl` stops the rewrite of the shared plugin `.mcp.json` (on 22943 also the write of `require-browser-access.mjs` into the same cache), and `managed-config-cua-repl-thread` sends the full `cua_repl` definition per thread in the `config` of `thread/start`, next to `node_repl`. A `-c mcp_servers.<name>` override replaces a plugin-supplied server only as a full definition, and `cua_repl`'s changes at runtime, so a static override would freeze it. Since 20770 the app sets `cua_repl` per thread itself whenever the cached principal id exists (a richer definition, with the per-thread `node_repl`); the edit keeps that assignment and sends the copy's own definition only when the app does not make one. The `codex_app` plugin write carries nothing copy-specific and stays. On 22943 the app sets it itself only with its local daemon (`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`), so a copy's threads get the copy's own definition; never the stock one from the shared cache.
- The values the backend needs come from `AdapterPack.backend.configOverrides` (§6.7).
- The `notify` line is no longer rewritten by the Computer Use helper because of its private `CODEX_HOME`.

**Updater.** The upstream updater would replace the signed copy, so it is suppressed three ways. The builder removes `SUFeedURL` and `CFBundleURLTypes` from the Info.plist and sets `SUEnableAutomaticChecks` to false. The loader sets `CODEX_SPARKLE_ENABLED=false` on every boot, including passthrough and error paths. The build report records the evidence, and a build whose suppression is incomplete is refused (`--allow-updater` exists for diagnostics only).

**The isolation baseline.** The builder holds a fixed list of edit ids: the Keychain service and account, the Aura fallback service and account, `cua-relocate-dir`, `-config`, `-installer`, `cua-service-path-env`, `cua-helper-private-home`, `cua-disable-locked-use`, `cua-container`, and at least one `cua-bundle-id:*` and one `cua-container:*`. A production build is refused unless the pack declares each in `mandatoryEdits` and the builder applied it. An absent or empty `mandatoryEdits` is refused, and so is a pack produced by refreshing an older one. The pack's own list is longer (it adds the approvals relocation and managed-config edits), and the generator refuses to emit a pack that cannot derive any of them. The superseded 20052 pack has no `cua-helper-private-home`, so a production build of it is now refused.

**The content scan.** Declarations are not enough: after patching and before signing, the builder scans every script and executable under the bundled Computer Use tree, the helper bundles and the app's main-process bundles (main and src up to 21477, 22943's `early-bootstrap` chunks) and workers for the stock identifiers (the container id, the helper bundle id as a whole token, and the `SKY_CUA_SERVICE_PATH` name), in UTF-8 and UTF-16LE and ignoring code-signature blobs. Any occurrence outside a short reviewed allowlist (inert build metadata and a type declaration) refuses the build (`ISOLATION_SCAN`). After signing, the scan covers the final entitlements of every signed code object and, for team builds, confirms that no stock team id remains under `cua_node` or `Resources/native`. The helper's final identity is checked as well. Results are in the build report.

### 5.4 Sharing `~/.codex`: the concurrency guard

Running two Codex apps on one Codex home can corrupt conversations. When `profile.guardStockApp` is set (daily profiles), the **loader** checks before app main continues, independently of whether the framework is enabled, in safe mode or disabled. It looks for the stock app (`/Applications/ChatGPT.app`) and for Codex app-server processes of the same user that are not the copy's own and use this profile's `CODEX_HOME`. A process whose environment cannot be read, or a failed inspection, counts as *inspection unknown* and also warns.

If anything is found, a native dialog appears once the app is ready, and nothing else starts until it is answered: the framework (Host, views, recovery dialogs) is held back.

- **Buttons:** `Continue anyway`, `Quit the other Codex`, `Quit`. Return and Escape both mean Quit. If the dialog cannot be shown, the loader quits with a logged reason. A Quit does not count as a boot attempt and forgets what was last allowed.
- **Quit the other Codex** is offered when at least one conflict is the stock app or an identifiable Codex server. It sends SIGTERM to each listed process (for the stock app, its main process) and waits up to 5 s. If any survive, a second dialog offers `Force quit` (SIGKILL to those pids only) or `Cancel` (default, ending in Quit). Every signal is preceded by a re-check of pid plus fingerprint, so only processes named in the warning are ever signalled. When all are gone, startup continues.
- **Continue anyway** leads to a second dialog, `Just this time` (default) or `Always allow this server`, which is offered only when every conflict is an identifiable Codex server: never for the stock app, never for an unknown environment or a failed inspection. Always-allow stores the server's fingerprint (executable path plus argv, never the pid) in `profile.json` `guardTrusted[]`; matching processes are ignored from then on, while a new or different server still warns. `codexmods recovery guard list|untrust <n>` manages the list. Trust is never added implicitly.
- **Inherited decisions.** A framework-initiated relaunch (safe mode on or off, LKG restore, app switch, framework update, Host-crash recovery) must not need a person. Before `app.relaunch()`, framework-main writes a one-shot `run/relaunch-intent.json`, which the loader consumes. The loader remembers the fingerprints of the last explicit Continue; a relaunch within 10 minutes whose conflicts are a subset of that set does not prompt again and is logged as `decision: "inherited"`. User-initiated launches always evaluate normally.
- Every decision is appended to `<profile>/logs/guard.log`.

A per-profile **instance lock**, taken first, makes a second instance of the same profile exit without touching boot markers, flags or the environment.

---

## 6. The app-server plane (the mux)

### 6.1 Attachment

The loader sets `CODEX_CLI_PATH` to the relay, a small shell script that is a byte pipe between the app's stdio and the Host's mux socket (`run/app.sock`). The app launches it as if it were its app-server.

- If `flags/disabled` is set, or no run directory is configured, the relay execs the real `codex` binary unchanged, so a disabled framework costs nothing.
- The relay acts only when an `app-server` token appears anywhere in its arguments (the app runs `codex -c k=v app-server …`). Any other invocation execs the real binary unchanged, and so does a one-shot app-server run: 22943 reads its startup policy before any window opens with `codex app-server … --print-startup-config` (one JSON object on stdout, then exit), which the real binary answers.
- It writes one header line with the app's exact argv and environment (header v2, `contracts/ipc.d.ts` §4: the environment as hex of `env -0`, so any value survives), then pipes stdin unchanged. The mux launches that session's primary backend exactly as the app would have: the same arguments and the app's environment, with only `CODEX_HOME` (the profile's) and the Host's process markers set on top. The app's environment carries what its bundled tools need (`CODEX_MCP_NODE_PATH`, `CODEX_CLI_PATH`, PATH entries for its bundled git), and the Code Review page's MCP server fails without it. Named backends use the Host's environment. The Host still accepts header v1 (argv only). The header is stripped before anything observes or logs a frame. The relay parses nothing else.
- It waits up to 15 s for the socket to accept connections. If the Host is unavailable after that, the relay exits non-zero and the app's own backend-failure handling takes over (§12.6).

The mux owns the real app-server processes and spawns them itself. It is the only holder of their stdio.

### 6.2 Logical clients and backends

- **Logical clients:** the app, each mod (via `ctx.appServer`), and each external client lease (§8.6).
- **Private threads** (reference-mods.md §2, RM7). The Host gives an internal mod's client (§7.5) a hidden root (`hiddenRoot`, its data folder's `threads`). That client's traffic and the threads it starts are its alone: observed by it only, run through its own interceptors only, delivered to no other client, kept out of the diagnostic ring. A thread is private by its key once its start is answered, and from its first notification when it starts in a folder under the root (`thread/started` can come before the answer). The app never hears of them, and the native provider never puts them in the graph.
- **Sessions.** The app opens several app-server connections. Each is an *app session* with its own primary backend. From a mod's point of view, "primary" is the oldest live session.
- **Backends:** the primary backend (the profile's `CODEX_HOME`), plus named backends that mods define. A named backend is a launch overlay (its own `CODEX_HOME`, environment, arguments) owned by the defining mod. It starts on first use and stops after 10 idle minutes. Login on a named backend uses the app-server's own login methods, sent by the owning mod.
- **Framework backends** (reference-mods.md RM10, `framework/host/added-accounts.mjs`). Each ChatGPT account the user adds beside the app's runs its own app-server, a backend the framework owns (`framework/<key>`). Its Codex home holds only its own sign-in (auth.json, written and refreshed by that app-server through its own sign-in, file-backed: never the Keychain); the rest of the user's Codex is the app's home linked in (the chats and their writer locks, config.toml, AGENTS.md, skills, prompts, rules, plugins, worktrees), with the sqlite stores shared through `CODEX_SQLITE_HOME`. So a chat is the same chat on any account, and the app lists every chat as ever. It starts from the app's environment with the primary's config overrides and never idles out. No mod names it (`Denied`), and what it sends that no key ties to a thread (its account's traffic) reaches framework clients only: never the app, never a mod's observer or interceptor, and a request of it is refused rather than given to the app.
- **Moving a thread** between backends is the framework's (the native provider, `added-accounts.mjs` there) with the mux's key primitives: the key is held (other clients' requests wait), checked idle (nothing in flight; its home's status), resumed on the target, re-homed (requests go there, every subscriber follows, the old home's frames for it are dropped from then on), let go on its old home, and released. Keyless creator requests (a new thread) can go to a start backend (where new chats start). Placements are kept by the Host and restored at start; a thread a framework backend creates lives there.
- **Handshake:** the mux forwards the app's handshake to the primary backend. It replays the handshake parameters to each named backend as it starts. Mod requests issued before the handshake completes wait, within a time limit. The adapter pack's protocol catalog names the handshake methods.

### 6.3 Message flow

The mux parses each frame once and shares the parsed object read-only.

| Kind | Interceptor results allowed | Default destination |
|---|---|---|
| client → server request | pass, replace, **respond**, **route**, **defer** | the affinity backend, else primary |
| client → server notification | pass, replace, drop | same as requests |
| server → client response | pass, replace | the originating logical client (by id map) |
| server → client notification | pass, replace, drop | every client subscribed to its thread on that backend, minus what each opted out of; with none, the owner of its affinity key; else the app |
| server → client request (e.g. approvals) | pass, replace, **respond**, **defer** | one answerer: the app session when it is subscribed to the thread; else the first subscriber with a connection; else the key's owner; else the app |
| client → server response | pass, replace | the originating backend (by id map) |

- **Correlation:** every id sent to a backend is mux-allocated and restored on the way back, so logical clients' id spaces never collide.
- **Affinity:** the protocol catalog declares JSON paths that carry a conversation key (for example a thread id) and which responses create keys. The mux records which logical client and backend own each key and routes later requests, and server-initiated requests, accordingly. A `route` result on a request that carries a key re-pins that key, which is how a routing mod moves a thread. The table is generic: it knows paths, not threads or accounts.
- **Subscriptions (routing by subscription).** A client is subscribed to a thread on a backend after a successful `thread/start`, `thread/resume`, `thread/fork` or `turn/start` on it, until its own `thread/unsubscribe`, its disconnection, or that backend's restart. A thread's notifications go to every subscribed client with a connection (in-process clients read through observation), as the app-server does for several connections, so the app follows a thread a mod or lease started once it opens it. Notifications without a thread key go to the app session.
- **Union subscription.** The app's `initialize` goes upstream with some of its notification opt-outs removed (`DEFAULT_UPSTREAM_OPT_INS`: `turn/diff/updated`, `thread/compacted`, `thread/closed`, `thread/reverted`, `thread/readState/changed`, `thread/project/updated`, `project/changed`, `warning`), so observers see them; the mux drops them on delivery to each client that opted out. The legacy `codex/event/*` stream stays opted out. A client's `thread/unsubscribe` is answered by the mux (`{status}`) while another client stays subscribed, so the backend keeps the thread.
- **Key families.** Every observed frame's keys are recorded (thread, turn, item, process, watch), with their thread and backend; a key's owner is its thread's owner (`mux.keyInfo`).
- **Intents.** With the graph runtime's journal (§6.8), a request from a client other than the app whose method class (`mux/method-classes.mjs`: read, mutate or external, secret, replaySafe; every client request of the build's schema is classified, checked by a test) is mutate or external is claimed in the journal before it is written to the backend, unless the caller passes the graph intent it carries out. A request the backend never answered is uncertain, reported once and never replayed.

### 6.4 Interceptor semantics

```
ctx.appServer.intercept(kind, methods, handler, {priority?, timeoutMs?, onError?})
handler(message, info) → undefined | {replace} | {drop} | {respond:{result}|{error}} | {route: backendKey} | {defer: true}
info = {origin: 'app'|'mod:<id>'|'client:<id>', backend, affinityKey?}
```

- **Selection.** `methods` is a list of names or prefixes, or `'*'`, which needs an elevated grant. The mux looks handlers up by method first, so non-matching mods cost nothing.
- **Order.** Priority descending, then install order. Each handler sees the previous handler's output. `respond` and `drop` end the chain.
- **Asynchrony.** Handlers may be async and may issue their own requests. The default deadline is 1 s and the maximum 30 s, declared per interceptor, on the Host's own time (§7.3). A mod's own requests pass through other mods' interceptors, never its own, so nesting is bounded by deadlines and the origin skip.
- **Failure.** A throw or timeout applies `onError`. `'pass'` (the default) continues with the message as it was before this handler, discards the late result and counts a fault. `'reject'` gives a request's client a JSON-RPC error (nothing goes upstream), replaces a response with an error, and drops a notification; a policy mod that must not be bypassed uses it, and the consent screen flags it.
- **Ordering.** Requests are independent: holding one delays only that request. Notifications from one backend are processed in stream order, so holding one holds that backend's later notifications, bounded by the deadline. Responses are matched by id.
- **Integrity.** `replace` may not change the `id`, and may change the method only on requests. Results must be valid JSON-RPC.
- **Deferral (the framework's own holds).** A `serverRequest` or `clientRequest` handler of the framework's own clients may return `{defer: true}`: the request leaves the stream (or its chain) at once and the framework holds it while the graph's interceptors and policies decide (the app's actions held at their choke point, `Request.ask`, a mod's tool call), then answers or releases it. **No mod defers** (graph-integrity G6.4): a mod's `{defer: true}` is an invalid result; a mod stops an app action through the graph's interceptors (`stopped`) and answers a request later through its instance (`Approval.answer`, `Question.answer`), the request waiting at its source.
  - `release(token, {params?})` sends the request on through the rest of the request pipeline exactly as if the chain had passed it: a route chosen earlier in the chain, routing by key, the intent claim for clients other than the app (made at transmission, with the params then sent), transmission, response interceptors, and observation once, at transmission. `params` replace the request's own (validated as a `replace`'s, method and id unchanged; invalid ones throw `Invalid` and leave the token open). The promise resolves when the client's response is settled: `{released: true, response: {result} | {error}}`, the response as delivered to the client after response interceptors (an error also reports a backend that was unavailable, or died after the request was sent: `OutcomeUnknown`). It resolves `{released: false, reason}` for a token already closed, or `{released: false, reason: 'appGone', sent?: true}` when the client left before its response (`sent` when the backend had the request, so its effect is uncertain). Params on a server request's token are `Invalid`.
  - `respond(token, {result}|{error: {code, message}})` answers the client without the backend: `{outcome: 'delivered' | 'notDelivered'}`. Observers see the answer, as for an interceptor's `respond`; there is no request on the wire to see.
  - Or the hold ends, and `onResolved(token, reason)` reports it: `appGone` (the client, an app session or any other client, disconnected or was disposed; nothing is sent), `muxClosed`, `cancelled` (a mod requester's own timeout passed while the request was held) or `expired`. A hold not settled within `tune.maxClientHoldMs` (default 10 min) is released unchanged and ends `expired`. Disposing the holder (disable or crash) releases its held client requests unchanged and does not tell it.

  A second settle of a closed token reports why: `released`, `alreadyAnswered`, `appGone`, `muxClosed`, `cancelled`, `expired` or, for another mod's token, `unknownToken`. Held requests count toward a mod requester's in-flight cap. The mux orders nothing per object; the graph runtime orders its own holds.

### 6.5 Requests, observation and outcomes

- **Requests.** `ctx.appServer.request(method, params, {backend?, timeoutMs?})` and `notify(...)` send traffic from a mod (in-process clients may also pass `intent`, §6.3 Intents). A request that was never transmitted fails `Unavailable`. One that was transmitted but got no reply (timeout, backend exit, Host restart) fails `OutcomeUnknown`. The framework never retries either.
- **Observation.** `ctx.appServer.observe({kinds, methods, directions}, listener, {queue})` delivers frozen copies in order for each source. Each subscriber has a bounded queue; overflow delivers an explicit `{gap: {from, to, reason}}` event and never applies backpressure to the stream. `replay: 'boot'` subscribers also receive a bounded buffer (default 4 MB) of frames from the current backend session, so a mod that activates late still sees the handshake.
- **Lifecycle topics.** `appServer/starting`, `ready`, `exited` and `backend/<key>/*` arrive as events (§8.4).

### 6.6 Backpressure and limits

Each mod has a cap on in-flight requests (default 32); exceeding it fails with `Busy`. Queues, replay buffers and the affinity table are bounded.

### 6.7 Backend configuration overrides

`AdapterPack.backend.configOverrides` (`contracts/adapter.d.ts`) lists per-process config the Host adds to each session's **primary** backend spawn as one `-c <key>=<toml>` argument per key. Nothing is written to the shared `config.toml`. Keys are dotted codex config paths (the pack declares `notify` and the static `mcp_servers.node_repl`), and string values are templates over `${appContents}`, `${resources}`, `${computerUseDir}`, `${codexHome}`, `${relayPath}` and `${profileDir}`. An unknown variable makes the Host refuse to spawn the primary backend. The overrides pair with the mandatory transform `managed-config-no-persist` (§5.3); per-thread config carries the rest.

### 6.8 The graph runtime (behind the `graph` flag)

The runtime that serves SDK v2's object graph (docs/graph/; design: docs/design/integration.md §3 and docs/design/runtime-core.md) runs in the Host beside the mux, in `framework/host/graph/` (contract: `contracts/graph.d.ts`). The graph is on by default (E6; `flags/graph-off` turns it off): the Host opens its intent journal (`profiles/<name>/graph/intents.jsonl`), hands it to the mux, creates the runtime with the native type library (`sdk/graph/native`) and starts the native protocol source. With `flags/graph-off` nothing of it runs (the recovery entry and the CLI work without it).

- **Types** are SDK v2 descriptors (`sdk/graph/define.mjs`); a subtype only adds. **Instances** are held by identity (provider, concept, id); a provider is the only writer of its instances; many relations derive from the inverse one relation; every change is an event with old and new values and an observation sequence. Collections are complete only when every provider says so; instances are live, stale or gone.
- **One invocation path:** authority, capability, argument validation, interceptors (priority order, the caller's own skipped, changed arguments validated and authorized again; each with a deadline on its own time, after which it counts as a fault), the durable claim, the provider's handler, the outcome, events. An operation with an external effect is written to the journal as `started` (fsynced) before its handler, or a replacing interceptor, runs; a crash leaves it uncertain: reported once, never replayed. Arguments are digested, never stored.
- **Named events** (docs/graph/04 §3): a provider emits the events its type declares (`handle.emit(ref, name, payload)`; a mod through `ctx.graph.provide(...).emit`), checked against the declaration and its payload schema, for its own instance (resident, or gone a moment ago); views of the instance, and the collections and relations it is in (or was in until it was removed a moment ago, so a `deleted` or `removed` emitted after the removal still reaches them), get them as deltas whose event has `kind: 'event'`. The runtime never derives them from state changes, which are events of their own. The native provider emits them from the protocol's notifications, never from reads (Thread, Turn, Step, AgentMessage, Request, Agent and Model events; breadth.md D2).
- **Realm views:** a snapshot, then ordered deltas, for an instance, a filtered collection or a relation; bounded queues; an overflow sends `stale` and a new snapshot. A view with `depth: 'core'` does not ask the provider to load what is not resident (a thread's turns), for presentations that show an instance's core only. A realm's view feels its channel's pressure (contracts/ipc.d.ts §2): the realm client acknowledges the events it has handled in batches of 32, and a subscription with 256 unacknowledged pauses its view until the realm has caught up to 64; past its bound the view resnapshots as above.
- **The native protocol source** (`graph/providers/codex`) reads Thread, Turn, Message, Step and Request from the app's primary backends through the mux's observation stream, with its own in-process client for reads (thread lists, a thread's turns when a realm observes it) and its operations (`Thread.rename`, `setGoal`, `clearGoal`, and `markRead` through the read-state store below). Operations that need the app's own path are refused `unavailable` until their bindings land, and the protocol-backed ones while the app-server is down. Requests are answered at the mux as the app would answer them (`mux.answerServerRequest`: observers see the answer as the client's, the app's own late answer is dropped, and the backend's `serverRequest/resolved` reaches the app): `Approval.approve(once | thread | always)` and `deny`, `Question.answer`; `approve(always)` answers with the standing rule the request proposed (a command prefix, a host to allow, `persist: always` for a tool or an app), offered only when the request proposes one, and a mod's call needs the user's approval (R17, below); `Question.skip` interrupts the turn, as dismissing a question does in the app. *Reconciliation* (boundary review R1): its thread list reads every source kind and model provider, and a complete read replaces the collection (a thread it did not list, and that was not put while it ran, is removed with what is in it); a full load of a thread replaces its turns; when the app cuts a chat's history (`thread/revert` from a turn on, or `thread/rollback` of its last turns: its Edit of the last message), the turns it dropped go with what is in them, once the backend answers; `onObserve` returns the load, so a view's `loaded` means resident. A CommandRun's command reads as the app shows it (the last of its parsed actions that is not a bare shell wrapper). The app-server sends a thread's notifications only to subscribed clients, and nothing happens on a thread nobody is subscribed to, so when a loaded thread is subscribed again (the mux's `onSubscription`) the source reads its newest turns once; a backend restart or an observation gap re-reads everything. An ephemeral thread (never materialized: the app's own helper threads) has no history to read and is never listed, so a complete list keeps it; it ends with `thread/closed` or a backend crash. Its instances are Codex's own subtypes at the source's fidelity (graph-integrity G1): CodexThread, CodexTurn, CodexCommandRun, CodexToolCall, CodexReasoning, CodexStep (an item kind with no concept, kept whole), CodexCommandApproval, CodexQuestion, CodexUsage and CodexInstructions, with the source's own fields and every report as an event (token usage, rate limits, errors, reroutes, reviews); who started each turn is a fact (`Turn.startedBy`); `fidelity.mjs` lists what it maps of the pinned schema and what it leaves out, with why, and a test diffs the schema against it.
- **The app's projects** (`graph/app-projects.mjs`, `graph/providers/codex/projects.mjs`; breadth.md D3) come from the app, not the protocol: the protocol's `Thread.projectId` is the app-server's id for a project, which is not the app's. The Host's store is a copy of framework-main's `projects` reports (§4.1); a reset, or its first report, is a sync, so no event is made of it. The native provider puts every local project as a LocalProject (name; location and folder its first root; a project without a root is not put), links each live thread to the project the app shows it in (`Project.threads` is the inverse) by the app's own rule (its renderer's project filter): an assigned thread is in its project, a projectless one in none, any other in the project its workspace-root hint names or whose root holds its working directory (the deepest), and emits `added`, `renamed` and `removed` when the app's list changes and `opened` when the app selects a project. `Project.open` (effect local: the app's selection), `Project.rename` and `remove` (effect external) and `LocalProject.reveal` (effect none) go to framework-main as `app-op`, and `openIn(app)` of a Project, Folder or File is ExternalApp.open's path; refused `unavailable` when nothing was tried (no store, an unknown project, a bad name), failed when the app's own call failed or nothing answered.
- **The apps on this Mac** (`graph/providers/codex/apps.mjs`; breadth.md D3) are ExternalApp instances read through framework-main's `apps` (§4.1): the app's installed "open in" targets and its computer-use approvals. An app is named by its bundle id where it is known (an approval's, a target whose executable is inside its `.app`, Finder and Terminal), else by the app's target id. `opens` follows the target's kind; `computerUse` is `always` for an approved app, `ask` for another, `unsupported` without computer-use settings (the app has no "never"). They are read at start, when the app's projects become available, every ten minutes, after a computer-use request is answered, and when observed after 30 s; a change of level or name says `changed`. `open(target)` opens a Project, File or Folder in a target the app's way; `setComputerUse('ask')` takes an approval back after the user approves a mod's call (R17); "always" comes only from the app's own permission prompt.
- **Environments** (`graph/providers/codex/projects.mjs`, `cloud.mjs`; breadth.md D3): each project's LocalEnvironment ("This computer": its folder), put and removed with the project; a thread whose working directory is in its project's folder runs there (`Thread.environment`). The CloudEnvironments are the signed-in account's environment configs (the app's newer cloud system, owner decision 2026-10-24), read through framework-main's `cloud-environments` (§4.1) at start, when a window is held, every ten minutes and when observed after 30 s; status `ready`, failed ones `unavailable`, anything else `preparing`, with `statusChanged`. Hosted threads run on the app's remote connection, which the mux does not see, so a CloudEnvironment links no threads. `manage()` opens the app's Settings, Codex Cloud (framework-main's `navigate`).
- **Git and worktrees** (`graph/providers/codex/git.mjs`, `worktrees.mjs`; breadth.md D3): each project's GitRepository and its branches, read through framework-main's `repository` (§4.1: the app's `repositoryOrigins` and its git worker) when the app's projects become available, every two minutes, when observed after 15 s and after a change the provider makes; `branchChanged`, `statusChanged`, `committed` and `pushed` say what moved. `switchBranch`, `createBranch` and `push` (then `pushed`) run through the app's `gitRepository` handles (framework-main's `switch-branch`, `create-branch`, `push`). A thread whose working directory is outside its project's folder runs in a WorktreeEnvironment when that folder is a worktree of the project's repository (framework-main's `worktree`: the same git common directory, not its checkout): the app's `worktree` attachment names it for a thread moved into one (`thread/attachment/list`, `thread/attachment/updated`), the thread's own folder for a thread started in one. One instance per worktree (its git root): named by its branch, or "Worktree" while detached (no `branch`), its base the branch metadata's or the default branch, its `setup` the environment's script. `remove()` is the app's Worktrees settings' Delete: refused while a chat in it is pinned, its chats archived as Thread.archive does (the threads area), then framework-main's `remove-worktree`; a mod's call asks the user (R17).
- **Instructions** (`graph/providers/codex/instructions.mjs`; breadth.md D3): one Instructions per `AGENTS.md` or `AGENTS.override.md`, named by its path: the global ones in the Codex home (the global `AGENTS.md` always, empty when absent: the app makes it when its settings show it), each project's in its folder, and a folder's once the files feed lists a folder that holds one (`listed`). An override that is not empty is followed in place of the `AGENTS.md` beside it (`enabled`). Read through framework-main's `instructions` at start, when the app's projects change, every two minutes and when observed after 15 s; each file is watched with `fs/watch` on the file itself, as the app watches the files it shows, and a change of text or `enabled` says `changed`. `edit(text)` saves through framework-main's `edit-instructions`; a mod's edit of the global instructions asks the user first (R17). `open()` shows the file in a tab beside the thread the window shows. The app has no switch for a file, so `enable` and `disable` are not realized.
- **A project's actions** (`graph/providers/codex/actions.mjs`; breadth.md D3): one ProjectAction (a Command) per action of the environment config the app selected for the project's folder, read through framework-main's `actions` at start, when the app's projects change, every two minutes, when observed after 15 s and when a config file changes (`fs/watch` on each config). `title` its name, `category` its config's name, `command`, `icon` the app's symbol (tool, run, debug, test), `enabled` while it is for this platform. `run(args?)` runs it through framework-main's `run-action` in a terminal of the thread the window shows, or of `args.thread` (then in that thread's own folder, such as its worktree), and says `ran`; without a thread shown it is refused and nothing runs.
- **The app's own state** (`graph/app-state.mjs`, `graph/providers/codex/app-state.mjs`; breadth.md D4) comes from framework-main's `app-state` reports (§4.1); a reset, or the first report, is a sync. The native provider puts one Setting per setting of the app's registry (its key; its title and SettingsSection are the Settings page that shows it, from a catalog of the build's pages, since the registry has neither; its kind and choices from its schema; `value` the effective one; scope `app`), one SettingsSection per page, the Theme (mode the `appearanceTheme` setting, the appearance framework-main reports; accent, fonts and tokens what a window's theme shows, reported by the renderer runtime on `framework/theme`; the font size the `sansFontSize` setting) and the App (version, onboarded; launched once when the App is first put within five minutes of the app's start, quitting, windowOpened and windowClosed from the framework's window events). `Setting.set`, `reset` (the default: the app has no unset) and `Theme.set('mode' | 'size')` write the app's way (`write-setting`); a mod's write of a setting the app's own agent may only read asks the user (R17). `App.openHelp` opens Documentation; `App.quit` and `App.sendFeedback` (the protocol's `feedback/upload`, no logs) ask the user first (R17).
- **The account** (`graph/providers/codex/accounts.mjs`; breadth.md D4) is the protocol's: `account/read` (never with a token refresh), `account/updated` and `account/login/completed`; a ChatGPT account is named by its account id and its workspace from framework-main's `account` (§4.1). One Account for the signed-in account (a ChatGPTAccount, or an Account for an API key or Amazon Bedrock), linked from the Codex agent; when the app signs out it stays, `signedIn: false`. Its Usage is `account/rateLimits/read`: one limit per window of each limit bucket in percent, near at 90 % or when the backend says one is reached, merged with `account/rateLimits/updated`, read again after a turn, every five minutes and when observed after a minute. `signIn()` starts the app-server's ChatGPT sign-in and opens its page (`open-login`); `signOut()` asks the user first (R17); `manage()` opens the app's account settings.
- **Feature areas** (`graph/providers/codex/areas.mjs`; breadth.md D5 to D10): from D5 on, a feature area of the native provider lives in its own module, `areas/<name>.mjs`, found by its file and written, tested and declared apart. It exports its part of `realizes.mjs` (merged into the core's), its types' operation handlers (added to a type the core registers; an operation defined twice fails the source's construction) and `createFeed(ctx)`, whose feed hears every notification, the answers to the app's own requests, observations of native refs, the start, app-server restarts and the disposal. Its context has the source's client, the graph handle, the app's stores and `mainOp(op, args)`, framework-main's module for the same area through `graph/main-ops.mjs` (§4.1). The fake app-server takes an area's modelled methods from `tests/fixtures/fake-areas/`, and the realizes test its samples from `providers/codex/test/areas/`.
  The areas start once, at the app-server's first ready (the Host never calls the source's `start()`); a later ready is `serverUp()`. A
  request the app-server answers only for a thread it has loaded (`turn/start`, `thread/compact/start`, `thread/settings/update`,
  `thread/queue/start`) goes through the context's `withLoadedThread`: on "thread not found" it resumes the thread, as the app does when it
  opens a chat (`thread/resume {excludeTurns: true}`), and asks once more. The areas:
  - **Thread operations** (`areas/threads.mjs`, `framework/main/areas/threads.cjs`; D5): `send` (`turn/start`) and `steer` (`turn/steer`
    with the running turn), `stop` (an active goal paused first, `turn/interrupt`, then the background terminals cleaned, as the app's
    stop), `archive` (the app's archive bookkeeping, `managedWorktrees.registerThreadArchive`, then `thread/archive`, else the app's
    `archiveInactiveThread` for a thread with no rollout; then its unpin) and `restore`, `open` (the app shows the chat), `fork` (from a
    turn), `delete` (an archived chat, the app's `deleteArchivedThread`), `compact` (between turns), `setModel`, `pin` and `unpin` (the app's
    `pinnedThreads`; `pinned` is read from it every minute and after the app's own pin) and `export` (the transcript as markdown). A mod's
    send, steer, compact and delete ask the user (R17).
  - **The follow-up queue** (`areas/queue.mjs`; D5): one QueuedMessage per entry of the app-server's queue (`thread/queue/*`), listed when a
    thread is observed and on `thread/queue/changed` (`queued`, and `sent` or `removed` when one goes); `Thread.enqueue`, `edit`, `remove`,
    `move` (reorder) and `sendNow` (steering a running turn with it, then deleting it, else `thread/queue/start`), as the app's queue does.
    An archived or ephemeral thread has none. A mod's enqueue, edit and sendNow ask the user (R17).
  - **A thread's settings** (`areas/thread-settings.mjs`; D5): per thread four Settings with scope `thread` in a Composer section (model,
    reasoning effort, mode, access), from `thread/settings/updated` and the answers to `thread/start`, `resume` and `fork`; model, effort
    and mode are set through `thread/settings/update`; access is refused (the app's permissions menu asks before full access);
    `Model.select` for a thread or its draft.
  - **The composer** (`areas/composer.mjs`, `framework/main/areas/composer.cjs`; D5): one Draft per chat from the app's saved drafts
    (framework-main reports `composer-prompt-drafts-v2` of the persisted atom state; nothing else of it leaves main). `setContent`,
    `insert`, `attach`, `clear` and `send` work the chat's composer through the app: framework-main shows the chat, then posts the app's
    own host messages (`codex-micro-insert-composer-text`, `codex-micro-insert-skill-mention`, `add-context-file`) and runs its commands
    (`composer.clear`, `composer.submit`); `send` returns the turn that starts. `Skill.use` and `File.attachTo` insert into a draft;
    `Project.newThread` and `Agent.newThread` open the app's new chat (prefilled, and sent with a draft). The custom prompts in the Codex
    home's `prompts/` are SlashCommands (`/prompts:<id>`); `run` inserts the command and submits it. A mod's send, new chat with a draft
    and run ask the user (R17).
  - **Tool servers and tools** (`areas/tool-servers.mjs`, `framework/main/areas/tool-servers.cjs`; D10): the layered config's
    `mcp_servers` (the user layer and the projects', a project's read-only) joined with `mcpServerStatus/list`; a server the app or a
    plugin brings is read-only. A Tool per tool the status lists, and one per tool the config turns off (the status leaves those out),
    `enabled: false`. `edit` and `remove` (`config/batchWrite`), `enable` and `disable` (`config/value/write`) as the MCP settings page
    writes; Tool `enable` and `disable` write `disabled_tools` or `enabled_tools` (the app has no switch for one tool); `restart` reloads
    every server (`config/mcpServer/reload`: the app has no per-server restart); `signIn` is `mcpServer/oauth/login` with its page in the
    browser (https, or http on this Mac's loopback), then a reload when it completes. After a write framework-main refreshes the app's
    queries (the page follows). A mod's writes ask the user (R17).
  - **Plugins** (`areas/plugins.mjs`, `framework/main/areas/plugins.cjs`; D10): the local catalog (`plugin/list` with
    `marketplaceKinds: ['local']`, as the app's own local queries ask: with the remote catalog the answer was 21 MB) and every installed
    plugin (`plugin/installed`); `connected` from `app/installed` and each plugin's apps (`plugin/read`; one that fails leaves it unknown).
    `install`, `uninstall` (not Code Review, as the app refuses), `enable` and `disable` through the protocol, then the app's refresh and
    its browser plugin sync; `connect` and `disconnect` open the plugin's page. A mod's changes ask the user (R17).
  - **Skills** (`areas/skills.mjs`, `framework/main/areas/skills.cjs`; D10): `skills/list` over the projects' roots, and the app's skills
    library (`recommendedSkills`) for what is not installed; `enable` and `disable` (`skills/config/write`), `delete` and `install` through
    `recommendedSkills`, `edit` opens SKILL.md beside the chat. A mod's changes ask the user (R17).
  - **Codex defaults** (`areas/agent-config.mjs`, `framework/main/areas/agent-config.cjs`; D10): the Configuration page's keys as Settings
    of the user config layer (scope `app`) and of each project's `.codex/config.toml` (scope `project`: the six keys the page writes, edited
    as it does through `workspaceFiles`); `Model.makeDefault`; the Codex agent's links to its settings, instructions, skills, tool servers
    and installed plugins. A mod's writes ask the user (R17).
  - **Commands** (`areas/commands.mjs`, `framework/main/areas/commands.cjs`; D6): the app's command table, found among the main process's
    loaded modules by its shape (objects with an id, tagged by kind or titled), as Commands with the menu's titles; their Shortcuts from the
    keymap service `commandKeybindings` (read every minute). `run` goes through the application menu for an Electron command, else
    `run-command`; `rebind` and `reset` go through the keymap service, then the Keyboard shortcuts page's own query is refreshed. A mod's
    rebind and reset ask the user (R17).
  - **Changes** (`areas/changes.mjs`, `framework/main/areas/changes.cjs`; D7): a turn's and a thread's ChangeSet, FileChanges and Hunks
    from the protocol's `fileChange` items (FileEdit steps link their FileChange); `revert` and `apply` of a set, a file or a hunk are the
    git worker's `apply-patch` (atomic: no 3-way merge), newest first to undo; `viewDiff` and `openFile` show the chat, then open the tab;
    `openIn` as a project's. A mod's revert and apply ask the user (R17).
  - **Run control** (`areas/run-control.mjs`, `framework/main/areas/run-control.cjs`; D7): copying a turn's answer, a message, a step, a
    command or its output with the app's clipboard; `Turn.retry` and `rewind` are the app's own Edit of the last message, sent with
    `kit.followerRequest` to the window that owns the chat (it reverts and starts the turn, and its transcript follows); `CommandRun.stop`
    terminates the command's process (`thread/backgroundTerminals/terminate`). A mod's retry and rewind ask the user (R17).
  - **History** (`areas/history.mjs`, `framework/main/areas/history.cjs`; D7): the current branch's commits since its base
    (`branch-commits`), with their files and author (the commit object) read once per sha; `Repository.commit`, `GitRepository.stage` and
    `unstage` and `ChangeSet.commit` through the git worker (no attribution trailer), then the repository is read again. A mod's writes ask
    the user (R17).
  - **Review** (`areas/review.mjs`, `framework/main/areas/review.cjs`; D7): a turn with the app's review prompt is a Review; the
    `::code-comment` lines of its answer are Findings, as the app parses them; `Finding.open` shows the diff, `dismiss` writes the app's own
    dismissal (its persisted-atom state, keyed as it keys a model comment, then the windows are told); `Review.stop` interrupts the turn. A
    mod's dismiss asks the user (R17).
  - **Comments** (`areas/comments.mjs`, `framework/main/areas/comments.cjs`; D7): the drafts in the app's `commentAttachments` store
    (observed at its writes) and the comments sent in a message (its `## User Comment` blocks); `Hunk.comment` and `Finding.comment` add a
    draft, `edit` and `delete` change it, `send` sends one to Codex as the app writes it. A mod's send asks the user (R17).
  - **Pull requests** (`areas/pull-requests.mjs`, `framework/main/areas/pull-requests.cjs`; D7): your pull requests of each project's
    repository through the app's `github` service (the `gh` CLI: the board, then each open one's summary and reviews), as GitHubPullRequests
    with Branch.pullRequest and a chat's attachment; `open`, `refresh`, `markReady`, `merge` and `ChangeSet.openPullRequest` (push, create,
    attach). A mod's writes ask the user (R17).
  - **Terminals** (`areas/terminals.mjs`, `framework/main/areas/terminals.cjs`; D8): your terminals from the app's terminal manager
    (observed through its listener sets, never the window service's single listener) and the agent's background terminals (commands still
    running after their turn); yours take `run` and `write` (typed), `clear`, `stop`, `close` and `focus`; the agent's `stop` and `close`
    terminate the process. A mod's run and write ask the user (R17).
  - **The browser** (`areas/browser.mjs`, `framework/main/areas/browser.cjs`; D8): the in-app browser's tabs from its manager (read every
    15 s and on the app's invalidations); `navigate`, `reload`, `back` and `forward` through `browserHost.runPageCommand`, `close` with the
    app's host message, `openExternally` in the default browser. A mod's navigate asks the user (R17).
  - **Computer use** (`areas/computer-use.mjs`; D8): a chat's ComputerUseSession from its ComputerAction steps (running until its turn
    completes, as the app's tray shows it); `stop` interrupts the turn.
  - **Automations** (`areas/automations.mjs`, `framework/main/areas/automations.cjs`; D9): the app's local automations
    (`localAutomations`) and the chats their runs started; `runNow`, `enable`, `disable`, `edit` and `delete` through that service, then
    its pages are told (`automation-runs-updated`). A mod's operations ask the user (R17).
  - **Notifications** (`areas/notifications.mjs`, `framework/main/areas/notifications.cjs`; D9): observed at the app's notification
    manager (shown, opened, dismissed); `open` shows the chat and hides the notification, `dismiss` hides it.
  A page's conversation id is not always its thread's: a chat begun in this profile keeps its client id (`client-new-thread:<uuid>`) in its
  page, which `kit.threadIdOf` maps to the thread as the app does (its persisted `thread-client-id-v1` entries).
- **The user's approval of a mod's one-time action** (`graph/approvals.mjs`; runtime-core.md R17). An operation whose effect lasts beyond the call gives `approval(call)`; when it returns a prompt and the caller is a mod, the runtime asks the user after the interceptors and before the claim. framework-main shows the app's native dialog (§4.1), outside every page so no mod's code can answer it, naming the mod and its id; Don't Allow is the default, a checkbox stops that mod asking for that operation until the app restarts, and each call asks again (there is no "always allow"). One prompt at a time; a mod with one waiting is answered no; one unanswered for 5 minutes or cancelled closes as not allowed. A no is `refused notAllowed`; a yes is recorded on the intent (`approvedBy: user`).
- **A project's folders and files** (`graph/providers/codex/files.mjs`; breadth.md D3) are read the app's way, through framework-main's `list` and `inspect` (§4.1). Each project's folder (its first root) is put with the project and goes with it, with everything read inside it. A folder's contents are read when a realm observes the folder, its `files` or its `folders`; a file when it is observed (a FileEdit's or an Attachment's file); what is no longer there goes, and a file that goes says `deleted`. A folder that was read is watched through the protocol on the source's own client (`fs/watch`; `fs/changed` names the watch, and the mux routes it to the watch's creator), at most 64 at a time, the least recently read let go; a change reads it again, and a file whose size or time changed says `changed`. A backend restart ends the watches; they are made again when the app-server is ready. A path outside every project has no instance. `File.open` (effect local), `File.reveal` and `Folder.reveal` go to framework-main with the path, in the project that holds it.
- **Read state** (`graph/read-state.mjs`, docs/design/presentations.md V12) keeps the app's unread state and `Thread.unread` in step both ways. The truth is the app's own (its global state, reached by framework-main's `threadReadState` session, §4.1); the Host's store is a copy by protocol thread id, fed by `read-state` reports and written with `set(threadId, unread)`, which takes effect at once and goes out as `read-state-set`. A write carries the account epoch of the last report (boundary review R3): framework-main applies it in that account's session only, acks it once applied, and reports the ones it drops (another account's, refused, failed), whose effect reverts. Every change is announced with its origin: `app` (the user read or unread a thread), `framework` (our own write) or `sync` (catching up: the first report of an account, after the app was unreachable, an expired or dropped write), and only an `app` change is treated as the user's doing. *Native threads:* `Thread.unread` is put from the store and follows it; `Thread.markRead` (effect local) writes the store, and is refused `unavailable` while the app has no session. The app's own mark-read has already happened when the Host hears of it, so nothing holds it for interceptors (`interceptable` says `graph only`). A mod's chats keep their own read state (their provider's `unread`, read when their view is shown). A backend restart or an observation gap makes its instances stale until it has read them again.
- **The framework's provider** (`graph/providers/framework/`, docs/graph/07, docs/design/systems.md S1 to S4): the framework's own types (CodexMods, Mod, Operation, with Feature and CopyUpdate to come; `sdk/graph/framework.mjs`, owner `framework`) and the mods' settings (`providers/framework/settings.mjs`, docs/design/systems.md E3: a SettingsSection per mod and group under the Mods section, a Setting per declaration at the app scope and at a project's or a thread's where a value is stored there or the instance is observed, its value the effective one there; `set` and `reset` are a scoped patch through `mods.configure`, answered when the operation ends), under the provider id `codexmods.framework`. It reads the management state through the management dispatcher (`mods.list`, `mods.inspect`, `compat.report`, `ops.list`, `diagnostics`, `updates.status`) and follows its events (a phase of an operation reads only the operations again); each of its operations is a management mutation, validated and journaled there, answered with the Operation's ref as soon as the mutation is accepted (the outcome is the Operation's state). There is no second lifecycle path.
- **Mods' chats** (docs/design/graph-integrity.md G2; decision D6 retired the protocol presenter): the app's store holds only Codex's chats. A mod's chats are in the shared surfaces through their concept: the sidebar (a group for their agent after the app's own groups, and the mods' sections), as rows the framework draws (the lent `ChatRow`: title, working or waiting, unread, time; a menu of the shared actions they support, each the user's act through `ctx.present.userAct`, delete asked first); the palette's "Agents' chats" (the graph's search of Threads); their agent's notifications (`ui.notify` with the chat as subject). Opening one routes to the view its subtype registers (`ui.replace('ThreadView', {for})`), drawn on `/codexmods/page/<provider>/view~<ref>` with the parts the framework lends (G2.3); shown, it is read (`Thread.markRead`, the user's). A subtype with no view is not drawn (the DetailView is a developer inspector).
- **Mods reach the runtime through `ctx.graph`** (host realm; permission `graph`): `registerTypes`, `provide` (a mod is one provider, whose id is its mod id; its operation handlers and `onObserve` run in its worker), `put`/`update`/`remove`/`setComplete`/`markStale`/`markLive`, `invoke` (as the mod), `can`, `resolve`, `list`, `related`, `types`, `subscribe`, `attach` and `attached`. A mod writes only its own instances. *Which instances* (docs/design/public-hooks.md §3.1, `framework/shared/where.mjs`): `list`, a view's `{type, where}` and every presentation rule's `for`/`where`/`of` take one grammar, evaluated alike in the Host and the page: paths (state fields, a relation then its target's path up to three hops, a mod's attached data `@<modId>/<key>`), literals by equality, `$` operators, `$or`/`$not`; a path that cannot be resolved now, or that goes through an instance the reader may not read, is unknown and matches nothing but `{$exists: false}`. *Attached data* (§3.3, `graph/attachments.mjs`): a mod's own value on anyone's instance, private unless shared, written with `graph.attach` (or on its own instances and types), kept in the mod's data directory apart from the instances (a provider going away keeps it; a `deleted` event drops it), loaded when the mod starts; every read and view carries it as the reader may see it (a mod: its own and the shared ones; the page's runtime: all of them with `attachedPrivate`, applied per rule owner). *Authority* (`graph/policy.mjs`, docs/design/breadth.md D0.2) is one rule from the mod's grants: with `graph` a mod reads and acts on its own instances, reads every instance of a type it declared (one it registered, or a subtype of one) and intercepts that type's operations; anything else needs `graph.read`, `graph.act`, `graph.intercept` or `graph.attach` (§8.3). The Host gives the rule to the runtime as `authorize`, which checks every `invoke` and an interceptor's changed call; the ingress applies it to reads, so `resolve`, `list`, `related` and a view's snapshot and deltas never carry what the mod may not read, `can` is false where it may not act, and an interceptor it may not register is refused. The user, the native provider and the framework are authenticated by their own ingress and not limited by it. A provider id that is not a mod's (`codex`, `codexmods.framework`) is never a mod's own, and no mod may take one as its id. The framework's own instances (docs/design/systems.md S4) are the user's: no mod acts on them, intercepts or replaces their operations, whatever its grants, the copy's update included (docs/design/graph-boundary.md B5: a mod cannot stop the update that fixes or removes it); a mod reads its own Mod, and reads and acts on its own Settings (the mod decoded from the instance's id; another mod's only read, with `graph.read`). Interceptors are registered on a type and see its subtypes, so the runtime asks the rule again for each call's own type and runs only the interceptors it allows. Its types and its provider go with it when it stops, and so does what other mods built on its types (their subtypes, interceptors and instances of them; a provider left with no type is disposed); those mods are degraded in the compatibility report (`missingTypes`, `missingBecause`) until they register again (boundary review 6b). In the renderer realm `ctx.graph` has the read members (`resolve`, `list`, `related`, `types`, `can`, `subscribe`, `attached`) and `invoke`; the rest is host-realm only. The page's own presentation runtime reads the graph under the reserved id `codexmods.framework` on the renderer channel only (graph reads and `invoke` as the framework; no other namespace; no mod may take the id), through a per-window replica (`framework/shared/graph-replica.mjs`: refcounted views per instance, core depth, a short linger). `ctx.graph.intercept(type, operation, fn, {priority, replaces, deadlineMs})` runs `fn(call, next)` in the mod's worker; `next` crosses back to the Host. A call cancelled while it is held (the user's Stop) is told to the worker, where `call.signal` aborts (6a, 3b).
- **What the agent gets from a mod: `ctx.agent`** (host realm; permissions `agent.tools`, `agent.skills`, `agent.instructions`; docs/design/public-hooks.md §3.16, `framework/host/agent`): the Host's agent part is a framework client of the mux. A mod's tools are one namespace of the protocol's dynamic tools (`mod_<id>`), added to each new non-ephemeral thread on the app's server; the agent's calls of them are answered at the mux by the mod's `run` in its worker (or, the mod not running, with a failure that says so), never by the app. Its skill folders (inside its package) join the server's extra skill roots. Its instructions join a thread's developer instructions (start, resume, fork; one marked block per mod), and a function's text goes with each turn as additional context under `mod:<id>`.
- **The app's own operations are intercepted too** (`graph/app-ops.mjs`, docs/design/interception.md). The app's protocol requests that carry a thread operation on Codex's threads (`turn/start` is `send`, `turn/steer`, `turn/interrupt` is `stop`, rename, archive, unarchive, fork, compact, review, goals, delete) are matched at the mux, the one choke point they cross on 20770. When the graph has an interceptor for that operation on the thread's type, the request is deferred (mux addition 5) and decided by `graph.interceptApp`: the same path as `invoke` up to the interceptors, with the app's request going on (changed or not) as the terminal and no durable claim. A refusal answers the app's request with an error; an interceptor that throws, misses its deadline (60 s by default, its own time only, at most 10 min) or goes away releases the request unchanged; the app disconnecting cancels the hold. An interceptor that replaces the operation is claimed in the journal before it runs, and once it may have started its request is never released: a replacement that fails, turns uncertain or misses its deadline answers the app with an error (docs/design/boundary-review.md 3a). Decisions on one thread are made in arrival order, Stop in a lane of its own; a Stop that goes on cancels the steers held on its thread, and the user's Stop while their send is still held (the app then has no turn to interrupt and sends only `thread/backgroundTerminals/clean`) cancels the held send. Reflection (`graph.interceptable(ref, operation)`) says `any origin` for the operations whose app path is bound this way, `graph only` for the rest.

---

## 7. Mod runtime

### 7.1 Package

A mod is a `.codexmod` archive, or a directory in developer mode, containing `mod.json` (`contracts/manifest.d.ts`) and its code. The manifest declares:

- `id`, `version`, `name`, `framework` (a version range) and `publisher` (an ed25519 public key; absent in developer mode);
- what the framework's pages read, all optional: `description`, `author` (the mod's own claim, never an identity), `glyph` (a name from the kit's set; one it lacks draws the default), `about` (paragraphs), `media` (package images, at most 1 MiB each and 8 MiB together, given on request by `Mod.image` as a data URL rather than kept in its state), `testedWith` (the exact builds the author tested);
- `entry` (`host` and/or `renderer`, each a single-file ESM module);
- `permissions` (§8.3), `requires` and `optional` (the feature log's ids, with methods and components, which drive compatibility, §15);
- `settings`: a list of settings and groups (docs/design/framework-ui.md F7): a group is `{group?, icon?, description?, media?, items}`, an item `{key, title, description?, icon?, kind, control?, default, scope?, options?, schema?, min?, max?, step?, unit?, placeholder?, requires?, needs?}`, with `kind` what the value is and `control` how it is drawn; `ctx.settings.get()` is one flat document;
- `data` (`schemaVersion` and an optional `migrate` module, §11.4);
- `processes`, the external processes the mod may start: workers (the default), which answer the mod's calls, and sessions (graph-integrity G8.2), long-lived and fed through their input, which may run a program on the Mac by name (`executable`, named in a `processes.exec:<name>` permission).

### 7.2 Entry points and realms

```js
export default defineMod({
  host(ctx)     { /* worker thread in the Host */ },
  renderer(ctx) { /* each app window, page main world */ },
});
```

Each entry may return a disposer, and every registration made through `ctx` is also tracked and disposed automatically. There is no main-process realm: anything that needs Electron main (for example extra views) is a generic framework facility (§9.4).

### 7.3 Execution and isolation

- **Host code** runs in one worker thread per mod, with a memory limit (default 256 MB) and a heartbeat. The mux dispatches to a thread only for its matching registrations. A thread that misses heartbeats for 5 s is terminated and the mod is quarantined; the app, the mux and other mods keep running. The 5 s are the Host's own time: a watchdog tick that comes more than 2 s late means the Host itself stalled (a long synchronous job, the machine asleep), so the stall does not count as any mod's silence, and that tick leaves the judgement to the next one, after the Host has read the heartbeats queued meanwhile. A thread that is really stuck still runs out of time, even while the Host stays slow. The deadlines the Host keeps on a mod work the same way (`framework/host/deadline.mjs`: an interceptor's in the mux and in the graph, activation's, a migration's): one expires only after the Host has had a turn of its event loop to read what arrived meanwhile, and one that fired more than 1 s (or half its length) late, overrun by the Host's own stall, starts again, once.
- **Renderer code** runs in the app's page realm, the only way to use the app's real React tree and components. Isolation there is best-effort: each mount has its own error boundary, errors are attributed through `codexmod://<id>/` module URLs, and repeated faults unmount and quarantine the mod. A renderer mod that busy-loops can freeze its window (§20).
- **Mod processes** are declared in the manifest. The Host spawns them in its process group, supervises them with backoff (at most 3 restarts per 10 minutes), and gives each a per-process token for the Host socket. Through that socket they get the same context minus `ui`, with the graph's reads, views and `invoke` as the mod under its grants (graph-integrity G8.2), and no app-server stdio, Electron handles or app IPC. A worker started on demand stops after `idleStopMs` unused. A **session** is never stopped for being idle, restarts after a failure only with `restart: 'on-failure'` (the same bounds, the same start), starts with arguments and a folder the mod gives, may run as several at once (`instances`, at most 16, each addressed `name#key`, the one past the limit `Busy`), takes input through `ctx.processes.write` (at most 4 MiB not yet taken, then `Busy`) and gives its output line by line (`output`, held back while a listener's realm is behind, the program waiting at its pipe); one that ends cleanly (code 0) is done, not restarted. A session may run a **program on the Mac** by name (`executable`, D4): one a `processes.exec:<name>` permission names, so consent shows it ("Runs claude on your Mac") and an update that adds one asks again; it is found on the user's PATH (their login shell's) at each start, runs in their home folder unless the mod gives another, and gets none of the framework's connection, since it is not the mod's code. Host code could already spawn programs (`node:child_process`), so naming one adds disclosure, not power.

### 7.4 Activation

Enable loads the mod's host entry in a new thread; its renderer entry loads in every window, including windows opened later. Activation must settle within 10 s of the Host's own time (§7.3) or it counts as failed. Disable runs disposers, closes the mod's interceptors and observers, unmounts its UI, stops its processes, revokes its leases and stops its backends' idle timers. In-flight requests resolve truthfully (§6.5), draining is bounded at 5 s, then the thread is terminated. No mod change needs an app relaunch.

### 7.5 Internal mods and mod intelligence

Functionality the app does not have, which the framework ships itself, is an **internal mod** (graph-boundary.md D7; `framework/host/internal-mods.mjs`): a mod of the framework's own in `framework/mods/<id>/`, run like any mod (its worker, its ctx, the same grant checks). The Host starts it before the user's mods, granting what its manifest asks; consent is not asked, since it is the framework's code. It is not in the user's Mods list, never installed, updated, replaced or removed as a package (its id is reserved: a package with it is invalid), and not run in safe mode. What only an internal mod gets is a hidden root for its app-server client (§6.2, private threads).

**Mod intelligence** (`codexmods.intelligence`, GOAL.md goal 16) is the first. A mod declares model use in its manifest (`intelligence: {why, tools?}`); the declaration grants nothing. Consent shows it among the mod's permissions (`Model use`, never granted there), and the Mod instance carries it (`Mod.intelligence`). Mod intelligence keeps one `ModelUse` per declaring mod, which only the user changes, from the **Model use** section of the mod's page in Settings, Mods or from mod intelligence's own page in Settings. Each records:
- the switch, off by default;
- the model (Luna by default);
- the token allowances per hour and per day;
- the other kinds of tool allowed;
- what the mod used.

A mod calls with `ctx.intelligence.ask` (any realm). Its ctx serves the call through a service of the mod's own, for that call alone, which only mod intelligence may call: the mod's tools, its storage and settings as tools, the streamed text and the end. Mod intelligence's `model` service, told the caller (a mod service's handler gets `{caller}`, §8.1), admits the call against:
- the switch and the allowances;
- 30 calls a minute and 4 at once;
- the prompt's size and the call's time;
- the account near its limit (CodexUsage).

It runs the call as one ephemeral private thread: approvals off, a read-only sandbox, Codex's own tools and the user's setup off, the mod's tools in one dynamic-tool namespace. It counts the thread's token reports against the mod, and the switch ends a mod's running calls at once.

---

## 8. SDK v1 (the mod-facing contract)

`@codexmods/sdk` provides types (`sdk/index.d.ts`), `defineMod`, a test harness (`@codexmods/sdk/testing`) and starters (`sdk/templates/`: a panel, a presentation rule, a contribution, an agent; each a working mod with its test, made with `codexmods new <id> --kind <kind>`; [docs/AUTHORING.md](docs/AUTHORING.md)). The Host provides the runtime context. Mods may use any bundler.

The test harness has two parts:
- **`createTestGraph()`** is the graph a mod meets in the app, offline. It is the real runtime: the graph with the app's types, and the Host's mod runtime, so a mod's host entry runs in a worker with the ctx it gets in the app (`mod(dir)`), and its renderer realm's `ctx.graph` is the page's (`renderer()`). The app's own instances come from providers the test declares (`provider(id, types)`), and the user or the app acts through `invoke`. It authorizes as the Host does (the graph policy over each running mod's grants), so a link or an act the app would refuse is refused in the test too; `path` gives a session's programs a test's own PATH.
- **The fakes** (`createFakeHostContext`, `createFakeRendererContext`, recorded-traffic `replay`) test the protocol plane and the page. The renderer fake records what a mod declares (commands, settings and main pages, panel tabs, regions, presentation rules) and what it hosts of the app's (`ui.host.thread`, `ui.host.tab`), draws it with a fake React, and takes a test graph's renderer realm as its `ctx.graph`.

### 8.1 Context

| Namespace | Methods | Notes |
|---|---|---|
| `mod` | `id`, `version`, `dataDir` | — |
| `log` | `debug`, `info`, `warn`, `error` | Per-mod ring buffer plus file; rate-limited |
| `settings` | `get(key?, {project?, thread?})`, `set(key, value, {scope?})`, `reset(key, {scope?})`, `onChange(fn(document, change))` | Validated against the declarations; a value is stored at the app, a project or a thread and inherits thread, project, app, default; `get()` is v1's whole effective app document; `set` and `reset` are one scoped patch, answered when it is written; one value across all realms |
| `storage` | `get`, `set`, `delete`, `list(prefix)`, `transaction(fn)`, `watch(prefix, fn)` | Atomic-commit KV store. `storage.retained` has the same API but is excluded from data restore (§10.3). Files live under `dataDir/files`. |
| `secrets` | `get`, `set`, `delete` | Keychain, namespaced by profile, mod and publisher; never snapshotted |
| `events` | `on(topic \| pattern, fn, {replay?})`, `emit(topic, data)`, `state(topic)` | Framework topics plus `mod/<id>/*`; gap semantics as in §6.5 |
| `services` | `provide(name, handlers)`, `call(modId, name, method, args)` | Mod-to-mod and framework services; schema-checked JSON; a handler is told who called (`(args, {caller})`: a mod, a client holding a mod's lease, or the app) |
| `intelligence` | `ask({prompt, instructions?, model?, tools?, storage?, settings?, onText?, timeoutMs?})`, `status()` | Model use through mod intelligence (§7.5): off until the user turns it on, within their allowance |
| `appServer` | `request`, `notify`, `observe`, `intercept` (host and process realms only), `backends.define / remove / list`, `clients.issue / revoke` | §6 |
| `processes` | `start(name, {args?, cwd?})`, `stop(name)`, `call(name, method, params)`, `write(name, data)`, `on(name, event, fn)` | Only declared processes; a session's input through `write`, its lines as `output` events (§7.3) |
| `scheduler` (host realm, preview) | `schedule({id, at, data, generation})`, `cancel(id)`, `on(id, handler)`, `get`, `list` | Durable wall-clock jobs kept in `storage.retained`; at most once per intent; a job that crashed between `started` and an outcome is delivered once as `uncertain` and never retried. Prototype from gate G-sched: docs/research/gate-scheduler.md. |
| `ui` (renderer realm) | `react`, `components`, `theme`, and the presentation rules (`commands.add`, `panel`, `panels.open`, `pages.add`, `settings.page`, `layouts.add`, `host.thread`, `notify`, ...) | §9 |

That is about 40 methods. The renderer realm gets every namespace except `appServer.intercept` and `processes`, proxied asynchronously to the Host.

### 8.2 Errors

One small set shared by every API: `Denied`, `Unavailable`, `OutcomeUnknown`, `Busy`, `Timeout`, `Invalid`, `Conflict`, `Incompatible`, `Disposed`. `OutcomeUnknown` always means the action may have happened.

### 8.3 Permissions

Granted at consent (§13): `appServer.observe|request|intercept[:methods]`, `appServer.backends`, `appServer.clients`, `ui`, `secrets`, `processes`, `processes.exec:<names>` (the programs on the Mac a mod's sessions run, never bare), `network` (advisory), `framework.updates` (privileged service), `graph` (`ctx.graph`: a mod's own types and instances, §6.8) and, beside it, `graph.read|act|intercept[:entries]` for other providers' instances: bare for every type, or a list of type ids (a concept covers its subtypes), where `act` and `intercept` entries may name `<Type>.<operation>` (`graph.read:Draft`, `graph.intercept:Thread.send`). Storage, settings, events, services and logging need none.

**Decisions** (`framework/host/permissions.mjs`, docs/design/framework-ui.md F8). The manifest's `permissions` are required: consent grants them, and the way to stop one is the mod's switch. Its `optionalPermissions` are each the user's to decide, kept in the record's `decisions` by grant string; none may cover what a required or another optional one does (`overlaps`: same family, one bare, or a shared type, operation or method prefix), `network` is never optional, and `processes` is optional only with no process that starts with the mod. What a decision may be follows what can be enforced and whether a call can wait: an act on the graph, a secret and a request to Codex are `allow`, `ask` or `deny` (default `ask`); what is checked at activation, registration or in a path that cannot wait is `allow` or `deny` (default `deny`); `network` is declared, not enforced, and has no decision. The record's `grants` are what the mod holds outright, its required grants and its optional ones allowed, and every reader (the graph's policy, the ctx gates, the mux, the rules, the processes) reads them as before. A grant decided `ask` is never among them, so whatever cannot wait treats it as not held by construction. Only three gates look at the asks, and only when the held grants refuse: `graph.invoke` (after the policies let the call through, before the approval R17 and dispatch, once for the call, an interceptor's change included; an automatic action never stands in for the answer), `ctx.secrets` and `ctx.appServer.request` (the mux carries a request under an ask grant once the ctx gate let it through). The prompt is the windows provider's question in the window in front, settled only by the page's own runtime: one per mod at a time, ending on its 60 s, on the mod stopping or on a decision changing (withdrawn); `Allow once` lets the call through, `Always allow` writes the decision, and `Deny` keeps that grant from asking again while the mod runs. Nothing asks while a mod starts or in safe mode. `ctx.permissions` gives `state(grant)`, `request(grant, {title?, subtitle?, body?})` (Allow and Don't allow; a grant not declared is refused without a prompt) and `onChange`. `Mod.setPermission(grant, decision)` (management `mods.setPermission`, op `set-permission`) restarts a running mod, since its rules, subscriptions and clients hold copies, unless the change is from ask to allow, which takes nothing away. An update keeps a decision, gives a new optional grant its default, and asks consent for an optional grant become required (a copy update reads what each mod requires again under its lock, so a decision changed after staging cannot slip through); a rollback, a last-known-good restore and an update undone never raise a decision (a restore that would hold again a grant the user has since set to ask or deny leaves that mod as it is). An answer lets a held call through only into the run of the mod that asked, still running, outside safe mode and with the grant not denied since; the prompt keeps its own deadline. The card is drawn in the page, where renderer mods also run: it is consent, not a boundary, and an effect that must not rest on it stays with R17.

### 8.4 Framework topics

`appServer/starting|ready|exited`, `backend/<key>/*`, `window/created|shown|focused|closed` (`shown` the first time a window is shown: the app creates some hidden), `ui/anchor/<name>/appeared|disappeared`, `framework/compat` (state), `framework/metrics` (sampled mux latency, queue depth, per-mod cost) and `mod/<id>/*`.

### 8.5 Data migration entry

`migrate({from, to, storage, settings, files})` runs in a separate worker whose only framework API is a staged copy of the mod's data: no app-server, services, processes or leases (§11.4). Like all mod code it is trusted, so Node's own network and process modules are not technically blocked (§13).

### 8.6 External clients

`ctx.appServer.clients.issue({name})` returns a lease descriptor (socket path plus token) that the mod hands to an external program, such as a helper service or a menu bar app. The program becomes a logical client of the mux with its own affinity keys and server-request routing, and with permission it can call the mod's services. Disabling the mod revokes its leases. Leases are the only supported way for something outside the app to use the app-server.

---

## 9. UI plane

### 9.1 Injection

framework-main registers the framework preload for the app's sessions with Electron's session preload API, so the app's own preload file is not edited. The preload installs the renderer runtime into the page main world, which resolves its anchors and components through the adapter pack, loads each enabled mod's renderer module, and talks to the Host over a MessagePort that framework-main hands it. The app's web content gets no general framework object, only the runtime's own channel.

### 9.2 Anchors, components and theme

- **Anchors** are the framework's own insertion points, which the adapter pack resolves for the current build by selector: `settings.section` (General page only: the recovery entry), `workspace` (the band), `sidebar` (the app's shell is on screen). They need no graph, no rules and no page runtime, which is what the recovery entry stands on. A mod draws through presentations (§9.6), never at an anchor.
- **Components** are the app's real components as the adapter exposes them: Button, Switch, TextField, Select, Menu, Dialog, SettingsSection, SettingsCard, SettingsRow, Tooltip, Icon. A mod's Button, Switch and Menu.Item carry the user's intent to their callbacks, as the kit's controls do (G7.1). On a pack with page seams the exposure blocks name them (and React and React DOM) under these keys, so the pack lists none (docs/design/presentations.md V10); the app has no standalone Select. If the adapter cannot expose one on a build, the runtime supplies a minimal primitive styled only with the app's theme tokens. Because these are real components, keyboard, input-method and accessibility behavior comes from the app. `ui.notify` uses the app's own toasts when the build exposes them.
- **Theme** gives the app's CSS variables and semantic tokens as reactive values. Light, dark and accent changes propagate without remounting. Framework components use only the theme's tokens for colors, fonts and corners (docs/design/presentations.md V9): a pack with page seams maps fifteen (text, textSecondary, background, surface, border, accent, danger, success, warning, scrim, onAccent, fontFamily, codeFontFamily, radius, spacing) to the app's own custom properties, and a token a build lacks leaves the property at its default, never at a literal.

### 9.3 Commands

`ui.commands.add({id, title, run, keys?, when?, appliesTo?, ...})` declares a command, in either realm: a row of the app's own palette, each of its key chords a hidden entry of the menu bar, in a subject's context menus when it `appliesTo` one (docs/design/public-hooks.md §3.14).

### 9.4 Views and places of a mod's own

A mod's view is a tab of the app's panels (`ui.panel`, opened with `ui.panels.open(id, {placement: 'panel'|'modal'|'side'|'window'})`), a page of the main region (`ui.pages.add`), a settings page (`ui.settings.page`), a region at the workspace's edge (`ui.regions.add`) or a sidebar view, each drawn in the app's own tree (docs/design/layouts.md). One of the app's own chats goes in any of those places with `ui.host.thread(ref, {composer?})`, a **pane**: the chat's own scopes under a route record of the framework's, around the app's own host of a second chat, with its composer and its requests; `ui.host.tab(kind, thread)` draws the panel kinds that stand alone (`review`, `subagents`). `Window.open(thread, {placement: 'side'})` is a chat beside another: a tab of the side panel, a view of the framework's, kept and restored as the app keeps its tabs.

### 9.5 The framework's UI

**The Mods pages** in the app's own Settings are the framework's UI (docs/design/systems.md S21, E6; §9.6 below: the Mods list, Update, Developer, a mod's page, the Dialogs, the band, the DetailView). They read the graph and act through it as the framework, drawn with the app's components and theme. **Adjustments**, the first management UI (a native section of Settings › General over the management API), went with E6.6d: every view it had is on those pages, and a v1 mod's settings schema is rows of graph Settings (E3). There is no separate mod-manager mod.

**The recovery entry** (`framework/renderer/recovery/`, E6.1) is a second built-in module, loaded first and on its own, at the top of the same Settings › General: safe mode, restoring last-known-good, the operations that need attention (acknowledged there, `ops.acknowledge`) and the latest activity, over the management port alone, so it works when the graph, the page runtime or the Mods pages do not. Each window reports its Mods pages (`framework/renderer/pages-status.mjs`): `running` once their route tree is reached, their navigation group has rendered and the framework's instance has been read; `failed` on a fault in their boundary (which takes only that part out of Settings), when they could not start or when the graph's types could not be read; `missing` otherwise (`starting` for the first 10 s of a window). The entry shows in that window unless the pages run, at once when they failed and after a short settle when they are missing, so it does not flash where they run; the pages are failed when the page runtime's Host channel closes and start again with the next one (E6.7). Safe mode and last-known-good each ask first and are never disabled by a running operation (the way out of a stuck one).

### 9.6 Presentations

The app's own components show the graph's instances (docs/design/presentations.md). Four parts:

- **Build-time seams** (`adapters/tools/seams.mjs`, V1, V2) are inert edits of the app's code, derived by strings and structure for each build and sealed in the pack: the JSX factory asks `__codexmods.jsx` first, the lazy loader passes each module through `__codexmods.lazy`, the three command tables start with `__codexmods.taps`, the item builder of a thread's menus passes its items through `__codexmods.menuItems`, main hands each window's AppHost to `__codexmods.appHost`, and one getter block per chunk names the app's objects under `__codexmods.exports`. Absent or throwing, the app's own behaviour runs. A group that does not derive leaves the pack degraded, declared in `seams.hooks`.
- **The kernel** (`framework/preload/preload.cjs`, V3) runs in the page's main world at document start through `contextBridge.executeInMainWorld`, with the armed bindings (`framework/renderer/present/addresses.json`: a binding's address is the prop keys its component's props carry, or with `exact` exactly those) from framework-main's synchronous `codexmods:kernel` answer. framework-main arms a binding only when the pack's `seams.hooks` delivers the seams and exposures it `needs` (a binding can also be addressed by an exposure, `exposure`, matched by the component's identity where its props are too generic; docs/design/systems.md E0); at a component type's first match its props must pass the binding's `canary` (the types it expects), or the type is never wrapped and the binding is off for the page and reported (boundary review 4a). It wraps each matching component type once, with a stable wrapper that reads the decision store, so bindings are in place from the first render; a binding whose address names an app scope (`scope`) has its wrapper read it through the app's `useScope`, for a component whose props do not carry its subject. A wrapper re-renders when the store is bumped or when a subject its binding read in its last render is touched, not for other subjects (4b).
- **The page runtime** (`framework/renderer/present/`, V4 to V8) gives each armed binding its renderer in the store and bumps it; every subject a binding reads is recorded, and a change to one touches only it (a binding's own components follow their subjects with `ctx.use`). A binding names its component's instance (`subject(props, ctx)`): a thread, turn or item by its protocol id (Codex's: the app holds no other provider's), a request card's Request by the id the app was asked with (`ctx.present.requestsOf`, resolved through the mux to the native source). Bindings that only name their instance pass through, for the rules that act on them; the page's probe report says which bindings work on the build (`binding:<id>`: matched, and named an instance the graph has). Bindings read their subjects from a per-window replica of the graph fed through the framework's renderer `ctx.graph` (framework scope). A binding that throws renders the app's own and is off until reload. Rules are not Presentation instances yet (V7).
- **Mods' presentation rules** (docs/design/systems.md S5 to S9, E2): `ctx.ui.decorate`, `hide`, `add`, `style` (both realms; data only in the host realm) and `replace`, `host`, `render`, `reorder` (renderer realm) on the presentation types the bindings realize, with the `graph.present[:Type]` grant; `style` sets the app's own variables to theme tokens (or other app variables) on every element, so it reaches a variable the app sets deeper than the root (a chat's width, a row's height), one owner per variable (`present/styles.mjs`); it stops at the framework's roots (`[data-codexmods-framework]`: its Settings pages, the Mods navigation, the band, its Dialogs, the recovery entry), where every custom property the rules' sheet changes (a variable a rule sets and any defined from it) is declared again with the app's own value, read without and with the sheet a moment and again when the theme changes (E6.4b, E6.7). The Host's registry of record (`framework/host/ui-rules.mjs`, namespace `ui`) checks the grant, the slot (`addresses.json` lists each binding's) and the realm, orders the rules (the mod's rank, priority, id) and keeps them for the mod's activation; each window's framework realm follows them (a snapshot, then deltas) and applies them in the bindings' wrappers (`present/rules.mjs`): claims, lists within a slot's budget, `reorder` last over the composed list (the app's entries with the mods'), regions, each mod node in a boundary, every function and callback guarded. A slot's name is the card's in camelCase without "the" (E7). A binding may realize another presentation's slots as its twin (`twins` in `addresses.json`, E7.2: the agent's final answer holds its turn's `actions` and `afterAnswer`; the chat page its title bar's actions, through the app's own `HeaderAction`), its slots only and never a claim, and may present nothing itself (E7.3: a sidebar row's hover actions, a project group's header actions); a user's action on a twin's entry is its presentation's; a slot is applied once even when the props it gave come back through it (entries keyed by mod, rule and item).
- **Presentation instances** (docs/design/systems.md S10, E2c): what is on screen as graph instances (`sdk/graph/presentations.mjs`, in the base graph). The kernel records each bound component's committed mount (passive effects); the page's registry (`present/instances.mjs`) reports each one whose binding names a presentation type and a subject, with the place its binding states (`in`, `via`, `slot`), whether a rule hides it, the rules that decorate it and `selected`, under a generation per page load, in batches at most every 250 ms within limits, and the user's actions on them as events of their own. The windows provider (`framework/host/graph/providers/windows/`, `codexmods.windows`) keeps them under their Window, resolves their parents from the subjects' links (never React ancestry), serves every instance's `presentations` relation, and acts by each operation's route (its `ROUTES`, systems.md "E7 in detail" decision 3): what acts on the window or the app's chrome through framework-main's `windows` area (the messages the app's main sends its pages, the app's own actions run in that window's AppView, Electron's close); what changes only what the window shows in the page of the presentation's generation (an `act` message: the page runs its binding's `operations` over the mount's committed props, the app's own callbacks, after checking the mount still presents what its number was reported as, and answers once; unanswered in 5 s it failed; past its expiry the page refuses it); anything more as the subject's own operation, invoked as the caller (`Composer.insert` is `Draft.insert`, `Chip.open` its File's `open`, `PaletteResult.choose` its Command's `run` and then the palette closes), a subject the graph has not read being observed for it first. `ctx.ui._read` and `_act` are the graph's list and invoke. **The framework's own presentations** (E6.5, `present/reports.mjs`) go through the same registry: its components put records while they are shown (`ctx.report`, a `Report` component that renders nothing) with framework-only bindings outside addresses.json, so no kernel arms them, no rule targets them and the runtime reports them with no rule's facts: the overview and a mod's page (SettingsPage of CodexMods or the Mod, the window's main view), their rows (SettingsRow of a Mod, an Operation or the CopyUpdate by `codexMods` or `mod`; of a Setting with its page named outright, `place.on`), each Dialog (its purpose its slot), each band line (NotificationBanner) and each composer picker (ComposerPicker on the thread's Draft). The windows provider puts them as its `FRAMEWORK_TYPES` (also DetailView, which waits for its route), kept out of `realizes.types` so the feature log does not list them; their subjects are the framework's, so the policy lets a mod only read them.
- **Settings pages** (`framework/renderer/present/settings-pages.mjs`, docs/design/framework-ui.md F2 to F4, docs/design/systems.md E0, E3, E6.2): routes under the app's `/settings` route (the Mods list `codexmods`, `~update`, `~developer`, `~detail`, a mod's page `<id>` with `<id>/permissions`, `<id>/activity`, its own pages `<id>/~<page>`, and `codexmods/*` for a mod that is not there), and a Mods group after the settings navigation's first group with `Update` while one is offered, including a framework-only one, `Mods` with its issue or mod count, and `Developer`. Each page is drawn with the app's settings frame (its `action`, `backSlot`, `scrollResetKey`), sections, card and rows and the kit (`present/kit/`), from the framework's graph. The **Mods list** (`present/mods-overview.mjs`) groups your mods in Updates, On, Issues and Off by `Mod.state`, the Host's one projection of the facts beside it (the framework provider's `modStateOf`: first of reloading, waiting for you, package unreadable, blocked, stopped, off, on; a quarantined mod is not always stopped), with a search over name, author and description and the Layouts section under it. A row opens its page and holds its switch (`Mod.enable`/`disable`, disabled in safe mode and for what cannot load; a stopped mod's stays on, and turning it off leaves it off with what stopped it in its record), `Review…` (a mod waiting for consent opens its page with the Dialog), `New` until its page is first opened or the Host next starts, and a menu: Settings, Permissions, Activity, Reload (`Mod.reload`, management `mods.reload`: a stop and start as one operation that clears a quarantine and keeps every choice, which a toggle or another operation on the mod waits for; one that cannot start again is left stopped, saying why), update from a file or folder, Check for updates, Move up and Move down (`CodexMods.setModOrder`, management `mods.order`: every installed mod once, else Conflict; written once as each record's `order`, `installSeq` staying the install ordinal; a new mod goes last; the rules are ranked again at once, the mux and activation follow at the next launch; a mod moves past the next one in its section, so a move always shows), Uninstall. `Install mod…` opens a Dialog that installs from a file or a folder through the app's file chooser (`pickFile`, with `directory` for a folder) and `CodexMods.install`. The **Update page** (`present/mods-update-page.mjs`, `present/mods-update.mjs`) shows the copy's update: its state, Prepare, and its review in a Dialog (the build, framework and mods it changes, its risks with their Features, a Switch per mod whose update asks more permissions, without which it stays at its version, the chats working now that the switch stops, Apply or Apply anyway naming the mods left behind, Later; it names the plan it showed); with none offered it says Codex is up to date, or that the check could not complete. The **Developer page** (`present/mods-developer.mjs`) holds a folder install, safe mode and last-known-good (each asked first in a Dialog, since both restart Codex, and never held by a running operation), the framework's version, Check now with when it last looked and why a look could not complete, the update policy, and Recent activity: the operations of no installed mod, running, needing attention with Acknowledge, failed or reverted. Every action is an invoke through the graph as the framework (`present/acting.mjs`), its refusal said where it was asked. A **mod's page** (`present/mod-page.mjs`) has a title block with its name, description, status and version, its switch and menu; one banner, what most needs you first (its package unreadable, stopped, blocked, waiting for consent); and tabs. A tab is a route, and the page carries focus and scroll across it, since the app's layout draws a route afresh. **Settings** shows while it declares any or anything is stored for it: its settings, then what is stored for projects and chats (`Mod.storedOverrides`: every value stored at a project or a thread, as stored, with `seen` and `valid`; cleared one at a time or all after asking by `Mod.clearOverrides`, management `mods.configure` clear patches, which never judge what they remove; E6.6b). A mod's own `ui.settings.page` in the Mods group is a tab, after Settings, in its rule's boundary; on one of the app's groups it keeps its entry there and its own framed route, which stays, saying the mod is not running, while the mod is installed. **Permissions** is what it may do (the highest risk first), what it may do without asking, its policies, what it gives the agent. **Activity** is its faults, its operations with Acknowledge, and its rules that lost to another mod's (a claim another's holds where both render in the window, a style variable another's holds: kept by the page runtime while both rules are, E6.5b). **About** closes every tab: what it says of itself and its images, its author, version, publisher, when it was installed, compatibility and reasons, a `Needs` row whose menu opens each Feature's DetailView, its kept versions (roll back with or without its data), its data (size, kept generations to reattach), and Uninstall, keeping its data unless you say (`present/mods-common.mjs`, shared with the list, which also holds the safe-mode banner above every page). Consent and every action that cannot be undone are **Dialogs** (`present/dialogs.mjs`): the app's `Dialog` and `DialogParts` (a Radix dialog: modal, focus kept inside, Escape), named for its content and giving focus back to what opened it, or a fallback that does the same with the app's theme classes; consent names the request it showed (`Mod.consent(request, approve, enable?)`), so a changed or answered request is not sent. Its settings (`present/setting-rows.mjs`, `present/setting-controls.mjs`, framework-ui.md F7) are a card per section and group, with what the group says of itself and Reset all (`SettingsSection.resetAll`: every value stored at the app scope in it, hidden rows included, never a project's or a chat's), and a row per active app-scope Setting: its control (a Switch; a choice as a select, segments or thumbnails; a number as a stepper or a slider; a line or an area of text; a shortcut recorder; a color; a time and a time range; a list of strings as reorderable rows; a structured list or a record as JSON), committed on Enter or blur and never per keystroke, its refusal under it, a changed dot while its value differs from its default, Reset while a value is stored at that scope (a project's value equal to the default can still shadow the app's), and for a project-scope setting a project menu that edits that project's instance. A stopped mod's stay editable, since a setting can be what stopped it; they wait only while an operation on the mod runs. `Setting.active` is the Host's answer at each instance's scope to what `requires` asks; every surface reads it, and it never changes a value.
- **The banner band** (`framework/renderer/present/band.mjs`, docs/design/systems.md E6 decision 4, E6.4): in every window, mounted by the page runtime at the `workspace` anchor (the top of the window's content, below the title bar and the app's dialogs), ONE line for what needs you (docs/design/framework-ui.md F15): an operation needing attention, a mod turned off after faults that you have not looked at since (its page opened is looked at, `Mod.stopSeen`), safe mode, an update held. One source says itself, with Open and, where the state allows, Dismiss (acknowledging the operation; Later for the update); several say how many of each, with Open to the most severe's place (the Mods list when they are all stopped mods). Nothing shows when all is well; a ready update is on the Update page, whose nav row says so. A mod stopping also toasts in the window in front (F16), never the only record (the app's toasts show only where a toast viewport is registered: in Settings they wait until a chat is shown). A mod's switch, turned, says so on its page with Undo, which is refused while an operation on that mod runs. It reads the graph as the framework does. Open goes by the framework's own navigation: the preload's `navigate` asks framework-main (`codexmods:navigate`, only the framework's Settings paths) to post the app's `navigate-to-route` to that window, so no mod's interceptor is on it; when that window's Mods pages cannot run (failed, or their routes or first read never came) it opens Settings › General, where the recovery entry is. An operation's line opens its mod's Activity, or Developer's Recent activity when no installed mod holds it; the update's opens the Update page with its review.
- **The DetailView** (`framework/renderer/present/detail-view.mjs`, docs/design/systems.md S11, E6.6c): one generic framework page (`/settings/codexmods/~detail`) that shows any graph instance: its summary as the title, its state, its relations as links to their own details, and the operations of its type that take no arguments, each asked first in a Dialog (those that take some are listed, not offered). A framework-owned instance with a page of its own (a Mod, its settings, CodexMods, an Operation, the CopyUpdate) links there instead. It is reached from a mod's page (what it needs: its Features), from another DetailView, and from `Window.open(ref)`: the windows provider asks that window's page (runtime `showDetail`, a `detail` message on its renderer channel) to open the framework's own page or the DetailView, and refuses when the page cannot.
- **Composer pickers** (`present/composer-pickers.mjs`, `present/bindings/composer.mjs`; E3): the composer binding sits on a chat's main composer controls (through ComposerScope) and adds after the app's own pickers one per thread-scope setting of an enabled mod (choices and toggles), in the mods' order then their own, three at most, drawn with the app's composer dropdown (`ComposerDropdown`; the Menu and Button where a build lacks it); choosing is `Setting.set` on the thread's instance, and a thread's own value goes back to the inherited one from the same menu.
- **Mod surfaces** (docs/design/mod-surfaces.md, docs/design/systems.md E8): typed, plug-and-play APIs for the surfaces a mod most
  likely wants, each sugar over one rule of the registry above (its grant, order, claims, lifetime and accounting), in both realms where
  the surface allows. A host-realm rule may carry functions (`{$fn}` markers the Host calls back in the mod's worker, with budgets), and
  every callback gets one `env` (its subject, window, thread, draft and how it was triggered; the instance it ran on as `_presentation`). Panel views (`ui.panel`) are
  tabs of a framework tab kind in every page's side and bottom panels, reopened where the app keeps no layout (a presence record);
  palette sources (with drill-in pages on the app's own page stack) and mod commands are rows of the app's own palette, and each mod
  command is a graph Command (provider `codexmods.commands`); message content takes part renderers through a markdown seam (code, inline
  code, links, directives) at every markdown site; the menu bar takes entries with chords from one keymap, and the app's own entries
  are MenuEntry presentations a mod may choose (never the application menu or a protected command); context menus (threads, projects,
  files in trees and references, panel tabs, scheduled tasks) take entries through the app's own menu builders (seams), each mod's in a
  section of its own; every composer presents its Draft (a chat's, the new chat's, the panel's), written live through the app's composer
  controller, with slash commands (and their arguments), mention sources, inline suggestions (`ui.composer.suggest`: asked at a pause at the
  end of a line, drawn as ghost text over the editor in its own font and the theme's tertiary colour, taken with Tab through the composer's
  controller, left with Escape; `present/composer-suggestions.mjs`), and the new chat's target set through the app's own controls and read
  back from them (project, run location or a new worktree, starting branch, model, effort, plan mode, access); a composer's send names what
  it sends (`Draft.send({content})`, the editor's text at that moment), so the mods' interceptors judge the message itself; the chrome takes
  actions with the Codex app's own button (`CodexButton`): the title bar and the sidebar's top bar, an approval card's own button row, a
  project group's footer, an app settings row; the Window's banner is the app's page banner (one writer per page); the sidebar can be
  filtered (with a notice the user can clear); a mod's own pages sit in the app's Settings groups; ThreadView `find` is the app's find
  bar; SidePanel `resize` is its own drag. A generic component the app draws for every menu is bound per element (kernel `element`
  bindings), and a binding that reads other mounts renders again when they change. The graph creates what the user creates (chats,
  automations, projects, worktrees).
- **The window's layout** (`present/bindings/frame-regions.mjs`, `frame.mjs`, `panel.mjs`, `present/allocator.mjs`, `present/tab-kinds.mjs`; docs/design/layouts.md): one frame host per window wraps the app's column from the first render, so nothing remounts when an arrangement comes or goes. It draws a mod's regions at the workspace's edges (`ui.regions.add`), the bottom panel beside the chat (the panel's content lives in one container from its first render, moved between the app's slot below and the column) and the sidebar at the right where the app shows its rail, and it narrows the shell's widths for them; `Window.setRegion` asks for each. While one of these arrangements is active the app's narrow-window handler asks the allocator first (seam `responsive`): the app keeps other pages' columns live out of sight, so only the shown column's question shares the window out; it keeps the main view at least 480 px, gives up the regions, the panel beside, the side panel (the app's own close for size) and the sidebar in that order and gives them back in reverse with a margin, leaves what the user changes alone, and hands everything back with no arrangement left. A build without the seam keeps the app's thresholds. The Window's facts say what is drawn and what is held (`suspended`). Tab kinds, sidebar groups and footer parts are rules over the app's own lists.
- **Named layouts** (`present/layouts.mjs`, `present/layout-switches.mjs`, `present/layouts-section.mjs`; docs/design/layouts.md D5, D6, D11, §5.3): one claim per window, made of the app's own guarded setters. It applies to a chat once the app has restored that chat from its checkpoint and the chat is shown, keeping what was there to give back, and it is kept across chats. A scope node's `watch` tells each change's origin: the framework's own acts and the allocator's in a bracket, the app's resize handler and restore by their marks, the user's by evidence (the app's layout counter, or a trusted input, a command or a panel message just before), which releases that region; anything else is the app's own and is left alone. The Host keeps the claim across a reload. A presentation's `where` may name the window's mode or layout. A switch per layout, region and page, and the default layout, are the user's, in the Mods overview.
- **A mod's own pages and destinations** (`present/main-pages.mjs`, `present/destinations.mjs`; docs/design/layouts.md D7, §5.2): one route of the framework's, `/codexmods/page/:mod/:page`, is written into the app's route tree where it is built (seam `page-route`), since a path with no route blanks the window. Its element draws the page host: the app's own page header, inline, over the mod's component in its rule's boundary, or, for a page that is not there, a notice with the mod's name. While a page is shown the address holds it in `initialRoute`, so a reload comes back. A mod's destinations join the app's list in its provider, before the split into pinned and more (seam `destinations`), so the rail, the header links and the user's pins and order all see them. A destination's sidebar view is drawn as the area ladder's children where the rail shows (seam `rail-mode` gives it the app's contextual column; the rail is never turned on) and in the conversations' place otherwise. Anchors resolve to the element shown, since the app keeps other pages' columns mounted out of sight.
- **Layers** (docs/design/graph-layers.md): mods **address data and declare UI**. The types of 02 are addressable; the presentation types
  are components a mod declares into (`ui.*`); their live instances, with their operations (`_select`, `_insert`, ...) and state, are the
  mechanism layer (`ui._read`, `ui._act`): there, not promised. The Window is the one addressable presentation. Members that are UI state
  on data are `_` too (`Step._expand`, `Folder._expanded`, `Model._select`). Coverage counts members by investment tier
  (`docs/coverage/tiers.json`: supported, verified natively; as built; mechanism, not counted).
- **Mods' chats** (§6.8) are not the app's: they are drawn by the shared surfaces and the views their subtypes register, never served to the app as app-server objects.

---

## 10. State and data

### 10.1 Layout (one root, mode 0700; per-profile state under `profiles/`)

The default root is `~/Library/Application Support/CodexMods`. Every path comes from `contracts/layout.mjs`.

```
CodexMods/
  framework/<version>/          immutable framework code; current, previous and lkg are text files naming a version
  adapters/<appBuild>/          adapter packs (the builder's input; each copy embeds the one it was built with)
  apps/<build>-<inputsHash>/    candidate copies (the current copy lives at the stable launch path, a symlink into here)
  store/<modId>/<version>/      immutable extracted packages (content-hashed)
  profiles/<name>/
    profile.json                signing identity, launch path and args, guard settings (§5.2)
    userData/  codex-home/      app state (the framework never edits credentials inside)
    state.json                  desired state: enabled mods and versions, grants, pinned publishers
    ops/<opId>.json             operations journal (§11)
    generations/<n>.json, lkg   boot records
    lkg-app                     this profile's last-known-good copy
    data/<modId>/               store, settings.json (the app scope), settings.scopes.json (projects' and threads' values), files/
    retained/<modId>/           storage.retained; never restored, deleted only explicitly
    snapshots/<modId>/<from>/   clone snapshots taken before migrations (last 2 kept)
    orphaned/<modId>/<time>/    data of removed mods kept for reinstall (§11.6)
    backends/<modId>/<key>/     CODEX_HOME of named backends
    computer-use/               the copy's own Computer Use helper and its config.json (§5.3)
    flags/                      safe, disabled, graph, boot.json, startup-dialog.json
    graph/intents.jsonl         the graph runtime's intent journal (§6.8)
    logs/                       host.log, <modId>.log, guard.log, lkg-reopen.log
    run/                        sockets (app, mgmt, clients, proc), relaunch-intent.json
```

### 10.2 Writes

`state.json` and every journal record are written to a temporary file, fsynced, then renamed. The KV store commits atomically. Nothing is written in place.

### 10.3 Data ownership

- A mod's **data** is its store, settings and files. It carries `data.schemaVersion`, and a version of the mod runs only on data at its own schema version.
- **Retained** storage holds records that must survive a data restore, such as intents for external effects, sync cursors and audit trails. A retained store's format can never change in place: a new format needs a new store name.
- **Secrets** live only in the Keychain and are never part of snapshots.
---

## 11. Lifecycle operations

### 11.1 The operations journal

Every mutation (install, enable, disable, configure, update, rollback, remove, framework update, app switch) is an **operation** with an id, a type, a target and its inputs, a phase list journaled before each phase runs, and an outcome:

- `succeeded`;
- `failed` (nothing applied);
- `reverted` (applied, then automatically undone locally);
- `needs-attention` (local state is consistent, but new code may have caused external effects).

Each mod has at most one operation in flight; operations on different mods run concurrently. On Host start, unfinished operations are recovered deterministically from their last journaled phase, and recovery never re-runs mod code that may have had external effects.

### 11.2 Install

1. Verify the archive: size limits, no path escapes, content hash, publisher signature.
2. Extract into `store/` and compute compatibility against the current adapter report.
3. Show consent: permissions grouped by risk, compatibility, publisher fingerprint (§13).
4. On approval, record the mod as installed and disabled, or enabled if the user chose *Install and enable*.

If orphaned data exists from the same publisher, the user can reattach it (the newest generation by default, or a chosen one). A migration runs if its schema is older.

**From GitHub** (`framework/host/github.mjs`, `framework/host/mod-updates.mjs`, docs/design/framework-ui.md F10). `mods.installFromGitHub {repo}` looks up the repository's latest release and its one `.codexmod` asset, downloads it and installs it as a file is: the same ZIP checks, signature, immutable store and publisher check, with nothing read from it before they run and no mod code before consent. Every request is HTTPS, bounded in size (64 MiB) and time (60 s), and follows a redirect only to GitHub's own hosts; a repository with no release, a release with no such asset or with two, and a failed lookup (no network, the rate limit) each say so and never fall through. The record keeps `source`: `{kind: 'github', repo, repoId, tag, digest}`, `{kind: 'folder', path}` or `{kind: 'file'}`. **The signature is the identity and the repository only where to look**: an update must carry the same publisher key, as before, and one whose repository was renamed, moved or replaced (another `repoId`) raises it in the update's consent. A mod from GitHub is checked again with `updates.check` and every six hours, one check at a time: a newer signed release is downloaded, checked as a package and offered (`Mod.release`, with what it adds and whether it runs here); `mods.applyUpdate` applies it through the update operation, which verifies exactly the bytes that were checked (their sha256), moves only forward, and refuses one that cannot run on this build. A signed file installed over it makes it a mod from a file, no longer checked. Developer mode (`framework.developerMode`, a stored flag) is what lets the page load a folder.

### 11.3 Configure

`mods.configure` takes the whole app document (v1's form, the CLI's `--settings` and `--file`) or patches (`{key, scope, value}` or `{key, scope, unset: true}`, `scope` `app` or a project's or a thread's ref; the CLI's `--set`, the page, the composer and `ctx.settings.set`), applied together under the mod's lock: every changed value validated (v1: the whole document against the whole schema; v2: the declaration), both files written atomically, then delivered to every realm through `settings.onChange` with the change's key, scope and value. A patch that changes nothing is no operation. Patches wait their turn behind the mod's running operation (in order, 16 per mod, 10 s, then Conflict), except while a framework operation runs or when the mod asks during its own operation. Recovery compares what is stored at each key and scope. A stored value that no longer validates is ignored, reported by `mods.settings` and kept until the next write there. Invalid input never reaches the mod.

### 11.4 Update

1. **Stage** the new version in `store/` and verify it. A different publisher key is a *publisher change* and needs explicit consent.
2. **Consent diff.** Added permissions require approval; until it is given, the old version keeps running.
3. **Stop** the old version (§7.4).
4. **Snapshot** `data/<mod>/` with APFS clone into `snapshots/<mod>/<oldVersion>/`, only when the schema changes.
5. **Migrate** a staged copy in an isolated worker (limit 60 s). On success, the staged data replaces the live data by rename. On failure or timeout, the staging is discarded, the old version restarts on untouched data, and the outcome is `failed`.
6. **Activate** the new version and watch it for a **60-second health window**.
7. **Revert or commit.** If activation fails, or the mod faults fatally in the window, the framework restores the snapshot (when the schema changed and one was taken; otherwise the old version restarts on the current data, which shares its schema), restarts the old version and records `reverted` with the reason. Records in retained storage survive, and the user is told that external actions the new version took in that window are not undone. Otherwise the operation is `succeeded`; the old version stays in `store/` and the snapshot is kept for rollback.

A crash resumes from the journal: before activation gives the old version on old data, during the health window is treated as a fatal fault (`reverted`), and after commit gives the new version.

### 11.5 Rollback (user-initiated, to any version still in the store)

- **Code only:** allowed when the target uses the current data schema. Data is kept.
- **Code and data:** allowed when a snapshot from the target version exists. A mod's page says that data changed since then is lost, in the rollback's Dialog. Retained storage is kept.
- **Blocked** otherwise, with the reason stated.

### 11.6 Remove

- **Keep data:** moves data to `orphaned/<modId>/<ISO timestamp>/` as a new *generation* with an `.orphan.json` record (publisher, version, data schema, removal time), and keeps retained storage and secrets for reinstall.
- **Delete data:** first shows any needs-attention operations and the mod's retained effect records, then deletes data, retained storage, snapshots, secrets, named backends (including their `CODEX_HOME`) and all orphan generations.

A keep-data removal never overwrites or deletes an earlier generation. A generation is recognized only by its `.orphan.json` marker, never by the shape of a directory name.

Unreferenced packages in `store/` are garbage-collected once no generation in the last 3 references them. Collection belongs to Operations, runs under a store lock, and protects references from every profile.

---

## 12. Updates and recovery

### 12.1 Generations

A **generation** is the tuple of app build (modded copy), framework version, adapter pack version, `{mod@version, data schema}` and a settings hash. Each boot writes a boot marker. A generation becomes **last-known-good** (LKG) when, within 60 seconds:

- the window has rendered;
- the Host is ready;
- the primary app-server handshake has completed;
- no fatal or quarantine event has occurred.

The window counts only time with no blocking startup dialog open, so waiting for a person never counts as a failed start.

LKG certifies the *effective* configuration: the mods that actually activated after any recovery, and the bundle that is actually running (not whatever the launch symlink says). The LKG copy is recorded per profile (the generation's `appCandidate` and the profile's `lkg-app` file), so restoring one profile never selects another profile's copy.

### 12.2 Framework update

1. Install `framework/<new>/`.
2. Point `current` at it.
3. Relaunch the app with `app.relaunch()` followed by `app.exit()`.
4. If the health gate fails, the loader points `current` back at the previous version and relaunches.

Framework state formats migrate forward only, and a copy of the pre-migration state is kept. The modded copy is not rebuilt.

### 12.3 The copy's update (app build, framework, mods' updates)

The stock app updates itself, or the user updates it; the framework follows and never updates the stock app. One update of the copy
combines the new app build, a framework release and the mods' updates in it (docs/design/systems.md S19, S20, "E5 in detail").

1. **Noticing** (`framework/host/updates/detector.mjs`, in the Host, once a boot is healthy and not in safe mode): the stock app at the
   profile's `stockApp` (`/Applications/ChatGPT.app` by default) is stat'ed every minute; the release source (`updates/release.mjs`: git
   tags of the published remote by default, or a directory) is asked once a day and when the user checks. An offer is a stock build other
   than the copy's, or a newer framework release (a development framework is offered releases only when the user checks), with the
   packages of installed mods the release ships (same id and publisher). A source or a bundle that cannot be read is unknown, never an update.
2. **Staging in quarantine** (`updates/staging.mjs`, a background job a framework operation preempts): an APFS snapshot of the stock app;
   the release tree, accepted only when it is what its `release.json` says (its tree hash, its version, no symlink; integrity, not
   authenticity), and trusted code from then on, since staging runs its builder; the pack (the new tree's, the root's, or a refresh by the
   new tree's tool, run as its own process); the evidence and its evaluation with the new framework's feature log (§15); the candidate,
   built from the snapshot by the new framework's builder with the copy's build flags, reused only for the same inputs including the stock's
   content; each enabled mod's compatibility at the version it would run, a newer version that fixes it taken from the release's packages
   or from the mod's GitHub release from the repository it came from (copied beside the plan and checked by its digest; another repository
   goes through the mod's own update, which asks); then the **plan** (`<profile>/updates/<hash>/plan.json`,
   its hash over its inputs). A plan is **ready**, or **held** while an enabled mod is at risk or blocked on the candidate (each risk a
   sentence); a build that cannot be made (a missing mandatory edit) is a problem, not a plan. For the Update page (docs/design/framework-ui.md
   F11) the plan also keeps every installed mod's verdict on the build it runs and on the candidate, what it uses and what of that changed
   (`display`, not an input of the hash); staging says each step as it begins; `release.json` may say which builds it `supports`; and the
   status says the framework's support from explicit outcomes (checking, ships with the update, already, not yet, unknown), whether the
   automatic policy will apply it, and how this offer's last try ended. Later, while it prepares, stops the staging.
3. **Applying** is one operation, `copy-update {plan, anyway?, consent?}` (`ops/lifecycle.mjs`; management `updates.apply`, the graph's
   `CopyUpdate.install` and `installAnyway(plan)`, `codexmods update apply`): the plan's inputs read again; with `anyway`, the held mods
   left disabled (`leftBehind`, said on the Mod); each incoming mod verified against the target framework, by the sha256 staging recorded,
   with any requirement it does not hold as required asked again under the lock, and committed (stopped, its data
   snapshot taken, a migrated clone swapped in, its record set, not activated); the release tree installed and its pointers set; then the
   switch. It excludes mod operations until the switch, and everything before the switch is undone from its record on a failure or a crash.
   Every framework change switches to a candidate built by it, so the copy always runs what was judged.
4. **The switch**: a tiny detached swap helper waits for the app process to exit, replaces the stable launch **symlink** into `apps/`
   atomically, writes a receipt correlated with the operation id, and reopens the app with the profile's `launchArgs` (the only reopen owner).
5. **The verdict**, reconciled before the next boot records its generation (so a generation is always recorded from settled state): the
   helper's failure undoes the update (failed); the loader's revert after two unhealthy boots puts the mods' snapshots and records back
   (reverted; the left-behind mods stay off); the new generation healthy and last-known-good, with the plan's tuple, is succeeded. Pending
   its verdict, the update holds the framework lock and the mods it changed (update, rollback and remove refused); safe mode does not wait
   for it, and restoring last-known-good concludes it as reverted first.
6. **The policy** is `offer` (default) or `auto` (`CodexMods.setUpdatePolicy`): auto applies a ready plan at the next launch, before any mod
   activates, recorded by its offer before any effect, never for an offer that was reverted or dismissed (`later`), never a held one.

The swap helper is the only out-of-process restart code in the system. `updates.app.prepare` still builds a candidate for the CLI;
`updates.app.apply` applies only through a plan.

### 12.4 Recovery ladder

Each rung works even if the rungs above it are broken.

1. **Mod quarantine.** Triggered by 3 faults in 10 minutes, a missed heartbeat, a crash attributed to the mod, or a revert. The mod is disabled until the user re-enables it.
2. **Host restart.** framework-main restarts a crashed Host once per session. Crashes are counted in `boot.json` across relaunches: two within 10 minutes quarantine every mod named in the crash breadcrumbs, and a third makes the next boot safe mode.
3. **Safe mode.** The framework and its pages run, but no third-party mod is enabled. It is entered by two unhealthy boots of a generation, by the recovery entry or the Developer page, or by `codexmods recovery safe on`. An explicit `safe off` ("try normally") ends the unhealthy streak. At a start in safe mode the framework chose (unhealthy boots, Host crashes, no pack), framework-main asks in a message box (Continue, Restore last-known-good, Disable framework); in safe mode you chose it does not, since the Mods band and pages say it (E6.4), and the message box would hold the app's start until answered.
4. **LKG generation.** Restore the LKG framework version, mod records and settings, and, if the app build changed, the LKG copy. A mod whose current data schema no longer matches its LKG version is left disabled with the reason stated, because data is never silently rolled back.
   - On the automatic path (two unhealthy boots), the loader repoints `framework/current` and the launch symlink at LKG, then compares the *running bundle* with the certified LKG candidate, whatever the symlink state. When they differ, it reopens exactly that candidate with `open -n <lkg> --args <the profile's launchArgs and this instance's switches>` rather than an untargeted `app.relaunch()`, and treats the reopen as done only after `open` exits 0 (`logs/lkg-reopen.log`). If the reopen fails, it falls to safe mode in the current bundle and never loops. The safe flag is written only when the loader stays in that bundle.
5. **Framework disabled.** The loader passes straight through to app main and starts no Host. The relay sees the flag and execs the real app-server directly (§6.1). It is set by the `flags/disabled` file, which the CLI can write without launching the app (`codexmods recovery disable`).
6. **Stock app.** It is always untouched and always available, with its own profile.

The loader evaluates rungs 3–5 from `flags/` and boot markers before loading any framework code. The concurrency guard (§5.4) runs before all of them, and a guard exit is not a boot attempt.

### 12.5 Restart, quit and process cleanup

- **Relaunch** is always `app.relaunch()` plus `app.exit()`. The Host is a child of main and exits with it. A framework-initiated relaunch leaves a one-shot token so the guard can inherit the user's earlier decision (§5.4).
- **Quit.** The app owns the quit decision: its own confirmation runs in its `before-quit` chain, so framework-main never pre-empts it (no `before-quit` handler, no `preventDefault`, no second `app.quit()`). Quitting is certain only at `will-quit`, which follows an unprevented `before-quit` and the closing of all windows. There the Host gets a graceful shutdown with a 10 s bound, then `app.exit(0)`, which skips every quit event. A cancelled confirmation leaves the Host and backends untouched.
- **Mod processes** run in the Host's process group and are signalled when the Host stops.
- **Leftovers.** At next boot, a process still carrying a previous boot's environment nonce is reported as a leftover and signalled after its identity is verified. It never blocks a boot.
- **Daemons.** A mod process that deliberately escapes its group is out of contract, and the compatibility report names it.

### 12.6 Backend failure

- If a session's primary app-server exits, every in-flight request resolves (`OutcomeUnknown` where transmitted). The mux restarts the backend, replays the handshake, and publishes `appServer/exited` then `ready`.
- If the Host dies, the relay exits. The app does not respawn a dead backend, so framework-main restarts the Host (rung 2) and relaunches the app.

---

## 13. Trust, consent and honest limits

- **Publishers.** A package is signed with its publisher's ed25519 key. The first install pins that key (trust on first use). Updates must match the pinned key, or the user must explicitly accept a publisher change. Developer mode loads unsigned packages from a folder, labels them *Development*, and never auto-updates them.
- **Consent screen.** It shows what the mod can do, grouped by risk in plain language, its compatibility, and a consent diff on every update. Risky permissions are flagged: intercepting `*`, `onError: 'reject'` interceptors, backends, secrets, processes and external clients.
- **Enforcement where it is real.** The mux refuses traffic outside a mod's granted methods. The Host refuses undeclared processes, other mods' secrets, and backends or leases the mod has not been granted.
- **Optional permissions.** A mod's optional permissions are the user's to allow, ask every time, or not allow (§8.3); the question for one is drawn in the page, so it is consent, not a boundary, like the rest of this section.
- **Where a mod came from.** A GitHub repository is where to look for a mod, never who it is: its publisher's key is. A renamed, moved or replaced repository is said in the update's consent; a new owner holding the same key cannot be told apart, as with any key that changes hands (§11.2).
- **Stated plainly.** Mod code is trusted code that runs with the user's authority. Renderer code shares the app's page, and a mod process could open its own network connections. Consent is informed trust, not a sandbox. The rule that all app access goes through framework seams is enforced by API shape and by refusing known bypass paths, not by isolation.
- **Privacy.** Default logs and diagnostics hold metadata only. Payload capture is a per-mod opt-in with bounded retention.

---

## 14. Management API and tooling

- **One method table** lives in the Host (`contracts/management.d.ts`), and every method has a schema:
  - reads: `mods.list / inspect`, `ops.get / list`, `compat.report`, `updates.status`, `diagnostics`;
  - mutations: `mods.install / consent / enable / disable / clearQuarantine / configure / update / rollback / remove / reattach`, `updates.framework`, `updates.app.prepare / apply`, `recovery.safeMode`, `recovery.lkg`;
  - `events.subscribe`.
- **Transports.**
  - The recovery entry uses a MessagePort through framework-main.
  - The CLI and external tools use a Unix socket in `run/` with a 0600 token.

  Both carry the same messages. No transport filters page code or scrubs payloads with regular expressions: schemas define what crosses.
- **Asynchronous mutations.** A mutation returns `{opId}` as soon as it is journaled. Clients subscribe to `ops` for progress. A disconnected client re-queries by id, so a slow operation is never misreported as unknown.
- **CLI.** `codexmods` provides:
  - `setup [--daily] [--identity <name>] [--profile] [--root] [--app-path] [--stock]`: installs the framework, writes the profile, builds the first copy and creates the stable launch symlink, in one command on any new Mac. It is idempotent, preserves unknown `profile.json` fields (including `guardTrusted`), and reports which input triggered a rebuild;
  - `app status | prepare | apply [--candidate <path>]`;
  - `framework install <dir> | rollback`;
  - `mods …` and `ops get | list | wait`;
  - `recovery safe on|off | disable | enable | lkg | guard list | untrust <n>`;
  - `new`, `dev <dir>` (hot reload on file change), `keygen`, `pack --key`.

  Mutations that are operations need a running Host. Without one, `setup`, `framework` and the `recovery` commands work offline: they edit `flags/`, `profile.json`, the framework tree and the launch symlink.
- **Author loop.** Scaffold with `new`, iterate with `dev` against the running app, unit-test with the SDK's fake context and recorded traffic, `pack`, then install from file.

---

## 15. Compatibility and adapter packs

An adapter pack is per app build. It is data plus small locator functions:

| Part | Content |
|---|---|
| Backend attachment | Override or binary-replacement method; app-server path |
| Protocol catalog | Known methods and notifications with observed shapes, handshake methods, affinity key paths, the build where each was last seen |
| Seam transforms | Exact-input, hash-pinned edits, each exposing one generic seam: loader insertion, component export exposure, settings section registration, trusted view sender. The isolation edits of §5.3 are transforms too. The UI seams of docs/design/presentations.md (V1, V2) are derived by structure for every build (`adapters/tools/seams.mjs`): the JSX runtime, the lazy loader, the three command tables, the AppHost hold in main, and one exposure block per renderer chunk for the app's own objects. Their hooks are inert members of `globalThis.__codexmods` (`jsx`, `lazy`, `taps`, `appHost`, `exports`, `faults`), declared in the pack's `seams.hooks` with an `abi`. |
| Binary patches | Hash-guarded exact-byte edits to Mach-O files outside the asar (Keychain names, Computer Use identity) |
| Mandatory edits | The ids that must be present and applied (§5.3) |
| Backend overrides | Per-process config for the primary backend (§6.7) |
| Anchors | Locators for each named anchor, with fallbacks |
| Components | Locator for each exposed component |
| Theme | Token names mapped to CSS variables |
| Probes | Checks the builder and runtime run to confirm each item |

- **The feature log** (`framework/host/features/log.json`, docs/design/systems.md S16 to S18, "E4 in detail") ships with the framework:
  the features a mod can name (`graph:<Type>` and `graph:<Type>.<op>` for every type and operation a framework provider realizes, a
  concept realized by its subtypes, the windows provider's types and operations needing their presentation; `presentation:<Type>` and
  `slot:<Type>.<slot>` for what the bindings realize; `sdk:<entry>` for the
  SDK's entries), the mechanics of the app they need (`protocol:`, `service:`, `message:`, `command:`, `route:`, `state:`, `seam:`,
  `exposure:`, `binding:`, `anchor:`, `action:`), and the edges. `scripts/features.mjs` generates it from the providers' `realizes`, the
  bindings' addresses and a scan of each unit of code (method literals at call sites, framework-main's area-kit calls), joined with the
  units' declarations (`features/units.mjs`, `features/declarations.mjs`: which operation needs which mechanic, what is only preferred,
  alternatives, dynamic sites); a test keeps it current, and the Host notes any method its own providers request that the log lacks. A
  grant naming an operation on a subtype (`graph.act:CodexThread.send`) is judged by the feature of the type that declares it
  (`graph:Thread.send`); a test keeps every maintained mod compatible on the current reference build.
- **A build's status** (`features/status.mjs`, `features/evidence.mjs`): each mechanic judged by its kind from the build's evidence (its
  pack, and beside it its census `build-facts.json` and its refresh report; for the running copy what its windows saw, each binding works,
  tripped or unseen): **present** when seen (a protocol method's fingerprint, its params and result, one a reference build had),
  **changed** when its fingerprint is new or a binding's canary tripped, **missing** only by a complete enumeration (a census family with
  nothing unresolved; the pack for anchors), **unknown** otherwise (no census, a partial family, a carried-over catalog, a
  locator miss, not seen yet). A feature is the worst of what it needs. The census adds per-method fingerprints and the static binding
  census (`bindings.sites`). `codexmods features` and `features.list` show it; the framework's provider puts a `Feature` per entry.
- **Compatibility** is what a mod needs against that status, one evaluator for the running copy and a prepared candidate (`ops/compat.mjs`):
  its `requires` and `optional` (`features`: ids or `{id, version}`, an epoch the log must accept; methods read
  as mechanics, components as SDK features) and, as optional hints, its typed graph grants.
  - *Compatible*: everything it needs is present.
  - *Degraded*: something optional is missing, changed or unknown.
  - *At risk*: something required changed or could not be checked; shown, and (step E5) it holds an update.
  - *Blocked*: something required is missing; the mod is not enabled, and an enabled one is quarantined at start.
  Each reason is one sentence naming the feature and the change ("It needs the Repository.push operation, which this build of the app
  lacks: the app's gitRepository service"). A prepared candidate is judged with the log of the framework it will run, and its result names
  what differs from the running build and the census diff.
- **Version strings play no part.** A mod that only uses methods present on a new build keeps working without a release. Version independence is best-effort, not a guarantee.
- **Refreshing a pack** for a new build is a bounded task: `builder/refresh-adapter.mjs` derives the new pack from the previous one and writes a report of everything it could not carry over.
  - The protocol catalog is regenerated from the new binary's own `app-server generate-json-schema`.
  - The mandatory asar edits (ids `cua-*` and `managed-config-*`) are **derived** from the new asar, never replayed: `adapters/tools/` locates every site by string anchors and structure (a minified name or a chunk name is never an anchor), emits the finds and texts of the new build, and fails closed when an anchor is absent, duplicated or changed. Their ids and files are by role (`cua-bundle-id:main:1`), because chunk names carry a content hash that changes every build: the main bundle is the one main-process bundle that contains the anchors (`.vite/build/main-*.js` up to 21477; 22943 splits its main process into `early-bootstrap-<n>-<hash>.js` chunks), another main-process chunk is `src`, a worker is `worker`. Builds also differ in spelling (template or quoted strings, named or inlined constants, `X.default.join` / `X().join` / `(0,X.join)`): the derivers accept either and write each edit in the build's own, and count names by binding (`adapters/tools/js-shape.mjs`, an acorn-based structural locator) or within their webpack module. The helper bundle-id sites are required as a family: a build may have more or fewer of them, but at least one, and the deriver's dry run proves no stock id is left in any `.vite/build` file.
  - Every other transform's `find` is re-checked against the file of the same role in the new asar (exactly one occurrence) and surviving transforms get new hashes. A miss is dropped and listed, and the pack ships degraded rather than blocked: a seam that works only whole (the trusted sender) is dropped whole, and the component, React and host-seam declarations that depended on dropped transforms are dropped with them. A generated pack (`generate-adapter.mjs`) restores what a refresh could not carry over. The UI seams are not replayed: the refresh and the generator derive them again as atomic groups (all of a group or none), and the pack declares only what applied. `reseam-adapter.mjs` re-derives the UI seams of an existing pack from an extraction of the same build when the app bundle itself is gone.
  - Anchor selectors are checked statically against the new bundle; the runtime probe confirms them (an anchor not seen yet is unknown, never missing).
  - Binary patches are re-derived for the new binaries and never carried forward.
  - Every mandatory edit must survive. If one cannot be re-derived, no pack is written and the refresh fails.

---

## 16. Performance and linear overhead

| Cost | Scales with |
|---|---|
| Fixed | Loader; framework-main; one Host process; relay; mux; boot replay buffer (≤ 4 MB) |
| Per mod | One worker thread (if it has host code); its registrations, storage and renderer modules; its declared processes (zero when idle) |
| Per message | One parse, a method-indexed lookup, and only the matching interceptors and observers |
| Per backend | One app-server process, only for backends in use |
| Disk | Content-addressed store; snapshots are clones; at most 2 snapshots per mod and 3 generations |

**Gates**, measured in the real app at 0, 1, 4 and 10 mods on startup traffic: enabling mods adds zero processes unless a mod declares one; a non-matching interceptor is invoked zero times; a full observer queue produces a gap, never growth; per-mod RSS increments stay roughly linear; added mux latency is reported as p50 and p95.

---

## 17. The maintained mods on this architecture

| Mod | Built from |
|---|---|
| account-switcher (Account switcher, goal 26) | `CodexAgent.accounts` and each `ChatGPTAccount`'s `CodexUsage`; `Thread.account` and `CodexThread`'s `compacted` event; `Thread.moveToAccount` between turns as its automatic action (`switch`); `CodexAgent.setStartAccount` for new chats; `CodexAgent.addAccount`, `Account.signIn`, `signOut` and `remove` from its `ui.settings.page` as the user; a `ui.contextMenu` entry per account on a chat |
| better-questions (Better questions, goal 22) | its tool and instructions on each new chat (interceptors of `CodexAgent._startThread` and `Tool._call`); a `ui.panel` drawn with `QuestionCard` (its own questions and `CodexQuestion`s answered as the user), opened by itself (`panels.open`, a popup window or beside the chat); `storage`; `secrets` (the Sendblue key); an automatic action (`Thread.send`) for the iMessage reply |
| claude-code (Claude Code, goal 23) | its own Agent and Thread subtypes (`ctx.graph.provide`), drawn by its `ui.replace('ThreadView', {for})` from the lent parts; a session process with `instances` (`claude#<chat>`, a program on the Mac by `processes.exec:claude`) spoken to in stream-json; `graph.read:Draft,Project` for the new chat's folder; `storage` |
| live-usage (Live usage, goal 21) | the graph's facts (`CodexThread.tokenUsageReported`, CodexUsage's snapshots); a `CodexThread.send` interceptor for the reserve; `status` adds in the composer and title bar; the `scheduler` for the resume; automatic actions (`pause`, `resume`); `storage`; `ui.settings.page`; `clients.issue` for the menu bar app |
| multi-panel (Split view, goal 19) | `ui.regions.add` with `ui.host.thread` panes and `DropTarget`s; its arrangement in `storage` (`watch` across windows); `ui.commands.add` (keys, the palette, a chat's menu); `Window.setRegion`, `focusPane`, `open(thread, {placement: 'side'})`; `Thread.open`; `settings` |
| project-orchestrator (Project orchestrator, goal 25) | a project menu entry (`ui.contextMenu.add`) calling `Project.newThread({prompt, send, open})`; the role as its attached data on the chat (`graph.attach`), a `ui.decorate('Thread')` badge on it; a `CodexAgent._startThread` interceptor for its instructions and tools, for that start only; a `CodexThread.send` interceptor for each turn's context (the project's chats and what changed); a `Tool._call` interceptor answering only orchestrators; its grill-me skill among the skill roots (`CodexAgent._setSkillRoots`); an automatic action (`Thread.send`) to tell it when a chat finishes |
| smart-composer (Smart composer, goal 24) | `ui.composer.suggest` asking `ctx.intelligence` from the renderer realm; a `Draft.send` interceptor stopping a chat's message for its questions, shown by a composer control above the input with the question card, the answered text sent with `Draft.setContent` and `Draft.send` as the user; a `CodexThread.send` interceptor setting the send's effort as its automatic action (`ctx.graph.assess` first, so it never asks) |
| thread-settings (Chat settings, goal 18) | `ui.panel`, a ThreadHeader action and a command; a chat's `settings` drawn with `SettingRow` (another mod's set as the user); skills' parameters as contributed Settings defined by their Skill (`provide` with `contributes`, `onObserve`); a `CodexThread.send` interceptor adding the chat's skill choices to the turn's context |
| ui-tweaks (UI tweaks, goal 20) | `ui.style` setting the app's own variables to others; `graph.defaults` (steps and turns open); `ui.parts` and `ui.hide` for the parts the user picks; `settings` |

None of these needs a namespace beyond §8.1, and none needs feature code in the core. App-update preparation, compatibility and LKG are framework functions on the Mods pages; an update-policy mod would use the `framework.updates` service. The sibling menu bar service connects through the lease protocol (§8.6). The release's reference mods are GOAL.md goals 18–26, built as maintained mods (docs/design/reference-mods.md).

---

## 18. Acceptance against GOAL.md

All acceptance runs happen in the real modded app, in the disposable QA user, with a signed-in QA profile.

| Goal | Native acceptance |
|---|---|
| 1. Lifecycle | From the Mods pages, on one mod: install → inspect → deny → approve → enable → configure → disable → re-enable → compatible update → changed-permission update → rollback → remove (keep data) → reinstall → remove (delete data). |
| 2. Update and recovery | Mod update with migration, then rollback with data restore. A failing migration reverts automatically. A fault inside the health window reverts. A kill in the middle of an update recovers to exactly one coherent version. Framework update with automatic revert on a failed health gate. App build switch with LKG retained. Two forced unhealthy boots enter safe mode. `recovery disable` gives passthrough. |
| 3. Native experience | A mod panel and the Mods pages use app components. A light/dark switch propagates. Keyboard navigation, an input-method composition and a VoiceOver label all work on a mounted panel. |
| 4. Small SDK | All maintained mods are built only from §8.1. The core has no feature names: checked by grep over framework code for the names of mod features and of mods. |
| 5. Shared access | Process and connection inventory: one mux, backends only as defined, no mod holding app-server stdio or Electron handles. |
| 6. Linear overhead | §16 gates at 0, 1, 4 and 10 mods. |
| 7. Failure isolation | Three injected faults: a throwing host mod, a hung host mod and a throwing renderer mod. Each is quarantined while the app and other mods keep working. |
| 8. Maintained mods | Every row of §17 works natively. |

Focused automated tests back these up:

- mux unit tests over one recorded traffic capture;
- operations-journal tests with crash injection at every phase;
- builder verification, including the isolation baseline and content scan;
- renderer anchor probes against the real build.

---

## 19. Out of scope

- Public distribution, notarization, prebuilt app downloads, mod feeds or marketplaces, and automatic mod updates from the network. Trusted people install the framework and build their own copy locally (§0). Packages come from files or URLs the user provides.
- Security sandboxing of mods; native C ABI, WASI or XPC executors; per-mod isolated renderer worlds.
- Strong version independence. Running the same mod bytes across app builds is best-effort through §15, never promised.
- Exactly-once delivery, a durable event log across sessions, cross-session event replay.
- Generic call interception or monkey-patching APIs. Renderer mods already run in the page and may do what the page can do, at their own risk, without framework support.
- A main-process mod realm.
- Running against the stock app, production user accounts, or production profiles.
- Windows, Linux and Intel Macs.

---

## 20. Known limitations

- **Trusted mod code.** Mods run with the user's authority. Renderer code shares the app's page, and a mod process or migration can use Node's own network and process modules. Consent is informed trust, not a sandbox (§13).
- **Renderer busy-loop.** A renderer mod that busy-loops can freeze its window. This cannot be contained in-process; boot markers and the recovery ladder are the way out (§7.3, §12).
- **No Computer Use while the screen is locked.** Locked-use is removed from the copy (§5.3) because its installer changes system-wide state shared with the stock app.
- **node_repl LaunchServices fallback.** When no host-services pipe exists, node_repl's fallback starts the helper through LaunchServices with the default environment instead of the private `CODEX_HOME`. It cannot be patched in the asar. The pipe is passed per thread, so the fallback is not expected to run.
- **One copy per stock build.** A copy is pinned to the stock build it was made from, and each app update needs an adapter refresh (§12.3, §15) and a new candidate. Interception stability across builds is best-effort.
