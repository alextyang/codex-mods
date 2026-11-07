// Themed fallback primitives for the ten ComponentNames (ARCHITECTURE §9.2). Used when the adapter cannot expose a real
// app component on a build, and as the safe re-render if a real component throws outside the app's provider tree.
// Styled only with the app's own theme custom properties (the adapter's `theme` map); no external CSS. Every color, font and corner
// is the theme's (docs/design/presentations.md V9): a token the build's map lacks leaves the property at its own default (the
// variable is undefined), never at a literal. They mimic the shape of the app's components (same prop names; compound parts as static
// members) so a mod need not know which it got.

/** @param {unknown} React  the app's React  @param {Record<string,string>} themeMap token → CSS custom property */
export function createFallbacks(React, themeMap = {}) {
  const h = React.createElement;
  const v = (token) => `var(${themeMap[token] ?? `--color-${token}`})`;
  const S = {
    text: v('text'), muted: v('textSecondary'), border: v('border'), surface: v('surface'), bg: v('background'), accent: v('accent'),
    danger: v('danger'), onAccent: v('onAccent'), scrim: v('scrim'), radius: v('radius'), font: v('fontFamily'),
  };
  const base = { fontFamily: S.font, color: S.text, boxSizing: 'border-box' };
  const cx = (...xs) => xs.filter(Boolean).join(' ');

  function Button({ children, onClick, disabled, type = 'button', variant = 'solid', color = 'primary', className, style, ...rest }) {
    const solid = variant === 'solid';
    return h('button', {
      type, disabled, onClick, className: cx('codexmods-button', className), 'data-fallback': 'Button',
      style: { ...base, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, padding: '4px 12px', borderRadius: S.radius, font: 'inherit',
        border: `1px solid ${color === 'danger' ? S.danger : S.border}`, background: solid ? (color === 'danger' ? S.danger : S.accent) : 'transparent', color: solid ? S.onAccent : S.text, ...style },
      ...rest,
    }, children);
  }

  function Switch({ checked, onChange, disabled, ariaLabel, id, className, ...rest }) {
    return h('button', {
      type: 'button', role: 'switch', 'aria-checked': !!checked, 'aria-label': ariaLabel, id, disabled, 'data-fallback': 'Switch', className,
      onClick: (e) => { if (!disabled && !e?.defaultPrevented) onChange?.(!checked); },
      style: { width: 36, height: 20, borderRadius: 10, border: `1px solid ${S.border}`, background: checked ? S.accent : 'transparent', position: 'relative', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 },
      ...rest,
    }, h('span', { 'aria-hidden': true, style: { position: 'absolute', top: 2, left: checked ? 18 : 2, width: 14, height: 14, borderRadius: 7, background: checked ? S.onAccent : S.muted } }));
  }

  function TextField({ value, onChange, placeholder, type = 'text', disabled, className, style, ...rest }) {
    return h('input', { type, value, onChange, placeholder, disabled, className, 'data-fallback': 'TextField',
      style: { ...base, padding: '4px 8px', borderRadius: S.radius, border: `1px solid ${S.border}`, background: 'transparent', font: 'inherit', ...style }, ...rest });
  }

  function Menu({ triggerButton, children, open: openProp, onOpenChange, disabled }) {
    const [openState, setOpen] = React.useState(false);
    const open = openProp ?? openState;
    const set = (next) => { setOpen(next); onOpenChange?.(next); };
    return h('span', { 'data-fallback': 'Menu', style: { position: 'relative', display: 'inline-block' } },
      h('span', { onClick: () => { if (!disabled) set(!open); } }, triggerButton),
      open ? h('div', { role: 'menu', style: { ...base, position: 'absolute', zIndex: 2147483000, minWidth: 160, padding: 4, marginTop: 4, borderRadius: S.radius, border: `1px solid ${S.border}`, background: S.surface },
        onClick: () => set(false) }, children) : null);
  }
  Menu.Item = function MenuItem({ children, onSelect, disabled, leftIcon }) {
    return h('div', { role: 'menuitem', 'aria-disabled': !!disabled, tabIndex: disabled ? -1 : 0, onClick: () => { if (!disabled) onSelect?.(); },
      style: { padding: '4px 8px', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, display: 'flex', gap: 6 } }, leftIcon ?? null, children);
  };
  Menu.Separator = function MenuSeparator() { return h('div', { role: 'separator', style: { height: 1, background: S.border, margin: '4px 0' } }); };

  function Dialog({ open, onOpenChange, children, triggerContent, className }) {
    return h(React.Fragment, null, triggerContent ? h('span', { onClick: () => onOpenChange?.(true) }, triggerContent) : null,
      open ? h('div', { 'data-fallback': 'Dialog', role: 'presentation', style: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: S.scrim },
        onClick: (e) => { if (e?.target === e?.currentTarget) onOpenChange?.(false); } },
        h('div', { role: 'dialog', 'aria-modal': true, className, style: { ...base, minWidth: 320, maxWidth: '80vw', maxHeight: '80vh', overflow: 'auto', padding: 16, borderRadius: S.radius, border: `1px solid ${S.border}`, background: S.surface } }, children)) : null);
  }
  Dialog.Header = function DialogHeader({ title, subtitle, icon }) {
    return h('div', { style: { marginBottom: 8 } }, icon ?? null, h('div', { style: { fontWeight: 600, fontSize: 16 } }, title), subtitle ? h('div', { style: { color: S.muted } }, subtitle) : null);
  };
  Dialog.Body = function DialogBody({ children }) { return h('div', { style: { marginBottom: 12 } }, children); };
  Dialog.Footer = function DialogFooter({ children }) { return h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, children); };

  function SettingsSection({ children, id, className }) { return h('section', { id, className, 'data-fallback': 'SettingsSection', style: { ...base, display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 } }, children); }
  SettingsSection.Header = function SettingsSectionHeader({ title, subtitle, actions }) {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' } },
      h('div', null, h('div', { style: { fontWeight: 600 } }, title), subtitle ? h('div', { style: { color: S.muted, fontSize: 12 } }, subtitle) : null), actions ?? null);
  };
  SettingsSection.Content = function SettingsSectionContent({ children }) { return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, children); };
  SettingsSection.Footer = function SettingsSectionFooter({ children }) { return h('div', { style: { color: S.muted, fontSize: 12 } }, children); };

  // the app's grouped rows: one rounded, bordered card, rows divided by hairlines
  function SettingsCard({ children }) {
    return h('div', { 'data-fallback': 'SettingsCard', style: { ...base, display: 'flex', flexDirection: 'column', border: `1px solid ${S.border}`, borderRadius: S.radius, overflow: 'hidden' } }, children);
  }
  function SettingsRow({ label, description, control, icon, className, id }) {
    const ctl = typeof control === 'function' ? control({ labelId: undefined, descriptionId: undefined }) : control;
    return h('div', { id, className, 'data-fallback': 'SettingsRow', style: { ...base, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', justifyContent: 'space-between' } },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 } }, icon ?? null, h('div', null, label != null ? h('div', null, label) : null, description != null ? h('div', { style: { color: S.muted, fontSize: 12 } }, description) : null)),
      ctl ?? null);
  }

  function Tooltip({ tooltipContent, children, disabled }) {
    const text = typeof tooltipContent === 'string' ? tooltipContent : undefined;
    if (disabled || tooltipContent == null) return h(React.Fragment, null, children);
    return h('span', { title: text, 'data-fallback': 'Tooltip' }, children);
  }

  function Icon({ icon, name, size, className }) {
    const label = name ?? (typeof icon === 'string' ? icon : '');
    return h('span', { 'aria-hidden': true, className, 'data-fallback': 'Icon', style: { display: 'inline-block', width: '1em', height: '1em', lineHeight: '1em', textAlign: 'center', fontSize: size === 'inline' ? 20 : 16 } }, label ? label.slice(0, 1) : '•');
  }

  return { Button, Switch, TextField, Menu, Dialog, SettingsSection, SettingsCard, SettingsRow, Tooltip, Icon };
}
