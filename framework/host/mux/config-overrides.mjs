// AdapterPack.backend.configOverrides -> `-c <key>=<toml>` arguments for the primary backend spawn (ARCHITECTURE v1.20).
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';

const VAR_RE = /\$\{([^}]*)\}/g;
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** Substitute ${name} in one string. An unknown name throws Invalid (the Host refuses the spawn; nothing is dropped silently). */
export function renderTemplate(str, vars) {
  return str.replace(VAR_RE, (_, name) => {
    if (!Object.hasOwn(vars, name) || typeof vars[name] !== 'string') {
      throw new CodexModsError('Invalid', `configOverrides: unknown or unavailable template variable \${${name}}`, { variable: name });
    }
    return vars[name];
  });
}

/** Template variables for configOverrides. Any input that is missing leaves its variables unavailable (an error if used). */
export function configOverrideVars({ runningAppPath, realCodexPath, layout, profile }) {
  const vars = {};
  let appContents;
  if (typeof runningAppPath === 'string' && runningAppPath) appContents = join(runningAppPath, 'Contents');
  else if (typeof realCodexPath === 'string') {
    const i = realCodexPath.indexOf('/Contents/');            // the outermost app bundle
    if (i >= 0) appContents = realCodexPath.slice(0, i + '/Contents'.length);
  }
  if (appContents) {
    vars.appContents = appContents;
    vars.resources = `${appContents}/Resources`;
    vars.relayPath = `${appContents}/Resources/codexmods-relay`;
  }
  if (layout?.computerUse) vars.computerUseDir = layout.computerUse;
  if (layout?.profileDir) vars.profileDir = layout.profileDir;
  if (profile?.codexHome) vars.codexHome = profile.codexHome;
  return vars;
}

const ESC = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
export function tomlString(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ESC[ch]) out += ESC[ch];
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}
const tomlKey = (k) => (BARE_KEY.test(k) ? k : tomlString(k));

/** TOML value for codex `-c` (strings are templated first when `vars` is given). */
export function toToml(value, vars) {
  switch (typeof value) {
    case 'string': return tomlString(vars ? renderTemplate(value, vars) : value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CodexModsError('Invalid', 'configOverrides: numbers must be finite');
      return String(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((v) => toToml(v, vars)).join(', ')}]`;
      if (value !== null) {
        const parts = Object.entries(value).map(([k, v]) => `${tomlKey(vars ? renderTemplate(k, vars) : k)} = ${toToml(v, vars)}`);
        return parts.length ? `{ ${parts.join(', ')} }` : '{}';
      }
  }
  throw new CodexModsError('Invalid', `configOverrides: unsupported value of type ${value === null ? 'null' : typeof value}`);
}

/** ['-c', 'key=toml', ...] in key order. */
export function buildConfigOverrideArgs(overrides, vars) {
  const args = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!key || /[=\s]/.test(key)) throw new CodexModsError('Invalid', `configOverrides: invalid key '${key}'`);
    args.push('-c', `${key}=${toToml(value, vars)}`);
  }
  return args;
}

/** Insert the -c pairs immediately before the `app-server` token (after the app's own -c pairs, so ours win); at the front if absent. */
export function withConfigArgs(args, cfgArgs) {
  if (!cfgArgs.length) return args;
  const i = args.indexOf('app-server');
  const at = i >= 0 ? i : 0;
  return [...args.slice(0, at), ...cfgArgs, ...args.slice(at)];
}
