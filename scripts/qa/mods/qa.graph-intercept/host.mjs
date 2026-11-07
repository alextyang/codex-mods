// qa.graph-intercept — QA only (G-intercept through the graph, docs/design/interception.md): the user's own operations in the app,
// held at the mux and decided by this mod's graph interceptors. Each call is logged to <dataDir>/files/intercept.log with its origin.
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (c) => (Array.isArray(c?.parts) ? c.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('') : '');

async function host(ctx) {
  const files = path.join(ctx.mod.dataDir, 'files');
  await fs.mkdir(files, { recursive: true });
  const log = (o) => fs.appendFile(path.join(files, 'intercept.log'), `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`).catch(() => {});
  const exists = (f) => fs.access(path.join(files, f)).then(() => true, () => false);
  const subs = [
    ctx.graph.intercept('Thread', 'send', async (call, next) => {
      const text = textOf(call.args[0]);
      log({ op: 'send', origin: call.origin, caller: call.caller?.kind, thread: call.ref.id, text: text.slice(0, 80) });
      if (text.replace(/[^a-z]/gi, '').toLowerCase().includes('gintercept')) {
        return { status: 'refused', reason: 'notAllowed', message: 'QA: a send containing G-INTERCEPT is refused' };
      }
      // A held send the user stops is cancelled: the call's signal aborts here, in the worker (breadth.md D0.4), and the wait ends.
      const wait = /gwait\s*(\d+)/i.exec(text);
      if (wait) {
        const cancelled = new Promise((resolve) => call.signal?.onAbort(() => resolve(true)));
        if (await Promise.race([sleep(Number(wait[1]) * 1000).then(() => false), cancelled])) {
          log({ op: 'send:cancelled', reason: call.signal.reason });
          return { status: 'refused', reason: 'unavailable', message: 'QA: the send was cancelled while held' };
        }
        log({ op: 'send:waited', seconds: Number(wait[1]) });
      }
      const out = /gchange/i.test(text)
        ? await next({ args: [{ parts: [{ kind: 'text', text: `${text.replace(/gchange/gi, '').trim()} (changed by QA)` }] }] })
        : await next();
      log({ op: 'send:outcome', status: out.status, turn: out.value?.turn?.id ?? null });
      return out;
    }, { deadlineMs: 20000 }),
    ctx.graph.intercept('Thread', 'archive', async (call, next) => {
      log({ op: 'archive', origin: call.origin, thread: call.ref.id });
      if (await exists('refuse-archive')) return { status: 'refused', reason: 'notAllowed', message: 'QA: archive refused' };
      return next();
    }),
    ctx.graph.intercept('Thread', 'stop', async (call, next) => {
      log({ op: 'stop', origin: call.origin, thread: call.ref.id });
      return next();
    }),
  ];
  return () => { for (const s of subs) s.dispose(); };
}

export default { host };
