// Pure process-table helpers (input: `ps -axo pid=,ppid=,pgid=,command=` text).
import path from 'node:path';

export function parsePs(text) {
  return String(text).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] }));
}

/** Pids of this process and its ancestors: the harness and its ssh/shell must never count as "owned". */
export function selfAndAncestors(rows, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out = new Set();
  for (let p = pid; p && !out.has(p); p = byPid.get(p)?.ppid) out.add(p);
  return out;
}

const HARNESS = /(\/scripts\/qa\.mjs|\/cli\/codexmods\.mjs)(\s|$)/;
/**
 * Processes owned by this QA root: their command line contains the root (apps/<build>/ChatGPT Mods.app/..., framework, store) in either
 * spelling (as given and realpath'd), excluding the harness itself.
 */
export function ownedProcesses(rows, roots, exclude = new Set()) {
  const prefixes = [...new Set(roots.map((r) => `${r.replace(/\/$/, '')}/`))];
  return rows.filter((r) => !exclude.has(r.pid) && !HARNESS.test(r.command) && prefixes.some((p) => r.command.includes(p)));
}

/** The leader plus its process group and every descendant. */
export function family(rows, leader) {
  const set = new Set(rows.filter((r) => r.pgid === leader || r.pid === leader).map((r) => r.pid));
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!set.has(r.pid) && set.has(r.ppid)) { set.add(r.pid); grew = true; } }
  return rows.filter((r) => set.has(r.pid));
}

export const MAIN_RE = /\/Contents\/MacOS\/ChatGPT(\s|$)/;
export function findMain(owned) { return owned.find((r) => MAIN_RE.test(r.command)); }

/** A process of a modded copy (any root): its main executable or a Codex Framework helper inside an .app other than the stock one. */
const COPY_PROCESS_RE = /\.app\/Contents\/(MacOS\/ChatGPT(\s|$)|Frameworks\/Codex Framework\.framework\/)/;
export function modCopyRunning(rows) { return rows.some((r) => COPY_PROCESS_RE.test(r.command) && !r.command.startsWith('/Applications/ChatGPT.app/')); }

/** Chromium's temp files of a copy (base::CreateTemporaryFile: `.<bundle id>.` and six letters or digits) among a directory's names. */
export function copyTempFiles(names, bundleId) {
  const prefix = `.${bundleId}.`;
  return names.filter((n) => n.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(n.slice(prefix.length)));
}

/** Short role label for reports. */
export function roleOf(command) {
  if (MAIN_RE.test(command)) return 'app-main';
  if (/--type=([a-z-]+)/.test(command)) return `chromium-${/--type=([a-z-]+)/.exec(command)[1]}`;
  if (/cua_node\/bin\/node/.test(command)) return 'host-node';
  if (/codexmods-relay/.test(command)) return 'relay';
  if (/CodexCLI\.app\/Contents\/MacOS\/codex/.test(command)) return 'backend';
  if (/crashpad_handler/.test(command)) return 'crashpad-handler';
  return path.basename(command.split(/ -{1,2}[A-Za-z]/)[0]); // paths may contain spaces: cut at the first option
}

/**
 * What may be signalled: every owned pid individually, plus a whole process group only when its leader is the app's main process
 * (or another owned pid) and no excluded pid (the harness, its shell, its ancestors) lives in that group.
 */
export function signalTargets(rows, ownedList, exclude) {
  const ownedPids = new Set(ownedList.map((r) => r.pid));
  const groups = new Set();
  for (const r of ownedList) {
    if (r.pgid <= 1 || !ownedPids.has(r.pgid)) continue;
    if (rows.some((x) => x.pgid === r.pgid && exclude.has(x.pid))) continue;
    groups.add(r.pgid);
  }
  return { pids: [...ownedPids], groups: [...groups] };
}
