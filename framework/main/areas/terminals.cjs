'use strict';
// The app's integrated terminals: observe the shared manager's listener sets, leaving each window service's renderer listener alone, and
// keep each one's recent output for Terminal.tail.
const { basename } = require('node:path');
const kit = require('../area-kit.cjs');
const string = (v) => typeof v === 'string' ? v : null;
const id = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
// A terminal's recent output, kept here for Terminal.tail (whose grant names it): it leaves main only as its answer.
const TAIL_MAX = 64 * 1024;
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
function lastLines(text, n) {
  const lines = text.replace(ESCAPES, '').replace(/\r\n/g, '\n').split('\n').map((l) => l.slice(l.lastIndexOf('\r') + 1));
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function register(hooks) {
  const bound = new Map(), outputAt = new Map(), recent = new Map();
  let logged = false;
  function warn(error) {
    if (logged) return;
    logged = true;
    try { hooks.log?.warn('terminals: observation failed', { message: String(error?.message ?? error) }); } catch { /* never break the app */ }
  }
  function report(e) {
    try {
      if (typeof e?.sessionId !== 'string') return;
      const data = { sessionId: e.sessionId };
      if (e.type === 'data') {
        if (typeof e.data === 'string') { const kept = (recent.get(e.sessionId) ?? '') + e.data; recent.set(e.sessionId, kept.length > TAIL_MAX ? kept.slice(-TAIL_MAX) : kept); }
        const now = Date.now();
        if (now - (outputAt.get(e.sessionId) ?? -Infinity) < 250) return;
        outputAt.set(e.sessionId, now);
        data.event = 'output'; // No terminal text leaves main.
      } else if (e.type === 'attached') {
        Object.assign(data, { event: 'attached', cwd: string(e.cwd), shell: typeof e.shell === 'string' ? basename(e.shell) : null });
      } else if (e.type === 'exit') {
        outputAt.delete(e.sessionId);
        recent.delete(e.sessionId);
        Object.assign(data, { event: 'exit', code: e.code ?? null, signal: e.signal ?? null });
      } else if (e.type === 'error') Object.assign(data, { event: 'error', message: string(e.message) });
      else return;
      hooks.areaReport('terminals', data);
    } catch (e) { warn(e); }
  }
  function bind(event) {
    try {
      if (event?.type === 'removed') {
        const remove = bound.get(event.id);
        bound.delete(event.id);
        try { remove?.(); } catch (e) { warn(e); }
      }
      for (const w of hooks.appHost?.windows?.() ?? []) {
        if (bound.has(w.id)) continue;
        try {
          const terminal = w.host?.services?.terminal;
          if (!terminal?.origin || typeof terminal.terminalManager?.subscribe !== 'function') continue;
          bound.set(w.id, terminal.terminalManager.subscribe(terminal.origin, report));
        } catch (e) { warn(e); }
      }
    } catch (e) { warn(e); }
  }
  try { hooks.appHost?.subscribe?.(bind); } catch (e) { warn(e); }
  bind();

  hooks.onAreaOp('terminals', async (op, args = {}) => {
    if (!['list', 'write', 'close', 'focus', 'tail'].includes(op)) throw kit.refusal(`unknown operation ${op}`);
    if (op !== 'list' && !id(args?.sessionId)) throw kit.refusal('a session id of at most 200 characters is needed');
    if (op === 'write' && (typeof args.data !== 'string' || args.data.length > 100_000)) throw kit.refusal('terminal data must be a string of at most 100000 characters');
    if (op === 'focus' && (!id(args.threadId) || args.threadId.startsWith('client-new-thread:'))) throw kit.refusal('a saved thread id of at most 200 characters is needed');
    if (op === 'tail' && (!Number.isSafeInteger(args.lines) || args.lines < 1 || args.lines > 1000)) throw kit.refusal('from 1 to 1000 lines');
    const windows = hooks.appHost?.windows?.() ?? [];
    const manager = windows.map((w) => w.host?.services?.terminal?.terminalManager).find((m) => m?.sessions instanceof Map);
    if (!manager) throw kit.refusal("the app's terminals cannot be reached");
    const sessions = [...manager.sessions.values()].filter((s) => s.hostId == null || s.hostId === 'local');
    if (op === 'list') return { sessions: sessions.map((s) => ({
      id: string(s.id), conversationId: string(s.conversationId), threadId: kit.threadIdOf(hooks, string(s.conversationId)), cwd: string(s.cwd),
      shell: typeof s.shell === 'string' ? basename(s.shell) : null, ownerId: s.ownerId == null ? null : String(s.ownerId),
    })) };
    const session = sessions.find((s) => s.id === args.sessionId);
    if (!session) throw kit.refusal('the terminal is no longer available');
    if (op === 'tail') return { text: lastLines(recent.get(args.sessionId) ?? '', args.lines) };
    if (op === 'focus') {
      await kit.appAction(hooks, { type: 'windows.show_thread', windowId: 'current', threadId: args.threadId });
      await kit.appAction(hooks, { type: 'windows.tabs.open', windowId: 'current', threadId: args.threadId, target: { type: 'terminal', sessionId: args.sessionId } });
    } else {
      const terminal = (windows.find((w) => {
        const ownerId = w.host?.services?.terminal?.origin?.id;
        return ownerId != null && String(ownerId) === String(session.ownerId);
      }) ?? windows[0])?.host?.services?.terminal;
      if (typeof terminal?.[op] !== 'function') throw kit.refusal(`the app's terminal service has no ${op}`);
      await kit.withTimeout(op === 'write' ? terminal.write(args.sessionId, args.data) : terminal.close(args.sessionId));
    }
    return {};
  });
}

module.exports = { register };
