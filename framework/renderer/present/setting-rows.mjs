// A mod's settings on its page in the app's Settings (docs/design/framework-ui.md F7; systems.md S15, "E3 in detail"): one card per section (the mod's, then each group's, with what it says
// of itself and its Reset all), each active setting a row with its control (setting-controls.mjs), a changed dot while its value differs from its default, and Reset while a value is stored
// at that scope, since a project's value equal to the default can still shadow the app's. A project-scope setting has a project menu: choosing a project edits that project's value in the
// same row (with its Reset), and the row says which it is; a thread-scope setting says that each chat chooses its own in the composer, or, when the composer has no room for it (its
// budget, composer-pickers.mjs), that it is not there.
// Every write is the instance's Setting.set or reset through the graph (the page's framework scope as the caller), skipped when it is what is stored, and the row follows the operation's
// end: a refusal shows under it. The rows read the graph through relation views (a section's settings and its groups); a project's instance is observed when the row shows it, so the
// provider puts it. The same row draws the app's own Settings for a mod's section on its pages (settings-sections.mjs). NO NODE API.
import { createReport } from './reports.mjs';
import { pickersOf, scopedOf, BUDGET } from './composer-pickers.mjs';
import { createKit } from './kit/index.mjs';
import { createModMedia } from './mod-media.mjs';
import { createSettingControls } from './setting-controls.mjs';

const P = 'codexmods.framework';
const FRAMEWORK = Object.freeze({ type: 'CodexMods', provider: P, id: 'codexmods' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MAX_PROJECTS = 20;
const lowerFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);
/** What defines a setting (its `definedBy` link: a mod's Mod, an agent, the app), or null. */
const definerOf = (setting) => { const d = setting?.links?.definedBy; return d && typeof d === 'object' && typeof d.id === 'string' ? d : null; };

/**
 * @param {{ R: object, exports: () => object, subscribe: (query: object, fn: (m: object) => void) => { dispose(): void },
 *   invoke: (ref: object, operation: string, args?: unknown[]) => Promise<object>, ctx: object, log?: (m: string, d?: object) => void, kit?: object }} o
 */
export function createSettingRows(o) {
  const { R } = o;
  const e = R.createElement;
  const Report = createReport(R, o.ctx);
  const kit = o.kit ?? createKit({ react: () => R, parts: () => { const ex = o.exports() ?? {}; return { Button: ex.Button, Menu: ex.Menu, MenuItem: ex.MenuParts?.Item, Separator: ex.MenuParts?.Separator }; } });
  const { ModMedia, useImage } = createModMedia({ R, kit, invoke: o.invoke });
  const controls = createSettingControls({ R, kit, exports: o.exports, useImage });

  /** The instances of a relation (or a collection), kept by a view while the component is mounted. */
  function useView(query, key) {
    const [items, setItems] = R.useState([]);
    R.useEffect(() => {
      if (!query) return undefined;
      let list = new Map();
      const sub = o.subscribe(query, (m) => {
        if (!m) return;
        if (m.type === 'snapshot' || (m.type === 'delta' && Array.isArray(m.items))) list = new Map((m.items ?? []).filter((x) => x && !x.gone).map((x) => [x.ref.id, x]));
        else if (m.type === 'delta' && m.event) {
          if (m.event.kind === 'removed') list.delete(m.event.ref.id);
          else if (m.event.instance) list.set(m.event.ref.id, m.event.instance);
        }
        setItems([...list.values()]);
      });
      return () => sub.dispose();
    }, [key]);
    return items;
  }

  /** The thread-scope settings the composer has no room for, by id (the composer's own choice, from every mod's settings). */
  function useOverComposer(on) {
    const all = useView(on ? { type: 'Setting', depth: 'core' } : null, on ? 'composer' : null);
    const fw = o.ctx.use(() => (on ? o.ctx.subject(FRAMEWORK) ?? null : null));
    const order = (fw && !fw.gone ? fw.links?.mods ?? [] : []).map((r) => r.id);
    const mods = o.ctx.use(() => order.map((id) => o.ctx.subject({ type: 'Mod', provider: P, id })).filter(Boolean));
    return new Set(pickersOf(all, mods, order).over.map((x) => x.ref.id));
  }

  /** A setting's row; a project-scope one with its project menu. `busy`: an operation on its mod is running; `icons`: its section keeps a column for them. */
  function Row({ setting, over, busy: held, icons }) {
    const s = setting.state ?? {};
    const owner0 = definerOf(setting);
    const projectScoped = Array.isArray(s.scopes) && s.scopes.includes('project') && !s.scopes.includes('thread');
    const [project, setProject] = R.useState(null);   // a project's ref, or null for every project's default
    const [error, setError] = R.useState(null);
    const [busy, setBusy] = R.useState(false);
    const projects = useView(projectScoped ? { type: 'Project', depth: 'core' } : null, projectScoped ? 'projects' : null).slice(0, MAX_PROJECTS);
    // The project's own instance when one is chosen: the one of the project's `settings` with this setting's definer and key (its provider
    // contributes it when the relation is read, graph-integrity G3.4).
    const projectSettings = useView(project ? { ref: project, relation: 'settings' } : null, project ? `${project.provider}\u001f${project.id}` : null);
    const scoped = project ? scopedOf(projectSettings, setting) : null;
    const shown = project ? scoped : setting;
    const here = shown && !shown.gone ? shown.state ?? {} : null;
    const label = String(s.title ?? setting.ref.id);
    const lower = label[0] ? label[0].toLowerCase() + label.slice(1) : label;
    const write = async (op, args) => {
      if (!here) return;
      if (op === 'set' && same(args[0], here.value) && here.overridden) return;
      setBusy(true); setError(null);
      try {
        const out = await o.invoke(shown.ref, op, args);
        if (out && out.status && out.status !== 'done') setError(out.error?.message ?? out.message ?? 'Not changed');
      } catch (err) { setError(String(err?.message ?? err)); } finally { setBusy(false); }
    };
    const disabled = busy || Boolean(held);
    const control = here ? controls.control({ s: here, label, disabled, write: (v) => write('set', [v]), onError: setError, definedBy: owner0 }) : e('span', { className: 'text-secondary' }, '…');
    const stacked = controls.stacked(s);
    const reset = here?.overridden ? e('button', { key: 'reset', type: 'button', className: 'cmk-more cmk-setting-reset', 'aria-label': `Reset ${lower}`, title: 'Reset', disabled, onClick: () => write('reset', []) }, e(kit.Glyph, { name: 'undo' })) : null;
    const name = (p) => String(p.state?.name ?? p.state?.title ?? p.ref.id);
    const where = projectScoped ? e(kit.Select, { key: 'where', ariaLabel: `${label}: where`, value: project?.id ?? '*', disabled,
      options: [{ value: '*', label: 'Every project' }, ...projects.map((p) => ({ value: p.ref.id, label: name(p) }))],
      onChange: (id) => { setProject(id === '*' ? null : projects.find((p) => p.ref.id === id)?.ref ?? null); setError(null); } }) : null;
    const inComposer = Array.isArray(s.scopes) && s.scopes.includes('thread') && (s.kind === 'choice' || s.kind === 'toggle')
      ? (over?.has(setting.ref.id) ? `Not in the composer, which has room for ${BUDGET}: chats use this value.` : 'Each chat can choose its own in the composer.')
      : null;
    const description = project ? `For this project${here?.overridden ? '' : ' (the default for every project)'}` : (inComposer && s.description ? `${/[.!?]$/.test(s.description) ? s.description : `${s.description}.`} ${inComposer}` : s.description ?? inComposer ?? null);
    // the changed dot: its value differs from its default, which is another thing than what Reset says
    const changed = here ? !same(here.value, here.default) : false;
    // F8: a setting that needs one of its mod's optional permissions says so while that permission is not allowed; changing a value never changes a permission
    const needed = o.ctx.use(() => {
      if (!s.needs || !owner0) return null;
      const perm = (o.ctx.subject(owner0)?.state?.permissions ?? []).find((p) => p.id === s.needs);
      return perm?.optional && perm.decision !== 'allow' ? perm : null;
    });
    const [allowing, setAllowing] = R.useState(false);
    const allow = async () => {
      setAllowing(true); setError(null);
      try { const out = await o.invoke(owner0, 'setPermission', [s.needs, 'allow']); if (out && out.status && out.status !== 'done') setError(out.error?.message ?? out.message ?? 'Not allowed'); }
      catch (err) { setError(String(err?.message ?? err)); } finally { setAllowing(false); }
    };
    const need = needed && !held ? e('div', { className: 'cmk-setting-needs' }, e(kit.Glyph, { name: 'shield-alert', size: 12 }),
      e('span', null, `Needs permission to ${lowerFirst(String(needed.label ?? needed.text ?? s.needs))}`), e('button', { type: 'button', className: 'cmk-setting-allow', disabled: allowing, onClick: allow }, 'Allow')) : null;
    // reported as a SettingsRow of the mod's page (E6.5): the page's subject is what defines the setting, its Mod (`on`)
    const owner = owner0;
    return e('div', { className: 'cmk-setting', 'data-setting': setting.ref.id },
      e('div', { className: 'cmk-setting-row' },
        e('div', { className: 'cmk-setting-lead' },
          icons ? e('span', { className: 'cmk-setting-icon' }, s.icon ? e(kit.Glyph, { name: s.icon }) : null) : null,
          e('div', { className: 'cmk-setting-text' },
            e('div', { className: 'cmk-setting-title' }, label, changed ? e('span', { className: 'cmk-changed', role: 'img', title: 'Changed', 'aria-label': 'Changed' }) : null),
            description ? e('div', { className: 'cmk-setting-description' }, description) : null,
            need,
            error ? e('div', { className: 'cmk-setting-error', role: 'alert' }, error) : null)),
        e('div', { className: 'cmk-setting-control' }, reset, where, stacked ? null : control)),
      stacked ? e('div', { className: 'cmk-setting-stacked', ...(icons ? { 'data-icons': '' } : {}) }, control) : null,
      owner ? e(Report, { type: 'SettingsRow', subject: setting.ref, place: { in: 'SettingsPage', on: owner, slot: 'settings' } }) : null);
  }

  /** The mod a section belongs to, for its image. */
  const modOfSection = (ref) => { const m = /^mod:([^:]+)/.exec(String(ref?.id)); return m ? { type: 'Mod', provider: ref.provider, id: m[1] } : null; };

  /** A section's card: what it says of itself, Reset all while more than one value is stored at the app scope (hidden rows included), and its active rows. */
  function SectionCard({ section, list, over, busy, title }) {
    const ex = o.exports() ?? {};
    const [working, setWorking] = R.useState(false);
    const [error, setError] = R.useState(null);
    const shown = list.filter((x) => x.state?.active !== false);
    if (!list.length) return null;
    const icons = shown.some((x) => x.state?.icon);
    const st = section?.state ?? {};
    const name = title ?? null;
    const lower = name ? name.toLowerCase() : null;
    const resetAll = async () => {
      setWorking(true); setError(null);
      try {
        const out = await o.invoke(section.ref, 'resetAll', []);
        if (out && out.status && out.status !== 'done') setError(out.error?.message ?? out.message ?? 'Not changed');
      } catch (err) { setError(String(err?.message ?? err)); } finally { setWorking(false); }
    };
    const many = list.filter((x) => x.state?.overridden).length > 1;
    const action = many && !busy && section ? e('button', { type: 'button', className: 'cmk-more', 'aria-label': lower ? `Reset ${lower} settings` : 'Reset all settings', disabled: working, onClick: resetAll }, 'Reset all') : null;
    const heading = name ? e('span', { className: 'cmk-group-title' }, st.icon ? e(kit.Glyph, { name: st.icon }) : null, name) : null;
    return e(ex.SettingsSection, null,
      heading || action || st.description ? e(ex.SettingsSection.Header, { title: heading, ...(st.description ? { subtitle: st.description } : {}), ...(action ? { actions: action } : {}) }) : null,
      e(ex.SettingsSection.Content, null,
        error ? e('p', { className: 'cmk-error', role: 'alert' }, error) : null,
        e(ex.SettingsCard, null,
          ...(st.media ? [e('div', { key: 'media', className: 'cmk-setting-media' }, e(ModMedia, { mod: modOfSection(section.ref), item: st.media }))] : []),
          ...shown.map((x) => e(Row, { key: x.ref.id, setting: x, over, busy, icons })))));
  }

  /** The cards of a mod's settings: its own section's, then each group's. `busy`: an operation on the mod is running. A stopped mod's stay editable: a setting can be what stopped it. */
  function ModSettings({ sectionRef, busy }) {
    const ex = o.exports() ?? {};
    const section = o.ctx.use(() => (sectionRef ? o.ctx.subject(sectionRef) ?? { ref: sectionRef } : null));
    const own = useView(sectionRef ? { ref: sectionRef, relation: 'settings', depth: 'core' } : null, sectionRef?.id);
    const groups = useView(sectionRef ? { ref: sectionRef, relation: 'children', depth: 'core' } : null, sectionRef ? `${sectionRef.id}/children` : null);
    const over = useOverComposer(!!sectionRef);
    if (!sectionRef || !ex.SettingsSection || !ex.SettingsCard) return null;
    const scoped = (list) => list.filter((x) => x.state?.scope === 'app');
    return e(R.Fragment, null, e(SectionCard, { key: 'own', section, list: scoped(own), over, busy }), ...groups.map((g) => e(Group, { key: g.ref.id, section: g, scoped, over, busy })));
  }
  function Group({ section, scoped, over, busy }) {
    const list = useView({ ref: section.ref, relation: 'settings', depth: 'core' }, section.ref.id);
    return e(SectionCard, { section, list: scoped(list), over, busy, title: String(section.state?.title ?? '') });
  }

  return { ModSettings, Row };
}
