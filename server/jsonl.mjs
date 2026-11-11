// Streaming reads of JSON Lines files. Imported transcripts can be hundreds of megabytes,
// so they are read in fixed-size chunks with byte offsets for every line, and the event
// loop gets a turn between chunks so other sessions keep streaming meanwhile.
import fsp from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
// Longer lines (a pasted video, say) are skipped rather than buffered.
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Calls `onLine(text, offset, length)` for every non-empty line of `file`, in order, with
 * the byte offset and length of the line. Reading begins at the first whole line at or
 * after byte `start` and stops at `limit` bytes from the start of the file (a final line
 * cut by the limit is dropped) or when `onLine` returns false. A last line without a
 * newline (a file still being written) is passed as is.
 */
export async function forEachLine(file, onLine, { start = 0, limit = Infinity, chunkBytes = CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    // The start of a line that continues in the next chunk.
    let pending = [];
    let pendingBytes = 0;
    let pendingOffset = 0;
    // A start inside the file skips the rest of the line it falls in. Reading from the
    // byte before it tells whether a line begins right at `start` (that byte is a newline).
    let skipping = start > 0;
    let position = Math.max(0, start - 1);
    const emit = (line, offset) => {
      if (line.length === 0 || (line.length === 1 && line[0] === 0x0d)) return true;
      return onLine(line.toString('utf8'), offset, line.length) !== false;
    };

    while (position < limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, limit - position), position);
      if (bytesRead === 0) break;
      let start = 0;
      for (let newline = buffer.indexOf(NEWLINE, 0); newline !== -1 && newline < bytesRead; newline = buffer.indexOf(NEWLINE, start)) {
        let keepGoing = true;
        if (skipping) skipping = false;
        else if (pendingBytes) {
          pending.push(buffer.subarray(start, newline));
          if (pendingBytes + newline - start <= maxLineBytes) keepGoing = emit(Buffer.concat(pending), pendingOffset);
        } else if (newline - start <= maxLineBytes) {
          keepGoing = emit(buffer.subarray(start, newline), position + start);
        }
        pending = [];
        pendingBytes = 0;
        start = newline + 1;
        if (!keepGoing) return;
      }
      if (start < bytesRead && !skipping) {
        if (!pendingBytes) pendingOffset = position + start;
        pendingBytes += bytesRead - start;
        if (pendingBytes > maxLineBytes) {
          skipping = true;
          pending = [];
          pendingBytes = 0;
        } else pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
      }
      position += bytesRead;
      await nextTurn();
    }
    if (pendingBytes && position < limit) emit(Buffer.concat(pending), pendingOffset);
  } finally {
    await handle.close();
  }
}

/** The parsed JSON of one line, or null when it is not valid JSON. */
export function parseLine(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads the line at a known offset (from forEachLine) through an open file handle. */
export async function readLineAt(handle, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.toString('utf8', 0, bytesRead);
}
