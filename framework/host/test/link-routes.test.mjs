// Where a link the user opens goes (public-hooks.md §3.14, ui.links.route, H7lr): the mods' routes, through the real registration path (the
// mod's `ui.links.route` in both realms, the Host's registry), decided here and told to framework-main's `links` area.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleRegistry } from '../ui-rules.mjs';
import { createRuleApi } from '../../shared/ui-rules-client.mjs';
import { createLinkRoutes, linkOf } from '../link-routes.mjs';

const settle = () => new Promise((r) => setImmediate(r));

function setup({ runMs } = {}) {
  const ranks = { 'unit.a': 1, 'unit.b': 2 };
  const registry = createRuleRegistry({ presentations: new Map([['Window', new Set(['links'])]]), rankOf: (id) => ranks[id] ?? 9, typeExists: () => true });
  const apis = {};
  const page = new Map();
  const hostRuns = [];
  // unit.a may read every chat; unit.b reads nothing
  const grants = { 'unit.a': ['graph.present', 'graph.read'], 'unit.b': ['graph.present'] };
  for (const id of ['unit.a', 'unit.b']) {
    const hostWho = { id, grants: grants[id], gen: 'g1', realm: 'host' };
    apis[id] = createRuleApi({ modId: id, realm: 'host', channel: {
      register: async (d) => registry.register(hostWho, d), dispose: async (rid) => registry.dispose(hostWho, rid),
      callbacks: (rid, reg, fn) => registry.bindCallbacks(hostWho, rid, reg, async ([path, env]) => { hostRuns.push([id, rid, path]); return fn(path, env); }),
    } }).api;
    const pageWho = { id, grants: grants[id], gen: 'g1', realm: 'renderer', window: 7 };
    apis[`${id}:page`] = createRuleApi({ modId: id, realm: 'renderer', channel: { register: async (d) => registry.register(pageWho, d), dispose: async (rid) => registry.dispose(pageWho, rid) },
      local: { set: (k, fns, reg) => page.set(k, { fns, reg }), delete: (k) => page.delete(k) } }).api;
    // the same mod's page in window 9
    const page9Who = { ...pageWho, window: 9 };
    apis[`${id}:page9`] = createRuleApi({ modId: id, realm: 'renderer', channel: { register: async (d) => registry.register(page9Who, d), dispose: async (rid) => registry.dispose(page9Who, rid) },
      local: { set() {}, delete() {} } }).api;
  }
  const ops = [], notes = [], pageRuns = [];
  const reports = new Set();
  const mainOps = {
    op: async (area, op, args) => { ops.push([area, op, args]); return { ok: true }; },
    onReport: (area, fn) => { const e = { area, fn }; reports.add(e); return { dispose: () => reports.delete(e) }; },
  };
  const windows = {
    runRule: async (windowId, m) => {
      pageRuns.push([windowId, m.key, m.path]);
      const h = windowId === 7 ? page.get(m.key) : null;
      if (!h || h.reg !== m.reg) return { status: 'refused', reason: 'unavailable' };
      await h.fns.items[0].run(m.env);
      return { status: 'done', value: null };
    },
    notify: async (requester, spec, at) => { notes.push([requester.id, requester.name, spec.title, spec.body, at?.windowId, at?.gen]); return { id: 'n' }; },
    genOf: (windowId) => (windowId === 7 ? 41 : windowId === 9 ? 42 : null),
  };
  const links = createLinkRoutes({ rules: registry, mainOps, windows: () => windows, threadOf: (id) => (id === 'conv-1' ? { type: 'CodexThread', provider: 'codex', id } : null),
    chainOf: (t) => (t === 'CodexThread' ? ['CodexThread', 'Thread'] : [t]),
    nameOf: (id) => `Mod ${id}`, ...(runMs ? { runMs } : {}) });
  const report = (r) => { for (const e of reports) if (e.area === 'links') e.fn(r); };
  return { registry, apis, links, ops, notes, pageRuns, hostRuns, report };
}

test('H7lr: a link as a route reads it: its scheme, host, path, whether it is this Mac\'s, and where it was opened from', () => {
  assert.deepEqual({ ...linkOf('https://Example.com/a/b?q=1', 'markdown_link_click') }, { url: 'https://example.com/a/b?q=1', scheme: 'https', host: 'example.com', path: '/a/b', local: false, from: 'message' });
  assert.deepEqual([linkOf('http://localhost:3000/', 'terminal_link_click').local, linkOf('http://app.localhost/').local, linkOf('file:///Users/x/a.html').local, linkOf('mailto:a@b.c').local],
    [true, true, true, false]);
  assert.deepEqual([linkOf('http://x', 'pull_request_link').from, linkOf('http://x', 'open_in_browser_bridge').from, linkOf('not a url')], ['pullRequest', 'app', null]);
});

test('H7lr: the first route in the user\'s order that takes a link decides; app and browser only where the user did not choose, none always (the window says which mod)', async () => {
  const s = setup();
  s.apis['unit.b'].links.route({ id: 'docs-in-app', where: { host: 'docs.example.com' }, open: 'app' });
  s.apis['unit.a'].links.route({ id: 'docs-outside', where: { host: { $glob: '*.example.com' }, from: 'message' }, open: 'browser' });
  s.apis['unit.b'].links.route({ id: 'no-tracker', where: { host: 'tracker.example.net' }, open: 'none' });
  await settle();
  assert.deepEqual(s.ops.at(-1), ['links', 'routes', { active: true }], 'framework-main holds links while a route exists');
  const d = (url, more = {}) => s.links.decide({ windowId: 7, url, initiator: 'markdown_link_click', ...more });
  assert.deepEqual(await d('https://docs.example.com/x'), { open: 'browser', by: { mod: 'unit.a', id: 'docs-outside' } }, 'unit.a first in the user\'s order');
  assert.deepEqual((await d('https://docs.example.com/x', { initiator: 'terminal_link_click' })).by, { mod: 'unit.b', id: 'docs-in-app' }, 'unit.a\'s takes only a message\'s');
  assert.deepEqual(await d('https://docs.example.com/x', { chosen: true }), { open: null }, 'the user chose where: theirs');
  assert.deepEqual((await d('https://tracker.example.net/p', { chosen: true })).open, 'none', 'stopped however it was asked for');
  assert.deepEqual(s.notes, [['unit.b', 'Mod unit.b', 'Link not opened', 'tracker.example.net was stopped by this mod.', 7, 41]], 'in the page it was opened in');
  assert.deepEqual(await d('https://other.org/'), { open: null }, 'no route takes it: the app\'s own');
});

test('H7lr: a route that runs is its mod opening the link itself, in either realm (the page\'s in the window it was opened in); one that does not run leaves it to the next', async () => {
  const s = setup();
  const seen = [];
  s.apis['unit.a'].links.route({ id: 'host-run', where: { host: 'a.test' }, run: (env) => { seen.push(['host', env.link.url, env.window?.id, env.thread?.id ?? null]); } });
  s.apis['unit.a:page'].links.route({ id: 'page-run', where: { host: 'b.test' }, run: (env) => { seen.push(['page', env.link.host, env.window?.id]); } });
  s.apis['unit.b'].links.route({ id: 'fallback', where: { host: 'b.test' }, open: 'app', priority: -1 });
  await settle();
  assert.deepEqual((await s.links.decide({ windowId: 7, url: 'https://a.test/x', conversationId: 'conv-1' })).open, 'handled');
  assert.deepEqual((await s.links.decide({ windowId: 7, url: 'https://b.test/y' })).open, 'handled');
  assert.deepEqual(seen, [['host', 'https://a.test/x', '7', 'conv-1'], ['page', 'b.test', '7']]);
  // opened in a window that does not run it: the next route
  assert.deepEqual(await s.links.decide({ windowId: 9, url: 'https://b.test/y' }), { open: 'app', by: { mod: 'unit.b', id: 'fallback' } });
  // a modified click is the user's: no run
  assert.deepEqual((await s.links.decide({ windowId: 7, url: 'https://a.test/x', chosen: true })).open, null);
  assert.equal(seen.length, 2);
});

test('H7lr: a run still going when its time is up is its mod\'s; one that failed is not; framework-main asks by report and is answered; no route, no hold', async () => {
  const s = setup({ runMs: 30 });
  s.apis['unit.a'].links.route({ id: 'slow', where: { host: 'slow.test' }, run: () => new Promise((r) => setTimeout(r, 200)) });
  s.apis['unit.a'].links.route({ id: 'broken', where: { host: 'broken.test' }, run: () => { throw new Error('no'); } });
  await settle();
  assert.equal((await s.links.decide({ windowId: 7, url: 'https://slow.test/' })).open, 'handled');
  assert.equal((await s.links.decide({ windowId: 7, url: 'https://broken.test/' })).open, 'handled', 'started and failed: it may have opened it, never again');
  assert.match(s.notes.at(-1)[3], /may not have opened/);
  s.report({ event: 'open', requestId: 'r1', windowId: 7, url: 'https://slow.test/', initiator: null, conversationId: null, chosen: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.ops.at(-1), ['links', 'answer', { requestId: 'r1', open: null }]);
  for (const id of ['slow', 'broken']) await s.registry.dispose({ id: 'unit.a', grants: ['graph.present', 'graph.read'], gen: 'g1', realm: 'host' }, id);
  await settle();
  assert.deepEqual(s.ops.at(-1), ['links', 'routes', { active: false }]);
  s.links.dispose();
});

test('H7lr: a route is checked where it is declared and where it is registered: open or run, one of them; a where on the link', async () => {
  const s = setup();
  const r = s.apis['unit.a'].links;
  assert.throws(() => r.route({ id: 'x', open: 'somewhere' }), /open is app, browser or none/);
  assert.throws(() => r.route({ id: 'x' }), /one of them/);
  assert.throws(() => r.route({ id: 'x', open: 'app', run: () => {} }), /one of them/);
  assert.throws(() => r.route({ id: 'x', where: { host: { $nope: 1 } }, open: 'app' }), /where/);
  // the Host checks what a client did not
  const who = { id: 'unit.a', grants: ['graph.present'], gen: 'g1', realm: 'host' };
  assert.throws(() => s.registry.register(who, { kind: 'add', presentation: 'Window', id: 'raw', slot: 'links', data: { route: { open: 'app' }, items: [{ id: 'raw' }] }, reg: 'r1' }), /has no run/);
  assert.throws(() => s.registry.register(who, { kind: 'add', presentation: 'Window', id: 'raw', slot: 'links', data: { route: { handles: true } }, reg: 'r1' }), /has its run/);
  assert.throws(() => s.registry.register({ ...who, grants: [] }, { kind: 'add', presentation: 'Window', id: 'raw', slot: 'links', data: { route: { open: 'app' } } }), /graph.present/);
});

test('H7lr review: a run sees only links from chats its mod may read; a page route holds only in its windows; the app\'s own routes stay its; a run starts only once framework-main still holds the link', async () => {
  const s = setup();
  const seen = [];
  s.apis['unit.b'].links.route({ id: 'reader', run: (env) => { seen.push(['b', env.link.url]); } });
  s.apis['unit.a:page'].links.route({ id: 'page-stop', where: { host: 'w7.test' }, open: 'none' });
  await settle();
  // unit.b reads no chat: a chat's link is not its to see, nor one whose chat the app does not say (a message's, a composer's: round 2)
  assert.deepEqual(await s.links.decide({ windowId: 7, url: 'https://x.test/?token=1', initiator: 'markdown_link_click' }), { open: null });
  assert.deepEqual(await s.links.decide({ windowId: 7, url: 'https://x.test/', conversationId: 'conv-1' }), { open: null });
  assert.deepEqual(await s.links.decide({ windowId: 7, url: 'https://help.test/' }), { open: null });
  assert.deepEqual(seen, []);
  // one that may read every chat sees them
  s.apis['unit.a'].links.route({ id: 'reader-a', where: { host: 'help.test' }, run: (env) => { seen.push(['a', env.link.url]); } });
  await settle();
  assert.equal((await s.links.decide({ windowId: 7, url: 'https://help.test/' })).open, 'handled');
  assert.deepEqual(seen, [['a', 'https://help.test/']]);
  // window 7's route, not window 9's; and the same id registered otherwise in window 9 holds there as window 9 said it (round 2)
  assert.equal((await s.links.decide({ windowId: 7, url: 'https://w7.test/' })).open, 'none');
  assert.notEqual((await s.links.decide({ windowId: 9, url: 'https://w7.test/' })).open, 'none');
  s.apis['unit.a:page9'].links.route({ id: 'page-stop', where: { host: 'w7.test' }, open: 'app' });
  await settle();
  assert.equal((await s.links.decide({ windowId: 7, url: 'https://w7.test/' })).open, 'none', 'window 7 still stops it');
  assert.equal((await s.links.decide({ windowId: 9, url: 'https://w7.test/' })).open, 'app', 'window 9 opens it in the app');
  // the app routes its own: codex: links and chatgpt.com, to no mod's destination or run
  for (const url of ['codex://threads/x', 'https://chatgpt.com/plugins']) assert.deepEqual(await s.links.decide({ windowId: 7, url }), { open: null }, url);
  // framework-main let the app have it already: nothing runs
  const before = seen.length;
  assert.deepEqual(await s.links.decide({ windowId: 7, url: 'https://help.test/' }, async () => false), { open: null });
  assert.equal(seen.length, before);
  // past its time: nothing decided
  assert.deepEqual(await s.links.decide({ windowId: 7, url: 'https://help.test/', expires: Date.now() - 1 }), { open: null });
});
