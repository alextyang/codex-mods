'use strict';
// Turn, file and hunk patches go through the app's git worker; opening a diff or file uses its own tab action (breadth D7).
const path = require('node:path');
const kit = require('../area-kit.cjs');

const id = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const absolute = (v) => typeof v === 'string' && path.isAbsolute(v);

function register(hooks) {
  hooks.onAreaOp('changes', async (op, args) => {
    const a = args ?? {};
    if (op === 'apply-patch') {
      if (!absolute(a.cwd) || typeof a.diff !== 'string' || !a.diff.trim()) throw kit.refusal('an absolute cwd and a non-empty diff are needed');
      const { svc } = kit.service(hooks, 'openIn', ['requestGitWorker']);
      const r = await kit.withTimeout(svc.requestGitWorker({ method: 'apply-patch', params: {
        cwd: a.cwd, diff: a.diff, revert: a.revert === true, atomic: a.atomic === true, operationSource: 'thread_diff',
      } }));
      if (r?.status !== 'success') {
        const paths = (key) => (Array.isArray(r?.[key]) ? r[key] : []).filter((p) => typeof p === 'string').join(', ');
        throw new Error(`git apply: ${r?.status ?? 'no status'}; conflictedPaths: ${paths('conflictedPaths')}; skippedPaths: ${paths('skippedPaths')}`);
      }
      return {};
    }
    if (op === 'view-diff' || op === 'open-file') {
      if (!id(a.threadId) || !absolute(a.path)) throw kit.refusal('a threadId of 1 to 200 characters and an absolute path are needed');
      try {
        // The app opens a diff or a file beside the chat it belongs to: show that chat first (21477 refuses a tab for a chat not shown).
        await kit.appAction(hooks, { type: 'windows.show_thread', windowId: 'current', threadId: a.threadId });
        await kit.appAction(hooks, { type: 'windows.tabs.open', windowId: 'current',
          target: op === 'view-diff' ? { type: 'review', view: 'last-turn', path: a.path } : { type: 'file', path: a.path }, threadId: a.threadId });
      } catch (e) {
        if (/requires a visible thread|is not visible in the targeted main window/.test(String(e?.message))) throw kit.refusal(`the app shows a ${op === 'view-diff' ? 'diff' : 'file'} beside a chat, and no chat is open`);
        throw e;
      }
      return {};
    }
    if (op === 'open-in') {
      if (!absolute(a.path) || !id(a.appId)) throw kit.refusal('an absolute path and an appId of 1 to 200 characters are needed');
      const { svc } = kit.service(hooks, 'openIn', ['open']);
      const r = await kit.withTimeout(svc.open({ path: a.path, cwd: path.dirname(a.path), target: a.appId, hostId: 'local' }));
      if (r?.success !== true) throw new Error(`the app could not open it in ${a.appId}`);
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
