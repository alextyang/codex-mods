// qa.surfaces — QA only: the plug-and-play mod surfaces (docs/design/mod-surfaces.md), written as a mod author would, from the host realm
// (no renderer code). Each callback appends what it was given (its env, P2) to files/env.log, which the native checks read.
import fs from 'node:fs/promises';
import path from 'node:path';

async function host(ctx) {
  const files = path.join(ctx.mod.dataDir, 'files');
  await fs.mkdir(files, { recursive: true });
  const record = (what) => async (env) => {
    await fs.appendFile(path.join(files, 'env.log'), `${JSON.stringify({ t: new Date().toISOString(), what, env })}\n`);
    return { recorded: what };
  };
  // E8.1: actions with callbacks in the host realm, each told what it acts on
  let qaFilter = null;
  const rules = [
    ctx.ui.decorate('MessageBlock', { id: 'message-action', slot: 'actions', actions: [{ id: 'env', title: 'QA env', run: record('message action') }] }),
    ctx.ui.add('Menu', { id: 'thread-menu', slot: 'groups', items: [{ id: 'env', title: 'QA env', run: record('thread menu') }] }),
    ctx.ui.decorate('SidebarItem', { id: 'row-badge', for: 'Thread', badges: [{ id: 'env', text: 'QA', tooltip: 'QA env', run: record('row badge') }] }),
    // E8.4: a menu bar entry with a chord (View, in the mod's own section)
    ctx.ui.menus.add({ id: 'menu-env', title: 'QA Env', in: 'view', keys: 'CmdOrCtrl+Alt+Shift+E', run: record('menu bar') }),
    // E8.5: palette rows: one in the app's own Workspace group, and a group of the mod's own answering "qa <text>"
    ctx.ui.palette.source({ id: 'palette-row', group: 'workspace', items: [{ id: 'env', title: 'QA palette env', keywords: ['codexmods'], run: record('palette row') }] }),
    ctx.ui.palette.source({ id: 'palette-search', title: 'QA notes', trigger: 'qa', minQuery: 0,
      search: async (query) => [{ id: `note-${query || 'empty'}`, title: `QA note: ${query || '(nothing typed)'}`, choose: { run: true } }],
      choose: async (row, env) => record('palette choose')({ ...env, row: row.id }) }),
    // E8.6: a slash command on every composer, told the composer's Draft and thread
    ctx.ui.composer.slash({ id: 'slash-env', name: 'qa-env', title: 'QA env', description: 'Record what this composer is', run: record('slash command') }),
    // E8.7: context menu entries: a chat's (its row's and its header's menus), a file's (the Files and Changes trees)
    ctx.ui.contextMenu.add({ id: 'cm-thread', for: 'Thread', title: 'QA thread entry', run: record('context menu: thread') }),
    ctx.ui.contextMenu.add({ id: 'cm-file', for: 'File', title: 'QA file entry', run: record('context menu: file') }),
    ctx.ui.contextMenu.add({ id: 'cm-automation', for: 'Automation', title: 'QA automation entry', run: record('context menu: automation') }),
    // P5 v2: a host-realm command (a palette row in Mod commands, and a hidden menu entry holding its chord)
    ctx.ui.commands.add({ id: 'qa-cmd', title: 'QA host command', keys: 'CmdOrCtrl+Alt+Shift+Y', keywords: ['codexmods'], run: record('host command') }),
    // graph-layers L3: a thread's badge wherever it is shown; a declared sidebar filter turned on and off from the menu bar, in the window
    // it was run in (the window in front: a Command run through the graph names none); this mod's renderer panel view opened from here;
    // the window's palette opened on a query
    ctx.ui.decorate('Thread', { id: 'subject-badge', badges: [{ id: 's', text: 'QA◆' }], tooltip: 'not drawn anywhere' }),
    qaFilter = ctx.ui.filter('sidebar', { id: 'qa-filter', title: 'QA replies', where: 'Reply' }),
    ctx.ui.commands.add({ id: 'filter-on', title: 'QA filter on', run: async (env) => { await record('filter on')({ ...env, out: await qaFilter.on({ window: env.window }) }); } }),
    ctx.ui.commands.add({ id: 'filter-off', title: 'QA filter off', run: async (env) => { await record('filter off')({ ...env, out: await qaFilter.off({ window: env.window }) }); } }),
    ctx.ui.commands.add({ id: 'panel-open', title: 'QA open notes', run: async (env) => { await record('panel open')({ ...env, out: await ctx.ui.panels.open('notes', { window: env.window }) }); } }),
    // public hooks §3.14: the same view in a modal
    ctx.ui.commands.add({ id: 'panel-modal', title: 'QA notes in a modal', run: async (env) => { await record('panel modal')({ ...env, out: await ctx.ui.panels.open('notes', { window: env.window, placement: 'modal' }) }); } }),
    // ... beside the chat (the window's split layout), and in a new window of its own
    ctx.ui.commands.add({ id: 'panel-split', title: 'QA notes beside the chat', run: async (env) => { await record('panel split')({ ...env, out: await ctx.ui.panels.open('notes', { window: env.window, placement: 'side' }) }); } }),
    ctx.ui.commands.add({ id: 'panel-window', title: 'QA notes in a window', run: async (env) => { await record('panel window')({ ...env, out: await ctx.ui.panels.open('notes', { placement: 'window' }) }); } }),
    ctx.ui.commands.add({ id: 'palette-open', title: 'QA open palette', run: async (env) => { await record('palette open')({ ...env, out: await ctx.graph.invoke(env.window ?? { type: 'Window', provider: 'codexmods.windows', id: '1' }, 'openPalette', ['qa']) }); } }),
    // E8.7b: a project's menu (its sidebar row's "..." and right-click)
    ctx.ui.contextMenu.add({ id: 'cm-project', for: 'Project', title: 'QA project entry', run: record('context menu: project') }),
    // E8.9: a button in the window's title bar, and one in the sidebar's top bar (both the app's own header actions)
    ctx.ui.decorate('TitleBar', { id: 'title-bar', slot: 'right', actions: [{ id: 'qa-bar', title: 'QA bar', run: record('title bar') }] }),
    ctx.ui.decorate('TitleBar', { id: 'side-bar', slot: 'left', actions: [{ id: 'qa-side', title: 'QA side', run: record('sidebar toolbar') }] }),
    ctx.ui.decorate('TitleBar', { id: 'thread-bar', slot: 'thread', actions: [{ id: 'qa-thread', title: 'QA thread', run: record('thread toolbar') }] }),
    ctx.ui.add('TitleBar', { id: 'bar-menu', slot: 'menu', items: [{ id: 'qa-menu', title: 'QA menu item', run: record('title bar menu') }] }),
    // E8.9 verification: the trees' own row slots and an automation's view
    ctx.ui.add('FilesView', { id: 'files-row', slot: 'rowActions', items: [{ id: 'qa-files-row', title: 'QA files row', run: record('files row') }] }),
    ctx.ui.add('ChangesView', { id: 'changes-row', slot: 'fileRowActions', items: [{ id: 'qa-changes-row', title: 'QA changes row', run: record('changes row') }] }),
    ctx.ui.decorate('AutomationView', { id: 'automation', slot: 'actions', actions: [{ id: 'qa-automation', title: 'QA automation', run: record('automation view') }] }),
    ctx.ui.decorate('RequestCard', { id: 'request-actions', slot: 'actions', actions: [{ id: 'qa-request', title: 'QA explain', run: record('request action') }] }),
    // E8.7b: a panel tab's menu (any tab but a file's, which is its File)
    ctx.ui.contextMenu.add({ id: 'cm-tab', for: 'PanelTab', title: 'QA tab entry', run: record('context menu: tab') }),
    // E8.6b: a mention source in the "@" list (searched in the worker): text, a link, and a file chip of this mod's data file
    ctx.ui.composer.mention({ id: 'mention', title: 'QA tickets', search: async (query, env) => {
      await record('mention search')({ ...env, query });
      const q = query.toLowerCase();
      return [
        { id: 'qa-7', title: 'QA-7 crash on start', description: 'text', insert: { text: 'QA-7 ', context: 'QA-7 is a crash on start; its fix codeword is DATE-21.' } },
        { id: 'qa-8', title: 'QA-8 docs', description: 'link', insert: { link: { href: 'https://example.com/qa/8', text: 'QA-8' } } },
        { id: 'env', title: 'env.log', description: 'file', insert: { file: path.join(files, 'env.log') } },
        // public hooks §3.14: an instance's own chip (a File's, a Skill's), named as the app names it
        { id: 'env-ref', title: 'QA env ref', description: 'file ref', insert: { ref: { type: 'File', provider: 'codex', id: path.join(files, 'env.log') } } },
        ...(await ctx.graph.list('Skill').catch(() => [])).filter((x) => /\/pdf\/SKILL\.md$/.test(x.ref.id)).slice(0, 1)
          .map((x) => ({ id: 'skill-ref', title: 'QA pdf skill', description: 'skill ref', insert: { ref: x.ref } })),
      ].filter((r) => !q || r.title.toLowerCase().includes(q));
    } }),
    // E8.3: a composer control on every composer: it writes into that composer's Draft (a chat's, a side chat's, the new chat's)
    ctx.ui.composer.control({ id: 'template', title: 'QA template', run: async (env) => {
      await record('composer control')(env);
      return ctx.graph.invoke(env.draft, 'insert', [{ parts: [{ kind: 'text', text: 'QA template text ' }] }]);
    } }),
  ];
  return () => { for (const r of rules) r.dispose(); };
}

export default { host };
