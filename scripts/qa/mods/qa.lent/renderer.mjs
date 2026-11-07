// qa.lent, renderer realm — QA only (graph-integrity G2.3): its page draws each lent part with the testing kit's fixtures (a copy: the QA
// copy cannot read the checkout), the way an agent mod would draw its own chat.
const text = (t) => ({ parts: [{ kind: 'text', text: t }] });
const F = {
  ThreadHeader: { title: 'Fix the flaky test', subtitle: 'QA lent parts', actions: [{ label: 'Archive', icon: 'archive' }] },
  user: { role: 'user', content: text('Why does the suite fail on CI?') },
  agent: { role: 'agent', content: text('It reads the clock twice:\n\n- once in `setup`\n- once in **assert**\n\n```js\nconst now = Date.now();\n```') },
  command: { kind: 'command', title: 'npm test', status: 'completed', output: '> node --test\n✔ 41 passed\n✖ 1 failed', expanded: true },
  edit: { kind: 'edit', title: 'Edited test/clock.test.mjs', status: 'completed', expanded: true,
    diff: '--- a/test/clock.test.mjs\n+++ b/test/clock.test.mjs\n@@ -1,3 +1,3 @@\n-const a = Date.now();\n+const a = clock.now();\n const b = 1;' },
  approval: { title: 'Run npm install?', detail: text('It needs the network.'),
    options: [{ id: 'accept', label: 'Allow once', kind: 'approve' }, { id: 'decline', label: 'Deny', kind: 'deny' }] },
  question: { prompts: [{ id: 'scope', header: 'Scope', prompt: text('Which tests should I run?'), choices: [{ id: 'all', label: 'All' }, { id: 'changed', label: 'Changed only' }], other: true }] },
};

function renderer(ctx) {
  const R = ctx.ui.react;
  const C = ctx.ui.components;
  const e = R.createElement;
  const page = ctx.ui.pages.add({ id: 'lent', title: 'QA lent parts', render: () => e('div', { 'data-qa': 'lent', style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    e(C.ThreadHeader, F.ThreadHeader),
    e(C.Transcript, null,
      e(C.Turn, null, e(C.Message, F.user), e(C.StepRow, F.command), e(C.StepRow, F.edit), e(C.Message, F.agent)),
      e(C.Turn, { status: 'running' }, e(C.ApprovalCard, { ...F.approval, onAnswer: (id) => console.warn(`qa.lent answer ${id}`) }),
        e(C.QuestionCard, { ...F.question, onAnswer: (a) => console.warn(`qa.lent answers ${JSON.stringify(a)}`) }),
        e(C.DiffView, { files: [{ path: 'src/clock.mjs', diff: '@@ -4,2 +4,2 @@\n-export const now = () => Date.now();\n+export const now = (c = Date) => c.now();' }] }),
        e(C.FileChip, { path: '/repo/src/clock.mjs' }))),
    e(C.Composer, { placeholder: 'Ask the QA agent', onSubmit: (t) => console.warn(`qa.lent send ${t}`),
      pickers: [e(C.ModelPicker, { key: 'm', models: [{ id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep' }], value: 'fast' }), e(C.EffortPicker, { key: 'e', efforts: ['low', 'medium', 'high'], value: 'medium' })] })) });
  // it opens itself once a window can show it
  let tries = 0;
  const opener = setInterval(() => { tries++; let opened = false; try { opened = page.open(); } catch { /* not yet */ } if (opened || tries > 30) clearInterval(opener); }, 2000);
  return () => { clearInterval(opener); page.dispose(); };
}

export default { renderer };
