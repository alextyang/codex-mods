// Lifecycle operation handlers and their crash recovery (ARCHITECTURE §11). Used by index.mjs.
//
// Conventions
//  - A handler returns a "done" object {outcome, note?, error?, awaiting?, result?} or throws (→ failed). index.mjs finishes the op.
//  - Every effect runs inside c.step(op, name, fn, patch): the phase is journaled first, then the effects run.
//  - A recoverer receives an op that was 'running' when the process died and returns a done object. It acts only on local
//    state and files, is idempotent, and never calls Runtime.activate (mod code that may have had external effects is not re-run).
//  - Update and rollback share one version-switching tail (`switchVersion`), whose plan is journaled in op.result.plan.
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { publisherFingerprint } from '../../../contracts/layout.mjs';
import { writeJsonAtomic, readJson, now } from '../fsutil.mjs';
import { readZip } from '../../shared/zip.mjs';
import { parseVersion, compareVersions } from '../packages/semver.mjs';
import { permissionCovered } from '../packages/manifest.mjs';
import { declarationsOf, applyPatches, documentOf, storedAt, scopeOfPatch, validateValue } from '../packages/settings.mjs';
import { exists, rmrf, ensureDir, cloneDir, replaceDir } from './fsops.mjs';
import { createOrphans, ORPHAN_META } from './orphans.mjs';
import { blockedBecause, noteOf } from './compat.mjs';
import { consentRequestOf } from './consent.mjs';
import { readPlan, choose, verdictOf, recheck as recheckPlan } from '../updates/plan.mjs';
import { samePath } from '../recovery/support.mjs';
import { keepAutomatic } from './automatic.mjs';
import { decisionsFor, grantsFor, requiredOf, restoredDecisions, choicesOf } from '../permissions.mjs';

const MOD_ID_RE = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const FRAMEWORK_TYPES = ['framework-update', 'app-prepare', 'app-switch', 'safe-mode', 'lkg-restore'];
const RANK = { stop: 0, snapshot: 1, migrate: 2, swap: 3, 'restore-data': 3, apply: 4, activate: 5, health: 6, commit: 7, cleanup: 8, revert: 99, reactivate: 99 };
const rank = (phase) => RANK[phase] ?? -1;

const invalid = (msg) => new CodexModsError('Invalid', msg);
const done = (outcome, extra = {}) => ({ outcome, ...extra });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lastPhase = (op) => op.phases.at(-1)?.name;

export function createLifecycle(c) {
  const { L, log } = c;
  const rec = (id) => c.state.mods[id];
  const need = (id) => { const r = rec(id); if (!r) throw invalid(`${id} is not installed`); return r; };
  const dataDir = (id) => c.dataDirOf(id);
  const settingsFile = (id) => join(dataDir(id), 'settings.json');
  const scopesFile = (id) => join(dataDir(id), 'settings.scopes.json');   // overrides at narrower scopes (docs/design/systems.md E3)
  const stagingData = (opId) => join(L.data, `.staging-${opId}`);
  const restoreTmp = (opId) => join(L.data, `.restore-${opId}`);
  const snapshotDir = (id, version) => join(L.snapshots, id, version);
  const snapshotTmp = (id, opId) => join(L.snapshots, id, `.tmp-${opId}`);
  const orphans = createOrphans(L);
  const isStaged = (dir) => resolve(dir).startsWith(join(L.store, '.staging') + '/');
  const activationInfo = (e) => ({ effects: e?.details?.effectsAttempted !== false, error: c.errInfo(e) });
  const rethrowCrash = (e) => { if (c.isCrash(e)) throw e; };
  const safeDeactivate = async (id, reason) => { try { await c.runtime.deactivate(id, reason); } catch (e) { log.warn('deactivate failed', { modId: id, error: String(e?.message ?? e) }); } };

  // ------------------------------------------------------------------ input validation
  function validateInput(input) {
    if (!isObj(input) || typeof input.type !== 'string') throw invalid('operation input must be an object with a type');
    const str = (k) => { if (typeof input[k] !== 'string' || !input[k]) throw invalid(`${k}: must be a non-empty string`); };
    const bool = (k, optional = false) => { if (!(optional && input[k] === undefined) && typeof input[k] !== 'boolean') throw invalid(`${k}: must be a boolean`); };
    const modId = () => { str('modId'); if (!MOD_ID_RE.test(input.modId)) throw invalid('modId: not a valid mod id'); };
    switch (input.type) {
      case 'install':
        str('source'); bool('enable', true); bool('dev', true);
        if (input.github !== undefined) githubOf(input.github, 'github');
        break;
      case 'consent':
        modId(); bool('approve'); bool('enable', true);
        if (input.request !== undefined && !(typeof input.request === 'string' && /^[0-9a-f]{16}$/.test(input.request))) throw invalid('request: not a consent request id');
        if (input.allow !== undefined && !(Array.isArray(input.allow) && input.allow.length <= 64 && input.allow.every((g) => typeof g === 'string' && g.length <= 512))) throw invalid('allow: the optional permissions allowed now');
        break;
      case 'enable': case 'disable': case 'clear-quarantine': case 'reload': modId(); break;
      case 'set-permission':
        modId();
        if (typeof input.grant !== 'string' || !input.grant || input.grant.length > 512) throw invalid('grant: a permission');
        if (!['allow', 'ask', 'deny'].includes(input.decision)) throw invalid('decision: allow, ask or deny');
        break;
      case 'set-policy':
        modId(); bool('on');
        if (typeof input.policy !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.policy)) throw invalid('policy: not a policy id');
        break;
      case 'set-automatic':
        modId(); bool('on');
        if (typeof input.action !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.action)) throw invalid('action: not an automatic action id');
        break;
      case 'reattach':
        modId();
        if (input.generation !== undefined && !(typeof input.generation === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z(-\d+)?$/.test(input.generation))) throw invalid('generation: not an orphaned generation name');
        break;
      case 'configure':
        modId();
        if (!Array.isArray(input.patches) || !input.patches.length || input.patches.length > 64) throw invalid('patches: a list of 1 to 64 patches');
        break;
      case 'update': modId(); str('source'); if (input.github !== undefined) githubOf(input.github, 'github'); break;
      case 'rollback': modId(); str('toVersion'); if (!parseVersion(input.toVersion)) throw invalid('toVersion: not a strict semver version'); bool('restoreData'); break;
      case 'remove': modId(); bool('deleteData'); break;
      case 'framework-update': str('version'); str('sourceDir'); break;
      case 'app-prepare': case 'lkg-restore': break;
      case 'app-switch': str('candidate'); break;
      case 'safe-mode': bool('enter'); break;
      case 'copy-update':
        str('plan'); if (!/^[0-9a-f]{32}$/.test(input.plan)) throw invalid('plan: a plan\'s hash'); bool('anyway', true);
        if (input.consent !== undefined && !(Array.isArray(input.consent) && input.consent.every((x) => typeof x === 'string' && MOD_ID_RE.test(x)))) throw invalid('consent: a list of mod ids');
        break;
      default: throw invalid(`unknown operation type "${input.type}"`);
    }
  }

  /** Best-effort: the mod id inside an install source, so the per-mod lock can be taken before the op starts. */
  async function peekModId(input) {
    if (input.type !== 'install') return null;
    try {
      let bytes;
      if (input.dev) bytes = await readFile(join(input.source, 'mod.json'));
      else {
        if ((await stat(input.source)).size > 64 * 1024 * 1024) return null;
        bytes = readZip(await readFile(input.source)).find((e) => e.path === 'mod.json')?.data;
      }
      const id = JSON.parse(bytes.toString('utf8'))?.id;
      return typeof id === 'string' && MOD_ID_RE.test(id) ? id : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------------ preflight: impossible requests fail in start()
  function preflight(input) {
    switch (input.type) {
      case 'install': return;
      case 'consent': {
        const r = need(input.modId);
        if (!r.pendingUpdate && r.status !== 'pending-consent') throw invalid(`${input.modId}: nothing is awaiting consent`);
        // E6: enable belongs to an install's consent; an update's keeps the mod as it is
        if (r.pendingUpdate && input.approve && input.enable && r.status !== 'enabled') throw invalid(`${input.modId}: approving its update keeps it off; turn it on after`);
        return;
      }
      case 'enable': {
        const r = need(input.modId);
        if (r.status === 'enabled') throw invalid(`${input.modId} is already enabled`);
        if (r.status === 'pending-consent') throw invalid(`${input.modId} is awaiting consent`);
        if (r.status === 'quarantined') throw invalid(`${input.modId} is quarantined; clear the quarantine first`);
        if (!c.installed(input.modId)) throw invalid(`${input.modId}: its package could not be loaded`);
        return;
      }
      case 'disable': {
        // a stopped mod can be switched off too (framework-ui.md F5): it then stays off, with what stopped it in its record
        const r = need(input.modId);
        if (r.status !== 'enabled' && r.status !== 'quarantined') throw invalid(`${input.modId} is not enabled`);
        return;
      }
      case 'reload': {
        const r = need(input.modId);
        if (r.status !== 'enabled' && r.status !== 'quarantined') throw invalid(`${input.modId} is off: turn it on instead`);
        if (c.safeModeActive()) throw invalid('Safe mode is on: no mod runs until it ends');
        if (!c.installed(input.modId)) throw invalid(`${input.modId}: its package could not be loaded`);
        return;
      }
      case 'clear-quarantine': {
        if (need(input.modId).status !== 'quarantined') throw invalid(`${input.modId} is not quarantined`);
        return;
      }
      case 'set-policy': need(input.modId); return;
      case 'set-permission': {
        const r = need(input.modId);
        if (r.status === 'pending-consent') throw invalid(`${input.modId} is awaiting consent`);
        const view = c.installed(input.modId);
        if (!view) throw invalid(`${input.modId}: its package could not be loaded`);
        if (!(view.manifest.optionalPermissions ?? []).includes(input.grant)) {
          throw invalid((view.manifest.permissions ?? []).includes(input.grant) ? `${input.grant} is required: turn ${input.modId} off to stop it` : `${input.modId} does not declare ${input.grant} as optional`);
        }
        if (!choicesOf(input.grant).includes(input.decision)) throw invalid(`${input.grant} can be ${choicesOf(input.grant).join(' or ')}`);
        return;
      }
      case 'set-automatic': {
        // turned on: an action its installed version declares, while it is on (turning one off always works)
        const r = need(input.modId);
        if (!input.on) return;
        if (r.status !== 'enabled') throw invalid(`${input.modId} is not on: its automatic actions are turned on while it is`);
        const view = c.installed(input.modId);
        if (!view) throw invalid(`${input.modId}: its package could not be loaded`);
        if (!(view.manifest.automatic ?? []).some((a) => a.id === input.action)) throw invalid(`${input.modId} declares no automatic action "${input.action}"`);
        return;
      }
      case 'configure': {
        const r = need(input.modId);
        if (r.status === 'pending-consent') throw invalid(`${input.modId} is awaiting consent`);
        const view = c.installed(input.modId);
        if (!view) throw invalid(`${input.modId}: its package could not be loaded`);
        // clearing what is stored needs no declaration (E6 review: a mod that no longer declares settings keeps what it stored)
        const clearing = Array.isArray(input.patches) && input.patches.length > 0 && input.patches.every((p) => p && typeof p === 'object' && p.clear === true);
        if (!view.manifest.settings && !clearing) throw invalid(`${input.modId} declares no settings`);
        checkPatches(view.manifest, input.patches);
        return;
      }
      case 'update': {
        const r = need(input.modId);
        if (r.status === 'pending-consent') throw invalid(`${input.modId} is awaiting consent; approve or deny the install first`);
        return;
      }
      case 'rollback': planRollback(input); return;
      case 'remove': planRemove(input); return;
      case 'reattach': planReattach(input); return;
      default: return;
    }
  }

  /** A GitHub source as an operation carries it (management's lookup), checked; `mod`: the mod a release of several was asked for. */
  function githubOf(g, at) {
    if (!g || typeof g !== 'object' || typeof g.repo !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(g.repo) || !Number.isSafeInteger(g.repoId)
      || typeof g.tag !== 'string' || g.tag.length > 200 || typeof g.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(g.digest)
      || (g.mod !== undefined && (typeof g.mod !== 'string' || !/^[a-z0-9.-]{3,128}$/.test(g.mod)))) throw invalid(`${at}: {repo, repoId, tag, digest, mod?}`);
    return { repo: g.repo, repoId: g.repoId, tag: g.tag, digest: g.digest, ...(g.mod ? { mod: g.mod } : {}) };
  }

  // ------------------------------------------------------------------ install
  async function install(op) {
    const hold = await c.holdStore();           // store lock: verify → record (so GC never sees a half-published package)
    try { return await installLocked(op); } finally { await hold.release(); }
  }

  async function installLocked(op) {
    const input = op.input;
    const pkg = await c.step(op, 'verify', () => c.packages.verify(input.source, { dev: Boolean(input.dev), ...(input.github ? { digest: githubOf(input.github, 'github').digest } : {}) }));
    try {
      const m = pkg.manifest, id = m.id;
      const asked = input.github ? githubOf(input.github, 'github').mod : undefined;
      if (asked && asked !== id) throw new CodexModsError('Invalid', `the release's package for ${asked} is ${id}`);
      c.claim(op, id);
      let compat;
      await c.step(op, 'compatibility', async () => {
        const existing = rec(id);
        if (existing) {
          if ((existing.publisher ?? null) !== (pkg.publisher ?? null)) {
            throw new CodexModsError('Denied', `${id} is already installed from a different publisher; a publisher change is only allowed through update`);
          }
          if (existing.status !== 'pending-consent') {
            if (pkg.publisher !== null) throw new CodexModsError('Conflict', `${id} is already installed (${existing.version}); use update`);
            if (existing.status === 'enabled') throw new CodexModsError('Conflict', `${id} is enabled; disable the development package before installing it again`);
            const schema = m.data?.schemaVersion ?? 0;
            if (existing.dataSchemaVersion !== schema && await exists(dataDir(id))) {
              throw new CodexModsError('Conflict', `${id}: data is at schema ${existing.dataSchemaVersion} but the package uses ${schema}; use update so the data can be migrated`);
            }
          }
        }
        compat = c.compatibility(m);
        if (compat.status === 'blocked') throw new CodexModsError('Incompatible', `${id} cannot run here. ${blockedBecause(compat)}`, { compatibility: compat });
      }, { modId: id, version: m.version });
      await c.step(op, 'store', () => c.packages.store(pkg));
      const seq = c.allocInstallSeq();
      await c.step(op, 'record', async () => {
        const existing = rec(id);
        const t = now();
        c.state.mods[id] = {
          id, version: m.version, status: 'pending-consent', publisher: pkg.publisher,
          ...(pkg.publisher === null ? { dev: { sourceDir: pkg.dir } } : {}),
          // where it came from (framework-ui.md F10): the signature is its identity, the repository where to look
          source: input.github ? { kind: 'github', ...githubOf(input.github, 'github') } : pkg.publisher === null ? { kind: 'folder', path: pkg.dir } : { kind: 'file' },
          grants: [],
          dataSchemaVersion: existing && existing.status !== 'pending-consent' ? existing.dataSchemaVersion : (m.data?.schemaVersion ?? 0),
          installedAt: t, updatedAt: t, installSeq: seq,
          // a new mod goes last in the user's order, once there is one (E6)
          ...(() => { const orders = Object.values(c.state.mods).filter((x) => x.id !== id).map((x) => x.order).filter(Number.isFinite); return orders.length ? { order: Math.max(...orders) + 1 } : {}; })(),
        };
        await c.persistState();
      }, { installSeq: seq });
      return done('succeeded', { awaiting: 'consent', ...(noteOf(compat) ? { note: noteOf(compat) } : {}) });
    } catch (e) {
      if (!c.isCrash(e) && isStaged(pkg.dir)) await rmrf(pkg.dir);
      throw e;
    }
  }

  function recoverInstall(op) {
    const id = op.result?.modId;
    const r = id ? rec(id) : undefined;
    if (lastPhase(op) === 'record' && r && r.installSeq === op.result.installSeq) return done('succeeded', { awaiting: 'consent', note: 'Recovered after a restart.' });
    return done('failed', { note: 'Interrupted before the install was recorded; nothing was applied.' });
  }

  // ------------------------------------------------------------------ consent
  async function consent(op) {
    const { modId, approve, enable } = op.input;
    const r = need(modId);
    // E6: the consent names what the user reviewed; checked here, under the mod's lock, against what waits now
    if (op.input.request !== undefined && consentRequestOf(r, c.installed(modId)?.manifest)?.id !== op.input.request) {
      throw new CodexModsError('Conflict', `${modId}: what waits for consent is not what was reviewed; look at it again`);
    }
    if (r.pendingUpdate) {
      if (!approve) {
        const declined = r.pendingUpdate.version;
        await c.step(op, 'apply', async () => { delete rec(modId).pendingUpdate; rec(modId).updatedAt = now(); await c.persistState(); }, { target: 'update' });
        return done('succeeded', { note: `Update to ${declined} declined.` });
      }
      return continueUpdate(op, r);
    }
    if (r.status !== 'pending-consent') throw invalid(`${modId}: nothing is awaiting consent`);
    if (!approve) {
      await c.step(op, 'apply', async () => { delete c.state.mods[modId]; await c.persistState(); }, { target: 'install' });
      return done('succeeded', { note: 'Install declined.' });
    }
    const view = c.installed(modId);
    if (!view) throw invalid(`${modId}: its package could not be loaded`);
    await c.step(op, 'apply', async () => {
      const cur = rec(modId);
      // F8: each optional permission its default, unless the review's Allow now said otherwise (only an optional one it declares)
      const allowNow = (op.input.allow ?? []).filter((g) => (view.manifest.optionalPermissions ?? []).includes(g) && choicesOf(g).includes('allow'));
      cur.decisions = { ...decisionsFor(view.manifest), ...Object.fromEntries(allowNow.map((g) => [g, 'allow'])) };
      cur.grants = grantsFor(view.manifest.permissions ?? [], cur.decisions);
      cur.status = 'disabled';
      cur.updatedAt = now();
      await c.persistState();
    }, { target: 'install' });
    return enable ? enableTail(op, modId) : done('succeeded');
  }

  // ------------------------------------------------------------------ enable / disable
  async function enableTail(op, modId) {
    const view = c.installed(modId);
    if (!view) throw invalid(`${modId}: its package could not be loaded`);
    try {
      await c.step(op, 'compatibility', () => {
        const compat = c.compatibility(view.manifest);
        if (compat.status === 'blocked') throw new CodexModsError('Incompatible', `${modId} cannot run here. ${blockedBecause(compat)}`, { compatibility: compat });
      });
    } catch (e) {
      rethrowCrash(e);
      throw e;   // a consent that was already applied makes this needs-attention (partial effects), see index.mjs
    }
    let note;
    if (c.safeModeActive()) note = 'Safe mode: the mod is marked enabled and will start when safe mode ends.';
    else {
      try { await c.step(op, 'activate', () => c.runtime.activate(view)); } catch (e) {
        rethrowCrash(e);
        await safeDeactivate(modId, 'activation-failed');
        const info = activationInfo(e);
        // The mod stays disabled. effectsAttempted tells whether activation may have acted on the outside world. A reattach (E6) has
        // attached the data already: never "nothing applied".
        const reattached = op.input.type === 'reattach' ? 'The data was reattached and the mod is off: turning it on again failed: ' : '';
        if (info.effects) return done('needs-attention', { error: info.error, note: `${reattached}${info.error.code}: ${info.error.message} (activation may have had external effects)` });
        if (reattached) return done('needs-attention', { error: info.error, note: `${reattached}${info.error.message}` });
        // For a consent op the grants are already persisted: not "nothing applied".
        return op.input.type === 'consent'
          ? done('needs-attention', { error: info.error, note: `Consent was recorded and the mod is disabled, but enabling failed: ${info.error.message}` })
          : done('failed', { error: info.error });
      }
    }
    // a mod turned on starts with its automatic actions off (turning it off ended them: public-hooks.md §3.9)
    await c.step(op, 'commit', async () => { const cur = rec(modId); cur.status = 'enabled'; delete cur.leftBehind; delete cur.automatic; delete cur.quarantine; cur.updatedAt = now(); await c.persistState(); });
    return done('succeeded', note ? { note } : {});
  }

  const enable = (op) => enableTail(op, op.input.modId);

  async function disable(op) {
    const { modId } = op.input;
    await c.step(op, 'deactivate', () => c.runtime.deactivate(modId, 'disable'));
    await c.step(op, 'commit', async () => { const cur = rec(modId); if (cur) { cur.status = 'disabled'; cur.updatedAt = now(); await c.persistState(); } });
    return done('succeeded');
  }

  async function recoverEnableLike(op, modId, last) {
    const r = rec(modId);
    if (!r) return done('failed', { note: 'The mod is no longer installed.' });
    if (last === 'compatibility') {
      return op.input.type === 'enable'
        ? done('failed', { note: 'Interrupted before activation; nothing was applied.' })
        : done('succeeded', { note: 'Approved; enabling was interrupted by a restart and was not completed. Enable the mod again.' });
    }
    if (last === 'activate') {
      return done('needs-attention', { note: 'Activation was interrupted by a restart and may have had external effects; the mod was left disabled.' });
    }
    if (last === 'commit') {
      if (r.status === 'disabled') { r.status = 'enabled'; r.updatedAt = now(); await c.persistState(); }
      return done('succeeded', { note: 'Recovered after a restart.' });
    }
    return done('failed', { note: 'Interrupted; nothing was applied.' });
  }

  async function recoverConsent(op) {
    if (op.result?.plan) return recoverSwitch(op);
    const { modId, approve, enable: wantEnable } = op.input;
    const last = lastPhase(op);
    const r = rec(modId);
    if (last === 'await-consent') return recoverAwaitConsent(op);
    if (last === 'approve' || !last) return done('failed', { note: 'Interrupted before the update started; nothing was applied. The update is still awaiting consent.' });
    if (last === 'apply') {
      if (op.result?.target === 'update') {
        return !r?.pendingUpdate ? done('succeeded', { note: 'Recovered after a restart.' }) : done('failed', { note: 'Interrupted; the update is still awaiting consent.' });
      }
      const committed = approve ? r && r.status !== 'pending-consent' : !r;
      return committed
        ? done('succeeded', { note: wantEnable && approve ? 'Recovered after a restart; enabling was not completed.' : 'Recovered after a restart.' })
        : done('failed', { note: 'Interrupted; the install is still awaiting consent.' });
    }
    return recoverEnableLike(op, modId, last);
  }

  async function recoverEnable(op) { return recoverEnableLike(op, op.input.modId, lastPhase(op)); }

  async function recoverDisable(op) {
    const r = rec(op.input.modId);
    if (r && r.status === 'enabled') { r.status = 'disabled'; r.updatedAt = now(); await c.persistState(); }
    return done('succeeded', { note: 'Recovered after a restart.' });
  }

  // ------------------------------------------------------------------ configure
  /** A patch's shape against the declarations, before anything is read (the files are checked under the lock). */
  function checkPatches(manifest, patches) {
    const { list } = declarationsOf(manifest);
    patches.forEach((p, i) => {
      // a clear patch removes what is stored at a project or a thread, whatever it is (E6): applyPatches checks its scope
      if (p && typeof p === 'object' && p.clear === true) { if (typeof p.key !== 'string' || !scopeOfPatch(p.scope).key) throw invalid(`patches[${i}]: a clear patch names a key and a project's or a thread's scope`); return; }
      const d = p && typeof p === 'object' ? list.find((x) => x.key === p.key) : null;
      if (!d) throw invalid(`patches[${i}].key: not a setting of this mod`);
      const where = scopeOfPatch(p.scope);
      if (!d.scopes.includes(where.kind)) throw invalid(`patches[${i}].scope: ${p.key} is not set at a ${where.kind} scope`);
      if (p.unset !== true) validateValue(d, p.value, `patches[${i}].value`);
    });
  }
  /** The stored settings: the app map and the overrides at narrower scopes. */
  async function readSettings(modId) {
    return { app: await readJson(settingsFile(modId), {}), scopes: await readJson(scopesFile(modId), {}) };
  }
  async function configure(op) {
    const { modId } = op.input;
    const view = c.installed(modId);
    // Under the mod's lock: the files as they are now, every patch applied, the whole validated, both written (systems.md E3).
    const { list } = declarationsOf(view.manifest);
    const stored = await readSettings(modId);
    const next = applyPatches(list, stored.app, stored.scopes, op.input.patches);
    if (!next.changed.length) return done('succeeded', { note: 'Unchanged.' });
    await c.step(op, 'write', async () => {
      if (JSON.stringify(next.scopes) !== JSON.stringify(stored.scopes)) await writeJsonAtomic(scopesFile(modId), next.scopes);
      if (JSON.stringify(next.app) !== JSON.stringify(stored.app)) await writeJsonAtomic(settingsFile(modId), next.app);
    });
    if (view.manifest.settings && rec(modId)?.status === 'enabled' && c.isActive(modId)) await c.step(op, 'notify', () => c.runtime.settingsChanged(modId, documentOf(list, next.app), next.changed));
    return done('succeeded');
  }

  async function recoverConfigure(op) {
    const { modId } = op.input;
    const view = c.installed(modId);
    if (!view) return done('failed', { note: 'The mod is no longer installed.' });
    // What is stored at each key and scope (present with its value, or absent), never effective values.
    const { list } = declarationsOf(view.manifest);
    const stored = await readSettings(modId);
    const held = op.input.patches.map((p) => {
      // a clear patch held when nothing is stored there any more (judged on the file, never on the declarations: E6 review)
      if (p.clear === true) { const m = stored.scopes?.[scopeOfPatch(p.scope).key]; return !m || typeof m !== 'object' || !Object.hasOwn(m, p.key); }
      const d = list.find((x) => x.key === p.key);
      if (!d) return false;
      const s = storedAt(d, stored.app, stored.scopes, scopeOfPatch(p.scope).key);
      return p.unset === true ? !s.present || (d.path !== undefined && JSON.stringify(s.value) === JSON.stringify(d.default)) : s.present && JSON.stringify(s.value) === JSON.stringify(p.value);
    });
    if (held.every(Boolean)) return done('succeeded', { note: 'Recovered after a restart.' });
    if (!held.some(Boolean)) return done('failed', { note: 'Interrupted before the settings were written; nothing was applied.' });
    return done('needs-attention', { note: 'Interrupted while the settings were written: some of its changes are stored and some are not. Set them again.' });
  }

  // ------------------------------------------------------------------ set-automatic (public-hooks.md §3.9)
  // The user's switch of one automatic action: on keeps the action as its installed version declares it (what the user saw), off forgets it.
  async function setAutomatic(op) {
    const { modId, action, on } = op.input;
    await c.step(op, 'apply', async () => {
      const r = need(modId);
      const decl = on ? (c.installed(modId)?.manifest.automatic ?? []).find((a) => a.id === action) : null;
      if (on && !decl) throw invalid(`${modId} declares no automatic action "${action}"`);
      if (decl) r.automatic = { ...(r.automatic ?? {}), [action]: structuredClone(decl) };
      else if (r.automatic) { delete r.automatic[action]; if (!Object.keys(r.automatic).length) delete r.automatic; }
      r.updatedAt = now();
      await c.persistState();
    });
    return done('succeeded');
  }
  function recoverSetAutomatic(op) {
    const { modId, action, on } = op.input;
    const r = rec(modId);
    if (!r) return done('failed', { note: 'The mod is no longer installed.' });
    return Boolean(r.automatic?.[action]) === on ? done('succeeded', { note: 'Recovered after a restart.' }) : done('failed', { note: 'Interrupted; the action was not changed.' });
  }

  // ------------------------------------------------------------------ set-policy (public-hooks.md §3.7)
  // The user's switch of one of its policies, by id: off is kept with the mod's record (registered again, it stays off); on forgets it.
  async function setPolicy(op) {
    const { modId, policy, on } = op.input;
    await c.step(op, 'apply', async () => {
      const r = need(modId);
      const off = new Set(r.policiesOff ?? []);
      if (on) off.delete(policy); else off.add(policy);
      if (off.size) r.policiesOff = [...off].sort(); else delete r.policiesOff;
      r.updatedAt = now();
      await c.persistState();
    });
    return done('succeeded');
  }
  function recoverSetPolicy(op) {
    const { modId, policy, on } = op.input;
    const r = rec(modId);
    if (!r) return done('failed', { note: 'The mod is no longer installed.' });
    return !(r.policiesOff ?? []).includes(policy) === on ? done('succeeded', { note: 'Recovered after a restart.' }) : done('failed', { note: 'Interrupted; the policy was not changed.' });
  }

  // ------------------------------------------------------------------ set-permission (framework-ui.md F8)
  // The user's decision on one optional permission. A mod running is restarted, since its rules, subscriptions and clients hold copies of what
  // it held; a change from ask to allow takes nothing away, and is written while it runs.
  async function setPermission(op) {
    const { modId, grant, decision } = op.input;
    const before = rec(modId)?.decisions?.[grant];
    const restart = c.isActive(modId) && !(before === 'ask' && decision === 'allow') && before !== decision;
    if (restart) await c.step(op, 'stop', () => c.runtime.deactivate(modId, 'permission'));
    await c.step(op, 'apply', async () => {
      const r = need(modId);
      const view = c.installed(modId);
      r.decisions = { ...decisionsFor(view.manifest, r.decisions), [grant]: decision };
      r.grants = grantsFor(view.manifest.permissions ?? [], r.decisions);
      r.updatedAt = now();
      await c.persistState();
    });
    c.permissionChanged?.(modId, grant, decision);
    if (restart) {
      const view = c.installed(modId);
      try { await c.step(op, 'activate', () => c.runtime.activate(view)); } catch (e) {
        rethrowCrash(e);
        await safeDeactivate(modId, 'activation-failed');
        const info = activationInfo(e);
        await c.step(op, 'stopped', async () => { const cur = rec(modId); if (cur) { cur.status = 'quarantined'; cur.quarantine = { reason: `It could not start again: ${info.error.message}`, at: now() }; cur.updatedAt = now(); await c.persistState(); } });
        return done(info.effects ? 'needs-attention' : 'failed', { error: info.error, note: `The permission was changed; starting it again failed: ${info.error.message}` });
      }
    }
    return done('succeeded');
  }
  function recoverSetPermission(op) {
    const { modId, grant, decision } = op.input;
    const r = rec(modId);
    if (!r) return done('failed', { note: 'The mod is no longer installed.' });
    const set = r.decisions?.[grant] === decision;
    // a running mod is started again by the Host's own start
    return set ? done('succeeded', { note: 'Recovered after a restart.' }) : done('failed', { note: 'Interrupted; the permission was not changed.' });
  }

  // ------------------------------------------------------------------ clear-quarantine
  async function clearQuarantine(op) {
    const { modId } = op.input;
    await c.step(op, 'apply', async () => {
      const r = need(modId);
      r.status = 'disabled'; delete r.quarantine; r.updatedAt = now();
      await c.persistState();
    });
    return done('succeeded');
  }
  function recoverClearQuarantine(op) {
    return rec(op.input.modId)?.status === 'quarantined' ? done('failed', { note: 'Interrupted; the mod is still quarantined.' }) : done('succeeded', { note: 'Recovered after a restart.' });
  }

  // ------------------------------------------------------------------ reload (framework-ui.md F5)
  // A runtime stop and start as one operation: it clears a quarantine and keeps every choice (its automatic actions, policies and permissions). One that cannot start again is left
  // stopped, saying why, since it no longer runs whatever its record said.
  async function reload(op) {
    const { modId } = op.input;
    const view = c.installed(modId);
    if (!view) throw invalid(`${modId}: its package could not be loaded`);
    await c.step(op, 'compatibility', () => {
      const compat = c.compatibility(view.manifest);
      if (compat.status === 'blocked') throw new CodexModsError('Incompatible', `${modId} cannot run here. ${blockedBecause(compat)}`, { compatibility: compat });
    });
    await c.step(op, 'stop', () => c.runtime.deactivate(modId, 'reload'));
    try { await c.step(op, 'activate', () => c.runtime.activate(view)); } catch (e) {
      rethrowCrash(e);
      await safeDeactivate(modId, 'activation-failed');
      const info = activationInfo(e);
      await c.step(op, 'stopped', async () => { const cur = rec(modId); if (cur) { cur.status = 'quarantined'; cur.quarantine = { reason: `It could not start again: ${info.error.message}`, at: now() }; cur.updatedAt = now(); await c.persistState(); } });
      return info.effects ? done('needs-attention', { error: info.error, note: `${info.error.code}: ${info.error.message} (starting it again may have had external effects)` }) : done('failed', { error: info.error });
    }
    await c.step(op, 'commit', async () => { const cur = rec(modId); if (cur) { cur.status = 'enabled'; delete cur.quarantine; cur.updatedAt = now(); await c.persistState(); } });
    return done('succeeded');
  }
  async function recoverReload(op) {
    const r = rec(op.input.modId);
    if (!r) return done('failed', { note: 'The mod is no longer installed.' });
    const last = lastPhase(op);
    if (last === 'commit' || last === 'stopped') {
      if (last === 'commit' && r.status === 'quarantined') { r.status = 'enabled'; delete r.quarantine; r.updatedAt = now(); await c.persistState(); }
      return done(last === 'commit' ? 'succeeded' : 'failed', { note: 'Recovered after a restart.' });
    }
    // an enabled mod is started by the Host's own start; a stopped one stays as it was
    if (r.status === 'enabled') return done('succeeded', { note: 'A restart started it again.' });
    return last === 'activate' ? done('needs-attention', { note: 'Starting it again was interrupted by a restart and may have had external effects; it is still stopped.' })
      : done('failed', { note: 'Interrupted; it is still stopped.' });
  }

  // ------------------------------------------------------------------ update / rollback: the version-switching tail
  const addedPermissions = (manifest, grants) => (manifest.permissions ?? []).filter((p) => !permissionCovered(p, grants));

  async function update(op) {
    // Store lock: verify → store. After 'store' the version is protected by this op's journaled result.version (GC reads running ops
    // of every profile), so the lock is not held through migration and the health window.
    const hold = await c.holdStore();
    try { return await updateLocked(op, hold.release); } finally { await hold.release(); }
  }

  async function updateLocked(op, releaseStore) {
    const { modId, source } = op.input;
    const r = need(modId);
    // If the source cannot even be stat'ed (unreadable volume), trust the record: a development mod is updated from a directory.
    const isDir = await stat(source).then((s) => s.isDirectory(), () => Boolean(r.dev));
    const pkg = await c.step(op, 'verify', () => c.packages.verify(source, { dev: isDir, ...(op.input.github ? { digest: githubOf(op.input.github, 'github').digest } : {}) }));
    try {
      const m = pkg.manifest;
      if (m.id !== modId) throw invalid(`${modId}: the package is ${m.id}`);
      let compat;
      await c.step(op, 'compatibility', () => {
        const cur = need(modId);
        if (cur.publisher !== null && pkg.publisher === null) throw new CodexModsError('Denied', `${modId} is a signed package; a development package cannot replace it`);
        if (cur.publisher === null && pkg.publisher === null && resolve(cur.dev.sourceDir) !== resolve(pkg.dir)) {
          throw invalid(`${modId} was loaded from ${cur.dev.sourceDir}; install the other directory instead`);
        }
        if (pkg.publisher !== null && m.version === cur.version) throw invalid(`${modId} is already at version ${m.version}`);
        // F10: an update found on GitHub only moves forward (an older release offered before a newer file was installed is not one)
        if (op.input.github && !(parseVersion(m.version) && parseVersion(cur.version) && compareVersions(parseVersion(m.version), parseVersion(cur.version)) > 0)) {
          throw invalid(`${modId} ${m.version} is not newer than ${cur.version}, which it runs`);
        }
        compat = c.compatibility(m);
        if (compat.status === 'blocked') throw new CodexModsError('Incompatible', `${modId}@${m.version} cannot run here. ${blockedBecause(compat)}`, { compatibility: compat });
      }, { modId, version: m.version });
      await c.step(op, 'store', () => c.packages.store(pkg));
      await releaseStore();
      const cur = rec(modId);
      const added = addedPermissions(m, requiredOf(cur));
      const publisherChange = (pkg.publisher ?? null) !== (cur.publisher ?? null);
      // F10: the repository is where to look, not who it is; one renamed, transferred or replaced by another (its id changed) is said in the review and asks again
      const github = op.input.github ? githubOf(op.input.github, 'github') : null;
      const repoChange = github && cur.source?.kind === 'github' && (cur.source.repoId !== github.repoId || cur.source.repo.toLowerCase() !== github.repo.toLowerCase())
        ? { from: cur.source.repo, to: github.repo, ...(cur.source.repoId !== github.repoId ? { another: true } : {}) } : null;
      if (added.length || publisherChange || repoChange) {
        await c.step(op, 'await-consent', async () => {
          const target = rec(modId);
          target.pendingUpdate = { version: m.version, addedPermissions: added, ...(publisherChange ? { newPublisher: pkg.publisher } : {}), ...(repoChange ? { repoChange } : {}), ...(github ? { github } : {}) };
          target.updatedAt = now();
          await c.persistState();
        });
        return done('succeeded', {
          awaiting: 'consent',
          note: `Update to ${m.version} is waiting for consent${publisherChange ? ' (publisher change)' : ''}${repoChange ? ` (now from ${repoChange.to})` : ''}${added.length ? `: new permissions ${added.join(', ')}` : ''}. ${cur.version} keeps running.`,
        });
      }
      return switchVersion(op, {
        kind: 'update', modId, manifest: m, publisherAfter: pkg.publisher, ...(github ? { github } : {}),
        packageDir: pkg.publisher === null ? pkg.dir : join(L.store, modId, m.version),
        devAfter: pkg.publisher === null ? { sourceDir: pkg.dir } : undefined,
      });
    } catch (e) {
      if (!c.isCrash(e) && isStaged(pkg.dir)) await rmrf(pkg.dir);
      throw e;
    }
  }

  /** Approving a pendingUpdate: continue the update from the staged package. */
  async function continueUpdate(op, r) {
    const { modId } = op.input;
    const pu = r.pendingUpdate;
    await c.step(op, 'approve', null, { target: 'update', modId });
    let t;
    if (pu.newPublisher !== undefined || !r.dev) {
      const packageDir = join(L.store, modId, pu.version);
      const manifest = c.readManifestSync(packageDir, true);
      if (!manifest) throw invalid(`${modId}@${pu.version}: the staged package is missing`);
      const publisherAfter = pu.newPublisher !== undefined ? pu.newPublisher : r.publisher;
      if ((manifest.publisher ?? null) !== (publisherAfter ?? null)) throw new CodexModsError('Denied', `${modId}@${pu.version}: the staged package is signed by another key`);
      t = { kind: 'update', modId, manifest, publisherAfter, packageDir, devAfter: undefined, ...(pu.github ? { github: pu.github } : {}) };
    } else {
      const pkg = await c.packages.verify(r.dev.sourceDir, { dev: true });
      const extra = addedPermissions(pkg.manifest, requiredOf(r)).filter((p) => !pu.addedPermissions.includes(p));
      if (extra.length) {
        await c.step(op, 'await-consent', async () => {
          rec(modId).pendingUpdate = { version: pkg.manifest.version, addedPermissions: addedPermissions(pkg.manifest, requiredOf(r)) };
          await c.persistState();
        });
        return done('succeeded', { awaiting: 'consent', note: `The development package now asks for more permissions: ${extra.join(', ')}.` });
      }
      t = { kind: 'update', modId, manifest: pkg.manifest, publisherAfter: null, packageDir: pkg.dir, devAfter: { sourceDir: pkg.dir } };
    }
    return switchVersion(op, t);
  }

  function planRollback(input) {
    const { modId, toVersion, restoreData } = input;
    const r = need(modId);
    if (r.status === 'pending-consent') throw invalid(`${modId} is awaiting consent`);
    if (r.dev) throw invalid(`${modId} is a development package; there are no stored versions to roll back to`);
    if (toVersion === r.version) throw invalid(`${modId} is already at ${toVersion}`);
    const dir = join(L.store, modId, toVersion);
    if (!existsSync(dir)) throw invalid(`${modId}@${toVersion} is not in the store`);
    const manifest = c.readManifestSync(dir, true);
    if (!manifest || manifest.id !== modId || manifest.version !== toVersion) throw invalid(`${modId}@${toVersion}: the stored package is damaged`);
    if ((manifest.publisher ?? null) !== (r.publisher ?? null)) throw new CodexModsError('Denied', `${modId}@${toVersion} was published under a different key; rolling back across a publisher change is not allowed`);
    const missing = addedPermissions(manifest, r.grants);
    if (missing.length) throw new CodexModsError('Denied', `${modId}@${toVersion} needs permissions that were not granted: ${missing.join(', ')}`);
    const compat = c.compatibility(manifest);
    if (compat.status === 'blocked') throw new CodexModsError('Incompatible', `${modId}@${toVersion} cannot run here. ${blockedBecause(compat)}`, { compatibility: compat });
    const toSchema = manifest.data?.schemaVersion ?? 0;
    if (restoreData) {
      if (!existsSync(snapshotDir(modId, toVersion))) throw invalid(`there is no data snapshot taken at ${toVersion}; roll back the code only, or not at all`);
    } else if (toSchema !== r.dataSchemaVersion) {
      throw invalid(`${toVersion} uses data schema ${toSchema} but the data is at schema ${r.dataSchemaVersion}; a code-only rollback is blocked${existsSync(snapshotDir(modId, toVersion)) ? ' (a snapshot exists: roll back with data)' : ''}`);
    }
    return { manifest, dir, restoreData: Boolean(restoreData) };
  }

  async function rollback(op) {
    const { modId } = op.input;
    const r = need(modId);
    const p = planRollback(op.input);
    return switchVersion(op, { kind: 'rollback', modId, manifest: p.manifest, publisherAfter: r.publisher, packageDir: p.dir, restoreData: p.restoreData });
  }

  async function takeSnapshot(op, plan) {
    const tmp = snapshotTmp(plan.modId, op.id);
    await rmrf(tmp);
    await cloneDir(dataDir(plan.modId), tmp);
    const finalDir = snapshotDir(plan.modId, plan.from);
    await rmrf(finalDir);
    await rename(tmp, finalDir);
  }

  async function restoreFromSnapshot(plan, opId, version = plan.from) {
    const snap = snapshotDir(plan.modId, version);
    if (!(await exists(snap))) throw new CodexModsError('Unavailable', `snapshot ${plan.modId}@${version} is missing`);
    const tmp = restoreTmp(opId);
    await rmrf(tmp);
    await cloneDir(snap, tmp);
    await replaceDir(dataDir(plan.modId), tmp);
  }

  const dataMayHaveChanged = (plan, reached) =>
    plan.doSnapshot && rank(reached) >= ((plan.doMigrate || plan.doRestore) ? RANK.swap : RANK.activate);

  /** Puts data/<id> back as it was before the op, given how far the op got. Idempotent. */
  async function undoData(op, plan, reached) {
    await rmrf(stagingData(op.id));
    await rmrf(restoreTmp(op.id));
    if (reached === 'snapshot' || reached === 'stop') await rmrf(snapshotTmp(plan.modId, op.id));
    if (dataMayHaveChanged(plan, reached)) await restoreFromSnapshot(plan, op.id);
  }

  async function migrateStaged(op, plan, t) {
    const staged = stagingData(op.id);
    await rmrf(staged);
    await cloneDir(dataDir(plan.modId), staged);
    const mod = c.viewOf({ ...rec(plan.modId), version: plan.to, dataSchemaVersion: plan.fromSchema }, t.manifest, t.packageDir);
    try {
      await c.runtime.runMigration({
        mod, script: join(t.packageDir, t.manifest.data.migrate), stagedDataDir: staged,
        from: plan.fromSchema, to: plan.toSchema, timeoutMs: c.migrationTimeoutMs,
      });
    } catch (e) { await rmrf(staged); throw e; }
  }

  async function pruneSnapshots(modId, keepNewest = 2, protect = []) {
    const dir = join(L.snapshots, modId);
    let names;
    try { names = (await readdir(dir)).filter((n) => !n.startsWith('.')); } catch { return; }
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    for (const { n } of withTime.slice(keepNewest)) if (!protect.includes(n)) await rmrf(join(dir, n));
  }

  async function switchVersion(op, t) {
    const id = t.modId;
    const r = rec(id);
    const fromSchema = r.dataSchemaVersion, toSchema = t.manifest.data?.schemaVersion ?? 0;
    const running = r.status === 'enabled' && !c.safeModeActive();
    const dataExists = await exists(dataDir(id));
    const doRestore = t.kind === 'rollback' && Boolean(t.restoreData);
    const doSnapshot = dataExists && (doRestore || toSchema !== fromSchema);
    const doMigrate = t.kind === 'update' && doSnapshot && Boolean(t.manifest.data?.migrate);
    const oldRecord = structuredClone(r);
    delete oldRecord.pendingUpdate;
    const plan = {
      kind: t.kind, modId: id, from: r.version, to: t.manifest.version, fromSchema, toSchema, running,
      doSnapshot, doMigrate, doRestore, oldRecord, oldPublisher: r.publisher, publisherChange: (t.publisherAfter ?? null) !== (r.publisher ?? null),
    };
    let patch = { plan, modId: id };
    const take = () => { const p = patch; patch = undefined; return p; };
    let reached = null;
    const S = (name, fn) => { reached = name; return c.step(op, name, fn, take()); };

    try {
      if (running) await S('stop', () => c.runtime.deactivate(id, t.kind));
      if (doSnapshot) await S('snapshot', () => takeSnapshot(op, plan));
      if (doMigrate) {
        await S('migrate', () => migrateStaged(op, plan, t));
        await S('swap', () => replaceDir(dataDir(id), stagingData(op.id)));
      }
      if (doRestore) {
        await S('restore-data', async () => {
          const tmp = restoreTmp(op.id);
          await rmrf(tmp);
          await cloneDir(snapshotDir(id, plan.to), tmp);
          await replaceDir(dataDir(id), tmp);
        });
      }
    } catch (e) {
      rethrowCrash(e);
      return revertSwitch(op, plan, { reached, reason: String(e?.message ?? e), outcome: 'failed', error: c.errInfo(e) });
    }

    try {
      await S('apply', async () => {
        const cur = rec(id);
        cur.version = plan.to;
        cur.dataSchemaVersion = toSchema;
        const kept = decisionsFor(t.manifest, cur.decisions);
        cur.decisions = t.kind === 'rollback' ? restoredDecisions(kept, cur.decisions ?? {}) : kept;
        cur.grants = grantsFor(t.manifest.permissions ?? [], cur.decisions);
        cur.publisher = t.publisherAfter ?? null;
        // F10: a GitHub release records where it came from; a signed file in its place makes it a mod from a file, no longer checked on GitHub
        if (t.github) cur.source = { kind: 'github', ...t.github };
        else if (t.kind === 'update' && t.publisherAfter !== null && cur.source) cur.source = { kind: 'file' };
        if (t.devAfter) cur.dev = t.devAfter; else delete cur.dev;
        delete cur.pendingUpdate;
        keepAutomatic(cur, t.manifest);
        cur.updatedAt = now();
        await c.persistState();
      });
    } catch (e) {
      rethrowCrash(e);
      return revertSwitch(op, plan, { reached: 'apply', reason: String(e?.message ?? e), outcome: 'failed', error: c.errInfo(e) });
    }

    if (running) {
      const watch = t.kind === 'update' ? c.watchFaults(id) : null;
      try {
        try { await S('activate', () => c.runtime.activate(c.installed(id))); } catch (e) {
          rethrowCrash(e);
          const info = activationInfo(e);
          return revertSwitch(op, plan, {
            reached: 'activate', reason: `${plan.to} failed to start: ${info.error.message}`, outcome: info.effects ? 'needs-attention' : 'reverted', error: info.error,
          });
        }
        if (watch) {
          await S('health', () => watch.window(c.healthWindowMs));
          if (watch.fault) return revertSwitch(op, plan, { reached: 'health', reason: `${plan.to} faulted during the health window (${watch.fault})`, outcome: 'reverted' });
        }
      } finally { watch?.dispose(); }
    }

    await S('commit', () => pruneSnapshots(id, 2, [plan.from]));
    if (plan.publisherChange) await S('cleanup', () => c.runtime.deleteSecrets(id, publisherFingerprint(plan.oldPublisher)));
    return done('succeeded', { ...(plan.publisherChange ? { note: 'Publisher changed; the previous publisher\'s secrets were deleted.' } : {}) });
  }

  const revertNote = (plan, reason) =>
    `${plan.kind === 'rollback' ? 'Rollback to' : 'Update to'} ${plan.to} undone, back on ${plan.from}: ${reason}. External actions the new code took are not undone.`;

  /** Live revert: stop what started, restore data and the record, restart the old version. */
  async function revertSwitch(op, plan, { reached, reason, outcome, error }) {
    const id = plan.modId;
    await c.step(op, 'revert', async () => {
      if (plan.running) await safeDeactivate(id, 'revert');
      await undoData(op, plan, reached);
      c.state.mods[id] = { ...structuredClone(plan.oldRecord), updatedAt: now() };
      await c.persistState();
    }, { revert: { reached, outcome, note: revertNote(plan, reason), ...(error ? { error } : {}) } });
    let finalOutcome = outcome, note = outcome === 'failed' ? undefined : revertNote(plan, reason);
    if (plan.running) {
      try { await c.step(op, 'reactivate', () => c.runtime.activate(c.installed(id))); } catch (e) {
        rethrowCrash(e);
        await safeDeactivate(id, 'reactivate-failed');
        const cur = rec(id);
        if (cur) { cur.status = 'disabled'; cur.updatedAt = now(); await c.persistState(); }
        finalOutcome = 'needs-attention';
        note = `${revertNote(plan, reason)} Restarting ${plan.from} failed (${e?.message ?? e}); the mod is disabled.`;
      }
    }
    return done(finalOutcome, { ...(note ? { note } : {}), ...(error && finalOutcome !== 'reverted' ? { error } : {}) });
  }

  async function recoverSwitch(op) {
    const plan = op.result?.plan;
    if (!plan) return done('failed', { note: 'Interrupted before anything was applied.' });
    const id = plan.modId;
    const last = lastPhase(op);
    const restoreRecord = async () => { c.state.mods[id] = { ...structuredClone(plan.oldRecord), updatedAt: now() }; await c.persistState(); };
    switch (last) {
      case 'commit': case 'cleanup':
        await pruneSnapshots(id, 2, [plan.from]);
        if (plan.publisherChange) await c.runtime.deleteSecrets(id, publisherFingerprint(plan.oldPublisher));
        return done('succeeded', { note: 'Recovered after a restart.' });
      case 'revert': case 'reactivate': {
        const info = op.result.revert ?? { reached: 'activate', outcome: 'reverted', note: revertNote(plan, 'interrupted') };
        await undoData(op, plan, info.reached);
        await restoreRecord();
        const outcome = info.outcome;
        return done(outcome, { note: `${info.note} (recovered after a restart)`, ...(info.error && outcome !== 'reverted' ? { error: info.error } : {}) });
      }
      case 'health':
        await undoData(op, plan, 'health');
        await restoreRecord();
        return done('reverted', { note: `${revertNote(plan, 'the Host restarted during the health window')}` });
      case 'activate':
        await undoData(op, plan, 'activate');
        await restoreRecord();
        return done('needs-attention', { note: `${revertNote(plan, 'the Host restarted while the new version was starting')} It may have had external effects.` });
      default: // stop, snapshot, migrate, swap, restore-data, apply: new code never ran
        await undoData(op, plan, last);
        await restoreRecord();
        return done('failed', { note: `Interrupted before ${plan.to} started; rolled back to ${plan.from}, nothing was applied.` });
    }
  }

  async function recoverUpdate(op) {
    if (!op.result?.plan && lastPhase(op) === 'await-consent') return recoverAwaitConsent(op);
    return recoverSwitch(op);
  }
  function recoverAwaitConsent(op) {
    const pu = rec(op.input.modId)?.pendingUpdate;
    if (pu && (op.result?.version === undefined || pu.version === op.result.version)) {
      return done('succeeded', { awaiting: 'consent', note: `Update to ${pu.version} is waiting for consent (recovered after a restart).` });
    }
    return done('failed', { note: 'Interrupted before the update was staged for consent; nothing was applied.' });
  }

  // ------------------------------------------------------------------ remove
  /** Keep-data removal: data/<id> becomes a NEW generation orphaned/<id>/<at>; earlier generations are never touched. Idempotent. */
  async function moveToOrphaned(plan) {
    const id = plan.modId;
    const gen = orphans.genDir(id, plan.at);
    if (await exists(dataDir(id))) {
      if (await exists(gen)) throw new CodexModsError('Conflict', `orphaned generation ${plan.at} already exists`);
      await ensureDir(orphans.dirOf(id));
      await rename(dataDir(id), gen);
    }
    if ((await exists(gen)) && !orphans.hasMeta(id, plan.at)) {
      orphans.writeMeta(id, plan.at, { publisher: plan.publisher, version: plan.version, dataSchemaVersion: plan.dataSchemaVersion, removedAt: plan.at });
    }
  }

  async function deleteEverything(plan) {
    const id = plan.modId;
    await c.runtime.deleteSecrets(id, publisherFingerprint(plan.publisher));
    for (const p of [dataDir(id), join(L.retained, id), join(L.snapshots, id), orphans.dirOf(id), join(L.backends, id)]) await rmrf(p);
  }

  /** The mod's current record, or (when a previous removal stopped half-way) the plan that removal journaled. */
  function planRemove(input, selfId) {
    const { modId, deleteData } = input;
    const r = rec(modId);
    if (r) return { plan: { modId, version: r.version, publisher: r.publisher ?? null, dataSchemaVersion: r.dataSchemaVersion, deleteData, at: orphans.uniqueAt(modId) }, status: r.status };
    const last = [...c.ops.values()].filter((o) => o.id !== selfId && o.input.type === 'remove' && o.input.modId === modId)
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).at(-1);
    if (last?.outcome === 'needs-attention' && last.result?.plan) return { plan: { ...last.result.plan, deleteData, at: orphans.uniqueAt(modId) }, status: null };
    throw invalid(`${modId} is not installed`);
  }

  async function remove(op) {
    const { modId, deleteData } = op.input;
    const { plan, status } = planRemove(op.input, op.id);
    const unrecord = async () => { if (rec(modId)) { delete c.state.mods[modId]; await c.persistState(); } };
    await c.step(op, 'stop', async () => {
      if (status === 'enabled' || c.isActive(modId)) await c.runtime.deactivate(modId, 'remove');
      await c.mux.disposeOwner(`mod:${modId}`);
    }, { plan, modId });
    if (deleteData) {
      await c.step(op, 'unrecord', unrecord);
      await c.step(op, 'delete-data', () => deleteEverything(plan));
    } else {
      await c.step(op, 'move-data', () => moveToOrphaned(plan));
      await c.step(op, 'unrecord', unrecord);
    }
    return done('succeeded', { note: deleteData ? 'Data, secrets, snapshots and backends deleted.' : `Data kept as orphaned generation ${plan.at} for reinstall.` });
  }

  async function recoverRemove(op) {
    const plan = op.result?.plan;
    const last = lastPhase(op);
    if (!plan || last === 'stop') return done('failed', { note: 'Interrupted before the removal started; the mod is still installed.' });
    // Past the stop phase the removal rolls forward (every step is idempotent).
    if (plan.deleteData) {
      delete c.state.mods[plan.modId]; await c.persistState();
      await deleteEverything(plan);
    } else {
      await moveToOrphaned(plan);
      delete c.state.mods[plan.modId]; await c.persistState();
    }
    return done('succeeded', { note: 'Removal completed after a restart.' });
  }

  // ------------------------------------------------------------------ reattach
  function planReattach(input) {
    const { modId } = input;
    const r = need(modId);
    const gens = orphans.list(modId);
    if (!gens.length) throw invalid(`${modId} has no orphaned data`);
    const gen = input.generation === undefined ? gens[0] : gens.find((g) => g.at === input.generation);   // newest unless one is named
    if (!gen) throw invalid(`${modId} has no orphaned generation ${input.generation}; available: ${gens.map((g) => g.at).join(', ')}`);
    if (!('publisher' in gen.meta)) throw new CodexModsError('Denied', `${modId}: the orphaned data has no provenance record`);
    if ((gen.publisher ?? null) !== (r.publisher ?? null)) throw new CodexModsError('Denied', `${modId}: the orphaned data belongs to a different publisher`);
    const view = c.installed(modId);
    if (!view) throw invalid(`${modId}: its package could not be loaded`);
    const toSchema = view.manifest.data?.schemaVersion ?? 0;
    if (gen.dataSchemaVersion > toSchema) throw invalid(`the orphaned data is at schema ${gen.dataSchemaVersion}, newer than the installed version supports (${toSchema})`);
    if (existsSync(dataDir(modId))) throw new CodexModsError('Conflict', `${modId} already has data; remove it first`);
    return { view, gen, meta: gen.meta, toSchema, doMigrate: gen.dataSchemaVersion < toSchema && Boolean(view.manifest.data?.migrate) };
  }

  // Reattach publishes nothing: the mod's package is already referenced by state.json, so it takes no store lock
  // (holding it through a 60 s migration would block every install and GC). An enabled mod is one operation (E6): it is turned off,
  // its data reattached, and turned on again (`reenable`); a failure to turn it on leaves the data attached and the mod off.
  async function reattach(op) {
    const { modId } = op.input;
    const p = planReattach(op.input);
    const reenable = rec(modId).status === 'enabled';
    const plan = { modId, toSchema: p.toSchema, fromSchema: p.gen.dataSchemaVersion, doMigrate: p.doMigrate, generation: p.gen.at, ...(reenable ? { reenable } : {}) };
    const staged = stagingData(op.id);
    let first = { plan, modId };
    const take = () => { const x = first; first = undefined; return x; };
    if (reenable) {
      await c.step(op, 'deactivate', () => c.runtime.deactivate(modId, 'reattach'), take());
      await c.step(op, 'disable', async () => { const cur = rec(modId); cur.status = 'disabled'; cur.updatedAt = now(); await c.persistState(); });
      // it may have written data while it ran: never overwritten (the operation ends needing attention, the mod off)
      if (existsSync(dataDir(modId))) throw new CodexModsError('Conflict', `${modId} wrote data before it stopped; its data was not replaced. Turn it on again, or remove its data first`);
    }
    try {
      if (p.doMigrate) {
        await c.step(op, 'stage', async () => { await rmrf(staged); await cloneDir(p.gen.dir, staged); await rmrf(join(staged, ORPHAN_META)); }, take());
        await c.step(op, 'migrate', () => c.runtime.runMigration({
          mod: p.view, script: join(p.view.packageDir, p.view.manifest.data.migrate), stagedDataDir: staged,
          from: plan.fromSchema, to: plan.toSchema, timeoutMs: c.migrationTimeoutMs,
        }), take());
      }
    } catch (e) {
      rethrowCrash(e);
      await rmrf(staged);
      throw e;
    }
    await c.step(op, 'attach', async () => {
      await ensureDir(L.data);
      await rename(p.doMigrate ? staged : p.gen.dir, dataDir(modId));
    }, take());
    await c.step(op, 'finish', () => finishReattach(plan));
    return reenable ? enableTail(op, modId) : done('succeeded');
  }

  async function finishReattach(plan) {
    const r = rec(plan.modId);
    if (r) { r.dataSchemaVersion = plan.toSchema; r.updatedAt = now(); await c.persistState(); }
    await rmrf(join(dataDir(plan.modId), ORPHAN_META));                 // the provenance record travelled with the renamed generation
    await rmrf(orphans.genDir(plan.modId, plan.generation));            // the consumed generation (still there after a migrated attach)
    orphans.pruneEmpty(plan.modId);                                     // other generations stay
  }

  async function recoverReattach(op) {
    const plan = op.result?.plan;
    if (!plan) return done('failed', { note: 'Interrupted before anything was applied.' });
    const last = lastPhase(op);
    // Turning the mod on again (reenable) was interrupted after its data was attached: as an enable's recovery, never activating here.
    if (plan.reenable && last === 'activate') return done('needs-attention', { note: 'The data was reattached; turning the mod on again was interrupted by a restart and may have had external effects, so it was left off.' });
    // Anything else: the data is attached or untouched, and a mod that was on is on again (the boot activates it). Attached only on the
    // attach's own evidence (E6 review): its phase was reached and its rename happened (the generation, or the migrated copy, moved into the
    // data directory), or a later phase was; a data directory without it is the mod's own, written while it stopped, never consumed.
    const turnOn = async () => { const r = rec(plan.modId); if (plan.reenable && r?.status === 'disabled') { r.status = 'enabled'; r.updatedAt = now(); await c.persistState(); } };
    const BEFORE_ATTACH = ['deactivate', 'disable', 'stage', 'migrate'];
    const hasData = await exists(dataDir(plan.modId));
    const attached = hasData && (last === 'attach'
      ? !(await exists(plan.doMigrate ? stagingData(op.id) : orphans.genDir(plan.modId, plan.generation)))
      : !BEFORE_ATTACH.includes(last));
    if (attached) { await finishReattach(plan); await turnOn(); return done('succeeded', { note: 'Recovered after a restart.' }); }
    await rmrf(stagingData(op.id));
    if (hasData) return done('needs-attention', { note: 'It wrote data before it stopped; its data was not replaced and the kept data is untouched. It was left off.' });
    await turnOn();
    return done('failed', { note: 'Interrupted before the data was attached; the orphaned data is untouched.' });
  }

  // ------------------------------------------------------------------ framework-level ops: delegated to Recovery
  async function framework(op) {
    const r = await c.recovery.runOp(structuredClone(op), (phase) => c.journal(op, phase));
    return done(r.outcome, { ...(r.note !== undefined ? { note: r.note } : {}), ...(r.result !== undefined ? { result: r.result } : {}) });
  }

  // ------------------------------------------------------------------ restoreFromGeneration
  async function restoreFromGeneration(g) {
    const restored = [], leftDisabled = [];
    const mods = c.state.mods;
    const genMods = g.state?.mods ?? {};
    const park = async (id, reason) => {
      const r = mods[id];
      if (r.status === 'enabled') {
        if (c.runtime.status(id) !== 'inactive') await safeDeactivate(id, 'restore');
        r.status = 'disabled'; r.updatedAt = now();
      }
      leftDisabled.push({ modId: id, reason });
    };
    for (const id of Object.keys(genMods).sort()) {
      const want = genMods[id], have = mods[id];
      if (!have) { leftDisabled.push({ modId: id, reason: 'not installed any more (its data may be under orphaned/)' }); continue; }
      if (have.status === 'pending-consent') { leftDisabled.push({ modId: id, reason: 'an install is awaiting consent' }); continue; }
      if (have.dataSchemaVersion !== want.dataSchemaVersion) {
        await park(id, `data is at schema ${have.dataSchemaVersion}, the generation expects ${want.dataSchemaVersion}`); continue;
      }
      if (!want.dev && !existsSync(join(L.store, id, want.version))) { await park(id, `version ${want.version} is no longer in the store`); continue; }
      // a restore never raises a decision (F8): a grant it required then, optional now and not allowed, would be held again without you
      const lowered = requiredOf(want).filter((g) => Object.hasOwn(have.decisions ?? {}, g) && have.decisions[g] !== 'allow');
      if (lowered.length) { await park(id, `it would hold ${lowered.join(', ')} again, which you set to ${lowered.map((g) => have.decisions[g]).join(', ')}`); continue; }
      if (c.runtime.status(id) !== 'inactive') await safeDeactivate(id, 'restore');
      mods[id] = { ...structuredClone(want), installSeq: have.installSeq };
      // a restore never raises a decision (F8): a later deny wins over an older allow
      if (want.decisions) {
        const decisions = restoredDecisions(want.decisions, have.decisions ?? {});
        mods[id].grants = grantsFor(requiredOf(want), decisions);
        mods[id].decisions = decisions;
      }
      if (g.settings && g.settings[id] !== undefined) await writeJsonAtomic(settingsFile(id), g.settings[id]);
      // The overrides at narrower scopes go back too; a generation without them had none (an older generation: left as they are).
      if (g.settingsScopes && g.settingsScopes[id] !== undefined) await writeJsonAtomic(scopesFile(id), g.settingsScopes[id]);
      else if (g.settingsScopes) await rm(scopesFile(id), { force: true });
      restored.push(id);
    }
    for (const id of Object.keys(mods).sort()) {
      if (genMods[id]) continue;
      if (mods[id].status === 'pending-consent') continue;
      await park(id, 'not part of the generation');
    }
    c.state.nextInstallSeq = Math.max(c.state.nextInstallSeq, g.state?.nextInstallSeq ?? 0, ...Object.values(mods).map((m) => (m.installSeq ?? 0) + 1));
    await c.persistState();
    return { restored, leftDisabled };
  }

  async function cleanupStaging() {
    const root = join(L.store, '.staging');
    for (const name of await readdir(root).catch(() => [])) await rmrf(join(root, name));
  }

  // ------------------------------------------------------------------ copy-update (docs/design/systems.md S20, "E5 in detail")
  // One update of the copy: the app build, the framework and the mods' updates, as one operation. Before its switch it excludes mod
  // operations, and everything it did is undone from its record; after the switch the swap helper, the loader and the health gate decide,
  // and the reconcile gives the verdict (succeeded once the new generation is healthy and last-known-good; reverted when the loader reverts).
  const SWITCH = 'swapping';
  const switchedOf = (op) => op.phases.some((p) => p.name === SWITCH);
  const committedOf = (op) => [...new Set(op.phases.map((p) => /^mod-commit:([^:]+):/.exec(p.name)?.[1]).filter(Boolean))];
  const reachedOf = (op, id) => { const last = [...op.phases].reverse().find((p) => p.name.startsWith(`mod-commit:${id}:`)); return last ? last.name.slice(`mod-commit:${id}:`.length) : null; };
  const sha256File = async (file) => { try { return createHash('sha256').update(await readFile(file)).digest('hex'); } catch { return null; } };

  async function copyUpdate(op) {
    const R = c.recovery.update;
    const plan = await readPlan(L, op.input.plan);
    const chosen = choose(plan, op.input.consent ?? []);
    const verdict = verdictOf(chosen);
    const left = op.input.anyway ? verdict.risks.map((r) => r.mod) : [];
    const takes = chosen.filter((x) => x.takes && !left.includes(x.id));
    const ptr = await R.pointers();
    let reached = 'recheck';
    try {
      await c.step(op, 'recheck', async () => {
        await recheckPlan(plan, { state: c.state, exists, sha256: sha256File, buildReport: (app) => readJson(join(dirname(app), 'build-report.json'), null) });
        if (verdict.held && !op.input.anyway) {
          throw new CodexModsError('Conflict', `the update is held: ${verdict.risks.map((r) => `${r.mod}: ${r.sentences.join(' ') || r.status}`).join(' ')}`, { held: true, risks: verdict.risks });
        }
      }, { plan: plan.hash, offer: plan.offer?.id ?? null, chosen, left, candidate: plan.candidate.path, framework: plan.framework ? { from: plan.framework.from, to: plan.framework.to } : null,
        pointers: { current: ptr.current, previous: ptr.previous }, leftFrom: {}, mods: {} });
      // 2. the mods the user leaves behind
      for (const id of left) {
        reached = `leave:${id}`;
        const r = need(id);
        await c.step(op, `leave:${id}`, async () => {
          await safeDeactivate(id, 'update');
          const cur = need(id);
          cur.status = 'disabled';
          cur.leftBehind = { op: op.id, plan: plan.hash, at: now(), why: verdict.risks.find((x) => x.mod === id)?.sentences ?? [] };
          cur.updatedAt = now();
          await c.persistState();
        }, { leftFrom: { ...(op.result?.leftFrom ?? {}), [id]: { status: r.status, updatedAt: r.updatedAt ?? null } } });
      }
      // 3 and 4. each incoming mod verified and stored, then committed: stopped, its data snapshot taken, migrated into a clone, swapped in,
      // its record set (no activation: the new build activates it)
      const hold = takes.length ? await c.holdStore() : null;
      const pkgs = {};
      try {
        for (const t of takes) {
          const inc = plan.enabled.find((m) => m.id === t.id).incoming;
          reached = `mod-verify:${t.id}`;
          const pkg = await c.step(op, `mod-verify:${t.id}`, async () => {
            // the bytes staging checked, by their sha256 (a GitHub release's package or the release's own)
            const p = await c.packages.verify(inc.package, { dev: false, frameworkVersion: plan.framework?.to, digest: `sha256:${inc.sha256}` });
            const cur = need(t.id);
            if (p.manifest.id !== t.id || p.manifest.version !== t.to) throw invalid(`the package for ${t.id} is ${p.manifest.id}@${p.manifest.version}`);
            if ((p.publisher ?? null) !== (cur.publisher ?? null)) throw new CodexModsError('Denied', `the package for ${t.id} has another publisher`);
            // F8: what it requires beyond what it holds as required now, read again under the lock: only with the user's consent to this update
            const added = addedPermissions(p.manifest, requiredOf(cur));
            if (added.length && !(op.input.consent ?? []).includes(t.id)) throw new CodexModsError('Denied', `${t.id} ${t.to} requires ${added.join(', ')}, which you have not approved; review the update again`);
            await c.packages.store(p);
            return p;
          }, { versions: { ...(op.result?.versions ?? {}), [t.id]: t.to } });
          pkgs[t.id] = pkg;
        }
      } finally { await hold?.release(); }
      for (const t of takes) {
        const m = pkgs[t.id].manifest;
        const r = need(t.id);
        const fromSchema = r.dataSchemaVersion, toSchema = m.data?.schemaVersion ?? 0;
        const doSnapshot = (await exists(dataDir(t.id))) && toSchema !== fromSchema;
        const mplan = { kind: 'update', modId: t.id, from: r.version, to: m.version, fromSchema, toSchema, running: c.runtime.status(t.id) !== 'inactive',
          doSnapshot, doMigrate: doSnapshot && Boolean(m.data?.migrate), doRestore: false, oldRecord: (() => { const o = structuredClone(r); delete o.pendingUpdate; return o; })() };
        const packageDir = join(L.store, t.id, m.version);
        let patch = { mods: { ...(op.result?.mods ?? {}), [t.id]: mplan } };
        const S = (name, fn) => { reached = `mod-commit:${t.id}:${name}`; const p = patch; patch = undefined; return c.step(op, `mod-commit:${t.id}:${name}`, fn, p); };
        await S('stop', () => safeDeactivate(t.id, 'update'));
        if (mplan.doSnapshot) await S('snapshot', () => takeSnapshot(op, mplan));
        if (mplan.doMigrate) {
          await S('migrate', () => migrateStaged(op, mplan, { manifest: m, packageDir }));
          await S('swap', () => replaceDir(dataDir(t.id), stagingData(op.id)));
        }
        await S('apply', async () => {
          const cur = need(t.id);
          cur.version = m.version;
          cur.dataSchemaVersion = toSchema;
          cur.decisions = decisionsFor(m, cur.decisions);
          cur.grants = grantsFor(m.permissions ?? [], cur.decisions);
          // F11: a GitHub release's version, applied with the copy, is where it comes from now
          const gh = plan.enabled.find((x) => x.id === t.id)?.incoming?.github;
          if (gh) cur.source = { kind: 'github', repo: gh.repo, repoId: gh.repoId, tag: gh.tag, digest: gh.digest, ...(gh.mod ? { mod: gh.mod } : {}) };
          delete cur.pendingUpdate;
          keepAutomatic(cur, m);
          cur.updatedAt = now();
          await c.persistState();
        });
      }
      // 5 and 6. the framework the candidate was built with, then its pointers
      if (plan.framework) {
        reached = 'framework-install';
        await c.step(op, 'framework-install', () => R.installFramework({ version: plan.framework.to, dir: plan.framework.dir, treeHash: plan.framework.treeHash }),
          { frameworkExisted: await exists(join(L.framework, plan.framework.to)) });
        reached = 'framework-pointers:previous';
        await c.step(op, 'framework-pointers:previous', () => R.setPointer('previous', ptr.current));
        reached = 'framework-pointers:current';
        await c.step(op, 'framework-pointers:current', () => R.setPointer('current', plan.framework.to));
      }
    } catch (e) {
      rethrowCrash(e);
      // A refusal at the recheck applied nothing; anything later is undone, and what was running runs again.
      if (reached !== 'recheck') await undoCopyUpdate(op, { live: true });
      return done('failed', { note: reached === 'recheck' ? String(e?.message ?? e) : `The update was undone, nothing was applied: ${e?.message ?? e}`, error: c.errInfo(e) });
    }
    // 7. the switch: from here the swap helper, the loader and the health gate decide
    await c.step(op, SWITCH, () => R.swap(op, plan.candidate.path));
    c.endExclusive(op);
    return done('running', { note: 'switching to the new copy; its first healthy boot completes the update' });
  }

  /** Everything the update did before its switch put back, from its record (idempotent); `live`: what was running runs again. */
  async function undoCopyUpdate(op, { live = false, keepLeft = false, pointers = true } = {}) {
    const R = c.recovery.update;
    const res = op.result ?? {};
    const journaled = (name) => op.phases.some((p) => p.name === name);
    if (pointers && (journaled('framework-pointers:previous') || journaled('framework-pointers:current'))) {
      await c.step(op, 'undo:framework-pointers', async () => { await R.setPointer('current', res.pointers?.current ?? null); await R.setPointer('previous', res.pointers?.previous ?? null); });
    }
    if (pointers && journaled('framework-install') && res.frameworkExisted === false && res.framework?.to) {
      await c.step(op, 'undo:framework-install', () => R.removeFramework(res.framework.to));
    }
    const committed = committedOf(op);
    for (const id of [...committed].reverse()) {
      const mplan = res.mods?.[id];
      if (!mplan) continue;
      await c.step(op, `undo:mod:${id}`, async () => {
        await undoData(op, mplan, reachedOf(op, id) ?? 'stop');
        const back = { ...structuredClone(mplan.oldRecord), updatedAt: now() };
        // undone, it never raises a decision (F8): one you lowered while the new copy waited for its first healthy boot stays
        const nowDecisions = c.state.mods[id]?.decisions;
        if (back.decisions && nowDecisions) {
          const decisions = restoredDecisions(back.decisions, nowDecisions);
          back.grants = grantsFor(requiredOf(back), decisions);
          back.decisions = decisions;
        }
        c.state.mods[id] = back;
        await c.persistState();
      });
    }
    if (!keepLeft) {
      for (const [id, was] of Object.entries(res.leftFrom ?? {})) {
        if (!journaled(`leave:${id}`)) continue;
        await c.step(op, `undo:leave:${id}`, async () => {
          const cur = rec(id);
          if (cur && cur.status === 'disabled' && cur.leftBehind?.op === op.id) { cur.status = was.status; delete cur.leftBehind; cur.updatedAt = now(); await c.persistState(); }
        });
      }
    }
    if (live) {
      for (const id of [...new Set([...committed, ...Object.keys(res.leftFrom ?? {})])]) {
        const cur = rec(id);
        if (cur?.status !== 'enabled' || c.runtime.status(id) !== 'inactive' || c.safeModeActive()) continue;
        try { await c.runtime.activate(c.installed(id)); } catch (e) {
          rethrowCrash(e);
          cur.status = 'disabled'; cur.updatedAt = now(); await c.persistState();
          log.warn('an update\'s undo could not restart a mod; it is disabled', { modId: id, error: String(e?.message ?? e) });
        }
      }
    }
  }

  /**
   * The update after a restart: undone before its switch; after it, from the helper's receipt, the symlink, the pointers and this boot's
   * health. Answers the outcome, or null while it waits for its verdict (then it holds only the framework lock and its mods).
   * `early`: before the boot's generation is recorded (the Host's first call), which also waits a while for a swap helper still at work.
   */
  async function recoverCopyUpdate(op, { early = false } = {}) {
    const R = c.recovery.update;
    const res = op.result ?? {};
    const last = lastPhase(op) ?? '';
    if (!switchedOf(op) || last.startsWith('undo:')) {
      if (!res.plan) return done('failed', { note: 'Interrupted before anything was applied.' });
      const switched = switchedOf(op);
      await undoCopyUpdate(op, { keepLeft: last.startsWith('undo:') && op.result?.verdict === 'reverted' });
      if (op.result?.verdict === 'reverted') return done('reverted', { note: op.result.verdictNote });
      return done('failed', { note: switched ? `The switch did not happen (${op.result?.switchNote ?? 'the swap failed'}); the update was undone, nothing was applied.`
        : 'Interrupted before the switch; the update was undone, nothing was applied.' });
    }
    const candidate = res.candidate;
    let f = await R.facts(op, candidate);
    // A boot can race the swap helper: on a failed open it reopens the previous copy before it writes its receipt.
    for (let i = 0; early && !f.receipt && !f.done && i < (c.swapWaitTicks ?? 60); i++) { await new Promise((r) => setTimeout(r, c.swapWaitMs ?? 500)); f = await R.facts(op, candidate); }
    const fwTo = res.framework?.to ?? null;
    if (f.failed) {
      op.result = { ...res, switchNote: f.note };
      await undoCopyUpdate(op);
      return done('failed', { note: `The switch did not happen (${f.note}); the update was undone, nothing was applied.` });
    }
    if (f.attention) return done('needs-attention', { note: `After the switch: ${f.note}. The mods' updates stay; check the copy.` });
    const runningCandidate = !!f.running && await samePath(f.running, candidate);
    const onLkgApp = !!f.pointers.lkgApp && !!f.target && await samePath(f.target, f.pointers.lkgApp) && !(await samePath(f.pointers.lkgApp, candidate));
    const fwBack = !fwTo || (f.pointers.current === f.pointers.lkg && f.pointers.current !== fwTo);
    if (f.done && !runningCandidate && onLkgApp && fwBack) {
      // The loader reverted: the new generation was never healthy. The mods' data and records go back; those left behind stay off.
      const note = 'The new build never became healthy; the loader went back to the last known good copy. The mods\' updates were undone (data they wrote since is lost)'
        + `${Object.keys(res.leftFrom ?? {}).length ? '; the mods left behind stay disabled' : ''}.`;
      op.result = { ...res, verdict: 'reverted', verdictNote: note };
      await undoCopyUpdate(op, { keepLeft: true, pointers: false });
      return done('reverted', { note });
    }
    if (!runningCandidate) return early ? null : null;
    const g = R.healthy();
    if (!g) return null;
    const lkgOk = (await samePath(f.pointers.lkgApp ?? '', candidate)) && (!fwTo || f.pointers.lkg === fwTo);
    const versions = new Map((g.mods ?? []).map((m) => [m.id, m.version]));
    const modsOk = Object.entries(res.versions ?? {}).every(([id, v]) => !committedOf(op).includes(id) || versions.get(id) === v)
      && (res.left ?? []).every((id) => !versions.has(id));
    if (!(lkgOk && (await samePath(g.appCandidate ?? '', candidate)) && (!fwTo || g.frameworkVersion === fwTo) && modsOk)) return null;
    for (const id of committedOf(op)) await pruneSnapshots(id, 2, [res.mods?.[id]?.from].filter(Boolean));
    return done('succeeded', { note: `The copy runs the update (generation ${g.n}), and it is the last known good.` });
  }

  /** Restoring last-known-good while an update waits for its verdict: the update is concluded first, reverted (its mods' undo). */
  async function concludeCopyUpdate(op, reason) {
    const note = `${reason}; the mods' updates were undone (data they wrote since is lost).`;
    op.result = { ...(op.result ?? {}), verdict: 'reverted', verdictNote: note };
    await undoCopyUpdate(op, { keepLeft: true, pointers: false });
    return done('reverted', { note });
  }

  const handlers = {
    install, consent, enable, disable, configure, update, rollback, remove, reattach, 'clear-quarantine': clearQuarantine, reload, 'set-permission': setPermission, 'set-automatic': setAutomatic, 'set-policy': setPolicy,
    ...Object.fromEntries(FRAMEWORK_TYPES.map((t) => [t, framework])),
    'copy-update': copyUpdate,
  };
  const recoverers = {
    install: recoverInstall, consent: recoverConsent, enable: recoverEnable, disable: recoverDisable, configure: recoverConfigure,
    update: recoverUpdate, rollback: recoverSwitch, remove: recoverRemove, reattach: recoverReattach, 'clear-quarantine': recoverClearQuarantine, reload: recoverReload, 'set-permission': recoverSetPermission, 'set-automatic': recoverSetAutomatic, 'set-policy': recoverSetPolicy,
  };
  return { handlers, recoverers, validateInput, peekModId, preflight, restoreFromGeneration, cleanupStaging, recoverCopyUpdate, concludeCopyUpdate, switchedOf };
}
