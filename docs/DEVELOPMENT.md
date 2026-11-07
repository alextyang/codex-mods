# Development

How to build, test and natively check the framework. Authority: [AGENTS.md](../AGENTS.md) and [ARCHITECTURE.md](../ARCHITECTURE.md). Running a daily copy is in [OPERATIONS.md](OPERATIONS.md).

## Machines

- **Your Mac (your own account).** Edit, commit and run the headless test suite here. It never launches the app or touches your Keychain or `~/.codex`.
- **The QA machine, as the QA user (UID 503).** The isolated QA machine for native runs: building, signing and launching QA copies with `scripts/qa.mjs`. It has the same checkout path on a shared volume. `node` is not on PATH in a non-login ssh session, so use `PATH=/opt/homebrew/bin:$PATH`. Run git on this Mac rather than over ssh, so file ownership stays consistent.
- **Your daily copy** (see OPERATIONS.md) is not for checks: use the QA copy.
- The hard lines in AGENTS.md apply everywhere.

## Tests

```
CODEXMODS_REAL_MODULES=1 npm test        # locally
ssh <qa-host> 'cd "<checkout>" && PATH=/opt/homebrew/bin:$PATH CODEXMODS_REAL_MODULES=1 npm test'   # on the QA machine
```

- `npm test` runs `node --test` over every `*.test.mjs` under `sdk`, `contracts`, `loader`, `relay`, `framework`, `adapters`, `builder`, `cli`, `mods` and `tests`. Tests that need a stock bundle find it through `adapters/tools/stock.mjs`: `CODEXMODS_STOCK_ASAR`, then an extraction at `.tmp/asar-<bundle>/`, then `/Applications`; without one they skip. The suite is headless, using the strict fake app-server (`tests/fixtures/fake-app-server.mjs`), and needs no app. The fake refuses what it does not model, and its modelled payloads match the schema of every build since 20770 (`tests/fixtures/schema-check.mjs`; `buildsSince` in `tests/fixtures/captures.mjs` lists them, so a build added to `contracts/upstream/` joins the shape checks of the presenter's codecs, the fake and the captured payloads on its own). With `FAKE_APP_SERVER_CAPTURE=<file>` it replays a capture instead (below).
- Run it in both modes. `CODEXMODS_REAL_MODULES=1` makes the integration harness (`tests/integration/harness.mjs`) boot the Host with the real modules; with `0` or unset it replaces the Host's other modules with test doubles. The expected result in each mode is **0 failures and 1 skip**: the real login-keychain round trip. It is opt-in, with `CODEXMODS_TEST_LOGIN_KEYCHAIN=1`, because it writes and deletes a test item in the running user's login keychain.
- Focus a run with `node --test "<dir>/**/*.test.mjs"`. Tests clean up the processes, sockets and temp dirs they create, and use fresh `fs.mkdtemp` roots.
- Adapter tests marked `stock:` read the installed stock app (read-only, never launched) and skip when it is not the pack's build.
- Do not launch the native app, sign in or send model traffic from automated tests.
- `tests/graph-docs.test.mjs` checks that the object graph plan in `docs/graph/` stays consistent. Run the check on its own with `node scripts/graph-check.mjs`, which lists any problem by file and name.
- `node scripts/features.mjs` regenerates the feature log (`framework/host/features/log.json`, docs/design/systems.md E4) after a change to what the framework's code reaches in the app, its providers' `realizes`, the bindings or a pack's census; `--units` prints what the scan found per unit, and `--check` (run by `framework/host/features/test/log.test.mjs`) fails when the log is not current or a unit's residue is not declared (`framework/host/features/units.mjs`, `declarations.mjs`).
- `node scripts/coverage.mjs` (`--json`) counts the graph's members by state, per feature area and in total (docs/design/breadth.md §3): declared in the native library, implemented by the native provider (`providers/codex/realizes.mjs`) or a binding, verified natively (the ledger `docs/coverage/verified.json`, and the censuses the QA mod `qa.graph-census` writes in a QA copy), or excluded with a reason. `tests/coverage.test.mjs` checks the ledger.

## Captures of the real app-server

A capture (`tests/fixtures/captures/<name>-<build>.json`, format `codexmods.capture/1`, documented in `tests/fixtures/captures.mjs`) is
one recorded script per app-server session. Each step is a client request with its answer, a client notification, a server
notification, or a server request with the client's answer. The strict fake replays it exactly and refuses anything off-script.
`tests/fixtures/captures-replay.test.mjs` replays every capture to its end. It also checks every captured payload against the
build's schema, experimental methods included (`contracts/upstream/<build>/schema-experimental/`).

**Recording** happens on the QA machine, as the QA user, in a QA copy:
1. Install the recorder mod `scripts/qa/mods/qa.record` (copy it into `~/cmq/qa/mods/`, then `mods install --dev`, then
   `consent --approve --enable`, with the Host running). It writes every frame the mux sees to its data directory
   (`frames.jsonl`, mode 0600, unredacted except the credential-bearing methods). The file never leaves the QA machine.
2. Note the recording's line count, drive the traffic, for example one lease connection through `scripts/qa/lease.mjs` (`${n.path}`
   references earlier results, `$sleep` waits, `--answer` answers server requests), and note the end.
3. Convert the slice: `node scripts/qa/capture.mjs --frames <frames.jsonl> (--client client:<leaseId> | --session <n>) --from <i>
   --to <i> --source <QA record> --doc <text>`. It pairs requests with their answers, drops ids, applies the sanitization rules
   S1 to S4, and refuses a capture that still breaks one. Steps it reconstructs are marked `synthetic`, for example a lease
   client's `initialize`, which the mux answers itself.
4. Read the result before committing it: the rules do not cover conversation text, tool catalogs, hostnames or remotes. Write a
   path in the home folder as an absolute path, because `~/` breaks S3.

Captures need live model traffic for turns: use `gpt-6-luna`, with one-word answers where possible.

## The QA harness (`scripts/qa.mjs`)

Run it as UID503 with a short absolute root (the Unix socket paths must stay under 104 bytes), for example `~/cmq`:

```
ssh <qa-host> 'cd "<checkout>" && /opt/homebrew/bin/node scripts/qa.mjs <command> --root ~/cmq [--json]'
```

It refuses other UIDs and unsafe roots (system directories, `~`, `~/.codex`, Group Containers, `Application Support/Codex`). Exit codes: 0 ok, 1 failure, 2 usage or Host not running, 3 isolation violation, 4 Keychain prompt detected.

| Command | What it does |
|---|---|
| `setup [--rebuild] [--diag]` | Creates the QA profile with the real `codexmods setup` (ad-hoc identity, isolated `codex-home` and `userData`), installs this checkout and builds the copy with the QA-only build policy: `--qa-no-restore` (`NSDisablePersistence = true` in its signed Info.plist) and `--qa-socket-dirs` (main's `/tmp/codex-app-tools` and `/tmp/codex-browser-use` socket directories move to `<profile>/run/app-tools` and `<profile>/run/browser-use`, or a short directory in the user's `$TMPDIR` when a socket path would exceed 103 bytes; adapter NOTES N8). An older selected copy without this policy is rebuilt automatically. Writes `[features] computer_use = false` into the profile's config and removes any stale Computer Use helper under `codex-home/computer-use`. The setting turns off the Computer Use feature only: the copy still starts its own helper when appshots or Chronicle are on for the account (ARCHITECTURE §5.3). `--rebuild` forces a fresh copy (a `-r<N>` directory when the matching one is protected) and repoints the launch symlink, recording the target it replaced in `<root>/qa/previous-app`. Every successful `setup` then removes the superseded copies of the build (about 1.8 GB each): a plain `setup` after a framework change builds a copy for the new framework but does not select it, so that copy goes too. It keeps the launch target, the previous target, the LKG (`lkg-app`), any copy a boot record names (`generations/<n>.json`), any copy a running process uses and an unfinished build younger than an hour; copies of other builds are kept. The result lists them under `pruned`. `--diag` prepends `scripts/qa/diag/prelude.cjs` to the copy's loader (log: `<root>/qa/diag.log`). |
| `launch [--keep] [--fast] [--cu-refresh] [--noenv] [--guard]` | Opens the QA copy, waits for readiness, runs the isolation checks and writes `qa/last-launch.json`. |
| `status` | Reports any QA main process launched outside the harness (exit 3, even without a Host), with its pid and the stop/relaunch instruction; otherwise management diagnostics, `mods.list`, `compat.report` and `updates.status` of the running Host. |
| `screenshot <name>` | `screencapture` into `<root>/qa/shots/<name>.png`; reports "unavailable" without a GUI session. |
| `stop` | Graceful quit, then SIGTERM, then SIGKILL, and verifies that nothing owned remains. Afterwards removes this root’s QA app entries from both user and current-host `loginwindow` relaunch lists and disables persistence for the copy’s bundle id, even if nothing was running. Cleanup failure exits 1. Once nothing owned remains, it also deletes the copy's leftover temp files, `<user temp dir>/.dev.codexmods.app.XXXXXX` (`tempFiles` in the result). They come from the stock app, which reads its webview with `fs.createReadStream` inside `app.asar`. Electron extracts each such file to a temp file it never deletes: about 950 files (50 MB) per launch, on the stock app too. A running copy reuses those paths, so nothing is deleted while any modded copy of the QA user runs. |
| `cli <args…>` | Runs `cli/codexmods.mjs` against the QA root (`--root` is consumed here). |
| `control` | Diagnostic only: builds and launches a stock-equivalent copy with no framework and reports whether an AppleScript quit works. |
| `setup --identity <name>` | Signs the QA copy with that identity instead of ad-hoc. Only a team-signed copy gets the Computer Use app group (ARCHITECTURE §5.3), so Computer Use runs only in such a copy. The identity must be in the QA user's dedicated keychain `qa-signing.keychain-db`, created by `scripts/qa/signing-keychain.sh <identity.p12>` (run once as the QA user with `ssh -t`; empty keychain password, partition list allows codesign, so signing never shows a dialog). Grants made in System Settings hold across rebuilds, because the designated requirement is stable. Without `--identity`, `setup` keeps the identity the profile already has, so a team-signed profile never falls back to ad-hoc. |
| `setup --probe <name>` | Diagnostic only: prepends the QA probe `scripts/qa/probe/<name>.cjs` to the copy's loader (combines with `--diag`). `native` probes the app's mechanisms for the realization map (docs/design/realization/). G-apphost: one load-time edit at the app's `connect-app-host` listener, anchored on the method names `createAppHost` and `registerAppView`, holds each window's AppHost and AppView session. G-bus: observes `message-from-view` and `message-for-view` by channel name. G-jsx: edits the renderer's JSX factory as it is served, so each call consults an optional page hook. Log: `<root>/qa/probe/probe.log`. |
| `probe '<json>'` | Sends one command to the running probe and prints its answer. Commands: `{"op":"views"}`; `describe` and `call` with a `path` into the window's AppHost services (`["appInfo","get"]`) and `args`; `action` with the app action to run (`{"action":{"type":"app.get_summary","windowId":"current"}}`); `viewServices`; `readState` (optional `options`, `state`) opens a framework session on AppHost `threadReadState` and reports its events (and sets `state` when given); `termTest` (optional `command`, `cwd`) runs a framework terminal session through the window's AppHost `terminal`; `mgrDescribe` and `mgrCall` with a `path` into main's window manager (held at the listener); `wrap` with `["service"]` or `["service","method"]` and `mode` `log` or `refuse` (that window only); `unwrap`; `wrapBoot` with a `path` and `mode` (or `clear: true`) applies a wrap at every hold, so a reload records the calls a window makes while loading; `busStats`; `busLast` with an optional `type` (the last five payloads per bus message type, protocol and fetch traffic excluded, except the last payloads of content-free notifications under `mcp <method>`: status, rate limits, queue, settings, read state, token usage); `fetch` with a handler `name`, `body`, optional `headers` and `max` (result size) (git handlers need `x-codex-git-source`) (through the app's own handler); `send` with a host `message` for the window. `post` delivers a renderer `message` to the app's own `message-from-view` handler. `worker` with `method`, `params` (and `workerId`, default `git`) sends a request to one of main's workers and returns its response. `text` returns the window's visible text (optional `selector`, `max`). `count` with a `selector` counts matching elements (`deep: true` also searches open shadow roots). `focus` describes the focused element. `attrs` (`selector`, `names`, `n`) returns attributes of the first matches; `css` (`selector`, `props`) returns computed CSS properties, custom properties included. `refuse` with a `list` (`fetch:<handler>` entries refuse those fetch handlers with an error; other entries drop bus messages of that type) reports the refusals made. `menus` (optional `append`) reports the native context menus requested (items, options) and appends a framework item when `append` is true; `console` returns the renderers' recent warnings and errors (optional `match`, `max`, `clear`). `click` with a `selector` and a `text` prefix clicks the innermost matching element (or the one at `index`). `count` also reports `aria-checked`, `aria-label` and the surrounding row text of the first five matches. `key` sends a synthetic key press (`key`, `modifiers`). `pointer` sends a real mouse press at the centre of the first match of `selector` (or the `index`th; `deep: true` also searches open shadow roots): `button` left opens a menu trigger that listens for pointer-down, right takes the app's own context-menu path (answer it with `menus` `choose` to avoid a popup). `jsx` with a `plan` (`passthrough`, `census`, `decorate`, `decorate-live` with `live-on` / `live-off`, `decorate-message`, `banner`, `inject`, `replace`, `throw`, `off`, `stats`, `reset`) (also `watch`) drives the G-jsx seam, which the probe adds to the renderer's JSX factory as main serves it. `composer` with `do` (`read` or `insert`, with `text`) uses the composer controller the `watch` plan captured; `jsxWatch` with `props` (a list of prop names) configures the `watch` plan; `jsxCaptured` with a `prop` (and `depth`, default 3; `field` for another key of the same props) returns the value the `watch` plan last captured for it, as plain data; `jsxInject` with `rules` (`[{prop, mode: set|wrap|append|items|after|null|empty|replace, text?, labelId?, attr?, nav?, path?}]`) configures the `inject` plan; `jsxBoot` with a `plan` (or none) stores it in the window's `localStorage`; the served chunk installs it before the first render on the next load; `reload` reloads the window. `scroll` scrolls an element (`selector`, default the transcript's scroller) by `y` pixels, `count` times, `every` ms apart, from inside the page; `wheel` sends trusted mouse-wheel input (`deltaY`, `count`, `every`) at the centre of the same element (the app pages its history only on a user's scroll). `perf` with `do` (`start` or `stop`) records the page's frame intervals and reports their spread. `win` with `do` (`minimize`, `restore`, or none) changes or reports the window's focus state. `rects` with `selectors` returns each one's count and first box; `cssvar` with a `selector` and `names` returns computed values; `winSize` with `w` and `h` sets the window's content size (none reports it); `drag` with `phase` (`down` at a `selector`'s centre or `x`/`y`, `move` by `dx`/`dy` in `steps`, `up`) is a trusted drag (the window must be in front); `wl0` with `do` (`scopes`, `titlebar`, `kinds`, `tabs`, `route`, `route-add`, `route-remove`, `mode`, `drag`, `fiber` with `args: {selector, depth}`: the components above an element, each with its props' keys) runs the layouts WL0 experiments over the framework's exposures (docs/research/layouts/wl0-probes.md). `tapBoot` with `on: true` (or false) adds one QA command (`codexmodsQaTap`) to the command table and the default handler map from the next load; `tapStats` reports its runs. `lazyBoot` with a `plan` (`census`, `wrap-command-menu`, `wrap-delete-dialog`, or none) drives the G-lazy seam from the next load; `lazyStats` reports the lazy loads seen. `app` with `do` (`state`, `toast`, `modal-open`, `modal-close`, `tab-open`, `header-add`, `header-remove`, `cmd-override`, `cmd-release`, `runs-on`, `runs`, `runs-off`, `slash-add`, `slash-remove`, `slot-set`, `slot-clear`, `routes`, `route-add`, `route-remove`, `banner-off`, `tabs`, `tab-close` or `tab-close:<id>`, `tab-decorate`, `tab-undecorate`, `tab-durable`, `tab-durable-open`, `open-wrap`, `open-unwrap`, `ime-start`, `ime-check`, `ime-end`, `modal-block`, `page-stats`, `page-parts:<csv>` (the framework page's shell parts), `settings-route-add`, `settings-route-remove`, `kinds`, and `kind-hide`, `kind-body`, `kind-overwrite` or `kind-restore` with `:<kind>`) uses the G-app exposures of the app's own mechanics. `elStats`, `elSet` (`suppress`, `badgeOverride`, `appendMenu`), `elNotify` (optional `path`: a click navigates there) and `elClicks` drive the G-el wrappers on Electron's menu, Dock badge and notifications. `menuFind` with a `label` lists matching application menu items with their accelerators. An optional `wc` picks the window. |

`launch` flags:

- `--keep` keeps the app running after a failed launch (an isolation violation, exit 3, still stops it).
- `--fast` skips the +20 s and +45 s isolation re-checks that run after sign-in. It is not needed to get past the copy's own helper (m3 session 2, D3, fixed): the re-checks accept it.
- `--cu-refresh` lets the first-boot Computer Use helper install happen (it omits `CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH`); the helper is accepted only under the profile's `computer-use/` directory.
- `--noenv` omits `CODEX_SPARKLE_ENABLED=false` and the skip variable from the launch environment, and asserts instead that no updater process or appcast fetch appears. It proves the copy suppresses its updater on its own.
- `--guard` turns the profile's concurrency guard on for this launch only (`profile.json` is restored afterwards), so the guard dialog can be exercised. Fixture processes that the run starts on purpose are excluded from the ownership and isolation checks.

Every launch passes `--user-data-dir` from the profile and `--use-mock-keychain`, so a harness launch never touches a Keychain item. It also uses `open -F`, `-ApplePersistenceIgnoreState YES`, `-NSDisablePersistence YES` and `-NSQuitAlwaysKeepsWindows NO`. Setup, launch and stop apply the same QA-user-only persistence preferences and remove stale `TALAppsToRelaunchAtLogin` entries by app path under this root; other apps and other loginwindow settings survive. No global Resume setting is changed. These preference operations refuse every UID except 503, independently of the test-only `QA_ALLOW_UID` override, and verify writes by reading them back.

**Always launch through `qa launch`, including after a reboot or GUI login.** Each launch supplies a fresh `CODEXMODS_QA_LAUNCH_ID` and records it with the main pid in `qa/harness-launch.json`. Status and isolation checks reject a QA main process without that matching receipt and environment, including a second restored copy outside the harness process group. Run `qa stop --root <root>` followed by `qa launch --root <root>` if status reports `outside-harness`; keep its failure report. Stop clears the receipt when the processes are gone. Do not open the app or launch symlink directly. The build opt-out is QA-only; `codexmods setup --daily --qa-no-restore` (or `--qa-socket-dirs`) is refused. `NSDisablePersistence` has [documented use by Mozilla](https://bugzilla.mozilla.org/show_bug.cgi?id=967970), rather than an Apple public Info.plist contract, so a native logout/login check on the pinned QA build remains the acceptance check for macOS Resume behavior.

The harness runs strict isolation checks at launch, +20 s and +45 s: nothing held open in a stock user-data directory or `~/.codex`, only the copy's own Computer Use container, and no updater. Every `CODEX_HOME` must be the profile's `codex-home`, except on the copy's own helper: a helper process that runs from `<profile>/computer-use` must have the profile directory as `CODEX_HOME` (`cua-helper-private-home`), and the service (`SkyComputerUseService`) is refused anywhere else or without that value (`helper-home`). The launch result's `info.computer-use` counts the helper's files, processes and private homes. It also watches for Keychain prompts: if one targets a QA process, the app is stopped, the dialog is dismissed and the launch exits 4. **A person must never need to answer a Keychain prompt.**

### An update in the QA copy (docs/design/systems.md E5)

The QA copy never touches the installed app, so a "new stock build" is a clone of it under the QA root with its build bumped:
`cp -c -R /Applications/ChatGPT.app ~/cmq/qa/stock/ChatGPT.app` (an APFS clone; the source is only read), then
`plutil -replace CFBundleVersion -string <n+1> ~/cmq/qa/stock/ChatGPT.app/Contents/Info.plist`. Run `qa setup` while the profile has no
`stockApp` (so the copy stays on the installed build), then set the profile's `stockApp` to the clone and `qa launch`: once the boot is
healthy the detector offers the clone's build and stages it (`qa cli update status|stage|apply [--anyway]|later|policy`). `qa setup --stock
<app>` builds the copy itself from a clone. A framework release for QA is a directory of release trees (the profile's `updates.source`
`{kind: 'dir', path}`): a copy of an installed framework tree with its `package.json` version raised, a `release.json` `{version, treeHash,
mods?}` (`frameworkTreeHash` of the tree; signed `.codexmod`s it ships under `mods/`, each with its sha256), offered when checked
(`qa cli update check`) while the running framework is a development one. QA setup puts `--use-mock-keychain` in the profile's
`launchArgs` (every relaunch, the swap helper's too, carries it) and names the QA signing keychain (`signingKeychain`), which staging
unlocks in the app's session before it builds. The update's state is `<profile>/updates/state.json` (three staging attempts an offer a day).

## Computer-use automation (CUA)

UI automation of the QA copy uses the QA machine's own driver:

```
ssh <qa-host> '/Applications/CuaDriver.app/Contents/MacOS/cua-driver call <tool> <json>'
```

Target only the QA app's pid (from `qa status` or `qa/last-launch.json`). The driver needs a GUI session on that Mac. Some checks cannot be automated, such as the native file chooser and input-method composition, and are done by hand.

## Live model traffic

Manual native checks may send live turns, preferably with `gpt-6-luna`. Use a larger model only when a check needs it. Automated suites never send live traffic; they use the fake app-server and recorded captures.

## Adapter refresh for a new stock build

An adapter pack (`adapters/<version>-<bundleVersion>/`) is per stock build. When the stock app updates, the copy keeps working on its old build until a pack for the new one exists (ARCHITECTURE §12.3, §15).

1. **Refresh.** With the new stock app installed (it is only read):

   ```
   node builder/refresh-adapter.mjs --previous adapters/<old>/adapter.json --stock /Applications/ChatGPT.app --out adapters/<new>
   ```

   (A running copy does the same automatically on **Prepare ChatGPT \<version\>**, or `codexmods app prepare`, writing under the framework root.) It regenerates the protocol catalog from the new binary, **derives** the mandatory asar edits from the new asar (`adapters/tools/cua-container.mjs`, `managed-config.mjs`: string anchors and structure, ids and files by role), re-checks every other transform against the new asar, re-derives the binary patches, runs the census (`adapters/tools/census.mjs`, integration.md §9), and writes `adapter.json`, `refresh-report.json`, `NOTES.md` and `build-facts.json`. The schema of the build goes to `contracts/upstream/<build>/schema/` (`HOME=<tmp> CODEX_HOME=<tmp> <app>/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server generate-json-schema --out <dir>`, the stable schema), and the same command with `--experimental` goes to `schema-experimental/`.
   The census anchors 20 families of facts by strings and structure (bus messages in both directions, fetch handlers, IPC channels, global-state, persisted-atom and shared-object keys, command ids, settings slugs, panel tab kinds, item types, AppHost services, routes, i18n ids, `data-app-*` attributes, the protocol with its wire-only methods, and the JSX, lazy-loader and React choke points). A family that matches its anchor 0 times or more than expected is written as failed, with no values; compare each family's `count` and `digestSha256` with the previous build's to see what changed. `node adapters/tools/census.mjs <app.asar> <schema> <schema-experimental>` runs it alone.
2. **Review the report.** Dropped transforms (shipped degraded), the declarations dropped with them (components, React, host seams), unverified or missed anchors and unresolved items are listed there. Anchors and components are re-checked at runtime by the probe report. Add what differs from the previous build, the decisions taken and the open items to the pack's `NOTES.md`.
3. **Isolation baseline.** Every mandatory edit (Keychain names, Computer Use relocation, identity and container, locked-use removal, managed config) must still be derived and listed in `mandatoryEdits`. If one cannot be, the refresh writes no pack and fails. Never work around that by editing the pack by hand: fix the deriver (`adapters/tools/`) so that it locates the edit again by string anchors and structure, with a test that it still fails closed when the anchor is absent, duplicated or changed. `builder/build.mjs` re-checks the baseline and runs the content scan on every build (ARCHITECTURE §5.3).
4. **Regenerate from source** when more than a refresh is needed: `node adapters/tools/generate-adapter.mjs --app /Applications/ChatGPT.app --schema contracts/upstream/<build>/schema --authored adapters/<build>/authored.json --out adapters/<build>/adapter.json` (upstream schemas come from the build's own `codex app-server generate-json-schema`).
5. **Check and record.** Add `adapters/tools/adapter-<bundle>.test.mjs` (a `definePackTests` call like the other packs') and the build to `BUILDS` in `adapters/tools/census.test.mjs`, with the facts that differ from the previous build.
   The refresh writes the pack in a private (0700) directory: set its directory to 755 and its files to 644, because the QA user reads the same checkout. `framework/host/mux/method-classes.test.mjs` fails until every client
   request of the new schema is classified. Run the full suite (the stock-app adapter tests exercise the new pack), build a QA copy with `qa setup --rebuild`, `launch` it, and confirm that `status` reports the expected compatibility for each mod. Record what differs from the previous build in the pack's `NOTES.md`, and commit the pack.

## The public tree

The public repository is one squashed snapshot of this one, without its internal working notes (GOAL.md, docs/DELEGATION.md,
docs/design/, docs/research/):

```
node scripts/release/public-tree.mjs <empty folder> --commit --author "Name <noreply email>"
```

It swaps in the neutral contributor guide (`scripts/release/AGENTS.public.md`), turns links to the notes it leaves out into plain text, and
marks the coverage ledger's proofs in them `history:`. Run the suite in the result before publishing it (`tests/release.test.mjs` covers
the rewriting).
