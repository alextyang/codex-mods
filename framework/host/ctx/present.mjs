// ctx.present → the page's own presentation runtime only (docs/design/presentations.md V6): the user's acts held for the mods (§3.5), the
// Request instance behind a request card (by the request id the app saw), the mods' themes and mentions. Mods have no access: the page's
// framework scope only.
import { randomUUID } from 'node:crypto';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { createHeldActions } from '../graph/held-actions.mjs';
import { automationValues } from '../graph/defaults.mjs';

const MAX_IDS = 500;

const FRESH_MS = 10_000;   // how long a page hold waits for its instance read again (a repository's branch)
const USER = Object.freeze({ kind: 'user', id: 'user', owner: 'app' });
// the page's held actions (public-hooks.md §3.5): a new chat's send, a composer's attach (H6m3b), a card's answers, a command the user runs
// in the page (H6m3), the review panel's git actions and a pull request created (H6m4), as `[concept, operation]`
const PAGE_HELD = Object.freeze([['Draft', 'send'], ['Draft', 'attach'], ['Approval', 'answer'], ['Question', 'answer'], ['Command', 'run'],
  ['Repository', 'stage'], ['Repository', 'unstage'], ['Repository', 'discard'], ['Branch', 'openPullRequest']]);
// the operations of the controls the framework draws for an instance, by concept (public-hooks.md §3.15: a mod's Account rows on the
// app's Account page; graph-integrity G2.1, G2.2: the row it draws for a chat the app does not hold, and that chat's view opened, which
// reads it): the user's click on one is the user's own act
const USER_CONTROLS = new Map([['Account', new Set(['signIn', 'signOut'])],
  ['Thread', new Set(['archive', 'restore', 'markRead', 'markUnread', 'delete'])]]);
const changersOf = (call) => (Array.isArray(call?.changers) ? call.changers : []).map((ch) => ({ mod: String(ch.owner).replace(/^mod:/, ''), ...(ch.policy ? { policy: ch.policy.title } : {}) }));

/**
 * @param {{ requests?: () => { refOf(id: string): object | null } | null, graph?: () => object | null,
 *   agent?: () => { mentioned(draftId: string, entry: object): boolean } | null, themes?: () => ReturnType<typeof import('../themes.mjs').createThemes> | null }} o
 */
export function createPresentNs({ requests = () => null, graph = () => null, agent = () => null, themes = () => null, attestations = null }) {
  const framework = (scope) => { if (scope.state.framework !== true) throw new CodexModsError('Denied', 'ctx.present is the framework\'s own'); };
  const held = createHeldActions({ graph });
  /**
   * A ref the page names by what it has (a repository by the folder it acts in, a branch by that folder and its name: H6m4), as the graph
   * lists it; null when it names none.
   */
  const listed = async (ref) => {
    const byFolder = (ref?.type === 'Repository' || ref?.type === 'Branch') && ref.cwd !== undefined;
    try { return { ref: (await requests()?.pageRef?.(ref)) ?? (byFolder ? null : ref) }; } catch (e) {
      // named but not decidable (its repository could not be read, another checkout's): refused, never let through unheld
      return e?.refuse ? { ref: null, refuse: String(e.message) } : { ref: byFolder ? null : ref };
    }
  };
  /** The instance as it is now, read again first where the Host can (a repository's branch: `requests.fresh`), within LOAD_MS: false when it could not be. */
  const freshNow = (ref) => {
    const f = requests()?.fresh;
    if (typeof f !== 'function') return Promise.resolve(null);
    return Promise.race([Promise.resolve().then(() => f(ref)).catch(() => false), new Promise((res) => { const t = setTimeout(() => res(false), FRESH_MS); t.unref?.(); })]);
  };
  return {
    subs: {
      /**
       * What holds the page's own actions now, and what only observes them (`{held, observed}`, `Type.operation` each), then again each
       * time that changes: the page waits on the Host only for an action something holds (otherwise the app's own runs at once, as before).
       */
      /** The mods' themes (public-hooks.md §3.14): which one the user chose and whether it holds the app's settings, then each change. */
      themes(scope, _args, emit) {
        framework(scope);
        const t = themes();
        queueMicrotask(() => emit(t ? t.state() : { active: null }));
        return t ? t.subscribe(emit) : { dispose() {} };
      },
      holds(scope, _args, emit) {
        framework(scope);
        const g = graph();
        if (!g?.appHolds) { queueMicrotask(() => emit({ held: [], observed: [] })); return { dispose() {} }; }
        let said = null;
        const tell = () => { const now = g.appHolds(PAGE_HELD); const s = JSON.stringify(now); if (s === said) return; said = s; emit(now); };
        // after the channel has recorded the subscription (what is emitted before is dropped)
        queueMicrotask(tell);
        const sub = g.onHolds?.(tell);
        return { dispose() { sub?.dispose(); } };
      },
    },
    calls: {
      /**
       * The page minted an attestation of the user's intent for a mod (graph-integrity G7.1): kept for that page, for a call of that mod's
       * to take once within a few seconds. Only the page's own runtime tells it; a call before it is told finds none.
       */
      attest(scope, token, mod) {
        framework(scope);
        return attestations ? attestations.mint(scope.channel ?? null, token, mod) : false;
      },
      /**
       * The user's own action, held in the page before the app's own handler runs (public-hooks.md §3.5: a card's answer, a new chat's
       * send): it passes the interceptors and the policies as the user's. `{go: true, args, token, changedBy?}` (the app's handler runs,
       * with the arguments as they ended; `changedBy` names who changed them, for the page to say), `{go: false, message}` (it does not;
       * the page says why), `{go: false, handled: true}` (a mod did it in the app's place). `opts.changes: false`: the page cannot carry
       * out a change of the arguments, so one is refused. Nothing to hold (no instance, no interceptor, no policy): go. Once the action
       * went, the page says what it did with `done(token, outcome)`.
       */
      async hold(scope, ref0, operation, args, opts) {
        framework(scope);
        const g = graph();
        const named = await listed(ref0);
        if (named.refuse) return { go: false, message: named.refuse };
        const ref = named.ref;
        const a0 = Array.isArray(args) ? args : [];
        // decided on the instance as it is now (a repository's branch, built review H6m4), never on what was read before
        if (g && ref && typeof operation === 'string' && (await freshNow(ref)) === false) return { go: false, message: 'it could not be decided (it could not be read as it is now)' };
        if (!g || !ref || typeof ref !== 'object' || typeof operation !== 'string') return { go: true, args: a0 };
        const token = `ph-${randomUUID()}`;
        const changes = !(opts && typeof opts === 'object' && opts.changes === false);
        let wentWith = null;
        const went = new Promise((resolve) => { wentWith = resolve; });
        const decided = g.interceptApp({ ref, operation, args: a0, caller: USER, origin: 'app' }, (a, call) => {
          const changedBy = changersOf(call);
          if (changedBy.length && !changes) return { status: 'refused', reason: 'unsupported', message: `${changedBy.map((c) => c.mod).join(', ')} would change it, and a change cannot be carried out here` };
          wentWith({ go: true, args: a, token, ...(changedBy.length ? { changedBy } : {}) });
          return held.completion(token);
        }).then((d) => {
          if (d.decision === 'forwarded' && d.outcome?.status !== 'refused') return null;   // it went (answered above)
          if (d.decision === 'release') { held.released(token, { ref, operation, args: a0, caller: USER, origin: 'app' }); return { go: true, args: a0, token }; }
          if (d.decision === 'handled') return { go: false, handled: true, ...(d.outcome?.value != null ? { value: d.outcome.value } : {}) };
          // a mod stopped it (graph-integrity G6.2): the page does not run the app's handler and says nothing; the user keeps their input
          if (d.decision === 'stopped') return { go: false, stopped: true, by: d.outcome?.by?.id ?? null };
          if (d.decision === 'cancelled') return { go: false, message: 'cancelled' };
          const o = d.outcome ?? {};
          return { go: false, message: o.message ?? o.error?.message ?? d.reason ?? 'not allowed' };
        });
        return Promise.race([went, decided.then((r) => r ?? went)]);
      },
      /**
       * The user's click on a control the framework draws for an instance (a mod's Account's Sign in or Sign out, public-hooks.md §3.15; a
       * chat's row or its view, graph-integrity G2.1, G2.2): invoked as the user, through the interceptors and policies as any act of the
       * user's. Only those controls' operations, and never on Codex's own instances (the app draws those). Its outcome.
       */
      async userAct(scope, ref, operation) {
        framework(scope);
        const g = graph();
        if (!g) return { status: 'refused', reason: 'unavailable', message: 'the Host\'s graph is off' };
        const snap = ref && typeof ref === 'object' ? g.resolve(ref) : null;
        if (!snap || snap.gone) return { status: 'refused', reason: 'unavailable', message: 'it is gone' };
        const concept = g.type(snap.ref.type)?.concept ?? snap.ref.type;
        if (snap.ref.provider === 'codex' || !USER_CONTROLS.get(concept)?.has(operation)) return { status: 'refused', reason: 'notAllowed', message: `the framework draws no control for ${snap.ref.type}.${operation}` };
        return g.invoke({ ref: snap.ref, operation, args: [], caller: USER, origin: 'app' });
      },
      /** What a held action did once it went (`hold`'s token): `{status: 'done' | 'failed', error?}`; its record says so. */
      done(scope, token, outcome) { framework(scope); return typeof token === 'string' ? held.done(token, outcome) : false; },
      /** An action nothing held went while a mod observes it (`holds`): what it did, as its record (§3.4). */
      async did(scope, ref0, operation, args, outcome) {
        framework(scope);
        const g = graph();
        const { ref } = await listed(ref0);
        if (!g || !ref || typeof ref !== 'object' || typeof operation !== 'string') return false;
        return g.recordApp({ ref, operation, args: Array.isArray(args) ? args : [], caller: USER, origin: 'app', outcome: outcome && typeof outcome === 'object' ? outcome : null });
      },
      /**
       * A mod's mention picked in one of the page's composers (public-hooks.md §3.14): `{mod, label, context}` for the composer's Draft; the
       * next message from it that still has the mention's text carries the context for the agent (framework/host/agent).
       */
      mentioned(scope, draft, entry) {
        framework(scope);
        if (!draft || typeof draft !== 'object' || draft.type !== 'Draft' || typeof draft.id !== 'string') return false;
        return agent()?.mentioned(draft.id, entry) ?? false;
      },
      /**
       * What the mods' defaults give a new automation (public-hooks.md §3.8), for the app's own create form: one value per field
       * (`name`, `enabled`, `project`, `settings`, `where`, `notifications`, `archiveRuns`), each the first mod's in order that gives it,
       * read on an automation to be that names nothing yet.
       */
      /** The user turns a mod's theme on (its mod and id), or off (`null`): written as the app's appearance settings, or given back. */
      async useTheme(scope, mod, id) {
        framework(scope);
        const t = themes();
        if (!t) return { status: 'refused', reason: 'unavailable', message: 'themes need the Host\'s graph' };
        return mod === null ? t.stop() : t.use(String(mod), String(id));
      },
      automationDefaults(scope) {
        framework(scope);
        const g = graph();
        if (!g || typeof g.defaultsFor !== 'function') return {};
        return automationValues(g.defaultsFor('Automation', { ref: { type: 'Automation', provider: 'codex', id: '(new)' }, state: {}, links: {} }));
      },
      /** {[requestId]: ref | null} for up to 500 pending server request ids, as the app saw them: the Request each stands for (Codex's). */
      requestsOf(scope, ids) {
        framework(scope);
        const r = requests();
        const out = {};
        for (const id of Array.isArray(ids) ? ids.slice(0, MAX_IDS) : []) if (typeof id === 'string') out[id] = r?.refOf(id) ?? null;
        return out;
      },
    },
  };
}
