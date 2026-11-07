// Renderer entry: runs in the app's page. One file, no imports needed.
//
// Where the user sets a chat's focus: a row above that chat's composer, drawn by the framework's `SettingRow` (the same control,
// reset and errors as the mod's settings page), for this chat's value of the setting.

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  function Focus({ subject }) {
    const thread = subject?.links?.thread ?? null;   // the composer's Draft names its chat; a new chat's has none yet
    if (!thread) return null;
    return e('div', { style: { padding: '0 calc(var(--spacing) * 3)' } }, e(C.SettingRow, { setting: { key: 'focus', thread } }));
  }
  const band = ctx.ui.host('Composer', { id: 'focus', slot: 'aboveInput', render: Focus });
  return () => band.dispose();
}

export default { renderer };
