// qa.settings, host realm — QA only (docs/design/systems.md E3): ctx.settings from the host realm, driven by trigger files; it logs and faults on trigger too.
import fs from 'node:fs/promises';
import path from 'node:path';
// the SDK's instructions helper (graph-integrity G3.5), as its bundle has it (sdk-agent.mjs)
import { instructions } from './sdk-agent.mjs';

async function host(ctx) {
  const files = path.join(ctx.mod.dataDir, 'files');
  await fs.mkdir(files, { recursive: true });
  const log = (o) => fs.appendFile(path.join(files, 'changes.log'), `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`).catch(() => {});
  const sub = ctx.settings.onChange((doc, change) => log({ doc, change: change ?? null }));
  // its own block of a chat's developer instructions, after the mods before it in the user's order (G3.5)
  instructions(ctx, 'QA settings: when the user asks for the QA colour, answer exactly TEAL-19.');
  const take = async (f) => { try { const b = await fs.readFile(path.join(files, f), 'utf8'); await fs.rm(path.join(files, f)); return JSON.parse(b); } catch { return null; } };
  const timer = setInterval(async () => {
    // framework-ui.md F9: lines for its Activity, and a fault
    const said = await take('log');
    if (said) ctx.log[said.level ?? 'info'](String(said.message ?? 'a line'));
    // framework-ui.md F8: a request to Codex under an optional permission, and the mod asking for one itself
    const listing = await take('request');
    if (listing) {
      let out;
      try { const r = await ctx.appServer.request('thread/list', { limit: 1 }); out = { ok: true, threads: Array.isArray(r?.data) ? r.data.length : null }; } catch (e) { out = { error: String(e?.code ?? ''), message: String(e?.message ?? e) }; }
      await fs.writeFile(path.join(files, 'request.json'), `${JSON.stringify({ t: new Date().toISOString(), out })}\n`);
    }
    const asked = await take('permission');
    if (asked) {
      let out;
      try { out = { state: await ctx.permissions.state(asked.grant), ...(asked.request ? { answer: await ctx.permissions.request(asked.grant, { title: asked.title }) } : {}) }; } catch (e) { out = { error: String(e?.code ?? ''), message: String(e?.message ?? e) }; }
      await fs.writeFile(path.join(files, 'permission.json'), `${JSON.stringify({ t: new Date().toISOString(), out })}\n`);
    }
    const thrown = await take('throw');
    if (thrown) setTimeout(() => { throw new Error(String(thrown.message ?? 'a QA fault')); }, 0);
    for (const op of ['set', 'reset', 'get']) {
      const req = await take(op);
      if (!req) continue;
      let out;
      try {
        if (op === 'set') out = await ctx.settings.set(req.key, req.value, req.scope ? { scope: req.scope } : {});
        else if (op === 'reset') out = await ctx.settings.reset(req.key, req.scope ? { scope: req.scope } : {});
        else out = { value: await ctx.settings.get(req.key, req.where ?? {}), document: await ctx.settings.get() };
      } catch (e) { out = { error: String(e?.code ?? ''), message: String(e?.message ?? e) }; }
      await fs.writeFile(path.join(files, `${op}.json`), `${JSON.stringify({ t: new Date().toISOString(), req, out })}\n`);
    }
  }, 1000);
  return () => { clearInterval(timer); sub.dispose(); };
}

export default { host };
