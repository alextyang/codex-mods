// Small helpers shared by the setup/app/framework/recovery CLI commands. The dispatcher passes `io`:
//   { stdout?, stderr?, env?, deps? }  — every field optional; `deps` are test seams.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { layout as makeLayout, resolveRoot } from '../../../contracts/layout.mjs';
import { CodexModsError } from '../../../sdk/errors.mjs';

/** Minimal parser: `--k v`, `--k=v`, booleans listed in `bool`, `--no-x` negation, positionals. */
export function parseArgs(argv, { bool = [], value = [] } = {}) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (k.startsWith('no-') && bool.includes(k.slice(3))) { flags[k.slice(3)] = false; continue; }
    if (bool.includes(k)) { flags[k] = v === undefined ? true : v !== 'false'; continue; }
    if (v === undefined) {
      if (i + 1 >= argv.length) throw new CodexModsError('Invalid', `--${k} needs a value`);
      v = argv[++i];
    }
    if (!value.includes(k) && !bool.includes(k)) throw new CodexModsError('Invalid', `unknown option --${k}`);
    flags[k] = v;
  }
  return { flags, positional };
}

export function context(argv, io, spec) {
  const { flags, positional } = parseArgs(argv, { ...spec, bool: [...(spec?.bool ?? []), 'json'], value: [...(spec?.value ?? []), 'root', 'profile'] });
  const env = io?.env ?? process.env;
  const resolved = resolveRoot(env);
  const root = flags.root ?? resolved.root;
  const profile = flags.profile ?? resolved.profile;
  const write = (stream, fallback) => (text) => (stream ?? fallback).write(text.endsWith('\n') ? text : `${text}\n`);
  return {
    flags, positional, env, root, profile, layout: makeLayout(root, profile), deps: io?.deps ?? {},
    home: io?.deps?.home ?? homedir(),
    out: write(io?.stdout, process.stdout), err: write(io?.stderr, process.stderr),
    json: !!flags.json,
    print(human, data) { this.out(this.json ? JSON.stringify(data) : human); },
  };
}

/** Runs a command body; maps CodexModsError and usage errors to exit codes (2 = Host not running, 1 = failure). */
export async function guarded(c, body) {
  try { return await body(); } catch (e) {
    if (e instanceof CodexModsError) {
      c.err(c.json ? JSON.stringify({ error: e.toJSON() }) : `${e.code}: ${e.message}`);
      return e.code === 'Invalid' ? 64 : 1;
    }
    c.err(`error: ${e?.message ?? e}`);
    return 1;
  }
}
export const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
export const HOST_NOT_RUNNING = 'Host not running';
