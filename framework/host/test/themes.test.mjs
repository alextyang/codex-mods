// The mods' themes (public-hooks.md §3.14, H7y): turned on by the user, written as the app's own appearance settings (an override of the
// theme's mod), given back when turned off or when the user leaves it; the chosen one applied again when its declaration comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../graph/index.mjs';
import { toDescriptor } from '../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../sdk/graph/native/index.mjs';
import { createThemes, settingsOf, chromeOf, THEME_OVERRIDE } from '../themes.mjs';
import { themeWhy } from '../../shared/ui-rules-client.mjs';

const KEYS = ['appearanceTheme', 'appearanceLightChromeTheme', 'appearanceDarkChromeTheme', 'appearanceLightCodeThemeId', 'appearanceDarkCodeThemeId'];
const setting = (id) => ({ type: 'Setting', provider: 'codex', id });
const until = (fn, ms = 2000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (fn()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('timed out')); setTimeout(tick, 10); }; tick(); });
const DUSK = { title: 'Dusk', dark: { surface: '#101418', ink: '#e6e6e6', accent: '#ff8800', code: 'tokyo-night' } };
const PAIR = { title: 'Paper', light: { surface: '#fffdf5', ink: '#222222', accent: '#0066cc', contrast: 60 }, dark: { surface: '#1b1b1b', ink: '#eeeeee', accent: '#66aaff', translucent: false } };

function setup(file, now = Date.now, { late = false, writeDelay = null } = {}) {
  const graph = createGraph({ overridesFile: path.join(path.dirname(file), 'overrides.json'), now });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  const state = { appearanceTheme: 'system' };
  let p;
  const put = (key) => p.put(setting(key), { state: { title: key, value: state[key] ?? null, default: null, scope: 'app', kind: 'record' }, links: { section: { type: 'SettingsSection', provider: 'codex', id: 'appearance' }, definedBy: { type: 'App', provider: 'codex', id: 'codex' } } });
  p = graph.registerProvider('native', 'codex', { types: { Setting: { operations: {
    set: { effect: 'external', handler: async ({ ref, args }) => { if (writeDelay) await writeDelay(); state[ref.id] = args[0]; put(ref.id); return null; } },
    reset: { effect: 'external', handler: async ({ ref }) => { if (writeDelay) await writeDelay(); state[ref.id] = undefined; put(ref.id); return null; } },
  } } } });
  const arrive = () => { for (const k of KEYS) put(k); };
  if (!late) arrive();
  const listeners = new Set();
  let snapshot = [];
  const rules = { snapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
  const declare = (mod, id, theme) => { const rule = { mod, id, kind: 'add', presentation: 'SettingsPage', slot: 'theme', data: { items: [{ id, ...theme }] } }; snapshot = [...snapshot.filter((r) => !(r.mod === mod && r.id === id)), rule]; for (const fn of listeners) fn({ t: 'put', rule }); };
  const takeBack = (mod, id) => { snapshot = snapshot.filter((r) => !(r.mod === mod && r.id === id)); for (const fn of listeners) fn({ t: 'remove', key: `${mod}/${id}` }); };
  const themes = createThemes({ rules, graph: () => graph, file });
  return { graph, state, put, declare, takeBack, themes, arrive, userSets: (k, v) => { state[k] = v; put(k); } };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'themes-')), 'themes.json');

test('H7y: a theme is the app\'s chrome theme of each variant it gives (the framework fills what it leaves out); one of one variant sets the appearance too', () => {
  assert.deepEqual(chromeOf(DUSK.dark, 'dark'), { accent: '#ff8800', accentSource: 'custom', contrast: 50, fonts: { ui: null, code: null }, ink: '#e6e6e6', opaqueWindows: false,
    semanticColors: { diffAdded: '#3fb950', diffRemoved: '#f85149', skill: '#a371f7' }, surface: '#101418' });
  assert.deepEqual(settingsOf(DUSK).map((x) => [x.ref.id, typeof x.value === 'object' ? 'chrome' : x.value]), [['appearanceDarkChromeTheme', 'chrome'], ['appearanceDarkCodeThemeId', 'tokyo-night'], ['appearanceTheme', 'dark']]);
  assert.deepEqual(settingsOf(PAIR).map((x) => x.ref.id), ['appearanceLightChromeTheme', 'appearanceDarkChromeTheme'], 'both variants: the appearance stays the user\'s');
  assert.equal(chromeOf(PAIR.dark, 'dark').opaqueWindows, true);
  assert.equal(themeWhy(DUSK), null);
  for (const bad of [{ title: 'x' }, { title: '', dark: DUSK.dark }, { title: 'x', dark: { ...DUSK.dark, accent: 'orange' } }, { title: 'x', dark: { ...DUSK.dark, contrast: 101 } }, { title: 'x', dark: { ...DUSK.dark, glow: 1 } }]) assert.ok(themeWhy(bad), JSON.stringify(bad));
});

test('H7y: the user turns a theme on (no prompt: their own act) and off; another theme on first gives the user\'s values back', async () => {
  const s = setup(tmp());
  s.declare('mod.a', 'dusk', DUSK);
  s.declare('mod.b', 'paper', PAIR);
  assert.equal((await s.themes.use('mod.a', 'dusk')).status, 'done');
  assert.deepEqual([s.state.appearanceTheme, s.state.appearanceDarkCodeThemeId, s.state.appearanceDarkChromeTheme?.accent], ['dark', 'tokyo-night', '#ff8800']);
  assert.deepEqual(s.themes.state().active, { mod: 'mod.a', id: 'dusk', applied: true });
  assert.deepEqual(s.graph.overrideHolderOf(setting('appearanceTheme')), { owner: 'mod:mod.a', id: THEME_OVERRIDE });
  assert.equal((await s.themes.use('mod.b', 'paper')).status, 'done');
  assert.deepEqual([s.state.appearanceTheme, s.state.appearanceDarkCodeThemeId, s.state.appearanceLightChromeTheme?.accent], ['system', undefined, '#0066cc'], 'the first theme\'s values given back');
  await s.themes.stop();
  assert.deepEqual([s.state.appearanceLightChromeTheme, s.state.appearanceDarkChromeTheme], [undefined, undefined]);
  assert.equal(s.themes.state().active, null);
  assert.equal((await s.themes.use('mod.a', 'nope')).status, 'refused');
});

test('H7y: the chosen theme ends with its declaration and is applied again when it comes back, after a restart too; the user changing all it set leaves it', async () => {
  const file = tmp();
  let clock = Date.now();
  const s = setup(file, () => clock);
  s.declare('mod.a', 'dusk', DUSK);
  await s.themes.use('mod.a', 'dusk');
  s.takeBack('mod.a', 'dusk');
  await until(() => s.state.appearanceTheme === 'system');
  assert.deepEqual(s.themes.state().active, { mod: 'mod.a', id: 'dusk', applied: false }, 'still the chosen one');
  s.declare('mod.a', 'dusk', DUSK);
  await until(() => s.state.appearanceTheme === 'dark');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).active, { mod: 'mod.a', id: 'dusk' });
  // the user changes every setting it holds, after its own writes: the theme is left, and no longer the chosen one
  clock += 10_000;
  const seen = [];
  s.themes.subscribe((x) => seen.push(x.active));
  s.userSets('appearanceTheme', 'light');
  s.userSets('appearanceDarkCodeThemeId', 'github');
  assert.equal(s.themes.state().active?.applied, true, 'one setting still held');
  s.userSets('appearanceDarkChromeTheme', { accent: '#000000' });
  assert.equal(s.themes.state().active, null);
  assert.deepEqual(seen.at(-1), null);
  assert.deepEqual([s.state.appearanceTheme, s.state.appearanceDarkCodeThemeId], ['light', 'github'], 'nothing written back over the user\'s');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).active, null);
  s.themes.dispose();
});

test('H7y: a Host started again applies the chosen theme once its declaration is there, and not over one that still holds', async () => {
  const file = tmp();
  const a = setup(file);
  a.declare('mod.a', 'dusk', DUSK);
  await a.themes.use('mod.a', 'dusk');
  a.themes.dispose();
  // the next start: a fresh app state (the user's values), the saved choice; the mod's declaration arrives later
  const b = setup(file);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.state.appearanceTheme, 'system');
  assert.deepEqual(b.themes.state().active, { mod: 'mod.a', id: 'dusk', applied: false });
  b.declare('mod.a', 'dusk', DUSK);
  await until(() => b.state.appearanceTheme === 'dark');
  assert.equal(b.themes.state().active.applied, true);
  b.declare('mod.a', 'dusk', DUSK);   // declared again while it holds: not written again
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.graph.overridesOf('mod:mod.a').length, 1);
  b.themes.dispose();
});

test('H7y review: what the chosen theme does is decided when its turn comes: a declaration taken back during a switch ends only its own', async () => {
  let gate = null;
  const s = setup(tmp(), Date.now, { writeDelay: () => gate });
  s.declare('mod.a', 'dusk', DUSK);
  s.declare('mod.b', 'paper', PAIR);
  await s.themes.use('mod.a', 'dusk');
  let open;
  gate = new Promise((r) => { open = r; });
  const switching = s.themes.use('mod.b', 'paper');
  s.takeBack('mod.a', 'dusk');   // while the switch writes
  await new Promise((r) => setTimeout(r, 5));
  gate = null;
  open();
  assert.equal((await switching).status, 'done');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.themes.state().active, { mod: 'mod.b', id: 'paper', applied: true }, 'the new one stays');
  assert.equal(s.state.appearanceLightChromeTheme?.accent, '#0066cc');
  s.themes.dispose();
});

test('H7y review: a remembered theme declared before the app\'s Settings are here is applied once they are; declared again while it ends, it holds after', async () => {
  const file = tmp();
  const a = setup(file);
  a.declare('mod.a', 'dusk', DUSK);
  await a.themes.use('mod.a', 'dusk');
  a.themes.dispose();
  const b = setup(file, Date.now, { late: true });
  b.declare('mod.a', 'dusk', DUSK);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.themes.state().active.applied, false, 'not yet: no Settings');
  b.arrive();
  await until(() => b.state.appearanceTheme === 'dark', 5000);
  // taken back and declared again while its values are being given back: it holds after
  let open;
  const c = setup(tmp(), Date.now, { writeDelay: () => (open ? null : new Promise((r) => { open = r; })) });
  c.declare('mod.a', 'dusk', DUSK);
  open = () => {};
  await c.themes.use('mod.a', 'dusk');
  open = null;
  c.takeBack('mod.a', 'dusk');
  await new Promise((r) => setTimeout(r, 5));
  c.declare('mod.a', 'dusk', DUSK);
  const release = open;
  open = () => {};
  release();
  await until(() => c.themes.state().active?.applied === true && c.state.appearanceTheme === 'dark', 3000);
  b.themes.dispose();
  c.themes.dispose();
});
