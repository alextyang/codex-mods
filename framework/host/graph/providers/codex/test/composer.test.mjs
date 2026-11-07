// The composer area through the source, graph, real mux and fake app-server. This test plays framework-main's reports and answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraph } from '../../../index.mjs';
import { createMainOps } from '../../../main-ops.mjs';
import { createCodexSource } from '../index.mjs';
import { refs, userInput } from '../map.mjs';
import { projectData, localEnvironmentData } from '../projects.mjs';
import { fileData } from '../files.mjs';
import { skillData, librarySkillData } from '../areas/skills.mjs';
import * as composer from '../areas/composer.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { harness, until } from '../../../../mux/test/helpers.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const user = { kind: 'user', id: 'user', owner: 'app' }, mod = { kind: 'mod', id: 'mod.a' };
const content = (text) => ({ parts: text ? [{ kind: 'text', text }] : [] });
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });
const done = (r) => { assert.equal(r.status, 'done', JSON.stringify(r)); return r.value; };
const refused = (r, reason, message) => { assert.equal(r.status, 'refused', JSON.stringify(r)); assert.equal(r.reason, reason); if (message) assert.equal(r.message, message); };
const prompts = [{ id: 'review', description: 'Review files', argumentHint: 'PATH', content: 'Review this' }, { id: 'empty', description: '' }];
/** A new chat's Draft that is not the app's own (`new:<id>`, no composer reaches it): a seed a caller hands to newThread. */
const seedDraft = (s, id, target) => { const r = refs.draft(`new:${id}`); s.source.provider.put(r, { state: { content: { parts: [] }, dictating: false, target }, links: {} }); return r; };

async function setup({ pageAct, chooseWindow, showsIn, files = true, windows = {} } = {}) {
  const h = await harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-codex-composer-'));
  const asked = [], ops = [], events = [], answers = new Map();
  const clock = { now: Date.now() }, state = { prompts };
  const graph = createGraph({ journalFile: path.join(dir, 'intents.jsonl'), log: quiet, approvals: { ask: async (q) => { asked.push({ action: q.action, detail: q.detail }); return { approved: true }; } } });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  await h.up();
  let seq = 0;
  const ask = (method, params) => h.app.request(++seq, method, params);
  const thread = (await ask('thread/start', { cwd: '/repo' })).result.thread;
  await ask('thread/name/set', { threadId: thread.id, name: 'Chat' });
  let mainOps, lastDrafts = [];
  mainOps = createMainOps({ log: quiet, send: (m) => {
    assert.equal(m.area, 'composer');
    ops.push([m.op, m.args]);
    queueMicrotask(async () => {
      try {
        const answer = answers.get(m.op);
        const result = typeof answer === 'function' ? await answer(m.args) : answer;
        // the app selects the project a new chat is shown in, and framework-main reports it (the new chat's target)
        if (m.op === 'new-chat' && m.args && m.args.projectId !== undefined && !answer) mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: lastDrafts, newChat: { project: m.args.projectId } } });
        mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ...(result ?? { ok: true, result: m.op === 'prompts' ? { prompts: state.prompts } : m.op === 'new-chat' ? { windowId: 7 } : {} }) });
      } catch (e) { mainOps.settle({ type: 'area-op-done', requestId: m.requestId, ok: false, error: e.message }); }
    });
  } });
  const reportRaw = mainOps.report.bind(mainOps);
  mainOps.report = (msg) => { if (msg?.area === 'composer' && Array.isArray(msg.report?.drafts)) lastDrafts = msg.report.drafts; return reportRaw(msg); };
  const filesDir = path.join(dir, 'draft-files');
  const source = createCodexSource({ graph, mux: h.mux, bus: h.bus, log: quiet, mainOps, areas: { composer }, now: () => clock.now, ...(pageAct ? { pageAct } : {}), ...(chooseWindow ? { chooseWindow } : {}),
    ...(showsIn ? { showsIn } : {}), ...(files ? { filesDir } : {}), ...windows });
  graph.onEvent((e) => { if (e.kind === 'event' && ['Draft', 'SlashCommand'].includes(e.ref.type)) events.push([e.ref.id, e.name]); });
  await source.start();
  await until(() => graph.resolve(refs.slashCommand('review')), 3000, 'prompts');
  const draft = refs.draft(thread.id);
  const report = (drafts) => mainOps.report({ type: 'area-report', area: 'composer', report: { drafts } });
  return {
    h, graph, source, mainOps, ops, events, asked, answers, ask, thread, draft, clock, state, report, filesDir,
    put(d) { source.provider.put(d.ref, { state: d.state, links: d.links }); return d.ref; },
    invoke: (ref, operation, args = [], caller = user) => graph.invoke({ ref, operation, args, caller }),
    async autoSubmit() {
      answers.set('submit', async ({ threadId }) => {
        await ask('fake/hold', { threadId });
        await ask('turn/start', { threadId, input: userInput(content('Sent from the app')) });
        return { ok: true, result: {} };
      });
    },
    async close() { await source.dispose(); graph.close(); mainOps.dispose(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('contentOfDoc preserves text, paragraph and hard breaks, and inline mention labels with their fallbacks', () => {
  const rich = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'hello ' }, { type: 'hard_break' }, { type: 'mention', attrs: { label: 'label', name: 'ignored' } }, { type: 'skill', attrs: { name: 'skill' } }, { type: 'mention', attrs: { path: '/repo/a' } }, { type: 'mention' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'next ' }, { type: 'richLink', attrs: { displayText: 'the spec', href: 'https://x/spec' } }, { type: 'resourceMention', attrs: { server: 's', resourceUri: 'u', title: 'Res' } }] },
  ] };
  assert.deepEqual(composer.contentOfDoc(rich), content('hello \n@label@skill@/repo/a@\nnext the spec@Res'), 'a link is its text; a chip named by a title says it');
  for (const empty of [null, {}, doc(''), { type: 'doc', content: [] }]) assert.deepEqual(composer.contentOfDoc(empty), { parts: [] });
  assert.deepEqual(composer.draftData('t', rich), { ref: refs.draft('t'), state: { content: composer.contentOfDoc(rich), dictating: false }, links: { thread: refs.thread('t'), attachments: [], mentions: [] }, mentions: [] });
  assert.deepEqual(composer.slashCommandData(prompts[0]), { ref: refs.slashCommand('review'), state: { title: '/prompts:review', category: 'Prompts', enabled: true, name: 'prompts:review', custom: true, arguments: 'PATH', prompt: content('Review this') }, links: {} });
  assert.deepEqual(composer.slashCommandData(prompts[1]), { ref: refs.slashCommand('empty'), state: { title: '/prompts:empty', category: 'Prompts', enabled: true, name: 'prompts:empty', custom: true }, links: {} });
});

test('every chat in the graph has a Draft, empty until the app saves one, so operations find it', async () => {
  const s = await setup();
  try {
    await until(() => s.graph.resolve(s.draft), 3000, 'the chat\'s draft');
    assert.deepEqual(s.graph.resolve(s.draft).state, { content: { parts: [] }, dictating: false });
    const next = (await s.ask('thread/start', { cwd: '/repo' })).result.thread;
    await until(() => s.graph.resolve(refs.draft(next.id)), 3000, 'a new chat\'s draft');
    assert.equal((await s.invoke(refs.draft(next.id), 'clear')).status, 'done', 'an operation on it runs');
    assert.deepEqual(s.events, [], 'no events for empty drafts');
  } finally { await s.close(); }
});

test('a draft reported before its thread is in the graph is put, without an event, once a thread read puts the thread', async () => {
  const s = await setup();
  try {
    const later = (await s.ask('thread/start', { cwd: '/repo' })).result.thread;
    await until(() => s.graph.resolve(refs.thread(later.id)), 3000, 'the second thread');
    await s.ask('fake/notify', { method: 'thread/deleted', params: { threadId: later.id } });
    await until(() => s.graph.resolve(refs.thread(later.id))?.gone, 3000, 'out of the graph');
    s.report([{ threadId: later.id, doc: doc('Early') }]);
    assert.equal(s.graph.resolve(refs.draft(later.id))?.gone ?? true, true, 'not put while its thread is not there');
    await s.ask('thread/read', { threadId: later.id });
    await until(() => s.graph.resolve(refs.draft(later.id))?.state?.content?.parts?.length, 3000, 'the early draft');
    assert.deepEqual(s.graph.resolve(refs.draft(later.id)).state.content, content('Early'));
    assert.deepEqual(s.events, [], 'a sync');
  } finally { await s.close(); }
});

test('saved drafts sync without events, change, clear or send; dropped entries become empty and gone threads lose their draft', async () => {
  const s = await setup();
  try {
    s.report([{ threadId: s.thread.id, doc: doc('Saved') }]);
    assert.deepEqual(s.graph.resolve(s.draft).state, { content: content('Saved'), dictating: false });
    assert.deepEqual(s.graph.resolve(s.draft).links, { thread: refs.thread(s.thread.id), attachments: [], mentions: [] });
    assert.deepEqual(s.graph.resolve(refs.thread(s.thread.id)).links.draft, s.draft);
    assert.deepEqual(s.events, []);
    s.report([{ threadId: s.thread.id, doc: doc('Edited') }]);
    s.report([{ threadId: s.thread.id, doc: doc('Edited') }]);
    s.report([]);
    assert.deepEqual(s.graph.resolve(s.draft).state.content, { parts: [] });
    assert.deepEqual(s.events.map(([, e]) => e), ['changed', 'cleared']);
    s.report([{ threadId: s.thread.id, doc: doc('Send this') }]);
    await s.ask('fake/hold', { threadId: s.thread.id });
    await s.ask('turn/start', { threadId: s.thread.id, input: userInput(content('Send this')) });
    await until(() => s.graph.list('Turn').some((t) => t.state.status === 'running'), 3000, 'the held turn');
    s.report([]);
    assert.equal(s.events.at(-1)[1], 'sent');
    s.report([{ threadId: s.thread.id, doc: doc('Later') }]);
    s.clock.now += 3001;
    s.report([{ threadId: s.thread.id, doc: doc('') }]);
    assert.equal(s.events.at(-1)[1], 'cleared', 'a turn older than 3 s is not a send');
    await s.ask('fake/notify', { method: 'thread/deleted', params: { threadId: s.thread.id } });
    await until(() => s.graph.resolve(refs.thread(s.thread.id))?.gone, 3000, 'the thread goes');
    s.report([]);
    assert.equal(s.graph.resolve(s.draft).gone, true);
  } finally { await s.close(); }
});

test('observing a resident thread draft creates an empty one; a new chat\'s draft that is not the app\'s is left as it is', async () => {
  const s = await setup();
  try {
    const seen = [];
    const sub = s.graph.subscribe({ ref: s.draft }, (m) => seen.push(m));
    await until(() => s.graph.resolve(s.draft), 3000, 'the observed draft');
    assert.deepEqual(s.graph.resolve(s.draft).state.content, { parts: [] });
    assert.deepEqual(s.events, []);
    sub.dispose();
    s.report([{ threadId: s.thread.id, doc: doc('Saved') }]);
    assert.deepEqual(s.events, [], 'the first report remains a sync even after observation');
    s.report([]);
    assert.equal(s.graph.resolve(s.draft).state.content.parts.length, 0);
    const other = seedDraft(s, 'home', { settings: {} });
    s.graph.subscribe({ ref: other }, () => {});
    s.graph.subscribe({ ref: refs.draft('missing') }, () => {});
    s.report([]);
    assert.equal(s.graph.resolve(refs.draft('missing')), null);
    assert.deepEqual(s.graph.resolve(other).links, {});
    assert.ok(seen.length);
  } finally { await s.close(); }
});

test('draft editing, attaching, File.attachTo and Skill.use dispatch the composer operations without approval', async () => {
  const s = await setup();
  try {
    s.report([{ threadId: s.thread.id, doc: doc('Saved') }]);
    const file = s.put(fileData('/repo/a.mjs', 'p', { kind: 'text' }));
    const skill = s.put(skillData({ path: '/skills/review/SKILL.md', name: 'review', scope: 'user', enabled: true }));
    const rich = { parts: [{ kind: 'text', text: 'Review ' }, { kind: 'mention', label: 'review', target: skill }] };
    for (const [op, args] of [['setContent', [rich]], ['setContent', [content('')]], ['insert', [rich]], ['attach', [file]], ['attach', [refs.folder('/repo/src')]], ['clear', []]]) done(await s.invoke(s.draft, op, args, mod));
    done(await s.invoke(file, 'attachTo', [s.draft], mod));
    done(await s.invoke(skill, 'use', [s.draft], mod));
    assert.deepEqual(s.ops.slice(1), [
      ['set-text', { threadId: s.thread.id, text: 'Review @review', skills: [{ name: 'review', path: skill.id }] }],
      ['set-text', { threadId: s.thread.id, text: '', skills: [] }],
      ['insert', { threadId: s.thread.id, text: 'Review @review', skills: [{ name: 'review', path: skill.id }] }],
      ['attach', { threadId: s.thread.id, path: file.id }], ['attach', { threadId: s.thread.id, path: '/repo/src' }], ['clear', { threadId: s.thread.id }],
      ['attach', { threadId: s.thread.id, path: file.id }], ['insert', { threadId: s.thread.id, text: '', skills: [{ name: 'review', path: skill.id }] }],
    ]);
    assert.deepEqual(s.asked, []);
    assert.deepEqual(s.graph.resolve(s.draft).state.content, content('Saved'), 'draft changes come from the app report');
  } finally { await s.close(); }
});

test('send waits for a new turn from the app after submit and returns its ref; a previous turn cannot satisfy its timeout', async () => {
  const s = await setup();
  try {
    s.report([{ threadId: s.thread.id, doc: doc('Ready') }]);
    await s.ask('fake/hold', { threadId: s.thread.id });
    const sending = s.invoke(s.draft, 'send');
    await until(() => s.ops.some(([op]) => op === 'submit'), 3000, 'submit');
    const turn = (await s.ask('turn/start', { threadId: s.thread.id, input: userInput(content('Ready')) })).result.turn;
    assert.deepEqual(done(await sending), refs.turn(turn.id));
    assert.deepEqual(s.ops.at(-1), ['submit', { threadId: s.thread.id }]);
    const start = Date.now();
    const timedOut = await s.invoke(s.draft, 'send');
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.error.message, "the app did not send it: no turn started (the chat must be open with its composer ready)");
    assert.ok(Date.now() - start >= 7900);
    assert.equal(s.ops.filter(([op]) => op === 'submit').length, 2, 'an uncertain send is never replayed');
  } finally { await s.close(); }
});

test('Project.newThread opens an empty composer or sends a draft; Agent.newThread uses the draft target project', async () => {
  const s = await setup();
  try {
    const project = s.put(projectData({ id: 'p', name: 'Repo', roots: ['/repo'] }));
    done(await s.invoke(project, 'newThread'));
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: 'p' }]);
    const seed = seedDraft(s, 'seed', { project, settings: {} });
    s.source.provider.update(seed, { state: { content: content('Start work') } });
    let started;
    // the app's chat says its first message (the fallback without a client id takes only that as the send's)
    s.answers.set('submit-new', async () => { await s.ask('fake/next-preview', { text: 'Start work' }); started = (await s.ask('thread/start', { cwd: '/repo' })).result.thread; return { ok: true, result: {} }; });
    assert.deepEqual(done(await s.invoke(project, 'newThread', [seed])), refs.thread(started.id));
    assert.deepEqual(s.ops.slice(-2), [['new-chat', { projectId: 'p', text: 'Start work' }], ['submit-new', {}]]);
    assert.deepEqual(done(await s.invoke(refs.agent(), 'newThread', [seed])), refs.thread(started.id));
    assert.deepEqual(s.ops.slice(-2), [['new-chat', { projectId: 'p', text: 'Start work' }], ['submit-new', {}]]);
    s.source.provider.update(seed, { state: { target: { settings: {} } } });
    done(await s.invoke(refs.agent(), 'newThread', [seed]));
    assert.deepEqual(s.ops.slice(-2), [['new-chat', { text: 'Start work' }], ['submit-new', {}]]);
    s.source.provider.update(seed, { state: { content: content('') } });
    done(await s.invoke(project, 'newThread', [seed]));
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: 'p' }]);
    const at = s.ops.length;
    refused(await s.invoke(refs.agent(), 'newThread', [seed]), 'invalid');
    refused(await s.invoke(project, 'newThread', [refs.draft('missing')]), 'invalid');
    assert.equal(s.ops.length, at);
    assert.deepEqual(s.asked, [], 'user callers do not ask');
  } finally { await s.close(); }
});

test('custom prompts are SlashCommands; run inserts and submits through the app, then emits ran', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.graph.list('SlashCommand').map((x) => x.ref.id).sort(), ['prompts:empty', 'prompts:review']);
    s.report([]);
    await s.autoSubmit();
    done(await s.invoke(refs.slashCommand('review'), 'run', [{ thread: refs.thread(s.thread.id), arguments: 'src' }]));
    assert.deepEqual(s.ops.slice(-2), [['insert', { threadId: s.thread.id, text: '/prompts:review src' }], ['submit', { threadId: s.thread.id }]]);
    assert.deepEqual(s.events, [['prompts:review', 'ran']]);
    done(await s.invoke(refs.slashCommand('empty'), 'run', [{ thread: refs.thread(s.thread.id) }]));
    assert.deepEqual(s.ops.at(-2), ['insert', { threadId: s.thread.id, text: '/prompts:empty' }]);
  } finally { await s.close(); }
});

test('prompt observation shares a running read, respects 30 s freshness, removes gone commands and refreshes every 2 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = await setup();
  try {
    const observe = (ref) => s.graph.subscribe({ ref }, () => {});
    observe(refs.slashCommand('review')).dispose();
    assert.equal(s.ops.filter(([op]) => op === 'prompts').length, 1);
    s.clock.now += 30_000;
    let release;
    s.answers.set('prompts', () => new Promise((resolve) => { release = resolve; }));
    const one = observe(refs.slashCommand('review')), two = observe(refs.slashCommand('empty'));
    await until(() => release, 3000, 'the shared read');
    assert.equal(s.ops.filter(([op]) => op === 'prompts').length, 2);
    release({ ok: true, result: { prompts: [prompts[0]] } });
    await until(() => s.graph.resolve(refs.slashCommand('empty'))?.gone, 3000, 'gone prompt');
    one.dispose(); two.dispose();
    s.answers.delete('prompts');
    s.state.prompts = [prompts[1]];
    s.clock.now += 120_000;
    t.mock.timers.tick(120_000);
    await until(() => s.graph.resolve(refs.slashCommand('review'))?.gone, 3000, 'refreshed prompts');
    assert.ok(!s.graph.resolve(refs.slashCommand('empty')).gone);
    // The areas start once: another source start reads nothing and installs no second refresh interval.
    await s.source.start();
    assert.equal(s.ops.filter(([op]) => op === 'prompts').length, 3);
  } finally { await s.close(); }
});

test('refusals do not dispatch or ask: drafts no composer reaches, non-files, missing skills, nonempty command composers and invalid run arguments', async () => {
  const s = await setup();
  try {
    s.report([{ threadId: s.thread.id, doc: doc('Existing text') }]);
    const other = seedDraft(s, 'home', { settings: {} });
    const library = s.put(librarySkillData({ id: 'review', name: 'review' }));
    const at = s.ops.length;
    for (const [op, args] of [['setContent', [content('x')]], ['insert', [content('x')]], ['attach', [refs.file('/repo/a')]], ['clear', []], ['send', []]]) refused(await s.invoke(other, op, args, mod), 'unsupported', "this new chat's draft is not reachable here");
    refused(await s.invoke(s.draft, 'insert', [content('')], mod), 'invalid');
    refused(await s.invoke(s.draft, 'attach', [{ kind: 'image', source: '/a.png' }], mod), 'invalid', 'attach takes a File or Folder, a Skill, {text, name?}, {image, name?} or {url, title?}');
    refused(await s.invoke(s.draft, 'attach', [{ ...refs.file('/repo/a'), provider: 'other' }], mod), 'invalid', 'attach takes a File or Folder, a Skill, {text, name?}, {image, name?} or {url, title?}');
    refused(await s.invoke(library, 'use', [s.draft], mod), 'unsupported');
    refused(await s.invoke(library, 'use', [other], mod), 'unsupported', "this new chat's draft is not reachable here");
    refused(await s.invoke(refs.slashCommand('review'), 'run', [{ thread: refs.thread(s.thread.id) }], mod), 'unavailable', "the chat's composer has text: Codex would send it too");
    for (const arg of [undefined, {}, { thread: refs.thread('missing') }, { thread: { ...refs.thread(s.thread.id), provider: 'other' } }, { thread: refs.thread(s.thread.id), arguments: 3 }]) refused(await s.invoke(refs.slashCommand('review'), 'run', arg === undefined ? [] : [arg], mod), 'invalid');
    assert.equal(s.ops.length, at);
    assert.deepEqual(s.asked, []);
  } finally { await s.close(); }
});

test('R17 asks for sends, new chats with drafts and slash commands only for a mod; down-server calls refuse without approval', async () => {
  const s = await setup();
  try {
    s.report([{ threadId: s.thread.id, doc: doc('Send it') }]);
    await s.autoSubmit();
    done(await s.invoke(s.draft, 'send', [], mod));
    const project = s.put(projectData({ id: 'p', name: 'Repo', roots: ['/repo'] }));
    const seed = seedDraft(s, 'seed', { project, settings: {} });
    const text = 'a'.repeat(70);
    s.source.provider.update(seed, { state: { content: content(text) } });
    s.answers.set('submit-new', async () => { await s.ask('fake/next-preview', { text }); await s.ask('thread/start', { cwd: '/repo' }); return { ok: true, result: {} }; });
    done(await s.invoke(project, 'newThread', [seed], mod));
    done(await s.invoke(refs.agent(), 'newThread', [seed], mod));
    done(await s.invoke(project, 'newThread', [], mod));
    s.report([]);
    done(await s.invoke(refs.slashCommand('review'), 'run', [{ thread: refs.thread(s.thread.id) }], mod));
    const detail = "Codex works on it with the chat's permissions, and it counts toward your usage.";
    assert.deepEqual(s.asked, [
      { action: 'send the draft in “Chat”', detail }, { action: `start a chat with “${text.slice(0, 60)}”`, detail }, { action: `start a chat with “${text.slice(0, 60)}”`, detail }, { action: 'run “/prompts:review” in “Chat”', detail },
    ]);
    const count = s.asked.length;
    done(await s.invoke(s.draft, 'send'));
    done(await s.invoke(project, 'newThread', [seed]));
    done(await s.invoke(refs.agent(), 'newThread', [seed]));
    done(await s.invoke(refs.slashCommand('review'), 'run', [{ thread: refs.thread(s.thread.id) }]));
    assert.equal(s.asked.length, count);
    s.h.bus.publish('appServer/exited', { backend: 'primary', reason: 'test' });
    const at = s.ops.length;
    for (const [ref, op, args] of [[s.draft, 'send', []], [project, 'newThread', [seed]], [refs.agent(), 'newThread', [seed]], [refs.slashCommand('review'), 'run', [{ thread: refs.thread(s.thread.id) }]]]) refused(await s.invoke(ref, op, args, mod), 'unavailable');
    assert.equal(s.ops.length, at);
    assert.equal(s.asked.length, count);
    done(await s.invoke(s.draft, 'clear', [], mod));
    done(await s.invoke(project, 'newThread', [], mod));
  } finally { await s.close(); }
});

test('framework-main refusals are unavailable; attempted failures throw and submission is never retried', async () => {
  const s = await setup();
  try {
    s.report([{ threadId: s.thread.id, doc: doc('Ready') }]);
    for (const [op, operation, args] of [['set-text', 'setContent', [content('x')]], ['insert', 'insert', [content('x')]], ['attach', 'attach', [refs.file('/repo/a')]], ['clear', 'clear', []], ['submit', 'send', []]]) {
      s.answers.set(op, { ok: false, refused: true, error: 'no composer' });
      refused(await s.invoke(s.draft, operation, args), 'unavailable', 'no composer');
      s.answers.set(op, { ok: false, refused: false, error: 'dispatch failed' });
      const result = await s.invoke(s.draft, operation, args);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.message, 'dispatch failed');
      s.answers.delete(op);
    }
    const project = s.put(projectData({ id: 'p', name: 'Repo', roots: ['/repo'] }));
    s.answers.set('new-chat', { ok: false, refused: true, error: 'no window' });
    refused(await s.invoke(project, 'newThread'), 'unavailable', 'no window');
    assert.equal(s.ops.filter(([op]) => op === 'submit-new').length, 0);
  } finally { await s.close(); }
});

test('E8.3: the new chat\'s draft is always there, with its target\'s project; its operations reach the main window\'s new chat; send starts a chat; setTarget picks the project or none', async () => {
  const s = await setup();
  try {
    const NEW = refs.draft('new:app:new-conversation');
    const reportNew = (drafts, project) => s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts, newChat: { project } } });
    s.put(projectData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    reportNew([], 'p1');
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    let d = s.graph.resolve(NEW);
    assert.deepEqual(d.state.content, { parts: [] });
    assert.deepEqual(d.state.target.project, refs.project('p1'));
    assert.deepEqual(d.state.target.agent, { type: 'CodexAgent', provider: 'codex', id: 'codex' });
    assert.equal(d.links.thread, null, 'no thread yet');
    reportNew([{ threadId: 'new:app:new-conversation', doc: doc('Plan the release') }], null);
    await until(() => s.graph.resolve(NEW)?.state.content.parts.length, 2000, 'its text');
    d = s.graph.resolve(NEW);
    assert.equal(d.state.target.project, undefined, 'no project: a project-less new chat');
    // its operations reach framework-main with its id (the main window's new chat)
    for (const [op, args] of [['setContent', [content('x')]], ['insert', [content('y')]], ['clear', []]]) assert.equal((await s.invoke(NEW, op, args, mod)).status, 'done');
    assert.deepEqual(s.ops.slice(-3).map(([op, a]) => [op, a.threadId]), [['set-text', 'new:app:new-conversation'], ['insert', 'new:app:new-conversation'], ['clear', 'new:app:new-conversation']]);
    // setTarget: a project (the new chat opens in it), none refused (chosen in the picker), a chat's draft has no target to set
    const picked = await s.invoke(NEW, 'setTarget', [{ project: refs.project('p1') }], mod);
    assert.equal(picked.status, 'done', JSON.stringify(picked));
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: 'p1' }]);
    assert.equal((await s.invoke(NEW, 'setTarget', [{ project: null }], mod)).status, 'done', 'no project: a project-less chat');
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: null }]);
    assert.equal((await s.invoke(NEW, 'setTarget', [{ project: refs.project('nope') }], mod)).reason, 'invalid');
    assert.equal((await s.invoke(s.draft, 'setTarget', [{ project: refs.project('p1') }], mod)).reason, 'unsupported');
    assert.match((await s.invoke(NEW, 'setTarget', [{ settings: { sandbox: 'none' } }], mod)).message ?? '', /sandbox setting cannot be set here yet/);
    // where it runs (E8.3b): a project's LocalEnvironment (locally, in that project), a CloudEnvironment; a worktree's is its open()
    const localEnv = { type: 'LocalEnvironment', provider: 'codex', id: 'local:p1' };
    const cloudEnv = { type: 'CloudEnvironment', provider: 'codex', id: 'cloud-1' };
    s.put({ ref: localEnv, state: { name: 'Local', status: 'ready' }, links: { project: refs.project('p1'), folder: { type: 'Folder', provider: 'codex', id: '/repo' } } });
    s.put({ ref: cloudEnv, state: { name: 'Cloud', status: 'ready' }, links: { project: null } });
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: localEnv }], mod)).status, 'done');
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: 'p1', mode: 'local', windowId: 7 }]);
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: cloudEnv }], mod)).status, 'done');
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: null, mode: 'cloud', windowId: 7 }]);
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: { type: 'WorktreeEnvironment', provider: 'codex', id: '/w' } }], mod)).reason, 'unsupported');
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: { type: 'LocalEnvironment', provider: 'codex', id: 'local:nope' } }], mod)).reason, 'invalid');
    // E8.3g: a new worktree of its project ('worktree', the app makes it when the chat is sent); a project-less chat has none
    assert.equal((await s.invoke(NEW, 'setTarget', [{ project: refs.project('p1'), environment: 'worktree' }], mod)).status, 'done');
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: 'p1', mode: 'worktree', windowId: 7 }]);
    reportNew([{ threadId: 'new:app:new-conversation', doc: doc('Plan the release') }], null);   // the user chose no project
    await new Promise((r) => setImmediate(r));
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: 'worktree' }], mod)).reason, 'invalid', 'the new chat has no project');
    assert.equal((await s.invoke(NEW, 'setTarget', [{ project: null, environment: 'worktree' }], mod)).reason, 'invalid');
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: 'container' }], mod)).reason, 'unsupported');
    s.put({ ref: refs.branch('p1', 'main'), state: { name: 'main', current: true }, links: { repository: refs.repository('p1') } });
    assert.match((await s.invoke(NEW, 'setTarget', [{ environment: localEnv, branch: refs.branch('p1', 'main') }], mod)).message, /switchBranch/, 'a local chat starts on the checked-out branch');
    // review 4: a cloud chat's branch is one its environment serves; a project-less chat's branch needs its project or environment
    assert.match((await s.invoke(NEW, 'setTarget', [{ environment: cloudEnv, branch: refs.branch('p1', 'main') }], mod)).message, /does not serve/);
    assert.match((await s.invoke(NEW, 'setTarget', [{ branch: refs.branch('p1', 'main') }], mod)).message, /needs that project/);
    // send: asks the user what it starts, then the app's own submit in the new chat; its result is the new Thread
    // a sub-agent's chat or another chat (its first message another text) started meanwhile is not the one this send starts
    let mine;
    s.answers.set('submit', async ({ threadId }) => {
      assert.equal(threadId, 'new:app:new-conversation');
      await s.ask('fake/notify', { method: 'thread/started', params: { thread: { id: 'sub-1', parentThreadId: 'x', preview: 'Plan the release' } } });
      await s.ask('fake/notify', { method: 'thread/started', params: { thread: { id: 'other-1', preview: 'Nightly automation run' } } });
      await s.ask('fake/next-preview', { text: 'Plan the release' });
      mine = (await s.ask('thread/start', { cwd: '/repo' })).result.thread;
      return { ok: true, result: {} };
    });
    const sent = await s.invoke(NEW, 'send', [], mod);
    assert.equal(sent.status, 'done');
    assert.equal(sent.value.type, 'CodexThread');
    assert.equal(sent.value.id, mine.id);
    assert.match(s.asked.at(-1).action, /^start a chat with “Plan the release”$/);
  } finally { await s.close(); }
});

test('E8 review 3: the panel\'s new chat is written live while its composer is shown; else, and for files and send, refused', async () => {
  const acted = [];
  let shown = true;
  const s = await setup({ pageAct: async (type, subject, op, args) => { acted.push([type, subject.id, op, args]); return shown ? { status: 'done', value: null } : null; } });
  try {
    const PANEL = refs.draft('new:app:panel-new-conversation');
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:panel-new-conversation', doc: doc('') }], newChat: { project: null } } });
    await until(() => s.graph.resolve(PANEL), 2000, 'the panel\'s draft');
    const before = s.ops.length;
    for (const [op, args] of [['setContent', [content('In the panel')]], ['insert', [content(' more')]], ['clear', []]]) assert.equal((await s.invoke(PANEL, op, args, mod)).status, 'done', op);
    assert.deepEqual(acted.map(([t, id, op]) => [t, id, op]), [['Composer', 'new:app:panel-new-conversation', 'setText'], ['Composer', 'new:app:panel-new-conversation', 'insert'], ['Composer', 'new:app:panel-new-conversation', 'clear']]);
    assert.equal(s.ops.length, before, 'nothing through framework-main');
    shown = false;
    const away = await s.invoke(PANEL, 'setContent', [content('x')], mod);
    assert.deepEqual([away.status, away.reason], ['refused', 'unavailable']);
    assert.equal((await s.invoke(PANEL, 'send', [], mod)).reason, 'unsupported');
    assert.equal((await s.invoke(PANEL, 'attach', [{ type: 'File', provider: 'codex', id: '/x/a.txt' }], mod)).reason, 'unsupported');
  } finally { await s.close(); }
});

test('H8d round 1: the latest window\'s report wins (its tray, removal in it); a composer\'s own refusal of an image is the answer', async () => {
  const acted = [];
  let imageAnswer = { status: 'refused', reason: 'unavailable', message: 'a queued message is being edited in this composer' };
  const s = await setup({ chooseWindow: async () => ({ windowId: 1, shows: true }), pageAct: async (type, subject, op, args, windowId) => {
    acted.push([op, args, windowId]);
    return op === 'attachImage' ? imageAnswer : { status: 'done', windowId, value: null };
  } });
  try {
    const at = (item) => ({ type: 'Attachment', provider: 'codex', id: `draft:${s.thread.id}:${item}` });
    const report = (windowId, items) => s.h.bus.publish('window/attachments', { windowId, drafts: { [s.thread.id]: items } });
    report(1, [{ id: 'image:one', kind: 'image', name: 'one.png' }]);
    report(2, [{ id: 'image:two', kind: 'image', name: 'two.png' }]);
    report(1, [{ id: 'image:one', kind: 'image', name: 'one.png' }]);
    await until(() => s.graph.resolve(at('image:one')) && (s.graph.resolve(at('image:two'))?.gone ?? true), 2000, 'window 1, reported last');
    assert.equal((await s.invoke(at('image:one'), 'remove', [], mod)).status, 'done');
    assert.deepEqual(acted.at(-1), ['removeAttachment', ['image:one'], 1]);
    // the composer said why it takes no image: refused, and no file of the framework's is attached in its stead
    const before = s.ops.length;
    const out = await s.invoke(s.draft, 'attach', [{ image: 'data:image/png;base64,iVBORw0KGgo=', name: 'qa.png' }], mod);
    assert.deepEqual([out.status, out.reason, out.message], ['refused', 'unavailable', 'a queued message is being edited in this composer']);
    assert.equal(s.ops.length, before);
    // no composer can paste there ("cannot ... now"): the framework's file, as before
    imageAnswer = { status: 'refused', reason: 'unavailable', message: 'this Composer cannot attachImage now' };
    await s.invoke(s.draft, 'attach', [{ image: 'data:image/png;base64,iVBORw0KGgo=', name: 'qa.png' }], mod);
    assert.equal(acted.at(-1)[0], 'attachFile');
  } finally { await s.close(); }
});

test('H8d: a draft\'s attachments are its composers\' trays\' (the latest window); removed by the composer; an image goes in as its paste where it is shown', async () => {
  const acted = [];
  const s = await setup({ chooseWindow: async () => ({ windowId: 7, shows: true }), pageAct: async (type, subject, op, args, windowId) => { acted.push([type, subject.id, op, args, windowId]); return { status: 'done', windowId: 7, value: null }; } });
  try {
    const at = (item) => ({ type: 'Attachment', provider: 'codex', id: `draft:${s.thread.id}:${item}` });
    s.h.bus.publish('window/attachments', { windowId: 7, drafts: { [s.thread.id]: [{ id: 'image:a', kind: 'image', name: 'shot.png', path: '/tmp/shot.png' }, { id: 'picked:path:/r/notes.md', kind: 'file', name: 'notes.md', path: '/r/notes.md' }] } });
    await until(() => s.graph.resolve(at('image:a')), 2000, 'the attachments');
    assert.deepEqual([s.graph.resolve(at('image:a')).state, s.graph.resolve(at('image:a')).links], [{ name: 'shot.png', kind: 'image' }, { draft: s.draft, file: refs.file('/tmp/shot.png') }]);
    assert.deepEqual(s.graph.related(s.draft, 'attachments').map((x) => x.ref.id), [at('image:a').id, at('picked:path:/r/notes.md').id]);
    assert.equal((await s.invoke(at('picked:path:/r/notes.md'), 'remove', [], mod)).status, 'done');
    assert.deepEqual(acted.at(-1), ['Composer', s.thread.id, 'removeAttachment', ['picked:path:/r/notes.md'], 7]);
    // the tray changes: one goes; the window's page goes: all go
    s.h.bus.publish('window/attachments', { windowId: 7, drafts: { [s.thread.id]: [{ id: 'image:a', kind: 'image', name: 'shot.png' }] } });
    await until(() => s.graph.resolve(at('picked:path:/r/notes.md'))?.gone ?? true, 2000, 'one gone');
    assert.deepEqual(s.graph.related(s.draft, 'attachments').map((x) => x.ref.id), [at('image:a').id]);
    s.h.bus.publish('window/attachments', { windowId: 7, drafts: {} });
    await until(() => s.graph.related(s.draft, 'attachments').length === 0, 2000, 'all gone');
    assert.equal((await s.invoke(at('image:a'), 'remove', [], mod)).reason, 'unavailable', 'gone with its tray');
    // an image where the composer shows the Draft: the composer's own paste, nothing through framework-main
    const before = s.ops.length;
    assert.equal((await s.invoke(s.draft, 'attach', [{ image: 'data:image/png;base64,iVBORw0KGgo=', name: 'qa.png' }], mod)).status, 'done');
    assert.deepEqual(acted.at(-1).slice(2, 5), ['attachImage', ['data:image/png;base64,iVBORw0KGgo=', 'qa.png'], 7]);
    assert.equal(s.ops.length, before);
  } finally { await s.close(); }
});

test('E8.3c: the new chat\'s model and effort go through its own model menu, the home page shown first when no window shows it', async () => {
  const acted = [];
  let shownAfter = 0, answer = { status: 'done', value: null };
  const s = await setup({ pageAct: async (type, subject, op, args, windowId) => { acted.push([type, subject.id, op, args, windowId]); if (shownAfter > 0) { shownAfter--; return null; } return answer; } });
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [], newChat: { project: null } } });
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    const gpt = { type: 'Model', provider: 'codex', id: 'gpt-x' };
    s.put({ ref: gpt, state: { name: 'GPT X', description: '', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], default: false, available: true }, links: { agent: { type: 'CodexAgent', provider: 'codex', id: 'codex' } } });
    const set = (target) => s.invoke(NEW, 'setTarget', [target], mod);
    assert.equal((await set({ model: gpt, settings: { effort: 'high' } })).status, 'done');
    assert.deepEqual(acted.at(-1), ['ComposerPicker', 'new:app:new-conversation:model', 'choose', ['gpt-x', 'high'], null], 'the menu\'s own choice (where it is shown)');
    assert.equal((await set({ settings: { effort: 'low' } })).status, 'done');
    assert.deepEqual(acted.at(-1).slice(2, 4), ['choose', [null, 'low']], 'an effort alone: the chosen model\'s');
    // checked before the page: an effort the model does not take, a model the graph does not have, another provider's
    const asked = acted.length;
    assert.equal((await set({ model: gpt, settings: { effort: 'max' } })).reason, 'invalid');
    assert.equal((await set({ model: { type: 'Model', provider: 'codex', id: 'nope' } })).reason, 'invalid');
    assert.equal((await set({ model: { type: 'Model', provider: 'other', id: 'gpt-x' } })).reason, 'unsupported', 'the app\'s new chat is on a Codex model');
    assert.equal(acted.length, asked);
    // no window shows the new chat: the home page is shown, then its menu chooses, in the window main showed it in
    shownAfter = 2;
    const before = s.ops.length;
    assert.equal((await set({ model: gpt })).status, 'done');
    assert.deepEqual(s.ops.slice(before), [['new-chat', {}]]);
    assert.equal(acted.at(-1)[4], 7, 'the window the new chat was shown in');
    // E8.3e: its mode, through its composer, in the same way
    assert.equal((await set({ settings: { mode: 'plan' } })).status, 'done');
    assert.deepEqual(acted.at(-1).slice(0, 4), ['Composer', 'new:app:new-conversation', 'setCollaborationMode', ['plan']]);
    assert.equal((await set({ settings: { mode: 'chat' } })).reason, 'invalid');
    assert.match((await set({ settings: { sandbox: 'none' } })).message, /sandbox setting cannot be set here yet/);
    // E8.3f, graph-layers L2d: its access, ask or approve, as the local host's selection the app keeps (no menu); custom through its
    // permissions menu; full access is the user's (the app asks first)
    const menuActs = acted.length;
    assert.equal((await set({ settings: { access: 'approve' } })).status, 'done');
    assert.deepEqual(s.ops.at(-1), ['set-access', { access: 'approve' }]);
    assert.equal(acted.length, menuActs, 'no menu');
    assert.equal((await set({ settings: { access: 'custom' } })).status, 'done');
    assert.deepEqual(acted.at(-1).slice(0, 4), ['Composer', 'new:app:new-conversation', 'setAccess', ['custom']]);
    assert.equal((await set({ settings: { access: 'full' } })).reason, 'unsupported');
    assert.equal((await set({ settings: { access: 'root' } })).reason, 'invalid');
    // E8.3g: its starting branch (a new worktree's base, a cloud chat's branch), a Branch of its project, through its run location's picker
    s.put(projectData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    s.put({ ref: refs.branch('p1', 'feature'), state: { name: 'feature', current: false }, links: { repository: refs.repository('p1') } });
    s.put({ ref: refs.branch('p2', 'main'), state: { name: 'main', current: true }, links: { repository: refs.repository('p2') } });
    assert.equal((await set({ project: refs.project('p1'), environment: 'worktree', branch: refs.branch('p1', 'feature') })).status, 'done');
    assert.deepEqual(acted.at(-1).slice(0, 4), ['Composer', 'new:app:new-conversation', 'setBranch', ['feature']]);
    const branchAsked = acted.length;
    assert.equal((await set({ project: refs.project('p1'), branch: refs.branch('p2', 'main') })).reason, 'invalid', 'another project\'s');
    assert.equal((await set({ branch: refs.branch('p1', 'gone') })).reason, 'invalid');
    assert.equal((await set({ branch: { type: 'Branch', provider: 'other', id: 'p1:feature' } })).reason, 'unsupported');
    assert.equal(acted.length, branchAsked, 'refused before the page');
    // review 4: a cloud chat's branch, of the project its environment serves
    const servingCloud = { type: 'CloudEnvironment', provider: 'codex', id: 'cloud-p1' };
    s.put({ ref: servingCloud, state: { name: 'Cloud p1', status: 'ready' }, links: { project: refs.project('p1') } });
    assert.equal((await set({ environment: servingCloud, branch: refs.branch('p1', 'feature') })).status, 'done');
    assert.deepEqual(acted.at(-1).slice(2, 4), ['setBranch', ['feature']]);
    // the menu says no: its reason
    answer = { status: 'refused', reason: 'unavailable', message: 'the menu does not offer gpt-x' };
    const no = await set({ model: gpt });
    assert.deepEqual([no.reason, no.message], ['unavailable', 'the menu does not offer gpt-x']);
  } finally { await s.close(); }
});

test('E8.3h: the new chat\'s target reads back what its composer shows (where it runs, its starting branch, its model, effort and mode), the latest window\'s', async () => {
  const s = await setup();
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:new-conversation', doc: doc('Hi') }], newChat: { project: 'p1' } } });
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    s.h.bus.publish('window/newChat', { windowId: 1, target: { environment: 'worktree', branch: 'feature', model: 'gpt-x', effort: 'high', mode: 'plan' } });
    await until(() => s.graph.resolve(NEW)?.state.target.model, 2000, 'its target');
    let t = s.graph.resolve(NEW).state.target;
    assert.deepEqual([t.project, t.environment, t.branch, t.model, t.settings], [refs.project('p1'), 'worktree', refs.branch('p1', 'feature'), refs.model('gpt-x'), { effort: 'high', mode: 'plan' }]);
    assert.deepEqual(s.graph.resolve(NEW).state.content.parts.map((p) => p.text), ['Hi'], 'its text stays');
    // another window shows it running locally; then that window shows no new chat: the first window's again
    s.h.bus.publish('window/newChat', { windowId: 2, target: { environment: 'local', mode: 'default' } });
    await until(() => s.graph.resolve(NEW)?.state.target.environment?.type === 'LocalEnvironment', 2000, 'the local one');
    t = s.graph.resolve(NEW).state.target;
    assert.deepEqual([t.environment, t.branch, t.model, t.settings], [refs.localEnvironment('p1'), undefined, undefined, { mode: 'default' }]);
    s.h.bus.publish('window/newChat', { windowId: 2, target: null });
    await until(() => s.graph.resolve(NEW)?.state.target.environment === 'worktree', 2000, 'the first window\'s again');
  } finally { await s.close(); }
});

test('E8.3b: a Draft shown in a composer is written there live (setText, insert, clear); none shown, or the page cannot: the app\'s own messages', async () => {
  const acted = [];
  let shown = true;
  const s = await setup({ pageAct: async (type, subject, op, args) => { acted.push([type, subject.id, op, args]); return shown ? (op === 'clear' && args.length === 0 && acted.length > 3 ? { status: 'refused', reason: 'unavailable' } : { status: 'done', value: null }) : null; } });
  try {
    const before = s.ops.length;
    assert.equal((await s.invoke(s.draft, 'setContent', [content('Live text')])).status, 'done');
    assert.equal((await s.invoke(s.draft, 'insert', [content(' more')])).status, 'done');
    assert.equal((await s.invoke(s.draft, 'clear', [])).status, 'done');
    assert.deepEqual(acted.map(([t, id, op, a]) => [t, id, op, a]), [['Composer', s.thread.id, 'setText', ['Live text']], ['Composer', s.thread.id, 'insert', ['more']], ['Composer', s.thread.id, 'clear', []]]);
    assert.equal(s.ops.length, before, 'nothing went through framework-main');
    // the page cannot (a composer without a controller): the app's own messages
    assert.equal((await s.invoke(s.draft, 'clear', [])).status, 'done');
    assert.deepEqual(s.ops.at(-1), ['clear', { threadId: s.thread.id }]);
    shown = false;
    assert.equal((await s.invoke(s.draft, 'setContent', [content('Cold')])).status, 'done');
    assert.equal(s.ops.at(-1)[0], 'set-text', 'not shown: framework-main shows the chat and writes its composer');
  } finally { await s.close(); }
});

test('E8 review 2: a live edit the page did not answer in time is not made again another way (the operation fails)', async () => {
  const s = await setup({ pageAct: async () => ({ status: 'failed', error: { message: 'the window did not answer in time' } }) });
  try {
    const before = s.ops.length;
    const out = await s.invoke(s.draft, 'insert', [content('maybe twice')]);
    assert.equal(out.status, 'failed');
    assert.equal(s.ops.length, before, 'no fallback through framework-main');
  } finally { await s.close(); }
});

test('graph-layers L2: a Draft operation given a window stays in it (its composer there, or refused, never the app\'s messages elsewhere)', async () => {
  const acts = [];
  const s = await setup({ pageAct: async (type, subject, op, args, windowId) => { acts.push([op, windowId]); return windowId === 7 ? { status: 'done', windowId } : null; } });
  try {
    const win = (id) => ({ window: { type: 'Window', provider: 'codexmods.windows', id: String(id) } });
    const before = s.ops.length;
    assert.equal((await s.invoke(s.draft, 'setContent', [content('Here'), win(7)], mod)).status, 'done');
    const away = await s.invoke(s.draft, 'insert', [content('There'), win(8)], mod);
    assert.deepEqual([away.status, away.reason], ['refused', 'unavailable'], 'window 8 does not show its composer');
    assert.equal(s.ops.length, before, 'no message to whichever window the app would choose');
    assert.deepEqual(acts, [['setText', 7], ['insert', 8]]);
    assert.equal((await s.invoke(s.draft, 'clear', [{ window: 'front' }], mod)).reason, 'invalid', 'a window is a Window ref');
  } finally { await s.close(); }
});

test('graph-layers L2: setTarget chooses its window before its first step and keeps it; a project the app does not select is refused', async () => {
  let choice = { windowId: 9 };
  const s = await setup({ chooseWindow: async () => choice });
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.put(projectData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [], newChat: { project: null } } });
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    const first = await s.invoke(NEW, 'setTarget', [{ project: refs.project('p1') }], mod);
    assert.equal(first.status, 'done', JSON.stringify(first));
    assert.deepEqual(s.ops.at(-1), ['new-chat', { projectId: 'p1', windowId: 9 }], 'the window chosen first, for its first step too');
    // two windows show the new chat and neither is in front: refused before anything is done
    choice = { refused: { status: 'refused', reason: 'unavailable', message: 'more than one window shows it and none is the one in front' } };
    const n = s.ops.length;
    assert.equal((await s.invoke(NEW, 'setTarget', [{ project: null }], mod)).reason, 'unavailable');
    assert.equal(s.ops.length, n);
    // the app does not select the project asked for: refused, nothing set after it
    choice = { windowId: 9 };
    s.put(projectData({ id: 'p2', name: 'other', roots: ['/other'] }));
    s.answers.set('new-chat', { ok: true, result: { windowId: 9 } });
    const r = await s.invoke(NEW, 'setTarget', [{ project: refs.project('p2'), settings: { mode: 'plan' } }], mod);
    assert.deepEqual([r.status, r.reason, /did not select/.test(r.message)], ['refused', 'unavailable', true], JSON.stringify(r));
  } finally { await s.close(); }
});

test('graph-layers L2: a new chat\'s send answers the thread the app bound to its client id, not another chat started meanwhile', async () => {
  const s = await setup();
  try {
    const NEW = refs.draft('new:app:new-conversation');
    const clientId = 'client-new-thread:1111';
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:new-conversation', doc: doc('Ship it') }], newChat: { project: null, clientId } } });
    await until(() => s.graph.resolve(NEW)?.state.content.parts.length, 2000, 'its text');
    // the app starts another chat first (an automation), then the one this send made, and binds the client id to it
    const other = (await s.ask('thread/start', { cwd: '/repo' })).result.thread;
    let polls = 0;
    s.answers.set('submit', { ok: true, result: {} });
    s.answers.set('bound', async (args) => { polls++; assert.equal(args.clientId, clientId); return { ok: true, result: { threadId: polls >= 2 ? 'th-made' : null } }; });
    const out = await s.invoke(NEW, 'send', [], mod);
    assert.equal(out.status, 'done', JSON.stringify(out));
    assert.deepEqual(out.value, refs.thread('th-made'), `not ${other.id}`);
  } finally { await s.close(); }
});

test('graph-layers L2: Project.newThread(spec) prepares the new chat in one window and sends it; the user\'s draft is never written over, an edit meanwhile never sent', async () => {
  let s;
  const typed = { text: null };   // the user's edit, made as soon as the operation has written its text
  const page = { text: '' };      // what the composer's editor holds (its live read)
  const changed = { status: 'refused', reason: 'unavailable', message: 'changed: the draft holds something else now' };
  s = await setup({
    chooseWindow: async () => ({ windowId: 7, shows: true }),
    pageAct: async (type, subject, op, args, windowId) => {
      if (windowId !== 7) return null;
      if (op === 'textIs') return page.text === args[0] ? { status: 'done', windowId } : changed;
      if (op !== 'setTextIf') return null;
      if (page.text !== args[0]) return changed;
      page.text = typed.text ?? args[1];
      queueMicrotask(() => s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:new-conversation', doc: doc(page.text) }], newChat: { project: 'p1', clientId: 'client-new-thread:2222' } } }));
      return { status: 'done', windowId };
    },
  });
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.put(projectData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [], newChat: { project: null, clientId: 'client-new-thread:2222' } } });
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    // unsent: the Draft, prepared in window 7
    const unsent = await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'Look at the tests' }], mod);
    assert.equal(unsent.status, 'done', JSON.stringify(unsent));
    assert.deepEqual(unsent.value, NEW);
    assert.deepEqual(s.ops.find(([op]) => op === 'new-chat'), ['new-chat', { projectId: 'p1', windowId: 7 }]);
    await until(() => textOfDraft(s.graph.resolve(NEW)) === 'Look at the tests', 2000, 'its text');
    // the user's text there now: not written over without replace
    const kept = await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'Other', send: true }], mod);
    assert.deepEqual([kept.status, kept.reason], ['refused', 'unavailable']);
    // with replace, sent: the thread the app bound to the new chat's client id
    let submitted = false;
    s.answers.set('submit', () => { submitted = true; return { ok: true, result: {} }; });
    s.answers.set('bound', () => ({ ok: true, result: { threadId: submitted ? 'th-sent' : null } }));
    const sent = await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'Ship it', send: true, replace: true }], mod);
    assert.equal(sent.status, 'done', JSON.stringify(sent));
    assert.deepEqual(sent.value, refs.thread('th-sent'));
    assert.deepEqual(s.ops.filter(([op]) => op === 'submit').at(-1), ['submit', { threadId: 'new:app:new-conversation', windowId: 7, shown: true }], 'at once, where it was written');
    assert.ok(s.asked.some((q) => /start a chat in “repo” with “Ship it”/.test(q.action)), 'asked as a send');
    // the user types while it is prepared: not sent, the edit kept
    typed.text = 'my own words';
    const n = s.ops.filter(([op]) => op === 'submit').length;
    const edited = await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'Ship it again', send: true, replace: true }], mod);
    assert.deepEqual([edited.status, /changed: it is not sent/.test(edited.message)], ['refused', true], 'the live editor read just before the submit');
    assert.equal(s.ops.filter(([op]) => op === 'submit').length, n, 'nothing submitted');
    assert.equal((await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'x', colour: 'red' }], mod)).reason, 'invalid');
  } finally { await s.close(); }
});
const textOfDraft = (d) => (d?.state.content.parts ?? []).map((p) => p.text ?? '').join('');

test('graph-layers L2d: a cloud chat\'s environment is the exact one asked for: the app\'s stored choice, or its only one; otherwise refused before anything is set', async () => {
  const s = await setup();
  try {
    const NEW = refs.draft('new:app:new-conversation');
    const report = (cloud) => s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [], newChat: { project: null, clientId: null, cloud } } });
    report(null);
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    const a = { type: 'CloudEnvironment', provider: 'codex', id: 'env-a' }, b = { type: 'CloudEnvironment', provider: 'codex', id: 'env-b' };
    s.put({ ref: a, state: { name: 'alpha', status: 'ready' }, links: { project: null } });
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: a }], mod)).status, 'done', 'the account\'s only one, none stored');
    s.put({ ref: b, state: { name: 'beta', status: 'ready' }, links: { project: null } });
    const n = s.ops.length;
    const r = await s.invoke(NEW, 'setTarget', [{ environment: b }], mod);
    assert.deepEqual([r.status, r.reason, /choose “beta”/.test(r.message)], ['refused', 'unavailable', true], 'two, none stored: which one the composer takes is not this call\'s');
    assert.equal(s.ops.length, n, 'nothing set');
    report({ id: 'wham-1', label: 'beta' });
    await new Promise((x) => setTimeout(x, 50));
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: b }], mod)).reason, 'unavailable', 'a stored choice of the same name is not the same environment');
    report({ id: 'env-b', label: 'beta' });
    await new Promise((x) => setTimeout(x, 50));
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: b }], mod)).status, 'done', 'the app\'s stored choice, by its id');
    assert.equal((await s.invoke(NEW, 'setTarget', [{ environment: a }], mod)).reason, 'unavailable');
  } finally { await s.close(); }
});

test('graph-layers L2 (built review): an ambiguous place is refused, never the app\'s messages to the first window; an edit while preparing is never written over; a just-bound client id is not this send\'s; local is the project\'s folder', async () => {
  let choice = { refused: { status: 'refused', reason: 'unavailable', message: 'more than one window shows it and none is the one in front' } };
  let s;
  s = await setup({ chooseWindow: async () => choice, pageAct: async () => null });
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.put(projectData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    s.put(localEnvironmentData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    const report = (text, clientId = 'client-new-thread:3333') => s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: text ? [{ threadId: 'new:app:new-conversation', doc: doc(text) }] : [], newChat: { project: 'p1', clientId } } });
    report('');
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    const n = s.ops.length;
    assert.equal((await s.invoke(NEW, 'insert', [content('x')], mod)).reason, 'unavailable');
    assert.equal(s.ops.length, n, 'nothing sent to the app\'s first window');
    // the user types while the target is set: refused before the prompt is written
    choice = { windowId: 7, shows: false };
    s.answers.set('new-chat', async () => { report('the user typed this'); await new Promise((r) => setTimeout(r, 50)); return { ok: true, result: { windowId: 7 } }; });
    const r = await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'Mine', environment: 'local' }], mod);
    assert.deepEqual([r.status, /changed while it was prepared/.test(r.message)], ['refused', true], JSON.stringify(r));
    assert.ok(s.ops.some(([op, a]) => op === 'new-chat' && a.mode === 'local' && a.projectId === 'p1' && a.windowId === 7), "'local': the project's own folder");
    // a client id already bound: the user's send just now, not this one
    s.answers.delete('new-chat');
    report('Send me', 'client-new-thread:4444');
    await until(() => (s.graph.resolve(NEW)?.state.content.parts[0]?.text ?? '') === 'Send me', 2000, 'its text');
    s.answers.set('bound', { ok: true, result: { threadId: 'th-old' } });
    const sent = await s.invoke(NEW, 'send', [], mod);
    assert.deepEqual([sent.status, /just sent/.test(sent.message)], ['refused', true]);
  } finally { await s.close(); }
});

test('public hooks H5: a draft\'s chips are its Mentions in order (files, folders, skills, plugins, apps, chats); a link is text; a change of chips alone is a change', async () => {
  const s = await setup();
  try {
    const at = (fsPath, label) => ({ type: 'atMention', attrs: { label, path: fsPath.replace('/repo/', ''), fsPath } });
    const chips = (first) => ({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'See ' }, first, { type: 'text', text: ' and ' }, at('/repo/src/', 'src'),
      { type: 'skillMention', attrs: { name: 'review', displayName: 'Review', path: '/skills/review/SKILL.md', description: '' } },
      { type: 'pluginMention', attrs: { name: 'figma', displayName: 'Figma', path: 'plugin://figma@openai-curated', description: '' } },
      { type: 'appMention', attrs: { name: 'gmail', displayName: 'Gmail', path: 'app://gmail', description: '' } },
      { type: 'agentMention', attrs: { name: 'helper', displayName: 'Helper', conversationId: 'c-1', path: 'thread://c-1' } },
      { type: 'agentMention', attrs: { name: 'custom', displayName: 'Custom', conversationId: null, path: 'agent://custom' } },
      { type: 'richLink', attrs: { displayText: 'docs', href: 'https://x/docs', sourceAppId: 'a' } },
      { type: 'resourceMention', attrs: { server: 's', resourceUri: 'u', title: 'Res' } },
    ] }] });
    s.report([{ threadId: s.thread.id, doc: chips(at('/repo/a.mjs', 'a.mjs')) }]);
    const d = s.graph.resolve(s.draft);
    assert.deepEqual(d.state.content, content('See @a.mjs and @src@review@figma@gmail@helper@customdocs@Res'));
    assert.deepEqual(d.links.mentions, [0, 1, 2, 3, 4, 5].map((i) => refs.draftMention(s.thread.id, i)));
    assert.deepEqual(d.links.mentions.map((r) => s.graph.resolve(r).state), [
      { label: 'a.mjs', target: refs.file('/repo/a.mjs') }, { label: 'src', target: refs.folder('/repo/src') }, { label: 'Review', target: refs.skill('/skills/review/SKILL.md') },
      { label: 'Figma', target: refs.plugin('figma@openai-curated') }, { label: 'Gmail', target: refs.plugin('gmail') }, { label: 'Helper', target: refs.thread('c-1') },
    ], 'a chip the graph has no type for (a custom agent, a link, an MCP resource) is no Mention');
    // the same text, another file behind the first chip: a change
    s.report([{ threadId: s.thread.id, doc: chips(at('/repo/b/a.mjs', 'a.mjs')) }]);
    assert.deepEqual(s.events.map(([, e]) => e), ['changed']);
    assert.deepEqual(s.graph.resolve(refs.draftMention(s.thread.id, 0)).state.target, refs.file('/repo/b/a.mjs'));
    s.report([{ threadId: s.thread.id, doc: { type: 'doc', content: [{ type: 'paragraph', content: [at('/repo/a.mjs', 'a.mjs')] }] } }]);
    assert.deepEqual(s.graph.resolve(s.draft).links.mentions, [refs.draftMention(s.thread.id, 0)]);
    for (const i of [1, 2, 3, 4, 5]) assert.ok(!s.graph.resolve(refs.draftMention(s.thread.id, i)) || s.graph.resolve(refs.draftMention(s.thread.id, i)).gone, `mention ${i} goes`);
    await s.ask('fake/notify', { method: 'thread/deleted', params: { threadId: s.thread.id } });
    await until(() => s.graph.resolve(refs.thread(s.thread.id))?.gone, 3000, 'the thread goes');
    s.report([]);
    assert.equal(s.graph.resolve(s.draft).gone, true);
    assert.equal(s.graph.resolve(refs.draftMention(s.thread.id, 0)).gone, true, 'a gone draft\'s mentions go with it');
  } finally { await s.close(); }
});

test('public hooks H5: setContent({ifEmpty}) writes only into an empty draft: read and written in one step where it is shown, else when the saved draft is empty (an insert)', async () => {
  const acted = [];
  let shown = true, live = '';
  const s = await setup({ pageAct: async (type, subject, op, args) => {
    acted.push([op, args]);
    if (!shown) return null;
    if (op !== 'setTextIf') return { status: 'done', value: null };
    if (live !== args[0]) return { status: 'refused', reason: 'unavailable', message: 'changed: the draft holds something else now' };
    live = args[1];
    return { status: 'done', value: null };
  } });
  try {
    const before = s.ops.length;
    done(await s.invoke(s.draft, 'setContent', [content('Hi'), { ifEmpty: true }], mod));
    assert.deepEqual(acted, [['setTextIf', ['', 'Hi']]]);
    refused(await s.invoke(s.draft, 'setContent', [content('Again'), { ifEmpty: true }], mod), 'unavailable', 'the draft is not empty: it is not written over');
    assert.equal(live, 'Hi', 'the text in the composer is kept');
    assert.equal(s.ops.length, before, 'nothing through framework-main');
    // not shown: the draft the app saved decides; an insert, never a clear
    shown = false;
    s.report([{ threadId: s.thread.id, doc: doc('Saved') }]);
    refused(await s.invoke(s.draft, 'setContent', [content('Cold'), { ifEmpty: true }], mod), 'unavailable', 'the draft is not empty: it is not written over');
    assert.equal(s.ops.length, before);
    s.report([{ threadId: s.thread.id, doc: doc('') }]);
    done(await s.invoke(s.draft, 'setContent', [content('Cold'), { ifEmpty: true }], mod));
    assert.deepEqual(s.ops.at(-1), ['insert', { threadId: s.thread.id, text: 'Cold', skills: [] }]);
    done(await s.invoke(s.draft, 'setContent', [content(''), { ifEmpty: true }], mod));
    assert.equal(s.ops.length, before + 1, 'nothing to write: nothing done');
    refused(await s.invoke(s.draft, 'setContent', [content('x'), { ifEmpty: 'yes' }], mod), 'invalid', 'ifEmpty is true or false');
  } finally { await s.close(); }
});

test('public hooks H5: attach takes a text (a file of the framework\'s own, attached as a file), a link (inserted where the cursor is) and a Skill (its chip)', async () => {
  const s = await setup();
  try {
    const skill = s.put(skillData({ path: '/skills/review/SKILL.md', name: 'review', scope: 'user', enabled: true }));
    const before = s.ops.length;
    done(await s.invoke(s.draft, 'attach', [{ text: 'line 1\nline 2', name: 'build.log' }], mod));
    done(await s.invoke(s.draft, 'attach', [{ text: 'plain' }], mod));
    done(await s.invoke(s.draft, 'attach', [{ url: 'https://example.com/spec', title: 'Spec' }], mod));
    done(await s.invoke(s.draft, 'attach', [{ url: 'https://example.com/' }], mod));
    done(await s.invoke(s.draft, 'attach', [skill], mod));
    const ops = s.ops.slice(before);
    assert.deepEqual(ops.map(([op]) => op), ['attach', 'attach', 'insert', 'insert', 'insert']);
    const [log, plain] = [ops[0][1].path, ops[1][1].path];
    for (const [p, name, text] of [[log, 'build.log', 'line 1\nline 2'], [plain, 'text.txt', 'plain']]) {
      assert.equal(path.dirname(path.dirname(p)), s.filesDir);
      assert.equal(path.basename(p), name);
      assert.equal(fs.readFileSync(p, 'utf8'), text);
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    }
    assert.notEqual(path.dirname(log), path.dirname(plain), 'each text has its own folder');
    assert.deepEqual(ops.slice(2).map(([, a]) => [a.text, a.skills]), [['Spec: https://example.com/spec', []], ['https://example.com/', []], ['', [{ name: 'review', path: skill.id }]]]);
    const at = s.ops.length;
    for (const [what, reason] of [[{ text: 'x', name: '../a' }, 'invalid'], [{ text: 'x', name: '.hidden' }, 'invalid'], [{ text: 'x'.repeat(512 * 1024 + 1) }, 'invalid'],
      [{ url: 'javascript:alert(1)' }, 'invalid'], [{ url: 'not a url' }, 'invalid'], [{ url: 'https://x', title: 3 }, 'invalid'], [{ kind: 'image', source: '/a.png' }, 'invalid'], [42, 'invalid']]) {
      refused(await s.invoke(s.draft, 'attach', [what], mod), reason);
    }
    const PANEL = refs.draft('new:app:panel-new-conversation');
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:panel-new-conversation', doc: doc('') }], newChat: { project: null } } });
    await until(() => s.graph.resolve(PANEL), 2000, 'the panel\'s draft');
    refused(await s.invoke(PANEL, 'attach', [{ text: 'x', name: 'never.txt' }], mod), 'unsupported');
    assert.equal(s.ops.length, at, 'nothing refused reached framework-main');
    assert.deepEqual(fs.readdirSync(s.filesDir).length, 2, 'nothing refused was written');
  } finally { await s.close(); }
  const t = await setup({ files: false });
  try { refused(await t.invoke(t.draft, 'attach', [{ text: 'x' }], mod), 'unavailable'); } finally { await t.close(); }
});

test('public hooks H8: attach takes an image of the mod\'s own (a data URL), written as a file of the framework\'s and attached as one', async () => {
  const s = await setup();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const before = s.ops.length;
    done(await s.invoke(s.draft, 'attach', [{ image: `data:image/png;base64,${png.toString('base64')}` }], mod));
    done(await s.invoke(s.draft, 'attach', [{ image: `data:image/jpeg;base64,${png.toString('base64')}`, name: 'shot.jpeg' }], mod));
    const [a, b] = s.ops.slice(before).map(([op, args]) => [op, args.path]);
    assert.deepEqual([a[0], path.basename(a[1]), path.basename(b[1])], ['attach', 'image.png', 'shot.jpeg']);
    assert.deepEqual(fs.readFileSync(a[1]), png, 'its bytes');
    const at = s.ops.length;
    for (const what of [{ image: 'data:image/svg+xml;base64,PHN2Zz4=' }, { image: 'https://example.com/a.png' }, { image: 'data:image/png;base64,' },
      { image: `data:image/png;base64,${png.toString('base64')}`, name: 'a.jpg' }, { image: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}` }]) {
      refused(await s.invoke(s.draft, 'attach', [what], mod), 'invalid');
    }
    assert.equal(s.ops.length, at, 'nothing refused reached framework-main');
  } finally { await s.close(); }
});

test('public hooks H6 (§3.8): a new chat starts with the mods\' defaults where a window shows it (the first mod gives a field); the user\'s choice wins until the next chat; the text only into an empty draft', async () => {
  const acted = [];
  const s = await setup({ pageAct: async (type, subject, op, args, windowId) => { acted.push([op, args, windowId]); return { status: 'done', value: null }; } });
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.graph.defaults('mod:d.one', { id: 'plan', of: 'Draft', target: { settings: { mode: 'plan' } }, content: content('Start with a plan') });
    s.graph.defaults('mod:d.two', { id: 'other', of: 'Draft', target: { settings: { mode: 'default', effort: 'high' } } });
    const show = (target) => s.h.bus.publish('window/newChat', { windowId: 7, target });
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:new-conversation', doc: doc('') }], newChat: { project: null } } });
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    show({ mode: 'default', effort: 'low' });
    await until(() => acted.some(([op]) => op === 'setTextIf'), 3000, 'the defaults applied');
    assert.deepEqual(acted.filter(([op]) => op === 'setCollaborationMode').map(([, a, w]) => [a, w]), [[['plan'], 7]], 'the first mod gives the mode');
    assert.ok(acted.some(([op, a]) => op === 'choose' && a[1] === 'high'), 'a field only the second gives: its effort');
    assert.deepEqual(acted.find(([op]) => op === 'setTextIf').slice(1), [['', 'Start with a plan'], 7]);
    // the window shows what the defaults put (theirs), then the user chooses default (theirs now): shown again, nothing is put back
    show({ mode: 'plan', effort: 'high' });
    const before = acted.length;
    show({ mode: 'default', effort: 'high' });
    show(null);
    show({ mode: 'default', effort: 'high' });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(acted.filter(([op], i) => i >= before && op === 'setCollaborationMode').length, 0, 'the user\'s choice wins');
    // the next chat (the draft cleared): the defaults again; text the user wrote is never written over
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [{ threadId: 'new:app:new-conversation', doc: doc('Mine') }], newChat: { project: null } } });
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [], newChat: { project: null } } });
    await until(() => acted.filter(([op]) => op === 'setCollaborationMode').length === 2, 3000, 'applied again for the next chat');
    s.graph.disposeOwner('mod:d.one');
    s.graph.disposeOwner('mod:d.two');
    // a choice the user made before a mod declared its defaults is theirs too (its provenance, not what a default put)
    show({ mode: 'plan', effort: 'low' });
    show({ mode: 'plan', effort: 'medium' });
    const was = acted.length;
    s.graph.defaults('mod:d.late', { id: 'effort', of: 'Draft', target: { settings: { effort: 'high', mode: 'default' } } });
    await until(() => acted.filter(([op], i) => i >= was && op === 'setCollaborationMode').length === 1, 3000, 'the late default applied');
    assert.deepEqual(acted.filter(([op], i) => i >= was && op === 'choose').map(([, a]) => a[1]), [], 'the effort the user chose is kept');
    s.graph.disposeOwner('mod:d.late');
  } finally { await s.close(); }
});

test('public hooks §3.14 (review): a chat\'s spec may name its window (where a starter was chosen): every step keeps to it, none is chosen', async () => {
  let chose = 0;
  const s = await setup({
    chooseWindow: async () => { chose++; return { windowId: 7, shows: true }; },
    pageAct: async (type, subject, op, args, windowId) => (windowId === 3 && op === 'setTextIf' ? { status: 'done', windowId } : null),
  });
  try {
    const NEW = refs.draft('new:app:new-conversation');
    s.put(projectData({ id: 'p1', name: 'repo', roots: ['/repo'] }));
    s.mainOps.report({ type: 'area-report', area: 'composer', report: { drafts: [], newChat: { project: null, clientId: 'client-new-thread:3333' } } });
    await until(() => s.graph.resolve(NEW), 2000, 'the new chat\'s draft');
    const W3 = { type: 'Window', provider: 'codexmods.windows', id: '3' };
    await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'Here', window: W3 }], mod);
    assert.deepEqual(s.ops.find(([op]) => op === 'new-chat'), ['new-chat', { projectId: 'p1', windowId: 3 }], 'in the window named');
    assert.equal(chose, 0, 'no window was chosen for it');
    const bad = await s.invoke(refs.project('p1'), 'newThread', [{ prompt: 'x', window: { type: 'Window', provider: 'codex', id: '3' } }], mod);
    assert.deepEqual([bad.status, bad.reason], ['refused', 'invalid']);
  } finally { await s.close(); }
});

test('public hooks H5x: a side chat\'s draft (an ephemeral fork in the side panel) is written where its composer is shown; the app\'s messages, files and its send are refused', async () => {
  const s = await setup();
  try {
    const side = (await s.ask('thread/start', { cwd: '/repo', ephemeral: true })).result.thread.id;
    const draft = refs.draft(side);
    await until(() => s.graph.resolve(draft), 2000, 'its draft');
    const before = s.ops.length;
    refused(await s.invoke(draft, 'setContent', [content('x')], mod), 'unavailable', "a side chat's draft is written while its composer is shown");
    refused(await s.invoke(draft, 'insert', [content('x')], mod), 'unavailable', "a side chat's draft is written while its composer is shown");
    refused(await s.invoke(draft, 'attach', [refs.file('/repo/a.txt')], mod), 'unavailable', "a side chat's draft is written while its composer is shown");
    refused(await s.invoke(draft, 'send', [], user), 'unsupported', "a side chat's draft is sent from its composer");
    assert.equal(s.ops.length, before, 'nothing reached framework-main');
  } finally { await s.close(); }
});

test('public hooks H5x: a side chat\'s draft is written live in the composer that shows it', async () => {
  const calls = [];
  const s = await setup({ pageAct: async (type, subject, op, args, windowId) => { calls.push([type, subject.id, op, args, windowId]); return { status: 'done', windowId: 3 }; }, chooseWindow: async () => ({ windowId: 3, shows: true }) });
  try {
    const side = (await s.ask('thread/start', { cwd: '/repo', ephemeral: true })).result.thread.id;
    const draft = refs.draft(side);
    await until(() => s.graph.resolve(draft), 2000, 'its draft');
    done(await s.invoke(draft, 'setContent', [content('Live')], mod));
    assert.deepEqual(calls.at(-1), ['Composer', side, 'setText', ['Live'], 3]);
  } finally { await s.close(); }
});

test('public hooks H5x review 1, 2: a Draft is written and sent in its own composer: shown, live (its own submit, its skill chips); else its chat shown first and its composer then; a file by the app\'s message to it, focused first', async () => {
  const calls = [], shown = new Set();
  const s = await setup({
    pageAct: async (type, subject, op, args, windowId) => { if (!shown.has(`${windowId}:${subject.id}`)) return null; calls.push([op, windowId]); return { status: 'done', windowId }; },
    chooseWindow: async () => ({ windowId: 3, shows: shown.has(`3:${s.thread.id}`) }),
    showsIn: (windowId, type, subject) => shown.has(`${windowId}:${subject.id}`),
  });
  try {
    await until(() => s.graph.resolve(s.draft), 2000, 'the draft');
    // not shown: framework-main shows the chat, then its composer takes it live
    s.answers.set('show', async () => { shown.add(`3:${s.thread.id}`); return { ok: true, result: { windowId: 3 } }; });
    done(await s.invoke(s.draft, 'setContent', [content('Hello')], mod));
    assert.deepEqual(s.ops.map(([op]) => op).filter((op) => op !== 'prompts'), ['show']);
    assert.deepEqual(calls.at(-1), ['setText', 3]);
    // shown: its own submit, never the app's submit command
    s.answers.set('submit', () => assert.fail('the app\'s submit command reaches the active composer'));
    queueMicrotask(async () => { await new Promise((r) => setTimeout(r, 20)); await s.ask('turn/start', { threadId: s.thread.id, input: userInput(content('Hello')) }); });
    const sent = done(await s.invoke(s.draft, 'send', [], mod));
    assert.equal(sent.type, 'CodexTurn');
    assert.deepEqual(calls.at(-1), ['submit', 3]);
    // a skill's chip: put by its own composer (review 2), never by the app's message
    s.answers.delete('submit');
    const opsBefore = s.ops.length;
    done(await s.invoke(s.draft, 'insert', [{ parts: [{ kind: 'mention', target: refs.skill('/s/review/SKILL.md'), label: 'review' }] }], mod));
    assert.deepEqual(calls.at(-1), ['insertSkill', 3]);
    assert.equal(s.ops.length, opsBefore);
    // a file: told by its very composer, with no navigation and no message from main
    done(await s.invoke(s.draft, 'attach', [refs.file('/repo/a.txt')], mod));
    assert.deepEqual(calls.at(-1), ['attachFile', 3]);
    assert.equal(s.ops.length, opsBefore);
  } finally { await s.close(); }
});

test('public hooks H5x review 1: a side chat\'s skill (Skill.use) is put only in its own composer', async () => {
  const s = await setup();
  try {
    const side = (await s.ask('thread/start', { cwd: '/repo', ephemeral: true })).result.thread.id;
    await until(() => s.graph.resolve(refs.draft(side)), 2000, 'its draft');
    const skill = s.put(skillData({ name: 'review', path: '/s/review/SKILL.md', enabled: true, scope: 'user', description: '' }));
    const before = s.ops.length;
    refused(await s.invoke(skill, 'use', [refs.draft(side)], mod), 'unavailable', "a side chat's draft is written while its composer is shown");
    assert.equal(s.ops.length, before);
  } finally { await s.close(); }
});

test('layouts WL7 review: a file is told by the pane\'s very composer; where it cannot be, the app\'s message, which goes to the active composer, is not tried for a pane', async () => {
  const acted = [];
  let held, panes = ['pane-a', 'pane-b'], answer = { status: 'done', windowId: 1, value: null };
  const s = await setup({
    chooseWindow: async () => ({ windowId: 1, shows: true }), showsIn: () => true,
    pageAct: async (type, subject, op, args, windowId) => { acted.push([op, args, windowId, held]); return op === 'attachFile' ? answer : { status: 'done', windowId, value: null }; },
    windows: { withPane: (pane, fn) => { held = pane ?? undefined; return fn(); }, capturePane: (w, token) => { held ??= token; }, heldPane: () => held, panesOf: () => panes },
  });
  try {
    const file = refs.file('/repo/a file.txt');
    const attach = (opts) => s.invoke(s.draft, 'attach', [file, ...(opts ? [opts] : [])], mod);
    const before = s.ops.length;
    assert.equal((await attach({ pane: 'pane-b' })).status, 'done');
    assert.deepEqual(acted.at(-1), ['attachFile', [{ label: 'a file.txt', path: '/repo/a file.txt', fsPath: '/repo/a file.txt' }], 1, 'pane-b']);
    assert.equal(s.ops.length, before, 'no message from main');
    const twice = await attach();
    assert.deepEqual([twice.status, twice.reason], ['refused', 'unavailable'], 'two panes and none named: never guessed');
    // the composer cannot take it (a window not in front): a pane's is refused, never the app's message
    answer = { status: 'refused', reason: 'unavailable', message: 'the composer cannot attachFile here' };
    const noMessage = await attach({ pane: 'pane-a' });
    assert.deepEqual([noMessage.status, noMessage.message], ['refused', "that pane's composer cannot take this now"]);
    assert.equal(s.ops.length, before);
    const shown = (await s.invoke(s.draft, 'attach', [file, { pane: 'route' }], mod));
    assert.deepEqual([shown.status, shown.reason], ['refused', 'gone'], 'the window\'s own page is not one of them here');
    // the window's own composer, the only one of this chat there: the app's message is as sure as it was
    panes = ['route'];
    assert.equal((await attach()).status, 'done');
    assert.equal(held, 'route', 'settled on the one there');
    assert.equal(s.ops.length, before + 1);
    assert.deepEqual(s.ops.at(-1)[0], 'attach');
    // the composer's own reason is the answer
    answer = { status: 'refused', reason: 'unavailable', message: 'a queued message is being edited in this composer' };
    assert.equal((await attach()).message, 'a queued message is being edited in this composer');
  } finally { await s.close(); }
});

test('layouts WL7 review: File.attachTo keeps to one pane too; two composers of it are a refusal, not a failure; a text it wrote for a refused attach is not kept', async () => {
  const acted = [];
  let held, inOperation = false, panes = ['pane-a'], answer = { status: 'done', windowId: 1, value: null };
  const s = await setup({
    chooseWindow: async () => ({ windowId: 1, shows: true }), showsIn: () => true,
    pageAct: async (type, subject, op, args, windowId) => { acted.push([op, held]); return op === 'attachFile' ? answer : { status: 'done', windowId, value: null }; },
    // as the windows provider's: a record only for the operation's life, nothing captured without one
    windows: { withPane: async (pane, fn) => { held = pane ?? undefined; inOperation = true; try { return await fn(); } finally { inOperation = false; held = undefined; } }, capturePane: (w, token) => { if (inOperation) held ??= token; }, heldPane: () => held, panesOf: () => panes },
  });
  try {
    const file = s.put(fileData('/repo/a.txt', 'p', { kind: 'text' }));
    assert.equal((await s.invoke(file, 'attachTo', [s.draft], mod)).status, 'done');
    assert.deepEqual(acted.at(-1), ['attachFile', 'pane-a'], 'settled on the one there, as a Draft operation does');
    answer = { status: 'refused', reason: 'unavailable', message: 'two of these: which one is not known' };
    const two = await s.invoke(s.draft, 'attach', [file], mod);
    assert.deepEqual([two.status, two.message], ['refused', 'two of these: which one is not known']);
    const dirs = () => (fs.existsSync(s.filesDir) ? fs.readdirSync(s.filesDir).filter((n) => !n.startsWith('.')) : []);
    const before = dirs().length;
    answer = { status: 'refused', reason: 'unavailable', message: 'a queued message is being edited in this composer' };
    const told = await s.invoke(s.draft, 'attach', [{ text: 'a secret', name: 'note.txt' }], mod);
    assert.equal(told.message, 'a queued message is being edited in this composer');
    assert.equal(dirs().length, before, 'told no: the text is not kept');
    answer = { status: 'refused', reason: 'unavailable', message: 'the composer cannot attachFile here' };
    const noMessage = await s.invoke(s.draft, 'attach', [{ text: 'a secret', name: 'note.txt' }, { pane: 'pane-a' }], mod);
    assert.equal(noMessage.message, "that pane's composer cannot take this now");
    assert.equal(dirs().length, before, 'nor when the app\'s message is refused for a pane');
  } finally { await s.close(); }
});

test('layouts WL7 review round 2: a chat brought into view in two panes is refused as ambiguous, and settles on one otherwise; a text stays when whether it was attached is not known', async () => {
  const acted = [];
  let held, inOperation = false, panes = [], answer = { status: 'done', windowId: 1, value: null };
  const s = await setup({
    chooseWindow: async () => ({ windowId: 1, shows: false }), showsIn: () => panes.length > 0,
    pageAct: async (type, subject, op, args, windowId) => { acted.push([op, held]); return op === 'attachFile' ? answer : { status: 'done', windowId, value: null }; },
    windows: { withPane: async (pane, fn) => { held = pane ?? undefined; inOperation = true; try { return await fn(); } finally { inOperation = false; held = undefined; } }, capturePane: (w, token) => { if (inOperation) held ??= token; }, heldPane: () => held, panesOf: () => panes },
  });
  try {
    const file = refs.file('/repo/a.txt');
    const shownIn = (list) => { panes = []; s.answers.set('show', async () => { panes = list; return { ok: true, result: { windowId: 1 } }; }); };
    shownIn(['route', 'pane-a']);
    const many = await s.invoke(s.draft, 'attach', [file], mod);
    assert.deepEqual([many.status, /more than one pane/.test(many.message)], ['refused', true], 'never guessed');
    assert.deepEqual(acted, [], 'and nothing tried');
    shownIn(['pane-a']);
    assert.equal((await s.invoke(s.draft, 'attach', [file], mod)).status, 'done');
    assert.deepEqual(acted.at(-1), ['attachFile', 'pane-a'], 'it keeps to the one it brought into view');
    // no answer from the page: the composer may hold the file, so the text stays
    const dirs = () => (fs.existsSync(s.filesDir) ? fs.readdirSync(s.filesDir).filter((n) => !n.startsWith('.')) : []);
    const before = dirs().length;
    answer = { status: 'failed', error: { message: 'no answer' } };
    const unknown = await s.invoke(s.draft, 'attach', [{ text: 'kept', name: 'note.txt' }], mod);
    assert.notEqual(unknown.status, 'done');
    assert.equal(dirs().length, before + 1);
  } finally { await s.close(); }
});
