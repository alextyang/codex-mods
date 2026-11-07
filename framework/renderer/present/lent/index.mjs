// The parts the framework lends (graph-integrity G2.3): the app's conversation pieces as kit components with stable props, fed by a mod's
// own data, so an agent mod draws its own view of its own chats the way the app draws Codex's. Each is drawn through the app's own piece
// where the adapter exposes one (its composer dropdown and menu parts for the pickers) and otherwise from this stylesheet, in the theme's
// variables only. Actions call back into the mod; nothing here reads the graph or interprets a provider's conversation. NO NODE API.
import { withIntent, useModOf } from '../attest.mjs';
import { LENT_CSS, LENT_STYLE_ID } from './styles.mjs';

export const LENT_NAMES = Object.freeze(['Transcript', 'Turn', 'Message', 'StepRow', 'DiffView', 'FileChip', 'ApprovalCard', 'QuestionCard',
  'ThreadHeader', 'Composer', 'ModelPicker', 'EffortPicker', 'ChatRow', 'DropTarget']);

/** A time as the app's rows say it: now, minutes, hours, days, then a date. */
export function ago(t, now = Date.now()) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A Content's text (`{parts}`), or a string as it is. */
const textOf = (c) => (typeof c === 'string' ? c : isObj(c) && Array.isArray(c.parts) ? c.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const baseName = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? String(p ?? '');

/**
 * @param {{ react: () => any, exports: () => object, kit: object, document?: () => any, drops?: () => object | null }} o  `exports`: the app's
 *   pieces the adapter exposes; `drops`: the page's places that take drops and its rows' drags (present/drops.mjs), once it runs
 */
export function createLentParts(o) {
  const docOf = () => (o.document ? o.document() : globalThis.document);
  function ensureStyle() {
    o.kit?.ensureStyle?.();
    const d = docOf();
    if (!d?.createElement || d.getElementById?.(LENT_STYLE_ID)) return;
    const el = d.createElement('style');
    el.id = LENT_STYLE_ID;
    el.setAttribute('data-codexmods-style', 'lent');
    el.textContent = LENT_CSS;
    (d.head ?? d.documentElement)?.appendChild?.(el);
  }
  const R = () => o.react();
  /** The mod whose content a part is drawn in (its boundary names it), for the user's intent its controls attest (graph-integrity G7.1). */
  const useMod = () => useModOf(R());
  const h = (...args) => { ensureStyle(); return R().createElement(...args); };
  const ex = () => o.exports?.() ?? {};

  // ---------------------------------------------------------------- markdown: blocks and inline marks, built as elements (never HTML)
  function inline(text, key) {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
    let at = 0, m, i = 0;
    while ((m = re.exec(text))) {
      if (m.index > at) out.push(text.slice(at, m.index));
      const s = m[0];
      if (s.startsWith('`')) out.push(h('code', { key: `${key}-${i++}`, className: 'cml-code' }, s.slice(1, -1)));
      else if (s.startsWith('**')) out.push(h('strong', { key: `${key}-${i++}` }, s.slice(2, -2)));
      else if (s.startsWith('*')) out.push(h('em', { key: `${key}-${i++}` }, s.slice(1, -1)));
      else out.push(h('a', { key: `${key}-${i++}`, href: m[2], target: '_blank', rel: 'noreferrer' }, s.slice(1, s.indexOf(']'))));
      at = m.index + s.length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  function markdown(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (line.startsWith('```')) {
        const body = [];
        for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
        i++;
        blocks.push(h('pre', { key: `b${blocks.length}`, className: 'cml-pre' }, h('code', null, body.join('\n'))));
      } else if (/^\s*[-*] /.test(line)) {
        const items = [];
        for (; i < lines.length && /^\s*[-*] /.test(lines[i]); i++) items.push(h('li', { key: `i${items.length}` }, inline(lines[i].replace(/^\s*[-*] /, ''), `l${blocks.length}-${items.length}`)));
        blocks.push(h('ul', { key: `b${blocks.length}` }, ...items));
      } else if (/^#{1,3} /.test(line)) {
        blocks.push(h('p', { key: `b${blocks.length}`, className: 'cml-heading' }, inline(line.replace(/^#{1,3} /, ''), `h${blocks.length}`)));
        i++;
      } else if (!line.trim()) i++;
      else {
        const para = [];
        for (; i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^\s*[-*] /.test(lines[i]); i++) para.push(lines[i]);
        blocks.push(h('p', { key: `b${blocks.length}` }, inline(para.join(' '), `p${blocks.length}`)));
      }
    }
    return blocks;
  }

  // ---------------------------------------------------------------- the conversation
  /** The transcript's scroller: what is in it, keeping to its end while it is there. */
  function Transcript({ children, ariaLabel = 'Conversation' }) {
    const r = R();
    const ref = r.useRef(null);
    const stuck = r.useRef(true);
    r.useLayoutEffect(() => { const el = ref.current; if (el && stuck.current) el.scrollTop = el.scrollHeight; });
    const onScroll = () => { const el = ref.current; if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
    return h('div', { ref, className: 'cml-transcript', role: 'log', 'aria-label': ariaLabel, onScroll }, h('div', { className: 'cml-column' }, children));
  }
  /** A turn: what was said and done in it, and while it runs, that it is working. */
  function Turn({ status, children }) {
    return h('section', { className: 'cml-turn', 'data-status': status ?? 'completed' }, children,
      status === 'running' ? h('div', { className: 'cml-working', role: 'status' }, o.kit.Glyph ? h(o.kit.Glyph, { name: 'spinner', size: 12, spinning: true }) : null, 'Working') : null);
  }
  /** A message: the user's, as the app shows a sent one; the agent's, its text as markdown. `content`: a Content or a string. */
  function Message({ role = 'agent', content, text, streaming = false }) {
    const body = textOf(content ?? text ?? '');
    if (role === 'user') return h('div', { className: 'cml-message', 'data-role': 'user' }, h('div', { className: 'cml-bubble' }, body));
    return h('div', { className: 'cml-message', 'data-role': 'agent', ...(streaming ? { 'aria-busy': true } : {}) }, ...markdown(body));
  }
  /** A step: its kind's glyph, its title and status; expanded, its detail, a command's output or an edit's diff. */
  function StepRow({ kind = 'other', title, status = 'completed', detail, output, diff, expanded, onToggle }) {
    const r = R();
    const [open, setOpen] = r.useState(expanded === true);
    const shown = expanded ?? open;
    const toggle = () => { if (onToggle) onToggle(!shown); else setOpen(!shown); };
    const glyph = { command: 'terminal', edit: 'file', tool: 'tool', search: 'search', web: 'globe', reasoning: 'sparkle' }[kind] ?? 'dot';
    const has = output !== undefined || diff !== undefined || detail !== undefined;
    return h('div', { className: 'cml-step', 'data-kind': kind, 'data-status': status },
      h('button', { type: 'button', className: 'cml-step-head', 'aria-expanded': has ? shown : undefined, disabled: !has, onClick: has ? toggle : undefined },
        o.kit.Glyph ? h(o.kit.Glyph, { name: status === 'running' ? 'spinner' : glyph, size: 14, spinning: status === 'running' }) : null,
        h('span', { className: 'cml-step-title' }, String(title ?? kind)),
        status === 'failed' ? h('span', { className: 'cml-step-failed' }, 'Failed') : null),
      shown && has ? h('div', { className: 'cml-step-body' },
        detail !== undefined ? h('div', { className: 'cml-step-detail' }, textOf(detail)) : null,
        output !== undefined ? h('pre', { className: 'cml-pre' }, h('code', null, String(output))) : null,
        diff !== undefined ? h(DiffView, { diff }) : null) : null);
  }
  /** A diff, as a unified patch (or `files: [{path, diff}]`): its files' names, each line marked added or removed. */
  function DiffView({ diff, files }) {
    const list = Array.isArray(files) ? files : [{ path: null, diff }];
    return h('div', { className: 'cml-diff' }, ...list.map((f, n) => h('div', { key: `f${n}`, className: 'cml-diff-file' },
      f.path ? h('div', { className: 'cml-diff-path' }, h(FileChip, { path: f.path })) : null,
      h('pre', { className: 'cml-diff-lines' }, ...String(f.diff ?? '').split('\n').map((line, i) => h('span', { key: i, className: 'cml-diff-line',
        'data-change': line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'remove' : line.startsWith('@@') ? 'hunk' : 'same' }, line || ' '))))));
  }
  /** A file, by its name, opened by the mod when it is chosen. */
  function FileChip({ path, onOpen }) {
    const act = withIntent(onOpen, useMod());
    return h(onOpen ? 'button' : 'span', { className: 'cml-chip', title: String(path ?? ''), ...(onOpen ? { type: 'button', onClick: () => act(path) } : {}) },
      o.kit.Glyph ? h(o.kit.Glyph, { name: 'file', size: 12 }) : null, baseName(path));
  }

  // ---------------------------------------------------------------- requests (graph-integrity G1.5: Approval.options, Question.prompts)
  /** An approval's card: what it asks and its options, each answered by the mod (`onAnswer(optionId)`). */
  function ApprovalCard({ title, detail, options = [], onAnswer: answer0, busy = false }) {
    const onAnswer = withIntent(answer0, useMod());
    return h('div', { className: 'cml-card', role: 'group', 'aria-label': String(title ?? 'Approval') },
      h('div', { className: 'cml-card-title' }, String(title ?? '')),
      detail !== undefined ? h('div', { className: 'cml-card-detail' }, ...markdown(textOf(detail))) : null,
      h('div', { className: 'cml-card-actions' }, ...options.map((x, i) => h(o.kit.Action, { key: x.id, label: x.label, primary: i === 0 && x.kind === 'approve',
        danger: x.kind === 'deny', disabled: busy, onClick: () => onAnswer?.(x.id) }))));
  }
  /** A question's card: its prompts, each its choices (and a text where it takes one), answered together (`onAnswer({[promptId]: {choices?, text?}})`). */
  function QuestionCard({ prompts = [], onAnswer: answer0, onSkip: skip0, busy = false }) {
    const mod = useMod();
    const onAnswer = withIntent(answer0, mod), onSkip = withIntent(skip0, mod);
    const r = R();
    const [answers, setAnswers] = r.useState({});
    const set = (id, patch) => setAnswers((a) => ({ ...a, [id]: { ...(a[id] ?? {}), ...patch } }));
    return h('div', { className: 'cml-card', role: 'group', 'aria-label': 'Question' },
      ...prompts.map((p) => h('div', { key: p.id, className: 'cml-prompt' },
        p.header ? h('div', { className: 'cml-card-title' }, String(p.header)) : null,
        h('div', { className: 'cml-card-detail' }, ...markdown(textOf(p.prompt))),
        (p.choices ?? []).length ? h('div', { className: 'cml-choices', role: 'radiogroup' }, ...(p.choices ?? []).map((c) => h('button', { key: c.id, type: 'button', role: 'radio',
          className: 'cml-choice', 'aria-checked': (answers[p.id]?.choices ?? []).includes(c.id), disabled: busy, onClick: () => set(p.id, { choices: [c.id] }) }, c.label))) : null,
        p.other || !(p.choices ?? []).length ? h('input', { className: 'cml-input', type: p.secret ? 'password' : 'text', 'aria-label': String(p.header ?? 'Answer'), disabled: busy,
          value: answers[p.id]?.text ?? '', onChange: (e) => set(p.id, { text: String(e?.target?.value ?? '') }) }) : null)),
      h('div', { className: 'cml-card-actions' },
        h(o.kit.Action, { key: 'send', label: 'Answer', primary: true, disabled: busy, onClick: () => onAnswer?.(answers) }),
        onSkip ? h(o.kit.Action, { key: 'skip', label: 'Skip', disabled: busy, onClick: () => onSkip() }) : null));
  }

  // ---------------------------------------------------------------- the chat's frame
  /** A chat's header: its title and what it says under it, and its actions. */
  function ThreadHeader({ title, subtitle, actions: actions0 = [] }) {
    const mod = useMod();
    const actions = actions0.map((a) => (a && typeof a.onClick === 'function' ? { ...a, onClick: withIntent(a.onClick, mod) } : a));
    return h('header', { className: 'cml-header' }, h('div', { className: 'cml-header-text' }, h('div', { className: 'cml-header-title' }, String(title ?? '')),
      subtitle ? h('div', { className: 'cml-header-subtitle' }, String(subtitle)) : null),
      actions.length ? h('div', { className: 'cml-header-actions' }, ...actions.map((a, i) => h(o.kit.Action, { key: i, label: a.label, glyph: a.icon, ariaLabel: a.label, onClick: a.onClick }))) : null);
  }
  /**
   * The composer: its text, sent with Enter (Shift+Enter for a line) or its button to the mod (`onSubmit(text)`), Stop while the mod says
   * it is busy (`onStop`), its pickers (`pickers`: elements, the subtype's settings drawn with ModelPicker, EffortPicker or its own), and
   * its attachments (`attachments: [{id, name}]` as chips, `onAttach()` to add one, `onRemoveAttachment(id)`), each the mod's.
   */
  function Composer({ placeholder = 'Ask anything', value, onChange, onSubmit: submit0, onStop: stop0, busy = false, disabled = false, pickers = [], attachments = [], onAttach: attach0, onRemoveAttachment: remove0 }) {
    const mod = useMod();
    const onSubmit = withIntent(submit0, mod), onStop = withIntent(stop0, mod), onAttach = withIntent(attach0, mod), onRemoveAttachment = withIntent(remove0, mod);
    const r = R();
    const [own, setOwn] = r.useState('');
    const text = value ?? own;
    const change = (t) => { if (onChange) onChange(t); else setOwn(t); };
    const submit = () => { const t = text.trim(); if (!t || disabled || busy) return; onSubmit?.(t); if (value === undefined) setOwn(''); };
    return h('div', { className: 'cml-composer' },
      attachments.length ? h('div', { className: 'cml-attachments' }, ...attachments.map((a) => h('span', { key: a.id, className: 'cml-chip' }, String(a.name ?? a.id),
        onRemoveAttachment ? h('button', { type: 'button', className: 'cml-chip-remove', 'aria-label': `Remove ${a.name ?? a.id}`, onClick: () => onRemoveAttachment(a.id) }, '×') : null))) : null,
      h('textarea', { className: 'cml-composer-input', rows: 2, placeholder, value: text, disabled, 'aria-label': placeholder,
        onChange: (e) => change(String(e?.target?.value ?? '')), onKeyDown: (e) => { if (e?.key === 'Enter' && !e.shiftKey) { e.preventDefault?.(); submit(); } } }),
      h('div', { className: 'cml-composer-bar' }, h('div', { className: 'cml-composer-pickers' },
        onAttach ? h(o.kit.Action, { key: 'attach', label: '', ariaLabel: 'Attach', glyph: 'plus', disabled, onClick: () => onAttach() }) : null, ...pickers),
        // the app's own button (the kit's action), primary for Send
        busy && onStop ? h(o.kit.Action, { key: 'stop', label: 'Stop', ariaLabel: 'Stop', glyph: 'stop', onClick: () => onStop() })
          : h(o.kit.Action, { key: 'send', label: 'Send', ariaLabel: 'Send', glyph: 'arrow-up', primary: true, disabled: disabled || busy || !text.trim(), onClick: submit })));
  }
  /** A picker in the composer's bar: the app's composer dropdown where it is exposed, else the kit's select. */
  function Picker({ label, options, value, onChange: change0 }) {
    const onChange = withIntent(change0, useMod());
    const r = R();
    const [open, setOpen] = r.useState(false);
    const x = ex();
    const list = (options ?? []).map((v) => (isObj(v) ? v : { value: v, label: String(v) }));
    const current = list.find((v) => v.value === value)?.label ?? String(value ?? '');
    if (x.ComposerDropdown && x.MenuParts?.Item) {
      return h(x.ComposerDropdown, { 'aria-label': label, value: current, menuOpen: open, onOpenChange: setOpen, tooltipContent: label },
        ...list.map((v) => h(x.MenuParts.Item, { key: String(v.value), onClick: () => { setOpen(false); onChange?.(v.value); } }, v.value === value ? `✓ ${v.label}` : v.label)));
    }
    return h(o.kit.Select, { options: list, value, onChange: (v) => onChange?.(v), ariaLabel: label });
  }
  /** The model picker: `models` ({id, label} or ids), the chosen one, `onChange(id)`. */
  const ModelPicker = ({ models = [], value, onChange, label = 'Model' }) => h(Picker, { label, options: models.map((m) => (isObj(m) ? { value: m.id, label: m.label ?? m.name ?? m.id } : m)), value, onChange });
  /** The reasoning effort picker: `efforts`, the chosen one, `onChange(effort)`. */
  const EffortPicker = ({ efforts = [], value, onChange, label = 'Reasoning effort' }) => h(Picker, { label, options: efforts.map((x) => (isObj(x) ? { value: x.id, label: x.label ?? x.id } : { value: x, label: x[0] ? x[0].toUpperCase() + x.slice(1) : x })), value, onChange });

  /**
   * A chat's row, as the sidebar draws one (graph-integrity G2.1, for a chat the app's own rows cannot draw): its title, working or waiting
   * for you, unread, its time; `onOpen` when chosen, and its menu (`menu: [{label, onSelect, danger?}]`, what it supports). `drag`: its
   * chat's ref, which the user can then drag to a place that takes chats (G5.3).
   */
  function ChatRow({ title, status = 'idle', unread = false, time, selected = false, onOpen: open0, menu: menu0 = [], drag, badges = [] }) {
    const mod = useMod();
    const onOpen = withIntent(open0, mod);
    const menu = menu0.map((m) => (m && typeof m.onSelect === 'function' ? { ...m, onSelect: withIntent(m.onSelect, mod) } : m));
    const mark = status === 'working' ? (o.kit.Glyph ? h(o.kit.Glyph, { name: 'spinner', size: 12, spinning: true }) : null)
      : status === 'waitingForYou' ? h('span', { className: 'cml-row-dot', 'data-tone': 'waiting', role: 'img', 'aria-label': 'Waiting for you' })
        : unread ? h('span', { className: 'cml-row-dot', role: 'img', 'aria-label': 'Unread' }) : null;
    const draggable = !!drag && typeof o.drops?.()?.dragStart === 'function';
    return h('div', { className: 'cml-row', 'data-selected': selected ? '' : undefined, ...(draggable ? { draggable: true, onDragStart: (ev) => o.drops?.()?.dragStart(ev, drag) } : {}) },
      h('button', { type: 'button', className: 'cml-row-open', 'aria-current': selected ? 'page' : undefined, onClick: () => onOpen?.() },
        h('span', { className: 'cml-row-mark' }, mark), h('span', { className: 'cml-row-title' }, String(title ?? '')),
        ...(Array.isArray(badges) && badges.length ? [h('span', { className: 'cml-row-badges' }, ...badges)] : []), h('span', { className: 'cml-row-time' }, ago(time))),
      menu.length && o.kit.MenuButton ? h('span', { className: 'cml-row-menu' }, h(o.kit.MenuButton, { ariaLabel: `More for ${title ?? 'this chat'}`, items: menu.map((m) => ({ label: m.label, danger: m.danger, onSelect: m.onSelect })) })) : null);
  }

  /**
   * A place of the mod's that takes what the user drops on it (G5.3): `accepts`, the concepts it takes (`['Thread']`); `onDrop({ref})`
   * with the instance dropped, one of those; a chat dragged from the sidebar (the app's rows and the framework's) or from a ChatRow. While
   * one would be taken it says so (`data-over`), as the theme draws it. Its children are the place.
   */
  function DropTarget({ accepts = [], onDrop, children, className, style }) {
    const r = R();
    const mod = useMod();
    const fn = r.useRef(onDrop);
    fn.current = withIntent(onDrop, mod);   // a drop is the user's own gesture: its mod's attestation with it (G7.1)
    const held = r.useRef(null);
    const [over, setOver] = r.useState(false);
    const list = (Array.isArray(accepts) ? accepts : [accepts]).filter((a) => typeof a === 'string' && a);
    const key = list.join('\u001f');
    // the place is its element while it is drawn: React gives it as it mounts (and when what it accepts changes), null as it goes
    const attach = r.useCallback((node) => {
      held.current?.();
      held.current = null;
      const d = o.drops?.();
      if (node && d && list.length) held.current = d.target(node, { accepts: list, drop: (x) => fn.current?.(x), over: setOver });
    }, [key]);
    return h('div', { ref: attach, className: `cml-drop${className ? ` ${className}` : ''}`, 'data-over': over ? '' : undefined, style }, children);
  }

  return { Transcript, Turn, Message, StepRow, DiffView, FileChip, ApprovalCard, QuestionCard, ThreadHeader, Composer, ModelPicker, EffortPicker, ChatRow, DropTarget, ensureStyle };
}
