// QueuedMessage instances produced by the queue area (breadth step D5).
import { queuedData } from '../../areas/queue.mjs';

export function produced() {
  return [queuedData('t', { id: 'q-1', clientUserMessageId: 'client-1', input: [{ type: 'text', text: 'Next', text_elements: [] }] })];
}
