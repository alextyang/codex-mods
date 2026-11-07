// What the setup app carries of the tree: what setup installs as the framework and the setup app's page and server, never tests, the
// adapter tooling or the app's own sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carried, CARRIED } from '../build.mjs';

test('the app carries the framework tree and the setup page, without tests, tooling or its own sources', () => {
  for (const yes of ['framework/host/main.mjs', 'framework/catalog.json', 'sdk/testing/core.mjs', 'adapters/26.1027.30824-22943/adapter.json', 'mods/codexmods.live-usage/mod.json', 'package.json',
    'setup-app/server.mjs', 'setup-app/ui/setup.js', 'cli/commands/setup.mjs']) assert.equal(carried(yes), true, yes);
  for (const no of ['framework/host/test/x.mjs', 'mods/codexmods.live-usage/test/a.test.mjs', 'setup-app/test/steps.test.mjs', 'adapters/tools/js-shape.mjs', 'contracts/upstream/x.json',
    'setup-app/mac/main.swift', 'setup-app/build.mjs', 'docs/AUTHORING.md', 'scripts/release/mods.mjs', 'framework/.DS_Store', 'GOAL.md']) assert.equal(carried(no), false, no);
  assert.ok(CARRIED.includes('setup-app'));
});
