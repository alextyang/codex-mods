// Stand-in for the real codex binary's entry: records its argv (JSON line) to $CODEXMODS_ARGV_LOG, then becomes the fake
// app-server (tests/fixtures/fake-app-server.mjs), which only looks for --name in process.argv.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.env.CODEXMODS_ARGV_LOG) appendFileSync(process.env.CODEXMODS_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
await import(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'fake-app-server.mjs'));
