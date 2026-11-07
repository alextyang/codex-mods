// --noenv launches omit CODEX_SPARKLE_ENABLED, so the proof that the copy never updates itself moves from the environment to behaviour:
// no Sparkle/updater process in the app group and no appcast/updater activity in the app's logs (pure parts).
export const UPDATER_PROCESS = /(Sparkle|Autoupdate|org\.sparkle-project|\/Updater\.app|Installer\.xpc|Downloader\.xpc)/i;
/** Log lines that show the updater checking or fetching a feed. */
export const UPDATER_LOG = /(appcast|sparkle[^\n]{0,60}(check|fetch|feed|download|updat)|checking for updates|check for updates|update feed|SUFeedURL|autoupdate|updater[^\n]{0,40}(start|check|fetch))/i;

/** @returns {{kind: string, detail: string}[]} */
export function updaterViolations({ processes = [], logs = [] }) {
  const out = [];
  for (const p of processes) if (UPDATER_PROCESS.test(p.command ?? '')) out.push({ kind: 'updater-process', detail: `${p.pid} ${String(p.command).slice(0, 160)}` });
  for (const l of logs) for (const line of l.lines ?? []) if (UPDATER_LOG.test(line)) out.push({ kind: 'updater-log', detail: `${l.file}: ${line.slice(0, 200)}` });
  return out;
}
