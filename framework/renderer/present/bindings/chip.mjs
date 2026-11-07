// Chip (docs/graph/03): a compact reference. On 21477 a file attached to a draft is the file chip, whose props carry the file's path
// (`resourcePath`, with filename, folderPath, onClick, onRemove ...); it names the File at that path. Mentions are the composer editor's
// own nodes (no component props), not bound here. It passes through. Removing it from its draft (E7.1) is the app's own `onRemove()`, as
// its remove button calls it; opening it is its File's `open` (the windows provider's route). NO NODE API.
import { defineBinding } from '../runtime.mjs';

export const fileChip = defineBinding({
  id: 'chip.file', presentation: 'Chip',
  place: { in: null, slot: 'chips' },   // in a composer or a message: its props do not say which
  presents: ['File'],
  subject(props) {
    const p = props.resourcePath;
    return typeof p === 'string' && p.startsWith('/') ? { type: 'File', provider: 'codex', id: p } : null;
  },
  operations: {
    remove(props) {
      if (typeof props.onRemove !== 'function') return { unavailable: 'this chip cannot be removed' };
      props.onRemove();
      return true;
    },
  },
});
