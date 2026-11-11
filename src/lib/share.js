// Structural sharing for JSON-shaped data: returns `previous` (or the parts of it)
// wherever `next` holds equal values, so unchanged objects keep their identity and
// memoized components skip re-rendering. Every SSE `session` event delivers fresh
// objects for the whole transcript; this keeps the unchanged messages identical.

export function share(previous, next) {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  if (Array.isArray(next)) {
    let same = previous.length === next.length;
    const out = next.map((item, i) => {
      const shared = share(previous[i], item);
      if (shared !== previous[i]) same = false;
      return shared;
    });
    return same ? previous : out;
  }
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(previous).length;
  const out = {};
  for (const key of keys) {
    const shared = share(previous[key], next[key]);
    if (shared !== previous[key] || !Object.prototype.hasOwnProperty.call(previous, key)) same = false;
    out[key] = shared;
  }
  return same ? previous : out;
}

// Shares a message list by message id (robust to insertions), returning the previous
// array itself when nothing changed.
export function shareMessages(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return next;
  const byId = new Map();
  for (const message of previous) if (message?.id) byId.set(message.id, message);
  let same = previous.length === next.length;
  const out = next.map((message, i) => {
    const shared = message?.id && byId.has(message.id) ? share(byId.get(message.id), message) : message;
    if (shared !== previous[i]) same = false;
    return shared;
  });
  return same ? previous : out;
}
