// QA-only protocol tap used by the stock-equivalent control: sits between the app and the real codex, logs both directions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [real, outPrefix, ...args] = process.argv.slice(2);
const inLog = fs.createWriteStream(`${outPrefix}.app-to-backend`, { flags: 'a' });
const outLog = fs.createWriteStream(`${outPrefix}.backend-to-app`, { flags: 'a' });
const child = spawn(real, args, { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.on('data', (d) => { inLog.write(d); child.stdin.write(d); });
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', (d) => { outLog.write(d); process.stdout.write(d); });
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 143 : 1)));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));
