# Adapter pack for ChatGPT/Codex 26.1027.30824 (22943)

A **refreshed** pack: derived from the 21477 pack and a copy of the installed stock app (`.tmp/stock-22943`, the same `app.asar` byte for byte) with

    node builder/refresh-adapter.mjs --previous adapters/26.1016.62342-21477/adapter.json --stock .tmp/stock-22943/ChatGPT.app \
      --out adapters/26.1027.30824-22943

The protocol catalog comes from `contracts/upstream/26.1027.30824-22943/schema/` (the build's own `codex app-server generate-json-schema`, stable schema;
`schema-experimental/` is the same command with `--experimental`; both ran with a temporary `HOME` and `CODEX_HOME`, never `~/.codex`). Nothing in
`adapter.json` was edited by hand: the 18 mandatory asar edits are **derived** by `adapters/tools/cua-container.mjs`, `managed-config.mjs`, `cua-skills.mjs`
and `cua-peer-auth.mjs`, the 31 binary patches by `binary-patch.mjs` / `cua-container.mjs`, and the UI seams by `seams.mjs`. **Nothing was dropped.**

**This build was a port, not a refresh.** 22943 re-bundled its main process (webpack chunks `early-bootstrap-<n>-<hash>.js` in place of one
`main-<hash>.js`) and minifies it differently (quoted strings, inlined single-use constants, `X().join` / `(0,X.join)`, Yoda comparisons), so none of the
21477 main-process finds occurred verbatim. The derivers were changed to match either spelling and to write each edit in the build's own, with 21477 and
20770 still derived byte for byte (their pack tests); `adapters/tools/js-shape.mjs` (acorn) counts names by binding where a text count was fooled. The
site-by-site mapping is in `docs/research/22943/isolation-edits.md` and `docs/research/22943/ui-seams.md`.

**Checked natively on a 22943 QA copy (2026-11-01).** The copy starts, isolated, with no Keychain prompt; every window's AppHost is held; a
chat turn runs through the relay and the Host (luna, "pong"); `Draft.setContent` fills a chat's composer; the Host reads the app's 191
commands; `qa cli features` reads 775 entries present and 2 unknown, the same two as on 21477 (`binding:page.banner`, `exposure:Select`). A binding
tour (the same screens on 21477 and 22943: home, a chat, the palette, the model menu, settings, Scheduled, three chats with tool steps, the
Changes panel) finds every binding that works on 21477 working on 22943. Two things the copy needed are in the framework, not in this
pack's edits: the relay passes 22943's startup policy read (`codex app-server … --print-startup-config`, one JSON object, before any
window) to the real binary, and the new `main-modules` seam hands framework-main webpack's module cache (`globalThis.__codexmods.mainModules`)
so tables in main's modules (the command table) are found.

## Build identity

| Field | Value |
|---|---|
| version / bundleVersion | 26.1027.30824 / 22943 |
| asarSha256 | `36bf3d2b…` (whole `app.asar`); the header hash equals Info.plist `ElectronAsarIntegrity` (`a452d061…`) |
| electronVersion | 42.3.0, carried from 21477 (the refresh copies it; nothing reads it: the runtime is the app's Chromium build, `Codex Framework` 156.0.8078.48, 21477: 155.0.8059.80) |
| bundled `codex` | `codex-cli 0.166.0-alpha.5.1` (21477: 0.163.0-alpha.11.2) |
| protocol | 106 client requests (21477: 105), 1 client notification, 10 server requests, 85 server notifications |
| main-process scripts | 27 in `.vite/build`: `early-bootstrap.js` and its numbered chunks (the roles: `main` = the chunk that starts the Computer Use helper, `early-bootstrap-916-…`; `src` = another main-process chunk, `early-bootstrap-339-…`; `worker` = `worker.js`); renderer chunks 16,044 (21477: 14,907) |

## What changed from 21477 (the parts the pack depends on)

- **Main process:** re-bundled and minified differently (above). Every site of the 18 mandatory edits is still there; the edits read the same
  except: the container id and two bundle-id sites are inline literals (no constant); the installer path is inlined into its executor, so
  `cua-relocate-installer` replaces the join expression and `cua-disable-locked-use` ends at the executor's call (adjacent finds; the rest of the
  executor is dead code after the throw); the managed edit list is built inline in the tool sync; the app assigns `cua_repl` per thread itself
  only with its local daemon (`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`), so a copy's threads get the copy's own definition; 22943 also writes
  `require-browser-access.mjs` into the shared plugin cache, removed with the `.mcp.json` write (`managed-config-no-persist-cua-repl`).
- **AppHost seam:** the host is passed inline to the AppView factory; the seam adds a binding (`__cmH`) to the declaration list and becomes a `replace-once`.
- **Renderer:** the same rolldown output; small drifts only (a statement or prop added, a helper moved to `app-primary` and imported). The shell's
  components moved from `app-initial` to `app-primary`; the panel width and sidebar show-all exposures follow imports across chunks.

## Mandatory edits (ARCHITECTURE §5.3)

`mandatoryEdits` lists the 4 Keychain/Aura binary patches, the 27 `cua-container:*` binary patches and the 18 asar edits, the same 49 ids as the
21477 pack's (the bundle-id sites again `main:1`, `:2`, `:3`, `src:1`, `worker:1`). The builder's content scan now covers the `early-bootstrap`
chunks (`ASAR_SCAN_PATTERN`).
The Keychain isolation, the Computer Use container, relocation and identity, and the managed-config edits are explained in
`../26.1007.30912-20156/NOTES.md`; what they guarantee is unchanged.

## Census and bindings

Every census family anchors on 22943 (`adapters/tools/census.mjs` finds each vocabulary by what the code holds, in whichever chunk holds it,
in any quote style). Two premises changed: the main process keeps one fetch handler (`set-remote-wsl-connections-enabled`; the rest are
AppHost services since 21477), and the renderer no longer uses shared objects (`state.sharedObjects` is `retired`). Five bindings' calls
gained or lost a prop; their addresses take `optional` keys (`addresses.json`), so one address holds on 20770, 21477 and 22943. 22943 is a
reference build of the feature log (`scripts/features.mjs`).

## Refresh report (generated by builder/refresh-adapter.mjs; the same data is in refresh-report.json)

Derived from 26.1016.62342-21477 on 2026-11-01T22:26:13.042Z. Review everything marked missed; none of it was guessed.

## Transforms

- mandatory isolation edits derived from this build's app.asar (not replayed): cua-relocate-dir, cua-relocate-config, cua-relocate-installer, cua-disable-locked-use, cua-helper-private-home, cua-relocate-approvals, cua-service-path-env, cua-container, cua-bundle-id:src:1, cua-bundle-id:main:1, cua-bundle-id:main:2, cua-bundle-id:main:3, cua-bundle-id:worker:1, managed-config-no-persist, managed-config-no-persist-cua-repl, managed-config-cua-repl-thread, cua-skills-no-expose, cua-disable-cu-peer-auth
- no transform missed

## UI seams

- derived again for this build and applied (atomic groups): jsx, lazy, taps, menus, file-menu, workspace-file-menu, tab-menu, launcher, markdown, markdown-text, copy, copy-origin, command, attach, review-action, pr-create, props:mcp-row, props:model-menu, props:branch-list, app-host, menu-command, main-modules, seam-expose:agent-activity-item, seam-expose:agent-activity-item-row, seam-expose:app-initial, seam-expose:app-primary, seam-expose:app-runtime, seam-expose:app-shared, seam-expose:followup-analytics, seam-expose:settings-content-layout, seam-expose:settings-group
- declared in seams.hooks (abi 1): jsx, lazy, taps, menuItems, menuKinds, launcher, markdown, props, appHost, mainModules, copy, command, attach, reviewAction, pullRequestCreate, exposures

## Backend overrides

- the previous build's app version was replaced by 26.1027.30824 in: backend.configOverrides.mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION

## Anchors

- no anchor fully missed

## Binary patches

- re-derived for this build: 31 (previous pack had 31; none carried forward)
- mandatory edits all present: cua-relocate-dir, cua-relocate-config, cua-relocate-installer, cua-disable-locked-use, cua-helper-private-home, cua-relocate-approvals, cua-service-path-env, cua-container, managed-config-no-persist, managed-config-no-persist-cua-repl, managed-config-cua-repl-thread, keychain-service-name, keychain-service-name-account, aura-fallback-service, aura-fallback-account, cua-container:bin/node_repl:1, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:1, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:2, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:3, cua-container:lib/node_modules/@oai/cua/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:4, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:2, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:3, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService:4, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/MacOS/CUALockScreenGuardian:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/MacOS/CUALockScreenGuardian:2, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app/Contents/MacOS/CUALockScreenGuardian:3, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin:2, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/MacOS/CodexComputerUseAuthorizationPlugin:3, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPluginInstallerTool:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Info.plist:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient:1, cua-container:lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient:2, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:1, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:2, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:3, cua-container:lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/native-pipe.js:4, cua-skills-no-expose, cua-disable-cu-peer-auth, cua-bundle-id:src:1, cua-bundle-id:main:1, cua-bundle-id:main:2, cua-bundle-id:main:3, cua-bundle-id:worker:1

## Protocol

- regenerated: {"clientRequests":106,"clientNotifications":1,"serverRequests":10,"serverNotifications":85}

## Census

- build-facts.json written; families that failed to anchor: bus.fromView, bus.toView, bus.fetchHandlers, state.globalKeys, state.persistedAtoms, state.sharedObjects, settings.slugs, panel.tabKinds, apphost.services, routes.paths, protocol.wireOnly
