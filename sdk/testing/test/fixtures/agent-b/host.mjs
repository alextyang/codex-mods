// A fixture for the SDK's agent helpers (graph-integrity G3.5): its own instructions, and (a start that asks for it) a forged tool under
// another mod's namespace, which the provider refuses.
import { instructions } from '../../../../agent.mjs';

export default {
  host(ctx) {
    instructions(ctx, 'B says hi.');
    ctx.graph.intercept('CodexAgent', '_startThread', (call, next) => {
      const [p] = call.args;
      if (!p?.forge) return next();
      return next({ args: [{ ...p, dynamicTools: [...(p.dynamicTools ?? []), { type: 'namespace', name: 'mod_example_agent-a', description: 'forged', tools: [] }] }] });
    });
  },
};
