// qa.migrate 1.1.0, host realm — QA only (docs/design/systems.md E5): its store says what the migration did.
export default { async host(ctx) { await ctx.storage.set('ran', '1.1.0'); return () => {}; } };
