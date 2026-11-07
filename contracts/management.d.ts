// Management API (ARCHITECTURE.md §14). Implemented by framework/host/management; consumed by the CLI, Adjustments and tests.
// Transport framing (both transports carry exactly these objects):
//   CLI socket: one JSON object per line. The first request on a connection must carry `token` (contents of mgmt.token).
//   MessagePort: same objects, no token.
// Mutations NEVER wait for the operation: they return {opId} as soon as it is journaled (D13).
import type { Json, ErrorCode } from '../sdk/index.js';
import type { OpInput, OpRecord, ModRecord, Generation } from './state.js';
import type { ModManifest } from './manifest.js';

export interface ManagementRequest { id: string | number; method: ManagementMethod; params?: Json; token?: string }
export type ManagementResponse =
  | { id: string | number; ok: true; result: Json }
  | { id: string | number; ok: false; error: { code: ErrorCode; message: string; details?: Json } };
/** Pushed after `events.subscribe`; lines without an id. */
export type ManagementEvent =
  | { event: 'op'; data: OpRecord }
  | { event: 'mods'; data: { mods: ModRecord[] } }
  | { event: 'compat'; data: Json }
  | { event: 'health'; data: Json }
  /** E3: a mod's settings are to be read again (after a configure, or an operation that restored or replaced its data; modId null: every mod's). */
  | { event: 'settings'; data: { modId: string | null } };

export type ManagementMethod =
  // ----- reads (answer immediately)
  | 'mods.list'          // → { mods: ModView[] }
  | 'mods.inspect'       // {modId} → ModDetail
  | 'mods.activity'      // {modId, after?} → its feed since the Host started: {lines, cursor, dropped, since} (framework-ui.md F9)
  | 'mods.media'         // {modId, media} → a data URL of one of its images (framework-ui.md F6)
  | 'mods.settings'      // {modId} → ModSettings (docs/design/systems.md E3)
  | 'ops.get'            // {opId} → OpRecord
  | 'ops.list'           // {modId?, running?} → { ops: OpRecord[] }
  | 'compat.report'      // → { appBuild, adapterVersion, probes: Record<string,boolean>, mods: Record<string, Compatibility>, features?: {build, hash, features, mechanics} (counts by status) }
  | 'features.list'      // → FeatureList: the feature log with this build's status and its evidence (docs/design/systems.md E4)
  | 'ops.acknowledge'    // {opId} → OpRecord: a needs-attention operation acknowledged (E6); refused for any other outcome
  | 'updates.status'     // → { framework: {current, previous}, app: {stockBuild, copyBuild} | null, lkg: Generation | null }
  | 'diagnostics'        // → { host: {...}, mux: MuxMetrics, mods: Record<string, {status, faults, lastError?}>, graph?: {degraded, windows, failed?} }
  // ----- mutations (→ { opId })
  | 'mods.install'       // {source, enable?, dev?}
  | 'mods.consent'       // {modId, approve, enable?, request?} (E6: request = mods.inspect's consentRequest.id)
  | 'mods.enable' | 'mods.disable' | 'mods.clearQuarantine' | 'mods.reload' // {modId}
  | 'mods.setPermission' // {modId, grant, decision: 'allow' | 'ask' | 'deny'} (framework-ui.md F8)
  | 'mods.installFromGitHub' // {repo: 'owner/repository'}: its latest release's signed .codexmod, installed as a file is (framework-ui.md F10)
  | 'mods.applyUpdate'   // {modId}: the update a check found for a mod from GitHub (F10)
  | 'framework.developerMode' // {on} (F12)
  | 'mods.setAutomatic'                                     // {modId, action, on}: one automatic action's switch (public-hooks.md §3.9)
  | 'mods.setPolicy'                                        // {modId, policy, on}: one of its policies' switch (public-hooks.md §3.7)
  | 'mods.configure'     // {modId, patches: SettingsPatch[]} (E3; → {opId: null, unchanged: true}
                         //   when no patch changes anything)
  | 'mods.update'        // {modId, source}
  | 'mods.rollback'      // {modId, toVersion, restoreData}
  | 'mods.remove'        // {modId, deleteData}
  | 'mods.reattach'      // {modId, generation?}
  | 'updates.framework'  // {version, sourceDir}
  | 'updates.app.prepare'// {} → { opId }  (OpInput {type:'app-prepare'}; the op's result holds {candidate, appBuild, compatibility})
  | 'updates.app.apply'  // {candidate}
  | 'recovery.safeMode'  // {enter}
  | 'recovery.lkg'       // {} → { opId }  (OpInput {type:'lkg-restore'})
  // ----- subscriptions
  | 'events.subscribe';  // {} → { subscribed: true }, then ManagementEvent lines on this connection/port

/** Mutation method → OpInput mapping is 1:1 with contracts/state.d.ts OpInput (mods.clearQuarantine → 'clear-quarantine'). */
export type MutationToOp = OpInput;

export interface ModView {
  id: string; name: string; version: string; status: ModRecord['status'];
  dev: boolean; publisherFingerprint: string | null;  // first 16 hex of sha256(publisher key)
  compatibility: 'compatible' | 'degraded' | 'atRisk' | 'blocked';
  /** E5: disabled by an update applied anyway (its op, plan, when, and why it was at risk). */
  leftBehind?: { op: string; plan: string; at: string; why: string[] };
  hasSettings: boolean; pendingUpdate: ModRecord['pendingUpdate'] | null; quarantine: ModRecord['quarantine'] | null;
}
export interface ModDetail extends ModView {
  manifest: ModManifest;
  grants: string[];
  /** Plain-language permission lines grouped by risk, for the consent screen. */
  permissionText: { risk: 'high' | 'medium' | 'low'; text: string }[];
  settings: Json | null;               // current value (the app map)
  /** E3: the overrides at narrower scopes ({"project:<provider>:<id>" | "thread:<provider>:<id>": {key: value}}), or null. */
  scopedSettings: Record<string, Record<string, Json>> | null;
  versionsInStore: string[];
  /** v1.9: facts for rollback gating. codeOnly allowed iff dataSchemaVersion equals the installed data schema;
   *  codeAndData allowed iff hasSnapshot. Adjustments offers exactly these. */
  versions: { version: string; dataSchemaVersion: number; hasSnapshot: boolean; rollback: { codeOnly: boolean; codeAndData: boolean } }[];
  snapshots: { fromVersion: string; at: string }[];
  dataBytes: number;
  recentOps: OpRecord[];
  /** v1.9: orphaned data from a keep-data removal exists for this mod (Adjustments offers Reattach). */
  orphaned: boolean;
  /** v1.13: preserved data generations, newest first (orphaned/<id>/<ISO timestamp>/). */
  orphanedGenerations: { at: string; version: string; dataSchemaVersion: number; /** v1.14: on-disk size of the preserved copy. */ bytes?: number }[];
  /** Set when pendingUpdate.newPublisher differs from the pinned key: explicit consent required (ARCHITECTURE §13). */
  publisherChange: { oldFingerprint: string; newFingerprint: string } | null;
  /** E6: what waits for consent (an install or an update), its id hashing what it asks; null when nothing waits. */
  consentRequest: { id: string; kind: 'install' | 'update'; version: string; publisher: string | null; permissions: string[]; addedPermissions: string[];
    publisherChange?: { from: string | null; to: string | null } } | null;
}

/** A scoped settings change (docs/design/systems.md E3): set or unset one key at one scope. */
export type SettingsScope = 'app' | { project: { provider: string; id: string } } | { thread: { provider: string; id: string } }
  /** A scope key, as the graph's Setting ids carry it: "project:<provider>:<id>" or "thread:<provider>:<id>" (each part URI-escaped). */
  | string;
export type SettingsPatch = { key: string; scope?: SettingsScope; value: Json } | { key: string; scope?: SettingsScope; unset: true };

/** mods.settings: a mod's declarations and stored values; `invalid` lists the stored values that are not used (kept, never deleted). */
export interface ModSettings {
  modId: string;
  version: 0 | 1 | 2;
  declarations: import('./manifest').SettingDeclaration[];
  app: Json;
  scopes: Record<string, Record<string, Json>>;
  document: Json;
  invalid: { key: string; scope: string; reason: string }[];
}

/** `features.list` (docs/design/systems.md "E4 in detail"): every feature and mechanic of the log with its status on the running build. */
export interface FeatureList {
  build: string | null;
  log: { hash: string; reference: string[] } | null;
  /** `unlogged`: methods the framework's own providers requested that the log lacks (the scan's blind spots, seen at run time). */
  evidence: { build: string | null; from: string | null; census: boolean; report: boolean; stale: string[]; live: { bindings: number; anchors: number }; unlogged: string[] } | null;
  features: Array<{ id: string; kind: 'feature'; title: string; version: number; status: 'present' | 'changed' | 'missing' | 'unknown';
    because: Array<{ id: string; status: string; why: string }>; needs: Array<string | { anyOf: string[] }>; realizedBy?: string[] }>;
  mechanics: Array<{ id: string; kind: 'mechanic'; title: string; status: 'present' | 'changed' | 'missing' | 'unknown'; why: string; units: string[] }>;
}
