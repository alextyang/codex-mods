// Every branch of Notification data, for realizes.test.mjs.
import { notificationData } from '../../areas/notifications.mjs';

export function produced() {
  return [
    notificationData({ id: 'finished', kind: 'turn-complete', title: 'Finished', body: 'Done', conversationId: 't' }, { read: false, createdAt: 1, failed: false }),
    notificationData({ id: 'failed', kind: 'turn-complete' }, { read: true, createdAt: 2, failed: true }),
    notificationData({ id: 'approval', kind: 'permission', title: null, body: null }, { read: false, createdAt: 3, failed: false }),
    notificationData({ id: 'question', kind: 'question', conversationId: '' }, { read: true, createdAt: 4, failed: false }),
    notificationData({ id: 'agent', kind: 'agent-message' }, { read: false, createdAt: 5, failed: false }),
    notificationData({ id: 'other', kind: '__proto__' }, { read: false, createdAt: 6, failed: true }),
  ];
}
