// ctx.ui's presentation rules on the Host (docs/design/systems.md S6, "E2 in detail"): a mod registers and disposes its rules here, from
// the host realm (static data) or the renderer realm (its functions and components stay in its window); the page's own runtime, under the
// framework scope only, follows every rule as a snapshot and then deltas. The registry (../ui-rules.mjs) checks and orders them. The page's
// runtime also reports its window's presentations here (S10), which the windows provider keeps as graph instances.
import { CodexModsError } from '../../../sdk/errors.mjs';
import { isRef } from '../graph/types.mjs';
import { askFieldsOf } from '../packages/settings.mjs';

const PURPOSE = /^[a-z][a-zA-Z0-9.-]{0,63}$/;
const ACTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const text = (v, max, what) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CodexModsError('Invalid', `ui.ask: ${what} is text of at most ${max} characters`);
  return v;
};
/** A mod's question, checked ("E7 in detail" decision 7): its subject and purpose, title, message, 1 to 3 actions (the first confirms). */
function askSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new CodexModsError('Invalid', 'ui.ask takes {subject, purpose, title, message, actions}');
  if (!isRef(spec.subject)) throw new CodexModsError('Invalid', 'ui.ask: subject is the ref of what it asks about');
  if (typeof spec.purpose !== 'string' || !PURPOSE.test(spec.purpose)) throw new CodexModsError('Invalid', 'ui.ask: purpose is a short name, such as confirm or approve');
  const actions = Array.isArray(spec.actions) ? spec.actions : [];
  if (actions.length < 1 || actions.length > 3) throw new CodexModsError('Invalid', 'ui.ask: 1 to 3 actions, the first the one confirm chooses');
  const seen = new Set();
  const list = actions.map((x) => {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ACTION_ID.test(x.id) || seen.has(x.id)) throw new CodexModsError('Invalid', 'ui.ask: each action has its own id');
    seen.add(x.id);
    return { id: x.id, title: text(x.title, 40, 'an action\'s title') };
  });
  if (spec.until !== undefined && !Number.isFinite(spec.until)) throw new CodexModsError('Invalid', 'ui.ask: until is a time (ms since the epoch)');
  const fields = fieldsOf(spec.fields);
  // `withdraw`: the mod's own token for withdrawing it (its realm's `signal`), never shown
  if (spec.withdraw !== undefined && (typeof spec.withdraw !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(spec.withdraw))) throw new CodexModsError('Invalid', 'ui.ask: withdraw is a token');
  return { subject: { type: spec.subject.type, provider: spec.subject.provider, id: spec.subject.id }, purpose: spec.purpose, title: text(spec.title, 120, 'the title'),
    message: text(spec.message, 2000, 'the message'), actions: list, ...(spec.until !== undefined ? { until: spec.until } : {}), ...(fields.length ? { fields } : {}),
    ...(spec.withdraw !== undefined ? { withdraw: spec.withdraw } : {}) };
}
/**
 * A question's fields (public-hooks.md §3.14; graph-integrity G4.2): settings' declarations, their schema and kinds (`{key, kind, title,
 * default, ...}`, at most 12; a text's `control: 'secret'` masked, with no default), drawn by the settings' own controls. The answer's
 * `values` has one value per field, by its key, of its kind.
 */
const fieldsOf = (fields) => askFieldsOf(fields, 'ui.ask fields');

/**
 * @param {{ rules: () => ReturnType<import('../ui-rules.mjs').createRuleRegistry> | null,
 *   windows?: () => ReturnType<import('../graph/providers/windows/index.mjs').createWindowsSource> | null }} o
 */
/** What a mod's declaration may be asked to do in a window (`inWindow`). */
const IN_WINDOW = new Set(['filter.on', 'filter.off', 'panel.open', 'panel.close']);
const WINDOW_TRIES = 25, WINDOW_EVERY_MS = 200;   // a new window's page asked for a view for this long (5 s) before it has the declaration

export function createUiNs({ rules, windows = () => null, interceptions = null }) {
  const registry = () => {
    const r = rules();
    if (!r) throw new CodexModsError('Unavailable', 'presentation rules are not available');
    return r;
  };
  const who = (scope) => {
    if (scope.state.framework === true) throw new CodexModsError('Denied', 'the page\'s runtime follows the rules; it registers none');
    return { id: scope.state.id, grants: scope.state.grants ?? [], gen: scope.state, realm: scope.realm, window: scope.channel?.identity?.windowId };
  };
  const reporter = (scope) => {
    if (scope.state.framework !== true) throw new CodexModsError('Denied', 'a window\'s presentations are reported by its page\'s runtime');
    const w = windows();
    if (!w) throw new CodexModsError('Unavailable', 'presentation instances are not available (the Host\'s graph is off: flags/graph-off)');
    const id = scope.channel?.identity?.windowId;
    if (!Number.isSafeInteger(id)) throw new CodexModsError('Unavailable', 'this channel has no window');
    return { w, id };
  };
  return {
    calls: {
      register(scope, desc) {
        if (scope.realm === 'process') throw new CodexModsError('Denied', 'a mod process has no presentation rules');
        return registry().register(who(scope), desc);
      },
      dispose(scope, id) { return registry().dispose(who(scope), String(id)); },
      /** The app's own parts of a component (public-hooks.md §3.10), with whether this build draws each. */
      parts(scope, presentation, slot) { return registry().parts(String(presentation), slot === undefined || slot === null ? undefined : String(slot)); },
      /**
       * Do what one of this mod's declarations does in a window (graph-layers.md §3.1): turn a list's filter on or off, open or close a
       * panel view. `window` a Window ref, else the window in front. The page answers whether it did.
       */
      async inWindow(scope, id, op, args, window, reg) {
        const me = who(scope);
        if (!IN_WINDOW.has(op)) throw new CodexModsError('Invalid', `inWindow: ${op} is none of ${[...IN_WINDOW].join(', ')}`);
        const rule = registry().ownRule(me.id, String(id), me.gen, typeof reg === 'string' ? reg : undefined);
        if (!rule) throw new CodexModsError('Unavailable', `no rule ${id} of this mod is registered${typeof reg === 'string' ? ' (as that registration)' : ''}`);
        const w = windows();
        if (!w) throw new CodexModsError('Unavailable', 'windows are not available (the Host\'s graph is off: flags/graph-off)');
        const asked = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const named = window && typeof window === 'object' ? (window.type === 'Window' && window.provider === 'codexmods.windows' && /^\d{1,12}$/.test(String(window.id)) ? Number(window.id) : NaN) : null;
        if (Number.isNaN(named)) throw new CodexModsError('Invalid', 'window is a Window (an env\'s `window`)');
        // a view in its own window (public-hooks.md §3.14): a new window the app's own way (App.openWindow, on the chat it is asked from, or
        // its home), then the view as its tab filling that window's workspace; the window's page has the declaration once its mod's renderer
        // module registered it there (a host-realm one comes with the rules), so it is asked again for a while
        // beside the chat or a window is the right panel's: a view that is not a panel view, or allows only the bottom panel, has neither (and
        // no window is opened for it)
        if (op === 'panel.open' && (asked.placement === 'side' || asked.placement === 'window')) {
          const targets = rule.data?.view?.targets;
          if (rule.presentation !== 'SidePanel' || rule.slot !== 'tabs') return Object.freeze({ status: 'refused', reason: 'unavailable', message: 'that declaration is not a panel view' });
          if (Array.isArray(targets) && !targets.includes('right')) return Object.freeze({ status: 'refused', reason: 'unavailable', message: `this view is the bottom panel's only: it has no ${asked.placement}` });
        }
        if (op === 'panel.open' && asked.placement === 'window') {
          // still this mod's very declaration (its mod not stopped or registered again since): checked before the window is made, and
          // before each ask (H7pl review 1)
          const mine = () => !!registry().ownRule(me.id, String(id), me.gen, typeof reg === 'string' ? reg : undefined);
          // on the chat the window it is asked from shows, when it shows one (the view keeps that chat as its context, and a window the user
          // opens on the home at the same moment is never taken for it: H7pl review 2); else on the app's home
          const from = named ?? await w.frontWindow?.();
          const made = await w.openWindow(Number.isSafeInteger(from) ? w.threadOf?.(from) ?? null : null, null, { exact: true, beforeCreate: mine });
          if (made?.status !== 'done') return made;
          const at = Number(made.value?.id);
          let out = null;
          for (let i = 0; i < WINDOW_TRIES; i++) {
            if (!mine()) return Object.freeze({ status: 'refused', reason: 'unavailable', message: 'its mod stopped or registered the view again' });
            out = await w.declarationAct(at, `${rule.mod}/${rule.id}`, op, { ...asked, placement: 'full' }, rule.realm === 'host' && typeof reg === 'string' ? reg : null);
            // not there yet (its page, its mod's renderer module): asked again; anything else (done, failed, never possible) is the answer
            if (out?.status !== 'refused' || out.reason !== 'unavailable') break;
            await new Promise((r) => { const t = setTimeout(r, WINDOW_EVERY_MS); t.unref?.(); });
          }
          return out?.status === 'done' ? Object.freeze({ ...out, value: made.value }) : out;
        }
        const windowId = named ?? await w.frontWindow();
        if (!Number.isSafeInteger(windowId)) return { status: 'refused', reason: 'unavailable', message: 'no window is open' };
        return w.declarationAct(windowId, `${rule.mod}/${rule.id}`, op, asked, rule.realm === 'host' && typeof reg === 'string' ? reg : null);
      },
      // The page runs a host-realm rule's callback (mod-surfaces.md P1): the user acted on what the rule put; `env` says where (P2).
      callback(scope, key, reg, path, env) {
        if (scope.state.framework !== true) throw new CodexModsError('Denied', 'a rule\'s callbacks are run by the page\'s runtime, for the user');
        if (typeof key !== 'string' || typeof reg !== 'string' || typeof path !== 'string') throw new CodexModsError('Invalid', 'callback(key, reg, path, env)');
        return registry().callback(key, reg, path, env);
      },
      // The window's presentations (S10, "E2c in detail"), from the page's own runtime only: a generation per page load, its deltas, and
      // its user actions apart from them, in order.
      // The window's id comes back with the generation: the page names its presentations and its window in an action's env (P2).
      window(scope) { const { w, id } = reporter(scope); return { gen: w.open(id, scope.channel), windowId: id }; },
      report(scope, gen, batch) { const { w, id } = reporter(scope); return w.report(id, gen, batch); },
      acted(scope, gen, events) { const { w, id } = reporter(scope); return w.acted(id, gen, events); },
      // The page's answer to an act the windows provider sent it ("E7 in detail" decision 3): for its own window only.
      answer(scope, gen, actId, outcome) { const { w, id } = reporter(scope); return w.answer(id, gen, actId, outcome); },
      // A mod asks the user (decision 7): in the window they are in, named as the mod by the framework; settled once ({choice, by} or
      // {cancelled, by, reason}). The page's end of it comes back by `askAnswer`, for its own window only.
      ask(scope, spec) {
        if (scope.state.framework === true) throw new CodexModsError('Denied', 'the page\'s runtime shows questions; it asks none');
        const w = windows();
        if (!w) throw new CodexModsError('Unavailable', 'asking needs the windows provider (the Host\'s graph is off: flags/graph-off)');
        const name = scope.state.mod?.manifest?.name;
        // asked during one of this mod's interceptions (`call.ask`): the question ends with that call
        let during;
        if (spec && spec.during !== undefined) {
          if (typeof spec.during !== 'string' || !interceptions || interceptions.stateOf(spec.during) !== scope.state) throw new CodexModsError('Invalid', 'ui.ask: during names a call this mod is intercepting');
          during = (fn) => interceptions.onEnd(spec.during, fn);
        }
        const asked = w.ask({ requester: { id: scope.state.id, name: typeof name === 'string' && name ? name.slice(0, 80) : scope.state.id }, ...askSpec(spec), ...(during ? { during } : {}) });
        // the user's intent the answer carries is for a call from the page only (graph-integrity G7.4): a host-realm asker does not get it
        if (scope.realm === 'renderer') return asked;
        return Promise.resolve(asked).then((r) => {
          if (!r || typeof r !== 'object' || typeof r.result?.asUser !== 'string' && typeof r.asUser !== 'string') return r;
          const strip = (x) => { if (!x || typeof x !== 'object') return x; const { asUser: _drop, ...rest } = x; void _drop; return rest; };
          return r.result ? { ...r, result: strip(r.result) } : strip(r);
        });
      },
      askAnswer(scope, gen, askId, outcome) { const { w, id } = reporter(scope); return w.askAnswer(id, gen, askId, outcome); },
      /** A mod withdraws its question (its `signal` aborted): cancelled, by the requester. */
      askWithdraw(scope, token) { return windows()?.askWithdraw?.(scope.state.id, String(token)) ?? false; },
      // A mod's notification (public-hooks.md §3.14), named as the mod by the framework: its id; it ends with notifyEnd, the mod stopping, or
      // the user. The page's end of a toast comes back by `noticeAnswer`, for its own window only.
      notify(scope, spec) {
        if (scope.state.framework === true) throw new CodexModsError('Denied', 'the page\'s runtime shows notifications; it sends none');
        const w = windows();
        if (!w?.notify) throw new CodexModsError('Unavailable', 'notifications need the windows provider (the Host\'s graph is off: flags/graph-off)');
        const name = scope.state.mod?.manifest?.name;
        return w.notify({ id: scope.state.id, name: typeof name === 'string' && name ? name.slice(0, 80) : scope.state.id }, spec);
      },
      notifyEnd(scope, noticeId, token) { return windows()?.notifyEnd?.(scope.state.id, String(noticeId), typeof token === 'string' ? token : undefined) ?? false; },
      noticeAnswer(scope, gen, noticeId, outcome) { const { w, id } = reporter(scope); return w.noticeAnswer(id, gen, noticeId, outcome); },
    },
    handlers: {
      /** A host-realm rule's callbacks, in its mod's worker (P1): bound by rule id, before the rule itself is registered. */
      callbacks(scope, [id, reg], invoke) {
        if (scope.realm !== 'host') throw new CodexModsError('Denied', 'only the host realm serves a rule\'s callbacks');
        return registry().bindCallbacks(who(scope), id, reg, (args, deadlineMs) => invoke(args, deadlineMs));
      },
    },
    subs: {
      /**
       * The framework scope's view of every rule: {t:'snapshot', rules}, then {t:'put', rule} and {t:'remove', key}. The snapshot goes once
       * the channel has registered the subscription (an event before that is dropped), with the deltas from then on: the snapshot taken
       * then holds whatever changed in between.
       */
      rules(scope, args, emit) {
        if (scope.state.framework !== true) throw new CodexModsError('Denied', 'the rules are the page runtime\'s to follow');
        const r = registry();
        let sub = null, done = false;
        queueMicrotask(() => {
          if (done) return;
          emit({ t: 'snapshot', rules: r.snapshot() });
          sub = r.subscribe((d) => emit(d));
        });
        return { dispose() { done = true; sub?.dispose(); } };
      },
      /** What the user did with this mod's notifications: `{id, action, window?}` (an action chosen), `{id, gone: true}` (it went). */
      notices(scope, args, emit) {
        if (scope.state.framework === true) throw new CodexModsError('Denied', 'the page\'s runtime sends no notifications');
        const w = windows();
        return w?.onNotices ? w.onNotices(scope.state.id, (e) => emit(e)) : { dispose() {} };
      },
    },
  };
}
