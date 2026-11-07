// qa.panes, renderer realm — QA only (graph-integrity G5.3, G5.4): a region of two panes at the workspace's right edge. A chat dropped on one (from the sidebar: the app's
// own rows or the framework's) is hosted there. Which chat is in which pane is this mod's own data: kept in its storage, and read back
// when it starts, so the panes come back after a relaunch.
const KEY = 'panes';
const isRef = (r) => !!r && typeof r === 'object' && typeof r.type === 'string' && typeof r.provider === 'string' && typeof r.id === 'string';

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  let slots = [null, null];
  const subs = new Set();
  const changed = () => { for (const fn of subs) fn(); };
  ctx.storage.get(KEY).then((v) => {
    if (!Array.isArray(v)) return;
    slots = [0, 1].map((i) => (isRef(v[i]) ? v[i] : null));
    console.warn(`qa.panes restored ${JSON.stringify(slots.map((x) => x && x.id))}`);
    changed();
  }).catch((err) => console.warn(`qa.panes: not read: ${err?.message ?? err}`));
  const put = (i, ref) => {
    slots = slots.map((x, j) => (j === i ? ref : x));
    console.warn(`qa.panes dropped ${ref.type}:${ref.id} on ${i}`);
    ctx.storage.set(KEY, slots).catch((err) => console.warn(`qa.panes: not saved: ${err?.message ?? err}`));
    changed();
  };
  function Slot({ i }) {
    const chat = slots[i];
    return e(C.DropTarget, { accepts: ['Thread'], onDrop: ({ ref }) => put(i, ref), style: { flex: 1, minWidth: 0, minHeight: 0 } },
      e('div', { 'data-qa-panes-slot': String(i), style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } },
        chat ? ctx.ui.host.thread(chat, { key: `slot-${i}-${chat.id}` })
          : e(C.EmptyState, { title: 'Drop a chat here', description: 'Drag one from the sidebar.' })));
  }
  function Page() {
    const [, bump] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => { subs.add(bump); return () => { subs.delete(bump); }; }, []);
    return e('div', { 'data-qa-panes': '', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 'calc(var(--spacing) * 2)' } }, e(Slot, { i: 0 }), e(Slot, { i: 1 }));
  }
  // beside the chat, where the sidebar is too (a mod's page in the main region shows the app's rail alone)
  const region = ctx.ui.regions.add({ id: 'panes', title: 'QA panes', edge: 'right', width: { default: 520, min: 360, max: 900 }, render: () => e(Page) });
  return () => region.dispose();
}

export default { renderer };
