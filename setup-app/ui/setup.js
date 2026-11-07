// The setup window (the install flow's Check, Choose, Build and Done; Unsupported; and, once set up, its own page with Rebuild and
// Uninstall). It reads and acts only through this run's server, with the token from its own address.
'use strict';

const token = location.hash.slice(1);
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'X-Setup-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? `The setup app answered ${r.status}.`);
  return j;
}

// ---- building the page
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const ICONS = {
  ok: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.25"/><path d="M5.5 8.2l1.7 1.7 3.3-3.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7.13 2.6a1 1 0 0 1 1.74 0l5.2 9.2a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8 6.3v3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><circle cx="8" cy="11.1" r="0.75" fill="currentColor"/></svg>',
  skip: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.25"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  done: '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.8 8.4l2.6 2.6 5.8-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const icon = (name) => { const s = h('span', { 'aria-hidden': 'true', style: 'display:inline-flex' }); s.innerHTML = ICONS[name]; return s; };
const badge = (tone, label, glyph) => h('span', { className: 'status', 'data-tone': tone }, glyph === 'spin' ? h('span', { className: 'spin', 'aria-hidden': 'true' }) : glyph ? icon(glyph) : null, label);
const row = (label, desc, control) => h('div', { className: 'row' }, h('div', { className: 'row-text' }, h('div', { className: 'row-label' }, label), desc ? h('div', { className: 'row-desc' }, desc) : null), control ?? null);
const group = (title, side, ...rows) => h('section', { className: 'group' }, h('div', { className: 'group-head' }, h('div', { className: 'group-title' }, title), side ? h('span', { className: 'group-side' }, side) : null), h('div', { className: 'card' }, ...rows));
const btn = (label, onClick, tone, disabled) => h('button', { type: 'button', className: 'btn', 'data-tone': tone, onClick, disabled: Boolean(disabled) }, label);
const bytes = (n) => (n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const quit = () => { if (window.webkit?.messageHandlers?.setup) window.webkit.messageHandlers.setup.postMessage('quit'); else window.close(); };

// ---- state
const S = { view: 'loading', check: null, choice: null, job: null, details: false, dialog: false, error: null, log: [] };
const NAV = [['check', 'Check'], ['choose', 'Choose'], ['build', 'Build'], ['done', 'Done']];
const STEP_OF = { check: 0, unsupported: 0, choose: 1, build: 2, done: 3, installed: 3, uninstalling: 3, uninstalled: 3 };

function render() {
  const at = STEP_OF[S.view] ?? 0;
  const failedBuild = S.view === 'build' && S.job?.done && S.job.error;
  document.getElementById('nav').replaceChildren(...NAV.map(([, label], i) => h('div', { className: 'nav-item', 'aria-current': i === at ? 'step' : null, 'data-state': i < at || (i === at && S.view === 'done') ? 'done' : null },
    i < at || (S.view === 'installed' || S.view === 'done') ? badge('success', '', 'ok')
      : i === at && (S.view === 'unsupported' || failedBuild) ? badge('warning', '', 'warn') : h('span', { className: 'nav-num' }, String(i + 1)), label)));
  const view = VIEWS[S.view] ?? VIEWS.loading;
  const [content, footer] = view();
  document.getElementById('main').replaceChildren(h('div', { className: 'content' }, ...content), h('div', { className: 'footer' }, ...footer), ...(S.dialog ? [uninstallDialog()] : []));
}

async function load() {
  S.error = null;
  try {
    S.check = await api('GET', '/api/check');
    const c = S.check;
    S.view = c.installed ? 'installed' : !c.stock.found || !c.stock.supported ? 'unsupported' : 'check';
  } catch (e) { S.error = e.message; S.view = 'error'; }
  render();
}

// ---- the views
const VIEWS = {
  loading: () => [[h('div', { className: 'head' }, h('h1', null, 'Set up Codex Mods'), h('p', { className: 'lead' }, 'Checking this Mac…'))], []],
  error: () => [[h('div', { className: 'head' }, h('h1', null, 'Something went wrong'), h('p', { className: 'lead' }, S.error ?? ''))], [btn('Quit', quit), btn('Try again', load, 'primary')]],

  check: () => {
    const c = S.check;
    const busy = c.running.chatgpt.length || c.running.codex.length;
    const id = c.identities[0];
    const ready = c.node.ok && c.stock.supported;
    return [[
      h('div', { className: 'head' }, h('h1', null, 'Set up Codex Mods'), h('p', { className: 'lead' }, 'Codex Mods builds a separate copy of ChatGPT that can run mods. Your ChatGPT app stays exactly as it is.')),
      group('What it needs', ready ? 'All ready' : null,
        row('ChatGPT for Mac', `Version ${c.stock.version} (build ${c.stock.bundle}), supported`, badge('success', 'Ready', 'ok')),
        row('Node.js', `Version ${c.node.version}, used to build the copy and run mods`, c.node.ok ? badge('success', 'Ready', 'ok') : badge('danger', 'Needs 24 or newer', 'warn')),
        row('Signing certificate', id ? `${id}, for a copy you use every day` : 'None found. You can still make a copy to try it, without one.', id ? badge('success', 'Ready', 'ok') : badge('muted', 'Optional', 'skip')),
        row('Your Codex data', c.codex.exists ? `Chats and settings in ~/.codex (${bytes(c.codex.bytes)}), backed up before anything changes if you choose` : 'None yet: a copy you use every day starts it', badge('muted', c.codex.exists ? 'Found' : 'None', c.codex.exists ? 'ok' : 'skip'))),
      busy ? h('div', { className: 'note', 'data-tone': 'warning' }, icon('warn'), h('span', null, 'Quit ChatGPT and any running codex sessions before a copy for every day, or a backup, so your Codex data is complete. ', h('button', { type: 'button', className: 'link', onClick: load }, 'Check again'))) : null,
    ], [btn('Quit', quit), btn('Continue', () => { S.choice ??= { mode: id ? 'daily' : 'try', identity: id ?? '-', backup: c.codex.exists, autoUpdate: true, dock: true }; S.view = 'choose'; render(); }, 'primary', !ready)]];
  },

  unsupported: () => {
    const c = S.check;
    const id = c.identities[0];
    const title = !c.stock.found ? 'ChatGPT for Mac isn’t installed' : 'This ChatGPT is newer than Codex Mods';
    const lead = !c.stock.found ? 'Codex Mods makes its copy from the ChatGPT app. Install ChatGPT for Mac in Applications, then check again.'
      : `Codex Mods needs an adapter for each ChatGPT build, and the one for ${c.stock.version} isn’t out yet. Nothing has changed: keep using ChatGPT, and try again when an update arrives.`;
    return [[
      h('div', { className: 'head' }, h('h1', null, title), h('p', { className: 'lead' }, lead)),
      group('What it needs', '1 to fix',
        row('ChatGPT for Mac', c.stock.found ? `Version ${c.stock.version} (build ${c.stock.bundle}).${c.newest ? ` Codex Mods supports up to ${c.newest}.` : ''}` : `Not found at ${c.stock.path}`, badge('warning', c.stock.found ? 'Not supported yet' : 'Not found', 'warn')),
        row('Node.js', `Version ${c.node.version}`, c.node.ok ? badge('success', 'Ready', 'ok') : badge('danger', 'Needs 24 or newer', 'warn')),
        row('Signing certificate', id ?? 'None found. You can still make a copy to try it, without one.', id ? badge('success', 'Ready', 'ok') : badge('muted', 'Optional', 'skip'))),
    ], [btn('Quit', quit), btn('Check again', load, 'primary')]];
  },

  choose: () => {
    const c = S.check, ch = S.choice;
    const daily = c.identities.length > 0;
    const pick = (mode) => () => { if (mode === 'daily' && !daily) return; ch.mode = mode; render(); };
    const option = (mode, title, desc, need, enabled) => h('button', { type: 'button', role: 'radio', className: 'option', 'aria-checked': ch.mode === mode ? 'true' : 'false', 'aria-disabled': enabled ? null : 'true', onClick: pick(mode) },
      h('span', { className: 'option-title' }, title), h('span', { className: 'option-desc' }, desc), need ? h('span', { className: 'option-need' }, need) : null);
    const check = (key, label, desc, disabled) => h('label', { className: 'check' },
      h('input', { type: 'checkbox', checked: ch[key] && !disabled, disabled, onChange: (e) => { ch[key] = e.target.checked; } }),
      h('span', { className: 'row-text' }, h('span', { className: 'row-label' }, label), h('span', { className: 'row-desc' }, desc)));
    const identity = daily && c.identities.length > 1 && ch.mode === 'daily'
      ? h('select', { 'aria-label': 'Signing certificate', onChange: (e) => { ch.identity = e.target.value; } }, ...c.identities.map((x) => h('option', { value: x, selected: x === ch.identity }, x))) : null;
    if (ch.mode === 'daily' && !c.identities.includes(ch.identity)) ch.identity = c.identities[0] ?? '-';
    return [[
      h('div', { className: 'head' }, h('h1', null, 'How will you use it?'), h('p', { className: 'lead' }, 'Either way the ChatGPT app is never changed.')),
      h('div', { className: 'options', role: 'radiogroup', 'aria-label': 'How you will use it' },
        option('daily', 'Every day', 'Takes ChatGPT’s place in your Dock. Shares your chats and settings (~/.codex) with the ChatGPT app and the codex command line.', daily ? `Signed with ${ch.identity === '-' ? c.identities[0] : ch.identity}` : 'Needs your Apple Development certificate. None was found.', daily),
        option('try', 'To try it', 'A separate copy beside ChatGPT, with its own sign-in and its own data. Nothing you use today is touched.', 'Signed on this Mac, without your certificate', true)),
      identity,
      h('div', { className: 'card' },
        check('backup', 'Back up your Codex data first', 'A copy of ~/.codex in ~/CodexModsBackup, kept on this Mac', !c.codex.exists),
        check('dock', 'Put it in your Dock', ch.mode === 'daily' ? 'In ChatGPT’s place; uninstalling puts ChatGPT back' : 'Beside ChatGPT; uninstalling takes it out again'),
        check('autoUpdate', 'Rebuild when ChatGPT updates', 'The copy is rebuilt from the new ChatGPT once Codex Mods supports it')),
    ], [btn('Back', () => { S.view = 'check'; render(); }), btn('Build my copy', start, 'primary')]];
  },

  build: () => {
    const j = S.job, ch = S.choice;
    const steps = [
      ['backup', 'Back up your Codex data'],
      ['framework', `Install the framework${S.check.framework ? ` ${S.check.framework}` : ''}`],
      ['copy', 'Build your copy', `Copied from ChatGPT ${S.check.stock.version}, with the adapter for build ${S.check.stock.bundle}, signed and checked to be isolated from ChatGPT`],
      ['dock', ch.mode === 'daily' ? 'Put it in ChatGPT’s place in your Dock' : 'Put it beside ChatGPT in your Dock'],
      ['updates', 'Set how it updates'],
    ];
    const of = (id) => j?.steps?.find((s) => s.id === id);
    const tone = { done: ['success', 'Done', 'ok'], skipped: ['muted', 'Skipped', 'skip'], failed: ['danger', 'Failed', 'warn'], running: ['muted', 'Working', 'spin'] };
    const done = j?.done && !j.error;
    return [[
      h('div', { className: 'head' }, h('h1', null, done ? 'Built' : j?.error ? 'The copy wasn’t built' : 'Building your copy'),
        h('p', { className: 'lead' }, j?.error ? 'Nothing is lost: ChatGPT is unchanged, and your data is where it was.' : done ? 'Your copy is ready.' : 'About two minutes. You can keep working; leave ChatGPT closed until it finishes.')),
      h('div', { className: 'card' }, ...steps.map(([id, label, desc]) => {
        const s = of(id);
        const t = s ? tone[s.status] : null;
        // a step's own word once it is done or skipped; while it runs, and when it failed (the note below says why), what it does
        return row(label, (s?.status === 'done' || s?.status === 'skipped') && s.detail ? s.detail : desc ?? null, t ? badge(t[0], t[1], t[2]) : badge('muted', 'Waiting'));
      })),
      j?.error ? h('div', { className: 'note', 'data-tone': 'danger' }, icon('warn'), h('span', null, j.error)) : null,
      ch.mode === 'daily' && !j?.done ? h('p', { className: 'lead' }, 'macOS may ask to use your signing key once. Choose Always Allow. Codex Mods never asks for your Keychain password otherwise.') : null,
      S.log.length ? h('div', null, h('button', { type: 'button', className: 'link', onClick: () => { S.details = !S.details; render(); } }, S.details ? 'Hide details' : 'Show details')) : null,
      S.details ? h('pre', { className: 'details' }, S.log.slice(-200).join('\n')) : null,
    ], j?.error ? [btn('Quit', quit), btn('Back', () => { S.view = 'choose'; S.job = null; render(); }, 'primary')]
      : [btn('Continue', () => { S.view = 'done'; render(); }, 'primary', !done)]];
  },

  done: () => {
    const r = S.job?.result ?? {};
    const ch = S.choice;
    return [[
      h('div', { className: 'head-row' }, h('span', { className: 'tile', 'data-tone': 'success' }, icon('done')),
        h('div', { className: 'head' }, h('h1', null, 'ChatGPT Mods is ready'), h('p', { className: 'lead' }, `It’s in your Applications folder${r.dock ? (ch.mode === 'daily' ? ' and in your Dock, where ChatGPT was' : ' and in your Dock, beside ChatGPT') : ''}.`))),
      group('What happens next', null,
        row('Sign in once', ch.mode === 'daily' ? 'The copy has its own sign-in. Your chats and settings are already there.' : 'The copy has its own sign-in and its own chats.'),
        row('Add mods from Settings › Mods', 'Recommended mods are listed there. Each one shows what it can do before it runs.'),
        row('Go back any time', 'Open Codex Mods Setup again to uninstall. ChatGPT is never changed, and your mods’ data stays until you delete it.', badge('muted', 'ChatGPT unchanged'))),
    ], [r.backup ? btn('Show the backup', () => api('POST', '/api/reveal', { path: r.backup })) : null, btn('Open ChatGPT Mods', async () => { await api('POST', '/api/open'); quit(); }, 'primary')]];
  },

  installed: () => {
    const i = S.check.installed;
    const running = S.check.running.copy.length > 0;
    return [[
      h('div', { className: 'head' }, h('h1', null, 'Codex Mods is set up'), h('p', { className: 'lead' }, 'Rebuild the copy from the ChatGPT you have now, or uninstall it.')),
      group('Your copy', null,
        row('ChatGPT Mods', i.appPath, badge('success', 'Installed', 'ok')),
        row('How you use it', i.daily ? 'Every day: it shares ~/.codex with ChatGPT' : 'To try it: its own sign-in and its own data'),
        row('Framework', i.framework ? `Version ${i.framework}` : 'Not installed'),
        row('Your mods and their data', i.root)),
      running ? h('div', { className: 'note', 'data-tone': 'warning' }, icon('warn'), h('span', null, 'ChatGPT Mods is open. Quit it to rebuild or uninstall. ', h('button', { type: 'button', className: 'link', onClick: load }, 'Check again'))) : null,
      S.error ? h('div', { className: 'note', 'data-tone': 'danger' }, icon('warn'), h('span', null, S.error)) : null,
    ], [btn('Uninstall…', () => { S.dialog = true; render(); }, 'danger', running), h('span', { className: 'spacer' }),
      btn('Rebuild', () => { S.choice = { mode: i.daily ? 'daily' : 'try', identity: S.check.identities[0] ?? '-', backup: false, autoUpdate: null, dock: i.dock }; start(); }, null, running || (i.daily && !S.check.identities.length)),
      btn('Open ChatGPT Mods', async () => { await api('POST', '/api/open'); quit(); }, 'primary')]];
  },

  uninstalling: () => [[h('div', { className: 'head' }, h('h1', null, 'Uninstalling'), h('p', { className: 'lead' }, 'Putting your Dock back and removing the copy…'))], []],

  uninstalled: () => {
    const j = S.job;
    if (j?.error) return [[h('div', { className: 'head' }, h('h1', null, 'It wasn’t uninstalled'), h('p', { className: 'lead' }, j.error))], [btn('Quit', quit), btn('Back', load, 'primary')]];
    const r = j?.result ?? {};
    const dock = j?.steps?.find((s) => s.id === 'dock');
    return [[
      h('div', { className: 'head' }, h('h1', null, 'Codex Mods is uninstalled'), h('p', { className: 'lead' }, 'ChatGPT is as it was. What you made stays on this Mac until you delete it.')),
      group('What went', null,
        row('ChatGPT Mods and the framework', `${r.removed?.length ?? 0} items removed`, badge('success', 'Removed', 'ok')),
        row('Your Dock', dock?.detail ?? '', badge('success', 'Done', 'ok'))),
      group('What stayed', null,
        row('Your mods, their data and settings', `${r.kept}. Setting up again brings them back; delete the folder to remove them.`, btn('Show in Finder', () => api('POST', '/api/reveal', { path: r.kept }))),
        row('Your Codex data', '~/.codex and any backup in ~/CodexModsBackup are untouched')),
    ], [btn('Quit', quit, 'primary')]];
  },
};

function uninstallDialog() {
  const close = () => { S.dialog = false; render(); };
  return h('div', { className: 'dialog-scrim' }, h('div', { className: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'u-title' },
    h('h2', { id: 'u-title' }, 'Uninstall Codex Mods?'),
    h('ul', null, h('li', null, 'ChatGPT Mods and the framework are removed.'), h('li', null, 'Your Dock is put back as it was.'),
      h('li', null, 'Your mods, their data and settings stay, as do ~/.codex and your backups.')),
    h('div', { className: 'dialog-actions' }, btn('Cancel', close), btn('Uninstall', async () => {
      S.dialog = false; S.view = 'uninstalling'; render();
      try { await api('POST', '/api/uninstall'); S.job = await follow(); } catch (e) { S.job = { done: true, error: e.message }; }
      S.view = 'uninstalled'; render();
    }, 'danger'))));
}

// ---- jobs
async function follow() {
  for (;;) {
    const j = await api('GET', '/api/job');
    S.job = j;
    const copy = j?.steps?.find((s) => s.id === 'copy' && s.status === 'running' && s.detail);
    if (copy && S.log.at(-1) !== copy.detail) S.log.push(copy.detail);
    if (S.view === 'build') render();
    if (!j || j.done) return j;
    await new Promise((r) => setTimeout(r, 600));
  }
}
async function start() {
  S.view = 'build'; S.job = null; S.log = []; S.error = null; render();
  try { await api('POST', '/api/install', { choice: S.choice }); await follow(); } catch (e) { S.job = { done: true, error: e.message, steps: S.job?.steps ?? [] }; }
  render();
}

load();
