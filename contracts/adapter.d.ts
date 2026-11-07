// Adapter pack: adapters/<version>-<bundleVersion>/adapter.json (ARCHITECTURE.md §15).
// Authored by hand (anchors, components, theme, transforms) with the protocol section derived from contracts/upstream/.
// Consumed by the builder (transforms, backend), the Host (protocol), the renderer runtime (anchors, components, theme).
import type { ComponentName } from '../sdk/index.js';

/** Where the framework's own mounts go, by selector: its recovery entry in Settings, its band over the workspace; the sidebar says the app's shell is on screen. */
export type AnchorName = 'settings.section' | 'sidebar' | 'workspace';

export interface ProtocolCatalog {
  handshake: { request: 'initialize'; notification: 'initialized' };
  /** Dotted paths read from a message to find its affinity key; first hit wins. v1: ["params.threadId"]. */
  affinityKeyPaths: string[];
  /** Responses that create a key: the key is read from result at resultPath. */
  affinityCreators: { method: string; resultPath: string }[];
  methods: {
    clientRequests: string[]; clientNotifications: string[];
    serverRequests: string[]; serverNotifications: string[];
  };
}

/** One exact-input edit inside app.asar. Applied by the builder in array order. */
export interface SeamTransform {
  id: string;                         // e.g. "expose-components", "settings-section-anchor", "trusted-view-sender", "seam-jsx", "seam-tap:commands", "seam-expose:app-initial"
  /** v1.22 (C5, docs/design/presentations.md V1/V2): `jsx`, `lazy`, `tap`, `expose` and `app-host` are the inert page seams derived by adapters/tools/seams.mjs.
   *  Patched app code calls members of `globalThis.__codexmods` (see PageHooks); when a member is absent or throws, the app's own behaviour runs.
   *    jsx       renderer: the JSX factory asks `__codexmods.jsx(factory, type, props, key)` first
   *    lazy      renderer: the Vite preload helper passes each lazily loaded module through `__codexmods.lazy(importerSource, module)`
   *    tap       renderer: the three command tables (descriptors, handlers, messages) start with entries from `__codexmods.taps`; all three or none
   *    menu      renderer: the items of a thread's menus (the sidebar row's and the thread header's) pass `__codexmods.menuItems(args, items)`
   *    markdown  renderer: the markdown sites' components and directives (`markdownComponents`, `markdownDirectives`), and the renderer's text
   *              tokens (`markdownText(props, renderText)`: a renderer to draw them with)
   *    props     renderer: identity props an app component lacks to name what it shows, inserted at its call (`name:value` pairs only; no
   *              hook): the framework's bindings read them, and a row without them is not named
   *    copy      renderer: what the app's copy helper is given passes `__codexmods.copy(content, event, origin)` first (what it answers is
   *              copied)
   *    copy-origin renderer: a thread action's call to the copy helper is given where its content is from (`{chat:id}` or `{content:!1}`,
   *              data only), which the copy seam hands to `__codexmods.copy`
   *    command   renderer: the page's command dispatcher asks `__codexmods.command(id, keyboardEvent, source, origin, run)` first
   *    attach    renderer: a composer's attach methods, as the app makes them, pass `__codexmods.attach(methods, args)` (an object answered
   *              is used in their place)
   *    review-action renderer: the review panel's git action asks `__codexmods.reviewAction(arg, run)` first
   *    pr-create renderer: a pull request the user creates asks `__codexmods.pullRequestCreate(arg)` before the app's route runs
   *    menu-command main process: each command's menu bar item carries its command id (`codexmodsCommand`; data only)
   *    app-host  main process: `__codexmods.appHost(host, sender, view)` is told about each window's AppHost and AppView
   *    main-modules main process, webpack builds only (22943): the entry chunk's runtime writes its module cache to `__codexmods.mainModules`
   *              (data only), so framework-main can read tables in the app's main-process modules
   *    expose    renderer: one append-only block of getters per chunk on `__codexmods.exports` (keys in PackHookSeams.exposures)
   *  A refresh or a generation derives these again for every build, as atomic groups; they are never replayed from an older pack. */
  seam: 'components' | 'anchor' | 'trusted-sender' | 'preload' | 'host' | 'jsx' | 'lazy' | 'tap' | 'menu' | 'launcher' | 'markdown' | 'props' | 'expose' | 'app-host' | 'copy' | 'copy-origin' | 'command' | 'attach' | 'review-action' | 'pr-create' | 'menu-command' | 'main-modules' | 'other';
  file: string;                       // path inside app.asar
  sha256Before: string;               // of the whole file before this transform
  sha256After: string;                // of the whole file after this transform
  op: 'replace-once' | 'insert-before-once' | 'insert-after-once';
  find: string;                       // must occur exactly once
  text: string;                       // replacement or inserted text
}

/** A v1.21 host seam. */
export interface HostSeam { transform?: string; exports: string[] }
/** v1.22: what the page seams of the pack deliver, written by the generator and the refresh from the transforms that applied (a group that did not derive is absent). */
export interface PackHookSeams {
  /** Version of the hook names and call signatures below (PageHooks). A runtime that does not know the number must not rely on them. Starts at 1. */
  abi: number;
  /** Ids of the transforms of each seam; a seam that did not derive for the build is absent. `taps` lists all three, or the key is absent. */
  jsx?: string; lazy?: string; taps?: string[]; menuItems?: string; menuKinds?: Record<string, string>; launcher?: string; markdown?: string[];
  /** The identity props edits that applied (no hook: what the bindings may read). */
  props?: string[];
  appHost?: string;
  /** Webpack builds only: the transform that hands framework-main the main process's module cache. */
  mainModules?: string;
  copy?: string;
  command?: string;
  attach?: string;
  reviewAction?: string;
  /** sidebar-groups renderer: the conversations sidebar's group keys pass `__codexmods.sidebarGroups(keys)` before the app reads them (layouts §4.1) */
  sidebarGroups?: string;
  /** tab-visible renderer: the panels ask a kind's `isVisible(scope, tab)` with the tab (no hook; layouts §4.1) */
  tabVisible?: string;
  /** responsive renderer: the workspace column's narrow-window handler asks `__codexmods.responsive({width, scope})` first (layouts WL4d) */
  responsive?: string;
  /** page-route renderer: the framework's route for a mod's page in the app's route tree, its element `__codexmods.PageRoute` (layouts WL5a) */
  pageRoute?: string;
  /** destinations renderer: the mods' items in the rail's and the sidebar's navigation, before the provider's split (layouts WL5b) */
  destinations?: string;
  /** rail-mode renderer: a mod's page with a sidebar view asks for the app's contextual column (layouts WL5c) */
  railMode?: string;
  pullRequestCreate?: string;
  /** Exports key → id of the 'expose' transform whose block defines it. A key that did not derive is absent. */
  exposures?: Record<string, string>;
}
export type PackSeams = { hooks?: PackHookSeams; [host: string]: HostSeam | PackHookSeams | undefined };

/** The members of `globalThis.__codexmods` that patched app code calls or defines (ABI 1). All optional: the kernel (renderer) and framework-main (main process) define them,
 *  and the app runs unchanged when one is absent. A hook that throws is counted in `faults` and the app's own behaviour runs. */
export interface PageHooks {
  /** renderer. Returns the element, or null/undefined for "not mine" (the factory then runs). */
  jsx?(factory: (type: unknown, props: unknown, key?: unknown) => unknown, type: unknown, props: unknown, key?: unknown): unknown;
  /** renderer. `importerSource` is String(importer): it names the chunk and the picked exports. Returns a replacement module, or null/undefined for unchanged. */
  lazy?(importerSource: string, module: unknown): unknown;
  /** renderer. Read once, when the command chunks evaluate: command descriptors, [id, handler] pairs and message-catalog entries. */
  taps?: { commands?: unknown[]; handlers?: [string, (...a: unknown[]) => unknown][]; messages?: Record<string, unknown> };
  /** renderer. A thread menu's items before they show: `args` is the app's builder argument ({ target: { conversationId, hostId, cwd }, surface, … }),
   *  `items` its flat list (separators `{ id, type: 'separator' }` between groups). Anything but an array keeps the app's items. */
  menuItems?(args: unknown, items: unknown[]): unknown[];
  /** renderer. The markdown sites' default components ({a, code}) and directives, and the markdown renderer's text tokens' renderer: a function
   *  answered draws them (anything else keeps the site's). */
  markdownComponents?(options: unknown, components: object): object;
  markdownDirectives?(options: unknown, directives: object): object;
  markdownText?(props: object, renderText: unknown): unknown;
  /** renderer. What the app's copy helper is given (a string, a promise of one, or {"text/plain", "text/html"}) and the event that asked:
   *  what it answers is copied (null, or a throw: the content as it was). */
  copy?(content: unknown, event: unknown): unknown;
  /** renderer. The page's command dispatcher (a command's id, the key event, its source, its origin) asks first; `run()` is its own
   *  dispatch. A boolean answered is the dispatch's answer (the hook ran it, or holds it); anything else, or a throw: the app's own. */
  command?(id: string, keyboardEvent: unknown, source: unknown, origin: unknown, run: () => boolean): boolean | undefined;
  /** main process. Once per window, after the AppView is registered. `host` may be undefined when the window has no context. */
  appHost?(host: unknown, sender: unknown, view?: unknown): void;
  /** main process, webpack builds only. Written (not called) by the app's webpack runtime as it starts: its module cache, `{ id: { exports } }`. */
  mainModules?: Record<string, { exports?: unknown } | undefined>;
  /** renderer. Lazy, cached getters defined by the 'expose' blocks (keys in PackHookSeams.exposures). Never replace this object; add to it. */
  exports?: Record<string, unknown>;
  /** A throw from a hook is counted here when the object exists. */
  faults?: { jsx?: number; lazy?: number; menuItems?: number; appHost?: number };
}

export interface AnchorLocator {
  /** CSS selector evaluated against document; alternatives tried in order. */
  selectors: string[];
  /** How a mount relates to the matched element. */
  placement: 'inside' | 'before' | 'after';
}

/** Produced by each window's renderer runtime on load, published by the Runtime as bus state 'framework/probe'.
 *  Keys: 'anchor:<AnchorName>', 'component:<ComponentName>', 'react'. */
export interface ProbeReport { appBuild: string; at: string; items: Record<string, boolean>;
  /** E4: each armed presentation binding's state in this window (the feature log's live evidence); the Runtime publishes them merged
   *  across the live windows (a trip wins). */
  bindings?: Record<string, { state: 'works' | 'tripped' | 'unseen'; why?: string }>;
  /** v1.5: false for bootstrap/mod-view probes sent before the page is ready; such reports never feed compatibility (the Runtime ignores them in the union). */
  complete: boolean }

/** v1.5: the builder embeds the exact adapter.json it built with at Contents/Resources/codexmods-adapter.json (signed with the copy, immutable).
 *  framework-main reads THAT file; <root>/adapters/<build>/ is only the builder's input. */
/** v1.20: a TOML-shaped value (inline tables as objects). */
export type ConfigOverrideValue = string | number | boolean | ConfigOverrideValue[] | { [k: string]: ConfigOverrideValue };
export interface AdapterPack {
  adapterVersion: string;             // semver of this pack
  build: { version: string; bundleVersion: string; asarSha256: string; electronVersion: string };
  backend: {
    /** Path of the real codex binary the app spawns, relative to Contents/ (20052: Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex). */
    codexPath: string;
    /** The bundled Node that runs the Host (20052: Resources/cua_node/bin/node). */
    nodePath: string;
    /** 'override': point the app at the relay via configKey; real binary stays at codexPath.
     *  'replace': the builder renames codexPath to <codexPath>.real and puts the relay at codexPath; the real binary is <codexPath>.real. */
    method: 'override' | 'replace';
    /** override: the environment variable the app reads for its CLI path (20052: CODEX_CLI_PATH). The builder installs the relay at Contents/Resources/codexmods-relay. */
    configKey?: string;
    /** v1.20: per-process config the Host adds to the copy's PRIMARY backend spawn as `-c <key>=<toml>` (one `-c` per key; never persisted
     *  to the shared config.toml). Keys are dotted codex config paths (e.g. 'notify', 'mcp_servers.node_repl'). Every string value is a
     *  template; variables: ${appContents} ${resources} ${computerUseDir} ${codexHome} ${relayPath} ${profileDir}. An unknown ${name}
     *  makes the Host refuse to spawn the primary backend. Paired with the mandatory transform 'managed-config-no-persist'. */
    configOverrides?: Readonly<Record<string, ConfigOverrideValue>>;
  };
  /** Owl runtime settings file and the user-data directory name the builder writes into it (20052: Resources/owl-app.ini, 'ChatGPT Mods'). */
  owl?: { iniPath: string; userDataDirectoryName: string };
  /** Path inside app.asar of the package.json whose "main" the builder redirects to the loader. */
  asarPackageJson: string;
  protocol: ProtocolCatalog;
  /** v1.13: ids of transforms/binaryPatches that are mandatory isolation edits (keychain names, Computer Use container/relocation/identity).
   *  The builder refuses a pack where any listed id is missing or not applied; the generator refuses to emit such a pack. */
  mandatoryEdits?: string[];
  transforms: SeamTransform[];
  /** v1.10: exact-byte patches to signed Mach-O files outside app.asar (applied by the builder before signing; same fail-closed rules as
   *  the embedded ASAR digest patch). Used for the keychain service name (builder/KEYCHAIN.md): 'Codex' → 'Codey' Storage Key. */
  binaryPatches?: { id: string; file: string /* relative to Contents/ */; sha256Before: string; offset: number; before: string /* hex */; after: string /* hex */; sha256After: string; justification: string }[];
  anchors: Partial<Record<AnchorName, AnchorLocator>>;
  /** Where the 'components' seam transform exposes each component: a key on globalThis.__codexmods.exports. */
  components: Partial<Record<ComponentName, string>>;
  /** v1.21 (G-tree): host seams. Each key is a surface host name (`globalThis.__codexmods.hosts[<key>]`); `transform` is the id of the 'host' transform that renders
   *  that host inside the app's providers, and `exports` are the extra keys it needs on globalThis.__codexmods.exports (the app-shell namespace, the scope definitions, useScope).
   *  v1.22: the reserved key `hooks` declares the page seams that applied (PackHookSeams); it is not a surface host. */
  seams?: PackSeams;
  /** React and ReactDOM keys on globalThis.__codexmods.exports. */
  react: { react: string; reactDom: string } | null;
  /** Token name → CSS custom property on document.documentElement. */
  theme: Record<string, string>;
}
