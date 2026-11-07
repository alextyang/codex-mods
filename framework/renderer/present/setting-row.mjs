// The kit's SettingRow (graph-integrity G3.6): a Setting drawn with the framework's own controls, its reset, its notes and its errors, as
// the framework's settings pages draw it, in a mod's own surface. The mod whose surface it is reads and sets it: its own settings it sets,
// another mod's only as the user (D1, G7: a mod alone is refused, and the row says so). `setting` is a Setting (a snapshot, or its ref), or
// one of the mod's own settings by its key, at the app, a project or a chat: `{key, project?, thread?}`. A chat's or a project's instance is
// the one of its `settings` the mod defined with that key (contributed when that relation is read, G3.4): no id names it. NO NODE API.
import { attestNow } from './attest.mjs';
import { createSettingControls, lowerFirst } from './setting-controls.mjs';
import { createModMedia } from './mod-media.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRef = (r) => isObj(r) && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';
const sameRef = (a, b) => isRef(a) && isRef(b) && a.provider === b.provider && a.id === b.id;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {{ R: () => object, kit: object, exports: () => object, modId: string, graph: () => object | undefined }} o
 *   `graph`: the mod's own renderer graph (subscribe and invoke as the mod)
 */
export function createSettingRow(o) {
  /** What the row follows: an instance, a chat's or a project's settings, or the mod's app-scope settings of that key. */
  function queryOf(setting) {
    if (isObj(setting) && typeof setting.key === 'string' && !isRef(setting.ref) && !isRef(setting)) {
      const at = setting.thread ?? setting.project ?? null;
      if (at !== null && !isRef(at)) return null;
      return { by: setting.key, query: at ? { ref: at, relation: 'settings' } : { type: 'Setting', where: { scope: 'app', key: setting.key } } };
    }
    const ref = isRef(setting?.ref) ? setting.ref : isRef(setting) ? setting : null;
    return ref ? { ref, query: { ref } } : null;
  }

  function SettingRow({ setting }) {
    const R = o.R();
    const e = R.createElement;
    const controls = controlsOf(R);
    const g = o.graph();
    const q = queryOf(setting);
    const key = JSON.stringify(q?.query ?? null);
    const [items, setItems] = R.useState(() => (isObj(setting?.state) && isRef(setting?.ref) ? [setting] : []));
    const [error, setError] = R.useState(null);
    const [busy, setBusy] = R.useState(false);
    R.useEffect(() => {
      if (!q || typeof g?.subscribe !== 'function') return undefined;
      let list = new Map();
      const k = (r) => `${r.provider}\u001f${r.id}`;
      let sub = null;
      try {
        sub = g.subscribe(q.query, (m) => {
          if (!m) return;
          if (m.type === 'snapshot') list = new Map((m.items ?? []).filter((x) => x && !x.gone && x.ref).map((x) => [k(x.ref), x]));
          else if (m.type === 'delta' && m.event?.ref && m.event.kind !== 'event') {
            if (m.event.kind === 'removed') list.delete(k(m.event.ref)); else if (m.event.instance) list.set(k(m.event.ref), m.event.instance);
          } else return;
          setItems([...list.values()]);
        });
      } catch (err) { setError(String(err?.message ?? err)); }
      return () => sub?.dispose?.();
    }, [key]);
    if (!q) return null;
    // the mod's own setting of that key: the Mod that defined it is this mod
    const mine = (x) => x?.links?.definedBy?.type === 'Mod' && x.links.definedBy.id === o.modId && x.state?.key === q.by;
    const inst = q.by !== undefined ? items.find(mine) ?? null : items.find((x) => sameRef(x.ref, q.ref)) ?? null;
    o.kit.ensureStyle?.();
    if (!inst) return e('div', { className: 'cmk-setting', 'aria-busy': true }, e('div', { className: 'cmk-setting-row' }, e('span', { className: 'text-secondary' }, '…')));
    const s = inst.state ?? {};
    if (s.active === false) return null;   // what it requires does not hold here (framework-ui.md F7)
    const label = String(s.title ?? s.key ?? inst.ref.id);
    const write = async (op, args) => {
      if (op === 'set' && same(args[0], s.value) && s.overridden) return;
      // the user's own input (still being dispatched: nothing awaited yet): set as the user through this mod (graph-integrity G7.1; D1:
      // another mod's setting only so)
      const asUser = attestNow(o.modId);
      setBusy(true); setError(null);
      try {
        const out = await g.invoke(inst.ref, op, args, ...(asUser ? [{ asUser }] : []));
        if (out && out.status && out.status !== 'done') setError(out.error?.message ?? out.message ?? 'Not changed');
      } catch (err) { setError(String(err?.message ?? err)); } finally { setBusy(false); }
    };
    const control = controls.control({ s, label, disabled: busy, write: (v) => write('set', [v]), onError: setError, definedBy: inst.links?.definedBy ?? null });
    const reset = s.overridden ? e('button', { key: 'reset', type: 'button', className: 'cmk-more cmk-setting-reset', 'aria-label': `Reset ${lowerFirst(label)}`, title: 'Reset', disabled: busy, onClick: () => write('reset', []) }, e(o.kit.Glyph, { name: 'undo' })) : null;
    const changed = !same(s.value, s.default);
    const stacked = controls.stacked(s);
    return e('div', { className: 'cmk-setting', 'data-setting': inst.ref.id },
      e('div', { className: 'cmk-setting-row' },
        e('div', { className: 'cmk-setting-lead' },
          e('div', { className: 'cmk-setting-text' },
            e('div', { className: 'cmk-setting-title' }, label, changed ? e('span', { className: 'cmk-changed', role: 'img', title: 'Changed', 'aria-label': 'Changed' }) : null),
            s.description ? e('div', { className: 'cmk-setting-description' }, s.description) : null,
            error ? e('div', { className: 'cmk-setting-error', role: 'alert' }, error) : null)),
        e('div', { className: 'cmk-setting-control' }, reset, stacked ? null : control)),
      stacked ? e('div', { className: 'cmk-setting-stacked' }, control) : null);
  }

  // its controls, made with the app's React on the first draw (the page has it by then)
  let made = null;
  const controlsOf = (R) => {
    if (made?.R === R) return made.controls;
    const { useImage } = createModMedia({ R, kit: o.kit, invoke: (ref, op, args) => o.graph()?.invoke(ref, op, args) });
    made = { R, controls: createSettingControls({ R, kit: o.kit, exports: o.exports, useImage }) };
    return made.controls;
  };
  return SettingRow;
}
