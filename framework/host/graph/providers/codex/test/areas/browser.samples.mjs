import { tabData } from '../../areas/browser.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  return [
    tabData({ conversationId: 't', browserTabId: 'one', url: 'https://example.com/', title: 'Example', loading: false, canGoBack: true, canGoForward: false, agent: false }, { thread: refs.thread('t') }),
    tabData({ conversationId: 'new-chat', browserTabId: 'two', url: '', title: '', loading: true, canGoBack: false, canGoForward: true, agent: true }, { thread: null }),
  ];
}
