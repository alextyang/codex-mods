// What the setup app does (README "Quick start"; the install flow's Check, Choose, Build and Done): it checks this Mac, backs up the Codex
// data, runs `codexmods setup` (the framework installed, the copy built from the installed ChatGPT, signed, checked to be isolated, and its
// launch path made), puts the copy in the Dock and sets how its updates go. It uninstalls as well: the copy and the framework's code go and
// the Dock is put back, while the mods, their data and settings, the try-it copy's own chats and every backup stay where they are, so
// setting up again brings them back. Nothing here deletes data the user made. Node built-ins and the framework's own modules only.
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { layout as makeLayout, resolveRoot } from '../contracts/layout.mjs';
import { STOCK_APP, readAppBuildSync, runBuilderProcess, frameworkVersionOf, FRAMEWORK_TREE } from '../framework/host/recovery/support.mjs';
import { writeJsonAtomic, readJson } from '../framework/host/fsutil.mjs';
import { createUpdateState } from '../framework/host/updates/detector.mjs';
import { run as setupCommand } from '../cli/commands/setup.mjs';
import { readDock, writeDock, placeCopy, removeCopy } from './dock.mjs';

/** The oldest Node the framework runs on. */
export const NODE_MAJOR = 24;
/**
 * What uninstall removes under the root: in each of these folders, only the entries the framework makes there, named as it names them
 * (built copies, framework versions and their pointers, adapter packs, update staging), all made again by setup; the folder itself goes
 * once nothing else is in it. Anything else, anywhere, stays (review 2026-11-07 #1).
 */
export const OWNED = Object.freeze({
  apps: async (name, s) => s.isDirectory() && /^\d[\d.]*-\d+-[0-9a-f]{16}$/.test(name),
  framework: async (name, s, dir) => (s.isFile() && ['current', 'previous', 'lkg'].includes(name))
    || (s.isDirectory() && (/^\.install-.+\.tmp$/.test(name) || await exists(join(dir, name, 'framework', 'main', 'index.cjs')))),
  adapters: async (name, s, dir) => s.isDirectory() && (/^\.setup-[0-9a-f]+$/.test(name) || await exists(join(dir, name, 'adapter.json'))),
  updates: async (name, s) => s.isDirectory() && ['stock', 'framework', 'git', 'fetched', 'leases', 'mods'].includes(name),
});
export const REMOVED = Object.freeze(Object.keys(OWNED));
/** A folder Codex Mods set up: its framework pointer or the setup app's record is there. */
const isRoot = async (root) => (await exists(join(root, 'framework', 'current'))) || (await exists(join(root, 'setup.json')));

/**
 * What a backup leaves out of the Codex data: the chats (their transcripts, their index and locks) and the worktrees chats run in. They are
 * most of its size, often many gigabytes; they stay where they are, and nothing setup does changes them.
 */
export const NOT_BACKED_UP = Object.freeze(['sessions', 'archived_sessions', 'session_index.jsonl', 'session_index.jsonl.lock', 'thread-writer-locks', 'worktrees']);

/**
 * A copy of the Codex data, but for NOT_BACKED_UP, in a new folder of its own under `base` (never one another backup has): an APFS clone of
 * each item when it can, a plain copy otherwise. A link to the data folder is followed; links inside it stay links (review #3, #4). Answers
 * the folder.
 */
export async function backupCodex(from, base) {
  const src = await realpath(from);
  const items = (await readdir(src)).filter((n) => !NOT_BACKED_UP.includes(n));
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const clone of [true, false]) {
    const to = await mkdtemp(join(base, `codex-${stamp()}-`));
    let failed = null;
    for (const n of items) {
      const r = await exec('/bin/cp', [clone ? '-cRp' : '-Rp', join(src, n), to], { timeout: 30 * 60_000 });
      if (!r.ok) { failed = r.err.trim(); break; }
    }
    if (!failed) return to;
    await rm(to, { recursive: true, force: true });
    if (!clone) throw new Error(`the backup failed: ${failed}`);
  }
  throw new Error('the backup failed');
}

/** How big a backup of the Codex data is (what NOT_BACKED_UP leaves out not counted), or null. */
async function backupBytesOf(home, du) {
  const src = await realpath(home).catch(() => null);
  if (!src) return null;
  let total = 0;
  for (const n of await readdir(src)) {
    if (NOT_BACKED_UP.includes(n)) continue;
    const b = await du(join(src, n));
    if (b == null) return null;
    total += b;
  }
  return total;
}

const exec = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...opts }, (e, out, err) => res({ ok: !e, out: String(out ?? ''), err: String(err ?? e?.message ?? '') })));
const exists = (p) => lstat(p).then(() => true, () => false);
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** The builds this framework has adapter packs for, newest last (`<version>-<build>`, as `readAppBuildSync` names one). */
export async function supportedBuilds(sourceRoot) {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(join(sourceRoot, 'adapters')).catch(() => []);
  const builds = [];
  for (const n of names) if (/^\d/.test(n) && await exists(join(sourceRoot, 'adapters', n, 'adapter.json'))) builds.push(n);
  const key = (b) => b.split(/[.-]/).map(Number);
  return builds.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
}

/** This user's processes as [pid, command path]. */
async function processes() {
  const r = await exec('/bin/ps', ['-x', '-U', String(process.getuid()), '-o', 'pid=,comm=']);
  return r.out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]);
}

/**
 * @param {{ home?: string, env?: object, sourceRoot?: string, stockApp?: string, deps?: object }} [o]  `deps` stand in for the Mac in tests:
 *   readBuild, identities, processes, du, backup, setup (the setup command's run), readDock, writeDock, open
 */
export function createSteps(o = {}) {
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const d = o.deps ?? {};
  const sourceRoot = resolve(o.sourceRoot ?? FRAMEWORK_TREE);
  const { root, profile } = resolveRoot(env);
  const L = makeLayout(root, profile);
  const stockApp = o.stockApp ?? env.CODEX_MODS_SETUP_STOCK ?? STOCK_APP;
  const codexHome = join(home, '.codex');
  const appPath = join(home, 'Applications', 'ChatGPT Mods.app');
  const record = join(root, 'setup.json');   // what the setup app did: the mode, the Dock's record, the backup

  const ps = d.processes ?? processes;
  async function running() {
    const list = await ps();
    const real = await readlink(appPath).catch(() => null);
    return {
      chatgpt: list.filter(([, c]) => c === join(stockApp, 'Contents', 'MacOS', 'ChatGPT')).map(([p]) => p),
      codex: list.filter(([, c]) => /(^|\/)codex$/.test(c)).map(([p]) => p),
      copy: list.filter(([, c]) => c.startsWith(L.apps + sep) || (real && c.startsWith(resolve(real) + sep))).map(([p]) => p),
    };
  }

  async function identities() {
    if (d.identities) return d.identities();
    const r = await exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    return [...new Set([...r.out.matchAll(/"(Apple Development: [^"]+)"/g)].map((m) => m[1]))];
  }

  async function bytesOf(path) {
    if (d.du) return d.du(path);
    const r = await exec('/usr/bin/du', ['-sk', path], { timeout: 60000 });
    const k = Number(/^(\d+)/.exec(r.out)?.[1]);
    return Number.isFinite(k) ? k * 1024 : null;
  }

  /** The install as the setup app (or the CLI) left it, or null. */
  async function installed() {
    const config = await readJson(L.profileConfig, null);
    if (!config) return null;
    const link = await readlink(config.appPath ?? appPath).catch(() => null);
    const version = (await readFile(L.frameworkCurrent, 'utf8').catch(() => '')).trim();
    if (!link && !version) return null;
    const rec = await readJson(record, null);
    return { root, appPath: config.appPath ?? appPath, target: link, daily: config.codexHome === codexHome, framework: version || null, dock: Boolean(rec?.dock), backup: rec?.backup ?? null };
  }

  return {
    root, appPath, codexHome, stockApp,

    /** What this Mac has, and what a copy needs of it. */
    async check() {
      let stock = { path: stockApp, found: false };
      try {
        const b = (d.readBuild ?? readAppBuildSync)(stockApp);
        stock = { path: stockApp, found: true, version: b.short, bundle: b.bundle, build: b.build };
      } catch { /* not installed */ }
      const builds = await supportedBuilds(sourceRoot);
      if (stock.found) stock.supported = builds.includes(stock.build);
      const newest = builds.at(-1) ?? null;
      const major = Number(String(o.nodeVersion ?? process.versions.node).split('.')[0]);
      const hasCodex = await exists(codexHome);
      return {
        stock, newest: newest ? newest.split('-')[0] : null,
        node: { version: o.nodeVersion ?? process.versions.node, ok: major >= NODE_MAJOR },
        identities: await identities(),
        codex: { path: codexHome, exists: hasCodex, bytes: hasCodex ? await bytesOf(codexHome) : 0, backupBytes: hasCodex ? await backupBytesOf(codexHome, bytesOf) : 0 },
        running: await running(),
        installed: await installed(),
        framework: await frameworkVersionOf(sourceRoot).catch(() => null),
      };
    },

    /**
     * Set up: `choice` is { mode: 'daily'|'try', identity, backup, autoUpdate (null: as it is), dock }. `onStep(id, status, detail)` hears each step as it
     * goes (status running, done, skipped or failed). Answers what was made. A refusal (ChatGPT still open, no identity for everyday use) is
     * thrown before anything changes.
     */
    async install(choice, onStep = () => {}) {
      const daily = choice?.mode === 'daily';
      // a copy to try is signed ad hoc: no certificate, and no Keychain prompt while it is built
      const identity = daily && typeof choice?.identity === 'string' && choice.identity ? choice.identity : '-';
      if (daily && identity === '-') throw new Error('Everyday use needs your Apple Development certificate.');
      const busy = await running();
      if ((daily || choice.backup) && (busy.chatgpt.length || busy.codex.length)) throw new Error('Quit ChatGPT and any codex sessions first, so your Codex data is complete.');
      if (busy.copy.length) throw new Error('Quit ChatGPT Mods first.');
      const there = await readdir(root).catch(() => []);
      if (there.some((n) => n !== '.DS_Store') && !(await isRoot(root))) throw new Error(`${root} has other files in it; Codex Mods sets up only in an empty folder or its own.`);
      const out = { appPath, root };
      const step = async (id, fn) => {
        onStep(id, 'running');
        try { const r = await fn(); onStep(id, r?.skipped ? 'skipped' : 'done', r?.detail); return r; } catch (e) { onStep(id, 'failed', String(e?.message ?? e)); throw e; }
      };

      await step('backup', async () => {
        if (!choice.backup || !(await exists(codexHome))) return { skipped: true, detail: choice.backup ? 'No Codex data yet' : 'Not chosen' };
        const dest = await (d.backup ?? backupCodex)(codexHome, join(home, 'CodexModsBackup'));
        out.backup = dest;
        return { detail: dest };
      });

      // the setup command: the framework, then the copy (the builder's part reported as it starts)
      let building = false;
      onStep('framework', 'running');
      const lines = [];
      const io = {
        env: { ...env }, stdout: { write: (t) => lines.push(String(t)) }, stderr: { write: (t) => lines.push(String(t)) },
        deps: {
          home,
          runBuilder: (args) => {
            building = true;
            onStep('framework', 'done');
            onStep('copy', 'running');
            return (d.runBuilder ?? runBuilderProcess)(args, { spawnFn: (...a) => { const c = spawn(...a); const tell = (b) => onStep('copy', 'running', String(b).trim().split('\n').at(-1)); c.stdout?.on('data', tell); c.stderr?.on('data', tell); return c; } });
          },
        },
      };
      const argv = ['--json', daily ? '--daily' : '--try', '--identity', identity, ...(stockApp !== STOCK_APP ? ['--stock', stockApp] : [])];
      const code = await (d.setup ?? setupCommand)(argv, io);
      if (code !== 0) {
        const said = lines.join('').trim().split('\n').at(-1) ?? '';
        let msg = said;
        try { msg = JSON.parse(said)?.error?.message ?? said; } catch { /* plain text */ }
        onStep(building ? 'copy' : 'framework', 'failed', msg);
        throw new Error(msg || `setup failed (${code})`);
      }
      if (!building) onStep('framework', 'done');
      onStep('copy', 'done', '');

      await step('dock', async () => {
        if (!choice.dock) return { skipped: true, detail: 'Not chosen' };
        const bundleId = (await exec('/usr/bin/defaults', ['read', join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier'])).out.trim() || undefined;
        const dock = await (d.readDock ?? readDock)();
        const placed = placeCopy(dock, { copy: appPath, chatgpt: stockApp, label: 'ChatGPT Mods', bundleId, replace: daily });
        if (!placed) return { detail: 'Already in your Dock' };
        // what to put back, and the Dock as it was, kept before the Dock changes (review #5)
        const rec = await readJson(record, null);
        await writeJsonAtomic(record, { ...(rec ?? {}), mode: daily ? 'daily' : 'try', at: rec?.at ?? new Date().toISOString(), dock: placed.record });
        await writeJsonAtomic(join(root, 'setup-dock-before.json'), dock);
        await (d.writeDock ?? writeDock)(placed.dock);
        out.dock = placed.record;
        return { detail: daily ? 'In ChatGPT’s place' : 'Beside ChatGPT' };
      });

      await step('updates', async () => {
        if (choice.autoUpdate !== true && choice.autoUpdate !== false) return { skipped: true, detail: 'Unchanged' };
        await createUpdateState(L).update((s) => { s.policy = choice.autoUpdate ? 'auto' : 'offer'; });
        return { detail: choice.autoUpdate ? 'Rebuilt when ChatGPT updates' : 'Offered when ChatGPT updates' };
      });

      const before = await readJson(record, null);
      await writeJsonAtomic(record, { mode: daily ? 'daily' : 'try', at: new Date().toISOString(), dock: out.dock ?? before?.dock ?? null, backup: out.backup ?? before?.backup ?? null });
      return out;
    },

    /** Open the copy. */
    async open() { return (d.open ?? ((p) => exec('/usr/bin/open', [p])))(appPath); },
    /** Show a path in the Finder: the backup, or the root. */
    async reveal(path) {
      const p = resolve(path);
      if (!(p === root || p.startsWith(join(home, 'CodexModsBackup') + sep))) throw new Error('not a path the setup app shows');
      return (d.open ?? ((x) => exec('/usr/bin/open', ['-R', x])))(p);
    },

    /**
     * Uninstall: the Dock put back, the launch path and what OWNED names under the root gone. Refused while the copy runs. Answers what
     * went and what stayed.
     */
    async uninstall(onStep = () => {}) {
      if ((await running()).copy.length) throw new Error('Quit ChatGPT Mods first.');
      const rootStat = await lstat(root).catch(() => null);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !(await isRoot(root))) throw new Error(`Codex Mods is not set up here (${root}).`);
      const rec = await readJson(record, null);
      onStep('dock', 'running');
      const dock = await (d.readDock ?? readDock)();
      const next = removeCopy(dock, { copy: appPath, chatgpt: stockApp, record: rec?.dock ?? null });
      if (next) await (d.writeDock ?? writeDock)(next);
      onStep('dock', next ? 'done' : 'skipped', next ? (rec?.dock?.original ? 'ChatGPT is back in your Dock' : 'Taken out of your Dock') : 'Not in your Dock');
      onStep('copy', 'running');
      const removed = [];
      const link = await lstat(appPath).catch(() => null);
      if (link?.isSymbolicLink()) {
        const target = resolve(join(appPath, '..'), await readlink(appPath));
        if (target.startsWith(L.apps + sep)) { await rm(appPath); removed.push(appPath); }
      }
      for (const [name, owned] of Object.entries(OWNED)) {
        const dir = join(root, name);
        const s = await lstat(dir).catch(() => null);
        if (!s?.isDirectory() || s.isSymbolicLink()) continue;
        for (const entry of await readdir(dir)) {
          const p = join(dir, entry);
          const st = await lstat(p).catch(() => null);
          if (st && !st.isSymbolicLink() && await owned(entry, st, dir)) { await rm(p, { recursive: true, force: true }); removed.push(p); }
        }
        if (!(await readdir(dir)).filter((n) => n !== '.DS_Store').length) await rm(dir, { recursive: true, force: true });
      }
      if (rec) await writeJsonAtomic(record, { ...rec, uninstalledAt: new Date().toISOString(), dock: null });
      onStep('copy', 'done');
      return { removed, kept: root };
    },

    /** How big a path is now (the Build step's detail for the backup), or null. */
    async size(path) { return (await stat(path).catch(() => null)) ? bytesOf(path) : null; },
  };
}
