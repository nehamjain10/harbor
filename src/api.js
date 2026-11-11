// Fetch wrapper for the /api routes: JSON in/out, timeout, and errors surfaced as
// Error(message) using the server's `{ error }` body when present. The whole error
// body stays on `error.data` (a 409 carries the current copy of what changed).

const DEFAULT_TIMEOUT = 15_000;

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function request(method, route, body, { timeout = DEFAULT_TIMEOUT, fetchImpl = globalThis.fetch } = {}) {
  const init = {
    method,
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl('/api/' + route.replace(/^\//, ''), init);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new ApiError('The server took too long to respond.', 0);
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error || (text && text.length < 200 ? text : '') || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, data);
  }
  return data;
}

export const api = {
  get: (route, options) => request('GET', route, undefined, options),
  post: (route, body = {}, options) => request('POST', route, body, options),
  put: (route, body, options) => request('PUT', route, body, options),
  patch: (route, body, options) => request('PATCH', route, body, options),
  delete: (route, options) => request('DELETE', route, undefined, options),
};
