// qa.settings, renderer realm — QA only (docs/design/systems.md E3): what changed, seen from a window; a write from this realm. Its panel
// tab (graph-integrity G3.6) draws its chat-scope settings for the open chat with the kit's SettingRow, as this mod reads and sets them;
// it opens itself once a chat shows.
function renderer(ctx) {
  const R = ctx.ui.react;
  const panel = ctx.ui.panel({ id: 'chat-settings', title: 'QA chat settings', render: (p) => (p.thread
    ? R.createElement('div', { 'data-qa': 'chat-settings' }, ...['mode', 'verbose', 'budget', 'memo'].map((key) => R.createElement(ctx.ui.components.SettingRow, { key, setting: { key, thread: p.thread } })))
    : R.createElement('p', null, 'No chat')) });
  let tries = 0;
  const opener = setInterval(() => { tries++; let opened = false; try { opened = panel.open(); } catch { /* not yet */ } if (opened || tries > 30) clearInterval(opener); }, 2000);
  const sub = ctx.settings.onChange((doc, change) => {
    console.warn(`qa.settings renderer change ${JSON.stringify(change ?? null)}`);
    if (Array.isArray(doc?.tags) && doc.tags.includes('renderer-set') && doc.limit !== 5) {
      ctx.settings.set('limit', 5).then((r) => console.warn(`qa.settings renderer set ${JSON.stringify(r)}`), (e) => console.warn(`qa.settings renderer set failed ${e?.message ?? e}`));
    }
  });
  return () => { clearInterval(opener); sub.dispose(); };
}

export default { renderer };
