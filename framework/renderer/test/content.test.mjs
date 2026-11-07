// Mods' message content (E8.8, docs/design/mod-surfaces.md §3.3): part renderers claim code by language, inline code and links by
// pattern, directives by name; the first rule in order draws, given the app's own rendering; a throw falls back to the app's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReact, rootText } from './fake-react.mjs';
import { createContent, partOf, textOf } from '../present/content.mjs';
import { createRules } from '../present/rules.mjs';
import { createRuleApi, partWhy } from '../../shared/ui-rules-client.mjs';

const rule = (id, part, render, more = {}) => ({ mod: more.mod ?? 'm', id, kind: 'host', presentation: 'ContentView', slot: 'partRenderers', order: more.order ?? 1, data: { part }, fns: { render }, ...more });

function setup({ rules: list = [], subjects = {} } = {}) {
  const { React, ReactDOM } = createFakeReact();
  const site = React.createContext(null);
  const rules = createRules({});
  const conflicts = [];
  const content = createContent({
    react: () => React, rules, chainOf: (t) => (t === 'AgentMessage' ? ['AgentMessage', 'Message'] : [t]), site: () => site,
    use: (compute) => compute(), subjectOf: (at) => (at?.props?.id ? { type: 'AgentMessage', provider: 'codex', id: at.props.id } : null),
    instance: (ref) => subjects[ref.id] ?? null, onConflict: (l, w) => conflicts.push(`${l.mod}/${l.id}>${w.mod}/${w.id}`),
    threadOf: (id) => ({ type: 'CodexThread', provider: 'codex', id }),
  });
  const set = (l) => { rules.reset(l); return content.setRules(rules.all()); };
  set(list);
  // the app's own components, as its markdown gives them
  const Code = (p) => React.createElement('pre', { lang: p.className }, textOf(p.children));
  const Link = (p) => React.createElement('a', { href: p.href }, p.children);
  // the kernel's part wrapper, in short: the mod's part, or the app's own
  const part = (kind, Native) => (props) => { const at = React.useContext(site); return content.parts(kind, Native, props, at) ?? React.createElement(Native, props); };
  const C = part('code', Code), A = part('a', Link);
  const root = ReactDOM.createRoot({});
  return { React, site, rules, content, conflicts, set, Code, Link, C, A, root, render: (el) => { root.render(el); return rootText(root); } };
}

test('partWhy: what a part renderer claims, checked alike by the client and the Host', () => {
  assert.equal(partWhy({ kind: 'code', language: ['chart'] }), null);
  assert.match(partWhy({ kind: 'code', language: [] }), /languages/);
  assert.equal(partWhy({ kind: 'inlineCode', match: { source: '^#\\d+$', flags: '' } }), null);
  assert.match(partWhy({ kind: 'inlineCode', match: { source: '(', flags: '' } }), /pattern/);
  assert.match(partWhy({ kind: 'link', scheme: ['mymod'] }), /https, http, codex/);
  assert.match(partWhy({ kind: 'link' }), /claims a scheme, a host or a pattern/);
  assert.equal(partWhy({ kind: 'link', host: ['github.com'], sites: ['agent-message'] }), null);
  assert.match(partWhy({ kind: 'directive', name: '1x' }), /names its directive/);
  assert.match(partWhy({ kind: 'directive', name: 'x', sites: ['sidebar'] }), /sites are among/);
  assert.match(partWhy({ kind: 'image', host: ['x'] }), /code, inlineCode, link, directive or text/);
  assert.equal(partOf(rule('r', { kind: 'code', language: ['Chart'] }, null)), null, 'no component in this window: not this window\'s part');
  assert.deepEqual([...partOf(rule('r', { kind: 'code', language: ['Chart'] }, () => null)).languages], ['chart']);
});

test('the client: ui.content.* registers one host rule on ContentView partRenderers with its part (RegExp patterns as data)', async () => {
  const sent = [];
  const local = new Map();
  const { api } = createRuleApi({ modId: 'm', realm: 'renderer', channel: { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => {} }, local });
  const R = () => null;
  api.content.code({ id: 'chart', language: 'Chart', sites: 'agent-message', render: R });
  api.content.inlineCode({ id: 'issue', match: /^#\d+$/i, render: R });
  api.content.link({ id: 'gh', host: 'GitHub.com', render: R, for: 'Message' });
  api.content.directive({ id: 'note', name: 'note', groupConsecutive: true, render: R });
  await Promise.resolve();
  assert.deepEqual(sent.map((d) => [d.kind, d.presentation, d.slot, d.data.part]), [
    ['host', 'ContentView', 'partRenderers', { kind: 'code', language: ['Chart'], sites: ['agent-message'] }],
    ['host', 'ContentView', 'partRenderers', { kind: 'inlineCode', match: { source: '^#\\d+$', flags: 'i' } }],
    ['host', 'ContentView', 'partRenderers', { kind: 'link', host: ['github.com'] }],
    ['host', 'ContentView', 'partRenderers', { kind: 'directive', name: 'note', groupConsecutive: true }],
  ]);
  assert.ok(sent.every((d) => d.part === undefined), 'a renderer\'s part is its claim (data), never one of the app\'s parts');
  assert.equal(sent[2].for, 'Message');
  await new Promise((r) => setImmediate(r));   // accepted: the handle is this window's then
  assert.equal(local.get('m/chart').render, R, 'the component stays in this window');
  assert.throws(() => api.content.link({ id: 'x', scheme: 'mymod', render: R }), /https, http, codex/);
  assert.throws(() => api.content.code({ id: 'y', language: 'x' }), /render/);
  const host = createRuleApi({ modId: 'm', realm: 'host', channel: { register: async () => ({}), dispose: async () => {} } }).api;
  assert.deepEqual(Object.keys(host.content), ['redact'], 'a part is a component: the renderer realm\'s (a redaction is data, either realm\'s)');
});

test('a code block in a claimed language is the mod\'s, given its part and the app\'s own; other languages and inline code stay the app\'s', () => {
  const seen = [];
  const Chart = ({ part, streaming }) => { seen.push({ ...part, streaming }); return `[chart ${part.text}]`; };
  const t = setup({ rules: [rule('chart', { kind: 'code', language: ['chart'] }, Chart)] });
  const { React, C } = t;
  const out = t.render(React.createElement('div', null,
    React.createElement(C, { className: 'language-chart', 'data-code-block-info': 'chart wide', children: 'a,b', rawText: '```chart\na,b\n```', isCodeFenceOpen: false }),
    React.createElement(C, { className: 'language-js', children: 'x()' }),
    React.createElement(C, { inline: true, children: 'chart' })));
  assert.equal(out, '[chart a,b]x()chart');
  assert.deepEqual(seen, [{ language: 'chart', info: 'chart wide', text: 'a,b', raw: '```chart\na,b\n```', open: false, streaming: false }]);
});

test('whileStreaming native: the app\'s own block while the fence is open, the mod\'s once it closes; render (the default) draws it open', () => {
  const t = setup({ rules: [rule('n', { kind: 'code', language: ['a'], whileStreaming: 'native' }, ({ part }) => `[A ${part.text}]`), rule('r', { kind: 'code', language: ['b'] }, ({ streaming }) => `[B ${streaming}]`)] });
  const { React, C } = t;
  assert.equal(t.render(React.createElement(C, { className: 'language-a', children: 'x', isCodeFenceOpen: true })), 'x');
  assert.equal(t.render(React.createElement(C, { className: 'language-a', children: 'x', isCodeFenceOpen: false })), '[A x]');
  assert.equal(t.render(React.createElement(C, { className: 'language-b', children: 'y', isCodeFenceOpen: true })), '[B true]');
});

test('a rule that throws: the app\'s own block in its place, the rule off (alone), its mod told; the next rule in order claims afterwards', () => {
  const faults = [];
  const t = setup();
  const { React } = t;
  const rules = createRules({ onFault: (mod, e, key) => faults.push(key) });
  const content = createContent({ react: () => React, rules, chainOf: (x) => [x], site: () => t.site, use: (compute) => compute(), subjectOf: () => null, instance: () => null });
  rules.reset([rule('bad', { kind: 'code', language: ['x'] }, () => { throw new Error('boom'); }, { order: 1 }), rule('good', { kind: 'code', language: ['x'] }, () => '[good]', { mod: 'n', order: 2 })]);
  content.setRules(rules.all());
  const P = (props) => content.parts('code', t.Code, props, null) ?? React.createElement(t.Code, props);
  assert.equal(t.render(React.createElement(P, { className: 'language-x', children: 'raw' })), 'raw', 'the app\'s own block');
  assert.deepEqual(faults, ['m/bad']);
  assert.equal(t.render(React.createElement(P, { className: 'language-x', children: 'raw', key: 2 })), '[good]');
});

test('claims: the first rule in order draws a part; another that claims it too is told it lost (once)', () => {
  const t = setup({ rules: [rule('late', { kind: 'link', host: ['example.com'] }, () => '[late]', { mod: 'b', order: 5 }), rule('early', { kind: 'link', scheme: ['https'] }, () => '[early]', { mod: 'a', order: 2 })] });
  const { React, A } = t;
  assert.equal(t.render(React.createElement(A, { href: 'https://docs.example.com/x', children: 'docs' })), '[early]');
  t.render(React.createElement(A, { href: 'https://example.com/y', children: 'y', key: 'b' }));
  assert.deepEqual(t.conflicts, ['b/late>a/early']);
  assert.equal(t.render(React.createElement(A, { href: 'http://example.com/', children: 'plain' })), '[late]', 'http: only the host rule claims it');
});

test('links: by scheme, host (and its subdomains) and pattern; the part is the href as the app left it, its own text, scheme and host', () => {
  const seen = [];
  const t = setup({ rules: [
    rule('issue', { kind: 'link', host: ['github.com'], match: { source: '/issues/\\d+$', flags: '' } }, ({ part, children }) => { seen.push(part); return ['[issue]', children]; }),
    rule('deep', { kind: 'link', scheme: ['codex'] }, ({ part }) => `[codex ${part.host}]`, { order: 2 }),
    rule('ticket', { kind: 'inlineCode', match: { source: '^PROJ-\\d+$', flags: 'i' } }, ({ part }) => `[ticket ${part.text}]`, { order: 3 }),
  ] });
  const { React, A, C } = t;
  const out = t.render(React.createElement('p', null,
    React.createElement(A, { href: 'https://api.github.com/o/r/issues/12', 'data-markdown-raw-link-label': '#12', title: 'Issue', children: 'issue 12' }),
    React.createElement(A, { href: 'https://github.com/o/r/pulls', children: 'pulls' }),
    React.createElement(A, { href: 'codex://mods/m/open', children: 'open' }),
    React.createElement(A, { href: 'src/a.js', children: 'a.js' }),
    React.createElement(C, { inline: true, children: 'proj-45' })));
  assert.equal(out, '[issue]issue 12pulls[codex mods]a.js[ticket proj-45]');
  assert.deepEqual(seen, [{ href: 'https://api.github.com/o/r/issues/12', text: '#12', title: 'Issue', scheme: 'https', host: 'api.github.com' }]);
});

test('sites and subjects: a markdown site binding tells its site; `sites`, `for` and `where` narrow where a rule draws (outside: the app\'s own)', () => {
  const subjects = { m1: { ref: { type: 'AgentMessage', provider: 'codex', id: 'm1' }, state: { phase: 'final' } }, m2: { ref: { type: 'AgentMessage', provider: 'codex', id: 'm2' }, state: { phase: 'commentary' } } };
  const seen = [];
  const t = setup({ subjects, rules: [
    rule('only-agent', { kind: 'code', language: ['a'], sites: ['agent-message'] }, ({ site, subject }) => { seen.push([site, subject?.id ?? null]); return '[a]'; }),
    rule('final', { kind: 'code', language: ['f'] }, () => '[f]', { for: 'Message', where: { phase: 'final' }, order: 2 }),
  ] });
  const { React, site, C } = t;
  const at = (id, s = 'agent-message') => ({ binding: 'message.agent', site: s, props: { id } });
  const block = (lang, key) => React.createElement(C, { className: `language-${lang}`, children: lang, key });
  const out = t.render(React.createElement('div', null,
    React.createElement(site.Provider, { value: at('m1'), key: 1 }, block('a'), block('f')),
    React.createElement(site.Provider, { value: at('m2'), key: 2 }, block('f')),
    React.createElement(site.Provider, { value: at('u1', 'user-message'), key: 3 }, block('a')),
    block('a', 'bare'), block('f', 'bare2')));
  assert.equal(out, '[a][f]faaf', 'for/where need a subject that covers them; elsewhere the app\'s own');
  assert.deepEqual(seen, [['agent-message', 'm1']]);
});

test('directives: the mods\' names join the app\'s defaults as one stable component per name; a name of the app\'s stays the app\'s; where it renders, the first rule that covers the site draws it', () => {
  const seen = [];
  const Note = ({ part, children }) => { seen.push(part); return ['[note ', part.attributes.title, ': ', children, ']']; };
  const t = setup({ rules: [rule('note', { kind: 'directive', name: 'note', groupConsecutive: true }, Note), rule('mine', { kind: 'directive', name: 'appnote' }, () => 'x', { order: 2 }), rule('twice', { kind: 'directive', name: 'note' }, () => 'y', { mod: 'z', order: 3 })] });
  const { React, content } = t;
  const AppNote = () => 'app';
  const defaults = { appnote: AppNote };
  const d1 = content.directives({ conversationId: 't' }, defaults);
  const d2 = content.directives({ conversationId: 'u' }, defaults);
  assert.deepEqual(Object.keys(d1).sort(), ['appnote', 'note']);
  assert.equal(d1.appnote, AppNote, 'the app\'s own name');
  assert.equal(d1.note, d2.note, 'one stable component per name (the app renders a directive as a component type)');
  assert.equal(d1.note.groupConsecutive, true);
  assert.deepEqual(t.conflicts, ['m/mine>app/appnote']);
  const out = t.render(React.createElement(d1.note, { name: 'note', attributes: { title: 'T' }, isBlock: true, isLastBlock: false, rawText: 'body', children: 'body' }));
  assert.equal(out, '[note T: body]');
  assert.deepEqual(t.conflicts.sort(), ['m/mine>app/appnote', 'z/twice>m/note'], 'both cover the site: the later is told');
  assert.deepEqual(seen, [{ name: 'note', attributes: { title: 'T' }, rawText: 'body', isBlock: true, isLastBlock: false }]);
  assert.equal(content.directives({}, defaults) === defaults, false);
  assert.equal(t.set([]), true, 'the names changed: the sites render again');
  assert.equal(content.directives({}, defaults), defaults, 'no mods\' directives: the app\'s own map');
  assert.equal(t.render(React.createElement(d1.note, { name: 'note', attributes: {}, rawText: 'body', children: 'body', key: 2 })), 'body', 'a rule gone: its text');
});

test('a directive name by site: each rule draws where it covers the site, the first in order where both do', () => {
  const t = setup({ rules: [
    rule('agent', { kind: 'directive', name: 'card', sites: ['agent-message'] }, () => '[agent card]'),
    rule('user', { kind: 'directive', name: 'card', sites: ['user-message'] }, () => '[user card]', { mod: 'n', order: 2 }),
  ] });
  const { React, site, content } = t;
  const D = content.directives({}, {}).card;
  const at = (s) => ({ binding: 'x', site: s, props: {} });
  const out = t.render(React.createElement('div', null,
    React.createElement(site.Provider, { value: at('agent-message'), key: 1 }, React.createElement(D, { name: 'card', attributes: {}, children: 'a' })),
    React.createElement(site.Provider, { value: at('user-message'), key: 2 }, React.createElement(D, { name: 'card', attributes: {}, children: 'b' })),
    React.createElement(D, { name: 'card', attributes: {}, children: 'plain', key: 3 })));
  assert.equal(out, '[agent card][user card]plain');
  assert.deepEqual(t.conflicts, [], 'no site where both draw');
});

test('a part whose rule failed: the next rule that claims it draws in a boundary of its own, in place (no remount from above)', () => {
  const faults = [];
  const { React, ReactDOM } = createFakeReact();
  const site = React.createContext(null);
  const rules = createRules({ onFault: (mod, e, key) => faults.push(key) });
  const content = createContent({ react: () => React, rules, chainOf: (x) => [x], site: () => site, use: (compute) => compute(), subjectOf: () => null, instance: () => null });
  rules.reset([rule('bad', { kind: 'code', language: ['x'] }, () => { throw new Error('boom'); }, { order: 1 }), rule('good', { kind: 'code', language: ['x'] }, () => '[good]', { mod: 'n', order: 2 })]);
  content.setRules(rules.all());
  const Code = (p) => React.createElement('pre', null, p.children);
  const P = (props) => content.parts('code', Code, props, null) ?? React.createElement(Code, props);
  const root = ReactDOM.createRoot({});
  const el = React.createElement(P, { className: 'language-x', children: 'raw' });
  root.render(el);
  assert.equal(rootText(root), 'raw');
  root.render(React.createElement(P, { className: 'language-x', children: 'raw' }));   // the same place: no new key above
  assert.equal(rootText(root), '[good]');
  assert.deepEqual(faults, ['m/bad']);
});

test('patterns: matched in time linear in the text whatever the pattern (review 4, round 2); a lookaround or back-reference is refused; inline code longer than the bound is not tried', () => {
  for (const source of ['(\\w+\\s?)*$', '^(a|aa)+$', '^(a+){20}$', '^((a+))+$', '(?:a|b)+', '^[A-Z]{2,5}-\\d{1,6}$']) assert.equal(partWhy({ kind: 'inlineCode', match: { source, flags: '' } }), null, source);
  for (const source of ['(?=a)', '(?<!a)b', '(a)\\1', '\\k<n>', 'a{1001}']) assert.match(partWhy({ kind: 'inlineCode', match: { source, flags: '' } }), /no lookaround or back-reference/, source);
  assert.match(partWhy({ kind: 'link', match: { source: '\\p{L}', flags: 'u' } }), /no lookaround/);
  // the shapes that backtrack in the engine run here in linear time, and still say what the engine says
  const slow = setup({ rules: [rule('evil', { kind: 'inlineCode', match: { source: '^(a+){20}$', flags: '' } }, () => '[evil]'), rule('alt', { kind: 'inlineCode', match: { source: '^(a|aa)+!$', flags: '' } }, () => '[alt]')] });
  const t0 = Date.now();
  assert.equal(slow.render(slow.React.createElement(slow.C, { inline: true, children: `${'a'.repeat(200)}!` })), `${'a'.repeat(200)}!`.replace(/^.*$/, '[alt]'));
  assert.equal(slow.render(slow.React.createElement(slow.C, { inline: true, children: `${'a'.repeat(250)}?`, key: 2 })), `${'a'.repeat(250)}?`);
  assert.ok(Date.now() - t0 < 500, 'no backtracking');
  const t = setup({ rules: [rule('any', { kind: 'inlineCode', match: { source: 'x', flags: '' } }, () => '[x]')] });
  const { React, C } = t;
  assert.equal(t.render(React.createElement(C, { inline: true, children: 'x' })), '[x]');
  assert.equal(t.render(React.createElement(C, { inline: true, children: 'x'.repeat(300), key: 2 })), 'x'.repeat(300));
});

test('public hooks §3.14 (H7u): through the markdown text seam a site\'s text tokens show the redactions as masks and the text parts\' drawings; the rest is the site\'s own; code is masked', async () => {
  const { redactOf } = await import('../present/content.mjs');
  const redact = (id, r, more = {}) => ({ mod: more.mod ?? 'm', id, kind: 'add', presentation: 'ContentView', slot: 'redact', order: more.order ?? 1, data: { redact: r }, ...more });
  assert.equal(redactOf(redact('x', { match: { source: '(', flags: '' } })), null, 'a pattern that does not compile: none');
  const ticket = (p) => p.React?.createElement?.('b', null, p.part.text) ?? `[${p.part.text}]`;
  const t = setup({ rules: [redact('keys', { match: { source: 'sk-[a-z0-9]+', flags: '' } }), redact('mail', { match: { source: '[a-z]+@x\\.com', flags: '' }, as: '<email>', sites: ['agent-message'] }),
    rule('tick', { kind: 'text', match: { source: 'T-\\d+', flags: '' } }, ticket)] });
  const { React } = t;
  const seen = [];
  // the site's own renderer: the text as the app gives it (escaped), on the token it is given
  const own = (text, key, token) => { seen.push([text, token?.text]); return `{${text}}`; };
  const agent = { textStyle: { kind: 'assistant-message' }, conversationId: 'c1' };
  const render = t.content.textRenderer(agent, own);
  assert.notEqual(render, own);
  assert.equal(t.content.textRenderer(agent, own), render, 'the same renderer while nothing changed (the app memoizes on it)');
  const show = (out) => t.render(React.createElement('p', null, out));
  assert.equal(show(render('key sk-abc123, mail me@x.com &amp; see T-7.', 'p0', { type: 'text', text: 'x' }, true)), '{key }•••{, mail }<email>{ &amp; see }[T-7]{.}');
  assert.deepEqual(seen.find(([x]) => x.includes('see')), [' &amp; see ', ' &amp; see '], 'the rest goes to the site\'s own, escaped as the app gave it, each on a token of its own');
  // the mask shows and copies as its `as`: the original is not in the page
  const maskEl = render('sk-q1', 'p1', null, true);
  assert.deepEqual([maskEl[0].type, maskEl[0].props['data-codexmods-redacted'], maskEl[0].props['data-markdown-copy-text']], ['span', 'm', undefined]);
  // elsewhere (the user's message): the mail redaction is the agent's only
  const user = t.content.textRenderer({ textStyle: { tone: 'user-message' }, conversationId: 'c1' }, own);
  assert.equal(show(user('mail me@x.com, sk-zz', 'p2', null, true)), '{mail me@x.com, }•••');
  assert.equal(user('nothing here', 'p3', null, true), '{nothing here}', 'no match: the site\'s own, once');
  t.set([]);
  assert.equal(t.content.textRenderer(agent, own), own, 'none declared: the site\'s own');
});

test('ui.content.redact and ui.content.text: a redaction is data (either realm), a text part a renderer\'s; the Host checks both', async () => {
  const sent = [];
  const channel = { register: async (d) => { sent.push(d); return { order: 1 }; }, dispose: async () => true, callbacks: () => ({ dispose() {} }) };
  const host = createRuleApi({ modId: 'm', realm: 'host', channel });
  await host.api.content.redact({ id: 'keys', match: /sk-[a-z0-9]+/i, as: '[key]', sites: 'agent-message' }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].presentation, sent[0].slot, sent[0].data], ['add', 'ContentView', 'redact', { redact: { match: { source: 'sk-[a-z0-9]+', flags: 'i' }, as: '[key]', sites: ['agent-message'] } }]);
  for (const bad of [{ id: 'x', match: '(' }, { id: 'x', match: 'a', as: 'x'.repeat(41) }, { id: 'x', match: 'a', sites: ['nowhere'] }]) assert.throws(() => host.api.content.redact(bad), /ui.content.redact/);
  assert.equal(host.api.content.text, undefined, 'a text part draws a component: the renderer realm\'s');
  const page = createRuleApi({ modId: 'm', realm: 'renderer', channel, local: { set() {}, delete() {} } });
  sent.length = 0;
  await page.api.content.text({ id: 't', match: /T-\d+/, render: () => null }).accepted;
  assert.deepEqual([sent[0].kind, sent[0].slot, sent[0].data.part], ['host', 'partRenderers', { kind: 'text', match: { source: 'T-\\d+', flags: '' } }]);
  assert.match(partWhy({ kind: 'text', match: { source: '(?=x)', flags: '' } }), /a text part matches a pattern/);
});

test('H7u review rounds 1 and 2: redactions come first (merged; a text part never takes what one masks, its assertions read the whole text), code is masked in the renderer\'s own tokens in place (given back when no rule masks it), a text too long or too costly is masked whole, no match leaves the text as it was', async () => {
  const redact = (id, source, as, more = {}) => ({ mod: more.mod ?? 'm', id, kind: 'add', presentation: 'ContentView', slot: 'redact', order: more.order ?? 1, data: { redact: { match: { source, flags: '' }, as } }, ...more });
  const all = (p) => `[${p.part.text}]`;
  const t = setup({ rules: [rule('every', { kind: 'text', match: { source: '.+', flags: '' } }, all), redact('a', 'sec', 'A'), redact('b', 'secret', 'B', { order: 2 })] });
  const { React } = t;
  const own = (text) => `{${text}}`;
  const fence = { type: 'code', text: 'key secret here', raw: '```sh\nkey secret here\n```', lang: 'sh' };
  const indented = { type: 'code', codeBlockStyle: 'indented', text: 'a secret\nb', raw: '    a secret\n    b' };
  const span = { type: 'codespan', text: 'a & secret', raw: '`a & secret`' };
  const para = { type: 'paragraph', tokens: [{ type: 'text', text: 'x' }, span] };
  const tokens = [para, fence, { type: 'blockquote', tokens: [indented] }];
  const render = t.content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 'c1', tokens }, own);
  assert.equal(typeof render, 'function');
  // "my secret": the two redactions overlap (one mask, the longest match's); a part's match never overlaps a mask (`.+` from "my " would)
  assert.equal(t.render(React.createElement('p', null, render('my secret!', 'p0', null, true))), '{my }B[!]');
  // code masked in place (the same tokens, their raw written again; inline code is literal)
  assert.deepEqual([fence.text, fence.raw, span.text, span.raw, indented.text, indented.raw, tokens[0]], ['key B here', '```sh\nkey B here\n```', 'a & B', '`a & B`', 'a B\nb', '    a B\n    b', para]);
  // too long to read: one mask
  assert.equal(render('x'.repeat(100_001), 'p1', null, true).length, 1);
  // a text part's assertions read the whole text: `^foo` does not match "foo" after a mask
  t.set([rule('start', { kind: 'text', match: { source: '^foo', flags: '' } }, all), redact('x', 'X', 'M')]);
  const r2 = t.content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 'c1', tokens }, own);
  assert.equal(t.render(React.createElement('p', null, r2('Xfoo', 'p3', null, true))), 'M{foo}');
  assert.equal(fence.text, 'key secret here', 'no rule masks it now: given back');
  // no match and no renderer of the site's: the text as the app gave it (still escaped)
  t.set([redact('a', 'zzz', 'Z')]);
  assert.equal(t.content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 'c1' }, undefined)('a &amp; b', 'p2', null, true), 'a &amp; b');
  // a text part waits for the chat: none named, it draws nothing
  t.set([rule('every', { kind: 'text', match: { source: '.+', flags: '' } }, all)]);
  assert.equal(t.content.textRenderer({ textStyle: { kind: 'assistant-message' } }, own), own);
});

test('H7u review round 1: content reaches a rule only where its mod may read the content\'s subject', () => {
  const { React, ReactDOM } = createFakeReact();
  const rules = createRules({});
  const content = createContent({ react: () => React, rules, chainOf: (t) => [t], site: () => null, use: (c) => c(), subjectOf: () => null, instance: () => null,
    threadOf: (id) => ({ type: 'CodexThread', provider: 'codex', id }), may: (rule) => rule.mod === 'reader' });
  rules.reset([{ mod: 'reader', id: 'r', kind: 'add', presentation: 'ContentView', slot: 'redact', order: 1, data: { redact: { match: { source: 'sk', flags: '' }, as: 'R' } } },
    { mod: 'blind', id: 'b', kind: 'add', presentation: 'ContentView', slot: 'redact', order: 2, data: { redact: { match: { source: 'pw', flags: '' }, as: 'B' } } }]);
  content.setRules(rules.all());
  const own = (x) => x;
  const fn = content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 't1' }, own);
  const root = ReactDOM.createRoot({});
  root.render(React.createElement('p', null, fn('sk pw', 'k', null, true)));
  assert.equal(rootText(root), 'R pw', 'the mod that may not read the chat masks nothing');
});

test('F3 copy redaction: chats\' copied content is masked by their redactions, whatever sites they name, the whole text at once; its html left out; a drawn code text keeps its masks; every rule when a chat is not known', async () => {
  const { React } = createFakeReact();
  const rules = createRules({});
  const chat = { type: 'CodexThread', provider: 'codex', id: 't1' };
  const other = { type: 'CodexThread', provider: 'codex', id: 't2' };
  const insts = { t1: { ref: chat, state: { title: 'Secrets' }, links: {} }, t2: { ref: other, state: { title: 'Plain' }, links: {} } };
  const content = createContent({ react: () => React, rules, chainOf: (t) => (t === 'CodexThread' ? ['CodexThread', 'Thread'] : [t]), site: () => null, use: (c) => c(),
    subjectOf: () => null, instance: (ref) => insts[ref.id] ?? null, threadOf: (id) => ({ type: 'CodexThread', provider: 'codex', id }), may: (rule) => rule.mod !== 'blind' });
  const redact = (mod, id, source, as, more = {}) => ({ mod, id, kind: 'add', presentation: 'ContentView', slot: 'redact', order: 1, data: { redact: { match: { source, flags: more.flags ?? '' }, as, ...(more.sites ? { sites: more.sites } : {}) } }, ...(more.where ? { for: 'Thread', where: more.where } : {}) });
  const set = (l) => { rules.reset(l); content.setRules(rules.all()); };
  assert.equal(content.copyMasked('sk-1', [chat]), null, 'no redaction: nothing to do');
  const base = [redact('m', 'keys', 'sk-[0-9]+', '[key]', { sites: ['user-message'] }), redact('blind', 'pw', 'pw', 'B'), redact('m', 'titled', 'secret', '[secret]', { where: { title: 'Secrets' } }),
    redact('m', 'block', 'BEGIN[\\s\\S]*?END', '[block]', { flags: 's' })];
  set(base);
  // a site-limited rule masks a copy too (a copy mixes sites); a mod that may not read the chat masks nothing; a where reads the chat
  assert.equal(content.copyMasked('sk-12 pw secret\nnext sk-3', [chat]), '[key] pw [secret]\nnext [key]');
  // the whole text at once: a pattern across lines (review round 1)
  assert.equal(content.copyMasked('a BEGIN\nsecret line\nEND b', [chat]), 'a [block] b');
  // a mask's text found in a copy proves nothing: it is masked as any text (built review round 2: a raw secret equal to a rule's `as`)
  assert.equal(content.copyMasked('shown [secret] and secret', [chat]), 'shown [[secret]] and [secret]');
  // a code text the page drew masked, copied whole (its Copy button): its masks kept, a match on one or crossing one not masked again
  const code = { type: 'code', text: 'run secret now', raw: '```\nrun secret now\n```' };
  content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 't1', tokens: [code] }, (x) => x);
  assert.equal(code.text, 'run [secret] now');
  set([...base, redact('m', 'cross', '\\[secret\\] now', 'X')]);
  content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 't1', tokens: [code] }, (x) => x);
  assert.equal(code.text, 'run [secret] now', 'drawn from the original: the cross rule does not match it');
  assert.equal(content.copyMasked('run [secret] now', [chat]), 'run [secret] now', 'drawn: kept as drawn');
  assert.equal(content.copyMasked('so run [secret] now', [chat]), 'so run X', 'not exactly drawn: masked as any text (the cross rule and the mask\'s text merged)');
  // the union of the chats' rules (a selection across two chats): a where that holds for one of them masks the copy
  assert.equal(content.copyMasked('a secret', [other]), 'a secret', 'the other chat alone: its where does not hold');
  assert.equal(content.copyMasked('a secret', [other, chat]), 'a [secret]');
  // no chat known: every rule (the safe way), a where and a mod that may not read included
  assert.equal(content.copyMasked('sk-12 pw secret', [null]), '[key] B [secret]');
  // rich: its masked text alone (its html cannot be masked as text: a link's address keeps what it says)
  assert.deepEqual(content.copyMasked({ 'text/plain': '[x](https://e.test/?sk-9)', 'text/html': '<a href="https://e.test/?sk-9">x</a>' }, [chat]), { 'text/plain': '[x](https://e.test/?[key])' });
  assert.equal(await content.copyMasked(Promise.resolve('x sk-4'), [chat]), 'x [key]');
  // a selection's copy: its text masked, its html left out; nothing to mask in another chat's (a where that does not hold) for that rule
  assert.equal(content.copyPart('text/plain', 'sk-1 secret', [chat]), '[key] [secret]');
  assert.equal(content.copyPart('text/html', '<b>sk-1</b>', [chat]), false);
  // a whole chat as Markdown, longer than a token is searched in: still one search (bounded for a copy), never masked whole for its length
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i} has sk-${i} in it, and more words to make it long enough`).join('\n');
  const out = content.copyMasked(long, [chat]);
  assert.ok(long.length > 100_000 && !/sk-\d/.test(out) && out.split('\n').length === 3000 && out.startsWith('line 0 has [key] in it'));
  assert.equal(content.copyMasked('x'.repeat(2_000_001), [chat]), '[block]', 'past a copy\'s bound: one mask, never copied for want of looking');
  // a raw secret equal to another rule's mask is masked (built review round 2)
  set([redact('m', 'sk', 'sk-\\w+', '[masked]'), redact('m', 'cred', 'credential', 'sk-replaced')]);
  assert.equal(content.copyMasked('key sk-replaced', [chat]), 'key [masked]');
  // many matches against many drawn masks: walked in order on the copy's budget (never one scan per match)
  set([redact('m', 'z', 'z', 'a')]);
  const many = { type: 'code', text: 'z'.repeat(50_000), raw: 'x' };
  content.textRenderer({ textStyle: { kind: 'assistant-message' }, conversationId: 't1', tokens: [many] }, (x) => x);
  const t0 = Date.now();
  assert.equal(content.copyMasked(many.text, [chat]), many.text, 'a drawn text of 50,000 masks copied as drawn');
  assert.ok(Date.now() - t0 < 2000);
});
