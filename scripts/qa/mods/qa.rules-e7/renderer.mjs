// qa.rules-e7, renderer realm — QA only (docs/design/systems.md E7.2): one rule on each conversation slot E7 adds. What each rule does is
// visible in the app (data-qa-e7, data-codexmods-action, data-codexmods-badge); what ran is logged to the page console with the prefix
// "qa.rules-e7".
// The QA copy's gh-repo project, and its Setup chat (in the repo project), added to gh-repo's group by the items rule.
const GH_REPO = '434d2a4d-ad4b-41f1-84a3-5c781dcaa4db';
const SETUP = { type: 'CodexThread', provider: 'codex', id: '01a171bc-ad98-7c80-ada3-4c1081e22e09' };

function renderer(ctx) {
  const h = ctx.ui.react.createElement;
  const log = (m) => console.warn(`qa.rules-e7 ${m}`);   // warn: the QA probe keeps warnings and errors
  const region = (name, text) => () => h('div', { 'data-qa-e7': name }, text);
  const rules = [
    ctx.ui.decorate('TurnView', { id: 'turn', actions: [{ id: 't', title: 'E7 turn', run: () => log('turn action ran') }] }),
    ctx.ui.host('TurnView', { id: 'after', slot: 'afterAnswer', render: region('after-answer', 'E7 after the answer') }),
    ctx.ui.decorate('MessageBlock', { id: 'decoration', for: 'UserMessage', badges: [{ id: 'd', text: 'E7', tooltip: 'qa.rules-e7' }] }),
    ctx.ui.host('ThreadView', { id: 'end', slot: 'transcript', render: region('transcript-end', 'E7 at the end of the transcript') }),
    ctx.ui.host('ThreadView', { id: 'above', slot: 'aboveComposer', render: region('above-composer', 'E7 above the composer') }),
    ctx.ui.decorate('Composer', { id: 'tool', actions: [{ id: 'c', title: 'E7 tool', run: () => log('composer action ran') }] }),
    ctx.ui.host('Composer', { id: 'picker', slot: 'pickers', render: () => h('span', { 'data-qa-e7': 'picker' }, 'E7 picker') }),
    ctx.ui.host('Composer', { id: 'header', slot: 'aboveInput', render: region('above-input', 'E7 above the input') }),
    ctx.ui.host('Composer', { id: 'below', slot: 'belowInput', render: region('below-input', 'E7 below the input') }),
    // E7.3, the frame
    ctx.ui.decorate('SidebarItem', { id: 'hover', for: 'Thread', actions: [{ id: 'h', title: 'E7 hover', run: () => log('hover action ran') }] }),
    ctx.ui.decorate('SidebarItem', { id: 'rowmenu', slot: 'contextMenu', actions: [{ id: 'm', title: 'E7 row menu', run: () => log('row menu ran') }] }),
    ctx.ui.decorate('SidebarSection', { id: 'group', actions: [{ id: 's', title: 'E7 group', run: () => log('group action ran') }] }),
    ctx.ui.add('SidebarSection', { id: 'items', slot: 'items', items: (p) => (p && p.ref.id === GH_REPO ? [SETUP] : []) }),
    ctx.ui.host('Sidebar', { id: 'section', slot: 'sections', render: region('sidebar-section', 'E7 sidebar section') }),
    ctx.ui.host('Sidebar', { id: 'footer', slot: 'footer', render: region('sidebar-footer', 'E7 sidebar footer') }),
    ctx.ui.decorate('ThreadHeader', { id: 'title-action', actions: [{ id: 't', title: 'E7 header', run: () => log('header action ran') }] }),
    ctx.ui.add('Menu', { id: 'groups', slot: 'groups', items: [{ id: 'g', title: 'E7 menu group', run: () => log('menu group ran') }] }),
    // E7.4, the side panel
    ctx.ui.host('SidePanel', { id: 'strip', slot: 'toolbar', render: () => h('span', { 'data-qa-e7': 'panel-toolbar' }, 'E7 panel') }),
    ctx.ui.host('FilesView', { id: 'tree-tools', slot: 'toolbar', render: () => h('span', { 'data-qa-e7': 'tree-toolbar' }, 'E7 tree') }),
    ctx.ui.decorate('FilePreview', { id: 'file', actions: [{ id: 'f', title: 'E7 file', run: () => log('file action ran') }] }),
    // E7.5, the panel's views
    ctx.ui.host('TerminalView', { id: 'term-tools', slot: 'toolbar', render: region('terminal-toolbar', 'E7 terminal') }),
    ctx.ui.decorate('BrowserView', { id: 'browser', actions: [{ id: 'b', title: 'E7 browser', run: () => log('browser action ran') }] }),
    // E7.6, settings and attention
    ctx.ui.host('SettingsPage', { id: 'page-section', slot: 'sections', render: region('settings-section', 'E7 settings section') }),
    ctx.ui.host('SettingsPage', { id: 'page-rows', slot: 'rows', render: region('settings-rows', 'E7 settings row') }),
    ctx.ui.decorate('SettingsPage', { id: 'page-act', actions: [{ id: 'p', title: 'E7 page', run: () => log('page action ran') }] }),
    ctx.ui.decorate('AutomationView', { id: 'auto', actions: [{ id: 'a', title: 'E7 automation', run: () => log('automation action ran') }] }),
    ctx.ui.host('AutomationView', { id: 'auto-details', slot: 'details', render: region('automation-details', 'E7 automation details') }),
    ctx.ui.host('DetailView', { id: 'detail', slot: 'sections', for: 'LocalProject', render: region('detail-section', 'E7 detail section') }),
    ctx.ui.decorate('DetailView', { id: 'detail-act', for: 'LocalProject', actions: [{ id: 'd', title: 'E7 detail', run: () => log('detail action ran') }] }),
    // E7.7: an approval card's body; a mod's step's body, badge and action
    ctx.ui.host('RequestCard', { id: 'request-body', slot: 'body', render: region('request-body', 'E7 in the request') }),
    ctx.ui.host('StepBlock', { id: 'step-body', slot: 'body', render: region('step-body', 'E7 step body') }),
    ctx.ui.decorate('StepBlock', { id: 'step-badge', badges: [{ id: 's', text: 'E7 step', tooltip: 'qa.rules-e7' }], actions: [{ id: 'a', title: 'E7 step action', run: () => log('step action ran') }] }),
    // E7.5b: the Changes tab's header row, its controls row's action, a file's header action
    ctx.ui.host('ChangesView', { id: 'changes-header', slot: 'header', render: region('changes-header', 'E7 changes header') }),
    ctx.ui.add('ChangesView', { id: 'changes-tool', slot: 'toolbarActions', items: [{ id: 'c', title: 'E7 changes', run: () => log('changes action ran') }] }),
    ctx.ui.add('DiffView', { id: 'file-act', slot: 'fileActions', items: [{ id: 'f', title: 'E7 file', run: () => log('file action ran') }] }),
    // E7.6c: another mod's question about a chat takes this mod's region in its body and its action
    ctx.ui.host('Dialog', { id: 'ask-body', slot: 'body', for: 'Thread', render: region('ask-body', 'E7 in the question') }),
    ctx.ui.decorate('Dialog', { id: 'ask-act', for: 'Thread', actions: [{ id: 'q', title: 'E7 question', run: () => log('question action ran') }] }),
  ];
  for (const [i, r] of rules.entries()) r.accepted.then((ok) => log(`rule ${i} accepted ${ok}`));
  return () => { for (const r of rules) r.dispose(); };
}

export default { renderer };
