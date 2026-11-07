import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { stat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHarness, installMod, portPair, waitFor, sleep, EVAL_HOST, inWorker } from './helpers.mjs';

const exec = promisify(execFile);
const SOCKET_PORT = pathToFileURL(fileURLToPath(new URL('../socket-port.mjs', import.meta.url))).href;
const REALM_CLIENT = pathToFileURL(fileURLToPath(new URL('../../../shared/realm-client.mjs', import.meta.url))).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pgid = async (pid) => Number((await exec('ps', ['-o', 'pgid=', '-p', String(pid)])).stdout.trim());

/** A mod process that connects to proc.sock with the framework's own client and serves a few methods. */
const BRIDGE = `
import { connectProcessRealm } from '${SOCKET_PORT}';
import { createRealmClient } from '${REALM_CLIENT}';
const { port } = await connectProcessRealm();
const client = createRealmClient(port);
const modId = process.env.CODEX_MODS_MOD_ID;
const ctx = client.context(modId, 'process', { id: modId, version: '1.0.0', dataDir: '/unused' });
ctx.process.serve({
  echo: (p) => ({ echoed: p, pid: process.pid }),
  env: () => ({ sock: process.env.CODEX_MODS_PROC_SOCKET, token: process.env.CODEX_MODS_PROC_TOKEN, mod: process.env.CODEX_MODS_MOD_ID,
                proc: process.env.CODEX_MODS_PROCESS, generation: process.env.CODEX_MODS_GENERATION, boot: process.env.CODEX_MODS_BOOT, path: process.env.PATH }),
  viaHost: async ({ a, b }) => ctx.services.call(modId, 'math', 'add', { a, b }),
  storeRound: async () => { await ctx.storage.set('from-process', 'hello'); return await ctx.storage.get('from-process'); },
  other: async () => { const other = client.context('someone.else', 'process', { id: 'someone.else', version: '1', dataDir: '/x' }); try { await other.storage.get('k'); return 'allowed?!'; } catch (e) { return e.code; } },
  hasProcesses: () => 'processes' in ctx,
  hang: () => new Promise(() => {}),
  crashMid: () => { process.exit(9); },
  die: () => { setTimeout(() => process.exit(7), 10); return 'bye'; },
});
ctx.process.emit({ ready: true, pid: process.pid });
setInterval(() => {}, 1000);
`;

const sh = (body) => `#!/bin/sh\n${body}\n`;

test('process round trip over proc.sock: spawn, env contract, process group, RPC both ways, events', async () => {
  process.env.CODEX_MODS_BOOT = 'boot-test-value';
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, {
      id: 'test.proc', host: EVAL_HOST, grants: ['processes'],
      processes: { bridge: { command: 'bridge.mjs', start: 'with-mod' } }, files: { 'bridge.mjs': BRIDGE },
    });
    await h.runtime.activate(mod);        // with-mod: started by activate
    const run = (body, args) => inWorker(h.runtime, 'test.proc', body, args);
    await run(`globalThis.msgs = []; ctx.processes.on('bridge', 'message', (d) => globalThis.msgs.push(d));
               ctx.services.provide('math', { add: ({ a, b }) => a + b });`);
    // the process emitted `ready` before we subscribed possibly; call something and re-check below
    const echo = await run(`return await ctx.processes.call('bridge', 'echo', { x: [1, 2] });`);
    assert.deepEqual(echo.echoed, { x: [1, 2] });
    assert.ok(alive(echo.pid));
    assert.equal(await pgid(echo.pid), await pgid(process.pid), 'the process stays in the Host process group');

    const env = await run(`return await ctx.processes.call('bridge', 'env');`);
    assert.match(env.token, /^[0-9a-f]{64}$/);
    assert.equal(env.sock, join(h.layout.run, 'proc.sock'));
    assert.deepEqual([env.mod, env.proc], ['test.proc', 'bridge']);
    assert.match(env.generation, /^\d+$/);
    assert.equal(env.boot, 'boot-test-value', 'processes inherit the Host process.env (CODEX_MODS_BOOT)');
    assert.equal(env.path, process.env.PATH);
    assert.equal((await stat(env.sock)).mode & 0o777, 0o600);

    // the process uses its ProcessContext: storage, and services provided by the host realm
    assert.equal(await run(`return await ctx.processes.call('bridge', 'storeRound');`), 'hello');
    assert.equal(await run(`return await ctx.storage.get('from-process');`), 'hello');
    assert.equal(await run(`return await ctx.processes.call('bridge', 'viaHost', { a: 20, b: 22 });`), 42);
    assert.equal(await run(`return await ctx.processes.call('bridge', 'hasProcesses');`), false, 'ProcessContext has no processes namespace');
    // a message naming another modId is refused
    assert.equal(await run(`return await ctx.processes.call('bridge', 'other');`), 'Denied');
    // unknown remote method → error crosses back
    await assert.rejects(inWorker(h.runtime, 'test.proc', `return await ctx.processes.call('bridge', 'nope');`), (e) => e.code === 'Invalid');

    // events: exited arrives with the exit code, and the process is restarted by supervision (with-mod)
    await run(`globalThis.exits = []; ctx.processes.on('bridge', 'exited', (d) => globalThis.exits.push(d)); globalThis.starts = 0; ctx.processes.on('bridge', 'started', () => globalThis.starts++);`);
    assert.equal(await run(`return await ctx.processes.call('bridge', 'die');`), 'bye');
    await waitFor(async () => (await run(`return globalThis.exits.length;`)) === 1, { what: 'exited event' });
    assert.deepEqual((await run(`return globalThis.exits;`))[0], { code: 7, signal: null });
    await waitFor(async () => (await run(`return globalThis.starts;`)) === 1, { what: 'restart', timeout: 30000 });
    const again = await run(`return await ctx.processes.call('bridge', 'echo', 1);`);
    assert.notEqual(again.pid, echo.pid);
    assert.ok(h.topic('framework/fault').some((f) => f.realm === 'process' && f.kind === 'exit'));
    assert.deepEqual(h.quarantines, [], 'a supervised process exit does not count toward quarantine');

    // deactivating stops the process
    await h.runtime.deactivate('test.proc', 'test');
    await waitFor(() => !alive(again.pid), { what: 'process gone' });
  } finally { delete process.env.CODEX_MODS_BOOT; await h.close(); }
});

test('proc.sock handshake: wrong token, wrong mod, reused token and garbage are refused', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, {
      id: 'test.hs', host: EVAL_HOST, grants: ['processes'],
      processes: { bridge: { command: 'bridge.mjs', start: 'with-mod' } }, files: { 'bridge.mjs': BRIDGE },
    });
    await h.runtime.activate(mod);
    const env = await inWorker(h.runtime, 'test.hs', `return await ctx.processes.call('bridge', 'env');`);
    const attempt = (line) => new Promise((resolve) => {
      const s = net.connect(env.sock);
      let buf = ''; s.setEncoding('utf8');
      s.on('connect', () => s.write(line));
      s.on('data', (d) => { buf += d; });
      s.on('close', () => resolve(buf.trim()));
      s.on('error', () => resolve('error'));
      setTimeout(() => s.destroy(), 2000);
    });
    const good = { process: 'bridge', mod: 'test.hs', token: env.token };
    assert.equal(await attempt(`${JSON.stringify({ ...good, token: 'f'.repeat(64) })}\n`), '{"ok":false}');
    assert.equal(await attempt(`${JSON.stringify({ ...good, mod: 'someone.else' })}\n`), '{"ok":false}');
    assert.equal(await attempt(`${JSON.stringify({ ...good, process: 'other' })}\n`), '{"ok":false}');
    assert.equal(await attempt(`${JSON.stringify(good)}\n`), '{"ok":false}', 'the token is already in use by the live connection');
    assert.equal(await attempt('not json\n'), '');
    assert.equal(await attempt(`${JSON.stringify({ ...good, token: 7 })}\n`), '{"ok":false}');
    // the legitimate connection is unaffected
    assert.deepEqual((await inWorker(h.runtime, 'test.hs', `return await ctx.processes.call('bridge', 'echo', 'still');`)).echoed, 'still');
  } finally { await h.close(); }
});

test('process realm channel: bound modId (Denied), no processes/renderer-only namespaces, undeclared processes refused', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, {
      id: 'test.bind', host: EVAL_HOST, grants: ['processes'],
      processes: { bridge: { command: 'bridge.mjs', start: 'on-demand' } }, files: { 'bridge.mjs': 'setInterval(() => {}, 1000);' },
    });
    await h.runtime.activate(mod);
    const [hostPort, realmPort] = portPair();
    const replies = []; realmPort.onMessage((m) => replies.push(m));
    const d = h.runtime.handleRealm('process', hostPort, { modId: 'test.bind', process: 'bridge' });
    const call = (id, modId, ns, method, args = []) => realmPort.post({ t: 'call', id, modId, ns, method, args });
    call(1, 'test.bind', 'storage', 'set', ['k', 1]);
    await waitFor(() => replies.length === 1);
    call(2, 'someone.else', 'storage', 'get', ['k']);
    call(3, 'test.bind', 'processes', 'start', ['bridge']);
    call(4, 'test.bind', 'storage', 'get', ['k']);
    await waitFor(() => replies.length === 4);
    const by = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(by[1].error, undefined);
    assert.equal(by[2].error.code, 'Denied');
    assert.equal(by[3].error.code, 'Denied');
    assert.equal(by[4].value, 1);
    d.dispose();
    // a process the manifest does not declare gets no channel
    const [hp2, rp2] = portPair(); let closed = false; rp2.onClose(() => { closed = true; });
    h.runtime.handleRealm('process', hp2, { modId: 'test.bind', process: 'ghost' });
    await waitFor(() => closed, { what: 'channel closed' });
    // undeclared name from the host realm → Denied
    await assert.rejects(inWorker(h.runtime, 'test.bind', `await ctx.processes.start('ghost')`), (e) => e.code === 'Denied');
    await assert.rejects(inWorker(h.runtime, 'test.bind', `await ctx.processes.call('constructor', 'x')`), (e) => e.code === 'Denied');
  } finally { await h.close(); }
});

test('executable commands run directly; stdout reaches the mod log; explicit start/stop', async () => {
  const h = await makeHarness({ internals: { processes: { connectTimeoutMs: 300 } } });
  try {
    const mod = await installMod(h.layout, {
      id: 'test.exe', host: EVAL_HOST, grants: ['processes'],
      processes: { tool: { command: 'bin/tool.sh', args: ['--flag'], start: 'on-demand' } },
      files: { 'bin/tool.sh': sh('echo "tool up $1 $CODEX_MODS_PROCESS"; exec sleep 30') },
    });
    await h.runtime.activate(mod);
    const run = (body, args) => inWorker(h.runtime, 'test.exe', body, args);
    await run(`globalThis.pids = []; ctx.processes.on('tool', 'started', (d) => globalThis.pids.push(d.pid));`);
    assert.deepEqual(await run(`return globalThis.pids;`), [], 'on-demand: not started by activate');
    await run(`await ctx.processes.start('tool');`);
    await waitFor(async () => (await run(`return globalThis.pids.length;`)) === 1);
    const [pid] = await run(`return globalThis.pids;`);
    assert.ok(alive(pid));
    await waitFor(async () => (await readFile(join(h.layout.logs, 'test.exe.log'), 'utf8').catch(() => '')).includes('tool up --flag tool'), { what: 'process stdout in the mod log' });
    // this process never connects: a call waits for its handlers and fails Unavailable
    await assert.rejects(inWorker(h.runtime, 'test.exe', `return await ctx.processes.call('tool', 'x')`), (e) => e.code === 'Unavailable');
    await run(`await ctx.processes.stop('tool');`);
    assert.ok(!alive(pid));
    await run(`await ctx.processes.stop('tool');`); // idempotent
  } finally { await h.close(); }
});

test('on-demand processes start on first call and stop after idleStopMs; with-mod crash loops stop after 3 restarts', async () => {
  const h = await makeHarness({ internals: { processes: { backoffBaseMs: 20, backoffMaxMs: 40 } } });
  try {
    const od = await installMod(h.layout, {
      id: 'test.idle', host: EVAL_HOST, grants: ['processes'],
      processes: { bridge: { command: 'bridge.mjs', start: 'on-demand', idleStopMs: 1500 } }, files: { 'bridge.mjs': BRIDGE },
    });
    await h.runtime.activate(od);
    const run = (body, args) => inWorker(h.runtime, 'test.idle', body, args);
    await run(`globalThis.log = []; ctx.processes.on('bridge', 'started', () => globalThis.log.push('started')); ctx.processes.on('bridge', 'exited', () => globalThis.log.push('exited'));`);
    const first = await run(`return await ctx.processes.call('bridge', 'echo', 1);`);   // starts it
    assert.ok(alive(first.pid));
    await waitFor(async () => !alive(first.pid), { what: 'idle stop', timeout: 20000 });
    assert.deepEqual(await run(`return globalThis.log;`), ['started', 'exited']);
    const second = await run(`return await ctx.processes.call('bridge', 'echo', 2);`);  // restarts on demand
    assert.notEqual(second.pid, first.pid);
    // activity keeps it alive
    for (let i = 0; i < 5; i++) { await sleep(500); await run(`return await ctx.processes.call('bridge', 'echo', 3);`); }
    assert.ok(alive(second.pid));

    const loop = await installMod(h.layout, {
      id: 'test.loop', host: EVAL_HOST, grants: ['processes'],
      processes: { crash: { command: 'bin/crash.sh', start: 'with-mod' } }, files: { 'bin/crash.sh': sh('exit 1') },
    });
    await h.runtime.activate(loop);
    await waitFor(() => h.topic('framework/fault').some((f) => f.kind === 'crash-loop'), { what: 'crash-loop fault', timeout: 30000 });
    await sleep(300);
    const exits = h.topic('framework/fault').filter((f) => f.modId === 'test.loop' && f.kind === 'exit');
    assert.equal(exits.length, 4, '1 initial start + 3 restarts, then no more');
    await assert.rejects(inWorker(h.runtime, 'test.loop', `return await ctx.processes.call('crash', 'x')`), (e) => e.code === 'Unavailable');
  } finally { await h.close(); }
});

test('proc.sock is removed and processes are gone when the runtime closes', async () => {
  const h = await makeHarness();
  const mod = await installMod(h.layout, {
    id: 'test.close', host: EVAL_HOST, grants: ['processes'],
    processes: { bridge: { command: 'bridge.mjs', start: 'with-mod' } }, files: { 'bridge.mjs': BRIDGE },
  });
  await h.runtime.activate(mod);
  const { pid } = await inWorker(h.runtime, 'test.close', `return await ctx.processes.call('bridge', 'echo', 1);`);
  assert.ok(alive(pid));
  await h.close();
  assert.ok(!alive(pid));
  await assert.rejects(stat(join(h.layout.run, 'proc.sock')));
});

test('a failed activation stops the processes it started and reports effectsAttempted', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, {
      id: 'test.failproc', host: 'export default { host() { throw new Error("late failure"); } };', grants: ['processes'],
      processes: { bridge: { command: 'bridge.mjs', start: 'with-mod' } }, files: { 'bridge.mjs': BRIDGE },
    });
    await assert.rejects(h.runtime.activate(mod), (e) => e.code === 'Invalid' && e.details.effectsAttempted === true);
    assert.equal(h.runtime.status('test.failproc'), 'inactive');
    // no leftover child of this mod
    const { stdout } = await exec('pgrep', ['-f', join(mod.packageDir, 'bridge.mjs')]).catch(() => ({ stdout: '' }));
    assert.equal(stdout.trim(), '');
  } finally { await h.close(); }
});

test('activate refuses a mod without entries, with an ActivationError', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, { id: 'test.noentry' });
    await assert.rejects(h.runtime.activate(mod), (e) => e.code === 'Invalid' && e.details.effectsAttempted === false);
  } finally { await h.close(); }
});

test('process calls: OutcomeUnknown once dispatched (deadline or process gone), Unavailable if never dispatched', async () => {
  const h = await makeHarness({ internals: { processes: { callDeadlineMs: 300, connectTimeoutMs: 300, backoffBaseMs: 10000 } } });
  try {
    const mod = await installMod(h.layout, {
      id: 'test.pc', host: EVAL_HOST, grants: ['processes'],
      processes: { bridge: { command: 'bridge.mjs', start: 'on-demand' }, mute: { command: 'bin/mute.sh', start: 'on-demand' } },
      files: { 'bridge.mjs': BRIDGE, 'bin/mute.sh': sh('exec sleep 30') },
    });
    await h.runtime.activate(mod);
    const run = (body) => inWorker(h.runtime, 'test.pc', body);
    assert.equal((await run(`return await ctx.processes.call('bridge', 'echo', 1);`)).echoed, 1);
    await assert.rejects(run(`return await ctx.processes.call('bridge', 'hang');`), (e) => e.code === 'OutcomeUnknown');
    await assert.rejects(run(`return await ctx.processes.call('bridge', 'crashMid');`), (e) => e.code === 'OutcomeUnknown');
    // never dispatched: the process never connected / registered its handlers
    await assert.rejects(run(`return await ctx.processes.call('mute', 'x');`), (e) => e.code === 'Unavailable');
    await run(`await ctx.processes.stop('mute');`);
    // after the crash the next call starts it again and works
    assert.equal((await run(`return await ctx.processes.call('bridge', 'echo', 2);`)).echoed, 2);
  } finally { await h.close(); }
});

test('every process start path needs the processes grant: activation is Denied before anything starts', async () => {
  const h = await makeHarness();
  try {
    for (const start of ['with-mod', 'on-demand']) {
      const id = `test.ng-${start}`;
      const mod = await installMod(h.layout, {
        id, host: EVAL_HOST, grants: [], processes: { bridge: { command: 'bridge.mjs', start } }, files: { 'bridge.mjs': BRIDGE },
      });
      await assert.rejects(h.runtime.activate(mod), (e) => e.code === 'Denied' && e.details.code === 'Denied' && e.details.effectsAttempted === false);
      assert.equal(h.runtime.status(id), 'inactive');
      assert.equal(h.workers.filter((w) => w.modId === id).length, 0, 'no worker was started');
      assert.equal(h.mux.clients.has(`mod:${id}`), false, 'nothing was created');
      const { stdout } = await exec('pgrep', ['-f', join(mod.packageDir, 'bridge.mjs')]).catch(() => ({ stdout: '' }));
      assert.equal(stdout.trim(), '');
    }
    // a grant that merely resembles it does not count
    const near = await installMod(h.layout, { id: 'test.ng-near', host: EVAL_HOST, grants: ['processes.x'], processes: { b: { command: 'bridge.mjs', start: 'with-mod' } }, files: { 'bridge.mjs': BRIDGE } });
    await assert.rejects(h.runtime.activate(near), (e) => e.code === 'Denied');
    // with the grant it starts
    const ok = await installMod(h.layout, { id: 'test.ng-ok', host: EVAL_HOST, grants: ['processes'], processes: { bridge: { command: 'bridge.mjs', start: 'with-mod' } }, files: { 'bridge.mjs': BRIDGE } });
    await h.runtime.activate(ok);
    assert.equal((await inWorker(h.runtime, 'test.ng-ok', `return await ctx.processes.call('bridge', 'echo', 1);`)).echoed, 1);
  } finally { await h.close(); }
});

test('graph-integrity G8.2: a session takes its input in order and gives its output line by line; never idle-stopped; started with arguments and a folder; restarted after a failure with the same start', async () => {
  const h = await makeHarness({ internals: { processes: { idleStopMs: 300, backoffBaseMs: 20, backoffMaxMs: 40 } } });
  const { mkdtemp, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'cm-session-')));
  try {
    const mod = await installMod(h.layout, {
      id: 'test.session', host: EVAL_HOST, grants: ['processes'],
      processes: {
        echo: { kind: 'session', command: 'bin/echo.sh', args: ['--from-manifest'], start: 'on-demand', restart: 'on-failure' },
        worker: { command: 'bin/w.sh', start: 'on-demand' },
      },
      files: {
        'bin/echo.sh': sh('echo "args: $* in: $(pwd -P)"; while IFS= read -r line; do [ "$line" = die ] && exit 3; echo "got: $line"; echo "err: $line" >&2; done'),
        'bin/w.sh': sh('exec sleep 30'),
      },
    });
    await h.runtime.activate(mod);
    const run = (body, args) => inWorker(h.runtime, 'test.session', body, args);
    await run(`globalThis.out = []; globalThis.pids = []; ctx.processes.on('echo', 'output', (d) => globalThis.out.push(d)); ctx.processes.on('echo', 'started', (d) => globalThis.pids.push(d.pid));`);
    await run(`await ctx.processes.start('echo', { args: ['--a', 'b c'], cwd: args.folder });`, { folder });
    const lines = async () => run(`return globalThis.out;`);
    await waitFor(async () => (await lines()).some((x) => x.line === `args: --from-manifest --a b c in: ${folder}`), { what: 'its start line' });
    await run(`await ctx.processes.write('echo', 'one\\n'); await ctx.processes.write('echo', 'two\\n');`);
    await waitFor(async () => (await lines()).filter((x) => x.stream === 'stdout' && x.line.startsWith('got:')).length === 2, { what: 'its answers' });
    const got = await lines();
    assert.deepEqual(got.filter((x) => x.stream === 'stdout' && x.line.startsWith('got:')).map((x) => x.line), ['got: one', 'got: two'], 'in order');
    assert.ok(got.some((x) => x.stream === 'stderr' && x.line === 'err: one'), 'its stderr too');
    const [pid] = await run(`return globalThis.pids;`);
    await sleep(900);
    assert.ok(alive(pid), 'a session is never stopped for being idle');
    await assert.rejects(run(`await ctx.processes.start('echo', { args: ['other'] });`), (e) => e.code === 'Invalid' && /running/.test(e.message));
    await run(`await ctx.processes.start('echo');`);   // running already: nothing to do
    // a failure: restarted (its manifest says so) with the start it had
    await run(`await ctx.processes.write('echo', 'die\\n');`);
    await waitFor(async () => (await run(`return globalThis.pids.length;`)) === 2, { what: 'the restart' });
    await waitFor(async () => (await lines()).filter((x) => x.line === `args: --from-manifest --a b c in: ${folder}`).length === 2, { what: 'the same start again' });
    await run(`await ctx.processes.write('echo', 'three\\n');`);
    await waitFor(async () => (await lines()).some((x) => x.line === 'got: three'), { what: 'input after the restart' });
    // a worker takes no input and no start options
    await assert.rejects(run(`await ctx.processes.write('worker', 'x');`), (e) => e.code === 'Invalid' && /not a session/.test(e.message));
    await assert.rejects(run(`await ctx.processes.start('worker', { args: ['x'] });`), (e) => e.code === 'Invalid' && /not a session/.test(e.message));
    // bounds: a folder that is none, input too large, input to a stopped session
    await run(`await ctx.processes.stop('echo');`);
    await assert.rejects(run(`await ctx.processes.start('echo', { cwd: '/no/such/folder' });`), (e) => e.code === 'Invalid' && /not a folder/.test(e.message));
    await assert.rejects(run(`await ctx.processes.start('echo', { cwd: 'relative' });`), (e) => e.code === 'Invalid');
    await assert.rejects(run(`await ctx.processes.write('echo', 'x');`), (e) => e.code === 'Unavailable');
    await run(`await ctx.processes.start('echo');`);
    await assert.rejects(run(`await ctx.processes.write('echo', 'x'.repeat(1024 * 1024 + 1));`), (e) => e.code === 'Invalid');
    await run(`await ctx.processes.stop('echo');`);
  } finally { await h.close(); }
});

test('graph-integrity G8.2, D4: a program on the Mac by name: found on the user\'s PATH at each start, given none of the framework\'s connection; only with the grant naming it; fed through its input, never called', async () => {
  const { mkdtemp, writeFile: wf, chmod: cm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createUserPath } = await import('../../ctx/user-path.mjs');
  const bin = await realpath(await mkdtemp(join(tmpdir(), 'cm-bin-')));
  await wf(join(bin, 'fakeprog'), sh('echo "token=${CODEX_MODS_PROC_TOKEN:-none} sock=${CODEX_MODS_PROC_SOCKET:-none} gen=${CODEX_MODS_GENERATION:-none} path=$PATH in=$(pwd -P)"; while IFS= read -r l; do echo "fake: $l"; done'));
  await cm(join(bin, 'fakeprog'), 0o755);
  let shellPath = `${bin}:/usr/bin:/bin`;
  const userPath = createUserPath({ read: async () => shellPath, ttlMs: 0 });
  const h = await makeHarness({ internals: { userPath } });
  try {
    const decl = { kind: 'session', executable: 'fakeprog', args: ['--x'], start: 'on-demand' };
    const mod = await installMod(h.layout, { id: 'test.exec', host: EVAL_HOST, grants: ['processes', 'processes.exec:fakeprog'], processes: { prog: decl } });
    await h.runtime.activate(mod);
    const run = (body, args) => inWorker(h.runtime, 'test.exec', body, args);
    await run(`globalThis.out = []; globalThis.started = []; ctx.processes.on('prog', 'output', (d) => globalThis.out.push(d.line)); ctx.processes.on('prog', 'started', (d) => globalThis.started.push(d));`);
    await run(`await ctx.processes.start('prog');`);
    await waitFor(async () => (await run(`return globalThis.out;`)).some((l) => l.startsWith('token=')), { what: 'its first line' });
    const [first] = await run(`return globalThis.out;`);
    const { homedir } = await import('node:os');
    assert.equal(first, `token=none sock=none gen=${first.match(/gen=(\S+)/)[1]} path=${bin}:/usr/bin:/bin in=${await realpath(homedir())}`, 'no framework connection; the user\'s PATH; the home folder');
    assert.notEqual(first.match(/gen=(\S+)/)[1], 'none', 'marked as the Host\'s for leftovers');
    assert.equal((await run(`return globalThis.started;`))[0].executable, join(bin, 'fakeprog'), 'where it was found');
    await run(`await ctx.processes.write('prog', 'hi\\n');`);
    await waitFor(async () => (await run(`return globalThis.out;`)).includes('fake: hi'), { what: 'its answer' });
    await assert.rejects(run(`return await ctx.processes.call('prog', 'x');`), (e) => e.code === 'Invalid' && /fed through write/.test(e.message));
    await run(`await ctx.processes.stop('prog');`);
    // found at each start: gone from the PATH, it is not installed
    shellPath = '/usr/bin:/bin';
    await assert.rejects(run(`await ctx.processes.start('prog');`), (e) => e.code === 'Unavailable' && /fakeprog is not installed/.test(e.message));
    // only with the grant that names it
    const other = await installMod(h.layout, { id: 'test.exec2', host: EVAL_HOST, grants: ['processes', 'processes.exec:otherprog'], processes: { prog: decl } });
    shellPath = `${bin}:/usr/bin:/bin`;
    await h.runtime.activate(other);
    await assert.rejects(inWorker(h.runtime, 'test.exec2', `await ctx.processes.start('prog');`), (e) => e.code === 'Denied' && /processes\.exec:fakeprog/.test(e.message));
  } finally { await h.close(); }
});

test('graph-integrity G8.2: a session that starts with the mod starts once its host code ran: the listeners that code set up hear it start and its first line', async () => {
  const h = await makeHarness();
  try {
    const host = EVAL_HOST.replace('export default { host(ctx) {', `export default { host(ctx) {
  globalThis.heard = [];
  ctx.processes.on('s', 'started', () => globalThis.heard.push('started'));
  ctx.processes.on('s', 'output', (d) => globalThis.heard.push(d.line));`);
    const mod = await installMod(h.layout, { id: 'test.first', host, grants: ['processes'],
      processes: { s: { kind: 'session', command: 'bin/s.sh', start: 'with-mod' } }, files: { 'bin/s.sh': sh('echo hello first; exec sleep 30') } });
    await h.runtime.activate(mod);
    await waitFor(async () => (await inWorker(h.runtime, 'test.first', 'return globalThis.heard;')).includes('hello first'), { what: 'its first line' });
    assert.deepEqual(await inWorker(h.runtime, 'test.first', 'return globalThis.heard;'), ['started', 'hello first']);
  } finally { await h.close(); }
});

test('graph-integrity G8.2: a session that starts with the mod does not hold up its activation; a program that is not installed is a fault the mod sees, not a failed activation', async () => {
  const { createUserPath } = await import('../../ctx/user-path.mjs');
  const h = await makeHarness({ internals: { userPath: createUserPath({ read: async () => '/usr/bin:/bin' }) } });
  try {
    const mod = await installMod(h.layout, { id: 'test.absent', host: EVAL_HOST, grants: ['processes', 'processes.exec:codexmods-not-installed'],
      processes: { s: { kind: 'session', executable: 'codexmods-not-installed', start: 'with-mod' } } });
    await h.runtime.activate(mod);
    assert.equal(h.runtime.status('test.absent'), 'active');
    await waitFor(() => h.topic('framework/fault').some((f) => f.modId === 'test.absent' && f.kind === 'start' && /not installed/.test(f.message)), { what: 'the fault' });
  } finally { await h.close(); }
});

test('review 2026-11-05 #9-#11: a session\'s unwritten input is bounded; its output waits while a listener\'s realm is behind; one that ends cleanly is done, not restarted', async () => {
  const { makeRoot } = await import('./helpers.mjs');
  const { createProcessManager } = await import('../../ctx/processes.mjs');
  const { root, layout, cleanup } = await makeRoot();
  const faults = [];
  const pm = createProcessManager({ layout, log: { warn() {}, info() {}, debug() {}, error() {} }, internals: { processes: { backoffBaseMs: 10, backoffMaxMs: 20 } }, authenticated() {}, fault: (...a) => faults.push(a) });
  const { mkdir: md, writeFile: wf, chmod: cm } = await import('node:fs/promises');
  const pkg = join(root, 'pkg');
  await md(join(pkg, 'bin'), { recursive: true });
  const script = async (name, body) => { await wf(join(pkg, 'bin', name), sh(body)); await cm(join(pkg, 'bin', name), 0o755); };
  await script('deaf.sh', 'exec sleep 30');                                             // never reads its input
  await script('talk.sh', 'i=0; while [ $i -lt 400 ]; do echo "line $i"; i=$((i+1)); done; exec sleep 30');
  await script('done.sh', 'echo finished; exit 0');
  const state = { id: 'test.bounds', status: 'active', grants: ['processes'], effects: false, logger: { write() {} },
    mod: { packageDir: pkg, manifest: { processes: {
      deaf: { kind: 'session', command: 'bin/deaf.sh', start: 'on-demand' },
      talk: { kind: 'session', command: 'bin/talk.sh', start: 'on-demand' },
      done: { kind: 'session', command: 'bin/done.sh', start: 'on-demand', restart: 'on-failure' },
    } } } };
  const api = pm.forMod(state);
  try {
    // #9: writes that are not waited for meet the bound
    await api.start('deaf');
    const big = 'x'.repeat(1024 * 1024);
    const pending = [];
    let busy = null;
    for (let i = 0; i < 12 && !busy; i++) {
      const w = api.write('deaf', big).then(() => 'ok', (e) => e);
      pending.push(w);
      const r = await Promise.race([w, sleep(50).then(() => 'waiting')]);
      if (r instanceof Error) busy = r;
    }
    assert.equal(busy?.code, 'Busy', 'a write past what it has not taken is refused');
    await api.stop('deaf');
    await Promise.all(pending);
    // #10: a listener whose realm is behind holds the output back until it says it caught up
    let lines = 0, behind = true;
    const sub = api.on('talk', 'output', () => { lines++; return !behind; });
    await api.start('talk');
    await waitFor(() => lines > 0, { what: 'its first lines' });
    await sleep(300);
    const held = lines;
    await sleep(300);
    assert.equal(lines, held, 'nothing more while it is behind');
    assert.ok(held < 400, `held back (${held} of 400)`);
    behind = false;
    sub.resume();
    await waitFor(() => lines >= 400, { what: 'the rest once it caught up' });
    await api.stop('talk');
    // #11: a clean end is done
    let exits = 0, starts = 0;
    api.on('done', 'exited', () => { exits++; });
    api.on('done', 'started', () => { starts++; });
    await api.start('done');
    await waitFor(() => exits === 1, { what: 'its end' });
    await sleep(300);
    assert.deepEqual([starts, exits, faults.filter((f) => f[2] === 'exit').length], [1, 1, 0], 'not restarted, no fault');
  } finally { await api.stopAll(); await pm.close(); await cleanup(); }
});

test('a session declared with instances runs as several at once, each addressed as name#key; one more is Busy; a one-instance process takes no key', async () => {
  const h = await makeHarness();
  try {
    const mod = await installMod(h.layout, {
      id: 'test.instances', host: EVAL_HOST, grants: ['processes'],
      processes: {
        chat: { kind: 'session', command: 'bin/chat.sh', start: 'on-demand', instances: 2 },
        one: { kind: 'session', command: 'bin/chat.sh', start: 'on-demand' },
      },
      files: { 'bin/chat.sh': sh('while IFS= read -r line; do echo "$1 got: $line"; done') },
    });
    await h.runtime.activate(mod);
    const run = (body, args) => inWorker(h.runtime, 'test.instances', body, args);
    await run(`globalThis.out = []; for (const k of ['a', 'b']) ctx.processes.on('chat#' + k, 'output', (d) => globalThis.out.push(d.line));`);
    await run(`await ctx.processes.start('chat#a', { args: ['A'] }); await ctx.processes.start('chat#b', { args: ['B'] });`);
    await run(`await ctx.processes.write('chat#a', 'one\\n'); await ctx.processes.write('chat#b', 'two\\n');`);
    await waitFor(async () => (await run(`return globalThis.out;`)).length === 2, { what: 'each instance\'s answer' });
    assert.deepEqual((await run(`return globalThis.out;`)).sort(), ['A got: one', 'B got: two'], 'each its own process, its own start');
    await assert.rejects(run(`await ctx.processes.start('chat#c');`), (e) => e.code === 'Busy' && /at most 2/.test(e.message));
    await run(`await ctx.processes.stop('chat#a'); await ctx.processes.start('chat#c', { args: ['C'] });`);
    await assert.rejects(run(`await ctx.processes.start('one#x');`), (e) => e.code === 'Invalid' && /addressed by its name alone/.test(e.message));
    await assert.rejects(run(`await ctx.processes.start('chat#bad key');`), (e) => e.code === 'Invalid');
    await assert.rejects(run(`await ctx.processes.start('nope#a');`), (e) => e.code === 'Denied');
    await run(`await ctx.processes.stop('chat#b'); await ctx.processes.stop('chat#c');`);
  } finally { await h.close(); }
});
