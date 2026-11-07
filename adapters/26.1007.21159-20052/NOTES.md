# Adapter pack 1.0.0 for ChatGPT/Codex 26.1007.21159 (20052)

Source of truth: `adapter.json` (generated). Hand-authored parts: `authored.json`. Everything else is re-derived from the
stock app by `adapters/tools/generate-adapter.mjs` (locators in `adapters/tools/derive.mjs`, protocol in
`adapters/tools/protocol-from-schema.mjs`). Regenerate for the next build:

    node adapters/tools/generate-adapter.mjs --app /Applications/ChatGPT.app \
      --schema contracts/upstream/<build>/schema --authored adapters/<build>/authored.json \
      --out adapters/<build>/adapter.json --report /tmp/report.json

Nothing here was verified by running the app (native verification is separate). Static analysis only: the stock `app.asar` was read with
`adapters/tools/asar.mjs` (our own reader; the legacy tools were not needed).

## Build identity

| Field | Value | Source |
|---|---|---|
| version / bundleVersion | 26.1007.21159 / 20052 | `Contents/Info.plist` |
| asarSha256 | `97b8e5fd…9fdb` (SHA-256 of the whole `app.asar`) | file hash |
| asar header hash | `c497f508…0b41f` | equals Info.plist `ElectronAsarIntegrity` (the builder must recompute this for the modified asar) |
| electronVersion | 42.3.0 | asar `package.json` devDependencies; Chromium 155.0.8059.40 from the Codex Framework Info.plist |
| asarPackageJson | `package.json` (`main` = `.vite/build/early-bootstrap.js`) | asar |

## Transforms (5; all exact-input, hash-pinned, `find` occurs exactly once)

| id | seam | file | justification (one line) |
|---|---|---|---|
| `expose-components:app-shared` | components | `webview/assets/app-shared-2f2228189a8d.js` | One insertion before the sourceMappingURL line defines lazy getters on `globalThis.__codexmods.exports` for React, ReactDOM(+client), Button, Switch, Dialog, Tooltip, Icon, SettingsRow, Menu, MenuParts, DialogParts. |
| `expose-components:app-initial` | components | `webview/assets/app-initial-c468e3fd7f91.js` | Same, for TextField and SettingsSection (the two kit components that live in the other chunk). |
| `trusted-view-context` | trusted-sender | `.vite/build/main-39FdJ_vp.js` | `getContextForWebContents` also returns the shared app context for webContents whose URL is `app://-/index.html?…codexmodsView=1`. |
| `trusted-view-sender` | trusted-sender | same | `WindowManager.isTrustedIpcSender` lets those unregistered webContents through the registration test; the main-frame + app-URL test (`x1e`) still applies. |
| `trusted-view-startup` | trusted-sender | same | `StartupRenderer.whenReady` returns at once for such a view (it is never the primary window, so it would throw `AbortError`). |

Each getter calls the lazy-module init function of the section that defines the component (`(init(), local)`), so a mod can
read a component before the app first rendered it. All located locals and init functions are top-level bindings of their
chunk (all but `Dialog`'s local are in the chunk's `export{}` list; `Dialog` is a hoisted top-level function). The
app-shared insertion was evaluated in a `vm` module against the stock chunk (test "exposed components evaluate…"):
`react` is React 19.2.7, `reactDom` has `createRoot` and `createPortal`, and every function above is a function.
app-initial was only parse-checked and export-checked (it imports ~300 chunks).

No `anchor` transform: `settings.section` resolves from the DOM (below). No `preload` transform: V4 is answered by session
preload registration (not verifiable statically); if it turns out not to reach a window, the fallback is one
`preload`-seam transform in `.vite/build/preload.js`.

## Components (`components`, `react`)

Key on `globalThis.__codexmods.exports` = the ComponentName. Evidence is the destructured prop signature of the stock
function (stable across minification).

| ComponentName | Located as | Props signature used to find it |
|---|---|---|
| Button | app-shared `jCe` (init `MCe`) | `{type='button', color='primary', variant='solid', pill, squircle, uniform, size, loading, selected, …}` |
| Switch | app-shared `sji` | `{checked, onChange, disabled, className, id, ariaLabel, size, tone, trackClassName, thumbClassName, onClick}` (`role=switch`) |
| TextField | app-initial `tk` | `{autoSize, id, ref, type, leadingControl, valueSuffix, trailingInlineControl, trailingControl, variant, focusRing, …}` (renders `<input>`) |
| Dialog | app-shared `qMi` (the root; `QMi` with a capital Q is its content panel) | `{children, modal, autoFocusCloseButton, triggerContent, triggerAsChild, triggerRef, contentClassName, showDialogClose, variant, size, …rest}`; `open`/`onOpenChange` reach the Radix root through the rest props |
| Tooltip | app-shared `w5` | `{tooltipContent, shortcut, side, align, open, onOpenChange, children, …}` |
| Icon | app-shared `s5` | `{className, icon, legacyClassName, size}`; `icon` is an app asset record (`{assets:{16,20}}`), not a name |
| SettingsRow | app-shared `qBi` | `{label, labelSizing, labelWeight, layout, description, control, controlSizing, icon, …}` |
| SettingsSection | app-initial `O6s` = `Object.assign(root,{Header,Content,Footer})` | root `{children,id,className}` renders `<section id>`; Header `{title,subtitle,actions,…}` |
| Menu | app-shared `p7` (the Dropdown: `{triggerButton, disabled, children, loadingContent, open, onOpenChange, side, align, …}`) | Menu items are the namespace `y7` (`Trigger, Content, Item, CheckboxItem, RadioItem, Separator, SectionLabel, SubmenuItem, …`) |
| react / reactDom | app-shared CJS wrappers `o()` (React) and `{..._de(), ...vde()}` (react-dom + react-dom/client) | found from `e.useSyncExternalStore=`, `e.createPortal=`, `e.createRoot=` |

**Convention (not in `ComponentName`):** the exports key `MenuParts` carries `y7`; the runtime attaches it to `ui.components.Menu`
as static members (`Menu.Item`, `Menu.Separator`, …). `DialogParts` carries `{Header: pNi, Body: mNi, Footer: hNi}` (`{icon,title,subtitle,…}`, `{children,className,size,variant}`, `{children,className,expandSingleButton,variant}`), attached the same way as `Dialog.Header/Body/Footer`.

### Missing (components)

- **Select** — missing. The app has no standalone select control: its settings selects are the Dropdown (`p7`) with `y7.Item`
  children. Tried: `role=combobox`/`role=listbox` wrappers (one in app-initial is an autocomplete), `SelectTrigger`, native
  `<select>`; the segmented selector `bYc` (`{options, selectedId, onSelect}`) is a different control. The runtime supplies a themed fallback.

## Anchors

Selectors are derived from `data-*` attributes, ARIA and structural classes in the bundle. **Confidence is static only.**
Placement is the default when `mount()` gives no `position`.

| Anchor | Selectors (first match wins) | Placement | Evidence / confidence |
|---|---|---|---|
| settings.section | `body:has([data-settings-panel-slug]) main[data-app-shell-main-surface]`; `… [data-app-shell-main-content-layout]` | inside | `data-settings-panel-slug` is set only on the Settings nav entries (settings-page chunk); the settings page renders inside the `main` surface. **Medium**: appends after the page content; the Adjustments nav entry itself is not added (see below). |
| sidebar | `nav[role="navigation"][class*="_Navigation_"]`; `[data-app-shell-page-sidebar]`; `[data-app-navigation-rail]` | inside | `<nav role=navigation aria-label="Chat history" class=_Navigation_…>` in app-initial. **High**. |
| sidebar.footer | `nav[…_Navigation_…] > div.absolute.inset-x-0.bottom-0`; `[data-app-shell-page-sidebar] div.absolute.inset-x-0.bottom-0` | inside | The footer wrapper `div.absolute.inset-x-0.bottom-0.z-20` inside that nav (account/usage control); no data attribute exists. **Low–medium** (class based). |
| titlebar | `[data-app-shell-titlebar]`; `[data-app-shell-main-titlebar]`; `[data-app-shell-titlebar-slot="main"]` | inside | Three distinct attributes on the header strip in app-initial. **High**. |
| thread.header | `[data-app-shell-header-toolbar]`; `[data-app-shell-page-header]`; `[data-app-shell-titlebar-content]` | inside | The flex toolbar in the main header (`justify-between`); the thread chrome chunk renders `role=toolbar` with `data-app-shell-titlebar-content`. **Low–medium**: the toolbar also exists on non-thread pages. |
| thread.footer | `[data-codex-composer-root]`; `[data-composer-layout]` | after | The app has no separate thread footer; the region below the composer is the closest. **Low** (derived, not observed). |
| composer | `[data-codex-composer-root]`; `[data-composer-layout]`; `[data-codex-composer]` | before | `data-codex-composer-root` wraps the composer in app-primary; `[data-codex-composer]` is the editor wrapper used by the app's own focus logic. **High**. |
| workspace | `[data-app-shell-workspace-layout]`; `[data-app-shell-main-content-layout]`; `main[data-app-shell-main-surface]` | inside | The legacy profile used `main.main-surface` and `[data-app-shell-main-content-layout]`; both exist in 20052. **High**. |
| statusbar | none | – | **missing**: the app has no status bar. Tried: `statusbar`, `status-bar`, `StatusBar`, `data-*status*`, composer footer (`data-composer-footer-layout`, rejected: it is part of the composer, not an app-level bar). The runtime marks any mount at `statusbar` degraded. |

Every `data-*` token in these selectors is checked against the stock renderer by `adapters/tools/adapter.test.mjs`.

### Missing (anchors / settings integration)

- **A nav entry for Adjustments in Settings.** The legacy profile did this with ~20 route/nav edits (slug lists, route
  loaders, messages, visibility, host affinity). Not authored: the assignment prefers a pure DOM `settings.section` and
  allows an `anchor` seam only if that fails. Consequence for L4: Adjustments renders inside the Settings page content area
  and must offer its own entry point (for example a row it appends), not a native nav item. An `anchor` transform can be
  added later without changing any contract (the stock slug list `x4a`/`An` and loader map `k1c` of the old build moved; they would be re-derived).
- **The app's command palette** is not exposed (no adapter field exists for it), so commands always appear in the framework palette.
- **App shortcut list**: no adapter field, so conflicts with app shortcuts are not detected (only between mods).

## Theme

Defined at `:where(:root,[data-theme])` in `app-shared-9a94b907ed47.css` (light/dark by `data-theme` on `<html>`, which the
app sets with `documentElement.dataset.theme`; user accent colors arrive as `--app-color-*` inline properties that the same
variables alias).

| Token | CSS custom property | Note |
|---|---|---|
| background | `--color-token-main-surface-primary` | = `--app-color-background-surface` |
| surface | `--color-surface` | |
| text | `--color-text` | |
| textSecondary | `--color-text-secondary` | |
| border | `--color-border` | |
| accent | `--color-ring` | follows the user's accent (`--app-color-border-focus`); `--color-chart-blue` is the fixed-blue alternative the Switch uses |
| danger | `--color-text-danger` | |
| fontFamily | `--font-sans` | `@layer theme`, from `--font-ui-family` |
| radius | `--radius-md` | |

## Actions (`adapter.actions`)

Value syntax: `<impl>:<selector>`, where `{id}` is replaced by the escaped `args.id`:

- `composer.insertText` → `dom.insertText:[data-codex-composer] .ProseMirror` (the composer is a ProseMirror editor; the app itself looks up `.ProseMirror` under `[data-codex-composer]`).
- `composer.focus` → `dom.focus:[data-codex-composer] .ProseMirror`.
- `thread.currentRoute` → `dom.currentRoute:[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]`. Returns the app route string.
  **The URL cannot answer this:** the router is a *memory* router (`createMemoryRouter`/`createMemoryHistory({initialEntries})` seeded from `?initialRoute=` or
  `<meta name=initial-route>`), so neither `location.pathname`, `location.search` nor `location.hash` changes after startup (the only hash use is a `referrer` query for analytics).
  The action therefore reads the selected sidebar row (id `local:<host>:<id>` | `local:<id>` | `remote:<id>` → `/local/<id>?hostId=<host>` | `/remote/<id>`), and falls back to the
  window's own `initialRoute` search parameter (framework route views). `Unavailable` when no thread is selected (for example on a settings page). **Medium** confidence.
- `thread.open` → `dom.click:[data-app-action-sidebar-thread-id="{id}"]` (sidebar thread rows carry that attribute). Only reaches threads currently rendered in the sidebar. **Low–medium.**

## Backend (contracts v1.2)

`method: override`, `configKey: CODEX_CLI_PATH`, real binary `Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, Host node `Resources/cua_node/bin/node`,
`owl: {iniPath: Resources/owl-app.ini, userDataDirectoryName: 'ChatGPT Mods'}` (values from the builder's probes; not derived by the generator).
Static evidence that agrees: `Resources/codex-cli/bin/codex` is a 328-byte `sh` wrapper that `exec`s `../CodexCLI.app/Contents/MacOS/codex`, and the main bundle honors
`process.env.CODEX_CLI_PATH` (trimmed absolute path) in at least two places (`IS()` and the runtime resolver `sa({rawValue:e.CODEX_CLI_PATH})`; one is gated on `!isPackaged`).

## Platform facts discovered while deriving

1. **CSP**: `webview/index.html` has a `<meta>` CSP with `script-src 'self' 'sha256-…' 'wasm-unsafe-eval' …` and
   `connect-src 'self' …`. A page-initiated `import('codexmod://…')` is blocked unless the `codexmod` scheme is registered
   with `bypassCSP: true` (plus `standard`, `secure`, `supportFetchAPI`, `corsEnabled`) and the protocol handler answers with
   `Access-Control-Allow-Origin` (the page origin is `app://-`, so module requests are cross-origin). The app registers its
   own schemes in `browser-background-switches-*.js` (`registerSchemesAsPrivileged([{scheme:'app',…}])`), and the Sentry
   bootstrap already wraps `protocol.registerSchemesAsPrivileged` in a Proxy to append its own scheme; framework-main
   (framework-main) must do the same for `codexmod` before `app.ready`. The `app` scheme has **no** `corsEnabled`.
   The framework's own scripts do not depend on this: the preload injects them with `webFrame.executeJavaScript`, which is not subject to the page CSP.
2. All app windows use `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`: the framework preload runs sandboxed
   (no `fs`); it can use `ipcRenderer`, `webFrame` and `contextBridge` only.
3. The app's own routing for a framework split view is `app://-/index.html?initialRoute=<route>`; `x1e` (main) trusts any `app://-` main frame, and only the registration test needed patching.

## Contract gaps seen while deriving

- `ProbeReport.appBuild` has no stated format; the runtime uses `<version>-<bundleVersion>` (the adapter directory name).
- `AdapterPack.components` cannot express a sub-part such as `Menu.Item`; the `MenuParts` exports-key convention above fills that gap.
