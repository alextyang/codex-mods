// A mod's section on one of the app's settings pages (ui.settings.section, docs/design/public-hooks.md §3.14): after the page's own
// sections, the app's own SettingsSection with its header (the section's title) and either the mod's component (renderer realm, in its
// rule's boundary) or a card of rows for the Settings it names, each the framework's row for its kind (setting-rows.mjs), showing only
// the Settings its mod may read. A write from a row is the user's (through the graph, as on a mod's own page). NO NODE API.
import { createSettingRows } from './setting-rows.mjs';

const MAX_SETTINGS = 50;

/** @param {{ R: object, ctx: object }} o  the binding's React and ctx */
export function createSettingsSections(o) {
  const { R, ctx } = o;
  const e = R.createElement;
  const rows = createSettingRows({ R, exports: () => ctx.exports?.() ?? {}, subscribe: ctx.view, invoke: ctx.invoke, ctx, log: ctx.log });

  /** The Settings a section names, as its mod may read them (observed: the row follows each). */
  function Rows({ rule, refs }) {
    const ex = ctx.exports?.() ?? {};
    const env = typeof ctx.whereEnv === 'function' ? ctx.whereEnv(rule) : {};
    const list = ctx.use(() => refs.slice(0, MAX_SETTINGS).map((r) => ctx.subject(r))
      .filter((x) => x && !x.gone && x.ref?.type === 'Setting' && x.state?.active !== false && (typeof env.may !== 'function' || env.may(x))));
    if (!list.length || !ex.SettingsCard) return null;
    return e(ex.SettingsCard, null, ...list.map((s) => e(rows.Row, { key: s.ref.id, setting: s })));
  }
  function Section({ rule, item, node, page }) {
    const ex = ctx.exports?.() ?? {};
    const S = ex.SettingsSection;
    if (!S || !S.Header || !S.Content) return null;
    const title = typeof item.title === 'string' && item.title ? item.title : null;
    const content = typeof item.render === 'function' ? node(rule, item.render, { mod: rule.mod, page })
      : Array.isArray(item.settings) ? e(Rows, { rule, refs: item.settings }) : null;
    return e(S, null, title ? e(S.Header, { title }) : null, e(S.Content, null, content));
  }
  return {
    /** The section's element (keyed by its mod and rule). */
    nodeFor: (rule, item, key, node, page) => e(Section, { key, rule, item, node, page }),
  };
}
