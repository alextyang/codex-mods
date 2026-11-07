// Run with: node --test
// The SDK's testing kit is `@codexmods/sdk/testing`; inside the codexmods repository it is loaded from the checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import rendererMod, { originBadges } from '../renderer.mjs';

const { createFakeRendererContext } = await import('@codexmods/sdk/testing').catch(() => import('../../../testing/index.mjs'));
const manifest = JSON.parse(fs.readFileSync(new URL('../mod.json', import.meta.url), 'utf8'));
const chat = (origin) => ({ ref: { type: 'CodexThread', provider: 'codex', id: origin }, state: { title: 'A chat', origin }, links: {} });

test('a chat that did not start from you gets a badge saying how it started; one you started gets none', () => {
  assert.deepEqual(originBadges(chat('fork')).map((b) => b.text), ['Fork']);
  assert.deepEqual(originBadges(chat('automation')).map((b) => b.text), ['Scheduled']);
  assert.deepEqual(originBadges(chat('delegation')).map((b) => b.text), ['Delegated']);
  assert.deepEqual(originBadges(chat('user')), []);
});

test('the rule is declared on chats, wherever the app shows them, and goes with the mod', async (t) => {
  const { control } = createFakeRendererContext({ manifest });
  t.after(() => control.cleanup());
  await control.activate(rendererMod);
  const rule = control.rules.get('origin');
  assert.deepEqual([rule.kind, rule.target], ['decorate', 'Thread']);
  assert.deepEqual(rule.spec.badges(chat('fork')).map((b) => b.text), ['Fork']);
  await control.deactivate();
  assert.equal(control.rules.has('origin'), false);
});

test('without its grant to present on chats, the app refuses the rule', async () => {
  const { control } = createFakeRendererContext({ manifest: { ...manifest, permissions: ['ui'] } });
  await assert.rejects(control.activate(rendererMod), (e) => e.code === 'Denied');
});
