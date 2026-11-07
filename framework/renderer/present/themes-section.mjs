// The mods' themes on the app's Appearance page (ui.theme.add, docs/design/public-hooks.md §3.14, H7y): the framework's own section after
// the page's own, in the app's SettingsSection with its title, a card with a row per theme (its colours, its name, its mod and description)
// and its button: Use, or Stop using the one on. The Host writes a theme turned on as the app's own appearance settings and gives the
// user's back when it is turned off (themes.mjs). The swatches show the theme's own colours: they are what it is, not this page's look.
// NO NODE API.

/** A variant's swatch: its surface, ringed with its accent. */
const swatch = (R, c, key) => R.createElement('span', { key, 'aria-hidden': true, className: 'inline-block size-3 shrink-0 rounded-full', style: { background: c.surface, boxShadow: `inset 0 0 0 3px ${c.accent}` } });

/**
 * The section for these theme entries (`[{rule, item}]`), or null when the build lacks the app's settings parts.
 * @param {object} R  React
 * @param {{ exports?: () => object, themes?: () => { active: object | null }, useTheme?: (mod: string | null, id: string | null) => Promise<object>,
 *   modName?: (id: string) => string }} ctx
 */
export function themesSection(R, ctx, entries) {
  const ex = ctx.exports?.() ?? {};
  const S = ex.SettingsSection, Card = ex.SettingsCard, Row = ex.SettingsRow, Button = ex.Button;
  if (!S?.Header || !S.Content || !Card || !Row || !Button || !entries.length) return null;
  const { active } = ctx.themes?.() ?? { active: null };
  const e = R.createElement;
  const rows = entries.map(({ rule, item }) => {
    const on = !!active && active.mod === rule.mod && active.id === rule.id && active.applied === true;
    const label = e('span', { className: 'inline-flex items-center gap-2' },
      ...['light', 'dark'].filter((v) => item[v]).map((v) => swatch(R, item[v], v)), item.title);
    const by = typeof ctx.modName === 'function' ? ctx.modName(rule.mod) : rule.mod;
    const description = typeof item.description === 'string' && item.description ? `${by} · ${item.description}` : by;
    const control = e(Button, { color: on ? 'secondary' : 'primary', 'data-codexmods-theme': `${rule.mod}/${rule.id}`,
      onClick: () => { void ctx.useTheme?.(on ? null : rule.mod, on ? null : rule.id); } }, on ? 'Stop using' : 'Use');
    return e(Row, { key: `${rule.mod}/${rule.id}`, label, description, control });
  });
  return e(S, { key: 'codexmods-themes', 'data-codexmods-framework': 'themes' }, e(S.Header, { title: 'Themes from mods' }), e(S.Content, null, e(Card, null, ...rows)));
}
