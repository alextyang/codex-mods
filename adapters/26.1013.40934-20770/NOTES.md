# Adapter pack 1.0.0+refresh.20770 for ChatGPT/Codex 26.1013.40934 (20770)

A **refreshed** pack: derived from the 20156 pack and the installed stock app with

    node builder/refresh-adapter.mjs --previous adapters/26.1007.30912-20156/adapter.json --stock /Applications/ChatGPT.app \
      --out adapters/26.1013.40934-20770

The protocol catalog comes from `contracts/upstream/26.1013.40934-20770/schema/` (the build's own `codex app-server generate-json-schema`, stable schema
without `--experimental`). Nothing in `adapter.json` was edited by hand: the 17 mandatory asar edits are **derived** from the new `app.asar` by
`adapters/tools/cua-container.mjs`, `adapters/tools/managed-config.mjs` and `adapters/tools/cua-skills.mjs` (string anchors and structure; see below), the 31 binary patches are re-derived
by `adapters/tools/binary-patch.mjs` / `cua-container.mjs`, and what else the refresh could not carry over is dropped and listed.

**UI seams (step C5, 2026-10-22).** The pack also carries the build-time UI seams of `docs/design/presentations.md` V1/V2, appended after every other transform and declared in `seams.hooks`
(section "UI seams" below). They were added by `node adapters/tools/reseam-adapter.mjs --pack adapters/26.1013.40934-20770/adapter.json` (derived by `adapters/tools/seams.mjs` from the stock 20770
code, `.tmp/asar-20770/`; the 18 transforms before them are byte for byte the ones above, hashes included) and `build-facts.json` was regenerated with the census (four new families). Nothing was edited by hand.

**Nothing here was verified by running the app**, except N1 ("QA of N1" below). What was checked is static (the derivations, exactly-once finds, hash chains, a `vm.Script` compile of the
patched bundles, the static guards of the pack tests) and by the repository's tests. Native QA of a 20770 copy is still to be done (open items below).

## Build identity

| Field | Value |
|---|---|
| version / bundleVersion | 26.1013.40934 / 20770 |
| asarSha256 | `5ddc4e48…16ddb` (whole `app.asar`); the header hash equals Info.plist `ElectronAsarIntegrity` |
| electronVersion | 42.3.0 (unchanged; the Codex Framework directory is 155.0.8059.80, was 155.0.8059.40) |
| protocol | 105 client requests, 1 client notification, 10 server requests, 85 server notifications (20156: 84) |
| main-process bundles | `.vite/build/main-CLu1A25j.js`, `src-DsLVGakC.js`, `worker.js` (only their roles matter: see "Edit ids by role") |

## What changed from 20156

- **Protocol.** One new server notification, `thread/readState/changed`; nothing removed. Handshake, affinity keys and creators are unchanged.
- **Codex Framework.** `Frameworks/Codex Framework.framework/Versions/155.0.8059.80/Codex Framework` (was `.40`). The four Keychain/Aura patches are the same instruction
  words as in 20156 at new offsets (`keychain-service-name` `0x10d2670`, `-account` `0x10d1df0`, `aura-fallback-service` `0x10d273c`, `-account` `0x10d27e0`; 20156:
  `0x104b94c`, `0x104b0dc`, `0x104ba18`, `0x104babc`). All 31 binary patches have the same ids, `before`/`after` bytes and justifications as in 20156; the file path of
  the four framework patches, 14 offsets and the hashes differ.
- **Mandatory asar edits.** The same 16 edits at the same 16 sites, every minified name different (`Da`→`pa`, `Fc`→`cc`, `Vhe`→`Kge`, `pd`→`pie`, `gc`→`Wre`, `rne`→`ka`, config
  properties `.ss/.rs`→`.ls/.as`). Their finds and texts were derived from the new bundle, not carried over; for the reviewed proposal (`C0-isolation-20770`) they are identical
  except the five `cua-bundle-id:*` finds (below). Chained hashes equal the proposal's.
- **What the refresh could not carry over (dropped, listed in `refresh-report.json`; the UI seams below restore the exposures of the app's own objects, not these).** `expose-components:app-initial`, `expose-components:app-shared`, `seam-host:thread-header`,
  `trusted-view-context`, `trusted-view-sender` and, with them (the trusted sender works only whole), `trusted-view-startup`. These are not isolation edits. Their finds embed
  chunk and minified names of 20156. Because the pack no longer exposes components, its `components`, `react` and `seams` declarations are empty (a pack does not declare what
  its transforms do not deliver), so mods that need the app's components or the `thread.header` host are blocked on this pack. `adapters/tools/derive.mjs` locates the
  component exposures, the HeaderToolbar seam and the trusted sender on 20770 (TextField and Select are the two it does not find); a generated pack
  (`generate-adapter.mjs`) is the way to get them back, with its own review.
- **Backend overrides.** `backend.configOverrides` is carried over; `BROWSER_USE_CODEX_APP_VERSION` for node_repl follows the build (`26.1013.40934`), as the refresh now does for every
  override that is exactly the previous build's version.
- **Anchors, theme, actions.** Unchanged text. Statically checked against the 20770 renderer by the pack tests (every `data-*` attribute, class token and theme property exists; the
  General settings page slug and the navigation row's `aria-current="page"` that the `settings.section` gate relies on still exist). The runtime probe stays the final judge.
- **Missing, as before.** The `statusbar` anchor (no status bar in the app) and a standalone Select component (selects are built from the Dropdown). Nothing new was found missing in the anchors.

## UI seams (step C5)

Ten transforms after the 18 above (jsx, lazy, three taps, the menu builder, the AppHost hold, three exposure blocks; the menu builder was added on 2026-10-22 with the same re-seam tool), derived by `adapters/tools/seams.mjs` from strings and structure; each site occurs exactly once, nothing is anchored on a
minified name, a chunk name or a React Compiler cache size. `seams.hooks` declares what applied (`abi` 1). They are inert: patched code calls members of `globalThis.__codexmods`, and when a member is absent
or throws the app's own code runs (a throw is counted in `__codexmods.faults`).

| Transform | File (by role) | Op | What it does |
|---|---|---|---|
| `seam-jsx` | `app-shared` | replace-once | the jsx-runtime wrapper `X.Fragment=F,X.jsx=G,X.jsxs=G}` asks `__codexmods.jsx(factory, type, props, key)` first |
| `seam-lazy` | `app-shared` | replace-once | Vite's preload helper passes each lazy module through `__codexmods.lazy(String(importer), module)` (its chunk holds `vite:preloadError` exactly once) |
| `seam-tap:commands`, `:handlers` | `app-initial` | replace-once | `X=[{id:`newTask`,` and `X=new Map([[`newTask`,` start with `taps.commands` / `taps.handlers` |
| `seam-tap:messages` | `command-messages` | replace-once | `X={...Y,"codex.command.importExternalAgent":` starts with `taps.messages` (the three apply together or not at all) |
| `seam-menu` | `app-initial` | replace-once | the item builder of a thread's menus `async function F({scope,target,actions,…,showForkInSidebar,…})` keeps its name as a wrapper: the original, renamed `F__cm`, is awaited and its items pass `__codexmods.menuItems(args, items)` |
| `seam-app-host` | main bundle | insert-after-once | after the `registerAppView(...).catch(...)` statement: `__codexmods.appHost(host, sender)` |
| `seam-expose:app-initial` / `app-shared` / `app-primary` | the chunk | insert-before-once | one append-only block of lazy, cached getters on `__codexmods.exports`, before the source-map comment |

The 33 exposures (all derived once, keys by chunk on 20770; the last twelve, React DOM and v1's components, added on 2026-10-22 for V10 with the re-seam tool): `app-initial` appShell, headerSlots, tabRegistry, panelControllers, modal, commandStack, commandRegistered, slashRegistry, slashHooks, routes, panelSlots, shellSignals,
ComposerScope, RouteScope, ThreadScope, TextField, SettingsSection; `app-shared` AppScope, toast, bus, react, useScope, reactDom, Button, Switch, Menu, MenuParts, Dialog, DialogParts, SettingsRow, Tooltip, Icon; `app-primary` composerBanners. Each is a getter that runs the lazy initialiser(s) of the module that assigns the object (`(init(),X)`) before it reads it.
The probe's `useScope` capture edit is not carried over (the hook is exposed, not instrumented). The census lists the sites and keys: `choke.taps`, `choke.appHost`, `ui.exposures`, `lazy.addresses` (1160 static `(chunk, export)` pairs).

**Verified by tests, not natively:** `adapters/tools/seams.test.mjs` runs each seam's text in a VM (hook absent: the stock result; throwing hook: the fallback and one counted fault), derives everything from the 20770 and
21477 code, evaluates the patched `app-shared`, `app-initial` and `app-primary` as ES modules in a VM (the stock runtime, a DOM stub) and reads all 21 exposures, and the pack tests re-derive the seams
and parse every patched chunk. No QA copy of this pack has run them; the main session does the native check.

**Still dropped, and why.** The v1 component exposures (`expose-components:*`: Button, Switch, Dialog, …, `react`/`reactDom` declarations, `components`), the `thread.header` host seam and the trusted view sender trio
are not restored: they are outside step C5 (V10 rebuilds v1's `ctx.ui` over the bindings and exposures), and their finds embed the 20156 names. `derive.mjs` can still derive them
(`generate-adapter.mjs`) if v1's `ctx.ui` is wanted on this build; V10 rebuilds it over the bindings and exposures instead. `pack.react` stays null: the `react` exposure is the React module only
(no `reactDom`).

## Edit ids by role (hash-free) and how the edits are located

Chunk names carry a content hash that changes with every build, so ids and file lookups use the **role** of a file (its name without the hash: `main`, `src`, `worker`):

- `cua-bundle-id:main:1..3`, `cua-bundle-id:src:1`, `cua-bundle-id:worker:1` (20156: `cua-bundle-id:main-CqEoQDOU.js:1`, …). `normalizeEditId` reads old ids by role, so a refresh from a 20156-style pack keeps working.
- The main bundle is the one `.vite/build/main-*.js` that contains the anchors (`spawnComputerUseService(` and the container id for Computer Use; `config/batchWrite`, `mcp_servers.node_repl`, `mcpServers.cua_repl`
  and `cuaReplEnabled` for the managed config). Zero or several such bundles is a mandatory miss.
- A bare bundle id is replaced together with its **neighbouring string literal** (the next one, else the previous one), never by a one-letter tail of a minified name. Same replaced bytes and same hashes as the
  reviewed proposal; the finds are shorter: `` `com.openai.sky.CUAService`,`com.apple.WindowManager` `` (proposal: with the opening `[`), `` `…`,nw=`computerUseSoundMode` `` (proposal: with `tw=`), `` `…`;P7(`SkCu` `` (proposal:
  with `n2e=` and the closing `)`), `` `…`,`com.spotify.installer` `` (proposal: with the leading `,`), `` `…`,SFe=`CodexComputerUseNativeBridge-1` `` (proposal: with `xFe=`). Each occurs exactly once.
- The managed-config edits capture the config property names (`i.ls`, `i.as`) instead of assuming them, accept the `,` chain (20156) and the `;` statement (20770) before the `.mcp.json` write, and
  derive the per-thread edit for both shapes of the assembly (below). `persistedManagedConfig` fails closed: a bundle without its anchors is a finding, and the pack tests run it on the main bundle only.
- `cua-skills-no-expose` (N1, `adapters/tools/cua-skills.mjs`) locates the skill exposure by `Bundled CUA skill version mismatch` (exactly once in exactly one main bundle), the one map of the three
  skill directories (`computer-use`, `control-chrome`, `control-in-app-browser`) and, inside the one function that encloses the error (checked by a `vm.Script` parse of it alone), the
  lookup in that map, `skills`, `SKILL.md`, `.codex-plugin`/`skill-${…}`, `cuaReplSurfaces.includes(` and the `cp`/`rm`/`mkdir`/`rename` calls. Every other reference to the function must be
  an awaited call whose value is discarded (20770: one, in the managed tool sync). The edit replaces that whole function (exactly once) with itself
  plus a leading `return;` (`async function Gne(e){return;…`), so its stock text is gone, like every mandatory edit's site, and the dead body keeps the checker anchored.
- All derivers fail closed (no drafts, a mandatory miss) when an anchor is absent, duplicated or changed, and their dry runs re-run the static guards (no `computer-use` path off a non-relocated base, every helper start site
  private, the installer unreachable, nothing of the managed config persisted).

## Build facts

`build-facts.json` is this build's census (`adapters/tools/census.mjs`, integration.md §9; added 2026-10-21): 24 families, all
anchored exactly once as expected (since 2026-10-22 with `choke.taps`, `choke.appHost`, `ui.exposures` and `lazy.addresses`). `adapters/tools/census.test.mjs` checks it against the stock 20770 code
(`CODEXMODS_STOCK_ASAR`, `.tmp/asar-20770/` or the installed app, whichever is this build) and checks that a drifted anchor fails its families loudly.

## Decisions

Owner-architect decisions:

- **`managed-config-cua-repl-thread`: option (a).** In 20770 the app itself sets `mcp_servers.cua_repl` per thread (the full definition, with the per-thread node_repl and its private env) whenever the cached principal id exists. That
  assignment is kept. Only when it is not made (no cached principal id) the copy's own definition, kept in memory by `managed-config-no-persist-cua-repl`, is sent, so a thread never falls through to the stock definition in
  the shared plugin `.mcp.json`. On a build that never sets `cua_repl` per thread (20156) the deriver emits the 20156 form (the stash is added unconditionally). Not exercised by a launch: whether the no-principal case occurs in practice is open.

- **N1 (2026-10-21, under the owner's delegation): a daily copy does not write the shared plugin cache.** The skill exposure step
  becomes a no-op in copies, through a mandatory edit derived like the others (anchors: `Bundled CUA skill version mismatch`, the
  `skills/computer-use` / `skills/control-chrome` / `skills/control-in-app-browser` segments). The copy's threads then see whatever
  skills the stock app exposed, which is the price of never flapping the stock app's state. QA copies are unaffected (their
  `codex-home` is their own) but get the edit too. **Implemented 2026-10-21 as `cua-skills-no-expose`** (see "Open items", N1).

Implementation decisions of this change (reviewable, not owner decisions):

- The refresh **derives** the mandatory edits (ids `cua-*`, `managed-config-*`) and never replays their old finds; a mandatory edit that is not derived, applied exactly once or listed is a refused refresh (no pack). Other transforms are replayed against the
  file of the same role; a seam that works only whole (the trusted sender) is dropped whole; declarations that depended on dropped transforms are dropped and reported.
- The pack tests no longer hold constants of one build: offsets, function texts and counts come from the pack or from re-deriving.

## Open items for daily copies (from the review of the 20770 isolation edits; N1 is resolved by `cua-skills-no-expose`; N9 is resolved by relying on the copy's private per-profile sockets for the Computer Use peer authorization (`cua-disable-cu-peer-auth`); the others are not)

Shared state the 20156 baseline does not cover. Whether they already existed in 20156 is unknown (the 20156 asar is not available). No edit exists for N2–N8.

- **N1. CUA skill exposure wrote into the shared plugin cache: resolved by `cua-skills-no-expose`.** The function the tool sync calls right after the plugin `.mcp.json` rewrite copies or removes `skills/computer-use`,
  `skills/control-chrome` and `skills/control-in-app-browser` under `<CODEX_HOME>/plugins/cache/openai-bundled/<plugin>/<version>/` (through a temp dir `.codex-plugin/skill-<uuid>`), depending on this app's `cuaReplSurfaces`; it throws
  `Bundled CUA skill version mismatch` when the bundled plugin version differs from the installed one. Stock and copy would alternately add and remove the skill; relocation is no option (state-, not path-dependent). The
  copy's function now returns before any filesystem access (`async function Gne(e){return;…`); its one caller awaits it and discards the result, so the tool sync is otherwise unchanged (including the version-mismatch
  throw, which no longer happens in a copy). Verified: `adapters/tools/cua-skills.test.mjs` (the stock code on a fake fs removes and copies skills and throws on a mismatch; the transformed code touches nothing; drifted
  anchors on the synthetic shape and on the stock 20770 asar are mandatory misses), the pack tests (the edit is in the pack exactly once and mandatory; on the stock asar the checker sees the exposure before and
  nothing after; no other main-process script exposes skills; the re-derivation equals the pack), `builder/test/refresh.test.mjs` (a refresh that cannot derive or apply it once writes no pack). Native check:
  see "QA of N1" below.
- **N2. Bundled-marketplace materialization.** The app materializes its bundled marketplace (marker `.materialization-key`; `<CODEX_HOME>/.tmp/bundled-marketplaces/<name>`), writes the audio and live variants into each materialized plugin
  (`skills/computer-use/SKILL.md`, `.codex-plugin/plugin.json` `bundledContentVariant`) and removes `skills/live` for `live-disabled`. Shared with stock. The 20156 notes cover the SKILL.md audio edit only.
- **N3. Messages approvals.** `MessagesReadDecisions.json` and `MessagesSendApprovals.json` are read and written beside `ComputerUseAppApprovals.json`, so they live in the renamed container (`cua-container`; one constant). The team-build container
  rewrite must keep treating that constant as the single site. The helper RPC `messagesSearchChats` is forwarded through the worker; its transport was not traced.
- **N4. Native-pipe environment.** `SKY_CUA_SERVICE_NATIVE_PIPE_PATH`, `SKY_CUA_NATIVE_PIPE`, `SKY_CUA_NATIVE_PIPE_DIRECTORY` and the pipe `\\.\pipe\codex-computer-use-<uuid>`. On darwin the app passes the pipe only when the Windows-only pipe exists, and
  forwards the ambient `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` only for the Dev flavor: inert in a Prod copy, but not renamed. Whether the node client in `Resources/cua_node` reads them was not checked. The isolation content scan does not know them either.
- **N5. Shared-home mutations unrelated to the helper paths.** (a) The Chronicle/Skysight gate moves `<CODEX_HOME>/skills/chronicle` and `.codex-chronicle-assets-to-install.marker` into `<CODEX_HOME>/skysight/migration/legacy-chronicle-skill/<ts>-<uuid>`
  (whichever app runs first). (b) A one-time `config/batchWrite` deletes `remote_control` and `features.remote_control`, gated by the copy's own global-state flag, so it runs once more against the shared `config.toml`. Both are idempotent and mirror stock.
- **N6. Notification sounds.** Custom sounds are read from `~/Library/Group Containers/2DC432GLL2.com.openai.codex.notifications/Library/Sounds` (stock's notifications group container). The path is built and a staging map exists; a write was not seen and not traced.
- **N7. Checked and inert.** The DMG-install relocation in the bootstrap can rename `/Applications/ChatGPT.app` only for an app whose own basename is `ChatGPT.app` and that passes a codesign requirement on team `2DC432GLL2`; a copy fails both. The Windows-only
  notify writer and native-pipe server are guarded by `platform==='win32'`. The `codex_app` plugin `.mcp.json` write still targets the shared plugin cache but carries nothing copy-specific (as in 20156). No `safeStorage`, `keychain`, `Storage Key`,
  `Aura`, `/usr/bin/security` or `kSec` string exists in the 35 `.vite/build` scripts: the Keychain isolation rests entirely on the binary patches.
- **N8. Fixed `/tmp` socket directories (found by the D6 proof, 2026-10-21).** Main listens for the app tools on
  `/tmp/codex-app-tools/<uuid>.sock` and for the in-app browser on `/tmp/codex-browser-use/<uuid>.sock` (literal directories; on win32
  named pipes). Sockets are mode 0600 and their peers are authorized by key. A daily copy shares the directories with stock under the
  same user: names are unique, so this is acceptable and needs no edit. A QA user is another macOS user: when the owner's stock app has
  made a directory first (mode 0755), the QA copy gets `EACCES`, `CODEX_APP_TOOLS_PIPE_PATH` stays unset, the app tools are off
  (`missing-pipe`) and the model's in-app browser fails ("The browser access host is unavailable"). Decided: QA builds relocate both
  directories under the profile's run directory with a QA-only edit; product copies keep them. **Implemented** by the builder's
  `--qa-socket-dirs` (builder/qa-socket-dirs.mjs; `qa setup` passes it, `codexmods setup --daily` refuses it): each literal must occur
  once across `.vite/build/*.js`, as the template literal, and is replaced by `<root>/profiles/<profile>/run/app-tools` and `…/run/browser-use`
  (root and profile resolved as the loader does), or `$TMPDIR/cm<6 hex>/a|b` when a uuid socket path would exceed 103 bytes. Only main
  moves: the in-app browser client gets the socket path in `BROWSER_USE_ACCESS_PIPE_PATH`, but the Chrome extension host and
  `browser-service.mjs` still scan `/tmp/codex-browser-use`, so the Chrome backend stays unavailable in QA. Native check (D6 rerun,
  model-batch-3.md): both sockets listen in the profile, and the log has no `EACCES`. The browser still fails, because of N9.
- **N9. Computer Use local-socket peer trust (found 2026-10-21; resolved 2026-10-22, `cua-disable-cu-peer-auth`).** The Computer Use app-tools and in-app-browser pipes authorize their socket peers against OpenAI's own signing identity, which a copy re-signed under the user's Apple Developer identity cannot present, so the model's in-app browser and app tools were unavailable in copies. For team builds the builder re-pins the bundled Computer Use identity references to the copy's own team (completeness; no stock identity survives). Those sockets are mode-0600 in the copy's private per-profile run directory, reachable only by the copy's own user, so for the app-tools/in-app-browser peer authorization the copy relies on that location-based access control in place of the stock OpenAI-identity pin. The edit is scoped to Computer Use and locked into `mandatoryEdits`. Native QA on the isolated QA copy confirms the pipes connect and the in-app-browser backend starts; a visible browser tab additionally needs an on-screen GUI session, which the headless QA harness lacks, so that final step is confirmed in normal GUI use.

Also open:

- **Install-flow toast: "Couldn't enable Locked use".** The Computer Use plugin install flow (`plugin-installation-content-*.js` in the renderer) calls `setLockedUseEnabled(true)` after installing the plugin and shows the warning "Computer Use installed / Couldn't enable
  Locked use" when the result is not `true`. With `cua-disable-locked-use` the result is `null`, so a copy shows that toast after every Computer Use install. The settings row stays hidden (`enabled: null`). Cosmetic; no isolation effect; whether 20156 made the same call
  is unknown. A renderer edit could silence it; this pack has none.
- **Native QA of `cua-helper-private-home`.** The text is the 20156 text and the native symbols of `sky.node` are structurally unchanged (the spawn is still an async worker, `posix_spawn` with the live environment), but the effect (the helper sees the profile
  directory as `CODEX_HOME`; `notify` is no longer written to the shared `config.toml`) needs the same native check on a 20770 QA copy. Binary patches were re-derived and are unchanged in kind; `Resources/native/*`, plists and entitlements were not examined beyond that.
- **Dropped v1 UI seams.** See "What changed" and "UI seams": the page seams of C5 are restored; the v1 component exposures, the `thread.header` host seam and the trusted view sender are not.
- **`cua-disable-cu-peer-auth` now has a deriver (2026-10-22).** The edit was added to this pack by hand (commit `b40b2f2c`: `insert-after-once` after `function Vd(){`, the browser-use native-pipe peer
  authorizer), so no refresh could have re-derived it (a refresh would have refused: a mandatory edit that was not derived). `adapters/tools/cua-peer-auth.mjs` now locates the factory by its log name
  `browser-use-native-pipe-peer-authorizer`, its macOS check and its build-flavor read, and reproduces exactly this edit (id, file by role, op, find and text); it is the last of the derived mandatory edits
  (`derive.mjs`, the refresh and the pack tests), so every hash of the chain above is unchanged.

## QA of N1 (2026-10-21, native, on the QA machine as the QA user)

QA copy rebuilt from commit `64523fe8` (branch `n1-skip-cua-skill-exposure`) with `qa setup --probe native --rebuild` (team-signed, TeamIdentifier `76JE9YNX29`;
the main bundle `main-CLu1A25j.js` of the built copy contains `async function Gne(e){return;` exactly once), launched with `launch --keep --fast`.

- Before the launch: a snapshot (mtime, inode, path) of every entry under `codex-home/plugins/cache/openai-bundled/*/*/skills` and `*/*/.codex-plugin` (34 entries; the earlier,
  unpatched build had already emptied `computer-use/1.0.1001501/skills` and `browser/26.1013.40934/skills`), no `skill-*` temp dir.
- After 30 s and again after 6 minutes of running: the same 34 entries, identical mtimes and inodes; no `skill-*` anywhere under `codex-home/plugins`.
- The app works normally: all four QA mods `compatible`, the window renders (probe `text`: sidebar with Home, Plugins, Projects, Recents and the threads),
  the console shows only the usual warnings (Statsig, a CSP inline-script notice, AudioContext).
- Computer Use still starts: the copy's own helper `profiles/default/computer-use/Codex Computer Use.app/…/SkyComputerUseService` runs, started 10 s after the app.

Not observed directly: that the tool sync called the patched function during this launch (it runs at every bundled-plugin reconcile, launch included; no log line names it).
A daily copy was not run (owner's machine; not needed for this check).

## Mandatory edits (ARCHITECTURE §5.3)

`mandatoryEdits` in `adapter.json` lists the 4 Keychain/Aura binary patches, the 27 `cua-container:*` binary patches and the 17 asar edits:
`cua-relocate-dir`, `cua-relocate-config`, `cua-relocate-installer`, `cua-disable-locked-use`, `cua-helper-private-home`, `cua-relocate-approvals`, `cua-service-path-env`, `cua-container`,
`cua-bundle-id:main:1`, `:2`, `:3`, `cua-bundle-id:src:1`, `cua-bundle-id:worker:1`, `managed-config-no-persist`, `managed-config-no-persist-cua-repl`, `managed-config-cua-repl-thread` and `cua-skills-no-expose` (N1, above).
The Keychain isolation (`keychain-service-name`, `keychain-service-name-account`, `aura-fallback-service`, `aura-fallback-account`), the Computer Use container, relocation and identity, and the managed-config edits are explained in `../26.1007.30912-20156/NOTES.md`; they apply unchanged.
The builder (`builder/build.mjs`) refuses this pack unless every listed edit is declared and applied, and its content scan covers the final bundles.

## Refresh report (generated by builder/refresh-adapter.mjs; the same data is in refresh-report.json)

Derived from 26.1007.30912-20156 on 2026-10-21T19:59:23.048Z. Review everything marked missed; none of it was guessed.

### Transforms

- mandatory isolation edits derived from this build's app.asar (not replayed): cua-relocate-dir, cua-relocate-config, cua-relocate-installer, cua-disable-locked-use, cua-helper-private-home, cua-relocate-approvals, cua-service-path-env, cua-container, cua-bundle-id:main:1, cua-bundle-id:main:2, cua-bundle-id:main:3, cua-bundle-id:src:1, cua-bundle-id:worker:1, managed-config-no-persist, managed-config-no-persist-cua-repl, managed-config-cua-repl-thread, cua-skills-no-expose
- missed expose-components:app-initial: `find` not found in the new bundle (dropped from the pack)
- missed expose-components:app-shared: `find` not found in the new bundle (dropped from the pack)
- missed seam-host:thread-header: `find` not found in the new bundle (dropped from the pack)
- missed trusted-view-context: `find` not found in the new bundle (dropped from the pack)
- missed trusted-view-sender: `find` not found in the new bundle (dropped from the pack)
- missed trusted-view-startup: another transform of the trusted-sender seam is missing, and the seam works only whole (dropped from the pack)

### Declarations

- components no longer exposed, dropped from the pack: Button, Switch, Dialog, Tooltip, Icon, SettingsRow, Menu, TextField, SettingsSection
- react/reactDom no longer exposed, dropped from the pack
- host seams no longer provided, dropped from the pack: thread.header, thread.panel

### Backend overrides

- the previous build's app version was replaced by 26.1013.40934 in: backend.configOverrides.mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION

### Anchors

- no anchor fully missed

### Binary patches

- re-derived for this build: 31 (previous pack had 31; none carried forward)
- mandatory edits all present: cua-relocate-dir, cua-relocate-config, cua-relocate-installer, cua-disable-locked-use, cua-helper-private-home, cua-relocate-approvals, cua-service-path-env, cua-container, cua-bundle-id:main:1, cua-bundle-id:main:2, cua-bundle-id:main:3, cua-bundle-id:src:1, cua-bundle-id:worker:1, managed-config-no-persist, managed-config-no-persist-cua-repl, managed-config-cua-repl-thread, keychain-service-name, keychain-service-name-account, aura-fallback-service, aura-fallback-account, cua-container:bin/node_repl:1, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:1, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:2, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:3, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:4, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:2, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:3, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:4, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/MacOS/CUALockScreenGuardian:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/MacOS/CUALockScreenGuardian:2, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/MacOS/CUALockScreenGuardian:3, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin:2, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin:3, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPluginInstallerTool:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient:2, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:1, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:2, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:3, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:4, cua-skills-no-expose

### Protocol

- regenerated: {"clientRequests":105,"clientNotifications":1,"serverRequests":10,"serverNotifications":85}

### Census

- build-facts.json written; families that failed to anchor: none
