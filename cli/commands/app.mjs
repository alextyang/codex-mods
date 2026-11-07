// codexmods app status|prepare|apply (ARCHITECTURE §12.3). `status` reads files and works offline;
// `prepare` and `apply` are operations and need the running Host.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexModsError } from '../../sdk/errors.mjs';
import { readJson } from '../../framework/host/fsutil.mjs';
import {
  STOCK_APP, readText, readLinkAbs, readAppBuildSync, candidateDirsSync, connectManagement, waitForOp,
} from '../../framework/host/recovery/support.mjs';
import { context, guarded, HOST_NOT_RUNNING } from '../../framework/host/recovery/cli-common.mjs';

const USAGE = 'usage: codexmods app status | prepare [--no-wait] | apply [--candidate <path>] [--no-wait]';

function tryBuild(app, readBuild) { try { return readBuild(app).build; } catch { return null; } }

async function status(c) {
  const { layout, deps } = c;
  const readBuild = deps.readBuild ?? readAppBuildSync;
  const stockApp = c.flags.stock ?? deps.stockApp ?? STOCK_APP;
  const profile = await readJson(layout.profileConfig, undefined);
  const target = profile?.appPath ? readLinkAbs(profile.appPath) : undefined;
  const candidates = [];
  try {
    for (const name of readdirSync(layout.apps).sort()) {
      const c2 = candidateDirsSync(layout, name).find((x) => x.name === name);
      if (c2) candidates.push({ build: name, app: c2.app, complete: c2.complete });
    }
  } catch { /* no apps dir */ }
  const data = {
    stockBuild: tryBuild(stockApp, readBuild),
    copyBuild: target ? tryBuild(target, readBuild) : null,
    appPath: profile?.appPath ?? null, target: target ?? null,
    lkg: (await readText(layout.lkgApp)) ?? null,
    candidates,
    framework: { current: (await readText(layout.frameworkCurrent)) ?? null, previous: (await readText(layout.frameworkPrevious)) ?? null,
      lkg: (await readText(layout.frameworkLkg)) ?? null },
  };
  data.updateAvailable = !!data.stockBuild && !!data.copyBuild && data.stockBuild !== data.copyBuild;
  c.print([`stock ChatGPT:  ${data.stockBuild ?? 'not found'}`,
    `running copy:   ${data.copyBuild ?? 'unknown'}${data.target ? ` (${data.target})` : ''}`,
    `launch path:    ${data.appPath ?? 'not set up'}`,
    `last-known-good copy: ${data.lkg ?? 'none'}`,
    `framework:      current ${data.framework.current ?? '-'}, previous ${data.framework.previous ?? '-'}, lkg ${data.framework.lkg ?? '-'}`,
    ...candidates.map((x) => `candidate:      ${x.build}${x.complete ? '' : ' (incomplete)'}  ${x.app}`),
    data.updateAvailable ? `A newer ChatGPT build (${data.stockBuild}) is installed: run \`codexmods app prepare\`.` : 'The copy follows the installed ChatGPT build.',
  ].join('\n'), data);
  return 0;
}

async function viaHost(c, method, params, label) {
  const client = await (c.deps.connectManagement ?? connectManagement)(c.layout);
  if (!client) { c.err(`${HOST_NOT_RUNNING}: ${label} needs the running app (it is an operation). Start the modded app and retry.`); return 2; }
  try {
    const { opId } = await client.request(method, params);
    if (c.flags.wait === false) { c.print(`started ${opId}`, { opId }); return 0; }
    const op = await waitForOp(client, opId, c.deps.wait);
    c.print(`${op.outcome}${op.note ? `: ${op.note}` : ''}${op.error ? `: ${op.error.message}` : ''}${op.result?.candidate ? `\ncandidate: ${op.result.candidate}` : ''}`, op);
    return op.outcome === 'succeeded' ? 0 : 1;
  } finally { client.close(); }
}

export async function run(argv, io = {}) {
  let c;
  try { c = context(argv, io, { bool: ['wait'], value: ['candidate', 'stock'] }); } catch (e) { (io.stderr ?? process.stderr).write(`${e.message}\n`); return 64; }
  const [sub] = c.positional;
  return guarded(c, async () => {
    if (sub === 'status') return status(c);
    if (sub === 'prepare') return viaHost(c, 'updates.app.prepare', {}, 'app prepare');
    if (sub === 'apply') {
      let candidate = c.flags.candidate && resolve(c.flags.candidate);
      if (!candidate) {
        const stock = tryBuild(c.flags.stock ?? c.deps.stockApp ?? STOCK_APP, c.deps.readBuild ?? readAppBuildSync);
        // newest completed candidate of the installed build (candidates are apps/<build>-<inputsHash>)
        candidate = stock ? candidateDirsSync(c.layout, stock).find((x) => x.complete)?.app : undefined;
        if (!candidate) throw new CodexModsError('Invalid', 'no prepared candidate for the installed ChatGPT build; run `codexmods app prepare` or pass --candidate');
      }
      // apply restarts the app: the op ends at the next boot, so it is not waited for by default
      c.flags.wait = c.flags.wait === true;
      return viaHost(c, 'updates.app.apply', { candidate }, 'app apply');
    }
    c.err(USAGE);
    return 64;
  });
}
