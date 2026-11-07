// TEST FIXTURE (not a product mod): a clientRequest interceptor on thread/start that sets params.cwd to a home-relative
// destination chosen by a setting, only when the request carries no cwd (absent or null). Any other cwd passes untouched.
// Used by tests/integration/slice-projectless.test.mjs. Single-file ESM, built-ins only.
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DESTINATION = 'developer-codex';
const DESTINATIONS = {
  'developer-codex': ['Developer', 'Codex'],
  'developer-chatgpt': ['Developer', 'ChatGPT'],
  'documents-codex': ['Documents', 'Codex'],
  'home-codex': ['Codex'],
};

const resolveDestination = (destination) => path.join(os.homedir(), ...(Object.hasOwn(DESTINATIONS, destination) ? DESTINATIONS[destination] : DESTINATIONS[DEFAULT_DESTINATION]));

async function host(ctx) {
  let destination = (await ctx.settings.get()).destination ?? DEFAULT_DESTINATION;
  const sub = ctx.settings.onChange((v) => { destination = v.destination ?? DEFAULT_DESTINATION; });
  const reg = ctx.appServer.intercept('clientRequest', ['thread/start'], (message) => {
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    if (params.cwd !== undefined && params.cwd !== null) return undefined;
    return { replace: { ...message, params: { ...params, cwd: resolveDestination(destination) } } };
  }, { timeoutMs: 500, onError: 'pass' });
  return () => { sub.dispose(); reg.dispose(); };
}

export default { host };
