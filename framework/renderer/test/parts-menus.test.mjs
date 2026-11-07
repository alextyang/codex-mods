// The app's own parts in its menus (docs/design/public-hooks.md §3.10): a thread's or a project's menu entries hidden, relabelled and
// reordered by name, in submenus too, separators tidied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withParts, MENU_PARTS, threadMenus } from '../present/menus.mjs';
import { PARTS } from '../../shared/parts.mjs';

const items = () => [
  { id: 'rename-thread', message: { defaultMessage: 'Rename' } }, { id: 'pin-thread' }, { id: 'sep-a', type: 'separator' },
  { id: 'fork', items: [{ id: 'fork-into-local' }, { id: 'fork-into-worktree' }] },
  { id: 'copy-actions', items: [{ id: 'copy-deeplink' }, { id: 'copy-conversation-markdown' }] },
  { id: 'share-thread' }, { id: 'sep-b', type: 'separator' }, { id: 'archive-thread' }, { id: 'delete-thread' }];
const rule = (kind, extra) => ({ mod: 'unit.a', id: `${kind}-r`, kind, ...extra });

test('every mapped id names a part of the catalogue', () => {
  for (const part of Object.values(MENU_PARTS)) assert.ok(PARTS.Menu.items[part], part);
});

test('hide, relabel and reorder by part; submenus; separators tidied; no rule leaves the items as they are', () => {
  const same = items();
  assert.equal(withParts(same, []), same);
  const hidden = withParts(items(), [rule('hide', { part: ['delete', 'archive', 'share'] })]);
  assert.deepEqual(hidden.map((x) => x.id), ['rename-thread', 'pin-thread', 'sep-a', 'fork', 'copy-actions'], 'the last group gone with its separator');
  const sub = withParts(items(), [rule('hide', { part: ['copyLink'] })]);
  assert.deepEqual(sub.find((x) => x.id === 'copy-actions').items.map((x) => x.id), ['copy-conversation-markdown'], 'a child of a submenu');
  const relabelled = withParts(items(), [rule('decorate', { part: ['rename'], data: { label: 'Retitle' } }), rule('decorate', { part: ['rename'], data: { label: 'Second' }, id: 'later' })]);
  assert.equal(relabelled[0].message.defaultMessage, 'Retitle', 'the first in order wins');
  assert.match(relabelled[0].message.id, /^codexmods:label:unit\.a\//);
  const moved = withParts(items(), [rule('reorder', { slot: 'items', data: { order: ['delete', 'rename'] } })]);
  assert.deepEqual(moved.slice(0, 2).map((x) => x.id), ['delete-thread', 'rename-thread']);
  assert.equal(moved.length, items().length);
});

test('a thread menu applies the rules for its thread', () => {
  const menu = threadMenus(() => [], () => [rule('hide', { part: ['delete'] })]);
  const out = menu({ target: { conversationId: 't1' } }, items());
  assert.equal(out.some((x) => x.id === 'delete-thread'), false);
  const broken = threadMenus(() => [], () => { throw new Error('a rule threw'); });
  assert.equal(broken({ target: { conversationId: 't1' } }, items()).length, items().length, 'a fault leaves the app\'s entries');
});
