// Host entry: runs in this mod's worker thread inside the Host. One file, no imports needed.
//
// A contribution to the agent's inputs: a chat's own setting (`focus`, declared in mod.json with `scope: "thread"`, so each chat has its
// own value) goes with every message sent in that chat, as the turn's additional context under this mod's name. It intercepts the
// send (`Thread.send` of Codex's chats) and adds its part; other mods' parts come in the user's order with it, and the provider refuses a
// change that is not this mod's own. The SDK's `instructions` helper (`@codexmods/sdk/agent`) does the same for a bundled mod, and also
// adds a text to a thread's developer instructions at its start.

const MAX = 2000;

async function host(ctx) {
  const key = `mod:${ctx.mod.id}`;
  const send = ctx.graph.intercept('CodexThread', 'send', async (call, next) => {
    const focus = await ctx.settings.get('focus', { thread: call.ref });
    if (typeof focus !== 'string' || !focus.trim()) return next();
    const [content, options] = call.args;
    const o = options && typeof options === 'object' ? options : {};
    const context = { ...(o.additionalContext ?? {}), [key]: { kind: 'application', value: `Keep in mind in this chat: ${focus.trim().slice(0, MAX)}` } };
    return next({ args: [content, { ...o, additionalContext: context }] });
  });
  return () => send.dispose();
}

export default { host };
