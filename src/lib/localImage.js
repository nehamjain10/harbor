// Images the agent points at on this machine (`![plot](/tmp/.../plot.png)`, a Read of
// a .png) have no URL of their own: the server's /api/local-image route serves them,
// raster images only, resolving relative paths against the session's folder.

// Anything with a scheme (http:, data:, blob:…) or protocol-relative is not a local path.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The local file path an image src names, or null when it is a URL. */
export function localImagePath(src) {
  let value = String(src ?? '').trim();
  if (!value) return null;
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  if (value.startsWith('//') || SCHEME.test(value)) return null;
  // The app's own routes stay as they are.
  if (/^\/(?:api|dist|vendor|__file)\//.test(value)) return null;
  // Marked percent-encodes the destination (spaces, non-ASCII).
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** The URL that shows the local image at `filePath` (relative paths need `sessionId`). */
export function localImageUrl(filePath, sessionId) {
  const query = new URLSearchParams({ path: filePath });
  if (sessionId) query.set('session', sessionId);
  return '/api/local-image?' + query;
}
