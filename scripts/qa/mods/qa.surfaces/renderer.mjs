// qa.surfaces, renderer realm — QA only: the surfaces whose part is a component (docs/design/mod-surfaces.md), written as a mod author
// would. A panel view ("QA notes", §3.1) beside every chat, opened from the chat's menu or the panels' "+"; its counter lives in the tab's own
// state. "QA log": the bottom panel only, never saved.
function renderer(ctx) {
  const React = ctx.ui.react;
  const h = React.createElement;
  function Notes(view) {
    const clicks = typeof view.state?.clicks === 'number' ? view.state.clicks : 0;
    return h('div', { 'data-qa-surfaces': 'notes', className: 'flex flex-col gap-2 p-3 text-sm' },
      h('div', null, `QA notes beside ${view.thread ? view.thread.id : 'no chat'}`),
      h('button', { type: 'button', onClick: () => view.setState({ clicks: clicks + 1 }) }, `Clicked ${clicks}`));
  }
  const notes = ctx.ui.panel({ id: 'notes', title: 'QA notes', render: Notes });
  // layouts WL4a: a region of the mod's own at the workspace's right edge
  const region = ctx.ui.regions.add({ id: 'region', title: 'QA region', edge: 'right', width: { default: 280, min: 200, max: 480 },
    render: ({ region: r }) => h('div', { 'data-qa-surfaces': 'region', className: 'p-3 text-sm' }, `QA region ${r.size}px`) });
  const regionLeft = ctx.ui.regions.add({ id: 'region-left', title: 'QA left region', edge: 'left', width: { default: 240 },
    render: ({ region: r }) => h('div', { 'data-qa-surfaces': 'region-left', className: 'p-3 text-sm' }, `QA left region ${r.size}px`) });
  // layouts WL5a: a page of the mod's own in the main region, with an action in its header
  const mainPage = ctx.ui.pages.add({ id: 'page', title: 'QA page', header: { actions: () => h('button', { type: 'button', 'data-qa-surfaces': 'page-action' }, 'QA action') },
    render: ({ page: p }) => h('div', { 'data-qa-surfaces': 'page', className: 'p-panel text-sm' }, `QA page ${p.id}`) });
  // layouts WL5b, WL5c: the page reached from the rail and the sidebar's navigation, with a sidebar view of its own; another with none
  // the framework's kit (docs/design/framework-ui.md FU0): each component beside what it should look like in the mockups
  const kitPage = ctx.ui.pages.add({ id: 'kit', title: 'QA kit', render: () => {
    const c = ctx.ui.components;
    const [tab, setTab] = React.useState('a'), [seg, setSeg] = React.useState('GitHub'), [sel, setSel] = React.useState('allow'), [q, setQ] = React.useState(''), [on, setOn] = React.useState(true);
    const row = (label, ...kids) => h('div', { key: label, 'data-qa-kit': label, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'calc(var(--spacing) * 3)', padding: 'calc(var(--spacing) * 2) 0' } }, h('span', { style: { width: 'calc(var(--spacing) * 28)', color: 'var(--color-text-tertiary)', fontSize: 'var(--text-xs)' } }, label), ...kids);
    return h('div', { 'data-qa-surfaces': 'kit', style: { padding: 'calc(var(--spacing) * 6)', maxWidth: 'calc(var(--spacing) * 200)', overflow: 'auto', height: '100%' } },
      row('Glyph', ...['plugin', 'download', 'terminal', 'gear', 'alert', 'shield-alert', 'clock', 'check', 'refresh'].map((n) => h(c.Glyph, { key: n, name: n })), h(c.Glyph, { key: 'spin', name: 'spinner', spinning: true })),
      row('IconTile', h(c.IconTile, { key: 1, glyph: 'plugin' }), h(c.IconTile, { key: 2, glyph: 'clock', size: 'sm' }), h(c.IconTile, { key: 3, glyph: 'alert', size: 'sm', tone: 'danger' }), h(c.IconTile, { key: 4, glyph: 'shield-alert', size: 'sm', tone: 'warning' })),
      row('Badge', h(c.Badge, { key: 1, label: 'Local' }), h(c.Badge, { key: 2, label: 'Stopped', tone: 'danger' }), h(c.Badge, { key: 3, label: 'Needs Codex 25.x', tone: 'warning' }), h(c.Badge, { key: 4, label: 'New', tone: 'info' }), h(c.Badge, { key: 5, label: 'Compatible', tone: 'success', glyph: 'check' }), h(c.Badge, { key: 6, label: 'Reloading', spinning: true })),
      row('Tabs', h(c.Tabs, { key: 1, value: tab, onChange: setTab, ariaLabel: 'QA sections', items: [{ value: 'a', label: 'Settings', icon: 'gear' }, { value: 'b', label: 'Permissions', icon: 'shield-alert', count: 1 }, { value: 'c', label: 'Activity', icon: 'clock', dot: true }] })),
      row('SegmentedControl', h(c.SegmentedControl, { key: 1, value: seg, onChange: setSeg, ariaLabel: 'Install from', options: ['GitHub', 'Folder'] })),
      row('Select', h(c.Select, { key: 1, value: sel, onChange: setSel, ariaLabel: 'QA grant', options: [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask every time' }, { value: 'deny', label: 'Don’t allow' }] }), h(c.Select, { key: 2, value: 'x', disabled: true, ariaLabel: 'QA disabled', options: [{ value: 'x', label: 'Disabled' }] })),
      row('MenuButton', h(c.MenuButton, { key: 1, ariaLabel: 'QA actions', items: [{ label: 'Permissions', icon: 'shield-alert' }, { label: 'Activity', icon: 'clock' }, { separator: true }, { label: 'Reload', icon: 'refresh', disabled: true }, { separator: true }, { label: 'Uninstall…', danger: true }] })),
      row('Checkbox', h(c.Checkbox, { key: 1, checked: on, onChange: setOn, ariaLabel: 'QA check' }), h(c.Checkbox, { key: 2, checked: false, disabled: true, ariaLabel: 'QA disabled check' })),
      row('SearchField', h(c.SearchField, { key: 1, value: q, onChange: setQ, placeholder: 'Search mods' })),
      h('div', { key: 'banners', 'data-qa-kit': 'Banner', style: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 3)', padding: 'calc(var(--spacing) * 2) 0' } },
        h(c.Banner, { tone: 'danger', title: 'Stopped after an error', message: 'Cannot read properties of undefined (reading ‘items’) (src/Notes.jsx:42)', actions: [{ label: 'Reload' }, { label: 'View activity' }] }),
        h(c.Banner, { tone: 'warning', title: 'Doesn’t support Codex 26.1027', message: 'Built for Codex 25.x, so it isn’t loaded.', actions: [{ label: 'Check for updates' }] }),
        h(c.Banner, { tone: 'info', glyph: 'download', title: 'Version 1.3.0 is available', message: 'Fixes for long chats.', actions: [{ label: 'Update' }], onClose: () => {} })),
      h('div', { key: 'empty', 'data-qa-kit': 'EmptyState' }, h(c.EmptyState, { glyph: 'plugin', title: 'No mods installed', description: 'Mods add sidebar sections, status items and panes to Codex.', actions: [{ label: 'Install mod…', primary: true, glyph: 'plus' }] })));
  } });
  const plainPage = ctx.ui.pages.add({ id: 'plain', title: 'QA plain page', render: () => h('div', { 'data-qa-surfaces': 'plain-page', className: 'p-panel text-sm' }, 'QA plain page') });
  const nav = ctx.ui.sidebar.view({ id: 'nav', title: 'QA nav', render: ({ page: p }) => h('div', { 'data-qa-surfaces': 'sidebar-view', className: 'p-3 text-sm' }, `QA sidebar for ${p.id}`) });
  const dest = ctx.ui.destinations.add({ id: 'dest', title: 'QA page', icon: 'Q', open: { page: 'page' }, sidebar: 'nav' });
  const destPlain = ctx.ui.destinations.add({ id: 'dest-plain', title: 'QA plain', open: { page: 'plain' } });
  // layouts WL6: named layouts; "Focus": the chat alone and the sidebar closed; "Review": beside its tabs with the bottom panel open and a region; "Too much": partly impossible; a title-bar item only while "Review" holds
  const focus = ctx.ui.layouts.add({ id: 'focus', title: 'QA Focus', main: 'chat', side: { open: false }, bottom: { open: false }, sidebar: { open: false } });
  const review = ctx.ui.layouts.add({ id: 'review', title: 'QA Review', side: { open: true, size: 520 }, bottom: { open: true, height: 300 }, regions: { 'region-left': { open: false }, region: { open: true, size: 300 } } });
  const fullMode = ctx.ui.layouts.mode('full', { sidebar: { open: false } });
  const reviewNav = ctx.ui.sidebar.view({ id: 'review-nav', title: 'QA review nav', where: { window: { layout: 'qa.surfaces/review' } }, render: () => h('div', { 'data-qa-surfaces': 'review-nav', className: 'p-3 text-sm' }, 'QA sidebar while Review') });
  const once = ctx.ui.layouts.add({ id: 'once', title: 'QA Once', keep: 'once', bottom: { open: false } });
  // WL6's second look: a tab filling the workspace, a tab of the mod's own at the front of each panel, a page's layout
  const tabbed = ctx.ui.layouts.add({ id: 'tabbed', title: 'QA Tab fills', main: 'tab', side: { tab: 'qa.surfaces/notes' }, keys: 'CmdOrCtrl+Alt+Shift+9' });
  const fronts = ctx.ui.layouts.add({ id: 'fronts', title: 'QA Tabs at the front', side: { open: true, tab: 'qa.surfaces/notes', size: 480 }, bottom: { open: true, tab: 'qa.surfaces/log', height: 260 } });
  const paged = ctx.ui.layouts.add({ id: 'paged', title: 'QA Page layout', main: { page: 'plain' }, sidebar: { open: false } });
  const tooMuch = ctx.ui.layouts.add({ id: 'too-much', title: 'QA Too much', side: { open: true, tab: 'no-such-kind' }, regions: { 'no-such-region': { open: true } } });
  const reviewBadge = ctx.ui.host('Window', { id: 'qa-review-banner', slot: 'banner', where: { window: { layout: 'qa.surfaces/review' } }, render: () => h('div', { 'data-qa-surfaces': 'review-banner', className: 'px-4 py-1 text-sm' }, 'QA while Review') });
  const splitBanner = ctx.ui.host('Window', { id: 'qa-split-banner', slot: 'banner', where: { window: { mode: 'split' } }, render: () => h('div', { 'data-qa-surfaces': 'split-banner', className: 'px-4 py-1 text-sm' }, 'QA while split') });
  // layouts WL7: a page of the app's own chats, each a pane: two with their composers, one transcript alone, one that is not there
  const CHATS = ['01a15fc2-1a9f-7c70-9676-8873498ada0b', '01a193c6-a7b8-7aa0-932f-0523ccade01c'];
  const chats = ctx.ui.pages.add({ id: 'chats', title: 'QA chats', render: () => h('div', { 'data-qa-surfaces': 'chats', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gridAutoRows: 'minmax(0, 1fr)', height: '100%', minHeight: 0 } },
    ...CHATS.map((id) => h('div', { key: id, style: { minHeight: 0, minWidth: 0, display: 'flex' } }, ctx.ui.host.thread({ type: 'CodexThread', provider: 'codex', id }))),
    h('div', { key: 'alone', style: { minHeight: 0, minWidth: 0, display: 'flex' } }, ctx.ui.host.thread({ type: 'CodexThread', provider: 'codex', id: CHATS[0] }, { composer: false, key: 'alone' })),
    h('div', { key: 'none', style: { minHeight: 0, minWidth: 0, display: 'flex' } }, ctx.ui.host.thread({ type: 'TestAgentThread', provider: 'qa.test-agent', id: 'nope' }))) });
  const twice = ctx.ui.pages.add({ id: 'chats-twice', title: 'QA one chat twice', render: () => h('div', { 'data-qa-surfaces': 'chats-twice', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100%', minHeight: 0 } },
    ...['a', 'b'].map((key) => h('div', { key, style: { minHeight: 0, minWidth: 0, display: 'flex' } }, ctx.ui.host.thread({ type: 'CodexThread', provider: 'codex', id: CHATS[0] }, { key })))) });
  const tabs = ctx.ui.pages.add({ id: 'tabs', title: 'QA hosted tabs', render: () => h('div', { 'data-qa-surfaces': 'tabs', style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridAutoRows: '320px', height: '100%', minHeight: 0, overflow: 'auto' } },
    ...['review', 'subagents', 'terminal'].map((kind) => h('div', { key: kind, 'data-qa-kind': kind, style: { minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden', border: '1px solid currentColor' } }, ctx.ui.host.tab(kind, { type: 'CodexThread', provider: 'codex', id: '01a191ab-fb5a-7102-987d-33a88680ec06' })))) });
  const alone = ctx.ui.pages.add({ id: 'alone', title: 'QA chat alone', render: () => h('div', { className: 'flex h-full min-h-0 flex-1', 'data-qa-surfaces': 'alone' }, ctx.ui.host.thread({ type: 'CodexThread', provider: 'codex', id: '01a191ab-fb5a-7102-987d-33a88680ec06' }, { composer: false })) });
  // a bottom-only view that stays out of the saved layout
  const log = ctx.ui.panel({ id: 'log', title: 'QA log', targets: ['bottom'], persist: false,
    render: (view) => h('div', { 'data-qa-surfaces': 'log', className: 'p-3 text-sm' }, `QA log beside ${view.thread ? view.thread.id : 'no chat'}`) });
  const open = ctx.ui.add('Menu', { id: 'open-notes', slot: 'groups', items: [{ id: 'open', title: 'Open QA notes', run: () => notes.open() }] });
  // E8.4: a menu of the mod's own in the menu bar, its entry run in the window it was chosen in
  const bar = ctx.ui.menus.add({ id: 'bar-notes', title: 'Open QA Notes', in: { menu: 'QA' }, keys: 'CmdOrCtrl+Alt+Shift+N', run: () => notes.open() });
  // E8.6: a prompt command: its text into the composer
  const prompt = ctx.ui.composer.slash({ id: 'slash-prompt', name: 'qa-prompt', title: 'QA prompt', description: 'Insert the QA prompt', prompt: 'QA prompt text ' });
  // E8.5: a row in the app's Panels group of the palette
  const row = ctx.ui.palette.source({ id: 'palette-notes', group: 'panels', items: [{ id: 'open', title: 'Open QA notes', keywords: ['codexmods'], run: () => notes.open() }] });
  // E8.8: message content. A `qa-chart` block drawn by the mod above the app's own block (kept: Native); inline `QA-<n>` as a tag; links
  // to example.com marked; a `qa-note` directive (the model is asked to write one) drawn as a note. The part's text is the model's: text only.
  const chart = ctx.ui.content.code({ id: 'qa-chart', language: ['qa-chart'], render: ({ part, streaming, Native, nativeProps }) => h('div', { 'data-qa-surfaces': 'chart' },
    h('div', { className: 'text-sm' }, `QA chart: ${part.text.split('\n').filter(Boolean).length} rows${streaming ? ' (streaming)' : ''}, at ${part.language}`),
    h(Native, nativeProps)) });
  const tag = ctx.ui.content.inlineCode({ id: 'qa-tag', match: /^QA-\d+$/, render: ({ part, site, subject }) => h('span', { 'data-qa-surfaces': 'tag', title: `${site} ${subject ? subject.id : 'none'}` }, `[tag ${part.text}]`) });
  const link = ctx.ui.content.link({ id: 'qa-link', host: 'example.com', render: ({ Native, nativeProps }) => h('span', { 'data-qa-surfaces': 'link' }, '[QA link] ', h(Native, nativeProps)) });
  const note = ctx.ui.content.directive({ id: 'qa-note', name: 'qa-note', sites: ['agent-message'], render: ({ part, children }) => h('div', { 'data-qa-surfaces': 'note', className: 'text-sm' },
    `[QA note${part.attributes.title ? `: ${part.attributes.title}` : ''}] `, children ?? part.rawText ?? '') });
  // E8.9a: a page of the mod's own in the app's Settings, in the app's Integrations group
  const page = ctx.ui.settings.page({ id: 'qa-page', title: 'QA page', group: 'integrations', render: ({ mod, page: id }) => h('div', { 'data-qa-surfaces': 'settings-page', className: 'p-3 text-sm' }, `QA settings page ${id} of ${mod}`) });
  // E8.9 verification: a region after an automation's runs
  const footer = ctx.ui.host('SidebarSection', { id: 'section-footer', slot: 'footer', for: 'Project', render: ({ subject }) => h('div', { 'data-qa-surfaces': 'section-footer', className: 'px-8 py-1 text-sm' }, `QA footer of ${subject?.state?.name ?? 'a project'}`) });
  const above = ctx.ui.host('NewThreadView', { id: 'new-above', slot: 'aboveComposer', render: () => h('div', { 'data-qa-surfaces': 'new-above', className: 'text-sm' }, 'QA above the new chat composer') });
  const autoDetails = ctx.ui.host('AutomationView', { id: 'automation-details', slot: 'details', render: () => h('div', { 'data-qa-surfaces': 'automation-details', className: 'p-2 text-sm' }, 'QA automation details') });
  // E8.5b: a drill-in page: "qa drill" gives a row that opens the mod's page in the palette; the page's rows come from the same search
  const drill = ctx.ui.palette.source({ id: 'qa-drill', title: 'QA drill', search: (q, env) => (env?.page
    ? [{ id: `${env.page.id}-row`, title: `QA page row for ${q || 'nothing typed'}`, run: () => { globalThis.document.documentElement.dataset.qaDrill = String(env.page.id); } }]
    : q.toLowerCase().startsWith('qa drill') ? [{ id: 'd1', title: 'QA drill in', choose: { page: { title: 'QA page', placeholder: 'Search the QA page' } } }] : []) });
  // E8.9k: an action after the app's own "Branch prefix" settings row (its Setting, by its state); it marks the row when run
  const rowAction = ctx.ui.decorate('SettingsRow', { id: 'qa-row', for: 'Setting', where: { title: 'Branch prefix' },
    actions: [{ id: 'mark', title: 'QA row action', run: (env) => { globalThis.document.documentElement.dataset.qaRowAction = String(env?.subject?.id ?? env?.subject?.ref?.id ?? 'ran'); } }] });
  // E8.9i: a banner above every page, in the app's own page banner
  const banner = ctx.ui.host('Window', { id: 'qa-banner', slot: 'banner', render: () => h('div', { 'data-qa-surfaces': 'banner', className: 'px-4 py-1 text-sm' }, 'QA banner on every page') });
  // layouts WL2: regions at the rail's own ends, where the app shows the rail
  const railTop = ctx.ui.host('Rail', { id: 'rail-header', slot: 'header', render: () => h('div', { 'data-qa-surfaces': 'rail-header', className: 'text-xs' }, 'QA') });
  const railEnd = ctx.ui.host('Rail', { id: 'rail-footer', slot: 'footer', render: () => h('div', { 'data-qa-surfaces': 'rail-footer', className: 'text-xs' }, 'QA rail') });
  // layouts WL2: the panels' strips (before the side panel's tabs; the bottom panel's after, before and empty)
  const stripTag = (name, text) => () => h('span', { 'data-qa-surfaces': name, className: 'px-1 text-xs' }, text);
  const strips = [
    ctx.ui.host('SidePanel', { id: 'side-before', slot: 'stripBefore', render: stripTag('side-before', 'QA<') }),
    ctx.ui.host('SidePanel', { id: 'side-empty', slot: 'empty', render: stripTag('side-empty', 'QA side empty') }),
    ctx.ui.host('BottomPanel', { id: 'bottom-after', slot: 'toolbar', render: stripTag('bottom-after', 'QA>') }),
    ctx.ui.host('BottomPanel', { id: 'bottom-before', slot: 'stripBefore', render: stripTag('bottom-before', 'QA<') }),
  ];
  // P5: a command listed in the app's own palette, under "Mod commands": it opens the QA notes panel
  const cmd = ctx.ui.commands.add({ id: 'qa-open-notes', title: 'QA open notes', run: () => notes.open() });
  return () => { for (const s of strips) s.dispose(); railTop.dispose(); railEnd.dispose(); notes.dispose(); twice.dispose(); chats.dispose(); fullMode.dispose(); reviewNav.dispose(); once.dispose(); tabs.dispose(); alone.dispose(); tabbed.dispose(); fronts.dispose(); paged.dispose(); focus.dispose(); review.dispose(); tooMuch.dispose(); reviewBadge.dispose(); splitBanner.dispose(); dest.dispose(); destPlain.dispose(); nav.dispose(); plainPage.dispose(); mainPage.dispose(); kitPage.dispose(); region.dispose(); regionLeft.dispose(); log.dispose(); open.dispose(); bar.dispose(); row.dispose(); prompt.dispose(); chart.dispose(); tag.dispose(); link.dispose(); note.dispose(); page.dispose(); cmd.dispose(); autoDetails.dispose(); above.dispose(); footer.dispose(); banner.dispose(); rowAction.dispose(); drill.dispose(); };
}

export default { renderer };
