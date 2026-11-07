// TEST FIXTURE (not a product mod): a request interceptor that sets `config.compact_prompt` on thread/start, thread/resume
// and thread/fork, preserving every other config override. Used by tests/integration/slice-compaction.test.mjs and
// slice-faults.test.mjs as a real, healthy mod with a settings schema. Single-file ESM, no imports.

const COMPACT_PROMPT = 'TEST FIXTURE COMPACTION PROMPT: summarise the conversation so far for the next model, keeping decisions, open questions, file references and the exact state of any work in progress.';
const THREAD_METHODS = ['thread/start', 'thread/resume', 'thread/fork'];

function withCompactPrompt(params, prompt) {
  const base = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const config = base.config && typeof base.config === 'object' && !Array.isArray(base.config) ? base.config : {};
  return { ...base, config: { ...config, compact_prompt: prompt } };
}

const promptFrom = (settings) => (typeof settings?.prompt === 'string' && settings.prompt.length >= 1 ? settings.prompt : COMPACT_PROMPT);

async function host(ctx) {
  let prompt = promptFrom(await ctx.settings.get());
  const sub = ctx.settings.onChange((value) => { prompt = promptFrom(value); });   // applies from the next request
  const reg = ctx.appServer.intercept('clientRequest', THREAD_METHODS, (message) => (
    { replace: { ...message, params: withCompactPrompt(message.params, prompt) } }
  ), { priority: 0, timeoutMs: 500, onError: 'pass' });
  return () => { sub.dispose(); reg.dispose(); };
}

export default { host };
export { COMPACT_PROMPT };
