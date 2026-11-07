// Shape checks of app-server frames against a build's own JSON Schema (contracts/upstream/<build>/schema, and schema-experimental when the
// build has it). integration.md §12: codecs and fixtures are checked against the protocol's real shapes, not only against themselves.
// A small validator for the keywords the generated schema uses: $ref (local pointers), allOf, anyOf, oneOf (at least one alternative),
// type, enum, const, required, properties, additionalProperties, items, minimum. `format` and `default` are not checked.
// Node built-ins only.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { UPSTREAM } from './captures.mjs';

const roots = new Map();
/** The build's root schema bundle, the experimental one when present (it is a superset). */
export function schemaRoot(build) {
  if (roots.has(build)) return roots.get(build);
  const exp = join(UPSTREAM, build, 'schema-experimental', 'codex_app_server_protocol.schemas.json');
  const std = join(UPSTREAM, build, 'schema', 'codex_app_server_protocol.schemas.json');
  const file = existsSync(exp) ? exp : std;
  if (!existsSync(file)) throw new Error(`no schema bundle for build ${build}`);
  const root = JSON.parse(readFileSync(file, 'utf8'));
  roots.set(build, root);
  return root;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (t, v) => { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer'); };

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`external $ref ${ref}`);
  let at = root;
  for (const part of ref.slice(2).split('/')) { at = at?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]; }
  if (at === undefined) throw new Error(`unresolved $ref ${ref}`);
  return at;
}

function check(root, schema, value, path, out) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { out.push({ path, message: 'no value is allowed here' }); return; }
  if (schema.$ref) check(root, resolve(root, schema.$ref), value, path, out);
  for (const s of schema.allOf ?? []) check(root, s, value, path, out);
  for (const key of ['anyOf', 'oneOf']) {
    if (!schema[key]) continue;
    const tries = schema[key].map((s) => { const o = []; check(root, s, value, path, o); return o; });
    if (!tries.some((o) => o.length === 0)) {
      const best = tries.reduce((a, b) => (b.length < a.length ? b : a));
      out.push({ path, message: `matches none of the ${tries.length} alternatives (closest: ${best.slice(0, 3).map((i) => `${i.path} ${i.message}`).join('; ')})` });
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) { out.push({ path, message: `is ${typeOf(value)}, not ${types.join(' or ')}` }); return; }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) out.push({ path, message: `is not one of ${JSON.stringify(schema.enum).slice(0, 120)}` });
  if ('const' in schema && schema.const !== value) out.push({ path, message: `is not ${JSON.stringify(schema.const)}` });
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) out.push({ path, message: `is below ${schema.minimum}` });
  if (isObject(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) out.push({ path: `${path}.${r}`, message: 'is required' });
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) check(root, props[k], v, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push({ path: `${path}.${k}`, message: 'is not a property of this type' });
      else if (isObject(schema.additionalProperties)) check(root, schema.additionalProperties, v, `${path}.${k}`, out);
    }
  }
  if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) value.forEach((v, i) => check(root, schema.items, v, `${path}[${i}]`, out));
}

/** Every way `value` breaks `schema` (a schema object of the build's bundle): [{path, message}]. */
export function schemaIssues(build, schema, value, path = '$') {
  const out = [];
  check(schemaRoot(build), schema, value, path, out);
  return out;
}

/** The entry of a method in one of the bundle's unions (ClientRequest, ServerNotification, ServerRequest, ClientNotification). */
function entry(build, union, method) {
  const root = schemaRoot(build);
  const u = root.definitions[union];
  const e = (u?.oneOf ?? u?.anyOf ?? []).find((b) => b?.properties?.method?.enum?.[0] === method || b?.properties?.method?.const === method);
  return e ?? null;
}
const definition = (build, name) => {
  const d = schemaRoot(build).definitions;
  return d[name] ?? d.v2?.[name] ?? null;
};

/**
 * The schema a frame's payload must match, by what it is:
 *  'params' (a client request's params), 'result' (its response's result), 'notification' (a server notification's params),
 *  'serverRequest' (a server request's params), 'answer' (the client's result for a server request), 'clientNotification' (its params).
 * Null when the build has no such method or no response schema (the generator pairs <X>Params with <X>Response).
 */
/** Methods whose response does not follow the <X>Params / <X>Response pairing (the generator names it otherwise). */
const RESPONSE_OF = Object.freeze({
  'config/batchWrite': 'ConfigWriteResponse', 'config/value/write': 'ConfigWriteResponse', 'config/mcpServer/reload': 'McpServerRefreshResponse',
});

export function schemaOf(build, what, method) {
  const union = { params: 'ClientRequest', result: 'ClientRequest', notification: 'ServerNotification', serverRequest: 'ServerRequest', answer: 'ServerRequest', clientNotification: 'ClientNotification' }[what];
  if (!union) throw new Error(`unknown frame part ${what}`);
  const e = entry(build, union, method);
  if (!e) return null;
  if ((what === 'result' || what === 'answer') && Object.hasOwn(RESPONSE_OF, method)) return definition(build, RESPONSE_OF[method]);
  if (what === 'result' || what === 'answer') {
    // <X>Params pairs with <X>Response; a method without params falls back to its camel-cased name (account/logout → AccountLogoutResponse).
    const ref = e.properties?.params?.$ref;
    if (ref) { const d = definition(build, ref.split('/').pop().replace(/Params$/, 'Response')); if (d) return d; }
    const camel = method.split(/[/_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    return definition(build, `${camel}Response`);
  }
  return e.properties?.params ?? {};
}

/** Every way a frame's payload breaks its method's schema; a method the build does not have is one issue. */
export function frameIssues(build, what, method, value) {
  const s = schemaOf(build, what, method);
  if (s === null) return [{ path: '$', message: `no schema for ${what} of '${method}' in build ${build}` }];
  const issues = schemaIssues(build, s, value);
  // A method without params is typed `null`; the app sends `{}` for it, or no params at all, and the server accepts each.
  if (issues.length && (value === undefined || (isObject(value) && Object.keys(value).length === 0)) && schemaIssues(build, s, null).length === 0) return [];
  return issues;
}
