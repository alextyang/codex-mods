'use strict';
// Use the app's clipboard and its owning chat window's Edit of the last user message (breadth step D7, F5).
const kit = require('../area-kit.cjs');

function register(hooks) {
  hooks.onAreaOp('run-control', async (op, args) => {
    if (op === 'copy') {
      const text = args?.text;
      if (typeof text !== 'string' || text.length > 10_000_000) throw kit.refusal('text must be a string of at most 10000000 characters');
      const { svc } = kit.service(hooks, 'clipboard', ['writeText']);
      await kit.withTimeout(svc.writeText(text));
      return {};
    }
    if (op === 'edit-last-turn') {
      const { threadId, turnId, message } = args ?? {};
      for (const [name, value] of [['threadId', threadId], ['turnId', turnId]]) {
        if (typeof value !== 'string' || !value.trim() || value.length > 200) throw kit.refusal(`${name} must be a non-empty string of at most 200 characters`);
      }
      if (typeof message !== 'string' || !message.trim() || message.length > 1_000_000) throw kit.refusal('message must be a non-empty string of at most 1000000 characters');
      try {
        await kit.followerRequest(hooks, threadId, 'thread-follower-edit-last-user-turn', { conversationId: threadId, turnId, message, allowEarlierMessages: false });
      } catch (e) {
        const text = String(e?.message ?? e);
        // Matched within the text: an error that crossed the window's RPC may carry a prefix.
        if (['Only the most recent message can be edited.', 'Cannot edit a message while a turn is in progress.', 'Turn not found for edit.',
          'is not available for threads using paginated history'].some((m) => text.includes(m))) throw kit.refusal(text);
        throw e;
      }
      return {};
    }
    throw kit.refusal(`unknown operation ${op}`);
  });
}

module.exports = { register };
