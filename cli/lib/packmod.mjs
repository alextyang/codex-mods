// Loads the pack module (framework/host/packages/pack.mjs: keygen, packMod). The path is injectable for tests.
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { CodexModsError } from '../../sdk/errors.mjs';

const DEFAULT = new URL('../../framework/host/packages/pack.mjs', import.meta.url).href;

export async function loadPackModule(io) {
  const spec = io.modules?.pack ?? DEFAULT;
  const href = isAbsolute(spec) ? pathToFileURL(spec).href : spec;
  try { return await import(href); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') throw new CodexModsError('Unavailable', `The packaging module is not available in this checkout (${spec})`);
    throw e;
  }
}
