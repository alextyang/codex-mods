// Test helper (loader/loader.test.mjs): one simulated app launch in its own OS process. Runs the real loader.cjs against a real
// root with a fake electron, waits for a start time so several launches really race, prints "proceeded" or "second", and, if it
// proceeded, stays alive (holding the lock) until stdin closes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { root, startAt, waitMs } = JSON.parse(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let exitedViaApp = false;
const electron = { app: { setPath() {}, relaunch() {}, exit() { exitedViaApp = true; } } };
const fake = {
  env: { ...process.env, CODEX_MODS_INSTANCE_WAIT_MS: String(waitMs) }, pid: process.pid, kill: process.kill.bind(process),
  execPath: process.execPath, resourcesPath: join(root, 'App.app', 'Contents', 'Resources'),
  exit() { exitedViaApp = true; }, on() {},
};
const src = readFileSync(join(here, 'loader.cjs'), 'utf8').replace('__CODEXMODS_ROOT__', root);
while (Date.now() < startAt) { /* spin to the common start instant */ }
let started = false;
const req = (id) => (id === 'electron' ? electron : id.endsWith('index.cjs') ? { start() { started = true; } } : require(id));
new Function('require', 'process', src)(req, fake);
process.stdout.write((started ? 'proceeded' : exitedViaApp ? 'second' : 'unknown') + '\n');
if (started) { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); } else process.exit(0);
