// codexmods.account-switcher, host entry (GOAL.md goal 26, docs/design/reference-mods.md RM10). Single-file ESM, no imports.
//
// Several ChatGPT accounts: the framework keeps each signed in and its usage read (CodexAgent.accounts, each Account's CodexUsage), knows
// each chat's account (Thread.account) and moves a chat between turns (Thread.moveToAccount). This mod decides where chats run:
//   - New chats start on the account whose limit resets soonest (CodexAgent.setStartAccount, its automatic action `place`), while it has room.
//   - Soon after a compaction (at the end of the turn that compacted, when its context is small and a move costs least), and after a new
//     chat's first turn, a chat moves to the account whose limit resets soonest, when that is not its own: usage that resets soonest is
//     used first, so none is left unused at a reset.
//   - Right before an account runs out (its most used window at "near", 90% by default), the chats on it that were not just compacted move
//     off it at the end of their turn, to the account whose limit resets soonest that has room; the ones just compacted, and the one with
//     the smallest context, stay and use what is left: fewer chats are stopped by the limit (above all ones with a large context), and
//     each account's usage is still used in full. An account that ran out (or was signed out) has every chat moved off it.
// A limit's reset is its longest window's (the weekly one). Moving a chat is the mod's act: its automatic action `switch`, made only while
// the user has it on (never asking at each turn); it waits 10 minutes before moving the same chat again, unless its account ran out.
// Its page (renderer.mjs) shows the accounts with their usage and the chats on each, and adds, signs in and removes accounts as the user.

const AGENT = Object.freeze({ type: 'CodexAgent', provider: 'codex', id: 'codex' });
const COOLDOWN_MS = 10 * 60_000;
const ACTIVE_MS = 30 * 60_000;   // a chat that had a turn this recently is one of its account's active chats
const same = (a, b) => !!a && !!b && a.type === b.type && a.provider === b.provider && a.id === b.id;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An account's limit from its CodexUsage state: its most used window, its longest window's reset (ms), whether it was reached. */
export function limitOf(usage) {
  const snaps = isObj(usage?.snapshots) ? usage.snapshots : {};
  const snap = snaps.codex ?? Object.values(snaps)[0];
  if (!isObj(snap)) return null;
  const windows = [snap.primary, snap.secondary].filter((w) => isObj(w) && Number.isFinite(w.usedPercent));
  if (!windows.length) return null;
  const long = windows.reduce((a, w) => ((w.windowDurationMins ?? 0) > (a.windowDurationMins ?? 0) ? w : a));
  return {
    used: Math.max(...windows.map((w) => w.usedPercent)),
    resetsAt: Number.isFinite(long.resetsAt) ? long.resetsAt : null,
    reached: (typeof snap.rateLimitReachedType === 'string' && !!snap.rateLimitReachedType) || usage.ordinaryUsageAllowed === false,
  };
}
/** 'out' (signed out, or its limit reached), 'near' (its most used window at `near`), 'ok', or 'unknown' (no usage read yet). */
export function standingOf(account, near) {
  if (!account?.signedIn) return 'out';
  const l = account.limit;
  if (!l) return 'unknown';
  if (l.reached || l.used >= 100) return 'out';
  return l.used >= near ? 'near' : 'ok';
}
/** The account new usage should go to: of those with room, the one whose limit resets soonest (one not read yet comes last). */
export function preferredOf(accounts, near, except) {
  const room = accounts.filter((a) => !same(a.ref, except) && ['ok', 'unknown'].includes(standingOf(a, near)));
  const at = (a) => (standingOf(a, near) === 'unknown' ? Infinity : a.limit.resetsAt ?? Number.MAX_SAFE_INTEGER);
  return room.sort((a, b) => at(a) - at(b) || (a.limit?.used ?? 0) - (b.limit?.used ?? 0))[0] ?? null;
}
const resetsSooner = (a, b) => (a?.limit?.resetsAt ?? Infinity) < (b?.limit?.resetsAt ?? Infinity);

/**
 * Where a chat whose turn just ended should run (an account ref), or null to stay. `chat`: {account, justCompacted, firstTurn, movedAt,
 * context}; `peers`: the other active chats on its account ({justCompacted, context}).
 */
export function decide({ chat, accounts, near, now, peers = [] }) {
  const cur = accounts.find((a) => same(a.ref, chat.account)) ?? null;
  const st = cur ? standingOf(cur, near) : 'out';
  const best = preferredOf(accounts, near, chat.account);
  if (st === 'out') return best?.ref ?? null;   // ran out (or signed out): off it, wherever there is room
  if (Number.isFinite(chat.movedAt) && now - chat.movedAt < COOLDOWN_MS) return null;
  if (st === 'near') {
    // right before it runs out: the chats just compacted and the one with the smallest context stay and use what is left
    if (chat.justCompacted) return null;
    const smallest = !peers.some((p) => !p.justCompacted && (p.context ?? Infinity) < (chat.context ?? Infinity));
    if (smallest && !peers.some((p) => p.justCompacted)) return null;
    return best?.ref ?? null;
  }
  // soon after a compaction (or a first turn): to the account whose limit resets soonest
  if ((chat.justCompacted || chat.firstTurn) && best && (st === 'unknown' || resetsSooner(best, cur))) return best.ref;
  return null;
}

async function host(ctx) {
  const { log } = ctx;
  let settings = await ctx.settings.get();
  const settingsSub = ctx.settings.onChange?.((s) => { settings = s; void placeNew(); });
  const accounts = new Map();   // account id -> {ref, name, email, plan, signedIn, added}
  const usages = new Map();     // account id -> its CodexUsage state
  const chats = new Map();      // thread id -> {ref, title, status, account, turns, compactedIn, lastTurnAt, movedAt, context}
  let agent = { accounts: [], startAccount: null };
  let stopped = false;
  const near = () => (Number.isFinite(settings.near) ? settings.near : 90);
  const tell = () => { try { ctx.events.emit(`mod/${ctx.mod.id}/updated`, { at: Date.now() }); } catch { /* no listener */ } };

  /** The accounts as the strategy reads them: the agent's, in its order, each with its limit. */
  function list() {
    return agent.accounts.map((ref) => {
      const a = accounts.get(ref.id);
      return { ref, name: a?.name ?? 'An account', email: a?.email ?? null, plan: a?.plan ?? null, signedIn: a?.signedIn === true, added: a?.added === true,
        limit: limitOf(usages.get(ref.id)) };
    });
  }

  ctx.graph.subscribe({ ref: AGENT }, (m) => {
    const inst = m?.type === 'snapshot' ? m.items?.[0] : m?.event?.instance;
    if (!inst?.links) return;
    agent = { accounts: Array.isArray(inst.links.accounts) ? inst.links.accounts : inst.links.account ? [inst.links.account] : [], startAccount: inst.links.startAccount ?? null };
    void placeNew(); tell();
  });
  ctx.graph.subscribe({ type: 'ChatGPTAccount' }, (m) => {
    const items = m?.type === 'snapshot' ? (m.items ?? []) : m?.event?.instance ? [m.event.instance] : [];
    for (const a of items) {
      if (a.gone) { accounts.delete(a.ref.id); continue; }
      accounts.set(a.ref.id, { ref: a.ref, name: a.state?.name, email: a.state?.email ?? null, plan: a.state?.plan ?? null, signedIn: a.state?.signedIn === true, added: a.state?.added === true });
    }
    if (items.length) { void placeNew(); tell(); }
  });
  ctx.graph.subscribe({ type: 'CodexUsage' }, (m) => {
    const items = m?.type === 'snapshot' ? (m.items ?? []) : m?.event?.instance ? [m.event.instance] : [];
    for (const u of items) if (u?.links?.account?.id) usages.set(u.links.account.id, u.state);
    if (items.length) { void placeNew(); tell(); }
  });
  ctx.graph.subscribe({ type: 'CodexThread', depth: 'core' }, (m) => {
    if (m?.type === 'snapshot') { for (const th of m.items ?? []) seen(th, false); tell(); return; }
    if (m?.type !== 'delta') return;
    const e = m.event;
    if (e?.kind === 'event' && e.name === 'compacted') { const c = chats.get(e.ref.id); if (c) c.compactedIn = c.turns; return; }
    if (e?.instance) seen(e.instance, true);
  });
  function seen(th, live) {
    const id = th?.ref?.id;
    if (!id || th.state?.ephemeral === true) return;
    if (th.gone) { chats.delete(id); return; }
    const c = chats.get(id) ?? { ref: th.ref, turns: 0, compactedIn: null, lastTurnAt: null, movedAt: null, status: th.state?.status };
    const was = c.status;
    Object.assign(c, { title: th.state?.title ?? '', status: th.state?.status, account: th.links?.account ?? null, context: th.state?.usage?.last?.inputTokens ?? null });
    chats.set(id, c);
    // a turn ended: where the chat runs next is decided now, between its turns
    if (live && (was === 'working' || was === 'waitingForYou') && c.status === 'idle') { c.turns += 1; c.lastTurnAt = Date.now(); void turnEnded(c); }
  }

  async function turnEnded(c) {
    if (stopped || agent.accounts.length < 2) return;
    const accs = list();
    const justCompacted = c.compactedIn !== null && c.turns - c.compactedIn <= 1;
    const now = Date.now();
    const peers = [...chats.values()].filter((x) => x !== c && same(x.account, c.account) && x.lastTurnAt && now - x.lastTurnAt < ACTIVE_MS)
      .map((x) => ({ justCompacted: x.compactedIn !== null && x.turns - x.compactedIn <= 1, context: x.context }));
    const to = decide({ chat: { account: c.account, justCompacted, firstTurn: c.turns === 1, movedAt: c.movedAt, context: c.context }, accounts: accs, near: near(), now, peers });
    if (!to || same(to, c.account)) return;
    // the mod's own act: only while the user has its automatic action on
    const may = await ctx.graph.assess(c.ref, 'moveToAccount', [to], { automatic: 'switch' }).catch(() => null);
    if (may?.status !== 'allowed') { log.info('a move was not made: its automatic action is off', { thread: c.ref.id, status: may?.status }); return; }
    const out = await ctx.graph.invoke(c.ref, 'moveToAccount', [to], { automatic: 'switch' }).catch((e) => ({ status: 'failed', message: String(e?.message ?? e) }));
    if (out?.status === 'done') { c.movedAt = Date.now(); c.account = to; log.info('a chat moved', { thread: c.ref.id, to: to.id }); tell(); }
    else log.warn('a chat did not move', { thread: c.ref.id, status: out?.status, message: out?.message });
  }

  /** New chats start on the account whose limit resets soonest (the setting `placeNew`, on by default). */
  let placing = null;
  async function placeNew() {
    if (stopped || settings.placeNew === false || agent.accounts.length < 2) return;
    const best = preferredOf(list(), near());
    if (!best) return;
    const isApp = same(best.ref, agent.accounts[0]);
    const cur = agent.startAccount;
    if ((isApp && !cur) || same(cur, best.ref)) return;
    if (placing) return;
    const args = isApp ? [] : [best.ref];
    // the mod's own act: only while the user has its automatic action `place` on
    const may = await ctx.graph.assess(AGENT, 'setStartAccount', args, { automatic: 'place' }).catch(() => null);
    if (may?.status !== 'allowed' || placing) return;
    placing = ctx.graph.invoke(AGENT, 'setStartAccount', args, { automatic: 'place' }).catch((e) => ({ status: 'failed', message: String(e?.message ?? e) }))
      .then((out) => { if (out?.status !== 'done') log.warn('new chats were not placed', { status: out?.status, message: out?.message }); })
      .finally(() => { placing = null; });
  }

  const svc = ctx.services.provide('switcher', {
    /** The page's data: each account with its usage, standing and chats; where new chats start; the automatic action's state. */
    async status() {
      const accs = list();
      const best = preferredOf(accs, near());
      return {
        near: near(),
        start: agent.startAccount?.id ?? accs[0]?.ref.id ?? null,
        preferred: best?.ref.id ?? null,
        accounts: accs.map((a) => ({ ref: a.ref, name: a.name, email: a.email, plan: a.plan, signedIn: a.signedIn, added: a.added, limit: a.limit,
          standing: standingOf(a, near()), chats: [...chats.values()].filter((c) => same(c.account, a.ref)).length })),
      };
    },
  });
  return () => { stopped = true; svc.dispose(); settingsSub?.dispose(); };
}

export default { host };
