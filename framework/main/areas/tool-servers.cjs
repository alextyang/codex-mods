'use strict';
// The MCP settings page's refresh after a Host write, and the external browser for an MCP OAuth login: an HTTPS page, or an HTTP one on
// this Mac's loopback (a local MCP server's sign-in, as native apps use; RFC 8252 §7.3).
const kit = require('../area-kit.cjs');
const { projectEnabled } = require('./agent-config.cjs');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function register(hooks) {
  hooks.onAreaOp('tool-servers', async (op, args = {}) => {
    if (op === 'refresh') return { refreshed: await kit.invalidate(hooks, args.keys) };
    // a server on or off in one project's own .codex/config.toml (scoped enable, F9)
    if (op === 'project-enabled') return projectEnabled(hooks, 'mcp_servers', args);
    if (op === 'open-url') {
      let safe = false;
      try {
        const u = new URL(args.url);
        safe = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
      } catch { /* Invalid URLs are refused below. */ }
      if (!safe) throw kit.refusal('an HTTPS sign-in URL (or HTTP on this Mac\'s loopback) is needed');
      if (typeof hooks.electron?.openExternal !== 'function') throw kit.refusal('the external browser cannot be reached');
      await hooks.electron.openExternal(args.url);
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
