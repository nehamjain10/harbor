// Server-sent events. `publish` saves a session and tells every open client what
// changed as a `delta` event; `broadcast` only sends (for lightweight events that need
// no write). Streaming text goes out as small `live` events (`scheduleLive`) so it never
// rewrites the session file; the next delta carries the same state.
//
// Deltas: for each session the server remembers what its last broadcast said (the JSON
// of every public message and top-level field) under a revision number `rev`. A delta
// `{id, rev, base, fields, unset?, messages?, ids?, count}` holds the fields that
// changed (`unset`: removed ones), the new or changed messages in order, and `ids`, the
// whole message order, only when it is not just the old order plus new messages.
// A client applies a delta only to a copy at revision `base` and otherwise fetches the
// session again. GET /api/sessions/:id carries the `rev` of its copy: a GET that sees
// changes not broadcast yet moves the revision on (and broadcasts that delta), so a
// copy at revision N is always exactly what the delta N described. The exception is
// LIVE_FIELDS, which `live` events also set between deltas: every delta carries them.
// A delta with `base: null` (nothing broadcast for this session since the server
// started) carries the list form in `fields`; clients holding the session refetch it.
// Before deltas, every step of a turn pushed the whole session (~1 MB for a long one)
// to every client.
//
// Tails (server/tail.mjs): a client may hold only the messages from some index on. A GET
// of a tail serializes and compares only those messages (`tailRevision`), never the
// whole history. A snapshot made for a tail records the JSON of the messages from
// `known` on; the next delta takes the messages before that as unchanged (messages that
// old do not change in place; a move or removal still shows in `ids`). No client holding
// such a revision holds them: a GET of more of the session records their JSON first (if
// nothing else changed) or moves the revision on.
// Older pages (GET /api/sessions/:id/messages) send the messages of the last revision
// (`pageRevision`) and never move it, except to publish what is pending.
//
// Cost: a long session holds tens of thousands of messages. Their JSON is cached between
// snapshots (json-cache.mjs), so a publish stringifies only what changed; what is left
// grows with the session (~20 ms at 24k messages). A session whose publish takes
// SLOW_PUBLISH_MS or more waits PUBLISH_COST_FACTOR times that before the next one, a
// flush included (it is then coalesced into one publish when the wait is over), so a
// stream of events from several model agents cannot keep the event loop busy.
import { LIVE_THROTTLE_MS, MAX_CLIENT_BACKLOG, PUBLISH_COST_FACTOR, PUBLISH_THROTTLE_MS, SLOW_PUBLISH_MS } from './config.mjs';
import { cachedJson } from './json-cache.mjs';

// Not part of the list form (see store.mjs publicSession).
const FULL_ONLY_FIELDS = new Set(['messages', 'live', 'liveThinking']);
// What a `live` event sets (livePayload): a client's copy of these can be ahead of the
// last delta (or, for a dropped tick, behind it), so every delta sends them as they are.
const LIVE_FIELDS = ['live', 'liveThinking', 'status', 'updatedAt'];

export function formatEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The `live` event payload: just the streaming fields of a session. */
export function livePayload(session) {
  return {
    id: session.id,
    live: session.live ?? '',
    liveThinking: session.liveThinking ?? '',
    status: session.status,
    updatedAt: Date.now(),
  };
}

/**
 * @param {object} deps
 * @param {(session: object) => void} deps.save  persists a session (may throw)
 * @param {(session: object, full: boolean) => object} deps.toPublic  client-facing copy
 * @param {number} [deps.throttleMs]  window for schedule()
 * @param {number} [deps.liveThrottleMs]  window for scheduleLive()
 * @param {number} [deps.maxBacklog]  bytes a client may have unsent before it is dropped
 * @param {(message: string) => void} [deps.log]  where save failures are reported
 */
export function createEvents({
  save,
  toPublic,
  throttleMs = PUBLISH_THROTTLE_MS,
  liveThrottleMs = LIVE_THROTTLE_MS,
  maxBacklog = MAX_CLIENT_BACKLOG,
  log = console.error,
  slowPublishMs = SLOW_PUBLISH_MS,
  publishCostFactor = PUBLISH_COST_FACTOR,
}) {
  const listeners = new Set();
  // Session id -> {timer, due}: its pending publish and when it goes (performance.now()).
  const timers = new Map();
  // Session id -> {cost, at}: how long its last publish took and when it ended.
  const costs = new Map();
  // Session id -> {rev, ids, json, fields: Map(key -> JSON), usable, known}: `json` holds
  // the messages' JSON from index `known` on.
  const sent = new Map();
  // Revisions start at the clock so they keep growing across restarts.
  let lastRev = Date.now();

  // `known`: the index from which the messages' JSON is recorded (0: all of them).
  function snapshot(pub, known = 0) {
    const list = pub.messages || [];
    const ids = new Array(list.length);
    const json = new Array(list.length);
    // Messages without a unique id cannot be patched by id: such a session is never diffed.
    let usable = true;
    for (let i = 0; i < list.length; i++) {
      const id = list[i].id;
      ids[i] = id;
      if (typeof id !== 'string' || !id) usable = false;
      if (i >= known) json[i] = cachedJson(list[i]);
    }
    if (usable && new Set(ids).size !== ids.length) usable = false;
    const fields = new Map();
    for (const [key, value] of Object.entries(pub)) if (key !== 'messages') fields.set(key, JSON.stringify(value));
    return { rev: ++lastRev, ids, json, fields, usable, known: Math.min(known, list.length) };
  }

  /** The JSON `snapshot` recorded for message `id` (undefined when it did not record it). */
  function recordedJson(snap, id, index) {
    if (snap.ids[index] === id) return snap.json[index];
    // The message moved (or is new): look it up by id, once per snapshot.
    snap.byId ??= new Map(snap.ids.map((messageId, i) => [messageId, i]));
    const at = snap.byId.get(id);
    return at === undefined ? undefined : snap.json[at];
  }

  /**
   * Whether two snapshots say the same: the same messages in the same order (compared
   * where both recorded them) and the same fields apart from LIVE_FIELDS (which every
   * delta sends).
   */
  function agree(a, b) {
    if (a.ids.length !== b.ids.length) return false;
    for (let i = 0; i < a.ids.length; i++) if (a.ids[i] !== b.ids[i]) return false;
    for (let i = Math.max(a.known, b.known); i < b.json.length; i++) if (a.json[i] !== b.json[i]) return false;
    const keys = new Set([...a.fields.keys(), ...b.fields.keys()]);
    for (const key of keys) if (!LIVE_FIELDS.includes(key) && a.fields.get(key) !== b.fields.get(key)) return false;
    return true;
  }

  /** Records in `kept` the messages that `next` (which agrees with it) recorded and it did not. */
  function learn(kept, next) {
    for (let i = next.known; i < kept.known; i++) kept.json[i] = next.json[i];
    kept.known = Math.min(kept.known, next.known);
  }

  /** What changed from `previous` to `next` (snapshots of `pub`'s session) as a delta event. */
  function deltaEvent(id, previous, next, pub) {
    if (!previous?.usable || !next.usable) {
      const fields = {};
      for (const [key, value] of Object.entries(pub)) if (!FULL_ONLY_FIELDS.has(key)) fields[key] = value;
      return { id, rev: next.rev, base: null, fields };
    }
    const fields = {};
    for (const [key, json] of next.fields) if (previous.fields.get(key) !== json || LIVE_FIELDS.includes(key)) fields[key] = pub[key];
    const unset = [...previous.fields.keys()].filter((key) => !next.fields.has(key));
    // Messages a snapshot did not record are taken as unchanged (see the top). A message
    // new since `previous` is always recorded: new messages come at the end.
    const unknown = previous.known > 0 ? new Set(previous.ids.slice(0, previous.known)) : null;
    const list = pub.messages || [];
    const messages = [];
    for (let i = next.known; i < list.length; i++) {
      const message = list[i];
      if (unknown?.has(message.id)) continue;
      if (recordedJson(previous, message.id, i) !== next.json[i]) messages.push(message);
    }
    const appended = previous.ids.every((messageId, index) => next.ids[index] === messageId);
    const event = { id, rev: next.rev, base: previous.rev, fields, count: next.ids.length };
    if (unset.length) event.unset = unset;
    if (messages.length) event.messages = messages;
    if (!appended) event.ids = next.ids;
    return event;
  }

  /** Records `pub` (the full public form of `session`) as the next revision and broadcasts the delta to it. */
  function advance(session, pub, next = snapshot(pub)) {
    const event = deltaEvent(session.id, sent.get(session.id), next, pub);
    sent.set(session.id, next);
    if (listeners.size) broadcast('delta', event);
    return next.rev;
  }

  /**
   * The revision of `pub`, the full public form of `session` just built for a GET. A
   * session not broadcast yet gets its baseline here (no client holds a revision of it),
   * so the next publish can be a delta for this client. Changes not broadcast yet (a
   * throttled publish is pending) are broadcast now under a new revision, so that a
   * later delta cannot leave this copy with a value that changed back in the meantime.
   */
  function revision(session, pub = toPublic(session, true)) {
    const previous = sent.get(session.id);
    const next = snapshot(pub);
    if (!previous) {
      sent.set(session.id, next);
      return next.rev;
    }
    if (agree(previous, next)) {
      learn(previous, next);
      return previous.rev;
    }
    return advance(session, pub, next);
  }

  /**
   * `revision` for a GET that sends only the messages from `from` on (a tail): only those
   * are serialized and compared, so a long session costs what its tail costs. Returns
   * `{rev, pub}`: the revision and the full public form it belongs to. When the tail has
   * changes nobody was told about and a publish is on its way, that publish goes now.
   */
  function tailRevision(session, from) {
    let pub = toPublic(session, true);
    const previous = sent.get(session.id);
    const next = snapshot(pub, from);
    if (!previous) {
      sent.set(session.id, next);
      return { rev: next.rev, pub };
    }
    if (agree(previous, next)) {
      learn(previous, next);
      return { rev: previous.rev, pub };
    }
    if (timers.has(session.id)) {
      // Now, whatever the cooldown: the GET hands out the revision.
      publish(session);
      pub = toPublic(session, true);
      return { rev: sent.get(session.id).rev, pub };
    }
    // The delta must cover what clients of `previous` hold: all of it after a full
    // snapshot (expensive, and rare: changes without a publish on the way).
    const known = Math.min(previous.known, from);
    return { rev: advance(session, pub, known === from ? next : snapshot(pub, known)), pub };
  }

  /**
   * The revision an older page (the messages from `from` on that a client lacks, GET
   * /api/sessions/:id/messages) is cut at; null before any. A pending publish goes
   * first, so the page is that revision's messages. A revision made for a tail that did
   * not record them records them now (nothing changed since it was made, or a publish
   * would be pending), so the next delta tells the client that then holds them what
   * changes in them.
   */
  function pageRevision(session, from) {
    if (timers.has(session.id)) publish(session);
    const previous = sent.get(session.id);
    if (!previous || previous.known <= from) return previous?.rev ?? null;
    const pub = toPublic(session, true);
    const list = pub.messages || [];
    if (list.length !== previous.ids.length || list.some((message, i) => message.id !== previous.ids[i])) {
      // Changed without a publish on the way: a new revision, recording them.
      return advance(session, pub, snapshot(pub, from));
    }
    for (let i = from; i < previous.known; i++) {
      previous.json[i] = cachedJson(list[i]);
    }
    previous.known = from;
    return previous.rev;
  }
  const liveWindows = new Map();

  /** Registers an SSE response (anything with write()). Returns the unsubscribe function. */
  function subscribe(stream) {
    listeners.add(stream);
    stream.write(formatEvent('ready', { at: Date.now() }));
    return () => listeners.delete(stream);
  }

  /**
   * Sends one event to every client. Droppable events (streaming ticks such as `live`)
   * skip clients whose socket buffer is full; those catch up on the next full event.
   * A client that stopped reading altogether is disconnected so its backlog cannot
   * grow without bound; the browser reconnects and starts from full state.
   */
  function broadcast(type, payload, { droppable = false } = {}) {
    if (!listeners.size) return;
    const frame = formatEvent(type, payload);
    for (const stream of listeners) {
      if (droppable && stream.writableNeedDrain) continue;
      if ((stream.writableLength ?? 0) > maxBacklog) {
        listeners.delete(stream);
        stream.destroy?.();
        continue;
      }
      stream.write(frame);
    }
  }

  /**
   * Saves and broadcasts; returns the new revision. A failed save is logged, never
   * thrown into timers or turn cleanup.
   */
  function publish(session) {
    // A session prepared ahead of its first message (runner.prepare) is nobody's yet.
    if (session.prepared) return 0;
    // This publish says everything a pending one would.
    clearTimeout(timers.get(session.id)?.timer);
    timers.delete(session.id);
    const start = performance.now();
    try {
      save(session);
    } catch (error) {
      log(`Could not save session ${session.id}: ${error.message}`);
    }
    // The delta carries the live text, so a pending tick has nothing left to say.
    clearTimeout(liveWindows.get(session.id)?.timer);
    liveWindows.delete(session.id);
    // The baseline moves on even with no client connected: GETs hand out its revision.
    const rev = advance(session, toPublic(session, true));
    const end = performance.now();
    costs.set(session.id, { cost: end - start, at: end });
    return rev;
  }

  /** How long a slow (long) session waits before it publishes again, in ms; 0 for the rest. */
  function cooldown(id) {
    const last = costs.get(id);
    if (!last || last.cost < slowPublishMs) return 0;
    return Math.max(0, last.at + last.cost * publishCostFactor - performance.now());
  }

  /** Publishes `session` in `wait` ms, or sooner if a publish is already due sooner. */
  function publishIn(session, wait) {
    const due = performance.now() + wait;
    const pending = timers.get(session.id);
    if (pending && pending.due <= due) return;
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      timers.delete(session.id);
      publish(session);
    }, wait);
    timers.set(session.id, { timer, due });
  }

  // Publishing never sends the whole history any more, so a change that leaves the
  // messages alone (an import, a PATCH) is an ordinary publish.
  const announce = publish;

  /** Coalesces rapid updates into one publish per throttle window. */
  function schedule(session) {
    if (session.prepared || timers.has(session.id)) return;
    publishIn(session, Math.max(throttleMs, cooldown(session.id)));
  }

  /**
   * Publishes immediately, cancelling any pending throttled publish; a slow session that
   * published moments ago publishes when its cooldown is over instead.
   */
  function flush(session) {
    if (session.prepared) return;
    const wait = cooldown(session.id);
    if (wait > 0) return publishIn(session, wait);
    publish(session);
  }

  /**
   * Streams the session's live text as droppable `live` events, never saving. The first
   * tick goes out at once (so even a short reply is seen streaming); later ticks are
   * coalesced into at most one event per window, the last one carrying the latest text.
   */
  function scheduleLive(session) {
    const open = liveWindows.get(session.id);
    if (open) {
      open.dirty = true;
      return;
    }
    const window = { dirty: false, timer: null };
    const close = () => {
      if (!window.dirty) {
        liveWindows.delete(session.id);
        return;
      }
      window.dirty = false;
      broadcast('live', livePayload(session), { droppable: true });
      window.timer = setTimeout(close, liveThrottleMs);
    };
    window.timer = setTimeout(close, liveThrottleMs);
    liveWindows.set(session.id, window);
    broadcast('live', livePayload(session), { droppable: true });
  }

  return { subscribe, broadcast, publish, announce, schedule, flush, scheduleLive, revision, tailRevision, pageRevision, listeners };
}
