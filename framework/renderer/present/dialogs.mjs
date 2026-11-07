// The framework's Dialogs on its pages (docs/design/systems.md E6 decision 3): consent, the confirmations of what cannot be undone, and
// later the update's review. The app's Dialog and its parts (a Radix dialog: modal, focus kept inside, closed on Escape, focus given back),
// rendered inside the Settings route where the app's providers are; its header draws the title as text, so the dialog's name is given to
// its content. When the build lacks them, a fallback that does the same: modal and labelled, focus moved in, kept inside and given back,
// closed on Escape or outside, drawn with the app's theme classes only (layout inline, colors never). A Dialog given its `subject` is
// reported as a Dialog presentation of the window, its purpose its slot (E6.5). NO NODE API.
import { createReport } from './reports.mjs';

// The framework's own Dialogs open in this window (a mod's question waits for none to be open: decision 7), and who wants to know: one
// count per window, shared with the recovery entry (its own module, which counts its confirmations in it too).
const shared = (globalThis[Symbol.for('codexmods.frameworkDialogs')] ??= { open: 0, listeners: new Set() });
const openChanged = (d) => { shared.open += d; for (const f of [...shared.listeners]) { try { f(); } catch { /* a listener's own fault */ } } };
/** How many of the framework's own Dialogs are open in this window. */
export const frameworkDialogsOpen = () => shared.open;
/** `fn()` when one opens or closes; returns the unsubscribe. */
export const onFrameworkDialogs = (fn) => { shared.listeners.add(fn); return () => shared.listeners.delete(fn); };

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** The elements inside a container that take focus, in order. */
export const focusablesOf = (node) => (node && typeof node.querySelectorAll === 'function' ? [...node.querySelectorAll(FOCUSABLE)] : []);

/** Keeps Tab inside a container: from its last focusable to its first, and back with Shift. */
export function trapTab(node, ev) {
  const list = focusablesOf(node);
  if (!list.length) { ev.preventDefault?.(); return; }
  const active = node.ownerDocument?.activeElement ?? null;
  const first = list[0], last = list[list.length - 1];
  const outside = !list.includes(active);
  if (ev.shiftKey && (active === first || outside)) { ev.preventDefault?.(); last.focus?.(); }
  else if (!ev.shiftKey && (active === last || outside)) { ev.preventDefault?.(); first.focus?.(); }
}

/**
 * @param {{ R: object, exports: () => object, ctx?: object }} o  `ctx`: the page runtime's, whose reporter reports each Dialog
 * @returns {{ ModsDialog: Function, Frame: Function }}  `ModsDialog({ title, subtitle?, onClose, footer, children, subject?, purpose? })`: the
 *   framework's own, shown while rendered; `Frame` the same drawing, `own: false` for a mod's question (no framework marker, E7.6c)
 */
export function createDialogs(o) {
  const { R } = o;
  const e = R.createElement;

  /** The markers of a Dialog: the framework's own (its styles protected), or a mod's question. */
  const marks = (own, kind) => (own === false ? { 'data-codexmods-dialog': 'ask' } : { 'data-codexmods-dialog': kind, 'data-codexmods-framework': '' });

  function FallbackDialog({ title, subtitle, onClose, footer, children, own }) {
    const titleId = R.useId();
    const box = R.useRef(null);
    R.useEffect(() => {
      const node = box.current;
      if (!node) return undefined;
      const before = node.ownerDocument?.activeElement ?? null;
      const first = focusablesOf(node)[0] ?? node;
      first.focus?.();
      return () => { if (before && typeof before.focus === 'function' && before.isConnected !== false) before.focus(); };
    }, []);
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault?.(); ev.stopPropagation?.(); onClose(); }
      else if (ev.key === 'Tab') trapTab(box.current, ev);
    };
    return e('div', {
      className: 'codex-dialog-overlay bg-(--color-dialog-overlay)', ...marks(own, 'fallback'),
      style: { position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      onMouseDown: (ev) => { if (ev.target === ev.currentTarget) onClose(); },
    },
    e('div', {
      ref: box, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1, onKeyDown,
      className: 'codex-dialog bg-surface-elevated-secondary text-default shadow-lg ring-border',
      style: { display: 'flex', flexDirection: 'column', gap: 16, padding: 24, borderRadius: 16, width: 'min(520px, 90vw)', maxHeight: '80vh', overflow: 'auto' },
    },
    e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      e('h2', { id: titleId, className: 'heading-dialog font-semibold' }, title),
      subtitle ? e('div', { className: 'text-secondary' }, subtitle) : null),
    e('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, ...[].concat(children ?? [])),
    e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'flex-end' } }, ...footer)));
  }

  function AppDialog({ ex, title, subtitle, onClose, footer = [], children, own }) {
    const parts = ex.DialogParts;
    // What had focus when it opened (read before the dialog moves focus in): the app's dialog gives focus back only to its own trigger,
    // which these dialogs have none of, so it is given back here.
    const [opener] = R.useState(() => globalThis.document?.activeElement ?? null);
    const giveBack = (ev) => { if (opener && opener.isConnected !== false && typeof opener.focus === 'function') { ev?.preventDefault?.(); opener.focus(); } };
    return e(ex.Dialog, {
      open: true, onOpenChange: (open) => { if (!open) onClose(); }, showDialogClose: true, dialogCloseLabel: 'Close',
      contentProps: { 'aria-label': title, 'aria-labelledby': undefined, 'aria-describedby': undefined, ...marks(own, 'app'), onCloseAutoFocus: giveBack },
    },
    // the app's own anatomy: the header, the content and the footer inside the body (which gives them the dialog's padding)
    e(parts.Body, null, e(parts.Header, { title, subtitle }), ...[].concat(children ?? []), e(parts.Footer, null, ...footer)));
  }

  const Report = createReport(R, o.ctx);
  function Frame(props) {
    const ex = o.exports() ?? {};
    const parts = ex.DialogParts;
    return props.plain || typeof ex.Dialog !== 'function' || !parts?.Header || !parts?.Body || !parts?.Footer ? e(FallbackDialog, props) : e(AppDialog, { ...props, ex });
  }
  function ModsDialog(props) {
    R.useEffect(() => { openChanged(1); return () => openChanged(-1); }, []);
    const shown = e(Frame, { ...props, own: true });
    return props.subject ? e(R.Fragment, null, shown, e(Report, { type: 'Dialog', subject: props.subject, place: { in: 'Window', slot: String(props.purpose ?? '') } })) : shown;
  }
  return { ModsDialog, Frame };
}
