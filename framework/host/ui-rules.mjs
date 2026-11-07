// The registry of record of the mods' presentation rules (docs/design/systems.md S6, "E2 in detail"). A rule has one identity, `(mod, id)`,
// and belongs to one activation of its mod; the registry checks its grant (`graph.present[:Type]`), its presentation type and slot (what
// the framework's bindings realize on this build, from present/addresses.json), assigns its order (the mod's rank, then the rule's
// priority, then its id), keeps it while its mod runs and tells every window: a snapshot first, then deltas. A renderer-realm rule is
// registered from each window its mod's module runs in (its functions and components stay there): it lives while one of those windows
// holds it. A host-realm rule is static data and applies in every window. Node built-ins only.
import { readFileSync } from 'node:fs';
import { CodexModsError } from '../../sdk/errors.mjs';
import { validateWhere, validateOf } from '../shared/where.mjs';
import { partRuleWhy, slotOfPart, partsOf } from '../shared/parts.mjs';
import { presentAllowed, graphGrants } from './graph/policy.mjs';
import { CALLBACK_PATH, SEARCH_PATHS, partWhy, mainPageWhy, destinationWhy, sidebarViewWhy, layoutWhy, layoutModeWhy, settingsPageWhy, settingsSectionWhy, sidebarSectionWhy, sidebarSortWhy, regionWhy, statusWhy, isRefShape, choicesWhy, FILTER_LISTS, redactWhy, themeWhy, linkRouteWhy } from '../shared/ui-rules-client.mjs';

export const KINDS = Object.freeze(['decorate', 'hide', 'replace', 'host', 'render', 'add', 'reorder', 'style']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NEEDS_SLOT = new Set(['host', 'add', 'reorder']);
const COMPONENT = new Set(['replace', 'host', 'render']);   // their component runs in the page: renderer realm only
const MAX_DATA_BYTES = 16 * 1024;
/** A list's name (ui.filter) by the presentation its filters are declared on. */
const LIST_OF = Object.fromEntries(Object.entries(FILTER_LISTS).map(([list, presentation]) => [presentation, list]));
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** How long a host-realm rule's callback may take in its mod's worker (mod-surfaces.md P1), and how much it may answer. */
export const CALLBACK_MS = 30000;
export const SEARCH_MS = 3000;
const MAX_ANSWER_BYTES = 64 * 1024;
const PATH = /^[A-Za-z][A-Za-z0-9]*(?:\.(?:[A-Za-z][A-Za-z0-9]*|\d{1,4})){1,8}$/;
/**
 * The markers `{$fn: path}` in a rule's data, by path. A marker stands only where its path says it is and only as an entry's `run` (the
 * client writes them so); any other object with only `$fn` makes the data invalid (null), so no field can alias a callback.
 */
function markersIn(v, out = new Set(), depth = 0, at = '') {
  if (!v || typeof v !== 'object' || depth > 8) return out;
  if (!Array.isArray(v) && Object.keys(v).length === 1 && '$fn' in v) {
    if (out && v.$fn === at && CALLBACK_PATH.test(at)) out.add(v.$fn);
    else return null;
    return out;
  }
  for (const [k, x] of Object.entries(v)) { if (markersIn(x, out, depth + 1, at ? `${at}.${k}` : k) === null) return null; }
  return out;
}

/**
 * The presentation types the framework realizes, with their slots: the bindings and rules of present/addresses.json, and the slots a
 * binding realizes for a twin (`twins: [{presentation, slots}]`: another presentation its component also shows, E7).
 */
export function presentationsOf(addresses) {
  const out = new Map();
  const add = (presentation, slots) => {
    const set = out.get(presentation) ?? new Set();
    for (const s of Array.isArray(slots) ? slots : []) if (typeof s === 'string') set.add(s);
    out.set(presentation, set);
  };
  for (const b of [...(addresses?.bindings ?? []), ...(addresses?.rules ?? [])]) {
    if (!b || b.target === false) continue;
    if (typeof b.presentation === 'string') add(b.presentation, b.slots);
    // a binding that only realizes others' slots (it presents nothing itself) still gives them
    for (const t of Array.isArray(b.twins) ? b.twins : []) if (t && typeof t.presentation === 'string') add(t.presentation, t.slots);
    // and one that draws only parts of another's slots (a sidebar footer's banners: `partsOf`, `parts` by slot) gives those slots, so the
    // parts `ui.parts` offers there can be hidden
    if (typeof b.partsOf === 'string' && b.parts && typeof b.parts === 'object' && !Array.isArray(b.parts)) add(b.partsOf, Object.keys(b.parts));
  }
  return out;
}
/** Does the pack's seams.hooks deliver what an address needs (its seams and exposures, its scope's; as framework-main arms bindings)? */
export function needsMet(b, hooks) {
  if (!hooks || typeof hooks !== 'object') return true;   // no pack known: every address (the tests' registries)
  const exposures = [...(b?.needs?.exposures ?? []), ...(typeof b?.exposure === 'string' && b.exposure ? [b.exposure.split('.')[0]] : []),
    ...(typeof b?.scope === 'string' && b.scope ? ['useScope', b.scope] : [])];
  return (b?.needs?.seams ?? []).every((s) => !!hooks[s]) && exposures.every((x) => !!hooks.exposures?.[x]);
}
/**
 * The app's parts this build's bindings support (public-hooks.md §3.10): presentation -> slot -> Map of part name -> the rule kinds it
 * takes (addresses.json `parts`, and `partKinds`: hide by default; `decorate` relabels, `reorder` moves), from the addresses whose needs
 * the running build's pack delivers (`hooks`, its seams.hooks), so a rule on a part this build cannot draw that way says unsupported.
 */
export function partsSupported(addresses, hooks = null) {
  const out = new Map();
  for (const b of [...(addresses?.bindings ?? []), ...(addresses?.rules ?? [])]) {
    const of = typeof b?.partsOf === 'string' ? b.partsOf : b?.presentation;   // a binding drawing another presentation's part
    if (!b || b.target === false || typeof of !== 'string' || !b.parts || typeof b.parts !== 'object' || !needsMet(b, hooks)) continue;
    const kinds = new Set(Array.isArray(b.partKinds) ? b.partKinds : ['hide']);
    const bySlot = out.get(of) ?? new Map();
    for (const [slot, names] of Object.entries(b.parts)) {
      const map = bySlot.get(slot) ?? new Map();
      for (const n of Array.isArray(names) ? names : []) if (typeof n === 'string') map.set(n, new Set([...(map.get(n) ?? []), ...kinds]));
      bySlot.set(slot, map);
    }
    out.set(of, bySlot);
  }
  return out;
}
export function readPresentations(file) {
  try { return presentationsOf(JSON.parse(readFileSync(file, 'utf8'))); } catch { return new Map(); }
}
export function readPartsSupported(file, hooks = null) {
  try { return partsSupported(JSON.parse(readFileSync(file, 'utf8')), hooks); } catch { return new Map(); }
}

/**
 * @param {{ presentations: Map<string, Set<string>>, rankOf: (modId: string) => number, typeExists?: (typeId: string) => boolean,
 *   frameworkOwned?: (typeId: string) => boolean, ownThread?: (modId: string, typeId: string) => boolean, log?: object }} o
 *   `frameworkOwned`: a type the framework owns (07); no rule is for one (E6, decision 6: the page never applies a rule to such a subject);
 *   `ownThread`: a Thread subtype the mod itself registered (its chats' view is its own to register: graph-integrity G2.2)
 */
export function createRuleRegistry(o) {
  const log = o.log ?? { info() {}, warn() {} };
  const rules = new Map();      // key -> { rule (public), gen (the activation it belongs to), windows: Set<number> }
  const listeners = new Set();
  const emit = (d) => { for (const fn of [...listeners]) { try { fn(d); } catch (e) { log.warn('a rules listener threw', { message: String(e?.message ?? e) }); } } };
  const orderOf = (mod, priority) => (Number.isFinite(o.rankOf(mod)) ? Math.min(o.rankOf(mod), 1e9) : 1e9) * 1e6 + (1000 - Math.max(-999, Math.min(999, Math.trunc(priority))));
  /** A rule as a window gets it: its order from its mod's rank now (a rule registered while its mod activates may predate its rank). */
  const current = (rule) => Object.freeze({ ...rule, order: orderOf(rule.mod, rule.priority) });

  /** The parts a rule names that this build does not draw, or not that way (said on the handle, never dropped quietly). */
  const unsupportedParts = (rule) => {
    const names = rule.kind === 'reorder' && Array.isArray(rule.data?.order) ? rule.data.order : rule.part ?? [];
    const bySlot = o.parts?.get(rule.presentation);
    return names.filter((n) => {
      const slot = slotOfPart(rule.presentation, n, rule.slot);
      if (!slot) return false;   // a reorder may name a mod's own entries
      return !bySlot?.get(slot)?.get(n)?.has(rule.kind);
    });
  };
  /** Check a descriptor and give its public form; throws Invalid, Denied or Unavailable. */
  const whereOk = (w) => { try { return validateWhere(w); } catch { return false; } };
  function check(modId, grants, raw, realm) {
    if (!isPlain(raw)) throw new CodexModsError('Invalid', 'a rule is an object');
    const { id, kind, presentation, slot, for: forType, where, of, part, priority = 0, data, callbacks, reg } = raw;
    if (typeof id !== 'string' || !ID.test(id)) throw new CodexModsError('Invalid', 'a rule needs an id (letters, digits, ".", "_" and "-", at most 64)');
    if (!KINDS.includes(kind)) throw new CodexModsError('Invalid', `unknown rule kind ${kind}`);
    if (COMPONENT.has(kind) && realm !== 'renderer') throw new CodexModsError('Invalid', `a ${kind} rule renders a component: register it from the renderer realm`);
    if (!Number.isFinite(priority)) throw new CodexModsError('Invalid', 'priority is a number');
    if (kind === 'style') {
      if (!presentAllowed(grants, 'Theme')) throw new CodexModsError('Denied', 'styling needs the graph.present grant (or graph.present:Theme)');
      // The app's own variables, each set to a theme token or another of its variables, never a raw value (S12; the page checks they exist);
      // or `{light, dark}`, one of those for each appearance (public-hooks.md §3.14)
      const one = (v) => typeof v === 'string' && (/^--[A-Za-z0-9_-]{1,80}$/.test(v) || /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(v));
      const ok = isPlain(data?.variables) && Object.keys(data.variables).length <= 32 && Object.entries(data.variables)
        .every(([k, v]) => /^--[A-Za-z0-9_-]{1,80}$/.test(k) && (one(v) || (isPlain(v) && Object.keys(v).length === 2 && one(v.light) && one(v.dark))));
      if (!ok) throw new CodexModsError('Invalid', 'style takes { variables: { "--name": token | {light, dark} } }: the app\'s own variables, each a theme token or another of them, or one for each appearance (at most 32)');
    } else {
      if (typeof presentation !== 'string' || !o.presentations.has(presentation)) throw new CodexModsError('Unavailable', `no binding presents ${presentation} on this build`);
      if (!presentAllowed(grants, presentation)) throw new CodexModsError('Denied', `this mod has not been granted graph.present for ${presentation}`);
      const slots = o.presentations.get(presentation);
      if (slot !== undefined && (typeof slot !== 'string' || !slots.has(slot))) throw new CodexModsError('Unavailable', `${presentation} has no slot ${slot} on this build`);
      if (NEEDS_SLOT.has(kind) && slot === undefined) throw new CodexModsError('Invalid', `a ${kind} rule names its slot`);
    }
    // A panel view (ui.panel, mod-surfaces.md §3.1): a host rule on SidePanel's tabs with its title and options, which the tab persists.
    if (presentation === 'SidePanel' && slot === 'tabs') {
      const v = isPlain(data) ? data.view : undefined;
      const ok = kind === 'host' && isPlain(v) && typeof v.title === 'string' && v.title.trim().length > 0 && v.title.length <= 80
        && (v.icon === undefined || (typeof v.icon === 'string' && v.icon.length <= 64))
        && (v.targets === undefined || (Array.isArray(v.targets) && v.targets.length > 0 && v.targets.every((t) => t === 'right' || t === 'bottom')))
        && ['retain', 'persist'].every((k) => v[k] === undefined || typeof v[k] === 'boolean');
      if (!ok) throw new CodexModsError('Invalid', 'a panel view is a host rule on SidePanel tabs with its view: {title (at most 80), icon?, targets?, retain?, persist?}');
    }
    // A part renderer (ui.content, mod-surfaces.md §3.3): a host rule on ContentView's partRenderers with its part (a kind and its claim).
    if (presentation === 'ContentView' && slot === 'partRenderers') {
      const why = kind !== 'host' || !isPlain(data) ? 'a part renderer is a host rule with its part' : partWhy(data.part);
      if (why) throw new CodexModsError('Invalid', `ui.content: ${why}`);
    }
    // A redaction (ui.content.redact, public-hooks.md §3.14): an add rule on ContentView's redact with its pattern, what it shows and its sites.
    if (presentation === 'ContentView' && slot === 'redact') {
      const why = kind !== 'add' || !isPlain(data) ? 'a redaction is an add rule with its redact' : redactWhy(data.redact);
      if (why) throw new CodexModsError('Invalid', `ui.content.redact: ${why}`);
    }
    // A list's filter (ui.filter, public-hooks.md §3.12): an add rule on the list's presentation's filter with its title and what it keeps
    // (text is the sidebar's, a chat's title or preview, and so are its chats; `for`, the type of record it filters, the transcript's).
    if (slot === 'filter' && Object.hasOwn(LIST_OF, presentation)) {
      const f = isPlain(data) ? data.filter : undefined;
      const sidebar = presentation === 'Sidebar';
      const chat = (t) => isPlain(t) && typeof t.type === 'string' && typeof t.id === 'string' && typeof t.provider === 'string';
      const ok = kind === 'add' && isPlain(f) && typeof f.title === 'string' && f.title.trim().length > 0 && f.title.length <= 80
        && (f.where === undefined || (sidebar && typeof f.where === 'string' && f.where.length > 0 && f.where.length <= 200) || (isPlain(f.where) && whereOk(f.where)))
        && (f.threads === undefined || (sidebar && Array.isArray(f.threads) && f.threads.length <= 500 && f.threads.every(chat)))
        && (f.for === undefined || (presentation === 'ThreadView' && typeof f.for === 'string' && /^[A-Z][A-Za-z0-9]{0,63}$/.test(f.for)));
      if (!ok) throw new CodexModsError('Invalid', `ui.filter('${LIST_OF[presentation]}'): an add rule on ${presentation} filter with {title (at most 80), where?${sidebar ? ' (text or state fields), threads? (at most 500 chats)' : ''}${presentation === 'ThreadView' ? ', for? (a type)' : ''}}`);
    }
    // A status (ui.status, public-hooks.md §3.14): an add rule on a status slot with one status (a renderer rule's may stay in its window,
    // with its run) and, when it reads another instance than its place's, that instance.
    if (slot === 'status') {
      const items = isPlain(data) ? data.items : undefined;
      const why = kind !== 'add' ? 'a status is an add rule'
        : items !== undefined && !(Array.isArray(items) && items.length === 1) ? 'a status rule holds one status'
          : items !== undefined ? statusWhy(items[0]) ?? (items[0].when !== undefined && !whereOk(items[0].when) ? 'when is a where on its subject' : null)
            : null;
      if (why) throw new CodexModsError('Invalid', `ui.status: ${why}`);
      if (data?.subject !== undefined && !isRefShape(data.subject)) throw new CodexModsError('Invalid', 'ui.status: subject is a ref {type, provider, id}');
    } else if (isPlain(data) && data.subject !== undefined) throw new CodexModsError('Invalid', 'subject is a status\'s (ui.status)');
    // A sidebar order (ui.sidebar.order, public-hooks.md §3.14): an add rule on Sidebar's order with the list it names and its path (a
    // renderer rule's comparator stays in its window).
    if (presentation === 'Sidebar' && slot === 'order') {
      const why = kind !== 'add' || !isPlain(data?.sort) ? 'an order is an add rule with {in?, by}' : sidebarSortWhy(data.sort);
      if (why) throw new CodexModsError('Invalid', `ui.sidebar.order: ${why}`);
    }
    // A mod's region at the workspace's edge (ui.regions.add, layouts.md WL4a): an add rule on the Window's regions with its title, edge and
    // width; its render stays in the page (renderer realm only).
    if (presentation === 'Window' && slot === 'regions') {
      const why = kind !== 'add' || !isPlain(data?.region) ? 'a region is an add rule with its region' : realm !== 'renderer' ? 'a region renders: register it from the renderer realm' : regionWhy(data.region);
      if (why) throw new CodexModsError('Invalid', `ui.regions.add: ${why}`);
    }
    // A sidebar section (ui.sidebar.section, public-hooks.md §3.14): an add rule on Sidebar's section with what it lists and at most five
    // actions (its items).
    if (presentation === 'Sidebar' && slot === 'section') {
      const why = kind !== 'add' || !isPlain(data?.section) ? 'a section is an add rule with its section' : sidebarSectionWhy(data.section)
        ?? (data.section.where !== undefined && !whereOk(data.section.where) ? 'where: not the one grammar' : null)
        ?? (data.items !== undefined && !(Array.isArray(data.items) && data.items.length <= 5) ? 'at most five actions' : null);
      if (why) throw new CodexModsError('Invalid', `ui.sidebar.section: ${why}`);
    }
    // A starting point (ui.newThread.starter, public-hooks.md §3.14): an add rule on NewThreadView's starters with its declaration (its title,
    // where it is offered) and one entry (its run; a renderer-realm entry stays in its page); its chats are the mod's own calls, so only a
    // mod granted to start them declares one.
    if (presentation === 'NewThreadView' && slot === 'starters') {
      const x = isPlain(data) ? data.starter : undefined;
      const ok = kind === 'add' && isPlain(x) && typeof x.title === 'string' && x.title.trim().length > 0 && x.title.length <= 60
        && Array.isArray(x.in) && x.in.length > 0 && x.in.every((p) => ['newThread', 'palette', 'project'].includes(p))
        && (x.tooltip === undefined || (typeof x.tooltip === 'string' && x.tooltip.length <= 120))
        && (data.items === undefined || (Array.isArray(data.items) && data.items.length === 1 && isPlain(data.items[0])));
      if (!ok) throw new CodexModsError('Invalid', 'ui.newThread.starter: an add rule on NewThreadView starters with starter {title (at most 60), in, tooltip?} and one entry');
      const act = graphGrants(grants).act;
      const may = (types) => act === '*' || act.some((e) => { const [type, op] = e.split('.'); return types.includes(type) && (op === undefined || op === '*' || op === 'newThread'); });
      if (!may(['Project', 'LocalProject']) || !may(['Agent', 'CodexAgent'])) throw new CodexModsError('Denied', 'a starter starts its chats as the mod\'s own calls: it needs graph.act for Project.newThread and Agent.newThread');
    }
    // A link route (ui.links.route, public-hooks.md §3.14): an add rule on the Window's links with its route; one whose mod opens the
    // link itself has one entry (its run: a host-realm rule's callback, a renderer-realm entry's function stays in its page).
    if (presentation === 'Window' && slot === 'links') {
      const route = isPlain(data) ? data.route : undefined;
      const items = isPlain(data) ? data.items : undefined;
      const why = kind !== 'add' || !isPlain(route) ? 'a link route is an add rule with its route' : linkRouteWhy(route)
        ?? (Object.keys(data).some((k) => k !== 'route' && k !== 'items') ? 'a link route holds its route and its run only' : null)
        ?? (route.handles !== true ? (items !== undefined ? 'a route that opens the link has no run' : null)
          : realm === 'host' ? (Array.isArray(items) && items.length === 1 && isPlain(items[0]) && isPlain(items[0].run) && items[0].run.$fn === 'items.0.run' ? null : 'a route that runs has its run')
            : (items === undefined || (Array.isArray(items) && items.length === 1 && isPlain(items[0])) ? null : 'a route that runs has one entry'));
      if (why) throw new CodexModsError('Invalid', `ui.links.route: ${why}`);
    }
    // An attachment source (ui.composer.attachSource, public-hooks.md §3.14): an add rule on the composer's Palette with `attach` (its title)
    // and one entry (its run); what it attaches is the mod's own call, so only a mod granted Draft.attach declares one.
    if (presentation === 'Palette' && isPlain(data) && data.attach !== undefined) {
      const a = data.attach, items = data.items;
      const ok = kind === 'add' && forType === 'Draft' && isPlain(a) && typeof a.title === 'string' && a.title.trim().length > 0 && a.title.length <= 60
        && (a.description === undefined || (typeof a.description === 'string' && a.description.length <= 200))
        && (items === undefined || (Array.isArray(items) && items.length === 1 && isPlain(items[0])));   // a renderer-realm entry stays in its page
      if (!ok) throw new CodexModsError('Invalid', 'ui.composer.attachSource: an add rule on the Palette for Draft with attach {title (at most 60), description?} and one entry');
      const act = graphGrants(grants).act;
      if (act !== '*' && !act.some((e) => { const [type, op] = e.split('.'); return type === 'Draft' && (op === undefined || op === '*' || op === 'attach'); })) {
        throw new CodexModsError('Denied', 'an attachment source attaches as the mod\'s own call: it needs graph.act for Draft.attach');
      }
    }
    // A summary (decorate's `summary`, public-hooks.md §3.13) is one mod's text: no reorder sees it.
    if (kind === 'reorder' && slot === 'summary') throw new CodexModsError('Invalid', 'a summary is not reordered (the first rule that gives one is drawn)');
    // A chat or project hidden from the sidebar's listings (ui.hide('Thread' | 'Project'), public-hooks.md §3.12): an add rule on Sidebar's
    // hidden with what it hides (its type, and a where and `of` in the one grammar).
    // A command hidden from the palette (ui.hide('Command')): the same, on Palette's hidden.
    if ((presentation === 'Sidebar' || presentation === 'Palette') && slot === 'hidden') {
      const h = isPlain(data) ? data.hide : undefined;
      let ofOk = true;
      try { validateOf(h?.of); } catch { ofOk = false; }
      const types = presentation === 'Sidebar' ? ['Thread', 'Project'] : ['Command'];
      const ok = kind === 'add' && isPlain(h) && types.includes(h.for) && (h.where === undefined || (isPlain(h.where) && whereOk(h.where))) && ofOk;
      if (!ok) throw new CodexModsError('Invalid', `ui.hide(${types.join(' | ')}): an add rule on ${presentation} hidden with {for: ${types.join(' or ')}, where?, of?}`);
    }
    // Choices (ui.choices, public-hooks.md §3.11): an add rule on Choices' subject with what it hides, orders and relabels (a renderer
    // rule's hide test stays in its window) and at most ten entries it adds.
    if (presentation === 'Choices') {
      const why = kind !== 'add' || !isPlain(data?.choices) ? 'a choice is an add rule with its choices' : choicesWhy(data.choices)
        ?? (isPlain(data.choices.hide) && !whereOk(data.choices.hide) ? 'hide: not the one grammar' : null)
        ?? (data.items !== undefined && !(Array.isArray(data.items) && data.items.length <= 10) ? 'at most ten added entries' : null);
      if (why) throw new CodexModsError('Invalid', `ui.choices: ${why}`);
    }
    // A named layout and a mode's parameters (ui.layouts.add, ui.layouts.mode, layouts.md D5, D6): add rules on the Window's, data alone.
    if (presentation === 'Window' && slot === 'layouts') {
      const why = kind !== 'add' || !isPlain(data?.layout) ? 'a layout is an add rule with its layout' : layoutWhy(data.layout);
      if (why) throw new CodexModsError('Invalid', `ui.layouts.add: ${why}`);
    }
    if (presentation === 'Window' && slot === 'layoutModes') {
      const why = kind !== 'add' || !isPlain(data?.layoutMode) ? 'a mode\'s parameters are an add rule' : layoutModeWhy(data.layoutMode);
      if (why) throw new CodexModsError('Invalid', `ui.layouts.mode: ${why}`);
    }
    // A destination in the rail and the sidebar's navigation (ui.destinations.add, layouts.md D7): an add rule on the Window's destinations.
    if (presentation === 'Window' && slot === 'destinations') {
      const why = kind !== 'add' || !isPlain(data?.destination) ? 'a destination is an add rule with its destination' : destinationWhy(data.destination);
      if (why) throw new CodexModsError('Invalid', `ui.destinations.add: ${why}`);
    }
    // A sidebar view (ui.sidebar.view, layouts.md D7): an add rule on Sidebar's views; its render stays in the page.
    if (presentation === 'Sidebar' && slot === 'views') {
      const why = kind !== 'add' || !isPlain(data?.sidebarView) ? 'a sidebar view is an add rule with its view' : realm !== 'renderer' ? 'a sidebar view renders: register it from the renderer realm' : sidebarViewWhy(data.sidebarView);
      if (why) throw new CodexModsError('Invalid', `ui.sidebar.view: ${why}`);
    }
    // A mod's page in the main region (ui.pages.add, layouts.md D7): a host rule on MainRegion's pages; its components stay in the page.
    if (presentation === 'MainRegion' && slot === 'pages') {
      const why = kind !== 'host' || !isPlain(data) ? 'a page is a host rule with its page' : realm !== 'renderer' ? 'a page renders: register it from the renderer realm' : mainPageWhy(data.page);
      if (why) throw new CodexModsError('Invalid', `ui.pages.add: ${why}`);
    }
    // A mod's settings page (ui.settings.page, mod-surfaces.md §3.9): a host rule on SettingsPage's pages with its title and group.
    if (presentation === 'SettingsPage' && slot === 'pages') {
      const why = kind !== 'host' || !isPlain(data) ? 'a settings page is a host rule with its page' : settingsPageWhy(data.page);
      if (why) throw new CodexModsError('Invalid', `ui.settings.page: ${why}`);
    }
    // A mod's section on an app settings page (ui.settings.section, public-hooks.md §3.14): an add rule on SettingsPage's section, for one
    // page (`of` its SettingsSection), with one section (a renderer rule's may stay in its window, with its component).
    if (presentation === 'SettingsPage' && slot === 'section') {
      const items = isPlain(data) ? data.items : undefined;
      const page = Array.isArray(of) ? null : of;
      const why = kind !== 'add' ? 'a section is an add rule'
        : !(isPlain(page) && page.type === 'SettingsSection' && typeof page.id === 'string') ? 'a section names its page (of: the page\'s SettingsSection)'
          : items !== undefined && !(Array.isArray(items) && items.length === 1) ? 'a section rule holds one section'
            : items !== undefined ? settingsSectionWhy(items[0]) : null;
      if (why) throw new CodexModsError('Invalid', `ui.settings.section: ${why}`);
    }
    // A mod's theme (ui.theme.add, public-hooks.md §3.14): an add rule on SettingsPage's theme, the Appearance page's, holding one theme.
    if (presentation === 'SettingsPage' && slot === 'theme') {
      const items = isPlain(data) ? data.items : undefined;
      const why = kind !== 'add' ? 'a theme is an add rule'
        : !(isPlain(of) && of.type === 'SettingsSection' && of.id === 'appearance') ? 'a theme is the Appearance page\'s (of: its SettingsSection)'
          : !(Array.isArray(items) && items.length === 1) ? 'a theme rule holds one theme' : themeWhy(items[0]);
      if (why) throw new CodexModsError('Invalid', `ui.theme.add: ${why}`);
    }
    if (forType !== undefined && (typeof forType !== 'string' || (o.typeExists && !o.typeExists(forType)))) throw new CodexModsError('Invalid', `unknown type ${forType}`);
    if (forType !== undefined && o.frameworkOwned?.(forType)) throw new CodexModsError('Denied', `${forType} is the framework's: no mod's rule presents it`);
    if (where !== undefined) { try { validateWhere(where, { window: true }); } catch (e) { throw new CodexModsError('Invalid', `where: ${e?.message ?? e}`); } }
    // The app's own parts (public-hooks.md §3.10): named ones only, never a protected one, never a protected holder as a whole. A subtype's
    // own view (graph-integrity G2.2) is not the app's: a ThreadView replaced for a Thread subtype the mod registered draws only its chats,
    // which the app's store never holds.
    const ownView = kind === 'replace' && presentation === 'ThreadView' && part === undefined && slot === undefined && typeof forType === 'string'
      && o.ownThread?.(modId, forType) === true;
    const appPartWhy = kind === 'style' || ownView ? null : partRuleWhy({ kind, presentation, slot, part, data });
    if (appPartWhy) throw new CodexModsError(/protected|holds protected/.test(appPartWhy) ? 'Denied' : 'Invalid', appPartWhy);
    if (of !== undefined) { try { validateOf(of); } catch (e) { throw new CodexModsError('Invalid', e?.message ?? String(e)); } }
    if (data !== undefined) {
      if (!isPlain(data)) throw new CodexModsError('Invalid', 'data is an object');
      if (JSON.stringify(data).length > MAX_DATA_BYTES) throw new CodexModsError('Invalid', 'a rule\'s data is at most 16 KiB');
    }
    // A host-realm rule's callbacks: the paths of the markers its data holds, each one there (P1); the renderer realm keeps its own.
    const marked = markersIn(data);
    if (marked === null) throw new CodexModsError('Invalid', 'an object with only $fn stands only as an entry\'s run callback, at its own path');
    // a token naming no callbacks: a renderer rule's is its window's registration (kept per window below), a host rule's its own
    if (reg !== undefined && !marked.size && callbacks === undefined) {
      if (typeof reg !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(reg)) throw new CodexModsError('Invalid', 'a registration token is letters, digits, ".", "_" and "-"');
    } else if (callbacks !== undefined || marked.size || reg !== undefined) {
      if (realm !== 'host') throw new CodexModsError('Invalid', 'only a host-realm rule names callbacks (the renderer realm keeps its functions)');
      if (!Array.isArray(callbacks) || callbacks.length > 64 || !callbacks.every((c) => typeof c === 'string' && PATH.test(c)) || new Set(callbacks).size !== marked.size || !callbacks.every((c) => marked.has(c))) {
        throw new CodexModsError('Invalid', 'a rule\'s callbacks are the paths of the {$fn} markers in its data, each once');
      }
      if (typeof reg !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(reg)) throw new CodexModsError('Invalid', 'a rule with callbacks names its registration token');
    }
    return Object.freeze({
      mod: modId, id, kind, ...(presentation !== undefined ? { presentation } : {}), ...(slot !== undefined ? { slot } : {}),
      ...(forType !== undefined ? { for: forType } : {}), ...(where !== undefined ? { where } : {}), ...(of !== undefined ? { of } : {}),
      ...(part !== undefined ? { part: Object.freeze(Array.isArray(part) ? [...part] : [part]) } : {}), priority, realm,
      // what its mod may read (public-hooks.md §3.1, §3.13): '*' or type ids, its own instances besides; a where (a style's too: on the
      // Window it styles) and live text read nothing else, through relations or not
      reads: graphGrants(grants).read,
      order: orderOf(modId, priority), ...(data !== undefined ? { data } : {}), ...(marked.size ? { callbacks: Object.freeze([...marked]), reg } : realm === 'host' && typeof reg === 'string' ? { reg } : {}),
    });
  }
  /** What makes two registrations of a rule the same rule (its data and placement; a renderer rule's functions stay in each window). */
  const shapeOf = (r) => JSON.stringify([r.kind, r.presentation ?? null, r.slot ?? null, r.for ?? null, r.where ?? null, r.of ?? null, r.part ?? null, r.priority, r.data ?? null]);
  const invokers = new Map();   // key -> { gen, reg, invoke }: a host-realm rule's callbacks, in its mod's worker
  const failed = new Set();     // registration tokens whose callback threw or ran out of time: off until the mod registers again
  /**
   * A rule as told. A renderer rule is each window's own registration (graph-layers.md §2): the record is the newest one, and its `regs`
   * (window id -> token) name only the windows whose registration has that same data, so an app-wide run (a menu bar entry, a graph
   * Command) goes only to a window whose functions go with it; a window still on an older one draws its own until its module updates too.
   */
  const told = (cur) => {
    const r = current(cur.rule);
    if (!cur.byWindow || !cur.byWindow.size) return r;
    const shape = shapeOf(cur.rule);
    const regs = [...cur.byWindow].filter(([, e]) => typeof e.reg === 'string' && shapeOf(e.rule) === shape).map(([w, e]) => [w, e.reg]);
    return regs.length ? Object.freeze({ ...r, regs: Object.freeze(Object.fromEntries(regs)) }) : r;
  };
  let windowSeq = 0;
  /** The newest of a renderer rule's window registrations, made the record's rule. */
  const newest = (cur) => { const e = [...cur.byWindow.values()].sort((a, b) => b.seq - a.seq)[0]; if (e) cur.rule = e.rule; };
  /**
   * A host-realm rule's callback, run for the framework: `{ran: true, value}` when it ran (its answer, JSON of at most 64 KiB, or null),
   * `{ran: false, why}` when it did not: `gone` (the rule, its activation or its callback went, or another registration is the rule's)
   * or `failed` (it threw or ran out of time before: off until the mod registers again). A throw or a timeout now rejects.
   */
  async function call(key, reg, path, env) {
    const cur = rules.get(key);
    const inv = invokers.get(key);
    if (typeof reg === 'string' && failed.has(reg)) return { ran: false, why: 'failed' };
    // the registration the page's entry came from, still the rule's and its binding's, in the same activation
    if (!cur || !inv || inv.gen !== cur.gen || cur.rule.reg !== reg || inv.reg !== reg || !cur.rule.callbacks?.includes(path)) return { ran: false, why: 'gone' };
    let out;
    // a palette source's search answers within 3 s (the palette waits on it as the user types); the others run up to 30 s
    try { out = await inv.invoke([path, env === undefined ? null : env], SEARCH_PATHS.has(path) ? SEARCH_MS : CALLBACK_MS); } catch (e) { failed.add(reg); throw e; }
    if (out === undefined || out === null) return { ran: true, value: null };
    let size;
    try { size = JSON.stringify(out).length; } catch { throw new CodexModsError('Invalid', 'a callback answers JSON'); }
    if (size > MAX_ANSWER_BYTES) throw new CodexModsError('Invalid', 'a callback answers at most 64 KiB');
    return { ran: true, value: out };
  }

  return {
    /**
     * @param {{ id: string, grants: string[], gen: object, realm: 'host' | 'renderer', window?: number }} who  the mod, its activation
     * @returns {{ order: number }}
     */
    register(who, raw) {
      const rule = check(who.id, who.grants, raw, who.realm);
      const key = `${who.id}/${rule.id}`;
      const cur = rules.get(key);
      const windows = cur && cur.gen === who.gen ? cur.windows : new Set();
      // A renderer rule is each window's own registration (graph-layers.md §2): a window's update is its own, the record the newest
      const byWindow = cur && cur.gen === who.gen && cur.byWindow ? cur.byWindow : new Map();
      if (who.realm === 'renderer' && Number.isInteger(who.window)) {
        windows.add(who.window);
        byWindow.set(who.window, { rule, reg: typeof raw.reg === 'string' ? raw.reg : null, seq: ++windowSeq });
      }
      const rec = { rule, gen: who.gen, windows, byWindow };
      rules.set(key, rec);
      const sent = told(rec);
      emit({ t: 'put', rule: sent });
      const unsupported = unsupportedParts(rule);
      return { order: sent.order, ...(unsupported.length ? { unsupported } : {}) };
    },
    /** A component's parts (public-hooks.md §3.10): the catalogue's, each with whether this build supports it. */
    parts(presentation, slot) {
      const bySlot = o.parts?.get(presentation);
      return partsOf(presentation, slot).map((p) => {
        const kinds = bySlot?.get(p.slot)?.get(p.part);
        return Object.freeze({ ...p, supported: !!kinds, ...(kinds ? { kinds: Object.freeze([...kinds].sort()) } : {}) });
      });
    },
    /** The mod disposed a rule: from one window (renderer) or everywhere (host). */
    dispose(who, id) {
      const key = `${who.id}/${id}`;
      const cur = rules.get(key);
      if (!cur || cur.gen !== who.gen) return false;
      if (cur.rule.realm === 'renderer' && Number.isInteger(who.window)) {
        cur.windows.delete(who.window);
        cur.byWindow?.delete(who.window);
        if (cur.windows.size) { newest(cur); emit({ t: 'put', rule: told(cur) }); return true; }
      }
      rules.delete(key);
      emit({ t: 'remove', key });
      return true;
    },
    /** Every rule of a mod, at its teardown (disabled, removed, quarantined, restarted). */
    disposeMod(modId) {
      for (const [key, cur] of [...rules]) if (cur.rule.mod === modId) { rules.delete(key); emit({ t: 'remove', key }); }
      for (const key of [...invokers.keys()]) if (key.startsWith(`${modId}/`)) invokers.delete(key);
    },
    /**
     * A host-realm rule's callbacks, served by its mod's worker (P1): `invoke([path, env], deadlineMs)`. Bound before the rule is
     * registered; gone with the binding's disposal, the mod's teardown or another activation.
     */
    bindCallbacks(who, id, reg, invoke) {
      if (who.realm !== 'host') throw new CodexModsError('Invalid', 'only the host realm serves a rule\'s callbacks');
      if (typeof id !== 'string' || !ID.test(id)) throw new CodexModsError('Invalid', 'a rule id is needed');
      if (typeof reg !== 'string' || !reg) throw new CodexModsError('Invalid', 'a registration token is needed');
      const key = `${who.id}/${id}`;
      const entry = { gen: who.gen, reg, invoke };
      invokers.set(key, entry);
      return { dispose() { if (invokers.get(key) === entry) invokers.delete(key); } };
    },
    /**
     * Call a host-realm rule's callback for the page (the user ran it): `null` when the rule, its activation or the callback went (a late
     * click is a no-op); its answer, which must be JSON of at most 64 KiB; a throw or a timeout rejects (the page counts the fault).
     */
    async callback(key, reg, path, env) {
      const r = await call(key, reg, path, env);
      return r.ran ? r.value : null;
    },
    /** The same call, saying whether it ran (a Command's `run`, E8.11: "ran" is said only when it did; review 4, round 2). */
    run: call,
    /** A window went: the renderer rules only it held go. */
    closeWindow(windowId) {
      for (const [key, cur] of [...rules]) {
        if (cur.rule.realm !== 'renderer' || !cur.windows.delete(windowId)) continue;
        cur.byWindow?.delete(windowId);
        if (cur.windows.size) { newest(cur); emit({ t: 'put', rule: told(cur) }); continue; }
        rules.delete(key);
        emit({ t: 'remove', key });
      }
    },
    /** A mod's rank changed (the user's order): every rule of it gets its new order. */
    reorder(modId) {
      for (const cur of rules.values()) if (cur.rule.mod === modId) emit({ t: 'put', rule: told(cur) });
    },
    snapshot: () => [...rules.values()].map(told),
    /**
     * A mod's own rule, as told, in its activation `gen` (null when it has none: gone, another activation's); with `reg`, only that
     * registration (a host rule's token, or one of a renderer rule's windows' own).
     */
    ownRule(modId, id, gen, reg) {
      const cur = rules.get(`${modId}/${id}`);
      if (!cur || cur.gen !== gen) return null;
      if (typeof reg === 'string' && !(cur.rule.reg === reg || [...(cur.byWindow?.values() ?? [])].some((e) => e.reg === reg))) return null;
      return told(cur);
    },
    /**
     * A renderer rule as one window registered it (its own data, priority and order, and that window's token as its `regs`), or null when
     * that window did not: what applies in that window while its windows' registrations differ (built review H7lr round 2).
     */
    windowRule(key, windowId) {
      const cur = rules.get(key);
      const e = cur?.byWindow?.get(windowId);
      if (!e || typeof e.reg !== 'string') return null;
      return Object.freeze({ ...current(e.rule), regs: Object.freeze({ [String(windowId)]: e.reg }) });
    },
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
  };
}
