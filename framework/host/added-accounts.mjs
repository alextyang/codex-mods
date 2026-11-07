// Added accounts (docs/design/reference-mods.md RM10, GOAL.md goal 26): the framework's own backends, one per ChatGPT account the user adds
// beside the app's. Each runs an app-server (a framework backend, framework/host/mux) with a Codex home of its own that holds its sign-in
// only: its auth.json, which that app-server writes and refreshes itself through its own sign-in, file-backed (never the Keychain), and
// which nothing else reads. The rest of the user's Codex is the app's own home, linked into it: the chats (sessions, the thread writer
// locks, and the sqlite stores through CODEX_SQLITE_HOME), config.toml, AGENTS.md, skills, prompts, rules, plugins and worktrees. So a chat
// moved to an added account is the same chat with the same setup, its turns run with that account's usage, and the app lists it as ever.
// Kept in <backends>/framework/accounts.json: the accounts (by key), where each placed chat runs, and where new chats start; restored at
// start. Removing an account removes its home: the links in it go, never what they point to.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const OWNER = 'framework';
/** The app home's folders an added account shares, made there when missing (a link to a folder that does not exist cannot be filled). */
export const SHARED_DIRS = Object.freeze(['sessions', 'archived_sessions', 'thread-writer-locks', 'worktrees']);
/** Files an added account shares whether or not they exist yet (writing through the link makes them in the app's home). */
export const SHARED_FILES = Object.freeze(['config.toml', 'AGENTS.md', 'session_index.jsonl', 'session_index.jsonl.lock']);
/** What else of the app's home it shares, when the app's home has it. */
export const SHARED_IF_PRESENT = Object.freeze(['installation_id', 'project-metadata-locks', 'skills', 'prompts', 'rules', 'plugins', 'memories',
  'plans', 'automations', 'vendor_imports', 'visualizations', 'hooks.json']);
const KEY_RE = /^acct-[0-9a-f]{8}$/;
const SAVE_MS = 500;

export const backendIdOf = (key) => `${OWNER}/${key}`;
export const keyOfBackend = (id) => (typeof id === 'string' && id.startsWith(`${OWNER}/`) && KEY_RE.test(id.slice(OWNER.length + 1)) ? id.slice(OWNER.length + 1) : null);

/** The app's sqlite home, for an added account's CODEX_SQLITE_HOME; none when the shared config.toml names one itself (it then applies). */
export function sqliteHomeOf(appHome, env = process.env) {
  let toml = '';
  try { toml = fs.readFileSync(path.join(appHome, 'config.toml'), 'utf8'); } catch { /* none */ }
  const top = toml.split(/^\s*\[/m)[0];   // the keys before the first table
  if (/^\s*sqlite_home\s*=/m.test(top)) return null;
  return typeof env.CODEX_SQLITE_HOME === 'string' && env.CODEX_SQLITE_HOME ? env.CODEX_SQLITE_HOME : appHome;
}

/**
 * @param {{ mux: { defineBackend(owner: string, key: string, def: object): Promise<void>, removeBackend(owner: string, key: string): Promise<void>,
 *   place(key: string, to: string): boolean, onPlaced(fn: (c: { key: string, backend: string }) => void): { dispose(): void },
 *   setStartBackend(id: string | null): void }, dir: string, appHome: string, log: { info(m: string, d?: unknown): void, warn(m: string, d?: unknown): void },
 *   env?: Record<string, string | undefined> }} o  dir: <backends>/framework
 */
export function createAddedAccounts(o) {
  const { mux, dir, appHome, log } = o;
  const file = path.join(dir, 'accounts.json');
  const homeOf = (key) => path.join(dir, 'accounts', key, 'codex-home');
  /** @type {{ accounts: { key: string, addedAt: number }[], placed: Record<string, string>, start: string | null }} */
  let state = { accounts: [], placed: {}, start: null };
  let saveTimer = null, sub = null, disposed = false;
  const listeners = new Set();

  function load() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      const accounts = Array.isArray(v?.accounts) ? v.accounts.filter((a) => typeof a?.key === 'string' && KEY_RE.test(a.key)).map((a) => ({ key: a.key, addedAt: Number(a.addedAt) || 0 })) : [];
      const keys = new Set(accounts.map((a) => a.key));
      const placed = {};
      for (const [t, k] of Object.entries(v?.placed && typeof v.placed === 'object' ? v.placed : {})) if (keys.has(k)) placed[t] = k;
      state = { accounts, placed, start: keys.has(v?.start) ? v.start : null };
    } catch (e) { if (e?.code !== 'ENOENT') log.warn('added accounts: their record could not be read; none are restored', { message: String(e?.message ?? e) }); }
  }
  /** Write the record now; false when it could not be written. */
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) { log.warn('added accounts: their record was not written', { message: String(e?.message ?? e) }); return false; }
  }
  const save = () => { if (!disposed) saveTimer ??= setTimeout(saveNow, SAVE_MS); };

  /** A link at `at` to `target`; something else already there (the account's own) is left alone. */
  function link(target, at) {
    let st = null;
    try { st = fs.lstatSync(at); } catch { /* none */ }
    if (st) {
      if (st.isSymbolicLink() && fs.readlinkSync(at) === target) return;
      if (st.isSymbolicLink()) { fs.unlinkSync(at); } else return;
    }
    fs.symlinkSync(target, at);
  }
  /** Its home: made private, the app's chats and setup linked in. Run at every start, so what the app's home gained since is shared too. */
  function prepare(key) {
    const home = homeOf(key);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(home), 0o700);
    fs.chmodSync(home, 0o700);
    for (const d of SHARED_DIRS) { fs.mkdirSync(path.join(appHome, d), { recursive: true }); link(path.join(appHome, d), path.join(home, d)); }
    for (const f of SHARED_FILES) link(path.join(appHome, f), path.join(home, f));
    for (const x of SHARED_IF_PRESENT) if (fs.existsSync(path.join(appHome, x))) link(path.join(appHome, x), path.join(home, x));
    return home;
  }
  function definitionOf(key) {
    const sqlite = sqliteHomeOf(appHome, o.env ?? process.env);
    return {
      codexHome: path.relative(dir, homeOf(key)),
      env: sqlite ? { CODEX_SQLITE_HOME: sqlite } : {},
      config: { cli_auth_credentials_store: 'file' },   // its sign-in in its own home's auth.json, never the Keychain
      idleStopMs: null,   // it runs while the Host does: its sign-in stays refreshed and its chats loaded
    };
  }
  async function define(key) {
    prepare(key);
    await mux.defineBackend(OWNER, key, definitionOf(key));
  }
  const tell = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { log.warn('added accounts: a listener failed', { message: String(e?.message ?? e) }); } } };

  return {
    /** Restore the accounts, their backends and where their chats run. */
    async start() {
      load();
      for (const a of [...state.accounts]) {
        try { await define(a.key); } catch (e) { log.warn('added accounts: an account could not be restored', { key: a.key, message: String(e?.message ?? e) }); }
      }
      for (const [thread, key] of Object.entries(state.placed)) mux.place(thread, backendIdOf(key));
      if (state.start) { try { mux.setStartBackend(backendIdOf(state.start)); } catch { state.start = null; } }
      sub = mux.onPlaced(({ key: thread, backend }) => {
        const key = keyOfBackend(backend);
        if (key && state.accounts.some((a) => a.key === key)) { if (state.placed[thread] === key) return; state.placed[thread] = key; }
        else if (thread in state.placed) delete state.placed[thread];
        else return;
        save();
      });
    },
    /** The accounts, oldest first: their keys and backend ids. */
    list: () => state.accounts.map((a) => ({ key: a.key, backend: backendIdOf(a.key), addedAt: a.addedAt })),
    has: (key) => state.accounts.some((a) => a.key === key),
    /** A new account: its home and backend (not started: it starts when it is first asked). */
    async add() {
      const key = `acct-${randomBytes(4).toString('hex')}`;
      await define(key);
      state.accounts.push({ key, addedAt: Date.now() });
      saveNow();
      log.info('added accounts: an account was added', { key });
      tell();
      return { key, backend: backendIdOf(key) };
    },
    /** Remove an account (its chats were moved off it first): its backend stops, its record and its home go. */
    async remove(key) {
      if (!state.accounts.some((a) => a.key === key)) return false;
      await mux.removeBackend(OWNER, key);
      state.accounts = state.accounts.filter((a) => a.key !== key);
      for (const [t, k] of Object.entries(state.placed)) if (k === key) delete state.placed[t];
      if (state.start === key) state.start = null;
      saveNow();
      // rm does not follow links: the app's chats and setup stay where they are
      try { fs.rmSync(path.join(dir, 'accounts', key), { recursive: true, force: true }); } catch (e) { log.warn('added accounts: a removed account\'s home was not deleted', { key, message: String(e?.message ?? e) }); }
      log.info('added accounts: an account was removed', { key });
      tell();
      return true;
    },
    /** The account a chat is placed on (its key), or null for the app's. */
    placementOf: (thread) => state.placed[thread] ?? null,
    /** The chats placed on an account. */
    threadsOn: (key) => Object.entries(state.placed).filter(([, k]) => k === key).map(([t]) => t),
    /** Where new chats start: an account's key, or null for the app's. */
    get startKey() { return state.start; },
    setStart(key) {
      if (key !== null && !state.accounts.some((a) => a.key === key)) return false;
      mux.setStartBackend(key === null ? null : backendIdOf(key));
      state.start = key;
      saveNow();
      tell();
      return true;
    },
    onChange(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    homeOf,
    /** Write the record now (a move is recorded before it is released): false when it could not be written. */
    flush: () => saveNow(),
    dispose() { disposed = true; sub?.dispose(); if (saveTimer) saveNow(); },
  };
}
