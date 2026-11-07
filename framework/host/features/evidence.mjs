// A build's evidence for the feature log (docs/design/systems.md "E4 in detail"), resolved the same way for the running copy, a
// prepared candidate and the CLI: the build's pack, and its census (`build-facts.json`) and refresh report (`refresh-report.json`) from
// the first adapters directory that has them for the build: the framework tree's `adapters/<build>/` (shipped with the framework, made
// by its own census), else the root's (a refresh's output for a build the framework does not ship). A piece that belongs to another build is named in `stale` (its kinds read unknown). The running copy adds what its windows
// saw (`live`). Node built-ins only.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluate } from './status.mjs';
export { mergeLive } from './status.mjs';

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const sha256 = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** The build a pack is for: `<version>-<bundle>`, as the adapters' directories are named. */
export const buildIdOf = (pack) => (pack?.build?.version && pack?.build?.bundleVersion ? `${pack.build.version}-${pack.build.bundleVersion}` : null);
/**
 * The digest the binding census records of the addresses it ran with: what it reads of them, each keyed binding's id, keys and
 * exactness (with its optional keys) (adapters/tools/census.mjs `bindings.sites`), so a binding's other fields (its slots, parts, notes) never make it stale.
 */
export const addressesDigest = (addresses) => sha256((addresses?.bindings ?? []).filter((b) => Array.isArray(b?.keys) && b.keys.length)
  .map((b) => ({ id: b.id, keys: b.keys, exact: b.exact === true, ...(b.exact === true && b.optional?.length ? { optional: b.optional } : {}) })));
export const logHash = (log) => sha256(log).slice(0, 16);

/** The log shipped with this framework (log.json beside this module), or null. */
export async function loadLog(file = new URL('./log.json', import.meta.url)) { return readJson(file); }

/**
 * @param {{ pack: object, dirs: string[], addresses?: object|null, live?: object|null }} o  `dirs`: the adapters directories, in order
 * @returns {Promise<{ build: string|null, pack: object, facts: object|null, report: object|null, from: string|null, stale: string[], addressesSha256: string|null, live: object|null }>}
 */
export async function evidenceFor(o) {
  const build = buildIdOf(o.pack);
  let facts = null, report = null, from = null;
  if (build) {
    for (const d of o.dirs ?? []) {
      const f = await readJson(join(d, build, 'build-facts.json'));
      if (!f) continue;
      facts = f; report = await readJson(join(d, build, 'refresh-report.json')); from = join(d, build);
      break;
    }
  }
  const stale = [];
  if (facts && (facts.build?.version !== o.pack.build.version || String(facts.build?.buildNumber) !== String(o.pack.build.bundleVersion))) stale.push('census');
  if (report && report.to !== build) stale.push('report');
  return { build, pack: o.pack, facts, report, from, stale, addressesSha256: o.addresses ? addressesDigest(o.addresses) : null, live: o.live ?? null };
}

/**
 * The running copy's feature state: the log, this build's evidence and its evaluation, again whenever the windows report what they saw.
 * @param {{ log: object|null, pack: object, dirs: string[], addresses?: object|null }} o
 */
export async function createFeatureState(o) {
  const ev = await evidenceFor(o);
  const listeners = new Set();
  const requested = new Set();   // the methods the framework's own providers asked the app-server for
  let live = { bindings: {}, anchors: [] };
  let result = null;
  const compute = () => (result = o.log ? evaluate(o.log, { ...ev, live }) : null);
  compute();
  return {
    log: o.log,
    evidence: () => ({ ...ev, live }),
    /** The evaluation on the running build (null without a log). */
    current: () => result,
    hash: o.log ? logHash(o.log) : null,
    /** What the windows saw: `bindings` {id: {state: works|tripped|unseen, why?}} and `anchors` seen, merged across the live windows. */
    setLive(next) {
      const n = { bindings: next?.bindings ?? {}, anchors: [...new Set(next?.anchors ?? [])].sort() };
      if (JSON.stringify(n) === JSON.stringify(live)) return;
      live = n; compute();
      for (const fn of listeners) { try { fn(); } catch { /* a listener's own */ } }
    },
    onChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    /** A method the framework's own providers requested: the log's blind spots show as methods it lacks (`unlogged`). Answers true the
     *  first time a method the log lacks is seen. */
    noteRequested(method) {
      if (typeof method !== 'string' || requested.has(method)) return false;
      requested.add(method);
      return !!o.log && !o.log.mechanics?.[`protocol:${method}`];
    },
    unlogged: () => (o.log ? [...requested].filter((m) => !o.log.mechanics?.[`protocol:${m}`]).sort() : []),
  };
}
