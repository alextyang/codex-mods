// codexmods recovery safe on|off | disable | enable | lkg (ARCHITECTURE §12.4).
// The flag commands work offline, with no Host running. With a Host running, `safe` goes through the safe-mode operation so that
// the Host's own state stays consistent; `disable`/`enable` only touch the flag (the relay and loader read it at launch).
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CodexModsError } from '../../sdk/errors.mjs';
import { writeJsonAtomic, readJson, now } from '../../framework/host/fsutil.mjs';
import { FLAGS } from '../../contracts/layout.mjs';
import {
  exists, readText, writeTextAtomic, readLinkAbs, replaceSymlinkAtomic, samePath, connectManagement, waitForOp, resetBootMarker,
} from '../../framework/host/recovery/support.mjs';
import { context, guarded } from '../../framework/host/recovery/cli-common.mjs';

const USAGE = 'usage: codexmods recovery safe on|off | disable | enable | lkg | guard list | guard untrust <n>';

const requireCjs = createRequire(import.meta.url);
/** framework-main's trust-list helper (framework/main/guard-trust.cjs); `deps.guardTrust` replaces it in tests. */
const loadGuardTrust = (c) => c.deps.guardTrust ?? requireCjs('../../framework/main/guard-trust.cjs');

/** Keeps state.json's safeMode consistent with the flag when no Host owns the file. */
async function patchStateSafeMode(layout, value) {
  const state = await readJson(layout.state, undefined);
  if (state && state.safeMode !== value) await writeJsonAtomic(layout.state, { ...state, safeMode: value });
}
async function hostOp(c, method, params) {
  const client = await (c.deps.connectManagement ?? connectManagement)(c.layout);
  if (!client) return null;
  try {
    const { opId } = await client.request(method, params);
    if (c.flags.wait !== true) { c.print(`started ${opId}; the app restarts`, { opId }); return 0; }
    const op = await waitForOp(client, opId, c.deps.wait);
    c.print(`${op.outcome}${op.note ? `: ${op.note}` : ''}`, op);
    return op.outcome === 'succeeded' ? 0 : 1;
  } finally { client.close(); }
}

async function safe(c) {
  const mode = c.positional[1];
  if (mode !== 'on' && mode !== 'off') { c.err(USAGE); return 64; }
  const enter = mode === 'on';
  const viaHost = await hostOp(c, 'recovery.safeMode', { enter });
  if (viaHost !== null) return viaHost;
  if (enter) await writeJsonAtomic(join(c.layout.flags, FLAGS.safe), { reason: 'cli', at: now() });
  else {
    await rm(join(c.layout.flags, FLAGS.safe), { force: true });
    await resetBootMarker(c.layout.flags, 'safe-off');   // "try normally": the next launch must not count the old unhealthy streak
  }
  await patchStateSafeMode(c.layout, enter);
  c.print(`safe mode ${enter ? 'on' : 'off'} for the next launch`, { safeMode: enter, offline: true });
  return 0;
}

/** `guard list` / `guard untrust <n>`: the 'Always allow this server' list in profile.json guardTrusted[]. Offline: file edits only. */
async function guard(c) {
  const [, action, arg] = c.positional;
  const trust = loadGuardTrust(c);
  const file = c.layout.profileConfig;
  if (action === 'list' && arg === undefined) {
    const list = trust.listTrusted(file);
    c.print(list.length ? list.map((fp, i) => `${i + 1}. ${fp}`).join('\n') : 'No trusted servers.', { trusted: list });
    return 0;
  }
  if (action === 'untrust' && arg !== undefined && c.positional.length === 3) {
    const n = /^[1-9]\d*$/.test(arg) ? Number(arg) : NaN;
    if (!Number.isInteger(n)) throw new CodexModsError('Invalid', `guard untrust needs a position from \`guard list\` (1, 2, …), got "${arg}"`);
    let removed;
    try { removed = trust.untrust(file, n); } catch (e) {
      if (e instanceof RangeError) throw new CodexModsError('Invalid', `guard untrust ${n}: no such entry (see \`codexmods recovery guard list\`)`);
      throw e;
    }
    c.print(`Removed trusted server ${n}: ${removed}`, { removed, n });
    return 0;
  }
  c.err('usage: codexmods recovery guard list | guard untrust <n>');
  return 64;
}

async function lkg(c) {
  const viaHost = await hostOp(c, 'recovery.lkg', {});
  if (viaHost !== null) return viaHost;
  // Offline: restore what lives in files. Mod records and settings need the Host (Operations) and are NOT restored here.
  const { layout } = c;
  const n = await readText(join(layout.generations, 'lkg'));
  const g = n ? await readJson(join(layout.generations, `${n}.json`), undefined) : undefined;
  if (!g) throw new CodexModsError('Unavailable', 'no last-known-good generation has been recorded');
  if (!(await exists(join(layout.framework, g.frameworkVersion, 'framework', 'main', 'index.cjs')))) {
    throw new CodexModsError('Unavailable', `framework ${g.frameworkVersion} of the last-known-good generation is not installed`);
  }
  const lkgApp = g.appCandidate || (await readText(layout.lkgApp));
  if (lkgApp && !(await exists(lkgApp))) throw new CodexModsError('Unavailable', `the app copy of the last-known-good generation is gone: ${lkgApp}`);
  const done = [];
  const cur = await readText(layout.frameworkCurrent);
  if (cur !== g.frameworkVersion) {
    if (cur) await writeTextAtomic(layout.frameworkPrevious, cur);
    await writeTextAtomic(layout.frameworkCurrent, g.frameworkVersion);
    done.push(`framework current = ${g.frameworkVersion}`);
  }
  // Mod records and settings are not restored offline, so the next launch stays in safe mode (no third-party mod runs on stale records).
  await writeJsonAtomic(join(layout.flags, FLAGS.safe), { reason: 'offline-lkg', at: now() });
  await patchStateSafeMode(layout, true);
  done.push('safe mode stays on for the next launch');
  const profile = await readJson(layout.profileConfig, undefined);
  if (profile?.appPath && lkgApp && readLinkAbs(profile.appPath) && !(await samePath(readLinkAbs(profile.appPath), lkgApp))) {
    await replaceSymlinkAtomic(profile.appPath, lkgApp);
    done.push(`launch path -> ${lkgApp}`);
  }
  c.print(`Offline last-known-good restore (generation ${g.n}), partial: ${done.join(', ')}.\n`
    + 'Mod records and mod settings are NOT restored: only the online operation (the app running) restores them.\n'
    + 'The next launch starts in SAFE MODE, with no third-party mods. Start the app, then run `codexmods recovery lkg` again to finish the restore and leave safe mode.',
  { generation: g.n, done, recordsRestored: false, safeModeNextLaunch: true, offline: true });
  return 0;
}

export async function run(argv, io = {}) {
  let c;
  try { c = context(argv, io, { bool: ['wait'] }); } catch (e) { (io.stderr ?? process.stderr).write(`${e.message}\n`); return 64; }
  return guarded(c, async () => {
    const [sub] = c.positional;
    if (sub === 'safe') return safe(c);
    if (sub === 'disable') {
      await writeJsonAtomic(join(c.layout.flags, FLAGS.disabled), { reason: 'cli', at: now() });
      c.print('framework disabled: the next launch passes straight through to the stock behavior', { disabled: true });
      return 0;
    }
    if (sub === 'enable') {
      await rm(join(c.layout.flags, FLAGS.disabled), { force: true });
      c.print('framework enabled for the next launch', { disabled: false });
      return 0;
    }
    if (sub === 'lkg') return lkg(c);
    if (sub === 'guard') return guard(c);
    c.err(USAGE);
    return 64;
  });
}
