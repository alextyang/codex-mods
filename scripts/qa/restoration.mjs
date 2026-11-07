// QA-user-only Resume policy. Never change global Resume settings or match a copy by bundle id alone:
// the daily copy uses the same bundle id. TAL entries must name an app under this QA root.
import path from 'node:path';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEnvLine } from './isolation.mjs';
import { MAIN_RE } from './procs.mjs';

export const RESTORATION_ARGS = ['-ApplePersistenceIgnoreState', 'YES', '-NSDisablePersistence', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO'];
export const LAUNCH_ID_ENV = 'CODEXMODS_QA_LAUNCH_ID';
export const RELAUNCH_KEY = 'TALAppsToRelaunchAtLogin';
// builder/build.mjs uses this id for copies; this preference is written only in the QA user's domain.
export const COPY_BUNDLE_ID = 'dev.codexmods.app';
export const restorationInstruction = (root) => `Run node scripts/qa.mjs stop --root ${JSON.stringify(root)}, then run qa launch with the same --root. Never open a QA copy directly.`;

export function outsideHarness(processes, launch, envLineOf) {
  return processes.filter((p) => MAIN_RE.test(p.command) && (!launch?.launchId || p.pid !== launch.pid || parseEnvLine(envLineOf(p.pid))[LAUNCH_ID_ENV] !== launch.launchId));
}

// Old bundles may already be gone. Resolve their longest existing ancestor so macOS aliases and harness symlinks still agree.
function canonicalPath(value) {
  if (typeof value !== 'string') return null;
  try { if (value.startsWith('file:')) value = fileURLToPath(value); } catch { return null; }
  let current = path.resolve(value);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); }
    catch (e) {
      if (e.code !== 'ENOENT' || path.dirname(current) === current) return null;
      try { if (fs.lstatSync(current).isSymbolicLink()) return null; } catch { /* missing ancestor */ }
      tail.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}

function qaEntry(entry, roots) {
  const app = canonicalPath(entry?.Path);
  if (!app?.endsWith('.app')) return false;
  return roots.some((root) => {
    const relative = path.relative(root, app);
    return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
  });
}

export function suppressRestoration({ roots, preferences }) {
  const result = { ok: false, removed: 0, bundleId: COPY_BUNDLE_ID };
  try {
    roots = roots.map(canonicalPath).filter(Boolean);
    // Both scopes occur across macOS versions. Write only this key; preserve other apps and other loginwindow keys.
    for (const currentHost of [false, true]) {
      const entries = preferences.read('com.apple.loginwindow', currentHost, RELAUNCH_KEY);
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) throw new Error(`${RELAUNCH_KEY} is not an array`);
      const kept = entries.filter((e) => !qaEntry(e, roots));
      if (kept.length !== entries.length) {
        preferences.write('com.apple.loginwindow', RELAUNCH_KEY, kept, currentHost);
        result.removed += entries.length - kept.length;
      }
    }
    for (const [key, value] of [['NSQuitAlwaysKeepsWindows', false], ['NSDisablePersistence', true], ['ApplePersistenceIgnoreState', true]]) {
      for (const currentHost of [false, true]) preferences.write(COPY_BUNDLE_ID, key, value, currentHost);
    }
    result.ok = true;
  } catch (e) { result.error = String(e.message ?? e); }
  return result;
}

/** defaults runs as the harness user, never through sudo or with another user's home. UID override is for fake IO tests only. */
export function qaPreferences(run, uid = () => process.getuid()) {
  const checked = (cmd, args, opts) => {
    if (uid() !== 503) throw new Error('Resume preferences may only be changed by QA UID503');
    const r = run(cmd, args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024, ...opts });
    if (r.error || r.status !== 0) throw new Error(`${path.basename(cmd)}: ${r.error?.message ?? String(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
    return String(r.stdout ?? '');
  };
  const scope = (currentHost) => currentHost ? ['-currentHost'] : [];
  // One key's value, or undefined when the domain or the key is absent. Only that key is converted: a domain may also hold dates or data, which
  // JSON cannot represent (a real loginwindow or app domain does, and converting it whole fails).
  const read = (domain, currentHost, key) => {
    let xml;
    try { xml = checked('/usr/bin/defaults', [...scope(currentHost), 'export', domain, '-']); }
    catch (e) { if (/domain .* does not exist|domain .* not found/i.test(e.message)) return undefined; throw e; }
    let one;
    try { one = checked('/usr/bin/plutil', ['-extract', key, 'xml1', '-o', '-', '-'], { input: xml }); }
    catch (e) { if (/No value at that key path/i.test(e.message)) return undefined; throw e; }
    // plutil converts only a dictionary or an array to JSON: wrap the value (a boolean, say) in a one-element array.
    const inner = /<plist[^>]*>([\s\S]*)<\/plist>/.exec(one)?.[1];
    if (inner === undefined) throw new Error(`plutil: unexpected output for ${domain} ${key}`);
    return JSON.parse(checked('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${inner}</array></plist>` }))[0];
  };
  return {
    read,
    write(domain, key, value, currentHost) {
      const args = typeof value === 'boolean' ? ['-bool', String(value)]
        : [checked('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(value) })];
      checked('/usr/bin/defaults', [...scope(currentHost), 'write', domain, key, ...args]);
      if (!isDeepStrictEqual(read(domain, currentHost, key), value)) throw new Error(`Resume preference read-back failed: ${domain} ${key}`);
    },
  };
}
