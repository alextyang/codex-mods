// The stock app as an update sees it (docs/design/systems.md S19, "E5 in detail"): its build, read from its Info.plist; a snapshot of it
// (an APFS clone under the root's updates/stock/, instant, which stays what it was while the app updates itself); its hashes. A bundle
// being replaced (a plist that does not parse, a build that changes while it is read) is unknown, never "no update". Node built-ins only.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';

const run = (cmd, args, timeout = 120_000) => new Promise((res, rej) => {
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => (e ? rej(Object.assign(e, { stderr })) : res(String(stdout))));
});
export async function sha256File(file) {
  const h = createHash('sha256');
  await new Promise((res, rej) => { createReadStream(file).on('data', (b) => h.update(b)).on('end', res).on('error', rej); });
  return h.digest('hex');
}

/** The build of an app bundle (`<CFBundleShortVersionString>-<CFBundleVersion>`), or throws Unavailable (unknown) when unreadable. */
export async function readBuild(app) {
  let info;
  try { info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], 10_000)); } catch (e) {
    throw new CodexModsError('Unavailable', `the stock app's Info.plist cannot be read (${e.code ?? e.message})`, { unknown: true });
  }
  if (typeof info?.CFBundleShortVersionString !== 'string' || typeof info?.CFBundleVersion !== 'string') {
    throw new CodexModsError('Unavailable', 'the stock app\'s Info.plist names no version', { unknown: true });
  }
  return { build: `${info.CFBundleShortVersionString}-${info.CFBundleVersion}`, version: info.CFBundleShortVersionString, bundleVersion: info.CFBundleVersion, executable: info.CFBundleExecutable ?? null };
}

/** The Info.plist's identity (size and time) for a cheap poll: changed means read it again. */
export async function plistStamp(app) {
  try { const s = await stat(join(app, 'Contents', 'Info.plist')); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return null; }
}

/** A bundle's hashes: its Info.plist, its main executable and its app.asar. */
export async function hashesOf(app, executable) {
  const exe = executable ? join(app, 'Contents', 'MacOS', executable) : null;
  return {
    plist: await sha256File(join(app, 'Contents', 'Info.plist')),
    executable: exe ? await sha256File(exe).catch(() => null) : null,
    asar: await sha256File(join(app, 'Contents', 'Resources', 'app.asar')),
  };
}

/**
 * A snapshot of the stock app: an APFS clone into `<updates>/stock/<build>-<asar>/<App>.app`, its build read before and after (a bundle
 * that changed meanwhile is unknown), then hashed from the clone. Reused when one with the same name is complete.
 * @param {{ updates: string }} layout
 */
export async function snapshotStock(layout, app, { clone = (src, dst) => run('/bin/cp', ['-c', '-R', src, dst], 600_000) } = {}) {
  const before = await readBuild(app);
  const root = join(layout.updates, 'stock');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.tmp-${process.pid}-${Date.now()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    await clone(app, join(tmp, basename(app)));
    const after = await readBuild(join(tmp, basename(app)));
    const now = await readBuild(app);
    if (after.build !== before.build || now.build !== before.build) throw new CodexModsError('Unavailable', 'the stock app changed while it was copied', { unknown: true });
    const hashes = await hashesOf(join(tmp, basename(app)), after.executable);
    const dir = join(root, `${after.build}-${hashes.asar.slice(0, 12)}`);
    if (await stat(join(dir, basename(app))).then(() => true, () => false)) { await rm(tmp, { recursive: true, force: true }); return { path: join(dir, basename(app)), ...after, hashes }; }
    await rename(tmp, dir);
    return { path: join(dir, basename(app)), ...after, hashes };
  } catch (e) { await rm(tmp, { recursive: true, force: true }); throw e; }
}
