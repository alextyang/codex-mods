// The Mods list (docs/design/framework-ui.md F2, F4; design-spec §2.1): the page of the Mods group in the app's Settings. Your mods in sections, Updates, On, Issues and Off, then
// the Recommended mods not installed yet (F10), each added from its release and reviewed before it runs; each row
// opening its page, with its switch and a menu of what can be done to it, including moving it in your order; a search over them; Install mod…; and the Layouts section under the
// list. It reads and acts through the graph only (the framework scope's `invoke`), in the app's settings frame and cards, with the kit. Everything it uses arrives as arguments (the
// page bundle allows no import cycle with settings-pages.mjs). NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { createReport } from './reports.mjs';
import { readState } from './band.mjs';
import { useSwitchUndo } from './toasts.mjs';
import { modStateOf, modSectionOf, canReload, text } from './mods-text.mjs';

/** The sections, in their order. */
export const SECTIONS = Object.freeze([['updates', 'Updates'], ['on', 'On'], ['issues', 'Issues'], ['off', 'Off']]);
const TILE = { stopped: 'danger', missing: 'danger', incompatible: 'warning' };
const BADGES = { reloading: ['Reloading', 'neutral', true], stopped: ['Stopped', 'danger'], missing: ['Can’t be read', 'danger'], incompatible: ['Not loaded', 'warning'], consent: ['Waiting for you', 'info'] };

/** Does a mod match what is searched for: its name, author and description, without regard to case? */
export const matches = (s, name, query) => `${name} ${text(s.author)} ${text(s.description)}`.toLowerCase().includes(query.trim().toLowerCase());
/** Does it count as on: a stopped mod does, since it stopped running rather than being turned off; one that cannot load here does not. */
const countsOn = (s) => { const st = modStateOf(s); return st === 'stopped' || (s.status === 'enabled' && st !== 'incompatible'); };
/** The list's last line: how many mods, how many on, and safe mode. */
export const countLine = (states, safeMode) => `${states.length} mod${states.length === 1 ? '' : 's'} · ${states.filter(countsOn).length} on${safeMode ? ' · safe mode' : ''}`;

/**
 * @param {{ R: object, ctx: object, kit: object, common: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>,
 *   pickFile?: (o: { extensions?: string[], directory?: boolean }) => Promise<string | null>, navigate: (path: string) => void,
 *   frameworkRef: object, pathOf: (modId: string, tab?: string) => string, review?: (modId: string) => void, dialogs: { ModsDialog: Function }, LayoutsSection?: Function }} o
 *   `review`: open a mod's page with its consent's Dialog
 */
export function createModsOverview(o) {
  const { R, ctx, kit } = o;
  const e = R.createElement;
  const { ModsDialog } = o.dialogs;
  const Report = createReport(R, ctx);

  /**
   * Install mod (framework-ui.md F10; design-spec §4.1): from GitHub, the latest release's signed package of `owner/repository`; or from this computer, a `.codexmod` file, or a
   * folder in developer mode. Whatever it is, what it may do is reviewed before it runs.
   */
  function InstallDialog({ developerMode, onClose, installFrom, acting }) {
    const ex = o.exports() ?? {};
    const { SettingsCard: Card, SettingsRow: Row } = ex;
    const { button } = pageParts(R, ex);
    const [from, setFrom] = R.useState('github');
    const [repo, setRepo] = R.useState('');
    const busy = acting.busy('install') || acting.busy('github');
    const noPicker = typeof o.pickFile !== 'function';
    const go = async () => {
      if (!repo.trim()) return;
      const out = await acting.run('github', o.frameworkRef, 'installFromGitHub', [repo.trim()]);
      if (out.ok) onClose();
    };
    const said = acting.error(from === 'github' ? 'github' : 'install');   // what this tab's last try said
    const body = from === 'github' ? [
      e('input', { key: 'repo', className: 'cmk-input', style: { width: '100%' }, type: 'text', value: repo, placeholder: 'owner/repository', 'aria-label': 'GitHub repository', disabled: busy, 'aria-invalid': said ? 'true' : undefined,
        onChange: (ev) => setRepo(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault?.(); void go(); } } }),
      e('p', { key: 'how', className: 'text-secondary' }, busy ? 'Reading its latest release\u2026' : 'Its latest release\u2019s signed .codexmod package is installed.'),
    ] : [
      e(Card, { key: 'from' },
        e(Row, { key: 'file', label: 'A file', description: 'A signed .codexmod package.', control: button('Choose a file\u2026', () => installFrom(false), noPicker || busy) }),
        e(Row, { key: 'folder', label: 'A folder', description: developerMode ? 'A development package: loaded from its folder as it is, never updated automatically.' : 'Turn on Developer mode to load a mod from a folder.',
          control: button('Choose a folder\u2026', () => installFrom(true), noPicker || busy || !developerMode) })),
    ];
    return e(ModsDialog, { subject: o.frameworkRef, purpose: 'install', title: 'Install mod', onClose,
      footer: [button('Cancel', onClose), ...(from === 'github' ? [button(busy ? 'Checking\u2026' : 'Continue', go, busy || !repo.trim(), 'primary')] : [])] },
    e('p', { key: 'what' }, 'Mods run inside Codex with the permissions you give them. Install only mods you trust.'),
    e(kit.SegmentedControl, { key: 'from', options: [{ value: 'github', label: 'GitHub' }, { value: 'local', label: 'This computer' }], value: from, onChange: (v) => { setFrom(v); }, ariaLabel: 'Install from', disabled: busy }),
    ...body,
    said ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, said) : null);
  }

  function Overview() {
    const ex = o.exports() ?? {};
    const { SettingsPageFrame: Frame, SettingsSection: Section, SettingsCard: Card } = ex;
    const acting = useActing(R, o.invoke);
    const [dialog, setDialog] = R.useState(null);
    const [query, setQuery] = R.useState('');
    // F16: a switch turned says so here, with Undo (Settings has no toast viewport), refused while an operation on that mod runs (read when pressed)
    const undoer = useSwitchUndo(R, kit, { invoke: o.invoke, running: (x) => (readState(ctx, o.frameworkRef)?.ops ?? []).some((op) => op.state?.outcome === 'running' && op.links?.mod?.id === x) });
    const data = ctx.use(() => readState(ctx, o.frameworkRef));
    const { button, toggle } = pageParts(R, ex);
    const install = () => { acting.clear('install'); acting.clear('github'); setDialog({ kind: 'install' }); };
    const action = e(kit.Action, { label: 'Install mod…', glyph: 'plus', primary: true, onClick: install });
    if (!data) return e(Frame, { title: 'Mods', action });
    const { fw, ops } = data;
    const safeMode = fw.state?.safeMode === true;
    const mods = data.mods.map(({ ref, mod }) => ({ ref, s: mod && !mod.gone ? mod.state ?? {} : {}, settings: Boolean(mod?.links?.settings) }));
    const close = () => setDialog(null);
    const running = (id) => ops.some((x) => x.state?.outcome === 'running' && x.links?.mod?.id === id);

    // ---- the mods' order (CodexMods.setModOrder: every mod once, refused if they changed meanwhile): a mod moves past the next one in its section, whichever others are between them,
    // so a move always shows; the order decides between mods that run, and those share a section
    const sectionPeers = (m) => mods.filter((x) => modSectionOf(x.s) === modSectionOf(m.s));
    const peerBy = (m, by) => { const peers = sectionPeers(m); return peers[peers.indexOf(m) + by] ?? null; };
    const move = (m, by) => {
      const peer = peerBy(m, by);
      if (!peer) return null;
      const next = mods.filter((x) => x !== m);
      next.splice(next.indexOf(peer) + (by > 0 ? 1 : 0), 0, m);
      return acting.run('order', o.frameworkRef, 'setModOrder', [next.map((x) => x.ref)]);
    };

    // ---- what a row's Install or Update from a file does
    const updateFrom = async ({ ref, s }) => {
      const path = await o.pickFile?.(s.development ? { directory: true } : { extensions: ['codexmod'] });
      if (path) await acting.run(ref.id, ref, 'update', [path]);
    };
    const installFrom = async (directory) => {
      const path = await o.pickFile?.(directory ? { directory: true } : { extensions: ['codexmod'] });
      if (path) { const out = await acting.run('install', o.frameworkRef, 'install', [path]); if (out.ok) close(); }
    };
    const developerMode = fw.state?.developerMode === true;

    const rowOf = (m, i) => {
      const { ref, s } = m;
      const id = ref.id;
      const name = text(s.name) || id;
      const st = modStateOf(s);
      const busy = acting.busy(id) || running(id) || st === 'reloading';
      const open = () => o.navigate(o.pathOf(id));
      const badges = [BADGES[st], s.new ? ['New', 'info'] : null, s.development ? ['Local', 'neutral'] : null].filter(Boolean);
      const failed = acting.error(id) ?? (i === 0 ? acting.error('order') ?? acting.error('check') : null);
      const danger = Boolean(failed) || st === 'stopped' || st === 'missing';
      const sub = failed ?? (st === 'stopped' ? text(s.lastFault?.message) || text(s.quarantine?.reason) || 'Stopped' : st === 'missing' ? text(s.problem) : st === 'incompatible' ? text((s.reasons ?? [])[0]) : '');
      const sayable = sub || text(s.description);
      const controls = [
        // F10: an update from its GitHub release; one that asks more is reviewed on its page
        s.release && st === 'on' ? e(R.Fragment, { key: 'update' }, e(kit.Action, { label: 'Update', glyph: 'download', ariaLabel: `Update ${name}`, disabled: busy || s.release.verdict === 'blocked',
          onClick: () => acting.run(id, ref, 'applyUpdate') })) : null,
        s.consentRequest || s.status === 'pendingConsent' ? e(R.Fragment, { key: 'review' }, button('Review…', () => (o.review ? o.review(id) : open()), busy)) : null,
        // a stopped mod's switch stays on, and turning it off leaves it off
        ['enabled', 'disabled', 'quarantined'].includes(s.status)
          ? e(R.Fragment, { key: 'switch' }, toggle(s.status === 'disabled' ? `Turn on ${name}` : `Turn off ${name}`, s.status !== 'disabled' && st !== 'incompatible', async (on) => {
            const out = await acting.run(id, ref, on ? 'enable' : 'disable');
            if (out.ok) undoer.switched(ref, name, on);
          },
            busy || safeMode || st === 'incompatible' || (st === 'missing' && s.status === 'disabled'))) : null,
      ];
      const items = [
        ...(m.settings ? [{ label: 'Settings', icon: 'gear', onSelect: open }] : []),
        { label: 'Permissions', icon: 'shield-alert', onSelect: () => o.navigate(o.pathOf(id, 'permissions')) },
        { label: 'Activity', icon: 'clock', onSelect: () => o.navigate(o.pathOf(id, 'activity')) },
        { separator: true },
        { label: 'Reload', icon: 'refresh', disabled: busy || !canReload(s, safeMode), onSelect: () => acting.run(id, ref, 'reload') },
        { label: s.development ? 'Update from a folder…' : 'Update from a file…', icon: 'download', disabled: busy || typeof o.pickFile !== 'function' || Boolean(s.problem), onSelect: () => updateFrom(m) },
        { label: 'Check for updates', icon: 'download', disabled: acting.busy('check'), onSelect: () => acting.run('check', o.frameworkRef, 'checkForUpdates') },
        ...(mods.length > 1 ? [{ separator: true },
          { label: 'Move up', icon: 'arrow-up', disabled: acting.busy('order') || !peerBy(m, -1), onSelect: () => move(m, -1) },
          { label: 'Move down', icon: 'chevron-down', disabled: acting.busy('order') || !peerBy(m, 1), onSelect: () => move(m, 1) }] : []),
        { separator: true },
        { label: 'Uninstall…', danger: true, disabled: busy, onSelect: () => setDialog({ kind: 'uninstall', ref, name }) },
      ];
      return e('div', { key: id, className: 'cmk-row', role: 'listitem', 'data-codexmods-mod': id },
        e('button', { type: 'button', className: 'cmk-row-main', 'aria-label': `${name} settings`, onClick: open },
          e(kit.IconTile, { glyph: s.glyph, size: 'sm', ...(TILE[st] ? { tone: TILE[st] } : {}) }),
          e('span', { className: 'cmk-row-text' },
            e('span', { className: 'cmk-row-name', ...(st === 'on' ? { 'data-on': '' } : {}) }, e('span', { className: 'cmk-row-title' }, name),
              ...badges.map(([label, tone, spinning]) => e(kit.Badge, { key: label, label, tone, spinning }))),
            sayable ? e('span', { className: 'cmk-row-sub', ...(danger && sub ? { 'data-tone': 'danger' } : {}), title: sayable, ...(failed ? { role: 'alert' } : {}) }, sayable) : null)),
        e('span', { className: 'cmk-row-controls' }, ...controls, e(kit.MenuButton, { items, ariaLabel: `${name} actions` })),
        // reported as a SettingsRow of the page (E6.5): its subject links the page's, CodexMods, by `codexMods`
        e(Report, { type: 'SettingsRow', subject: ref, place: { in: 'SettingsPage', via: 'codexMods', slot: 'mods' } }));
    };

    // ---- the sections: each mod keeps its place in your order
    const shown = mods.map((m, i) => ({ m, i, name: text(m.s.name) || m.ref.id })).filter(({ m, name }) => matches(m.s, name, query));
    const sections = SECTIONS.map(([key, label]) => {
      const rows = shown.filter(({ m }) => modSectionOf(m.s) === key);
      if (!rows.length) return null;
      return e(Section, { key },
        e(Section.Header, { size: 'compact', spacing: 'compact', title: e('span', { className: 'cmk-head', ...(key === 'issues' ? { 'data-tone': 'danger' } : {}) }, label, e('span', { className: 'cmk-count' }, String(rows.length))) }),
        e(Section.Content, null, e('div', { role: 'list', 'aria-label': `${label} mods` }, e(Card, null, ...rows.map(({ m, i }) => rowOf(m, i))))));
    });
    // ---- F10: the mods the framework recommends that are not installed. Add installs one from its repository's latest release, by its id,
    // and opens its review: nothing runs before the user approves what it may do there.
    const installed = new Set(mods.map((m) => m.ref.id));
    const recommended = (fw.state?.recommended ?? []).filter((r) => !installed.has(r.id) && (!query.trim() || matches(r, r.name, query)));
    const add = async (r) => {
      const out = await acting.run(`add:${r.id}`, o.frameworkRef, 'installFromGitHub', [r.repo, r.id]);
      if (out.ok) { if (o.review) o.review(r.id); else o.navigate(o.pathOf(r.id)); }
    };
    const recommendedRow = (r) => {
      const failed = acting.error(`add:${r.id}`);
      const busy = acting.busy(`add:${r.id}`) || running(r.id);
      const sub = failed ?? r.description;
      return e('div', { key: r.id, className: 'cmk-row', role: 'listitem', 'data-codexmods-recommended': r.id },
        e('span', { className: 'cmk-row-main', style: { cursor: 'default' } },
          e(kit.IconTile, { glyph: r.glyph, size: 'sm' }),
          e('span', { className: 'cmk-row-text' },
            e('span', { className: 'cmk-row-name' }, e('span', { className: 'cmk-row-title' }, r.name)),
            e('span', { className: 'cmk-row-sub', title: sub, ...(failed ? { 'data-tone': 'danger', role: 'alert' } : {}) }, sub))),
        e('span', { className: 'cmk-row-controls' }, button(busy ? 'Adding…' : 'Add', () => add(r), busy, 'secondary', `Add ${r.name}`)));
    };
    const recommendedSection = recommended.length ? e(Section, { key: 'recommended' },
      e(Section.Header, { size: 'compact', spacing: 'compact', title: e('span', { className: 'cmk-head' }, 'Recommended', e('span', { className: 'cmk-count' }, String(recommended.length))),
        subtitle: mods.length ? undefined : 'Made by Codex Mods. Each one shows what it can do before it runs.' }),
      e(Section.Content, null, e('div', { role: 'list', 'aria-label': 'Recommended mods' }, e(Card, null, ...recommended.map(recommendedRow))))) : null;

    const list = !mods.length && recommendedSection ? null : !mods.length ? e(kit.EmptyState, { key: 'none', glyph: 'plugin', title: 'No mods installed', description: 'Mods add sidebar sections, status items and panes to Codex.', actions: [{ label: 'Install mod…', primary: true, onClick: install }] })
      : !shown.length ? e(kit.EmptyState, { key: 'none', glyph: 'search', title: `No mods match “${query}”`, description: 'Try another name or author.', actions: [{ label: 'Clear search', onClick: () => setQuery('') }] })
        : e(R.Fragment, { key: 'sections' }, ...sections);

    // ---- the Dialogs
    let dialogEl = null;
    if (dialog?.kind === 'uninstall') {
      dialogEl = e(o.common.UninstallDialog, { key: 'uninstall', modId: dialog.ref.id, modRef: dialog.ref, name: dialog.name, ops: ops.filter((x) => x.links?.mod?.id === dialog.ref.id), onClose: close });
    } else if (dialog?.kind === 'install') {
      dialogEl = e(InstallDialog, { key: 'install', developerMode, onClose: close, installFrom, acting });
    }

    return e(R.Fragment, null,
      e(Frame, { title: 'Mods', action },
        ...(safeMode ? [e(o.common.SafeBanner, { key: 'safe' })] : []),
        undoer.notice,
        e('div', { key: 'list', className: 'cmk-list' },
          e('div', { key: 'search', className: 'cmk-list-search' }, e(kit.SearchField, { value: query, onChange: setQuery, placeholder: 'Search mods', ariaLabel: 'Search mods', style: { width: 'calc(var(--spacing) * 64)', maxWidth: '100%' } })),
          list,
          mods.length ? e('div', { key: 'count', className: 'cmk-meta' }, countLine(mods.map((m) => m.s), safeMode)) : null,
          recommendedSection),
        ...(o.LayoutsSection ? [e(o.LayoutsSection, { key: 'layouts' })] : [])),
      dialogEl);
  }
  return { Overview };
}
