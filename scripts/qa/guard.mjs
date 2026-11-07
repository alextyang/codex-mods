// `qa launch --guard` tests the stock/CLI concurrency guard, so a Codex CLI app-server running on the QA profile's codex-home BEFORE the
// launch is the expected fixture, not a leftover. Pure parts: classification and exclusion.
import path from 'node:path';
import { parseEnvLine } from './isolation.mjs';

/** A Codex app-server process (`… codex app-server …`, also codex.real). */
export function isAppServer(command) {
  const t = command.split(/\s+/);
  const at = t.indexOf('app-server');
  return at > 0 && t.slice(0, at).some((x) => ['codex', 'codex.real'].includes(path.basename(x)));
}

/** CODEX_HOME of a process: from its environment line (`ps eww`), else an inline `CODEX_HOME=…` in its command line. */
export function codexHomeOf(command, envLine) {
  const fromEnv = envLine ? parseEnvLine(envLine).CODEX_HOME : undefined;
  if (fromEnv) return fromEnv;
  return /(?:^|\s)CODEX_HOME=(\S+)/.exec(command)?.[1] ?? null;
}

const under = (p, d) => p === d || p.startsWith(`${d.replace(/\/$/, '')}/`);
const exeOf = (command) => command.split(/ -{1,2}[A-Za-z]/)[0].trim();

/**
 * Split the owned processes into guard fixtures and everything else (which still refuses the launch).
 * A fixture is an app-server whose CODEX_HOME is one of the QA profile's codex-homes and whose executable is NOT inside the QA apps/ tree
 * (an app-server from the copy itself is a leftover of a previous run, not a fixture).
 * @param {{pid:number, command:string}[]} owned
 * @param {{codexHomes: string[], appsDirs: string[], envLineOf?: (pid:number)=>string|undefined}} ctx
 */
export function classifyGuardFixtures(owned, { codexHomes, appsDirs, envLineOf = () => undefined }) {
  const fixtures = []; const others = [];
  for (const p of owned) {
    const home = isAppServer(p.command) ? codexHomeOf(p.command, envLineOf(p.pid)) : null;
    const isFixture = home !== null && codexHomes.includes(path.resolve(home)) && !appsDirs.some((d) => under(exeOf(p.command), d) || p.command.includes(`${d.replace(/\/$/, '')}/`));
    (isFixture ? fixtures : others).push(p);
  }
  return { fixtures, others };
}

/** Rows without the saved fixtures; a saved pid only counts while it still has the same command line (pid reuse). */
export function withoutFixtures(rows, saved) {
  if (!saved?.length) return rows;
  const key = new Map(saved.map((f) => [f.pid, f.command]));
  return rows.filter((r) => !(key.has(r.pid) && key.get(r.pid) === r.command));
}
