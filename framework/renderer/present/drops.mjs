// Drops (graph-integrity G5.3): the places a mod draws that take what the user drops on them (the lent DropTarget, `accepts` a list of
// concepts, `onDrop({ref})`), and what the user drags there:
// - a row of the framework's (a ChatRow given its chat's ref): the platform's drag, carrying the ref and one type per concept of its
//   type's chain (a drag over a place says only its types, so a place shows it takes the drop before it is made);
// - the app's own chat rows in its sidebar: the app drags them its own way, by the pointer, to its own places (its groups, a chat's
//   composer, which takes a reference). A press on one that moves is followed from the document, and let go over a mod's place that
//   takes a chat it is a drop there; the app's own drag is untouched (nothing is prevented or changed).
// A drop reaches the place's mod only for an instance of a concept it takes; the ref is the instance's own where the page knows it.
// NO NODE API.

export const REF_TYPE = 'application/x-codexmods-ref';
export const CONCEPT_TYPE = 'application/x-codexmods-is-';   // + a type's name, lowercased (the platform lowercases a drag's types)
export const DROP_ATTR = 'data-codexmods-drop';
const APP_ROW = '[data-app-action-sidebar-thread-row]';
const APP_ROW_ID = 'data-app-action-sidebar-thread-id';
const SLOP = 6;   // px the pointer moves before a press on one of the app's rows is a drag
const isRef = (r) => !!r && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';

/**
 * @param {{ doc: () => any, chainOf: (type: string) => string[], thread: (appId: string) => object | null,
 *   subject: (ref: object) => object | null, log?: (m: string, d?: object) => void }} o
 *   `thread`: the ref of the app's chat by the id its sidebar row carries; `subject`: the instance the page knows for a ref
 */
export function createDrops(o) {
  const targets = new Map();   // a place's element -> { accepts: Set<string>, drop({ref}), over(boolean) }
  let doc = null, press = null, over = null;
  const takes = (t, chain) => chain.some((c) => t.accepts.has(c));
  const hostOf = (el) => (el && typeof el.closest === 'function' ? el.closest(`[${DROP_ATTR}]`) : null);
  /** The place under a point that takes an instance of these types (the innermost place there decides), or null. */
  function placeAt(x, y, chain) {
    for (const el of doc?.elementsFromPoint?.(x, y) ?? []) {
      const host = hostOf(el);
      const t = host ? targets.get(host) : null;
      if (t) return takes(t, chain) ? { el: host, t } : null;
    }
    return null;
  }
  const setOver = (next) => {
    if ((over?.el ?? null) === (next?.el ?? null)) return;
    try { over?.t.over(false); } catch { /* the place's own */ }
    over = next;
    try { next?.t.over(true); } catch { /* the place's own */ }
  };
  /** The drop, to the place's mod: the instance's own ref, of a concept it takes. */
  function deliver(t, ref) {
    if (!isRef(ref)) return;
    const inst = o.subject(ref);
    const r = inst && !inst.gone && isRef(inst.ref) ? inst.ref : ref;
    if (!takes(t, o.chainOf(r.type))) return;
    try { t.drop(Object.freeze({ ref: Object.freeze({ type: r.type, provider: r.provider, id: r.id }) })); }
    catch (e) { o.log?.('a drop: the place\'s fault', { message: String(e?.message ?? e) }); }
  }

  // the app's own rows: the pointer's path
  const down = (e) => {
    press = null;
    if (e.button !== 0 || !targets.size) return;
    const row = e.target?.closest?.(APP_ROW);
    const id = row?.getAttribute?.(APP_ROW_ID);
    const ref = typeof id === 'string' ? o.thread(id) : null;
    if (isRef(ref)) press = { ref, x: e.clientX, y: e.clientY, moving: false };
  };
  const move = (e) => {
    if (!press) return;
    if (!press.moving) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP) return;
      press.moving = true;
    }
    setOver(placeAt(e.clientX, e.clientY, o.chainOf(press.ref.type)));
  };
  const up = (e) => {
    const p = press;
    press = null;
    // let go away from where it was pressed: a drag, moves seen or not (an input that jumps the pointer sends none)
    if (!p || (!p.moving && Math.hypot(e.clientX - p.x, e.clientY - p.y) < SLOP)) { setOver(null); return; }
    const at = placeAt(e.clientX, e.clientY, o.chainOf(p.ref.type)) ?? over;
    setOver(null);
    if (at) deliver(at.t, p.ref);
  };
  const cancel = () => { press = null; setOver(null); };
  const key = (e) => { if (e.key === 'Escape' && press) cancel(); };

  // the platform's drags: the framework's rows
  const typesOf = (e) => [...(e.dataTransfer?.types ?? [])].map(String);
  const placeOf = (e) => {
    const types = typesOf(e);
    if (!types.includes(REF_TYPE)) return null;
    const host = hostOf(e.target);
    const t = host ? targets.get(host) : null;
    const is = types.filter((x) => x.startsWith(CONCEPT_TYPE)).map((x) => x.slice(CONCEPT_TYPE.length));
    return t && [...t.accepts].some((a) => is.includes(a.toLowerCase())) ? { el: host, t } : null;
  };
  const dragOver = (e) => {
    const at = placeOf(e);
    if (!at) { if (typesOf(e).includes(REF_TYPE)) setOver(null); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setOver(at);
  };
  const dropped = (e) => {
    const at = placeOf(e);
    if (!at) return;
    e.preventDefault();
    setOver(null);
    let ref;
    try { ref = JSON.parse(e.dataTransfer.getData(REF_TYPE)); } catch { return; }
    deliver(at.t, ref);
  };
  const LISTENERS = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['keydown', key], ['dragover', dragOver], ['drop', dropped], ['dragend', cancel]];
  function listen() {
    if (doc) return;
    doc = o.doc();
    for (const [name, fn] of LISTENERS) doc?.addEventListener?.(name, fn, true);
  }

  return {
    /** A place that takes drops (`accepts`: concepts): `drop({ref})`, `over(true | false)` while one would be taken there. */
    target(el, { accepts, drop, over: onOver }) {
      if (!el) return () => {};
      const list = (Array.isArray(accepts) ? accepts : [accepts]).filter((a) => typeof a === 'string' && a);
      targets.set(el, { accepts: new Set(list), drop, over: typeof onOver === 'function' ? onOver : () => {} });
      el.setAttribute?.(DROP_ATTR, '');
      listen();
      return () => { if (over?.el === el) over = null; targets.delete(el); };
    },
    /** A framework row's drag of its instance: the ref, and its type's concepts for the places it passes over. */
    dragStart(e, ref) {
      if (!isRef(ref) || !e?.dataTransfer) return;
      e.dataTransfer.setData(REF_TYPE, JSON.stringify({ type: ref.type, provider: ref.provider, id: ref.id }));
      for (const t of o.chainOf(ref.type)) e.dataTransfer.setData(`${CONCEPT_TYPE}${t.toLowerCase()}`, '');
      e.dataTransfer.effectAllowed = 'copyLink';
    },
    dispose() {
      for (const [name, fn] of LISTENERS) doc?.removeEventListener?.(name, fn, true);
      doc = null; press = null; over = null;
      targets.clear();
    },
  };
}
