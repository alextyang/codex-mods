// The menu bar's mod entries, the Host's side (docs/design/mod-surfaces.md §3.4, E8.4). A mod's entry is an `add` rule on Menu for the App
// (`ui.menus.add`): the registry keeps it like every rule (its grant, order, lifetime). This module projects the bar's rules, in rule order,
// to framework-main's `menus` area whenever they change, and runs the entry the user chose: a host-realm entry's callback in the mod's
// worker (the registry's `callback`, its registration's token checked), a renderer-realm one in the page of the window it was chosen in
// (the page holds its function). Node built-ins only.

/** Is this rule a menu bar entry? */
export const isBarRule = (r) => !!r && r.kind === 'add' && r.presentation === 'Menu' && r.for === 'App' && r.slot === 'groups';
const APP = Object.freeze({ type: 'App', provider: 'codex', id: 'codex' });
/** A renderer rule's registrations as an entry carries them (`window:token,...`): each window's own, when the menu was built. */
const regsSaid = (regs) => (regs && typeof regs === 'object' ? Object.entries(regs).map(([w, t]) => `${w}:${t}`).sort().join(',') : null);
/** The token a renderer entry's choice names for the window it was chosen in, as the menu it was chosen from was built. */
const regIn = (said, windowId) => {
  if (typeof said !== 'string') return null;
  const hit = said.split(',').find((x) => x.startsWith(`${windowId}:`));
  return hit ? hit.slice(String(windowId).length + 1) : null;
};

/**
 * @param {{ rules: ReturnType<import('./ui-rules.mjs').createRuleRegistry>, mainOps: { op(area: string, op: string, args?: object): Promise<object>,
 *   onReport(area: string, fn: (report: object) => void): { dispose(): void } }, windows?: () => { runRule?(windowId: number, msg: object): Promise<object> } | null,
 *   log?: object, schedule?: (fn: () => void, ms: number) => unknown }} o
 */
export function createMenuBar(o) {
  const log = o.log ?? { warn() {}, info() {} };
  const schedule = o.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  let timer = null, disposed = false, last = null;

  /** The bar's entries in rule order: each item of each rule, as framework-main takes it (its data, never a function). */
  function entries() {
    const out = [];
    const list = o.rules.snapshot().filter(isBarRule).sort((a, b) => a.order - b.order || `${a.mod}/${a.id}`.localeCompare(`${b.mod}/${b.id}`));
    for (const r of list) {
      (Array.isArray(r.data?.items) ? r.data.items : []).forEach((it, i) => {
        if (!it || typeof it !== 'object' || it.in === undefined) return;
        const { run: _run, layout: _layout, ...item } = it;
        out.push({ key: `${r.mod}/${r.id}`, reg: r.realm === 'host' ? r.reg ?? null : regsSaid(r.regs), mod: r.mod, realm: r.realm, path: r.realm === 'host' ? `items.${i}.run` : 'menuRun', item });
      });
    }
    return out;
  }
  async function push() {
    timer = null;
    if (disposed) return;
    const list = entries();
    const said = JSON.stringify(list);
    if (said === last) return;
    last = said;
    const r = await o.mainOps.op('menus', 'set', { entries: list });
    if (!r.ok) { last = null; if (!r.refused) log.warn('menu bar: the entries were not installed', { error: r.error }); }
  }
  const later = () => { if (!timer && !disposed) timer = schedule(push, 50); };

  /** The entry the user chose: its rule as it is now, run where its function is. */
  async function choose(m) {
    if (!m || typeof m.key !== 'string') return;
    const r = o.rules.snapshot().find((x) => `${x.mod}/${x.id}` === m.key);
    if (!isBarRule(r)) return;   // gone since the menu was built: a late choice is nothing
    const env = Object.freeze({
      subject: APP, _presentation: null, window: Number.isSafeInteger(m.windowId) ? { type: 'Window', provider: 'codexmods.windows', id: String(m.windowId) } : null,
      pane: null, thread: null, draft: null, via: m.via === 'keys' ? 'keys' : 'menu', ...(typeof m.checked === 'boolean' ? { checked: m.checked } : {}),
    });
    // a named layout's entry (ui.layouts.add's keys): the user picks a layout of that mod's own, the framework's to do, in the window it was chosen in: that very entry, as the menu was built (a late choice from an older one is nothing)
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    const chosen = m.path === 'menuRun' ? items[0] : items[Number(/^items\.(\d+)\.run$/.exec(String(m.path))?.[1])];
    if (typeof chosen?.layout === 'string') {
      const current = r.realm === 'host' ? m.reg === (r.reg ?? null) : regIn(m.reg, m.windowId) === regIn(regsSaid(r.regs), m.windowId);
      const pick = chosen.layout;
      const out = current && pick.startsWith(`${r.mod}/`) && Number.isSafeInteger(m.windowId) ? await o.windows?.()?.pickLayout?.(m.windowId, pick) : null;
      if (out?.status !== 'done') log.info('menu bar: the layout was not picked', { rule: m.key, why: out?.message ?? out?.error?.message ?? 'no window picks it' });
      return;
    }
    if (r.realm === 'host') {
      try { await o.rules.callback(m.key, m.reg, m.path, env); } catch (e) { log.warn('menu bar: an entry failed', { rule: m.key, message: String(e?.message ?? e) }); }
      return;
    }
    // the window's registration the menu was built from goes along: a late choice never runs a replacement's function (review 4, round 2)
    const w = o.windows?.();
    const out = Number.isSafeInteger(m.windowId) && w?.runRule ? await w.runRule(m.windowId, { key: m.key, reg: regIn(m.reg, m.windowId), path: 'menuRun', env }) : null;
    if (out?.status !== 'done') log.info('menu bar: the entry did not run', { rule: m.key, why: out?.message ?? out?.error?.message ?? 'no window runs it' });
  }

  const sub = o.rules.subscribe((d) => { if (d.t === 'remove' || isBarRule(d.rule)) later(); });
  const reports = o.mainOps.onReport('menus', (report) => {
    if (report?.event === 'choose') choose(report);
    else if (report?.event === 'shortcuts' && Array.isArray(report.results)) {
      for (const x of report.results) if (x && x.held === false) log.info('menu bar: a mod\'s key chord is held by another', { rule: x.key, keys: x.keys, by: x.conflict });
    }
  });
  later();
  return {
    /** framework-main came back (a restart of the app's main side): install the entries again. */
    resend() { last = null; later(); },
    entries,
    dispose() { disposed = true; sub.dispose(); reports?.dispose?.(); },
  };
}
