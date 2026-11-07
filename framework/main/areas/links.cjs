'use strict';
// Where a link the user opens goes (docs/design/public-hooks.md §3.14, ui.links.route; the Host's link-routes.mjs; scout H7lr-links): the
// app's pages send every link the user opens from them (a chat's messages, the terminal, a pull request's link, the link menus) to its main
// side as `open-in-browser`; while a mod's route exists the Host is asked first (`links` reports), and its answer is what the app gets: the
// link to open in its own browser or the default browser, or nothing to open (a route stopped it, or a mod opened it itself). The Host
// gone, or no answer in time: the app's own, as before any mod; but once the Host claimed it (a mod's run is starting) it is never the
// app's to open as well: a claimed link not answered in time is not opened (built review H7lr).
const kit = require('../area-kit.cjs');

const WAIT_MS = 5000;   // until the Host claims the link or answers
const CLAIMED_MS = 30000;   // a claimed link's answer (the Host gives the mods' runs 3 s, link-routes.mjs RUN_MS)

function register(hooks, o = {}) {
  const electron = hooks.electron;
  const waitMs = o.waitMs ?? WAIT_MS, claimedMs = o.claimedMs ?? CLAIMED_MS;
  let active = false, seq = 0;
  const waiting = new Map();   // requestId -> {take, claim}
  const settleAll = () => { for (const [id, w] of [...waiting]) { waiting.delete(id); w.take(null); } };
  hooks.onAreaOp('links', async (op, args = {}) => {
    if (op === 'routes') { active = args && args.active === true; if (!active) settleAll(); return { holding: active && !!electron && typeof electron.holdAppMessage === 'function' }; }
    if (op === 'claim') {
      const w = args && typeof args.requestId === 'string' ? waiting.get(args.requestId) : undefined;
      return { claimed: !!w && w.claim() };
    }
    if (op === 'answer') {
      const w = args && typeof args.requestId === 'string' ? waiting.get(args.requestId) : undefined;
      if (!w) return { late: true };
      waiting.delete(args.requestId);
      w.take(args);
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
  hooks.onHostState?.((up) => { if (!up) { active = false; settleAll(); } });
  if (!electron || typeof electron.holdAppMessage !== 'function') return;
  electron.holdAppMessage('open-in-browser', (windowId, msg) => {
    if (!active || typeof msg.url !== 'string' || typeof hooks.areaReport !== 'function') return msg;
    // the user said where (a modifier, a menu's "Open in", a new tab or window), or the app must open it outside (mailto:, tel:)
    const chosen = msg.openTarget != null || msg.useExternalBrowser === true || msg.clickModifiers != null || msg.disposition != null;
    const requestId = `link-${process.pid}-${++seq}`;
    return new Promise((resolve) => {
      let claimed = false, t = null;
      const after = (ms, fn) => { clearTimeout(t); t = setTimeout(fn, ms); if (t.unref) t.unref(); };
      // not claimed in time: the app's own; claimed and not answered in time: not opened (a mod's run may have opened it)
      after(waitMs, () => { waiting.delete(requestId); resolve(msg); });
      waiting.set(requestId, {
        claim() { if (!claimed) { claimed = true; after(claimedMs, () => { waiting.delete(requestId); resolve(null); }); } return true; },
        take(a) {
          clearTimeout(t);
          const open = a && a.open;
          if (open === 'none' || open === 'handled') resolve(null);
          else if (open === 'app') resolve({ ...msg, openTarget: 'in-app-browser' });
          else if (open === 'browser') resolve({ ...msg, openTarget: 'external-browser' });
          else resolve(claimed && a === null ? null : msg);   // the Host gone after it claimed it: not opened
        },
      });
      try {
        hooks.areaReport('links', { event: 'open', requestId, windowId, url: msg.url, initiator: typeof msg.initiator === 'string' ? msg.initiator : null,
          conversationId: typeof msg.conversationId === 'string' ? msg.conversationId : null, chosen, expires: Date.now() + waitMs });
      } catch { waiting.delete(requestId); clearTimeout(t); resolve(msg); }
    });
  });
}

module.exports = { register, WAIT_MS, CLAIMED_MS };
