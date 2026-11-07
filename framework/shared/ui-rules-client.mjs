// The mod side of the presentation rules (docs/design/systems.md S5, "E2 in detail"): `ctx.ui.decorate`, `hide`, `replace`, `host`,
// `render`, `add`, `reorder` and `style`, over the Host's `ui` namespace. A rule's static data crosses to the Host (and from there to every
// window); its functions and components stay where they were registered: in the renderer realm, in the page's own store of handles, which
// the page joins to the Host's rule when it arrives. The host realm has the data rules, whose callbacks (an action's or a badge's `run`)
// stay in the mod's worker (docs/design/mod-surfaces.md P1): each is sent as a marker `{$fn: path}` and the page calls it through the Host
// with the action's env (P2).
// `read` and `act` reach the Presentation instances (S10): the graph's own list, `presentations` relation and invoke, as the mod.
// `ask` asks the user in a Dialog (E7 decision 7), through the Host.
//
// NO NODE API HERE: this file runs in the mod worker and in the page.
import { CodexModsError } from '../../sdk/errors.mjs';
import { compilePattern } from './bounded-pattern.mjs';
import { compileWhere } from './where.mjs';

/** The member of a realm context that reaches the Host's rules (not part of the SDK surface: the realm's `ctx.ui` is built on it). */
export const RULES = Symbol.for('codexmods.presentation-rules');

/** Fields each kind takes, and whether a function there is the mod's (page-only) or data. */
const FIELDS = {
  decorate: ['badges', 'label', 'tooltip', 'actions', 'icon', 'summary'],   // `icon`: a part's relabel (public-hooks.md §3.10); `summary`: how a subject reads (§3.13)
  hide: [],
  replace: ['render'],
  host: ['render', 'view', 'headerRows', 'part', 'page', 'actions'],   // `view`, `headerRows`: a panel view's (ui.panel); `part`: a content part renderer's (ui.content); `page`: a settings page's (ui.settings.page)
  render: ['render'],
  add: ['items', 'subject', 'menuRun', 'source', 'slash', 'mention', 'suggest', 'command', 'filter', 'sort', 'section', 'choices', 'hide', 'attach', 'starter', 'redact', 'route', 'region', 'destination', 'sidebarView', 'layout', 'layoutMode'],   // `region`: a mod's region at the workspace's edge (ui.regions.add; its render stays in the page)   // `route`: which links a link route takes and where they open (ui.links.route)   // `redact`: text masked where content is shown (ui.content.redact)   // `starter`: a starting point's declaration (ui.newThread.starter)   // `attach`: an attachment source of the composer's "+" list (ui.composer.attachSource)   // `hide`: a subject a mod hides from the sidebar's listings (ui.hide('Thread' | 'Project'))   // `choices`: what a picker offers (ui.choices)   // `subject`: the instance a status reads (ui.status); `sort`: a sidebar order (ui.sidebar.order)   // `filter`: a list's filter (ui.filter)   // `command`: a mod command (ui.commands.add)   // `slash`: a composer slash command's (ui.composer.slash)   // `menuRun`: a renderer-realm menu bar entry's function (ui.menus.add); `source`: a palette source's (ui.palette.source)
  reorder: ['order'],
  style: ['variables'],
};
const META = ['id', 'for', 'where', 'of', 'part', 'slot', 'priority'];
const hasFunction = (v, depth = 0) => typeof v === 'function' || (depth < 4 && v && typeof v === 'object' && Object.values(v).some((x) => hasFunction(x, depth + 1)));
/** A callback marker's shape: only the framework writes one (a mod's data holding one is refused, so no field can alias a callback). */
const isMarker = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '$fn' in v;
const hasMarker = (v, depth = 0) => isMarker(v) || (depth < 8 && !!v && typeof v === 'object' && Object.values(v).some((x) => hasMarker(x, depth + 1)));
let regSeq = 0;
/** A registration's own token: a callback call names it, so a stale click never reaches a later registration under the same id. */
const regToken = () => `${Date.now().toString(36)}.${(++regSeq).toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
/**
 * Where a subject's decorations draw (docs/design/graph-layers.md §3.4): for each subject concept, the presentations that present it and
 * the kinds each draws, as the bindings draw them on 21477 (a Step's: a mod's own steps). `ui.decorate(<subject>, spec)` puts one rule in
 * each; a kind no place draws is said on the handle.
 */
export const DECORATION_PLACES = Object.freeze({
  Thread: Object.freeze({ SidebarItem: ['badges', 'label', 'actions', 'summary'], ThreadHeader: ['badges', 'actions', 'summary'] }),
  // a message's badges: the user's in its header, the agent's in its action row (public-hooks.md §3.13); a turn's in its final answer's row
  Message: Object.freeze({ MessageBlock: ['actions', 'badges'] }),
  UserMessage: Object.freeze({ MessageBlock: ['actions', 'badges'] }),
  AgentMessage: Object.freeze({ MessageBlock: ['actions', 'badges'] }),
  Turn: Object.freeze({ TurnView: ['actions', 'badges'], PlanView: ['actions'] }),
  Step: Object.freeze({ StepBlock: ['badges', 'actions'] }),
  Request: Object.freeze({ RequestCard: ['actions'] }),
  Setting: Object.freeze({ SettingsRow: ['actions', 'badges'] }),
  // H7s: a skill's card on the Skills page; H7v: a tool server's row on the MCP servers page (its key and host from the pack's props seam)
  Skill: Object.freeze({ ListItem: ['badges'] }),
  ToolServer: Object.freeze({ SettingsRow: ['actions', 'badges'] }),
  // H7x: a queued follow-up's row, a terminal's tab and a plan's tab (header rows), a branch's row in a branch picker
  QueuedMessage: Object.freeze({ QueueItem: ['actions', 'badges'] }),
  Terminal: Object.freeze({ TerminalView: ['actions'] }),
  Branch: Object.freeze({ ListItem: ['badges'] }),
  // H7z: a model's row in the composer's model menu (this Mac's catalog: the pack names the host it lists)
  Model: Object.freeze({ ListItem: ['badges'] }),
  Project: Object.freeze({ SidebarSection: ['actions', 'badges', 'label', 'summary'] }),   // its group in the sidebar (§3.13)
  Automation: Object.freeze({ AutomationView: ['actions'] }),
  App: Object.freeze({ Window: ['actions'] }),
  // public-hooks.md §3.13: a file's preview header, a browser tab's toolbar, the Changes tab's controls and a changed file's diff header
  File: Object.freeze({ FilePreview: ['actions'] }),
  BrowserTab: Object.freeze({ BrowserView: ['actions'] }),
  ChangeSet: Object.freeze({ ChangesView: ['actions'] }),
  FileChange: Object.freeze({ DiffView: ['actions'] }),
});
// `summary` (public-hooks.md §3.13): how a subject reads where it is listed or headed, without renaming it: `{title?, subtitle?, icon?}` (or
// the title alone), data, live text or a function of the subject; a chat's SidebarItem rules are also read by the palette's and the "@"
// list's rows
const DECORATION_KINDS = ['badges', 'label', 'tooltip', 'actions', 'summary'];
/**
 * Where hiding a subject takes it out (public-hooks.md §3.12, `ui.hide(Subject, {id, where?, of?, in?})`): the agent's records (its steps,
 * messages and turns, a file's section of its changes), hidden in place with a one-line stub the user can open; never one still under
 * way or waiting on the user. Chats and projects (`LISTED`) are taken out of the sidebar's listings with the window's notice ("2 hidden by
 * <mod>", "Show"); never the chat a window shows, nor one working, waiting for the user or failed. A catalog's entries are its choices.
 */
export const HIDE_PLACES = Object.freeze({
  Step: Object.freeze(['StepBlock']), Message: Object.freeze(['MessageBlock']), Turn: Object.freeze(['TurnView']), FileChange: Object.freeze(['DiffView']),
  Thread: Object.freeze(['Sidebar']), Project: Object.freeze(['Sidebar']), Command: Object.freeze(['Palette']),
});
/** The subjects hidden from listings: one add rule on their listing's `hidden` (the sidebar's, the palette's), on in every window, with its notice. */
const LISTED = new Map([['Thread', 'Sidebar'], ['Project', 'Sidebar'], ['Command', 'Palette']]);
const HIDE_ELSEWHERE = Object.freeze({
  Model: 'a catalog\'s entries are its choices: ui.choices(Model, {hide})', SlashCommand: 'a catalog\'s entries are its choices: ui.choices(SlashCommand, {hide})',
  ExternalApp: 'a catalog\'s entries are its choices: ui.choices(ExternalApp, {hide})', Environment: 'a catalog\'s entries are its choices: ui.choices(Environment, {hide})',
});
/** Where a starter is offered (`ui.newThread.starter`): the new chat page, the palette, a project's context menu. */
const STARTER_PLACES = Object.freeze(['newThread', 'palette', 'project']);
/** The new chat's Draft (its target names the project a new chat starts in) and Codex's agent (a chat of no project). */
const NEW_CHAT_DRAFT = Object.freeze({ type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' });
const CODEX_AGENT = Object.freeze({ type: 'CodexAgent', provider: 'codex', id: 'codex' });
/** The lists `ui.filter` filters, by the presentation each filter is an add rule on (slot `filter`). */
export const FILTER_LISTS = Object.freeze({ sidebar: 'Sidebar', transcript: 'ThreadView', files: 'FilesView', changes: 'ChangesView' });
/** The members a host-realm rule may give as functions: callbacks the user triggers, called with the action's env (mod-surfaces.md P1): an
 *  entry's `run`, a palette source's `search` and `choose`. */
const CALLBACKS = new Set(['run', 'search', 'choose']);
/** Where a callback may stand: an entry's `run` (`field.n.run`), a palette source's `search` and `choose`. */
export const CALLBACK_PATH = /^(?:[A-Za-z]+\.\d{1,4}\.run|source\.(?:search|choose)|slash\.run|command\.run|mention\.search|suggest\.provide)$/;
/** The callbacks that take an argument before the env (a source's or a mention source's text, the chosen row): called with `{arg, env}`. */
export const ARG_PATHS = Object.freeze(new Set(['source.search', 'source.choose', 'mention.search']));
/** The callbacks that answer a search: the Host gives them the search's time, not an action's. */
export const SEARCH_PATHS = Object.freeze(new Set(['source.search', 'mention.search']));
const MAX_CALLBACKS = 64;

// Message content (docs/design/mod-surfaces.md §3.3, E8.8): what a part renderer claims, checked alike by the client and the Host.
/** The markdown sites a part renderer may name: the two message sites are told now; the others are reserved until a binding tells them. */
export const CONTENT_SITES = Object.freeze(['agent-message', 'user-message', 'reasoning', 'plan', 'file-preview', 'review-comment', 'other']);
/** The link schemes a link part may claim: the app's sanitiser drops every other (a mod's own scheme never reaches a renderer). */
export const LINK_SCHEMES = Object.freeze(['https', 'http', 'codex']);
/** The navigation groups a mod's settings page may join (E8.9a): the framework's Mods group, or one of the app's own. */
export const SETTINGS_GROUPS = Object.freeze(['mods', 'personal', 'integrations', 'coding']);
/** A page of the app's settings as its route names it (`/settings/<slug>`). */
export const SETTINGS_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The sidebar's lists an order names (ui.sidebar.order): or a Project's ref, its group. */
export const SIDEBAR_LISTS = Object.freeze(['pinned', 'chats', 'projects', 'project']);
/** Why a sidebar order's data is not one (null when it is): `{in?, by?}`, `by` a path (`-path` descending); a function stays in its window. */
export function sidebarSortWhy(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'an order is {in?, by}';
  if (x.in !== undefined && !SIDEBAR_LISTS.includes(x.in) && !isRefShape(x.in)) return `in is one of ${SIDEBAR_LISTS.join(', ')} or a Project's ref`;
  if (x.by !== undefined && !(typeof x.by === 'string' && /^-?[@A-Za-z][\w.@/-]{0,199}$/.test(x.by))) return 'by is a path (-path descending) or, in the renderer realm, (a, b) => number';
  return null;
}
// Choices (docs/design/public-hooks.md §3.11): what a picker offers, keyed by the subject offered. `of` is a type or `{setting}`.
export const CHOICE_SUBJECTS = Object.freeze(['Model', 'effort', 'access', 'SlashCommand', 'ExternalApp', 'Environment']);
/** The places a choice may name (`in`); every place that offers its subject by default. */
export const CHOICE_PLACES = Object.freeze(['composer', 'newChat', 'slashMenu', 'menus', 'settings']);
/** What each subject's places do not do yet on this framework (said on the handle, never dropped quietly). */
export const CHOICES_NOT_BUILT = Object.freeze({
  Model: ['in settings', 'add in slashMenu'], effort: ['order', 'add', 'in settings'], access: ['label in the newer menu form', 'in slashMenu'],
  SlashCommand: ['add (ui.composer.slash adds a command)', 'label is shown, not searched'], ExternalApp: ['in settings', 'the artifact header'], Environment: ['add', 'the run locations (local, worktree, cloud)', 'the cloud-mode dropdown and /cloud-environment'],
});
const idList = (v) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200);
/** Why a choice's data is not one (null when it is): `{in?, hide?: ids | where, order?: ids, label?: {id: text | {title?, description?}}}`. */
export function choicesWhy(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'a choice is {in?, hide?, order?, label?, add?}';
  if (c.in !== undefined && !(Array.isArray(c.in) && c.in.length && c.in.every((x) => CHOICE_PLACES.includes(x)))) return `in names places among ${CHOICE_PLACES.join(', ')}`;
  if (c.hide !== undefined && !idList(c.hide) && !(c.hide && typeof c.hide === 'object' && !Array.isArray(c.hide))) return 'hide is ids, a where on the offered subject or (renderer realm) a test';
  if (c.order !== undefined && !idList(c.order)) return 'order is ids (at most 200)';
  if (c.label !== undefined) {
    const entries = c.label && typeof c.label === 'object' && !Array.isArray(c.label) ? Object.entries(c.label) : null;
    const ok = (l) => (typeof l === 'string' && l.length <= 120) || (l && typeof l === 'object' && !Array.isArray(l) && Object.keys(l).every((k) => k === 'title' || k === 'description')
      && (l.title === undefined || (typeof l.title === 'string' && l.title.length <= 120)) && (l.description === undefined || (typeof l.description === 'string' && l.description.length <= 300)));
    if (!entries || entries.length > 200 || !entries.every(([, l]) => ok(l))) return 'label maps ids to a text or {title?, description?}';
  }
  return null;
}
/** Why a mod's sidebar section is not one (null when it is): `{title, where | of, sort?, collapsed?, limit?, position?}`. */
export function sidebarSectionWhy(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a section is {title, where | of, ...}';
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 80) return 'a section has a title of at most 80 characters';
  if ((x.where === undefined) === (x.of === undefined)) return 'a section lists the chats its where selects or the ones its of names';
  if (x.where !== undefined && (!x.where || typeof x.where !== 'object' || Array.isArray(x.where))) return 'where is the one grammar (an object)';
  if (x.of !== undefined && !(Array.isArray(x.of) && x.of.length > 0 && x.of.length <= 50 && x.of.every(isRefShape))) return 'of names chats by ref (at most 50)';
  if (x.sort !== undefined && sidebarSortWhy({ by: x.sort })) return 'sort is a path (-path descending)';
  if (x.collapsed !== undefined && typeof x.collapsed !== 'boolean') return 'collapsed is true or false';
  if (x.limit !== undefined && !(Number.isInteger(x.limit) && x.limit >= 1 && x.limit <= 50)) return 'limit is 1 to 50 (the rows shown before "Show more")';
  if (x.position !== undefined && x.position !== 'top' && x.position !== 'end') return 'position is top or end';
  return null;
}
/** A region's width bounds (px): at least 160, at most 960. */
export const REGION_WIDTH = Object.freeze({ min: 160, max: 960, default: 320 });
/** Why a mod's region is not one (null when it is): `{title, icon?, edge: 'left' | 'right', width?: {default?, min?, max?}}` (layouts.md WL4a). */
export function regionWhy(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a region is {title, edge, width?}';
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 80) return 'a region has a title of at most 80 characters';
  if (x.icon !== undefined && (typeof x.icon !== 'string' || x.icon.length > 80)) return 'icon is a name';
  if (x.edge !== 'left' && x.edge !== 'right') return 'edge is left or right';
  if (x.width !== undefined) {
    const w = x.width;
    if (!w || typeof w !== 'object' || Array.isArray(w) || !Object.keys(w).every((k) => ['default', 'min', 'max'].includes(k))) return 'width is {default?, min?, max?}';
    const n = (v) => v === undefined || (Number.isFinite(v) && v >= REGION_WIDTH.min && v <= REGION_WIDTH.max);
    if (!n(w.default) || !n(w.min) || !n(w.max)) return `a width is ${REGION_WIDTH.min} to ${REGION_WIDTH.max} px`;
    const lo = w.min ?? REGION_WIDTH.min, hi = w.max ?? REGION_WIDTH.max, d = w.default ?? Math.min(Math.max(REGION_WIDTH.default, lo), hi);
    if (!(lo <= d && d <= hi)) return 'min <= default <= max';
  }
  return null;
}
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Why a theme's variant is not one (null when it is): its colours the app's chrome theme takes, a code theme's id, fonts. */
function variantWhy(v, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${name} is {surface, ink, accent, contrast?, added?, removed?, skill?, translucent?, fonts?, code?}`;
  for (const k of ['surface', 'ink', 'accent']) if (typeof v[k] !== 'string' || !HEX.test(v[k])) return `${name}.${k} is a colour #rrggbb`;
  for (const k of ['added', 'removed', 'skill']) if (v[k] !== undefined && (typeof v[k] !== 'string' || !HEX.test(v[k]))) return `${name}.${k} is a colour #rrggbb`;
  if (v.contrast !== undefined && !(Number.isInteger(v.contrast) && v.contrast >= 0 && v.contrast <= 100)) return `${name}.contrast is a whole number from 0 to 100`;
  if (v.translucent !== undefined && typeof v.translucent !== 'boolean') return `${name}.translucent is true or false`;
  if (v.fonts !== undefined && !(v.fonts && typeof v.fonts === 'object' && !Array.isArray(v.fonts) && ['ui', 'code'].every((k) => v.fonts[k] === undefined || (typeof v.fonts[k] === 'string' && v.fonts[k].length <= 100)) && Object.keys(v.fonts).every((k) => k === 'ui' || k === 'code'))) return `${name}.fonts is {ui?, code?}: font families`;
  if (v.code !== undefined && (typeof v.code !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.code))) return `${name}.code is one of the app's code themes (its id)`;
  const extra = Object.keys(v).filter((k) => !['surface', 'ink', 'accent', 'contrast', 'added', 'removed', 'skill', 'translucent', 'fonts', 'code'].includes(k));
  return extra.length ? `${name} has no ${extra.join(', ')}` : null;
}
/** Why a theme (ui.theme.add, public-hooks.md §3.14) is not one (null when it is): a title, a light or a dark variant (or both). */
export function themeWhy(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a theme is {title, description?, light?, dark?}';
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 60) return 'a theme has a title of at most 60 characters';
  if (x.description !== undefined && (typeof x.description !== 'string' || x.description.length > 200)) return 'a description is at most 200 characters';
  if (x.light === undefined && x.dark === undefined) return 'a theme has a light variant, a dark one, or both';
  return (x.light !== undefined ? variantWhy(x.light, 'light') : null) ?? (x.dark !== undefined ? variantWhy(x.dark, 'dark') : null);
}
/** Why a mod's section on an app settings page is not one (null when it is): `{title?, settings?: refs (at most 50)}`. */
export function settingsSectionWhy(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a section is {title?, render | settings}';
  if (x.title !== undefined && (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 80)) return 'a section\'s title is at most 80 characters';
  if (x.settings !== undefined && !(Array.isArray(x.settings) && x.settings.length > 0 && x.settings.length <= 50 && x.settings.every(isRefShape))) return 'settings are refs {type, provider, id} (at most 50)';
  return null;
}
/** Why a settings page's `page` is not one (null when it is). */
export function settingsPageWhy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a page is {title, group?}';
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 80) return 'a page has a title of at most 80 characters';
  if (p.group !== undefined && !SETTINGS_GROUPS.includes(p.group)) return `a page's group is one of ${SETTINGS_GROUPS.join(', ')}`;
  return null;
}
/** A mod's page in the main region (ui.pages.add, layouts.md D7): its id is part of its path. */
export const MAIN_PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Why a main page's `page` is not one (null when it is): `{title, heading?}`. */
export function mainPageWhy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a page is {title, heading?}';
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 80) return 'a page has a title of at most 80 characters';
  if (p.heading !== undefined && (typeof p.heading !== 'string' || !p.heading.trim() || p.heading.length > 80)) return 'a page\'s heading is at most 80 characters';
  return null;
}
/** Why a destination is not one (null when it is): `{title, icon?, open: {page} | {command} | ref, sidebar?}`, exactly; its `icon` here is text. */
export function destinationWhy(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'a destination is {title, open, icon?, sidebar?}';
  const extra = Object.keys(d).find((k) => !['title', 'icon', 'open', 'sidebar'].includes(k));
  if (extra !== undefined) return `a destination has no ${extra}: it is {title, open, icon?, sidebar?}`;
  if (typeof d.title !== 'string' || !d.title.trim() || d.title.length > 40) return 'a destination has a title of at most 40 characters';
  if (d.icon !== undefined && (typeof d.icon !== 'string' || !d.icon || d.icon.length > 8)) return 'a destination\'s icon is an element or a component (renderer realm), or text of at most 8 characters (an emoji)';
  const to = d.open;
  const keys = to && typeof to === 'object' && !Array.isArray(to) ? Object.keys(to) : [];
  const only = (k) => keys.length === 1 && keys[0] === k && typeof to[k] === 'string' && MAIN_PAGE_ID.test(to[k]);
  const page = only('page'), command = only('command');
  if (!page && !command && (keys.includes('page') || keys.includes('command') || !isRefShape(to))) return 'a destination opens exactly one of {page} (this mod\'s), {command} (this mod\'s) or a ref';
  if (d.sidebar !== undefined && !page) return 'a sidebar view goes with a page';
  if (d.sidebar !== undefined && (typeof d.sidebar !== 'string' || !MAIN_PAGE_ID.test(d.sidebar))) return 'its sidebar is the id of this mod\'s ui.sidebar.view';
  return null;
}
/** Why what a layout or a mode's parameters ask of the regions is not that (null when it is). */
function layoutRegionsWhy(l) {
  const only = (o, keys, what) => { if (!plain(o)) return `${what} is an object`; const x = Object.keys(o).find((k) => !keys.includes(k)); return x === undefined ? null : `${what} has no ${x}`; };
  const px = (v, what) => (v === undefined || (Number.isFinite(v) && v > 0) ? null : `${what} is a number of px`);
  const open = (o, what) => (o.open === undefined || typeof o.open === 'boolean' ? null : `${what}'s open is true or false`);
  const tab = (o, what) => (o.tab === undefined || (typeof o.tab === 'string' && o.tab.length > 0 && o.tab.length <= 200) ? null : `${what}'s tab is a tab kind's name, or a view of a mod's <mod>/<id>`);
  if (l.sidebar !== undefined) { const why = only(l.sidebar, ['open', 'edge'], 'sidebar') ?? open(l.sidebar, 'sidebar') ?? (l.sidebar.edge === undefined || ['left', 'right'].includes(l.sidebar.edge) ? null : 'the sidebar\'s edge is left or right'); if (why) return why; }
  if (l.side !== undefined) { const why = only(l.side, ['open', 'size', 'tab'], 'side') ?? open(l.side, 'side') ?? px(l.side.size, 'the side panel\'s size') ?? tab(l.side, 'the side panel'); if (why) return why; }
  if (l.bottom !== undefined) { const why = only(l.bottom, ['open', 'height', 'tab', 'at'], 'bottom') ?? open(l.bottom, 'bottom') ?? px(l.bottom.height, 'the bottom panel\'s height') ?? tab(l.bottom, 'the bottom panel') ?? (l.bottom.at === undefined || ['below', 'left', 'right'].includes(l.bottom.at) ? null : 'the bottom panel is at below, left or right'); if (why) return why; }
  return null;
}
/** Why a layout is not one (null when it is): `{title, icon?, keep?, sidebar?, side?, bottom?, regions?, main?}`, with something to arrange. */
export function layoutWhy(l) {
  if (!plain(l)) return 'a layout is an object';
  const extra = Object.keys(l).find((k) => !['title', 'icon', 'keep', 'sidebar', 'side', 'bottom', 'regions', 'main'].includes(k));
  if (extra !== undefined) return `a layout has no ${extra}`;
  if (typeof l.title !== 'string' || !l.title.trim() || l.title.length > 80) return 'a layout has a title of at most 80 characters';
  if (l.icon !== undefined && (typeof l.icon !== 'string' || !l.icon || l.icon.length > 8)) return 'a layout\'s icon is text of at most 8 characters (an emoji)';
  if (l.keep !== undefined && !['while-active', 'once'].includes(l.keep)) return 'a layout\'s keep is while-active or once';
  const why = layoutRegionsWhy(l);
  if (why) return why;
  if (l.regions !== undefined) {
    if (!plain(l.regions) || Object.keys(l.regions).length > 16) return 'its regions are {<id>: {open?, size?}} (at most 16)';
    for (const [id, r] of Object.entries(l.regions)) {
      if (!plain(r) || (r.open !== undefined && typeof r.open !== 'boolean') || (r.size !== undefined && !(Number.isFinite(r.size) && r.size > 0)) || Object.keys(r).some((k) => k !== 'open' && k !== 'size')) return `region ${id} is {open?, size?}`;
    }
  }
  if (l.main !== undefined && l.main !== 'chat' && l.main !== 'tab' && !(plain(l.main) && Object.keys(l.main).length === 1 && typeof l.main.page === 'string' && MAIN_PAGE_ID.test(l.main.page))) return 'its main is chat, tab or {page} (this mod\'s)';
  if (!l.sidebar && !l.side && !l.bottom && !l.regions && !l.main) return 'a layout arranges something: its sidebar, side, bottom, regions or main';
  return null;
}
/** Why a mode's parameters are not that (null when they are): `{mode: chat | split | full, sidebar?, side?, bottom?}`. */
export function layoutModeWhy(m) {
  if (!plain(m) || !['chat', 'split', 'full'].includes(m.mode)) return 'the app\'s modes are chat, split and full';
  const extra = Object.keys(m).find((k) => !['mode', 'sidebar', 'side', 'bottom'].includes(k));
  if (extra !== undefined) return `a mode's parameters have no ${extra}`;
  if (!m.sidebar && !m.side && !m.bottom) return 'parameters for its sidebar, side or bottom';
  return layoutRegionsWhy(m);
}
/** Why a sidebar view's `sidebarView` is not one (null when it is): `{title}`. */
export function sidebarViewWhy(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 80) return 'a sidebar view has a title of at most 80 characters';
  return null;
}
// A status (docs/design/public-hooks.md §3.14): where it shows, how it reads, checked alike by the client and the Host.
/** Where a status shows: the window's title bar, the sidebar's footer, a composer's footer. */
export const STATUS_PLACES = Object.freeze(['titleBar', 'sidebarFooter', 'composer']);
/** A status's tones: the theme's own colors for them (neutral is the secondary text). */
export const STATUS_TONES = Object.freeze(['neutral', 'accent', 'success', 'warning', 'danger']);
const LIVE_FORMATS = ['number', 'percent', 'duration', 'relative'];
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Text, a template (`{{path}}`) or `{bind, format?}`, at most `max` characters. */
const textOk = (v, max) => (typeof v === 'string' && v.length <= max)
  || (plain(v) && typeof v.bind === 'string' && v.bind.length > 0 && v.bind.length <= 200 && Object.keys(v).every((k) => k === 'bind' || k === 'format')
    && (v.format === undefined || LIVE_FORMATS.includes(v.format)));
const numberOk = (v) => Number.isFinite(v) || (plain(v) && typeof v.bind === 'string' && v.bind.length > 0 && v.bind.length <= 200 && Object.keys(v).every((k) => k === 'bind'));
/** Is this a ref `{type, provider, id}`? */
export const isRefShape = (r) => plain(r) && ['type', 'provider', 'id'].every((k) => typeof r[k] === 'string' && r[k].length > 0 && r[k].length <= 200);
/** Why a status is not one (null when it is): `{text?, icon?, tone?, tooltip?, meter?: {value, max?}, when?, run?}`; something to show. */
export function statusWhy(st) {
  if (!plain(st)) return 'a status is an object';
  if (st.text !== undefined && !textOk(st.text, 200)) return 'text is at most 200 characters: text, a template ({{path}}) or {bind, format?}';
  if (st.tooltip !== undefined && !textOk(st.tooltip, 500)) return 'a tooltip is at most 500 characters: text, a template or {bind, format?}';
  if (st.tone !== undefined && !STATUS_TONES.includes(st.tone)) return `tone is one of ${STATUS_TONES.join(', ')}`;
  if (st.meter !== undefined && !(plain(st.meter) && numberOk(st.meter.value) && (st.meter.max === undefined || numberOk(st.meter.max)))) return 'a meter is {value, max?}: numbers or {bind}';
  if (st.when !== undefined && !plain(st.when)) return 'when is a where on its subject';
  if (st.text === undefined && st.meter === undefined && st.icon === undefined) return 'a status shows text, a meter or an icon';
  return null;
}
const LANGUAGE = /^[A-Za-z0-9_+.#-]{1,40}$/;
export const DIRECTIVE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const HOST_NAME = /^[A-Za-z0-9.-]{1,253}$/;
const listOf = (v, ok, max) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === 'string' && ok(x));
/** A part's pattern: one the bounded matcher takes (linear in the text whatever the pattern: no lookaround, no back-reference; review 4,
 *  round 2), at most 200 characters, flags among i, m, s, u. */
const patternOk = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.source !== 'string' || !m.source || m.source.length > 200 || typeof m.flags !== 'string') return false;
  try { compilePattern(m.source, m.flags); return true; } catch { return false; }
};
/** Why a part renderer's `part` is not one (null when it is). */
export function partWhy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a part is an object';
  if (p.sites !== undefined && !listOf(p.sites, (x) => CONTENT_SITES.includes(x), CONTENT_SITES.length)) return `sites are among ${CONTENT_SITES.join(', ')}`;
  if (p.whileStreaming !== undefined && p.whileStreaming !== 'render' && p.whileStreaming !== 'native') return 'whileStreaming is render or native';
  switch (p.kind) {
    case 'code': return listOf(p.language, (x) => LANGUAGE.test(x), 16) ? null : 'a code part names its languages (letters, digits and _+.#-, at most 16)';
    case 'inlineCode': return patternOk(p.match) ? null : 'an inline code part matches a pattern (at most 200 characters, no lookaround or back-reference; flags among i, m, s, u)';
    case 'link':
      if (p.scheme !== undefined && !listOf(p.scheme, (x) => LINK_SCHEMES.includes(x), 3)) return `a link part's schemes are among ${LINK_SCHEMES.join(', ')} (the app keeps no other)`;
      if (p.host !== undefined && !listOf(p.host, (x) => HOST_NAME.test(x), 32)) return 'a link part\'s hosts are host names (at most 32)';
      if (p.match !== undefined && !patternOk(p.match)) return 'a link part\'s match is a pattern (at most 200 characters, no lookaround or back-reference; flags among i, m, s, u)';
      return p.scheme === undefined && p.host === undefined && p.match === undefined ? 'a link part claims a scheme, a host or a pattern' : null;
    case 'directive':
      if (typeof p.name !== 'string' || !DIRECTIVE_NAME.test(p.name)) return 'a directive part names its directive (a letter, then letters, digits, _ and -; at most 40)';
      return p.groupConsecutive === undefined || typeof p.groupConsecutive === 'boolean' ? null : 'groupConsecutive is a boolean';
    case 'text': return patternOk(p.match) ? null : 'a text part matches a pattern (at most 200 characters, no lookaround or back-reference; flags among i, m, s, u)';
    default: return 'a part is code, inlineCode, link, directive or text';
  }
}
/** What text a mod masks where content is shown (`ui.content.redact`): its pattern, what it shows instead (at most 40 characters) and its sites. */
/** Where a link route opens what it takes (ui.links.route): the app's own browser, the default browser, or nowhere. */
export const LINK_OPENS = Object.freeze(['app', 'browser', 'none']);
/** Where a link is opened from, as a route's where reads it (`from`): a chat's message, the terminal, a pull request's link, or elsewhere. */
export const LINK_FROM = Object.freeze(['message', 'terminal', 'pullRequest', 'app']);
/** What makes a link route's declaration wrong, or null: `{where?, open}` or `{where?, handles: true}` (its run opens it). */
export function linkRouteWhy(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((k) => !['where', 'open', 'handles'].includes(k))) return 'a route is {where?, open} or {where?, run}';
  if (x.open !== undefined && !LINK_OPENS.includes(x.open)) return 'open is app, browser or none';
  if (x.handles !== undefined && x.handles !== true) return 'handles is true (its run opens the link)';
  if ((x.open !== undefined) === (x.handles === true)) return 'a route opens the link somewhere (open) or runs (run): one of them';
  if (x.where !== undefined) {
    if (!x.where || typeof x.where !== 'object' || Array.isArray(x.where)) return 'where is a where on the link {url, scheme, host, path, local, from}';
    try { compileWhere(x.where); } catch (e) { return `where: ${e?.message ?? e}`; }
  }
  return null;
}
export function redactWhy(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'a redaction is an object';
  if (!patternOk(r.match)) return 'a redaction matches a pattern (at most 200 characters, no lookaround or back-reference; flags among i, m, s, u)';
  if (r.as !== undefined && (typeof r.as !== 'string' || r.as.length > 40)) return 'as is text of at most 40 characters';
  if (r.sites !== undefined && !listOf(r.sites, (x) => CONTENT_SITES.includes(x), CONTENT_SITES.length)) return `sites are among ${CONTENT_SITES.join(', ')}`;
  return null;
}
/** A pattern as a rule's data holds it: a RegExp's source and flags, or a string's. */
const patternOf = (m) => (m instanceof RegExp ? { source: m.source, flags: m.flags.replace(/[^imsu]/g, '') } : typeof m === 'string' ? { source: m, flags: '' } : m);
const listed = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
/**
 * A host-realm field with its callbacks replaced by markers `{$fn: path}`, the functions kept in `fns` by path. Any other function (a
 * field computed from the subject, a component) is the renderer realm's.
 */
function markCallbacks(kind, field, v, path, fns, depth = 0) {
  if (typeof v === 'function') throw new CodexModsError('Invalid', `ui.${kind}: ${path} is a function; in the host realm only an entry's run is (a field computed from its subject is the renderer realm's)`);
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x, i) => markCallbacks(kind, field, x, `${path}.${i}`, fns, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'function' && CALLBACKS.has(k) && CALLBACK_PATH.test(`${path}.${k}`)) {
      if (fns.size >= MAX_CALLBACKS) throw new CodexModsError('Invalid', `ui.${kind}: at most ${MAX_CALLBACKS} callbacks in one rule`);
      fns.set(`${path}.${k}`, x);
      out[k] = { $fn: `${path}.${k}` };
    } else out[k] = markCallbacks(kind, field, x, `${path}.${k}`, fns, depth + 1);
  }
  return out;
}

/**
 * `panels` (renderer realm): opens and closes this mod's panel views in the window (ui.panel).
 * @param {{ modId: string, realm: 'host' | 'renderer', channel: { register(desc: object): Promise<{ order: number }>, dispose(id: string): Promise<unknown> },
 *   panels?: { open(id: string, opts?: object): boolean, close(id: string, opts?: object): boolean },
 *   local?: { set(key: string, fns: object): void, delete(key: string): void }, onRefused?: (id: string, error: Error) => void,
 *   graph?: () => { list(type: string, filter?: object): Promise<object[]>, related(ref: object, name: string): Promise<object[] | null>,
 *     invoke(ref: object, operation: string, args?: unknown[]): Promise<object> } | undefined }} o  `graph`: the realm's ctx.graph
 */
export function createRuleApi(o) {
  const live = new Map();   // id -> its handle, while registered here
  /** `replace`: register again under the same id in place (an entry's update): the Host replaces the rule; the older registration's
   *  callbacks are let go once the new one is accepted, and no dispose is sent between them. */
  // set while a handle's update registers its declaration again under its id (below): the new registration replaces the old
  let replacing = false;
  function register(kind, presentation, spec, replace = replacing) {
    if (!spec || typeof spec !== 'object') throw new CodexModsError('Invalid', `ui.${kind} takes a spec object`);
    const id = spec.id;
    if (typeof id !== 'string' || !id) throw new CodexModsError('Invalid', `ui.${kind}: the rule needs an id`);
    const prev = live.get(id);
    if (prev && !replace) throw new CodexModsError('Conflict', `a rule with the id ${id} is registered already`);
    const desc = { kind, ...(presentation !== undefined ? { presentation } : {}) };
    // a name a kind takes as data is its data (a content renderer's `part` is its claim, not one of the app's parts)
    for (const k of META) if (spec[k] !== undefined && !FIELDS[kind].includes(k)) desc[k] = spec[k];
    const data = {}, fns = {}, callbacks = new Map();
    for (const f of FIELDS[kind]) {
      const v = spec[f];
      if (v === undefined) continue;
      if (hasMarker(v)) throw new CodexModsError('Invalid', `ui.${kind}: ${f} holds an object with only $fn, which the framework reserves`);
      if (!hasFunction(v)) data[f] = v;
      else if (o.realm === 'renderer') {
        fns[f] = v;
        // a mod command's title and keywords are the Host's too (its graph Command, E8.11); its run stays in this window (round 2); a
        // list filter's title and data the same (its keep stays here)
        if (f === 'command') data[f] = { title: v.title, ...(v.keywords !== undefined ? { keywords: v.keywords } : {}) };
        if (f === 'filter' || f === 'sort' || f === 'choices' || f === 'region' || f === 'destination' || f === 'sidebarView') data[f] = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== 'function'));
      } else data[f] = markCallbacks(kind, f, v, f, callbacks);
    }
    if (Object.keys(data).length) desc.data = data;
    if (callbacks.size) desc.callbacks = [...callbacks.keys()];
    // Every registration has its token: a host-realm rule's names its callbacks; a renderer rule's is this window's own registration, so
    // a run the Host sends here (a menu bar entry chosen, a Command run) names the one it came from (review 4, round 2)
    desc.reg = regToken();   // every registration's own (a host-realm one without callbacks too: a filter's on names it)
    const key = `${o.modId}/${id}`;
    // A renderer-realm rule applies in the windows its mod's module registered it in: its handle says so, with or without functions, once
    // the Host accepted it (an unaccepted registration never draws: until then this window draws the one it had: built review, round 2)
    let disposed = false;
    // A host-realm rule's callbacks: the Host calls them here, by path, with the env the page gives (bound before the rule is registered,
    // so the first click finds them).
    const served = callbacks.size && typeof o.channel.callbacks === 'function'
      ? o.channel.callbacks(id, desc.reg, (path, env) => {
        const fn = callbacks.get(path);
        if (typeof fn !== 'function') throw new CodexModsError('Unavailable', `no callback ${path}`);
        // a palette source's search and choose get their argument (the text, the chosen row), then the env
        return ARG_PATHS.has(path) ? fn(env?.arg, env?.env) : fn(env);
      })
      : null;
    if (callbacks.size && !served) throw new CodexModsError('Unavailable', `ui.${kind}: callbacks are not available here`);
    prev?.retire();
    let unsupported = [];
    const accepted = Promise.resolve().then(() => o.channel.register(desc)).then((answer) => {
      if (Array.isArray(answer?.unsupported)) unsupported = answer.unsupported;
      if (o.realm === 'renderer' && !disposed) o.local?.set(key, fns, desc.reg, desc);
      prev?.release();
      return true;
    }, (e) => {
      o.local?.delete(key);
      live.delete(id);
      try { served?.dispose(); } catch { /* the channel went */ }
      try { prev?.release(); } catch { /* the channel went */ }
      try { o.onRefused?.(id, e); } catch { /* the reporter's own fault */ }
      return false;
    });
    let retired = false;
    const handle = {
      accepted,
      dispose() {
        if (disposed) return;
        disposed = true;
        live.delete(id);
        o.local?.delete(key);
        accepted.then((ok) => (ok ? o.channel.dispose(id) : null)).catch(() => {}).finally(() => { try { served?.dispose(); } catch { /* the channel went */ } });
      },
      // a registration replaced by a newer one under the same id: no dispose of its own, its callbacks let go after the newer is accepted
      retire() { retired = true; disposed = true; },
      /** Disposed, or replaced by a newer registration under its id: what it hands out acts on nothing. */
      get disposed() { return disposed; },
      /** This registration's own token. */
      reg: desc.reg,
      ruleId: id,
      /** The parts it names that this build does not draw (public-hooks.md §3.10), once accepted. */
      get unsupported() { return unsupported; },
      release() { if (retired) { try { served?.dispose(); } catch { /* the channel went */ } } },
    };
    live.set(id, handle);
    return handle;
  }
  /** One of this mod's declarations acted on in a window, through the Host (the page answers): `{window}` names it, else the one in front. */
  function inWindow(id, op, opts) {
    if (typeof id !== 'string' || !id) return Promise.reject(new CodexModsError('Invalid', 'a declaration id is needed'));
    if (typeof o.channel.inWindow !== 'function') return Promise.reject(new CodexModsError('Unavailable', 'windows are not reachable here'));
    const { window, ...args } = opts && typeof opts === 'object' ? opts : {};
    return o.channel.inWindow(id, op, args, window ?? null);
  }
  /** `ui.decorate(<subject>, {id, badges?, label?, tooltip?, actions?, for?, in?, where?, priority?})`: a decorate rule in each place. */
  function decorateSubject(subject, spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', `ui.decorate(${subject}): the rule needs an id`);
    const places = Object.keys(DECORATION_PLACES[subject]);
    const within = spec.in === undefined ? places : listed(spec.in);
    if (!within.every((x) => places.includes(x))) throw new CodexModsError('Invalid', `ui.decorate(${subject}): in is among ${places.join(', ')}`);
    const kinds = DECORATION_KINDS.filter((k) => spec[k] !== undefined);
    if (!kinds.length) throw new CodexModsError('Invalid', `ui.decorate(${subject}): give badges, a label, a tooltip or actions`);
    const { in: _in, id, ...rest } = spec;
    const handles = [], drawn = new Set();
    for (const place of within) {
      const takes = DECORATION_PLACES[subject][place].filter((k) => kinds.includes(k));
      if (!takes.length) continue;
      const rid = `${id}.${place}`;
      if (rid.length > 64) { for (const h of handles) h.dispose(); throw new CodexModsError('Invalid', `ui.decorate(${subject}): an id of at most ${63 - place.length} characters`); }
      const fields = Object.fromEntries(Object.entries(rest).filter(([k]) => !DECORATION_KINDS.includes(k) || takes.includes(k)));
      try { handles.push(register('decorate', place, { ...fields, id: rid, for: spec.for ?? subject })); } catch (e) { for (const h of handles) h.dispose(); throw e; }
      for (const k of takes) drawn.add(k);
    }
    if (!handles.length) throw new CodexModsError('Invalid', `ui.decorate(${subject}): no place of it draws ${kinds.join(', ')}`);
    return {
      places: within.filter((p) => DECORATION_PLACES[subject][p].some((k) => kinds.includes(k))),
      /** The kinds given that no place draws (a tooltip on 21477): said, never dropped quietly. */
      unsupported: kinds.filter((k) => !drawn.has(k)),
      get accepted() { return Promise.all(handles.map((h) => h.accepted)).then((all) => all.every((x) => x === true)); },
      dispose() { for (const h of handles) h.dispose(); },
      get disposed() { return handles.every((h) => h.disposed); },
      /** Its rules' ids, one per place (an update drops the places it no longer draws in). */
      ruleIds: handles.map((h) => h.ruleId),
    };
  }
  const graph = () => {
    const g = o.graph?.();
    if (!g) throw new CodexModsError('Unavailable', 'reading and acting on presentations needs the graph (the graph permission)');
    return g;
  };
  const sameRef = (a, b) => !!a && !!b && a.type === b.type && a.provider === b.provider && a.id === b.id;
  /**
   * A section of this mod's on one of the app's settings pages (public-hooks.md §3.14): `{id, page, title?, render | settings}`, after
   * the page's own sections, in the app's own section with its title: the mod's component (renderer realm) or a card of rows for
   * the Settings it names (either realm; the app's or a mod's, as this mod may read them), each the framework's row for its kind.
   * `page` is the page's slug (`/settings/<slug>`; a page whose settings the graph has). One rule: SettingsPage's `section`.
   */
  function settingsSection(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.settings.section takes {id, page, title?, render | settings}');
    if (typeof spec.page !== 'string' || !SETTINGS_SLUG.test(spec.page)) throw new CodexModsError('Invalid', 'ui.settings.section: page is a settings page\'s slug (its route: /settings/<slug>)');
    if ((spec.render === undefined) === (spec.settings === undefined)) throw new CodexModsError('Invalid', 'ui.settings.section: give render or settings');
    if (spec.render !== undefined && (typeof spec.render !== 'function' || o.realm !== 'renderer')) throw new CodexModsError('Invalid', 'ui.settings.section: render is a component of the renderer realm (the host realm names settings)');
    const section = { ...(spec.title !== undefined ? { title: typeof spec.title === 'string' ? spec.title.trim() : spec.title } : {}), ...(spec.settings !== undefined ? { settings: spec.settings } : {}) };
    const why = settingsSectionWhy(section);
    if (why) throw new CodexModsError('Invalid', `ui.settings.section: ${why}`);
    return register('add', 'SettingsPage', { id: spec.id, slot: 'section', of: { type: 'SettingsSection', provider: 'codex', id: spec.page },
      items: [{ id: spec.id, ...section, ...(spec.render !== undefined ? { render: spec.render } : {}) }], ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
  }
  // the types' chains (from their reflection, read once): whether a subject's type is a type a declaration names, or a subtype of it
  let parentsOf = null;
  async function typeIsA(typeId, of) {
    if (typeId === of) return true;
    if (!parentsOf) {
      const types = await graph().types().catch(() => []);
      parentsOf = new Map((Array.isArray(types) ? types : []).map((t) => [t.id, t.parent ?? null]));
    }
    for (let t = parentsOf.get(typeId), n = 0; t && n < 16; t = parentsOf.get(t), n++) if (t === of) return true;
    return false;
  }

  // ---- notifications (public-hooks.md §3.14): the Host shows them, named as this mod; their actions' runs stay here
  const notes = new Map();   // notification id -> {runs: Map(action id -> run), subject}
  let noteSub = null;
  const NOTE_KINDS = new Set(['info', 'success', 'warning', 'error']);
  function noteSpec(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200) throw new CodexModsError('Invalid', 'ui.notify takes {title, body?, kind?, subject?, actions?, surface?, dedupe?}');
    if (spec.body !== undefined && (typeof spec.body !== 'string' || spec.body.length > 2000)) throw new CodexModsError('Invalid', 'ui.notify: body is at most 2000 characters');
    if (spec.kind !== undefined && !NOTE_KINDS.has(spec.kind)) throw new CodexModsError('Invalid', 'ui.notify: kind is info, success, warning or error');
    if (spec.subject !== undefined && !isRefShape(spec.subject)) throw new CodexModsError('Invalid', 'ui.notify: subject is a ref {type, provider, id}');
    if (spec.surface !== undefined && !['auto', 'desktop', 'toast'].includes(spec.surface)) throw new CodexModsError('Invalid', 'ui.notify: surface is auto, desktop or toast');
    if (spec.dedupe !== undefined && (typeof spec.dedupe !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(spec.dedupe))) throw new CodexModsError('Invalid', 'ui.notify: dedupe is an id (letters, digits, ".", "_", "-")');
    if (spec.sticky !== undefined && typeof spec.sticky !== 'boolean') throw new CodexModsError('Invalid', 'ui.notify: sticky is true or false');
    const actions = spec.actions === undefined ? [] : spec.actions;
    if (!Array.isArray(actions) || actions.length > 4 || !actions.every((a) => a && typeof a.id === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(a.id) && typeof a.title === 'string' && a.title.trim() && a.title.length <= 40 && typeof a.run === 'function')
      || new Set(actions.map((a) => a.id)).size !== actions.length) {
      throw new CodexModsError('Invalid', 'ui.notify: actions are at most 4 {id, title, run}, their ids distinct');
    }
    return { spec: { title: spec.title.trim(), ...Object.fromEntries(['body', 'kind', 'subject', 'surface', 'dedupe', 'sticky'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]])),
      actions: actions.map((a) => ({ id: a.id, title: a.title.trim() })) }, runs: new Map(actions.map((a) => [a.id, a.run])) };
  }
  /**
   * A notification, named as this mod by the framework: `{title, body?, kind?, subject?: ref, actions?: [{id, title, run}], surface?: 'auto'
   * | 'desktop' | 'toast', dedupe?, sticky?}`: the app's own toast in the window in front (two actions at most there) or the app's own desktop
   * notification (four), `auto` (the default) a toast while an app window is focused; one with the same `dedupe` replaces this mod's
   * earlier one. Clicking a desktop one opens its subject. `{id, update(patch), dismiss()}`; an action's run gets `{notification, action,
   * subject, window}`.
   */
  let noteHandles = 0;
  function notify(spec0) {
    if (typeof o.channel?.notify !== 'function') throw new CodexModsError('Unavailable', 'notifications are not available here');
    let cur = noteSpec(spec0);
    // one identity for the handle: each update replaces its earlier showing (its own dedupe when it gave none)
    const key = cur.spec.dedupe ?? `h${++noteHandles}-${Math.random().toString(36).slice(2, 10)}`;
    cur.spec.dedupe = key;
    if (!noteSub && typeof o.channel.notices === 'function') {
      noteSub = o.channel.notices((e) => {
        const n = e && notes.get(e.id);
        if (!n) return;
        if (e.gone) { notes.delete(e.id); return; }
        const run = n.runs.get(e.action);
        if (run) { try { const r = run({ notification: e.id, action: e.action, subject: n.subject ?? null, window: e.window ?? null }); Promise.resolve(r).catch((err) => o.onRefused?.(e.id, err)); } catch (err) { o.onRefused?.(e.id, err); } }
      });
    }
    let id = null, token, gone = false;
    // what the Host shows: its id, and this showing's token (dismiss ends this showing, never a later one of the same id)
    const show = () => Promise.resolve(o.channel.notify(cur.spec)).then((r) => {
      const nid = r && typeof r === 'object' ? r.id : r;
      token = r && typeof r === 'object' ? r.token : undefined;
      if (id && id !== nid) notes.delete(id);
      id = nid;
      notes.set(nid, { runs: cur.runs, subject: cur.spec.subject });
      if (gone) o.channel.notifyEnd(nid, token);
      return nid;
    });
    let shown = show();
    return {
      get id() { return id; },
      shown,
      /** Show it again with these fields changed (it replaces itself). */
      update(patch) {
        if (gone) return Promise.resolve(false);
        cur = noteSpec({ ...cur.spec, actions: cur.spec.actions.map((a) => ({ ...a, run: cur.runs.get(a.id) })), ...patch, dedupe: key });
        shown = shown.then(() => show());
        return shown.then(() => true);
      },
      dismiss() {
        if (gone) return Promise.resolve(false);
        gone = true;
        return shown.then((nid) => { notes.delete(nid); return o.channel.notifyEnd(nid, token); }).then(() => true, () => true);
      },
    };
  }

  // ---- the Dock (public-hooks.md §3.14): its badge and its attention, through the DockBadge presentation, as this mod
  const docks = new Set();   // this mod's badges, let go with it

  const isCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 99999;
  async function dockAct(operation, args) {
    const ref = (await graph().list('DockBadge'))[0]?.ref ?? null;
    if (!ref) throw new CodexModsError('Unavailable', 'the Dock is not available here');
    const out = await graph().invoke(ref, operation, args);
    if (out?.status && out.status !== 'done') throw new CodexModsError(out.reason === 'notAllowed' ? 'Denied' : 'Unavailable', out.message ?? out.error?.message ?? 'the Dock did not take it');
    return true;
  }
  function dockSpec(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.dock.badge takes {id, count: {type, where?} | value, combine?}');
    const hasCount = spec.count !== undefined, hasValue = spec.value !== undefined;
    if (hasCount === hasValue) throw new CodexModsError('Invalid', 'ui.dock.badge: give a count ({type, where?}) or a value');
    if (hasCount && (!spec.count || typeof spec.count !== 'object' || typeof spec.count.type !== 'string' || (spec.count.where !== undefined && (!spec.count.where || typeof spec.count.where !== 'object')))) {
      throw new CodexModsError('Invalid', 'ui.dock.badge: count is {type, where?}: how many instances the where keeps');
    }
    if (hasValue && spec.value !== null && !isCount(spec.value) && !(typeof spec.value === 'string' && spec.value.length > 0 && spec.value.length <= 16)) {
      throw new CodexModsError('Invalid', 'ui.dock.badge: value is a count (0 to 99999), text of at most 16 characters, or null');
    }
    const combine = spec.combine ?? 'replace';
    if (combine !== 'replace' && combine !== 'add') throw new CodexModsError('Invalid', 'ui.dock.badge: combine is replace or add');
    if (combine === 'add' && hasValue && typeof spec.value === 'string') throw new CodexModsError('Invalid', 'ui.dock.badge: only a count adds to the app\'s');
    return { id: spec.id, ...(hasCount ? { count: { type: spec.count.type, ...(spec.count.where ? { where: spec.count.where } : {}) } } : { value: spec.value }), combine };
  }
  /**
   * The Dock's badge: `count` is how many instances of a type its where keeps, as this mod may read them, kept current (none: the badge is
   * let go, the app's own shows); `value` a count or text; `combine: 'add'` adds a count to the app's own. The latest mod's shows; letting
   * go (dispose, or the mod stopping) gives the badge back. Its handle's `update(patch)` changes it.
   */
  function dockBadge(spec0) {
    let cur = dockSpec(spec0);
    if ([...docks].some((d) => d.id === cur.id)) throw new CodexModsError('Conflict', `a Dock badge with the id ${cur.id} is held already`);
    let view = null, members = new Set(), gone = false;
    const show = (n) => {
      if (gone) return;
      const v = n === null || n === 0 ? null : cur.combine === 'add' && typeof n === 'number' ? { add: n } : n;
      if (JSON.stringify(v) === JSON.stringify(handle.want) && handle.want !== undefined) return;
      handle.want = v;
      // each badge is its own holder (this mod's, by its id): the latest holder's shows, the one before when it lets go
      dockAct('_set', [v, cur.id]).catch((e) => o.onRefused?.(cur.id, e));
    };
    const follow = () => {
      try { view?.dispose(); } catch { /* gone */ }
      view = null; members = new Set();
      if (!cur.count) { show(cur.value); return; }
      view = graph().subscribe({ type: cur.count.type, ...(cur.count.where ? { where: cur.count.where } : {}) }, (m) => {
        if (m?.type === 'snapshot') members = new Set((m.items ?? []).filter((x) => !x.gone).map((x) => JSON.stringify([x.ref.type, x.ref.provider, x.ref.id])));
        else if (m?.type === 'delta' && m.event?.ref) {
          const k = JSON.stringify([m.event.ref.type, m.event.ref.provider, m.event.ref.id]);
          if (m.event.kind === 'removed') members.delete(k); else if (m.event.kind === 'added') members.add(k);
        } else return;
        show(members.size);   // the same count again is not sent again
      });
    };
    const handle = {
      want: undefined,
      get id() { return cur.id; },
      update(patch) {
        if (gone) return Promise.resolve(false);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CodexModsError('Invalid', 'update takes the fields to change');
        if (patch.id !== undefined && patch.id !== cur.id) throw new CodexModsError('Invalid', 'update cannot change a declaration\'s id');
        const next = { ...cur, ...patch };
        if (patch.count !== undefined) delete next.value;
        if (patch.value !== undefined) delete next.count;
        cur = dockSpec(next);
        follow();
        return Promise.resolve(true);
      },
      dispose() {
        if (gone) return Promise.resolve(false);
        gone = true;
        docks.delete(handle);
        try { view?.dispose(); } catch { /* gone */ }
        return dockAct('_set', [null, cur.id]).then(() => true, () => true);
      },
    };
    docks.add(handle);
    follow();
    return handle;
  }

  /** `ui.hide` of a subject (HIDE_PLACES): one rule in each place that lists or shows it, or its choices. */
  function hideSubject(subject, spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', `ui.hide(${subject}): the rule needs an id`);
    const { id, in: within0, where, of, ...rest } = spec;
    const places = HIDE_PLACES[subject];
    const within = within0 === undefined ? places : listed(within0);
    if (!within.every((x) => places.includes(x))) throw new CodexModsError('Invalid', `ui.hide(${subject}): in is among ${places.join(', ')}`);
    // chats and projects: out of the sidebar's listings, with the window's notice
    if (LISTED.has(subject)) {
      const { for: forType, ...own } = rest;
      if (forType !== undefined && forType !== subject) throw new CodexModsError('Invalid', `ui.hide(${subject}): for is ${subject}`);
      const listing = LISTED.get(subject);
      const h = register('add', listing, { ...own, id, slot: 'hidden', hide: { for: subject, ...(where !== undefined ? { where } : {}), ...(of !== undefined ? { of } : {}) } });
      return Object.assign(h, { places: [listing] });
    }
    const handles = [];
    for (const place of within) {
      const rid = places.length > 1 ? `${id}.${place}` : id;
      try { handles.push(register('hide', place, { ...rest, id: rid, for: spec.for ?? subject, ...(where !== undefined ? { where } : {}), ...(of !== undefined ? { of } : {}) })); }
      catch (e) { for (const h of handles) h.dispose(); throw e; }
    }
    return {
      places: within,
      get accepted() { return Promise.all(handles.map((h) => h.accepted)).then((all) => all.every((x) => x === true)); },
      dispose() { for (const h of handles) h.dispose(); },
      get disposed() { return handles.every((h) => h.disposed); },
      ruleIds: handles.map((h) => h.ruleId),
    };
  }

  /**
   * Text masked where content is shown (public-hooks.md §3.14): `content.redact({id, match, as?, sites?, for?, where?})`, every match of
   * `match` in the text of a message, reasoning, plan, file preview or review comment shown as `as` ('•••' by default): what is displayed
   * only (copying a message keeps its text). Either realm: data, no component. One rule: an `add` on ContentView's `redact`.
   */
  function contentRedact(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') throw new CodexModsError('Invalid', 'ui.content.redact takes {id, match, as?, sites?}');
    const redact = { match: patternOf(spec.match), ...(spec.as !== undefined ? { as: spec.as } : {}), ...(spec.sites !== undefined ? { sites: listed(spec.sites) } : {}) };
    const why = redactWhy(redact);
    if (why) throw new CodexModsError('Invalid', `ui.content.redact: ${why}`);
    return register('add', 'ContentView', { id: spec.id, slot: 'redact', redact, ...(spec.for !== undefined ? { for: spec.for } : {}),
      ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
  }

  const api = {
    /** Message content in either realm: masked text (`redact`); the renderer realm's `content` also draws parts with components. */
    content: Object.freeze({ redact: contentRedact }),
    /**
     * What is shown: Presentation instances, `{type?, window?, subject?}` (a Window's ref or id, a subject's ref): the graph's list, or
     * the subject's `presentations`. Each has its parent, window and subject in its links.
     */
    async _read(query = {}) {
      const g = graph();
      const q = query && typeof query === 'object' ? query : {};
      const type = typeof q.type === 'string' ? q.type : null;
      // A type is the graph's list (with its subtypes); a subject alone is its `presentations`.
      const list = q.subject && !type ? (await g.related(q.subject, 'presentations')) ?? [] : await g.list(type ?? 'Presentation');
      const win = q.window === undefined ? null : typeof q.window === 'object' ? q.window : { type: 'Window', provider: 'codexmods.windows', id: String(q.window) };
      return list.filter((p) => (!win || sameRef(p.links?.window, win)) && (!q.subject || sameRef(p.links?.subject, q.subject)));
    },
    /**
     * The app's own parts of a component (docs/design/public-hooks.md §3.10): `[{slot, part, title, for?, operation?, protected?,
     * optional?, supported}]`, the names `hide`, `decorate` (relabel), `replace` and `reorder` take; `supported`: this build draws it.
     */
    parts(presentation, opts) {
      if (typeof o.channel?.parts !== 'function') return Promise.reject(new CodexModsError('Unavailable', 'the parts are not available here'));
      return o.channel.parts(presentation, opts && typeof opts === 'object' && typeof opts.slot === 'string' ? opts.slot : null);
    },
    /** Do what the user can do on a presentation: one of its type's operations (select, open, focus, ...), as this mod. */
    _act: (ref, action, args = []) => graph().invoke(ref, action, Array.isArray(args) ? args : [args]),
    /**
     * Ask the user ("E7 in detail" decision 7): `{subject, purpose, title, message, actions: [{id, title}], until?}`, a Dialog in the
     * window they are in, named as this mod. Resolves once: `{choice, by: 'user' | 'requester'}` or `{cancelled: true, by, reason}`.
     */
    ask(spec) {
      if (typeof o.channel?.ask !== 'function') throw new CodexModsError('Unavailable', 'asking the user is not available here');
      // `signal` (an AbortSignal of the mod's): aborted, the question is withdrawn (cancelled, by the requester)
      const signal = spec && typeof spec === 'object' ? spec.signal : undefined;
      if (signal === undefined || signal === null) return o.channel.ask(spec);
      if (typeof signal.addEventListener !== 'function') throw new CodexModsError('Invalid', 'ui.ask: signal is an AbortSignal');
      if (signal.aborted) return Promise.resolve({ cancelled: true, by: 'requester', reason: 'withdrawn' });
      const token = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).padEnd(8, '0');
      const { signal: _s, ...rest } = spec;
      const onAbort = () => { void Promise.resolve(o.channel.askWithdraw?.(token)).catch(() => {}); };
      signal.addEventListener('abort', onAbort, { once: true });
      return Promise.resolve(o.channel.ask({ ...rest, withdraw: token })).finally(() => signal.removeEventListener?.('abort', onAbort));
    },
    notify,
    /**
     * Open in (public-hooks.md §3.14): `add({id, title, icon?, description?, run})`, an entry of the app's "Open in" menus (a chat's, a
     * project's, a file's), its run given what it opens (`env.subject`). One `ui.choices('ExternalApp', {add})`.
     */
    openIn: Object.freeze({
      add(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || typeof spec.title !== 'string' || !spec.title.trim() || typeof spec.run !== 'function') {
          throw new CodexModsError('Invalid', 'ui.openIn.add takes {id, title, icon?, description?, run}');
        }
        const entry = { id: spec.id, title: spec.title.trim(), ...Object.fromEntries(['icon', 'description'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]])), run: spec.run };
        return api.choices('ExternalApp', { id: spec.id, add: [entry], ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
    }),
    // a presentation type, or a subject concept: one rule in each place that presents it (graph-layers.md §3.4)
    decorate: (target, spec) => (Object.hasOwn(DECORATION_PLACES, target) ? decorateSubject(target, spec) : register('decorate', target, spec)),
    /**
     * Composer controls (docs/design/mod-surfaces.md §3.6), on every composer the app shows (a chat's, a side chat's, the new chat's)
     * unless `for`/`where` narrow them: `{id, title, icon?, run(env)}` is a button after the composer's own (env.draft is the composer's
     * Draft); `{id, place: 'toolbar' | 'pickers' | 'aboveInput' | 'belowInput', render}` (renderer realm) hosts a component there.
     */
    composer: Object.freeze({
      control(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') throw new CodexModsError('Invalid', 'ui.composer.control takes {id, title, run} or {id, place, render}');
        const base = { id: spec.id, ...(spec.for !== undefined ? { for: spec.for } : {}), ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) };
        if (spec.render !== undefined) {
          if (o.realm !== 'renderer') throw new CodexModsError('Invalid', 'ui.composer.control: a component is the renderer realm\'s; give {title, run} here');
          const place = spec.place ?? 'pickers';
          if (!['toolbar', 'pickers', 'aboveInput', 'belowInput'].includes(place)) throw new CodexModsError('Invalid', 'ui.composer.control: place is toolbar, pickers, aboveInput or belowInput');
          return register('host', 'Composer', { ...base, slot: place, render: spec.render });
        }
        if (typeof spec.title !== 'string' || !spec.title.trim() || typeof spec.run !== 'function') throw new CodexModsError('Invalid', 'ui.composer.control: a button has a title and run(env)');
        if (spec.place !== undefined && spec.place !== 'toolbar') throw new CodexModsError('Invalid', 'ui.composer.control: a button sits in the toolbar; another place takes a component');
        // public-hooks.md §3.14: its tooltip, whether it is turned off or on now, and a short badge (each changed in place by update)
        if (spec.tooltip !== undefined && (typeof spec.tooltip !== 'string' || spec.tooltip.length > 200)) throw new CodexModsError('Invalid', 'ui.composer.control: tooltip is at most 200 characters');
        for (const k of ['disabled', 'pressed']) if (spec[k] !== undefined && typeof spec[k] !== 'boolean') throw new CodexModsError('Invalid', `ui.composer.control: ${k} is true or false`);
        if (spec.badge !== undefined && !(typeof spec.badge === 'string' && spec.badge.length <= 8) && !(Number.isSafeInteger(spec.badge) && spec.badge >= 0)) throw new CodexModsError('Invalid', 'ui.composer.control: badge is a count or at most 8 characters');
        const state = Object.fromEntries(['icon', 'tooltip', 'disabled', 'pressed', 'badge'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]));
        return register('decorate', 'Composer', { ...base, actions: [{ id: spec.id, title: spec.title.trim(), ...state, run: spec.run }] });
      },
      /**
       * A slash command (mod-surfaces.md §3.6): `{id, name, title?, description?, arguments?, run(env)}` or `{..., prompt}`, a row of the app's
       * own slash menu on every composer; `run` gets the composer's Draft and thread, a `prompt` is inserted into the Draft. One rule: an
       * `add` on the composer's Palette (for Draft).
       */
      slash(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') throw new CodexModsError('Invalid', 'ui.composer.slash takes {id, name, run} or {id, name, prompt}');
        if (typeof spec.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(spec.name)) throw new CodexModsError('Invalid', 'ui.composer.slash: a name of lower-case letters, digits, ".", "_" and "-" (what the user types after /)');
        const run = typeof spec.run === 'function' ? spec.run : null;
        const prompt = typeof spec.prompt === 'string' && spec.prompt.trim() ? spec.prompt : null;
        if (!!run === !!prompt) throw new CodexModsError('Invalid', 'ui.composer.slash: either run(env) or a prompt');
        // public-hooks.md §3.14: other names it is found by, a heading of its own, only into an empty composer, only on the composers whose
        // Draft a where keeps
        if (spec.aliases !== undefined && (!Array.isArray(spec.aliases) || spec.aliases.length > 5 || spec.aliases.some((a) => typeof a !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(a)))) {
          throw new CodexModsError('Invalid', 'ui.composer.slash: aliases are up to 5 more names');
        }
        if (spec.group !== undefined && (typeof spec.group !== 'string' || !spec.group.trim() || spec.group.length > 40)) throw new CodexModsError('Invalid', 'ui.composer.slash: group is a heading of at most 40 characters');
        if (spec.when !== undefined && spec.when !== 'empty' && spec.when !== 'any') throw new CodexModsError('Invalid', 'ui.composer.slash: when is empty or any');
        if (spec.where !== undefined && (!spec.where || typeof spec.where !== 'object' || Array.isArray(spec.where))) throw new CodexModsError('Invalid', 'ui.composer.slash: where is a where on the composer\'s Draft');
        const slash = { name: spec.name, ...(typeof spec.title === 'string' ? { title: spec.title } : {}), ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
          ...(typeof spec.arguments === 'string' ? { arguments: spec.arguments } : {}), ...(spec.aliases ? { aliases: [...spec.aliases] } : {}), ...(spec.group ? { group: spec.group.trim() } : {}),
          ...(spec.when === 'empty' ? { whenEmpty: true } : {}), ...(prompt ? { prompt } : { run }) };
        return register('add', 'Palette', { id: spec.id, for: 'Draft', slot: 'resultSources', slash, ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
      /**
       * An attachment source (public-hooks.md §3.14): `{id, title, description?, pick(env)}`, a row of the "Add" section of every composer's
       * "+" and "@" list, as the app's own (attach files, a screenshot). Choosing it runs `pick(env)` (`env.draft`: that composer's Draft),
       * whose attachments (one or a list of at most 20: `{text, name}`, `{url, title}`, a Skill's ref, a file's path) are attached to the Draft
       * as the mod's own calls (`Draft.attach`): the Host takes a source only from a mod granted that. One rule: an `add` on the composer's
       * Palette (for Draft) with `attach`.
       */
      attachSource(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.composer.attachSource takes {id, title, pick}');
        if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 60) throw new CodexModsError('Invalid', 'ui.composer.attachSource: a title of at most 60 characters');
        if (typeof spec.pick !== 'function') throw new CodexModsError('Invalid', 'ui.composer.attachSource: pick(env) gives what to attach');
        if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > 200)) throw new CodexModsError('Invalid', 'ui.composer.attachSource: a description of at most 200 characters');
        const run = async (env) => {
          const draft = env?.draft;
          if (!draft || typeof draft !== 'object') throw new CodexModsError('Unavailable', 'no composer to attach to');
          // the window and pane it was chosen in, taken before `pick` runs: every attachment goes to that very composer, or to none if it has gone
          const at = { ...(env?.window && typeof env.window === 'object' ? { window: env.window } : {}), ...(typeof env?.pane === 'string' ? { pane: env.pane } : {}) };
          const got = await spec.pick(env);
          const list = got === undefined || got === null ? [] : Array.isArray(got) ? got : [got];
          if (list.length > 20) throw new CodexModsError('Invalid', `the attachment source ${spec.id} gave more than 20 attachments`);
          const out = [];
          for (const a of list) out.push(await graph().invoke(draft, 'attach', Object.keys(at).length ? [a, at] : [a]));
          return out;
        };
        const attach = { title: spec.title.trim(), ...(spec.description !== undefined ? { description: spec.description } : {}), ...(spec.icon !== undefined ? { icon: spec.icon } : {}) };
        return register('add', 'Palette', { id: spec.id, for: 'Draft', slot: 'resultSources', attach, items: [{ id: spec.id, title: attach.title, run }],
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
      /**
       * An inline suggestion (reference-mods.md RM8): `{id, provide(env), debounceMs?, minChars?}`. When the user pauses at the end of a line
       * in any composer, `provide` is asked (env.before and env.after the text around the caret, env.draft and env.thread the composer's)
       * and its answer, a string, is shown as ghost text after the caret: Tab takes it, Escape leaves it. One rule: an `add` on the
       * composer's Palette (for Draft); the first source in the user's order is asked.
       */
      suggest(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.composer.suggest takes {id, provide}');
        if (typeof spec.provide !== 'function') throw new CodexModsError('Invalid', 'ui.composer.suggest: provide(env) gives the suggestion (a string, or null)');
        const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
        for (const [k, min, max] of [['debounceMs', 150, 3000], ['minChars', 1, 200]]) {
          if (spec[k] !== undefined && int(spec[k], min, max) === undefined) throw new CodexModsError('Invalid', `ui.composer.suggest: ${k} is a whole number from ${min} to ${max}`);
        }
        const suggest = { provide: spec.provide, ...(spec.debounceMs !== undefined ? { debounceMs: spec.debounceMs } : {}), ...(spec.minChars !== undefined ? { minChars: spec.minChars } : {}) };
        return register('add', 'Palette', { id: spec.id, for: 'Draft', slot: 'resultSources', suggest, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
      /**
       * A mention source (mod-surfaces.md §3.6): a section of the app's own "@" list on every composer, its rows from `search(query, env)`
       * (env.draft, env.thread; debounced, an older answer never replacing a newer one, at most 3 s in the host realm). A row inserts the
       * app's own file chip (`insert: {file}`), a link or text (default: its title). One rule: an `add` on the composer's Palette (for Draft).
       */
      mention(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') throw new CodexModsError('Invalid', 'ui.composer.mention takes {id, title, search}');
        if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 60) throw new CodexModsError('Invalid', 'ui.composer.mention: a title of at most 60 characters');
        if (typeof spec.search !== 'function') throw new CodexModsError('Invalid', 'ui.composer.mention: search(query, env) gives its rows');
        if (spec.position !== undefined && spec.position !== 'first' && spec.position !== 'last') throw new CodexModsError('Invalid', 'ui.composer.mention: position is first or last');
        const int = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : undefined);
        const mention = { title: spec.title.trim(), search: spec.search, ...(spec.position ? { position: spec.position } : {}),
          ...(int(spec.minQuery, 20) !== undefined ? { minQuery: int(spec.minQuery, 20) } : {}), ...(int(spec.limit, 10) ? { limit: int(spec.limit, 10) } : {}),
          ...(int(spec.debounceMs, 2000) !== undefined ? { debounceMs: int(spec.debounceMs, 2000) } : {}) };
        return register('add', 'Palette', { id: spec.id, for: 'Draft', slot: 'resultSources', mention, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
    }),
    /**
     * Menu bar entries (docs/design/mod-surfaces.md §3.4): `{id, title, in: 'file' | 'edit' | 'view' | 'window' | 'help' | {menu, before?},
     * keys?, type?: 'item' | 'checkbox' | 'radio', checked?, enabled?, visible?, run(env)}`, in a section of the mod's own at the end of that
     * menu (or a menu of the mod's own before Window). `keys` is held if no one holds it (the app first, then earlier mods); `update(patch)`
     * changes the entry in place. One rule: an `add` on the bar's Menu (for the App).
     */
    menus: Object.freeze({
      add(spec) {
        const item = (sp) => {
          if (!sp || typeof sp !== 'object' || typeof sp.id !== 'string') throw new CodexModsError('Invalid', 'ui.menus.add takes {id, title, in, run}');
          if (typeof sp.title !== 'string' || !sp.title.trim() || sp.title.length > 80) throw new CodexModsError('Invalid', 'ui.menus.add: a title of at most 80 characters');
          const where = sp.in;
          const okIn = ['file', 'edit', 'view', 'window', 'help'].includes(where)
            || (where && typeof where === 'object' && typeof where.menu === 'string' && where.menu.trim() && where.menu.length <= 40 && (where.before === undefined || where.before === 'window' || where.before === 'help'));
          if (!okIn) throw new CodexModsError('Invalid', 'ui.menus.add: in is file, edit, view, window, help or {menu, before?}');
          if (typeof sp.run !== 'function') throw new CodexModsError('Invalid', 'ui.menus.add: an entry runs run(env)');
          if (sp.keys !== undefined && (typeof sp.keys !== 'string' || sp.keys.length > 40)) throw new CodexModsError('Invalid', 'ui.menus.add: keys is an accelerator such as CmdOrCtrl+Alt+N');
          const type = sp.type === 'checkbox' || sp.type === 'radio' ? sp.type : undefined;
          return { id: sp.id, title: sp.title.trim(), in: typeof where === 'string' ? where : { menu: where.menu.trim(), ...(where.before ? { before: where.before } : {}) },
            ...(sp.keys ? { keys: sp.keys } : {}), ...(typeof sp.layout === 'string' ? { layout: sp.layout } : {}), ...(type ? { type } : {}), ...(type && sp.checked === true ? { checked: true } : {}),
            ...(sp.enabled === false ? { enabled: false } : {}), ...(sp.visible === false ? { visible: false } : {}) };
        };
        const ruleOf = (sp, replace) => {
          const it = item(sp);
          const base = { id: sp.id, for: 'App', slot: 'groups', ...(sp.priority !== undefined ? { priority: sp.priority } : {}) };
          // the host realm's run is a callback in its worker; the renderer realm's stays in this window's page (`menuRun`)
          return o.realm === 'host' ? register('add', 'Menu', { ...base, items: [{ ...it, run: sp.run }] }, replace)
            : register('add', 'Menu', { ...base, items: [it], menuRun: sp.run }, replace);
        };
        let current = { ...spec };
        let h = ruleOf(current, false);
        const handle = {
          get accepted() { return h.accepted; },
          /** Change the entry in place: its title, keys, enabled, visible or checked. */
          update(patch) { current = { ...current, ...(patch && typeof patch === 'object' ? patch : {}), id: current.id, run: current.run, in: current.in }; h = ruleOf(current, true); return h.accepted; },
          dispose() { h.dispose(); },
        };
        return handle;
      },
    }),
    /**
     * Context menu entries (docs/design/mod-surfaces.md §3.5): `{id, for, where?, title, run(env)}`, an entry in every menu the app shows for
     * a subject of that type (a chat's row and header menus; a project's; a file's or folder's in the trees and wherever it is referenced; a
     * panel tab's; a scheduled task's "..." menu), in a section of the mod's
     * own at the menu's end; `env.subject` is what it was opened on. One rule: an `add` on Menu's `groups` for that type.
     */
    /**
     * Mod commands (mod-surfaces.md P5, the v2 form; both realms): `{id, title, keys?, keywords?, run(env)}`: a row of the app's palette in
     * its "Mod commands" group (the mod's name beside it), and with `keys` a hidden entry of the menu bar's
     * View menu that holds the chord (P4: held if no one holds it; in every window, focus anywhere). Two rules, one handle.
     */
    commands: Object.freeze({
      /**
       * A command (public-hooks.md §3.14): `{id, title, run, keys?: accelerator | accelerator[], keywords?, description?, group?, icon?,
       * when?, appliesTo?, where?}`: a row of the palette (in its `group`, the mods' group by default; `description` beside its mod's name),
       * each of its key chords a hidden menu bar entry. `when` is a where on the Window it is offered in (`{'current.type': 'CodexThread'}`);
       * `appliesTo` a subject type: offered only while the window shows one (that `where` keeps), and in that subject's context menus;
       * its run's `env.subject` is that subject.
       */
      add(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.commands.add takes {id, title, run}');
        if (spec.id.length > 59) throw new CodexModsError('Invalid', 'ui.commands.add: an id of at most 59 characters');
        if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 80) throw new CodexModsError('Invalid', 'ui.commands.add: a title of at most 80 characters');
        if (typeof spec.run !== 'function') throw new CodexModsError('Invalid', 'ui.commands.add: a command runs run(env)');
        const chords = spec.keys === undefined ? [] : Array.isArray(spec.keys) ? spec.keys : [spec.keys];
        if (chords.length > 4 || chords.some((k) => typeof k !== 'string' || !k || k.length > 40)) throw new CodexModsError('Invalid', 'ui.commands.add: keys is an accelerator such as CmdOrCtrl+Alt+N, or up to 4 of them');
        for (const [k, max] of [['description', 120], ['group', 40], ['icon', 64]]) {
          if (spec[k] !== undefined && (typeof spec[k] !== 'string' || !spec[k].trim() || spec[k].length > max)) throw new CodexModsError('Invalid', `ui.commands.add: ${k} is text of at most ${max} characters`);
        }
        for (const k of ['when', 'where']) if (spec[k] !== undefined && (!spec[k] || typeof spec[k] !== 'object' || Array.isArray(spec[k]))) throw new CodexModsError('Invalid', `ui.commands.add: ${k} is a where (an object)`);
        if (spec.appliesTo !== undefined && (typeof spec.appliesTo !== 'string' || !spec.appliesTo)) throw new CodexModsError('Invalid', 'ui.commands.add: appliesTo is a subject type');
        if (spec.where !== undefined && spec.appliesTo === undefined) throw new CodexModsError('Invalid', 'ui.commands.add: where is on the subject appliesTo names');
        const keywords = Array.isArray(spec.keywords) ? spec.keywords.filter((k) => typeof k === 'string' && k).slice(0, 10).map((k) => k.slice(0, 60)) : [];
        const extra = Object.fromEntries(['description', 'group', 'icon', 'when', 'appliesTo', 'where'].filter((k) => spec[k] !== undefined).map((k) => [k, typeof spec[k] === 'string' ? spec[k].trim() : spec[k]]));
        const row = register('add', 'Palette', { id: spec.id, slot: 'resultSources', ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
          command: { title: spec.title.trim(), ...(keywords.length ? { keywords } : {}), ...extra, run: spec.run } });
        // the same conditions wherever it runs (a key chord, a context menu; the page checks the palette's row): its `when` on the window it
        // runs in, the subject it applies to (`where` on it), each read as this mod may (one it may not read: it does not run); its run
        // gets that subject
        for (const w of [spec.when, spec.where]) if (w !== undefined) { try { compileWhere(w); } catch (e) { throw new CodexModsError('Invalid', `ui.commands.add: ${e?.message ?? e}`); } }
        // whether a where holds on an instance as the Host reads it for this mod (its relations and attached data too, as the palette does)
        const holds = async (ref, where) => (await graph().list(ref.type, where)).some((x) => x.ref.provider === ref.provider && x.ref.id === ref.id);
        const guarded = (subjectOf) => (!spec.when && !spec.appliesTo ? spec.run : async (env) => {
          const g = graph();
          const win = env?.window ? await g.resolve(env.window) : null;
          if (spec.when && (!win || win.gone || !(await holds(win.ref, spec.when)))) return undefined;
          let subjectRef = env?.subject ?? null;
          if (spec.appliesTo) {
            const ref = subjectOf(env, win);
            const cur = ref ? await g.resolve(ref) : null;
            if (!cur || cur.gone || !(await typeIsA(cur.ref.type, spec.appliesTo)) || (spec.where && !(await holds(cur.ref, spec.where)))) return undefined;
            subjectRef = cur.ref;
          }
          return spec.run({ ...env, subject: subjectRef });
        });
        const more = [];
        // declared again (its handle's update): its own entries go first, then come back as this declaration says them
        const own = new RegExp(`^${spec.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(keys\\d*|menu)$`);   // its own entries, exactly
        if (replacing) for (const rid of [...live.keys()]) if (own.test(rid)) live.get(rid)?.dispose();
        try {
          // a key chord: the subject the window shows
          const chordRun = guarded((env, win) => win?.state?.current ?? null);
          chords.forEach((k, i) => more.push(api.menus.add({ id: `${spec.id}.keys${i ? i + 1 : ''}`, title: spec.title.trim(), in: 'view', keys: k, visible: false, run: chordRun })));
          // a command that applies to a subject is that subject's too: in its context menus (the subject the menu was opened on)
          if (spec.appliesTo) more.push(api.contextMenu.add({ id: `${spec.id}.menu`, for: spec.appliesTo, ...(spec.where ? { where: spec.where } : {}), title: spec.title.trim(), run: guarded((env) => env?.subject ?? null) }));
        } catch (e) { row.dispose(); for (const m of more) m.dispose(); throw e; }
        return {
          // accepted when all are: the row and its entries (review 4)
          get accepted() { return Promise.all([row.accepted, ...more.map((m) => m.accepted)]).then((all) => all.every((a) => a === true)); },
          dispose() { row.dispose(); for (const m of more) m.dispose(); },
          get disposed() { return row.disposed; },
          // its rules, so an update drops the ones it no longer has (a key chord taken away)
          ruleIds: [spec.id, ...chords.map((_, i) => `${spec.id}.keys${i ? i + 1 : ''}`), ...(spec.appliesTo ? [`${spec.id}.menu`] : [])],
          // what this build cannot draw: said, never dropped quietly (a palette row has no icon on 21477)
          unsupported: spec.icon !== undefined ? ['icon'] : [],
        };
      },
    }),
    /**
     * Starting points (public-hooks.md §3.14): `newThread.starter({id, title, description?, icon?, spec, in?, where?})`, a new chat from
     * `spec` (a ThreadSpec, or `(env) => ThreadSpec`) in the new chat page's starters above its composer ('newThread'), the palette's "New
     * chat" group ('palette') and a project's context menu ('project', `where` on the Project); all three unless `in` says. Choosing one
     * starts it in the project it was chosen for (the project whose menu it is; else the new chat's project; none: a chat of no project)
     * and opens it unless the spec says `open: false`. A spec that sends asks the user first, as `Project.newThread` does. Its chats are
     * the mod's own calls: the Host takes a starter only from a mod granted `graph.act` for `Project.newThread` and `Agent.newThread`. One
     * rule on NewThreadView `starters` is its declaration (where it is offered; drawn on the new chat page when that is one), and the
     * palette's row and the project menus' entry go with it.
     */
    /**
     * Where a link the user opens goes (public-hooks.md §3.14): `{id, where?, open: 'app' | 'browser' | 'none'}` or `{id, where?, run(env)}`.
     * `where` is on the link `{url, scheme, host, path, local, from}` (`from`: message, terminal, pullRequest or app); the mods' routes
     * are tried in the user's order of their mods and the first that takes it decides: `app` opens it in the app's own browser (where the
     * app has one), `browser` in the default browser, each only when the user did not choose where (a plain click; a modifier or a menu's
     * "Open in" stays theirs); `none` does not open it, however it was asked for, and the window says which mod stopped it; `run(env)`
     * (`{link, window, thread}`) is the mod opening it itself, for a plain click on a link from a chat it may read (one whose chat the
     * app does not say: only a mod that may read every chat) (one that did not run leaves it to the app; one that may have run keeps it). Links the app routes itself (codex:, chatgpt.com)
     * are only ever stopped. Links the user opens from the app's pages: not the link menu's "New tab" and "New window" on a chat's link,
     * links inside the app's browser's own pages, a file's path, or a link from outside the app.
     */
    links: Object.freeze({
      route(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.links.route takes {id, where?, open} or {id, where?, run}');
        if (spec.run !== undefined && typeof spec.run !== 'function') throw new CodexModsError('Invalid', 'ui.links.route: run(env) is a function');
        const route = { ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.open !== undefined ? { open: spec.open } : {}), ...(spec.run ? { handles: true } : {}) };
        const why = linkRouteWhy(route);
        if (why) throw new CodexModsError('Invalid', `ui.links.route: ${why}`);
        return register('add', 'Window', { id: spec.id, slot: 'links', route, ...(spec.run ? { items: [{ id: spec.id, run: spec.run }] } : {}),
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
    }),
    newThread: Object.freeze({
      starter(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.newThread.starter takes {id, title, spec}');
        if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 60) throw new CodexModsError('Invalid', 'ui.newThread.starter: a title of at most 60 characters');
        const plain = spec.spec && typeof spec.spec === 'object' && !Array.isArray(spec.spec);
        if (typeof spec.spec !== 'function' && !plain) throw new CodexModsError('Invalid', 'ui.newThread.starter: spec is a ThreadSpec or (env) => ThreadSpec');
        const within = spec.in === undefined ? STARTER_PLACES : listed(spec.in);
        if (!within.length || !within.every((x) => STARTER_PLACES.includes(x))) throw new CodexModsError('Invalid', `ui.newThread.starter: in is among ${STARTER_PLACES.join(', ')}`);
        if (spec.description !== undefined && (typeof spec.description !== 'string' || !spec.description.trim() || spec.description.length > 120)) throw new CodexModsError('Invalid', 'ui.newThread.starter: a description of 1 to 120 characters');
        const title = spec.title.trim();
        // the chat it starts, in the window it was chosen in: in the project chosen (a project's menu), else the new chat's (the framework
        // says it for the new chat page's button; else read as this mod: one it may not read is refused, never taken for none), else none
        // (Codex's agent starts a chat of no project)
        const start = async (env, project) => {
          const g = graph();
          if (!g) throw new CodexModsError('Unavailable', 'the graph is not reachable here');
          const made = typeof spec.spec === 'function' ? await spec.spec(env ?? {}) : spec.spec;
          if (!made || typeof made !== 'object' || Array.isArray(made)) throw new CodexModsError('Invalid', `the starter ${spec.id} gave no ThreadSpec`);
          let where = project;
          if (!where && env && Object.hasOwn(env, 'project')) where = env.project ?? null;
          else if (!where) {
            const draft = await g.resolve(NEW_CHAT_DRAFT).catch(() => null);
            if (!draft) throw new CodexModsError('Unavailable', 'the new chat\'s project cannot be read (graph.read for Draft): choose the starter from a project\'s menu or the new chat page');
            where = draft.state?.target?.project ?? null;
          }
          const window = env?.window && typeof env.window === 'object' ? { window: env.window } : {};
          return g.invoke(where ?? CODEX_AGENT, 'newThread', [{ open: true, ...window, ...made }]);
        };
        // its declaration: the new chat page's entry (drawn there only when offered there), which the Host checks for the grants its run needs;
        // what it says is data (the Host reads it in either realm), its run the entry's
        const starter = { title, in: within, ...(spec.description !== undefined ? { tooltip: spec.description } : {}), ...(spec.icon !== undefined ? { icon: spec.icon } : {}) };
        const anchor = register('add', 'NewThreadView', { id: spec.id, slot: 'starters', starter, ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
          items: [{ id: spec.id, title, run: (env) => start(env, null) }] });
        const handles = [anchor];
        try {
          if (within.includes('palette')) {
            handles.push(api.commands.add({ id: `${spec.id}.palette`, title: `New chat: ${title}`, group: 'New chat', ...(spec.description !== undefined ? { description: spec.description } : {}), run: (env) => start(env, null) }));
          }
          if (within.includes('project')) {
            handles.push(api.contextMenu.add({ id: `${spec.id}.project`, for: 'Project', ...(spec.where !== undefined ? { where: spec.where } : {}), title: `New chat: ${title}`,
              run: (env) => start(env, env?.subject && typeof env.subject === 'object' ? env.subject : null) }));
          }
        } catch (e) { for (const h of handles) h.dispose(); throw e; }
        // one refused (the grants its run needs, a place this mod may not present in): all of it goes, never a part of it left behind
        let refused = false;
        const settled = Promise.all(handles.map((h) => h.accepted)).then((all) => {
          const ok = all.every((x) => x === true);
          if (!ok) { refused = true; for (const h of handles) h.dispose(); }
          return ok;
        });
        return {
          places: within,
          get accepted() { return settled; },
          dispose() { for (const h of handles) h.dispose(); },
          get disposed() { return refused || handles.every((h) => h.disposed); },
          ruleIds: handles.flatMap((h) => h.ruleIds ?? [h.ruleId]),
          unsupported: spec.icon !== undefined && within.includes('palette') ? ['icon'] : [],
        };
      },
    }),
    /** The Dock (§3.14): its badge (`badge(spec)`) and `attention(kind?)`: its icon bounces once ('informational') or until the app comes forward ('critical'). */
    dock: Object.freeze({ badge: dockBadge, attention: (kind = 'informational') => dockAct('_attention', [kind]) }),
    /**
     * A status (public-hooks.md §3.14): `{id, place, text?, icon?, tone?, tooltip?, meter?: {value, max?}, run?, subject?, when?, for?, where?,
     * priority?}`, a short live reading in the window's title bar (`titleBar`), the sidebar's footer (`sidebarFooter`) or a composer's footer
     * (`composer`), drawn the app's way: a button when it has `run`, text otherwise. It reads its place's subject (a composer's Draft; the
     * title bar's chat when `for` names one, its App otherwise; the sidebar's App) or the `subject` it names: text, tooltip and meter may
     * be live (`{{path}}`, `{bind}`), `when` shows it only while its subject holds. One rule: an `add` on that place's `status` slot.
     */
    status(spec) {
      if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.status takes {id, place, text?, icon?, tone?, tooltip?, meter?, run?, subject?, when?, for?, where?}');
      if (!STATUS_PLACES.includes(spec.place)) throw new CodexModsError('Invalid', `ui.status: place is one of ${STATUS_PLACES.join(', ')}`);
      const status = Object.fromEntries(['text', 'icon', 'tone', 'tooltip', 'meter', 'when', 'run'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]));
      if (status.run !== undefined && typeof status.run !== 'function') throw new CodexModsError('Invalid', 'ui.status: run is a function');
      const why = statusWhy(status);
      if (why) throw new CodexModsError('Invalid', `ui.status: ${why}`);
      if (spec.subject !== undefined && !isRefShape(spec.subject)) throw new CodexModsError('Invalid', 'ui.status: subject is a ref {type, provider, id}');
      // the title bar shows a chat's status on its page (the chat's ThreadHeader), the window's on every page
      const presentation = spec.place === 'sidebarFooter' ? 'Sidebar' : spec.place === 'composer' ? 'Composer' : spec.for !== undefined ? 'ThreadHeader' : 'Window';
      return register('add', presentation, { id: spec.id, slot: 'status', items: [{ id: spec.id, ...status }], ...(spec.subject !== undefined ? { subject: spec.subject } : {}),
        ...Object.fromEntries(['for', 'where', 'priority'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]])) });
    },
    // a section on an app settings page, in either realm (the renderer realm's `settings` adds its own pages)
    settings: Object.freeze({ section: settingsSection }),
    /**
     * Themes (public-hooks.md §3.14, H7y): `add({id, title, description?, light?, dark?})`, each variant `{surface, ink, accent, contrast?,
     * added?, removed?, skill?, translucent?, fonts?: {ui?, code?}, code?}` (colours #rrggbb; `code` one of the app's code themes). Listed
     * on the app's Appearance page; the user turns one on there, and it is written as the app's own appearance settings (a theme of one
     * variant sets the appearance too) until the user turns it off, changes those settings, or the mod stops. One rule: SettingsPage's `theme`.
     */
    theme: Object.freeze({
      add(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.theme.add takes {id, title, light?, dark?}');
        const theme = Object.fromEntries(['title', 'description', 'light', 'dark'].filter((k) => spec[k] !== undefined).map((k) => [k, k === 'title' && typeof spec.title === 'string' ? spec.title.trim() : spec[k]]));
        const why = themeWhy(theme);
        if (why) throw new CodexModsError('Invalid', `ui.theme.add: ${why}`);
        return register('add', 'SettingsPage', { id: spec.id, slot: 'theme', of: { type: 'SettingsSection', provider: 'codex', id: 'appearance' }, items: [{ id: spec.id, ...theme }] });
      },
    }),
    /**
     * Choices (public-hooks.md §3.11): what the pickers offer of a subject, keyed by the subject, not the picker. `of`: 'Model',
     * {setting: 'effort'}, {setting: 'access'}, 'SlashCommand', 'ExternalApp', 'Environment'; `{id, in?, hide?, order?, label?, add?}`:
     * `hide` ids, a where on the offered subject or (renderer realm) a test; `order` ids first; `label` {id: text | {title, description}};
     * `add` entries `{id, title, description?, run}` whose choice runs here (never the app's choice). The selected entry always stays.
     * The handle's `unsupported` says what this framework does not do yet for that subject. One rule: an `add` on Choices' subject.
     */
    choices(of, spec) {
      const subject = typeof of === 'string' ? of : of && typeof of === 'object' && typeof of.setting === 'string' ? of.setting : null;
      if (!CHOICE_SUBJECTS.includes(subject)) throw new CodexModsError('Invalid', `ui.choices: of is 'Model', {setting: 'effort'}, {setting: 'access'}, 'SlashCommand', 'ExternalApp' or 'Environment'`);
      if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.choices takes (of, {id, in?, hide?, order?, label?, add?})');
      if (spec.where !== undefined || spec.for !== undefined) throw new CodexModsError('Invalid', 'ui.choices: a choice applies in every place it names (in); narrowing it by the place\'s subject is not built');
      if (typeof spec.hide === 'function' && o.realm !== 'renderer') throw new CodexModsError('Invalid', 'ui.choices: a hide test is the renderer realm\'s (the host realm gives ids or a where)');
      const choices = Object.fromEntries(['in', 'hide', 'order', 'label'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]));
      const why = choicesWhy({ ...choices, hide: typeof choices.hide === 'function' ? undefined : choices.hide });
      if (why) throw new CodexModsError('Invalid', `ui.choices: ${why}`);
      const add = spec.add === undefined ? [] : spec.add;
      if (!Array.isArray(add) || add.length > 10 || !add.every((a) => a && typeof a.id === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(a.id) && typeof a.title === 'string' && a.title.trim() && a.title.length <= 120 && typeof a.run === 'function'
        && (a.description === undefined || typeof a.description === 'string'))) throw new CodexModsError('Invalid', 'ui.choices: add is at most 10 {id, title, description?, run}');
      const h = register('add', 'Choices', { id: spec.id, slot: subject, choices, ...(add.length ? { items: add.map((a) => ({ id: a.id, title: a.title.trim(), ...(a.description ? { description: a.description } : {}), run: a.run })) } : {}),
        ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      const answered = Object.getOwnPropertyDescriptor(h, 'unsupported')?.get;
      Object.defineProperty(h, 'unsupported', { configurable: true, enumerable: true, get: () => [...CHOICES_NOT_BUILT[subject], ...(answered ? answered() : [])] });
      return h;
    },
    /**
     * A banner above every page (graph-layers.md §3.1): `{id, render, where?, priority?}`, the app's own page banner after its own content
     * (sugar for `host('Window', {slot: 'banner'})`; renderer realm: a component).
     */
    banner(spec) {
      if (!spec || typeof spec !== 'object' || typeof spec.render !== 'function') throw new CodexModsError('Invalid', 'ui.banner takes {id, render}');
      if (o.realm !== 'renderer') throw new CodexModsError('Invalid', 'ui.banner renders a component: register it from the renderer realm');
      const { render, ...rest } = spec;
      return register('host', 'Window', { ...rest, slot: 'banner', render });
    },
    /**
     * A filter over one of the app's lists (public-hooks.md §3.12): `filter(list, {id, title, where?, keep?, threads?, for?})`, off until
     * the mod turns it on in a window (`on({window?})`: the window named, else the host realm's window in front or the renderer realm's
     * own; `off()`). `list`: 'sidebar' (the chats; `where` may be text, a chat's title or preview; `threads`: the chats to list),
     * 'transcript' (a chat's records: its steps and messages, or the type `for` names, a Step, Message or Turn type; one under way is
     * never left out), 'files' (the file tree: each File's `path` and `name`) or 'changes' (the Changes list and its diffs: each changed
     * file's `path` and `kind`). With several on, an item is listed when every one keeps it; the list's notice names each, and the user's
     * "Show all" turns them all off in that window. `keep(item)`: the renderer realm's own test. A filter stays on through `update`.
     */
    filter(list, spec) {
      const presentation = FILTER_LISTS[list];
      if (!presentation) throw new CodexModsError('Invalid', `ui.filter: the list is one of ${Object.keys(FILTER_LISTS).join(', ')}`);
      const what = `ui.filter('${list}')`;
      if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', `${what} takes {id, title, where?, keep?${list === 'sidebar' ? ', threads?' : list === 'transcript' ? ', for?' : ''}}`);
      if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 80) throw new CodexModsError('Invalid', `${what}: a title of at most 80 characters`);
      if (spec.keep !== undefined && (typeof spec.keep !== 'function' || o.realm !== 'renderer')) throw new CodexModsError('Invalid', `${what}: keep is a function of the renderer realm (the host realm gives where${list === 'sidebar' ? ' or threads' : ''})`);
      if (spec.threads !== undefined && list !== 'sidebar') throw new CodexModsError('Invalid', `${what}: threads are the sidebar's`);
      if (spec.for !== undefined && list !== 'transcript') throw new CodexModsError('Invalid', `${what}: for is the transcript's (the type of record it filters)`);
      if (spec.where === undefined && spec.threads === undefined && spec.keep === undefined) throw new CodexModsError('Invalid', `${what}: give where${list === 'sidebar' ? ', threads' : ''} or keep`);
      const filter = { title: spec.title.trim(), ...Object.fromEntries(['where', 'threads', 'for', 'keep'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]])) };
      const h = register('add', presentation, { id: spec.id, slot: 'filter', filter, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      const turn = (op) => (opts = {}) => {
        // a handle disposed or replaced acts on nothing (never on the declaration registered under its id since: built review)
        if (h.disposed) return Promise.reject(new CodexModsError('Unavailable', `the filter ${spec.id} was disposed or registered again`));
        // in this window (the renderer realm, no window named): here, once the Host took it (declared and turned on at once is on); else
        // through the Host, in the window named or in front
        if (o.realm === 'renderer' && !opts.window && o.filters) {
          return h.accepted.then((ok) => {
            if (!ok || h.disposed) throw new CodexModsError('Unavailable', `the filter ${spec.id} was refused, disposed or registered again`);
            return o.filters.set(spec.id, op === 'filter.on');
          });
        }
        if (typeof o.channel.inWindow !== 'function') return Promise.reject(new CodexModsError('Unavailable', 'windows are not reachable here'));
        // its registration goes along: a dispatch already started never acts on one registered under its id since
        return h.accepted.then(() => o.channel.inWindow(spec.id, op, {}, opts.window ?? null, h.reg));
      };
      return Object.assign(h, { on: turn('filter.on'), off: turn('filter.off') });
    },
    sidebar: Object.freeze({
      /**
       * An order of the sidebar's lists (public-hooks.md §3.14): `{id, in?, by}`. `in`: 'pinned', 'chats', 'projects' (the project groups),
       * 'project' (every project's chats) or a Project's ref (its chats); omitted, every list of chats. `by`: a path on the listed
       * instances (`-path` descending; what this mod may read) or, in the renderer realm, `(a, b) => number`. The first order naming a
       * list wins; the unknown sort last; the user's own order comes back when it goes. One rule: an `add` on Sidebar's `order`.
       */
      /**
       * A section of this mod's (public-hooks.md §3.14): `{id, title, where | of, sort?, collapsed?, limit?, position?: 'top' | 'end',
       * actions?: [{id, title, run}]}`, drawn with the app's own group and rows: the chats its `where` selects (live) or its `of` names, as
       * this mod may read them, in its `sort` (a path, `-path` descending); `limit` rows before the app's "Show more" (10); before the app's
       * groups or after them (the default); its actions on the title's hover. A view: its chats stay in the app's own lists.
       */
      section(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.sidebar.section takes {id, title, where | of, sort?, collapsed?, limit?, position?, actions?}');
        const section = Object.fromEntries(['title', 'where', 'of', 'sort', 'collapsed', 'limit', 'position'].filter((k) => spec[k] !== undefined).map((k) => [k, k === 'title' && typeof spec.title === 'string' ? spec.title.trim() : spec[k]]));
        const why = sidebarSectionWhy(section);
        if (why) throw new CodexModsError('Invalid', `ui.sidebar.section: ${why}`);
        const actions = spec.actions === undefined ? [] : spec.actions;
        if (!Array.isArray(actions) || actions.length > 5 || !actions.every((a) => a && typeof a.title === 'string' && a.title.trim() && typeof a.run === 'function')) throw new CodexModsError('Invalid', 'ui.sidebar.section: actions are at most 5 {id, title, run}');
        return register('add', 'Sidebar', { id: spec.id, slot: 'section', section, ...(actions.length ? { items: actions.map((a, i) => ({ id: a.id ?? String(i), title: a.title.trim(), run: a.run })) } : {}),
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
      /**
       * A view of this mod's for the sidebar (docs/design/layouts.md D5, D7): `{id, title, render(props), where?}`, its body while a page whose destination names it is
       * shown, or, with `where` (the window's mode or layout), while that holds, with the user's way back to the conversations: the app's contextual column where the rail
       * shows, the conversations' place otherwise (the footer stays).
       * One rule: an `add` on Sidebar's `views`; the renderer realm's.
       */
      view(spec) {
        if (o.realm !== 'renderer') throw new CodexModsError('Invalid', 'ui.sidebar.view renders: register it from the renderer realm');
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !MAIN_PAGE_ID.test(spec.id) || typeof spec.render !== 'function') throw new CodexModsError('Invalid', 'ui.sidebar.view takes {id, title, render}');
        const view = { title: typeof spec.title === 'string' ? spec.title.trim() : spec.title };
        const why = sidebarViewWhy(view);
        if (why) throw new CodexModsError('Invalid', `ui.sidebar.view: ${why}`);
        return register('add', 'Sidebar', { id: spec.id, slot: 'views', sidebarView: { ...view, render: spec.render }, ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
      order(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.sidebar.order takes {id, in?, by}');
        if (typeof spec.by === 'function' && o.realm !== 'renderer') throw new CodexModsError('Invalid', 'ui.sidebar.order: a comparator is the renderer realm\'s (the host realm gives a path)');
        if (spec.by === undefined) throw new CodexModsError('Invalid', 'ui.sidebar.order: give by');
        const sort = { ...(spec.in !== undefined ? { in: spec.in } : {}), by: spec.by };
        const why = sidebarSortWhy({ ...sort, by: typeof spec.by === 'function' ? undefined : spec.by });
        if (why) throw new CodexModsError('Invalid', `ui.sidebar.order: ${why}`);
        return register('add', 'Sidebar', { id: spec.id, slot: 'order', sort, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
    }),
    /**
     * A panel view of this mod (declared with `ui.panel` in its renderer realm), opened or closed in a window from either realm
     * (graph-layers.md §3.1): `open(id, {window?, target?, instance?, focus?})`, `close(id, {window?, instance?})`; the window in front by
     * default. Resolves to the page's outcome.
     */
    layouts: Object.freeze({
      /**
       * A named layout the user picks like the app's own (docs/design/layouts.md D6, D11): `{id, title, icon?, keys?, sidebar?: {open?, edge?}, side?: {open?, size?, tab?},
       * bottom?: {open?, height?, tab?, at?}, regions?: {<id>: {open?, size?}}, main?: 'chat' | 'tab' | {page}, keep?: 'while-active' | 'once'}`. Picked (the palette, `keys`, or
       * `Window.setLayout('<mod>/<id>')`), it is kept as the user moves between chats until they pick another: what they change themselves is theirs from then on, and each
       * region it set goes back as it was when it ends. One rule: an `add` on the Window's `layouts`; `keys` an entry of the menu bar's Layouts menu.
       */
      add(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !MAIN_PAGE_ID.test(spec.id)) throw new CodexModsError('Invalid', 'ui.layouts.add takes {id, title, ...}: an id of letters, digits, dots, dashes and underscores');
        const layout = Object.fromEntries(['title', 'icon', 'keep', 'sidebar', 'side', 'bottom', 'regions', 'main'].filter((k) => spec[k] !== undefined).map((k) => [k, k === 'title' && typeof spec[k] === 'string' ? spec[k].trim() : spec[k]]));
        const why = layoutWhy(layout);
        if (why) throw new CodexModsError('Invalid', `ui.layouts.add: ${why}`);
        const rule = register('add', 'Window', { id: spec.id, slot: 'layouts', layout, ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
        if (spec.keys === undefined) return rule;
        // the user's own pick of this mod's layout: the framework's to run, with no grant of the mod's and no say of the mods' order
        const pick = `${o.modId}/${spec.id}`;
        const entry = api.menus.add({ id: `${spec.id}.keys`, title: layout.title, in: { menu: 'Layouts' }, keys: spec.keys, layout: pick, run: () => {} });
        return Object.assign(rule, { dispose: ((d) => () => { entry.dispose(); d(); })(rule.dispose) });
      },
      /**
       * The app's own mode's parameters (D5): `mode('split', {sidebar?, side?, bottom?})`, applied as the window's effective mode becomes that mode; what the user changes while
       * in it is theirs. A layout picked comes first. One rule: an `add` on the Window's `layoutModes`.
       */
      mode(mode, params) {
        const layoutMode = { mode, ...(params && typeof params === 'object' ? params : {}) };
        const why = layoutModeWhy(layoutMode);
        if (why) throw new CodexModsError('Invalid', `ui.layouts.mode: ${why}`);
        return register('add', 'Window', { id: `mode-${mode}`, slot: 'layoutModes', layoutMode });
      },
    }),
    destinations: Object.freeze({
      /**
       * A destination in the rail (where the app shows it) and the sidebar's navigation (docs/design/layouts.md D7, WL5b): `{id, title, icon?,
       * open: {page} | {command} | ref, sidebar?}`. `page` and `command` are this mod's; `sidebar` a `ui.sidebar.view` of this mod's, shown
       * with the page. `icon`: an element or a component (renderer realm), or text (an emoji). The user pins and orders it as the app's own.
       * One rule: an `add` on the Window's `destinations`.
       */
      add(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id) throw new CodexModsError('Invalid', 'ui.destinations.add takes {id, title, open, icon?, sidebar?}');
        const node = spec.icon !== undefined && typeof spec.icon !== 'string';
        if (node && o.realm !== 'renderer') throw new CodexModsError('Invalid', 'ui.destinations.add: an element or a component as its icon is the renderer realm\'s; here it is text');
        const destination = { title: typeof spec.title === 'string' ? spec.title.trim() : spec.title, open: spec.open, ...(typeof spec.icon === 'string' ? { icon: spec.icon } : {}), ...(spec.sidebar !== undefined ? { sidebar: spec.sidebar } : {}) };
        const why = destinationWhy(destination);
        if (why) throw new CodexModsError('Invalid', `ui.destinations.add: ${why}`);
        return register('add', 'Window', { id: spec.id, slot: 'destinations', ...(spec.where !== undefined ? { where: spec.where } : {}), destination: node ? { ...destination, iconNode: typeof spec.icon === 'function' ? spec.icon : () => spec.icon } : destination, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
    }),
    /**
     * This mod's panel views (`ui.panel`), opened or closed in a window: the window named, else the one in front. `placement` (public-hooks.md
     * §3.14): 'panel' (a tab of the side or bottom panel, `target`; the default), 'modal' (the framework's dialog above the route, its
     * title the view's; `close` closes it), 'side' (a tab of the right panel with the chat beside it: the window's layout) or 'window' (a
     * new window of the app's, the view's tab filling it; resolves with that Window).
     */
    panels: Object.freeze({
      open: (id, opts = {}) => {
        const placement = opts && typeof opts === 'object' ? opts.placement : undefined;
        if (placement !== undefined && !['panel', 'modal', 'side', 'window'].includes(placement)) return Promise.reject(new CodexModsError('Invalid', 'ui.panels.open: placement is panel, modal, side or window'));
        return inWindow(id, 'panel.open', opts);
      },
      close: (id, opts = {}) => inWindow(id, 'panel.close', opts),
    }),
    contextMenu: Object.freeze({
      add(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') throw new CodexModsError('Invalid', 'ui.contextMenu.add takes {id, for, title, run}');
        if (typeof spec.for !== 'string' || !spec.for) throw new CodexModsError('Invalid', 'ui.contextMenu.add: for names the subject type (Thread, File, Folder, ...)');
        if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 80) throw new CodexModsError('Invalid', 'ui.contextMenu.add: a title of at most 80 characters');
        if (typeof spec.run !== 'function') throw new CodexModsError('Invalid', 'ui.contextMenu.add: an entry runs run(env)');
        return register('add', 'Menu', { id: spec.id, for: spec.for, slot: 'groups', ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
          items: [{ id: spec.id, title: spec.title.trim(), run: spec.run }] });
      },
    }),
    /**
     * Palette sources (docs/design/mod-surfaces.md §3.2): rows in the app's palette (Cmd+K and the floating search window). `{id, title |
     * group, position?, items?, search?(query, env), choose?(item, env), trigger?, minQuery?, limit?, debounceMs?}`: `items` are rows the
     * palette filters itself, each with its `run(env)` (or `choose: {open: ref} | {command: id}`); `search` answers the text typed with rows
     * (data: their `choose` is `{open}`, `{command}`, or the source's own `choose`). One rule: an `add` on Palette's `resultSources`.
     */
    palette: Object.freeze({
      source(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') throw new CodexModsError('Invalid', 'ui.palette.source takes {id, title or group, items or search}');
        const groups = ['suggested', 'thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app'];
        if (spec.group !== undefined && !groups.includes(spec.group)) throw new CodexModsError('Invalid', `ui.palette.source: group is one of ${groups.join(', ')}`);
        if (spec.group === undefined && (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 60)) throw new CodexModsError('Invalid', 'ui.palette.source: a title of at most 60 characters, or an app group');
        if (spec.items === undefined && typeof spec.search !== 'function') throw new CodexModsError('Invalid', 'ui.palette.source: items or search');
        if (spec.search !== undefined && typeof spec.search !== 'function') throw new CodexModsError('Invalid', 'ui.palette.source: search is a function');
        if (spec.choose !== undefined && typeof spec.choose !== 'function') throw new CodexModsError('Invalid', 'ui.palette.source: choose is a function');
        const source = {
          ...(spec.group ? { group: spec.group } : { title: spec.title.trim() }), ...(spec.position === 'above' ? { position: 'above' } : {}),
          ...(typeof spec.trigger === 'string' ? { trigger: spec.trigger } : {}),
          ...(Number.isInteger(spec.minQuery) ? { minQuery: spec.minQuery } : {}), ...(Number.isInteger(spec.limit) ? { limit: spec.limit } : {}),
          ...(Number.isInteger(spec.debounceMs) ? { debounceMs: spec.debounceMs } : {}),
          ...(spec.search ? { search: spec.search } : {}), ...(spec.choose ? { choose: spec.choose } : {}),
        };
        return register('add', 'Palette', { id: spec.id, slot: 'resultSources', source, ...(spec.items !== undefined ? { items: spec.items } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
      },
    }),
    // a presentation type, or a subject (HIDE_PLACES): taken out of each place that lists or shows it
    hide: (target, spec) => {
      if (Object.hasOwn(HIDE_ELSEWHERE, target)) throw new CodexModsError('Invalid', `ui.hide(${target}): ${HIDE_ELSEWHERE[target]}`);
      return Object.hasOwn(HIDE_PLACES, target) ? hideSubject(target, spec) : register('hide', target, spec);
    },
    // An order of names (the app's parts and this mod's entries' ids, public-hooks.md §3.10) is data, in either realm; a function of the
    // slot's entries is the renderer realm's (below).
    reorder(presentation, spec) {
      if (o.realm !== 'renderer' && typeof spec?.order === 'function') throw new CodexModsError('Invalid', 'ui.reorder: a function order is the renderer realm\'s; give a list of names here');
      // the palette's groups and commands are the app's own lists, written in place: ordered by name only
      if (presentation === 'Palette' && (spec?.slot === 'groups' || spec?.slot === 'commands') && !Array.isArray(spec?.order)) {
        throw new CodexModsError('Invalid', `ui.reorder: the palette's ${spec.slot} are ordered by a list of names (${spec.slot === 'groups' ? 'its groups: ui.parts(\'Palette\')' : 'Command ids'})`);
      }
      if (spec && spec.order !== undefined && typeof spec.order !== 'function' && !(Array.isArray(spec.order) && spec.order.length <= 64 && spec.order.every((n) => typeof n === 'string' && n))) {
        throw new CodexModsError('Invalid', 'ui.reorder: order is a list of names (at most 64) or a function');
      }
      return register('reorder', presentation, spec);
    },
    add: (presentation, spec) => register('add', presentation, spec),
    style: (spec) => register('style', undefined, spec),
  };
  if (o.realm === 'renderer') {
    Object.assign(api, {
      /**
       * A panel view (docs/design/mod-surfaces.md §3.1): a tab of the app's side and bottom panels in every chat, the new chat and remote
       * tasks, restored after a restart as the app's own tabs are. `{id, title, icon?, render(ctx), headerRows?(ctx), targets?, retain?,
       * persist?}`; the handle opens (or focuses) it in this window and closes it. One rule: SidePanel's `tabs` slot.
       */
      panel(spec) {
        if (!spec || typeof spec !== 'object' || typeof spec.render !== 'function') throw new CodexModsError('Invalid', 'ui.panel takes {id, title, render}');
        if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 80) throw new CodexModsError('Invalid', 'ui.panel: a title of at most 80 characters');
        const targets = spec.targets === undefined ? undefined : (Array.isArray(spec.targets) ? spec.targets : [spec.targets]);
        if (targets && (!targets.length || !targets.every((t) => t === 'right' || t === 'bottom'))) throw new CodexModsError('Invalid', 'ui.panel: targets are right and bottom');
        const view = {
          title: spec.title.trim(), ...(typeof spec.icon === 'string' ? { icon: spec.icon } : {}), ...(targets ? { targets } : {}),
          ...(spec.retain === false ? { retain: false } : {}), ...(spec.persist === false ? { persist: false } : {}),
        };
        const h = register('host', 'SidePanel', {
          id: spec.id, slot: 'tabs', render: spec.render, view, ...(typeof spec.headerRows === 'function' ? { headerRows: spec.headerRows } : {}),
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        });
        return Object.assign(h, {
          open: (opts) => (o.panels ? o.panels.open(spec.id, opts ?? {}) : false),
          close: (opts) => (o.panels ? o.panels.close(spec.id, opts ?? {}) : false),
        });
      },
      /**
       * A region of this mod's own at the workspace's edge (docs/design/layouts.md D10, WL4a): `{id, title, icon?, edge: 'left' | 'right',
       * width?: {default, min, max}, render(ctx)}`, beside the app's main view in every window, sized in each window as it is now
       * (Window.setRegion '<mod>/<id>') and kept at the width the user drags it to. One rule: an `add` on the Window's `regions` slot.
       */
      regions: Object.freeze({
        add(spec) {
          if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id || typeof spec.render !== 'function') throw new CodexModsError('Invalid', 'ui.regions.add takes {id, title, edge, width?, render}');
          const region = { ...(typeof spec.title === 'string' ? { title: spec.title.trim() } : {}), ...Object.fromEntries(['icon', 'edge', 'width'].filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]])) };
          const why = regionWhy(region);
          if (why) throw new CodexModsError('Invalid', `ui.regions.add: ${why}`);
          return register('add', 'Window', { id: spec.id, slot: 'regions', region: { ...region, render: spec.render }, ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
        },
      }),
      /**
       * Something of this mod's at one of the rail's ends, where the app shows the rail (docs/design/layouts.md §4.1): `{id, slot: 'header' |
       * 'footer', render}`. One rule: a `host` on Rail's slot.
       */
      rail: Object.freeze({
        add(spec) {
          if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !spec.id || typeof spec.render !== 'function' || !['header', 'footer'].includes(spec.slot)) throw new CodexModsError('Invalid', 'ui.rail.add takes {id, slot: header | footer, render}');
          return register('host', 'Rail', { id: spec.id, slot: spec.slot, render: spec.render, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
        },
      }),
      /**
       * A page of this mod's own in the window's main region (docs/design/layouts.md D7, WL5a): `{id, title, render(props), header?:
       * {title?, actions?}}`, in the app's history like its own pages, with its header in the title bar's page row; `actions` is a component.
       * While its mod is off its path still shows, saying so. One rule: a `host` on MainRegion's `pages`. The handle's `open()` opens it
       * here (false when this window cannot); any code opens it with `Window.open({page: '<mod>/<id>'})`.
       */
      pages: Object.freeze({
        add(spec) {
          if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || !MAIN_PAGE_ID.test(spec.id) || typeof spec.render !== 'function') throw new CodexModsError('Invalid', 'ui.pages.add takes {id, title, render}: an id of letters, digits, dots, dashes and underscores');
          const head = spec.header;
          if (head !== undefined && (!head || typeof head !== 'object' || (head.actions !== undefined && typeof head.actions !== 'function'))) throw new CodexModsError('Invalid', 'ui.pages.add: header is {title?, actions?}; actions a component');
          const page = { title: typeof spec.title === 'string' ? spec.title.trim() : spec.title, ...(head?.title !== undefined ? { heading: head.title } : {}) };
          const why = mainPageWhy(page);
          if (why) throw new CodexModsError('Invalid', `ui.pages.add: ${why}`);
          const h = register('host', 'MainRegion', { id: spec.id, slot: 'pages', page, render: spec.render, ...(head?.actions ? { actions: head.actions } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
          return Object.assign(h, { open: () => (o.mainPages ? o.mainPages.open(spec.id) : false) });
        },
      }),
      /**
       * Message content (docs/design/mod-surfaces.md §3.3): a part of every markdown the app shows (the agent's answers, your messages,
       * plans, previews), drawn by a component of this mod: `code({id, language, render})` (a fenced block in those languages),
       * `inlineCode({id, match, render})`, `link({id, scheme?, host?, match?, render})`, `directive({id, name, groupConsecutive?, render})`;
       * each also takes `sites?`, `for?`, `where?`, `whileStreaming?` ('render', the default, or 'native': the app's own until the part
       * is complete) and `priority?`. The component gets `{part, site, subject, streaming, Native, nativeProps, children}`: `Native` with
       * `nativeProps` is the app's own rendering, to fall back on or to wrap. The first rule in order claims a part. One rule each:
       * ContentView's `partRenderers`.
       */
      content: Object.freeze({ ...Object.fromEntries(['code', 'inlineCode', 'link', 'directive', 'text'].map((kind) => [kind, (spec) => {
        if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || typeof spec.render !== 'function') throw new CodexModsError('Invalid', `ui.content.${kind} takes {id, …, render}`);
        const part = { kind };
        if (kind === 'code') part.language = listed(spec.language);
        if (kind === 'inlineCode' || kind === 'text' || (kind === 'link' && spec.match !== undefined)) part.match = patternOf(spec.match);
        if (kind === 'link') { if (spec.scheme !== undefined) part.scheme = listed(spec.scheme); if (spec.host !== undefined) part.host = listed(spec.host).map((h) => (typeof h === 'string' ? h.toLowerCase() : h)); }
        if (kind === 'directive') { part.name = spec.name; if (spec.groupConsecutive !== undefined) part.groupConsecutive = spec.groupConsecutive; }
        if (spec.sites !== undefined) part.sites = listed(spec.sites);
        if (spec.whileStreaming !== undefined) part.whileStreaming = spec.whileStreaming;
        const why = partWhy(part);
        if (why) throw new CodexModsError('Invalid', `ui.content.${kind}: ${why}`);
        return register('host', 'ContentView', {
          id: spec.id, slot: 'partRenderers', part, render: spec.render, ...(spec.for !== undefined ? { for: spec.for } : {}),
          ...(spec.where !== undefined ? { where: spec.where } : {}), ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        });
      }])),
      redact: contentRedact,
    }),
      /**
       * A mod's pages in the app's Settings (docs/design/mod-surfaces.md §3.9): `page({id, title, group?, render})` is a page drawn in the
       * app's own frame, its entry in the navigation's Mods group (the default) or one of the app's own groups ('personal',
       * 'integrations', 'coding'); its handle opens it. `open(page?)`: this mod's page in Settings, or one of its own pages. One rule
       * per page: SettingsPage's `pages`.
       */
      settings: Object.freeze({
        page(spec) {
          if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string' || typeof spec.render !== 'function') throw new CodexModsError('Invalid', 'ui.settings.page takes {id, title, render}');
          const page = { title: typeof spec.title === 'string' ? spec.title.trim() : spec.title, ...(spec.group !== undefined ? { group: spec.group } : {}) };
          const why = settingsPageWhy(page);
          if (why) throw new CodexModsError('Invalid', `ui.settings.page: ${why}`);
          const h = register('host', 'SettingsPage', { id: spec.id, slot: 'pages', page, render: spec.render, ...(spec.priority !== undefined ? { priority: spec.priority } : {}) });
          return Object.assign(h, { open: () => (o.settings ? o.settings.open(spec.id) : false) });
        },
        open: (page) => (o.settings ? o.settings.open(typeof page === 'string' ? page : null) : false),
        section: settingsSection,
      }),
      replace: (presentation, spec) => register('replace', presentation, spec),
      host: (presentation, spec) => register('host', presentation, spec),
      render: (presentation, spec) => register('render', presentation, spec),
    });
  }
  // Every declaration's handle can change what it declares in place (docs/design/public-hooks.md §3.13): `update(patch)` registers it
  // again under its id with those fields changed, the newer registration replacing the older in each window once accepted, and the
  // handle stands for the newer one from then on. `menus.add` has its own update. The number is the spec's argument.
  const UPDATABLE = {
    '': { decorate: 1, hide: 1, add: 1, style: 0, banner: 0, status: 0, choices: 1, replace: 1, host: 1, render: 1, reorder: 1, panel: 0, filter: 1 },
    composer: { control: 0, slash: 0, mention: 0, attachSource: 0 }, commands: { add: 0 }, sidebar: { order: 0, section: 0, view: 0 }, destinations: { add: 0 }, rail: { add: 0 }, contextMenu: { add: 0 },
    palette: { source: 0 }, content: { code: 0, inlineCode: 0, link: 0, directive: 0, text: 0, redact: 0 }, settings: { page: 0, section: 0 }, pages: { add: 0 }, openIn: { add: 0 }, newThread: { starter: 0 }, theme: { add: 0 }, links: { route: 0 },
  };
  for (const [ns, fns] of Object.entries(UPDATABLE)) {
    const holder = ns ? api[ns] : api;
    if (!holder) continue;
    const next = { ...holder };
    for (const [name, at] of Object.entries(fns)) if (typeof holder[name] === 'function') next[name] = updatable(holder[name], at);
    if (ns) api[ns] = Object.isFrozen(holder) ? Object.freeze(next) : next;
    else Object.assign(api, next);
  }
  function updatable(build, at) {
    return (...args) => {
      let cur = build(...args);
      let spec = args[at];
      const update = (patch) => {
        if (cur.disposed) return Promise.resolve(false);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CodexModsError('Invalid', 'update takes the fields to change');
        if (patch.id !== undefined && patch.id !== spec.id) throw new CodexModsError('Invalid', 'update cannot change a declaration\'s id');
        const merged = { ...spec, ...patch };
        const before = Array.isArray(cur.ruleIds) ? cur.ruleIds : null;
        let built;
        replacing = true;
        try { built = build(...args.slice(0, at), merged, ...args.slice(at + 1)); } finally { replacing = false; }
        if (before) for (const rid of before) if (!(built.ruleIds ?? []).includes(rid)) live.get(rid)?.dispose();
        cur = built;
        spec = merged;
        return built.accepted;
      };
      return new Proxy(Object.create(null), {
        get: (_, k) => (k === 'update' ? update : (typeof cur[k] === 'function' ? cur[k].bind(cur) : cur[k])),
        has: (_, k) => k === 'update' || k in cur,
      });
    };
  }
  return { api, disposeAll() { for (const h of [...live.values()]) h.dispose(); for (const d of [...docks]) d.dispose(); try { noteSub?.dispose(); } catch { /* gone */ } notes.clear(); } };
}
