// codexmods.live-usage, host entry (GOAL.md goal 21). Single-file ESM, Node built-ins only.
//
// Live usage from the graph's facts, at the source's fidelity (graph-integrity G1): every token report the agent gets (a Codex chat's
// `tokenUsageReported`, one per model response) and every rate-limit report (CodexUsage's snapshots by limit, each window's used percent,
// length and reset time). All analysis is this mod's own:
// - a window's estimate between its whole percentage points: the cost of the responses since the server last moved the window, over a
//   calibrated cost per point (learnt each time it moves); the rate per hour from the last half hour; the time left at that rate;
// - each chat's share of the binding window;
// - the reserve: with a window at or past the chosen percentage, a message sent in a Codex chat is stopped quietly and kept (G6.2), and
//   a turn still running is stopped (an automatic action the user turns on); when the window resets, the kept messages are sent and a
//   stopped turn gets "Continue" (a scheduled job, each send with a key so an uncertain delivery never sends twice: G6.3);
// - its status in the composer and the title bar, its settings page (the renderer), and the `usage` service with a lease for the menu
//   bar app (its `snapshot`, schemaVersion 1, as before).
// With several accounts (the account switcher's, RM10) each account has its own estimate: a chat's reports count toward its account's
// (Thread.account), each usage report toward its own account's, and the reserve holds a chat's message by its own account's limit; the
// status shows the account the chats use now (the last one a report came from).
// It keeps metadata only: no prompts beyond the messages it holds for the user, no answers, no account identity (an account is its id).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const WEIGHTS = Object.freeze({ input: 1, cached: 0.1, output: 6 });
const RATE_WINDOW_MS = 30 * 60_000;
const STATE_KEY = 'usage/v3';   // {version: 3, accounts: {accountId: an estimator's state}}
const KEPT_KEY = 'reserve/kept';
const RESUME_JOB = 'resume';
const MAX_THREADS = 500;
const MAX_KEPT = 20;
const FLUSH_MS = 1_000;
const TICK_MS = 15_000;

const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What one model response cost, in this mod's units: uncached input, cached input at a tenth, output (reasoning in it) at six. */
export function costOf(last) {
  if (!isObj(last)) return 0;
  const input = n(last.inputTokens), cached = Math.min(n(last.cachedInputTokens), input);
  return (input - cached) * WEIGHTS.input + cached * WEIGHTS.cached + n(last.outputTokens) * WEIGHTS.output;
}

/** A window's key: its limit and its length (primary and secondary are not "short" and "weekly": the length says which). */
export const windowKey = (limitId, w) => `${limitId || 'codex'}:${Number.isFinite(w?.windowDurationMins) ? w.windowDurationMins : 'unknown'}`;
export function windowName(w) {
  const m = w?.windowDurationMins;
  if (!Number.isFinite(m)) return 'Limit';
  if (m >= 6 * 24 * 60) return 'Weekly';
  if (m >= 23 * 60) return 'Daily';
  if (m >= 60) return `${Math.round(m / 60)}-hour`;
  return `${m}-minute`;
}

/**
 * The estimator: a pure state machine with an injected clock. `report(threadId, total, last)` for each token report (a repeat of a
 * thread's total counts nothing: the server re-emits a stale one after an interrupt); `snapshot(limitId, window)` for each window the
 * server reports; `view()` the estimates.
 */
export function createEstimator({ now = Date.now, state = null } = {}) {
  const s = isObj(state) && state.version === 2 ? structuredClone(state) : { version: 2, windows: {}, threads: {}, recent: [], totals: { cost: 0, responses: 0 } };
  const prune = () => {
    const cut = now() - RATE_WINDOW_MS;
    while (s.recent.length && s.recent[0][0] < cut) s.recent.shift();
    const ids = Object.keys(s.threads);
    if (ids.length > MAX_THREADS) for (const id of ids.sort((a, b) => s.threads[a].at - s.threads[b].at).slice(0, ids.length - MAX_THREADS)) delete s.threads[id];
  };
  return {
    /** A token report: true when it counted (a new response). */
    report(threadId, total, last) {
      const t = s.threads[threadId] ?? (s.threads[threadId] = { cost: 0, lastTotal: -1, at: 0 });
      const totalTokens = n(total?.totalTokens);
      if (totalTokens <= t.lastTotal) return false;
      t.lastTotal = totalTokens;
      const c = costOf(last);
      t.cost += c; t.at = now();
      s.totals.cost += c; s.totals.responses += 1;
      for (const w of Object.values(s.windows)) w.since += c;
      s.recent.push([now(), c]);
      prune();
      return true;
    },
    /** A window the server reported: a new window starts over; a move of its percent teaches the cost of a point. */
    snapshot(limitId, win) {
      if (!isObj(win) || !Number.isFinite(win.usedPercent)) return;
      const key = windowKey(limitId, win);
      const w = s.windows[key];
      if (!w || (Number.isFinite(win.resetsAt) && w.resetsAt !== win.resetsAt && win.usedPercent < w.percent)) {
        s.windows[key] = { limitId: limitId || 'codex', durationMins: win.windowDurationMins ?? null, percent: win.usedPercent, resetsAt: win.resetsAt ?? null,
          since: 0, perPoint: w?.perPoint ?? null, learnt: w?.learnt ?? 0, at: now() };
        return;
      }
      const moved = win.usedPercent - w.percent;
      if (moved > 0) {
        if (w.since > 0) { const sample = w.since / moved; w.perPoint = w.perPoint ? 0.7 * w.perPoint + 0.3 * sample : sample; w.learnt += 1; }
        w.since = 0;
      }
      w.percent = win.usedPercent;
      w.resetsAt = win.resetsAt ?? w.resetsAt;
      w.at = now();
    },
    view() {
      prune();
      const perHourCost = s.recent.reduce((a, [, c]) => a + c, 0) * (3_600_000 / RATE_WINDOW_MS);
      const windows = Object.entries(s.windows).map(([key, w]) => {
        const k = w.perPoint;
        const estimate = k ? Math.min(100, w.percent + Math.min(w.since / k, 0.99)) : w.percent;
        const ratePerHour = k ? perHourCost / k : null;
        const hoursLeft = ratePerHour && ratePerHour > 0 ? Math.max(0, (100 - estimate) / ratePerHour) : null;
        return { key, limitId: w.limitId, name: windowName({ windowDurationMins: w.durationMins }), durationMins: w.durationMins, percent: w.percent, estimate,
          calibrated: Boolean(k), ratePerHour, hoursLeft, resetsAt: w.resetsAt };
      }).sort((a, b) => b.estimate - a.estimate);
      const binding = windows[0] ?? null;
      const k = binding ? s.windows[binding.key]?.perPoint : null;
      const threads = Object.entries(s.threads).map(([id, t]) => ({ id, cost: t.cost, share: k ? t.cost / k : null })).sort((a, b) => b.cost - a.cost);
      return { windows, binding, threads, totals: { ...s.totals } };
    },
    state() { return structuredClone(s); },
  };
}

/** Whether the reserve holds sends now: the binding window at or past it (a reserve of 0 is off). */
export const reserveHolds = (view, reserve) => Number.isFinite(reserve) && reserve > 0 && !!view.binding && view.binding.estimate >= reserve;

/** The status line: the binding window's estimate and its rate. */
export function statusOf(view) {
  const b = view.binding;
  if (!b) return { text: 'Usage: waiting for the first report', tooltip: 'Live usage shows your limits once Codex reports them.', meter: 0 };
  const pct = b.calibrated ? `${b.estimate.toFixed(1)}%` : `${b.percent}%`;
  const rate = b.ratePerHour !== null && b.ratePerHour > 0.05 ? ` · ${b.ratePerHour.toFixed(1)}%/h` : '';
  const left = b.hoursLeft !== null && b.hoursLeft < 72 ? ` · about ${b.hoursLeft < 1 ? `${Math.round(b.hoursLeft * 60)} min` : `${b.hoursLeft.toFixed(1)} h`} left at this pace` : '';
  const resets = Number.isFinite(b.resetsAt) ? ` Resets ${new Date(b.resetsAt).toLocaleString()}.` : '';
  return { text: `${b.name} ${pct}${rate}`, tooltip: `${b.name} limit: ${pct} used${left}.${resets}${b.calibrated ? '' : ' (between points once Live usage has seen it move)'}`, meter: b.estimate / 100 };
}

/** Writes JSON atomically with mode 0600 inside a 0700 directory. */
export async function writePrivateJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

async function host(ctx) {
  const { log } = ctx;
  let settings = await ctx.settings.get();
  const saved = await ctx.storage.get(STATE_KEY);
  const ests = new Map();          // account id -> its estimator
  const chatAccount = new Map();   // thread id -> its account's id
  let current = null;              // the account the last report came from
  /** An account's estimator ('' while no account is known). */
  const estOf = (id) => {
    const k = typeof id === 'string' ? id : '';
    let e = ests.get(k);
    if (!e) { e = createEstimator({ state: isObj(saved) && saved.version === 3 && isObj(saved.accounts) ? saved.accounts[k] ?? null : null }); ests.set(k, e); }
    return e;
  };
  /** A chat's account: its own, else the only (or first) account with usage. */
  const accountOf = (threadId) => chatAccount.get(threadId) ?? usages.keys().next().value ?? '';
  const est = { view: () => estOf(current ?? usages.keys().next().value ?? '').view() };   // what the status shows: the account in use
  const totals = { turns: 0, active: new Set(), peak: 0, freshAt: null };
  const usages = new Map();   // account id -> its usage's snapshots
  let dirty = false, stopped = false, timer = null;
  const flush = async () => { timer = null; if (!dirty) return; dirty = false; try { await ctx.storage.set(STATE_KEY, { version: 3, accounts: Object.fromEntries([...ests].map(([k, e]) => [k, e.state()])) }); } catch (e) { log.warn('usage not kept', { error: String(e?.message ?? e) }); } };
  let told = null;
  const tell = () => { told = null; try { ctx.events.emit(`mod/${ctx.mod.id}/updated`, { at: Date.now() }); } catch { /* no listener */ } };
  const changed = () => { dirty = true; totals.freshAt = Date.now(); if (!stopped) { timer ??= setTimeout(flush, FLUSH_MS); told ??= setTimeout(tell, 250); refreshStatus(); } };

  // ---- the facts
  // the chats: their token reports (named events), and which are working now (the reserve stops those)
  const working = (th) => {
    const id = th?.ref?.id; if (!id || th.state?.ephemeral === true) return;
    if (typeof th.links?.account?.id === 'string') chatAccount.set(id, th.links.account.id);
    if (th.state?.status === 'working' && !th.gone) { totals.active.add(id); totals.peak = Math.max(totals.peak, totals.active.size); }
    else if (totals.active.delete(id)) totals.turns += 1;
  };
  const threads = ctx.graph.subscribe({ type: 'CodexThread', depth: 'core' }, (m) => {
    if (m?.type === 'snapshot') { for (const th of m.items ?? []) working(th); return; }
    if (m?.type !== 'delta') return;
    const e = m.event;
    if (e?.kind === 'event') {
      if (e.name === 'tokenUsageReported' && isObj(e.payload?.tokenUsage)) {
        const acct = accountOf(e.ref.id);
        if (estOf(acct).report(e.ref.id, e.payload.tokenUsage.total, e.payload.tokenUsage.last)) { current = acct; changed(); }
      }
      return;
    }
    if (e?.instance) { const before = totals.active.size; working(e.instance); if (totals.active.size > before) void checkReserve(); }
  });
  const usage = ctx.graph.subscribe({ type: 'CodexUsage' }, (m) => {
    const items = m?.type === 'snapshot' ? (m.items ?? []) : m?.type === 'delta' && m.event?.instance ? [m.event.instance] : [];
    for (const u of items) {
      const snaps = isObj(u?.state?.snapshots) ? u.state.snapshots : {};
      const acct = typeof u.links?.account?.id === 'string' ? u.links.account.id : u.ref.id;
      usages.set(acct, snaps);
      for (const [limitId, snap] of Object.entries(snaps)) for (const w of [snap?.primary, snap?.secondary]) estOf(acct).snapshot(limitId, w);
    }
    if (items.length) { changed(); void checkReserve(); }
  });

  // ---- what the user sees: the status, refreshed as reports come and every few seconds (the rate decays)
  const status = { composer: null, title: null };
  const refused = new Set();   // a place whose status rule the framework refused: not asked again until the mod restarts
  function refreshStatus() {
    const st = statusOf(est.view());
    const tone = reserveHolds(est.view(), settings.reserve) ? 'warning' : 'neutral';
    for (const [k, place] of [['composer', 'composer'], ['title', 'titleBar']]) {
      if (refused.has(k) || settings.status === 'off' || (settings.status === 'composer' && k === 'title')) { status[k]?.dispose(); status[k] = null; continue; }
      const spec = { text: st.text, tooltip: st.tooltip, tone, meter: { value: Math.max(0, Math.min(1, st.meter)) } };
      if (status[k]) status[k].update(spec).catch(() => {});
      else {
        try { status[k] = ctx.ui.status({ id: `status-${k}`, place, ...spec }); } catch (e) { refused.add(k); log.warn('the status was not shown', { place, error: String(e?.message ?? e) }); continue; }
        status[k].accepted?.then((ok) => { if (ok === false) { refused.add(k); status[k]?.dispose(); status[k] = null; } }, () => {});
      }
    }
  }
  const tick = setInterval(() => { try { refreshStatus(); } catch (e) { log.warn('the status was not refreshed', { error: String(e?.message ?? e) }); } }, TICK_MS);
  tick.unref?.();
  try { refreshStatus(); } catch (e) { log.warn('the status was not shown', { error: String(e?.message ?? e) }); }

  // ---- the reserve: hold sends past it, stop running turns, resume at the reset
  const keptOf = async () => { const v = await ctx.storage.get(KEPT_KEY); return isObj(v) ? v : {}; };
  const exempt = async (thread) => (await ctx.settings.get('keepWorking', { thread }).catch(() => false)) === true;
  const send = ctx.graph.intercept('CodexThread', 'send', async (call, next) => {
    const view = estOf(accountOf(call.ref.id)).view();   // the chat's own account's limit
    if (!reserveHolds(view, settings.reserve) || await exempt(call.ref)) return next();
    const b = view.binding;
    // keep it first, then stop: what is stopped is always kept (G6.2)
    await ctx.storage.transaction((tx) => {
      const kept = isObj(tx.get(KEPT_KEY)) ? tx.get(KEPT_KEY) : {};
      const list = Array.isArray(kept[call.ref.id]) ? kept[call.ref.id] : [];
      kept[call.ref.id] = [...list, { content: call.args[0], at: Date.now() }].slice(-MAX_KEPT);
      tx.set(KEPT_KEY, kept);
    });
    await scheduleResume(b);
    tell();
    return { status: 'stopped', message: `Live usage held this message: your ${b.name.toLowerCase()} limit is at ${b.estimate.toFixed(1)}%, past your reserve of ${settings.reserve}%. It is sent when the limit resets${Number.isFinite(b.resetsAt) ? ` (${new Date(b.resetsAt).toLocaleString()})` : ''}.` };
  });
  let stopping = false;
  async function checkReserve() {
    if (stopping || !Number.isFinite(settings.reserve) || settings.reserve <= 0 || settings.stopRunning !== true || !totals.active.size) return;
    stopping = true;
    try {
      for (const threadId of [...totals.active]) {
        const view = estOf(accountOf(threadId)).view();   // each chat by its own account's limit
        if (!reserveHolds(view, settings.reserve)) continue;
        const thread = { type: 'CodexThread', provider: 'codex', id: threadId };
        if (await exempt(thread)) continue;
        const out = await ctx.graph.invoke(thread, 'stop', [], { automatic: 'pause' });
        if (out?.status === 'done') {
          await ctx.storage.transaction((tx) => {
            const kept = isObj(tx.get(KEPT_KEY)) ? tx.get(KEPT_KEY) : {};
            kept[thread.id] = [...(Array.isArray(kept[thread.id]) ? kept[thread.id] : []), { content: { parts: [{ kind: 'text', text: 'Continue.' }] }, at: Date.now(), continuation: true }].slice(-MAX_KEPT);
            tx.set(KEPT_KEY, kept);
          });
          await scheduleResume(view.binding);
        } else log.info('a running turn was not stopped', { status: out?.status, message: out?.message });
      }
    } finally { stopping = false; }
  }
  async function scheduleResume(b) {
    const at = Number.isFinite(b?.resetsAt) ? b.resetsAt + 60_000 : Date.now() + 60 * 60_000;
    await ctx.scheduler.schedule({ id: RESUME_JOB, at, generation: Math.floor(at / 60_000) }).catch((e) => log.warn('the resume was not scheduled', { error: String(e?.message ?? e) }));
  }
  const resume = ctx.scheduler.on(RESUME_JOB, async (job) => {
    const kept = await keptOf();
    const left = {};
    for (const [threadId, list] of Object.entries(kept)) {
      const thread = { type: 'CodexThread', provider: 'codex', id: threadId };
      for (const [i, item] of list.entries()) {
        const key = `resume:${threadId}:${item.at}:${i}`;
        if (job.uncertain) { const made = await ctx.graph.made(key).catch(() => null); if (made && made.status !== 'refused' && made.status !== 'failed') continue; }
        const out = await ctx.graph.invoke(thread, 'send', [item.content], { automatic: 'resume', key }).catch((e) => ({ status: 'failed', message: String(e?.message ?? e) }));
        if (out?.status !== 'done') (left[threadId] ??= []).push(item);
      }
    }
    await ctx.storage.set(KEPT_KEY, left);
    if (Object.keys(left).length) await scheduleResume({ resetsAt: Date.now() + 15 * 60_000 - 60_000 });
    await job.done({ sent: Object.values(kept).flat().length - Object.values(left).flat().length });
  });

  const sub = ctx.settings.onChange((next) => { settings = next; refreshStatus(); tell(); void checkReserve(); });

  // ---- the menu bar app: the `usage` service's snapshot (schemaVersion 1) and a lease
  const snapshot = () => {
    const view = est.view();
    const rateLimits = {};
    for (const [id, snaps] of usages) for (const [limitId, snap] of Object.entries(snaps)) {
      rateLimits[usages.size > 1 ? `${id}:${limitId || 'codex'}` : (limitId || 'codex')] = { primary: snap?.primary ?? null, secondary: snap?.secondary ?? null, planType: snap?.planType ?? null, observedAt: totals.freshAt };
    }
    return { schemaVersion: 1, status: totals.freshAt ? 'live' : 'waiting', totals: { turns: totals.turns, requests: view.totals.responses, cost: Math.round(view.totals.cost) },
      active: { turns: totals.active.size }, concurrency: { peak: totals.peak }, configuration: null, rateLimits, coverage: { complete: true },
      estimates: view.windows.map((w) => ({ name: w.name, percent: w.percent, estimate: w.estimate, ratePerHour: w.ratePerHour, hoursLeft: w.hoursLeft, resetsAt: w.resetsAt, calibrated: w.calibrated })),
      reserve: { percent: n(settings.reserve), holding: reserveHolds(view, settings.reserve) } };
  };
  const service = ctx.services.provide('usage', {
    snapshot: async () => snapshot(),
    threads: async () => [...ests.values()].flatMap((e) => e.view().threads).sort((a, b) => b.cost - a.cost).slice(0, 50),
    kept: async () => { const k = await keptOf(); return Object.entries(k).map(([thread, list]) => ({ thread, count: list.length, continuation: list.some((x) => x.continuation) })); },
    release: async ({ thread } = {}) => { const k = await keptOf(); if (typeof thread === 'string') delete k[thread]; await ctx.storage.set(KEPT_KEY, thread ? k : {}); tell(); return true; },
  });
  const leaseFile = path.join(ctx.mod.dataDir, 'files', 'lease.json');
  let lease = null;
  await fs.rm(leaseFile, { force: true });
  try {
    lease = await ctx.appServer.clients.issue({ name: 'menubar' });
    await writePrivateJson(leaseFile, { id: lease.id, socketPath: lease.socketPath, token: lease.token });
  } catch (e) {
    log.info('no menu bar lease', { error: String(e?.message ?? e) });
    if (lease) await ctx.appServer.clients.revoke(lease.id).catch(() => {});
    lease = null;
    await fs.rm(leaseFile, { force: true });
  }

  return async () => {
    stopped = true;
    clearInterval(tick); clearTimeout(timer); clearTimeout(told);
    for (const d of [threads, usage, send, resume, sub, service, status.composer, status.title]) { try { d?.dispose(); } catch { /* gone */ } }
    if (lease) { await ctx.appServer.clients.revoke(lease.id).catch(() => {}); await fs.rm(leaseFile, { force: true }); }
    await flush();
  };
}

export default { host };
