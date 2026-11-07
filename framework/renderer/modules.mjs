// Loads and unloads mod renderer modules to match the Host's `modules` messages (contracts/ipc.d.ts §3). A module is an ES
// module served from codexmod://<modId>/<rev>/<entry>; its default export is a ModDefinition (sdk defineMod) whose `renderer(ctx)`
// runs in this window. Loads are serialized; a failed activation is reported as a fault with the modId and cleaned up.
import { RULES } from '../shared/ui-rules-client.mjs';

const normalize = (result) => {
  if (typeof result === 'function') return result;
  if (result && typeof result.dispose === 'function') return () => result.dispose();
  return null;
};
const RETRY_MS = [250, 500, 1000];
const withTimeout = (p, ms, schedule) => new Promise((resolve) => {
  let done = false;
  const cancel = schedule(() => { if (!done) { done = true; resolve('timeout'); } }, ms);
  Promise.resolve(p).then(() => { if (!done) { done = true; cancel(); resolve('ok'); } }, () => { if (!done) { done = true; cancel(); resolve('error'); } });
});

/**
 * @param {{ importModule: (url: string) => Promise<any>, makeContext: (m: { modId: string, version: string, dataDir: string }) => object, uiFactory: ReturnType<import('./ui.mjs').createUiFactory>,
 *           ready: () => Promise<void>, onFault: (modId: string, err: unknown) => void, schedule: (fn: () => void, ms: number) => () => void, log?: Function, disposeTimeoutMs?: number }} deps  (activationTimeoutMs defaults to 10 s)
 */
export function createModuleLoader({ importModule, makeContext, uiFactory, ready, onFault, schedule, log = () => {}, disposeTimeoutMs = 3000, activationTimeoutMs = 10_000 }) {
  const loaded = new Map();      // modId → { url, version, disposer, scope }
  const failed = new Map();      // modId → url that failed (not retried until the url changes)
  let chain = Promise.resolve();
  let closing = false;

  /** Stop an entry: in-flight activation must not create anything further, and what exists is disposed. */
  function cancelEntry(entry) {
    entry.state.cancelled = true;
    entry.state.abort();
    entry.scope?.dispose();
  }

  async function unload(modId) {
    const entry = loaded.get(modId);
    loaded.delete(modId);
    failed.delete(modId);
    if (!entry) return;
    const disposer = entry.disposer;
    cancelEntry(entry);
    if (disposer) {
      const r = await withTimeout((async () => disposer())(), disposeTimeoutMs, schedule);
      if (r !== 'ok') onFault(modId, new Error(`renderer dispose ${r === 'timeout' ? 'timed out' : 'threw'}`));
    }
  }

  /** A just-activated mod's codexmod:// URL can be requested before framework-main has applied the new renderer-modules map (
   *  "Failed to fetch dynamically imported module" on first enable, fine on re-enable). Retry the import only, 250/500/1000 ms. */
  async function importWithRetry(url, state) {
    for (let attempt = 0; ; attempt++) {
      // A failed dynamic import is cached per document for that exact URL, so every retry uses a distinct one (?attempt=n). The codexmod://
      // handler maps the path only (url.pathname), so the query changes nothing server-side.
      const attemptUrl = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}attempt=${attempt}`;
      try { return await importModule(attemptUrl); } catch (err) {
        if (attempt >= RETRY_MS.length || state.cancelled || closing) throw err;
        log('renderer import failed, retrying', { url, attempt: attempt + 1, error: String(err?.message ?? err) });
        await new Promise((resolve) => { schedule(resolve, RETRY_MS[attempt]); });
        if (state.cancelled || closing) throw err;           // unloaded or closed while waiting: do not import again
      }
    }
  }

  /** Import + activate under one deadline (10 s). Cancellation is checked after every await: a cancelled (timed out, unloaded or
   *  closed) load never calls renderer() and never creates a context or scope; a late disposer is still run so nothing leaks. */
  async function load(m) {
    let abort = () => {};
    const aborted = new Promise((resolve) => { abort = () => resolve('cancelled'); });
    const state = { cancelled: false, abort };
    const entry = { url: m.url, version: m.version, disposer: null, scope: null, state };
    loaded.set(m.modId, entry);
    const activation = (async () => {
      const mod = await importWithRetry(m.url, state);
      if (state.cancelled || closing) return null;
      const def = mod?.default ?? mod;
      if (!def || typeof def.renderer !== 'function') throw new Error(`${m.modId}: module has no renderer entry`);
      const base = makeContext(m);
      // The mod's presentation rules reach the Host through its realm context (docs/design/systems.md S6).
      const scope = uiFactory.forMod(m.modId, base[RULES], () => base.graph);
      entry.scope = scope;
      const ctx = { ...base, ui: scope.ui };
      if (state.cancelled || closing) { scope.dispose(); return null; }
      const d = normalize(await def.renderer(ctx));
      if (state.cancelled) { try { await d?.(); } catch { /* late cleanup is best effort */ } return null; }
      return d ?? 'none';
    })();
    activation.catch(() => {});
    let cancelTimer = () => {};
    const deadline = new Promise((resolve) => { cancelTimer = schedule(() => resolve('activation-timeout'), activationTimeoutMs); });
    try {
      const winner = await Promise.race([activation, deadline, aborted]);
      cancelTimer();
      if (winner === 'activation-timeout') {
        cancelEntry(entry);
        throw new Error('activation-timeout');
      }
      if (winner === 'cancelled' || winner === null || state.cancelled || loaded.get(m.modId) !== entry) { cancelEntry(entry); return; }
      entry.disposer = winner === 'none' ? null : winner;
    } catch (err) {
      cancelTimer();
      failed.set(m.modId, m.url);
      if (loaded.get(m.modId) === entry) loaded.delete(m.modId);
      cancelEntry(entry);
      onFault(m.modId, err);
    }
  }

  return {
    /** Make the loaded set equal `list` ({modId, url, version, dataDir}[]). Resolves when this sync has finished. */
    sync(list) {
      const run = async () => {
        if (closing) return;
        await ready();
        if (closing) return;
        const want = new Map(list.map((m) => [m.modId, m]));
        for (const id of [...loaded.keys()]) {
          const cur = loaded.get(id); const w = want.get(id);
          if (!w || w.url !== cur.url || w.version !== cur.version) await unload(id);
          if (closing) return;
        }
        for (const [id, url] of [...failed]) if (want.get(id)?.url !== url) failed.delete(id);
        for (const m of list) {
          if (closing) return;
          if (!loaded.has(m.modId) && failed.get(m.modId) !== m.url) await load(m);
        }
      };
      chain = chain.then(run, run).catch((e) => log('module sync failed', { error: String(e?.message ?? e) }));
      return chain;
    },
    loadedIds: () => [...loaded.keys()],
    isLoaded: (id) => loaded.has(id),
    /** Does not wait for an unsettled activation: its scope is disposed here and the late result is cleaned up when it lands. */
    async close() { closing = true; for (const id of [...loaded.keys()]) await unload(id); },
  };
}
