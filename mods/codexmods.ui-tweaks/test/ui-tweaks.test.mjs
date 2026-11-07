// codexmods.ui-tweaks: the tweaks as the app's own variables, the rules the host entry keeps, and the page where parts are chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { variablesOf, hidesOf, VARIABLES } from '../host.mjs';
import rendererMod, { hideable, keyOf } from '../renderer.mjs';

const { createTestGraph, createFakeRendererContext } = await import('../../../sdk/testing/index.mjs');
const here = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../mod.json', import.meta.url), 'utf8'));
const MOD = 'codexmods.ui-tweaks';

test('each tweak sets one of the app\'s variables to another of the app\'s; the app\'s own choice sets nothing', () => {
  assert.deepEqual(variablesOf({ width: 'default', chatText: 'default', codeText: 'default', rows: 'default' }), {});
  assert.deepEqual(variablesOf({ width: 'wider', chatText: 'larger', codeText: 'smaller', rows: 'compact' }), {
    '--thread-content-max-width': '--container-5xl', '--codex-chat-font-size-override': '--text-lg',
    '--codex-chat-code-font-size-override': '--text-xs', '--height-token-row': '--control-size-sm' });
  assert.deepEqual(variablesOf({ width: 'enormous' }), {}, 'an unknown choice sets nothing');
  for (const { variable, to } of Object.values(VARIABLES)) {
    assert.match(variable, /^--[a-z0-9-]+$/);
    for (const v of Object.values(to)) assert.match(v, /^--[a-z0-9-]+$/, 'never a raw value');
  }
  // every choice the manifest offers that is not the app's own maps to a variable
  const items = manifest.settings.flatMap((s) => s.items ?? [s]);
  for (const key of Object.keys(VARIABLES)) {
    const choices = items.find((s) => s.key === key).options.map((o) => o.value).filter((v) => v !== 'default');
    assert.deepEqual(choices.sort(), Object.keys(VARIABLES[key].to).sort(), key);
  }
});

test('hidden parts as one hide rule per place and slot; anything else in the list is left out', () => {
  assert.deepEqual(hidesOf(['Sidebar/sections/explore', 'Sidebar/sections/sites', 'Composer/toolbar/dictate', 'junk', 7, 'Sidebar/sections/explore']), [
    { presentation: 'Sidebar', slot: 'sections', parts: ['explore', 'sites'] },
    { presentation: 'Composer', slot: 'toolbar', parts: ['dictate'] },
  ]);
  assert.deepEqual(hideable([{ slot: 's', part: 'a', title: 'A', supported: true }, { slot: 's', part: 'b', title: 'B', supported: false },
    { slot: 's', part: 'c', title: 'C', supported: true, protected: true }, { slot: 's', part: 'd', title: 'D', supported: true, kinds: ['reorder'] }]).map((p) => p.part), ['a']);
});

test('the host entry keeps a style rule, the defaults and the hide rules for what is set, and follows a change', async (t) => {
  const g = await createTestGraph();
  t.after(() => g.close());
  const mod = await g.mod(here);
  assert.deepEqual(g.runtime.rulesOf(MOD), [], 'nothing while every tweak is the app\'s own');
  const r = mod.renderer();
  await r.settings.set('width', 'widest');
  await r.settings.set('hidden', ['Composer/toolbar/dictate']);
  await r.settings.set('expandSteps', true);
  const rules = await g.waitFor(() => { const x = g.runtime.rulesOf(MOD); return x.length >= 2 ? x : null; }, { what: 'the rules' });
  assert.ok(rules.some((x) => x.kind === 'style'));
  const hide = rules.find((x) => x.kind === 'hide');
  assert.deepEqual([hide.presentation, hide.slot], ['Composer', 'toolbar']);
  await r.settings.set('width', 'default');
  await g.waitFor(() => !g.runtime.rulesOf(MOD).some((x) => x.kind === 'style'), { what: 'the style rule gone' });
});

test('the Hidden parts page lists what each place draws that may be hidden, and checks what is hidden', async (t) => {
  const { ctx, control } = createFakeRendererContext({ manifest });
  t.after(() => control.cleanup());
  control.setParts('Sidebar', [{ slot: 'sections', part: 'explore', title: 'Explore', supported: true }, { slot: 'footer', part: 'settings', title: 'Settings', supported: true, protected: true }]);
  control.setParts('Composer', [{ slot: 'toolbar', part: 'dictate', title: 'Dictate', supported: true }]);
  await control.activate(rendererMod);
  await ctx.settings.set('hidden', [keyOf('Composer', { slot: 'toolbar', part: 'dictate' })]);
  const root = await control.render('parts');
  await root.until(() => /Explore/.test(root.text()) && /Dictate/.test(root.text()));
  assert.doesNotMatch(root.text().split('Show all')[1], /Settings/, 'a protected part is not offered');
  assert.match(root.text(), /Show all/);
});
