// codexmods.intelligence (GOAL.md goal 16; docs/design/reference-mods.md §2): the guardrails, the managed thread's settings, and a mod's
// call end to end: refused while its model use is off, then run in a private thread on the app's connection (the real mux on the strict
// fake app-server) with the mod's own storage and tools answered in its own realm, its text streamed, its tokens counted, and the app
// never hearing of the thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admit, accountUsed, threadParams, usedSince, LIMITS, NAMESPACE } from '../host.mjs';
import { harness, until } from '../../../host/mux/test/helpers.mjs';
import { FRAMEWORK_TYPES } from '../../../../sdk/graph/framework.mjs';
import { toDescriptor } from '../../../../sdk/graph/define.mjs';
import { modData } from '../../../host/graph/providers/framework/index.mjs';

const { createTestGraph } = await import('../../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const WRITER = 'acme.writer';
const use = (o = {}) => ({ enabled: true, perHour: 1000, perDay: 5000, history: [], ...o });

test('a call is admitted only while the user has the mod\'s model use on, within its allowances and the limits', () => {
  const t = 10 * 3_600_000, ok = { now: t, calls: [], account: 10, promptChars: 100, running: 0 };
  assert.equal(admit(use(), ok), null);
  assert.match(admit(undefined, ok), /not declared model use/);
  assert.match(admit(use({ enabled: false }), ok), /model use is off/);
  assert.match(admit(use({ history: [{ t: t - 60_000, tokens: 1000 }] }), ok), /1000 tokens an hour/);
  assert.match(admit(use({ history: [{ t: t - 60_000, tokens: 600 }] }), { ...ok, live: 400 }), /1000 tokens an hour/, 'what its running calls used counts');
  assert.equal(admit(use({ history: [{ t: t - 2 * 3_600_000, tokens: 1000 }] }), ok), null, 'an hour later the hour\'s allowance is back');
  assert.match(admit(use({ perHour: 10_000, history: [{ t: t - 2 * 3_600_000, tokens: 5000 }] }), ok), /5000 tokens a day/);
  assert.match(admit(use(), { ...ok, calls: Array(LIMITS.callsPerMinute).fill(t - 1000) }), /calls a minute/);
  assert.match(admit(use(), { ...ok, promptChars: LIMITS.promptChars + 1 }), /a prompt is at most/);
  assert.match(admit(use(), { ...ok, running: LIMITS.running }), /at once/);
  assert.match(admit(use(), { ...ok, account: 97 }), /account's limit is 97% used/);
  assert.equal(usedSince([{ t: 0, tokens: 5 }, { t: 90, tokens: 7 }], 100, 50), 7);
  assert.equal(accountUsed([{ state: { snapshots: { '': { primary: { usedPercent: 40 }, secondary: { usedPercent: 80 } } } } }]), 80);
  assert.equal(accountUsed([{ state: { snapshots: { codex: { rateLimitReachedType: 'primary' } } } }]), 100);
});

test('a managed thread: ephemeral, approvals off, Codex\'s own tools and the user\'s setup off, the mod\'s tools in one namespace', () => {
  const p = threadParams({ cwd: '/d/threads/1', model: 'gpt-6-luna', instructions: 'Be brief.', tools: [{ name: 'note', description: 'Keep a note', inputSchema: { type: 'object' } }], allowed: [] });
  assert.deepEqual([p.ephemeral, p.approvalPolicy, p.sandbox, p.cwd, p.model], [true, 'never', 'read-only', '/d/threads/1', 'gpt-6-luna']);
  assert.match(p.developerInstructions, /Be brief\.$/);
  assert.match(p.baseInstructions, /not a coding agent/, 'Codex\'s coding agent\'s base instructions replaced');
  assert.deepEqual(p.dynamicTools.map((n) => [n.name, n.tools.map((x) => x.name)]), [[NAMESPACE, ['note']]]);
  assert.equal(p.config['features.shell_tool'], false);
  assert.equal(p.config.web_search, 'disabled');
  assert.equal(threadParams({ cwd: '/x', model: 'm', tools: [], allowed: ['web'] }).config.web_search, 'live', 'the web only when the user allows it');
  assert.equal(threadParams({ cwd: '/x', model: 'm', tools: [], allowed: [] }).dynamicTools, undefined);
  // the user's tool servers, each off for the thread unless the user allowed this mod tool servers
  const off = threadParams({ cwd: '/x', model: 'm', tools: [], allowed: [], servers: ['node_repl', 'docs'] }).config;
  assert.deepEqual([off['mcp_servers.node_repl.enabled'], off['mcp_servers.docs.enabled']], [false, false]);
  assert.equal(threadParams({ cwd: '/x', model: 'm', tools: [], allowed: ['toolServers'], servers: ['docs'] }).config['mcp_servers.docs.enabled'], undefined);
});

/** A mod that writes with model use: its `draft` asks with its storage and a tool of its own, streaming the text. */
function writerMod(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ id: WRITER, version: '1.0.0', name: 'Writer', framework: '>=1 <2', entry: { host: 'host.mjs' },
    intelligence: { why: 'It drafts notes', tools: ['web'] }, permissions: [] }));
  fs.writeFileSync(path.join(dir, 'host.mjs'), `
export default { host(ctx) {
  const streamed = [];
  const notes = [];
  ctx.services.provide('writer', {
    async draft({ prompt }) {
      try {
        const out = await ctx.intelligence.ask({ prompt, storage: true, onText: (d) => streamed.push(d),
          tools: { note: { description: 'Keep a note', input: { type: 'object', properties: { text: { type: 'string' } } }, run: ({ text }) => { notes.push(text); return 'noted'; } } } });
        return { ok: true, out, streamed, notes };
      } catch (e) { return { ok: false, message: String(e.message) }; }
    },
    status: () => ctx.intelligence.status(),
    async kept() { return (await ctx.storage.get('topic')) ?? null; },
  });
} };`);
  return dir;
}

test('a mod\'s call end to end: refused while off; on, a private thread with its own storage and tools, streamed, its tokens counted', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await h.up();
  const g = await createTestGraph({ mux: h.mux });
  t.after(() => g.close());
  g.graph.registerTypes(FRAMEWORK_TYPES.map(toDescriptor), 'framework');
  const fw = g.provider('codexmods.framework', { Mod: {} }, { owner: 'framework' });
  const writerRef = { type: 'Mod', provider: 'codexmods.framework', id: WRITER };
  await fw.put(writerRef, modData({ id: WRITER, name: 'Writer', version: '1.0.0', status: 'enabled', manifest: { intelligence: { why: 'It drafts notes', tools: ['web'] } }, grants: [] }, null));
  await g.mod(here, { internal: true });
  const writer = await g.mod(writerMod(t));
  const useRef = { type: 'ModelUse', provider: 'codexmods.intelligence', id: WRITER };
  const u0 = await g.waitFor(() => g.graph.resolve(useRef), { what: 'its ModelUse' });
  assert.deepEqual([u0.state.enabled, u0.state.why, u0.state.wants, u0.state.tools, u0.state.model], [false, 'It drafts notes', ['web'], [], 'gpt-6-luna']);

  // off until the user turns it on; a mod cannot turn it on
  const refused = await writer.call('writer', 'draft', { prompt: 'a note' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /model use is off/);
  assert.equal((await g.invoke(useRef, 'setEnabled', [true], { as: { kind: 'mod', id: WRITER, owner: `mod:${WRITER}` } })).status, 'refused');
  assert.equal((await g.invoke(useRef, 'setEnabled', [true])).status, 'done', 'the user turns it on');
  assert.equal((await g.invoke(useRef, 'setTools', [['files']])).status, 'refused', 'only the kinds it asks for');

  // it never runs with the user's tool servers: one it cannot turn off makes the call refuse
  const ctl = h.mux.client('test:control');
  await ctl.request('fake/config', { config: { mcp_servers: { 'odd.name': { command: 'x' } } } });
  const closed = await writer.call('writer', 'draft', { prompt: 'a note' });
  assert.equal(closed.ok, false);
  assert.match(closed.message, /cannot be turned off/);
  await ctl.request('fake/config', { config: { mcp_servers: { node_repl: { command: 'node_repl' }, docs: { url: 'https://example.invalid/mcp' } } } });
  // on: its call runs in a private thread (the fake names threads in order: this is the first), held so the test can play the model
  const thread = 'thr-primary-1';
  await ctl.request('fake/hold', { threadId: thread });
  const drafting = writer.call('writer', 'draft', { prompt: 'Write about tea' });
  await g.waitFor(() => (g.graph.resolve(useRef)?.state.running === 1 ? true : null), { what: 'the call running' });
  await new Promise((r) => setTimeout(r, 200));   // its turn started (held)
  ctl.request('fake/serverRequest', { method: 'item/tool/call', params: { threadId: thread, turnId: 'turn-1', callId: 'c1', namespace: NAMESPACE, tool: 'storage_set', arguments: { key: 'topic', value: 'tea' } } }).catch(() => {});
  ctl.request('fake/serverRequest', { method: 'item/tool/call', params: { threadId: thread, turnId: 'turn-1', callId: 'c2', namespace: NAMESPACE, tool: 'note', arguments: { text: 'green' } } }).catch(() => {});
  await until(async () => (await writer.call('writer', 'kept')) === 'tea', 10000, 'its storage written by the model, in its own realm');
  for (const delta of ['Tea is ', 'calm.']) await ctl.request('fake/notify', { method: 'item/agentMessage/delta', params: { threadId: thread, turnId: 'turn-1', itemId: 'i1', delta } });
  await ctl.request('fake/notify', { method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: 'turn-1', tokenUsage: { total: { totalTokens: 321, inputTokens: 300, cachedInputTokens: 0, outputTokens: 21, reasoningOutputTokens: 0 }, last: { totalTokens: 321, inputTokens: 300, cachedInputTokens: 0, outputTokens: 21, reasoningOutputTokens: 0 } } } });
  await ctl.request('fake/finishTurn', { threadId: thread });
  const done = await drafting;
  assert.equal(done.ok, true, done.message);
  const startLine = h.serverLog().map((l) => JSON.parse(l.slice(l.indexOf('{')))).find((m) => m.method === 'thread/start' && m.params?.ephemeral === true);
  assert.deepEqual([startLine.params.config['mcp_servers.node_repl.enabled'], startLine.params.config['mcp_servers.docs.enabled']], [false, false], 'its thread has the user\'s tool servers off');
  assert.deepEqual([done.out.text, done.out.usage.tokens, done.streamed.join(''), done.notes], ['Tea is calm.', 321, 'Tea is calm.', ['green']]);
  const u1 = await g.waitFor(() => (g.graph.resolve(useRef)?.state.usedTotal === 321 ? g.graph.resolve(useRef) : null), { what: 'its tokens counted' });
  // a refused call is not one; the one that failed closed on the tool servers is
  assert.deepEqual([u1.state.usedHour, u1.state.usedDay, u1.state.calls, u1.state.running], [321, 321, 2, 0]);
  const status = await writer.call('writer', 'status');
  assert.deepEqual([status.enabled, status.usedTotal], [true, 321]);

  // the app never heard of it
  assert.equal(h.app.inbox.some((m) => JSON.stringify(m).includes(thread) || JSON.stringify(m).includes('Write about tea')), false);

  // a mod that leaves the list (stopped, the Host stopping) keeps the user's decisions when it comes back
  await fw.remove(writerRef);
  await g.waitFor(() => { const r = g.graph.resolve(useRef); return !r || r.gone ? true : null; }, { what: 'its ModelUse gone with it' });
  await fw.put(writerRef, modData({ id: WRITER, name: 'Writer', version: '1.0.0', status: 'enabled', manifest: { intelligence: { why: 'It drafts notes', tools: ['web'] } }, grants: [] }, null));
  const back = await g.waitFor(() => { const r = g.graph.resolve(useRef); return r && !r.gone ? r : null; }, { what: 'its ModelUse back' });
  assert.deepEqual([back.state.enabled, back.state.usedTotal], [true, 321]);

  // the switch: off ends what runs and refuses what comes
  assert.equal((await g.invoke(useRef, 'setEnabled', [false])).status, 'done');
  assert.match((await writer.call('writer', 'draft', { prompt: 'again' })).message, /model use is off/);
});
