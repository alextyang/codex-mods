// The band (docs/design/systems.md E6 decision 4, E6.4; docs/design/framework-ui.md F15): in every window, at the top of its content (below the title
// bar's drag region and below the app's dialogs), ONE line for what needs you: an operation needing attention, a mod stopped that you have not looked at
// since (its page opened is looked at), an update held, safe mode. One source says itself, with Open to its place and Dismiss where the state allows it
// (acknowledging the operation, Later for the update); several say how many of each, with Open to the most severe's place. Nothing shows when all is
// well: it is not a status bar. A mod stopping also toasts in the window in front (F16), never the only record. It reads the graph and acts through it
// as the framework scope, drawn with the app's Button and theme classes only. NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { KIND, text } from './mods-text.mjs';
import { createReport } from './reports.mjs';
import { toast } from './toasts.mjs';

/** Settings › General, where the recovery entry is: Open goes there when the window's Mods pages cannot run. */
export const RECOVERY_PATH = '/settings/general-settings';

/**
 * What needs you, the most severe first.
 * @param {{ fw: object, mods: { ref: object, mod: object }[], ops: object[], update: object | null }} data
 * @param {(modId: string) => string} nameOf
 * @returns {{ key: string, kind: 'attention' | 'quarantined' | 'safeMode' | 'update', subject: object, text: string, open: object, dismiss?: { ref: object, op: string } }[]}
 */
export function bannersOf(data, nameOf) {
  const out = [];
  for (const x of data.ops) {
    const s = x.state ?? {};
    if (s.outcome !== 'needsAttention' || s.acknowledgedAt) continue;
    const mod = x.links?.mod?.id;
    out.push({ key: `op:${x.ref.id}`, kind: 'attention', subject: x.ref, text: `${KIND[s.kind] ?? text(s.kind)}${mod ? ` · ${nameOf(mod)}` : ''} needs your attention${text(s.message) ? `: ${text(s.message)}` : '.'}`,
      open: mod && data.mods.some((m) => m.ref.id === mod) ? { mod, tab: 'activity' } : { developer: true }, dismiss: { ref: x.ref, op: 'acknowledge' } });
  }
  for (const { ref, mod } of data.mods) {
    const s = mod && !mod.gone ? mod.state ?? {} : {};
    // a stop you have looked at (its page opened since) is on its page and in the list: not here
    if (s.status !== 'quarantined' || s.stopSeen === true) continue;
    out.push({ key: `mod:${ref.id}`, kind: 'quarantined', subject: ref, text: `${nameOf(ref.id)} was turned off after faults${text(s.quarantine?.reason) ? `: ${text(s.quarantine.reason)}` : '.'}`, open: { mod: ref.id } });
  }
  if (data.fw.state?.safeMode) out.push({ key: 'safe', kind: 'safeMode', subject: data.fw.ref, text: 'Safe mode is on: no mod runs until you turn it off.', open: { overview: true } });
  // an update held needs you; a ready one waits on the Update page (its nav row says Ready)
  const u = data.update && !data.update.gone ? data.update.state ?? {} : null;
  if (u && u.state === 'ready' && u.held && !u.dismissed) {
    out.push({ key: 'update', kind: 'update', subject: data.update.ref, text: `An update is held: ${text(u.version)}. Some mods may not work on it.`, open: { update: true }, dismiss: { ref: data.update.ref, op: 'later' } });
  }
  return out;
}

const COUNTED = Object.freeze({ attention: ['operation needs your attention', 'operations need your attention'], quarantined: ['mod stopped', 'mods stopped'],
  update: ['update is held', 'updates are held'], safeMode: ['safe mode is on', 'safe mode is on'] });
/** The one line for what needs you: one source as itself; several by how many of each, opening the most severe's place (the Mods list when they are mods). */
export function lineOf(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const counts = new Map();
  for (const b of list) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => (k === 'safeMode' ? COUNTED.safeMode[0] : `${n === 1 ? (k === 'update' ? 'an' : 'one') : n} ${COUNTED[k][n === 1 ? 0 : 1]}`));
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  const first = list[0];
  const open = list.every((b) => b.kind === 'quarantined') ? { overview: true } : first.open;
  return { key: 'band', kind: first.kind, text: `${said.charAt(0).toUpperCase()}${said.slice(1)}.`, open };
}

/** The framework's state the band and the Mods entry read: the framework, its mods, its operations, its update. */
export function readState(ctx, frameworkRef) {
  const fw = ctx.subject(frameworkRef);
  if (!fw || fw.gone) return null;
  return {
    fw,
    mods: (fw.links?.mods ?? []).map((ref) => ({ ref, mod: ctx.subject(ref) })),
    ops: (fw.links?.operations ?? []).map((ref) => ctx.subject(ref)).filter((x) => x && !x.gone),
    update: fw.links?.update ? ctx.subject(fw.links.update) ?? null : null,
  };
}

/** The names of the mods, by id. */
export const namesOf = (data) => {
  const names = new Map(data.mods.map(({ ref, mod }) => [ref.id, text(mod?.state?.name) || ref.id]));
  return (id) => names.get(id) ?? text(id);
};

/**
 * @param {{ R: object, ctx: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>,
 *   open: (target: { overview?: true, mod?: string, tab?: string, developer?: true, update?: true }) => void, frameworkRef: object, focused?: () => boolean }} o
 *   `focused`: whether this window is the one in front (a mod's stop toasts there only)
 */
export function createBand(o) {
  const { R, ctx } = o;
  const e = R.createElement;
  const Report = createReport(R, ctx);
  const focused = o.focused ?? (() => globalThis.document?.hasFocus?.() === true);

  function Band() {
    const ex = o.exports() ?? {};
    const acting = useActing(R, o.invoke);
    const data = ctx.use(() => readState(ctx, o.frameworkRef));
    // F16: a mod that stops while this window is shown toasts here, when it is in front; those stopped before are only in the line
    const stops = R.useRef(null);
    R.useEffect(() => {
      if (!data) return;
      const now = new Map(data.mods.filter(({ mod }) => mod?.state?.status === 'quarantined').map(({ ref, mod }) => [ref.id, mod.state.quarantine?.at ?? 0]));
      if (stops.current) {
        for (const [id, at] of now) {
          if (stops.current.get(id) === at || !focused()) continue;
          const m = data.mods.find((x) => x.ref.id === id)?.mod?.state ?? {};
          const name = text(m.name) || id;
          toast(ex, { kind: 'warning', title: `${name} stopped`, body: text(m.quarantine?.reason) ? `It was turned off after faults: ${text(m.quarantine.reason)}` : 'It was turned off after faults.',
            id: `stopped:${id}`, action: { label: 'Open', onClick: () => o.open({ mod: id }) } });
        }
      }
      stops.current = now;
    });
    if (!data) return null;
    const list = bannersOf(data, namesOf(data));
    const b = lineOf(list);
    if (!b) return null;
    const { button } = pageParts(R, ex);
    return e('div', { 'data-codexmods-band': '', 'data-codexmods-framework': '', role: 'region', 'aria-label': 'Mods',
      className: 'flex flex-col border-b border-default bg-surface-secondary text-default text-sm' },
    e('div', { key: b.key, className: 'flex items-center gap-3 px-4 py-2', role: 'status' },
      e('span', { key: 't', className: `min-w-0 flex-1 truncate${b.kind === 'attention' || b.kind === 'quarantined' ? ' text-danger' : ''}`, title: b.text }, b.text),
      acting.error(b.key) ? e('span', { key: 'err', className: 'shrink-0 text-danger', role: 'alert' }, acting.error(b.key)) : null,
      e('span', { key: 'open', className: 'shrink-0' }, button('Open', () => o.open(b.open))),
      b.dismiss ? e('span', { key: 'dismiss', className: 'shrink-0' }, button('Dismiss', () => acting.run(b.key, b.dismiss.ref, b.dismiss.op), acting.busy(b.key))) : null),
    // each source reported as a NotificationBanner of the window (E6.5)
    ...list.map((x) => (x.subject ? e(Report, { key: `report:${x.key}`, type: 'NotificationBanner', subject: x.subject, place: { in: 'Window', slot: 'banner' } }) : null)));
  }
  return { Band };
}
