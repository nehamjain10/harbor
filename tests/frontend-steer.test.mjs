// Steering a model agent from the web app: messages to a worker (user messages nested
// under its card) in the entries, the agent view and every place that treats a user
// message as a turn; the tool rows of the lead's message_agent, stop_agent and
// check_agents calls; the composer's helpers for the agent panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentOutcome, buildAgentEntries, createAgentSubtree, sendingEntries, withSending } from '../src/lib/agentTranscript.js';
import { awaitingFirstTurn } from '../src/lib/imports.js';
import { turnWasStopped } from '../src/lib/notify.js';
import { todosVisible } from '../src/lib/todos.js';
import { groupSummary, runningLabel, toolSummary } from '../src/lib/tools.js';
import { buildEntries, liveEntries, turnStartedAt } from '../src/lib/transcript.js';

const DELEGATE = 'mcp__meshy__delegate';

const worker = (fields = {}) => ({
  id: 'm-d1',
  role: 'tool',
  tool: DELEGATE,
  toolId: 'd1',
  input: { model: 'luna', task: 'Write the parser tests.', description: 'Parser tests' },
  agentModel: 'luna',
  agentId: 'luna-a1b2c3',
  taskId: 'luna-a1b2c3',
  state: 'running',
  background: true,
  at: 2000,
  ...fields,
});
const step = (toolId, parentToolId, fields = {}) => ({ id: 'm-' + toolId, role: 'tool', tool: 'Bash', toolId, parentToolId, input: { command: 'ls' }, state: 'done', at: 3000, ...fields });
const say = (id, parentToolId, text, fields = {}) => ({ id, role: 'assistant', text, parentToolId, at: 4000, ...fields });
const toLead = (id, text, fields = {}) => ({ id, role: 'user', text, parentToolId: 'd1', from: 'lead', delivery: 'done', at: 5000, ...fields });

test('a message to a worker is a step of its card: never a turn, a bubble or a break in the activity group', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'Split the work.', at: 1000, delivery: 'done' },
    step('b0', undefined, { at: 1500 }),
    worker(),
    step('s1', 'd1'),
    toLead('l1', 'Also cover the lexer edge cases.'),
    toLead('l2', 'Skip the fixtures.', { from: 'user', delivery: 'sent', clientId: 'c-1' }),
    say('t1', 'd1', 'On it.'),
    step('b1', undefined, { at: 6000 }),
    { id: 'a1', role: 'assistant', text: 'The worker is on it.', at: 7000 },
    { id: 'a2', role: 'assistant', text: 'More soon.', at: 7100 },
    { id: 'turn1', role: 'turn', duration: 6000 },
  ];
  const { entries } = buildEntries(messages);
  // One user turn; the tools around the nested messages stay one group.
  assert.deepEqual(entries.map((e) => e.type), ['user', 'activity', 'assistant', 'assistant', 'turn']);
  assert.equal(entries.filter((e) => e.type === 'user').length, 1);
  const group = entries[1];
  assert.deepEqual(group.items.map((n) => n.message.id), ['m-b0', 'm-d1', 'm-b1']);
  assert.equal(group.tools, 3);
  // The messages are the card's steps, in order, whatever their delivery.
  const card = group.items[1];
  assert.deepEqual(card.children.map((n) => [n.kind, n.message.id]), [['tool', 'm-s1'], ['steer', 'l1'], ['steer', 'l2'], ['text', 't1']]);
  // The turn's reply is one turn (the nested messages ended nothing).
  assert.equal(entries[3].turnEnd, true);
  assert.equal(entries[3].turnText, 'The worker is on it.\n\nMore soon.');
  assert.equal(entries[2].showHeader, true);
  assert.equal(entries[3].showHeader, false);
});

test('a message to a worker does not move the clock of the turn, the thinking time or the working row', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'Go.', at: 1000, delivery: 'running' },
    worker(),
    { id: 'th1', role: 'thinking', text: 'Planning.', at: 3000 },
    toLead('l1', 'Hurry.', { at: 9000, delivery: 'sent' }),
    { id: 'th2', role: 'thinking', text: 'Still planning.', at: 12_000 },
  ];
  const { entries, lastActivityAt } = buildEntries(messages);
  // Thinking is timed from the previous top-level message, not from the lead's message.
  assert.equal(entries.find((e) => e.key === 'th2' || e.message?.id === 'th2').duration, 9000);
  assert.equal(lastActivityAt, 12_000);
  assert.equal(turnStartedAt({ messages }), 1000);
  assert.equal(turnStartedAt({ messages, currentMessageId: 'u1' }), 1000);
  const late = [...messages, toLead('l2', 'And again.', { at: 20_000 })];
  assert.equal(turnStartedAt({ messages: late }), 1000, 'the latest user message of the conversation, not of the worker');
  // Nothing of it shows as a transient entry either.
  assert.deepEqual(liveEntries({ status: 'idle', messages }, buildEntries(messages)).map((e) => e.type), []);
});

test('a message whose card is not in the list shows nowhere in the conversation', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'Hi.', at: 1000, delivery: 'done' },
    toLead('orphan', 'Read at its next step.', { parentToolId: 'gone' }),
    { id: 'a1', role: 'assistant', text: 'Hello.', at: 2000 },
  ];
  assert.deepEqual(buildEntries(messages).entries.map((e) => e.type), ['user', 'assistant']);
});

test('a long run of messages to workers leaves the entries, their count and the window untouched', () => {
  const messages = [{ id: 'u1', role: 'user', text: 'Go.', at: 1000, delivery: 'done' }, worker({ state: 'done' })];
  for (let i = 0; i < 200; i++) messages.push(toLead('l' + i, 'Message ' + i, { at: 2000 + i }));
  messages.push({ id: 'a1', role: 'assistant', text: 'Done.', at: 9000 });
  const { entries, messageCount } = buildEntries(messages);
  assert.deepEqual(entries.map((e) => e.type), ['user', 'activity', 'assistant']);
  assert.equal(entries[1].items[0].children.length, 200);
  assert.equal(messageCount, messages.length);
});

test('the agent view: a message to the agent is a steer entry in order, with its delivery; the next reply is headed again', () => {
  const messages = [
    step('s1', 'd1'),
    say('t1', 'd1', 'Reading the parser.'),
    toLead('l1', 'Also cover the lexer.', { at: 4500 }),
    toLead('l2', 'Not now.', { from: 'user', delivery: 'dropped', at: 4600 }),
    toLead('l3', 'Skip the fixtures.', { from: 'user', delivery: 'sent', at: 4700, clientId: 'c-3' }),
    say('t2', 'd1', 'Will do.', { at: 4800 }),
    { id: 'm-inner', role: 'tool', tool: 'Agent', toolId: 'in', parentToolId: 'd1', input: {}, state: 'done', at: 4900, output: 'ok' },
    // A message to an agent the worker started: its card's step, not this view's.
    { id: 'l9', role: 'user', text: 'Deeper.', parentToolId: 'in', from: 'lead', delivery: 'done', at: 5000 },
  ];
  const card = worker();
  const { entries } = buildAgentEntries(card, createAgentSubtree('d1')([card, ...messages]).messages);
  assert.deepEqual(entries.map((e) => e.type), ['agent-prompt', 'activity', 'assistant', 'steer', 'steer', 'steer', 'assistant', 'activity', 'working']);
  assert.deepEqual(entries.filter((e) => e.type === 'steer').map((e) => [e.message.id, e.message.from, e.message.delivery]), [
    ['l1', 'lead', 'done'],
    ['l2', 'user', 'dropped'],
    ['l3', 'user', 'sent'],
  ]);
  assert.equal(entries[6].showHeader, false, 'the same speaker is not named again after a message');
  const inner = entries[7].items[0];
  assert.deepEqual(inner.children.map((n) => [n.kind, n.message.id]), [['steer', 'l9']]);
  // A steer entry keeps its identity while its message does not change.
  const first = buildAgentEntries(card, createAgentSubtree('d1')([card, ...messages]).messages);
  const again = buildAgentEntries(card, createAgentSubtree('d1')([card, ...messages]).messages, first);
  assert.equal(again.entries[3], first.entries[3]);
  // The delivery moving on replaces just that entry.
  const read = messages.map((m) => (m.id === 'l3' ? { ...m, delivery: 'done' } : m));
  const next = buildAgentEntries(card, createAgentSubtree('d1')([card, ...read]).messages, first);
  assert.notEqual(next.entries[5], first.entries[5]);
  assert.equal(next.entries[3], first.entries[3]);
});

test('every other reader of user messages skips the ones sent to an agent', () => {
  // The completed task list stays through the turn that completed it; a message to a
  // worker is not a later turn.
  const todos = [{ content: 'a', status: 'completed' }];
  const update = { id: 'tw', role: 'tool', tool: 'TodoWrite', toolId: 'tw', input: { todos }, state: 'done' };
  const session = { todos, messages: [{ id: 'u1', role: 'user', delivery: 'done' }, update, toLead('l1', 'x')] };
  assert.equal(todosVisible(session), true);
  session.messages.push({ id: 'u2', role: 'user', text: 'next', delivery: 'done' });
  assert.equal(todosVisible(session), false);

  // The stop came before a result: the user message of the turn says so, a worker's does not.
  assert.equal(turnWasStopped([{ role: 'user', delivery: 'stopped' }, toLead('l1', 'x')]), true);

  // An imported session still waits for its first turn here.
  const imported = { source: { kind: 'claude' }, messages: [{ id: 'i1', role: 'user', imported: true }, toLead('l1', 'x')] };
  assert.equal(awaitingFirstTurn(imported), true);
});

test('a worker stopped by the lead is stopped; a failed one is not', () => {
  assert.equal(agentOutcome(worker({ state: 'error', stopped: true, stoppedBy: 'lead' })), 'stopped');
  assert.equal(agentOutcome(worker({ state: 'error' })), 'failed');
});

/* The lead's tools for its workers */

const lead = (tool, input, fields = {}) => ({ id: 'm-' + tool, role: 'tool', tool: 'mcp__meshy__' + tool, toolId: 'x-' + tool, input, state: 'done', at: 6000, ...fields });
const luna = { id: 'luna-a1b2c3', toolId: 'd1', description: 'Parser tests', model: 'luna', name: 'GPT-6 Luna agent' };

test('message_agent reads "Messaged <model> agent" with the message as its target', () => {
  const call = lead('message_agent', { id: 'luna-a1b2c3', message: 'Also cover the lexer edge cases.\nAnd the fixtures.' });
  assert.deepEqual(toolSummary(call, '/repo', [luna]), { verb: 'Messaged GPT-6 Luna agent', target: 'Also cover the lexer edge cases.', kind: 'message', mono: false, path: false, stats: null });
  assert.equal(toolSummary({ ...call, state: 'running' }, '/repo', [luna]).verb, 'Messaging GPT-6 Luna agent');
  assert.equal(runningLabel(call, '/repo'), 'Messaging agent Also cover the lexer edge cases.');
  // A worker the session has no card for: the verb stays generic.
  assert.equal(toolSummary(call, '/repo').verb, 'Messaged agent');
  assert.equal(toolSummary(call, '/repo', []).verb, 'Messaged agent');
  // A long message is clipped to one line of the target.
  const long = toolSummary(lead('message_agent', { id: luna.id, message: 'word '.repeat(100) }), '/repo', [luna]).target;
  assert.ok(long.length <= 200 && long.endsWith('…'), long.length);
  // Without a message, the worker it was for.
  assert.equal(toolSummary(lead('message_agent', { id: luna.id }), '/repo', [luna]).target, 'Parser tests');
});

test('stop_agent reads "Stopped agent" and the worker by what it does, else by id', () => {
  const call = lead('stop_agent', { id: luna.id, reason: 'Wrong approach' });
  assert.deepEqual(toolSummary(call, '/repo', [luna]), { verb: 'Stopped agent', target: 'Parser tests', kind: 'stop', mono: false, path: false, stats: null });
  assert.equal(toolSummary({ ...call, state: 'running' }, '/repo', [luna]).verb, 'Stopping agent');
  assert.equal(toolSummary(call, '/repo').target, 'luna-a1b2c3');
  assert.equal(toolSummary(call, '/repo', [{ ...luna, description: '' }]).target, 'luna-a1b2c3');
});

test('check_agents reads "Checked agents"; it and wait_agents name the workers they were about', () => {
  const deepseek = { id: 'deepseek-d4e5f6', toolId: 'd2', description: 'Lexer tests', model: 'deepseek', name: 'DeepSeek V4.1 Flash agent' };
  const check = lead('check_agents', {});
  assert.deepEqual(toolSummary(check, '/repo'), { verb: 'Checked agents', target: 'all workers', kind: 'check', mono: false, path: false, stats: null });
  assert.equal(toolSummary({ ...check, state: 'running' }).verb, 'Checking agents');
  assert.equal(toolSummary(lead('check_agents', { ids: [luna.id, deepseek.id] }), '/repo', [luna, deepseek]).target, 'Parser tests, Lexer tests');
  assert.equal(toolSummary(lead('check_agents', { ids: [luna.id, 'nope'] }), '/repo', [luna]).target, 'Parser tests, nope');
  assert.equal(toolSummary(lead('wait_agents', { ids: [luna.id], mode: 'any' }), '/repo', [luna]).target, 'first of Parser tests');
  assert.equal(toolSummary(lead('wait_agents', { ids: [luna.id] }), '/repo').target, 'luna-a1b2c3', 'the id when the card is unknown');
  assert.equal(toolSummary(lead('wait_agents', {}), '/repo').target, 'all workers');
});

test('group summaries count the lead\'s worker tools', () => {
  const tools = [
    lead('delegate', { model: 'luna', task: 't' }, { id: 'a' }),
    lead('delegate', { model: 'deepseek', task: 't' }, { id: 'b' }),
    lead('message_agent', { id: 'x', message: 'hi' }, { id: 'c' }),
    lead('check_agents', {}, { id: 'd' }),
    lead('stop_agent', { id: 'x' }, { id: 'e' }),
    lead('wait_agents', {}, { id: 'f' }),
  ];
  assert.equal(groupSummary(tools), 'Ran 2 agents, sent 1 agent message, stopped 1 agent, waited, checked agents');
  assert.equal(groupSummary([tools[3]]), 'Checked agents');
});

test('entries resolve the workers a lead tool names from the delegate cards, nested ones too', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'Go.', at: 1000, delivery: 'done' },
    worker(),
    worker({ id: 'm-d2', toolId: 'd2', agentId: 'deepseek-d4e5f6', agentModel: 'deepseek', input: { model: 'deepseek', task: 't', description: 'Lexer tests' } }),
    // A worker started by an agent (nested) is found as well.
    worker({ id: 'm-d3', toolId: 'd3', parentToolId: 'd1', agentId: 'kimi-111111', agentModel: 'kimi', input: { model: 'kimi', task: 't', description: 'Deep one' } }),
    lead('message_agent', { id: 'luna-a1b2c3', message: 'hi' }, { id: 'm1' }),
    lead('stop_agent', { id: 'nobody-000000' }, { id: 'm2' }),
    lead('check_agents', { ids: ['deepseek-d4e5f6', 'kimi-111111'] }, { id: 'm3' }),
    lead('check_agents', {}, { id: 'm4' }),
    step('b1', undefined),
  ];
  const nodes = buildEntries(messages).entries[1].items;
  const byId = Object.fromEntries(nodes.map((n) => [n.message.id, n]));
  assert.deepEqual(byId.m1.workers, [{ id: 'luna-a1b2c3', toolId: 'd1', model: 'luna', description: 'Parser tests' }]);
  assert.equal(byId.m2.workers, undefined, 'an unknown id');
  assert.deepEqual(byId.m3.workers.map((w) => w.description), ['Lexer tests', 'Deep one']);
  assert.equal(byId.m4.workers, undefined, 'all workers');
  assert.equal(byId['m-b1'].workers, undefined, 'other tools');
  // Rebuilt from the same messages: the same nodes.
  const first = buildEntries(messages);
  assert.equal(buildEntries(messages, first).entries[1], first.entries[1]);
});

/* Messages on their way (the agent panel's message box) */

test('sendingEntries: a message waits as a "Sending…" row until its copy (same clientId) is among the agent\'s messages', () => {
  const sends = [
    { key: 1, clientId: 'c-1', sessionId: 's1', toolId: 'd1', text: 'first', at: 100 },
    { key: 2, clientId: 'c-2', sessionId: 's1', toolId: 'd1', text: 'second', at: 200 },
    { key: 3, clientId: 'c-3', sessionId: 's1', toolId: 'd2', text: 'another agent', at: 300 },
    { key: 4, clientId: 'c-4', sessionId: 's2', toolId: 'd1', text: 'another session', at: 400 },
  ];
  const messages = [step('s1', 'd1'), toLead('l1', 'Hi.')];
  const rows = sendingEntries(sends, 's1', 'd1', messages);
  assert.deepEqual(rows.map((r) => [r.type, r.key, r.message.text, r.message.delivery, r.message.from, r.message.parentToolId]), [
    ['steer', 'c-1', 'first', 'sending', 'user', 'd1'],
    ['steer', 'c-2', 'second', 'sending', 'user', 'd1'],
  ]);
  // The first one's copy arrived: only the second waits.
  const arrived = [...messages, toLead('srv-1', 'first', { from: 'user', delivery: 'sent', clientId: 'c-1' })];
  assert.deepEqual(sendingEntries(sends, 's1', 'd1', arrived).map((r) => r.key), ['c-2']);
  // Nothing to send: the same empty list every time (no new array per update).
  assert.equal(sendingEntries([], 's1', 'd1', messages), sendingEntries(sends, 's1', 'd9', messages));
  // Its copy takes the row's key, so the bubble stays where it is when it arrives.
  const { entries } = buildAgentEntries(worker(), arrived.filter((m) => m.parentToolId === 'd1'));
  assert.ok(entries.some((e) => e.type === 'steer' && e.key === 'c-1'));
});

test('withSending puts the sending rows before the working row, else at the end', () => {
  const sending = [{ type: 'steer', key: 'c-1' }];
  assert.deepEqual(withSending([{ type: 'activity' }, { type: 'working' }], sending).map((e) => e.type), ['activity', 'steer', 'working']);
  assert.deepEqual(withSending([{ type: 'activity' }, { type: 'agent-end' }], sending).map((e) => e.type), ['activity', 'agent-end', 'steer']);
  const same = [{ type: 'activity' }];
  assert.equal(withSending(same, []), same);
});
