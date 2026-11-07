// The JSON Schema subset used by mod settings (contracts/manifest.d.ts): type object|string|number|integer|boolean|array,
// properties, required, enum, default, minimum, maximum, minLength, maxLength, items, title, description. Nothing else.
import { CodexModsError } from '../../../sdk/errors.mjs';

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'title', 'description']);
const invalid = (path, msg) => new CodexModsError('Invalid', `${path}: ${msg}`, { path });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const propPath = (base, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`);

/** Checks that a schema document uses only the subset. `path` prefixes messages (e.g. "settings"). Defaults are checked against their schema. */
export function checkSchema(schema, path = 'settings') {
  if (!isObj(schema)) throw invalid(path, 'must be an object');
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw invalid(path, `unsupported schema keyword "${key}"`);
  if (!TYPES.has(schema.type)) throw invalid(`${path}.type`, `must be one of ${[...TYPES].join(', ')}`);
  for (const k of ['title', 'description']) if (schema[k] !== undefined && typeof schema[k] !== 'string') throw invalid(`${path}.${k}`, 'must be a string');
  for (const k of ['minimum', 'maximum']) if (schema[k] !== undefined && (typeof schema[k] !== 'number' || !Number.isFinite(schema[k]))) throw invalid(`${path}.${k}`, 'must be a finite number');
  for (const k of ['minLength', 'maxLength']) if (schema[k] !== undefined && (!Number.isInteger(schema[k]) || schema[k] < 0)) throw invalid(`${path}.${k}`, 'must be a non-negative integer');
  if (schema.properties !== undefined) {
    if (schema.type !== 'object') throw invalid(`${path}.properties`, 'is only valid for type object');
    if (!isObj(schema.properties)) throw invalid(`${path}.properties`, 'must be an object');
    for (const [k, sub] of Object.entries(schema.properties)) checkSchema(sub, propPath(`${path}.properties`, k));
  }
  if (schema.required !== undefined) {
    if (schema.type !== 'object') throw invalid(`${path}.required`, 'is only valid for type object');
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string')) throw invalid(`${path}.required`, 'must be an array of strings');
  }
  if (schema.items !== undefined) {
    if (schema.type !== 'array') throw invalid(`${path}.items`, 'is only valid for type array');
    checkSchema(schema.items, `${path}.items`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw invalid(`${path}.enum`, 'must be a non-empty array');
  if (schema.enum !== undefined) for (const [i, e] of schema.enum.entries()) check(schema, e, `${path}.enum[${i}]`, { skipEnum: true });
  if (schema.default !== undefined) check(schema, schema.default, `${path}.default`, {});
}

function check(schema, value, path, { skipEnum = false } = {}) {
  switch (schema.type) {
    case 'object': if (!isObj(value)) throw invalid(path, 'expected object'); break;
    case 'array': if (!Array.isArray(value)) throw invalid(path, 'expected array'); break;
    case 'string': if (typeof value !== 'string') throw invalid(path, 'expected string'); break;
    case 'boolean': if (typeof value !== 'boolean') throw invalid(path, 'expected boolean'); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(path, 'expected number'); break;
    case 'integer': if (!Number.isInteger(value)) throw invalid(path, 'expected integer'); break;
    default: throw invalid(path, 'unknown type');
  }
  if (!skipEnum && schema.enum && !schema.enum.some((e) => deepEqual(e, value))) throw invalid(path, `must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw invalid(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw invalid(path, `must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) throw invalid(path, `must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) throw invalid(path, `must have at most ${schema.maxLength} characters`);
  }
}

/** Validates `value` against `schema` and returns it with defaults applied. Throws Invalid with a path-precise message. */
export function applySchema(schema, value, path = 'settings') {
  if (value === undefined && schema.default !== undefined) value = clone(schema.default);
  if (value === undefined) throw invalid(path, 'is required');
  check(schema, value, path);
  if (schema.type === 'object') {
    const out = { ...value };
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      const p = propPath(path, key);
      if (out[key] === undefined) {
        if (sub.default !== undefined) out[key] = clone(sub.default);
        else if (sub.type === 'object' && sub.properties) {
          const nested = fillObjectDefaults(sub, p);
          if (nested && Object.keys(nested).length) out[key] = nested;
        }
      }
      if (out[key] !== undefined) out[key] = applySchema(sub, out[key], p);
    }
    for (const req of schema.required ?? []) if (out[req] === undefined) throw invalid(propPath(path, req), 'is required');
    return out;
  }
  if (schema.type === 'array' && schema.items) return value.map((item, i) => applySchema(schema.items, item, `${path}[${i}]`));
  return value;
}

function fillObjectDefaults(schema, path) {
  const out = {};
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (sub.default !== undefined) out[key] = clone(sub.default);
    else if (sub.type === 'object' && sub.properties) {
      const nested = fillObjectDefaults(sub, propPath(path, key));
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}
