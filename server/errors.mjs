/** An Error carrying the HTTP status the app's error handler should answer with. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
