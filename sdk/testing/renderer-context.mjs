// createFakeRendererContext: a RendererContext whose `ui` records commands, settings pages, notifications and what the mod hosts (panel tabs,
// regions, main pages, the app's chats and panel kinds in its places), and whose `graph` records what is invoked; given `graph` (a test
// graph's renderer realm: `(await createTestGraph().mod(dir)).renderer().graph`), it is that real graph instead. Commands and pages go through the framework's own rule API over a fake channel: the mod side's checks and handles are the real ones; of the Host's it
// applies the id and the grant each needs (`graph.present` for its presentation), refused as the Host would, not what a build's bindings draw. Every other namespace is the same fake core as the host's; pass
// `host: <control from createFakeHostContext>` to share storage, settings, events, services and the app-server fake with it (as the real Host does
// across realms), otherwise the renderer gets its own.
import fs from 'node:fs';
import { CodexModsError } from '../errors.mjs';
import { createCore, clone } from './core.mjs';
import { createFakeReact } from './fake-react.mjs';
import { createRuleApi } from '../../framework/shared/ui-rules-client.mjs';
import { createKit } from '../../framework/renderer/present/kit/index.mjs';
import { createSettingRow } from '../../framework/renderer/present/setting-row.mjs';
import { createLentParts } from '../../framework/renderer/present/lent/index.mjs';

const MODIFIERS = new Set(['cmd', 'command', 'ctrl', 'control', 'cmdorctrl', 'commandorcontrol', 'alt', 'option', 'altgr', 'shift', 'meta', 'super']);
/** 'CmdOrCtrl+\\', 'Cmd+Shift+P': zero or more modifiers then exactly one key, separated by '+' (v1.9). */
export function validAccelerator(keys) {
  if (typeof keys !== 'string' || !keys) return false;
  const parts = keys.split('+');
  if (parts.length > 1 && parts.at(-1) === '' ) parts.splice(-2, 2, '+');   // a literal '+' key
  const key = parts.pop();
  return Boolean(key) && parts.every((p) => MODIFIERS.has(p.toLowerCase())) && (key.length === 1 || /^(F\d{1,2}|Esc|Escape|Enter|Return|Tab|Space|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown)$/i.test(key));
}

export function createFakeRendererContext({ manifest, grants, settings, host, tokens, graph: realGraph } = {}) {
  const core = host ? host.core : createCore({ manifest, grants, settings, kind: 'renderer' });
  const m = host ? host.core.manifest : manifest;
  const need = (flag) => { if (!core.granted.flags.has(flag)) throw new CodexModsError('Denied', `permission "${flag}" is not granted`); };
  const { React, createRoot } = createFakeReact();

  const rec = { commands: new Map(), pages: new Map(), notifications: [], invoked: [], onInvoke: null, refused: [],
    panels: new Map(), regions: new Map(), mainPages: new Map(), hostRules: new Map(), rules: new Map(), hosted: [], opened: [], parts: new Map() };
  // the framework's own rule API, the Host's grant check on its channel: a rule without its grant is refused as it would be in the app
  const presentable = (type) => [...core.granted.flags].some((g) => g === 'graph.present' || (g.startsWith('graph.present:') && g.slice('graph.present:'.length).split(',').map((x) => x.trim()).includes(type)));
  const pendingRules = [];
  const rules = createRuleApi({
    modId: m.id, realm: 'renderer',
    channel: {
      register(desc) {
        if (typeof desc.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(desc.id)) throw new CodexModsError('Invalid', 'a rule needs an id (letters, digits, ".", "_" and "-", at most 64)');
        if (desc.presentation !== undefined && !presentable(desc.presentation)) throw new CodexModsError('Denied', `this mod has not been granted graph.present for ${desc.presentation}`);
        return {};
      },
      dispose() {},
    },
    onRefused: (id, e) => {
      rec.refused.push({ id, code: e?.code ?? 'Unavailable', message: String(e?.message ?? e) });
      for (const m of [rec.commands, rec.pages, rec.panels, rec.regions, rec.mainPages, rec.hostRules, rec.rules]) m.delete(id);
    },
    settings: { open: (page) => (page === null || rec.pages.has(page)) },
    // what the handles open in this (fake) window: recorded, and true while the view is declared
    panels: {
      open: (id, opts) => { rec.opened.push({ kind: 'panel', id, ...(opts?.placement ? { placement: opts.placement } : {}) }); return rec.panels.has(id); },
      close: (id) => { rec.opened.push({ kind: 'panel-close', id }); return rec.panels.has(id); },
    },
    mainPages: { open: (id) => { rec.opened.push({ kind: 'page', id }); return rec.mainPages.has(id); } },
  }).api;
  // the rule API's handle is a proxy over its current declaration: a facade over it, so a dispose also leaves the records and an update changes what they run
  const recorded = (what, id, handle, drop, record) => {
    pendingRules.push(handle.accepted);
    const t = core.track(what, id, () => { drop(); handle.dispose(); });
    const update = (patch) => {
      const done = handle.update(patch);
      record(patch);
      pendingRules.push(done);
      return done;
    };
    return new Proxy(handle, { get: (_, k) => (k === 'dispose' ? t.dispose : k === 'update' && typeof handle.update === 'function' ? update : handle[k]) });
  };
  const roots = new Set();

  const el = (tag, extra = {}) => ({ children, ...props }) => React.createElement(tag, { ...props, ...extra }, children);
  const components = {
    Button: el('button', { 'data-component': 'Button' }), Switch: ({ checked, onChange, ...p }) => React.createElement('input', { type: 'checkbox', checked, onChange, 'data-component': 'Switch', ...p }),
    TextField: ({ value, onChange, ...p }) => React.createElement('input', { type: 'text', value, onChange, 'data-component': 'TextField', ...p }),
    Menu: el('div', { 'data-component': 'Menu' }), Dialog: el('div', { 'data-component': 'Dialog' }),
    SettingsSection: Object.assign(({ children, id }) => React.createElement('section', { id, 'data-component': 'SettingsSection' }, children), {
      Header: ({ title, subtitle, actions }) => React.createElement('header', {}, React.createElement('h2', {}, title), subtitle ? React.createElement('p', {}, subtitle) : null, actions ?? null),
      Content: ({ children }) => React.createElement('div', {}, children),
      Footer: ({ children }) => React.createElement('footer', {}, children),
    }),
    SettingsRow: ({ label, description, control, id }) => React.createElement('div', { id, 'data-component': 'SettingsRow' }, React.createElement('label', {}, label), description ? React.createElement('p', {}, description) : null, control ?? null),
    Tooltip: el('span', { 'data-component': 'Tooltip' }), Icon: el('span', { 'data-component': 'Icon' }),
  };
  // the framework's own, as they are in the app: with no app pieces and no page they draw plainly
  const kit = createKit({ react: () => React, parts: () => ({}), document: () => null });
  const { Badge, Banner, Checkbox, EmptyState, Glyph, IconTile, MenuButton, SearchField, SegmentedControl, Select, Tabs } = kit;
  Object.assign(components, { Badge, Banner, Checkbox, EmptyState, Glyph, IconTile, MenuButton, SearchField, SegmentedControl, Select, Tabs });
  // the mod's SettingRow (graph-integrity G3.6): reads and sets as the mod, through this context's graph (a test graph's real one when given)
  // the parts the framework lends (graph-integrity G2.3), drawn as their fallbacks (no app pieces here)
  const { ensureStyle: _lentStyle, ...lent } = createLentParts({ react: () => React, kit, exports: () => ({}), document: () => null });
  Object.assign(components, lent);
  components.SettingRow = createSettingRow({ R: () => React, kit, exports: () => components, modId: manifest?.id ?? 'example.mod', graph: () => graph });
  const themeTokens = tokens ?? { 'text-primary': '#111', 'text-secondary': '#666', 'border-default': '#ddd', 'surface-default': '#fff', accent: '#06c' };
  const themeListeners = new Set();

  const ui = {
    react: React, components,
    theme: {
      tokens: () => ({ ...themeTokens }), appearance: 'light',
      onChange(fn) { core.guard(); themeListeners.add(fn); return core.track('theme.onChange', '', () => themeListeners.delete(fn)); },
    },
    commands: {
      // ui.commands.add (public-hooks.md §3.14), as a mod declares it: recorded, its run called by `control.runCommand`
      add(spec) {
        core.guard();
        for (const keys of spec?.keys === undefined ? [] : [spec.keys].flat()) if (!validAccelerator(keys)) throw new CodexModsError('Invalid', `keys must be Electron-accelerator style with '+' (e.g. 'CmdOrCtrl+\\'), got ${JSON.stringify(keys)}`);
        const h = rules.commands.add(spec);
        rec.commands.set(spec.id, { id: spec.id, spec });
        return recorded('ui.command', spec.id, h, () => rec.commands.delete(spec.id), (patch) => { const c = rec.commands.get(spec.id); if (c) c.spec = { ...c.spec, ...patch }; });
      },
    },
    // ui.parts (public-hooks.md §3.10): the app's own parts a place draws, as the test gives them (`control.setParts`): none by default
    async parts(presentation, opts = {}) {
      core.guard();
      const list = rec.parts.get(String(presentation)) ?? [];
      return clone(opts?.slot ? list.filter((x) => x.slot === opts.slot) : list);
    },
    settings: {
      // ui.settings.page (public-hooks.md §3.14): recorded, its component drawn by `control.render`
      page(spec) {
        core.guard();
        const h = rules.settings.page(spec);
        rec.pages.set(spec.id, spec);
        return recorded('ui.settings.page', spec.id, h, () => rec.pages.delete(spec.id), (patch) => { const c = rec.pages.get(spec.id); if (c) rec.pages.set(spec.id, { ...c, ...patch }); });
      },
      open: (page) => rules.settings.open(page),
    },
    // Hosting (docs/design/layouts.md, mod-surfaces.md §3.1): declared through the framework's rule API as in the app, recorded, and drawn by
    // `control.render(id)`. The app's chats and panel kinds a mod hosts are elements standing for them (`hosted-thread`, `hosted-tab`),
    // recorded in `control.hosted`: the app draws them, a test checks what the mod asked for.
    panel(spec) {
      core.guard();
      const h = rules.panel(spec);
      rec.panels.set(spec.id, spec);
      return recorded('ui.panel', spec.id, h, () => rec.panels.delete(spec.id), (patch) => { const c = rec.panels.get(spec.id); if (c) rec.panels.set(spec.id, { ...c, ...patch }); });
    },
    regions: Object.freeze({
      add(spec) {
        core.guard();
        const h = rules.regions.add(spec);
        rec.regions.set(spec.id, spec);
        return recorded('ui.regions.add', spec.id, h, () => rec.regions.delete(spec.id), (patch) => { const c = rec.regions.get(spec.id); if (c) rec.regions.set(spec.id, { ...c, ...patch }); });
      },
    }),
    pages: Object.freeze({
      add(spec) {
        core.guard();
        const h = rules.pages.add(spec);
        rec.mainPages.set(spec.id, spec);
        return recorded('ui.pages.add', spec.id, h, () => rec.mainPages.delete(spec.id), (patch) => { const c = rec.mainPages.get(spec.id); if (c) rec.mainPages.set(spec.id, { ...c, ...patch }); });
      },
    }),
    host: Object.assign((presentation, spec) => {
      core.guard();
      const h = rules.host(presentation, spec);
      rec.hostRules.set(spec.id, { presentation, ...spec });
      return recorded('ui.host', spec.id, h, () => rec.hostRules.delete(spec.id), (patch) => { const c = rec.hostRules.get(spec.id); if (c) rec.hostRules.set(spec.id, { ...c, ...patch }); });
    }, {
      supported: () => ({ thread: true, transcript: true, tabs: ['review', 'subagents'] }),
      thread(ref, opts = {}) {
        core.guard();
        const composer = opts?.composer !== false;
        rec.hosted.push({ kind: 'thread', thread: ref, composer, ...(opts?.key ? { key: opts.key } : {}) });
        return React.createElement('hosted-thread', { 'data-thread': `${ref?.provider}:${ref?.id}`, 'data-composer': String(composer) });
      },
      tab(kind, ref) {
        core.guard();
        rec.hosted.push({ kind: 'tab', tab: String(kind), thread: ref });
        return React.createElement('hosted-tab', { 'data-tab': String(kind), 'data-thread': `${ref?.provider}:${ref?.id}` });
      },
    }),
    // ui.notify (public-hooks.md §3.14): recorded as it was asked for, its handle as a real one's (its id once shown)
    notify(spec) {
      core.guard(); need('ui');
      if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string' || !spec.title.trim()) throw new CodexModsError('Invalid', 'ui.notify takes {title, ...}');
      const id = `fake:n${rec.notifications.length + 1}`;
      const n = { id, title: spec.title, kind: spec.kind ?? 'info', ...(spec.body !== undefined ? { body: spec.body } : {}), surface: spec.surface ?? 'auto', dismissed: false };
      rec.notifications.push(n);
      return { id, shown: Promise.resolve(id), update: async (patch) => { Object.assign(n, patch); return true; }, dismiss: async () => { n.dismissed = true; return true; } };
    },
  };

  // the presentation rules a mod declares on the app's presentations (decorate, replace, hide, reorder, add, style, banner, filter,
  // status): through the framework's own rule API, recorded by id in `control.rules` ({kind, target, spec}); a rule with a component
  // (`replace`'s render) is drawn by `control.render(id, props)` (graph-integrity G8.3: the starters' tests)
  for (const name of ['decorate', 'replace', 'hide', 'reorder', 'add', 'style', 'banner', 'filter', 'status']) {
    if (typeof rules[name] !== 'function') continue;
    ui[name] = (target, spec) => {
      core.guard();
      const h = rules[name](target, spec);
      const s = spec ?? target;
      const id = s?.id;
      rec.rules.set(id, { kind: name, target: typeof target === 'string' ? target : null, spec: s });
      return recorded(`ui.${name}`, id, h, () => rec.rules.delete(id), (patch) => { const c = rec.rules.get(id); if (c) rec.rules.set(id, { ...c, spec: { ...c.spec, ...patch } }); });
    };
  }

  // the rule API's namespaces not drawn above (ui.composer.control, slash, mention, attachSource, suggest; ui.contextMenu.add; ...): through
  // the framework's own rule API, recorded by id in `control.rules` as {kind: '<namespace>.<name>', target: null, spec}
  for (const [space, members] of Object.entries(rules)) {
    if (!members || typeof members !== 'object' || Array.isArray(members) || Object.hasOwn(ui, space)) continue;
    const fns = Object.entries(members).filter(([, fn]) => typeof fn === 'function');
    if (!fns.length) continue;
    ui[space] = {};
    for (const [name, fn] of fns) {
      ui[space][name] = (spec, ...rest) => {
        core.guard();
        const h = fn(spec, ...rest);
        const id = spec?.id;
        rec.rules.set(id, { kind: `${space}.${name}`, target: space === 'composer' ? 'Composer' : null, spec });
        return recorded(`ui.${space}.${name}`, id, h, () => rec.rules.delete(id), (patch) => { const c = rec.rules.get(id); if (c) rec.rules.set(id, { ...c, spec: { ...c.spec, ...patch } }); });
      };
    }
  }

  const { intercept: _i, ...appServer } = core.api.appServer; void _i;
  // ctx.graph, as far as a test needs it: what is invoked is recorded, and answers done unless `control.onInvoke` says otherwise
  const graph = realGraph ?? {
    async invoke(ref, operation, args = []) {
      core.guard(); need('graph');
      if (!rec.onInvoke) { rec.invoked.push({ ref, operation, args }); return { status: 'done', value: null }; }
      return rec.onInvoke(ref, operation, args);
    },
  };
  const ctx = Object.freeze({ ...core.api, appServer, ui, graph });

  const control = {
    ctx,
    get commands() { return rec.commands; },
    /** Mod intelligence, faked: `answer(fn)` answers each `ctx.intelligence.ask` (fn(spec, {tool(name, args), text(delta)})), `asks()` lists
     *  them (each with the tool names it was given), `enable(on)` is the user's switch for the mod's model use. */
    intelligence: {
      answer(fn) { core.intelligence.answer = fn; },
      asks: () => core.intelligence.asks.map((x) => clone(x)),
      enable(on) { core.intelligence.enabled = on !== false; },
    },
    get pages() { return rec.pages; },
    /** Declared panel tabs, regions, main pages and host rules, by id; what the mod hosts of the app's (chats, panel kinds); what it opened. */
    get panels() { return rec.panels; },
    get regions() { return rec.regions; },
    get mainPages() { return rec.mainPages; },
    get hostRules() { return rec.hostRules; },
    /** The presentation rules it declared (decorate, replace, hide, ...), by id: {kind, target, spec}. */
    get rules() { return rec.rules; },
    get hosted() { return rec.hosted; },
    get opened() { return rec.opened; },
    get notifications() { return rec.notifications; },
    get invoked() { return rec.invoked; },
    /** The rules refused as the app would refuse them (a grant it lacks): {id, code, message}, once they have settled. */
    get refused() { return rec.refused; },
    /** Every rule so far has been answered. */
    async settled() { await Promise.all(pendingRules); },
    get logs() { return core.logs; },
    /** The app's own parts a place draws, for `ui.parts(presentation)`: `[{slot, part, title, supported, protected?, kinds?}]`. */
    setParts(presentation, list) { rec.parts.set(String(presentation), clone(list ?? [])); },
    /** Answer ctx.graph.invoke: `(ref, operation, args) => outcome`, or throw. */
    onInvoke(fn) { rec.onInvoke = fn; },
    /** Run a command as the framework would, with its env. */
    async runCommand(id, env = {}) {
      const c = rec.commands.get(id);
      if (!c) throw new Error(`no command "${id}"`);
      return c.spec.run(Object.freeze({ subject: null, window: null, pane: null, thread: null, draft: null, via: 'palette', ...env }));
    },
    /**
     * Renders what the mod declared under `id` with the fake React: a settings page, a main page, a region, or a panel tab. A panel tab's
     * component gets the context a tab gets in the app (`thread`, `draft`, `window`, `project`, its `state`), from `props`.
     */
    async render(id, props = {}) {
      const panel = rec.panels.get(id);
      const drawn = typeof rec.rules.get(id)?.spec?.render === 'function' ? rec.rules.get(id).spec : null;
      const page = rec.pages.get(id) ?? rec.mainPages.get(id) ?? rec.regions.get(id) ?? panel ?? drawn;
      if (!page) throw new Error(`nothing to render for "${id}"`);
      const given = panel ? { mod: m.id, view: id, instance: null, tabId: `fake:${id}`, isActive: true, isVisible: true, thread: null, draft: null,
        window: null, project: null, state: null, setState() {}, close() {}, ...props } : props;
      const root = createRoot(); roots.add(root);
      root.render(React.createElement(page.render, given));
      await root.settle();
      return root;
    },
    registrations: () => { const o = {}; for (const r of core.registry.values()) o[r.kind] = (o[r.kind] ?? 0) + 1; o.total = core.registry.size; return o; },
    /** Disable path: run the renderer disposer, dispose registrations, unmount rendered roots. */
    async activate(definition) {
      const fn = typeof definition === 'function' ? definition : (definition.default ?? definition).renderer;
      if (typeof fn !== 'function') throw new CodexModsError('Invalid', 'definition has no renderer entry');
      rec.refused.length = 0;
      control._disposer = await fn(ctx);
      // what the app would have refused fails here, not silently in the app
      await control.settled();
      if (rec.refused.length) throw new CodexModsError(rec.refused[0].code, `rule ${rec.refused[0].id}: ${rec.refused[0].message}`);
      return control._disposer;
    },
    async deactivate() {
      const r = control._disposer; control._disposer = null;
      if (typeof r === 'function') await r(); else if (r?.dispose) await r.dispose();
      for (const root of roots) root.unmount();
      for (const reg of [...core.registry.values()]) { try { await reg.dispose(); } catch { /* ignore */ } }
      if (!host) core.disposed = true;
    },
    cleanup() { if (!host && core.ownsDataDir) { try { fs.rmSync(core.dataDir, { recursive: true, force: true }); } catch { /* ignore */ } } },
    core, manifest: m,
  };
  return { ctx, control };
}
