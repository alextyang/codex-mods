// Child process for the store-lock tests: acquire, record enter/exit around a short critical section, release.
import { appendFileSync } from 'node:fs';
import { getStoreLock } from '../storelock.mjs';
const [, , storeDir, logFile, id] = process.argv;
const lock = getStoreLock(storeDir, undefined, { timeoutMs: 20_000, pollMs: 5 });
const hold = await lock.acquire();
appendFileSync(logFile, `enter ${id}\n`);
await new Promise((r) => setTimeout(r, 30));
appendFileSync(logFile, `exit ${id}\n`);
await hold.release();
