// The app's operations the bridge holds (app-ops.mjs APP_OPERATIONS, plus the Stop-without-a-turn request) against the protocol of every modelled build
// (the build the captures were recorded on, 20770, and every newer one, 21477 so far): each is still a client request, its params still carry the
// `threadId` and the fields the bridge reads and rewrites, and a request the bridge rewrites with changed arguments is still valid for the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_OPERATIONS, APP_AREA_METHODS, STOP_WITHOUT_TURN } from '../app-ops.mjs';
import { buildsSince, protocolMethods } from '../../../../tests/fixtures/captures.mjs';
import { schemaOf, schemaRoot, frameIssues } from '../../../../tests/fixtures/schema-check.mjs';
import { userContent, inputOfContent } from '../providers/codex/map.mjs';

const BUILDS = buildsSince('26.1013.40934-20770');
const METHODS = [...Object.keys(APP_OPERATIONS), STOP_WITHOUT_TURN];
const T = 'thr-1';
const input = [{ type: 'text', text: 'hello', text_elements: [] }];
/** A params object valid for each method: the bridge's own view of what the app sends. */
const SAMPLE = {
  'turn/start': { threadId: T, input },
  'turn/steer': { threadId: T, expectedTurnId: 'turn-1', input },
  'turn/interrupt': { threadId: T, turnId: 'turn-1' },
  'thread/name/set': { threadId: T, name: 'A name' },
  'thread/archive': { threadId: T },
  'thread/unarchive': { threadId: T },
  'thread/fork': { threadId: T, lastTurnId: 'turn-1' },
  'thread/revert': { threadId: T, beforeTurnId: 'turn-1' },
  'thread/compact/start': { threadId: T },
  'review/start': { threadId: T, target: { type: 'uncommittedChanges' } },
  'thread/goal/set': { threadId: T, objective: 'Ship it' },
  'thread/goal/clear': { threadId: T },
  'thread/delete': { threadId: T },
  // the agent's inputs (graph-integrity G3.5): a start and the skill roots are the agent's (no thread), a resume the thread's
  'thread/start': { cwd: '/repo', developerInstructions: 'The app\'s own.' },
  'thread/resume': { threadId: T },
  'skills/extraRoots/set': { extraRoots: ['/a/skills'] },
  [STOP_WITHOUT_TURN]: { threadId: T },
};
/** The agent's acts: on its CodexAgent, not a thread. */
const AGENTS = new Set(Object.entries(APP_OPERATIONS).filter(([, x]) => x.on === 'agent').map(([m]) => m));
/** The fields each operation's `args` reads from the params (and `params` writes back). */
const READS = { 'turn/start': ['input'], 'turn/steer': ['input'], 'thread/name/set': ['name'], 'review/start': ['target'], 'thread/goal/set': ['objective'], 'thread/fork': ['lastTurnId'] };
/** The area requests the bridge holds (H6m), as the app's pages send them (scouts H6m-ext-holds): valid for each build. */
const AREA_SAMPLE = {
  'plugin/install': { pluginName: 'p', marketplacePath: '/m', installAttemptId: 'a1' },
  'plugin/uninstall': { pluginId: 'p@m' },
  'config/batchWrite': { edits: [{ keyPath: 'mcp_servers.s', value: { command: 'x' }, mergeStrategy: 'replace' }], filePath: null, expectedVersion: null },
  'config/value/write': { keyPath: 'mcp_servers.s.enabled', value: false, mergeStrategy: 'upsert', filePath: null, expectedVersion: null },
  'skills/config/write': { path: '/s/SKILL.md', enabled: false },
  'mcpServer/oauth/login': { name: 's' },
};

/** The params definition of a method in a build: the schema `$ref` followed once. */
function paramsDef(build, method) {
  const s = schemaOf(build, 'params', method);
  return s?.$ref ? s.$ref.slice(2).split('/').reduce((at, k) => at[k], schemaRoot(build)) : s;
}

test('the sample covers exactly the bridge\'s table', () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...METHODS].sort());
  assert.deepEqual(Object.keys(AREA_SAMPLE).sort(), [...APP_AREA_METHODS].sort());
  assert.ok(BUILDS.includes('26.1016.62342-21477'), `builds: ${BUILDS.join(', ')}`);
});

for (const build of BUILDS) {
  test(`${build}: every method the bridge holds is a client request, with threadId required and the fields the bridge reads`, () => {
    const requests = protocolMethods(build).clientRequest;
    for (const m of METHODS) {
      assert.ok(requests.has(m), `${m} is a client request`);
      const d = paramsDef(build, m);
      if (!AGENTS.has(m)) {
        assert.ok(d.required.includes('threadId') && d.properties.threadId, `${m}: threadId is required`);
        assert.equal(d.properties.threadId.type, 'string', `${m}: threadId is a string`);
      }
      for (const f of READS[m] ?? []) assert.ok(d.properties[f], `${m}: params has ${f}`);
    }
  });

  test(`${build}: the area requests the bridge holds are client requests, and the app's are valid (H6m)`, () => {
    const requests = protocolMethods(build).clientRequest;
    for (const [m, p] of Object.entries(AREA_SAMPLE)) {
      assert.ok(requests.has(m), `${m} is a client request`);
      assert.deepEqual(frameIssues(build, 'params', m, p), [], `${m}: the sample`);
    }
  });

  test(`${build}: the sample requests are valid, and a request the bridge rewrites with changed arguments is still valid and keeps every other field`, () => {
    for (const m of METHODS) {
      assert.deepEqual(frameIssues(build, 'params', m, SAMPLE[m]), [], `${m}: the sample`);
      const spec = APP_OPERATIONS[m];
      if (!spec) continue;
      const args = spec.args(SAMPLE[m]);
      assert.ok(Array.isArray(args), `${m}: the sample is this operation`);
      if (!spec.params) continue;
      // the same arguments give back the same request; changed ones keep every other field and stay valid
      const changed = args.map((a) => (typeof a === 'string' ? `${a} (changed)` : a));
      for (const next of [args, changed]) {
        const out = spec.params(SAMPLE[m], next);
        assert.deepEqual(frameIssues(build, 'params', m, out), [], `${m}: rewritten`);
        for (const [k, v] of Object.entries(SAMPLE[m])) if (!(READS[m] ?? []).includes(k)) assert.deepEqual(out[k], v, `${m}: ${k} is kept`);
      }
    }
  });
}

test('turn/start and turn/steer: the app\'s input round-trips through the graph\'s content and back unchanged', () => {
  for (const m of ['turn/start', 'turn/steer']) {
    const back = APP_OPERATIONS[m].params(SAMPLE[m], APP_OPERATIONS[m].args(SAMPLE[m]));
    assert.deepEqual(back.input, input, m);
    assert.deepEqual(inputOfContent(userContent(input)), input, m);
  }
});
