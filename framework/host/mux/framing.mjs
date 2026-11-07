// JSONL line framing with a hard per-frame size cap (ARCHITECTURE §6, requirement 1).
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
// A backend's frames: the app-server is trusted, and some of its answers are larger (its whole plugin catalog with the remote one was
// 21 MB on build 21477; a thread's history carries its images). The cap only stops a runaway backend.
export const MAX_BACKEND_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Incremental newline splitter. `onFrame(line)` receives each non-empty line as a string (without the newline).
 * A line longer than `maxBytes` calls `onOverflow()` once and silences the framer.
 * `maxBytes` is mutable so a connection can use a small cap for its first (authentication) line.
 */
export function createFramer({ maxBytes = MAX_FRAME_BYTES, onFrame, onOverflow }) {
  const framer = { maxBytes, dead: false, push };
  let chunks = [];
  let size = 0;

  function kill() { framer.dead = true; chunks = []; size = 0; onOverflow(); }

  function push(chunk) {
    if (framer.dead) return;
    if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8');
    let start = 0;
    while (start < chunk.length) {
      if (framer.dead) return;
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        const part = chunk.subarray(start);
        size += part.length;
        if (size > framer.maxBytes) return kill();
        chunks.push(part);
        return;
      }
      const part = chunk.subarray(start, nl);
      const total = size + part.length;
      if (total > framer.maxBytes) return kill();
      let line;
      if (chunks.length === 0) line = part;
      else { chunks.push(part); line = Buffer.concat(chunks, total); chunks = []; }
      size = 0;
      start = nl + 1;
      if (line.length > 0) onFrame(line.toString('utf8'));
    }
  }
  return framer;
}
