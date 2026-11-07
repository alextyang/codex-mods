'use strict';
// Thread operations through the app's own services: server pins, archive/worktree bookkeeping, deletion and opening a chat.
const kit = require('../area-kit.cjs');
const { own } = require('../user-actions.cjs');

function register(hooks) {
  hooks.onAreaOp('threads', async (op, args = {}) => {
    if (op === 'pinned') {
      const { svc } = kit.service(hooks, 'pinnedThreads', ['list']);
      const r = await kit.withTimeout(svc.list({ hostId: 'local', useAppServerPins: true, preservePinSource: true }));
      return { threadIds: (Array.isArray(r?.threadIds) ? r.threadIds : []).filter((id) => typeof id === 'string') };
    }
    if (!['pin', 'archive-prepare', 'archive-inactive', 'restore-prepare', 'delete', 'open'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    const threadId = args?.threadId;
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw kit.refusal('a threadId of at most 200 characters is needed');
    if (op === 'pin') {
      const { svc } = kit.service(hooks, 'pinnedThreads', ['set']);
      // the service's own set: a pin the graph made passed the mods already (user-actions.cjs holds the user's)
      await kit.withTimeout(own(svc, 'set', { threadId, pinned: args.pinned === true, hostId: 'local', useAppServerPins: true }));
      return {};
    }
    if (op === 'archive-prepare') {
      const { svc } = kit.service(hooks, 'managedWorktrees', ['registerThreadArchive']);
      await kit.withTimeout(svc.registerThreadArchive({ hostId: 'local', threadId, cwd: typeof args.cwd === 'string' ? args.cwd : null, cleanupWorktree: true }));
      return {};
    }
    if (op === 'archive-inactive') {
      const { svc } = kit.service(hooks, 'threadArchive', ['archiveInactiveThread']);
      return kit.withTimeout(svc.archiveInactiveThread({ hostId: 'local', threadId, removeCatalogEntryIfMissing: true }));
    }
    if (op === 'restore-prepare') {
      const { svc } = kit.service(hooks, 'managedWorktrees', ['registerThreadUnarchive']);
      await kit.withTimeout(svc.registerThreadUnarchive({ hostId: 'local', threadId }));
      return {};
    }
    if (op === 'delete') {
      const { svc } = kit.service(hooks, 'threadArchive', ['deleteArchivedThread']);
      const r = await kit.withTimeout(svc.deleteArchivedThread({ hostId: 'local', threadId }));
      return { deletedThreadIds: (Array.isArray(r) ? r : Array.isArray(r?.deletedThreadIds) ? r.deletedThreadIds : []).filter((id) => typeof id === 'string') };
    }
    await kit.appAction(hooks, { type: 'windows.show_thread', windowId: 'current', threadId });
    return {};
  });
}

module.exports = { register };
