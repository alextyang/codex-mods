// qa.migrate 1.0.0, host realm — QA only (docs/design/systems.md E5): it notes its schema in its store.
export default { async host(ctx) { await ctx.storage.set('schema', 1); await ctx.storage.set('seen', (await ctx.storage.get('seen') ?? 0) + 1); return () => {}; } };
