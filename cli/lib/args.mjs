// Shared argument parsing and connection context for the codexmods CLI.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { layout, resolveRoot, SOCKETS } from '../../contracts/layout.mjs';

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

export const COMMON_OPTIONS = {
  root: { type: 'string' },
  profile: { type: 'string' },
  json: { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** Parse argv with the common options plus `extra`; throws UsageError on unknown flags. */
export function parse(argv, extra = {}, { positionals = true } = {}) {
  try {
    const { values, positionals: pos } = parseArgs({
      args: argv, options: { ...COMMON_OPTIONS, ...extra }, allowPositionals: positionals, strict: true,
    });
    return { values, positionals: pos };
  } catch (e) {
    throw new UsageError(e.message);
  }
}

/** Root and profile: flags override CODEX_MODS_ROOT / CODEX_MODS_PROFILE. Paths come only from layout(). */
export function contextFor(io, values = {}) {
  const env = { ...io.env };
  if (values.root) env.CODEX_MODS_ROOT = resolve(io.cwd, values.root);
  if (values.profile) env.CODEX_MODS_PROFILE = values.profile;
  const { root, profile } = resolveRoot(env);
  const lay = layout(root, profile);
  return { root, profile, layout: lay, socketPath: join(lay.run, SOCKETS.management), tokenPath: join(lay.run, 'mgmt.token') };
}

/** Absolute path from the user's working directory (the Host's cwd is unrelated). */
export const absPath = (io, p) => resolve(io.cwd, p);

export const out = (io, text) => io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
export const err = (io, text) => io.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
export const printJson = (io, value) => out(io, JSON.stringify(value, null, 2));

const VALUE_FLAGS = new Set(['--root', '--profile']);
/** First non-flag token (global flags with values may precede it) and the remaining argv in original order. */
export function splitFirst(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return { first: a, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { first: undefined, rest: argv };
}
