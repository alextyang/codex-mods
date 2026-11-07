// codexmods framework install <dir> | rollback (ARCHITECTURE §12.2).
// install: through the Host when it runs (a framework-update operation, which relaunches the app); otherwise directly on disk.
// rollback: always on disk (pointer files); it takes effect at the next launch.
import { resolve } from 'node:path';
import { join } from 'node:path';
import { CodexModsError } from '../../sdk/errors.mjs';
import {
  exists, readText, writeTextAtomic, frameworkVersionOf, installFrameworkTree, assertFrameworkTree, assertVersionName,
  connectManagement, waitForOp,
} from '../../framework/host/recovery/support.mjs';
import { context, guarded } from '../../framework/host/recovery/cli-common.mjs';

const USAGE = 'usage: codexmods framework install <dir> [--version <v>] | rollback';

async function install(c) {
  const dir = c.positional[1] && resolve(c.positional[1]);
  if (!dir) throw new CodexModsError('Invalid', USAGE);
  await assertFrameworkTree(dir);
  const version = c.flags.version ?? await frameworkVersionOf(dir);
  assertVersionName(version);
  const client = await (c.deps.connectManagement ?? connectManagement)(c.layout);
  if (client) {
    try {
      const { opId } = await client.request('updates.framework', { version, sourceDir: dir });
      if (c.flags.wait === false) { c.print(`started ${opId}`, { opId }); return 0; }
      let op;
      try { op = await waitForOp(client, opId, c.deps.wait); }
      catch (e) {
        if (e.code === 'Unavailable') { c.print(`framework ${version} installed; the app is restarting (${opId})`, { opId, version, restarting: true }); return 0; }
        throw e;
      }
      c.print(`${op.outcome}${op.note ? `: ${op.note}` : ''}`, op);
      return op.outcome === 'succeeded' ? 0 : 1;
    } finally { client.close(); }
  }
  const cur = await readText(c.layout.frameworkCurrent);
  await installFrameworkTree(c.layout, dir, version);
  if (cur) await writeTextAtomic(c.layout.frameworkPrevious, cur);
  await writeTextAtomic(c.layout.frameworkCurrent, version);
  c.print(`framework ${version} installed and current (previous ${cur ?? 'none'}); it runs at the next launch`, { version, previous: cur ?? null, restarting: false });
  return 0;
}

async function rollback(c) {
  const { layout } = c;
  const prev = await readText(layout.frameworkPrevious);
  const cur = await readText(layout.frameworkCurrent);
  if (!prev) throw new CodexModsError('Unavailable', 'there is no previous framework version to roll back to');
  if (!(await exists(join(layout.framework, prev, 'framework', 'main', 'index.cjs')))) {
    throw new CodexModsError('Unavailable', `framework ${prev} is no longer installed`);
  }
  if (cur) await writeTextAtomic(layout.frameworkPrevious, cur);
  await writeTextAtomic(layout.frameworkCurrent, prev);
  c.print(`framework current is now ${prev} (was ${cur ?? 'unset'}); it runs at the next launch`, { current: prev, previous: cur ?? null });
  return 0;
}

export async function run(argv, io = {}) {
  let c;
  try { c = context(argv, io, { bool: ['wait'], value: ['version'] }); } catch (e) { (io.stderr ?? process.stderr).write(`${e.message}\n`); return 64; }
  return guarded(c, async () => {
    const [sub] = c.positional;
    if (sub === 'install') return install(c);
    if (sub === 'rollback') return rollback(c);
    c.err(USAGE);
    return 64;
  });
}
