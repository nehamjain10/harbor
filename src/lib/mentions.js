// Composer autocomplete: detecting an `@` file mention or a `/` command at the caret,
// fuzzy matching, and replacing the typed token with the chosen item.

// Characters that may sit right before an `@` that starts a mention. Anything else
// (a letter, digit, dot…) means the `@` is inside a word, like an email address.
const MENTION_BEFORE = /[\s([{"'`]/;

// End of the token that starts at `start`: the first whitespace at or after it.
function tokenEnd(text, start) {
  const rest = text.slice(start);
  const match = rest.match(/\s/);
  return match ? start + match.index : text.length;
}

// Returns the autocomplete trigger at `caret`, or null:
//   { type: 'command', query, start, end }  `/` as the first character, caret in that word
//   { type: 'mention', query, start, end }  `@` at the start of a word
// `start`..`end` is the whole token (including the part after the caret), so picking
// an item replaces it and keeps the rest of the text.
export function detectTrigger(text, caret) {
  if (typeof text !== 'string' || caret == null || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);

  if (text.startsWith('/') && caret >= 1 && !/\s/.test(before)) {
    return { type: 'command', query: before.slice(1), start: 0, end: tokenEnd(text, 0) };
  }

  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s@]/.test(query)) return null;
  if (at > 0 && !MENTION_BEFORE.test(text[at - 1])) return null;
  return { type: 'mention', query, start: at, end: tokenEnd(text, at) };
}

// Replaces the trigger's token with `replacement`. Returns { text, caret } with the
// caret right after the inserted text. A trailing space is not doubled when the rest
// of the text already starts with whitespace.
export function insertToken(text, trigger, replacement) {
  const head = text.slice(0, trigger.start);
  const rest = text.slice(trigger.end);
  const inserted = replacement.endsWith(' ') && /^\s/.test(rest) ? replacement.slice(0, -1) : replacement;
  const next = head + inserted + rest;
  // After the inserted text, and past the existing space when that one was reused.
  return { text: next, caret: Math.min(head.length + replacement.length, next.length) };
}

// Text for a picked file or folder: `@path ` (folders keep a trailing `/` and no
// space, so the menu reopens on the folder's contents).
export function mentionText(item) {
  const path = String(item.path || '').replace(/\/+$/, '');
  return item.directory ? `@${path}/` : `@${path} `;
}

// Fuzzy score of `query` against `target` (higher is better), or -1 when the query's
// characters do not all appear in order. Rewards prefix and word-boundary matches
// and consecutive runs; penalizes gaps and long targets.
export function fuzzyScore(query, target) {
  const q = String(query || '').toLowerCase();
  const t = String(target || '').toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return (/[\s/_\-.:]/.test(t[at - 1]) ? 600 : 400) - at - t.length / 10;

  let score = 0;
  let ti = 0;
  let previous = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    if (found === previous + 1) score += 6;
    else if (found === 0 || /[\s/_\-.:]/.test(t[found - 1])) score += 4;
    else score -= Math.min(found - ti, 6);
    previous = found;
    ti = found + 1;
  }
  return 100 + score - t.length / 10;
}

// Items whose `key(item)` fuzzy-matches `query`, best first (stable for ties).
export function fuzzyFilter(items, query, key = (item) => item) {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, key(item)) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
