// Fixtures of the parts the framework lends (graph-integrity G2.3): each part's props as an agent mod would pass its own data, for a
// mod's tests and the framework's own (each part drawing them, in both themes, on every build). Plain data; the callbacks are the test's.

const text = (t) => ({ parts: [{ kind: 'text', text: t }] });

export const LENT_FIXTURES = Object.freeze({
  ThreadHeader: { title: 'Fix the flaky test', subtitle: 'Claude · repo', actions: [{ label: 'Archive', icon: 'archive' }] },
  userMessage: { role: 'user', content: text('Why does the suite fail on CI?') },
  agentMessage: { role: 'agent', content: text('It reads the clock twice:\n\n- once in `setup`\n- once in **assert**\n\n```js\nconst now = Date.now();\n```\n\nSee [the docs](https://example.com/docs).') },
  streamingMessage: { role: 'agent', text: 'Looking at the', streaming: true },
  commandStep: { kind: 'command', title: 'npm test', status: 'completed', output: '> node --test\n✔ 41 passed\n✖ 1 failed' },
  runningStep: { kind: 'command', title: 'npm run build', status: 'running' },
  editStep: { kind: 'edit', title: 'Edited test/clock.test.mjs', status: 'completed',
    diff: '--- a/test/clock.test.mjs\n+++ b/test/clock.test.mjs\n@@ -1,3 +1,3 @@\n-const a = Date.now();\n+const a = clock.now();\n const b = 1;' },
  DiffView: { files: [{ path: 'src/clock.mjs', diff: '@@ -4,2 +4,2 @@\n-export const now = () => Date.now();\n+export const now = (c = Date) => c.now();' }] },
  FileChip: { path: '/repo/src/clock.mjs' },
  ApprovalCard: { title: 'Run npm install?', detail: text('It needs the network.'),
    options: [{ id: 'accept', label: 'Allow once', kind: 'approve' }, { id: 'acceptForSession', label: 'Allow this chat', kind: 'approve' }, { id: 'decline', label: 'Deny', kind: 'deny' }] },
  QuestionCard: { prompts: [
    { id: 'scope', header: 'Scope', prompt: text('Which tests should I run?'), choices: [{ id: 'all', label: 'All' }, { id: 'changed', label: 'Changed only' }], other: true, secret: false },
    { id: 'token', header: 'Token', prompt: text('The registry token'), choices: [], other: true, secret: true },
  ] },
  Composer: { placeholder: 'Ask Claude anything' },
  ModelPicker: { models: [{ id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep' }], value: 'fast' },
  EffortPicker: { efforts: ['low', 'medium', 'high'], value: 'medium' },
});
