// @codexmods/sdk runtime entry. The Host supplies contexts; this module only shapes definitions.
export { CodexModsError, ERROR_CODES } from './errors.mjs';

/** An SDK v2 mod's setting (docs/design/systems.md S13): {key, kind, title, description, default, scope, ...}; the Host checks it. */
export function setting(key, spec) {
  if (typeof key !== 'string' || !key || !spec || typeof spec !== 'object') throw new TypeError('setting(key, {kind, title, description, default, scope})');
  return Object.freeze({ key, ...structuredClone(spec) });
}

export function defineMod(definition) {
  if (!definition || (typeof definition.host !== 'function' && typeof definition.renderer !== 'function')) {
    throw new TypeError('defineMod needs a host or renderer function');
  }
  return Object.freeze({ ...definition });
}
