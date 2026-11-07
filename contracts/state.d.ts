// Persistent state records (ARCHITECTURE.md §10–§12).
// Paths come from contracts/layout.mjs. Every JSON file here is written temp → fsync → rename.
import type { Json, ErrorCode } from '../sdk/index.js';
import type { ModManifest, Permission } from './manifest.js';

// ------------------------------------------------------------ profile
/** profiles/<p>/profile.json — written by `codexmods setup` or the QA harness. */
export interface ProfileConfig {
  /** Absolute CODEX_HOME for the primary backend. Daily profile: "~/.codex" expanded. QA: layout.codexHome. */
  codexHome: string;
  /** v1.13 (owner decision): when the stock app or a Codex CLI app-server is using the same codexHome at launch, the LOADER warns
   *  (dialog: continue / quit) and allows on continue; an inspection failure also warns. Independent of framework availability. */
  guardStockApp: boolean;
  signingIdentity: string; // codesign identity name, or "-" for ad-hoc
  /** Stable launch path: a symlink into <root>/apps (e.g. ~/Applications/ChatGPT Mods.app). */
  appPath: string;
  /** v1.4: arguments every (re)launch of this profile passes after `open -n <appPath> --args` (QA: ['--user-data-dir=<layout.userData>']; daily: []).
   *  Used by the swap helper, relaunch paths and the QA harness. */
  launchArgs: string[];
  /** E5: the stock app this profile's copies are built from and whose new builds it offers (`codexmods setup --stock`); absent:
   *  /Applications/ChatGPT.app. QA points it at a clone under its root, never at the installed app's place. */
  stockApp?: string;
  /** E5: the keychain the signing identity lives in when it is not the login keychain (QA's qa-signing keychain, whose password is
   *  empty): an update's staging unlocks it in the Host's own session before it builds, without a prompt (a wrong password just fails). */
  signingKeychain?: string;
}

// ------------------------------------------------------------ state.json
export type ModStatus = 'pending-consent' | 'disabled' | 'enabled' | 'quarantined';
export interface ModRecord {
  id: string;
  version: string;                 // the installed (active) version in store/<id>/<version>
  status: ModStatus;
  publisher: string | null;        // pinned key; null = developer mode
  dev?: { sourceDir: string };     // developer mode: loaded from this directory, never auto-updated
  grants: Permission[];            // what it holds outright: its required permissions as approved, and its optional ones allowed
  /** Where it came from (docs/design/framework-ui.md F10): the signature is its identity, the repository only where to look. */
  source?: { kind: 'github' } & GitHubSource | { kind: 'folder'; path: string } | { kind: 'file' };
  /** The user's decision for each optional permission (docs/design/framework-ui.md F8); a grant decided `ask` is not in `grants`. */
  decisions?: Record<string, 'allow' | 'ask' | 'deny'>;
  dataSchemaVersion: number;       // schema of data/<id>
  quarantine?: { reason: string; at: string };
  /** Its last fault, kept so a restart does not lose what stopped it (docs/design/framework-ui.md F9). */
  lastFault?: { at: string; message: string; where: string; stack?: string };
  /** An update staged but waiting for consent: to added permissions and/or a publisher change (newPublisher set). */
  pendingUpdate?: { version: string; addedPermissions: Permission[]; newPublisher?: string; repoChange?: { from: string; to: string; another?: true }; github?: GitHubSource };
  /** E5: disabled by an update applied anyway (its op and plan, and why it was at risk); cleared when the user enables it again. */
  leftBehind?: { op: string; plan: string; at: string; why: string[] };
  installedAt: string;
  updatedAt: string;
  /** Persistent, never-reused installation ordinal: interceptor tie-break rank (ARCHITECTURE §6.4). New on every fresh install. */
  installSeq: number;
  /** public-hooks.md §3.9: the automatic actions the user turned on, each as declared when turned on (a version whose declaration differs
   *  turns it off; disabling or removing the mod ends them all). */
  automatic?: Record<string, import('./manifest').AutomaticAction>;
  /** public-hooks.md §3.7: the ids of its policies the user turned off (they stay off when the mod registers them again). */
  policiesOff?: string[];
}
export interface ProfileState {
  schemaVersion: 1;
  mods: Record<string, ModRecord>;
  safeMode: boolean;
  /** framework-ui.md F12: folder installs are allowed and stacks shown. */
  developerMode?: boolean;
  nextInstallSeq: number;
}

/** A mod's GitHub release: its repository as GitHub names it, its id (which a rename or transfer keeps and a new repository does not), the tag, the package's sha256. */
export interface GitHubSource { repo: string; repoId: number; tag: string; digest: string }

// ------------------------------------------------------------ operations journal (recovery adds framework/app ops)
export type OpType =
  | 'install' | 'consent' | 'enable' | 'disable' | 'configure' | 'update' | 'rollback' | 'remove'
  | 'reattach' | 'clear-quarantine' | 'reload' | 'set-permission' | 'set-automatic' | 'set-policy' | 'framework-update' | 'app-prepare' | 'app-switch' | 'safe-mode' | 'lkg-restore' | 'copy-update';
export type OpOutcome = 'running' | 'succeeded' | 'failed' | 'reverted' | 'needs-attention';

export type OpInput =
  | { type: 'install'; source: string; enable?: boolean; dev?: boolean; github?: GitHubSource }      // source: .codexmod path or (dev) directory; github: where management found it
  | { type: 'consent'; modId: string; approve: boolean; enable?: boolean; request?: string; allow?: string[] }    // answers pending-consent or pendingUpdate; E6: `request` names what was reviewed (ops/consent.mjs), refused (Conflict) once another waits; `enable` with a pendingUpdate of a mod that is off is refused
  | { type: 'enable' | 'disable' | 'clear-quarantine' | 'reload'; modId: string }
  | { type: 'set-automatic'; modId: string; action: string; on: boolean }   // public-hooks.md §3.9: the user's switch of one automatic action
  | { type: 'set-permission'; modId: string; grant: string; decision: 'allow' | 'ask' | 'deny' }   // framework-ui.md F8: the user's decision on one optional permission
  | { type: 'set-policy'; modId: string; policy: string; on: boolean }        // public-hooks.md §3.7: the user's switch of one of its policies
  | { type: 'configure'; modId: string; patches: import('./management').SettingsPatch[] }
  | { type: 'update'; modId: string; source: string }
  | { type: 'rollback'; modId: string; toVersion: string; restoreData: boolean }
  | { type: 'remove'; modId: string; deleteData: boolean }
  | { type: 'reattach'; modId: string; generation?: string }                  // orphaned data → reinstalled mod (v1.13: newest generation by default; E6: an enabled mod is turned off and on again around it)
  | { type: 'framework-update'; version: string; sourceDir: string }
  | { type: 'app-prepare' }                                                   // build a candidate copy for the stock app's build
  | { type: 'app-switch'; candidate: string }                                  // apps/<build>/<App>.app
  /** E5: the copy's update, one plan (`<profile>/updates/<plan>/plan.json`); `anyway` leaves its held mods disabled; `consent`: the mods
   *  whose incoming version adds permissions and may take them. */
  | { type: 'copy-update'; plan: string; anyway?: boolean; consent?: string[] }
  | { type: 'safe-mode'; enter: boolean }
  | { type: 'lkg-restore' };                                                  // restore the LKG generation (ARCHITECTURE §12.4 rung 4)

export interface OpRecord {
  id: string;                      // "op-" + 16 hex
  input: OpInput;
  outcome: OpOutcome;
  /** Ordered phases; each appended (and journaled) BEFORE the phase's effects run. */
  phases: { name: string; at: string }[];
  /** Set when the op stops waiting on the user (e.g. consent). */
  awaiting?: 'consent';
  error?: { code: ErrorCode; message: string };
  /** Human-readable note for reverted / needs-attention outcomes. */
  note?: string;
  /** E6: a needs-attention operation the user acknowledged (management ops.acknowledge); it keeps its outcome. */
  acknowledgedAt?: string;
  /** Op-specific result, e.g. app-prepare: {candidate, appBuild, compatibility}. */
  result?: Json;
  startedAt: string;
  endedAt?: string;
}

// ------------------------------------------------------------ generations and boot
export interface Generation {
  n: number;
  appBuild: string;                // "26.1007.21159-20052"
  frameworkVersion: string;
  adapterVersion: string;
  mods: { id: string; version: string; dataSchemaVersion: number }[];
  settingsHash: string;            // sha256 over enabled mods' settings.json bytes, sorted by id
  /** v1.6: exact candidate path (apps/<build>-<inputsHash>/<App>.app) this generation ran from; LKG restore selects exactly this. */
  appCandidate: string;
  /** Restorable snapshot: mod records and settings values at this generation (secrets and data are not included). */
  state: ProfileState;
  settings: Record<string, Json>;
  createdAt: string;
  healthyAt?: string;              // set when the health gate passes → candidate for LKG
}
export interface BootMarker {
  generation: number;
  startedAt: string;
  /** Written by the loader at boot; cleared to 'healthy' by framework-main when the health gate passes. */
  state: 'booting' | 'healthy';
  /** Consecutive boots of this generation that never reached healthy. */
  unhealthyCount: number;
  /** Mods active when the last unhealthy boot ended (from Host breadcrumbs), for attribution. */
  breadcrumbs?: string[];
  /** v1.3: Host crashes since the last 10 minutes of crash-free uptime; framework-main increments it on every Host crash and
   *  writes breadcrumbs each time. At Host start, hostCrashCount >= 2 → quarantine the breadcrumbed mods and reset it. */
  hostCrashCount?: number;
  lastHostCrashAt?: string;
}

// ------------------------------------------------------------ installed mod view shared across modules
export interface InstalledMod {
  record: ModRecord;
  manifest: ModManifest;
  packageDir: string;              // store/<id>/<version>  (or dev.sourceDir)
  dataDir: string;                 // data/<id>
  retainedDir: string;             // retained/<id>
  backendsDir: string;             // backends/<id>
}
