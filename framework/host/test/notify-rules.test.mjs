// ui.notify (docs/design/public-hooks.md §3.14), the mod's side: checked, sent without its runs, which stay here and run when the user
// chooses an action; update shows it again; dismiss ends it; it goes with the mod. The Host's side: windows provider tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleApi } from '../../shared/ui-rules-client.mjs';

test('ui.notify: the spec goes without its runs; an action the user chose runs here with its env; update replaces it; dismiss and the mod stopping end it', async () => {
  const sent = [], ended = [];
  let tell = null, n = 0;
  const channel = { notify: async (spec) => { sent.push(spec); return `unit.n:n${++n}`; }, notifyEnd: async (id) => { ended.push(id); return true; },
    notices: (fn) => { tell = fn; return { dispose() { tell = null; } }; } };
  const { api, disposeAll } = createRuleApi({ modId: 'unit.n', realm: 'host', channel, graph: () => null });
  const ran = [];
  const h = api.notify({ title: 'Synced', body: 'ok', subject: { type: 'Thread', provider: 'codex', id: 't1' }, actions: [{ id: 'undo', title: 'Undo', run: (env) => ran.push(env) }] });
  assert.equal(await h.shown, 'unit.n:n1');
  const { dedupe, ...first } = sent[0];
  assert.deepEqual(first, { title: 'Synced', body: 'ok', subject: { type: 'Thread', provider: 'codex', id: 't1' }, actions: [{ id: 'undo', title: 'Undo' }] }, 'no function crosses');
  assert.match(dedupe, /^h1-/, 'the handle\'s own identity');
  tell({ id: 'unit.n:n1', action: 'undo', window: { type: 'Window', provider: 'codexmods.windows', id: '7' } });
  tell({ id: 'unit.n:n1', action: 'nope' });
  assert.deepEqual(ran, [{ notification: 'unit.n:n1', action: 'undo', subject: { type: 'Thread', provider: 'codex', id: 't1' }, window: { type: 'Window', provider: 'codexmods.windows', id: '7' } }]);
  assert.equal(await h.update({ title: 'Synced again' }), true);
  assert.deepEqual([sent[1].title, sent[1].dedupe], ['Synced again', dedupe], 'the same identity: it replaces its earlier showing');
  tell({ id: 'unit.n:n2', action: 'undo' });
  assert.equal(ran.length, 2, 'the updated one keeps its runs');
  assert.equal(await h.dismiss(), true);
  assert.deepEqual(ended, ['unit.n:n2']);
  for (const bad of [{}, { title: 'x', kind: 'loud' }, { title: 'x', actions: [{ id: 'a', title: 'A' }] }, { title: 'x', surface: 'banner' }, { title: 'x', dedupe: 'a b' },
    { title: 'x', actions: [1, 2, 3, 4, 5].map((i) => ({ id: `a${i}`, title: 'A', run() {} })) }]) assert.throws(() => api.notify(bad), { code: 'Invalid' });
  disposeAll();
  assert.equal(tell, null, 'the mod stopped: it no longer hears');
});

test('ui.ask with a signal: withdrawn when it aborts (by its token, never shown); already aborted: cancelled at once', async () => {
  const asked = [], withdrawn = [];
  let settle;
  const channel = { ask: (spec) => { asked.push(spec); return new Promise((r) => { settle = r; }); }, askWithdraw: async (t) => { withdrawn.push(t); settle({ cancelled: true, by: 'requester', reason: 'withdrawn' }); return true; } };
  const { api } = createRuleApi({ modId: 'unit.n', realm: 'host', channel, graph: () => null });
  const ac = new AbortController();
  const p = api.ask({ subject: { type: 'Thread', provider: 'codex', id: 't1' }, purpose: 'confirm', title: 'T', message: 'M', actions: [{ id: 'ok', title: 'OK' }], signal: ac.signal });
  assert.equal('signal' in asked[0], false, 'the signal stays here');
  assert.match(asked[0].withdraw, /^[A-Za-z0-9_-]{8,64}$/);
  ac.abort();
  assert.deepEqual(await p, { cancelled: true, by: 'requester', reason: 'withdrawn' });
  assert.deepEqual(withdrawn, [asked[0].withdraw]);
  const done = new AbortController(); done.abort();
  assert.deepEqual(await api.ask({ subject: { type: 'Thread', provider: 'codex', id: 't1' }, purpose: 'confirm', title: 'T', message: 'M', actions: [{ id: 'ok', title: 'OK' }], signal: done.signal }),
    { cancelled: true, by: 'requester', reason: 'withdrawn' });
  assert.equal(asked.length, 1, 'never asked');
});

test('the Host checks a question\'s fields as settings\' declarations (graph-integrity G4.2): at most 12, each its own key, its kind and default, a choice\'s options; a secret text with no default; no scope, requires or needs', async () => {
  const { createUiNs } = await import('../ctx/ui.mjs');
  const got = [];
  const ns = createUiNs({ rules: () => null, windows: () => ({ ask: (asked) => { got.push(asked); return Promise.resolve({ choice: 'ok', by: 'user' }); } }) });
  const scope = { state: { id: 'unit.a', mod: { manifest: { name: 'Unit A' } } } };
  const base = { subject: { type: 'Thread', provider: 'codex', id: 't1' }, purpose: 'confirm', title: 'T', message: 'M', actions: [{ id: 'ok', title: 'OK' }] };
  const every = [
    { key: 'size', kind: 'choice', title: 'Size', default: 's', options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }] },
    { key: 'on', kind: 'toggle', title: 'On', default: false }, { key: 'name', kind: 'text', title: 'Name', default: '' },
    { key: 'token', kind: 'text', control: 'secret', title: 'Token' }, { key: 'count', kind: 'number', title: 'Count', default: 2, min: 1, max: 5 },
    { key: 'at', kind: 'time', title: 'At', default: '09:00' }, { key: 'tint', kind: 'color', title: 'Tint', default: '#336699' }, { key: 'tags', kind: 'list', title: 'Tags', default: [] },
  ];
  await ns.calls.ask(scope, { ...base, fields: every, withdraw: 'tok-12345678' });
  assert.deepEqual(got[0].fields.map((f) => [f.key, f.kind]), every.map((f) => [f.key, f.kind]), 'every kind');
  assert.deepEqual([got[0].fields[0].choices, got[0].fields[3].default, got[0].withdraw], [[{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }], '', 'tok-12345678'], 'a choice\'s options; a secret\'s empty default');
  for (const fields of [Array.from({ length: 13 }, (_, i) => ({ key: `f${i}`, kind: 'text', title: 'L', default: '' })), [{ key: 'a', kind: 'date', title: 'A', default: '' }],
    [{ key: 'a', kind: 'text', title: 'A', default: '' }, { key: 'a', kind: 'text', title: 'B', default: '' }], [{ key: 'c', kind: 'choice', title: 'C', default: 'x', options: [] }],
    [{ key: 't', kind: 'toggle', title: 'T', default: 'yes' }], [{ key: 's', kind: 'text', control: 'secret', title: 'S', default: 'x' }], [{ key: 'n', kind: 'number', title: 'N' }],
    [{ key: 'x', kind: 'text', title: 'X', default: '', scope: 'thread' }], [{ key: 'x', kind: 'text', title: 'X', default: '', requires: 'y' }], [{ group: 'G', items: [] }]]) {
    assert.throws(() => ns.calls.ask(scope, { ...base, fields }), { code: 'Invalid' }, JSON.stringify(fields).slice(0, 80));
  }
  assert.throws(() => ns.calls.ask(scope, { ...base, withdraw: 'short' }), { code: 'Invalid' });
});

test('ui.openIn.add is the ExternalApp choice that adds one entry to the app\'s Open in menus', async () => {
  const registered = [];
  const { api } = createRuleApi({ modId: 'unit.o', realm: 'host', channel: { register: async (d) => { registered.push(d); return { order: 1 }; }, dispose: async () => true,
    callbacks: () => ({ dispose() {} }) }, graph: () => null });
  const h = api.openIn.add({ id: 'qa-editor', title: 'QA editor', description: 'opens it in QA', run: () => {} });
  await h.accepted;
  const said = JSON.stringify(registered[0]);
  assert.ok(said.includes('"QA editor"') && said.includes('ExternalApp') && said.includes('opens it in QA'), 'its entry, a choice of ExternalApp');
  assert.throws(() => api.openIn.add({ id: 'x', title: 'X' }), { code: 'Invalid' });
});

test('ui.hide of a subject (public-hooks.md §3.12): the agent\'s records in each place that shows them; chats and projects out of the sidebar\'s listings with its notice; catalogs are choices', async () => {
  const registered = [];
  const { api } = createRuleApi({ modId: 'unit.h', realm: 'host', channel: { register: async (d) => { registered.push(d); return { order: 1 }; }, dispose: async () => true }, graph: () => null });
  await api.hide('Step', { id: 'quiet', where: { kind: 'read' } }).accepted;
  const [step] = registered;
  assert.deepEqual([step.kind, step.presentation, step.for, step.where], ['hide', 'StepBlock', 'Step', { kind: 'read' }]);
  const helpers = api.hide('Thread', { id: 'helpers', where: { '@unit.h/helper': true } });
  assert.deepEqual(helpers.places, ['Sidebar']);
  await helpers.accepted;
  await api.hide('Project', { id: 'scratch', of: [{ type: 'LocalProject', provider: 'codex', id: 'p9' }] }).accepted;
  assert.deepEqual(registered.slice(1).map((d) => [d.kind, d.presentation, d.slot, d.for ?? null, d.data]), [
    ['add', 'Sidebar', 'hidden', null, { hide: { for: 'Thread', where: { '@unit.h/helper': true } } }],
    ['add', 'Sidebar', 'hidden', null, { hide: { for: 'Project', of: [{ type: 'LocalProject', provider: 'codex', id: 'p9' }] } }]], 'one always-on rule each: never a claim on the sidebar');
  assert.throws(() => api.hide('Thread', { id: 'x', for: 'Project' }), /for is Thread/);
  assert.throws(() => api.hide('Thread', { id: 'x', in: ['SidebarItem'] }), { code: 'Invalid' });
  assert.throws(() => api.hide('Model', { id: 'x' }), /ui.choices\(Model/, 'a catalog\'s entries: its choices');
  const cmd = api.hide('Command', { id: 'nochat', of: [{ type: 'Command', provider: 'codex', id: 'newChat' }] });
  await cmd.accepted;
  assert.deepEqual([cmd.places, registered.at(-1).presentation, registered.at(-1).slot, registered.at(-1).data.hide.for], [['Palette'], 'Palette', 'hidden', 'Command'], 'a command: out of the palette, with its notice');
  assert.throws(() => api.hide('Step', { id: 'x', in: ['SidebarItem'] }), { code: 'Invalid' });
});

test('review: a command runs only where its conditions hold, by its key chord or its context menu, with the subject it applies to', async () => {
  const fns = new Map();
  const T1 = { type: 'CodexThread', provider: 'codex', id: 't1' }, W = { type: 'Window', provider: 'codexmods.windows', id: '7' };
  const things = new Map([['t1', { ref: T1, state: { archived: false } }], ['7', { ref: W, state: { current: T1, fullScreen: false } }]]);
  let readable = true;
  // the Host's list as the mod reads (a where on its attached data, as the palette's): a where on these fake instances' state
  const holdsOn = (x, where) => Object.entries(where).every(([k, v]) => (k.startsWith('@') ? (x.attached?.[k] ?? false) === v : x.state[k] === v));
  const graph = { resolve: async (r) => (readable || r.type !== 'Window' ? things.get(r.id) ?? null : null), types: async () => [{ id: 'Thread', parent: null }, { id: 'CodexThread', parent: 'Thread' }],
    list: async (type, where) => [...things.values()].filter((x) => x.ref.type === type && (readable || type !== 'Window') && holdsOn(x, where ?? {})) };
  const { api } = createRuleApi({ modId: 'unit.c', realm: 'renderer', channel: { register: async () => ({ order: 1 }), dispose: async () => true },
    local: { set: (k, f) => fns.set(k, f), delete: (k) => fns.delete(k) }, graph: () => graph });
  const ran = [];
  await api.commands.add({ id: 'pin', title: 'Pin', keys: 'CmdOrCtrl+Alt+P', appliesTo: 'Thread', where: { archived: false }, when: { fullScreen: false }, run: (env) => ran.push(env.subject) }).accepted;
  const chord = fns.get('unit.c/pin.keys').menuRun, menu = fns.get('unit.c/pin.menu').items[0].run;
  await chord({ window: W, subject: { type: 'App', provider: 'codex', id: 'codex' } });
  await menu({ window: W, subject: T1 });
  assert.deepEqual(ran, [T1, T1], 'the chord runs on the chat the window shows, not the App');
  things.get('t1').state.archived = true;
  await chord({ window: W });
  readable = false; things.get('t1').state.archived = false;
  await chord({ window: W });
  assert.equal(ran.length, 2, 'outside its where, or its window not readable by it: it does not run');
});

test('review: an Open in entry\'s update rebuilds it (its title and run)', async () => {
  const registered = [], kept = new Map();
  const { api } = createRuleApi({ modId: 'unit.o', realm: 'renderer', channel: { register: async (d) => { registered.push(d); return { order: 1 }; }, dispose: async () => true },
    local: { set: (k, f) => kept.set(k, f), delete: () => {} }, graph: () => null });
  const h = api.openIn.add({ id: 'ed', title: 'Old', run: () => 'old' });
  await h.accepted;
  await h.update({ title: 'New', run: () => 'new' });
  const [entry] = kept.get('unit.o/ed').items;
  assert.deepEqual([registered.length, entry.title, entry.run()], [2, 'New', 'new'], 'registered again: its new title and run');
});

test('ui.newThread.starter (public-hooks.md §3.14): the new chat page, the palette and a project\'s menu; each starts its chat in the window and project chosen, the new chat\'s, or none', async () => {
  const fns = new Map(), registered = [], invoked = [];
  const P1 = { type: 'LocalProject', provider: 'codex', id: 'p1' }, P2 = { type: 'LocalProject', provider: 'codex', id: 'p2' }, W = { type: 'Window', provider: 'codexmods.windows', id: '3' };
  let target = { project: P2 }, readable = true;
  const graph = { resolve: async (r) => (readable && r.id === 'new:app:new-conversation' ? { ref: r, state: { target } } : null), invoke: async (ref, op, args) => { invoked.push([ref.id, op, args[0]]); return { status: 'done', value: null }; } };
  const { api } = createRuleApi({ modId: 'unit.s', realm: 'renderer', channel: { register: async (d) => { registered.push(d); return { order: 1 }; }, dispose: async () => true },
    local: { set: (k, f) => fns.set(k, f), delete: (k) => fns.delete(k) }, graph: () => graph });
  const h = api.newThread.starter({ id: 'review', title: 'Review my last commit', description: 'a review of HEAD', spec: (env) => ({ prompt: `Review ${env.via ?? 'it'}`, mode: 'plan' }) });
  assert.deepEqual(h.places, ['newThread', 'palette', 'project']);
  assert.equal(await h.accepted, true);
  assert.deepEqual(['review', 'review.palette', 'review.project'].map((i) => { const d = registered.find((x) => x.id === i); return [d?.presentation, d?.slot, d?.for ?? null]; }),
    [['NewThreadView', 'starters', null], ['Palette', 'resultSources', null], ['Menu', 'groups', 'Project']], 'its declaration (the new chat page\'s entry), the palette\'s row, the project menus\' entry');
  assert.deepEqual(registered.find((d) => d.id === 'review').data.starter, { title: 'Review my last commit', in: ['newThread', 'palette', 'project'], tooltip: 'a review of HEAD' }, 'what it says is data, in either realm');
  const chip = fns.get('unit.s/review').items[0].run, menu = fns.get('unit.s/review.project').items[0].run;
  // the page's button: the framework says the window and the new chat's project
  await chip({ draft: { type: 'Draft', provider: 'codex', id: 'new:app:new-conversation' }, window: W, project: P1, via: 'chip' });
  await chip({ window: W, project: null, via: 'none' });
  await menu({ subject: P1, window: W, via: 'menu' });
  // the palette: the new chat's project, read as the mod
  await chip({ via: 'palette' });
  target = {};
  await chip({});
  assert.deepEqual(invoked, [['p1', 'newThread', { open: true, window: W, prompt: 'Review chip', mode: 'plan' }], ['codex', 'newThread', { open: true, window: W, prompt: 'Review none', mode: 'plan' }],
    ['p1', 'newThread', { open: true, window: W, prompt: 'Review menu', mode: 'plan' }], ['p2', 'newThread', { open: true, prompt: 'Review palette', mode: 'plan' }],
    ['codex', 'newThread', { open: true, prompt: 'Review it', mode: 'plan' }]], 'the page\'s project; none; the menu\'s; the new chat\'s; none: Codex\'s agent');
  readable = false;
  await assert.rejects(chip({}), /cannot be read/, 'a Draft the mod may not read is refused, never taken for none');
  const only = api.newThread.starter({ id: 'plain', title: 'Plain', spec: { prompt: 'x' }, in: 'palette' });
  await only.accepted;
  assert.deepEqual(only.places, ['palette']);
  assert.deepEqual(registered.filter((d) => d.id.startsWith('plain')).map((d) => d.id), ['plain', 'plain.palette'], 'its declaration always, offered in the palette only');
  // one part refused (its declaration's grants, or a place this mod may not present in): all of it goes
  for (const refuse of ['starters', 'resultSources']) {
    const refusing = createRuleApi({ modId: 'unit.n', realm: 'renderer', channel: { register: async (d) => { if (d.slot === refuse) throw new Error('Denied'); return { order: 1 }; }, dispose: async () => true },
      local: { set: (k, f) => fns.set(k, f), delete: (k) => fns.delete(k) }, graph: () => graph }).api;
    const no = refusing.newThread.starter({ id: `no${refuse}`, title: 'No', spec: {} });
    assert.equal(await no.accepted, false);
    assert.equal(no.disposed, true, `${refuse} refused: every entry went`);
  }
  for (const bad of [{ id: 'x', title: 'X' }, { id: 'x', title: 'X', spec: 'text' }, { id: 'x', title: 'X', spec: {}, in: ['sidebar'] }, { id: 'x', title: '', spec: {} },
    { id: 'x', title: 'X', spec: {}, description: 'd'.repeat(121) }, { id: 'x', title: 'X', spec: {}, description: ' ' }]) {
    assert.throws(() => api.newThread.starter(bad), { code: 'Invalid' });
  }
  h.dispose();
  assert.equal(h.disposed, true);
});
