// The fake app-server's layered Codex config (fake-areas/config.mjs serves it; other area modules read and watch it): a user layer
// (`<CODEX_HOME>/config.toml`) and project layers by root (`<root>/.codex/config.toml`), each with a version that every write bumps.
// Values are plain JSON; key paths are dotted (`mcp_servers.qa.enabled`). One store per fake process. Node built-ins only.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function home() { return process.env.CODEX_HOME || '/tmp/fake-codex-home'; }

let user = { config: {}, version: 1 };
const projects = new Map();   // root -> {config, version}
const listeners = new Set();

function getAt(obj, path) {
  let at = obj;
  for (const k of path) { if (!isObject(at) || !Object.hasOwn(at, k)) return undefined; at = at[k]; }
  return at;
}
function setAt(obj, path, value, mergeStrategy) {
  let at = obj;
  for (const k of path.slice(0, -1)) { if (!isObject(at[k])) at[k] = {}; at = at[k]; }
  const last = path.at(-1);
  if (value === null) { delete at[last]; return; }
  if (mergeStrategy === 'upsert' && isObject(at[last]) && isObject(value)) at[last] = deepMerge(at[last], value);
  else at[last] = clone(value);
}
function deepMerge(a, b) {
  const out = clone(a) ?? {};
  for (const [k, v] of Object.entries(b)) out[k] = isObject(out[k]) && isObject(v) ? deepMerge(out[k], v) : clone(v);
  return out;
}
/** Every leaf key path of a config object (an object's own keys, recursively; arrays are leaves). */
function leaves(obj, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isObject(v) && Object.keys(v).length) out.push(...leaves(v, [...prefix, k]));
    else out.push([...prefix, k].join('.'));
  }
  return out;
}

export const configStore = {
  userFile: () => `${home()}/config.toml`,
  projectFile: (root) => `${root}/.codex/config.toml`,
  /** The layers that apply at `cwd`, lowest first: the user's, then the project layers whose root holds cwd (the deepest last). */
  layersAt(cwd) {
    const out = [{ name: { type: 'user', file: configStore.userFile() }, version: `v${user.version}`, config: user.config, root: null }];
    const roots = [...projects.keys()].filter((r) => typeof cwd === 'string' && (cwd === r || cwd.startsWith(`${r}/`))).sort((a, b) => a.length - b.length);
    // a project the user's config does not say is trusted (its folder's entry, or the nearest around it): its layer is listed with why,
    // and none of it applies (Codex's rule: an absent entry is not trust)
    const trusted = (r) => {
      const at = Object.keys(user.config?.projects ?? {}).filter((f) => r === f || r.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0];
      return at !== undefined && user.config.projects[at]?.trust_level === 'trusted';
    };
    for (const r of roots) out.push({ name: { type: 'project', dotCodexFolder: `${r}/.codex` }, version: `v${projects.get(r).version}`, config: projects.get(r).config, root: r,
      ...(trusted(r) ? {} : { disabledReason: `To load project-local config, add ${r} as a trusted project.` }) });
    return out;
  },
  /** The merged config at `cwd` and, per leaf key path, the layer it comes from. */
  read(cwd) {
    const layers = configStore.layersAt(cwd);
    let config = {};
    const origins = {};
    for (const l of layers) {
      if (l.disabledReason) continue;
      config = deepMerge(config, l.config);
      for (const p of leaves(l.config)) origins[p] = { name: l.name, version: l.version };
    }
    return { config, origins, layers };
  },
  /** The merged value at a dotted key path (at cwd, else the user layer's). */
  get(keyPath, cwd = null) { return clone(getAt(configStore.read(cwd).config, keyPath.split('.'))); },
  /** Apply edits to the layer a file names (null or the user file: the user layer). Returns {filePath, version} or {error}. */
  write(edits, filePath = null, expectedVersion = null) {
    const root = filePath && filePath !== configStore.userFile() ? [...projects.keys()].find((r) => configStore.projectFile(r) === filePath) : null;
    if (filePath && filePath !== configStore.userFile() && !root) return { error: `not a config layer: ${filePath}` };
    const layer = root ? projects.get(root) : user;
    if (expectedVersion !== null && expectedVersion !== undefined && expectedVersion !== `v${layer.version}`) return { error: `version conflict: ${expectedVersion} is not v${layer.version}` };
    for (const e of edits) setAt(layer.config, String(e.keyPath).split('.'), e.value, e.mergeStrategy);
    layer.version += 1;
    for (const fn of [...listeners]) fn({ keyPaths: edits.map((e) => String(e.keyPath)), root });
    return { filePath: root ? configStore.projectFile(root) : configStore.userFile(), version: `v${layer.version}` };
  },
  /** Test controls: replace the user layer, set a project's layer. */
  setUser(config) { user = { config: clone(config) ?? {}, version: user.version + 1 }; for (const fn of [...listeners]) fn({ keyPaths: ['*'], root: null }); },
  setProject(root, config) { const v = projects.get(root)?.version ?? 0; projects.set(root, { config: clone(config) ?? {}, version: v + 1 }); for (const fn of [...listeners]) fn({ keyPaths: ['*'], root }); },
  /** fn({keyPaths, root}) after every change; returns the unsubscribe. */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
