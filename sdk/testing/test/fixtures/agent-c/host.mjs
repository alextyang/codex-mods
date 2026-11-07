// A fixture for the SDK's agent helpers: a turn's context only in the chats a where keeps (reference-mods.md RM9: a role).
import { instructions } from '../../../../agent.mjs';

export default {
  host(ctx) {
    instructions(ctx, ({ thread }) => `C for the lead chat ${thread.id}.`, { scope: { where: { title: 'Lead' } } });
  },
};
