// Commit's nullable links and available/unknown immutable facts (breadth D7).
import { commitData } from '../../areas/history.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  return [
    commitData('p', { sha: 'a', message: ' First\n\nBody\n', author: 'Alex', committedAt: '2026-10-25T12:00:00Z', files: 2 }, { branch: refs.branch('p', 'work'), thread: refs.thread('t') }),
    commitData('p', { sha: 'b', message: 'Second', committedAt: '2026-10-24T12:00:00Z' }, { branch: null, thread: null }),
  ];
}
