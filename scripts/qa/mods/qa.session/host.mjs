// qa.session, host realm — QA only (graph-integrity G8.2, D4): a session process (node, found on the user's PATH) started with the mod; the
// Say setting's value written to its input whenever it changes; each line it answers logged, so a check sees one process fed across idle time.
export default {
  host(ctx) {
    const subs = [
      ctx.processes.on('echo', 'started', (d) => ctx.log.info(`qa.session started pid ${d.pid} at ${d.executable}`)),
      ctx.processes.on('echo', 'exited', (d) => ctx.log.info(`qa.session exited ${JSON.stringify(d)}`)),
      ctx.processes.on('echo', 'output', (d) => ctx.log.info(`qa.session ${d.stream}: ${d.line}`)),
    ];
    const said = ctx.settings.onChange(async (doc) => {
      const say = typeof doc?.say === 'string' ? doc.say : '';
      if (!say) return;
      try { await ctx.processes.write('echo', `${say}\n`); ctx.log.info(`qa.session wrote ${JSON.stringify(say)}`); }
      catch (e) { ctx.log.warn(`qa.session could not write: ${e?.code ?? ''} ${e?.message ?? e}`); }
    });
    return () => { for (const s of subs) s.dispose(); said?.dispose?.(); };
  },
};
