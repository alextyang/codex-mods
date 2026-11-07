// Build-tagged captures (captures.mjs; release-2.md §4): the format, the build's protocol, the sanitization rules, and the sessions of a capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureIssues, sanitizationIssues, sanitizeCapture, loadCapture, sessionScript, contains, protocolMethods, newestBuild } from './captures.mjs';

const DIR = fileURLToPath(new URL('./captures/', import.meta.url));
const ok = (sessions) => ({ format: 'codexmods.capture/1', build: '26.1013.40934-20770', recorded: '2026-10-16', source: 'a test', doc: 'd', sanitized: ['S1', 'S2', 'S3', 'S4'], sessions });

test('every capture in the repository loads: its format, its build\'s protocol and the sanitization rules', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1);
  for (const f of files) {
    const c = loadCapture(join(DIR, f));
    assert.ok(f.includes(c.build), `${f}: the file name carries its build`);
  }
});

test('the format: each step is one kind, a request has exactly one answer, every method is the build\'s, a reconstructed step says why', () => {
  assert.deepEqual(captureIssues(ok({ '*': [{ client: 'initialize', result: {} }, { clientNotification: 'initialized' }, { notify: 'thread/started', params: { thread: { id: 't' } } }] })), []);
  const issues = captureIssues({
    ...ok({ '*': [
      { client: 'initialize' },
      { client: 'thread/start', result: {}, notify: 'thread/started' },
      { client: 'made/up', result: {} },
      { notify: 'turn/started' },
      { serverRequest: 'item/commandExecution/requestApproval', params: {}, synthetic: '' },
      { clientNotification: 'thread/start' },
    ] }),
    build: '26.1007.99999-1', recorded: '2026-10-16T10:00:00Z', sanitized: ['S1'],
  }).map((i) => `${i.path}: ${i.message}`);
  for (const want of [
    /\$\.build: no protocol schemas for build 26\.1007\.99999-1/, /\$\.recorded: is the day/, /\$\.sanitized: lists the rules/,
    /\[0\]: a client request is answered with exactly one of result or error/, /\[1\]: a step is exactly one of/,
    /\[3\]\.params: a notification carries its params/, /\[4\]\.synthetic: says why/,
  ]) assert.ok(issues.some((i) => want.test(i)), `${want}: ${issues.join('\n')}`);
  // the methods are checked against the build's protocol when it exists
  const methods = captureIssues(ok({ '*': [{ client: 'made/up', result: {} }, { clientNotification: 'thread/start' }, { notify: 'thread/start', params: {} }] })).map((i) => i.message);
  assert.deepEqual(methods, [
    "'made/up' is not a client request of build 26.1013.40934-20770",
    "'thread/start' is not a client notification of build 26.1013.40934-20770",
    "'thread/start' is not a server notification of build 26.1013.40934-20770",
  ]);
});

test('sanitization: credentials, account data, owner paths and real ids are found wherever they are, and the message never repeats the value', () => {
  const found = sanitizationIssues({
    a: { accessToken: 'abc', authStatus: 'bearerToken', apiKey: null },
    b: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', 'sk-ABCDEFGHIJKLMNOPQRST', 'Authorization: Bearer abcdefgh123'],
    c: { email: 'someone@example.com', text: 'mail me at owner@example.org', accountId: 'acct_1', planType: null },
    d: ['/Users/alex/project', '/Users/user/project', '/Volumes/Portable Drive/x', 'C:\\Users\\me', 'see ~/notes', 'https://chatgpt.com'],
    e: ['019a0000-0000-7000-8000-000000000001', '0199f3a2-5b1c-7d4e-9f00-123456789abc'],
    'code-review@openai-bundled': 'a plugin id is not an address',
  });
  const by = (rule) => found.filter((f) => f.rule === rule).map((f) => f.path);
  assert.deepEqual(by('S1'), ['$.a.accessToken', '$.b[0]', '$.b[1]', '$.b[2]']);
  assert.deepEqual(by('S2'), ['$.c.email', '$.c.email', '$.c.text', '$.c.accountId']);
  assert.deepEqual(by('S3'), ['$.d[0]', '$.d[2]', '$.d[3]', '$.d[4]']);
  assert.deepEqual(by('S4'), ['$.e[1]']);
  assert.ok(found.every((f) => !/someone|alex|sk-ABC|acct_1/.test(f.message)), 'the messages name the rule, never the value');
  assert.match(captureIssues({ ...ok({ '*': [{ client: 'initialize', result: { codexHome: '/Users/alex/.codex' } }] }) }).map((i) => i.message).join(), /S3: an owner path/);
});

test('sanitizeCapture: the first pass of recording; what it leaves passes every rule, and ids keep their grouping', () => {
  const raw = {
    params: { threadId: '0199F3A2-5B1C-7D4E-9F00-123456789ABC', cwd: '/Users/alex/work/repo', accessToken: 'abc', email: 'someone@example.com' },
    again: ['0199f3a2-5b1c-7d4e-9f00-123456789abc', 'turn 0199f3a2-5b1c-7d4e-9f00-000000000002 of /Volumes/Portable Drive/x', 'Bearer abcdefgh12345 from owner@example.org'],
  };
  const s = sanitizeCapture(raw);
  assert.deepEqual(sanitizationIssues(s), []);
  assert.equal(s.params.threadId, '019a0000-0000-7000-8000-000000000001');
  assert.equal(s.again[0], s.params.threadId, 'the same id, the same synthetic id');
  assert.equal(s.again[1], 'turn 019a0000-0000-7000-8000-000000000002 of /Volumes/volume/x');
  assert.equal(s.params.cwd, '/Users/user/work/repo');
  assert.deepEqual([s.params.accessToken, s.params.email], ['<redacted>', '<redacted>']);
  assert.equal(s.again[2], '<redacted> from <redacted-email>');
});

test('sessions: by label, "*", or the only one; with a claims directory, processes sharing a name take <name>.1, <name>.2 in order', async () => {
  const c = ok({ 'primary.1': [], 'primary.2': [], 'mod:a/k': [] });
  assert.equal(sessionScript(c, 'mod:a/k').label, 'mod:a/k');
  assert.throws(() => sessionScript(c, 'primary'), /no session 'primary'/);
  assert.equal(sessionScript(ok({ only: [] }), 'whatever').label, 'only');
  const claims = await mkdtemp(join(tmpdir(), 'claims-'));
  try {
    assert.equal(sessionScript(c, 'primary', claims).label, 'primary.1');
    assert.equal(sessionScript(c, 'primary', claims).label, 'primary.2');
    assert.throws(() => sessionScript(c, 'primary', claims), /no unclaimed session for 'primary'/);
  } finally { await rm(claims, { recursive: true, force: true }); }
});

test('contains: what the capture states must be there, deep; what it omits is not checked; arrays item by item; "$any"', () => {
  assert.ok(contains({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } }));
  assert.ok(!contains({ a: 1 }, { a: 2 }));
  assert.ok(!contains({ a: [1, 2] }, { a: [1] }), 'arrays are not prefixes');
  assert.ok(contains({ a: 'x' }, { a: '$any' }));
  assert.ok(!contains({}, { a: '$any' }));
  assert.ok(contains({ a: null }, { a: null }));
});

test('the protocol of a build: the four method lists of its schemas, experimental methods included when the build has them; the newest build is the default', () => {
  const p = protocolMethods('26.1007.30912-20156');
  assert.ok(p.clientRequest.has('thread/start') && p.serverNotification.has('mcpServer/startupStatus/updated') && p.serverRequest.has('item/tool/requestUserInput'));
  assert.deepEqual([...p.clientNotification], ['initialized']);
  assert.equal(p.experimental.size, 0, '20156 has no experimental schema in the repository');
  const q = protocolMethods('26.1013.40934-20770');
  assert.ok(q.clientRequest.has('thread/queue/list') && q.experimental.has('thread/queue/list'), 'an experimental client request');
  assert.ok(q.serverRequest.has('currentTime/read') && q.experimental.has('currentTime/read'), 'an experimental server request');
  assert.ok(!q.experimental.has('thread/start'));
  assert.match(newestBuild(), /^\d+\.\d+\.\d+-\d+$/);
});
