'use strict';
// The app's own refresh and browser plugin sync after a protocol write, and the page that manages a plugin's account connections.
const kit = require('../area-kit.cjs');
const { projectEnabled } = require('./agent-config.cjs');

function register(hooks) {
  hooks.onAreaOp('plugins', async (op, args = {}) => {
    if (op === 'refresh') return { refreshed: await kit.invalidate(hooks, args.keys) };
    // a plugin on or off in one project's own .codex/config.toml (scoped enable, F9)
    if (op === 'project-enabled') return projectEnabled(hooks, 'plugins', args);
    if (op === 'plugin-sync') {
      const { svc } = kit.service(hooks, 'browserPluginConfig', ['syncAfterPluginChange']);
      await kit.withTimeout(svc.syncAfterPluginChange());
      return {};
    }
    if (op === 'navigate') {
      if (typeof args.path !== 'string' || (args.path !== '/plugins' && !/^\/plugins\/[^/]+$/.test(args.path))) throw kit.refusal('a plugin page path is needed');
      const { winId } = kit.windowServices(hooks);
      kit.navigate(hooks, winId, args.path);
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
