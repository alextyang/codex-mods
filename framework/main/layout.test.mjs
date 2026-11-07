import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { layout } from '../../contracts/layout.mjs';

const { layout: cjsLayout } = createRequire(import.meta.url)('./layout.cjs');

test('layout.cjs is identical to contracts/layout.mjs', () => {
  for (const [root, profile] of [['/r', 'default'], ['/some/where else', 'qa-1']]) {
    assert.deepEqual({ ...cjsLayout(root, profile) }, { ...layout(root, profile) });
  }
  assert.deepEqual({ ...cjsLayout('/r') }, { ...layout('/r') });
});
