// The copy's update on the Update page (docs/design/systems.md S21, "The pages", E6.3): what its row says, and its Dialog: the build, the
// framework and the mods it changes, its risks with the Features they concern, the mods whose update asks for more permissions (each
// consented to here, or left at its version), the chats working now that the switch stops, and Apply, Apply anyway (naming the mods it
// leaves behind) or Later. The Dialog names the plan it showed, so a plan changed meanwhile is refused. NO NODE API.
import { shortBuild, text } from './mods-text.mjs';

/** The chats a switch to the new copy stops: those working, or waiting for you in a turn. */
export const RUNNING_CHATS = Object.freeze({ type: 'Thread', where: { status: { $in: ['working', 'waitingForYou'] } }, depth: 'core' });
/** At most this many of them are named. */
export const CHATS_NAMED = 5;
const STATE = Object.freeze({ available: 'Not prepared yet', downloading: 'Being prepared…', ready: 'Prepared', installing: 'Being applied…' });

/** What the update's row says: its state, whether it is held, why it could not be prepared, whether you chose Later. */
export function updateSays(s) {
  const out = [STATE[s.state] ?? text(s.state)];
  if (s.state === 'ready') out.push(s.held ? 'Held: some mods may not work on it' : s.checked === 'run' ? 'Checked by running it' : 'Checked against the new build');
  if (s.problem) out.push(`It could not be prepared: ${text(s.problem)}`);
  if (s.dismissed) out.push('You chose Later: it stays here without asking again.');
  return out;
}

/**
 * @param {{ R: object, ctx: object, subscribe?: (query: object, fn: Function) => { dispose(): void }, ModsDialog: Function }} o
 * @returns {{ UpdateDialog: Function }}  `UpdateDialog({ update, plan, nameOf, parts, acting, onClose })` (`parts`: page-parts.mjs')
 */
export function createUpdateDialog(o) {
  const { R, ctx } = o;
  const e = R.createElement;

  /** The chats working now (their titles), while the Dialog is open. */
  function useRunningChats() {
    const [chats, setChats] = R.useState([]);
    R.useEffect(() => {
      if (typeof o.subscribe !== 'function') return undefined;
      let list = new Map();
      const sub = o.subscribe(RUNNING_CHATS, (m) => {
        if (!m) return;
        if (m.type === 'snapshot' || (m.type === 'delta' && Array.isArray(m.items))) list = new Map((m.items ?? []).filter((x) => x && !x.gone).map((x) => [x.ref.id, x]));
        else if (m.type === 'delta' && m.event) {
          if (m.event.kind === 'removed') list.delete(m.event.ref.id);
          else if (m.event.instance) list.set(m.event.ref.id, m.event.instance);
        }
        setChats([...list.values()].filter((x) => ['working', 'waitingForYou'].includes(x.state?.status)));
      });
      return () => sub.dispose();
    }, []);
    return chats;
  }

  function UpdateDialog({ update, plan, nameOf, parts, acting, onClose }) {
    const { button, toggle } = parts;
    const s = update?.state ?? {};
    const [consent, setConsent] = R.useState(() => new Set());
    const chats = useRunningChats();
    const featureTitle = (ref) => (ref ? text(ctx.subject(ref)?.state?.title) || ref.id : '');
    const p = (key, t, className) => e('p', { key, className }, t);
    const changed = !update || update.gone || s.plan !== plan;
    const busy = acting.busy('apply');
    const asking = (s.mods ?? []).filter((m) => (m.addedPermissions ?? []).length);
    const behind = [...new Set((s.risks ?? []).map((r) => r.mod?.id).filter(Boolean))];
    const body = [
      ...(s.build ? [p('build', `Codex ${shortBuild(s.build.from)} → ${shortBuild(s.build.to)}`)] : []),
      ...(s.framework ? [p('framework', `Framework ${text(s.framework.from)} → ${text(s.framework.to)}`)] : []),
      ...(s.mods ?? []).map((m) => p(`mod:${m.mod.id}`, `${nameOf(m.mod.id)} ${text(m.from)} → ${text(m.to)}`)),
      ...(s.risks?.length ? [e('div', { key: 'risks', className: 'flex flex-col gap-1', role: 'list', 'aria-label': 'Its risks' },
        ...s.risks.map((r, i) => e('span', { key: i, role: 'listitem' }, `${nameOf(r.mod?.id)}: ${text(r.sentence)}${r.feature ? ` (${featureTitle(r.feature)})` : ''}`)))] : []),
      ...asking.map((m) => e('div', { key: `ask:${m.mod.id}`, className: 'flex items-center justify-between gap-3' },
        e('span', null, `${nameOf(m.mod.id)} ${text(m.to)} asks for more: ${m.addedPermissions.map(text).join(', ')}. Without your consent it stays at ${text(m.from)}.`),
        toggle(`Update ${nameOf(m.mod.id)} with its new permissions`, consent.has(m.mod.id), (on) => setConsent((c) => { const n = new Set(c); if (on) n.add(m.mod.id); else n.delete(m.mod.id); return n; }), busy))),
      chats.length ? p('chats', `Codex restarts to switch: ${chats.length === 1 ? 'this chat stops' : `these ${chats.length} chats stop`}: ${chats.slice(0, CHATS_NAMED).map((c) => text(c.state?.title) || 'Untitled').join(', ')}${chats.length > CHATS_NAMED ? ` and ${chats.length - CHATS_NAMED} more` : ''}.`)
        : p('chats', 'Codex restarts to switch; no chat is working now.', 'text-secondary'),
      ...(s.held ? [p('behind', `Apply anyway leaves ${behind.map(nameOf).join(', ') || 'the mods at risk'} behind: turned off on the new build until you turn them on again.`, 'text-danger')] : []),
      ...(changed ? [p('changed', 'The update changed since you opened this. Close it and review it again.', 'text-danger')] : []),
      ...(acting.error('apply') ? [e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error('apply'))] : []),
    ];
    const ref = update?.ref;
    const consented = asking.filter((m) => consent.has(m.mod.id)).map((m) => m.mod);
    const apply = async (anyway) => { const out = await acting.run('apply', ref, 'apply', [plan, anyway, consented]); if (out.ok) onClose(); };
    const later = async () => { const out = await acting.run('apply', ref, 'later'); if (out.ok) onClose(); };
    const footer = [
      button('Later', later, busy || !ref),
      s.held ? button('Apply anyway', () => apply(true), busy || changed, 'danger') : button('Apply', () => apply(false), busy || changed, 'primary'),
    ];
    // named as the page names it: the build of Codex, and the framework with it
    const title = s.build ? `Update to Codex ${shortBuild(s.build.to)}${s.framework ? ` with framework ${text(s.framework.to)}` : ''}?` : `Update to ${text(s.version)}?`;
    return e(o.ModsDialog, { subject: update?.ref, purpose: 'update', title, subtitle: s.held ? 'Some mods may not work on it' : undefined, onClose, footer }, ...body);
  }
  return { UpdateDialog };
}
