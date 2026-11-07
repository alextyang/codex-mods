// What a mod did, for its Activity tab (docs/design/framework-ui.md F9). The durable JSONL log stays what ctx.log writes (logs/<id>.log); the framework's own lines (turned on, updated,
// its faults) go to a second small file beside it (logs/<id>.framework.log), so a mod that floods its log cannot push them out. `read` gives both as one feed since the Host started, with a
// cursor, and says when lines were dropped. Each line says who wrote it. Node built-ins only.
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FRAMEWORK_BYTES = 64 * 1024;
/** At most this many lines in one read: the newest. */
export const ACTIVITY_LINES = 500;
const THROTTLE_MS = 500;
const MAX_LINE = 2000;

const parseLines = (text) => text.split('\n').flatMap((l) => {
  if (!l) return [];
  try { const o = JSON.parse(l); return typeof o?.ts === 'string' ? [o] : []; } catch { return []; }
});
/** A cursor: a line's time and how many lines before it share that time, so lines of one millisecond are not skipped. */
const cursorOf = (lines) => { const last = lines.at(-1); if (!last) return null; let n = 0; for (let i = lines.length - 2; i >= 0 && lines[i].ts === last.ts; i--) n++; return `${last.ts}#${n}`; };
function afterCursor(lines, cursor) {
  const m = /^(.+)#(\d+)$/.exec(String(cursor ?? ''));
  if (!m) return lines;
  let same = 0;
  return lines.filter((x) => { if (x.ts < m[1]) return false; if (x.ts > m[1]) return true; return same++ > Number(m[2]); });
}

/**
 * @param {{ dir: string, startedAt?: number, log?: object, maxBytes?: number }} o  `dir`: the logs directory; `startedAt`: when the Host started, the feed's boundary
 */
export function createModActivity(o) {
  const startedAt = new Date(o.startedAt ?? Date.now()).toISOString();
  const maxBytes = o.maxBytes ?? FRAMEWORK_BYTES;
  const listeners = new Set();
  const timers = new Map();
  const chains = new Map();   // mod id -> its writes, in order
  const sizes = new Map();

  /** Someone with this page open should read again: at most twice a second per mod. */
  function touch(modId) {
    if (timers.has(modId)) return;
    const t = setTimeout(() => { timers.delete(modId); for (const fn of [...listeners]) { try { fn(modId); } catch { /* the listener's own */ } } }, THROTTLE_MS);
    t.unref?.();
    timers.set(modId, t);
  }

  /** The framework's own line. */
  function note(modId, level, message) {
    if (typeof modId !== 'string' || !modId) return Promise.resolve();
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, realm: 'framework', msg: String(message).slice(0, MAX_LINE) })}\n`;
    const file = join(o.dir, `${modId}.framework.log`);
    const done = (chains.get(modId) ?? Promise.resolve()).then(async () => {
      if (!sizes.has(modId)) { await mkdir(o.dir, { recursive: true, mode: 0o700 }); sizes.set(modId, await stat(file).then((s) => s.size, () => 0)); }
      const bytes = Buffer.byteLength(line);
      if (sizes.get(modId) > 0 && sizes.get(modId) + bytes > maxBytes) { await rename(file, `${file}.1`); sizes.set(modId, 0); }
      await appendFile(file, line, { mode: 0o600 });
      sizes.set(modId, sizes.get(modId) + bytes);
    }).catch((e) => { o.log?.warn?.('activity: a line was not written', { modId, message: String(e?.message ?? e) }); });
    chains.set(modId, done);
    touch(modId);
    return done;
  }

  const readLog = async (file) => { try { return parseLines(await readFile(file, 'utf8')); } catch { return []; } };

  /** The feed since the Host started, oldest first; `after`: only what came after that cursor. `dropped`: lines of this session a log rotated away, or past the limit of a read. */
  async function read(modId, { after } = {}) {
    await chains.get(modId);
    const sources = await Promise.all(['log', 'framework.log'].map(async (name) => {
      const older = await readLog(join(o.dir, `${modId}.${name}.1`));
      const newer = await readLog(join(o.dir, `${modId}.${name}`));
      return { lines: [...older, ...newer], rotated: older.length > 0 };
    }));
    const lines = sources.flatMap((x) => x.lines).filter((x) => x.ts >= startedAt).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const from = after ?? startedAt;
    // a rotated log whose oldest line is later than where this read starts has lost what came between
    const lost = sources.some((x) => x.rotated && x.lines[0].ts > String(from).split('#')[0]);
    const fresh = afterCursor(lines, after);
    const kept = fresh.slice(-ACTIVITY_LINES);
    return {
      lines: kept.map((x) => ({ at: Date.parse(x.ts), level: String(x.level), realm: String(x.realm ?? 'host'), message: `${x.msg}${x.data === undefined ? '' : ` ${JSON.stringify(x.data).slice(0, MAX_LINE)}`}` })),
      cursor: cursorOf(lines) ?? after ?? null, dropped: lost || fresh.length > kept.length, since: Date.parse(startedAt),
    };
  }

  return { note, touch, read, onChange(fn) { listeners.add(fn); return { dispose: () => { listeners.delete(fn); } }; }, dispose() { for (const t of timers.values()) clearTimeout(t); timers.clear(); listeners.clear(); } };
}

/** A finished operation as a line of its mod's feed: [level, message], or null when it says nothing there. */
export function activityLineOf(op) {
  const type = op?.input?.type;
  if (!type || op.outcome === 'running') return null;
  // a quarantine is journaled as a `disable`, and has a line of its own
  if (type === 'disable' && String(op.note ?? '').startsWith('Quarantined')) return null;
  const VERB = {
    install: 'Installed', enable: 'Turned on', disable: 'Turned off', reload: 'Reloaded', update: 'Updated', rollback: 'Rolled back', reattach: 'Reattached its data',
    'clear-quarantine': 'Cleared what stopped it', 'set-automatic': op.input.on ? `Automatic action ${op.input.action} turned on` : `Automatic action ${op.input.action} turned off`,
    'set-permission': `Permission ${op.input.grant}: ${({ allow: 'allowed', ask: 'ask every time', deny: 'not allowed' })[op.input.decision] ?? op.input.decision}`,
    'set-policy': op.input.on ? `Policy ${op.input.policy} turned on` : `Policy ${op.input.policy} turned off`,
    consent: op.input.approve ? 'Approved' : 'Declined',
  };
  const verb = VERB[type];
  if (!verb) return null;
  const to = type === 'update' ? op.result?.version : type === 'rollback' ? op.input.toVersion : null;
  const did = to ? `${verb} to ${to}` : verb;
  if (op.outcome === 'succeeded') return op.awaiting === 'consent' ? ['info', `${did}: waiting for your consent`] : ['info', did];
  const why = op.error?.message ?? op.note ?? '';
  return [op.outcome === 'failed' ? 'error' : 'warn', `${verb}: ${op.outcome === 'failed' ? 'failed' : op.outcome === 'reverted' ? 'reverted' : 'needs attention'}${why ? `: ${why}` : ''}`];
}
