// A fixture for the SDK's agent helpers (graph-integrity G3.5): a chat's instructions, each turn's context and a tool.
import { instructions, tool } from '../../../../agent.mjs';

export default {
  host(ctx) {
    instructions(ctx, 'A says hello.');
    instructions(ctx, ({ thread }) => `A this turn, in ${thread.id}.`);
    tool(ctx, { name: 'echo', description: 'Echoes the text back', input: { type: 'object', properties: { text: { type: 'string' } } },
      run: async (args, env) => `A-ECHO ${args?.text} (${env.call})` });
  },
};
