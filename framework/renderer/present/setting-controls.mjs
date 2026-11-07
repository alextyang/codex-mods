// The controls of a setting's row (docs/design/framework-ui.md F7; design-spec §3.1): one for what each kind of value is and how it is drawn, each writing a value of its kind and never
// per keystroke. A text commits on Enter or when it loses focus and keeps the user's draft while the value changes elsewhere; one that cannot be read goes back to the value, or says why
// where the row has room. Theme variables only (kit/styles.mjs). NO NODE API.

/** A shortcut's parts in the order they read, each with what it shows as. */
const MODIFIERS = Object.freeze([['Ctrl', '⌃', 'ctrlKey'], ['Alt', '⌥', 'altKey'], ['Shift', '⇧', 'shiftKey'], ['Cmd', '⌘', 'metaKey']]);
const KEY_NAMES = Object.freeze({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Backspace: '⌫', Delete: '⌦', Tab: '⇥', ' ': 'Space' });
const NOT_A_KEY = new Set(['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Fn', 'Dead', 'Unidentified']);
const ACCELERATOR_NAMES = Object.freeze({ ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', ' ': 'Space' });

/** What a key press makes as a shortcut (an accelerator, `Alt+Cmd+P`): null for a modifier alone, or a key with no modifier that is not a function key. */
export function shortcutOf(ev) {
  if (NOT_A_KEY.has(ev.key)) return null;
  const mods = MODIFIERS.filter(([, , flag]) => ev[flag]).map(([name]) => name);
  const fn = /^F([1-9]|1\d|2[0-4])$/.test(ev.key);
  if (!mods.length && !fn) return null;
  const key = ACCELERATOR_NAMES[ev.key] ?? (ev.key.length === 1 ? ev.key.toUpperCase() : ev.key);
  return [...mods, key].join('+');
}
/** An accelerator as it reads: `Alt+Cmd+P` as ⌥⌘P. */
export function shortcutShown(value) {
  if (typeof value !== 'string' || !value) return 'None';
  const parts = value.split('+');
  const key = parts.pop();
  const shownKey = Object.entries(ACCELERATOR_NAMES).find(([, name]) => name === key)?.[0];
  const mods = MODIFIERS.filter(([name]) => parts.includes(name)).map(([, glyph]) => glyph).join('');
  return mods + (shownKey ? KEY_NAMES[shownKey] : key);
}

/** A time as `HH:MM` from what was typed (`9:30`, `0930`), or null. */
export function timeFrom(text) {
  const m = /^([01]?\d|2[0-3]):?([0-5]\d)$/.exec(String(text).trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
/** A color as `#RRGGBB` from what was typed, or null. */
export function colorFrom(text) {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(String(text).trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}
/** A number as a stepper keeps it: within its bounds, on a multiple of its step. */
export function clampNumber(n, { min, max, step } = {}) {
  let v = n;
  if (step) v = Number((Math.round(v / step) * step).toFixed(10));
  if (Number.isFinite(min) && v < min) v = min;
  if (Number.isFinite(max) && v > max) v = max;
  return v;
}
const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
/** Does this list's value draw as rows of text: its items are strings, and its declaration does not say they are more. */
export const listAsRows = (s) => isStringList(s.value) && s.structured !== true;

/**
 * @param {{ R: object, kit: object, exports: () => object, useImage: (mod: object, id: string) => string | null }} o  `useImage`: mod-media.mjs'
 */
/** A label inside a sentence ("Reset model"): its first letter lowered, unless it starts an acronym ("QA budget"). */
export const lowerFirst = (t) => (typeof t === 'string' && /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
/** A choice's value: its `value`, else its id (graph Setting card). */
export const choiceValue = (c) => (c && Object.hasOwn(c, 'value') ? c.value : c?.id);

export function createSettingControls(o) {
  const { R, kit } = o;
  const e = R.createElement;

  /** A field that writes on Enter or when it loses focus; Escape, or what `read` refuses, goes back to the value. */
  function TextInput({ value, read = (t) => t, write, disabled, label, placeholder, className = 'cmk-input', style, multiline, secret = false }) {
    const [draft, setDraft] = R.useState(null);
    const commit = () => {
      if (draft === null) return;
      const next = read(draft);
      setDraft(null);
      if (next !== null && next !== undefined && next !== value) write(next);
    };
    return e(multiline ? 'textarea' : 'input', {
      className, ...(style ? { style } : {}), value: draft ?? String(value ?? ''), disabled: Boolean(disabled), 'aria-label': label, ...(placeholder ? { placeholder } : {}),
      ...(multiline ? { rows: 3 } : secret ? { type: 'password', autoComplete: 'off', spellCheck: false } : { type: 'text' }),
      onChange: (ev) => setDraft(ev.target.value), onBlur: commit,
      onKeyDown: (ev) => {
        if (ev.key === 'Escape') { setDraft(null); ev.stopPropagation?.(); } else if (ev.key === 'Enter' && !multiline) { ev.preventDefault?.(); commit(); }
      },
    });
  }

  function Stepper({ s, label, disabled, write }) {
    const value = typeof s.value === 'number' ? s.value : 0;
    const step = s.step ?? 1;
    const lower = lowerFirst(label);
    const nudge = (by) => write(clampNumber(value + by * step, s));
    return e('span', { className: 'cmk-stepper', onKeyDown: (ev) => { if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') { ev.preventDefault?.(); if (!disabled) nudge(ev.key === 'ArrowUp' ? 1 : -1); } } },
      e('button', { type: 'button', className: 'cmk-stepper-button', 'aria-label': `Decrease ${lower}`, disabled: Boolean(disabled) || (Number.isFinite(s.min) && value <= s.min), onClick: () => nudge(-1) }, '−'),
      e('span', { className: 'cmk-stepper-value' }, e(TextInput, { value: String(value), className: 'cmk-stepper-input', label, disabled, read: (t) => { const n = Number(t); return t.trim() !== '' && Number.isFinite(n) ? String(clampNumber(n, s)) : null; }, write: (t) => write(Number(t)) }),
        s.unit ? e('span', { className: 'cmk-stepper-unit' }, s.unit) : null),
      e('button', { type: 'button', className: 'cmk-stepper-button', 'aria-label': `Increase ${lower}`, disabled: Boolean(disabled) || (Number.isFinite(s.max) && value >= s.max), onClick: () => nudge(1) }, '+'));
  }

  function Slider({ s, label, disabled, write }) {
    const [draft, setDraft] = R.useState(null);
    const value = draft ?? (typeof s.value === 'number' ? s.value : 0);
    const commit = () => { if (draft !== null) { setDraft(null); if (draft !== s.value) write(draft); } };
    const min = s.min ?? 0, max = s.max ?? 100;
    return e('span', { className: 'cmk-slider' },
      e('input', { type: 'range', 'aria-label': label, min, max, step: s.step ?? 1, value, disabled: Boolean(disabled), style: { '--cmk-fill': `${max > min ? ((value - min) / (max - min)) * 100 : 0}%` }, onChange: (ev) => setDraft(Number(ev.target.value)), onPointerUp: commit, onKeyUp: commit, onBlur: commit }),
      e('span', { className: 'cmk-slider-value' }, `${value}${s.unit ?? ''}`));
  }

  function Recorder({ s, label, disabled, write }) {
    const [recording, setRecording] = R.useState(false);
    const lower = lowerFirst(label);
    return e('span', { className: 'cmk-shortcut' },
      e('kbd', { className: 'cmk-shortcut-chip', ...(recording ? { 'data-recording': '' } : {}) }, recording ? 'Press keys' : shortcutShown(s.value)),
      e('button', {
        type: 'button', className: 'cmk-more', disabled: Boolean(disabled), 'aria-label': recording ? `Cancel changing ${lower}` : `Change ${lower}`, onClick: () => setRecording(!recording), onBlur: () => setRecording(false),
        onKeyDown: (ev) => {
          if (!recording) return;
          ev.preventDefault?.(); ev.stopPropagation?.();
          if (ev.key === 'Escape') { setRecording(false); return; }
          const made = shortcutOf(ev);
          if (made) { setRecording(false); write(made); }
        },
      }, e(kit.Glyph, { name: recording ? 'close' : 'compose' })));
  }

  function ColorField({ s, label, disabled, write }) {
    const value = typeof s.value === 'string' ? s.value : '#000000';
    return e('span', { className: 'cmk-color' },
      e('span', { className: 'cmk-color-swatch', style: { background: value } }, e('input', { type: 'color', 'aria-label': `${label}: pick`, value: value.toLowerCase(), disabled: Boolean(disabled), onChange: (ev) => write(ev.target.value.toUpperCase()) })),
      e(TextInput, { value, read: colorFrom, write, disabled, label, className: 'cmk-color-input' }));
  }

  function TimeRange({ s, label, disabled, write }) {
    const v = s.value && typeof s.value === 'object' ? s.value : { from: '00:00', to: '00:00' };
    return e('span', { className: 'cmk-times' },
      e(TextInput, { value: v.from, read: timeFrom, write: (from) => write({ ...v, from }), disabled, label: `${label} start`, className: 'cmk-time-input' }), '–',
      e(TextInput, { value: v.to, read: timeFrom, write: (to) => write({ ...v, to }), disabled, label: `${label} end`, className: 'cmk-time-input' }));
  }

  /** A choice's thumbnails, each its image or a frame (the graph's `media` asked for when shown). */
  function Thumb({ c, mod, selected, disabled, onPick }) {
    const url = o.useImage(mod, c.media?.id);
    return e('button', { type: 'button', role: 'radio', 'aria-checked': selected, className: 'cmk-thumb', disabled: Boolean(disabled), onClick: onPick },
      e('span', { className: 'cmk-thumb-frame' }, url ? e('img', { src: url, alt: '' }) : e(kit.Glyph, { name: 'image' })), e('span', { className: 'cmk-thumb-label' }, c.label));
  }

  /** A list of strings: a row per item, reordered by its handle (dragged, or with the arrow keys), and a last row that adds one. The handle moves it, so its text can still be selected. */
  function ListRows({ s, label, disabled, write }) {
    const list = s.value ?? [];
    const [adding, setAdding] = R.useState('');
    const [drag, setDrag] = R.useState(null);   // { from, to }: the row picked up, and where it would land
    const add = () => { const t = adding.trim(); if (!t) return; setAdding(''); write([...list, t]); };
    const move = (from, to) => { if (from === to || to < 0 || to >= list.length) return; const next = [...list]; const [x] = next.splice(from, 1); next.splice(to, 0, x); write(next); };
    /** The row a pointer is over, among the rows of the list this handle is in. */
    const rowAt = (ev) => {
      const rows = [...(ev.currentTarget?.closest?.('.cmk-list-rows')?.querySelectorAll?.('[role="listitem"]') ?? [])];
      const i = rows.findIndex((r) => ev.clientY < r.getBoundingClientRect().bottom);
      return i < 0 ? rows.length - 1 : i;
    };
    const handle = (item, i) => e('button', {
      type: 'button', className: 'cmk-list-handle', title: 'Drag to reorder', 'aria-label': `Move “${item}”`, disabled: Boolean(disabled),
      onPointerDown: (ev) => { ev.currentTarget?.setPointerCapture?.(ev.pointerId); setDrag({ from: i, to: i }); },
      onPointerMove: (ev) => { if (drag) setDrag({ from: drag.from, to: rowAt(ev) }); },
      onPointerUp: () => { if (drag) { setDrag(null); move(drag.from, drag.to); } },
      onPointerCancel: () => setDrag(null),
      onKeyDown: (ev) => { const by = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0; if (by) { ev.preventDefault?.(); move(i, i + by); } },
    }, e(kit.Glyph, { name: 'more' }));
    return e('div', { className: 'cmk-list-rows', role: 'list', 'aria-label': label },
      ...list.map((item, i) => e('div', { key: `${i}:${item}`, role: 'listitem', className: 'cmk-list-row', ...(drag?.from === i ? { 'data-dragging': '' } : {}), ...(drag && drag.to === i && drag.from !== i ? { 'data-drop': drag.to < drag.from ? 'before' : 'after' } : {}) },
        handle(item, i),
        e(TextInput, { value: item, className: 'cmk-list-input', label: `${label} ${i + 1}`, disabled, read: (t) => t.trim() || null, write: (t) => write(list.map((x, j) => (j === i ? t : x))) }),
        e('button', { type: 'button', className: 'cmk-more', disabled: Boolean(disabled), 'aria-label': `Remove “${item}”`, onClick: () => write(list.filter((_, j) => j !== i)) }, e(kit.Glyph, { name: 'close' })))),
      e('div', { key: 'add', className: 'cmk-list-row' }, e('span', { className: 'cmk-list-add' }, e(kit.Glyph, { name: 'plus' })),
        e('input', { className: 'cmk-list-input', type: 'text', value: adding, disabled: Boolean(disabled), 'aria-label': `Add to ${label}`, ...(s.placeholder ? { placeholder: s.placeholder } : {}), onChange: (ev) => setAdding(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault?.(); add(); } } }),
        adding.trim() ? e(kit.Action, { label: 'Add', onClick: add, disabled }) : null));
  }

  /** A structured value as JSON, which says when it cannot be read. */
  function JsonField({ s, label, disabled, write, onError }) {
    return e(TextInput, { value: JSON.stringify(s.value ?? null, null, 2), multiline: true, className: 'cmk-area', label, disabled, write: (t) => write(JSON.parse(t)),
      read: (t) => { try { JSON.parse(t); onError(null); return t; } catch { onError('Enter valid JSON'); return null; } } });
  }

  /** Whether a setting's control goes under its label, with the room it needs. */
  const stacked = (s) => s.kind === 'list' || s.kind === 'record' || s.control === 'area' || s.control === 'thumbnails';

  /**
   * One setting's control.
   * @param {{ s: object, label: string, disabled: boolean, write: (value: unknown) => void, onError: (message: string | null) => void }} p  `s`: the Setting's state
   */
  /** `definedBy`: what defines the setting (its links' `definedBy`: a mod's thumbnails are its package's images). */
  function control({ s, label, disabled, write, onError, definedBy = null }) {
    const ex = o.exports() ?? {};
    const p = { s, label, disabled, write, onError };
    switch (s.kind) {
      case 'toggle':
        return ex.Switch ? e(ex.Switch, { checked: s.value === true, disabled: Boolean(disabled), ariaLabel: label, 'aria-label': label, onChange: (v) => write(typeof v === 'boolean' ? v : Boolean(v?.target?.checked)) }) : null;
      case 'choice': {
        // a choice's value is its `value`, or its id when it has none (graph Setting card): matched and written by value
        const choices = s.choices ?? [];
        const options = choices.map((c) => ({ value: c.id, label: c.label }));
        const pick = (id) => { const c = choices.find((x) => x.id === id); if (c) write(choiceValue(c)); };
        const current = choices.find((c) => JSON.stringify(choiceValue(c)) === JSON.stringify(s.value))?.id ?? null;
        if (s.control === 'segmented') return e(kit.SegmentedControl, { options, value: current, onChange: pick, ariaLabel: label, disabled });
        if (s.control === 'thumbnails') return e('div', { role: 'radiogroup', 'aria-label': label, className: 'cmk-thumbs' }, ...(s.choices ?? []).map((c) => e(Thumb, { key: c.id, c, mod: definedBy, selected: c.id === current, disabled, onPick: () => pick(c.id) })));
        return e(kit.Select, { options, value: current, onChange: pick, ariaLabel: label, disabled });
      }
      case 'number': return s.control === 'slider' ? e(Slider, p) : e(Stepper, p);
      case 'shortcut': return e(Recorder, p);
      case 'color': return e(ColorField, p);
      case 'time': return e(TextInput, { value: s.value, read: timeFrom, write, disabled, label, className: 'cmk-time-input cmk-time-single' });
      case 'timerange': return e(TimeRange, p);
      case 'list': return listAsRows(s) ? e(ListRows, p) : e(JsonField, p);
      case 'record': return e(JsonField, p);
      // a secret (a question's only: ui.ask) is masked and never kept
      default: return e(TextInput, { value: s.value ?? '', write, disabled, label, placeholder: s.placeholder, multiline: s.control === 'area', secret: s.control === 'secret', className: s.control === 'area' ? 'cmk-area' : 'cmk-input' });
    }
  }
  return { control, stacked, TextInput };
}
