// The DetailView (docs/design/systems.md S11, E6.6c): one generic page of the framework that shows any graph instance, reached from a
// Feature on a mod's page, from another DetailView's relations, or from Window.open(ref) of an instance the app has no page for: its
// summary, its state, its relations as links. Its buttons are the operations of its type that take no arguments (those that take some are
// listed, not offered), each asked first in a Dialog (which of them cannot be undone is not known here); not a form engine. A
// framework-owned instance has no buttons here: it links to its own page (a Mod to its page,
// an Operation to the activity, the CopyUpdate to the update's review), so every lifecycle action keeps its Dialog. NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { text } from './mods-text.mjs';
import { createReport } from './reports.mjs';

/** The framework's provider: its instances are opened on their own pages. */
export const FRAMEWORK_PROVIDER = 'codexmods.framework';
/** At most this many instances of a relation are listed. */
export const RELATED = 10;
const MAX_VALUE = 160;

/** A state value as one line. */
export function shown(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
}
const isRef = (r) => Boolean(r) && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';

/**
 * @param {{ R: object, ctx: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>,
 *   typeOf: (typeId: string) => object | null, observe: (ref: object) => { dispose(): void },
 *   current: () => object | null, show: (ref: object) => void, ownPage: (ref: object) => string | null, openOwn: (ref: object) => void,
 *   dialogs: { ModsDialog: Function } }} o
 *   `typeOf`: the graph's reflection of a type (members merged along its chain); `current`: the instance shown (read with ctx.local);
 *   `show`: show another instance here; `ownPage`: a framework-owned instance's own page, or null (a Feature has none); `openOwn`: open it
 */
export function createDetailView(o) {
  const { R, ctx } = o;
  const e = R.createElement;
  const Report = createReport(R, ctx);

  function DetailPage() {
    const ex = o.exports() ?? {};
    const { SettingsPageFrame: Frame, SettingsRow: Row } = ex;
    const acting = useActing(R, o.invoke);
    const [asking, setAsking] = R.useState(null);   // { ref, name, title }: the operation asked about, on the instance it was asked for
    const ref = ctx.use(() => o.current());
    const key = ref ? `${ref.type}\u001f${ref.provider}\u001f${ref.id}` : '';
    R.useEffect(() => { if (!ref) return undefined; const v = o.observe(ref); return () => v.dispose(); }, [key]);
    // another instance shown: a confirmation asked about the one before goes (E6 review: it never runs on another)
    R.useEffect(() => { setAsking(null); }, [key]);
    const inst = ctx.use(() => (ref ? ctx.subject(ref) ?? null : null));
    const { value, button, lines, section } = pageParts(R, ex);
    if (!ref) return e(Frame, { title: 'Details' }, section('none', 'Nothing to show', [e(Row, { key: 'none', label: 'Open an instance from a mod\'s page or a link.' })]));
    const type = o.typeOf(inst?.ref?.type ?? ref.type);
    const members = type?.members ?? {};
    const st = inst && !inst.gone ? inst.state ?? {} : {};
    const titleField = type?.summary?.title;
    const title = text(st[titleField]) || ref.id;
    // eslint-disable-next-line codexmods/no-provider-identity -- the framework's own pages
    const own = ref.provider === FRAMEWORK_PROVIDER && Boolean(o.ownPage(ref));
    const gone = !inst || inst.gone;

    const stateRows = Object.keys(members.state ?? st).filter((k) => st[k] !== undefined).map((k) => e(Row, { key: `s:${k}`, label: k, control: value(shown(st[k])) }));
    const relationRows = [];
    for (const name of Object.keys(members.relations ?? {})) {
      const linked = inst?.links?.[name];
      const list = (Array.isArray(linked) ? linked : linked ? [linked] : []).filter(isRef);
      list.slice(0, RELATED).forEach((r, i) => relationRows.push(e(Row, { key: `r:${name}:${i}`, label: name, description: `${r.type} · ${r.id}`,
        control: button('Details', () => o.show(r), false, 'secondary', `Details of ${name} ${r.id}`) })));
      if (list.length > RELATED) relationRows.push(e(Row, { key: `r:${name}:more`, label: name, description: `and ${list.length - RELATED} more` }));
    }
    const opRows = own
      ? [e(Row, { key: 'own', label: 'The framework\'s', description: 'Its actions are on its own page, each asked first where it cannot be undone.', control: button('Open its page', () => o.openOwn(ref), false, 'primary') })]
      : Object.entries(members.operations ?? {}).map(([name, m]) => ((m.minArgs ?? 0) === 0
        ? e(Row, { key: `o:${name}`, label: name, description: lines([], acting.error(`o:${name}`)), control: button('Run…', () => setAsking({ ref: inst?.ref ?? ref, name, title }), gone || acting.busy(`o:${name}`), 'secondary', `Run ${name}`) })
        : e(Row, { key: `o:${name}`, label: name, description: 'Takes arguments: not offered here' })));

    const run = async (a) => { const out = await acting.run(`o:${a.name}`, a.ref, a.name, []); if (out.ok) setAsking(null); };
    const dialog = asking ? e(o.dialogs.ModsDialog, { key: 'run', subject: asking.ref, purpose: 'run', title: `Run ${asking.name} on ${asking.title}?`, onClose: () => setAsking(null),
      footer: [button('Cancel', () => setAsking(null)), button('Run', () => run(asking), acting.busy(`o:${asking.name}`), 'primary')] },
    e('p', { key: 'what' }, `${asking.ref.type}.${asking.name}, as you, through the graph. What it changes is its provider's (${asking.ref.provider}) to say; it may not ask again.`),
    acting.error(`o:${asking.name}`) ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error(`o:${asking.name}`)) : null) : null;
    // A mod's rules on the DetailView of an instance the framework does not own (E7.6, decision 6): its replacement, its sections after
    // these, its actions; never on the framework's own instances.
    const ruled = !ref.provider.startsWith('codexmods.') && typeof ctx.ruled === 'function' ? ctx.ruled('DetailView', inst && !inst.gone ? inst : null) : null;
    const frame = { title, subtitle: `${inst?.ref?.type ?? ref.type} from ${ref.provider}${gone ? ' · not in the graph now' : ''}` };
    // reported as the window's DetailView of the instance (E6.5)
    const report = e(Report, { key: 'report', type: 'DetailView', subject: inst?.ref ?? ref, place: { in: 'Window', slot: 'main' } });
    // a rule that hides or replaces it never takes the framework's open confirmation with it (decision 6)
    if (ruled?.hidden) return e(Frame, frame, report, dialog);
    if (ruled?.replace) return e(Frame, frame, report, ruled.replace, dialog);
    const modActions = (ruled?.actions ?? []).map((a) => e(Row, { key: a.key, label: a.title, control: button(a.title, () => a.run(), false, 'secondary') }));
    return e(Frame, frame,
      report,
      ...(stateRows.length ? [section('state', 'State', stateRows)] : []),
      ...(relationRows.length ? [section('relations', 'Related', relationRows)] : []),
      ...(opRows.length ? [section('operations', own ? 'Its page' : 'Operations', opRows)] : []),
      ...(modActions.length ? [section('mod-actions', 'Actions', modActions)] : []),
      ...(ruled?.regions?.sections ?? []), dialog);
  }
  return { DetailPage };
}
