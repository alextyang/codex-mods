// A chat's summary wherever it is listed (public-hooks.md §3.13, H7r): `{title, subtitle, icon}`, each field the first rule's that gives
// it; the sidebar row draws all three (its second line, its emoji) and its hover card the title; the palette's rows the title and icon;
// the "@" list's rows all three, and the chip a row inserts says the title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact } from './fake-react.mjs';
import { summaryOf } from '../present/bindings/slots.mjs';
import { sidebarRowTitle, sidebarRowCard } from '../present/bindings/frame.mjs';
import { paletteChat } from '../present/bindings/palette-result.mjs';
import { createMentionSources, summarized } from '../present/mention-sources.mjs';

test('H7r: each field of a summary is the first rule\'s that gives it; the title alone is a title; an icon is an emoji', () => {
  assert.deepEqual(summaryOf([{ item: { subtitle: 'Open' } }, { item: 'Ticket 7' }, { item: { title: 'Other', icon: '🎫', subtitle: 'Closed' } }]),
    { subtitle: 'Open', title: 'Ticket 7', icon: '🎫' });
  assert.equal(summaryOf([{ item: { icon: 'star' } }, { item: { title: '  ' } }]), null, 'a named icon is not drawn; an empty title is none');
  assert.equal(summaryOf([{ item: 'x'.repeat(200) }]).title.length, 120);
});

test('H7r: the sidebar row shows the subtitle as its second line (never over the app\'s) and the icon as its emoji; its hover card the title', () => {
  const apply = sidebarRowTitle.twins[0].slots.summary.apply;
  const row = { title: 'Fix login', emoji: null, statusState: 'idle', ariaLabel: 'Fix login, idle' };
  assert.deepEqual(apply(row, [{ item: { title: 'T-7 Fix login', subtitle: 'Open · P1', icon: '🎫' } }]),
    { title: 'T-7 Fix login', emoji: '🎫', statusState: 'idle', ariaLabel: 'T-7 Fix login, idle', secondaryContent: 'Open · P1' });
  assert.equal(apply({ ...row, secondaryContent: 'the app\'s' }, [{ item: { subtitle: 'mine' } }]).secondaryContent, 'the app\'s');
  assert.deepEqual(apply(row, [{ item: { subtitle: 'only' } }]).title, 'Fix login', 'no title given: its own');
  // a row without an emoji prop (22943 removed it; 20770 never had it): the icon goes before the title, unless the app put something there
  const { emoji: _e, ...bare } = row;
  assert.equal(apply(bare, [{ item: { icon: '🎫' } }]).titlePrefix, '🎫');
  assert.ok(!('emoji' in apply(bare, [{ item: { icon: '🎫' } }])));
  assert.equal(apply({ ...bare, titlePrefix: 'fork' }, [{ item: { icon: '🎫' } }]).titlePrefix, 'fork');
  const card = sidebarRowCard.twins[0].slots.summary.apply;
  assert.equal(card({ threadTitle: 'Fix login', threadTitleValue: 'Fix login' }, [{ item: 'T-7 Fix login' }]).threadTitle, 'T-7 Fix login');
});

test('H7r: a palette row of a chat of this Mac shows its summary\'s title, its icon before it; another row is the app\'s', () => {
  const { React } = createFakeReact();
  const factory = (type, props) => React.createElement(type, props);
  const Row = () => null;
  const ctx = { threadSummary: (id) => (id === 't1' ? { title: 'T-7 Fix login', icon: '🎫' } : null) };
  const el = paletteChat.render(Row, { title: 'Fix login', result: { kind: 'local', hostId: 'local', threadId: 't1' } }, factory, ctx);
  assert.equal(el.props.title, '🎫 T-7 Fix login');
  assert.equal(paletteChat.render(Row, { title: 'Other', result: { kind: 'local', hostId: 'local', threadId: 't2' } }, factory, ctx), undefined);
  assert.equal(paletteChat.render(Row, { title: 'Remote', result: { kind: 'local', hostId: 'devbox', threadId: 't1' } }, factory, ctx), undefined, 'another host\'s chat of the same id');
  assert.equal(paletteChat.render(Row, { title: 'Cloud', result: { kind: 'cloud', taskId: 'c' } }, factory, ctx), undefined);
});

test('H7r: the "@" list\'s chat rows read as their summary, still found by their own title; the chip says the summary\'s title', () => {
  const { React, ReactDOM } = createFakeReact();
  const inserted = [];
  class Controller { #own = 'private'; insertAgentMention(m, st) { inserted.push([m, st, this.#own]); } }
  const row = { key: 'thread:local:t1', label: 'Fix login', ariaLabel: 'Fix login', detail: null, searchTerms: ['Fix login'], type: 'mention',
    insertMention: ({ composerController, mentionState }) => composerController.insertAgentMention({ kind: 'agent', name: 'Fix login', displayName: 'Fix login', path: 'thread://t1' }, mentionState) };
  const out = summarized(React, row, { title: 'T-7 Fix login', subtitle: 'Open', icon: '🎫' });
  assert.deepEqual([out.label, out.ariaLabel, out.detail, out.searchTerms], ['T-7 Fix login', 'T-7 Fix login', 'Open', ['Fix login', 'T-7 Fix login']]);
  assert.equal(out.iconElement.props.children, '🎫');
  out.insertMention({ composerController: new Controller(), mentionState: 'S' });
  assert.deepEqual(inserted, [[{ kind: 'agent', name: 'Fix login', displayName: 'T-7 Fix login', path: 'thread://t1' }, 'S', 'private']], 'the app\'s own insert, its private members reached');
  // in the list: through `use`, with the hides
  const ms = createMentionSources({ react: () => React, guard: (r, fn) => fn, env: () => ({}), schedule: (fn) => { fn(); return 1; }, cancel: () => {},
    use: (compute) => compute(), summary: (id) => (id === 't1' ? { title: 'T-7 Fix login' } : null) });
  let got = null;
  const List = (p) => { got = p; return null; };
  ReactDOM.createRoot({}).render(React.createElement(ms.Splice, { Original: List, factory: (type, props) => React.createElement(type, props), draft: null, thread: null,
    props: { query: '', sections: [{ id: 'threads', items: [row, { ...row, key: 'thread:local:t2', label: 'Other' }] }] } }));
  assert.deepEqual(got.sections[0].items.map((x) => x.label), ['T-7 Fix login', 'Other']);
});

test('H7t: a chat the mods hide from the sidebar leaves the palette\'s chat rows (never the one shown), counted in its Hidden section', async () => {
  const { React } = createFakeReact();
  const { hiddenCommandCounts } = await import('../present/bindings/palette-hides.mjs');
  const declared = [{ mod: 'unit.h', id: 'helpers', kind: 'add', presentation: 'Sidebar', slot: 'hidden', data: { hide: { for: 'Thread', where: { title: { $prefix: 'Helper' } } } } }];
  const chats = { t1: { title: 'Helper 1', status: 'idle' }, t2: { title: 'Mine', status: 'idle' } };
  let shown = 'local:none';
  const ctx = { react: () => React, local: { read() {}, touch() {} }, declared: (p, slot) => (p === 'Sidebar' && slot === 'hidden' ? declared : []), whereEnv: () => ({}),
    chainOf: (t) => (t === 'CodexThread' ? ['CodexThread', 'Thread'] : [t]), mountsOf: (id) => (id === 'thread.view' ? [{ props: { conversationId: shown } }] : []),
    thread: (id) => (chats[id] ? { type: 'CodexThread', provider: 'codex', id } : null), subject: (ref) => ({ ref, state: chats[ref.id] }), threadSummary: () => null };
  const factory = (type, props) => React.createElement(type, props);
  const Row = () => null;
  const result = (id) => ({ kind: 'local', hostId: 'local', threadId: id });
  assert.equal(paletteChat.render(Row, { title: 'Helper 1', result: result('t1') }, factory, ctx, null, null, { n: 1 }), null, 'hidden');
  assert.equal(paletteChat.render(Row, { title: 'Mine', result: result('t2') }, factory, ctx, null, null, { n: 2 }), undefined);
  assert.deepEqual(hiddenCommandCounts(ctx, [1, 2]), [['unit.h', 1, ['Helper 1']]]);
  shown = 'local:t1';   // the chat the window shows: never hidden
  assert.equal(paletteChat.render(Row, { title: 'Helper 1', result: result('t1') }, factory, ctx, null, null, { n: 1 }), undefined);
  assert.deepEqual(hiddenCommandCounts(ctx, [1, 2]), []);
});

test('H7t review round 2: a hidden chat found by the search tells that search too; a row gone takes what it told with it', async () => {
  const { React } = createFakeReact();
  const { hiddenCommandCounts, forgetRow } = await import('../present/bindings/palette-hides.mjs');
  const declared = [{ mod: 'unit.h', id: 'helpers', kind: 'add', presentation: 'Sidebar', slot: 'hidden', data: { hide: { for: 'Thread' } } }];
  const ctx = { react: () => React, local: { read() {}, touch() {} }, declared: (p, slot) => (p === 'Sidebar' && slot === 'hidden' ? declared : []), whereEnv: () => ({}),
    chainOf: (t) => (t === 'CodexThread' ? ['CodexThread', 'Thread'] : [t]), mountsOf: () => [], thread: (id) => ({ type: 'CodexThread', provider: 'codex', id }),
    subject: (ref) => ({ ref, state: { title: 'Helper', status: 'idle' } }) };
  const factory = (type, props) => React.createElement(type, props);
  assert.equal(paletteChat.render(() => null, { title: 'Helper', trimmedSearch: 'branch-xyz', result: { kind: 'local', hostId: 'local', threadId: 't1' } }, factory, ctx, null, null, { n: 7 }), null);
  assert.deepEqual(hiddenCommandCounts(ctx, [7]), [['unit.h', 1, ['Helper', 'branch-xyz']]]);
  forgetRow(ctx, 7);
  assert.deepEqual(hiddenCommandCounts(ctx, [7]), []);
});
