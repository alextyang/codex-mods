// Several accounts in the native provider (docs/design/reference-mods.md RM10, GOAL.md goal 26): the accounts the user added beside the
// app's (framework/host/added-accounts.mjs keeps their backends and where their chats run), each with its own ChatGPTAccount and
// CodexUsage from its own app-server (an account feed of accounts.mjs per account); every chat's account (Thread.account); and moving a chat
// to another account between turns, which the framework does itself so nothing of a mod touches a backend:
//   the chat is held at the mux (its requests wait), checked idle (its status here, nothing in flight, and its home's own status), resumed
//   on the target (the same chat: the backends share the app's chat stores), re-homed (its requests go there, its subscribers follow, its
//   old home's frames for it are dropped), let go on its old home, and released; its placement is kept across restarts.
// Also: CodexAgent.accounts and startAccount (where new chats start: keyless thread starts go to that account's backend), addAccount,
// setStartAccount, Account.remove (its chats move to the app's account first), and the chats of an added backend that stopped resumed
// there again. An added account's credentials stay in its own Codex home: no operation here reads or returns them.
import { refs } from './map.mjs';
import { createAccountFeed } from './accounts.mjs';

export const ADDED_PREFIX = 'framework/';
const refused = (reason, message) => ({ status: 'refused', reason, message });
// an account of this provider's (a mod's own instance with the same id is never taken for it)
const isAccountRef = (r) => r && typeof r === 'object' && (r.type === 'ChatGPTAccount' || r.type === 'Account') && r.provider === 'codex' && typeof r.id === 'string';

/**
 * @param {{ added: ReturnType<typeof import('../../../added-accounts.mjs').createAddedAccounts> | null, mux: object, client: object,
 *   handle: object, appState: object | null, resident(ref: object): object | null, safe(what: string, fn: () => unknown): unknown,
 *   emitEvent(ref: object, name: string, payload?: object): void, log: object, primary: ReturnType<typeof createAccountFeed>,
 *   threads(): Iterable<string>, ephemeral(id: string): boolean, loaded(id: string): boolean, relinkAgent(): void, bus?: object }} o
 */
export function createAddedFeeds(o) {
  const { added, mux, client, handle, resident, safe, log } = o;
  const feeds = new Map();   // account key -> its account feed
  const removing = new Set();   // keys of accounts being removed: no chat starts on or moves to them
  // moves have a client of their own, so the hold keeps back every other request on the chat, this provider's ordinary ones included
  const mover = mux.client('graph:codex-moves');
  let disposed = false;
  const keyOf = (backend) => (typeof backend === 'string' && backend.startsWith(ADDED_PREFIX) ? backend.slice(ADDED_PREFIX.length) : null);

  function ensure(key) {
    let f = feeds.get(key);
    if (f) return f;
    const backend = `${ADDED_PREFIX}${key}`;
    f = createAccountFeed({ handle, appState: o.appState, fixedId: key, rpc: (method, params) => client.request(method, params, { backend }), resident, safe,
      emitEvent: o.emitEvent, log, relinkAgent: () => o.relinkAgent() });
    feeds.set(key, f);
    return f;
  }
  /** Every added account has its feed (read now, or when the app-server is ready); a removed one's goes, with its instances. */
  function sync(read = true) {
    if (!added || disposed) return;
    const keys = new Set(added.list().map((a) => a.key));
    for (const k of keys) if (!feeds.has(k)) { ensure(k); if (read) void feeds.get(k).read(); }
    for (const [k, f] of [...feeds]) {
      if (keys.has(k)) continue;
      f.dispose(); feeds.delete(k);
      safe('usage', () => handle.remove(refs.usage(k)));
      safe('account', () => handle.remove(refs.chatgptAccount(k)));
    }
    o.relinkAgent();
  }
  const sub = added?.onChange(() => sync()) ?? null;
  sync(false);   // the accounts restored at start: their instances now, read once the app-server is ready (the provider's readAll)

  /** The backend an account's chats run on: 'primary' for the app's own, its framework backend for an added one; null for another. */
  function backendOf(account) {
    if (!isAccountRef(account)) return null;
    if (account.type === 'ChatGPTAccount' && removing.has(account.id)) return null;
    if (account.type === 'ChatGPTAccount' && feeds.has(account.id)) return `${ADDED_PREFIX}${account.id}`;
    const cur = o.primary.current();
    return cur && cur.type === account.type && cur.id === account.id ? 'primary' : null;
  }
  /** A chat's account: its placement's, else the app's. */
  function accountOf(threadId) {
    const key = added?.placementOf(threadId) ?? null;
    if (key && feeds.has(key)) return feeds.get(key).current() ?? refs.chatgptAccount(key);
    return o.primary.current();
  }
  function relinkThread(threadId) {
    const r = refs.thread(threadId);
    if (!resident(r)) return;
    safe('thread account', () => handle.update(r, { links: { account: accountOf(threadId) } }));
  }
  /** The app's account changed: the chats it runs link to it again. */
  function relinkPrimaryThreads() {
    for (const id of o.threads()) if (!added?.placementOf(id)) relinkThread(id);
  }

  /** Move a chat to an account between turns (the module comment). */
  async function move(ref, account, intent) {
    const threadId = ref.id;
    const to = backendOf(account);
    if (!to) return refused('invalid', 'an account of the Codex agent is needed');
    if (!resident(account)?.state.signedIn) return refused('notAllowed', 'that account is signed out');
    if (o.ephemeral(threadId)) return refused('unsupported', 'a chat that is not kept cannot move');
    const from = mux.homeOf(threadId);
    if (from === to) return null;
    const busy = () => refused('unavailable', 'the chat is working: it moves between turns');
    const status = resident(ref)?.state.status;
    if (status === 'working' || status === 'waitingForYou') return busy();
    let hold;
    try { hold = mux.hold(threadId, mover.id); } catch { return refused('unavailable', 'the chat is already moving'); }
    try {
      if (mux.inFlight(threadId, mover.id) > 0) return busy();
      let was = 'notLoaded';
      try {
        const r = await mover.request('thread/read', { threadId, includeTurns: false }, { backend: from, intent });
        if (r?.thread?.ephemeral === true) return refused('unsupported', 'a chat that is not kept cannot move');
        was = typeof r?.thread?.status?.type === 'string' ? r.thread.status.type : 'notLoaded';
      } catch { was = 'notLoaded'; }   // its home does not have it (never loaded there since it started): nothing runs there
      if (was === 'active') return busy();
      await mover.request('thread/resume', { threadId, excludeTurns: true }, { backend: to, intent });
      mux.rehome(threadId, to);
      // recorded before anything goes on: a crash after this point restores it where it now runs; unrecorded, the move is undone
      if (added && !added.flush()) {
        try { await mover.request('thread/resume', { threadId, excludeTurns: true }, { backend: from, intent }); } catch { /* it reloads there on its next request */ }
        mux.rehome(threadId, from);
        added.flush();
        try { await mover.request('thread/unsubscribe', { threadId }, { backend: to, intent }); } catch { /* not loaded there */ }
        return refused('unavailable', 'the move could not be recorded: the chat stays on its account');
      }
      // its old home lets it go (it no longer writes it); the mover's own subscription from the resume ends too (the app's stays)
      if (was !== 'notLoaded') { try { await mover.request('thread/unsubscribe', { threadId }, { backend: from, intent }); } catch (e) { log.warn('accounts: a moved chat was not let go on its old backend', { message: String(e?.message ?? e) }); } }
      try { await mover.request('thread/unsubscribe', { threadId }, { backend: to, intent }); } catch { /* the app's subscription keeps it either way */ }
      relinkThread(threadId);
      log.info('accounts: a chat moved', { thread: threadId, from, to });
      return null;
    } catch (e) {
      return refused('unavailable', `the chat could not move: ${String(e?.message ?? e)}`);
    } finally { hold.release(); }
  }

  /** The chats on an added account move to the app's, each between its turns; those still working stay (the count of them). */
  async function moveAllHome(key) {
    const home = o.primary.current();
    let left = 0;
    for (const id of added?.threadsOn(key) ?? []) {
      const r = home && resident(home)?.state.signedIn ? await move(refs.thread(id), home) : refused('notAllowed', 'the app is signed out');
      if (r && r.status === 'refused') left++;
    }
    return left;
  }

  /** An added backend that stopped on its own (a crash): the chats loaded on it are resumed there again. */
  const exitSub = o.bus?.subscribe?.(`backend/${ADDED_PREFIX}*`, (d, topic) => {
    if (typeof topic === 'string' && !topic.endsWith('/exited')) return;
    const key = keyOf(d?.backend);
    if (disposed || !key || !feeds.has(key) || d?.reason === 'removed' || d?.reason === 'close') return;
    for (const id of added?.threadsOn(key) ?? []) {
      if (!o.loaded(id)) continue;
      client.request('thread/resume', { threadId: id, excludeTurns: true }, { backend: `${ADDED_PREFIX}${key}` })
        .catch((e) => log.warn('accounts: a chat was not resumed on its restarted account', { message: String(e?.message ?? e) }));
    }
  }) ?? null;

  return {
    sync,
    keyOf,
    feedOf: (ref) => (isAccountRef(ref) && ref.type === 'ChatGPTAccount' && feeds.has(ref.id) ? feeds.get(ref.id) : null),
    accountOf,
    relinkThread,
    relinkPrimaryThreads,
    backendOf,
    move,
    /** CodexAgent's links: every account (the app's first) and the one new chats start on. */
    agentLinks() {
      const list = [o.primary.current(), ...[...feeds.values()].map((f) => f.current())].filter(Boolean);
      const start = added?.startKey ? feeds.get(added.startKey)?.current() ?? null : null;
      return { accounts: list, startAccount: start };
    },
    /** A notification of an added account's own (its sign-in, its usage). */
    notified(key, method, params) { feeds.get(key)?.notified(method, params); },
    turnEnded(key) { feeds.get(key)?.turnEnded(); },
    observe(ref) { return feeds.get(ref?.id)?.observe(); },
    readAll() { return Promise.all([...feeds.values()].map((f) => f.read())); },
    async addAccount() {
      if (!added) return refused('unavailable', 'accounts cannot be added in this copy');
      const { key } = await added.add();
      const f = ensure(key);
      o.relinkAgent();
      const ref = refs.chatgptAccount(key);
      await f.read();
      const signIn = await f.signIn(ref);
      if (signIn?.status === 'refused') log.warn('accounts: an added account\'s sign-in did not open', { message: signIn.message });
      return ref;
    },
    async setStart(account) {
      if (!added) return refused('unavailable', 'accounts cannot be added in this copy');
      if (account === undefined || account === null) { added.setStart(null); o.relinkAgent(); return null; }
      const to = backendOf(account);
      if (!to) return refused('invalid', 'an account of the Codex agent is needed');
      if (!resident(account)?.state.signedIn) return refused('notAllowed', 'that account is signed out');
      added.setStart(to === 'primary' ? null : account.id);
      o.relinkAgent();
      return null;
    },
    removePrompt(instance) {
      return { action: `remove the added account ${instance.state.name}`, detail: 'Its chats move to the app\'s own account; it is signed out and removed.' };
    },
    async remove(ref) {
      const f = isAccountRef(ref) ? feeds.get(ref.id) : null;
      if (!f || !added) return refused('unsupported', 'only an added account is removed here; the app\'s own signs out in the app');
      // no chat starts on it or moves to it from now on; its chats move home; it goes only once none is left on it
      removing.add(ref.id);
      if (added.startKey === ref.id) { added.setStart(null); o.relinkAgent(); }
      await moveAllHome(ref.id);
      const still = added.threadsOn(ref.id).length;   // read again: what moved or started there meanwhile counts
      if (still > 0) {
        removing.delete(ref.id);
        return refused('unavailable', `${still} of its chats ${still === 1 ? 'is' : 'are'} working: remove it once they finish`);
      }
      try { if (resident(ref)?.state.signedIn) await client.request('account/logout', undefined, { backend: `${ADDED_PREFIX}${ref.id}` }); }
      catch (e) { log.warn('accounts: a removed account was not signed out first', { message: String(e?.message ?? e) }); }
      await added.remove(ref.id);   // its onChange removes the feed and its instances
      return null;
    },
    /** Its sign-out: its chats move to the app's account between turns (those working move when the strategy or the user moves them). */
    async signOut(ref) {
      const f = isAccountRef(ref) ? feeds.get(ref.id) : null;
      if (!f) return refused('unsupported', 'not an added account');
      const out = await f.signOut(ref);
      await moveAllHome(ref.id);
      return out;
    },
    dispose() {
      disposed = true;
      sub?.dispose(); exitSub?.dispose();
      for (const f of feeds.values()) f.dispose();
      feeds.clear();
    },
  };
}
