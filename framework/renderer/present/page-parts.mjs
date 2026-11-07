// What the framework's pages draw with (docs/design/systems.md E6.2): the app's Button and Switch (a plain button when the build lacks
// them), a value, lines with an error said under them, and a settings section with its card. Theme classes only. NO NODE API.

/**
 * @param {object} R  the app's React
 * @param {object} ex  the app's exports (SettingsSection, SettingsCard, Button, Switch)
 */
export function pageParts(R, ex) {
  const e = R.createElement;
  const { SettingsSection: Section, SettingsCard: Card } = ex;
  /** A button; `tone`: 'primary', 'secondary' (the default) or 'danger'; `name`: what assistive technology says, when the label is a glyph. */
  const button = (label, onClick, disabled, tone = 'secondary', name) => (ex.Button ? e(ex.Button, { color: tone, onClick, disabled: Boolean(disabled), ...(name ? { 'aria-label': name, title: name } : {}) }, label)
    : e('button', { type: 'button', className: 'text-sm', onClick, disabled: Boolean(disabled), ...(name ? { 'aria-label': name, title: name } : {}) }, label));
  // The app's Switch names its label `ariaLabel`; both are given.
  const toggle = (label, checked, onChange, disabled) => (ex.Switch
    ? e(ex.Switch, { checked: Boolean(checked), disabled: Boolean(disabled), ariaLabel: label, 'aria-label': label, onChange: (v) => onChange(typeof v === 'boolean' ? v : Boolean(v?.target?.checked)) })
    : button(checked ? 'Turn off' : 'Turn on', () => onChange(!checked), disabled));
  return {
    button, toggle,
    value: (v) => e('span', { className: 'text-secondary' }, v),
    /** Lines, with an error under them; nothing when there is nothing to say. */
    lines: (list, err) => {
      const said = list.filter(Boolean);
      if (!said.length && !err) return null;
      return e('span', { className: 'flex flex-col gap-0.5' }, ...said.map((l, i) => e('span', { key: i }, l)),
        err ? e('span', { key: 'err', className: 'text-danger', role: 'alert' }, err) : null);
    },
    section: (key, title, rows) => e(Section, { key }, e(Section.Header, { title }), e(Section.Content, null, e(Card, null, ...rows))),
  };
}
