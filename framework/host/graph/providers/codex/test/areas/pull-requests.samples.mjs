// Pull requests in every board state, with details/reviewers and all of the area's links (breadth D7).
import { pullRequestData } from '../../areas/pull-requests.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  const item = { title: 'Draft', number: 1, url: 'https://github.com/o/r/pull/1', state: 'draft', ciStatus: 'pending', headBranch: 'work' };
  const draft = pullRequestData('p', item);
  return [draft,
    pullRequestData('p', { ...item, number: 2, url: 'https://github.com/o/r/pull/2', state: 'ready' }, {
      summary: { state: 'open', isDraft: false, title: 'Open', ciStatus: 'passing', headBranch: 'work' },
      reviews: { reviewStatus: 'approved', reviewers: { approved: ['alex'], changesRequested: [], commented: ['alex', 'sam'], requested: ['sam'] } }, thread: refs.thread('t'),
    }),
    pullRequestData('p', { ...item, number: 3, url: 'https://github.com/o/r/pull/3', state: 'merged', ciStatus: 'passing' }),
    { ref: refs.branch('p', 'work'), state: { name: 'work', current: true }, links: { repository: refs.repository('p'), pullRequest: draft.ref } },
  ];
}
