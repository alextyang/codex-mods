// Derives AdapterPack.protocol (contracts/adapter.d.ts ProtocolCatalog) mechanically from the app-server JSON Schema
// that the installed build's own `codex app-server generate-json-schema` produced (contracts/upstream/<build>/schema/).
// Usage: node adapters/tools/protocol-from-schema.mjs <schemaDir> [--out file]
// Pure Node built-ins. Regenerate this for every new build; nothing here is hand-edited.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The four message families and the schema file that enumerates each one's methods. */
export const FAMILIES = Object.freeze({
  clientRequests: 'ClientRequest.json',
  clientNotifications: 'ClientNotification.json',
  serverRequests: 'ServerRequest.json',
  serverNotifications: 'ServerNotification.json',
});

/** v1 policy: affinity by thread id; thread-creating responses pin a new key. */
export const AFFINITY_KEY_PATHS = Object.freeze(['params.threadId']);
export const AFFINITY_CREATORS = Object.freeze([
  { method: 'thread/start', resultPath: 'thread.id' },
  { method: 'thread/resume', resultPath: 'thread.id' },
  { method: 'thread/fork', resultPath: 'thread.id' },
]);

/** Method names of one family: every `oneOf` branch carries `properties.method.enum` with exactly one name. */
export function methodsOfSchema(schema, family = '?') {
  const branches = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(branches)) throw new Error(`${family}: schema has no oneOf/anyOf`);
  const out = [];
  for (const [i, branch] of branches.entries()) {
    const names = branch?.properties?.method?.enum;
    if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== 'string') {
      throw new Error(`${family}: branch ${i} (${branch?.title ?? 'untitled'}) has no single method enum`);
    }
    out.push(names[0]);
  }
  const dup = out.find((m, i) => out.indexOf(m) !== i);
  if (dup) throw new Error(`${family}: duplicate method ${dup}`);
  return out;
}

/** @param {(file: string) => any} readSchema returns the parsed JSON of a schema file name. */
export function buildProtocol(readSchema) {
  const methods = {};
  for (const [family, file] of Object.entries(FAMILIES)) methods[family] = methodsOfSchema(readSchema(file), file);
  if (!methods.clientRequests.includes('initialize')) throw new Error('ClientRequest has no initialize');
  if (!methods.clientNotifications.includes('initialized')) throw new Error('ClientNotification has no initialized');
  for (const c of AFFINITY_CREATORS) {
    if (!methods.clientRequests.includes(c.method)) throw new Error(`affinity creator ${c.method} is not a client request`);
  }
  return {
    handshake: { request: 'initialize', notification: 'initialized' },
    affinityKeyPaths: [...AFFINITY_KEY_PATHS],
    affinityCreators: AFFINITY_CREATORS.map((c) => ({ ...c })),
    methods,
  };
}

export function protocolFromDir(schemaDir) {
  return buildProtocol((file) => JSON.parse(readFileSync(join(schemaDir, file), 'utf8')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: protocol-from-schema.mjs <schemaDir> [--out file]'); process.exit(2); }
  const protocol = protocolFromDir(dir);
  const outIdx = args.indexOf('--out');
  const json = JSON.stringify(protocol, null, 2) + '\n';
  if (outIdx >= 0) writeFileSync(args[outIdx + 1], json); else process.stdout.write(json);
}
