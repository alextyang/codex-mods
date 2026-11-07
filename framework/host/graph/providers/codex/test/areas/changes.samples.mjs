// Every data branch of the changes area, including the links it maintains on a thread and its turns.
import { changeSetData } from '../../areas/changes.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  const meta = { threadId: 't', turnId: 'u', cwd: '/repo', environment: refs.localEnvironment('p') };
  const changes = [
    { path: 'add', kind: { type: 'add' }, diff: 'one\ntwo\n' },
    { path: '/repo/delete', kind: { type: 'delete' }, diff: 'gone\n' },
    { path: 'before', kind: { type: 'update', move_path: 'after' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    { path: 'update', kind: { type: 'update', move_path: null }, diff: '@@ -1,0 +1,2 @@\n+a\n+b\n' },
    { path: 'update', kind: { type: 'update' }, diff: '@@ -4,2 +5 @@\n-a\n-b\n+c\n' },
    { path: 'last-delete', kind: { type: 'add' }, diff: 'temporary' },
    { path: 'last-delete', kind: { type: 'delete' }, diff: 'temporary' },
  ];
  const entries = changes.map((change, i) => ({ ...meta, change, state: i % 2 ? 'proposed' : 'applied' }));
  const turn = changeSetData('turn', 'u', entries);
  const thread = changeSetData('thread', 't', [...entries, { ...meta, turnId: 'v', change: { path: 'add', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-one\n+three\n' }, state: 'reverted' }]);
  const empty = changeSetData('turn', 'empty', [{ ...meta, turnId: 'empty', environment: null }]);
  return [turn, thread, empty].flatMap((d) => [d.changeSet, ...d.files, ...d.hunks]).concat([
    { ref: refs.thread('t'), state: {}, links: { changes: thread.changeSet.ref } },
    { ref: refs.turn('u'), state: {}, links: { changes: turn.changeSet.ref } },
  ]);
}
