// Command runner: argument errors, "Host not running" and management errors become exit codes.
import { UsageError, err } from './args.mjs';
import { HostNotRunning, connectHost, waitForOp } from './client.mjs';
import { CodexModsError } from '../../sdk/errors.mjs';
import { printJson, out } from './args.mjs';
import { opOutcomeText } from './format.mjs';

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, noHost: 2 });

/** Wrap a command body so every failure path yields an exit code and a message on stderr. */
export async function guarded(io, body) {
  try { return (await body()) ?? EXIT.ok; } catch (e) {
    if (e instanceof UsageError) { err(io, `codexmods: ${e.message}`); return EXIT.usage; }
    if (e instanceof HostNotRunning) { err(io, e.message); return EXIT.noHost; }
    if (e instanceof CodexModsError) { err(io, `error [${e.code}]: ${e.message}`); return EXIT.failed; }
    err(io, `error: ${e?.message ?? e}`);
    return EXIT.failed;
  }
}

/** Connect, run fn(client), always close. */
export async function withHost(ctx, fn) {
  const client = await connectHost(ctx);
  try { return await fn(client); } finally { client.close(); }
}

/** Start a mutation; unless --no-wait, follow its operation to the end and return the final record. */
export async function startAndWait(client, io, flags, method, params) {
  const { opId } = await client.call(method, params);
  if (flags['no-wait']) return { opId, op: null };
  const op = await waitForOp(client, opId, {
    onProgress: flags.json ? undefined : (o) => { if (o.outcome === 'running' && o.phases.length) out(io, `  ${o.phases.at(-1).name}...`); },
  });
  return { opId, op };
}

/**
 * Start a mutation and, by default, wait for its operation. Exit code 0 only for `succeeded`.
 * --no-wait prints the opId and returns 0.
 */
export async function mutate(client, io, flags, method, params) {
  const { opId, op } = await startAndWait(client, io, flags, method, params);
  if (!op) {
    if (flags.json) printJson(io, { opId }); else out(io, opId);
    return EXIT.ok;
  }
  if (flags.json) printJson(io, op); else out(io, opOutcomeText(op));
  return op.outcome === 'succeeded' ? EXIT.ok : EXIT.failed;
}
