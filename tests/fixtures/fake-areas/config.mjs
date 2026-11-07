// The fake app-server's layered Codex config (shared by the D10 areas; lib/config-store.mjs holds it):
//   config/read {cwd?, includeLayers?} → {config, origins, layers}: the user layer and the project layers whose root holds cwd, merged (a
//     project wins); origins name the layer of every leaf key path; layers (lowest first) only with includeLayers true, else null.
//   config/value/write {keyPath, value, mergeStrategy, filePath?, expectedVersion?} and config/batchWrite {edits, filePath?,
//     expectedVersion?, reloadUserConfig?} → {status: "ok", version, filePath, overriddenMetadata: null}: the layer filePath names (null:
//     the user's); value null removes the key; upsert merges objects; a stale expectedVersion or an unknown file is error -32600.
//   Test controls: fake/config {config} replaces the user layer; fake/projectConfig {root, config} sets a project's layer.
import { configStore } from './lib/config-store.mjs';

export default function config(f) {
  const answer = (m, r) => (r.error ? f.fail(m.id, -32600, r.error) : f.reply(m.id, { status: 'ok', version: r.version, filePath: r.filePath, overriddenMetadata: null }));
  return {
    'config/read': (m, p) => {
      const { config, origins, layers } = configStore.read(typeof p.cwd === 'string' ? p.cwd : null);
      f.reply(m.id, { config, origins, layers: p.includeLayers === true ? layers.map((l) => ({ name: l.name, version: l.version, config: l.config, disabledReason: l.disabledReason ?? null })) : null });
    },
    'config/value/write': (m, p) => {
      if (typeof p.keyPath !== 'string' || !p.keyPath || !['replace', 'upsert'].includes(p.mergeStrategy)) return f.fail(m.id, -32602, 'Invalid params: keyPath and mergeStrategy are needed');
      return answer(m, configStore.write([{ keyPath: p.keyPath, value: p.value ?? null, mergeStrategy: p.mergeStrategy }], p.filePath ?? null, p.expectedVersion ?? null));
    },
    'config/batchWrite': (m, p) => {
      if (!Array.isArray(p.edits) || p.edits.some((e) => typeof e?.keyPath !== 'string' || !['replace', 'upsert'].includes(e.mergeStrategy))) return f.fail(m.id, -32602, 'Invalid params: edits');
      return answer(m, configStore.write(p.edits.map((e) => ({ keyPath: e.keyPath, value: e.value ?? null, mergeStrategy: e.mergeStrategy })), p.filePath ?? null, p.expectedVersion ?? null));
    },
    'fake/config': (m, p) => { configStore.setUser(p.config ?? {}); f.reply(m.id, {}); },
    'fake/projectConfig': (m, p) => { configStore.setProject(String(p.root), p.config ?? {}); f.reply(m.id, {}); },
  };
}
