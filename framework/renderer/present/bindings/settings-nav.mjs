// The settings navigation, for a mod's page in the app's Settings (docs/design/systems.md S15, E0; ../settings-pages.mjs). Two bindings:
// - `settings.nav`, the navigation list (its props carry the settings sections, their grouping, the active one and `onSelect`): it keeps
//   `onSelect` for the Mods entries, and on a mod's page no app entry is active (the app falls back to General for a section it does not
//   know);
// - `settings.navgroup`, a group of a navigation list (the NavGroup exposure, by identity: its props are too generic to tell it): after
//   the app's first settings group (Personal) comes the framework's Mods group. Every other use of the group component is left as it is.
// Both present the settings sections (a mod's page is its SettingsSection). NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { settingsPages, isFirstGroup, groupOf, ACTIVE_SECTION } from '../settings-pages.mjs';

export const settingsNav = defineBinding({
  id: 'settings.nav',
  presents: ['SettingsSection'],
  render(Original, props, factory) {
    const pages = settingsPages();
    if (!pages) return undefined;
    pages.setOnSelect(props.onSelect);
    const active = pages.read();
    return active ? factory(Original, { ...props, activeSection: ACTIVE_SECTION }) : undefined;
  },
});

export const settingsNavGroup = defineBinding({
  id: 'settings.navgroup',
  presents: ['SettingsSection'],
  render(Original, props, factory, ctx) {
    const pages = settingsPages();
    const R = ctx.react();
    if (!pages || !R) return undefined;
    // the mods' own pages that join this group of the app's (E8.9a): entries after the app's own
    const own = pages.entriesFor?.(groupOf(props)) ?? [];
    const next = own.length ? { ...props, children: [...(Array.isArray(props.children) ? props.children : props.children == null ? [] : [props.children]), ...own] } : props;
    if (!isFirstGroup(props)) return own.length ? factory(Original, next) : undefined;
    return R.createElement(R.Fragment, null, factory(Original, next), factory(pages.ModsGroup, {}));
  },
});
