// codexmods.ui-tweaks, renderer entry (GOAL.md goal 20). Single-file ESM, no imports.
//
// "Hidden parts": a page of this mod's in Settings (a tab of its page, after its settings) listing the app's own parts each place draws
// (`ui.parts`: the names in the user's words, only those this build draws and the framework lets a mod hide), each with a checkbox. What
// is checked is this mod's `hidden` setting; the host entry hides them.

const PLACES = [
  ['Sidebar', 'Sidebar'], ['SidebarItem', 'Chats in the sidebar'], ['TitleBar', 'Title bar'], ['ThreadHeader', 'Chat header'],
  ['Composer', 'Composer'], ['NewThreadView', 'New chat'], ['TurnView', 'Turns'], ['MessageBlock', 'Messages'], ['StepBlock', 'Steps'],
  ['Menu', 'Menus'], ['SidePanel', 'Side panel'], ['StatusItem', 'Status'],
];
export const keyOf = (presentation, p) => `${presentation}/${p.slot}/${p.part}`;
/** What a mod may hide of a place's parts: those this build draws that are not protected (an optional part may be hidden). */
export const hideable = (parts) => (Array.isArray(parts) ? parts : []).filter((p) => p && p.supported !== false && p.protected !== true
  && (!Array.isArray(p.kinds) || p.kinds.includes('hide')) && typeof p.slot === 'string' && typeof p.part === 'string');

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;

  function usePlaces() {
    const [places, setPlaces] = R.useState(null);
    R.useEffect(() => {
      let live = true;
      Promise.all(PLACES.map(async ([presentation, title]) => {
        try { return { presentation, title, parts: hideable(await ctx.ui.parts(presentation)) }; } catch { return { presentation, title, parts: [] }; }
      })).then((list) => { if (live) setPlaces(list.filter((x) => x.parts.length)); });
      return () => { live = false; };
    }, []);
    return places;
  }
  function useHidden() {
    const [hidden, setHidden] = R.useState([]);
    R.useEffect(() => {
      let live = true;
      ctx.settings.get('hidden').then((v) => { if (live) setHidden(Array.isArray(v) ? v : []); }).catch(() => {});
      const sub = ctx.settings.onChange((doc) => { if (live) setHidden(Array.isArray(doc?.hidden) ? doc.hidden : []); });
      return () => { live = false; sub.dispose(); };
    }, []);
    return hidden;
  }

  function Page() {
    const places = usePlaces();
    const hidden = useHidden();
    const [error, setError] = R.useState(null);
    const set = (next) => { setError(null); ctx.settings.set('hidden', next).catch((err) => setError(String(err?.message ?? err))); };
    const toggle = (k, on) => set(on ? [...new Set([...hidden, k])] : hidden.filter((x) => x !== k));
    if (!places) return e(C.EmptyState, { glyph: 'customize', title: 'Reading the app\'s parts…' });
    return e('div', { 'data-ui-tweaks-parts': String(hidden.length), style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 5)' } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 3)' } },
        e('div', { className: 'text-sm', style: { flex: 1, color: 'var(--color-text-secondary)' } },
          'Checked parts are hidden in every window while this mod is on. Stop, Settings, signing in and out, and every answer to a request are never hidden.'),
        hidden.length ? e(C.Button ?? 'button', { type: 'button', onClick: () => set([]) }, 'Show all') : null),
      error ? e(C.Banner, { tone: 'danger', message: error }) : null,
      ...places.map((place) => e('section', { key: place.presentation, 'data-place': place.presentation, style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)' } },
        e('div', { className: 'text-sm font-medium' }, place.title),
        ...place.parts.map((p) => {
          const k = keyOf(place.presentation, p);
          const on = hidden.includes(k);
          return e('label', { key: k, className: 'text-sm', style: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 2)' } },
            e(C.Checkbox, { checked: on, ariaLabel: `Hide ${p.title}`, onChange: (v) => toggle(k, v) }),
            e('span', null, p.title));
        }))));
  }

  const page = ctx.ui.settings.page({ id: 'parts', title: 'Hidden parts', render: () => e(Page) });
  return () => page.dispose();
}

export default { renderer };
