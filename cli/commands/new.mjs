// codexmods new <id> [--kind <kind>] [--dir <path>]: scaffold a mod from one of the SDK's starters (sdk/templates/<kind>/).
import { chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, absPath, out, parse, printJson } from '../lib/args.mjs';
import { EXIT, guarded } from '../lib/run.mjs';

/** The starters (graph-integrity G8.3), each a working mod with its test: what a new mod starts from. */
export const KINDS = Object.freeze({
  panel: 'a tab of the side panel beside a chat, reading the chat from the graph',
  rule: 'a presentation rule: badges on the app\'s chats, wherever the app shows them',
  contribution: 'a setting of each chat, given to the agent with each message in that chat',
  agent: 'an agent of your own: its chats listed with the app\'s, and its own view of them',
});
export const DEFAULT_KIND = 'panel';

export const USAGE = `codexmods new <id> [--kind ${Object.keys(KINDS).join('|')}] [--dir <path>] [--json]

Creates a new mod from one of the SDK's starters, each a working mod with its test (default: ${DEFAULT_KIND}):
${Object.entries(KINDS).map(([k, what]) => `  ${k.padEnd(13)}${what}`).join('\n')}
<id> is reverse-DNS style (lowercase letters, digits, "." and "-", 3-128 characters). The mod is created in --dir, default ./<id>.
The starter's own id (its mod.json's) is replaced by <id> in every text file.`;

const templateOf = (kind) => new URL(`../../sdk/templates/${kind}/`, import.meta.url);
const SKIP = new Set(['node_modules', '.git', '.DS_Store']);
// A starter's test loads `@codexmods/sdk/testing`, else the testing kit beside it in this repository; a new mod lives elsewhere, so that
// fallback becomes this checkout's kit
const KIT_IN_REPO = "'../../../testing/index.mjs'";
const KIT_HERE = `'${new URL('../../sdk/testing/index.mjs', import.meta.url).href}'`;

async function copyTree(from, to, fromId, id, written) {
  await mkdir(to, { recursive: true, mode: 0o755 });
  for (const name of (await readdir(from)).sort()) {
    if (SKIP.has(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const st = await lstat(src);
    if (st.isDirectory()) await copyTree(src, dst, fromId, id, written);
    else if (st.isFile()) {
      const bytes = await readFile(src);
      let data = bytes;
      if (!bytes.includes(0)) data = Buffer.from(bytes.toString('utf8').replaceAll(fromId, id).replaceAll(KIT_IN_REPO, KIT_HERE), 'utf8');
      await writeFile(dst, data);
      await chmod(dst, st.mode & 0o777);
      written.push(dst);
    }
  }
}

export async function run(argv, io) {
  return guarded(io, async () => {
    const { values, positionals } = parse(argv, { dir: { type: 'string' }, kind: { type: 'string' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    if (positionals.length !== 1) throw new UsageError(`usage: codexmods new <id> [--kind ${Object.keys(KINDS).join('|')}] [--dir <path>]`);
    const id = positionals[0];
    if (!/^[a-z0-9.-]{3,128}$/.test(id) || /^\.+$/.test(id)) {
      throw new UsageError(`invalid mod id "${id}": use 3-128 lowercase letters, digits, "." and "-"`);
    }
    const kind = values.kind ?? DEFAULT_KIND;
    if (!Object.hasOwn(KINDS, kind)) throw new UsageError(`unknown kind "${kind}": one of ${Object.keys(KINDS).join(', ')}`);
    const target = absPath(io, values.dir ?? id);
    const template = io.templateDir ?? fileURLToPath(templateOf(kind));
    if (!(await stat(template).catch(() => null))?.isDirectory()) throw new UsageError(`starter not found: ${template}`);
    // the starter's own id, replaced by the new mod's
    let fromId;
    try { fromId = JSON.parse(await readFile(join(template, 'mod.json'), 'utf8')).id; } catch { fromId = null; }
    if (typeof fromId !== 'string' || !fromId) throw new UsageError(`the starter has no mod.json with an id: ${template}`);
    const existing = await readdir(target).catch(() => null);
    if (existing && existing.length > 0) throw new UsageError(`refusing to write into a non-empty directory: ${target}`);
    const written = [];
    await copyTree(template, target, fromId, id, written);
    if (values.json) printJson(io, { id, kind, dir: target, files: written });
    else {
      out(io, `Created ${id} (${kind}) in ${target} (${written.length} files)`);
      out(io, `Next: codexmods dev ${target}`);
    }
    return EXIT.ok;
  });
}
