// Keychain prompt safety net (pure parts). securityd logs "displaying keychain prompt for <path>(<pid>); ACL: ..." when it is about to
// show the SecurityAgent dialog (observed in the unified log of earlier QA/probe launches). A QA run must never leave such a dialog up.
import path from 'node:path';

export const PROMPT_PREDICATE = 'process == "securityd" AND eventMessage CONTAINS "displaying keychain prompt"';
export const EXIT_PROMPT = 4;
export const ERROR_PROMPT = 'keychain-prompt-detected';

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** `log show` wants local time "YYYY-MM-DD HH:MM:SS". */
export function logTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function logShowArgs(sinceMs) {
  return ['show', '--start', logTime(sinceMs), '--style', 'compact', '--predicate', PROMPT_PREDICATE];
}

/** Local "YYYY-MM-DD HH:MM:SS.mmm" -> epoch ms. */
export function parseLogTime(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?$/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0).getTime();
}

/**
 * @param {string} text `log show --style compact` output
 * @returns {{ts: string, atMs: number, path: string, pid: number, item: string|null}[]}
 */
export function parsePromptLog(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)\s.*?displaying keychain prompt for (.*)\((\d+)\); ACL:(.*)$/.exec(line);
    if (!m) continue;
    const item = /KeychainPromptAclSubject\([^)]*desc:(.*?)\)>/.exec(m[4])?.[1] ?? null;
    out.push({ ts: m[1], atMs: parseLogTime(m[1]), path: m[2], pid: Number(m[3]), item });
  }
  return out;
}

/** Prompts that belong to this QA run: the pid is one of the app's pids, or the requesting path lies under the QA root. */
export function matchPrompts(entries, { pids = new Set(), roots = [], sinceMs = 0 }) {
  const prefixes = roots.map((r) => `${r.replace(/\/$/, '')}/`);
  return entries.filter((e) => (Number.isNaN(e.atMs) || e.atMs >= sinceMs) && (pids.has(e.pid) || prefixes.some((p) => e.path.startsWith(p))));
}

/** SecurityAgent processes (the keychain dialog) among a uid-filtered process table. */
export function selectSecurityAgents(rows) {
  return rows.filter((r) => path.basename(r.command.split(/ -{1,2}[A-Za-z]/)[0].trim()) === 'SecurityAgent');
}

/**
 * Dismiss the dialog by killing the user's SecurityAgent: SIGTERM first, SIGKILL only for those still alive after `graceMs`.
 * deps: {ps: () => rows, kill: (pid, sig) => boolean, sleep: (ms) => Promise}
 */
export async function dismissSecurityAgents({ ps, kill, sleep }, { graceMs = 2000, stepMs = 200 } = {}) {
  const first = selectSecurityAgents(ps());
  const result = { found: first.map((r) => r.pid), termed: [], killed: [], remaining: [] };
  for (const r of first) if (kill(r.pid, 'SIGTERM')) result.termed.push(r.pid);
  for (let waited = 0; waited < graceMs && selectSecurityAgents(ps()).length; waited += stepMs) await sleep(stepMs);
  for (const r of selectSecurityAgents(ps())) if (kill(r.pid, 'SIGKILL')) result.killed.push(r.pid);
  if (result.killed.length) await sleep(stepMs);
  result.remaining = selectSecurityAgents(ps()).map((r) => r.pid);
  return result;
}
