// ctx.processes: manifest-declared mod processes.
//
// - The command is package-relative: a .mjs runs with process.execPath, anything else is executed directly. Processes stay
//   in the Host's process group (no detach) and receive the environment of contracts/ipc.d.ts §5.
// - The Host listens on layout.run/proc.sock. A process connects, sends one line {process, mod, token}, gets {"ok":true},
//   and then speaks Realm RPC (JSONL) as a ProcessContext. Tokens are 32 random bytes (hex), one per spawn.
// - Supervision: an unexpected exit is a fault; 'with-mod' processes restart with backoff, at most 3 restarts per 10 minutes.
//   On-demand processes start on first call and stop after idleStopMs (default 10 minutes) without use.
// - A session process (graph-integrity G8.2) is long-lived: never stopped for being idle, restarted only as its manifest says
//   (`restart: 'on-failure'`, with the same bounds), started with arguments and a folder of the mod's choosing, fed through its input
//   (`write`), its output given to the mod line by line (`output`). It may run a program on the Mac by name (`executable`, D4): one a
//   `processes.exec` grant names, found on the user's PATH at each start, given the user's environment and none of the framework's
//   connection (it is not the mod's code).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { FLAGS, SOCKETS } from '../../../contracts/layout.mjs';
import { requireGrant, execGranted } from './grants.mjs';
import { createUserPath } from './user-path.mjs';

export const PROCESS_DEFAULTS = Object.freeze({
  maxRestarts: 3, restartWindowMs: 600000, backoffBaseMs: 500, backoffMaxMs: 8000,
  idleStopMs: 600000, stopGraceMs: 3000, connectTimeoutMs: 10000, callDeadlineMs: 30000, handshakeMs: 5000,
});
const EVENTS = new Set(['started', 'exited', 'message', 'output']);
/** A session's start and input (graph-integrity G8.2): bounded, so a mod's call cannot make the Host hold arbitrary amounts. */
const START_ARGS_MAX = 64, ARG_MAX = 8192, WRITE_MAX = 1024 * 1024, LINE_MAX = 1024 * 1024;
/** What a session's input may hold that the process has not taken yet: a write past it waits for the mod (review 2026-11-05 #9). */
const PENDING_MAX = 4 * 1024 * 1024;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A stream's lines, each at most `max` characters (a longer one is cut there, `truncated`, the rest of it dropped). */
function eachLine(stream, max, fn) {
  stream.setEncoding('utf8');
  let buf = '', dropping = false;
  stream.on('data', (chunk) => {
    let s = chunk;
    for (;;) {
      const nl = s.indexOf('\n');
      if (nl < 0) {
        if (!dropping) {
          buf += s;
          if (buf.length > max) { fn(buf.slice(0, max), true); buf = ''; dropping = true; }
        }
        return;
      }
      if (!dropping) { const line = buf + s.slice(0, nl); buf = ''; fn(line.length > max ? line.slice(0, max) : line, line.length > max); }
      else dropping = false;
      s = s.slice(nl + 1);
    }
  });
  stream.on('end', () => { if (buf && !dropping) fn(buf, false); buf = ''; });
}

const generationOf = (layout) => {
  if (process.env.CODEX_MODS_GENERATION) return process.env.CODEX_MODS_GENERATION;
  try { return String(JSON.parse(readFileSync(join(layout.flags, FLAGS.bootMarker), 'utf8')).generation ?? 0); } catch { return '0'; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProcessManager({ layout, log, internals = {}, authenticated, fault }) {
  const cfg = { ...PROCESS_DEFAULTS, ...(internals.processes ?? {}) };
  // where a session's program is found: the user's PATH (tests give their own)
  const userPath = internals.userPath ?? createUserPath();
  const socketPath = join(layout.run, SOCKETS.processes);
  const tokens = new Map();           // token → Proc
  let server = null;
  let serverReady = null;
  const sockets = new Set();

  // ---------------------------------------------------------------- proc.sock
  function ensureServer() {
    serverReady ??= (async () => {
      if (Buffer.byteLength(socketPath) >= 100) throw new CodexModsError('Invalid', 'the run directory path is too long for a Unix socket');
      await mkdir(layout.run, { recursive: true, mode: 0o700 });
      await rm(socketPath, { force: true });
      server = net.createServer(onConnection);
      await new Promise((res, rej) => { server.once('error', rej); server.listen(socketPath, () => { server.off('error', rej); res(); }); });
      await chmod(socketPath, 0o600);
    })().catch((e) => { serverReady = null; throw e; });
    return serverReady;
  }

  function onConnection(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => socket.destroy(), cfg.handshakeMs);
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) { if (buf.length > 4096) { clearTimeout(timer); socket.destroy(); } return; }
      socket.off('data', onData); clearTimeout(timer);
      handshake(socket, buf.slice(0, nl), buf.slice(nl + 1));
    };
    socket.on('data', onData);
  }

  function handshake(socket, line, rest) {
    let h; try { h = JSON.parse(line); } catch { socket.destroy(); return; }
    const p = typeof h?.token === 'string' ? tokens.get(h.token) : undefined;
    if (!p || p.state.id !== h.mod || p.name !== h.process || p.conn) {
      log.warn('proc.sock handshake refused', { mod: typeof h?.mod === 'string' ? h.mod : undefined });
      socket.end('{"ok":false}\n');
      return;
    }
    socket.write('{"ok":true}\n');
    authenticated(socket, rest, { modId: p.state.id, process: p.name });
  }

  // ---------------------------------------------------------------- per-mod controller
  function forMod(state) {
    const procs = new Map();
    // a session declared with `instances` runs as several at once, each addressed as `name#key` (a key: letters, digits, "_", "-")
    const declOf = (name) => {
      const [base, key, extra] = typeof name === 'string' ? name.split('#') : [];
      const decl = typeof base === 'string' ? state.mod.manifest.processes?.[base] : undefined;
      if (!decl || !Object.hasOwn(state.mod.manifest.processes, base) || extra !== undefined) {
        throw new CodexModsError('Denied', `process ${String(name)} is not declared in the manifest`);
      }
      if (key !== undefined && (!Number.isInteger(decl.instances) || !/^[A-Za-z0-9_-]{1,64}$/.test(key))) {
        throw new CodexModsError('Invalid', `process ${base} runs as one: it is addressed by its name alone`);
      }
      return decl;
    };
    const baseOf = (name) => name.split('#')[0];
    const procFor = (name) => {
      let p = procs.get(name);
      if (!p) {
        const decl = declOf(name);
        p = { state, name, decl, session: decl.kind === 'session', status: 'stopped', child: null, token: null, conn: null, serve: null,
          listeners: new Map(), idleTimer: null, restartTimer: null, crashes: [], stopRequested: false, exited: null, waiters: new Set(), starting: null,
          last: null,     // a session's last start: {args, cwd}, what a restart starts it with again
          behind: new Set() };   // its output's listeners whose realm is behind
        procs.set(name, p);
      }
      return p;
    };
    // A listener's channel says when its realm is behind (false); a session's output then waits (its streams paused, the program held at its
    // pipe) until each such listener caught up (its `resume`): nothing queues without bound in the Host (review 2026-11-05 #10)
    const emit = (p, event, data) => {
      for (const fn of [...(p.listeners.get(event) ?? [])]) {
        let ok;
        try { ok = fn(data); } catch { ok = true; /* listener errors */ }
        if (ok === false && event === 'output') { p.behind.add(fn); holdOutput(p, true); }
      }
    };
    const holdOutput = (p, hold) => {
      const child = p.child;
      if (!child) return;
      for (const s of [child.stdout, child.stderr]) { try { if (hold) s?.pause(); else s?.resume(); } catch { /* gone */ } }
    };
    const caughtUp = (p, fn) => { if (p.behind.delete(fn) && !p.behind.size) holdOutput(p, false); };
    const wake = (p) => { for (const w of [...p.waiters]) w(); };
    const touch = (p) => {
      clearTimeout(p.idleTimer); p.idleTimer = null;
      if (!p.session && p.decl.start === 'on-demand' && p.status === 'running') {
        p.idleTimer = setTimeout(() => { stopProc(p).catch(() => {}); }, p.decl.idleStopMs ?? cfg.idleStopMs);
        p.idleTimer.unref?.();
      }
    };

    /** A session's start as the mod asks it (G8.2): more arguments after the manifest's, and the folder it runs in. */
    async function startOptions(p, opts) {
      if (opts === undefined || opts === null) return p.session ? { args: [], cwd: null } : null;
      if (!p.session) throw new CodexModsError('Invalid', `process ${p.name} is not a session: it takes no options at its start`);
      if (!isObj(opts) || Object.keys(opts).some((k) => k !== 'args' && k !== 'cwd')) throw new CodexModsError('Invalid', 'a session starts with {args?, cwd?}');
      const args = opts.args ?? [];
      if (!Array.isArray(args) || args.length > START_ARGS_MAX || args.some((a) => typeof a !== 'string' || a.length > ARG_MAX || a.includes('\u0000'))) {
        throw new CodexModsError('Invalid', `args is a list of at most ${START_ARGS_MAX} strings of at most ${ARG_MAX} characters`);
      }
      let cwd = null;
      if (opts.cwd !== undefined) {
        if (typeof opts.cwd !== 'string' || !isAbsolute(opts.cwd) || opts.cwd.includes('\u0000')) throw new CodexModsError('Invalid', 'cwd is an absolute path');
        const s = await stat(opts.cwd).catch(() => null);
        if (!s?.isDirectory()) throw new CodexModsError('Invalid', `cwd ${opts.cwd} is not a folder`);
        cwd = opts.cwd;
      }
      return { args: [...args], cwd };
    }

    function startProc(p, opts) {
      if (p.status === 'running') {
        if (opts !== undefined && opts !== null) return Promise.reject(new CodexModsError('Invalid', `process ${p.name} is running: stop it to start it with other options`));
        return Promise.resolve();
      }
      if (p.starting) return p.starting;
      clearTimeout(p.restartTimer); p.restartTimer = null;
      p.starting = (async () => {
        // Every start path (explicit, on-demand call, with-mod auto-start, supervised restart) needs the consented grant.
        requireGrant(state.grants, 'processes');
        // a program on the Mac: the grant that names it (consent showed it), at every start
        if (p.decl.executable !== undefined && !execGranted(state.grants, p.decl.executable)) {
          throw new CodexModsError('Denied', `this mod has not been granted running ${p.decl.executable} (processes.exec:${p.decl.executable})`);
        }
        if (state.status === 'stopping') throw new CodexModsError('Unavailable', 'the mod is stopping');
        const o = (await startOptions(p, opts)) ?? null;
        const pkg = state.mod.packageDir;
        let file, argv, env, cwd;
        let token = null;
        if (p.decl.executable !== undefined) {
          // found on the user's PATH now (D4), given the user's environment and none of the framework's connection
          file = await userPath.which(p.decl.executable);
          if (!file) throw new CodexModsError('Unavailable', `${p.decl.executable} is not installed (not found on your PATH)`);
          argv = [...(p.decl.args ?? []), ...(o?.args ?? [])];
          env = { ...process.env, PATH: await userPath.path(), CODEX_MODS_GENERATION: generationOf(layout) };
          for (const k of ['CODEX_MODS_PROC_SOCKET', 'CODEX_MODS_PROC_TOKEN', 'ELECTRON_RUN_AS_NODE']) delete env[k];
          cwd = o?.cwd ?? homedir();
        } else {
          await ensureServer();
          const abs = resolve(pkg, p.decl.command);
          const rel = relative(pkg, abs);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new CodexModsError('Denied', 'process command escapes the package directory');
          token = randomBytes(32).toString('hex');
          const isMjs = abs.endsWith('.mjs');
          file = isMjs ? process.execPath : abs;
          argv = [...(isMjs ? [abs] : []), ...(p.decl.args ?? []), ...(o?.args ?? [])];
          env = {
            ...process.env,
            CODEX_MODS_PROC_SOCKET: socketPath, CODEX_MODS_PROC_TOKEN: token,
            CODEX_MODS_MOD_ID: state.id, CODEX_MODS_PROCESS: p.name,
            CODEX_MODS_GENERATION: generationOf(layout),
            // When the Host is an Electron utility process, execPath is the Electron binary: make it behave as plain Node.
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          };
          cwd = o?.cwd ?? pkg;
        }
        const child = spawn(file, argv, { cwd, env, stdio: [p.session ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        child.on('error', () => {});
        try { await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); }); }
        catch (e) { throw new CodexModsError('Unavailable', `could not start process ${p.name}: ${e.code ?? e.message}`); }
        state.effects = true;
        p.child = child; p.token = token; p.status = 'running'; p.stopRequested = false;
        if (p.session) p.last = o;
        p.exited = new Promise((res) => { p.resolveExit = res; });
        if (token) tokens.set(token, p);
        child.stdin?.on('error', () => {});   // a session that closed its input: the next write says so
        if (p.session) {
          // its output is the mod's, line by line; what it says on stderr is logged too
          eachLine(child.stdout, LINE_MAX, (line, truncated) => emit(p, 'output', { stream: 'stdout', line, ...(truncated ? { truncated: true } : {}) }));
          eachLine(child.stderr, LINE_MAX, (line, truncated) => {
            state.logger.write('warn', line.slice(0, 2048), undefined, 'process');
            emit(p, 'output', { stream: 'stderr', line, ...(truncated ? { truncated: true } : {}) });
          });
        } else {
          for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'warn']]) eachLine(stream, 2048, (l) => state.logger.write(level, l, undefined, 'process'));
        }
        child.on('exit', (code, signal) => onExit(p, child, code, signal));
        touch(p);
        emit(p, 'started', { pid: child.pid, ...(p.decl.executable !== undefined ? { executable: file } : {}) });
      })().finally(() => { p.starting = null; });
      return p.starting;
    }

    function onExit(p, child, code, signal) {
      if (p.child !== child) return;
      tokens.delete(p.token);
      clearTimeout(p.idleTimer); p.idleTimer = null;
      // a session that ends by itself with nothing wrong (code 0, no signal) is done, not a failure: not restarted (review 2026-11-05 #11)
      const expected = p.stopRequested || state.status === 'stopping' || (p.session && code === 0 && !signal);
      p.behind.clear();
      p.status = 'stopped'; p.child = null; p.token = null; p.serve = null;
      const conn = p.conn; p.conn = null; conn?.close?.();
      p.resolveExit?.(); p.stopRequested = false;
      emit(p, 'exited', { code, signal });
      wake(p);
      if (expected) return;
      const t = Date.now();
      p.crashes = p.crashes.filter((x) => t - x < cfg.restartWindowMs);
      p.crashes.push(t);
      fault(state.id, 'process', 'exit', `process ${p.name} exited (code ${code}, signal ${signal})`, { count: false });
      // a worker that starts with the mod restarts; a session as its manifest says (G8.2), with the start it had
      if (p.session ? p.decl.restart === 'on-failure' : p.decl.start === 'with-mod') {
        if (p.crashes.length <= cfg.maxRestarts) {
          const delay = Math.min(cfg.backoffBaseMs * 2 ** (p.crashes.length - 1), cfg.backoffMaxMs);
          const again = p.session && p.last ? { args: p.last.args, ...(p.last.cwd ? { cwd: p.last.cwd } : {}) } : undefined;
          p.restartTimer = setTimeout(() => { startProc(p, again).catch((e) => log.warn('process restart failed', { mod: state.id, process: p.name, message: e.message })); }, delay);
          p.restartTimer.unref?.();
        } else {
          fault(state.id, 'process', 'crash-loop', `process ${p.name} exceeded ${cfg.maxRestarts} restarts in 10 minutes; not restarting`);
        }
      }
    }

    async function stopProc(p) {
      clearTimeout(p.restartTimer); p.restartTimer = null;
      clearTimeout(p.idleTimer); p.idleTimer = null;
      if (p.starting) await p.starting.catch(() => {});
      const child = p.child;
      if (!child) return;
      p.stopRequested = true;
      const exited = p.exited;
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), cfg.stopGraceMs);
      try { await Promise.race([exited, sleep(cfg.stopGraceMs + 2000)]); } finally { clearTimeout(t); }
    }

    function waitReady(p) {
      return new Promise((resolveReady, rejectReady) => {
        const check = () => {
          if (p.status !== 'running') { cleanup(); rejectReady(new CodexModsError('Unavailable', `process ${p.name} is not running`)); }
          else if (p.conn && p.serve) { cleanup(); resolveReady(); }
        };
        const timer = setTimeout(() => { cleanup(); rejectReady(new CodexModsError('Unavailable', `process ${p.name} did not connect and register its handlers`)); }, cfg.connectTimeoutMs);
        const cleanup = () => { clearTimeout(timer); p.waiters.delete(check); };
        p.waiters.add(check);
        check();
      });
    }

    const api = {
      declared: (name) => declOf(name),
      async start(name, opts) {
        const p = procFor(name);
        // instances of a session: at most as many running as it declares
        const limit = Number.isInteger(p.decl.instances) ? p.decl.instances : 1;
        if (p.status !== 'running' && !p.starting
          && [...procs.values()].filter((x) => x !== p && baseOf(x.name) === baseOf(name) && (x.status === 'running' || x.starting)).length >= limit) {
          throw new CodexModsError('Busy', `process ${baseOf(name)} runs at most ${limit} at once: stop one first`);
        }
        await startProc(p, opts); touch(p);
      },
      async stop(name) { await stopProc(procFor(name)); },
      /** A session's input (G8.2): written in order, waiting while the process has not taken what was written before. */
      async write(name, data) {
        const p = procFor(name);
        if (!p.session) throw new CodexModsError('Invalid', `process ${name} is not a session: it takes no input`);
        if (typeof data !== 'string' || data.length > WRITE_MAX) throw new CodexModsError('Invalid', `input is a string of at most ${WRITE_MAX} characters`);
        const stdin = p.status === 'running' ? p.child?.stdin : null;
        if (!stdin || stdin.destroyed || stdin.writableEnded) throw new CodexModsError('Unavailable', `process ${name} is not running (or closed its input)`);
        // what it has not taken yet is bounded: a mod that writes without waiting is told to wait
        if (stdin.writableLength + Buffer.byteLength(data) > PENDING_MAX) throw new CodexModsError('Busy', `process ${name} has not taken what was written before (${stdin.writableLength} bytes): wait for those writes`);
        await new Promise((res, rej) => {
          const ok = stdin.write(data, (e) => (e ? rej(new CodexModsError('Unavailable', `process ${name} did not take the input: ${e.code ?? e.message}`)) : null));
          if (ok) res(); else stdin.once('drain', res);
        });
      },
      async call(name, method, params) {
        const p = procFor(name);
        if (typeof method !== 'string' || !method) throw new CodexModsError('Invalid', 'method must be a non-empty string');
        if (p.decl.executable !== undefined) throw new CodexModsError('Invalid', `process ${name} runs ${p.decl.executable}: it is fed through write, and answers on its output`);
        if (p.status !== 'running') {
          const t = Date.now();
          if (p.crashes.filter((x) => t - x < cfg.restartWindowMs).length > cfg.maxRestarts) {
            throw new CodexModsError('Unavailable', `process ${name} keeps crashing and is not being restarted`);
          }
          await startProc(p);
        }
        await waitReady(p);
        touch(p);
        const { serve } = p;
        return serve.invoke([method, params === undefined ? null : params], cfg.callDeadlineMs);
      },
      on(name, event, fn) {
        const p = procFor(name);
        if (!EVENTS.has(event)) throw new CodexModsError('Invalid', `unknown process event ${event}`);
        let set = p.listeners.get(event);
        if (!set) p.listeners.set(event, (set = new Set()));
        set.add(fn);
        // `resume`: its channel's realm caught up (a crediting subscription), so the output it held back goes on
        return { dispose: () => { set.delete(fn); caughtUp(p, fn); }, resume: () => caughtUp(p, fn) };
      },
      /** Called by the process realm: the channel for this process connected / registered a serve handler / emitted. */
      connected(name, channel) { const p = procs.get(name); if (p && p.status === 'running') { p.conn = channel; wake(p); return true; } return false; },
      disconnected(name, channel) { const p = procs.get(name); if (p && p.conn === channel) { p.conn = null; p.serve = null; wake(p); } },
      setServe(name, serve) { const p = procs.get(name); if (p) { p.serve = serve; wake(p); } },
      clearServe(name, serve) { const p = procs.get(name); if (p && p.serve === serve) p.serve = null; },
      message(name, data) { const p = procs.get(name); if (p) { emit(p, 'message', data); touch(p); } },
      /** The processes that start with the mod, of one kind: its workers before its host code runs, its sessions after (G8.2). */
      async startAuto(kind) {
        const manifest = state.mod.manifest.processes ?? {};
        for (const [name, decl] of Object.entries(manifest)) if (decl.start === 'with-mod' && (decl.kind ?? 'worker') === kind) await api.start(name);
      },
      async stopAll() { await Promise.all([...procs.values()].map((p) => stopProc(p))); },
    };
    return api;
  }

  async function close() {
    for (const s of sockets) s.destroy();
    if (server) { await new Promise((r) => server.close(() => r())); await rm(socketPath, { force: true }); }
    server = null; serverReady = null;
  }
  return { forMod, close, socketPath, ensureServer };
}

export function createProcessesNs() {
  const ctl = (scope) => {
    if (scope.realm !== 'host') throw new CodexModsError('Denied', 'processes are available to the host realm only');
    requireGrant(scope.state.grants, 'processes');
    return scope.state.procs;
  };
  return {
    calls: {
      async start(scope, name, opts) { await ctl(scope).start(name, opts); },
      async stop(scope, name) { await ctl(scope).stop(name); },
      async write(scope, name, data) { await ctl(scope).write(name, data); },
      call: (scope, name, method, params) => ctl(scope).call(name, method, params),
    },
    subs: {
      on(scope, [name, event], emit) { return ctl(scope).on(name, event, emit); },
    },
  };
}

/** Namespace 'process': how a mod process answers `ctx.processes.call` and emits `message` events (not in sdk/index.d.ts). */
export function createProcessRealmNs() {
  const need = (scope) => {
    if (scope.realm !== 'process') throw new CodexModsError('Denied', 'only a mod process may use this namespace');
    return scope.channel.identity.process;
  };
  return {
    calls: { emit(scope, data) { scope.state.procs.message(need(scope), data === undefined ? null : data); } },
    handlers: {
      serve(scope, [methods], invoke) {
        const name = need(scope);
        const serve = { invoke: (args, deadline) => invoke(args, deadline), methods };
        scope.state.procs.setServe(name, serve);
        return { dispose: () => { scope.state.procs.clearServe(name, serve); } };
      },
    },
  };
}
