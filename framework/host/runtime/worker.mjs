// Worker-thread entry: one per mod (ARCHITECTURE §7.3). Imports the mod's host entry and calls definition.host(ctx).
// The Host drives it with {t:'activate'} / {t:'deactivate'} (contracts/ipc.d.ts §2) and watches its heartbeat.
import { parentPort, workerData } from 'node:worker_threads';
import { createRealmClient } from '../../shared/realm-client.mjs';
import { createScheduler } from '../../../sdk/scheduler.mjs';

const post = (m) => parentPort.postMessage(m);
const listeners = new Set();
parentPort.on('message', (m) => { for (const fn of [...listeners]) fn(m); });
const port = {
  post,
  onMessage(fn) { listeners.add(fn); return { dispose: () => { listeners.delete(fn); } }; },
};
const client = createRealmClient(port, { createScheduler });

const heartbeatMs = workerData?.heartbeatMs ?? 1000;
post({ t: 'heartbeat' });
setInterval(() => post({ t: 'heartbeat' }), heartbeatMs);

const fault = (e) => post({ t: 'fault', message: String(e?.message ?? e), stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 8).join('\n') : undefined });
process.on('uncaughtException', fault);
process.on('unhandledRejection', fault);

const VALID = new Set(['Denied', 'Unavailable', 'OutcomeUnknown', 'Busy', 'Timeout', 'Invalid', 'Conflict', 'Incompatible', 'Disposed']);
let disposer;
let activated = false;

async function activate(msg) {
  try {
    const module = await import(msg.entry);
    const definition = module.default ?? module;
    const ctx = client.context(msg.modId, 'host', msg.info);
    if (typeof definition?.host === 'function') {
      const ret = await definition.host(ctx);
      if (typeof ret === 'function') disposer = ret;
      else if (ret && typeof ret.dispose === 'function') disposer = () => ret.dispose();
    }
    activated = true;
    post({ t: 'activated' });
  } catch (e) {
    post({ t: 'activate-failed', error: { code: VALID.has(e?.code) ? e.code : 'Invalid', message: String(e?.message ?? e) } });
  }
}

async function deactivate() {
  try { if (disposer) await disposer(); } catch (e) { fault(e); }
  try { await client.disposeAll(); } catch { /* the Host closes everything anyway */ }
  // Leave the thread: the Host waits for its 'exit' (or terminates it after 5 s).
  setImmediate(() => process.exit(0));
}

listeners.add((m) => {
  if (m?.t === 'activate' && !activated) activate(m);
  else if (m?.t === 'deactivate') deactivate();
});
