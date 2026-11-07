// Live text (docs/design/public-hooks.md §3.13): a host-realm declaration's text follows its subject in the page, through the one
// grammar's paths and the reader's rules; `update` changes a declaration in place (framework/host/test/ui-rules.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveValue, isLive, hasRelative, valueOf, seenBy } from '../present/rules.mjs';

const P = { type: 'Project', provider: 'codex', id: 'p1' };
const thread = { ref: { type: 'CodexThread', provider: 'codex', id: 't1' }, state: { status: 'working', context: { used: 0.42 }, startedAt: 1_000_000 }, links: { project: P },
  attached: { 'm.one': { tag: 'red' }, 'm.two': { secret: 's' } }, attachedPrivate: ['m.two/secret'] };
const project = { ref: P, state: { title: 'Repo' }, summary: { title: 'Repo' } };
const env = (reads = '*') => ({ relation: (t, n) => n === 'project', related: (i, n) => (n === 'project' && (reads === '*' || reads.includes('Project')) ? project : undefined),
  attached: (i, m) => (m === 'm.two' ? undefined : i.attached?.[m]) });

test('templates, binds, formats and when', () => {
  const now = 1_000_000 + 5 * 60_000;
  assert.equal(liveValue('{{status}} · {{context.used|percent}}', thread, env(), now), 'working · 42%');
  assert.equal(liveValue({ bind: 'startedAt', format: 'relative' }, thread, env(), now), '5m ago');
  assert.equal(liveValue('{{project}} / {{project.title}}', thread, env(), now), 'Repo / Repo', 'a relation reads as its title');
  assert.equal(liveValue('{{project.title}}', thread, env([]), now), '', 'a target the mod may not read is empty');
  assert.equal(liveValue('{{@m.one/tag}}', thread, env(), now), 'red');
  assert.equal(liveValue('{{@m.two/secret}}', thread, env(), now), '', 'another mod\'s private value is empty');
  assert.equal(liveValue('{{missing}}!', thread, env(), now), '!');
  const badges = [{ id: 'a', text: '{{status}}', when: { status: 'working' } }, { id: 'b', text: 'idle', when: { status: 'done' } }, { id: 'c', text: 'always', run: { $fn: 'badges.2.run' } }];
  assert.deepEqual(liveValue(badges, thread, env(), now), [{ id: 'a', text: 'working' }, { id: 'c', text: 'always', run: { $fn: 'badges.2.run' } }]);
  assert.equal(liveValue({ text: 'x', when: { status: 'done' } }, thread, env(), now), undefined, 'a field whose when does not hold is absent');
  assert.equal(liveValue({ bind: 'context', format: 'percent' }, thread, env(), now), '', 'an object is not text');
});

test('what is live, what is relative, and valueOf applying it as the rule\'s mod sees the subject', () => {
  assert.equal(isLive('plain'), false);
  assert.equal(isLive([{ text: '{{status}}' }]), true);
  assert.equal(isLive({ text: 'x', when: { status: 'a' } }), true);
  assert.equal(hasRelative({ badges: [{ text: '{{startedAt|relative}}' }] }), true);
  assert.equal(hasRelative({ label: { bind: 'startedAt', format: 'relative' } }), true);
  assert.equal(hasRelative({ label: 'x' }), false);
  const rules = { env: () => env(), guard: (r, fn) => fn };
  assert.equal(valueOf(rules, { mod: 'm.one', data: { label: 'ctx {{context.used|percent}}' } }, 'label', thread), 'ctx 42%');
  let seen;
  valueOf(rules, { mod: 'm.one', fns: { label: (s) => { seen = s; return 'x'; } } }, 'label', thread);
  assert.deepEqual(seen.attached, { 'm.one': { tag: 'red' } }, 'a function sees its own and the shared values only');
  assert.equal(seen.attachedPrivate, undefined);
  assert.equal(seenBy(thread, 'm.two').attached['m.two'].secret, 's', 'its own private value');
});
