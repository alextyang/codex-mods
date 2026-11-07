// Account, ChatGPTAccount and Usage in the native provider (breadth step D4; docs/graph/02-types.md; scout
// docs/design/realization/scouting/D4-21477.md). The app-server owns the sign-in: the protocol's `account/read` (never with a token
// refresh) gives the kind of account, its email and plan, `account/updated` and `account/login/completed` tell a change. For a ChatGPT
// account framework-main adds the account's ids and workspace the app's way (framework/main/app-state.cjs `account`: no token leaves).
// - One Account for the signed-in account: a ChatGPTAccount named by its account id (its name is its workspace's for a workspace account,
//   else its email), or an Account for an API key (`openai-api`) or Amazon Bedrock (`amazon-bedrock`). When the app signs out, the account
//   stays, `signedIn: false`, as does one another account replaced. The Codex agent links to it (CodexAgent.account; Account.agents is the
//   inverse). Until framework-main can say a ChatGPT account's id (no window yet) it is put as `chatgpt`, read again when framework-main
//   is available and replaced by the account under its id (the same account: no event).
// - Usage: a CodexUsage with the server's rate-limit snapshots as the protocol gives them (graph-integrity G1.2), keyed by their `limitId`:
//   from `account/rateLimits/read` (the app's own Usage page reads the same backend another way) and each `account/rateLimits/updated`,
//   which replaces its limit's snapshot and is reported as given (`reported`, every one, repeats included). Times are the graph's
//   (milliseconds); a field the library has no schema for stays in the snapshot's `extra`. Nothing is computed: whether a limit is near,
//   reached or reset is a mod's to derive. Read when the account is, when a turn ends (debounced), every READ_MS, and when a realm observes
//   it after FRESH_MS.
// Events: Account signedIn, signedOut, planChanged; CodexUsage changed, reported.
// Operations: signIn() starts the app-server's ChatGPT sign-in and opens its page in the browser (nothing when signed in); signOut() signs
// the app out after the user approves a mod's call (R17); manage() opens the app's account settings.
// An added account (RM10, added-accounts.mjs) has a feed of its own on its own backend: its ChatGPTAccount is named by its key (`fixedId`,
// framework-main knows only the app's), `added`, and put signed out until its first sign-in; manage() is the app's account's only.
import { refs } from './map.mjs';

export const READ_MS = 5 * 60_000;
const UNKNOWN_ID = 'chatgpt';   // a ChatGPT account whose id framework-main has not said yet
const FRESH_MS = 60_000;
const AFTER_TURN_MS = 3_000;
/** The protocol's account (and framework-main's account facts) -> the Account instance, or null when there is none. */
export function accountData(acct, info, fixedId) {
  if (!acct || typeof acct !== 'object') return null;
  if (acct.type === 'chatgpt') {
    const id = fixedId ?? (typeof info?.accountId === 'string' && info.accountId ? info.accountId : UNKNOWN_ID);
    const ws = info?.workspace?.structure === 'workspace' && typeof info.workspace.name === 'string' && info.workspace.name ? info.workspace.name : null;
    const email = typeof acct.email === 'string' && acct.email ? acct.email : null;
    return {
      ref: refs.chatgptAccount(id),
      state: { service: 'chatgpt', name: ws ?? email ?? 'ChatGPT', signedIn: true, ...(email ? { email } : {}), ...(acct.planType ? { plan: String(acct.planType) } : {}), ...(ws ? { workspace: ws } : {}), ...(fixedId ? { added: true } : {}) },
      links: { usage: refs.usage(id) },
    };
  }
  if (fixedId) return null;   // an added account is a ChatGPT account only
  const service = acct.type === 'apiKey' ? 'openai-api' : acct.type === 'amazonBedrock' ? 'amazon-bedrock' : String(acct.type ?? 'unknown');
  return { ref: refs.account(service), state: { service, name: service === 'openai-api' ? 'OpenAI API key' : service === 'amazon-bedrock' ? 'Amazon Bedrock' : service, signedIn: true }, links: {} };
}

const SNAPSHOT_KEYS = ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'planType', 'rateLimitReachedType', 'individualLimit', 'spendControlReached', 'normalModelSlug'];
const window = (w) => (w && typeof w === 'object' && Number.isFinite(w.usedPercent)
  ? { usedPercent: w.usedPercent, ...(Number.isFinite(w.windowDurationMins) ? { windowDurationMins: w.windowDurationMins } : {}), ...(Number.isFinite(w.resetsAt) ? { resetsAt: w.resetsAt * 1000 } : {}) }
  : null);
/** A protocol RateLimitSnapshot as CodexUsage keeps it: its fields as given (times in ms), nulls left out, the rest in `extra`. */
export function snapshotOf(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const out = {};
  for (const k of ['limitId', 'limitName', 'planType', 'rateLimitReachedType', 'normalModelSlug']) if (typeof snap[k] === 'string' && snap[k]) out[k] = snap[k];
  for (const k of ['primary', 'secondary']) { const w = window(snap[k]); if (w) out[k] = w; }
  if (snap.credits && typeof snap.credits === 'object' && typeof snap.credits.hasCredits === 'boolean' && typeof snap.credits.unlimited === 'boolean') {
    out.credits = { hasCredits: snap.credits.hasCredits, unlimited: snap.credits.unlimited, ...(typeof snap.credits.balance === 'string' ? { balance: snap.credits.balance } : {}) };
  }
  for (const k of ['individualLimit', 'spendControlReached']) if (snap[k] !== undefined && snap[k] !== null) out[k] = snap[k];
  const extra = Object.fromEntries(Object.entries(snap).filter(([k, v]) => !SNAPSHOT_KEYS.includes(k) && v !== undefined && v !== null));
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}
/** The protocol's rate limits (account/rateLimits/read) -> CodexUsage's state: every snapshot by its limitId, and what the read says beside. */
export function usageState(resp) {
  const byId = resp?.rateLimitsByLimitId && typeof resp.rateLimitsByLimitId === 'object' ? Object.entries(resp.rateLimitsByLimitId)
    : resp?.rateLimits ? [[resp.rateLimits.limitId ?? '', resp.rateLimits]] : [];
  const snapshots = {};
  for (const [id, snap] of byId) { const x = snapshotOf(snap); if (x) snapshots[String(id ?? '')] = x; }
  return { snapshots, ...(typeof resp?.ordinaryUsageAllowed === 'boolean' ? { ordinaryUsageAllowed: resp.ordinaryUsageAllowed } : {}),
    ...(resp?.rateLimitResetCredits !== undefined && resp?.rateLimitResetCredits !== null ? { rateLimitResetCredits: resp.rateLimitResetCredits } : {}) };
}

/** The operation handlers, for the provider's registration (Account's, which ChatGPTAccount inherits). */
export function accountTypes(feed) {
  return {
    Account: {
      operations: {
        signIn: { effect: 'external', handler: ({ ref }) => feed.signIn(ref) },
        // Signing the app out ends the user's session in Codex: a mod's call asks the user first (R17).
        signOut: { effect: 'external', approval: ({ instance }) => feed.prompt(instance), handler: ({ ref }) => feed.signOut(ref) },
        manage: { effect: 'none', handler: ({ instance }) => feed.manage(instance) },
        // an added account (RM10): its chats move to the app's account, it is signed out and removed; a mod's call asks the user first
        ...(feed.remove ? { remove: { effect: 'external', approval: ({ instance }) => feed.removePrompt(instance), handler: ({ ref }) => feed.remove(ref) } } : {}),
      },
    },
  };
}

/**
 * @param {{ handle: object, appState: ReturnType<typeof import('../../app-state.mjs').createAppState> | null, rpc(method: string, params?: object): Promise<any>,
 *   resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown, emitEvent(ref: object, name: string, payload?: object): void,
 *   relinkAgent(): void, log: { warn(m: string, d?: unknown): void }, now?: () => number }} o
 */
/** An added account before its first sign-in (or once its sign-in is gone): a ChatGPT account under its key, signed out. */
export function addedPlaceholder(key) {
  return { ref: refs.chatgptAccount(key), state: { service: 'chatgpt', name: 'Added account', signedIn: false, added: true }, links: { usage: refs.usage(key) } };
}

export function createAccountFeed(o) {
  const { handle, safe } = o;
  const fixedId = typeof o.fixedId === 'string' && o.fixedId ? o.fixedId : undefined;   // an added account's key
  const now = o.now ?? Date.now;
  let current = null;        // the Account ref
  let reading = null;
  let usageAt = 0, usageReading = null, lastUsage = null;
  let afterTurn = null;
  let disposed = false;
  let heard = false;
  if (fixedId) {
    // an added account is there from the start, signed out until its backend says otherwise
    current = refs.chatgptAccount(fixedId);
    if (!o.resident(current)) { const p = addedPlaceholder(fixedId); safe('account', () => handle.put(p.ref, { state: p.state, links: p.links })); }
  }

  async function read() {
    if (disposed) return;
    if (reading) return reading;
    reading = (async () => {
      let r;
      try { r = await o.rpc('account/read', { refreshToken: false }); } catch (e) { o.log.warn('accounts: the account could not be read', { message: String(e?.message ?? e) }); return; }
      const acct = r?.account ?? null;
      let info = null;
      if (acct?.type === 'chatgpt' && !fixedId && o.appState?.available) {
        const a = await o.appState.op('account');
        if (a.ok) info = a.result;
      }
      apply(acct, info);
    })().finally(() => { reading = null; });
    return reading;
  }
  function apply(acct, info) {
    const sync = !heard;
    heard = true;
    const d = accountData(acct, info, fixedId);
    if (!d) {
      if (current && o.resident(current) && o.resident(current).state.signedIn) {
        safe('account', () => handle.update(current, { state: { signedIn: false } }));
        if (!sync) o.emitEvent(current, 'signedOut');
      }
      return;
    }
    const was = current;
    const moved = was && (was.id !== d.ref.id || was.type !== d.ref.type);
    // The account under its id once framework-main says it: the same account, so what it was is the placeholder's.
    const named = moved && was.type === 'ChatGPTAccount' && was.id === UNKNOWN_ID && d.ref.type === 'ChatGPTAccount';
    const cur = named ? o.resident(was) : o.resident(d.ref);
    if (named) {
      safe('usage', () => handle.remove(refs.usage(UNKNOWN_ID)));
      safe('account', () => handle.remove(was));
    } else if (moved && o.resident(was)?.state.signedIn) {
      safe('account', () => handle.update(was, { state: { signedIn: false } }));
      if (!sync) o.emitEvent(was, 'signedOut');
    }
    safe('account', () => handle.put(d.ref, { state: d.state, links: d.links }));
    current = d.ref;
    if (!was || moved) o.relinkAgent();
    if (!sync && (!cur || !cur.state.signedIn)) o.emitEvent(d.ref, 'signedIn');
    else if (!sync && cur && cur.state.plan !== d.state.plan) o.emitEvent(d.ref, 'planChanged');
    if (d.ref.type === 'ChatGPTAccount') readUsage();
  }
  /** The account's usage as the source has it now; `changed` when it is not what it was. */
  function putUsage(state, sync) {
    if (!current || current.type !== 'ChatGPTAccount') return;
    const ref = refs.usage(current.id);
    const cur = o.resident(ref);
    safe('usage', () => handle.put(ref, { state, links: { account: current } }));
    if (!sync && cur && JSON.stringify(cur.state) !== JSON.stringify(state)) o.emitEvent(ref, 'changed');
  }
  function readUsage() {
    if (disposed || !current || current.type !== 'ChatGPTAccount') return Promise.resolve();
    if (usageReading) return usageReading;
    usageReading = (async () => {
      let r;
      try { r = await o.rpc('account/rateLimits/read'); } catch (e) { o.log.warn('accounts: the usage could not be read', { message: String(e?.message ?? e) }); return; }
      const sync = !lastUsage;
      usageAt = now();
      lastUsage = usageState(r);
      putUsage(lastUsage, sync);
    })().finally(() => { usageReading = null; });
    return usageReading;
  }
  const timer = setInterval(() => { readUsage(); }, READ_MS);
  timer.unref?.();
  const sub = fixedId ? null : o.appState?.onChange((c) => { if (c.available && current?.type === 'ChatGPTAccount' && current.id === UNKNOWN_ID) read(); }) ?? null;
  const refused = (reason, message) => ({ status: 'refused', reason, message });

  return {
    read,
    /** The Codex agent's account, when one is known. */
    current: () => current,
    /** The source's onObserve for an Account or Usage ref: the usage is read again when it is old. */
    observe() { return now() - usageAt > FRESH_MS ? readUsage() : undefined; },
    /** A protocol notification about the account. */
    notified(method, p) {
      if (method === 'account/updated' || (method === 'account/login/completed' && p?.success)) { read(); return; }
      // a report: its limit's snapshot replaced as given, and reported, every one (graph-integrity G1.3)
      if (method === 'account/rateLimits/updated' && p?.rateLimits && current?.type === 'ChatGPTAccount') {
        const snapshot = snapshotOf(p.rateLimits);
        if (!snapshot) return;
        lastUsage = { ...(lastUsage ?? { snapshots: {} }), snapshots: { ...(lastUsage?.snapshots ?? {}), [snapshot.limitId ?? '']: snapshot } };
        putUsage(lastUsage, false);
        const ref = refs.usage(current.id);
        if (o.resident(ref)) o.emitEvent(ref, 'reported', { snapshot });
      }
    },
    /** A turn ended: the usage moved (the app reads its own after each message too). */
    turnEnded() {
      if (disposed || afterTurn) return;
      afterTurn = setTimeout(() => { afterTurn = null; readUsage(); }, AFTER_TURN_MS);
      afterTurn.unref?.();
    },
    prompt(instance) {
      if (!instance.state.signedIn) return null;
      if (fixedId) return { action: `sign out of the added account ${instance.state.name}`, detail: 'Its chats move to the app\'s own account between turns.' };
      return { action: `sign out of ${instance.state.service === 'chatgpt' ? 'ChatGPT' : instance.state.name} in Codex`, detail: 'Codex stops working with this account until you sign in again.' };
    },
    async signIn(ref) {
      const inst = o.resident(ref);
      if (inst?.state.signedIn) return null;
      if (ref.type !== 'ChatGPTAccount') return refused('unsupported', 'only a ChatGPT account signs in from here');
      if (!o.appState?.available) return refused('unavailable', 'the app\'s browser cannot be reached');
      const r = await o.rpc('account/login/start', { type: 'chatgpt' });
      if (typeof r?.authUrl !== 'string') return refused('unavailable', 'the app-server gave no sign-in page');
      const opened = await o.appState.op('open-login', { path: r.authUrl });
      if (!opened.ok) return refused('unavailable', opened.error);
      return null;
    },
    async signOut(ref) {
      if (!o.resident(ref)?.state.signedIn) return null;
      await o.rpc('account/logout');
      await read();
      return null;
    },
    async manage(instance) {
      if (fixedId) return refused('unsupported', 'an added account has no page in the app');
      if (instance.state.service !== 'chatgpt') return refused('unsupported', 'the app manages only a ChatGPT account');
      const r = await o.appState?.op('navigate', { path: '/settings/account' });
      if (r?.ok) return null;
      return refused('unavailable', r?.error ?? 'the app\'s pages cannot be reached');
    },
    dispose() { disposed = true; clearInterval(timer); clearTimeout(afterTurn); sub?.dispose(); },
  };
}
