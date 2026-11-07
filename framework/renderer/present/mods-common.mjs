// What the framework's pages share (docs/design/framework-ui.md F4, F16): the safe-mode banner above every page, its Dialog, and a mod's Uninstall, which both the Mods list and a mod's
// page open. It reads and acts through the graph as the framework scope. NO NODE API.
import { useActing } from './acting.mjs';
import { pageParts } from './page-parts.mjs';
import { KIND, text } from './mods-text.mjs';

/**
 * @param {{ R: object, kit: object, exports: () => object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object>, frameworkRef: object, dialogs: { ModsDialog: Function } }} o
 */
export function createPageCommon(o) {
  const { R, kit } = o;
  const e = R.createElement;
  const { ModsDialog } = o.dialogs;

  /** Turning safe mode on or off: it restarts the app, so it asks first. */
  function SafeDialog({ on, onClose }) {
    const acting = useActing(R, o.invoke);
    const { button } = pageParts(R, o.exports() ?? {});
    const confirm = async () => { const out = await acting.run('safe', o.frameworkRef, on ? 'enterSafeMode' : 'leaveSafeMode'); if (out.ok) onClose(); };
    return e(ModsDialog, { subject: o.frameworkRef, purpose: 'safeMode', title: on ? 'Run Codex without mods?' : 'Turn mods back on?', onClose,
      footer: [button('Cancel', onClose), button(on ? 'Turn off mods and restart' : 'Turn on and restart', confirm, acting.busy('safe'), 'primary')] },
    e('p', { key: 'what' }, on ? 'Codex restarts without any mod. Your mods, their settings and their data stay as they are.' : 'Codex restarts with your mods that are on.'),
    e('p', { key: 'chats', className: 'text-secondary' }, 'A chat that is working stops.'),
    acting.error('safe') ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error('safe')) : null);
  }

  /** The banner above every page while safe mode is on. */
  function SafeBanner() {
    const [asking, setAsking] = R.useState(false);
    return e(R.Fragment, null,
      e(kit.Banner, { tone: 'warning', title: 'Mods are off', message: 'Codex is running without mods. Their settings and permissions are kept.', actions: [{ label: 'Turn mods back on', onClick: () => setAsking(true) }] }),
      asking ? e(SafeDialog, { on: false, onClose: () => setAsking(false) }) : null);
  }

  /** Uninstall (F16): keeping the data is the default, since nothing brings deleted data back; deleting names the operations it would leave you unable to review. */
  function UninstallDialog({ modId, modRef, name, ops = [], onClose, onDone }) {
    const acting = useActing(R, o.invoke);
    const [keep, setKeep] = R.useState(true);
    const { button } = pageParts(R, o.exports() ?? {});
    const attention = ops.filter((x) => x.state?.outcome === 'needsAttention' && !x.state?.acknowledgedAt);
    const uninstall = async () => { const out = await acting.run('remove', modRef, 'remove', [keep]); if (out.ok) { onClose(); onDone?.(modId); } };
    return e(ModsDialog, { subject: modRef, purpose: 'remove', title: `Uninstall ${name}?`, onClose,
      footer: [button('Cancel', onClose), button('Uninstall', uninstall, acting.busy('remove'), 'danger')] },
    e('label', { key: 'keep', className: 'cmk-check-row' }, e(kit.Checkbox, { checked: keep, onChange: setKeep, ariaLabel: 'Keep its data' }), 'Keep its data'),
    e('p', { key: 'what' }, keep ? 'Its data is kept aside: install it again from the same publisher to reattach it.'
      : 'Its settings, data, retained storage, snapshots, secrets and backends are deleted. This cannot be undone.'),
    !keep && attention.length ? e('div', { key: 'att', className: 'flex flex-col gap-1', role: 'alert' },
      e('span', { className: 'text-danger' }, 'These operations need attention; deleting its data removes what you would review them by:'),
      ...attention.map((x) => e('span', { key: x.ref.id }, `${KIND[x.state.kind] ?? text(x.state.kind)}: ${text(x.state.message) || 'needs attention'}`))) : null,
    acting.error('remove') ? e('p', { key: 'err', className: 'text-danger', role: 'alert' }, acting.error('remove')) : null);
  }

  return { SafeBanner, SafeDialog, UninstallDialog };
}
