// The fake renderer's hosting (sdk/testing/renderer-context.mjs): panel tabs, regions and main pages declared through the framework's rule
// API, the app's chats and panel kinds hosted in a mod's places, and a renderer graph that is the test graph's real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createFakeRendererContext, createTestGraph } from '../index.mjs';

const manifest = (permissions) => ({ id: 'example.hosting', version: '1.0.0', name: 'Hosting', framework: '>=1 <2', entry: { renderer: 'renderer.mjs' }, permissions });
const CHAT = { type: 'CodexThread', provider: 'codex', id: 'c1' };

test('a mod hosts a chat in its own page and a panel tab: declared, drawn, and recorded', async (t) => {
  const { ctx, control } = createFakeRendererContext({ manifest: manifest(['ui', 'graph.present:MainRegion,SidePanel,Window']) });
  t.after(() => control.cleanup());
  await control.activate((c) => {
    const R = c.ui.react;
    c.ui.pages.add({ id: 'split', title: 'Split', render: () => R.createElement('main', null, c.ui.host.thread(CHAT), c.ui.host.thread(CHAT, { composer: false, key: 'b' })) });
    c.ui.panel({ id: 'notes', title: 'Notes', render: (p) => R.createElement('p', null, `notes for ${p.thread?.id ?? 'nothing'}`) });
    c.ui.regions.add({ id: 'rail', title: 'Rail', edge: 'right', render: () => R.createElement('aside', null, c.ui.host.tab('review', CHAT)) });
  });
  assert.deepEqual([...control.mainPages.keys(), ...control.panels.keys(), ...control.regions.keys()], ['split', 'notes', 'rail']);
  const page = await control.render('split');
  assert.equal(page.find((n) => n.type === 'hosted-thread').length, 2);
  assert.deepEqual(control.hosted.map((h) => [h.kind, h.composer]), [['thread', true], ['thread', false]]);
  const tab = await control.render('notes', { thread: CHAT });
  assert.match(tab.text(), /notes for c1/);
  await control.render('rail');
  assert.deepEqual(control.hosted.at(-1), { kind: 'tab', tab: 'review', thread: CHAT });
  assert.deepEqual(ctx.ui.host.supported(), { thread: true, transcript: true, tabs: ['review', 'subagents'] });
});

test('a declaration the app would refuse is refused: a panel tab without its grant', async (t) => {
  const { control } = createFakeRendererContext({ manifest: manifest(['ui']) });
  t.after(() => control.cleanup());
  await assert.rejects(control.activate((c) => { c.ui.panel({ id: 'notes', title: 'Notes', render: () => null }); }), (e) => e.code === 'Denied');
  assert.equal(control.panels.size, 0);
});

test('a handle opens what it declared, and its dispose takes the declaration away', async (t) => {
  const { ctx, control } = createFakeRendererContext({ manifest: manifest(['ui', 'graph.present:MainRegion,SidePanel']) });
  t.after(() => control.cleanup());
  let panel, page;
  await control.activate((c) => {
    panel = c.ui.panel({ id: 'notes', title: 'Notes', render: () => null });
    page = c.ui.pages.add({ id: 'split', title: 'Split', render: () => null });
  });
  assert.equal(panel.open(), true);
  assert.equal(page.open(), true);
  assert.deepEqual(control.opened, [{ kind: 'panel', id: 'notes' }, { kind: 'page', id: 'split' }]);
  panel.dispose();
  assert.equal(control.panels.has('notes'), false);
  assert.equal(ctx.ui.pages !== undefined, true);
});

test('given a test graph\'s renderer realm, ctx.graph is the real graph, as the mod', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const codex = g.provider('codex', { CodexAgent: {}, CodexThread: {} });
  const agent = { type: 'CodexAgent', provider: 'codex', id: 'codex' };
  codex.put(agent, { state: { name: 'Codex', icon: 'codex', available: true } });
  codex.put(CHAT, { state: { title: 'Plans', status: 'idle', unread: false, archived: false, origin: 'user', createdAt: 1, updatedAt: 1 }, links: { agent } });
  const mod = await g.mod(fileURLToPath(new URL('./fixtures/graph-mod', import.meta.url)));
  const { ctx, control } = createFakeRendererContext({ manifest: mod.manifest, graph: mod.renderer().graph });
  t.after(() => control.cleanup());
  assert.deepEqual((await ctx.graph.list('Thread')).map((s) => s.state.title), ['Plans']);
  assert.deepEqual(control.invoked, []);
});
