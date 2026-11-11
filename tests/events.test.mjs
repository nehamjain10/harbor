import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createEvents, formatEvent, livePayload } from '../server/events.mjs';

/** A stand-in for an SSE response. */
function fakeStream({ needDrain = false, backlog = 0 } = {}) {
  const frames = [];
  const stream = { frames, writableNeedDrain: needDrain, writableLength: backlog, destroyed: false };
  stream.write = (frame) => frames.push(frame);
  stream.destroy = () => (stream.destroyed = true);
  return stream;
}

const toPublic = (session, full) => ({ id: session.id, full, title: session.title });

// Shaped like store.mjs publicSession: the full form adds messages and the live text.
function richPublic(session, full) {
  const { messages = [], live, liveThinking, ...rest } = session;
  const copy = JSON.parse(JSON.stringify(rest));
  if (full) {
    copy.messages = JSON.parse(JSON.stringify(messages));
    if (live !== undefined) copy.live = live;
    if (liveThinking !== undefined) copy.liveThinking = liveThinking;
  }
  return copy;
}

// A message whose serializations are counted (by id) in `log`.
function counted(id, log = countedLog) {
  const message = { id, text: 'text of ' + id };
  Object.defineProperty(message, 'toJSON', { enumerable: false, value: () => (log.push(id), { id: message.id, text: message.text }) });
  return message;
}
let countedLog = [];

// A session of `count` counted messages and events whose public form passes them as
// they are (as store.mjs publicSession does for short tool output).
function tailFixture(count, options = {}) {
  const log = [];
  countedLog = log;
  const session = { id: 's1', title: 'T', status: 'idle', messages: Array.from({ length: count }, (_, i) => counted('m' + i, log)) };
  const toPublic = (s, full) => {
    const { messages, ...rest } = s;
    return full ? { ...rest, messages: [...messages] } : rest;
  };
  const events = createEvents({ save: () => {}, toPublic, ...options });
  const stream = fakeStream();
  events.subscribe(stream);
  // The ids serialized since the last call.
  return { events, session, stream, serialized: () => log.splice(0) };
}

function frameData(frame, type) {
  assert.ok(frame.startsWith(`event: ${type}\n`), frame.slice(0, 40));
  return JSON.parse(frame.split('data: ')[1]);
}

describe('createEvents', () => {
  test('formatEvent produces one SSE frame', () => {
    assert.equal(formatEvent('session', { a: 1 }), 'event: session\ndata: {"a":1}\n\n');
  });

  test('subscribe sends ready and unsubscribe stops delivery', () => {
    const events = createEvents({ save: () => {}, toPublic });
    const stream = fakeStream();
    const unsubscribe = events.subscribe(stream);
    assert.match(stream.frames[0], /^event: ready\ndata: \{"at":\d+\}\n\n$/);
    unsubscribe();
    events.publish({ id: 's1' });
    assert.equal(stream.frames.length, 1);
    assert.equal(events.listeners.size, 0);
  });

  test('publish saves; with nothing sent before, the delta has no base and carries the list form', () => {
    const saved = [];
    const events = createEvents({ save: (session) => saved.push(session.id), toPublic: richPublic });
    const stream = fakeStream();
    events.subscribe(stream);
    events.publish({ id: 's1', title: 'T', status: 'idle', messages: [{ id: 'm1', text: 'hi' }] });
    assert.deepEqual(saved, ['s1']);
    const delta = frameData(stream.frames[1], 'delta');
    assert.equal(delta.base, null);
    assert.ok(delta.rev > 0);
    assert.deepEqual(delta.fields, { id: 's1', title: 'T', status: 'idle' }, 'no messages or live text');
    assert.equal(delta.messages, undefined);
  });

  test('later publishes send only what changed since the previous one', () => {
    const events = createEvents({ save: () => {}, toPublic: richPublic });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', title: 'T', status: 'running', live: '', messages: [{ id: 'm1', text: 'hi' }, { id: 't1', role: 'tool', state: 'running' }] };
    // A GET hands out the baseline revision before anything was broadcast.
    const base = events.revision(session);
    assert.equal(events.revision(session), base, 'stable until the next publish');

    session.messages[1].state = 'done';
    session.messages.push({ id: 'a1', text: 'done' });
    session.live = 'typing';
    const rev = events.publish(session);
    let delta = frameData(stream.frames.at(-1), 'delta');
    assert.equal(delta.base, base);
    assert.ok(delta.rev > base);
    assert.equal(rev, delta.rev, 'publish returns the new revision');
    assert.equal(events.revision(session), delta.rev);
    // The status did not change, but every delta carries what live events set.
    assert.deepEqual(delta.fields, { status: 'running', live: 'typing' });
    assert.deepEqual(delta.messages, [{ id: 't1', role: 'tool', state: 'done' }, { id: 'a1', text: 'done' }]);
    assert.equal(delta.count, 3);
    assert.equal(delta.ids, undefined, 'only appended: the order is implied');

    // A removed message sends the whole order; a removed field is listed in `unset`.
    const previous = delta.rev;
    session.messages.splice(0, 1);
    delete session.live;
    session.status = 'idle';
    events.publish(session);
    delta = frameData(stream.frames.at(-1), 'delta');
    assert.equal(delta.base, previous);
    assert.deepEqual(delta.fields, { status: 'idle' });
    assert.deepEqual(delta.unset, ['live']);
    assert.equal(delta.messages, undefined);
    assert.deepEqual(delta.ids, ['t1', 'a1']);
    assert.equal(delta.count, 2);

    // Nothing changed but the save: an empty delta still moves the revision on.
    events.publish(session);
    const quiet = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual([quiet.base, quiet.fields, quiet.messages], [delta.rev, { status: 'idle' }, undefined]);
  });

  test('every delta resets the live text, which live events changed in between', () => {
    const events = createEvents({ save: () => {}, toPublic: richPublic, liveThrottleMs: 60_000 });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', status: 'running', updatedAt: 1, live: '', liveThinking: '', messages: [{ id: 'u1', text: 'hello' }] };
    events.publish(session);
    // The reply streams as `live` events; the client's copy now holds 'o'.
    session.live = 'o';
    events.scheduleLive(session);
    assert.equal(frameData(stream.frames.at(-1), 'live').live, 'o');
    // The reply becomes a message and the live text is cleared, as at the last delta.
    session.live = '';
    session.messages.push({ id: 'a1', text: 'ok' });
    events.publish(session);
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual(delta.fields, { status: 'running', updatedAt: 1, live: '', liveThinking: '' });
    assert.deepEqual(delta.messages, [{ id: 'a1', text: 'ok' }]);
  });

  test('a GET that sees changes not broadcast yet moves the revision on and broadcasts them', () => {
    const events = createEvents({ save: () => {}, toPublic: richPublic });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', title: 'T', status: 'running', pending: [], live: '', messages: [{ id: 'm1', text: 'hi' }] };
    const published = events.publish(session);
    const frames = stream.frames.length;

    // Only live fields differ: the copy is at the published revision (the next delta resets them).
    session.live = 'partial';
    session.status = 'waiting';
    assert.equal(events.revision(session), published);
    assert.equal(stream.frames.length, frames, 'nothing to broadcast');

    // An approval request not published yet (a throttled publish is pending).
    session.pending = [{ id: 'p1' }];
    const seen = events.revision(session);
    assert.ok(seen > published);
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual([delta.rev, delta.base], [seen, published]);
    assert.deepEqual(delta.fields.pending, [{ id: 'p1' }]);
    assert.equal(events.revision(session), seen, 'stable while nothing changes');
    assert.equal(stream.frames.length, frames + 1);

    // It is answered before that publish: the delta must still say so to the GET's copy.
    session.pending = [];
    events.publish(session);
    const next = frameData(stream.frames.at(-1), 'delta');
    assert.equal(next.base, seen);
    assert.deepEqual(next.fields.pending, []);
  });

  test('a GET of a session with unusable ids that changed sends one delta without a base, then nothing', () => {
    const events = createEvents({ save: () => {}, toPublic: richPublic });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', title: 'T', messages: [{ id: 'm1' }, { id: 'm1' }] };
    events.publish(session);
    session.title = 'U';
    const frames = stream.frames.length;
    const rev = events.revision(session);
    assert.equal(frameData(stream.frames.at(-1), 'delta').base, null);
    // The clients holding it refetch: those GETs see no change, so there is no loop.
    assert.equal(events.revision(session), rev);
    assert.equal(stream.frames.length, frames + 1);
  });

  test('messages without unique ids are never diffed: every delta has no base', () => {
    const events = createEvents({ save: () => {}, toPublic: richPublic });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', title: 'T', messages: [{ id: 'm1' }, { id: 'm1' }] };
    events.revision(session);
    events.publish(session);
    assert.equal(frameData(stream.frames.at(-1), 'delta').base, null);
  });

  test('revisions keep growing across server restarts', () => {
    const first = createEvents({ save: () => {}, toPublic: richPublic });
    const session = { id: 's1', title: 'T', messages: [] };
    const before = first.revision(session);
    assert.ok(before > Date.now() - 60_000, 'revisions start at the clock');
  });

  test('announce is an ordinary publish: a delta, never the history', () => {
    const events = createEvents({ save: () => {}, toPublic: richPublic });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', title: 'T', messages: [{ id: 'm1', text: 'long history' }] };
    events.revision(session);
    session.title = 'Renamed';
    events.announce(session);
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual([delta.fields, delta.messages], [{ title: 'Renamed' }, undefined]);
  });

  test('broadcast sends without saving; droppable events skip congested clients', () => {
    let saves = 0;
    const events = createEvents({ save: () => saves++, toPublic });
    const healthy = fakeStream();
    const congested = fakeStream({ needDrain: true });
    events.subscribe(healthy);
    events.subscribe(congested);

    events.broadcast('live', { id: 's1', live: 'Hel' }, { droppable: true });
    assert.equal(saves, 0);
    assert.equal(healthy.frames.at(-1), 'event: live\ndata: {"id":"s1","live":"Hel"}\n\n');
    assert.equal(congested.frames.length, 1, 'only the ready frame');

    // Deltas still reach every client so congested ones converge.
    events.publish({ id: 's1', title: 'T' });
    assert.match(congested.frames.at(-1), /^event: delta\n/);
  });

  test('a failed save is logged and the update is still broadcast', () => {
    const logged = [];
    const events = createEvents({
      save: () => {
        throw new Error('ENOSPC: no space left on device');
      },
      toPublic,
      log: (message) => logged.push(message),
    });
    const stream = fakeStream();
    events.subscribe(stream);
    assert.doesNotThrow(() => events.flush({ id: 's1', title: 'T' }));
    assert.deepEqual(logged, ['Could not save session s1: ENOSPC: no space left on device']);
    assert.match(stream.frames.at(-1), /^event: delta\n/);
  });

  test('schedule coalesces rapid updates and flush cancels the pending one', async () => {
    let saves = 0;
    const events = createEvents({ save: () => saves++, toPublic, throttleMs: 10 });
    const session = { id: 's1' };
    events.schedule(session);
    events.schedule(session);
    events.schedule(session);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(saves, 1);

    events.schedule(session);
    events.flush(session);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(saves, 2, 'the throttled publish was replaced by the flush');
  });

  test('a slow (long) session publishes again only after its cooldown; flushes meanwhile become one publish', async () => {
    let saves = 0;
    // Every publish of this session takes ~5 ms: slow, with a 4x cooldown of ~20 ms.
    const slowPublic = (session, full) => {
      const until = performance.now() + 5;
      while (performance.now() < until);
      return toPublic(session, full);
    };
    const events = createEvents({ save: () => saves++, toPublic: slowPublic, throttleMs: 1, slowPublishMs: 4, publishCostFactor: 4 });
    const stream = fakeStream();
    events.subscribe(stream);
    const session = { id: 's1', title: 'T' };
    events.flush(session);
    assert.equal(saves, 1, 'the first flush goes at once');
    session.title = 'T2';
    events.flush(session);
    events.flush(session);
    events.schedule(session);
    assert.equal(saves, 1, 'within the cooldown: deferred');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(saves, 2, 'one publish for all of them');
    assert.equal(frameData(stream.frames.at(-1), 'delta').fields.title, 'T2');
    // A publish (or a GET's revision) never waits.
    session.title = 'T3';
    events.publish(session);
    assert.equal(saves, 3);

    // A quick session is never held back.
    const quick = createEvents({ save: () => saves++, toPublic, slowPublishMs: 4 });
    quick.flush({ id: 's2' });
    quick.flush({ id: 's2' });
    assert.equal(saves, 5);
  });

  test('a tail GET publishes a cooled-down flush now', () => {
    const { events, session, stream } = tailFixture(10, { slowPublishMs: 0, publishCostFactor: 1e6 });
    events.publish(session);
    session.messages[9].text = 'step';
    events.flush(session);
    const frames = stream.frames.length;
    const { pub } = events.tailRevision(session, 7);
    assert.equal(stream.frames.length, frames + 1);
    assert.deepEqual(frameData(stream.frames.at(-1), 'delta').messages.map((m) => m.id), ['m9']);
    assert.equal(pub.messages[9].text, 'step');
  });

  test('a client that stopped reading is dropped instead of buffering without bound', () => {
    const events = createEvents({ save: () => {}, toPublic, maxBacklog: 1000 });
    const healthy = fakeStream({ backlog: 999 });
    const stalled = fakeStream({ backlog: 1001 });
    events.subscribe(healthy);
    events.subscribe(stalled);
    events.publish({ id: 's1', title: 'T' });
    assert.equal(stalled.destroyed, true);
    assert.equal(stalled.frames.length, 1, 'nothing more was queued for it');
    assert.equal(events.listeners.has(stalled), false);
    assert.equal(healthy.destroyed, false);
    assert.match(healthy.frames.at(-1), /^event: delta\n/);
  });

  test('scheduleLive sends the first tick at once, coalesces the rest, and never saves', async () => {
    let saves = 0;
    const events = createEvents({ save: () => saves++, toPublic, liveThrottleMs: 10 });
    const stream = fakeStream();
    const congested = fakeStream({ needDrain: true });
    events.subscribe(stream);
    events.subscribe(congested);
    const live = () => stream.frames.filter((frame) => frame.startsWith('event: live')).map((frame) => JSON.parse(frame.split('data: ')[1]));
    const session = { id: 's1', live: 'He', liveThinking: '', status: 'running' };
    events.scheduleLive(session);
    assert.deepEqual(live().map((payload) => payload.live), ['He'], 'leading edge: sent immediately');
    session.live = 'Hel';
    events.scheduleLive(session);
    session.live = 'Hello';
    events.scheduleLive(session);
    assert.equal(live().length, 1, 'later ticks wait for the window');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(saves, 0);
    assert.deepEqual(live().map((payload) => payload.live), ['He', 'Hello'], 'trailing edge: one event with the latest text');
    assert.deepEqual({ ...live()[1], updatedAt: 0 }, { id: 's1', live: 'Hello', liveThinking: '', status: 'running', updatedAt: 0 });
    assert.equal(congested.frames.length, 1, 'droppable: skipped for the congested client');

    // A full publish carries the same state, so it cancels a pending trailing tick.
    events.scheduleLive(session);
    session.live = 'Hello there';
    events.scheduleLive(session);
    events.publish(session);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(live().map((payload) => payload.live), ['He', 'Hello', 'Hello']);
    assert.equal(saves, 1);
  });

  test('a tail GET serializes and compares only the tail; changes before it keep the revision', () => {
    const { events, session, serialized, stream } = tailFixture(10);
    const { rev, pub } = events.tailRevision(session, 7);
    assert.deepEqual(serialized(), ['m7', 'm8', 'm9'], 'only the tail');
    assert.equal(pub.messages.length, 10, 'the full form, for the route to slice');
    assert.equal(events.pageRevision(session, 7), rev, 'the revision pages are cut at');
    assert.equal(events.tailRevision(session, 7).rev, rev, 'stable while nothing changes');
    assert.deepEqual(serialized(), [], 'unchanged messages keep their JSON (json-cache.mjs)');
    // A change before the tail: no client of this revision holds that message.
    session.messages[2].text = 'edited';
    assert.equal(events.tailRevision(session, 8).rev, rev);
    assert.deepEqual(serialized(), [], 'the edited message is before the tail: not even looked at');
    // A change in it is a new revision, broadcast (the snapshot still records only the tail).
    session.messages[8].text = 'edited';
    const moved = events.tailRevision(session, 7).rev;
    assert.ok(moved > rev);
    assert.deepEqual(serialized(), ['m8', 'm8'], 'the changed message, then the delta with it');
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual([delta.base, delta.rev, delta.messages.map((m) => m.id)], [rev, moved, ['m8']]);
  });

  test('deltas after a tail baseline take the messages it did not record as unchanged', () => {
    const { events, session, stream } = tailFixture(10);
    const { rev } = events.tailRevision(session, 7);
    session.messages[2].text = 'edited';
    session.messages[8].text = 'edited';
    session.messages.push(counted('m10'));
    events.publish(session);
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.equal(delta.base, rev);
    assert.deepEqual(delta.messages.map((m) => m.id), ['m8', 'm10']);
    assert.equal(delta.count, 11);
    // That publish recorded everything: the next delta covers the whole list again.
    session.messages[2].text = 'edited again';
    events.publish(session);
    assert.deepEqual(frameData(stream.frames.at(-1), 'delta').messages.map((m) => m.id), ['m2']);
  });

  test('a GET of more than a tail baseline recorded: learned when nothing changed', () => {
    const { events, session, serialized, stream } = tailFixture(10);
    const { rev } = events.tailRevision(session, 7);
    const frames = stream.frames.length;
    // A longer tail, then the whole session (the full form of older clients).
    assert.equal(events.tailRevision(session, 4).rev, rev);
    assert.deepEqual(serialized(), ['m7', 'm8', 'm9', 'm4', 'm5', 'm6'], 'each message once (json-cache.mjs)');
    assert.equal(events.revision(session), rev);
    assert.equal(stream.frames.length, frames, 'no delta: nothing changed');
    // Everything is recorded now: a change anywhere is in the next delta.
    session.messages[1].text = 'edited';
    events.publish(session);
    assert.deepEqual(frameData(stream.frames.at(-1), 'delta').messages.map((m) => m.id), ['m1']);
  });

  test('a tail GET that sees changes not broadcast yet: the pending publish goes now, else the revision moves on', () => {
    const { events, session, stream } = tailFixture(10, { throttleMs: 60_000 });
    const published = events.publish(session);
    // A step of the turn waits in the throttle window.
    session.messages[9].text = 'step';
    events.schedule(session);
    const frames = stream.frames.length;
    const { rev, pub } = events.tailRevision(session, 7);
    assert.ok(rev > published);
    assert.equal(stream.frames.length, frames + 1, 'one delta: the publish, done now');
    assert.deepEqual(frameData(stream.frames.at(-1), 'delta').messages.map((m) => m.id), ['m9']);
    assert.equal(pub.messages[9].text, 'step');
    // A change with no publish on its way (after a full snapshot): a full delta.
    session.messages[3].text = 'before the tail';
    session.messages[8].text = 'in the tail';
    const next = events.tailRevision(session, 7).rev;
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual([delta.base, delta.rev, delta.messages.map((m) => m.id)], [rev, next, ['m3', 'm8']]);
    assert.equal(events.tailRevision(session, 7).rev, next);
  });

  test('an older page is cut at the last revision, which then records its messages', () => {
    const { events, session, serialized, stream } = tailFixture(10, { throttleMs: 60_000 });
    const { rev } = events.tailRevision(session, 7);
    serialized();
    // Nothing changed since the tail: the page [3, 7) is that revision's, recorded now.
    assert.equal(events.pageRevision(session, 3), rev);
    assert.deepEqual(serialized(), ['m3', 'm4', 'm5', 'm6']);
    assert.equal(events.pageRevision(session, 5), rev);
    assert.deepEqual(serialized(), [], 'recorded already');
    // A change in the page reaches the client holding it; one before it nobody holds.
    session.messages[4].text = 'edited';
    session.messages[1].text = 'edited';
    events.publish(session);
    assert.deepEqual(frameData(stream.frames.at(-1), 'delta').messages.map((m) => m.id), ['m4']);
    // A publish on its way goes before the page is cut.
    session.messages[0].text = 'step';
    events.schedule(session);
    const frames = stream.frames.length;
    const cut = events.pageRevision(session, 0);
    assert.equal(stream.frames.length, frames + 1);
    const delta = frameData(stream.frames.at(-1), 'delta');
    assert.deepEqual([delta.rev, delta.messages.map((m) => m.id)], [cut, ['m0']]);

    // A list changed without a publish on its way: a new revision that records the page.
    const other = tailFixture(10);
    const first = other.events.tailRevision(other.session, 7).rev;
    other.session.messages.push(counted('m10'));
    const moved = other.events.pageRevision(other.session, 3);
    assert.ok(moved > first);
    const pushed = frameData(other.stream.frames.at(-1), 'delta');
    assert.deepEqual([pushed.base, pushed.rev, pushed.count, pushed.messages.map((m) => m.id)], [first, moved, 11, ['m10']]);
    other.session.messages[3].text = 'edited';
    other.events.publish(other.session);
    assert.deepEqual(frameData(other.stream.frames.at(-1), 'delta').messages.map((m) => m.id), ['m3']);
    assert.equal(events.pageRevision({ id: 'never-sent', messages: [] }, 0), null);
  });

  test('livePayload fills missing streaming fields', () => {
    const payload = livePayload({ id: 'x', status: 'idle' });
    assert.equal(payload.live, '');
    assert.equal(payload.liveThinking, '');
    assert.equal(typeof payload.updatedAt, 'number');
  });
});
