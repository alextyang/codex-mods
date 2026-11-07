// codexmods pack <dir> --key <pem> [--out <file>]: sign and archive a mod directory.
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { UsageError, absPath, out, parse, printJson } from '../lib/args.mjs';
import { EXIT, guarded } from '../lib/run.mjs';
import { loadPackModule } from '../lib/packmod.mjs';

export const USAGE = `codexmods pack <dir> --key <pem> [--out <file>] [--json]

Validates <dir>/mod.json, signs the package with the ed25519 private key in <pem>, and writes a .codexmod archive.
--out defaults to ./<dir name>.codexmod.`;

export async function run(argv, io) {
  return guarded(io, async () => {
    const { values, positionals } = parse(argv, { key: { type: 'string' }, out: { type: 'string' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    if (positionals.length !== 1 || !values.key) throw new UsageError('usage: codexmods pack <dir> --key <pem> [--out <file>]');
    const dir = absPath(io, positionals[0]);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new UsageError(`not a directory: ${dir}`);
    const outPath = absPath(io, values.out ?? `${basename(dir)}.codexmod`);
    const pem = await readFile(absPath(io, values.key), 'utf8').catch((e) => {
      throw new UsageError(`cannot read key file ${values.key}: ${e.code ?? e.message}`);
    });
    const { packMod } = await loadPackModule(io);
    const result = await packMod(dir, pem, outPath);
    if (values.json) printJson(io, { out: outPath, ...(result && typeof result === 'object' ? result : {}) });
    else {
      out(io, `Packed ${outPath}`);
      if (result && typeof result === 'object') {
        if (result.contentHash) out(io, `  contentHash: ${result.contentHash}`);
        if (result.publisher) out(io, `  publisher:   ${result.publisher}`);
      }
    }
    return EXIT.ok;
  });
}
