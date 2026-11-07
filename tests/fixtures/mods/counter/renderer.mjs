// Renderer entry: runs in every app window, in the page's main world, with the app's own React.

function renderer(ctx) {
  const { createElement: h, useState, useEffect } = ctx.ui.react;

  function SettingsView() {
    const [count, setCount] = useState(null);
    const [greeting, setGreeting] = useState('');
    useEffect(() => {
      let alive = true;
      ctx.settings.get().then((s) => alive && setGreeting(s.greeting));
      ctx.services.call(ctx.mod.id, 'counter', 'get').then((r) => alive && setCount(r.count), () => {});
      const sub = ctx.events.on(`mod/${ctx.mod.id}/count`, (data) => setCount(data.count));
      const settings = ctx.settings.onChange((s) => setGreeting(s.greeting));
      return () => { alive = false; sub.dispose(); settings.dispose(); };
    }, []);
    return h('section', {}, h('h2', {}, 'Counter'), h('p', {}, greeting), h('p', {}, `New threads seen: ${count ?? '…'}`));
  }

  // The mod's settings UI: a page of the app's own Settings.
  const page = ctx.ui.settings.page({ id: 'counter', title: 'Counter', render: SettingsView });
  return () => { page.dispose(); };
}

export default { renderer };
