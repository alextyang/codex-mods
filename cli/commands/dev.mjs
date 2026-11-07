// codexmods dev <dir>: install a mod folder as a development package, then reload it on every change.
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { UsageError, absPath, contextFor, err, out, parse } from '../lib/args.mjs';
import { EXIT, guarded, startAndWait, withHost } from '../lib/run.mjs';
import { opOutcomeText } from '../lib/format.mjs';

export const USAGE = `codexmods dev <dir> [--approve]

Installs <dir> as a development package (unsigned, labelled Development, never auto-updated) and watches it.
On every change the mod is disabled and enabled again, which re-reads it from <dir>.
--approve grants the mod's declared permissions at first install (you wrote it); without it, approve in
Adjustments or with "codexmods mods consent <id> --approve --enable".
Stop with Ctrl-C.`;

const IGNORED = /(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)|(~|\.swp|\.tmp)$/;

export async function run(argv, io) {
  return guarded(io, async () => {
    const { values, positionals } = parse(argv, { approve: { type: 'boolean' } });
    if (values.help) { out(io, USAGE); return EXIT.ok; }
    if (positionals.length !== 1) throw new UsageError('usage: codexmods dev <dir> [--approve]');
    const dir = absPath(io, positionals[0]);
    let manifest;
    try { manifest = JSON.parse(await readFile(join(dir, 'mod.json'), 'utf8')); } catch (e) {
      throw new UsageError(`cannot read ${join(dir, 'mod.json')}: ${e.code ?? e.message}`);
    }
    if (typeof manifest?.id !== 'string') throw new UsageError(`${join(dir, 'mod.json')} has no "id"`);
    const modId = manifest.id;
    const ctx = contextFor(io, values);
    const flags = { ...values, 'no-wait': false, json: false };

    return withHost(ctx, async (client) => {
      const step = async (label, method, params) => {
        out(io, `${label}...`);
        const { op } = await startAndWait(client, io, flags, method, params);
        out(io, opOutcomeText(op));
        return op;
      };
      const statusOf = async () => (await client.call('mods.inspect', { modId })).status;

      // Initial install as a dev package.
      const install = await step(`Installing ${modId} from ${dir}`, 'mods.install', { source: dir, dev: true, enable: true });
      if (install.outcome === 'succeeded' && install.awaiting === 'consent' && values.approve) {
        await step(`Approving ${modId}`, 'mods.consent', { modId, approve: true, enable: true });
      }
      out(io, `Watching ${dir} (Ctrl-C to stop)`);

      let running = false;
      let again = false;
      let timer = null;
      const reload = async () => {
        if (running) { again = true; return; }
        running = true;
        try {
          do {
            again = false;
            let status;
            try { status = await statusOf(); } catch (e) { err(io, `dev: ${e.message}`); continue; }
            if (status === 'pending-consent') { out(io, `${modId} is waiting for consent; not reloading`); continue; }
            if (status === 'enabled') await step(`Reloading ${modId}: disable`, 'mods.disable', { modId });
            else if (status === 'quarantined') await step(`Clearing quarantine of ${modId}`, 'mods.clearQuarantine', { modId });
            await step(`Reloading ${modId}: enable`, 'mods.enable', { modId });
          } while (again);
        } catch (e) {
          err(io, `dev: ${e.message}`);
        } finally { running = false; }
      };

      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && IGNORED.test(String(filename))) return;
        clearTimeout(timer);
        timer = setTimeout(reload, io.debounceMs ?? 200);
      });
      watcher.on('error', (e) => err(io, `dev: watcher error: ${e.message}`));
      await new Promise((resolve) => {
        const stop = () => resolve();
        client.onClose(stop);
        if (io.signal?.aborted) stop(); else io.signal?.addEventListener('abort', stop, { once: true });
      });
      clearTimeout(timer);
      watcher.close();
      while (running) await new Promise((r) => setTimeout(r, 20));
      return io.signal?.aborted ? EXIT.ok : EXIT.failed;
    });
  });
}
