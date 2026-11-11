import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDelta,
  applyDeltaToList,
  applyFetchedSession,
  applyLiveEvent,
  applyOptimistic,
  applySessionEvent,
  createSessionCache,
  createStore,
  isInterrupting,
  isStopping,
  patchFields,
  restorePending,
  shallowEqual,
  undoOptimistic,
  updateSession,
  withoutPending,
} from '../src/store.js';
import { createSync } from '../src/sync.js';
import { request } from '../src/api.js';
import { upsertSession } from '../src/lib/sessions.js';

test('createStore notifies only on real changes', () => {
  const store = createStore({ a: 1, b: { x: 1 } });
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.a));
  store.set({ a: 1 });
  store.set({ a: 2 });
  store.set((s) => ({ a: s.a + 1 }));
  store.set(() => null);
  unsubscribe();
  store.set({ a: 10 });
  assert.deepEqual(seen, [2, 3]);
  assert.equal(store.get().a, 10);
  assert.deepEqual(store.get().b, { x: 1 });
});

test('shallowEqual', () => {
  const o = {};
  assert.equal(shallowEqual({ a: 1, b: o }, { a: 1, b: o }), true);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(shallowEqual({ a: {} }, { a: {} }), false);
  assert.equal(shallowEqual(null, null), true);
});

test('session events update the list and the open session unless stale', () => {
  const state = {
    sessions: [{ id: 's1', title: 'old' }],
    current: { id: 's1', updatedAt: 100, messages: [] },
  };
  const fresh = applySessionEvent(state, { id: 's1', title: 'new', updatedAt: 200, messages: [{ id: 'm' }] });
  assert.equal(fresh.sessions[0].title, 'new');
  assert.equal(fresh.sessions[0].messages, undefined);
  assert.equal(fresh.current.updatedAt, 200);

  const stale = applySessionEvent(state, { id: 's1', title: 'stale', updatedAt: 50, messages: [] });
  assert.equal(stale.current, undefined);
  assert.equal(stale.sessions[0].title, 'stale');

  const other = applySessionEvent(state, { id: 's2', title: 'other', updatedAt: 300 });
  assert.equal(other.current, undefined);
  assert.equal(other.sessions.length, 2);
});

test('live events patch only the open session and only streaming fields', () => {
  const current = { id: 's1', updatedAt: 100, status: 'running', live: '', messages: [{ id: 'm' }] };
  const state = { sessions: [], current };
  const patch = applyLiveEvent(state, { id: 's1', live: 'Hel', liveThinking: 'hm', status: 'running', updatedAt: 100, messages: 'ignored' });
  assert.equal(patch.current.live, 'Hel');
  assert.equal(patch.current.liveThinking, 'hm');
  assert.equal(patch.current.messages, current.messages);
  assert.equal(applyLiveEvent(state, { id: 'other', live: 'x' }), null);
  assert.equal(applyLiveEvent(state, { id: 's1', live: 'x', updatedAt: 10 }), null);
  assert.equal(applyLiveEvent({ current: null }, { id: 's1', live: 'x' }), null);
});

test('fetched sessions are applied only to the open session and not when older', () => {
  const state = { sessions: [], current: { id: 's1', updatedAt: 100 } };
  assert.equal(applyFetchedSession(state, { id: 's1', updatedAt: 99 }), null);
  assert.equal(applyFetchedSession(state, { id: 's2', updatedAt: 200 }), null);
  assert.equal(applyFetchedSession(state, { id: 's1', updatedAt: 100 }).current.updatedAt, 100);
});

// Minimal EventSource stand-in.
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, data) {
    if (type === 'ready') this.readyState = 1;
    for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
  }
  fail(closed = false) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      queue.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const i = queue.indexOf(handle);
      if (i >= 0) queue.splice(i, 1);
    },
    async runNext() {
      const handle = queue.shift();
      await handle?.fn();
      await new Promise((r) => setImmediate(r));
      return handle;
    },
  };
}

test('updateSession merges a full copy and lays a list-form copy over the open session', () => {
  const messages = [{ id: 'm1', text: 'hi' }];
  const current = { id: 's1', title: 'Old', messages, live: 'typing', updatedAt: 1 };
  const listed = updateSession(current, { id: 's1', title: 'New', lastViewedAt: 5, updatedAt: 2 });
  assert.equal(listed.title, 'New');
  assert.equal(listed.lastViewedAt, 5);
  assert.equal(listed.messages, messages, 'a list-form copy keeps the messages');
  assert.equal(listed.live, 'typing');
  const full = updateSession(current, { id: 's1', title: 'New', messages: [{ id: 'm1', text: 'hi' }, { id: 'm2', text: 'yo' }], updatedAt: 3 });
  assert.equal(full.messages[0], messages[0], 'unchanged messages are shared');
  assert.equal(full.messages.length, 2);
});

test('updateSession: a copy older than the open one is ignored; a list form keeps the revision', () => {
  const current = { id: 's1', title: 'Old', status: 'running', messages: [{ id: 'm1' }], rev: 10 };
  // A PATCH reply that arrives after the next delta was applied.
  assert.equal(updateSession(current, { id: 's1', title: 'Late', status: 'idle', rev: 9 }), current);
  // A newer one is laid over it, but the messages are still those of revision 10.
  const ahead = updateSession(current, { id: 's1', title: 'New', rev: 12 });
  assert.deepEqual([ahead.title, ahead.rev, ahead.status], ['New', 10, 'running']);
  assert.equal(updateSession(current, { id: 's1', title: 'Same', rev: 10 }).title, 'Same');
  assert.equal(updateSession({ ...current, rev: undefined }, { id: 's1', title: 'No rev', rev: 1 }).title, 'No rev');
  // The session event path goes through it too.
  const state = { current, sessions: [{ id: 's1', title: 'Old', rev: 10 }] };
  const patch = applySessionEvent(state, { id: 's1', title: 'Late', rev: 9, updatedAt: 5 });
  assert.equal(patch.current, current);
  assert.equal(patch.sessions[0].title, 'Old', 'the list entry is newer too');
  // A newer reply applies even when a live event stamped the open copy with a later time.
  const stamped = { ...current, updatedAt: 50 };
  assert.equal(applySessionEvent({ ...state, current: stamped }, { id: 's1', lastViewedAt: 7, rev: 11, updatedAt: 20 }).current.lastViewedAt, 7);
});

test('session cache: least recently used out, list forms ignored, SSE updates never step back', () => {
  const cache = createSessionCache({ entries: 2 });
  const a = { id: 'a', messages: [], updatedAt: 1 };
  const b = { id: 'b', messages: [], updatedAt: 1 };
  cache.put(null);
  cache.put({ id: 'x', title: 'list form' });
  assert.equal(cache.size, 0);
  cache.put(a);
  cache.put(b);
  assert.equal(cache.get('a'), a, 'a is now the most recent');
  cache.put({ id: 'c', messages: [], updatedAt: 1 });
  assert.equal(cache.get('b'), null, 'b was the least recently used');
  assert.equal(cache.get('a'), a);

  cache.update({ id: 'a', title: 'Renamed', updatedAt: 2 });
  assert.equal(cache.get('a').title, 'Renamed');
  assert.equal(cache.get('a').messages, a.messages, 'a list-form event keeps the messages');
  const newer = { id: 'a', messages: [{ id: 'm1' }], updatedAt: 3 };
  cache.update(newer);
  assert.equal(cache.get('a'), newer);
  cache.update({ id: 'a', messages: [], updatedAt: 2 });
  assert.equal(cache.get('a'), newer, 'an older event is ignored');
  cache.update({ id: 'zz', messages: [], updatedAt: 9 });
  assert.equal(cache.get('zz'), null, 'events do not add sessions');
  cache.delete('a');
  assert.equal(cache.get('a'), null);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('applyDelta: fields, new and changed messages, a new order, removed fields; identity kept', () => {
  const m1 = { id: 'm1', text: 'hi' };
  const t1 = { id: 't1', role: 'tool', state: 'running' };
  const session = { id: 's1', rev: 10, status: 'running', live: 'x', plan: { a: 1 }, messages: [m1, t1] };

  const quiet = applyDelta(session, { id: 's1', rev: 11, base: 10, fields: { status: 'idle' }, count: 2 });
  assert.equal(quiet.status, 'idle');
  assert.equal(quiet.rev, 11);
  assert.equal(quiet.messages, session.messages, 'no message changed: the same array');
  assert.equal(quiet.plan, session.plan);

  const done = { id: 't1', role: 'tool', state: 'done' };
  const a1 = { id: 'a1', text: 'reply' };
  const grown = applyDelta(session, { id: 's1', rev: 11, base: 10, fields: {}, messages: [done, a1], count: 3, unset: ['live'] });
  assert.deepEqual(grown.messages, [m1, done, a1]);
  assert.equal(grown.messages[0], m1, 'unchanged messages keep their identity');
  assert.equal('live' in grown, false);

  const reordered = applyDelta(session, { id: 's1', rev: 11, base: 10, fields: {}, ids: ['t1'], count: 1 });
  assert.deepEqual(reordered.messages, [t1], 'a removed message');

  // Copies at another revision, or results that do not add up, need a refetch.
  assert.equal(applyDelta(session, { id: 's1', rev: 12, base: 11, fields: {} }), null);
  assert.equal(applyDelta(session, { id: 's1', rev: 12, base: null, fields: {} }), null);
  assert.equal(applyDelta({ ...session, rev: undefined }, { id: 's1', rev: 11, base: 10, fields: {} }), null);
  assert.equal(applyDelta(session, { id: 's1', rev: 11, base: 10, fields: {}, messages: [a1], count: 4 }), null);
  assert.equal(applyDelta(session, { id: 's1', rev: 11, base: 10, fields: {}, ids: ['m1', 'gone'], count: 2 }), null);
});

test('applyDeltaToList: changed fields only; unknown sessions only from a delta without a base', () => {
  const list = [{ id: 's1', title: 'A', status: 'idle', todos: [] }, { id: 's2', title: 'B' }];
  const next = applyDeltaToList(list, { id: 's1', rev: 2, base: 1, fields: { status: 'running', live: 'typing' }, unset: ['todos'] });
  assert.deepEqual(next[0], { id: 's1', title: 'A', status: 'running', rev: 2 }, 'no live text or messages in the list');
  assert.equal(next[1], list[1]);
  assert.equal(applyDeltaToList(list, { id: 's3', rev: 2, base: 1, fields: { title: 'C' } }), null);
  assert.deepEqual(applyDeltaToList(list, { id: 's3', rev: 2, base: null, fields: { id: 's3', title: 'C' } })[2], { id: 's3', title: 'C', rev: 2 });
  // An entry taken from a later copy (a PATCH reply) skips older deltas still on their way.
  const later = [{ id: 's1', title: 'Patched', rev: 5 }];
  assert.equal(applyDeltaToList(later, { id: 's1', rev: 4, base: 3, fields: { title: 'Earlier' } }), later);
  assert.equal(applyDeltaToList(later, { id: 's1', rev: 6, base: 5, fields: { title: 'Later' } })[0].title, 'Later');
});

test('upsertSession: an entry at a later revision is not replaced by an older copy', () => {
  const list = [{ id: 's1', title: 'New', rev: 5 }];
  assert.equal(upsertSession(list, { id: 's1', title: 'Old', rev: 4 }), list);
  assert.equal(upsertSession(list, { id: 's1', title: 'Newer', rev: 6 })[0].title, 'Newer');
  assert.equal(upsertSession(list, { id: 's1', title: 'Listed' })[0].title, 'Listed', 'copies without a revision always apply');
  assert.equal(upsertSession([{ id: 's1', title: 'Listed' }], { id: 's1', title: 'Old', rev: 4 })[0].title, 'Old');
});

test('fetched sessions are compared by revision when both copies have one', () => {
  const current = { id: 's1', rev: 20, updatedAt: 5, messages: [] };
  assert.equal(applyFetchedSession({ current, sessions: [] }, { id: 's1', rev: 19, updatedAt: 9, messages: [] }), null, 'older revision');
  assert.equal(applyFetchedSession({ current, sessions: [] }, { id: 's1', rev: 20, updatedAt: 4, messages: [] }).current.rev, 20, 'same revision: everything up to it, maybe more');
  assert.equal(applyFetchedSession({ current, sessions: [] }, { id: 's1', rev: 21, updatedAt: 1, messages: [] }).current.rev, 21);
});

test('session cache: deltas keep copies current; a copy a delta does not fit is dropped', () => {
  const cache = createSessionCache();
  cache.put({ id: 'a', rev: 5, messages: [{ id: 'm1' }] });
  cache.applyDelta({ id: 'a', rev: 6, base: 5, fields: { title: 'T' }, messages: [{ id: 'm2' }], count: 2 });
  assert.deepEqual(cache.get('a').messages.map((m) => m.id), ['m1', 'm2']);
  cache.applyDelta({ id: 'a', rev: 6, base: 5, fields: { title: 'old' } });
  assert.equal(cache.get('a').title, 'T', 'a delta it already has is ignored');
  cache.applyDelta({ id: 'a', rev: 9, base: 8, fields: {} });
  assert.equal(cache.get('a'), null, 'missed a delta: dropped');
  cache.applyDelta({ id: 'nope', rev: 1, base: null, fields: {} });
  assert.equal(cache.size, 0);
});

test('sync: ready → live, session and live events are forwarded', () => {
  FakeEventSource.instances = [];
  const events = [];
  const sync = createSync({
    EventSourceImpl: FakeEventSource,
    timers: fakeTimers(),
    onReady: () => events.push('ready'),
    onSession: (s) => events.push('session:' + s.id),
    onLive: (l) => events.push('live:' + l.live),
    onDelta: (d) => events.push('delta:' + d.rev),
    onStatus: (s) => events.push('status:' + s),
  });
  sync.start();
  const source = FakeEventSource.instances[0];
  assert.equal(source.url, '/api/events');
  source.emit('ready', { at: 1 });
  source.emit('session', { id: 'abc' });
  source.emit('live', { id: 'abc', live: 'Hi' });
  source.emit('delta', { id: 'abc', rev: 7, base: 6, fields: {} });
  source.emit('session', { nope: true });
  source.emit('delta', { rev: 8 });
  assert.deepEqual(events, ['status:live', 'ready', 'session:abc', 'live:Hi', 'delta:7']);
  assert.equal(sync.status, 'live');
  sync.stop();
  assert.equal(source.closed, true);
});

test('sync: error falls back to polling every interval until SSE returns', async () => {
  FakeEventSource.instances = [];
  const timers = fakeTimers();
  const statuses = [];
  let polls = 0;
  let pollFails = true;
  const sync = createSync({
    EventSourceImpl: FakeEventSource,
    timers,
    pollInterval: 3000,
    onStatus: (s) => statuses.push(s),
    poll: async () => {
      polls += 1;
      if (pollFails) throw new Error('down');
    },
  });
  sync.start();
  const source = FakeEventSource.instances[0];
  source.emit('ready', {});
  source.fail();
  assert.equal(sync.status, 'offline');
  assert.equal(timers.queue.length, 1);
  assert.equal(timers.queue[0].ms, 3000);

  await timers.runNext();
  assert.equal(polls, 1);
  assert.equal(sync.status, 'offline');
  assert.equal(timers.queue.length, 1, 'keeps polling');

  pollFails = false;
  await timers.runNext();
  assert.equal(polls, 2);
  assert.equal(sync.status, 'polling');

  source.emit('ready', {});
  assert.equal(sync.status, 'live');
  assert.equal(timers.queue.length, 0, 'polling stops once SSE is back');
  assert.deepEqual(statuses, ['live', 'offline', 'polling', 'live']);
  sync.stop();
});

test('sync: a closed EventSource is reopened after a delay; resume reconnects now', async () => {
  FakeEventSource.instances = [];
  const timers = fakeTimers();
  const sync = createSync({ EventSourceImpl: FakeEventSource, timers, reconnectDelay: 5000, poll: async () => {} });
  sync.start();
  FakeEventSource.instances[0].fail(true);
  const reconnect = timers.queue.find((t) => t.ms === 5000);
  assert.ok(reconnect, 'reconnect scheduled');
  timers.clearTimeout(reconnect);
  reconnect.fn();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(FakeEventSource.instances[0].closed, true);

  FakeEventSource.instances[1].fail();
  sync.resume();
  assert.equal(FakeEventSource.instances.length, 3);
  FakeEventSource.instances[2].emit('ready', {});
  sync.resume();
  assert.equal(FakeEventSource.instances.length, 3, 'no reconnect while open');
  sync.stop();
});

test('api.request: JSON success, server error message, non-JSON error, network failure', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/ok') return new Response(JSON.stringify({ a: 1 }), { status: 200 });
    if (url === '/api/bad') return new Response(JSON.stringify({ error: 'Unknown model' }), { status: 400 });
    if (url === '/api/proxy') return new Response('Bad Gateway', { status: 502 });
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await request('GET', 'ok', undefined, { fetchImpl }), { a: 1 });
  assert.equal(calls[0].init.body, undefined);
  await request('POST', '/ok', { x: 1 }, { fetchImpl });
  assert.equal(calls[1].init.body, '{"x":1}');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  await assert.rejects(request('PATCH', 'bad', {}, { fetchImpl }), { message: 'Unknown model', status: 400 });
  await assert.rejects(request('GET', 'proxy', undefined, { fetchImpl }), { message: 'Bad Gateway', status: 502 });
  await assert.rejects(request('GET', 'down', undefined, { fetchImpl }), /Cannot reach the server/);
});

test('patchFields: what a PATCH changes, as the server stores it', () => {
  const session = { id: 's1', model: 'opus', efforts: { sonnet: 'low' }, turnEndedAt: Date.now() + 60_000 };
  assert.deepEqual(patchFields(session, { mode: 'yolo' }), { mode: 'bypassPermissions' });
  assert.deepEqual(patchFields(session, { effort: 'high' }), { efforts: { sonnet: 'low', opus: 'high' } });
  assert.deepEqual(patchFields(session, { model: 'sonnet', effort: 'max' }), { model: 'sonnet', efforts: { sonnet: 'max' } });
  assert.deepEqual(patchFields(session, { pinned: true, archived: false, title: '  New name  ' }), { pinned: true, archived: false, title: 'New name' });
  assert.deepEqual(patchFields(session, { title: '   ' }), {}, 'a blank title is refused by the server');
  assert.equal(patchFields(session, { viewed: true }).lastViewedAt, session.turnEndedAt, 'seen up to the last turn even with a slow clock');
  assert.deepEqual(patchFields(session, { allowRules: true }), {});
  assert.deepEqual(patchFields(session, { allowRules: [] }), { allowRules: [] });
  const kept = [{ toolName: 'Bash', ruleContent: 'npm test' }];
  assert.deepEqual(patchFields(session, { allowRules: kept, allowDirectories: ['/srv/x'] }), { allowRules: kept, allowDirectories: ['/srv/x'] }, 'removing one grant shows the ones that stay');
});

test('applyOptimistic / undoOptimistic: shown at once, taken back only where still ours', () => {
  const a = { id: 'a', mode: 'default', model: 'opus', pinned: false };
  const b = { id: 'b', mode: 'plan' };
  let state = { sessions: [a, b], current: { ...a, messages: [{ id: 'm1' }] } };
  const fields = { mode: 'plan', pinned: true };
  const before = { mode: 'default', pinned: false };
  state = { ...state, ...applyOptimistic(state, 'a', fields) };
  assert.equal(state.sessions[0].mode, 'plan');
  assert.equal(state.current.pinned, true);
  assert.equal(state.sessions[1], b, 'other sessions keep their identity');
  // Meanwhile the server says the mode is acceptEdits (another tab): that stays.
  state = { ...state, current: { ...state.current, mode: 'acceptEdits' } };
  state = { ...state, ...undoOptimistic(state, 'a', fields, before) };
  assert.equal(state.current.mode, 'acceptEdits');
  assert.equal(state.current.pinned, false);
  assert.equal(state.sessions[0].mode, 'default');
  assert.deepEqual(state.current.messages, [{ id: 'm1' }]);
  // A field the session did not have is removed again.
  state = { ...state, ...applyOptimistic(state, 'b', { title: 'Named' }) };
  state = { ...state, ...undoOptimistic(state, 'b', { title: 'Named' }, { title: undefined }) };
  assert.equal('title' in state.sessions[1], false);
});

test('isStopping: from Stop until that turn ends', () => {
  const current = { id: 's1', status: 'running', currentMessageId: 'u1' };
  const stopping = { id: 's1', turn: 'u1' };
  assert.equal(isStopping({ current, stopping }), true);
  assert.equal(isStopping({ current, stopping: null }), false);
  assert.equal(isStopping({ current: { ...current, status: 'idle' }, stopping }), false, 'the turn ended');
  assert.equal(isStopping({ current: { ...current, currentMessageId: 'u2' }, stopping }), false, 'a later turn');
  assert.equal(isStopping({ current: { ...current, id: 's2' }, stopping }), false, 'another session');
});

test('isInterrupting: from "Interrupt and send now" until the waiting messages are read', () => {
  const current = { id: 's1', status: 'running', currentMessageId: 'u1', steering: [{ id: 'm1', text: 'hi' }] };
  const interrupting = { id: 's1', turn: 'u1' };
  assert.equal(isInterrupting({ current, interrupting }), true);
  assert.equal(isInterrupting({ current, interrupting: null }), false);
  assert.equal(isInterrupting({ current: { ...current, steering: [] }, interrupting }), false, 'read');
  assert.equal(isInterrupting({ current: { ...current, currentMessageId: 'm1' }, interrupting }), false, 'the next turn');
});

test('withoutPending / restorePending: a card goes at once and can come back in place', () => {
  const p1 = { id: 'p1' };
  const p2 = { id: 'p2' };
  let state = { current: { id: 's1', pending: [p1, p2] } };
  state = { ...state, ...withoutPending(state, 'p1') };
  assert.deepEqual(state.current.pending, [p2]);
  assert.equal(withoutPending(state, 'p1'), null);
  state = { ...state, ...restorePending(state, 's1', p1, 0) };
  assert.deepEqual(state.current.pending, [p1, p2]);
  assert.equal(restorePending(state, 's1', p1, 0), null, 'already there');
  assert.equal(restorePending({ current: { id: 's2', pending: [] } }, 's1', p1, 0), null, 'another session is open');
});

test('session cache: bounded by the messages it holds, the most recent always stays', () => {
  const cache = createSessionCache({ messages: 10 });
  const sized = (id, count) => ({ id, messages: Array.from({ length: count }, (_, i) => ({ id: id + i })) });
  cache.put(sized('a', 4));
  cache.put(sized('b', 4));
  assert.equal(cache.size, 2);
  cache.put(sized('c', 4));
  assert.equal(cache.has('a'), false, '12 messages: the oldest goes');
  assert.equal(cache.has('b') && cache.has('c'), true);
  cache.put(sized('big', 50));
  assert.equal(cache.size, 1, 'one over the budget alone is kept');
  assert.equal(cache.has('big'), true);
});
