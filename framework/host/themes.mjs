// The mods' themes (public-hooks.md §3.14, `ui.theme.add`; H7y; scout H7y-themes): a theme is a declaration of its mod's (an add rule on
// SettingsPage's `theme` slot, the Appearance page's), listed in the framework's own section of that page. The user turns one on there:
// it is written as the app's own appearance settings (each variant's chrome theme, its code theme, and the appearance itself for a theme of
// one variant), so every surface the app colours from them follows (the page, the terminal, diffs, pop-out windows, the window's backdrop),
// as an override of its mod's that the user made (graph.override, approved by that act): the user's own values come back when it is turned
// off, when its mod stops, or at the next start after a crash, and a change the user makes to one of those settings meanwhile stays. The
// theme the user chose is remembered on this Mac: it is applied again whenever its declaration comes back (the mod started again), until
// the user turns it off or leaves it (changes every setting it held). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

/** The override a theme is: one per mod (its owner), so a mod's stop ends it. */
export const THEME_OVERRIDE = 'codexmods.theme';
const RETRY_MS = 2000, RETRY_MAX_MS = 60_000;   // a chosen theme not applied yet is tried again, less often each time
const SETTING = (id) => Object.freeze({ type: 'Setting', provider: 'codex', id });
// what a variant's diff and skill colours are when its theme gives none (the app's own defaults are its seed's)
const SEMANTIC = Object.freeze({
  light: Object.freeze({ diffAdded: '#1a7f37', diffRemoved: '#cf222e', skill: '#8250df' }),
  dark: Object.freeze({ diffAdded: '#3fb950', diffRemoved: '#f85149', skill: '#a371f7' }),
});
const KEYS = Object.freeze({
  light: Object.freeze({ chrome: 'appearanceLightChromeTheme', code: 'appearanceLightCodeThemeId' }),
  dark: Object.freeze({ chrome: 'appearanceDarkChromeTheme', code: 'appearanceDarkCodeThemeId' }),
});

/** A variant of a theme as the app's chrome theme (its schema: accent, contrast, fonts, ink, opaqueWindows, semanticColors, surface). */
export function chromeOf(c, variant) {
  const s = SEMANTIC[variant];
  return {
    accent: c.accent, accentSource: 'custom', contrast: Number.isInteger(c.contrast) ? c.contrast : 50,
    fonts: { ui: typeof c.fonts?.ui === 'string' ? c.fonts.ui : null, code: typeof c.fonts?.code === 'string' ? c.fonts.code : null },
    ink: c.ink, opaqueWindows: c.translucent === false,
    semanticColors: { diffAdded: c.added ?? s.diffAdded, diffRemoved: c.removed ?? s.diffRemoved, skill: c.skill ?? s.skill },
    surface: c.surface,
  };
}
/** The Settings a theme sets: each variant's chrome theme and code theme; the appearance for a theme of one variant. */
export function settingsOf(theme) {
  const set = [];
  for (const variant of ['light', 'dark']) {
    const c = theme[variant];
    if (!c) continue;
    set.push({ ref: SETTING(KEYS[variant].chrome), value: chromeOf(c, variant) });
    if (typeof c.code === 'string') set.push({ ref: SETTING(KEYS[variant].code), value: c.code });
  }
  if (!!theme.light !== !!theme.dark) set.push({ ref: SETTING('appearanceTheme'), value: theme.light ? 'light' : 'dark' });
  return set;
}

/**
 * @param {{ rules: { snapshot(): object[], subscribe(fn: (e: object) => void): { dispose(): void } }, graph: () => object | null,
 *   file?: string, log?: object }} o
 */
export function createThemes(o) {
  const log = o.log ?? { info() {}, warn() {} };
  const listeners = new Set();
  let active = null;   // {mod, id}: the theme the user chose
  let busy = Promise.resolve();
  if (o.file && fs.existsSync(o.file)) {
    try { const s = JSON.parse(fs.readFileSync(o.file, 'utf8')); if (typeof s?.active?.mod === 'string' && typeof s.active.id === 'string') active = { mod: s.active.mod, id: s.active.id }; } catch { /* none */ }
  }
  const save = () => {
    if (!o.file) return;
    try { fs.mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 }); fs.writeFileSync(o.file, JSON.stringify({ active }), { mode: 0o600 }); } catch (e) { log.warn('themes: the chosen theme could not be saved', { message: String(e?.message ?? e) }); }
  };
  const owner = (mod) => `mod:${mod}`;
  /** A theme's declaration (its item), while its mod runs. */
  const themeOf = (mod, id) => o.rules.snapshot().find((r) => r.mod === mod && r.id === id && r.kind === 'add' && r.presentation === 'SettingsPage' && r.slot === 'theme')?.data?.items?.[0] ?? null;
  /** Whether the chosen theme holds any setting now (its override). */
  const applied = () => !!active && (o.graph()?.overridesOf(owner(active.mod)) ?? []).some((x) => x.id === THEME_OVERRIDE);
  const state = () => Object.freeze({ active: active ? Object.freeze({ ...active, applied: applied() }) : null });
  const tell = () => { const s = state(); for (const fn of [...listeners]) { try { fn(s); } catch { /* a listener's own */ } } };
  const serial = (fn) => { const run = busy.then(fn, fn); busy = run.catch(() => {}); return run; };

  async function apply(mod, id) {
    const g = o.graph();
    const t = themeOf(mod, id);
    if (!g || !t) return { status: 'refused', reason: 'unavailable', message: 'that theme is not here now (its mod is not running)' };
    return g.override(owner(mod), { id: THEME_OVERRIDE, set: settingsOf(t) }, { modId: mod, approved: true });
  }

  // the user left the chosen theme (changed every setting it held): it is no longer the chosen one
  let endSub = null;
  const follow = () => { if (!endSub && o.graph()?.onOverrideEnd) endSub = o.graph().onOverrideEnd((x) => { if (x.why === 'left' && active && x.owner === owner(active.mod) && x.id === THEME_OVERRIDE) { active = null; save(); tell(); } }); };
  follow();
  // The chosen theme holds the app's settings exactly while its declaration is here (built review H7y round 1): what to do is decided in
  // the queue, from what is chosen and declared then (never from what an earlier event saw); one that cannot be applied yet (the app's
  // Settings not here after a start) is tried again until it is, or is no longer wanted.
  let retry = null, tries = 0;
  const later = () => {
    if (retry || disposed) return;
    retry = setTimeout(() => { retry = null; void reconcile(); }, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.min(tries++, 5)));
    retry.unref?.();
  };
  function reconcile() {
    return serial(async () => {
      if (disposed || !active || !o.graph()) return;
      const declared = !!themeOf(active.mod, active.id);
      if (declared && !applied()) {
        const out = await apply(active.mod, active.id);
        if (out.status === 'done') tries = 0;
        else { log.warn('themes: the chosen theme is not applied yet', { message: out.message }); later(); }
      } else if (!declared && applied()) await o.graph().unoverride(owner(active.mod), THEME_OVERRIDE);
      tell();
    });
  }
  let disposed = false;
  const sub = o.rules.subscribe((e) => {
    follow();
    if (active && (e?.t === 'put' ? e.rule?.slot === 'theme' : e?.t === 'remove')) void reconcile();
  });
  queueMicrotask(() => { void reconcile(); });

  return {
    /** The user turns a mod's theme on: the one on before is turned off first (its values given back). */
    use(mod, id) {
      return serial(async () => {
        if (typeof mod !== 'string' || typeof id !== 'string' || !themeOf(mod, id)) return { status: 'refused', reason: 'invalid', message: 'no such theme' };
        if (active && applied()) await o.graph()?.unoverride(owner(active.mod), THEME_OVERRIDE);
        const out = await apply(mod, id);
        if (out.status === 'done') { active = { mod, id }; save(); }
        else void reconcile();   // the one chosen before holds again
        tell();
        return out;
      });
    },
    /** The user turns the theme off: the user's own values back. */
    stop() {
      return serial(async () => {
        if (active) await o.graph()?.unoverride(owner(active.mod), THEME_OVERRIDE);
        active = null;
        save();
        tell();
        return { status: 'done' };
      });
    },
    /** `{active: {mod, id, applied} | null}`: the theme the user chose, and whether it holds the app's settings now. */
    state() { follow(); return state(); },
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    dispose() { disposed = true; clearTimeout(retry); sub?.dispose?.(); endSub?.dispose?.(); listeners.clear(); },
  };
}
