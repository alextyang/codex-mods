// Drafts, sent diff comments and pull-request review threads (breadth D7), for realizes.test.mjs.
import { refs } from '../../map.mjs';
import { commentData } from '../../areas/comments.mjs';

export function produced() {
  const comment = { type: 'comment', content: [{ content_type: 'text', text: 'Keep the guard.' }],
    position: { path: 'a.js', side: 'right', start_line: 2, line: 4 }, localWorkspaceRoot: '/repo' };
  return [
    commentData('t', comment, { fileChange: refs.fileChange('thread:t', '/repo/a.js'), finding: refs.finding('review', 0) }),
    commentData('t', comment, { state: 'sent', id: 'sent-t:message-1' }),
    commentData('t', { ...comment, reviewThreadId: 'review-thread', isResolved: true }),
  ];
}
