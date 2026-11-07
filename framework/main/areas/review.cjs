'use strict';
// Model review comments use the app's persisted dismissal keys and its review tab (breadth step D7).
const kit = require('../area-kit.cjs');

const ATOMS = 'electron-persisted-atom-state';
const DISMISSED = 'dismissed-model-diff-comments-v3:';
const isKey = (key) => typeof key === 'string' && key.length <= 20_000;

function register(hooks) {
  hooks.onAreaOp('review', async (op, args = {}) => {
    if (!['dismissed', 'dismiss', 'open'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    args = args && typeof args === 'object' ? args : {};
    const { threadId } = args;
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw kit.refusal('a thread id of at most 200 characters is needed');
    if (op === 'open') {
      if (typeof args.path !== 'string' || !args.path.trim()) throw kit.refusal('a file path is needed');
      if (!['unstaged', 'branch'].includes(args.view)) throw kit.refusal('the review view must be unstaged or branch');
      try {
        // The app opens a diff beside the chat it belongs to: show that chat first (21477 refuses a tab for a chat not shown).
        await kit.appAction(hooks, { type: 'windows.show_thread', windowId: 'current', threadId });
        await kit.appAction(hooks, { type: 'windows.tabs.open', windowId: 'current', target: { type: 'review', view: args.view, path: args.path }, threadId });
      } catch (e) {
        if (/requires a visible thread|is not visible in the targeted main window/.test(String(e?.message))) throw kit.refusal('the app shows a diff beside a chat, and no chat is open');
        throw e;
      }
      return {};
    }
    if (op === 'dismissed' && (!Array.isArray(args.keys) || args.keys.length > 1000 || !Array.from(args.keys).every(isKey))) throw kit.refusal('at most 1000 comment keys of at most 20000 characters are needed');
    if (op === 'dismiss' && !isKey(args.key)) throw kit.refusal('a comment key of at most 20000 characters is needed');
    const store = kit.globalState(hooks);
    if (op === 'dismiss' && typeof store.set !== 'function') throw kit.refusal("the app's state cannot be written from here");
    const saved = await kit.withTimeout(store.get(ATOMS));
    const atoms = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
    const client = atoms[`thread-client-id-v1:${encodeURIComponent(`local:${threadId}`)}`];
    const prefix = `${DISMISSED}${typeof client === 'string' ? client : `local:${threadId}`}:`;
    if (op === 'dismissed') return { dismissed: args.keys.filter((key) => atoms[`${prefix}${key}`] === true) };
    const key = `${prefix}${args.key}`;
    if (atoms[key] === true) return {};
    const keys = Object.keys(atoms).filter((k) => k.startsWith(prefix));
    for (const old of keys.slice(0, Math.max(0, keys.length - 999))) delete atoms[old];
    atoms[key] = true;
    await kit.withTimeout(store.set(ATOMS, atoms));
    for (const w of hooks.appHost.windows()) kit.postToView(hooks, w.id, { type: 'persisted-atom-updated', key, value: true, deleted: false });
    return {};
  });
}

module.exports = { register };
