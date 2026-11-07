// The user's own actions in the page that the framework holds or observes (docs/design/public-hooks.md §3.4, §3.5: a card's answers, a
// new chat's send). The Host says which operations something holds now and which a mod only observes (`Type.operation` each); an action
// neither holds nor observes is the app's own handler, at once, its return kept, as before any mod existed. A held one waits for the Host;
// an observed one runs at once and is reported after. Either way the Host is told what it did (the mods' `after` records).

const settle = async (r) => { try { await r; return { status: 'done' }; } catch (e) { return { status: 'failed', error: { message: String(e?.message ?? e) } }; } };
const tell = (p) => { void Promise.resolve(p).catch(() => {}); };

/**
 * @param {{ hold?: Function, done?: Function, did?: Function, holds?: (fn: (m: object) => void) => { dispose(): void } } | undefined} present
 *   the page's ctx.present (the Host's hold of the user's own actions)
 */
export function createUserActions(present) {
  let now = { held: new Set(), observed: new Set() };
  const sub = typeof present?.holds === 'function'
    ? present.holds((m) => { now = { held: new Set(Array.isArray(m?.held) ? m.held : []), observed: new Set(Array.isArray(m?.observed) ? m.observed : []) }; }) : null;
  /**
   * The user's action `operation` on `ref` (its arguments `args`), carried out by the app's own handler `fn()`. While something holds it,
   * the Host decides first: refused (or done by a mod in the app's place), it does not run; let through, it runs, with its arguments as
   * they ended through `carry(args)` when a mod changed them (no `carry`: the page cannot carry a change out, and the Host refuses one).
   * `said(answer)` hears the Host's answer (`{go, message?, handled?, changedBy?}`), for the page to say where it happened. Returns what
   * `fn()` returns when nothing holds it.
   */
  function userAction(ref, operation, args, fn, { carry = null, said = () => {} } = {}) {
    const key = `${ref?.type}.${operation}`;
    if (!now.held.has(key) || typeof present?.hold !== 'function') {
      const r = fn();
      if (now.observed.has(key) && typeof present?.did === 'function') void settle(r).then((outcome) => tell(present.did(ref, operation, args, outcome)));
      return r;
    }
    void present.hold(ref, operation, args, { changes: typeof carry === 'function' }).then((h) => {
      said(h ?? {});
      if (!h || h.go === false) return;
      const changed = typeof carry === 'function' && JSON.stringify(h.args ?? args) !== JSON.stringify(args);
      let r;
      try { r = changed ? carry(h.args) : fn(); } catch (e) {
        if (h.token) tell(present.done?.(h.token, { status: 'failed', error: { message: String(e?.message ?? e) } }));
        return;
      }
      if (h.token) void settle(r).then((outcome) => tell(present.done?.(h.token, outcome)));
    }, () => fn());   // the Host cannot hold it now (it went, and its mods with it): the app's own goes on, as an unheld one does
    return undefined;
  }
  return { userAction, dispose() { try { sub?.dispose(); } catch { /* gone */ } } };
}
