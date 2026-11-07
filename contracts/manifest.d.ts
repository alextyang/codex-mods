// mod.json (ARCHITECTURE.md §7.1).
// Validated by framework/host/packages at install, and by the CLI `pack` and `dev` commands via the same validator.
import type { Json, ComponentName } from '../sdk/index.js';

export type Permission =
  | `appServer.observe${'' | `:${string}`}`     // optional comma-separated methods/prefixes after ':'
  | `appServer.request${'' | `:${string}`}`
  | `appServer.intercept${'' | `:${string}`}`
  | 'appServer.backends'
  | 'appServer.clients'
  | 'ui' | 'secrets' | 'processes' | 'network'
  // the programs on the Mac a mod's session processes run, each by name (graph-integrity G8.2, D4): never bare, so consent names each
  | `processes.exec:${string}`
  | 'framework.updates'
  | 'graph'                                    // ctx.graph: register types, provide and use the mod's own instances (docs/graph/04)
  // Other providers' instances (breadth.md D0.2): bare for every type, or a comma-separated list of type ids (a concept covers its
  // subtypes); act and intercept entries may name `<Type>.<operation>`.
  | `graph.read${'' | `:${string}`}`
  | `graph.act${'' | `:${string}`}`
  | `graph.intercept${'' | `:${string}`}`
  | `graph.attach${'' | `:${string}`}`
  // its own instances linked to others' (graph-integrity G3.2): bare, or the concepts it adds to (`graph.contribute:Thread,Project`)
  | `graph.contribute${'' | `:${string}`}`
  // where it draws or adds in the app's interface: bare, or the presentations (`graph.present:SidePanel,Composer`)
  | `graph.present${'' | `:${string}`}`;

export type FeatureRequirement = string | { id: string; version?: number };
export interface Capabilities { methods?: string[]; components?: ComponentName[]; features?: FeatureRequirement[] }
export interface ModManifest {
  /** Reverse-DNS style: lowercase letters, digits, '.', '-'; 3–128 chars; e.g. "codexmods.live-usage". */
  id: string;
  /** Strict semver x.y.z (optional -prerelease). */
  version: string;
  name: string;
  description?: string;
  /** The mod's own claim of who made it: never an identity, which is the publisher's key (docs/design/framework-ui.md F6). */
  author?: string;
  /** A name from the kit's set of glyphs; one it lacks, or none, draws the default. */
  glyph?: string;
  /** What it does, in paragraphs, on its page. */
  about?: string[];
  /**
   * Model use (GOAL.md goal 16): why the mod uses models, and the kinds of tool beyond its own storage, settings and actions it would like
   * them to have. It grants nothing: model use is off until the user turns it on on the mod's page, with the models and allowance they give.
   */
  intelligence?: { why: string; tools?: ('web' | 'network' | 'files' | 'toolServers' | 'plugins' | 'computerUse')[] };
  /** Package images on its page: png, jpg, webp or gif, at most 1 MiB each and 8 MiB together, at most 12. */
  media?: { id: string; src: string; caption?: string; aspect?: string }[];
  /** The exact Codex builds the author has tested this version on. */
  testedWith?: string[];
  /** Base64 ed25519 public key (32 bytes). Absent only for developer-mode packages. */
  publisher?: string;
  /** Semver range against FRAMEWORK_VERSION; v1 accepts ">=1 <2" style ranges with >=, <, ^, ~, exact. */
  framework: string;
  /** Package-relative paths to single-file ESM entries. At least one is required. */
  entry: { host?: string; renderer?: string };
  /** Required: consent grants them, and the way to stop one is the mod's switch. */
  permissions?: Permission[];
  /** Each decided by the user (docs/design/framework-ui.md F8): allow, ask every time (an act on the graph, a secret, a request to Codex) or don't allow. None covers what a required
   *  or another optional one does; `network` is never optional; `processes` is optional only with no process that starts with the mod. */
  optionalPermissions?: Permission[];
  /** What a grant is for, in the mod's words: its label and detail. Its risk is the framework's to say. */
  permissionNotes?: Record<string, { label?: string; detail: string }>;
  /** What the mod needs, judged against the build's status in the feature log (docs/design/systems.md "E4 in detail"). `features`: ids
   *  of the log (`graph:<Type>`, `graph:<Type>.<op>`, `presentation:<Type>`, `slot:<Type>.<slot>`, `sdk:<entry>`) or mechanic ids, each
   *  with the epoch it was written for (1 when it says none). Its other lists are read as mechanics: methods as `protocol:`, components as `sdk:component.<Name>`. */
  requires?: Capabilities;
  optional?: Capabilities;
  /** A list of settings and groups (docs/design/framework-ui.md F7): loose items come first, in a group with no title. */
  settings?: (SettingDeclaration | SettingsGroup)[];
  /** Absent means schemaVersion 0 with no migration. */
  data?: { schemaVersion: number; migrate?: string };
  /**
   * Declared processes. A worker (the default) answers the mod's calls and stops after `idleStopMs` unused when started on demand; a
   * session (graph-integrity G8.2) is long-lived: never stopped for being idle, restarted after a failure (an exit with a code other than 0, or
   * a signal) only with `restart: 'on-failure'`, started with arguments and a folder (`ctx.processes.start(name, {args, cwd})`), fed through `write`, its lines given as
   * `output`. `command` is package-relative (an executable, or a .mjs run with the framework's Node); a session may instead name a program
   * on the Mac, `executable` (D4), which a `processes.exec:<name>` permission names and the user's PATH finds at each start.
   */
  processes?: Record<string, { kind?: 'worker' | 'session'; command?: string; executable?: string; args?: string[]; start: 'on-demand' | 'with-mod';
    idleStopMs?: number; restart?: 'never' | 'on-failure';
    /** A session's instances (1 to 16): it runs as up to that many at once, each addressed as `name#key` (one per chat of an agent's). */
    instances?: number }>;
  /** public-hooks.md §3.9: calls the mod may make without asking, each off until the user turns it on (`invoke(..., { automatic: id })`). */
  automatic?: AutomaticAction[];
}

/** Archive format (.codexmod): a zip containing mod.json, the files it references, and signature.json at the root. */
/** One automatic action: the operation (`Type.operation`), why the mod does it, its bounds (`where` on the instance, `args` by index) and
 *  its rate. A call that names it and fits it does not ask while the user has it on; any other call asks as before. */
export interface AutomaticAction { id: string; operation: string; why: string; perHour: number; where?: Json; args?: Record<string, Json> }
export interface PackageSignature {
  /** sha256 hex over the canonical file list: sorted "path\0sha256hex\n" lines of every file except signature.json. */
  contentHash: string;
  /** Base64 ed25519 signature of the UTF-8 contentHash string by manifest.publisher. */
  signature: string;
}

/** An image in a package (docs/design/framework-ui.md F6): png, jpg, webp or gif, at most 1 MiB. Its id is unique in the mod. */
export interface ModMedia { id: string; src: string; caption?: string; aspect?: string }

/** A group of settings: its title, what it says of itself, and its items. */
export interface SettingsGroup { group?: string; icon?: string; description?: string; media?: ModMedia; items: SettingDeclaration[] }

/**
 * A mod's setting (docs/design/framework-ui.md F7). `kind` is what the value is, from the user's view, and `control` how it is drawn: a choice as `select` (the default), `segmented` or
 * `thumbnails`; a number as `stepper` (the default) or `slider`; a text as `line` (the default) or `area`.
 */
export interface SettingDeclaration {
  /** 1-64 letters, digits, "_" or "-", starting with a letter; unique in the mod. */
  key: string;
  kind: 'toggle' | 'choice' | 'text' | 'number' | 'shortcut' | 'list' | 'record' | 'color' | 'time' | 'timerange';
  control?: 'select' | 'segmented' | 'thumbnails' | 'stepper' | 'slider' | 'line' | 'area';
  title: string;
  description?: string;
  /** A name from the kit's set of glyphs, in the row's leading column. */
  icon?: string;
  /** Valid for its kind. A color is `#RRGGBB`, a time `HH:MM`, a timerange `{from, to}`. */
  default: Json;
  /** The narrowest scope it may be set at, `app` when absent (its wider scopes' values are its defaults). Any kind at any scope: the composer
   *  draws a chat's choices and toggles, a mod's own surface every kind (SettingRow; graph-integrity G4.1). */
  scope?: 'app' | 'project' | 'thread';
  /** A choice's options; a string is its own value and label. The value is a string, a number or a boolean. */
  options?: (string | { value: string | number | boolean; label: string; description?: string; media?: ModMedia })[];
  /** A number's bounds, step and unit. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** A text's or a list's. */
  placeholder?: string;
  /** The JSON Schema subset, for a list's items or a record. */
  schema?: Json;
  /** This row is active only while that setting is truthy, or differs from `not`, at the same scope. It never changes a value. */
  requires?: string | { key: string; not: Json };
  /** A permission it declares: a note shows on the row while that permission is not allowed. */
  needs?: string;
}
