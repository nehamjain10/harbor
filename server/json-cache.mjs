// JSON of transcript messages, kept between publishes and saves. A long session holds tens
// of thousands of messages (50+ MB of JSON), and stringifying all of them on every
// publish and save blocked the event loop for ~0.4 s each time; with several model
// agents streaming into one session that never let up, and the server stopped answering.
//
// Messages are changed in place all over the server (a tool card's state, its task, a
// delivery mark), so nothing tells us which ones changed. Instead each cached value keeps
// a shadow: a copy of its objects and arrays that shares its strings. A value whose
// shadow still matches it (same keys in the same order, same primitives) has the JSON it
// had; comparing is ~7x cheaper than stringifying (strings compare by reference first)
// and takes no copies of the text. A value that changed is stringified again.

const cache = new WeakMap();
// The shadow of anything but a plain object or array (a Date, a Map): never matches.
const NEVER = Symbol('never');

function shadowOf(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(shadowOf);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return NEVER;
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = shadowOf(value[key]);
  return copy;
}

function matches(shadow, value) {
  if (shadow === value) return true;
  if (shadow === null || value === null || typeof shadow !== 'object' || typeof value !== 'object') return false;
  if (Array.isArray(shadow)) {
    if (!Array.isArray(value) || shadow.length !== value.length) return false;
    for (let i = 0; i < shadow.length; i++) if (!matches(shadow[i], value[i])) return false;
    return true;
  }
  if (Array.isArray(value)) return false;
  const keys = Object.keys(shadow);
  const now = Object.keys(value);
  if (keys.length !== now.length) return false;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== now[i] || !matches(shadow[keys[i]], value[keys[i]])) return false;
  }
  return true;
}

/**
 * `JSON.stringify(value)` for a plain-data object (a message), reusing the last result
 * while the object is unchanged.
 */
export function cachedJson(value) {
  const entry = cache.get(value);
  if (entry && matches(entry.shadow, value)) return entry.json;
  const json = JSON.stringify(value);
  cache.set(value, { shadow: shadowOf(value), json });
  return json;
}
