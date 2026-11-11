// Copies of a session that hold only the end of its messages (a tail, server/tail.mjs):
// deltas, fetched copies, older pages, the cache and what reads the messages.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyDelta,
  applyFetchedSession,
  applyOlderMessages,
  applySessionEvent,
  createSessionCache,
  heldFrom,
  mergeSession,
  messageChanges,
  unsettled,
} from '../src/store.js';
import { awaitingFirstTurn } from '../src/lib/imports.js';
import { showsTurnEnd, turnWasStopped } from '../src/lib/notify.js';
import { briefSession } from '../src/lib/sessions.js';
import { OLDER_PAGE, TAIL_MESSAGES, olderRoute, sessionRoute } from '../src/lib/tail.js';
import { todosVisible } from '../src/lib/todos.js';

const message = (i, fields = {}) => ({ id: 'm' + i, role: 'assistant', text: 'text ' + i, ...fields });
const range = (from, to) => Array.from({ length: to - from }, (_, k) => message(from + k));
const ids = (session) => session.messages.map((m) => m.id);
// A copy at revision 1 holding messages [from, to) of a list of `to` messages.
const tail = (from, to, fields = {}) => ({ id: 's1', rev: 1, status: 'idle', messagesFrom: from, messages: range(from, to), ...fields });

describe('routes', () => {
  test('a session opens with its tail; older pages ask before the first message held', () => {
    assert.equal(sessionRoute('a b'), `sessions/a%20b?tail=${TAIL_MESSAGES}`);
    assert.equal(sessionRoute('s1', { rev: 42 }), `sessions/s1?tail=${TAIL_MESSAGES}&rev=42`);
    assert.equal(sessionRoute('s1', { tail: 40, rev: null }), 'sessions/s1?tail=40');
    const copy = tail(700, 1000);
    assert.equal(olderRoute(copy), `sessions/s1/messages?before=700&limit=${OLDER_PAGE}&beforeId=m700`);
    assert.equal(olderRoute(copy, { all: true }), 'sessions/s1/messages?before=700&limit=700&beforeId=m700');
  });

  test('heldFrom: where the copy starts (0 for a whole copy)', () => {
    assert.equal(heldFrom(tail(700, 1000)), 700);
    assert.equal(heldFrom({ messages: [] }), 0);
    assert.equal(heldFrom({ messagesFrom: 0, messages: [] }), 0);
    assert.equal(heldFrom(null), 0);
  });
});

describe('applyDelta on a tail', () => {
  test('new messages at the end, changes in the window, changes before it skipped', () => {
    const copy = tail(100, 105);
    const next = applyDelta(copy, { id: 's1', base: 1, rev: 2, fields: { status: 'running' }, count: 107, messages: [message(5, { text: 'old, edited' }), message(102, { text: 'edited' }), message(105), message(106)] });
    assert.deepEqual(ids(next), ['m100', 'm101', 'm102', 'm103', 'm104', 'm105', 'm106']);
    assert.equal(next.messagesFrom, 100);
    assert.equal(next.rev, 2);
    assert.equal(next.status, 'running');
    assert.equal(next.messages[2].text, 'edited');
    assert.equal(next.messages[0], copy.messages[0], 'unchanged messages keep their identity');
    const changes = messageChanges(next.messages);
    assert.deepEqual([changes.previous, changes.replaced.map((m) => m.id), changes.added.map((m) => m.id)], [copy.messages, ['m102'], ['m105', 'm106']]);
    // Only fields: the same messages array.
    const fields = applyDelta(copy, { id: 's1', base: 1, rev: 2, fields: { title: 'T' }, count: 105 });
    assert.equal(fields.messages, copy.messages);
    assert.equal(fields.messagesFrom, 100);
  });

  test('a delta that does not add up is refused (the session is fetched again)', () => {
    const copy = tail(100, 105);
    const delta = (fields) => ({ id: 's1', base: 1, rev: 2, fields: {}, ...fields });
    assert.equal(applyDelta(copy, delta({ count: 107, messages: [message(105)] })), null, 'a message missing');
    assert.equal(applyDelta(copy, delta({ count: 104 })), null, 'fewer messages than held');
    assert.equal(applyDelta(copy, delta({ messages: [message(105)] })), null, 'no count');
    // Changed messages come in the list's order, so new ones last.
    assert.equal(applyDelta(copy, delta({ count: 106, messages: [message(105), message(102, { text: 'x' })] })), null, 'the new message is not last');
    assert.equal(applyDelta(copy, { ...delta({ count: 106, messages: [message(105)] }), base: 7 }), null, 'another revision');
  });

  test('a new order: the copy keeps the end from its first message on', () => {
    const copy = tail(100, 105);
    const order = [...range(0, 105).map((m) => m.id)];
    // A queued message from before the window is read now: it moves to the end (changed).
    const moved = order.filter((id) => id !== 'm50').concat('m50');
    const next = applyDelta(copy, { id: 's1', base: 1, rev: 2, fields: {}, count: 105, ids: moved, messages: [message(50, { text: 'read now' })] });
    assert.deepEqual(ids(next), ['m100', 'm101', 'm102', 'm103', 'm104', 'm50']);
    assert.equal(next.messagesFrom, 99);
    // One moving in unchanged is not something the copy has: refused.
    assert.equal(applyDelta(copy, { id: 's1', base: 1, rev: 2, fields: {}, count: 105, ids: moved }), null);
    // A held message moving to the end.
    const within = order.filter((id) => id !== 'm101').concat('m101');
    const shuffled = applyDelta(copy, { id: 's1', base: 1, rev: 2, fields: {}, count: 105, ids: within });
    assert.deepEqual(ids(shuffled), ['m100', 'm102', 'm103', 'm104', 'm101']);
    assert.equal(shuffled.messagesFrom, 100);
  });

  test("a new message under an agent call the copy does not hold is refused; with the call it is fine", () => {
    const copy = tail(100, 103);
    copy.messages[1] = { id: 'm101', role: 'tool', tool: 'Agent', toolId: 'held-call', state: 'running' };
    const step = (id, fields) => ({ id: 's1', base: 1, rev: 2, fields: {}, count: 104, messages: [{ id, role: 'tool', tool: 'Read', state: 'done', ...fields }] });
    assert.equal(applyDelta(copy, step('n1', { parentToolId: 'old-call' })), null);
    assert.equal(applyDelta(copy, { ...step('n1', {}), messages: [{ id: 'end', role: 'notice', text: 'done', agentToolId: 'old-call' }] }), null);
    assert.deepEqual(ids(applyDelta(copy, step('n1', { parentToolId: 'held-call' }))), ['m100', 'm101', 'm102', 'n1']);
  });

  test('a whole copy is unaffected', () => {
    const whole = { id: 's1', rev: 1, messages: range(0, 3) };
    const next = applyDelta(whole, { id: 's1', base: 1, rev: 2, fields: {}, count: 4, messages: [message(3)] });
    assert.deepEqual(ids(next), ['m0', 'm1', 'm2', 'm3']);
    assert.equal(next.messagesFrom, undefined);
  });
});

describe('fetched copies and older pages', () => {
  test('a fetched tail keeps the older messages held when the two meet', () => {
    const current = tail(50, 105);
    const fetched = { ...tail(80, 107), rev: 3, title: 'T' };
    const merged = applyFetchedSession({ current, sessions: [] }, fetched).current;
    assert.equal(merged.messagesFrom, 50);
    assert.deepEqual(ids(merged), range(50, 107).map((m) => m.id));
    assert.equal(merged.messages[0], current.messages[0], 'the older ones are the same objects');
    assert.equal(merged.messages[40], current.messages[40], 'unchanged ones in the tail too');
    assert.equal(merged.rev, 3);
    assert.equal(merged.title, 'T');
  });

  test('...and takes the fetched window as it is when they do not meet or an older one may have changed', () => {
    // The list changed before the fetched window (a message moved out of it).
    const shifted = { ...tail(80, 106), rev: 3, messages: range(81, 107) };
    assert.equal(mergeSession(tail(50, 105), shifted).messagesFrom, 80);
    assert.deepEqual(ids(mergeSession(tail(50, 105), shifted)), range(81, 107).map((m) => m.id));
    // A tool call held as running, outside the fetched window: it has ended since.
    const running = tail(50, 105);
    running.messages[10] = { ...running.messages[10], role: 'tool', tool: 'Bash', toolId: 't', state: 'running' };
    assert.equal(mergeSession(running, { ...tail(80, 107), rev: 3 }).messagesFrom, 80);
    // A user message on its way, likewise.
    const sent = tail(50, 105);
    sent.messages[3] = { ...sent.messages[3], role: 'user', delivery: 'running' };
    assert.equal(mergeSession(sent, { ...tail(80, 107), rev: 3 }).messagesFrom, 80);
    // A fetched copy reaching back further, or a whole one, is taken as it is.
    assert.equal(mergeSession(tail(50, 105), { ...tail(20, 107), rev: 3 }).messagesFrom, 20);
    const whole = mergeSession(tail(50, 105), { id: 's1', rev: 3, messages: range(0, 107) });
    assert.equal(whole.messagesFrom, undefined);
    assert.equal(whole.messages.length, 107);
  });

  test('a list-form event leaves the window alone', () => {
    const current = tail(50, 105);
    const { current: next } = applySessionEvent({ current, sessions: [] }, { id: 's1', status: 'running', updatedAt: 5 });
    assert.equal(next.messagesFrom, 50);
    assert.equal(next.messages, current.messages);
    assert.equal(next.status, 'running');
  });

  test('applyOlderMessages: a page goes in front of the first message held', () => {
    const state = { current: tail(400, 1000, { rev: 5 }) };
    const page = { messages: range(100, 400), from: 100, before: 400, messageCount: 1000, rev: 5 };
    const { current } = applyOlderMessages(state, 's1', 'm400', page);
    assert.equal(current.messagesFrom, 100);
    assert.equal(current.messages.length, 900);
    assert.equal(current.messages[300], state.current.messages[0]);
    // The last page: a whole copy.
    const first = applyOlderMessages({ current }, 's1', 'm100', { messages: range(0, 100), from: 0, before: 100, rev: 5 }).current;
    assert.equal(first.messagesFrom, undefined);
    assert.deepEqual(ids(first), range(0, 1000).map((m) => m.id));
  });

  test('applyOlderMessages: refused when the copy moved on or the page may be stale', () => {
    const state = { current: tail(400, 1000, { rev: 5 }) };
    const page = { messages: range(100, 400), from: 100, before: 400, rev: 5 };
    assert.equal(applyOlderMessages(state, 'other', 'm400', page), null, 'another session');
    assert.equal(applyOlderMessages(state, 's1', 'm401', page), null, 'another first message');
    assert.equal(applyOlderMessages(state, 's1', 'm400', { ...page, before: 399 }), null, 'another index');
    assert.equal(applyOlderMessages(state, 's1', 'm400', { ...page, from: 99 }), null, 'a gap');
    assert.equal(applyOlderMessages({ current: { ...state.current, messagesFrom: undefined } }, 's1', 'm400', page), null, 'whole already');
    // Deltas newer than the page skipped its messages: fine unless one could still change.
    const newer = { current: { ...state.current, rev: 6 } };
    assert.ok(applyOlderMessages(newer, 's1', 'm400', page));
    const queued = { ...page, messages: page.messages.map((m, i) => (i === 7 ? { ...m, role: 'user', delivery: 'queued' } : m)) };
    assert.equal(applyOlderMessages(newer, 's1', 'm400', queued), null);
    assert.ok(applyOlderMessages(state, 's1', 'm400', queued), 'not when the page is as new as the copy');
  });

  test('unsettled: what can still change in place', () => {
    assert.equal(unsettled({ role: 'tool', state: 'running' }), true);
    assert.equal(unsettled({ role: 'tool', state: 'done' }), false);
    for (const delivery of ['queued', 'sent', 'running', 'sending']) assert.equal(unsettled({ role: 'user', delivery }), true, delivery);
    for (const delivery of ['done', 'stopped', 'cancelled', 'dropped', undefined]) assert.equal(unsettled({ role: 'user', delivery }), false, String(delivery));
    assert.equal(unsettled({ role: 'notice' }), false);
  });
});

describe('the cache and what reads the messages', () => {
  test('cached tails follow deltas; one a delta does not fit is dropped; bounded by messages held', () => {
    const cache = createSessionCache({ entries: 5, messages: 1000 });
    cache.put(tail(100, 105));
    cache.applyDelta({ id: 's1', base: 1, rev: 2, fields: {}, count: 106, messages: [message(105)] });
    assert.deepEqual([cache.get('s1').rev, cache.get('s1').messagesFrom, cache.get('s1').messages.length], [2, 100, 6]);
    cache.applyDelta({ id: 's1', base: 2, rev: 3, fields: {}, count: 110, messages: [message(106)] });
    assert.equal(cache.has('s1'), false);
    // A tail counts the messages it holds, not those of the session.
    cache.put({ ...tail(9000, 9600), id: 'big' });
    cache.put({ ...tail(0, 300), id: 'small' });
    assert.equal(cache.size, 2);
  });

  test('briefSession drops the window; todosVisible, awaitingFirstTurn and showsTurnEnd on a tail', () => {
    assert.deepEqual(briefSession({ ...tail(10, 12), live: 'x', title: 'T' }), { id: 's1', rev: 1, status: 'idle', title: 'T' });

    const done = [{ content: 'a', status: 'completed', activeForm: 'a' }];
    // Completed before the window: shown until a turn starts in the part held.
    assert.equal(todosVisible({ ...tail(500, 600), todos: done }), true);
    const turn = tail(500, 600);
    turn.messages[50] = { id: 'u', role: 'user', text: 'next' };
    assert.equal(todosVisible({ ...turn, todos: done }), false);
    assert.equal(todosVisible({ messages: range(0, 100), todos: done }), false, 'a whole copy without the update: hidden as before');

    const imported = { source: 'claude', createdAt: 100, lastMessageAt: 100 };
    assert.equal(awaitingFirstTurn({ ...imported, messages: [] }), true);
    assert.equal(awaitingFirstTurn({ ...imported, ...tail(500, 600) }), true, 'no turn of its own anywhere');
    assert.equal(awaitingFirstTurn({ ...imported, ...tail(500, 600), lastMessageAt: 200 }), false, 'one before the window');
    assert.equal(awaitingFirstTurn({ ...imported, messages: [{ id: 'u', role: 'user', text: 'hi' }] }), false);

    // A notification reads how the last turn ended; a tail that does not show it is
    // fetched whole (src/attention.js).
    const steps = Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, role: 'tool', tool: 'Bash', state: 'done' }));
    assert.equal(showsTurnEnd(steps), false);
    assert.equal(turnWasStopped(steps), false, 'undecided: read as not stopped');
    assert.equal(showsTurnEnd([...steps, { id: 'end', role: 'turn', stopped: true }]), true);
    assert.equal(showsTurnEnd([{ id: 'u', role: 'user', delivery: 'stopped' }, ...steps]), true);
    assert.equal(showsTurnEnd([{ id: 'u', role: 'user', delivery: 'queued' }, ...steps]), false);
  });
});
