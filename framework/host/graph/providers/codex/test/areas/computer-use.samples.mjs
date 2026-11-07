import { sessionData } from '../../areas/computer-use.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  return [
    sessionData('running', { status: 'running', app: refs.externalApp('com.apple.finder') }),
    sessionData('stopped', { status: 'stopped', app: null }),
  ];
}
