// codexmods.ui-tweaks, host entry (GOAL.md goal 20). Single-file ESM, no imports.
//
// Appearance settings for what users complain about, each one rule of the framework's while it is set:
// - the chat's width, its text size and its code's text size, and the rows' height: the app's own CSS variables, each set to another of
//   the app's variables (its container widths, its text sizes, its control sizes), so a tweak follows the app's own scale and the theme
//   (`ui.style`; the app's variables, never a raw value);
// - the agent's steps shown expanded and each turn's steps unfolded, until the user chooses otherwise (`graph.defaults`);
// - the app's own parts the user chose to hide (`ui.hide` with the part names `ui.parts` gives; the renderer's page is where they are
//   chosen).

/** Each choice, as the app's own variable it sets: `--name` -> another of the app's variables. */
export const VARIABLES = Object.freeze({
  width: { variable: '--thread-content-max-width', to: { wide: '--container-4xl', wider: '--container-5xl', widest: '--container-7xl' } },
  chatText: { variable: '--codex-chat-font-size-override', to: { smaller: '--text-sm', larger: '--text-lg', largest: '--text-xl' } },
  codeText: { variable: '--codex-chat-code-font-size-override', to: { smaller: '--text-xs', larger: '--text-base' } },
  rows: { variable: '--height-token-row', to: { compact: '--control-size-sm', roomy: '--control-size-lg' } },
});

/** What the style rule sets for these settings: only the tweaks that are not the app's own. */
export function variablesOf(s) {
  const out = {};
  for (const [key, { variable, to }] of Object.entries(VARIABLES)) if (Object.hasOwn(to, s?.[key])) out[variable] = to[s[key]];
  return out;
}

/** The hidden parts, `<Presentation>/<slot>/<part>` each, as one hide rule per presentation and slot. */
export function hidesOf(list) {
  const by = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const m = typeof x === 'string' ? /^([A-Za-z]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.:-]+)$/.exec(x) : null;
    if (!m) continue;
    const k = `${m[1]}/${m[2]}`;
    if (!by.has(k)) by.set(k, { presentation: m[1], slot: m[2], parts: [] });
    if (!by.get(k).parts.includes(m[3])) by.get(k).parts.push(m[3]);
  }
  return [...by.values()];
}

async function host(ctx) {
  let handles = [];
  const drop = () => { for (const h of handles) { try { h.dispose(); } catch { /* gone with the mod */ } } handles = []; };
  /** One rule: kept to dispose; one that is refused is logged and leaves the others in place. */
  const keep = (make, what) => {
    let h;
    try { h = make(); } catch (e) { ctx.log.warn(`${what} was refused`, { error: String(e?.message ?? e) }); return; }
    handles.push(h);
    h.accepted?.then((ok) => { if (ok === false) ctx.log.warn(`${what} was not accepted`); }, (e) => ctx.log.warn(`${what} was refused`, { error: String(e?.message ?? e) }));
  };
  function apply(s) {
    drop();
    const variables = variablesOf(s);
    if (Object.keys(variables).length) keep(() => ctx.ui.style({ id: 'look', variables }), 'the look');
    if (s.expandSteps === true) keep(() => ctx.graph.defaults({ id: 'steps-open', of: 'StepBlock', state: { expanded: true } }), 'steps expanded');
    if (s.expandTurns === true) keep(() => ctx.graph.defaults({ id: 'turns-open', of: 'TurnView', state: { expanded: true } }), 'turns unfolded');
    for (const h of hidesOf(s.hidden)) {
      keep(() => ctx.ui.hide(h.presentation, { id: `hide-${h.presentation}-${h.slot}`, slot: h.slot, part: h.parts }), `hiding ${h.presentation} ${h.slot}`);
    }
  }
  apply(await ctx.settings.get());
  const sub = ctx.settings.onChange((s) => apply(s));
  return () => { sub.dispose(); drop(); };
}

export default { host };
