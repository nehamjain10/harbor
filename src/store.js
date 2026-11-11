// A tiny observable store plus the pure state transitions the app relies on.
// Kept framework-free so it can be unit tested with node:test.
import { canonicalMode } from './lib/modes.js';
import { isBusy, upsertSession } from './lib/sessions.js';
import { share, shareMessages } from './lib/share.js';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    // `update` is a partial state or a function of the current state returning one.
    set(update) {
      const patch = typeof update === 'function' ? update(state) : update;
      if (!patch) return;
      let changed = false;
      for (const key of Object.keys(patch)) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
}

// Tails (server/tail.mjs): a copy may hold only the messages from index `messagesFrom`
// on (GET /api/sessions/:id?tail=N); older pages are added in front as the reader scrolls
// up (applyOlderMessages). Without `messagesFrom` (or 0) a copy holds them all.
export function heldFrom(session) {
  return session?.messagesFrom > 0 ? session.messagesFrom : 0;
}

// Whether a message can still change in place: a tool call running, or a user message
// on its way (queued, sent mid-turn, its turn running). Others never change again (the
// server's events.mjs relies on the same), so an older copy of them is still current.
export function unsettled(message) {
  if (message.role === 'tool') return message.state === 'running';
  return message.role === 'user' && UNSETTLED_DELIVERY.has(message.delivery);
}
const UNSETTLED_DELIVERY = new Set(['queued', 'sent', 'running', 'sending']);

// The messages of a fetched copy `session` after the older ones `current` holds before
// them, when the two meet (the message where the fetched ones start is where `current`
// has it): {messages, from}. Null when there is nothing older to keep, they do not meet
// (the list changed before that point), or one of those older messages may have changed
// since (`current` may have missed deltas): the fetched window is then taken as is.
function joinOlder(current, session) {
  const have = heldFrom(current);
  const from = heldFrom(session);
  const held = current.messages;
  if (from <= have || !Array.isArray(held) || !session.messages?.length) return null;
  const offset = from - have;
  if (offset >= held.length || held[offset].id !== session.messages[0].id) return null;
  const older = held.slice(0, offset);
  if (older.some(unsettled)) return null;
  return { messages: [...older, ...session.messages], from: have };
}

// A newer copy of the open session that reuses every unchanged part of `current`
// (messages by id, todos, plan, …), so only what changed re-renders. A tail keeps the
// older messages `current` loaded before it.
export function mergeSession(current, session) {
  if (!current || current.id !== session.id) return session;
  const joined = joinOlder(current, session);
  const next = {};
  for (const key of Object.keys(session)) {
    next[key] = key === 'messages' ? shareMessages(current.messages, joined ? joined.messages : session.messages) : share(current[key], session[key]);
  }
  if (joined) next.messagesFrom = joined.from;
  return next;
}

// GET /api/sessions/:id/messages answered `page` ({messages, from, before, rev}) for the
// open session `sessionId`, asked before the message `beforeId`: its messages go in front
// of those held. Null (ask again) when the copy moved on meanwhile (another window, or
// that message is no longer the first held), or when it took deltas newer than the page
// while one of the page's messages could still change: those deltas skipped it.
export function applyOlderMessages(state, sessionId, beforeId, page) {
  const current = state.current;
  if (current?.id !== sessionId || !Array.isArray(page?.messages) || !Array.isArray(current.messages)) return null;
  const from = heldFrom(current);
  if (!from || current.messages[0]?.id !== beforeId || page.before !== from || page.from + page.messages.length !== from) return null;
  if (page.rev != null && current.rev != null && current.rev > page.rev && page.messages.some(unsettled)) return null;
  const next = { ...current, messages: [...page.messages, ...current.messages] };
  if (page.from > 0) next.messagesFrom = page.from;
  else delete next.messagesFrom;
  return { current: next };
}

// `session` applied to `current` (same id): a full copy is merged, a list-form copy
// (no messages or live text, e.g. a PATCH result) only updates the fields it carries.
// A copy older than `current` (by revision, see applyDelta) is ignored. A list-form
// copy leaves the revision alone: the messages are still those of `current`'s.
export function updateSession(current, session) {
  if (session.rev != null && current.rev != null && session.rev < current.rev) return current;
  if (session.messages) return mergeSession(current, session);
  const { rev, ...fields } = session;
  return { ...current, ...fields };
}

// SSE `session` event (full or list form): refresh the list entry, and update the open
// session unless what we hold is newer.
export function applySessionEvent(state, session) {
  const patch = { sessions: upsertSession(state.sessions, session) };
  const current = state.current;
  if (current?.id !== session.id) return patch;
  // By revision when both copies have one (updateSession), else by time.
  if ((session.rev != null && current.rev != null) || (session.updatedAt || 0) >= (current.updatedAt || 0)) {
    patch.current = updateSession(current, session);
  }
  return patch;
}

// Message lists made by applyDelta -> what the delta did to the list before it
// (`previous`): the messages it replaced and those it added at the end. A view of a few
// messages (an agent's, lib/agentTranscript.js) follows a long session from these
// instead of reading the whole list again.
const deltaChanges = new WeakMap();

export function messageChanges(messages) {
  return (messages && deltaChanges.get(messages)) || null;
}

// SSE `delta` event (server/events.mjs): what changed since revision `delta.base`,
// applied to a full copy at that revision. Returns the new copy, or null when the copy
// is at another revision or the result does not add up; the caller then fetches the
// session again. Unchanged messages, and the messages array when no message changed,
// keep their identity, so only what changed re-renders.
export function applyDelta(session, delta) {
  if (!session || delta.base == null || session.rev !== delta.base) return null;
  const next = { ...session, ...delta.fields, rev: delta.rev };
  for (const key of delta.unset || []) delete next[key];
  if (heldFrom(session)) return applyToTail(session, delta, next);
  const changed = delta.messages || [];
  if (changed.length || delta.ids) {
    const updates = new Map(changed.map((message) => [message.id, message]));
    let messages;
    if (delta.ids) {
      const byId = new Map((session.messages || []).map((message) => [message.id, message]));
      messages = delta.ids.map((id) => updates.get(id) || byId.get(id));
      if (messages.some((message) => !message)) return null;
    } else {
      const known = new Set();
      const replaced = [];
      const added = [];
      messages = (session.messages || []).map((message) => {
        known.add(message.id);
        const update = updates.get(message.id);
        if (update) replaced.push(update);
        return update || message;
      });
      for (const message of changed) {
        if (known.has(message.id)) continue;
        messages.push(message);
        added.push(message);
      }
      deltaChanges.set(messages, { previous: session.messages, replaced, added });
    }
    next.messages = messages;
  }
  if (delta.count !== undefined && (next.messages?.length ?? 0) !== delta.count) return null;
  return next;
}

// applyDelta for a copy that holds the messages from `messagesFrom` on (a tail). The
// delta describes the whole list: `count` is its length, `ids` (a new order) names every
// message, and `messages` (in the list's order) may include messages before the copy's
// window (changed in place), which the copy does not hold and skips. New messages come
// last, after every message already there. Null (fetch again) when the result does not add up, when a
// message from before the window moved into it, or when a message new to the copy
// belongs under an agent call it does not hold (the server's cut then reaches back to
// that call, see server/tail.mjs).
function applyToTail(session, delta, next) {
  const from = heldFrom(session);
  const held = session.messages || [];
  const changed = delta.messages || [];
  if (delta.count === undefined) return null;
  const position = new Map(held.map((message, i) => [message.id, i]));
  let messages = held;
  let start = from;
  let arrived;
  if (delta.ids) {
    // The new order of every message: the copy keeps the end from its first message on.
    const updates = new Map(changed.map((message) => [message.id, message]));
    const first = delta.ids.findIndex((id) => position.has(id));
    if (first < 0) return null;
    arrived = [];
    messages = [];
    for (let i = first; i < delta.ids.length; i++) {
      const id = delta.ids[i];
      const message = updates.get(id) || held[position.get(id)];
      if (!message) return null;
      if (!position.has(id)) arrived.push(message);
      messages.push(message);
    }
    start = first;
  } else {
    // In the old order with new messages at the end: the last `added` of those the copy
    // does not hold are new; the others changed before its window.
    const added = delta.count - (from + held.length);
    const unknown = changed.filter((message) => !position.has(message.id));
    if (added < 0 || unknown.length < added) return null;
    arrived = unknown.slice(unknown.length - added);
    if (changed.slice(changed.length - added).some((message, i) => message !== arrived[i])) return null;
    const replaced = [];
    for (const message of changed) {
      const at = position.get(message.id);
      if (at === undefined) continue;
      if (messages === held) messages = held.slice();
      messages[at] = message;
      replaced.push(message);
    }
    if (arrived.length) {
      if (messages === held) messages = held.slice();
      messages.push(...arrived);
    }
    if (messages !== held) deltaChanges.set(messages, { previous: held, replaced, added: arrived });
  }
  if (start + messages.length !== delta.count || !holdsCalls(messages, arrived)) return null;
  next.messages = messages;
  next.messagesFrom = start;
  return next;
}

// Whether `messages` holds the agent call of each message of `arrived` that belongs to
// one (nested under it, or a background agent's end notice).
function holdsCalls(messages, arrived) {
  const wanted = [];
  for (const message of arrived) {
    if (message.parentToolId) wanted.push(message.parentToolId);
    if (message.agentToolId) wanted.push(message.agentToolId);
  }
  if (!wanted.length) return true;
  const calls = new Set();
  for (const message of messages) if (message.role === 'tool' && message.toolId) calls.add(message.toolId);
  return wanted.every((id) => calls.has(id));
}

// A delta applied to the session list (list form: no messages or live text). Returns
// the new list, or null for a session the list does not have and the delta cannot
// describe in full (only a delta without a base carries the whole list form).
export function applyDeltaToList(sessions, delta) {
  const { messages, live, liveThinking, ...fields } = delta.fields || {};
  const index = sessions.findIndex((s) => s.id === delta.id);
  if (index < 0) return delta.base == null ? [...sessions, { ...fields, rev: delta.rev }] : null;
  // An entry taken from a copy at this revision or later (upsertSession) has it already.
  if (sessions[index].rev != null && delta.rev <= sessions[index].rev) return sessions;
  const entry = { ...sessions[index], ...fields, rev: delta.rev };
  for (const key of delta.unset || []) delete entry[key];
  const next = sessions.slice();
  next[index] = entry;
  return next;
}

// Full sessions already loaded in this page, most recently used last, so switching
// back to one paints at once while the server confirms it is current. SSE events keep
// the copies current. Sessions are never mutated in place, so entries share the store's
// objects. Bounded by sessions and by messages held (a long session is ~10 MB); the
// most recent entry always stays.
export function createSessionCache({ entries: maxEntries = 40, messages: maxMessages = 25_000 } = {}) {
  const entries = new Map();
  const held = () => {
    let count = 0;
    for (const session of entries.values()) count += session.messages?.length ?? 0;
    return count;
  };
  return {
    get(id) {
      const session = entries.get(id);
      if (!session) return null;
      entries.delete(id);
      entries.set(id, session);
      return session;
    },
    put(session) {
      if (!session?.id || !Array.isArray(session.messages)) return;
      entries.delete(session.id);
      entries.set(session.id, session);
      while (entries.size > 1 && (entries.size > maxEntries || held() > maxMessages)) entries.delete(entries.keys().next().value);
    },
    // An SSE event for a cached session, unless the cached copy is newer. Nothing is
    // rendered from these copies yet, so a full event simply replaces it.
    update(session) {
      const cached = entries.get(session?.id);
      if (!cached || (session.updatedAt || 0) < (cached.updatedAt || 0)) return;
      entries.set(session.id, session.messages ? session : { ...cached, ...session });
    },
    // A delta for a cached session; a copy it does not apply to is dropped (opening
    // that session then waits for the server, as for one never opened).
    applyDelta(delta) {
      const cached = entries.get(delta?.id);
      if (!cached || (cached.rev != null && delta.rev <= cached.rev)) return;
      const next = applyDelta(cached, delta);
      if (next) entries.set(delta.id, next);
      else entries.delete(delta.id);
    },
    has(id) {
      return entries.has(id);
    },
    delete(id) {
      entries.delete(id);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

// SSE `live` event: streaming text ticks. Patch only the open session; never treat
// it as a structural update.
export function applyLiveEvent(state, event) {
  const current = state.current;
  if (!current || current.id !== event.id) return null;
  if ((event.updatedAt || 0) < (current.updatedAt || 0)) return null;
  const next = { ...current };
  for (const key of ['live', 'liveThinking', 'status', 'updatedAt']) {
    if (event[key] !== undefined) next[key] = event[key];
  }
  return { current: next };
}

// Result of GET /api/sessions/:id while a session is open: accept it unless the
// view moved on or we already hold something newer (by revision when both copies
// have one, see applyDelta).
export function applyFetchedSession(state, session) {
  const current = state.current;
  if (!current || current.id !== session.id) return null;
  if (session.rev != null && current.rev != null) {
    if (session.rev < current.rev) return null;
  } else if ((session.updatedAt || 0) < (current.updatedAt || 0)) return null;
  return { current: mergeSession(current, session), sessions: upsertSession(state.sessions, session) };
}

// Optimistic PATCH: the fields a `PATCH /api/sessions/:id` body changes, as the server
// will store them (server/app.mjs applySessionPatch), so a click shows its effect in
// the same frame instead of after the round trip.
export function patchFields(session, patch) {
  const fields = {};
  if (patch.model) fields.model = patch.model;
  if (patch.mode) fields.mode = canonicalMode(patch.mode);
  if (patch.effort !== undefined) fields.efforts = { ...(session.efforts || {}), [patch.model || session.model]: patch.effort };
  for (const key of ['archived', 'removed', 'pinned']) if (typeof patch[key] === 'boolean') fields[key] = patch[key];
  if (typeof patch.title === 'string' && patch.title.trim()) fields.title = patch.title.trim().slice(0, 100);
  // Seen up to the last turn even if this clock is behind the server's.
  if (patch.viewed) fields.lastViewedAt = Math.max(Date.now(), session.turnEndedAt || 0);
  // The grants that stay (none: all cleared).
  for (const key of ['allowRules', 'allowDirectories']) if (Array.isArray(patch[key])) fields[key] = patch[key];
  return fields;
}

// `fields` laid over session `id` in the list and the open session. Leaves the revision
// alone: the server's delta (or the PATCH reply) confirms the change.
export function applyOptimistic(state, id, fields) {
  const patch = { sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...fields } : s)) };
  if (state.current?.id === id) patch.current = { ...state.current, ...fields };
  return patch;
}

// Undoes applyOptimistic (after a failed PATCH) where the value is still the optimistic
// one, so nothing that arrived from the server meanwhile is overwritten.
export function undoOptimistic(state, id, fields, before) {
  const undo = (session) => {
    let next = null;
    for (const key of Object.keys(fields)) {
      if (!Object.is(session[key], fields[key])) continue;
      next ??= { ...session };
      if (before[key] === undefined) delete next[key];
      else next[key] = before[key];
    }
    return next || session;
  };
  const patch = { sessions: state.sessions.map((s) => (s.id === id ? undo(s) : s)) };
  if (state.current?.id === id) patch.current = undo(state.current);
  return patch;
}

// Whether the open session is being stopped: Stop was pressed during this turn and the
// turn has not ended yet (a later turn has another currentMessageId).
export function isStopping(state) {
  const { stopping, current } = state;
  return !!stopping && !!current && stopping.id === current.id && stopping.turn === (current.currentMessageId ?? null) && isBusy(current);
}

// Whether "Interrupt and send now" is under way: pressed during this turn, and the
// messages it is for are still waiting (the turn that reads them has another id).
export function isInterrupting(state) {
  const { interrupting, current } = state;
  return !!interrupting && !!current && interrupting.id === current.id && interrupting.turn === (current.currentMessageId ?? null) && !!current.steering?.length;
}

// The open session without the pending approval `id` (answered here, before the server
// confirms), or null when it is not there.
export function withoutPending(state, id) {
  const current = state.current;
  const index = current?.pending?.findIndex((p) => p.id === id) ?? -1;
  if (index < 0) return null;
  return { current: { ...current, pending: current.pending.filter((p) => p.id !== id) } };
}

// Puts a pending approval back (the answer failed) unless the session moved on.
export function restorePending(state, sessionId, entry, index) {
  const current = state.current;
  if (current?.id !== sessionId || current.pending?.some((p) => p.id === entry.id)) return null;
  const pending = [...(current.pending || [])];
  pending.splice(Math.min(index, pending.length), 0, entry);
  return { current: { ...current, pending } };
}
