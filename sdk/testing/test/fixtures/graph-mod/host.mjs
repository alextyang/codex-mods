// A fixture for sdk/testing/graph.mjs: a mod that acts on and intercepts the app's chats through ctx.graph only.
export default {
  async host(ctx) {
    let archived = 0;
    ctx.graph.intercept('Thread', 'archive', async (call, next) => {
      const thread = await ctx.graph.resolve(call.ref);
      if (thread?.state?.title?.startsWith('keep')) return { status: 'refused', reason: 'notAllowed', message: 'kept by the graph mod' };
      archived += 1;
      return next();
    });
    ctx.services.provide('fixture', {
      async rename({ ref, title }) { return ctx.graph.invoke(ref, 'rename', [title]); },
      async count() { return { archived }; },
    });
  },
};
