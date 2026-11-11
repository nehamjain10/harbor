// Draft bookkeeping around a send. Drafts live in storage under KEYS.draft(id), with
// the new-session view using KEYS.draft(null). `storage` is anything with
// getItem/setItem/removeItem (localStorage, or the safe wrappers in storage.js).
import { KEYS } from './storage.js';

const holds = (storage, key, text) => storage.getItem(key)?.trim() === text;

// A send from the new-session view just created `sessionId`: the text becomes that
// session's draft until the message is accepted, so the composer shows it there and a
// failed send can be retried. The new-session draft is left alone if the user has
// already typed something else into it.
export function moveNewDraft(storage, sessionId, text) {
  const from = KEYS.draft(null);
  const raw = storage.getItem(from);
  storage.setItem(KEYS.draft(sessionId), raw?.trim() === text ? raw : text);
  if (holds(storage, from, text)) storage.removeItem(from);
}

// The server accepted `text` for `sessionId`. Clear the drafts that still hold it
// (the session's, plus the new-session one when this send created the session), but
// keep anything typed since.
export function clearSentDrafts(storage, sessionId, text, { created = false } = {}) {
  const keys = created ? [KEYS.draft(sessionId), KEYS.draft(null)] : [KEYS.draft(sessionId)];
  for (const key of keys) {
    if (holds(storage, key, text)) storage.removeItem(key);
  }
}

// Uploaded attachments waiting to be sent are kept with the draft, as a JSON list of
// the server's Attachment objects, so a reload keeps them.
export const attachmentsKey = (id) => 'mesh-code-attachments-' + (id || 'new');

export function readAttachments(storage, id) {
  try {
    const list = JSON.parse(storage.getItem(attachmentsKey(id)) || '[]');
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeAttachments(storage, id, attachments) {
  if (attachments.length) storage.setItem(attachmentsKey(id), JSON.stringify(attachments));
  else storage.removeItem(attachmentsKey(id));
}

const sameIds = (list, ids) => list.length === ids.length && list.every((a, i) => a.id === ids[i]);

// Like moveNewDraft, for the attachments of a send that created `sessionId`.
export function moveNewAttachments(storage, sessionId, attachments) {
  if (!attachments.length) return;
  writeAttachments(storage, sessionId, attachments);
  if (sameIds(readAttachments(storage, null), attachments.map((a) => a.id))) storage.removeItem(attachmentsKey(null));
}

// Like clearSentDrafts: forget stored attachments that went out with the message.
export function clearSentAttachments(storage, sessionId, ids, { created = false } = {}) {
  if (!ids.length) return;
  const sent = new Set(ids);
  for (const id of created ? [sessionId, null] : [sessionId]) {
    const list = readAttachments(storage, id);
    const rest = list.filter((a) => !sent.has(a.id));
    if (rest.length !== list.length) writeAttachments(storage, id, rest);
  }
}

// A fork from a message puts that message (its text and attachments) in the new
// session's draft, to edit and send. Stored before the session opens, which is when the
// composer reads its draft.
export function storeForkDraft(storage, sessionId, draft) {
  if (typeof draft?.text === 'string' && draft.text.trim()) storage.setItem(KEYS.draft(sessionId), draft.text);
  const attachments = Array.isArray(draft?.attachments) ? draft.attachments.filter((a) => a && typeof a.id === 'string') : [];
  writeAttachments(storage, sessionId, attachments);
}
