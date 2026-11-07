// A mod from GitHub and its updates (docs/design/framework-ui.md F10), on the real operations and packages with GitHub faked: install records where it came from; a check offers a
// newer release with what it adds; applying it is the update operation, which asks consent for what it adds or another repository; the packages it holds go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { harness, keygen } from './ops/test/harness.mjs';
import { createModUpdates } from './mod-updates.mjs';
import { consentRequestOf } from './ops/consent.mjs';
import { CodexModsError } from '../../sdk/errors.mjs';

/** GitHub as a map of repository -> its latest release (an archive built by the harness); `fail` makes every lookup fail. */
function fakeGitHub() {
  const releases = new Map();
  const g = {
    releases, fail: null, lookups: 0,
    asked: [],
    async latest(repo, opts = {}) {
      g.lookups++;
      g.asked.push(opts.mod ?? null);
      if (g.fail) throw g.fail;
      const r = releases.get(repo.toLowerCase());
      if (!r) throw new CodexModsError('Invalid', `${repo} was not found on GitHub`);
      return { repo: r.repo ?? repo, repoId: r.repoId, tag: r.tag, notes: r.notes ?? '', asset: { name: 'mod.codexmod', size: 1, url: `https://github.com/${repo.toLowerCase()}/releases/download/${r.tag}/mod.codexmod` } };
    },
    async download(url, dest) {
      const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url)[1];
      await copyFile(releases.get(repo).archive, dest);
      const bytes = await readFile(dest);
      return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length };
    },
  };
  return g;
}

async function setup(o = {}) {
  const H = await harness(o.harness);
  const gh = fakeGitHub();
  const dir = join(H.root, 'updates', 'mods');
  const changes = [];
  const mu = createModUpdates({ github: gh, operations: H.ops, packages: H.packages, compatibility: o.compatibility ?? ((m) => H.ops.compatibility(m)), dir });
  mu.onChange(() => changes.push(1));
  const release = async (repo, over, extra = {}) => { gh.releases.set(repo.toLowerCase(), { repoId: 7, tag: `v${over.version ?? '1.0.0'}`, archive: await H.pack(over, {}, extra.key), ...extra }); };
  const settle = (id) => H.ops.whenSettled(id);
  const left = async () => (await readdir(dir).catch(() => [])).length;
  /** The packages held, once a removal that follows an operation's end has happened (it is not awaited by the operation). */
  const settledLeft = async () => { for (let i = 0; i < 100 && (await left()) > 0; i++) await new Promise((r) => setTimeout(r, 10)); return left(); };
  return { H, gh, mu, dir, release, settle, left, settledLeft, changes };
}

test('install from GitHub: its latest release, installed as a file is, waiting for consent; the record says where it came from; the download goes', async () => {
  const { H, mu, release, settle, settledLeft } = await setup();
  try {
    await release('acme/focus', { version: '1.0.0', permissions: ['ui'], optionalPermissions: ['secrets', 'graph.read'] }, { repo: 'Acme/Focus', repoId: 42, notes: 'First.' });
    const op = await settle(await mu.install('acme/focus'));
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    const r = H.ops.state().mods['test.alpha'];
    assert.equal(r.status, 'pending-consent');
    assert.equal(r.source.kind, 'github');
    assert.deepEqual(consentRequestOf(r, {}).source, { repo: 'Acme/Focus', tag: 'v1.0.0', digest: r.source.digest }, 'its review shows the release');
    assert.deepEqual({ ...r.source, digest: r.source.digest.slice(0, 7) }, { kind: 'github', repo: 'Acme/Focus', repoId: 42, tag: 'v1.0.0', digest: 'sha256:' });
    assert.match(r.source.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await settledLeft(), 0, 'the downloaded package is not kept');
    // F8: Allow now: only an optional permission it declares, and one that can be allowed
    const c = await H.run({ type: 'consent', modId: 'test.alpha', approve: true, allow: ['secrets', 'network', 'ui'] });
    assert.equal(c.outcome, 'succeeded', JSON.stringify(c));
    const after = H.ops.state().mods['test.alpha'];
    assert.deepEqual(after.decisions, { secrets: 'allow', 'graph.read': 'deny' });
    assert.deepEqual(after.grants, ['ui', 'secrets']);
  } finally { await H.cleanup(); }
});

test('install from GitHub with a mod id: the package named for it, its record keeps the id and checks ask for it again; a package that is another mod is refused', async () => {
  const { H, gh, mu, release, settle, settledLeft } = await setup();
  try {
    await release('acme/many', { version: '1.0.0', permissions: ['ui'] }, { repoId: 43 });
    const wrong = await settle(await mu.install('acme/many', 'test.beta'));
    assert.equal(wrong.outcome, 'failed', 'the release\'s package for test.beta is test.alpha');
    assert.match(JSON.stringify(wrong.error ?? wrong), /package for test\.beta is test\.alpha/);
    assert.deepEqual(H.ops.state().mods, {}, 'nothing recorded');
    const op = await settle(await mu.install('acme/many', 'test.alpha'));
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    assert.equal(H.ops.state().mods['test.alpha'].source.mod, 'test.alpha');
    assert.equal(await settledLeft(), 0);
    assert.equal((await H.run({ type: 'consent', modId: 'test.alpha', approve: true })).outcome, 'succeeded');
    gh.asked.length = 0;
    await mu.check();
    assert.deepEqual(gh.asked, ['test.alpha'], 'a check looks for the same mod in the release');
  } finally { await H.cleanup(); }
});

test('install from GitHub: what the lookup says is what install says, and nothing is left behind', async () => {
  const { H, gh, mu, left } = await setup();
  try {
    await assert.rejects(mu.install('acme/none'), /acme\/none was not found on GitHub/);
    gh.fail = new CodexModsError('Unavailable', 'GitHub’s rate limit for requests without an account is used up. Try again later.');
    await assert.rejects(mu.install('acme/focus'), (e) => e.code === 'Unavailable');
    assert.equal(await left(), 0);
    assert.deepEqual(H.ops.state().mods, {});
  } finally { await H.cleanup(); }
});

test('a check offers a newer release with what it adds, its notes and whether it runs here; the same or an older one is not offered; a lookup that fails says why', async () => {
  const { H, gh, mu, release, settle, left, settledLeft, changes } = await setup();
  try {
    await release('acme/focus', { version: '1.0.0', permissions: ['ui'] }, { repoId: 42 });
    await settle(await mu.install('acme/focus'));
    await H.run({ type: 'consent', modId: 'test.alpha', approve: true, enable: true });
    await mu.check();
    assert.equal(mu.offerOf('test.alpha'), null, 'the release it runs');
    assert.equal(await settledLeft(), 0);
    await release('acme/focus', { version: '1.1.0', permissions: ['ui', 'graph.read'] }, { repoId: 42, notes: 'Reads files.' });
    await mu.check();
    assert.deepEqual(mu.offerOf('test.alpha'), { version: '1.1.0', notes: 'Reads files.', addedPermissions: ['graph.read'], verdict: 'compatible', publisherChange: false, tag: 'v1.1.0' });
    assert.equal(await left(), 1, 'the package offered is kept to apply');
    assert.ok(changes.length >= 2);
    gh.fail = new CodexModsError('Unavailable', 'Couldn’t reach github.com (ENOTFOUND). Check your connection and try again.');
    await mu.check();
    assert.match(mu.problemOf('test.alpha'), /Couldn’t reach github\.com/);
    assert.ok(mu.offerOf('test.alpha'), 'a failed look keeps what was offered');
    gh.fail = null;
    await release('acme/focus', { version: '0.9.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    assert.equal(mu.problemOf('test.alpha'), null);
    assert.equal(mu.offerOf('test.alpha'), null, 'an older release is not offered, and what was offered goes');
    assert.equal(await settledLeft(), 0);
    await release('acme/focus', { id: 'test.other', version: '2.0.0' }, { repoId: 42 });
    await mu.check();
    assert.match(mu.problemOf('test.alpha'), /its latest release is test\.other, not test\.alpha/);
    await release('acme/focus', { version: '2.0.0', permissions: ['ui'] }, { repoId: 42, key: keygen() });
    await mu.check();
    assert.equal(mu.offerOf('test.alpha').publisherChange, true, 'another publisher is offered, and its consent says so');
    // one at a time: two checks at once share one
    const lookups = gh.lookups;
    await Promise.all([mu.check(), mu.check()]);
    assert.equal(gh.lookups, lookups + 1);
  } finally { await H.cleanup(); }
});

test('applying an offer is the update operation: one that adds nothing goes through and records the release; one that adds a permission or comes from another repository waits for consent', async () => {
  const { H, mu, release, settle, settledLeft } = await setup();
  try {
    await release('acme/focus', { version: '1.0.0', permissions: ['ui'] }, { repoId: 42 });
    await settle(await mu.install('acme/focus'));
    await H.run({ type: 'consent', modId: 'test.alpha', approve: true, enable: true });
    await assert.rejects(mu.apply('test.alpha'), (e) => e.code === 'Invalid' && /check for updates first/.test(e.message));
    await release('acme/focus', { version: '1.1.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    let op = await settle(await mu.apply('test.alpha'));
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    let r = H.ops.state().mods['test.alpha'];
    assert.equal(r.version, '1.1.0');
    assert.equal(r.source.tag, 'v1.1.0');
    assert.equal(mu.offerOf('test.alpha'), null);
    assert.equal(await settledLeft(), 0);
    // another repository (another id: not a rename) and a permission added: consent, which records where it now comes from
    await release('acme/focus', { version: '1.2.0', permissions: ['ui', 'graph.read'] }, { repo: 'Other/Focus', repoId: 99 });
    await mu.check();
    assert.deepEqual(mu.offerOf('test.alpha').repoChange, { from: 'acme/focus', to: 'Other/Focus' });
    op = await settle(await mu.apply('test.alpha'));
    r = H.ops.state().mods['test.alpha'];
    assert.equal(r.version, '1.1.0', 'it keeps running as it is');
    assert.deepEqual(r.pendingUpdate.repoChange, { from: 'acme/focus', to: 'Other/Focus', another: true });
    assert.deepEqual(r.pendingUpdate.addedPermissions, ['graph.read']);
    assert.deepEqual(consentRequestOf(r, {}).source.tag, 'v1.2.0', 'the review shows the release it is for, not the one it runs');
    const c = await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
    assert.equal(c.outcome, 'succeeded', JSON.stringify(c));
    r = H.ops.state().mods['test.alpha'];
    assert.equal(r.version, '1.2.0');
    assert.deepEqual([r.source.repo, r.source.repoId, r.source.tag], ['Other/Focus', 99, 'v1.2.0']);
    // a rename (the same id) also asks: the repository is where to look, and it changed
    await release('acme/focus', { version: '1.3.0', permissions: ['ui', 'graph.read'] }, { repo: 'other/focus-mod', repoId: 99 });
    r.source.repo = 'Other/Focus';
    await mu.check();
    // the record now says Other/Focus: a lookup of it answers with the renamed repository
    await release('other/focus', { version: '1.3.0', permissions: ['ui', 'graph.read'] }, { repo: 'other/focus-mod', repoId: 99 });
    await mu.check();
    assert.deepEqual(mu.offerOf('test.alpha').repoChange, { from: 'Other/Focus', to: 'other/focus-mod' });
    op = await settle(await mu.apply('test.alpha'));
    assert.deepEqual(H.ops.state().mods['test.alpha'].pendingUpdate.repoChange, { from: 'Other/Focus', to: 'other/focus-mod' }, 'renamed: not another');
  } finally { await H.cleanup(); }
});

test('an update that cannot run here is offered, so it shows, and never applied; a mod updated from a file is no longer checked on GitHub', async () => {
  let verdict = 'compatible';
  const { H, gh, mu, release, settle } = await setup({ compatibility: () => ({ status: verdict }) });
  try {
    await release('acme/focus', { version: '1.0.0', permissions: ['ui'] }, { repoId: 42 });
    await settle(await mu.install('acme/focus'));
    await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
    verdict = 'blocked';
    await release('acme/focus', { version: '1.1.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    assert.equal(mu.offerOf('test.alpha').verdict, 'blocked');
    await assert.rejects(mu.apply('test.alpha'), (e) => e.code === 'Incompatible');
    const op = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.5.0', permissions: ['ui'] }) });
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    assert.deepEqual(H.ops.state().mods['test.alpha'].source, { kind: 'file' });
    const lookups = gh.lookups;
    await mu.check();
    assert.equal(gh.lookups, lookups, 'not looked up');
    assert.equal(mu.offerOf('test.alpha'), null, 'what was offered goes');
  } finally { await H.cleanup(); }
});

test('the packages left from an earlier run go; the one offered stays', async () => {
  const { H, mu, dir, release, settle, left, settledLeft } = await setup();
  try {
    await release('acme/focus', { version: '1.0.0' }, { repoId: 42 });
    await settle(await mu.install('acme/focus'));
    await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
    await release('acme/focus', { version: '1.1.0' }, { repoId: 42 });
    await mu.check();
    assert.equal(await settledLeft(), 1);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'stale.codexmod'), 'x');
    assert.equal(await left(), 2);
    await mu.sweep();
    assert.equal(await left(), 1);
    assert.ok(mu.offerOf('test.alpha'));
  } finally { await H.cleanup(); }
});

test('apply installs the package that was checked or nothing: one put in its place is refused by its digest; an offer no longer newer than what runs is not shown or applied, nor is an older release (FU5/FU6 review)', async () => {
  const { H, mu, dir, release, settle } = await setup();
  try {
    await release('acme/focus', { version: '1.0.0', permissions: ['ui'] }, { repoId: 42 });
    await settle(await mu.install('acme/focus'));
    await H.run({ type: 'consent', modId: 'test.alpha', approve: true });
    await release('acme/focus', { version: '1.1.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    const [held] = await readdir(dir);
    await copyFile(await H.pack({ version: '1.2.0', permissions: ['ui'] }), join(dir, held));
    const op = await settle(await mu.apply('test.alpha'));
    assert.equal(op.outcome, 'failed');
    assert.match(op.error.message, /not the one that was found: its digest changed/);
    assert.equal(H.ops.state().mods['test.alpha'].version, '1.0.0', 'nothing installed');
    // a newer file since: what was offered is no longer an update
    await release('acme/focus', { version: '1.1.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    assert.equal(mu.offerOf('test.alpha').version, '1.1.0');
    const file = await H.run({ type: 'update', modId: 'test.alpha', source: await H.pack({ version: '1.5.0', permissions: ['ui'] }) });
    assert.equal(file.outcome, 'succeeded', JSON.stringify(file));
    assert.equal(mu.offerOf('test.alpha'), null, 'not shown');
    await assert.rejects(mu.apply('test.alpha'), (e) => e.code === 'Invalid' && /not newer than what it runs/.test(e.message));
    // the operation itself: a release from GitHub only moves forward
    const older = await H.pack({ version: '1.4.0', permissions: ['ui'] });
    const digest = `sha256:${createHash('sha256').update(await readFile(older)).digest('hex')}`;
    const back = await H.run({ type: 'update', modId: 'test.alpha', source: older, github: { repo: 'acme/focus', repoId: 42, tag: 'v1.4.0', digest } });
    assert.equal(back.outcome, 'failed');
    assert.match(back.error.message, /1\.4\.0 is not newer than 1\.5\.0/);
  } finally { await H.cleanup(); }
});

test('a newer release found while an update is in its health window is still offered once that update ends, and the package it reads is never removed under it (found natively)', async () => {
  const { H, mu, dir, release, settle } = await setup({ harness: { healthWindowMs: 400 } });
  try {
    await release('acme/focus', { version: '1.0.0', permissions: ['ui'] }, { repoId: 42 });
    await settle(await mu.install('acme/focus'));
    await H.run({ type: 'consent', modId: 'test.alpha', approve: true, enable: true });
    await release('acme/focus', { version: '1.1.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    const applying = await mu.apply('test.alpha');
    await release('acme/focus', { version: '1.2.0', permissions: ['ui'] }, { repoId: 42 });
    await mu.check();
    assert.equal(H.ops.get(applying).outcome, 'running', 'the check ran while the update waited');
    const op = await settle(applying);
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    assert.equal(H.ops.state().mods['test.alpha'].version, '1.1.0');
    assert.equal(mu.offerOf('test.alpha')?.version, '1.2.0', 'the newer one stays offered');
    for (let i = 0; i < 100 && (await readdir(dir)).length > 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await readdir(dir)).length, 1, 'only its package is kept');
    const next = await settle(await mu.apply('test.alpha'));
    assert.equal(next.outcome, 'succeeded', JSON.stringify(next));
    assert.equal(H.ops.state().mods['test.alpha'].version, '1.2.0');
  } finally { await H.cleanup(); }
});
