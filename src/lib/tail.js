// Tail loading (server/tail.mjs): sessions open with the recent end of their messages,
// and older pages load as the reader scrolls up (src/store.js heldFrom).

// Messages a session opens with. The server cuts at a turn's start within twice this,
// so the 8,000-message main session opens with ~550 messages (~75 entries, 1 MB of
// JSON), enough for the first screens (Transcript.jsx renders 50 entries first).
export const TAIL_MESSAGES = 300;
// Messages per older page.
export const OLDER_PAGE = 400;
// A finished turn's notification reads only the last messages (src/attention.js).
export const NOTIFY_TAIL = 40;

// The route of a session in its tail form; `rev`: the revision of a copy held.
export function sessionRoute(id, { tail = TAIL_MESSAGES, rev } = {}) {
  const query = new URLSearchParams({ tail: String(tail) });
  if (rev != null) query.set('rev', String(rev));
  return 'sessions/' + encodeURIComponent(id) + '?' + query.toString();
}

// The page of messages before the first one `session` holds (all of them with `all`).
export function olderRoute(session, { all = false } = {}) {
  const before = session.messagesFrom;
  const query = new URLSearchParams({ before: String(before), limit: String(all ? before : OLDER_PAGE) });
  if (session.messages?.[0]?.id) query.set('beforeId', session.messages[0].id);
  return 'sessions/' + encodeURIComponent(session.id) + '/messages?' + query.toString();
}
