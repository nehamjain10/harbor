// Tail loading: a client opens a long session with only the recent end of its messages
// (GET /api/sessions/:id?tail=N) and loads older pages as the reader scrolls up
// (GET /api/sessions/:id/messages?before=I&limit=N). A window is always a suffix of the
// message list, and where it starts is chosen so the client renders it the way it
// renders the whole list:
//   - every message under an agent (`parentToolId`) comes with the agent's call, and a
//     background agent's end notice (`agentToolId`) with its card (tool results are
//     stored on their call, so a call and its result are one message);
//   - live messages are always in it: running tool calls (the agents strip, the agents
//     dialog), messages Claude has not read yet (`delivery: 'sent'`) and the user
//     message of the running turn (`currentMessageId`, the working row's timer);
//   - it starts at a top-level message: a turn's user message when one starts within
//     twice the limit, else the nearest boundary that keeps the above (further back, or
//     later while the window keeps half the limit);
//   - fewer than half the limit left before it come along (no page that small).

// Queued, mid-turn and cancelled messages are not the start of a turn (see
// src/lib/transcript.js HIDDEN_DELIVERY).
const HIDDEN_DELIVERY = new Set(['queued', 'sent', 'cancelled']);

// The default page of GET /api/sessions/:id/messages, and the most either route sends.
export const DEFAULT_PAGE = 300;
export const MAX_LIMIT = 1_000_000;

/** A positive whole number of messages from a query value, or null when it is not one. */
export function parseLimit(value) {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 ? Math.min(limit, MAX_LIMIT) : null;
}

function isTurnStart(message) {
  return message.role === 'user' && !message.parentToolId && !HIDDEN_DELIVERY.has(message.delivery);
}

function isLive(message, currentMessageId) {
  if (message.role === 'tool' && message.state === 'running') return true;
  if (message.role === 'user' && !message.parentToolId && message.delivery === 'sent') return true;
  return Boolean(currentMessageId) && message.id === currentMessageId;
}

/**
 * The index where a window of `messages` starts when the client is to hold everything
 * from there on: for a tail `end` is the length of the list; for an older page it is
 * the index of the first message the client holds, and the page is [start, end).
 * About `limit` messages before `end`, never fewer than one (unless `end` is 0) and
 * never more than needed by the rules above. O(n).
 */
export function windowStart(messages, { end = messages.length, limit = DEFAULT_PAGE, currentMessageId = null } = {}) {
  const n = messages.length;
  end = Math.max(0, Math.min(end, n));
  const target = end - Math.max(1, limit);
  if (target <= 0) return 0;

  // Where each tool call is (its first message with that id, as the transcript reads it).
  const callAt = new Map();
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.toolId && !callAt.has(m.toolId)) callAt.set(m.toolId, i);
  }
  // The earliest message every window must hold: the first live one.
  let lowest = n;
  for (let i = 0; i < n; i++) {
    if (isLive(messages[i], currentMessageId)) {
      lowest = i;
      break;
    }
  }
  // valid[c]: a window starting at c holds what every message in it needs (the lowest
  // index anything in [c, n) needs is c or later) and starts at a top-level message.
  const valid = new Uint8Array(end);
  valid[0] = 1;
  for (let i = n - 1; i >= 1; i--) {
    const m = messages[i];
    for (const ref of [m.parentToolId, m.agentToolId]) {
      if (!ref) continue;
      const at = callAt.get(ref);
      if (at !== undefined && at < lowest) lowest = at;
    }
    if (i < end && lowest >= i && !m.parentToolId) valid[i] = 1;
  }

  // A turn's start, within twice the limit.
  const floor = Math.max(0, end - 2 * Math.max(1, limit));
  let start = -1;
  for (let c = target; c >= floor && start < 0; c--) if (valid[c] && isTurnStart(messages[c])) start = c;
  if (start < 0) {
    // Else the nearest boundary: further back (any distance), or a little later as long
    // as the window keeps at least half the limit.
    let down = target;
    while (down > 0 && !valid[down]) down--;
    const ceiling = end - Math.ceil(Math.max(1, limit) / 2);
    let up = target + 1;
    while (up <= ceiling && !valid[up]) up++;
    start = up <= ceiling && up - target < target - down ? up : down;
  }
  // Less than half a page left before it: that comes along rather than as a page of its own.
  return start < limit / 2 ? 0 : start;
}
