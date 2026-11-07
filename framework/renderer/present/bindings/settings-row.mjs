// SettingsRow (docs/graph/03; E8.9k, scout E8-frame-slots §3.2): one row of the app's settings pages, the app's own row component (the
// `SettingsRow` exposure, matched by identity: hundreds of rows, no props tell them apart). A row presents the Setting its label names: the
// title it shows, as the app's settings catalog has it, on the page the route shows (a mod's own setting rows, on its pages, name none). Its
// `trailingActions` are the mods' actions after the row's control, in the control's own right-aligned row, as the app's own button. NO NODE API.
import { defineBinding } from '../runtime.mjs';
import { actionNode, badgeNode } from './slots.mjs';

/** The title a row shows: its label's text, or its message's default text. */
const titleOf = (label) => (typeof label === 'string' ? label
  : label && typeof label === 'object' && label.props && typeof label.props.defaultMessage === 'string' ? label.props.defaultMessage : null);
/** The settings page a route shows (its slug), or null. */
const sectionOf = (route) => { const m = typeof route?.pathname === 'string' ? /^\/settings\/([^/?#]+)/.exec(route.pathname) : null; return m ? m[1] : null; };

const trailing = {
  kind: 'list', field: 'actions',
  apply: (props, entries, env) => {
    const R = env.R;
    const nodes = entries.map((e, i) => actionNode(R, env.ctx, e.item, `codexmods:${e.rule.mod}/${e.rule.id}/${e.item && e.item.id != null ? e.item.id : i}`));
    if (!nodes.length || !R) return props;
    const own = props.control;
    // the control may be the app's element or a function of its aria props; a row with none gets the actions as its control
    const control = typeof own === 'function' ? (aria) => R.createElement(R.Fragment, null, own(aria), ...nodes) : R.createElement(R.Fragment, null, own ?? null, ...nodes);
    return { ...props, control };
  },
};

// a mod's badges after the row's label (its title)
const badges = {
  kind: 'list', field: 'badges',
  apply: (props, entries, env) => {
    const R = env.R;
    const nodes = entries.map((e, i) => badgeNode(R, env.ctx, e.item, `codexmods:${e.rule.mod}/${e.rule.id}/${e.item && e.item.id != null ? e.item.id : i}`));
    return nodes.length && R ? { ...props, label: R.createElement(R.Fragment, null, props.label ?? null, ...nodes) } : props;
  },
};

// A tool server's row on the MCP servers page is the same component: the pack's identity props (seam `props:mcp-row`, H7v) give it the
// server's config key, the host whose servers the page shows and whether it is a plugin's (it shows a display name, and the page may show
// another host's, or a project's config of a key). A server of this Mac is its ToolServer (codex's ids are the keys) only where the graph
// knows where it is configured and that is the row's kind: a config's row only of a server the user's config alone defines (none of a
// project's layers names any of its fields), a plugin's only of one no config names. Otherwise it presents nothing (built review H7v).
function serverOf(props, ctx) {
  if (typeof props.serverKey !== 'string' || !props.serverKey || props.hostId !== 'local' || props.serverReadOnly === true) return null;
  const ref = { type: 'ToolServer', provider: 'codex', id: props.serverKey };
  const inst = typeof ctx.subject === 'function' ? ctx.subject(ref) : null;
  if (!inst || inst.gone) return null;
  return inst.state?.source === (props.fromPlugin === true ? 'plugin' : 'user') ? ref : null;
}

export const settingsRow = defineBinding({
  id: 'settings.row', presentation: 'SettingsRow', presents: ['Setting', 'ToolServer'],
  place: (props, route) => { const slug = sectionOf(route); return slug ? { in: 'SettingsPage', on: { type: 'SettingsSection', provider: 'codex', id: slug }, slot: 'rows' } : null; },
  subject: (props, ctx, route) => {
    if (props.serverKey !== undefined) return serverOf(props, ctx);
    return typeof ctx.settingNamed === 'function' ? ctx.settingNamed(titleOf(props.label), sectionOf(route)) : null;
  },
  slots: { trailingActions: trailing, badges },
});
