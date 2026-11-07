// A mod's page in the Mods group (docs/design/framework-ui.md F2, F4; design-spec §2.5): its title block with its switch and menu, one banner for what most needs you, and its tabs: its
// settings (E3), its own pages, what it may do (Permissions, with what it does without asking, its policies and what it gives the agent) and its Activity (faults, operations, rules
// that lost). About closes every tab: its details, its kept versions and data, Uninstall. Every action that cannot be undone asks first in a Dialog that says what it changes and what
// it keeps; consent names the request it showed, so a stale one is refused. It reads the graph and acts through it as the framework scope. NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { COMPAT, KIND, OUTCOME, RISK, RISK_ORDER, modStateOf, modWord, canReload, text, msOf, dayOf, sizeOf, opSays, placeSays } from './mods-text.mjs';
import { createReport } from './reports.mjs';
import { useSwitchUndo } from './toasts.mjs';
import { readState } from './band.mjs';
import { createModMedia } from './mod-media.mjs';
import { createActivityFeed } from './mod-activity-feed.mjs';

/** What an optional permission's decision says (framework-ui.md F8). */
export const DECISION = Object.freeze({ allow: 'Allow', ask: 'Ask every time', deny: 'Don\u2019t allow' });
/** What consent is, on every review: informed trust, not a sandbox (ARCHITECTURE §13). */
export const TRUST = 'A mod runs inside Codex with your authority. Approving it is trust in its publisher, not a sandbox: install only mods you trust.';

/** A mod's operations on its page: at most this many, the newest first. */
export const OPERATIONS = 10;
const MOD = 'codexmods.framework';
const modRef = (id) => ({ type: 'Mod', provider: MOD, id });
/** A mod's model use, as mod intelligence (the framework's internal mod, which provides it) keeps it. */
const modelUseRef = (id) => ({ type: 'ModelUse', provider: 'codexmods.intelligence', id });

/** An automatic action's name on the page: its id in words ("auto-continue" -> "Auto continue"). */
export const automaticTitle = (a) => { const t = String(a?.id ?? '').replace(/-/g, ' '); return t ? t[0].toUpperCase() + t.slice(1) : 'Action'; };
/** What an automatic action does and its bounds, in a line: the operation, which instances and arguments, and its rate. */
export function automaticBounds(a) {
  const short = (v) => { const j = JSON.stringify(v); return j.length > 120 ? `${j.slice(0, 117)}…` : j; };
  const parts = [String(a?.operation ?? '')];
  if (a?.where) parts.push(`only where ${short(a.where)}`);
  for (const [i, w] of Object.entries(a?.args ?? {})) parts.push(`argument ${Number(i) + 1} where ${short(w)}`);
  parts.push(`at most ${Number(a?.perHour) || 0} an hour`);
  return parts.filter(Boolean).join(', ');
}

/** What a policy does, in a line: refuses or asks before an operation, its reason or question, and when (who, which hours). */
export function policySays(spec) {
  const then = spec?.then ?? {};
  if (spec?.on?.request) {
    // a request policy: what it answers, before you are asked
    const a = then.answer ?? {};
    const does = a.approve ? `approves it ${a.approve === 'thread' ? 'for the chat' : 'once'}` : a.deny !== undefined ? `denies it${typeof a.deny === 'string' && a.deny ? `: “${a.deny}”` : ''}` : 'answers it';
    return `Answers ${spec.on.request} before you are asked: ${does}${spec.automatic ? ` (its automatic action “${spec.automatic}”)` : ''}`;
  }
  const on = spec?.on ? `${spec.on.type}.${spec.on.operation}` : 'an operation';
  const what = then.refuse ? `Refuses ${on}: “${then.refuse}”` : then.ask ? `Asks you before ${on}: “${then.ask.title}”` : `Applies to ${on}`;
  const who = spec?.origin && spec.origin !== 'any' ? ({ user: 'your own actions', mod: 'mods\' calls', agent: 'the agent\'s' })[spec.origin] : '';
  const when = Array.isArray(spec?.schedule?.between) ? `between ${spec.schedule.between[0]} and ${spec.schedule.between[1]}${Array.isArray(spec.schedule.days) ? ` on ${spec.schedule.days.join(', ')}` : ''}` : '';
  return [what, [who && `only ${who}`, when].filter(Boolean).join(', ')].filter(Boolean).join('; ');
}

/** The permissions a consent request names, with their words and risk from the mod's own list, the highest risk first. */
export function requestPermissions(request, permissions) {
  const known = new Map((permissions ?? []).map((p) => [p.id, p]));
  const added = new Set(request?.addedPermissions ?? []);
  const out = (request?.permissions ?? []).map((id) => {
    const p = known.get(id);
    // A permission the mod's list does not describe is shown as high risk: unknown is not low.
    return { id, text: text(p?.text) || id, risk: RISK_ORDER.includes(p?.risk) ? p.risk : 'high', added: added.has(id) };
  });
  return out.sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk));
}

/**
 * @param {{ R: object, ctx: object, kit: object, common: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>,
 *   pickFile?: (o: { extensions?: string[], directory?: boolean }) => Promise<string | null>, navigate: (path: string) => void,
 *   frameworkRef: object, overviewPath: string, pathOf: (modId: string, tab?: string) => string, rows?: { ModSettings: Function } | null, dialogs: { ModsDialog: Function },
 *   subscribe?: (query: object, fn: Function) => { dispose(): void }, takeReview?: (modId: string) => boolean, ownTabs?: (modId: string) => { id: string, title: string }[], renderOwn?: (modId: string, pageId: string) => unknown,
 *   ownPathOf?: (modId: string, pageId: string) => string, showDetail?: (ref: object) => void,
 *   onModFault?: (modId: string, error: unknown) => void, lostRulesOf?: (modId: string) => { rule: string, kind: string, what: string, to: string }[] }} o
 *   `lostRulesOf`: its rules that lost to another mod's in this window (E6.5b); `showDetail`: an instance's DetailView (S11)
 *   `takeReview`: whether the page was opened to review what waits (the list's Review…): its consent's Dialog opens at once
 *   `ownTabs`: its own pages in the Mods group, each a tab; `renderOwn`: such a page's body, in its rule's boundary
 */
export function createModPage(o) {
  const { R, ctx, kit } = o;
  const e = R.createElement;
  const { ModsDialog } = o.dialogs;
  const Report = createReport(R, ctx);
  const { ModMedia } = createModMedia({ R, kit, invoke: o.invoke });
  const { ActivityFeed, lastFaultRows } = createActivityFeed({ R, kit, exports: o.exports, invoke: o.invoke, subscribe: o.subscribe });
  let tabChosen = null;   // { mod, top }: the mod whose tab was just chosen, and how far its page was scrolled
  /** What scrolls this node: the nearest ancestor that does. */
  const scrollerOf = (node) => { for (let n = node?.closest?.('[role="tablist"]')?.parentElement; n; n = n.parentElement) if (/auto|scroll/.test(globalThis.getComputedStyle?.(n)?.overflowY ?? '')) return n; return null; };

  /** The back button in the frame's top bar, which is a drag region. */
  const backTo = (navigate) => e('button', { type: 'button', className: 'cmk-more no-drag', style: { WebkitAppRegion: 'no-drag' }, onClick: navigate }, e(kit.Glyph, { name: 'back' }), 'Mods');

  /** A mod no longer installed: removed in another window, or a path it never had. */
  function NotInstalled() {
    const ex = o.exports() ?? {};
    return e(ex.SettingsPageFrame, { title: 'Mods', backSlot: backTo(() => o.navigate(o.overviewPath)) },
      e(kit.EmptyState, { glyph: 'plugin', title: 'This mod isn’t installed', description: 'It may have been removed in another window.', actions: [{ label: 'All mods', onClick: () => o.navigate(o.overviewPath) }] }));
  }

  function ModPage({ modId, tab }) {
    const ex = o.exports() ?? {};
    const { SettingsPageFrame: Frame, SettingsSection: Section, SettingsCard: Card, SettingsRow: Row } = ex;
    const acting = useActing(R, o.invoke);
    // F16: a switch turned says so here, with Undo (Settings has no toast viewport), refused while an operation on it runs (read when pressed)
    const undoer = useSwitchUndo(R, kit, { invoke: o.invoke, running: (id) => (readState(ctx, o.frameworkRef)?.ops ?? []).some((x) => x.state?.outcome === 'running' && x.links?.mod?.id === id) });
    const [dialog, setDialog] = R.useState(() => (o.takeReview?.(modId) ? { kind: 'consent', request: null } : null));
    const data = ctx.use(() => {
      const mod = ctx.subject(modRef(modId));
      const fw = ctx.subject(o.frameworkRef);
      const ops = (fw && !fw.gone ? fw.links?.operations ?? [] : []).map((r) => ctx.subject(r)).filter((x) => x && !x.gone && x.links?.mod?.id === modId);
      const lost = typeof o.lostRulesOf === 'function' ? o.lostRulesOf(modId) : [];
      const nameOfMod = (id) => text(ctx.subject(modRef(id))?.state?.name) || id;
      const features = (mod && !mod.gone ? mod.links?.features ?? [] : []).map((r) => ({ ref: r, f: ctx.subject(r) }));
      // GOAL.md goal 16: its model use, as mod intelligence (the framework's internal mod) keeps it
      const use = mod?.state?.intelligence ? ctx.subject(modelUseRef(modId)) : null;
      return { use, mod: mod && !mod.gone ? mod : null, safeMode: fw?.state?.safeMode === true, developer: fw?.state?.developerMode === true, ops, lost: lost.map((x) => ({ ...x, toName: nameOfMod(x.to) })), features, own: o.ownTabs?.(modId) ?? [] };
    });
    const s = data.mod?.state ?? {};
    const live = s.consentRequest ?? null;
    // Opening its page is what ends `new` (F5); a mod that turns new while it is open, as its consent is answered, stays so until then.
    // opened: no longer new, and a stop it had is looked at (F15: the band leaves it out then)
    R.useEffect(() => { if (s.new || (s.quarantine && s.stopSeen === false)) o.invoke(modRef(modId), 'markSeen', []); }, [modId, s.quarantine?.at]);
    // A tab is a route, which the app's layout draws afresh: the keyboard's place and the scroll go with the tab chosen.
    R.useEffect(() => {
      if (tabChosen?.mod !== modId) return;
      const { top } = tabChosen;
      tabChosen = null;
      const selected = globalThis.document?.querySelector?.('[data-codexmods-framework] [role="tab"][aria-selected="true"]');
      selected?.focus?.({ preventScroll: true });
      const scroller = scrollerOf(selected);
      if (scroller) scroller.scrollTop = top;
    }, [tab]);
    // The consent Dialog shows the request it opened with; one opened before the request was read takes the first one shown.
    R.useEffect(() => { if (dialog?.kind === 'consent' && !dialog.request && live) setDialog({ kind: 'consent', request: live }); }, [dialog, live]);
    const { value, button, toggle, lines, section } = pageParts(R, ex);
    if (!data.mod) return e(NotInstalled);
    const ref = modRef(modId);
    const name = text(s.name) || modId;
    const st = modStateOf(s);
    const running = data.ops.some((x) => x.state?.outcome === 'running');
    const working = running || ['state', 'consent', 'update', 'rollback', 'reattach', 'remove', 'overrides'].some((k) => acting.busy(k));
    const close = () => setDialog(null);
    /** Runs an operation from a Dialog: it closes when the operation happened, and says why under its text when it did not. */
    const confirm = async (key, op, args, after) => { const out = await acting.run(key, ref, op, args); if (out.ok) { close(); after?.(); } return out; };
    const review = () => setDialog({ kind: 'consent', request: live });
    const toOverview = () => o.navigate(o.overviewPath);

    // ---- the tabs: Settings while it declares any or something is stored for it (F4), its own pages, Permissions, Activity
    const overrides = s.storedOverrides ?? [];
    const hasSettings = Boolean(o.rows && data.mod.links?.settings) || overrides.length > 0;
    const allPerms = s.permissions ?? [];
    const attention = data.ops.some((x) => x.state?.outcome === 'needsAttention' && !x.state?.acknowledgedAt);
    const tabs = [
      ...(hasSettings ? [{ value: 'settings', label: 'Settings', icon: 'gear' }] : []),
      ...data.own.map((p) => ({ value: `~${p.id}`, label: p.title, icon: 'plugin' })),
      { value: 'permissions', label: 'Permissions', icon: 'shield-alert', ...(allPerms.length ? { count: allPerms.length } : {}) },
      { value: 'activity', label: 'Activity', icon: 'clock', ...(st === 'stopped' || attention ? { dot: true } : {}) },
    ];
    // An unknown tab (a page of its that is gone) is the first one, which has no suffix of its own.
    const current = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;
    const pathOfTab = (value) => (value === tabs[0].value ? o.pathOf(modId) : value[0] === '~' ? o.ownPathOf(modId, value.slice(1)) : o.pathOf(modId, value));
    const chooseTab = (value) => {
      tabChosen = { mod: modId, top: scrollerOf(globalThis.document?.querySelector?.('[data-codexmods-framework] [role="tab"][aria-selected="true"]'))?.scrollTop ?? 0 };
      o.navigate(pathOfTab(value));
    };

    // ---- the title block
    const reloading = st === 'reloading';
    // a stopped mod's switch stays on, and turning it off leaves it off
    const stateControl = ['enabled', 'disabled', 'quarantined'].includes(s.status)
      ? toggle(s.status === 'disabled' ? `Turn ${name} on` : `Turn ${name} off`, s.status !== 'disabled' && st !== 'incompatible', async (on) => {
        const out = await acting.run('state', ref, on ? 'enable' : 'disable');
        if (out.ok) undoer.switched(ref, name, on);
      },
        working || reloading || data.safeMode || st === 'incompatible' || (st === 'missing' && s.status === 'disabled')) : null;
    const reload = () => acting.run('state', ref, 'reload');
    const updateFrom = async () => {
      const path = await o.pickFile?.(s.development ? { directory: true } : { extensions: ['codexmod'] });
      if (path) await acting.run('update', ref, 'update', [path]);
    };
    const menu = [
      { label: 'Reload', icon: 'refresh', disabled: working || reloading || !canReload(s, data.safeMode), onSelect: reload },
      { label: s.development ? 'Update from a folder…' : 'Update from a file…', icon: 'download', disabled: working || typeof o.pickFile !== 'function' || Boolean(s.problem), onSelect: updateFrom },
      { label: 'Check for updates', icon: 'download', disabled: acting.busy('check'), onSelect: () => acting.run('check', o.frameworkRef, 'checkForUpdates') },
      { separator: true },
      { label: 'Uninstall…', danger: true, disabled: working, onSelect: () => setDialog({ kind: 'uninstall' }) },
    ];
    const word = modWord(s, data.safeMode);
    const title = e('div', { key: 'title', className: 'cmk-title' },
      e('div', { className: 'cmk-title-text' },
        e('h1', { className: 'heading-xl' }, name),
        text(s.description) ? e('p', { className: 'cmk-title-description' }, text(s.description)) : null,
        e('div', { className: 'cmk-status', 'data-tone': word.tone },
          e('span', { className: 'cmk-status-dot', 'aria-hidden': true }), e('span', { className: 'cmk-status-word' }, word.word),
          e('span', null, `· v${text(s.version)}${s.development ? ' · Local' : ''}`))),
      e('div', { className: 'cmk-title-actions' }, stateControl, e(kit.MenuButton, { items: menu, ariaLabel: `${name} actions` })));
    const said = ['state', 'update', 'check', 'consent'].map((k) => (dialog ? null : acting.error(k))).find(Boolean);

    // ---- the one banner: what most needs you, first
    let banner = null;
    const activity = { label: 'View activity', onClick: () => o.navigate(pathOfTab('activity')) };
    if (reloading) banner = null;
    else if (st === 'missing') banner = { tone: 'danger', title: 'Its package can’t be read', message: text(s.problem) };
    else if (st === 'stopped') {
      banner = { tone: 'danger', title: 'Stopped after an error', message: s.lastFault ? `${text(s.lastFault.message)} (${text(s.lastFault.where)})` : text(s.quarantine?.reason), actions: [{ label: 'Reload', onClick: reload, disabled: working || data.safeMode }, ...(current === 'activity' ? [] : [activity])] };
    } else if (st === 'incompatible' && !live) banner = { tone: 'warning', title: 'Doesn’t support this version of Codex', message: (s.reasons ?? []).map(text).join(' '), actions: [{ label: 'Check for updates', onClick: () => acting.run('check', o.frameworkRef, 'checkForUpdates'), disabled: acting.busy('check') }] };
    else if (live) {
      banner = { tone: live.publisherChange ? 'warning' : 'info', glyph: 'shield-alert', title: live.kind === 'update' ? `Update to ${text(live.version)}` : `Install ${text(live.version)}`,
        message: [consentSummary(live, live.kind === 'install' ? (s.permissions ?? []).filter((x) => x.optional).length : 0), live.publisherChange ? 'It is signed by a different publisher.' : ''].filter(Boolean).join(' '), actions: [{ label: 'Review…', onClick: review, disabled: working }] };
    }

    // F10: an update a check found for it, from its GitHub release; one that asks more, or comes from another publisher or repository, goes through its review
    if (!banner && !reloading && s.release) {
      const u = s.release;
      const asks = (u.addedPermissions ?? []).length;
      const review = asks > 0 || u.publisherChange || u.repoChange;
      banner = { tone: 'info', glyph: 'download', title: `Version ${text(u.version)} is available`,
        message: [text(u.notes).split('\n')[0], asks ? (asks === 1 ? 'It asks for a new permission.' : `It asks for ${asks} new permissions.`) : '', u.repoChange ? `It now comes from ${text(u.repoChange.to)}.` : '',
          u.verdict === 'blocked' ? 'It doesn\u2019t run on this version of Codex.' : ''].filter(Boolean).join(' '),
        actions: [{ label: review ? 'Review update' : 'Update', onClick: () => acting.run('update', ref, 'applyUpdate'), disabled: working || u.verdict === 'blocked' }] };
    }

    // ---- what is stored for projects and chats (as stored: one whose key or scope no longer holds is still shown; cleared only by you)
    const scopeName = (x) => { const sub = x.seen ? ctx.subject(x.scope) : null; const t = text(sub?.state?.title) || text(sub?.state?.name);
      return `${x.kind === 'project' ? 'Project' : 'Chat'} ${t ? `“${t}”` : text(x.scope?.id)}`; };
    const overrideRows = overrides.map((x, i) => e(Row, { key: `ov:${i}`, label: text(x.key),
      description: lines([`${scopeName(x)}: ${JSON.stringify(x.value)}`, x.valid ? '' : 'Not used: it is not declared for that scope any more, or no longer valid',
        x.seen ? '' : 'That project or chat is not loaded now'], i === 0 ? acting.error('overrides') : null),
      control: button('Clear', () => acting.run('overrides', ref, 'clearOverrides', [[{ key: x.key, scope: x.scope }]]), working) }));
    if (overrideRows.length > 1) overrideRows.push(e(Row, { key: 'ov:all', label: 'All of them', control: button('Clear all…', () => setDialog({ kind: 'overrides' }), working, 'danger') }));
    const settingsTab = () => [
      ...(o.rows && data.mod.links?.settings ? [e(o.rows.ModSettings, { key: 'settings', sectionRef: data.mod.links.settings, busy: running })] : []),
      ...(overrideRows.length ? [section('overrides', 'Stored for projects and chats', overrideRows)] : []),
    ];

    // ---- Permissions: what it may do, what it may do without asking (public-hooks.md §3.9), its policies (§3.7), what it gives the agent (§3.16)
    const permissionsTab = () => {
      // F8: a required one reads Required (its switch is the way to stop it); what nothing enforces says so; an optional one is the user's to decide, by what can be enforced
      const permissions = allPerms.filter((p) => p.id !== 'intelligence').sort((a, b) => Number(Boolean(a.optional)) - Number(Boolean(b.optional)) || RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk)).map((p) => {
        const key = `perm:${p.id}`;
        const control = p.enforced === false ? value('Declared, not enforced')
          : p.optional ? e(kit.Select, { ariaLabel: text(p.label) || text(p.text) || p.id, value: p.decision, disabled: working || acting.busy(key),
            options: (p.choices ?? []).map((d) => ({ value: d, label: DECISION[d] ?? d })), onChange: (d) => acting.run(key, ref, 'setPermission', [p.id, d]) })
            : value(p.granted ? 'Required' : 'Waiting for your consent');
        return e(Row, { key: p.id, label: text(p.label) || text(p.text) || p.id,
          description: lines([text(p.detail), p.label ? text(p.text) : '', [p.risk === 'high' ? RISK.high : '', p.optional ? 'Optional' : ''].filter(Boolean).join(' · ')], acting.error(key)), control });
      });
      const optionalNote = allPerms.some((p) => p.optional && p.id !== 'intelligence') ? [e(Row, { key: 'optional', label: `Optional access isn\u2019t needed for ${name} to work.` })] : [];
      const automaticRows = (s.automatic ?? []).map((a) => e(Row, {
        key: `auto:${a.id}`, label: automaticTitle(a),
        description: lines([text(a.why), automaticBounds(a), s.status === 'enabled' ? '' : 'It can be turned on while the mod is on'], acting.error(`auto:${a.id}`)),
        control: toggle(automaticTitle(a), a.on === true, (on) => acting.run(`auto:${a.id}`, ref, 'setAutomatic', [a.id, on]),
          working || acting.busy(`auto:${a.id}`) || (s.status !== 'enabled' && a.on !== true)),
      }));
      const policyRows = (s.policies ?? []).map((p) => e(Row, {
        key: `policy:${p.id}`, label: text(p.title) || p.id,
        description: lines([policySays(p.spec)], acting.error(`policy:${p.id}`)),
        control: toggle(text(p.title) || p.id, p.on === true, (on) => acting.run(`policy:${p.id}`, ref, 'setPolicy', [p.id, on]), working || acting.busy(`policy:${p.id}`)),
      }));
      const ag = s.agent ?? {};
      const told = [...new Set(ag.instructions ?? [])].map((k) => (k === 'perTurn' ? 'Adds context to each message you send' : 'Adds its instructions to every chat'));
      // each place once, as said (two slots of one place read the same)
      const said = [...new Map((s.places ?? []).map(placeSays).map((w) => [`${w.where}|${w.what}`, w])).values()];
      const placeRows = said.map((w, i) => e(Row, { key: `place:${w.where}|${w.what}`, label: w.where, description: i === 0 ? 'As its rules declare it, while it runs; what shows depends on what is open' : undefined, control: value(w.what) }));
      const agentRows = [
        ...(ag.tools ?? []).map((t) => e(Row, { key: `tool:${t.name}`, label: text(t.name), description: lines(['A tool the agent can call in new chats', text(t.description)]) })),
        ...((ag.skills ?? []).length ? [e(Row, { key: 'skills', label: 'Skills', description: ag.skills.map(text).join(', ') })] : []),
        ...(told.length ? [e(Row, { key: 'instructions', label: 'Instructions', description: lines(told) })] : []),
      ];
      const modelRows = s.intelligence ? modelUseRows(data.use, s.intelligence) : [];
      return [
        section('access', 'Access', permissions.length ? [...optionalNote, ...permissions] : [e(Row, { key: 'none', label: 'No access to files, chats, commands or the network.' })]),
        ...(modelRows.length ? [section('model', 'Model use', modelRows)] : []),
        ...(automaticRows.length ? [section('automatic', 'What it may do without asking', automaticRows)] : []),
        ...(policyRows.length ? [section('policies', 'Its policies', policyRows)] : []),
        ...(agentRows.length ? [section('agent', 'What it gives the agent', agentRows)] : []),
        // F13: where its rules say it presents, while it runs: declared, not seen drawn (what shows depends on what is open)
        ...(placeRows.length ? [section('places', 'Where it appears', placeRows)] : []),
      ];
    };

    // ---- Model use (GOAL.md goal 16): the switch, the model, the allowances, the other tools it asks for, what it used; Stop while it runs.
    // Mod intelligence keeps them (its ModelUse); acting as the user here changes them, which a mod never can.
    function modelUseRows(use, decl) {
      const u = use && !use.gone ? use.state ?? {} : null;
      if (!u) return [e(Row, { key: 'model-off', label: 'Model use isn\u2019t available now', description: lines([text(decl.why), 'Mod intelligence is not running']) })];
      const uref = use.ref;
      const busy = (k) => working || acting.busy(k);
      const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));
      const choices = (list, current) => [...new Set([...list, current])].sort((a, b) => a - b).map((n) => ({ value: n, label: `${fmt(n)} tokens` }));
      const TOOLS = { web: 'Search the web', network: 'Use the network', files: 'Read and write your files', toolServers: 'Use tool servers', plugins: 'Use plugins', computerUse: 'Use your computer' };
      return [
        e(Row, { key: 'model-on', label: `Let ${name} use models`, description: lines([text(decl.why), 'Through your Codex account, in chats you never see, within the allowance below', u.lastError ? `Last call: ${u.lastError}` : ''], acting.error('model-on')),
          control: toggle(`Let ${name} use models`, u.enabled === true, (on) => acting.run('model-on', uref, 'setEnabled', [on]), busy('model-on')) }),
        e(Row, { key: 'model', label: 'Model', description: lines(['Luna unless you choose another'], acting.error('model')),
          control: e(kit.Select, { ariaLabel: 'Model', value: u.model, disabled: busy('model'),
            options: [...(u.available ?? []).map((m) => ({ value: m.id, label: text(m.name) || m.id })), ...((u.available ?? []).some((m) => m.id === u.model) ? [] : [{ value: u.model, label: u.model }])],
            onChange: (m) => acting.run('model', uref, 'setModel', [m]) }) }),
        e(Row, { key: 'per-hour', label: 'Tokens an hour', description: lines([`${fmt(u.usedHour)} used this hour`], acting.error('allowance')),
          control: e(kit.Select, { ariaLabel: 'Tokens an hour', value: u.perHour, disabled: busy('allowance'), options: choices([50_000, 200_000, 1_000_000], u.perHour),
            onChange: (n) => acting.run('allowance', uref, 'setAllowance', [{ perHour: Number(n), perDay: u.perDay }]) }) }),
        e(Row, { key: 'per-day', label: 'Tokens a day', description: lines([`${fmt(u.usedDay)} used today · ${fmt(u.usedTotal)} in all`]),
          control: e(kit.Select, { ariaLabel: 'Tokens a day', value: u.perDay, disabled: busy('allowance'), options: choices([200_000, 1_000_000, 5_000_000], u.perDay),
            onChange: (n) => acting.run('allowance', uref, 'setAllowance', [{ perHour: u.perHour, perDay: Number(n) }]) }) }),
        ...(u.wants ?? []).map((t) => e(Row, { key: `model-tool:${t}`, label: TOOLS[t] ?? t, description: lines(['It asks for this; off until you allow it'], acting.error(`model-tool:${t}`)),
          control: toggle(TOOLS[t] ?? t, (u.tools ?? []).includes(t), (on) => acting.run(`model-tool:${t}`, uref, 'setTools', [on ? [...new Set([...(u.tools ?? []), t])] : (u.tools ?? []).filter((x) => x !== t)]), busy(`model-tool:${t}`)) })),
        ...(u.running > 0 ? [e(Row, { key: 'model-stop', label: `${name} is using a model now`, control: button('Stop', () => acting.run('model-stop', uref, 'stop', []), busy('model-stop'), 'danger') })] : []),
      ];
    }

    // ---- Activity: its faults, its operations, and its rules that lost to another mod's (one holds a presentation or a variable at a time: the first in your order)
    const activityTab = () => {
      const faultRows = s.lastFault ? lastFaultRows({ fault: s.lastFault, faults: s.faults, developer: data.developer, Row })
        : s.quarantine ? [e(Row, { key: 'stopped', label: 'Stopped', description: text(s.quarantine.reason), control: e('span', { className: 'cmk-meta' }, dayOf(s.quarantine.at)) })] : [];
      const opRows = [...data.ops].sort((a, b) => msOf(b.state?.startedAt) - msOf(a.state?.startedAt)).slice(0, OPERATIONS).map((x) => {
        const op = x.state ?? {};
        const key = `op:${x.ref.id}`;
        const pending = op.outcome === 'needsAttention' && !op.acknowledgedAt;
        // reported as a SettingsRow of this page (E6.5): an Operation links its Mod by `mod`
        return e(R.Fragment, { key: x.ref.id }, e(Row, { label: `${KIND[op.kind] ?? text(op.kind)}${dayOf(op.startedAt) ? ` · ${dayOf(op.startedAt)}` : ''}`, description: lines([opSays(op)], acting.error(key)),
          control: pending ? button('Acknowledge', () => acting.run(key, x.ref, 'acknowledge'), acting.busy(key)) : value(OUTCOME[op.outcome] ?? text(op.outcome)) }),
        e(Report, { type: 'SettingsRow', subject: x.ref, place: { in: 'SettingsPage', via: 'mod', slot: 'operations' } }));
      });
      const lostRows = data.lost.map((x, i) => e(Row, { key: `lost:${i}`, label: x.kind === 'style' ? `Its style of ${x.what}` : `Its ${x.kind} of a ${x.what}`,
        description: `${x.toName}'s rule holds it: it comes first in your order.`, control: value(text(x.rule)) }));
      return [
        e(ActivityFeed, { key: 'feed', mod: ref, name }),
        ...(faultRows.length ? [section('faults', 'What stopped it', faultRows)] : []),
        ...(opRows.length ? [section('operations', 'Operations', opRows)] : []),
        ...(lostRows.length ? [section('lost', 'Rules that lost', lostRows)] : []),
      ];
    };

    // ---- About, closing every tab: what it says of itself, its details, its kept versions and data, Uninstall
    const FEATURE = { present: 'Present', changed: 'Changed in this build', missing: 'Missing in this build', unknown: 'Could not be checked' };
    const features = data.features.map(({ ref: fr, f }) => ({ ref: fr, title: text(f?.state?.title) || fr.id, status: f?.state?.status }));
    const differing = features.filter((f) => f.status && f.status !== 'present').length;
    const installed = dayOf(s.installedAt);
    const detailRows = [
      ...(text(s.author) ? [e(Row, { key: 'author', label: 'Author', description: 'What the mod says of itself', control: value(text(s.author)) })] : []),
      e(Row, { key: 'version', label: 'Version', description: s.availableVersion ? `${text(s.availableVersion)} is waiting for your consent` : undefined, control: value(text(s.version)) }),
      ...(s.source ? [e(Row, { key: 'source', label: 'Source', description: s.source.kind === 'github' ? [`Release ${text(s.source.tag)}`, text(s.source.digest).replace(/^sha256:(.{12}).*/, 'sha256 $1…')].filter(Boolean).join(' · ') : s.source.kind === 'folder' ? text(s.source.path) : 'Installed from a .codexmod file: a newer file updates it',
        control: value(s.source.kind === 'github' ? `GitHub · ${text(s.source.repo)}` : s.source.kind === 'folder' ? 'Local folder' : 'A file') })] : []),
      ...(s.checkProblem ? [e(Row, { key: 'check-problem', label: 'Its last update check', description: text(s.checkProblem) })] : []),
      e(Row, { key: 'publisher', label: 'Publisher', description: s.development ? 'A development package: unsigned, loaded from its folder as it is, never updated automatically'
        : s.publisher ? 'Its signing key\'s fingerprint' : 'Unsigned', control: s.publisher ? value(s.publisher) : null }),
      ...(installed ? [e(Row, { key: 'installed', label: 'Installed', control: value(installed) })] : []),
      e(Row, { key: 'compat', label: 'Compatibility', description: lines((s.reasons ?? []).map(text)), control: value(COMPAT[s.compatibility] ?? text(s.compatibility)) }),
      ...(features.length ? [e(Row, { key: 'needs', label: 'Needs', description: `${features.length} part${features.length === 1 ? '' : 's'} of Codex${differing ? `, ${differing} not as it expects` : ''}`,
        control: typeof o.showDetail === 'function' ? e(kit.MenuButton, { label: 'Details', icon: 'chevron-down', ariaLabel: `What ${name} needs`,
          items: features.map((f) => ({ key: f.ref.id, label: FEATURE[f.status] ? `${f.title}: ${FEATURE[f.status]}` : f.title, onSelect: () => o.showDetail(f.ref) })) }) : null })] : []),
    ];
    const versionRows = (s.versions ?? []).map((v) => e(Row, {
      key: `v:${v.version}`, label: `Version ${text(v.version)}`,
      description: v.codeOnly && v.withData ? 'Kept: it can come back with the data as it is now, or with its own data' : v.withData ? 'Kept: it can come back with its own data' : 'Kept: it can come back with the data as it is now',
      control: button('Roll back…', () => setDialog({ kind: 'rollback', version: v }), working),
    }));
    const dataRows = [
      e(Row, { key: 'size', label: 'Its data', control: value(sizeOf(s.dataBytes)) }),
      ...(s.keptData ?? []).map((g) => e(Row, {
        key: `g:${g.generation}`, label: `Kept on ${dayOf(g.at) || text(g.generation)}`,
        description: [g.version ? `From version ${text(g.version)}` : '', sizeOf(g.bytes)].filter(Boolean).join(' · '),
        control: button('Reattach…', () => setDialog({ kind: 'reattach', kept: g }), working),
      })),
    ];
    const about = e(Section, { key: 'about' }, e(Section.Header, { title: 'About' }), e(Section.Content, null, e('div', { className: 'cmk-tight' },
      ...(s.about?.length ? s.about.map((t, i) => e('p', { key: `p${i}`, className: 'cmk-paragraph' }, text(t))) : text(s.description) ? [e('p', { key: 'says', className: 'cmk-paragraph' }, text(s.description))] : []),
      ...(s.media?.length ? [e('div', { key: 'media', className: 'cmk-media-grid' }, ...s.media.map((item) => e(ModMedia, { key: item.id, mod: modRef(modId), item })))] : []),
      e(Card, { key: 'details' }, ...detailRows),
      ...(versionRows.length ? [e(Card, { key: 'versions' }, ...versionRows)] : []),
      e(Card, { key: 'data' }, ...dataRows),
      e(Card, { key: 'uninstall' }, e(Row, { key: 'uninstall', label: `Uninstall ${name}`, description: 'Removes it, and its settings and data unless you keep them.', control: button('Uninstall…', () => setDialog({ kind: 'uninstall' }), working) })))));

    const body = current === 'settings' ? settingsTab() : current === 'permissions' ? permissionsTab() : current === 'activity' ? activityTab() : [e(R.Fragment, { key: 'own' }, o.renderOwn?.(modId, current.slice(1)) ?? null)];

    return e(R.Fragment, null,
      e(Frame, { backSlot: backTo(toOverview), scrollResetKey: modId },
        ...(data.safeMode ? [e(o.common.SafeBanner, { key: 'safe' })] : []),
        e('div', { key: 'page', className: 'cmk-page' },
          title,
          undoer.notice,
          said ? e('p', { key: 'said', className: 'cmk-error', role: 'alert' }, said) : null,
          banner ? e(kit.Banner, { key: 'banner', ...banner }) : null,
          e('div', { key: 'tabs', className: 'cmk-page-body' },
            e(kit.Tabs, { items: tabs, value: current, onChange: chooseTab, ariaLabel: `${name} sections` }),
            e('div', { className: 'cmk-stack' }, ...body, about)))),
      dialog ? dialogOf(dialog, { s, name, live, working, acting, confirm, close, data, modId, toOverview, setDialog }) : null);
  }

  /** What a consent request asks, in one line; `optional`: how many of its permissions an install leaves to you. */
  function consentSummary(req, optional = 0) {
    const n = req.permissions?.length ?? 0, added = req.addedPermissions?.length ?? 0;
    const plural = (k) => (k === 1 ? '' : 's');
    if (req.kind === 'update') return added ? `It asks for ${added} more permission${plural(added)}.` : 'It asks for no more permissions.';
    if (!n) return optional ? `It asks only for ${optional} optional permission${plural(optional)}.` : 'It asks for no permissions.';
    return `It asks for ${n} permission${plural(n)}${optional ? ` and ${optional} optional` : ''}.`;
  }

  function dialogOf(d, c) {
    const { s, name, working, acting, confirm, close } = c;
    const p = (key, t, className) => e('p', { key, className }, t);
    const said = (key) => (acting.error(key) ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error(key)) : null);
    const { button } = pageParts(R, o.exports() ?? {});
    if (d.kind === 'consent') {
      const req = d.request ?? c.live;
      if (!req) return null;
      const update = req.kind === 'update';
      const changed = !c.live || c.live.id !== req.id;   // answered elsewhere, or another request waits now
      const perms = requestPermissions(req, s.permissions);
      const optional = req.kind === 'install' ? (s.permissions ?? []).filter((x) => x.optional) : [];
      const allowNow = d.allow ?? new Set();
      const toggleNow = (id, on) => { const next = new Set(allowNow); if (on) next.add(id); else next.delete(id); c.setDialog({ ...d, allow: next }); };
      const body = [
        ...(req.publisherChange ? [e('div', { key: 'pub', role: 'alert', className: 'flex flex-col gap-1' },
          e('span', { className: 'text-danger font-semibold' }, 'It is signed by a different publisher'),
          e('span', null, `You trusted the key ${text(req.publisherChange.from)} when you installed it; this ${update ? 'update' : 'package'} is signed by ${text(req.publisherChange.to)}. Continue only if you expected the publisher to change.`))] : []),
        p('who', s.development ? 'A development package: unsigned, loaded from its folder.' : req.publisher ? `Publisher: ${text(req.publisher)}` : 'Unsigned.', 'text-secondary'),
        // F10: the release it is for (an update's, not the one it runs)
        ...(req.source ? [p('from', `From GitHub · ${text(req.source.repo)} · release ${text(req.source.tag)} · ${text(req.source.digest).replace(/^sha256:(.{12}).*/, 'sha256 $1…')}`, 'text-secondary')] : []),
        ...(text(s.author) ? [p('author', `It says it is by ${text(s.author)}: its own claim; the publisher\u2019s key is what identifies it.`, 'text-secondary')] : []),
        ...(req.repoChange ? [e('div', { key: 'repo', role: 'alert', className: 'flex flex-col gap-1' }, e('span', { className: 'text-danger font-semibold' }, req.repoChange.another ? 'It comes from another repository' : 'Its repository was renamed or moved'),
          e('span', null, `It came from ${text(req.repoChange.from)}; this ${update ? 'update' : 'package'} comes from ${text(req.repoChange.to)}. Its publisher\u2019s key is checked as always; continue only if you expected this.`))] : []),
        ...(s.compatibility && s.compatibility !== 'compatible' ? [p('compat', COMPAT[s.compatibility] ?? text(s.compatibility))] : []),
        perms.length ? e('ul', { key: 'perms', className: 'flex flex-col gap-2', 'aria-label': 'What it may do' }, ...perms.map((x) => e('li', { key: x.id, className: 'flex flex-col' },
          e('span', null, x.text, x.added ? e('span', { className: 'text-danger' }, update ? ' · New in this update' : '') : null),
          e('span', { className: 'text-secondary' }, RISK[x.risk])))) : p('perms', optional.length ? 'It needs no permissions to run.' : 'It asks for no permissions.'),
        ...(optional.length ? [e('ul', { key: 'optional', className: 'flex flex-col gap-2', 'aria-label': 'What you decide later' }, ...optional.map((x) => e('li', { key: x.id, className: 'flex items-center justify-between gap-3' },
          e('span', { className: 'flex flex-col' }, e('span', null, text(x.label) || text(x.text)),
            e('span', { className: 'text-secondary' }, `Optional · ${RISK[x.risk] ?? ''} · ${allowNow.has(x.id) ? 'allowed now' : ({ ask: 'asks every time until you decide', deny: 'off until you allow it', allow: 'allowed' })[x.decision] ?? ''}`)),
          x.enforced !== false && (x.choices ?? []).includes('allow') ? e('label', { className: 'cmk-check-row' }, e(kit.Checkbox, { checked: allowNow.has(x.id), onChange: (on) => toggleNow(x.id, on), ariaLabel: `Allow ${text(x.label) || text(x.text)}` }), 'Allow now') : null)))] : []),
        p('trust', TRUST, 'text-secondary'),
        ...(update ? [p('keep', 'The version you have keeps running as it is until you approve.', 'text-secondary')] : []),
        ...(changed ? [p('changed', c.live ? 'What waits has changed since you opened this. Close it and review it again.' : 'It was answered elsewhere: nothing waits any more.', 'text-danger')] : []),
        said('consent'),
      ];
      // Denying an install removes the mod: the list is shown then.
      const act = (approve, enable) => confirm('consent', 'consent', enable === undefined ? [req.id, approve] : [req.id, approve, enable, ...(approve && allowNow.size ? [[...allowNow]] : [])], !approve && !update ? c.toOverview : undefined);
      const footer = [
        button(update ? 'Decline the update' : 'Deny', () => act(false), working || changed),
        ...(update ? [button('Approve', () => act(true), working || changed, 'primary')]
          : [button('Approve', () => act(true, false), working || changed), button('Approve and enable', () => act(true, true), working || changed || s.compatibility === 'blocked', 'primary')]),
      ];
      return e(ModsDialog, { key: 'consent', subject: modRef(c.modId), purpose: 'consent', title: update ? `Update ${name} to ${text(req.version)}?` : `Install ${name} ${text(req.version)}?`,
        subtitle: update ? 'What the update may do' : 'What it may do', onClose: close, footer }, ...body);
    }
    if (d.kind === 'rollback') {
      const v = d.version;
      const body = [
        p('what', `${name} goes from ${text(s.version)} back to ${text(v.version)}.`),
        ...(v.codeOnly ? [p('code', `Keeping its data: its data stays as it is now; its format is the same in both versions.`)] : []),
        ...(v.withData ? [p('data', `With its own data: the data saved with ${text(v.version)} comes back, and what changed in it since is lost. Retained storage is kept.`)] : []),
        said('rollback'),
      ];
      const footer = [
        button('Cancel', close, false),
        ...(v.codeOnly ? [button('Roll back, keeping its data', () => confirm('rollback', 'rollback', [v.version, false]), working, v.withData ? 'secondary' : 'primary')] : []),
        ...(v.withData ? [button('Roll back with its own data', () => confirm('rollback', 'rollback', [v.version, true]), working, 'danger')] : []),
      ];
      return e(ModsDialog, { key: 'rollback', subject: modRef(c.modId), purpose: 'rollback', title: `Roll back ${name} to ${text(v.version)}?`, onClose: close, footer }, ...body);
    }
    if (d.kind === 'reattach') {
      const g = d.kept;
      const body = [
        p('what', `The data kept on ${dayOf(g.at) || text(g.generation)}${g.version ? ` (version ${text(g.version)})` : ''}, ${sizeOf(g.bytes)}, becomes ${name}'s data again. A migration runs when its format is older.`),
        p('keep', `Nothing is replaced: it is refused while ${name} has data of its own.`, 'text-secondary'),
        ...(s.status === 'enabled' ? [p('off', `${name} is turned off while it happens and on again after.`, 'text-secondary')] : []),
        said('reattach'),
      ];
      return e(ModsDialog, { key: 'reattach', subject: modRef(c.modId), purpose: 'reattach', title: `Reattach ${name}'s kept data?`, onClose: close,
        footer: [button('Cancel', close, false), button('Reattach', () => confirm('reattach', 'reattach', [g.generation]), working, 'primary')] }, ...body);
    }
    if (d.kind === 'overrides') {
      const n = (s.storedOverrides ?? []).length;
      return e(ModsDialog, { key: 'overrides', subject: modRef(c.modId), purpose: 'clearOverrides', title: `Clear what ${name} stored for projects and chats?`, onClose: close,
        footer: [button('Cancel', close, false), button('Clear all', () => confirm('overrides', 'clearOverrides', []), working, 'danger')] },
      p('what', `${n} value${n === 1 ? '' : 's'} set for particular projects and chats go; those projects and chats use ${name}'s own setting again.`),
      p('keep', 'Its settings for every project and chat stay as they are.', 'text-secondary'), said('overrides'));
    }
    if (d.kind === 'uninstall') return e(o.common.UninstallDialog, { key: 'uninstall', modId: c.modId, modRef: modRef(c.modId), name, ops: c.data.ops, onClose: close, onDone: c.toOverview });
    return null;
  }

  return { ModPage, NotInstalled };
}
