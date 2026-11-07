// A mod from GitHub (docs/design/framework-ui.md F10): the latest release and its one .codexmod, found and fetched; what each failure says; redirects only to GitHub's hosts; bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGitHub, repoOf } from './github.mjs';

const body = (x) => { const b = Buffer.isBuffer(x) ? x : Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)); return { async *[Symbol.asyncIterator]() { yield b; }, destroy() {} }; };
const reply = (status, x = '', headers = {}) => ({ status, headers, body: body(x) });
function fake(routes) {
  const seen = [];
  const transport = async (url, headers, signal) => {
    seen.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(signal);
    return r ?? reply(404, { message: 'Not Found' });
  };
  return { transport, seen };
}
const API = 'https://api.github.com';
const PKG = Buffer.from('a signed package, as bytes');
const repoInfo = { id: 42, full_name: 'acme/focus' };
const release = (assets, tag = 'v1.2.0') => ({ tag_name: tag, body: 'Faster.', assets });
const asset = (name = 'focus-1.2.0.codexmod', url = 'https://github.com/acme/focus/releases/download/v1.2.0/focus-1.2.0.codexmod') => ({ name, size: PKG.length, browser_download_url: url });

test('a repository as owner/repository or its github.com address', () => {
  assert.equal(repoOf('acme/focus'), 'acme/focus');
  assert.equal(repoOf(' https://github.com/acme/focus.git/ '), 'acme/focus');
  for (const bad of ['acme', 'acme/focus/x', '../etc/passwd', 'acme/.git', 'https://evil.example/acme/focus', '', 'a b/c']) assert.equal(repoOf(bad), null, bad);
});

test('the latest release and its one .codexmod; downloaded through GitHub\'s redirect, with its digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cm-gh-'));
  try {
    const f = fake({
      [`${API}/repos/acme/focus`]: reply(200, repoInfo),
      [`${API}/repos/acme/focus/releases/latest`]: reply(200, release([asset(), { name: 'notes.txt', browser_download_url: 'x' }])),
      'https://github.com/acme/focus/releases/download/v1.2.0/focus-1.2.0.codexmod': reply(302, '', { location: 'https://objects.githubusercontent.com/abc?sig=1' }),
      'https://objects.githubusercontent.com/abc?sig=1': reply(200, PKG, { 'content-length': String(PKG.length) }),
    });
    const gh = createGitHub({ transport: f.transport });
    const rel = await gh.latest('acme/focus');
    assert.deepEqual(rel, { repo: 'acme/focus', repoId: 42, tag: 'v1.2.0', notes: 'Faster.', asset: { name: 'focus-1.2.0.codexmod', size: PKG.length, url: 'https://github.com/acme/focus/releases/download/v1.2.0/focus-1.2.0.codexmod' } });
    const out = await gh.download(rel.asset.url, join(dir, 'p.codexmod'));
    assert.deepEqual(out, { digest: `sha256:${createHash('sha256').update(PKG).digest('hex')}`, bytes: PKG.length });
    assert.deepEqual(await readFile(join(dir, 'p.codexmod')), PKG);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('what each failure says: no repository, no release, no package, two packages, the rate limit, no network', async () => {
  const gh = (routes) => createGitHub({ transport: fake(routes).transport });
  await assert.rejects(gh({}).latest('acme/gone'), (e) => e.code === 'Invalid' && /acme\/gone was not found on GitHub/.test(e.message));
  await assert.rejects(gh({ [`${API}/repos/acme/focus`]: reply(200, repoInfo) }).latest('acme/focus'), (e) => e.code === 'Invalid' && /acme\/focus has no release/.test(e.message));
  await assert.rejects(gh({ [`${API}/repos/acme/focus`]: reply(200, repoInfo), [`${API}/repos/acme/focus/releases/latest`]: reply(200, release([{ name: 'a.zip', browser_download_url: 'x' }])) }).latest('acme/focus'), /has no \.codexmod package/);
  await assert.rejects(gh({ [`${API}/repos/acme/focus`]: reply(200, repoInfo), [`${API}/repos/acme/focus/releases/latest`]: reply(200, release([asset('a.codexmod'), asset('b.codexmod')])) }).latest('acme/focus'), /has 2 \.codexmod packages/);
  await assert.rejects(gh({ [`${API}/repos/acme/focus`]: reply(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793750400' }) }).latest('acme/focus'),
    (e) => e.code === 'Unavailable' && /rate limit .* used up; it resets at \d\d:\d\d UTC/.test(e.message), 'never falls through to something else');
  await assert.rejects(gh({ [`${API}/repos/acme/focus`]: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }).latest('acme/focus'), (e) => e.code === 'Unavailable' && /Couldn’t reach github\.com \(ENOTFOUND\)/.test(e.message));
  await assert.rejects(gh({ [`${API}/repos/acme/focus`]: reply(500) }).latest('acme/focus'), (e) => e.code === 'Unavailable' && /answered 500/.test(e.message));
  await assert.rejects(gh({}).latest('not a repo'), /owner\/repository/);
});

test('a redirect goes only to GitHub\'s hosts, over HTTPS, a few times at most', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cm-gh-'));
  try {
    const start = 'https://github.com/acme/focus/releases/download/v1/p.codexmod';
    const away = createGitHub({ transport: fake({ [start]: reply(302, '', { location: 'https://evil.example/p.codexmod' }) }).transport });
    await assert.rejects(away.download(start, join(dir, 'a')), /went to https:\/\/evil\.example, which is not GitHub/);
    const plain = createGitHub({ transport: fake({ [start]: reply(302, '', { location: 'http://objects.githubusercontent.com/p' }) }).transport });
    await assert.rejects(plain.download(start, join(dir, 'b')), /http:\/\/objects\.githubusercontent\.com, which is not GitHub/);
    const loop = createGitHub({ transport: async () => reply(302, '', { location: start }) });
    await assert.rejects(loop.download(start, join(dir, 'c')), /too many redirects/);
    await assert.rejects(createGitHub({ transport: async () => reply(200, PKG) }).download('https://example.com/p', join(dir, 'd')), /not GitHub/, 'not even the first request');
    await assert.rejects(stat(join(dir, 'a')), 'nothing left behind');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bounded: a package larger than the limit is refused and removed, by what it says and by what it sends; a request that hangs ends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cm-gh-'));
  try {
    const url = 'https://objects.githubusercontent.com/p';
    const said = createGitHub({ maxBytes: 10, transport: async () => reply(200, 'x'.repeat(5), { 'content-length': '99' }) });
    await assert.rejects(said.download(url, join(dir, 'a')), /larger than/);
    const sent = createGitHub({ maxBytes: 10, transport: async () => reply(200, 'x'.repeat(50)) });
    await assert.rejects(sent.download(url, join(dir, 'b')), /larger than/);
    await assert.rejects(stat(join(dir, 'b')), 'a partial file is removed');
    const hang = createGitHub({ timeoutMs: 30, transport: (url2, h, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    await assert.rejects(hang.latest('acme/focus'), (e) => e.code === 'Unavailable' && /did not answer within/.test(e.message));
    const big = createGitHub({ maxBytes: 10, transport: fake({ [`${API}/repos/acme/focus`]: reply(200, repoInfo), [`${API}/repos/acme/focus/releases/latest`]: reply(200, release([{ ...asset(), size: 999 }])) }).transport });
    await assert.rejects(big.latest('acme/focus'), /larger than/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
