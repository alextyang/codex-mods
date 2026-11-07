// The native provider's declaration of what it realizes (realizes.mjs) stays equal to what the map produces: every type and link the map
// puts is declared, and every declared one is produced (so coverage, which counts from the declaration, counts what is there). A feature
// area (areas.mjs) gives its samples in areas/<name>.samples.mjs: `produced()`, every branch of its data, as the instances it puts.
import test from 'node:test';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { REALIZES } from '../realizes.mjs';
import { agentData, modelData, threadData, turnData, itemData, planData, requestData, refs } from '../map.mjs';
import { projectData, localEnvironmentData } from '../projects.mjs';
import { folderData, fileData } from '../files.mjs';
import { appsData } from '../apps.mjs';
import { cloudEnvironmentData } from '../cloud.mjs';
import { repositoryData } from '../git.mjs';
import { worktreeData } from '../worktrees.mjs';
import { instructionsData } from '../instructions.mjs';
import { actionsData } from '../actions.mjs';
import { settingData, sectionData, themeData, appData } from '../app-state.mjs';
import { accountData } from '../accounts.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';

const AREA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'areas');
const AREA_SAMPLES = [];
for (const f of readdirSync(AREA_DIR).filter((x) => x.endsWith('.samples.mjs')).sort()) AREA_SAMPLES.push(await import(pathToFileURL(join(AREA_DIR, f)).href));

/** Every branch of the map, once, and every area's samples. */
function produced() {
  const out = [agentData({ available: true }), agentData({ available: false, reason: 'stopped' }), modelData({ id: 'm', model: 'm', displayName: 'M', description: '', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] }),
    threadData({ id: 't', status: { type: 'idle' }, createdAt: 1, model: 'm', parentThreadId: 'q', turns: [] }, { project: refs.project('p'), environment: refs.localEnvironment('p') }),
    { ...projectData({ id: 'p', name: 'repo', roots: ['/Users/q/repo'] }), links: { ...projectData({ id: 'p', name: 'repo', roots: ['/Users/q/repo'] }).links, repository: refs.repository('p') } }, localEnvironmentData({ id: 'p', name: 'repo', roots: ['/Users/q/repo'] }),
    folderData('/Users/q/repo', 'p', null), folderData('/Users/q/repo/src', 'p', '/Users/q/repo'),
    fileData('/Users/q/repo/src/a.js', 'p', { size: 1, modifiedAt: 2, kind: 'text' }),
    ...[...appsData({ targets: [{ id: 'vscode', label: 'VS Code', icon: '/apps/vscode.png', kind: 'editor', bundleId: 'com.microsoft.VSCode' }], approvals: { apps: [] } })]
      .map(([id, d]) => ({ ref: refs.externalApp(id), state: d.state, links: {} })),
    { ...cloudEnvironmentData({ id: 'c1', name: 'cloud', status: 'ready' }), links: { project: refs.project('p') } },
    worktreeData('p', '/h/worktrees/1/repo', { exists: true, root: '/h/worktrees/1/repo', branch: 'codex/x', base: 'main', setup: 'npm ci' }, null),
    ...instructionsData('project', [{ path: '/Users/q/repo/AGENTS.md', exists: true, text: 'x' }], { projectId: 'p', folder: '/Users/q/repo' }),
    settingData({ key: 'appearanceTheme', agentAccess: 'read-write', default: 'system', description: 'Theme', schema: { type: 'string', enum: ['system', 'light', 'dark'] } }, { configured: 'dark', effective: 'dark' }),
    accountData({ type: 'chatgpt', email: 'q@example.com', planType: 'pro' }, { accountId: 'acct', workspace: { structure: 'workspace', name: 'Team' } }), accountData({ type: 'apiKey' }, null),
    { ref: refs.usage('acct'), state: { snapshots: {} }, links: { account: refs.chatgptAccount('acct') } },
    sectionData('appearance'), themeData(() => null, 'dark', { tokens: { accent: '#3a83f7' } }, [refs.setting('appearanceTheme')]),
    appData({ version: '26.1016.62342', onboarded: true }, { agents: [refs.agent()], accounts: [refs.chatgptAccount('acct-1')], settings: [refs.setting('appearanceTheme')], projects: [refs.project('p')], externalApps: [refs.externalApp('com.apple.finder')], newChatDraft: refs.draft('new:app:new-conversation') }),
    ...actionsData('p', { selected: '/Users/q/repo/.codex/environments/environment.toml', configs: [{ configPath: '/Users/q/repo/.codex/environments/environment.toml', name: 'env', actions: [{ name: 'Run', icon: 'run', command: 'make', platform: null }] }] }),
    ...(({ repo, branches }) => [{ ...repo, ref: { ...repo.ref, type: 'GitRepository' } }, ...branches])(repositoryData('p', { git: true, root: '/r', origin: 'o', branch: 'main', status: { staged: 0, unstaged: 1, untracked: 0 }, upstream: 'origin/main', ahead: 1, branches: ['dev'], defaultBranch: 'main', staged: [] })),
    turnData('t', { id: 'u', status: 'completed', startedAt: 1 })];
  const items = [
    { type: 'userMessage', id: 'a', content: [{ type: 'text', text: 'see' }, { type: 'localImage', path: '/tmp/a.png' }, { type: 'mention', name: 'figma', path: 'app://figma' }, { type: 'skill', name: 'review', path: '/s' }] },
    { type: 'agentMessage', id: 'b', text: 'x' }, { type: 'reasoning', id: 'c', summary: [] },
    { type: 'mcpToolCall', id: 'ca', server: 'computer-use', tool: 'click', status: 'completed', arguments: { app: 'com.apple.finder' } },
    { type: 'plan', id: 'd', text: '' }, { type: 'commandExecution', id: 'e', command: 'ls', cwd: '/', status: 'completed', commandActions: [] },
    { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.txt' }] },
    { type: 'webSearch', id: 'g', query: 'q', action: { type: 'openPage', url: 'https://x' } }, { type: 'webSearch', id: 'h', query: 'q', action: { type: 'search', query: 'q' } },
    { type: 'mcpToolCall', id: 'i', server: 's', tool: 'echo', status: 'completed', arguments: {} },
    { type: 'collabAgentToolCall', id: 'j', tool: 'spawn', status: 'completed', receiverThreadIds: ['child'], senderThreadId: 't', agentsStates: {} },
    { type: 'contextCompaction', id: 'k' },
  ];
  for (const item of items) out.push(...itemData('t', 'u', item, { done: true }));
  out.push(...planData('t', 'u', { explanation: 'Do it', plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'inProgress' }] }));
  const base = { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1 };
  for (const [method, params] of [
    ['item/commandExecution/requestApproval', { ...base, command: 'ls', cwd: '/' }],
    ['item/commandExecution/requestApproval', { ...base, networkApprovalContext: { host: 'example.com' } }],
    ['item/fileChange/requestApproval', { ...base }],
    ['item/permissions/requestApproval', { ...base }],
    ['mcpServer/elicitation/request', { threadId: 't', turnId: 'u', serverName: 'cua_repl', _meta: { connector_id: 'computer-use', tool_name: 'get_app_state', tool_params: { app: 'com.apple.finder' } } }],
    ['mcpServer/elicitation/request', { threadId: 't', turnId: 'u', serverName: 'srv', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'echo', tool_params: {} } }],
    ['item/tool/requestUserInput', { ...base, questions: [{ id: 'c', header: 'H', question: 'Q?', options: [{ label: 'A' }] }] }],
  ]) out.push(requestData(method, params, 's'));
  for (const a of AREA_SAMPLES) out.push(...a.produced());
  return out.filter(Boolean);
}
// Put by the source itself, not the map: the new-chat Draft (drafts.put), a turn's final answer, a step's request (Step.request,
// linked when the request opens; codex.test.mjs covers them), and the accounts (a chat's, the agent's: added-accounts.test.mjs).
const SOURCE_ONLY = [['Draft', []], ['CodexTurn', ['answer']], ['CodexAgent', ['account', 'accounts', 'startAccount']], ['CodexCommandRun', ['request']], ['CodexToolCall', ['request']], ['FileEdit', ['request']], ['CodexThread', ['automation', 'account']]];

test('every type and link the map puts is declared in REALIZES, and every declared one is produced', () => {
  const seen = new Map();
  const add = (type, links) => { let s = seen.get(type); if (!s) seen.set(type, (s = new Set())); for (const l of links) s.add(l); };
  for (const d of produced()) add(d.ref.type, Object.keys(d.links ?? {}));
  for (const [type, links] of SOURCE_ONLY) add(type, links);
  assert.deepEqual([...seen.keys()].sort(), [...REALIZES.types].sort(), 'the types it puts');
  for (const type of REALIZES.types) {
    assert.deepEqual([...(seen.get(type) ?? [])].sort(), [...(REALIZES.links[type] ?? [])].sort(), `the links of ${type}`);
  }
});

test('every optional member the map fills is one the provider declares it supports (SUPPORTS, by the type or an ancestor)', () => {
  const byId = new Map(NATIVE_TYPES.map((d) => [d.id, d]));
  const chain = (id) => { const out = []; for (let d = byId.get(id); d; d = d.parent ? byId.get(d.parent) : null) out.unshift(d.id); return out; };
  const missing = new Set();
  for (const d of produced()) {
    const ch = chain(d.ref.type);
    for (const k of [...Object.keys(d.state ?? {}), ...Object.keys(d.links ?? {})]) {
      const tier = ch.map((x) => byId.get(x).spec.state?.[k] ?? byId.get(x).spec.relations?.[k]).filter(Boolean).at(-1)?.tier;
      if (tier === 'optional' && !ch.some((x) => (REALIZES.supports[x] ?? []).includes(k))) missing.add(`${d.ref.type}.${k}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('REALIZES names native types, members and operations that exist', () => {
  const byId = new Map(NATIVE_TYPES.map((d) => [d.id, d]));
  for (const t of REALIZES.types) assert.ok(byId.has(t), t);
  for (const [t, ops] of Object.entries(REALIZES.operations)) for (const op of ops) assert.ok(byId.get(t)?.spec.operations?.[op], `${t}.${op}`);
  for (const [t, names] of Object.entries(REALIZES.events)) for (const n of names) assert.ok(byId.get(t)?.spec.events?.[n], `${t} event ${n}`);
  // A supported member is an optional one of the type or of an ancestor.
  const chain = (id) => { const out = []; for (let d = byId.get(id); d; d = d.parent ? byId.get(d.parent) : null) out.push(d.spec); return out; };
  for (const [t, names] of Object.entries(REALIZES.supports)) for (const n of names) {
    const m = chain(t).map((s) => s.state?.[n] ?? s.relations?.[n] ?? s.operations?.[n]).find(Boolean);
    assert.equal(m?.tier, 'optional', `${t}.${n}`);
  }
});
