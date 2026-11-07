// Host entry: runs in this mod's worker thread inside the Host. One file, no imports needed.
// (If you use a bundler you can `import { defineMod } from '@codexmods/sdk'`; a plain object is equivalent.)
//
// This mod counts `thread/started` notifications, keeps the count in storage, and serves it as the `counter` service.

async function host(ctx) {
  let count = (await ctx.storage.get('threads')) ?? 0;

  // Observers never change traffic; use ctx.appServer.intercept for that (needs an `appServer.intercept` permission).
  const observer = ctx.appServer.observe({ kinds: ['serverNotification'], methods: ['thread/started'] }, async (message) => {
    if (!message || 'gap' in message) return;             // a { gap } event means some frames were dropped
    count += 1;
    await ctx.storage.set('threads', count);
    ctx.events.emit(`mod/${ctx.mod.id}/count`, { count });
  });

  const service = ctx.services.provide('counter', { get: () => ({ count }) });
  ctx.log.info('counter active', { count });

  // Everything registered through ctx is disposed automatically; returning a disposer is for your own cleanup.
  return () => { observer.dispose(); service.dispose(); };
}

export default { host };
