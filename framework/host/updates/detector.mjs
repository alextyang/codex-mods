// Noticing an update (docs/design/systems.md S19, amended: the Host; "E5 in detail"): once the boot is healthy and not in safe mode, the
// stock app's Info.plist is stat'ed every minute (read when it changed) and the release source is asked after the first healthy boot of a
// day and when the user checks. An offer (a stock build other than the copy's, a newer framework release, with the mods' packages in it)
// is staged unless staging runs, a framework operation runs, or this offer was tried three times today. Its state lives in
// `<profile>/updates/state.json`: the policy (offer | auto), the last check, the attempts, the dismissals, the auto attempts (by offer, so
// a reverted or dismissed offer is never applied on its own again), and the latest plan. Node built-ins only.
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil.mjs';
import { readBuild, plistStamp } from './stock.mjs';
import { isNewer, supportsBuild } from './release.mjs';
import { readPlan, choose, verdictOf } from './plan.mjs';

const DAY_MS = 24 * 3600_000;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const offerIdOf = (offer) => `${offer.stock?.build ?? '-'}|${offer.release?.version ?? '-'}`;

/** The update state file, read and written whole. */
export function createUpdateState(layout) {
  const file = join(layout.profileUpdates, 'state.json');
  let cache = null;
  const load = async () => (cache ??= { policy: 'offer', attempts: {}, dismissed: [], auto: {}, ...(await readJson(file, null) ?? {}) });
  return {
    load,
    async update(fn) { const s = await load(); fn(s); await writeJsonAtomic(file, s); return s; },
  };
}

/**
 * @param {{ layout: object, log: object, copyBuild: string, frameworkVersion: string, stockApp: string, source: object, staging: object,
 *   state: object, busy: () => boolean, safe: () => boolean, onChange?: () => void, pollMs?: number, now?: () => number,
 *   enabledNow?: () => string[], installedNow?: () => string[] }} o  `enabledNow`: the enabled mods as `<id>@<version>`, sorted (a change restages the offer);
 *   `installedNow`: every installed mod so, sorted (the plan shows them all on the Update page: one installed or removed since is read again, F11)
 */
export function createDetector(o) {
  const log = o.log ?? { info() {}, warn() {} };
  const now = o.now ?? Date.now;
  let stamp = null, stockBuild = null, stockUnknown = null, release = null, releaseUnknown = null, timer = null, started = false;
  let lastProblem = null;
  // Work started in the background (a tick, staging after a check) is kept, so `stop` can wait for it: nothing writes after stop settles.
  const running = new Set();
  const background = (fn) => {
    const p = Promise.resolve().then(fn).catch((e) => log.warn('update detector', { message: String(e?.message ?? e) })).finally(() => running.delete(p));
    running.add(p);
  };

  const offer = () => {
    const stockOffer = stockBuild && stockBuild !== o.copyBuild;
    if (!stockOffer && !release) return null;
    const x = { stock: { app: o.stockApp, build: stockBuild ?? o.copyBuild }, ...(release ? { release } : {}) };
    return { ...x, id: offerIdOf(x) };
  };

  async function readStock() {
    const s = await plistStamp(o.stockApp);
    if (s === stamp && stockBuild) return false;
    try { const b = await readBuild(o.stockApp); const changed = b.build !== stockBuild; stockBuild = b.build; stamp = s; stockUnknown = null; return changed; } catch (e) {
      stockUnknown = String(e?.message ?? e); return false;
    }
  }

  async function checkRelease({ userAsked = false } = {}) {
    const st = await o.state.load();
    // A check of today is reused, judged again against the framework that runs now and as not asked (a development framework is not
    // offered a release the user asked about under another framework; a newer framework is not offered an older release).
    if (!userAsked && st.lastCheck && now() - Date.parse(st.lastCheck.at) < DAY_MS) {
      const r = st.lastCheck.found ?? st.lastCheck.release ?? null;
      release = r && isNewer(r, o.frameworkVersion) ? r : null;
      return;
    }
    let found;
    try { found = await o.source.latest(); releaseUnknown = null; } catch (e) { releaseUnknown = String(e?.message ?? e); return; }
    release = found && isNewer(found, o.frameworkVersion, { userAsked }) ? found : null;
    await o.state.update((s) => { s.lastCheck = { at: new Date(now()).toISOString(), found: found ?? null, release }; });
  }

  /** The enabled mods a plan was made for, as `<id>@<version>`, sorted. */
  const enabledOf = (p) => (p.enabled ?? []).map((m) => `${m.id}@${m.version}`).sort().join(',');
  /**
   * Stage the current offer when allowed. The daily cap of three attempts is for automatic ones; the user's (`userAsked`: Prepare, `update
   * stage`) runs whatever was tried today, and still counts (E6 acceptance: a cap spent by the day's launches kept a stale plan offered).
   */
  async function maybeStage({ userAsked = false } = {}) {
    const off = offer();
    if (!off || o.busy() || o.safe() || o.staging.status()) return null;
    const st = await o.state.load();
    if (st.latestPlan?.offer === off.id && st.latestPlan.hash) {
      // already staged, unless an input changed since: the enabled mods or their versions (the plan would be stale)
      let same;
      try {
        const p = await readPlan(o.layout, st.latestPlan.hash);
        same = (!o.enabledNow || enabledOf(p) === o.enabledNow().join(','))
          && (!o.installedNow || !p.display || p.display.map((m) => `${m.id}@${m.version}`).sort().join(',') === o.installedNow().join(','));
      } catch { same = false; }
      if (same) return null;
    }
    const a = st.attempts[off.id];
    if (!userAsked && a && a.day === day(now()) && a.n >= 3) return null;
    // Later (or Cancel while it prepared) means later: not prepared again on its own until the offer changes; Prepare still does (F11)
    if (!userAsked && st.dismissed.includes(off.id)) return null;
    await o.state.update((s) => { const cur = s.attempts[off.id]; s.attempts[off.id] = { day: day(now()), n: cur && cur.day === day(now()) ? cur.n + 1 : 1 }; });
    o.onChange?.();
    const r = await o.staging.stage(off);
    if (r.plan) await o.state.update((s) => { s.latestPlan = { hash: r.plan.hash, offer: off.id, at: new Date(now()).toISOString() }; lastProblem = null; });
    else if (r.problem) lastProblem = { offer: off.id, problem: r.problem, unknown: !!r.unknown, ...(r.code ? { code: r.code } : {}) };
    o.onChange?.();
    return r;
  }

  async function tick() {
    try { if (await readStock()) o.onChange?.(); await maybeStage(); } catch (e) { log.warn('update detector', { message: String(e?.message ?? e) }); }
  }

  return {
    /** Start after the boot's health gate passed (never in safe mode). */
    async start() {
      if (started || o.safe()) return;
      started = true;
      await readStock();
      await checkRelease().catch(() => {});
      o.onChange?.();
      background(tick);
      timer = setInterval(() => background(tick), o.pollMs ?? 60_000);
      timer.unref?.();
    },
    /** Stops polling; settles once the work it started in the background has ended. */
    async stop() { clearInterval(timer); timer = null; while (running.size) await Promise.allSettled([...running]); },
    /** The user checks now: the stock app and the release source (a development framework is offered releases then too). */
    async check() { await readStock(); await checkRelease({ userAsked: true }); o.onChange?.(); background(maybeStage); return this.status(); },
    /** Stage now: the user's ask by default (not held back by the daily cap); `{ userAsked: false }` as an automatic attempt. */
    stageNow: ({ userAsked = true } = {}) => maybeStage({ userAsked }),
    /** Preempted staging is tried again after the operation ends. */
    resume: () => { if (started) background(tick); },
    offer,
    async status() {
      const st = await o.state.load();
      let plan = null;
      if (st.latestPlan?.hash) {
        try {
          const p = await readPlan(o.layout, st.latestPlan.hash);
          // a plan made for other enabled mods is stale (its recheck would refuse it): not offered as ready; staging makes another
          if (o.enabledNow && enabledOf(p) !== o.enabledNow().join(',')) throw new Error('stale');
          const v = verdictOf(choose(p));
          plan = { hash: p.hash, offer: st.latestPlan.offer, createdAt: p.createdAt, build: p.stock.build, candidate: p.candidate.path,
            framework: p.framework ? { from: p.framework.from, to: p.framework.to, ...(p.framework.supports ? { supports: p.framework.supports } : {}) } : null, display: p.display ?? [],
            mods: choose(p).filter((c) => c.takes).map((c) => ({ id: c.id, from: c.from, to: c.to })), held: v.held, risks: v.risks,
            consentNeeded: p.enabled.filter((m) => m.incoming?.addedPermissions?.length).map((m) => ({ id: m.id, version: m.incoming.version, addedPermissions: m.incoming.addedPermissions })),
            checked: st.checked?.[p.hash] ?? 'static' };
        } catch { plan = null; }
      }
      const off = offer();
      const ready = plan && off && plan.offer === off.id ? plan : null;
      const problem = lastProblem && off && lastProblem.offer === off.id ? lastProblem : null;
      const unknown = [stockUnknown, releaseUnknown].filter(Boolean);
      // F11: the framework's support for the offered build, from explicit outcomes: a candidate made and checked (with the release, or by the framework that runs),
      // a build no release can make yet, a check that could not run
      const support = !off ? null : o.staging.status() ? { status: 'checking' }
        : ready ? { status: ready.framework ? 'ships' : 'already', ...(ready.framework?.supports ? { listed: supportsBuild(ready.framework.supports, ready.build) } : {}) }
          : problem ? { status: problem.code === 'Incompatible' && !problem.unknown ? 'notYet' : 'unknown', problem: problem.problem }
            // a release source out of reach says nothing of this build's support (staging decides that); a stock app that cannot be read does
            : stockUnknown ? { status: 'unknown', problem: stockUnknown } : { status: 'notChecked' };
      // whether the automatic policy applies it at the next launch (main.mjs): never an offer it tried, one dismissed, or one held
      const auto = !off ? null : st.policy !== 'auto' ? { will: false, why: 'off' } : st.auto[off.id] ? { will: false, why: 'tried' }
        : st.dismissed.includes(off.id) ? { will: false, why: 'dismissed' } : !ready ? { will: false, why: 'notReady' } : ready.held ? { will: false, why: 'held' } : { will: true };
      return {
        support, auto,
        offer: off ? { id: off.id, build: off.stock.build, copyBuild: o.copyBuild, framework: off.release ? { from: o.frameworkVersion, to: off.release.version } : null,
          dismissed: st.dismissed.includes(off.id) } : null,
        staging: o.staging.status(), problem, plan: ready,
        policy: st.policy, lastCheck: st.lastCheck ?? null, unknown,
      };
    },
  };
}

