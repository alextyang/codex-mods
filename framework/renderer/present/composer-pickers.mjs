// The mods' thread-scope settings in a chat's composer (docs/design/systems.md S15, "E3 in detail"): one picker per thread-scope setting
// of an enabled mod, after the app's own (the composer's `pickers` slot), in the mods' order then their declaration order, within a budget
// of three. A picker shows the setting's effective value for the thread and its choices (a toggle as two); choosing one is Setting.set on
// the thread's instance (the one of the chat's `settings` with the setting's definer and key: the framework's provider contributes it when
// the relation is read, graph-integrity G3.4), and a thread that has its own value goes back to the inherited one from the same menu
// (Setting.reset). The app's composers are its own chats': a mod's chat has its own composer in its own view (G2.2), with the pickers it
// takes from its settings. Drawn with the app's own composer dropdown where the build exposes it (`ComposerDropdown`), else with the app's
// Menu, its parts and its Button. NO NODE API.
import { createReport } from './reports.mjs';
import { choiceValue } from './setting-controls.mjs';

export const BUDGET = 3;
const P = 'codexmods.framework';
const FRAMEWORK = Object.freeze({ type: 'CodexMods', provider: P, id: 'codexmods' });
const label = (s, value) => {
  if (s.kind === 'toggle') return value === true ? 'On' : 'Off';
  return (s.choices ?? []).find((c) => JSON.stringify(choiceValue(c)) === JSON.stringify(value))?.label ?? String(value);
};

const sameThread = (a, b) => !!a && !!b && a.provider === b.provider && a.id === b.id;
/** A Setting that names this chat (its `thread`). */
const namesThread = (x, thread) => !!x && !x.gone && sameThread(x.links?.thread, thread);
const sameRef = (a, b) => !!a && !!b && a.type === b.type && a.provider === b.provider && a.id === b.id;
/** A chat's instance of a setting: the one of its settings with the same definer and key, of the same provider (G3.3; no id names it). */
export const scopedOf = (threadSettings, setting) => threadSettings.find((y) => y.ref.provider === setting.ref.provider && y.ref.id !== setting.ref.id
  && typeof y.state?.key === 'string' && y.state.key === setting.state?.key && sameRef(y.links?.definedBy, setting.links?.definedBy)) ?? null;

/** The thread-scope settings the composer shows, in order, within the budget; `over`: the ones left out. */
export function pickersOf(settings, mods, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  const enabled = new Set(mods.filter((m) => m && !m.gone && m.state?.status === 'enabled').map((m) => m.ref.id));
  const list = settings
    // eslint-disable-next-line codexmods/no-provider-identity -- the framework's own settings (mods' settings)
    .filter((x) => x && !x.gone && x.ref.provider === P && x.state?.scope === 'app' && Array.isArray(x.state.scopes) && x.state.scopes.includes('thread')
      && (x.state.kind === 'choice' || x.state.kind === 'toggle') && enabled.has(x.links?.definedBy?.id))
    .map((x, i) => ({ x, i, r: rank.get(x.links.definedBy.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((y) => y.x);
  return { shown: list.slice(0, BUDGET), over: list.slice(BUDGET) };
}

/**
 * @param {{ R: object, ctx: object, exports: () => object }} o  `ctx`: the presentation runtime's (subject, use, view, invoke)
 */
export function createComposerPickers(o) {
  const { R, ctx } = o;
  const e = R.createElement;
  const Report = createReport(R, ctx);

  /** The mods' setting definitions (the framework's app-scope Settings, defined by a Mod: a collection view of those only, kept while a composer is mounted). */
  function useSettings() {
    const [items, setItems] = R.useState([]);
    R.useEffect(() => {
      let list = new Map();
      const sub = ctx.view({ type: 'Setting', where: { scope: 'app' }, depth: 'core' }, (m) => {
        if (!m) return;
        // eslint-disable-next-line codexmods/no-provider-identity -- the framework's own settings (mods' settings)
        if (m.type === 'snapshot') list = new Map((m.items ?? []).filter((x) => x.ref.provider === P).map((x) => [x.ref.id, x]));
        // eslint-disable-next-line codexmods/no-provider-identity -- the framework's own settings (mods' settings)
        else if (m.type === 'delta' && m.event?.ref?.provider === P) {
          if (m.event.kind === 'removed') list.delete(m.event.ref.id); else if (m.event.instance) list.set(m.event.ref.id, m.event.instance);
        } else return;
        setItems([...list.values()]);
      });
      return () => sub.dispose();
    }, []);
    return items;
  }

  /**
   * A chat's Settings: its `settings` relation, followed while its composer is mounted (one that stops naming it goes): its instances of
   * the mods' settings (contributed when the relation is read).
   */
  function useThreadSettings(thread) {
    const [items, setItems] = R.useState([]);
    const key = thread ? `${thread.provider}\u001f${thread.type}\u001f${thread.id}` : null;
    R.useEffect(() => {
      if (!key) { setItems([]); return undefined; }
      let list = new Map();
      const k = (r) => `${r.provider}\u001f${r.type}\u001f${r.id}`;
      let sub = null;
      try {
        sub = ctx.view({ ref: thread, relation: 'settings' }, (m) => {
          if (!m) return;
          if (m.type === 'snapshot') list = new Map((m.items ?? []).filter((x) => namesThread(x, thread)).map((x) => [k(x.ref), x]));
          // the chat's own named events reach this view too (a status change): they say nothing of its Settings (H7ps review 2)
          else if (m.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
            if (m.event.kind === 'removed' || !namesThread(m.event.instance, thread)) { if (!list.delete(k(m.event.ref))) return; } else list.set(k(m.event.ref), m.event.instance);
          } else return;
          setItems([...list.values()]);
        });
      } catch (err) { ctx.log?.('a chat\'s settings cannot be followed', { message: String(err?.message ?? err) }); }
      return () => sub?.dispose();
    }, [key]);
    return items;
  }

  /** One picker: the thread's instance of a mod's setting (`scoped`, once contributed). */
  function Picker({ setting, thread, scoped = null }) {
    const ex = o.exports() ?? {};
    const [open, setOpen] = R.useState(false);
    const [busy, setBusy] = R.useState(false);
    const inst = scoped;
    const id = (inst ?? setting).ref.id;
    const s = (inst && !inst.gone ? inst : setting).state ?? {};
    if (s.active === false) return null;   // what it requires does not hold in this chat (framework-ui.md F7)
    const value = s.value;
    const act = async (op, args) => {
      setOpen(false);
      if (!inst || inst.gone) return;
      if (op === 'set' && JSON.stringify(args[0]) === JSON.stringify(value) && s.overridden) return;
      setBusy(true);
      try {
        const out = await ctx.invoke(inst.ref, op, args);
        if (out?.status && out.status !== 'done') ctx.log?.('a setting was not changed', { id, out });
      } catch (err) { ctx.log?.('a setting was not changed', { id, message: String(err?.message ?? err) }); } finally { setBusy(false); }
    };
    const choices = s.kind === 'toggle' ? [{ id: 'true', label: 'On', value: true }, { id: 'false', label: 'Off', value: false }] : (s.choices ?? []);
    const Item = ex.MenuParts?.Item;
    if (!Item) return null;
    // a choice's value is its `value`, or its id (graph Setting card)
    const items = [
      ...choices.map((c) => e(Item, { key: c.id, disabled: busy, onClick: () => act('set', [choiceValue(c)]) }, JSON.stringify(choiceValue(c)) === JSON.stringify(value) ? `✓ ${c.label}` : c.label)),
      ...(s.overridden === true ? [e(Item, { key: 'reset', disabled: busy, onClick: () => act('reset', []) }, 'Use the default')] : []),
    ];
    const title = String(setting.state?.title ?? '');
    const valueLabel = label(s, value);
    const shown = `${title}: ${valueLabel}`;
    // reported as a ComposerPicker of the thread's composer (E6.5), whose subject is the thread's Draft (the app's own chat's)
    const reported = (picker) => e(R.Fragment, null, picker, e(Report, { type: 'ComposerPicker', subject: (inst ?? setting).ref,
      place: { in: 'Composer', on: { type: 'Draft', provider: thread.provider, id: thread.id }, slot: 'pickers' } }));
    if (ex.ComposerDropdown) {
      return reported(e(ex.ComposerDropdown, { 'aria-label': title, value: valueLabel, menuOpen: open, onOpenChange: setOpen, tooltipContent: s.description ?? title, disabled: busy }, ...items));
    }
    if (!ex.Menu || !ex.Button) return null;
    return reported(e(ex.Menu, { open, onOpenChange: setOpen, triggerButton: e(ex.Button, { color: 'ghost', 'aria-label': title, disabled: busy }, shown) }, ...items));
  }

  /** The pickers of a thread's composer. */
  function Pickers({ thread }) {
    const settings = useSettings();
    const threadSettings = useThreadSettings(thread);
    const fw = ctx.use(() => ctx.subject(FRAMEWORK));
    const order = (fw && !fw.gone ? fw.links?.mods ?? [] : []).map((r) => r.id);
    const mods = ctx.use(() => order.map((id) => ctx.subject({ type: 'Mod', provider: P, id })).filter(Boolean));
    const shown = pickersOf(settings, mods, order).shown;
    if (!shown.length) return null;
    return e(R.Fragment, null, ...shown.map((x) => e(Picker, { key: x.ref.id, setting: x, thread, scoped: scopedOf(threadSettings, x) })));
  }

  // One element per thread (and per node the app passes there), so the composer's own caches keep theirs.
  const cache = new Map();
  return {
    Pickers,
    /** The node for the composer's pickers slot: the app's own first, then the mods'. */
    nodeFor(thread, appNode) {
      const k = `${thread.provider}\u001f${thread.id}`;
      let c = cache.get(k);
      if (!c || c.app !== appNode) {
        c = { app: appNode, el: e(R.Fragment, null, appNode ?? null, e(Pickers, { key: 'codexmods-pickers', thread })) };
        cache.set(k, c);
        if (cache.size > 50) cache.delete(cache.keys().next().value);
      }
      return c.el;
    },
  };
}
