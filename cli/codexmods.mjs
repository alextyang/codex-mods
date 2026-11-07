#!/usr/bin/env node
// codexmods: command dispatcher. Each command lives in cli/commands/<name>.mjs and exports run(argv, io) → exit code.
// setup, app, framework and recovery load the same way.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { splitFirst } from './lib/args.mjs';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'commands');

const USAGE = `codexmods: manage the Codex mods framework

Mods and operations (need the app running):
  mods list|inspect|install|consent|enable|disable|configure|update|rollback|remove|reattach|clear-quarantine|reload|permission|automatic|policy
  ops get|list|wait <opId>
  features [--all] [--status <s>]     the feature log with this build's status
  update status|check|stage|apply|later|policy   the copy's update (app build, framework, mods' updates)

Authoring:
  new <id> [--dir <path>]             scaffold a mod from the starter template
  dev <dir>                           install a folder as a dev package and reload on change
  keygen [--out <file>]               create a publisher key
  pack <dir> --key <pem> [--out <file>]

Framework (work offline):
  setup, app, framework, recovery     see "codexmods <command> --help"

Global options: --root <dir> (CODEX_MODS_ROOT), --profile <name> (CODEX_MODS_PROFILE), --json, --no-wait, --help
Exit codes: 0 success, 1 failure, 2 usage error or Host not running.`;

export function defaultIo(overrides = {}) {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd(), ...overrides };
}

export async function main(argv, io = defaultIo()) {
  const { first: name, rest } = splitFirst(argv);
  if (name === undefined) {
    const wantsHelp = argv.includes('--help') || argv.includes('-h');
    (wantsHelp ? io.stdout : io.stderr).write(`${USAGE}\n`);
    return wantsHelp ? 0 : 2;
  }
  if (name === 'help') { io.stdout.write(`${USAGE}\n`); return 0; }
  if (!/^[a-z][a-z-]*$/.test(name)) { io.stderr.write(`codexmods: unknown command "${name}"\n\n${USAGE}\n`); return 2; }
  const file = join(COMMANDS_DIR, `${name}.mjs`);
  let mod;
  try { mod = await import(pathToFileURL(file).href); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(file)) {
      io.stderr.write(`codexmods: unknown command "${name}"\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (typeof mod.run !== 'function') { io.stderr.write(`codexmods: command "${name}" has no run()\n`); return 1; }
  return mod.run(rest, io);
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => ac.abort());
  process.exitCode = await main(process.argv.slice(2), defaultIo({ signal: ac.signal }));
}
