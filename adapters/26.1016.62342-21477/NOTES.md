# Adapter pack 1.0.0+refresh.21477 for ChatGPT/Codex 26.1016.62342 (21477)

A **refreshed** pack: derived from the 20770 pack and the installed stock app with

    node builder/refresh-adapter.mjs --previous adapters/26.1013.40934-20770/adapter.json --stock /Applications/ChatGPT.app \
      --out adapters/26.1016.62342-21477

The protocol catalog comes from `contracts/upstream/26.1016.62342-21477/schema/` (the build's own `codex app-server generate-json-schema`, stable schema; `schema-experimental/` is the same
command with `--experimental`; both ran with a temporary `HOME` and `CODEX_HOME`, never `~/.codex`). Nothing in `adapter.json` was edited by hand: the 18 mandatory asar edits are **derived**
from the new `app.asar` by `adapters/tools/cua-container.mjs`, `managed-config.mjs`, `cua-skills.mjs` and `cua-peer-auth.mjs` (string anchors and structure), the 31 binary patches are re-derived by
`adapters/tools/binary-patch.mjs` / `cua-container.mjs`, and the UI seams of `docs/design/presentations.md` V1/V2 (nine then; the menu builder was added later) are derived again by `adapters/tools/seams.mjs`, in the same run. **Nothing was
dropped**: all 27 transforms of the 20770 pack derive on this build, and nothing was missed or unverified in the anchors.

The refresh ran twice. The first run wrote this pack with one census family failed (`bus.fetchHandlers`: its anchor was a handler name that 21477 no longer has, see "Build facts"). The deriver in
`adapters/tools/census.mjs` was fixed with fail-closed tests, that output directory (made by the first run) was removed and the same command ran again; `build-facts.json` and `refresh-report.json`
are those of the second run. `NOTES.md` is this file; the generated report is at the end.

**Nothing here was verified by running the app.** What was checked is static (the derivations, exactly-once finds, hash chains, a `vm.Script` compile of the patched bundles, the static guards of the
pack tests) and by the repository's tests, which now read this build (the installed app is 21477). Native QA of a 21477 copy is still to be done (open items below).

## Build identity

| Field | Value |
|---|---|
| version / bundleVersion | 26.1016.62342 / 21477 |
| asarSha256 | `5b5cf528…3be869` (whole `app.asar`); the header hash equals Info.plist `ElectronAsarIntegrity` (`c25979e3…`) |
| electronVersion | 42.3.0 (unchanged); Codex Framework 155.0.8059.80 (unchanged version) |
| bundled `codex` | `codex-cli 0.163.0-alpha.11.2` (20156 had 0.162.0-alpha.17.2) |
| protocol | 105 client requests, 1 client notification, 10 server requests, 85 server notifications: **identical to 20770** (experimental: 172, 1, 11, 85, also unchanged) |
| main-process scripts | 37 in `.vite/build` (20770: 35); the roles that matter are `main` (`main-JI9qDiXp.js`), `src` (`src-CsH31EEu.js`) and `worker` (`worker.js`); renderer chunks 14,907 (20770: 14,788) |

## What changed from 20770

- **Protocol: nothing in the stable schema.** All 39 files of `schema/` are byte-identical to 20770's, so the pack's `protocol` section (handshake, affinity keys and creators, the four method lists) equals
  20770's. The experimental bundle differs by one optional field: `ThreadRealtimeStartParams.voiceSessionId` (`string | null`, "Client-generated identifier for the product voice session, distinct from
  `realtimeSessionId`"). No method, notification, server request or definition was added or removed, and no required field changed (the codec and fake checks of this change confirm it over 884 definitions).
- **What moved is in the app, not the protocol.** The main-process fetch-handler map (`vscode://codex/<name>`) shrank from 131 keys to 37, the per-window shared objects from 20 to 5, and the AppHost
  services grew from 141 to 167: the renderer now reaches the removed operations through AppHost services (seen for `workspaceRoots` and `executionPaths`; the rest is inferred from the names of the 29 new
  services and not traced one by one; details under "Build facts"). The graph's choke points do not depend on the removed handlers (the protocol is untouched; the tap, JSX, lazy and AppHost seams derive as
  before), but any realization note that names a fetch handler or a shared object of 20770 must be re-read against these facts.
- **Mandatory asar edits.** The same 18 edits at the same 18 sites (ids, files by role, ops), every minified name different where the old text had one (`Gge`→`p_e`, `QC`→`yw`, `$C`→`bw`, …). Their
  finds and texts were derived from the new bundle, not carried over. Four have find and text literally as in 20770 (`cua-bundle-id:main:1`, `:3`, `cua-bundle-id:src:1`, `cua-disable-cu-peer-auth`), two
  have the same text and a find that differs only in names (`managed-config-no-persist`, `managed-config-no-persist-cua-repl`), and the other twelve differ from 20770's only in minified names (read
  side by side; the `cua-disable-locked-use` find and the three-function replacement keep the 20770 structure).
  `cua-disable-cu-peer-auth` is derived by `adapters/tools/cua-peer-auth.mjs`, which was not touched and whose change was not reviewed in this refresh (owner's request); it derives on 21477.
- **Binary patches.** The same 31 patches: same ids, `before`/`after` bytes and justifications as in 20770; the file paths are the same, 22 offsets and the hashes of the patched files differ. The four
  Keychain/Aura words in `Codex Framework` moved (`keychain-service-name` `0x10d2670`→`0x10cfeb0`, `-account` `0x10d1df0`→`0x10cf630`, `aura-fallback-service` `0x10d273c`→`0x10cff7c`, `-account`
  `0x10d27e0`→`0x10d0020`). The Computer Use helper binaries were rebuilt: `SkyComputerUseService` (4 words), `CUALockScreenGuardian` (3), `SkyComputerUseClient` (2), `bin/node_repl` (1) and both
  `native-pipe.js` copies (4 each) moved; the installer tool, the authorization plugin and the five plists are byte-identical at the patched offsets.
- **UI seams.** All ten derive and apply exactly once, atomically, with the same exposures by the same chunk roles (21 then, 33 since V10) (see the next section).
- **Backend overrides.** `backend.configOverrides` is carried over; `BROWSER_USE_CODEX_APP_VERSION` for node_repl follows the build (`26.1016.62342`).
- **Anchors, theme, actions, components, react, seams declarations.** Unchanged text and identical to 20770's (`adapter.json` compares equal part by part except `build`, `transforms`, `binaryPatches`). Statically
  checked against the 21477 renderer by the pack tests (every `data-*` attribute, class token and theme property exists; the General settings page slug and `aria-current="page"` that the `settings.section` gate
  relies on still exist). The runtime probe stays the final judge.
- **Missing, as before.** The `statusbar` anchor (no status bar in the app) and a standalone Select component. Nothing new was found missing.
- **Still dropped since 20770 (not new).** The v1 component exposures, `react`/`reactDom`, the `thread.header` host seam and the trusted view sender trio: the 20770 pack already shipped without them, so the
  pack's `components`, `react` and host `seams` declarations are empty and mods that need them stay blocked (V10 rebuilds `ctx.ui` over the bindings and exposures).

## UI seams (step C5)

Ten transforms after the 18 above (the menu builder added on 2026-10-22 by `adapters/tools/reseam-adapter.mjs`), derived by `adapters/tools/seams.mjs` from strings and structure; each site occurs exactly once and nothing is anchored on a minified name, a chunk name or a React Compiler
cache size. `seams.hooks` declares what applied (`abi` 1). The declaration equals the 20770 pack's. The table of sites is the 20770 pack's (`../26.1013.40934-20770/NOTES.md`, "UI seams"); on 21477:

| Transform | File (by role) | What differs from 20770 |
|---|---|---|
| `seam-jsx` | `app-shared` | find and text identical |
| `seam-lazy` | `app-shared` | the preload helper's variable names |
| `seam-tap:commands`, `:handlers` | `app-initial` | the table variable names |
| `seam-tap:messages` | `command-messages` | the object variable name |
| `seam-menu` | `app-initial` | the builder's minified name (`BUc`; `LFc` on 20770) |
| `seam-app-host` | main bundle | find and text identical |
| `seam-expose:app-initial` / `app-shared` / `app-primary` | the chunk | the `find` is the chunk's own `//# sourceMappingURL=<role>-<hash>.js.map` line (new hash); the getter block is the same keys (21 then, 33 since V10), with new minified names |

The 33 exposures (all derived once; React DOM and v1's components added on 2026-10-22 for V10): `app-initial` appShell, headerSlots, tabRegistry, panelControllers, modal, commandStack, commandRegistered, slashRegistry, slashHooks, routes, panelSlots, shellSignals,
ComposerScope, RouteScope, ThreadScope, TextField, SettingsSection; `app-shared` AppScope, toast, bus, react, useScope, reactDom, Button, Switch, Menu, MenuParts, Dialog, DialogParts, SettingsRow, Tooltip, Icon; `app-primary` composerBanners. The census facts `choke.jsx`, `choke.lazy`, `choke.react` (React 19.2.7), `choke.taps`,
`choke.appHost` and `ui.exposures` have the same digests as on 20770: the sites are identical in structure, so nothing about the seams' design changed. `lazy.addresses` grew from 1160 to 1206 pairs (53 new, 7 gone;
`command-menu-dialog:CommandMenuDialog` and `delete-thread-dialog:DeleteThreadDialog` are still there).

**Verified by tests, not natively:** `adapters/tools/seams.test.mjs` derives all nine groups from the 21477 code (and 20770's), runs each seam's text in a VM, and evaluates the patched chunks; the pack tests
re-derive the seams, compare them with the pack and parse every patched chunk. No QA copy of this pack has run them; the main session does the native check.

## Edit ids by role (hash-free) and how the edits are located

Unchanged from the 20770 pack (`../26.1013.40934-20770/NOTES.md`, same section): ids and file lookups use the role of a file (`main`, `src`, `worker`), the main bundle is the one `.vite/build/main-*.js` that
contains the anchors, bare bundle ids are replaced together with their neighbouring string literal, the managed-config edits capture the config property names, and every deriver fails closed when an anchor is absent,
duplicated or changed. On 21477 the three roles are `main-JI9qDiXp.js`, `src-CsH31EEu.js` and `worker.js`; `cua-bundle-id:main:1..3`, `:src:1` and `:worker:1` each occur exactly once.

## Build facts

`build-facts.json` is this build's census (`adapters/tools/census.mjs`, integration.md §9): 24 families, **all anchored exactly once as expected**. `adapters/tools/census.test.mjs` now checks both packs' facts against
their stock code (`.tmp/asar-20770/` for 20770, the installed app for 21477). Counts and digests against 20770 (`=` same digest):

| Family | 20770 | 21477 | |
|---|---|---|---|
| `bus.toView`, `ipc.channels`, `items.types`, `protocol.schema`, `protocol.wireOnly`, `choke.*` (5), `ui.exposures` | 197, 25, 36, 269, 19, 1/1/1/3/1, 21 | same | `=` |
| `bus.fromView` | 154 | 147 | gone: `pending-worktree-{cancel,continue,create,dismiss,retry,update-metadata}`, `codex-runtimes-config-changed` (no string of them is left in main or renderer) |
| `bus.fetchHandlers` | 131 | **37** | the map keeps the global state, settings, file reads, remote-control, dictation, git merge-base/snapshot and computer-use native-app handlers; 94 are gone from it (below) |
| `state.globalKeys` | 87 | 85 | gone: `git-pr-watch-auto-merge`, `git-pr-watch-instructions` |
| `state.persistedAtoms` | 329 | 333 | +5 (`browser-auth-password-manager-setup-dismissed`, `chatgpt-last-thinking-selection-id-v1`, `chatgpt-search-results-v2`, `learning-flashcards-presentations`, `spaces-browser-workspace-visits-v1`), -1 (see the blind spots) |
| `state.sharedObjects` | 20 | **5** | the remaining keys are the local remote-control ones; `diff_comments*`, `pending_worktrees`, `host_config`, `composer_prefill`, `statsig_*`, `remote_*_connections` and the rest are gone |
| `commands.ids` | 182 | 182 | `toggleMaximizeSidePanel` out, `deleteOrbit` in |
| `settings.slugs` | 52 | 53 | +`gateways` |
| `panel.tabKinds` | 54 | 53 | -`pull-request-fix-automation` |
| `apphost.services` | 141 | **167** | +29: `accountInfo`, `agentInstructions`, `browserPreferences`, `commandKeybindings`, `commentAttachments`, `composerHandoff`, `connectorOAuth`, `customAgents`, `executionHosts`, `externalAgentImport`, `feedbackDiagnostics`, `gitFiles`, `gitMessageGeneration`, `gitRepository`, `internalPlugins`, `mailProvider`, `modelReviewComments`, `nodeReplExecutions`, `permissionPolicy`, `projectlessThreads`, `queryCache`, `queuedSendLocks`, `recommendedSkills`, `remoteConnections`, `repositoryOrigins`, `runtimeInfo`, `sshConnections`, `threadConfiguration`, `workspaceRoots`; -3: `pullRequestMessageGeneration`, `safetyRecourseGeneration`, `sshConnectionRegistration` |
| `routes.paths` | 145 | 149 | +7 (`/rosalind/application`, `/rosalind/application/status`, `/settings/plugins/:server/:toolName`, `/space/browser/:url/:instanceId?`, `/students/claim`, `/students/verify`, `/w/:slug/:username`), -3 (see the blind spots) |
| `dom.dataAppAttrs` | 90 | 91 | +`data-app-shell-titlebar-divider` |
| `i18n.ids` | 32385 | 33982 | |
| `lazy.addresses` | 1160 | 1206 | +53, -7 |

What matters for the graph and the seams:

- **Item types: unchanged** (36, same digest; the schema's `ThreadItem` variants are byte-identical). Commands: 182 ids, one swapped. Panel tab kinds, `review`, `terminal` and `unrestored-route` stay.
- **Most fetch handlers are gone from main.** Of 20770's 131 handlers (`vscode://codex/<name>`) 94 are not in the 37 (among them `automation-create`, `worktree-create-managed`, `codex-agents-md-save`,
  `list-pinned-threads`, `set-thread-pinned`, `workspace-root-options`, `git-origins`); no string of most of them is left in main. The renderer still uses their names as query keys (`['vscode','list-automations']`)
  and calls AppHost services for the data (`Js.workspaceRoots`, `Js.executionPaths.readHomeDirectory`); services that already existed on 20770 (`automations`, `pinnedThreads`, `managedWorktrees`, `settings`) stay and
  29 are new (list above). `set-global-state`, `get-global-state`, `get-setting`, `set-setting`, `settings-read` and `settings-write` stay in the map, so the global-state and settings interception points hold.
  Inference, not traced: the AppHost hold (`seam-app-host`) reaches more of the app's operations on 21477 than on 20770.
- **The pending-worktree flow left the bus and the shared objects** (`pending-worktree-*` messages, `pending_worktrees`), as did the per-window diff comments (`modelReviewComments`, `commentAttachments`
  services now).
- **Census blind spots found by checking the removals against the code (not fixed here).** The census resolves a path or key constant by a unique definition of its identifier in the chunk, and refuses an identifier that
  collides with local variables. On 21477 two short import aliases collide (`ie`, `Kt`), so `/local/:conversationId` (the local thread route) and `/g/:gizmoId/c/:conversationId` dropped out of `routes.paths`
  although both routes still exist (their constants `T7e` and `o_t` in `app-shared`; `Gr('/local/:conversationId')` is called in `app-initial` and `routeTemplate:` uses it in three chunks); `unresolved` grew 4→5.
  `electron:onboarding-conversational-completed-by-account-id` left `state.persistedAtoms` for the same kind of reason (its string is still in the renderer, read through another helper in the onboarding
  chunk). The counts above are therefore a lower bound for those two families. A deriver that follows the import binding needs a scope check first; it is an open item, not a fix made here.

## Decisions

Owner-architect decisions carry over unchanged from the 20770 pack (`managed-config-cua-repl-thread` option (a), N1 `cua-skills-no-expose`, N9 `cua-disable-cu-peer-auth`); on 21477 the managed-config deriver emits the same form
as on 20770 (the app sets `mcp_servers.cua_repl` per thread when the cached principal id exists).

Implementation decisions of this change (reviewable, not owner decisions):

- **The fetch handler map is located by the dispatcher, not by a handler name.** `bus.fetchHandlers` anchored on the key `"automation-create":`, which 21477 does not have, so the census marked the family failed.
  It now anchors on the dispatcher's own failure text (`not implemented in the current Electron process`, exactly once in exactly one main script), checks that the text sits in a lookup of `this.handlers[...]`,
  climbs to the class body that holds it and takes its one field `handlers={...}`; zero or two fields, a lookup that is not `this.handlers[`, a dispatcher outside a class, fewer than 20 entries or an entry that is neither a
  key nor a spread fail the family loudly with no values. 20770 gives the same 131 values and digest as before; 21477 gives 37. Tests: `census.test.mjs` (synthetic shapes without a stock app, and every drift of the
  site on both stock builds).
- **The census forgets one run before the next.** Its file locators (`main`, `app-initial`, `app-shared`) and alias caches were module-level and survived between runs, which only a second census in one process
  (two builds in one test file) can show: the second build then looked in the first build's files. `census()` now clears them on entry; the output of a single run is unchanged (the committed digests of both
  builds are reproduced).
- **The refresh did not change.** The pack was produced by the documented command; the two census changes are the only deriver changes. `cua-peer-auth.mjs` was not touched.
- **The pack tests and the census tests cover both packs.** `adapters/tools/adapter-21477.test.mjs` runs the shared pack tests for this pack; `census.test.mjs` runs the same checks for 20770 and 21477 and holds the
  facts that differ per build (the 21477 shift to AppHost services is asserted, so a later census that undoes it fails).
- **The stock-bound tests that were pinned to 20770 now run on both builds.** `cua-skills.test.mjs` (the N1 derivation and its drift cases, which re-find the skill map's key by shape instead of the minified
  `i.qo`) and `builder/test/qa-socket-dirs.test.mjs` (N8: both `/tmp` socket directories occur exactly once, in `main-JI9qDiXp.js` on 21477, so `--qa-socket-dirs` still builds a QA copy). `cua-peer-auth.test.mjs`
  was left as it is.
- **Shape checks run against every build since 20770** (`tests/fixtures/captures.mjs` `buildsSince`): the presenter's codecs, the presenter tests' wire frames, the fake app-server's modelled payloads, the captured
  payloads (recorded on 20770) and the bridge's app operations (`graph/test/app-ops-schema.test.mjs`). A build added to `contracts/upstream/` joins them automatically.
- **Pack file modes.** The refresh builds the pack in a mode-0700 temporary directory, so the new files came out 0600; they were set to 0644 (directory 0755) like the 20770 pack's, because the QA user reads this
  checkout from another account.

## Open items for daily copies (the 20770 list applies unchanged: N2 to N8 have no edit; N1 and N9 are resolved by their mandatory edits)

See `../26.1013.40934-20770/NOTES.md`, "Open items": the bundled-marketplace materialization (N2), Messages approvals (N3), native-pipe environment (N4), shared-home mutations (N5), notification sounds (N6), the
inert checks (N7), the fixed `/tmp` socket directories relocated by the QA-only `--qa-socket-dirs` (N8), the "Couldn't enable Locked use" toast after a Computer Use install and the dropped v1 UI seams. New or changed on
21477:

- **Native QA of this pack has not run.** It needs a QA copy built from this pack (`qa setup --rebuild`, `launch`) and the probe report: the 18 mandatory edits and 31 binary patches apply to files that changed
  on this build (the Computer Use helper binaries and `node_repl` moved their patched words, see above), so the signed copy's isolation checks, the helper's private `CODEX_HOME` (`cua-helper-private-home`), the
  distinct service-path variable and the peer-authorization edit (`cua-disable-cu-peer-auth`) are checked statically only. Not exercised by a launch: whether the no-principal case of
  `managed-config-cua-repl-thread` occurs in practice.
- **The seams are not native-checked on this build** (the kernel and hooks of V3 are not in the pack yet; the seams are inert until `globalThis.__codexmods` provides members). G-jsx, G-lazy and G-tap were
  proven on 20770 through the probe.
- **Re-read the realization notes that name 20770 fetch handlers, shared objects or pending-worktree messages** (the interceptors of `set-global-state` etc. are unaffected; the removed handlers are now AppHost services,
  which the G-apphost hold reaches). Which operations the graph wants to intercept through the AppHost services is a design decision for the bindings, not made here.
- **The census blind spots above** (`routes.paths` lost the local thread route and the GPT chat route, `state.persistedAtoms` one onboarding key) should get a scope-aware alias resolution before the facts are used
  as a complete list for those two families.
- **`refresh-adapter.mjs` writes its output in a 0700 directory.** Anyone running it for another build must chmod the pack (directory 755, files 644) before the QA user can read it.

## Mandatory edits (ARCHITECTURE §5.3)

`mandatoryEdits` in `adapter.json` lists the 4 Keychain/Aura binary patches, the 27 `cua-container:*` binary patches and the 18 asar edits: `cua-relocate-dir`, `cua-relocate-config`, `cua-relocate-installer`,
`cua-disable-locked-use`, `cua-helper-private-home`, `cua-relocate-approvals`, `cua-service-path-env`, `cua-container`, `cua-bundle-id:main:1`, `:2`, `:3`, `cua-bundle-id:src:1`, `cua-bundle-id:worker:1`,
`managed-config-no-persist`, `managed-config-no-persist-cua-repl`, `managed-config-cua-repl-thread`, `cua-skills-no-expose` (N1) and `cua-disable-cu-peer-auth` (N9): 49 ids, the same list as the 20770 pack's.
The Keychain isolation, the Computer Use container, relocation and identity, and the managed-config edits are explained in `../26.1007.30912-20156/NOTES.md`; they apply unchanged. The builder
(`builder/build.mjs`) refuses this pack unless every listed edit is declared and applied, and its content scan covers the final bundles.

## Refresh report (generated by builder/refresh-adapter.mjs; the same data is in refresh-report.json)

Derived from 26.1013.40934-20770 on 2026-10-23T00:12:51.467Z (the second run; see above). Review everything marked missed; none of it was guessed.

### Transforms

- mandatory isolation edits derived from this build's app.asar (not replayed): cua-relocate-dir, cua-relocate-config, cua-relocate-installer, cua-disable-locked-use, cua-helper-private-home, cua-relocate-approvals, cua-service-path-env, cua-container, cua-bundle-id:main:1, cua-bundle-id:main:2, cua-bundle-id:main:3, cua-bundle-id:src:1, cua-bundle-id:worker:1, managed-config-no-persist, managed-config-no-persist-cua-repl, managed-config-cua-repl-thread, cua-skills-no-expose, cua-disable-cu-peer-auth
- no transform missed

### UI seams

- derived again for this build and applied (atomic groups): jsx, lazy, taps, app-host, seam-expose:app-initial, seam-expose:app-primary, seam-expose:app-shared
- declared in seams.hooks (abi 1): jsx, lazy, taps, appHost, exposures

### Declarations

- nothing dropped (the pack already declared no components, React or host seams)

### Backend overrides

- the previous build's app version was replaced by 26.1016.62342 in: backend.configOverrides.mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION

### Anchors

- no anchor fully missed; every selector was found statically (none unverified)

### Binary patches

- re-derived for this build: 31 (previous pack had 31; none carried forward); none missing
- mandatory edits all present (49 ids, the list above)

### Protocol

- regenerated: {"clientRequests":105,"clientNotifications":1,"serverRequests":10,"serverNotifications":85}

### Census

- build-facts.json written; families that failed to anchor: none
