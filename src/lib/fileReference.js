// Decides whether a markdown link points at a file in the project (so it opens in
// the side panel) and extracts the path and line. Ported from v1's
// public/conversation-model.js.
//
// Accepted forms: `src/app.js`, `src/app.js:42`, `src/app.js:42-50`, `src/app.js#L42`,
// `/__file/<encoded path>#L42` (our own rewritten links), and same-origin http(s) URLs
// of those. Returns `{ path, line }` or null.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// `server.mjs:40` looks like a URL scheme; treat it as a file when the "scheme" has a
// file extension and the rest is a line number or range.
const FILE_WITH_LINE = /^([^/:]+\.[a-z0-9_-]+):\d+(?:-\d+)?$/i;
const LINE_SUFFIX = /(?::(\d+)(?:-\d+)?|#L?(\d+)(?:-L?\d+)?)$/i;
const HAS_EXTENSION = /(?:^|\/)[^/]+\.[a-zA-Z0-9_-]+$/;

export const FILE_LINK_PREFIX = '/__file/';

export function fileReference(href, origin) {
  if (!href || href.startsWith('#')) return null;
  let value = href;

  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.origin !== origin) return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  } else if (SCHEME.test(value) && !FILE_WITH_LINE.test(value)) {
    return null;
  }

  if (value.startsWith(FILE_LINK_PREFIX)) value = value.slice(FILE_LINK_PREFIX.length);
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (value.includes('?') || value.startsWith('//')) return null;

  let line = null;
  const match = value.match(LINE_SUFFIX);
  if (match) {
    line = Number(match[1] || match[2]);
    value = value.slice(0, match.index);
  }
  if (!HAS_EXTENSION.test(value)) return null;
  return { path: value, line: line > 0 ? line : null };
}

// The href we render for a file reference; DOMPurify keeps it (no unknown scheme)
// and fileReference() can read it back.
export function fileHref(ref) {
  return FILE_LINK_PREFIX + encodeURIComponent(ref.path) + (ref.line ? '#L' + ref.line : '');
}
