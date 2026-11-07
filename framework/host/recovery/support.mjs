// Shared helpers for the recovery module and the setup/app/framework/recovery CLI commands.
// Pure Node built-ins. Every JSON write goes through writeJsonAtomic; text pointer files go through writeTextAtomic.
import { open, rename, mkdir, readFile, rm, cp, readdir, lstat, symlink, realpath, readlink, writeFile } from 'node:fs/promises';
import { readFileSync, lstatSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve, basename, sep, isAbsolute } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { writeJsonAtomic } from '../fsutil.mjs';
import { SOCKETS } from '../../../contracts/layout.mjs';

export const STOCK_APP = '/Applications/ChatGPT.app';
export const STOCK_EXECUTABLE = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
/** Root of the framework tree that contains this file (…/framework/<version> or a checkout). */
export const FRAMEWORK_TREE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ------------------------------------------------------------------ text pointer files
async function syncDir(dir) {
  const dh = await open(dir, 'r');
  try { await dh.sync(); } finally { await dh.close(); }
}

/** temp → fsync → rename → fsync dir. Used for framework/current|previous|lkg, apps/lkg, generations/lkg and flags. */
export async function writeTextAtomic(path, text, { mode = 0o600 } = {}) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'w', mode);
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  try { await rename(tmp, path); } catch (e) { await rm(tmp, { force: true }); throw e; }
  await syncDir(dir);
}

/** flags/ file written by framework-main (or the loader) while a blocking startup dialog is open: {pid, at, kind}. The health window pauses meanwhile. */
export const STARTUP_DIALOG_FILE = 'startup-dialog.json';
/** True while a LIVE process holds a startup dialog open (a stale file of a dead process is ignored). */
export function startupDialogOpenSync(flagsDir) {
  try {
    const d = JSON.parse(readFileSync(join(flagsDir, STARTUP_DIALOG_FILE), 'utf8'));
    if (!Number.isInteger(d?.pid)) return false;
    try { process.kill(d.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch { return false; }
}
/**
 * An explicit person-made decision ("try normally", Restore, Disable) ends the unhealthy streak: the marker becomes
 * {state:'healthy', unhealthyCount:0}, the same semantics the loader uses after a successful LKG reopen. No-op without a marker.
 */
export async function resetBootMarker(flagsDir, why) {
  const path = join(flagsDir, 'boot.json');
  let m;
  try { m = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  await writeJsonAtomic(path, { ...m, state: 'healthy', unhealthyCount: 0, ...(why ? { resetBy: why } : {}) });
  return true;
}

/** Trimmed content, or undefined when the file is absent or empty. */
export async function readText(path) {
  try { const t = (await readFile(path, 'utf8')).trim(); return t === '' ? undefined : t; }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
export function readTextSync(path) {
  try { const t = readFileSync(path, 'utf8').trim(); return t === '' ? undefined : t; }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
export async function exists(path) { try { await lstat(path); return true; } catch { return false; } }

// ------------------------------------------------------------------ symlinks and paths
/** Absolute target of a symlink, or undefined when the path is not a symlink (or absent). */
export function readLinkAbs(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    const t = readlinkSync(path);
    return isAbsolute(t) ? t : resolve(dirname(path), t);
  } catch { return undefined; }
}
/** True when two paths name the same location (textually, or after resolving symlinks). */
export async function samePath(a, b) {
  if (!a || !b) return false;
  if (resolve(a) === resolve(b)) return true;
  try { return (await realpath(a)) === (await realpath(b)); } catch { return false; }
}
/** Atomically point `stable` (a symlink) at `target`: new link beside it, renamed over it. Refuses to replace a non-symlink. */
export async function replaceSymlinkAtomic(stable, target) {
  let st = null;
  try { st = await lstat(stable); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isSymbolicLink()) {
    throw new CodexModsError('Conflict', `${stable} exists and is not a symlink; refusing to replace it`);
  }
  await mkdir(dirname(stable), { recursive: true });
  const tmp = join(dirname(stable), `.${basename(stable)}.${randomBytes(4).toString('hex')}.new`);
  await symlink(target, tmp);
  try { await rename(tmp, stable); } catch (e) { await rm(tmp, { force: true }); throw e; }
}
/** First `*.app` directory inside `dir`, or undefined. */
export function findAppSync(dir) {
  try {
    const hit = readdirSync(dir).filter((n) => n.endsWith('.app')).sort()[0];
    return hit ? join(dir, hit) : undefined;
  } catch { return undefined; }
}
export async function mkdirs(...dirs) { for (const d of dirs) await mkdir(d, { recursive: true, mode: 0o700 }); }

// ------------------------------------------------------------------ app builds (Info.plist)
function plistRaw(plist, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/** {short, bundle, build:'<short>-<bundle>'} of an .app, from its Info.plist. Throws Unavailable. */
export function readAppBuildSync(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  try {
    const short = plistRaw(plist, 'CFBundleShortVersionString');
    const bundle = plistRaw(plist, 'CFBundleVersion');
    return { short, bundle, build: `${short}-${bundle}` };
  } catch (e) {
    throw new CodexModsError('Unavailable', `cannot read the build of ${appPath}: ${String(e.message).split('\n')[0]}`);
  }
}

// ------------------------------------------------------------------ framework trees
const COPY_ALLOWLIST = ['framework', 'sdk', 'contracts', 'loader', 'relay', 'builder', 'cli', 'adapters', 'mods', 'package.json'];
function copyFilter(srcRoot) {
  return (src) => {
    const rel = src.slice(srcRoot.length + 1);
    if (rel === '') return true;
    const parts = rel.split(sep);
    if (parts.includes('.git') || parts.includes('node_modules') || parts.includes('.DS_Store')) return false;
    if (rel.endsWith('.test.mjs') || (parts[0] === 'framework' && parts.includes('test'))) return false;
    if (rel.startsWith(join('contracts', 'upstream'))) return false;
    return true;
  };
}
/** sha256 hex over the file tree that installFrameworkTree would install (or has installed): relative paths and bytes. */
export async function frameworkTreeHash(dir) {
  const h = createHash('sha256');
  const keep = copyFilter(dir);
  const walk = async (d, rel) => {
    for (const n of (await readdir(d)).sort()) {
      const p = join(d, n); const r = `${rel}/${n}`;
      if (!keep(p)) continue;
      const st = await lstat(p);
      if (st.isDirectory()) await walk(p, r);
      else if (st.isSymbolicLink()) h.update(`${r}\0->${await readlink(p)}\0`);
      else if (st.isFile()) h.update(r + '\0').update(await readFile(p)).update('\0');
    }
  };
  for (const top of COPY_ALLOWLIST) {
    const p = join(dir, top);
    if (!(await exists(p))) continue;
    const st = await lstat(p);
    if (st.isDirectory()) await walk(p, top);
    else h.update(top + '\0').update(await readFile(p)).update('\0');
  }
  return h.digest('hex');
}
/**
 * Content-addressed version of a framework tree: `<package.json version | 0.0.0-dev>+<first 8 hex of the tree hash>`, e.g. 1.0.0-dev+3f2a9c1e.
 * The directory framework/<version>/ is immutable: identical content reuses it, changed content gets a new one.
 */
export async function frameworkVersionOf(dir) {
  let base = '0.0.0-dev';
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) base = pkg.version.split('+')[0];
  } catch { /* no package.json */ }
  return `${base}+${(await frameworkTreeHash(dir)).slice(0, 8)}`;
}
export function assertVersionName(version) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version) || version === 'current' || version === 'previous' || version === 'lkg') {
    throw new CodexModsError('Invalid', `invalid framework version name: ${JSON.stringify(version)}`);
  }
}
/** Throws Invalid unless `dir` looks like a framework tree the loader can start. */
export async function assertFrameworkTree(dir) {
  if (!(await exists(join(dir, 'framework', 'main', 'index.cjs')))) {
    throw new CodexModsError('Invalid', `${dir} is not a framework tree (framework/main/index.cjs not found)`);
  }
}
/**
 * Install `sourceDir` as framework/<version>/ without touching any pointer: copy to a temp dir, then rename into place.
 * Framework directories are immutable and never modified in place: if framework/<version>/ exists with identical content it is
 * reused; with different content this is a Conflict (use a new version name; frameworkVersionOf gives content-addressed ones).
 */
export async function installFrameworkTree(layout, sourceDir, version) {
  assertVersionName(version);
  await assertFrameworkTree(sourceDir);
  const dest = join(layout.framework, version);
  await mkdirs(layout.framework);
  if (await exists(dest)) {
    if (await frameworkTreeHash(dest) === await frameworkTreeHash(sourceDir)) return dest;
    throw new CodexModsError('Conflict', `framework ${version} already exists with different content; frameworks are immutable, install under a new version`);
  }
  const tmp = join(layout.framework, `.install-${version}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await mkdir(tmp, { mode: 0o700 });
    for (const top of COPY_ALLOWLIST) {
      const from = join(sourceDir, top);
      if (!(await exists(from))) continue;
      await cp(from, join(tmp, top), { recursive: true, filter: copyFilter(sourceDir), verbatimSymlinks: true, preserveTimestamps: true });
    }
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return dest;
}
/** Remove leftover `.install-*.tmp*` directories from interrupted installs. */
export async function cleanFrameworkTemps(layout) {
  try {
    for (const n of await readdir(layout.framework)) {
      if (n.startsWith('.install-')) await rm(join(layout.framework, n), { recursive: true, force: true });
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
/** Set framework pointers like the framework-update op: previous = old current (when different), then current. */
export async function setFrameworkCurrent(layout, version, { phase } = {}) {
  const cur = await readText(layout.frameworkCurrent);
  if (cur && cur !== version) { await phase?.('previous'); await writeTextAtomic(layout.frameworkPrevious, cur); }
  await phase?.('current');
  await writeTextAtomic(layout.frameworkCurrent, version);
  return { previous: cur && cur !== version ? cur : await readText(layout.frameworkPrevious) };
}

// ------------------------------------------------------------------ builder invocation (shared by setup and app-prepare)
export function builderArgs({ layout, profile, stockApp, adapterPath, frameworkDir, frameworkVersion, outDir, name = 'ChatGPT Mods', extraArgs = [] }) {
  return [join(frameworkDir, 'builder', 'build.mjs'),
    '--stock', stockApp, '--adapter', adapterPath,
    '--loader', join(frameworkDir, 'loader', 'loader.cjs'), '--relay', join(frameworkDir, 'relay', 'relay'),
    '--root', layout.root, '--framework-version', frameworkVersion ?? '', '--identity', profile?.signingIdentity || '-', '--out', outDir, '--name', name, ...extraArgs];
}
/** Run `node builder/build.mjs …`. Under Electron's utility process execPath is Electron, so ELECTRON_RUN_AS_NODE is set. */
export function runBuilderProcess(args, { nodePath = process.execPath, timeoutMs = 30 * 60_000, spawnFn = spawn } = {}) {
  return new Promise((res, rej) => {
    const child = spawnFn(nodePath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (b) => { tail = (tail + b).slice(-4000); };
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } rej(new CodexModsError('Timeout', 'the builder timed out')); }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); rej(new CodexModsError('Unavailable', `cannot run the builder: ${e.message}`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) res({ tail });
      else rej(new CodexModsError('Unavailable', `the builder failed (exit ${code}): ${tail.trim().split('\n').slice(-6).join(' | ')}`));
    });
  });
}
/**
 * Identity of a build's inputs (contracts/layout.mjs `apps`), computed by the builder's own export so the candidate directory name
 * always equals build-report.json's inputsHash: adapter.json bytes, loader/loader.cjs bytes, relay/relay bytes, identity, framework version.
 */
export async function resolveInputsHash({ adapterPath, frameworkDir, identity, frameworkVersion }) {
  const { buildInputsHash } = await import('../../../builder/build.mjs');
  const read = async (path, what) => {
    try { return await readFile(path); } catch (e) { throw new CodexModsError('Unavailable', `cannot read the ${what} (${path}): ${e.code ?? e.message}`); }
  };
  return buildInputsHash({
    adapterBytes: await read(adapterPath, 'adapter pack'),
    loaderBytes: await read(join(frameworkDir, 'loader', 'loader.cjs'), 'loader'),
    relayBytes: await read(join(frameworkDir, 'relay', 'relay'), 'relay'),
    identity: identity || '-',
    frameworkVersion: frameworkVersion ?? '',
  });
}
/**
 * The adapter refresh (builder/refresh-adapter.mjs) of a framework tree, run as its own process: its census reads the whole app.asar
 * synchronously, which must never block the Host (its mods' heartbeats would time out). Answers what refreshAdapter answers.
 * A mandatory edit that cannot be derived (exit 3) is Incompatible.
 */
export async function refreshInChild({ frameworkDir, previous, stockApp, outDir, nodePath = process.execPath, spawnFn = spawn, timeoutMs = 20 * 60_000 }) {
  const tmp = join(dirname(outDir), `.refresh-previous-${process.pid}-${Date.now()}.json`);
  await mkdirs(dirname(outDir));
  await writeFile(tmp, JSON.stringify(previous), { mode: 0o600 });
  try {
    await new Promise((res, rej) => {
      const child = spawnFn(nodePath, [join(frameworkDir, 'builder', 'refresh-adapter.mjs'), '--previous', tmp, '--stock', stockApp, '--out', outDir],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let tail = '';
      const keep = (b) => { tail = (tail + b).slice(-4000); };
      child.stdout?.on('data', keep); child.stderr?.on('data', keep);
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } rej(new CodexModsError('Timeout', 'the adapter refresh timed out')); }, timeoutMs);
      child.once('error', (e) => { clearTimeout(timer); rej(new CodexModsError('Unavailable', `cannot run the adapter refresh: ${e.message}`)); });
      child.once('close', (code) => {
        clearTimeout(timer);
        const last = tail.trim().split('\n').slice(-3).join(' | ');
        if (code === 0) res();
        else rej(new CodexModsError(code === 3 ? 'Incompatible' : 'Unavailable', `the adapter refresh failed: ${last}`));
      });
    });
  } finally { await rm(tmp, { force: true }); }
  const adapterPath = join(outDir, 'adapter.json');
  return { adapterPath, adapter: JSON.parse(await readFile(adapterPath, 'utf8')), report: JSON.parse(await readFile(join(outDir, 'refresh-report.json'), 'utf8')) };
}
/** Candidate directory name apps/<build>-<inputsHash>. */
export const candidateDirName = (build, hash) => `${build}-${hash}`;
/** Directories of apps/ that hold a copy of `build` (named <build> or <build>-<hash>), newest completed first. */
export function candidateDirsSync(layout, build) {
  const out = [];
  try {
    for (const name of readdirSync(layout.apps)) {
      if (name !== build && !name.startsWith(`${build}-`)) continue;
      const dir = join(layout.apps, name);
      const app = findAppSync(dir);
      if (!app) continue;
      let mtime = 0, complete = false;
      try { mtime = statSync(join(dir, 'build-report.json')).mtimeMs; complete = true; } catch { /* incomplete */ }
      out.push({ name, dir, app, mtime, complete });
    }
  } catch { /* no apps dir */ }
  return out.sort((x, y) => y.mtime - x.mtime || (x.name < y.name ? -1 : 1));
}
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
/** The inputs a candidate is built from, in the terms build-report.json records them. */
export async function candidateInputs({ adapterPath, frameworkDir, identity, frameworkVersion, build }) {
  const read = async (p) => { try { return await readFile(p); } catch { return null; } };
  const adapter = await read(adapterPath), loader = await read(join(frameworkDir, 'loader', 'loader.cjs')), relay = await read(join(frameworkDir, 'relay', 'relay'));
  return { adapter: adapter && sha256Hex(adapter), loader: loader && sha256Hex(loader), relay: relay && sha256Hex(relay),
    identity: identity || '-', frameworkVersion: frameworkVersion ?? '', stock: build };
}
/** Names of the inputs that differ from a candidate's build-report.json (an input the report does not record counts as different). */
export function diffInputs(report, inputs) {
  const out = [];
  if (report?.inputs?.adapter?.sha256 !== inputs.adapter) out.push('adapter.json');
  if ((report?.frameworkVersion ?? '') !== inputs.frameworkVersion) out.push('framework version');
  if (report?.inputs?.loaderSha256 !== inputs.loader) out.push('loader');
  if (report?.inputs?.relaySha256 !== inputs.relay) out.push('relay');
  if (report?.signing?.identity !== inputs.identity) out.push('signing identity');
  if (`${report?.stock?.version}-${report?.stock?.bundleVersion}` !== inputs.stock) out.push('stock build');
  // An update's staging (docs/design/systems.md E5) also names the stock's content and the build flags: the same build id is not enough.
  if (inputs.asarSha256 !== undefined && report?.stock?.asarSha256 !== inputs.asarSha256) out.push('stock content');
  if (inputs.qaNoRestore !== undefined && !!report?.infoPlist?.qaNoRestore !== inputs.qaNoRestore) out.push('build flag qa-no-restore');
  if (inputs.qaSocketDirs !== undefined && !!report?.qaSocketDirs?.applied !== inputs.qaSocketDirs) out.push('build flag qa-socket-dirs');
  return out;
}
const readReportSync = (appOrDir) => {
  for (const d of [appOrDir, dirname(appOrDir)]) { try { return JSON.parse(readFileSync(join(d, 'build-report.json'), 'utf8')); } catch { /* next */ } }
  return null;
};
/**
 * Build the copy for `build` into apps/<build>-<inputsHash>/. A directory with exactly that name is reused only if its
 * build-report.json also records every current input (adapter.json hash, framework version, loader, relay, identity, stock build);
 * a stale or partial directory is removed first (unless `inUse(dir)`), because the builder refuses a non-empty --out.
 * `previousCandidate` (the .app now selected) names what changed since it was built: `triggers`.
 * Returns {outDir, candidate, reused, inputsHash, triggers}.
 */
/** The build flags a copy was built with (its build-report.json), as the builder takes them: what a rebuild for an update must pass. */
export function buildFlagsOf(report) {
  return [...(report?.infoPlist?.qaNoRestore ? ['--qa-no-restore'] : []), ...(report?.qaSocketDirs?.applied ? ['--qa-socket-dirs'] : [])];
}
export async function buildCandidate({ layout, profile, stockApp, build, adapterPath, frameworkDir, frameworkVersion, runBuilder, inUse, extraArgs = [], previousCandidate, extraInputs = {} }) {
  const identity = profile?.signingIdentity || '-';
  const inputsHash = await resolveInputsHash({ adapterPath, frameworkDir, identity, frameworkVersion });
  const outDir = join(layout.apps, candidateDirName(build, inputsHash));
  const inputs = { ...(await candidateInputs({ adapterPath, frameworkDir, identity, frameworkVersion, build })), ...extraInputs };
  const prevReport = previousCandidate ? readReportSync(previousCandidate) : null;
  const triggers = prevReport ? diffInputs(prevReport, inputs) : previousCandidate ? ['unknown (the selected copy has no build report)'] : ['first build'];
  if (await exists(join(outDir, 'build-report.json'))) {
    const app = findAppSync(outDir);
    const stale = diffInputs(readReportSync(outDir), inputs);
    if (app && stale.length === 0) return { outDir, candidate: app, reused: true, inputsHash, triggers: [] };
  }
  if (await exists(outDir)) {
    if (inUse && await inUse(outDir)) throw new CodexModsError('Conflict', `${outDir} is incomplete or stale but in use; refusing to rebuild over it`);
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdirs(layout.apps, outDir);
  try {
    await runBuilder(builderArgs({ layout, profile, stockApp, adapterPath, frameworkDir, frameworkVersion, outDir, extraArgs }));
  } catch (e) {
    await rm(outDir, { recursive: true, force: true });
    throw e;
  }
  const app = findAppSync(outDir);
  if (!app) {
    await rm(outDir, { recursive: true, force: true });
    throw new CodexModsError('Unavailable', `the builder finished but produced no .app in ${outDir}`);
  }
  return { outDir, candidate: app, reused: false, inputsHash, triggers };
}

// ------------------------------------------------------------------ management client (JSONL over mgmt.sock)
/**
 * Connects to the Host's management socket; resolves null when no Host answers: no token, no socket, a stale socket or token left
 * by a crashed Host (error or close before connecting), or no connection within `connectTimeoutMs` (default 2 s).
 */
export function connectManagement(layout, { timeoutMs = 5000, connectTimeoutMs = 2000 } = {}) {
  return new Promise((res) => {
    const socketPath = join(layout.run, SOCKETS.management);
    const tokenPath = join(layout.run, 'mgmt.token');
    let token;
    try { token = readFileSync(tokenPath, 'utf8').trim(); } catch { return res(null); }
    let connected = false, settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(connectTimer); res(v); } };
    const sock = createConnection(socketPath);
    const connectTimer = setTimeout(() => { sock.destroy(); settle(null); }, connectTimeoutMs);
    let buf = ''; let nextId = 1; const pending = new Map();
    const fail = (e) => { for (const p of pending.values()) p.rej(e); pending.clear(); };
    sock.setEncoding('utf8');
    sock.on('error', (e) => { if (!connected) { sock.destroy(); settle(null); } else fail(e); });
    sock.once('connect', () => { connected = true; settle(client); });
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        const p = pending.get(m.id);
        if (!p) continue;
        pending.delete(m.id);
        if (m.ok) p.res(m.result); else p.rej(CodexModsError.fromJSON(m.error));
      }
    });
    sock.once('close', () => { if (!connected) settle(null); fail(new CodexModsError('Unavailable', 'management connection closed')); });
    const client = {
      request(method, params = {}) {
        return new Promise((resolveReq, rejectReq) => {
          const id = nextId++;
          const timer = setTimeout(() => { pending.delete(id); rejectReq(new CodexModsError('Timeout', `${method} timed out`)); }, timeoutMs);
          pending.set(id, { res: (v) => { clearTimeout(timer); resolveReq(v); }, rej: (e) => { clearTimeout(timer); rejectReq(e); } });
          sock.write(JSON.stringify({ id, method, params, token }) + '\n');
        });
      },
      close() { sock.destroy(); },
    };
  });
}
/** Poll ops.get until the op leaves 'running'. */
export async function waitForOp(client, opId, { intervalMs = 300, timeoutMs = 10 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const op = await client.request('ops.get', { opId });
    if (op.outcome !== 'running') return op;
    if (Date.now() - t0 > timeoutMs) throw new CodexModsError('Timeout', `operation ${opId} is still running`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
