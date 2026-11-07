// A mod's permissions as the user decides them (docs/design/framework-ui.md F8). The manifest's `permissions` are required: consent grants them, and the way to stop one is the
// mod's switch. Its `optionalPermissions` each have a decision, `allow`, `ask` or `deny`, kept in its record by grant string. What a decision may be depends on what the framework can
// enforce and whether a call can wait: an act on the graph, a secret and a request to Codex can be held for the user (`ask`); what is checked at activation, at registration or in a
// path that cannot wait is only allowed or not. The record's `grants` are what the mod holds outright, the required and the allowed: every reader (the graph's policy, the ctx gates,
// the mux, the rules, the processes) reads them as it always did. An `ask` grant is never among them, so whatever cannot wait treats it as not held by construction; only the three
// gates that can wait look at the asks, and only when the held grants refuse.
// `createPermissionGate` is the Host's prompt: one request per mod at a time, in the window in front (the windows provider's queue, settled only by the page's own runtime), ending on
// its time (60 s), on the mod stopping, or on a decision changing. A Deny keeps that grant from asking again while the mod runs, so a mod cannot prompt in a loop. Node built-ins only.
import { CodexModsError } from '../../sdk/errors.mjs';

/** The decisions, the most held first. */
export const DECISIONS = Object.freeze(['allow', 'ask', 'deny']);
const RANK = { deny: 0, ask: 1, allow: 2 };
const ASKABLE = ['graph.act', 'secrets', 'appServer.request'];
/** A prompt waits this long for the user, then the call is refused. */
export const PROMPT_MS = 60_000;

const familyOf = (g) => String(g).split(':')[0];
/** Can a call under this grant wait for the user? */
export const askable = (grant) => ASKABLE.includes(familyOf(grant));
/** Is the framework able to enforce this grant at all? `network` is declared, not enforced: a worker has Node, and a renderer shares the page. */
export const enforced = (grant) => grant !== 'network';
/** What the user may decide for an optional grant. */
export const choicesOf = (grant) => (!enforced(grant) ? [] : askable(grant) ? ['allow', 'ask', 'deny'] : ['allow', 'deny']);
/** The decision an optional grant starts with. */
export const defaultOf = (grant) => (askable(grant) ? 'ask' : 'deny');

/** Do two grants cover some of the same thing? Same family, and one is bare, or they share an entry (a type and its operation, a method and its prefix). Subtypes are not seen here. */
export function overlaps(a, b) {
  if (familyOf(a) !== familyOf(b)) return false;
  // `Type.*` is the type, as the graph's policy reads it: every operation
  const items = (g) => (g.includes(':') ? g.slice(g.indexOf(':') + 1).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.endsWith('.*') ? x.slice(0, -2) : x)) : null);
  const ia = items(a), ib = items(b);
  if (!ia || !ib) return true;
  const one = (x, y) => x === y || x === '*' || y === '*' || y.startsWith(`${x}.`) || (x.endsWith('/') && y.startsWith(x));
  return ia.some((x) => ib.some((y) => one(x, y) || one(y, x)));
}

/** The decisions a manifest's optional grants have: a kept one where it is still a choice, else the grant's default. */
export function decisionsFor(manifest, previous = {}) {
  return Object.fromEntries((manifest?.optionalPermissions ?? []).map((g) => [g, choicesOf(g).includes(previous?.[g]) ? previous[g] : defaultOf(g)]));
}
/** What a mod holds outright: its required grants and its optional ones allowed. */
export const grantsFor = (required, decisions = {}) => [...required, ...Object.entries(decisions).filter(([, d]) => d === 'allow').map(([g]) => g)];
/** Its optional grants decided `ask`. */
export const asksOf = (record) => Object.entries(record?.decisions ?? {}).filter(([, d]) => d === 'ask').map(([g]) => g);
/** Of a record's grants, the required ones: those with no decision. */
export const requiredOf = (record) => (record?.grants ?? []).filter((g) => !Object.hasOwn(record?.decisions ?? {}, g));
/** A restore never raises a decision (F8): of the decision it restores and the one held now, the lower. */
export function restoredDecisions(restored = {}, now = {}) {
  return Object.fromEntries(Object.entries(restored).map(([g, d]) => [g, Object.hasOwn(now, g) && RANK[now[g]] < RANK[d] ? now[g] : d]));
}

/**
 * The Host's gate for the calls that can wait, and the prompt behind it.
 * @param {{ record: (modId: string) => object | undefined, status: (modId: string) => string, safeMode: () => boolean,
 *   windows: () => { ask: Function, askWithdraw?: Function } | null, nameOf: (modId: string) => string, decide: (modId: string, grant: string, decision: string) => Promise<unknown>,
 *   log?: object, now?: () => number, promptMs?: number }} o
 *   `decide`: the user's decision written (Mod.setPermission's operation); `status`: the runtime's for the mod (`active` while it runs)
 */
export function createPermissionGate(o) {
  const now = o.now ?? Date.now;
  const promptMs = o.promptMs ?? PROMPT_MS;
  const denied = new Map();    // mod id -> grants a Deny keeps from asking again while it runs
  const queues = new Map();    // mod id -> the end of its prompts, one at a time
  const pending = new Map();   // mod id -> Map(token -> grant) of prompts shown or waiting
  const listeners = new Map(); // mod id -> Set of (grant, decision) listeners, while it runs
  const runs = new Map();      // mod id -> which run of it this is: a stop ends the run, and a call held in one is not let through in the next
  let seq = 0;
  const refuse = (m) => new CodexModsError('Denied', m);

  /**
   * The optional grant that would let this call through, when the held grants do not: one decided `ask`, or one allowed since the mod started (from ask to allow takes nothing
   * away, so it is written without a restart, and the mod's own copy lacks it). `test(grants)` says whether a list admits the call.
   */
  function askFor(modId, held, test) {
    const r = o.record(modId);
    if (!r || test(held)) return null;
    return Object.entries(r.decisions ?? {}).filter(([, d]) => d === 'ask' || d === 'allow').map(([g]) => g).find((g) => test([...held, g])) ?? null;
  }

  /** Ask the user, after this mod's earlier prompts; `request`: the mod asked for the grant itself (Allow and Don't allow), else a held call (Allow once too). */
  function prompt(modId, grant, { title, message, request = false } = {}) {
    const run = async () => {
      const r = o.record(modId);
      const d = r?.decisions?.[grant];
      if (d === 'allow') return 'always';
      if (d !== 'ask' && !(request && d === 'deny')) return 'deny';
      if (denied.get(modId)?.has(grant)) return 'deny';
      if (o.status(modId) !== 'active' || o.safeMode()) return 'deny';
      const w = o.windows();
      if (!w?.ask) return 'deny';
      const token = `perm${(++seq).toString(36).padStart(6, '0')}`;
      if (!pending.has(modId)) pending.set(modId, new Map());
      pending.get(modId).set(token, grant);
      const name = o.nameOf(modId);
      let out, timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => { try { w.askWithdraw?.(modId, token); } catch { /* the window went */ } resolve(null); }, promptMs + 1000); timer.unref?.(); });
      try {
        out = await Promise.race([deadline, w.ask({
          requester: { id: modId, name }, subject: { type: 'Mod', provider: 'codexmods.framework', id: modId }, purpose: 'permission',
          title: title ?? `${name} asks to use: ${grant}`, message: message ?? '', until: now() + promptMs, withdraw: token,
          actions: request ? [{ id: 'always', title: 'Allow' }, { id: 'deny', title: 'Don’t allow' }]
            : [{ id: 'once', title: 'Allow once' }, { id: 'always', title: 'Always allow' }, { id: 'deny', title: 'Deny' }],
        })]);
      } catch (e) {
        o.log?.warn?.('permissions: the prompt could not be shown', { modId, message: String(e?.message ?? e) });
        out = null;
      } finally { clearTimeout(timer); pending.get(modId)?.delete(token); }
      const choice = out?.choice;
      if (choice === 'deny') { if (!denied.has(modId)) denied.set(modId, new Set()); denied.get(modId).add(grant); }
      if (choice === 'once' || choice === 'always' || choice === 'deny') return choice;
      return 'unanswered';
    };
    const next = (queues.get(modId) ?? Promise.resolve()).then(run, run);
    queues.set(modId, next.catch(() => {}));
    return next;
  }

  return {
    askFor,
    /**
     * A call under an `ask` grant, held for the user: resolves when it may go on, throws Denied otherwise. Not while the mod starts: an activation cannot wait.
     * @param {string} modId @param {string} grant @param {{ what?: string }} [o2]  `what`: the call in words
     */
    async hold(modId, grant, o2 = {}) {
      const label = o2.what ?? grant;
      if (o.status(modId) !== 'active') throw refuse(`${label} waits for your answer, and ${modId} cannot wait while it starts`);
      const run = runs.get(modId) ?? 0;
      const choice = await prompt(modId, grant, { title: `${o.nameOf(modId)} wants to: ${label}`, message: o2.message ?? `It asks under ${grant}, which you set to ask every time.` });
      // the answer lets the call through only into the run that asked, still running, outside safe mode, with the grant not denied since
      const still = () => o.status(modId) === 'active' && !o.safeMode() && (runs.get(modId) ?? 0) === run && ['ask', 'allow'].includes(o.record(modId)?.decisions?.[grant]);
      if ((choice === 'once' || choice === 'always') && !still()) {
        if (choice === 'always' && o.record(modId)?.decisions?.[grant] === 'ask') await o.decide(modId, grant, 'allow').catch((e) => o.log?.warn?.('permissions: a decision was not written', { modId, grant, message: String(e?.message ?? e) }));
        throw refuse(`${label}: ${modId} stopped, or the permission changed, while it waited for your answer`);
      }
      if (choice === 'once') return;
      if (choice === 'always') {
        if (o.record(modId)?.decisions?.[grant] !== 'allow') await o.decide(modId, grant, 'allow');
        return;
      }
      throw refuse(choice === 'deny' ? `you did not allow ${label}` : `${label} was not answered`);
    },
    /** What a mod holds of one of its grants: `allow`, `ask` or `deny` (a required one is `allow`); throws Invalid for one it does not declare. */
    state(modId, grant, manifest) {
      if ((manifest?.permissions ?? []).includes(grant)) return 'allow';
      if (!(manifest?.optionalPermissions ?? []).includes(grant)) throw new CodexModsError('Invalid', `permissions: ${grant} is not a permission this mod declares`);
      return o.record(modId)?.decisions?.[grant] ?? defaultOf(grant);
    },
    /** The mod asks for one of its optional grants: {granted}. The user's Allow is written as its decision. */
    async request(modId, grant, manifest, text = {}) {
      const st = this.state(modId, grant, manifest);
      if (st === 'allow') return { granted: true };
      if (!enforced(grant)) return { granted: true };
      if (denied.get(modId)?.has(grant)) return { granted: false };
      const choice = await prompt(modId, grant, { request: true, title: text.title ?? `${o.nameOf(modId)} asks to use: ${grant}`, message: [text.subtitle, text.body].filter(Boolean).join('\n\n') });
      if (choice !== 'always') return { granted: false };
      // from ask, nothing is taken away and it runs on: answered once it is written; from deny it starts again to hold it, so it is answered first
      const written = o.decide(modId, grant, 'allow');
      if (st === 'ask') await written;
      else written.catch((e) => o.log?.warn?.('permissions: a decision was not written', { modId, grant, message: String(e?.message ?? e) }));
      return { granted: true };
    },
    /** A decision changed: its prompts waiting end, and a running mod that keeps running hears it. */
    changed(modId, grant, decision) {
      const w = o.windows();
      for (const [token, g] of [...(pending.get(modId) ?? [])]) if (g === grant) { try { w?.askWithdraw?.(modId, token); } catch { /* the window went */ } }
      for (const fn of [...(listeners.get(modId) ?? [])]) { try { fn(grant, decision); } catch { /* the listener's own */ } }
    },
    onChange(modId, fn) {
      if (!listeners.has(modId)) listeners.set(modId, new Set());
      listeners.get(modId).add(fn);
      return { dispose: () => { listeners.get(modId)?.delete(fn); } };
    },
    /** The mod stopped: a Deny of this run is forgotten, and its listeners with it (its questions end with the windows provider's own cancel). */
    ended(modId) { denied.delete(modId); listeners.delete(modId); runs.set(modId, (runs.get(modId) ?? 0) + 1); },
  };
}
