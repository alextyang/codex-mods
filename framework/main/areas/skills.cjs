'use strict';
// The app's own skills library and file opening (breadth step D10). Only the library's public facts cross to the Host; paths to remove
// and open are guarded here, and recommendedSkills also guards its own roots. No skill files are read or written by this module.
const path = require('node:path');
const kit = require('../area-kit.cjs');
// framework-main's own calls: never held as the user's (user-actions.cjs)
const { own } = require('../user-actions.cjs');

function register(hooks) {
  hooks.onAreaOp('skills', async (op, args) => {
    if (op === 'library') {
      const { svc } = kit.service(hooks, 'recommendedSkills', ['list']);
      const r = await kit.withTimeout(svc.list({ hostId: 'local', refresh: false }));
      return { skills: (r.skills ?? []).map(({ id, name, description, shortDescription, repoPath }) => ({ id, name, description, shortDescription, repoPath })), error: r.error };
    }
    if (op === 'install') {
      const { svc } = kit.service(hooks, 'recommendedSkills', ['install']);
      const r = await kit.withTimeout(own(svc, 'install', { hostId: 'local', skillId: args.skillId, repoPath: args.repoPath }));
      return { success: r.success, destination: r.destination, error: r.error };
    }
    if (op === 'remove') {
      const p = args.skillPath;
      if (typeof p !== 'string' || !path.isAbsolute(p) || !path.resolve(p).split(path.sep).includes('skills')) throw kit.refusal('an absolute path in a skills folder is needed');
      const { svc } = kit.service(hooks, 'recommendedSkills', ['remove']);
      const r = await kit.withTimeout(own(svc, 'remove', { hostId: 'local', skillPath: p }));
      return { success: r.success, deletedPath: r.deletedPath, error: r.error };
    }
    if (op === 'open') {
      if (typeof args.path !== 'string' || !path.isAbsolute(args.path) || !args.path.endsWith('/SKILL.md')) throw kit.refusal('an absolute path to SKILL.md is needed');
      try {
        await kit.appAction(hooks, { type: 'windows.tabs.open', windowId: 'current', target: { type: 'file', path: args.path } });
      } catch (e) {
        if (/requires a visible thread/.test(String(e?.message))) throw kit.refusal('the app shows a file beside a thread, and no thread is open');
        throw e;
      }
      return {};
    }
    if (op === 'refresh') return { refreshed: await kit.invalidate(hooks, args.keys) };
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
