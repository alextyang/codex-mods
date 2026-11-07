// Review's supported targets and a model finding (breadth step D7), for realizes.test.mjs.
import { refs, userContent } from '../../map.mjs';

export function produced() {
  const content = (text) => userContent([{ type: 'text', text }]);
  return [
    ...[refs.changeSet('thread', 't'), refs.branch('p', 'main'), 'main', null].map((target, i) => ({
      ref: refs.review(`review-${i}`),
      state: { status: 'done', target, reviewer: refs.agent(), overview: content('Reviewed the changes.') },
      links: { thread: refs.thread('t'), turn: refs.turn(`review-${i}`) },
    })),
    { ref: refs.finding('review-0', 0), state: { title: '[P1] Keep the check', detail: content('An unchecked value reaches the caller.'), severity: 'high', state: 'open', location: { path: 'a.js', line: 3 } }, links: { review: refs.review('review-0') } },
  ];
}
