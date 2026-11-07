// What the framework's pages say of the graph's values (docs/design/systems.md E6.2): a mod's status and compatibility, an operation's
// kind and outcome, a permission's risk, times and sizes. Shared by the framework's pages and their dialogs. NO NODE API.

export const STATUS = Object.freeze({ enabled: 'On', disabled: 'Off', pendingConsent: 'Waiting for your consent', quarantined: 'Turned off after faults' });
export const COMPAT = Object.freeze({ compatible: 'Works with this version of the app', degraded: 'Works, with parts missing', atRisk: 'May not work with this version of the app', blocked: 'Does not work with this version of the app' });
export const KIND = Object.freeze({
  install: 'Install', consent: 'Consent', enable: 'Turn on', disable: 'Turn off', configure: 'Settings', update: 'Update', rollback: 'Roll back',
  remove: 'Remove', reattach: 'Reattach data', clearQuarantine: 'Clear what stopped it', reload: 'Reload', setPermission: 'Change a permission', setAutomatic: 'Switch an automatic action', setPolicy: 'Switch a policy',
  frameworkUpdate: 'Framework update', appPrepare: 'Prepare the app update',
  appSwitch: 'Switch to the new app', copyUpdate: 'Update', safeMode: 'Safe mode', lastKnownGood: 'Restore last-known-good',
});
export const OUTCOME = Object.freeze({ running: 'Running', succeeded: 'Done', failed: 'Failed', reverted: 'Reverted', needsAttention: 'Needs attention' });
export const RISK = Object.freeze({ high: 'High risk', medium: 'Medium risk', low: 'Low risk' });
/** The risks, the highest first. */
export const RISK_ORDER = Object.freeze(['high', 'medium', 'low']);

/** What a mod is now (docs/design/framework-ui.md F5): the Host's projection. */
export const modStateOf = (s) => s?.state ?? 'off';
const ISSUES = new Set(['consent', 'missing', 'incompatible', 'stopped']);
/** The section of the Mods list a mod is in: an issue comes first, a newer release found moves only a mod that is on, and one reloading stays as its switch says. */
export function modSectionOf(s) {
  const st = modStateOf(s);
  if (ISSUES.has(st)) return 'issues';
  if (st === 'off' || (st === 'reloading' && s.status === 'disabled')) return 'off';
  return s?.release ? 'updates' : 'on';
}
/** How many of these mods have an issue (the Mods entry's trailing text). */
export const issuesIn = (states) => states.filter((s) => modSectionOf(s) === 'issues').length;
/** A mod's word on its page, with its tone. */
export function modWord(s, safeMode) {
  const st = modStateOf(s);
  if (st === 'reloading') return { word: 'Reloading', tone: 'neutral' };
  if (st === 'consent') return { word: 'Waiting for you', tone: 'info' };
  if (st === 'missing') return { word: 'Can\u2019t be read', tone: 'danger' };
  if (st === 'incompatible') return { word: 'Not loaded', tone: 'warning' };
  if (st === 'stopped') { const t = timeOf(s.quarantine?.at); return { word: t ? `Stopped at ${t}` : 'Stopped', tone: 'danger' }; }
  if (st === 'off') return { word: 'Off', tone: 'neutral' };
  return safeMode ? { word: 'Off in safe mode', tone: 'neutral' } : { word: 'On', tone: 'success' };
}
/** Can it be reloaded now: it runs or has stopped, and may run here. */
export const canReload = (s, safeMode) => !safeMode && ['on', 'stopped'].includes(modStateOf(s));

/** A string value, or '' for anything else. */
export const text = (v) => (typeof v === 'string' ? v : '');
/** A time of the graph (milliseconds), or 0. */
export const msOf = (v) => (Number.isFinite(v) ? v : 0);
/** A time of the graph as its day, or '' when there is none. */
export const dayOf = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '');
/** A time of the graph as its hour and minute here, or '' when there is none. */
export const timeOf = (ms) => (Number.isFinite(ms) && ms > 0 ? `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}` : '');
/** A build as the pages show it: its first two parts (framework-ui.md F1); the full id is in a mod's details. */
export const shortBuild = (v) => { const t = text(v); const m = /^\d+\.\d+/.exec(t); return m ? m[0] : t; };
/** A size in bytes, in the unit that reads best. */
export function sizeOf(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return n === 1 ? '1 byte' : `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
/** What an operation says on its row: its phase while it runs, else its message. */
export const opSays = (s) => (s?.outcome === 'running' ? (s.phase ? `${s.phase}…` : '') : text(s?.message));
/** The activity worth looking at: running, failed, reverted, or needing attention and not acknowledged; the newest first. */
export const worthShowing = (ops, limit) => ops.filter((x) => {
  const out = x.state?.outcome;
  return out === 'running' || out === 'failed' || out === 'reverted' || (out === 'needsAttention' && !x.state?.acknowledgedAt);
}).sort((a, b) => msOf(b.state?.startedAt) - msOf(a.state?.startedAt)).slice(0, limit);

// ---- where a mod's rules say it presents (framework-ui.md F13), in the user's words
const PLACE = Object.freeze({
  Menu: 'Menus', SidebarItem: 'Sidebar rows', DetailView: 'Details views', Dialog: 'Questions', RequestCard: 'Approval cards', ContentView: 'Messages',
  SettingsPage: 'Settings', Choices: 'Pickers', MainRegion: 'A page of its own', SidePanel: 'The side panel', BottomPanel: 'The bottom panel',
  'Window/layouts': 'Layouts', 'Window/layoutModes': 'Layout modes', 'Window/destinations': 'The rail and the sidebar’s navigation', 'Window/links': 'Opening links',
  'Sidebar/views': 'A sidebar view', 'Sidebar/groups': 'The sidebar’s order',
});
const KIND_WORD = Object.freeze({ decorate: 'Adds to it', hide: 'Hides some of it', replace: 'Replaces it', host: 'Adds its own', render: 'Draws its own', add: 'Adds its own', reorder: 'Reorders it', style: 'Styles it' });
/** One of Mod.places in words: where, and what it does there. */
export function placeSays(p) {
  const where = PLACE[`${p.presentation}/${p.slot}`] ?? PLACE[p.presentation]
    ?? (p.presentation ? String(p.presentation).replace(/([a-z])([A-Z])/g, (_m, a, b) => `${a} ${b.toLowerCase()}`).replace(/^./, (c) => c.toUpperCase()) : 'The app');
  return { where, what: KIND_WORD[p.kind] ?? text(p.kind) };
}
