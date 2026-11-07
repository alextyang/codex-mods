// The kit (docs/design/framework-ui.md F3): what the framework's pages are built from, and what `ctx.ui.components` gives a mod, so a mod's page is made the way the framework's is.
// Each has props of its own, stable across builds: where the app has the piece (its Menu, its Button) the kit draws through it, and otherwise from its stylesheet in the theme's
// variables. Nothing here reads the graph. NO NODE API.
import { withIntent, useModOf } from '../attest.mjs';
import { GLYPHS, DEFAULT_GLYPH } from './glyphs.mjs';
import { KIT_CSS, KIT_STYLE_ID } from './styles.mjs';

export const KIT_NAMES = Object.freeze(['Badge', 'Banner', 'Checkbox', 'EmptyState', 'Glyph', 'IconTile', 'MenuButton', 'SearchField', 'SegmentedControl', 'Select', 'Tabs']);

const NEXT_KEYS = { ArrowRight: 1, ArrowDown: 1 }, BACK_KEYS = { ArrowLeft: -1, ArrowUp: -1 };
const optionsOf = (list) => (Array.isArray(list) ? list : []).map((o) => (o && typeof o === 'object' ? o : { value: o, label: String(o) }));
const stop = (e) => e?.stopPropagation?.();

/**
 * @param {{ react: () => any, parts: () => { Button?: any, Menu?: any, MenuItem?: any, Separator?: any }, document?: () => any }} o
 *   `parts`: the app's pieces where it has them, else undefined: the kit then draws its own
 */
export function createKit(o) {
  const docOf = () => (o.document ? o.document() : globalThis.document);
  /** Its stylesheet, once per document: what a window's pages and mods share. */
  function ensureStyle() {
    const d = docOf();
    if (!d?.createElement || d.getElementById?.(KIT_STYLE_ID)) return;
    const el = d.createElement('style');
    el.id = KIT_STYLE_ID;
    el.setAttribute('data-codexmods-style', 'kit');
    el.textContent = KIT_CSS;
    (d.head ?? d.documentElement)?.appendChild?.(el);
  }
  const R = () => o.react();
  const h = (...args) => { ensureStyle(); return R().createElement(...args); };

  function Glyph({ name, size = 16, className, spinning }) {
    const g = GLYPHS[name] ?? GLYPHS[DEFAULT_GLYPH];
    return h('svg', { 'aria-hidden': true, focusable: false, width: size, height: size, viewBox: g.viewBox, className: `cmk-glyph${spinning ? ' cmk-spin' : ''}${className ? ` ${className}` : ''}`, 'data-glyph': GLYPHS[name] ? name : DEFAULT_GLYPH, dangerouslySetInnerHTML: { __html: g.markup } });
  }

  function IconTile({ glyph, size = 'md', tone }) {
    return h('span', { className: 'cmk-tile', 'data-size': size, ...(tone ? { 'data-tone': tone } : {}) }, h(Glyph, { name: glyph, size: size === 'sm' ? 16 : 20 }));
  }

  function Badge({ label, tone = 'neutral', glyph, spinning }) {
    return h('span', { className: 'cmk-badge', 'data-tone': tone }, spinning ? h(Glyph, { name: 'spinner', size: 12, spinning: true }) : glyph ? h(Glyph, { name: glyph, size: 12 }) : null, label);
  }

  /** A button: the app's where it has one. `primary` is the page's main action. */
  function Action({ label, onClick, primary, disabled, danger, ariaLabel, glyph }) {
    const B = o.parts()?.Button;
    const content = glyph ? [h(Glyph, { key: 'g', name: glyph }), label] : [label];
    const props = { type: 'button', onClick, disabled: Boolean(disabled), ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) };
    return B ? R().createElement(B, { ...props, color: danger ? 'danger' : primary ? 'primary' : 'secondary' }, ...content) : h('button', { ...props, className: 'cmk-select' }, ...content);
  }

  const TONE_GLYPH = { danger: 'alert', warning: 'shield-alert', success: 'check', info: 'shield-alert', neutral: 'shield-alert' };
  /** The mod's callbacks of its controls, each with the user's intent its input attests (graph-integrity G7.1). */
  const intended = (list, key, mod) => list.map((a) => (a && typeof a[key] === 'function' ? { ...a, [key]: withIntent(a[key], mod) } : a));
  function Banner({ tone = 'neutral', title, message, glyph, actions: actions0 = [], onClose }) {
    const actions = intended(actions0, 'onClick', useModOf(R()));
    return h('aside', { className: 'cmk-banner', 'data-tone': tone, role: tone === 'danger' ? 'alert' : 'status' },
      h('span', { className: 'cmk-banner-icon' }, h(Glyph, { name: glyph ?? TONE_GLYPH[tone] ?? TONE_GLYPH.neutral })),
      h('div', { className: 'cmk-banner-text' }, title ? h('h3', { className: 'cmk-banner-title' }, title) : null, message ? h('div', { className: 'cmk-banner-message' }, message) : null),
      actions.length ? h('div', { className: 'cmk-banner-actions' }, ...actions.map((a, i) => h(Action, { key: a.label ?? i, ...a, primary: i === 0 }))) : null,
      onClose ? h('button', { type: 'button', className: 'cmk-search-clear', 'aria-label': 'Dismiss', onClick: onClose }, h(Glyph, { name: 'close' })) : null);
  }

  function EmptyState({ glyph, tone, title, description, actions: actions0 = [] }) {
    const actions = intended(actions0, 'onClick', useModOf(R()));
    return h('div', { className: 'cmk-empty' },
      h('div', { className: 'cmk-empty-head' }, h(IconTile, { glyph, tone }),
        h('div', { className: 'cmk-empty-text' }, h('h2', { className: 'cmk-empty-title' }, title), description ? h('p', { className: 'cmk-empty-description' }, description) : null)),
      actions.length ? h('div', { className: 'cmk-empty-actions' }, ...actions.map((a, i) => h(Action, { key: a.label ?? i, ...a }))) : null);
  }

  function SearchField({ value = '', onChange, placeholder = 'Search', ariaLabel, style }) {
    return h('div', { className: 'cmk-search', ...(style ? { style } : {}) },
      h('span', { className: 'cmk-search-icon' }, h(Glyph, { name: 'search' })),
      h('input', { className: 'cmk-search-input', type: 'text', value, placeholder, 'aria-label': ariaLabel ?? placeholder, onChange: (e) => onChange?.(e.target.value), onKeyDown: (e) => { if (e.key === 'Escape' && value) { stop(e); onChange?.(''); } } }),
      value ? h('button', { type: 'button', className: 'cmk-search-clear', 'aria-label': `Clear ${(ariaLabel ?? placeholder).toLowerCase()}`, onClick: () => onChange?.('') }, h(Glyph, { name: 'close', size: 14 })) : null);
  }

  function SegmentedControl({ options, value, onChange: change0, ariaLabel, disabled }) {
    const onChange = withIntent(change0, useModOf(R()));
    return h('div', { className: 'cmk-segmented', role: 'group', 'aria-label': ariaLabel },
      ...optionsOf(options).map((x) => h('button', { key: String(x.value), type: 'button', className: 'cmk-segment', 'aria-pressed': x.value === value, disabled: Boolean(disabled || x.disabled), onClick: () => onChange?.(x.value) }, x.label ?? String(x.value))));
  }

  function Tabs({ items, value, onChange: change0, ariaLabel }) {
    const onChange = withIntent(change0, useModOf(R()));
    const list = optionsOf(items);
    const move = (e, i) => {
      const dir = NEXT_KEYS[e.key] ?? BACK_KEYS[e.key];
      if (!dir || !list.length) return;
      e.preventDefault?.();
      const next = list[(i + dir + list.length) % list.length];
      onChange?.(next.value);
      e.currentTarget?.parentNode?.querySelectorAll?.('[role="tab"]')?.[(i + dir + list.length) % list.length]?.focus?.();
    };
    return h('div', { className: 'cmk-tabs', role: 'tablist', 'aria-label': ariaLabel },
      ...list.map((t, i) => h('button', { key: String(t.value), type: 'button', role: 'tab', className: 'cmk-tab', 'aria-selected': t.value === value, tabIndex: t.value === value ? 0 : -1, onClick: () => onChange?.(t.value), onKeyDown: (e) => move(e, i) },
        t.icon ? h(Glyph, { name: t.icon }) : null, t.label ?? String(t.value),
        t.count !== undefined && t.count !== null && t.count !== '' ? h('span', { className: 'cmk-tab-count' }, t.count) : null,
        t.dot ? h('span', { className: 'cmk-tab-dot', role: 'img', 'aria-label': typeof t.dot === 'string' ? t.dot : 'Needs attention' }) : null)));
  }

  function Checkbox({ checked, onChange: change0, ariaLabel, disabled }) {
    const onChange = withIntent(change0, useModOf(R()));
    return h('button', { type: 'button', role: 'checkbox', className: 'cmk-check', 'aria-checked': Boolean(checked), 'aria-label': ariaLabel, disabled: Boolean(disabled), onClick: (e) => { stop(e); onChange?.(!checked); } }, checked ? h(Glyph, { name: 'check', size: 12 }) : null);
  }

  /** A menu from a trigger: the app's, with its focus and keyboard behaviour, else a plain list. */
  function MenuOf({ trigger, items, disabled }) {
    const r = R();
    const [open, setOpen] = r.useState(false);
    const { Menu, MenuItem, Separator } = o.parts() ?? {};
    const pick = (x) => (e) => { stop(e); setOpen(false); x.onSelect?.(); };
    const content = (x, i) => {
      if (x.separator) return Separator ? r.createElement(Separator, { key: `rule-${i}` }) : h('div', { key: `rule-${i}`, className: 'cmk-menu-rule', role: 'separator' });
      const label = h('span', { className: 'cmk-item', ...(x.danger ? { 'data-danger': '' } : {}) }, x.icon ? h(Glyph, { name: x.icon }) : null, x.label);
      return MenuItem ? r.createElement(MenuItem, { key: x.key ?? x.label, disabled: Boolean(x.disabled), onClick: pick(x) }, label)
        : h('button', { key: x.key ?? x.label, type: 'button', role: 'menuitem', disabled: Boolean(x.disabled), className: 'cmk-more', onClick: pick(x) }, label);
    };
    if (Menu) return r.createElement(Menu, { open, onOpenChange: setOpen, disabled: Boolean(disabled), triggerButton: trigger({}) }, ...items.map(content));
    return h('span', { style: { position: 'relative', display: 'inline-flex' } }, trigger({ onClick: (e) => { stop(e); setOpen(!open); }, 'aria-expanded': open }),
      open ? h('div', { role: 'menu', style: { position: 'absolute', top: '100%', insetInlineEnd: 0, zIndex: 1, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' } }, ...items.map(content)) : null);
  }

  function MenuButton({ items: items0 = [], ariaLabel, label, icon = 'more', disabled }) {
    const items = intended(items0, 'onSelect', useModOf(R()));
    const trigger = (extra) => h('button', { type: 'button', className: 'cmk-more', 'aria-label': ariaLabel ?? label, 'aria-haspopup': 'menu', disabled: Boolean(disabled), ...extra }, icon ? h(Glyph, { name: icon }) : null, label ?? null);
    return h('span', { onClick: stop, style: { display: 'inline-flex' } }, h(MenuOf, { trigger, items, disabled }));
  }

  function Select({ value, options, onChange: change0, ariaLabel, disabled }) {
    const onChange = withIntent(change0, useModOf(R()));
    const list = optionsOf(options);
    const current = list.find((x) => x.value === value);
    const trigger = (extra) => h('button', { type: 'button', className: 'cmk-select', 'aria-label': ariaLabel, 'aria-haspopup': 'menu', disabled: Boolean(disabled), ...extra },
      h('span', { className: 'cmk-select-value' }, current?.label ?? String(value ?? '')), h('span', { className: 'cmk-select-chevron' }, h(Glyph, { name: 'chevron-down', size: 12 })));
    const items = list.map((x) => ({ key: String(x.value), label: x.label ?? String(x.value), icon: x.value === value ? 'check' : undefined, disabled: x.disabled, onSelect: () => { if (x.value !== value) onChange?.(x.value); } }));
    return h(MenuOf, { trigger, items, disabled });
  }

  return { Badge, Banner, Checkbox, EmptyState, Glyph, IconTile, MenuButton, SearchField, SegmentedControl, Select, Tabs, Action, ensureStyle };
}
