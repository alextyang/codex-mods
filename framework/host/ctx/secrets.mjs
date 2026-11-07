// ctx.secrets → macOS Keychain generic passwords via /usr/bin/security (pattern ported from legacy f1-secrets).
//
// service  = <prefix>.<profile>.<modId>.<fp>   prefix 'codexmods' (tests: 'codexmods-test'); fp = first 16 hex of
//            sha256(pinned publisher key), or 'dev' for developer packages. A replacement publisher therefore has a
//            different service and never sees the old secrets.
// account  = the secret's name (restricted to a safe character set, because it travels on a command line).
// value    = sent over STDIN to `security -i`, never in argv. It is stored as 'cm1:' + hex so that quoting problems
//            cannot arise and an empty secret is representable.
import { admit } from './permissions.mjs';
import { spawn } from 'node:child_process';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { publisherFingerprint } from '../../../contracts/layout.mjs';
import { requireGrant } from './grants.mjs';

const SECURITY = '/usr/bin/security';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
const PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_VALUE_BYTES = 4096;
const SENTINEL = 'cm1:';
const unavailable = (why) => new CodexModsError('Unavailable', `The Keychain operation could not complete${why ? ` (${why})` : ''}`);

/** Run `security`; resolves {code, stdout}. stdin text (if any) is written then closed. Output is bounded. */
export function runSecurity(args, input, { spawnFn = spawn, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn(SECURITY, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { reject(unavailable('spawn')); return; }
    const out = []; let size = 0; let failed = false; let stderr = '';
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { size += c.length; if (size > 16384) { failed = true; child.kill('SIGKILL'); } else out.push(c); });
    child.stderr.on('data', (c) => { if (stderr.length < 16384) stderr += c.toString(); });
    child.stdin.on('error', () => { failed = true; });
    child.on('error', () => { clearTimeout(timer); reject(unavailable('spawn')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return reject(unavailable('timeout or output limit'));
      resolve({ code, stdout: Buffer.concat(out).toString('utf8').trim(), stderr });
    });
    child.stdin.end(input);
  });
}

export function createKeychain({ servicePrefix = 'codexmods', profile, run = runSecurity } = {}) {
  const service = (modId, fp) => {
    if (!PART_RE.test(modId) || !PART_RE.test(fp) || !PART_RE.test(profile)) throw new CodexModsError('Invalid', 'invalid keychain service parts');
    return `${servicePrefix}.${profile}.${modId}.${fp}`;
  };
  const checkName = (name) => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CodexModsError('Invalid', 'secret name must match [A-Za-z0-9][A-Za-z0-9._@:-]{0,127}');
    return name;
  };
  return {
    service,
    async get(modId, fp, name) {
      const r = await run(['find-generic-password', '-s', service(modId, fp), '-a', checkName(name), '-w']);
      if (r.code === 44) return undefined;
      if (r.code !== 0) throw unavailable(`exit ${r.code}`);
      if (!r.stdout.startsWith(SENTINEL) || !/^(?:[a-f0-9]{2})*$/.test(r.stdout.slice(SENTINEL.length))) throw unavailable('malformed item');
      return Buffer.from(r.stdout.slice(SENTINEL.length), 'hex').toString('utf8');
    },
    async set(modId, fp, name, value) {
      if (typeof value !== 'string') throw new CodexModsError('Invalid', 'secret value must be a string');
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new CodexModsError('Invalid', `secret value exceeds ${MAX_VALUE_BYTES} bytes`);
      const encoded = SENTINEL + Buffer.from(value, 'utf8').toString('hex');
      const line = `add-generic-password -U -s ${service(modId, fp)} -a ${checkName(name)} -w ${encoded}\n`;
      const r = await run(['-i'], line);
      if (r.code !== 0 || /returned (?!0\b)-?\d+/.test(r.stderr)) throw unavailable(`exit ${r.code}`);
    },
    async delete(modId, fp, name) {
      const r = await run(['delete-generic-password', '-s', service(modId, fp), '-a', checkName(name)]);
      if (r.code !== 0 && r.code !== 44) throw unavailable(`exit ${r.code}`);
    },
    /** Delete every item under the mod's service (all accounts). */
    async deleteAll(modId, fp) {
      const s = service(modId, fp);
      for (let i = 0; i < 10000; i++) {
        const r = await run(['delete-generic-password', '-s', s]);
        if (r.code === 44) return;
        if (r.code !== 0) throw unavailable(`exit ${r.code}`);
      }
    },
  };
}

export function createSecretsNs({ keychain, permissions = () => null }) {
  const fp = (scope) => publisherFingerprint(scope.state.mod.record.publisher);
  // an optional `secrets` the user set to ask every time waits for their answer (framework-ui.md F8)
  const guard = (scope, what) => admit(scope, permissions, (grants) => requireGrant(grants, 'secrets'), what);
  return {
    calls: {
      async get(scope, name) { await guard(scope, `read its secret ${String(name)}`); return keychain.get(scope.state.id, fp(scope), name); },
      async set(scope, name, value) { await guard(scope, `store its secret ${String(name)}`); return keychain.set(scope.state.id, fp(scope), name, value); },
      async delete(scope, name) { await guard(scope, `delete its secret ${String(name)}`); return keychain.delete(scope.state.id, fp(scope), name); },
    },
  };
}
