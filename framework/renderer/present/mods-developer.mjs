// The Developer page (docs/design/framework-ui.md F2, F4, F12; design-spec §2.3): loading a mod from a folder, safe mode (asked first in a Dialog, since it restarts the app), the framework's
// version, last-known-good and update policy, and Recent activity: the operations that belong to no installed mod, with their acknowledgement. It reads and acts through the graph
// only. NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { createReport } from './reports.mjs';
import { readState } from './band.mjs';
import { KIND, OUTCOME, text, dayOf, shortBuild, opSays, worthShowing } from './mods-text.mjs';

/** Recent activity: at most this many operations, the newest first. */
export const ACTIVITY = 10;

/**
 * @param {{ R: object, ctx: object, common: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>,
 *   pickFile?: (o: { extensions?: string[], directory?: boolean }) => Promise<string | null>, frameworkRef: object, dialogs: { ModsDialog: Function } }} o
 */
export function createDeveloperPage(o) {
  const { R, ctx } = o;
  const e = R.createElement;
  const { ModsDialog } = o.dialogs;
  const Report = createReport(R, ctx);

  function DeveloperPage() {
    const ex = o.exports() ?? {};
    const { SettingsPageFrame: Frame, SettingsRow: Row } = ex;
    const acting = useActing(R, o.invoke);
    const [dialog, setDialog] = R.useState(null);
    const data = ctx.use(() => readState(ctx, o.frameworkRef));
    const { value, button, toggle, lines, section } = pageParts(R, ex);
    if (!data) return e(Frame, { title: 'Developer' });
    const { fw, mods, ops } = data;
    const f = fw.state ?? {};
    const close = () => setDialog(null);
    const installed = new Set(mods.map((m) => m.ref.id));
    const lkg = f.lastKnownGood;

    const loadUnpacked = async () => {
      const path = await o.pickFile?.({ directory: true });
      if (path) await acting.run('install', o.frameworkRef, 'install', [path]);
    };

    const developmentRows = [
      // F12: folder installs, and a fault's stack on a mod's Activity
      e(Row, { key: 'developer', label: 'Developer mode', description: lines(['Load mods from a folder and show full errors'], acting.error('developer')),
        control: toggle('Developer mode', f.developerMode === true, (on) => acting.run('developer', o.frameworkRef, 'setDeveloperMode', [on]), acting.busy('developer')) }),
      e(Row, { key: 'unpacked', label: 'Load unpacked mod', description: lines([f.developerMode ? 'Install a mod from a folder on this computer' : 'Turn on Developer mode to load a mod from a folder'], acting.error('install')),
        control: button('Choose folder…', loadUnpacked, typeof o.pickFile !== 'function' || acting.busy('install') || f.developerMode !== true) }),
    ];
    const safeRows = [   // never held by a running operation: the way out (E6 review)
      e(Row, { key: 'safe', label: 'Run Codex without mods', description: 'Turns every mod off without changing its settings. Use it when a mod keeps Codex from working.',
        control: toggle('Run Codex without mods', f.safeMode, (on) => setDialog({ kind: 'safe', on })) }),
    ];
    const frameworkRows = [
      e(Row, { key: 'version', label: 'Version', description: f.previousVersion ? `Before this: ${text(f.previousVersion)}` : undefined, control: value(text(f.version)) }),
      e(Row, { key: 'lkg', label: 'Last-known-good',
        description: lines([lkg ? `Codex ${shortBuild(lkg.app)}, framework ${text(lkg.framework)}${dayOf(lkg.at) ? `, recorded ${dayOf(lkg.at)}` : ''}` : 'None recorded yet'], acting.error('lkg')),
        control: button('Restore…', () => setDialog({ kind: 'lkg' }), !lkg || acting.busy('lkg')) }),
      e(Row, { key: 'check', label: 'Check for updates', description: lines([dayOf(f.lastChecked) ? `Last checked ${dayOf(f.lastChecked)}` : '',
        f.checkProblem ? `The last check could not complete: ${text(f.checkProblem)}` : ''], acting.error('check')),
        control: button('Check now', () => acting.run('check', o.frameworkRef, 'checkForUpdates'), acting.busy('check')) }),
      e(Row, { key: 'policy', label: 'Apply updates automatically',
        description: lines(['A prepared update that holds no mod back is applied at the next launch of Codex, unless you chose Later for it.'], acting.error('policy')),
        control: toggle('Apply updates automatically', f.updatePolicy === 'auto', (on) => acting.run('policy', o.frameworkRef, 'setUpdatePolicy', [on ? 'auto' : 'offer']), acting.busy('policy')) }),
    ];

    // ---- what belongs to no installed mod: copy updates, framework updates, removed mods; the rest is on its mod's Activity tab
    const activityRows = worthShowing(ops.filter((x) => !installed.has(x.links?.mod?.id)), ACTIVITY).map((x) => {
      const s = x.state ?? {};
      const key = `op:${x.ref.id}`;
      const control = s.outcome === 'needsAttention' ? button('Acknowledge', () => acting.run(key, x.ref, 'acknowledge'), acting.busy(key)) : value(OUTCOME[s.outcome] ?? text(s.outcome));
      return e(R.Fragment, { key: x.ref.id }, e(Row, { label: KIND[s.kind] ?? text(s.kind), description: lines([opSays(s)], acting.error(key)), control }),
        e(Report, { type: 'SettingsRow', subject: x.ref, place: { in: 'SettingsPage', via: 'codexMods', slot: 'activity' } }));
    });

    const p = (key, t, className) => e('p', { key, className }, t);
    const said = (key) => (acting.error(key) ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error(key)) : null);
    const restore = async () => { const out = await acting.run('lkg', o.frameworkRef, 'restoreLastKnownGood'); if (out.ok) close(); };
    let dialogEl = null;
    if (dialog?.kind === 'safe') dialogEl = e(o.common.SafeDialog, { key: 'safe', on: dialog.on, onClose: close });
    else if (dialog?.kind === 'lkg' && lkg) {
      dialogEl = e(ModsDialog, { key: 'lkg', subject: o.frameworkRef, purpose: 'lastKnownGood', title: 'Restore last-known-good?', onClose: close,
        footer: [button('Cancel', close), button('Restore and restart', restore, acting.busy('lkg'), 'danger')] },
      p('what', `The framework, your mods and their settings go back to how they were with Codex ${shortBuild(lkg.app)} and framework ${text(lkg.framework)}${dayOf(lkg.at) ? ` (${dayOf(lkg.at)})` : ''}, and the copy of Codex too when its build changed since.`),
      p('data', 'Mod data is never rolled back: a mod whose data format changed since stays off.'),
      p('chats', 'Codex restarts: a chat that is working stops.', 'text-secondary'), said('lkg'));
    }

    return e(R.Fragment, null,
      e(Frame, { title: 'Developer' },
        ...(f.safeMode ? [e(o.common.SafeBanner, { key: 'safe-banner' })] : []),
        section('development', 'Development', developmentRows),
        section('safe', 'Safe mode', safeRows),
        section('framework', 'Framework', frameworkRows),
        ...(activityRows.length ? [section('activity', 'Recent activity', activityRows)] : [])),
      dialogEl);
  }
  return { DeveloperPage };
}
