// Every branch of the composer's Draft, tray attachment and custom prompt data, for realizes.test.mjs.
import { draftData, attachmentData, slashCommandData } from '../../areas/composer.mjs';

export function produced() {
  return [
    draftData('t', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft' }] }] }),
    slashCommandData({ id: 'review', description: 'Review', argumentHint: 'PATH', content: 'Review this' }),
    slashCommandData({ id: 'empty', description: '' }),
    attachmentData('t', { id: 'a1', kind: 'file', name: 'a.txt', path: '/Users/q/repo/a.txt' }),
    attachmentData('t', { id: 'a2', kind: 'image', name: 'shot.png' }),
  ];
}
