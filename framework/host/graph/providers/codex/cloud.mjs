// CloudEnvironment in the native provider (breadth step D3; owner decision 2026-10-24: the app's newer cloud environments): the signed-in
// account's environment configs, read the app's way through framework-main (framework/main/projects.cjs `cloud-environments`: the app's
// `environmentConfigs`). Hosted threads run on the app's remote connection, which the mux does not see, so a CloudEnvironment links no
// threads here; it names no project (it serves repositories) and has no address (the newer system gives none).
// - `status`: the config's `ready` is ready, a failed one unavailable, anything else (a draft, a build) preparing; a change says
//   `statusChanged`.
// - Read at the source's start, when the app's projects become available (framework-main holds a window), every READ_MS, and when a realm
//   observes one read longer ago than FRESH_MS (the app pushes no change here). One the account no longer lists goes.
// manage() opens where the app manages its cloud environments (Settings, Codex Cloud: Edit, Delete), as the app's main opens a page
// (framework-main's `navigate`).
import { refs } from './map.mjs';

export const READ_MS = 10 * 60_000;
const FRESH_MS = 30_000;

/** The operation handlers, for the provider's registration. */
export function cloudTypes(appProjects) {
  return {
    CloudEnvironment: {
      operations: {
        manage: { effect: 'none', handler: async () => {
          const r = await appProjects.op('navigate', null, { path: '/settings/codex-cloud' });
          if (r.ok) return null;
          if (r.refused) return { status: 'refused', reason: 'unavailable', message: r.error };
          throw new Error(r.error);
        } },
      },
    },
  };
}

/** A config's status -> Environment.status. */
export function cloudStatus(s) {
  if (s === 'ready') return 'ready';
  if (typeof s === 'string' && /fail|error|invalid|disabled/i.test(s)) return 'unavailable';
  return 'preparing';
}
/** A config -> the CloudEnvironment instance. */
export function cloudEnvironmentData(c) {
  return { ref: refs.cloudEnvironment(c.id), state: { name: c.name, status: cloudStatus(c.status) }, links: { project: null } };
}

/**
 * @param {{ handle: object, graph: object, appProjects: ReturnType<typeof import('../../app-projects.mjs').createAppProjects>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string): void,
 *   log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
export function createCloudFeed(o) {
  const { handle, graph, appProjects, safe } = o;
  const now = o.now ?? Date.now;
  let readAt = 0, reading = null, disposed = false;
  function apply(r) {
    const seen = new Set();
    for (const c of r.environments ?? []) {
      const d = cloudEnvironmentData(c);
      seen.add(d.ref.id);
      const cur = o.resident(d.ref);
      safe('cloud environment', () => handle.put(d.ref, { state: d.state, links: d.links }));
      if (cur && cur.state.status !== d.state.status) o.emitEvent(d.ref, 'statusChanged');
    }
    for (const x of graph.list('CloudEnvironment') ?? []) {
      if (x.ref.provider === handle.id && !seen.has(x.ref.id)) safe('cloud environment removal', () => handle.remove(x.ref));
    }
  }
  function read() {
    if (disposed || !appProjects.available) return Promise.resolve();
    if (reading) return reading;
    reading = (async () => {
      const r = await appProjects.op('cloud-environments', null);
      if (!r.ok) { o.log.warn('cloud: the account\'s cloud environments could not be read', { message: r.error }); return; }
      readAt = now();
      apply(r.result ?? { environments: [] });
    })().finally(() => { reading = null; });
    return reading;
  }
  const sub = appProjects.onChange((c) => { if (c.available === true) read(); });
  const timer = setInterval(() => { read(); }, READ_MS);
  timer.unref?.();
  return {
    read,
    observe() { return now() - readAt > FRESH_MS ? read() : undefined; },
    dispose() { disposed = true; sub.dispose(); clearInterval(timer); },
  };
}
