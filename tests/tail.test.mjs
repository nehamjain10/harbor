// Where a tail or an older page of a session's messages starts (server/tail.mjs).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseLimit, windowStart } from '../server/tail.mjs';

// `turns` turns of a user message and a reply (2 messages each), ids u<i> / a<i>.
function chat(turns, start = 0) {
  const messages = [];
  for (let i = start; i < start + turns; i++) {
    messages.push({ id: `u${i}`, role: 'user', text: `Question ${i}`, delivery: 'done' });
    messages.push({ id: `a${i}`, role: 'assistant', text: `Answer ${i}` });
  }
  return messages;
}

// `count` top-level tool calls without a user message between them (one long turn).
function tools(count, prefix = 't') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, role: 'tool', tool: 'Bash', toolId: `${prefix}-call-${i}`, state: 'done' }));
}

// Whether a window from `start` holds every agent call its messages belong to.
function complete(messages, start) {
  const calls = new Set(messages.slice(start).filter((m) => m.role === 'tool').map((m) => m.toolId));
  const known = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolId));
  return messages.slice(start).every((m) => [m.parentToolId, m.agentToolId].every((ref) => !ref || !known.has(ref) || calls.has(ref)));
}

describe('windowStart', () => {
  test('a list within the limit is sent whole', () => {
    const messages = chat(100);
    assert.equal(windowStart(messages, { limit: 300 }), 0);
    assert.equal(windowStart(messages, { limit: 200 }), 0);
    assert.equal(windowStart([], { limit: 10 }), 0);
  });

  test('cuts at the start of a turn, at least the limit back and within twice it', () => {
    // Turns of 7 messages: a user message, then 6 others.
    const messages = [];
    for (let i = 0; i < 300; i++) {
      messages.push({ id: `u${i}`, role: 'user', text: 'q', delivery: 'done' });
      for (let k = 0; k < 6; k++) messages.push({ id: `m${i}-${k}`, role: k % 2 ? 'assistant' : 'thinking', text: 'x' });
    }
    const start = windowStart(messages, { limit: 300 });
    assert.equal(messages[start].role, 'user');
    assert.ok(messages.length - start >= 300 && messages.length - start < 307, `window of ${messages.length - start}`);
    // Queued, mid-turn and cancelled messages are not a turn's start.
    const queued = chat(400);
    const target = queued.length - 300;
    queued[target] = { ...queued[target], delivery: 'queued' };
    assert.equal(windowStart(queued, { limit: 300 }), target - 2);
  });

  test("an agent's messages come with its call, however far back it is", () => {
    // A background agent started at 10 reports nested steps until the end.
    const messages = [...chat(5), { id: 'agent', role: 'tool', tool: 'Agent', toolId: 'ag1', state: 'done', background: true }, ...chat(1000, 5)];
    for (let i = 20; i < messages.length; i += 50) messages.splice(i, 0, { id: `n${i}`, role: 'tool', tool: 'Read', toolId: `r${i}`, parentToolId: 'ag1', state: 'done' });
    const start = windowStart(messages, { limit: 300 });
    assert.ok(start <= 10, `starts at ${start}, before the agent's call`);
    assert.ok(complete(messages, start));
    // A nested agent: its call is nested too, and pulls in the outer one.
    const deep = [{ id: 'outer', role: 'tool', tool: 'Agent', toolId: 'o1', state: 'done' }, { id: 'inner', role: 'tool', tool: 'Agent', toolId: 'i1', parentToolId: 'o1', state: 'done' }, ...chat(500)];
    deep.push({ id: 'late', role: 'assistant', text: 'inner step', parentToolId: 'i1' });
    assert.equal(windowStart(deep, { limit: 100 }), 0);
  });

  test("a background agent's end notice comes with its card", () => {
    const messages = [...chat(200), { id: 'card', role: 'tool', tool: 'Agent', toolId: 'bg1', state: 'done', background: true }, ...chat(400, 200)];
    messages.push({ id: 'end', role: 'notice', text: 'Background agent finished.', agentToolId: 'bg1' });
    // No turn starts within reach: the nearest boundary, the card itself.
    assert.equal(windowStart(messages, { limit: 100 }), 400);
    assert.ok(complete(messages, 400));
    assert.ok(complete(messages, windowStart(messages, { limit: 350 })));
  });

  test('live messages are always held: running calls, unread messages, the running turn', () => {
    const running = [...chat(50), { id: 'run', role: 'tool', tool: 'Agent', toolId: 'live1', state: 'running', background: true }, ...chat(500, 50)];
    assert.ok(windowStart(running, { limit: 100 }) <= 100);
    const unread = [...chat(50), { id: 'steer', role: 'user', text: 'also this', delivery: 'sent' }, ...tools(500)];
    assert.ok(windowStart(unread, { limit: 100 }) <= 100);
    const turn = [...chat(50), { id: 'turn-start', role: 'user', text: 'go', delivery: 'running' }, ...tools(500)];
    assert.ok(windowStart(turn, { limit: 100, currentMessageId: 'turn-start' }) <= 100);
    assert.ok(windowStart(turn, { limit: 100 }) > 400, 'without it the long turn is cut');
  });

  test('without a turn start nearby, the nearest top-level boundary; never a nested message', () => {
    // One long turn of tool calls: the cut is where the limit says.
    const messages = [...chat(2), ...tools(1000)];
    assert.equal(windowStart(messages, { limit: 300 }), messages.length - 300);
    // A subagent's steps right where the limit falls: the nearest boundary outside them.
    const nested = [...chat(2), ...tools(600, 'a'), { id: 'call', role: 'tool', tool: 'Agent', toolId: 'sub', state: 'done' }];
    for (let i = 0; i < 60; i++) nested.push({ id: `s${i}`, role: 'tool', tool: 'Read', toolId: `s-${i}`, parentToolId: 'sub', state: 'done' });
    nested.push(...tools(250, 'b'));
    const start = windowStart(nested, { limit: 300 });
    assert.equal(nested[start].parentToolId, undefined);
    assert.ok(complete(nested, start));
    assert.equal(start, nested.findIndex((m) => m.id === 'call'), 'back to the call (closer than the end of its steps)');
    // Later is fine when that is nearer and keeps half the limit.
    const later = [...chat(2), ...tools(600, 'a'), { id: 'call', role: 'tool', tool: 'Agent', toolId: 'sub', state: 'done' }];
    for (let i = 0; i < 200; i++) later.push({ id: `s${i}`, role: 'tool', tool: 'Read', toolId: `s-${i}`, parentToolId: 'sub', state: 'done' });
    later.push(...tools(250, 'b'));
    const after = windowStart(later, { limit: 300 });
    assert.equal(later[after].id, 'b0');
  });

  test('less than half the limit left before the cut comes along', () => {
    const messages = [...tools(50), ...chat(150)];
    // The turn start at 50 would leave 50 messages before it: half of 300 is 150.
    assert.equal(windowStart(messages, { limit: 300 }), 0);
    assert.equal(windowStart([...tools(200), ...chat(150)], { limit: 300 }), 200);
  });

  test('older pages: [start, end) is cut so that everything from start on is complete', () => {
    const messages = chat(1000);
    const tail = windowStart(messages, { limit: 300 });
    const page = windowStart(messages, { end: tail, limit: 400 });
    assert.equal(tail - page, 400);
    assert.equal(messages[page].role, 'user');
    // Steps after `end` (held already) pull the page back to their call.
    const nested = [...chat(100), { id: 'call', role: 'tool', tool: 'Agent', toolId: 'bg', state: 'done', background: true }, ...chat(600, 100)];
    nested.push({ id: 'late', role: 'assistant', text: 'step', parentToolId: 'bg' });
    const end = nested.length - 10;
    const start = windowStart(nested, { end, limit: 100 });
    assert.ok(start <= 200 && complete(nested, start));
    assert.equal(windowStart(nested, { end: 0, limit: 100 }), 0);
    assert.equal(windowStart(nested, { end: 120, limit: 1000 }), 0, 'all of it');
  });
});

test('parseLimit takes a positive whole number of messages', () => {
  assert.equal(parseLimit('300'), 300);
  assert.equal(parseLimit('1'), 1);
  for (const bad of ['0', '-1', '1.5', 'abc', '', ' 3', undefined, ['3']]) assert.equal(parseLimit(bad), null, String(bad));
  assert.equal(parseLimit('999999999'), 1_000_000, 'capped');
});
