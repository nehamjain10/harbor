// Attention logic, kept pure for unit tests: which sessions need the user (title
// badge), which changes deserve a desktop notification, and what it should say.
// src/attention.js wires this to the store, the Notification API and the tab.
import { firstLine } from './format.js';
import { isUnread } from './sessions.js';

const BUSY = new Set(['running', 'waiting']);

export function needsYou(session) {
  return session?.status === 'waiting' || !!session?.pending?.length;
}

// Unread = a finished turn the user has not seen. The open session is never unread
// while the page is visible: the user is looking at it.
export function isUnreadFor(session, { currentId = null, visible = true } = {}) {
  if (!isUnread(session) || BUSY.has(session.status)) return false;
  return !(visible && session.id === currentId);
}

// N in "(N) Harbor": sessions that need the user plus unread finished turns.
export function attentionCount(sessions, context = {}) {
  let count = 0;
  for (const session of sessions) {
    if (session.removed || session.archived) continue;
    if (needsYou(session) || isUnreadFor(session, context)) count += 1;
  }
  return count;
}

export function documentTitle(sessionTitle, count = 0) {
  const base = sessionTitle ? `${sessionTitle} · Harbor` : 'Harbor';
  return count > 0 ? `(${count}) ${base}` : base;
}

// Whether opening `session` should PATCH {viewed:true}: once per new turnEndedAt.
// `marks` maps session id → the turnEndedAt already reported.
export function shouldMarkViewed(session, marks) {
  return isUnread(session) && marks.get(session.id) !== session.turnEndedAt;
}

// Notifications show plain text: drop the common inline markdown markers.
export function plainText(line) {
  return String(line || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
}

// Text of the last top-level assistant message, first non-empty line.
export function lastAssistantLine(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant' && !message.parentToolId && message.text?.trim()) return plainText(firstLine(message.text, 140));
  }
  return '';
}

function lastTurnFailed(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'turn') return !!messages[i].isError;
  }
  return false;
}

export function finishedBody(session) {
  if (session.status === 'error' || lastTurnFailed(session.messages)) return 'Finished with an error';
  return lastAssistantLine(session.messages) || 'Finished';
}

// Whether the latest turn was stopped by the user: its `turn` message says so, or,
// when the stop came before a result, its user message was marked stopped.
export function turnWasStopped(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'turn') return !!message.stopped;
    if (turnStart(message)) return message.delivery === 'stopped';
  }
  return false;
}

// Whether `messages` (the end of a session, src/lib/tail.js) hold what turnWasStopped
// reads: a `turn` message or the user message a turn started with.
export function showsTurnEnd(messages = []) {
  return messages.some((message) => message.role === 'turn' || turnStart(message));
}

function turnStart(message) {
  return message.role === 'user' && !message.parentToolId && !['queued', 'sent', 'cancelled'].includes(message.delivery);
}

export function pendingBody(pending) {
  if (pending.kind === 'question') return 'Has a question for you';
  if (pending.kind === 'plan') return 'Plan ready for review';
  return `Needs your approval: ${pending.tool || 'a tool'}`;
}

// Decides which changes deserve a notification. Feed it every new sessions list
// (`observe`); it returns the events to announce:
//   { type: 'finished', session, key } — a turn ended (turnEndedAt moved forward)
//   { type: 'waiting', session, pending, key } — a new approval request
// The first list loaded from the server (`loaded`) is recorded without announcing
// anything, so nothing from before the page loaded is announced. A session that
// first appears after that (created on another device) starts from nothing, so its
// first finished turn and approvals are announced. Each turn end and each pending id
// is announced once. Announcing is skipped (but still recorded) when notifications
// are off, or when the change is in the open session while the user is looking at
// it (`visible`: the page is visible and focused).
export function createNotifier() {
  const turns = new Map(); // session id → last seen turnEndedAt
  const announced = new Set(); // pending ids already seen
  let baselineTaken = false;

  return {
    observe(sessions, { currentId = null, visible = true, enabled = true, loaded = true } = {}) {
      const events = [];
      for (const session of sessions) {
        const seen = turns.has(session.id);
        const ended = session.turnEndedAt || 0;
        if (!seen && !baselineTaken) {
          turns.set(session.id, ended);
          for (const pending of session.pending || []) announced.add(pending.id);
          continue;
        }
        const quiet = !enabled || (visible && session.id === currentId) || session.removed;

        if (!seen) turns.set(session.id, 0);
        if (ended > turns.get(session.id)) {
          turns.set(session.id, ended);
          // A queued follow-up already started, or the user stopped it: not "done".
          const finished = !BUSY.has(session.status) && session.status !== 'interrupted';
          if (finished && !quiet) events.push({ type: 'finished', session, key: `${session.id}:${ended}` });
        }

        for (const pending of session.pending || []) {
          if (announced.has(pending.id)) continue;
          announced.add(pending.id);
          if (!quiet) events.push({ type: 'waiting', session, pending, key: `pending:${pending.id}` });
        }
      }
      if (loaded) baselineTaken = true;
      return events;
    },
  };
}
