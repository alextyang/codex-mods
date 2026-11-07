// replay(control, jsonlPath): feeds captured frames to a fake host context through control.deliver.
// Accepted line formats (blank lines and lines starting with '#' are skipped):
//   1. {"kind": <MessageKind>, "message": {...}, "info": {...}?}         canonical
//   2. {"dir": "c2s"|"s2c", "backend"?, "origin"?, "frame": {...}}       raw frame with a direction
//   3. <backend-name> <raw JSON-RPC frame>                                 tests/fixtures/fake-app-server.mjs FAKE_APP_SERVER_LOG (client→server)
//   4. a bare JSON-RPC frame, treated as `opts.dir` (default 's2c')
// Request methods are remembered per (origin, backend, id) so responses carry their request method in MessageInfo.
import fs from 'node:fs';

function classify(dir, frame) {
  const isReq = typeof frame.method === 'string';
  const hasId = frame.id !== undefined;
  if (dir === 'c2s') return isReq ? (hasId ? 'clientRequest' : 'clientNotification') : 'clientResponse';
  return isReq ? (hasId ? 'serverRequest' : 'serverNotification') : 'serverResponse';
}

export async function replay(control, jsonlPath, opts = {}) {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
  const pending = new Map(); // `${dir}|${origin}|${backend}|${id}` -> method
  const results = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let rec;
    const prefixed = /^([A-Za-z0-9._-]+) (\{.*)$/.exec(line);
    if (prefixed) rec = { dir: 'c2s', backend: prefixed[1], frame: JSON.parse(prefixed[2]) };
    else {
      const obj = JSON.parse(line);
      if (obj.kind && obj.message) rec = { kind: obj.kind, frame: obj.message, backend: obj.info?.backend, origin: obj.info?.origin, info: obj.info };
      else if (obj.dir && obj.frame) rec = obj;
      else rec = { dir: opts.dir ?? 's2c', frame: obj };
    }
    const backend = rec.backend === 'primary' || rec.backend === undefined ? (opts.backendMap?.[rec.backend] ?? 'primary') : (opts.backendMap?.[rec.backend] ?? rec.backend);
    const origin = rec.origin ?? 'app';
    const kind = rec.kind ?? classify(rec.dir, rec.frame);
    const reqDir = kind === 'clientRequest' ? 'c2s' : kind === 'serverRequest' ? 's2c' : null;
    const respDir = kind === 'serverResponse' ? 'c2s' : kind === 'clientResponse' ? 's2c' : null;
    let method = rec.frame.method ?? rec.info?.method;
    if (reqDir && rec.frame.id !== undefined) pending.set(`${reqDir}|${origin}|${backend}|${rec.frame.id}`, rec.frame.method);
    if (respDir) { const k = `${respDir}|${origin}|${backend}|${rec.frame.id}`; method = method ?? pending.get(k); pending.delete(k); }
    if (method === undefined) { results.push({ outcome: 'skipped', reason: 'response without a known request' }); continue; }
    results.push(await control.deliver(kind, rec.frame, { ...(rec.info ?? {}), method, backend, origin }));
  }
  return results;
}
