// qa.lease — QA only (gate G-protocol): issues one connection lease and writes its descriptor for scripts/qa/lease.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';

async function host(ctx) {
  const file = path.join(ctx.mod.dataDir, 'files', 'lease.json');
  await fs.rm(file, { force: true });
  const lease = await ctx.appServer.clients.issue({ name: 'qa' });
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ id: lease.id, socketPath: lease.socketPath, token: lease.token }), { mode: 0o600 });
  return async () => {
    await ctx.appServer.clients.revoke(lease.id).catch(() => {});
    await fs.rm(file, { force: true });
  };
}

export default { host };
