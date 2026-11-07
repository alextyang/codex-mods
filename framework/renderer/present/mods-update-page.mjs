// The Update page (docs/design/framework-ui.md F2, F11; design-spec §2.2): the copy's update as it truly stands. Its summary (what is offered, the step it
// prepares, ready, being applied, how its last try ended, Later), the framework's support for the build from explicit outcomes, what is new when known, and
// your mods grouped by what the update does to them, each with where it stands now and after; Restart to update opens the review (mods-update.mjs), and
// Use original Codex opens the stock app after its Dialog. An empty state while nothing is offered. It reads and acts through the graph only. NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { createReport } from './reports.mjs';
import { readState, namesOf } from './band.mjs';
import { createUpdateDialog } from './mods-update.mjs';
import { dayOf, shortBuild, text } from './mods-text.mjs';

const RANK = { compatible: 0, degraded: 1, atRisk: 2, blocked: 3 };

/** Your mods' groups, in their order: key, label, glyph, tone, note (`{V}`: the build offered). */
export const GROUPS = Object.freeze([
  ['incompatible', 'Incompatible', 'alert', 'danger', 'Won’t load until updated'],
  ['affected', 'Affected', 'shield-alert', 'warning', 'Not tested; uses parts that changed'],
  ['unchecked', 'Couldn’t check', 'shield-alert', 'warning', 'What it uses could not be checked'],
  ['degraded', 'Works with less', 'shield-alert', 'neutral', 'Works without some of what it can use'],
  ['update', 'Compatible update', 'download', 'info', 'Update to keep working'],
  ['compatible', 'Compatible', 'check', 'success', 'Tested with {V}'],
  ['notAffected', 'Not affected', 'shield-alert', 'neutral', 'Not tested; what it uses did not change'],
  ['off', 'Off', 'plugin', 'neutral', 'If turned back on'],
]);

/** The group of one of `CopyUpdate.verdicts` (F11): a mod that is off is Off; one a verified newer version fixes is a Compatible update; else its verdict on the build. */
export function groupOf(v) {
  if (!v.on || v.now === 'blocked') return 'off';
  if (v.candidate && RANK[v.candidate.after] < RANK[v.after] && RANK[v.candidate.after] <= RANK.degraded) return 'update';
  if (v.after === 'blocked') return 'incompatible';
  if (v.after === 'atRisk') return (v.changed ?? []).length ? 'affected' : 'unchecked';
  if (v.after === 'degraded') return 'degraded';
  return v.tested ? 'compatible' : 'notAffected';
}

/** Names joined, at most three of them: `a, b and c`, `a, b, c and 4 more`. */
const list = (xs) => (xs.length <= 1 ? (xs[0] ?? '') : xs.length > 3 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const IF_ON = { compatible: 'it works', degraded: 'it works with less', atRisk: 'it may not work', blocked: 'it won’t load' };

/** What a mod's row says, by its group; `V`: the build offered, as said. */
export function reasonOf(v, group, V) {
  const uses = (v.uses ?? []).map(text), changed = (v.changed ?? []).map(text), missing = (v.missing ?? []).map(text), unchecked = (v.unchecked ?? []).map(text);
  const asks = v.candidate?.addedPermissions?.length ?? 0;
  switch (group) {
    case 'update': return `${text(v.candidate.version)} works with ${V}${asks ? ` · asks for ${asks === 1 ? 'a new permission' : `${asks} new permissions`}` : ''}`;
    case 'incompatible': return missing.length ? `Needs ${list(missing)}, which ${V} lacks` : changed.length ? `Needs ${list(changed)}, which changed` : `It can’t load on ${V}`;
    case 'affected': return `Uses ${list(changed)}, which changed`;
    case 'unchecked': return uses.length ? `Uses ${list(uses)}, which couldn’t be checked` : 'What it uses couldn’t be checked';
    case 'degraded': return missing.length ? `Works without ${list(missing)}` : changed.length ? `Can use ${list(changed)}, which changed`
      : unchecked.length ? `Can use ${list(unchecked)}, which couldn’t be checked` : 'Works without some of what it can use';
    case 'compatible': return `Tested with ${V}`;
    case 'notAffected': return uses.length ? `Uses ${list(uses)}` : 'Declares no app parts';
    default: return `If turned back on, ${IF_ON[v.candidate && RANK[v.candidate.after] < RANK[v.after] ? v.candidate.after : v.after] ?? 'it may not work'} on ${V}`;
  }
}

/** The icon pair's meanings: glyph, tone, what it says. */
export const MEANINGS = Object.freeze({
  works: ['check', 'success', 'Works'], updateAvail: ['download', 'info', 'Update available'], stopped: ['alert', 'danger', 'Stopped after an error'],
  wont: ['alert', 'danger', 'Won’t load'], compatible: ['check', 'success', 'Compatible'], notAffected: ['shield-alert', null, 'Not tested, not affected'],
  affected: ['shield-alert', 'warning', 'Not tested, affected'], unchecked: ['shield-alert', 'warning', 'Couldn’t be checked'], degraded: ['shield-alert', null, 'Works with less'],
});
/** Where a mod stands now and after the update, as the pair's meanings. `stopped`: it stopped after an error. */
export function pairOf(v, group, stopped = false) {
  const now = v.now === 'blocked' ? 'wont' : stopped ? 'stopped' : group === 'update' ? 'updateAvail' : 'works';
  const byVerdict = { blocked: 'wont', atRisk: (v.changed ?? []).length ? 'affected' : 'unchecked', degraded: 'degraded', compatible: v.tested ? 'compatible' : 'notAffected' };
  const after = group === 'off' ? byVerdict[v.after] : { incompatible: 'wont', update: 'compatible', affected: 'affected', unchecked: 'unchecked', degraded: 'degraded', compatible: 'compatible', notAffected: 'notAffected' }[group];
  return { now, after: after ?? 'notAffected' };
}

/** The framework card (F11): the version it shows, what it says, its pill. `fw`: the framework that runs; `V`: the build offered, as said. */
export function supportOf(us, fw, V) {
  const s = us.support?.status ?? (us.plan ? (us.framework ? 'ships' : 'already') : 'notChecked');
  switch (s) {
    case 'ships': return { version: text(us.framework?.to), detail: `Supports ${V}. Installs with the update.${us.support?.listed === false ? ' Its release does not list this build as tested.' : ''}`, pill: ['Compatible', 'success', 'check'] };
    case 'already': return { version: text(fw), detail: `Already supports ${V}. Nothing extra to install.`, pill: ['Compatible', 'success', 'check'] };
    case 'notYet': return { version: text(fw), detail: `No framework release supports ${V} yet.`, pill: ['Not supported yet', 'neutral', 'clock'] };
    case 'unknown': return { version: text(fw), detail: `Couldn’t check support for ${V}.${us.support?.problem ? ` ${text(us.support.problem)}` : ''}`, pill: ['Unknown', 'warning', 'shield-alert'] };
    case 'checking': return { version: text(fw), detail: `Checking support for ${V}${us.step ? `: ${STEPS[us.step] ?? text(us.step)}` : ''}.`, pill: ['Checking', 'neutral', 'clock'] };
    default: return { version: text(fw), detail: `Not checked yet. Prepare checks it against ${V}.`, pill: ['Not checked', 'neutral', 'clock'] };
  }
}

/** Staging's steps, as the page says them (progress is by step, F11). */
export const STEPS = Object.freeze({ start: 'starting', snapshot: 'copying Codex', framework: 'getting the framework', pack: 'reading the new build', evidence: 'checking what changed',
  candidate: 'building the new copy', mods: 'checking your mods', plan: 'finishing' });

/**
 * @param {{ R: object, ctx: object, kit: object, common: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>, frameworkRef: object,
 *   dialogs: { ModsDialog: Function }, subscribe?: (query: object, fn: Function) => { dispose(): void }, takeIntent?: (kind: string) => boolean, hasIntent?: (kind: string) => boolean }} o
 *   `takeIntent`: whether the band asked to open the update's review ('update') when the page is shown; `subscribe`: the graph's, for the chats an update's switch would stop
 */
export function createUpdatePage(o) {
  const { R, ctx, kit } = o;
  const e = R.createElement;
  const { UpdateDialog } = createUpdateDialog({ R, ctx, subscribe: o.subscribe, ModsDialog: o.dialogs.ModsDialog });
  const Report = createReport(R, ctx);

  /** The pair: where it stands now, an arrow, and after (in its circle). */
  function Pair({ now, after, current, V }) {
    const [ng, nt, nw] = MEANINGS[now], [ag, at, aw] = MEANINGS[after];
    return e('span', { className: 'cmk-pair' },
      e('span', { className: 'cmk-pair-now', role: 'img', title: nw, 'aria-label': `${nw} on ${current}`, ...(nt ? { 'data-tone': nt } : {}) }, e(kit.Glyph, { name: ng })),
      e('span', { 'aria-hidden': true }, '→'),
      e('span', { className: 'cmk-pair-after', role: 'img', title: aw, 'aria-label': `${aw} on ${V}`, ...(at ? { 'data-tone': at } : {}) }, e(kit.Glyph, { name: ag })));
  }

  function UpdatePage() {
    const ex = o.exports() ?? {};
    const { SettingsPageFrame: Frame } = ex;
    const acting = useActing(R, o.invoke);
    const [dialog, setDialog] = R.useState(() => (o.takeIntent?.('update') ? { kind: 'review', plan: null } : null));
    const data = ctx.use(() => {
      const state = readState(ctx, o.frameworkRef);
      return state ? { ...state, app: state.fw.links?.app ? ctx.subject(state.fw.links.app) ?? null : null } : null;
    });
    // The band's ask arriving while the page is shown opens the review too, and it shows the plan offered when it was first read.
    const asked = ctx.use(() => o.hasIntent?.('update') ?? false);
    R.useEffect(() => { if (asked && o.takeIntent?.('update')) setDialog({ kind: 'review', plan: null }); }, [asked]);
    const update = data?.update && !data.update.gone ? data.update : null;
    const livePlan = update?.state?.plan ?? null;
    R.useEffect(() => { if (dialog?.kind === 'review' && !dialog.plan && livePlan) setDialog({ kind: 'review', plan: livePlan }); }, [dialog, livePlan]);
    const parts = pageParts(R, ex);
    const { button } = parts;
    if (!data) return e(Frame, { title: 'Update' });
    const safe = data.fw.state?.safeMode === true ? [e(o.common.SafeBanner, { key: 'safe' })] : [];
    const f = data.fw.state ?? {};
    const check = () => acting.run('check', o.frameworkRef, 'checkForUpdates');

    if (!update) {
      const build = shortBuild(data.app?.state?.version);
      const youHave = build ? `You have Codex ${build}.` : '';
      // A check that could not complete does not say Codex is up to date.
      return e(Frame, { title: 'Update' }, ...safe,
        e(kit.EmptyState, { key: 'none', ...(f.checkProblem ? { glyph: 'alert', title: 'Couldn’t check for updates', description: `${text(f.checkProblem)}${youHave ? ` ${youHave}` : ''}` }
          : { glyph: 'check', title: 'Codex is up to date', description: `${youHave ? `${youHave} ` : ''}Mods are checked again when the next update arrives.` }),
        actions: [{ label: 'Check for updates', onClick: check, disabled: acting.busy('check') }] }),
        dayOf(f.lastChecked) || acting.error('check') ? e('p', { key: 'last', className: acting.error('check') ? 'cmk-error' : 'cmk-meta', style: { margin: 0, textAlign: 'center' }, ...(acting.error('check') ? { role: 'alert' } : {}) }, acting.error('check') ? acting.error('check') : `Last checked ${dayOf(f.lastChecked)}`) : null);
    }

    const us = update.state ?? {};
    const anyRunning = data.ops.some((x) => x.state?.outcome === 'running');
    const have = shortBuild(us.build?.from ?? data.app?.state?.version);
    const current = have ? `Codex ${have}` : 'this version of Codex';
    const V = us.build ? `Codex ${shortBuild(us.build.to)}` : current;
    // what is offered names itself: a build of Codex, or a framework release alone (F11: the page's headline says which)
    const what = us.build ? V : us.framework ? `Framework ${text(us.framework.to)}` : `The update to ${text(us.version)}`;
    const support = us.support?.status ?? (us.plan ? (us.framework ? 'ships' : 'already') : 'notChecked');
    const preparing = us.state === 'downloading' || support === 'checking';
    const nameOf = namesOf(data);
    const stoppedOf = (ref) => ctx.subject(ref)?.state?.state === 'stopped';
    const close = () => setDialog(null);

    // ---- your mods, grouped (only with a candidate the framework supports: F11)
    const verdicts = (support === 'ships' || support === 'already') ? (us.verdicts ?? []) : [];
    const grouped = new Map(GROUPS.map(([k]) => [k, []]));
    for (const v of verdicts) grouped.get(groupOf(v)).push(v);
    const risky = ['incompatible', 'affected', 'unchecked'].reduce((n, k) => n + grouped.get(k).length, 0);
    // a newer GitHub release that runs on this build is applied now; one that only runs on the new build applies with the update
    const appliesNow = (v) => { const r = ctx.subject(v.mod)?.state?.release; return v.candidate?.from === 'github' && r && r.version === v.candidate.version && r.verdict !== 'blocked'; };

    // ---- the summary
    let headline, glyph, tone, actions;
    if (us.state === 'installing') { headline = `${what} is being applied`; glyph = 'refresh'; tone = 'info'; actions = [button('Restarting…', undefined, true, 'primary')]; } else if (preparing) {
      headline = `Preparing ${what}`; glyph = 'download';
      // its own key: Prepare's call lasts as long as the preparation, and Cancel is for exactly then
      actions = [button('Cancel', () => acting.run('cancel', update.ref, 'later'), acting.busy('cancel')), button('Preparing…', undefined, true, 'primary')];
    } else if (us.state === 'ready' && us.plan) {
      headline = `${what} is ready to install`; glyph = 'refresh'; tone = 'info';
      actions = [button('Restart to update…', () => setDialog({ kind: 'review', plan: us.plan }), anyRunning, 'primary')];
    } else if (support === 'notYet') {
      headline = `${what} is waiting for mods support`; glyph = 'clock';
      actions = us.build ? [button('Use original Codex…', () => setDialog({ kind: 'original' }), acting.busy('original'))] : [];
    } else if (support === 'unknown') {
      headline = `Couldn’t check mods support for ${what}`; glyph = 'alert';
      actions = [button('Try again', () => acting.run('update', update.ref, 'download'), acting.busy('update') || anyRunning, 'primary')];
    } else {
      headline = `${what} is available`; glyph = 'download';
      actions = [button('Prepare update', () => acting.run('update', update.ref, 'download'), acting.busy('update') || anyRunning, 'primary')];
    }
    const meta = [us.build ? `${shortBuild(us.build.from)} → ${shortBuild(us.build.to)}` : '', us.framework ? `framework ${text(us.framework.from)} → ${text(us.framework.to)}` : ''].filter(Boolean).join(' · ');
    const said = acting.error('update') || acting.error('cancel') || acting.error('original');
    const summary = e('div', { key: 'summary', className: 'cmk-summary', 'data-update-state': us.state === 'installing' ? 'installing' : preparing ? 'preparing' : us.state === 'ready' ? 'ready' : support },
      e(kit.IconTile, { glyph, tone }),
      e('div', { className: 'cmk-summary-text' }, e('h2', { className: 'cmk-summary-title' }, headline),
        meta ? e('span', { className: 'cmk-meta' }, meta) : null,
        preparing && us.step ? e('span', { className: 'cmk-meta' }, `Step: ${STEPS[us.step] ?? text(us.step)}`) : null,
        us.problem && support !== 'notYet' && support !== 'unknown' ? e('span', { className: 'cmk-error' }, `It could not be prepared: ${text(us.problem)}`) : null,
        us.dismissed ? e('span', { className: 'cmk-meta' }, 'You chose Later: it stays here without asking again.') : null,
        said ? e('span', { className: 'cmk-error', role: 'alert' }, said) : null),
      e('div', { className: 'cmk-summary-actions' }, ...actions.map((a, i) => e(R.Fragment, { key: i }, a))));

    // ---- how its last try ended (F11): never promise an automatic update it will not make
    const tried = us.lastApply ? e(kit.Banner, { key: 'tried', tone: 'danger', glyph: 'alert',
      title: us.lastApply.outcome === 'reverted' ? 'The update was undone' : us.lastApply.outcome === 'needsAttention' ? 'The last try needs your attention' : 'The last try did not complete',
      message: [us.lastApply.note ? text(us.lastApply.note) : '', `Codex stayed on ${shortBuild(us.build?.from) || 'the version it had'}.`, us.automatic?.why === 'tried' ? 'It is not applied on its own again.' : ''].filter(Boolean).join(' ') }) : null;

    // ---- the framework card and its note
    const card = supportOf(us, f.version, V);
    const note = support === 'notYet' ? ['refresh', `Your mods keep running on ${current}. Check again later, or use the original Codex for ${V}.`]
      : support === 'unknown' ? ['refresh', `Codex won’t update until mods support is confirmed. Your mods keep running on ${current}.`]
        : risky || us.held ? ['shield-alert', `${risky ? `${risky} mod${risky === 1 ? '' : 's'}` : 'Some mods'} may not work on ${V}.${us.held ? ' Updating anyway turns them off until you turn them on again.' : ''}`]
          : us.automatic?.will ? ['refresh', 'Codex updates automatically the next time it restarts.'] : null;
    const framework = e('div', { key: 'framework', className: 'cmk-panel', 'aria-label': 'Mods framework' },
      e('div', { className: 'cmk-panel-head' }, e(kit.IconTile, { glyph: 'plugin', size: 'sm' }),
        e('div', { className: 'cmk-vrow-text' }, e('span', { className: 'cmk-vrow-name' }, 'Mods framework', e('span', { className: 'cmk-meta' }, card.version)), e('span', { className: 'cmk-vrow-why' }, card.detail)),
        e(kit.Badge, { label: card.pill[0], tone: card.pill[1], glyph: card.pill[2] })),
      note ? e('div', { className: 'cmk-panel-note' }, e(kit.Glyph, { name: note[0], size: 14 }), e('span', null, note[1])) : null);

    // ---- what is new, when known
    const notes = typeof us.notes === 'string' ? us.notes.split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean) : [];
    const whatsNew = notes.length ? e('div', { key: 'notes', className: 'cmk-tight' }, e('h3', { className: 'cmk-head' }, `What’s new in ${V}`),
      e('ul', { className: 'cmk-notes' }, ...notes.map((l, i) => e('li', { key: i }, l)))) : null;

    // ---- your mods
    const row = (v, group) => {
      const m = ctx.subject(v.mod)?.state ?? {};
      const pair = pairOf(v, group, stoppedOf(v.mod));
      const key = `mod:${v.mod.id}`;
      const control = group !== 'update' ? null : appliesNow(v) ? button('Update', () => acting.run(key, v.mod, 'applyUpdate'), acting.busy(key) || anyRunning)
        : e('span', { className: 'cmk-meta' }, `Updates with ${V}`);
      return e('div', { key: v.mod.id, className: 'cmk-vrow', 'data-codexmods-mod': v.mod.id },
        e(kit.IconTile, { glyph: text(m.glyph) || 'plugin', size: 'sm' }),
        e('div', { className: 'cmk-vrow-text' }, e('span', { className: 'cmk-vrow-name' }, nameOf(v.mod.id), e('span', { className: 'cmk-meta' }, `v${text(v.version)}`)),
          e('span', { className: 'cmk-vrow-why' }, reasonOf(v, group, V)), acting.error(key) ? e('span', { className: 'cmk-error', role: 'alert' }, acting.error(key)) : null),
        control, e(Pair, { ...pair, current, V }));
    };
    const groups = GROUPS.filter(([k]) => grouped.get(k).length).map(([k, label, g, t, groupNote]) => {
      const rows = grouped.get(k);
      const now = k === 'update' ? rows.filter(appliesNow) : [];
      const all = now.length > 1 ? button('Update all', async () => { for (const v of now) await acting.run(`mod:${v.mod.id}`, v.mod, 'applyUpdate'); }, now.some((v) => acting.busy(`mod:${v.mod.id}`)) || anyRunning) : null;
      return e('section', { key: k, className: 'cmk-group', 'data-tone': t, 'aria-label': `${label} mods` },
        e('div', { className: 'cmk-group-head' }, e(kit.Glyph, { name: g }), e('span', { className: 'cmk-group-label' }, label), e('span', { className: 'cmk-group-note' }, groupNote.replace('{V}', V)), all),
        e('div', { className: 'cmk-group-rows' }, ...rows.map((v) => row(v, k))));
    });
    const yourMods = groups.length ? e('div', { key: 'mods', className: 'cmk-groups' },
      e('div', { className: 'cmk-groups-head' }, e('h3', { className: 'cmk-head' }, 'Your mods'), e('span', { className: 'cmk-meta' }, `${current} → ${V}`)), ...groups) : null;

    // ---- its Dialogs: the review, and Use original Codex
    let dialogEl = null;
    if (dialog?.kind === 'review' && dialog.plan) dialogEl = e(UpdateDialog, { key: 'update', update, plan: dialog.plan, nameOf, parts, acting, onClose: close });
    else if (dialog?.kind === 'original') {
      const open = async () => { const out = await acting.run('original', update.ref, 'openOriginal'); if (out.ok) close(); };
      dialogEl = e(o.dialogs.ModsDialog, { key: 'original', subject: update.ref, purpose: 'original', title: 'Use Codex without mods?', onClose: close,
        footer: [button('Cancel', close), button('Open original Codex', open, acting.busy('original'), 'primary')] },
      e('p', { key: 'what' }, `The original Codex app opens and updates to ${shortBuild(us.build?.to)} on its own. Mods aren’t available there. Your mods, settings and permissions stay here, and you can switch back once the mods framework supports ${shortBuild(us.build?.to)}.`),
      acting.error('original') ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error('original')) : null);
    }

    return e(R.Fragment, null,
      e(Frame, { title: 'Update' }, ...safe, tried, summary, framework, whatsNew, yourMods,
        e(Report, { key: 'report', type: 'SettingsRow', subject: update.ref, place: { in: 'SettingsPage', via: 'codexMods', slot: 'update' } })),
      dialogEl);
  }
  return { UpdatePage };
}
