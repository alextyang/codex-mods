// qa.panes, host realm — QA only (graph-integrity G5.1, G5.2): a turn's steps start unfolded and the app's command steps expanded, until the
// user chooses (defaults of presentation state), and the commands that move the keyboard between the panes of the window they run in.
export default {
  host(ctx) {
    const focus = (target) => async (env) => {
      const out = await ctx.graph.invoke(env.window, 'focusPane', [target]);
      ctx.log.info(`qa.panes focusPane ${target}: ${out?.status}${out?.message ? ` (${out.message})` : ''}`);
    };
    const handles = [
      ctx.graph.defaults({ id: 'turns-open', of: 'TurnView', state: { expanded: true } }),
      ctx.graph.defaults({ id: 'commands-open', of: 'StepBlock', for: 'CommandRun', state: { expanded: true } }),
      ctx.ui.commands.add({ id: 'pane-next', title: 'QA next pane', run: focus('next') }),
      ctx.ui.commands.add({ id: 'pane-previous', title: 'QA previous pane', run: focus('previous') }),
      ctx.ui.commands.add({ id: 'pane-main', title: 'QA main pane', run: focus('main') }),
    ];
    return () => { for (const h of handles) h.dispose?.(); };
  },
};
