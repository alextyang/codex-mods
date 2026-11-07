#!/usr/bin/env node
// Native QA harness (W1.3). Run as the QA user (UID 503): ssh <qa-host> 'cd <checkout> && /opt/homebrew/bin/node scripts/qa.mjs <command> --root ~/cmq'
// Drives the real `cli/codexmods.mjs setup`, launches the isolated QA copy, checks readiness and isolation, and stops it.
// Never touches /Applications/ChatGPT.app beyond reading, the stock app's processes, ~/.codex or credentials. No sign-in, no model traffic.
import os from 'node:os';
import { parseQaArgs, validateRoot, QaUsageError, USAGE } from './qa/args.mjs';

async function main(argv) {
  let a;
  try { a = parseQaArgs(argv); if (a.command !== 'help') a.root = validateRoot(a.root, { home: os.homedir() }); } catch (e) {
    if (e instanceof QaUsageError) { process.stderr.write(`qa: ${e.message}\n\n${USAGE}\n`); return 2; }
    throw e;
  }
  if (a.command === 'help') { process.stdout.write(`${USAGE}\n`); return 0; }
  const uid = process.getuid?.();
  if (uid !== 503 && !process.env.QA_ALLOW_UID) { process.stderr.write(`qa: refusing to run as uid ${uid}; the native QA harness runs as the QA user, UID 503 (QA_ALLOW_UID=1 overrides)\n`); return 2; }
  const cmds = await import('./qa/commands.mjs');
  let r;
  switch (a.command) {
    case 'setup': r = await cmds.setup(a); break;
    case 'launch': r = await cmds.launch(a); break;
    case 'status': r = await cmds.status(a); break;
    case 'screenshot': r = cmds.screenshot({ root: a.root, name: a.positionals[0] }); break;
    case 'stop': r = await cmds.stop(a); break;
    case 'cli': r = await cmds.cli(a); break;
    case 'control': r = await cmds.control(a); break;
    case 'probe': r = await cmds.probe({ root: a.root, command: a.positionals[0] }); break;
  }
  if (r.result !== null) process.stdout.write(`${JSON.stringify(r.result, null, a.json ? 0 : 2)}\n`);
  return r.code;
}

process.exitCode = await main(process.argv.slice(2));
