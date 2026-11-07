// Mods' mention sources (E8.6b, docs/design/mod-surfaces.md §3.6): sections of the app's own "@" list; a row inserts the app's file chip,
// a link or text through the composer's own controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { createMentionSources, mentionOf, rowOf, insertRow } from '../present/mention-sources.mjs';
import { createRuleApi } from '../../shared/ui-rules-client.mjs';
import { hydrate } from '../present/rules.mjs';

const rule = (id, mention, more = {}) => ({ mod: more.mod ?? 'm', id, kind: 'add', presentation: 'Palette', for: 'Draft', slot: 'resultSources', order: 1, fns: { mention }, ...more });

test('mentionOf and rowOf: a source and its rows as checked; a row inserts its title when it says nothing else', () => {
  assert.equal(mentionOf(rule('a', { title: '', search() {} })), null);
  assert.equal(mentionOf(rule('a', { title: 'T' })), null, 'no search');
  assert.deepEqual((({ key, title, last, minQuery, limit, debounceMs }) => ({ key, title, last, minQuery, limit, debounceMs }))(mentionOf(rule('a', { title: ' Tickets ', search() {}, position: 'last', limit: 99 }))),
    { key: 'm/a', title: 'Tickets', last: true, minQuery: 0, limit: 10, debounceMs: 120 });
  assert.equal(rowOf({ id: 'x' }), null);
  assert.deepEqual(rowOf({ id: 'x', title: ' T-1 ' }).insert, { text: 'T-1' });
  assert.deepEqual(rowOf({ id: 'x', title: 'a', insert: { file: '/w/src/' } }).insert, { file: '/w/src/', directory: true });
  assert.deepEqual(rowOf({ id: 'x', title: 'a', insert: { file: 'relative.txt' } }).insert, { text: 'a' }, 'a file chip needs an absolute path');
  assert.deepEqual(rowOf({ id: 'x', title: 'a', insert: { link: { href: 'javascript:x' } } }).insert, { text: 'a' }, 'a link is https, http or codex');
  assert.deepEqual(rowOf({ id: 'x', title: 'Issue 7', insert: { link: { href: 'https://t/7' } } }).insert, { link: { href: 'https://t/7', text: 'Issue 7' } });
});

test('insertRow: the app\'s file chip through insertAtMention; a link or text after the typed @query is cleared', () => {
  const calls = [];
  const c = { insertAtMention: (m, s) => calls.push(['chip', m, s]), clearSuggestion: (s) => calls.push(['clear', s]), insertTextAtSelection: (t) => calls.push(['text', t]), insertCompletionTextAtSelection: (t) => calls.push(['completion', t]) };
  insertRow(rowOf({ id: 'f', title: 'a', insert: { file: '/w/a.txt' } }), c, 'S');
  insertRow(rowOf({ id: 'l', title: 'Issue [7]', insert: { link: { href: 'https://t/7' } } }), c, 'S');
  insertRow(rowOf({ id: 't', title: 'T', insert: { text: 'PROJ-1 ' } }), c, 'S');
  assert.deepEqual(calls, [
    ['chip', { label: 'a.txt', path: '/w/a.txt', fsPath: '/w/a.txt', matchType: 'file' }, 'S'],
    ['clear', 'S'], ['completion', '[Issue \\[7\\]](https://t/7) '],
    ['clear', 'S'], ['text', 'PROJ-1 '],
  ]);
  assert.equal(insertRow(rowOf({ id: 't', title: 'T' }), null, 'S'), false);
});

test('the splice: the mods\' sections after the app\'s leading section (or last), asked with the query and the composer\'s Draft; rows are the app\'s shape', async () => {
  const { React, ReactDOM } = createFakeReact();
  const asked = [];
  const timers = [];
  const ms = createMentionSources({
    react: () => React, guard: (r, fn) => fn, env: (draft, thread) => ({ draft, thread, via: 'mention' }),
    schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {},
  });
  ms.setSources([
    rule('tickets', { title: 'Tickets', search: (q, env) => { asked.push([q, env.draft.id, env.via]); return [{ id: 't1', title: `T ${q}`, description: 'open' }]; } }),
    rule('late', { title: 'Late', position: 'last', minQuery: 2, search: () => [{ id: 'x', title: 'X' }] }),
    rule('none', { title: 'None', search: () => [] }),
  ]);
  let got = null;
  const List = (p) => { got = p; return null; };
  const factory = (type, props) => React.createElement(type, props);
  const draft = { type: 'Draft', provider: 'codex', id: 'th1' };
  const app = [{ id: 'context-actions', items: [] }, { id: 'files', items: [] }];
  const root = ReactDOM.createRoot({});
  const show = (query) => root.render(React.createElement(ms.Splice, { Original: List, factory, draft, thread: null, props: { query, sections: app, onAddContext() {} } }));
  show('');
  assert.deepEqual(got.sections.map((s) => [s.id, s.isLoading]), [['context-actions', undefined], ['codexmods:m/tickets', true], ['codexmods:m/none', true], ['files', undefined]], 'asked: loading, after the leading section');
  while (timers.length) timers.shift()();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [['', 'th1', 'mention']]);
  const t = got.sections.find((s) => s.id === 'codexmods:m/tickets');
  assert.deepEqual({ ...t.items[0], insertMention: typeof t.items[0].insertMention }, { key: 'codexmods:m/tickets/t1', label: 'T', detail: 'open', searchTerms: ['T'], type: 'mention', insertMention: 'function' });
  assert.equal(got.sections.some((s) => s.id === 'codexmods:m/none'), false, 'a source that answered nothing: no section');
  show('ab');
  while (timers.length) timers.shift()();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.sections.map((s) => s.id), ['context-actions', 'codexmods:m/tickets', 'files', 'codexmods:m/late'], 'position last; minQuery met');
  assert.equal(got.sections[1].items[0].label, 'T ab');
  // the row inserts through the list's controller
  const calls = [];
  got.sections[1].items[0].insertMention({ composerController: { clearSuggestion: () => calls.push('clear'), insertTextAtSelection: (x) => calls.push(x) }, mentionState: {} });
  assert.deepEqual(calls, ['clear', 'T ab']);
});

test('an older answer never replaces a newer one; with no source the app\'s list is untouched', async () => {
  const { React, ReactDOM } = createFakeReact();
  const timers = [];
  const answers = [];
  const ms = createMentionSources({ react: () => React, guard: (r, fn) => fn, env: () => ({}), schedule: (fn) => { timers.push(fn); return 0; }, cancel: () => {} });
  let got = null;
  const List = (p) => { got = p; return null; };
  const factory = (type, props) => React.createElement(type, props);
  const app = [{ id: 'files', items: [] }];
  const root = ReactDOM.createRoot({});
  const show = (query) => root.render(React.createElement(ms.Splice, { Original: List, factory, draft: null, thread: null, props: { query, sections: app } }));
  show('a');
  assert.equal(got.sections, app, 'no sources: the app\'s own sections');
  ms.setSources([rule('s', { title: 'S', search: (q) => new Promise((r) => answers.push(() => r([{ id: q, title: q }]))) })]);
  show('a'); timers.shift()();
  show('ab'); timers.shift()();
  answers[1](); await new Promise((r) => setImmediate(r));
  answers[0](); await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.sections[0].items.map((i) => i.label), ['ab']);
});

test('the client: ui.composer.mention is one add rule on the composer\'s Palette; in the host realm its search is a callback with its argument', async () => {
  const sent = [];
  const served = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {}, callbacks: (id, reg, invoke) => { served.push(invoke); return { dispose() {} }; } };
  const host = createRuleApi({ modId: 'm', realm: 'host', channel }).api;
  const search = (q, env) => [{ id: q, title: `${q}:${env.via}` }];
  host.composer.mention({ id: 'tickets', title: 'Tickets', search, position: 'last', minQuery: 1 });
  await Promise.resolve();
  assert.deepEqual(sent[0], { kind: 'add', presentation: 'Palette', id: 'tickets', for: 'Draft', slot: 'resultSources', data: { mention: { title: 'Tickets', search: { $fn: 'mention.search' }, position: 'last', minQuery: 1 } }, callbacks: ['mention.search'], reg: sent[0].reg });
  assert.deepEqual(await served[0]('mention.search', { arg: 'x', env: { via: 'mention' } }), [{ id: 'x', title: 'x:mention' }]);
  // the page makes the marker a function of (query, env) that runs the callback through the Host
  const calls = [];
  const h = hydrate({ mod: 'm', id: 'tickets', reg: sent[0].reg, callbacks: ['mention.search'], data: sent[0].data }, (key, reg, path, env) => { calls.push([key, path, env]); return Promise.resolve([]); });
  await h.data.mention.search('q', { via: 'mention' });
  assert.deepEqual(calls, [['m/tickets', 'mention.search', { arg: 'q', env: { via: 'mention' } }]]);
  assert.throws(() => host.composer.mention({ id: 'x', title: 'X' }), /search/);
  assert.throws(() => host.composer.mention({ id: 'x', title: 'X', search, position: 'top' }), /first or last/);
});

test('attachment sources (public hooks §3.14): rows of the "Add" section as the app\'s actions; choosing one picks and attaches to that composer\'s Draft as the mod', async () => {
  const { React, ReactDOM } = createFakeReact();
  const { attachOf } = await import('../present/mention-sources.mjs');
  // the rule API: one add on the composer's Palette with `attach` and its run (pick, then Draft.attach for each)
  const sent = [], kept = new Map(), invoked = [];
  const graph = { invoke: async (ref, op, args) => { invoked.push([ref.id, op, args[0], args[1]?.window?.id ?? null]); return { status: 'done', value: null }; } };
  const { api } = createRuleApi({ modId: 'm', realm: 'renderer', channel: { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => true },
    local: { set: (k, f) => kept.set(k, f), delete: () => {} }, graph: () => graph });
  await api.composer.attachSource({ id: 'clip', title: 'Clipboard history', description: 'a past copy', pick: (env) => [{ text: `from ${env.via}`, name: 'clip.txt' }, { url: 'https://x/1', title: 'X' }] }).accepted;
  assert.deepEqual([sent[0].presentation, sent[0].for, sent[0].slot, sent[0].data.attach], ['Palette', 'Draft', 'resultSources', { title: 'Clipboard history', description: 'a past copy' }]);
  const r = { mod: 'm', id: 'clip', kind: 'add', presentation: 'Palette', for: 'Draft', slot: 'resultSources', order: 1, data: sent[0].data, fns: kept.get('m/clip') };
  assert.equal(attachOf({ ...r, fns: {}, data: { attach: { title: 'T' } } }), null, 'no run in this window: none');
  const W = { type: 'Window', provider: 'codexmods.windows', id: '4' };
  const ms = createMentionSources({ react: () => React, guard: (rule, fn) => fn, env: (draft, thread) => ({ draft, thread, window: W, via: 'mention' }), schedule: (fn) => { fn(); return 1; }, cancel: () => {} });
  ms.setSources([r]);
  let got = null;
  const List = (p) => { got = p; return null; };
  const factory = (type, props) => React.createElement(type, props);
  const draft = { type: 'Draft', provider: 'codex', id: 'th1' };
  const root = ReactDOM.createRoot({});
  const show = (query, sections) => root.render(React.createElement(ms.Splice, { Original: List, factory, draft, thread: null, props: { query, sections } }));
  show('', [{ id: 'context-actions', items: [{ key: 'context-action:pick-local-files', label: 'Photos & files', type: 'action' }] }, { id: 'files', items: [] }]);
  const add = got.sections[0];
  assert.deepEqual(add.items.map((x) => [x.key, x.label, x.type]), [['context-action:pick-local-files', 'Photos & files', 'action'], ['codexmods:attach:m/clip', 'Clipboard history', 'action']], 'after the app\'s own');
  await add.items[1].action();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(invoked, [['th1', 'attach', { text: 'from attach', name: 'clip.txt' }, '4'], ['th1', 'attach', { url: 'https://x/1', title: 'X' }, '4']], 'each to the window it was chosen in');
  show('clip', [{ id: 'files', items: [] }]);
  assert.deepEqual(got.sections.map((s) => [s.id, s.title ?? null, s.items.length]), [['codexmods:attach', 'Add', 1], ['files', null, 0]], 'the app\'s section not shown: one of ours, first');
  show('zzz', [{ id: 'files', items: [] }]);
  assert.deepEqual(got.sections.map((s) => s.id), ['files'], 'a query it does not match: not offered');
});

test('public hooks §3.14: a row inserts an instance\'s own chip: a File\'s or Folder\'s file chip, an installed Skill\'s skill chip, another\'s title as text', () => {
  const calls = [];
  const c = { insertAtMention: (m, s) => calls.push(['chip', m, s]), insertMention: (m, s) => calls.push(['mention', m, s]), clearSuggestion: (s) => calls.push(['clear', s]), insertTextAtSelection: (t) => calls.push(['text', t]) };
  const ref = (type, id, provider = 'codex') => ({ type, provider, id });
  insertRow(rowOf({ id: 'f', title: 'Spec', insert: { ref: ref('File', '/w/.env'), label: 'README.md' } }), c, 'S');
  insertRow(rowOf({ id: 'd', title: 'src', insert: { ref: ref('Folder', '/w/src') } }), c, 'S');
  insertRow(rowOf({ id: 's', title: 'Review', insert: { ref: ref('Skill', '/u/.codex/skills/review/SKILL.md') } }), c, 'S');
  insertRow(rowOf({ id: 'x', title: 'Ticket 7', insert: { ref: ref('Ticket', 't7', 'unit.m') } }), c, 'S');
  insertRow(rowOf({ id: 'l', title: 'PDF (library)', insert: { ref: ref('Skill', 'library:pdf') } }), c, 'S');
  assert.deepEqual(calls, [
    ['chip', { label: '.env', path: '/w/.env', fsPath: '/w/.env', matchType: 'file' }, 'S'],
    ['chip', { label: 'src', path: '/w/src', fsPath: '/w/src', matchType: 'directory' }, 'S'],
    ['mention', { kind: 'skill', name: 'review', displayName: 'review', path: '/u/.codex/skills/review/SKILL.md', description: '' }, 'S'],
    ['clear', 'S'], ['text', 'Ticket 7'],
    ['clear', 'S'], ['text', 'PDF (library)'],
  ], 'named as the app names it (never the mod\'s label); a library skill not installed: its title as text');
  assert.deepEqual(rowOf({ id: 'b', title: 'B', insert: { ref: { type: 'File' } } }).insert, { text: 'B' }, 'not a ref: its title');
});

test('public hooks §3.12: the chats a mod hides are out of the app\'s Chats section; the footer says how many each mod hides, after the app\'s own footer', () => {
  const { React, ReactDOM } = createFakeReact();
  const hiddenBy = { t2: 'mod.h', t3: 'mod.h', t4: 'mod.k' };
  const notices = [];
  const ms = createMentionSources({ react: () => React, guard: (r, fn) => fn, env: () => ({}), schedule: (fn) => { fn(); return 1; }, cancel: () => {},
    hides: { by: (id) => hiddenBy[id] ?? null, notice: (R, counts) => { notices.push(counts); return counts.map(([mod, n]) => R.createElement('div', { key: mod }, `${n} hidden by ${mod}`)); } } });
  let got = null;
  const List = (p) => { got = p; return null; };
  const factory = (type, props) => React.createElement(type, props);
  const root = ReactDOM.createRoot({});
  const own = React.createElement('span', { key: 'app' }, 'the app\'s footer');
  const chats = (ids) => ({ id: 'threads', title: 'Chats', items: ids.map((id) => ({ key: `thread:local:${id}`, label: id, type: 'mention' })) });
  root.render(React.createElement(ms.Splice, { Original: List, factory, draft: null, thread: null, props: { query: '', footer: own, sections: [chats(['t1', 't2', 't3', 't4']), { id: 'files', items: [] }] } }));
  assert.deepEqual(got.sections[0].items.map((x) => x.label), ['t1']);
  assert.deepEqual(got.sections[1], { id: 'files', items: [] }, 'other sections as they were');
  assert.deepEqual(notices.at(-1), [['mod.h', 2], ['mod.k', 1]]);
  assert.ok(got.footer, 'a footer with the notices');
  // nothing hidden: the app's own props, untouched
  root.render(React.createElement(ms.Splice, { Original: List, factory, draft: null, thread: null, props: { query: '', footer: own, sections: [chats(['t1'])] } }));
  assert.equal(got.footer, own);
});

test('H7p review round 2: the hidden chats are worked out in the runtime\'s `use`, whose reads draw the list again', () => {
  const { React, ReactDOM } = createFakeReact();
  const hidden = { t2: 'mod.h' };
  const used = [];
  const ms = createMentionSources({ react: () => React, guard: (r, fn) => fn, env: () => ({}), schedule: (fn) => { fn(); return 1; }, cancel: () => {},
    use: (compute) => { used.push('reads followed'); return compute(); },
    hides: { by: (id) => hidden[id] ?? null, notice: (R, counts) => counts.map(([mod, n]) => R.createElement('div', { key: mod }, `${n} hidden by ${mod}`)) } });
  let got = null;
  const List = (p) => { got = p; return null; };
  const root = ReactDOM.createRoot({});
  const chats = { id: 'threads', items: ['t1', 't2'].map((id) => ({ key: `thread:local:${id}`, label: id, type: 'mention' })) };
  const draw = () => root.render(React.createElement(ms.Splice, { Original: List, factory: (type, props) => React.createElement(type, props), draft: null, thread: null, props: { query: '', sections: [chats] } }));
  draw();
  assert.deepEqual([got.sections[0].items.map((x) => x.label), used.length > 0], [['t1'], true]);
  delete hidden.t2;   // what decides it changed (the chat began working, or Show): drawn again, it is back
  draw();
  assert.deepEqual(got.sections[0].items.map((x) => x.label), ['t1', 't2']);
});

test('public hooks §3.14: a row\'s context (text or content) goes to the Host when it is picked, with what the composer shows for it', () => {
  assert.equal(rowOf({ id: 'x', title: 'Ticket 7', insert: { context: 'Status: open' } }).insert.context, 'Status: open');
  assert.equal(rowOf({ id: 'x', title: 'T', insert: { text: 'T-7 ', context: { parts: [{ kind: 'text', text: 'Owner: ' }, { kind: 'text', text: 'ana' }] } } }).insert.context, 'Owner: ana');
  assert.equal(rowOf({ id: 'x', title: 'T', insert: { context: '  ' } }).insert.context, undefined);
  const { React, ReactDOM } = createFakeReact();
  const told = [];
  const src = rule('tickets', { title: 'Tickets', search: () => [{ id: 't7', title: 'Ticket 7', insert: { text: 'T-7 ', context: 'Status: open' } }, { id: 't8', title: 'Ticket 8' }] });
  const ms = createMentionSources({ react: () => React, guard: (r, fn) => fn, env: () => ({}), schedule: (fn) => { fn(); return 1; }, cancel: () => {}, mentioned: (draft, entry) => told.push([draft.id, entry]) });
  ms.setSources([src]);
  let got = null;
  const List = (p) => { got = p; return null; };
  const root = ReactDOM.createRoot({});
  const draft = { type: 'Draft', provider: 'codex', id: 'th1' };
  root.render(React.createElement(ms.Splice, { Original: List, factory: (type, props) => React.createElement(type, props), draft, thread: null, props: { query: 'T', sections: [] } }));
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    root.render(React.createElement(ms.Splice, { Original: List, factory: (type, props) => React.createElement(type, props), draft, thread: null, props: { query: 'T', sections: [] } }));
    const items = got.sections.find((s) => s.title === 'Tickets').items;
    const c = { clearSuggestion() {}, insertTextAtSelection() {} };
    items[0].insertMention({ composerController: c, mentionState: 'S' });
    items[1].insertMention({ composerController: c, mentionState: 'S' });
    assert.deepEqual(told, [['th1', { mod: 'm', label: 'T-7', context: 'Status: open' }]], 'only the row with context; its label is what the composer shows');
  });
});

test('layouts D8: an attachment source chosen in a pane\'s composer says that pane', async () => {
  const { React, ReactDOM } = createFakeReact();
  const Pane = React.createContext(null);
  const seen = [];
  const sent = [], kept = new Map(), invoked = [];
  const { api } = createRuleApi({ modId: 'm', realm: 'renderer', channel: { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => true }, local: { set: (k, f) => kept.set(k, f), delete: () => {} }, graph: () => ({ invoke: async (ref, op, args) => { invoked.push(args[1]); return { status: 'done' }; } }) });
  await api.composer.attachSource({ id: 'clip', title: 'Clipboard history', pick: (env) => { seen.push(env.pane); return [{ text: 'x' }]; } }).accepted;
  const r = { mod: 'm', id: 'clip', kind: 'add', presentation: 'Palette', for: 'Draft', slot: 'resultSources', order: 1, data: sent[0].data, fns: kept.get('m/clip') };
  const ms = createMentionSources({ react: () => React, guard: (rule, fn) => fn, paneContext: () => Pane, env: (draft, thread, pane) => ({ draft, thread, pane, via: 'mention' }), schedule: (fn) => { fn(); return 1; }, cancel: () => {} });
  ms.setSources([r]);
  let got = null;
  const List = (p) => { got = p; return null; };
  const root = ReactDOM.createRoot({});
  root.render(React.createElement(Pane.Provider, { value: 'pane-x-1' }, React.createElement(ms.Splice, { Original: List, factory: (type, props) => React.createElement(type, props), draft: { type: 'Draft', provider: 'codex', id: 'th1' }, thread: null, props: { query: '', sections: [{ id: 'files', items: [] }] } })));
  const row = got.sections.flatMap((x) => x.items).find((x) => x.key === 'codexmods:attach:m/clip');
  await row.action();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(seen, ['pane-x-1']);
  assert.deepEqual(invoked, [{ pane: 'pane-x-1' }], 'its attachment goes to that composer, or to none if it has gone');
});
