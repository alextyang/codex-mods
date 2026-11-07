// The Layouts section of the Mods list (docs/design/layouts.md D9): every mod's layout, region and page with its switch, and the layout a window starts with. The
// framework's own UI, drawn with the app's settings parts. NO NODE API.
import { pageParts } from './page-parts.mjs';

const KINDS = Object.freeze({ layout: 'Layout', region: 'Region', page: 'Page' });

/**
 * @param {{ ctx: object, exports: () => object, items: () => { kind: 'layout' | 'region' | 'page', key: string, title: string, mod: string }[],
 *   switches: { isOff(kind: string, key: string): boolean, set(kind: string, key: string, off: boolean): void, defaultLayout(): string | null, setDefault(key: string | null): void },
 *   modName?: (mod: string) => string, stateKey: string }} o
 */
export function createLayoutsSection(o) {
  const { ctx } = o;
  return function LayoutsSection() {
    const R = ctx.react();
    const e = R.createElement;
    const items = ctx.use(() => { ctx.local?.read?.(o.stateKey); return o.items(); });
    if (!items.length) return null;
    const ex = o.exports();
    const parts = pageParts(R, ex);
    const Row = ex.SettingsRow;
    const def = o.switches.defaultLayout();
    const rows = items.map((it) => {
      const off = o.switches.isOff(it.kind, it.key);
      const controls = e('span', { className: 'flex items-center gap-2' },
        it.kind === 'layout' && !off ? parts.button(def === it.key ? 'New windows start with it' : 'Start new windows with it', () => o.switches.setDefault(def === it.key ? null : it.key), false) : null,
        parts.toggle(`${it.title}: on`, !off, (on) => o.switches.set(it.kind, it.key, !on)));
      return e(Row, { key: `${it.kind}:${it.key}`, label: it.title, description: `${KINDS[it.kind]} of ${o.modName?.(it.mod) ?? it.mod}`, control: controls });
    });
    return parts.section('codexmods-layouts', 'Layouts', rows);
  };
}

/**
 * The window's layouts where the user arranges the workspace (D6): a menu in the title bar, by the app's own controls, while any is declared: the layouts, the one picked marked,
 * and the way back to the app's own. Its element for the title bar's binding, or null with none.
 * @param {{ ctx: object, exports: () => object, layouts: () => object | null, contextKey: string }} o
 */
export function createLayoutPicker(o) {
  const { ctx } = o;
  function LayoutPicker() {
    const R = ctx.react();
    const e = R.createElement;
    const [open, setOpen] = R.useState(false);
    const layouts = o.layouts();
    const picked = ctx.use(() => { ctx.local?.read?.(o.contextKey); return layouts?.facts()?.picked ?? null; });
    const ex = o.exports() ?? {};
    const Button = ex.CodexButton ?? ex.Button, Item = ex.MenuParts?.Item;
    const list = layouts?.list() ?? [];
    if (!ex.Menu || !Button || !Item || !list.length) return null;
    const title = list.find((l) => l.key === picked)?.title ?? 'Layout';
    const choose = (fn) => () => { setOpen(false); fn(); };
    return e(ex.Menu, { open, onOpenChange: setOpen, triggerButton: e(Button, { color: 'ghost', size: 'toolbar', 'aria-label': `Layout: ${title}`, 'data-codexmods-layouts': picked ?? '' }, title) },
      ...list.map((l) => e(Item, { key: l.key, 'data-codexmods-layout': l.key, onClick: choose(() => layouts.pick(l.key)) }, l.key === picked ? `\u2713 ${l.title}` : l.title)),
      ...(picked ? [e(Item, { key: 'codexmods:app', 'data-codexmods-layout': '', onClick: choose(() => layouts.end()) }, 'The app\'s own layout')] : []));
  }
  return () => {
    const R = ctx.react();
    return R && (o.layouts()?.list().length ?? 0) > 0 ? R.createElement(LayoutPicker) : null;
  };
}
