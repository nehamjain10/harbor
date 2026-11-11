// The agent view's data (src/lib/agentTranscript.js): where an agent sits among the
// session's agents, its messages followed through deltas, the entries built for its
// subtree (task, steps, nested agents, report, end) and the page URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentOutcome,
  agentPath,
  agentUrl,
  buildAgentEntries,
  createAgentSubtree,
  needsFiles,
  parseAgentUrl,
} from '../src/lib/agentTranscript.js';
import { applyDelta } from '../src/store.js';

const agent = (toolId, fields = {}) => ({
  id: 'm-' + toolId,
  role: 'tool',
  tool: 'Agent',
  toolId,
  input: { description: 'Survey the repo', subagent_type: 'Explore', prompt: 'Look around and report.' },
  state: 'running',
  at: 1000,
  ...fields,
});
const tool = (toolId, parentToolId, fields = {}) => ({ id: 'm-' + toolId, role: 'tool', tool: 'Bash', toolId, parentToolId, input: { command: 'ls' }, state: 'done', at: 2000, ...fields });
const say = (id, parentToolId, text, fields = {}) => ({ id, role: 'assistant', text, parentToolId, at: 3000, ...fields });

// A session: the user's message, agent a1 (a Bash call, a reply, nested agent a2 with a
// Read), an unrelated agent b1 with its own step, and the main reply.
function session() {
  return [
    { id: 'u1', role: 'user', text: 'Survey it.', at: 500, delivery: 'done' },
    agent('a1'),
    tool('s1', 'a1'),
    say('t1', 'a1', 'Two packages so far.'),
    agent('a2', { parentToolId: 'a1', input: { description: 'Read the README', subagent_type: 'general-purpose', prompt: 'Read it.' } }),
    tool('s2', 'a2', { tool: 'Read', input: { file_path: '/repo/README.md' } }),
    agent('b1', { input: { description: 'Other work', prompt: 'Elsewhere.' } }),
    tool('s3', 'b1'),
    say('r1', undefined, 'Both agents are working.'),
  ];
}

test('agentPath walks up from an agent call through the agents that started it', () => {
  const messages = session();
  assert.deepEqual(agentPath(messages, 'a1'), ['a1']);
  assert.deepEqual(agentPath(messages, 'a2'), ['a1', 'a2']);
  assert.deepEqual(agentPath(messages, 'a2', 'a1'), ['a2']);
  assert.equal(agentPath(messages, 's1'), null, 'not an agent');
  assert.equal(agentPath(messages, 'missing'), null);
  // A tool listed as its own parent ends the walk.
  assert.deepEqual(agentPath([agent('x', { parentToolId: 'x' })], 'x'), ['x']);
});

test('createAgentSubtree picks the agent card and every message under it, nested agents included', () => {
  const update = createAgentSubtree('a1');
  const messages = session();
  const view = update(messages);
  assert.equal(view.card, messages[1]);
  assert.deepEqual(
    view.messages.map((m) => m.id),
    ['m-s1', 't1', 'm-a2', 'm-s2'],
  );
  assert.equal(update(messages), view, 'same list, same result');
  // Its own transcript (from disk): no card, the messages under it all the same.
  const own = createAgentSubtree('a1')(messages.slice(2, 6));
  assert.equal(own.card, null);
  assert.equal(own.messages.length, 4);
});

test('createAgentSubtree follows deltas from what they changed and keeps its result when nothing of the agent did', () => {
  const update = createAgentSubtree('a1');
  let current = { id: 's', rev: 1, messages: session() };
  const first = update(current.messages);
  const step = (rev, messages, ids) => {
    current = applyDelta(current, { id: 's', rev, base: current.rev, fields: {}, messages, ...(ids ? { ids } : {}) });
    assert.ok(current, 'delta applies');
    return update(current.messages);
  };

  // An unrelated agent's step: a new list, the same view.
  assert.equal(step(2, [tool('s4', 'b1')]), first);

  // A nested agent's new step and a changed step of the agent itself.
  const second = step(3, [tool('s5', 'a2', { state: 'running' }), tool('s1', 'a1', { output: 'a\nb' })]);
  assert.notEqual(second, first);
  assert.deepEqual(
    second.messages.map((m) => m.id),
    ['m-s1', 't1', 'm-a2', 'm-s2', 'm-s5'],
  );
  assert.equal(second.messages[0].output, 'a\nb');
  assert.equal(second.messages[1], first.messages[1], 'unchanged messages keep their identity');
  assert.equal(second.card, first.card);

  // A step of the step just added (it is a member now), then the card ends.
  const third = step(4, [say('t2', 'a1', 'Done.')]);
  assert.equal(third.messages.at(-1).id, 't2');
  const fourth = step(5, [agent('a1', { state: 'done', output: 'Done.' })]);
  assert.equal(fourth.card.state, 'done');
  assert.equal(fourth.messages, third.messages);

  // A reordering delta (`ids`) is read in full, with the same outcome.
  const ids = current.messages.map((m) => m.id).reverse();
  const reordered = step(6, [], ids);
  assert.deepEqual(
    reordered.messages.map((m) => m.id).sort(),
    third.messages.map((m) => m.id).sort(),
  );

  // A full copy of the session (not from a delta) is read in full too.
  const full = update(session());
  assert.deepEqual(
    full.messages.map((m) => m.id),
    ['m-s1', 't1', 'm-a2', 'm-s2'],
  );
});

test('buildAgentEntries: the task first, steps grouped as in the transcript, nested agents under their cards, a working row while it runs', () => {
  const messages = session();
  const view = createAgentSubtree('a1')(messages);
  const { entries } = buildAgentEntries(view.card, view.messages);
  // The nested agent still runs: its row shows that, no working row is added.
  assert.deepEqual(
    entries.map((e) => e.type),
    ['agent-prompt', 'activity', 'assistant', 'activity'],
  );
  assert.equal(entries[0].text, 'Look around and report.');
  const nested = entries[3].items[0];
  assert.equal(nested.message.toolId, 'a2');
  assert.deepEqual(
    nested.children.map((child) => child.message.id),
    ['m-s2'],
  );

  // Between steps: the working row, counting from its latest message.
  const idle = view.messages.map((m) => (m.toolId === 'a2' ? { ...m, state: 'done', output: 'Read.' } : m));
  const thinking = buildAgentEntries(view.card, idle).entries.at(-1);
  assert.equal(thinking.type, 'working');
  assert.equal(thinking.since, 3000);
  assert.equal(thinking.waitingOn, undefined);

  // A worker between turns, its Monitors still up: the row says what it waits on.
  const waiting = buildAgentEntries({ ...view.card, progress: { description: 'Waiting on 2 background tasks', waitingOn: 2 } }, idle).entries.at(-1);
  assert.equal(waiting.type, 'working');
  assert.equal(waiting.waitingOn, 2);
});

test('buildAgentEntries shows the report once, then how the agent ended', () => {
  const card = agent('a1', { state: 'done', endedAt: 61_000, output: 'The repo has two packages.', usage: { toolUses: 2, tokens: 12_400, durationMs: 60_000 } });
  // Its last reply is the report (a background agent): it shows as the report only.
  const replied = buildAgentEntries(card, [tool('s1', 'a1'), say('t1', 'a1', 'The repo has two packages.')]);
  assert.deepEqual(
    replied.entries.map((e) => e.type),
    ['agent-prompt', 'activity', 'agent-report', 'agent-end'],
  );
  assert.equal(replied.entries[2].text, 'The repo has two packages.');
  assert.deepEqual(replied.entries[3], { type: 'agent-end', key: 'agent-end', outcome: 'finished', stats: '2 tool uses · 12k tokens · 1m 0s' });

  // No final reply among its steps (a foreground agent): the report is added.
  const quiet = buildAgentEntries(card, [say('t0', 'a1', 'Looking.'), tool('s1', 'a1')]);
  assert.deepEqual(
    quiet.entries.map((e) => e.type),
    ['agent-prompt', 'assistant', 'activity', 'agent-report', 'agent-end'],
  );

  // A model agent's report starts with its answer and adds what it changed.
  const delegate = { ...card, tool: 'mcp__meshy__delegate', input: { task: 'Write the tests.', description: 'Tests' }, output: 'All written.\n\nFiles changed: `a.test.js`' };
  const model = buildAgentEntries(delegate, [say('t1', 'a1', 'All written.')]);
  assert.deepEqual(
    model.entries.map((e) => e.type),
    ['agent-prompt', 'agent-report', 'agent-end'],
  );
  assert.equal(model.entries[0].text, 'Write the tests.');

  // Failed, stopped, and an older background agent whose card ended at its launch.
  const failed = buildAgentEntries({ ...card, state: 'error', usage: null, output: 'Agent crashed.' }, []);
  assert.deepEqual(failed.entries.slice(1), [
    { type: 'agent-report', key: 'agent-report', text: 'Agent crashed.', error: true },
    { type: 'agent-end', key: 'agent-end', outcome: 'failed', stats: '1m 0s' },
  ]);
  const stopped = buildAgentEntries({ ...card, state: 'error', stopped: true }, []);
  assert.equal(stopped.entries.at(-1).outcome, 'stopped');
  assert.equal(stopped.entries.some((e) => e.type === 'agent-report'), false);
  const launched = buildAgentEntries({ ...card, output: 'Async agent launched successfully.\nagentId: abc' }, []);
  assert.deepEqual(
    launched.entries.map((e) => e.type),
    ['agent-prompt', 'notice'],
  );
  assert.equal(agentOutcome(null), 'unknown');
});

test('buildAgentEntries keeps unchanged entries from the previous build', () => {
  const messages = session();
  const view = createAgentSubtree('a1')(messages);
  const first = buildAgentEntries(view.card, view.messages);
  const next = buildAgentEntries(view.card, [...view.messages, say('t3', 'a1', 'More.', { at: 5000 })], first);
  assert.equal(next.entries[0], first.entries[0], 'task');
  assert.equal(next.entries[1], first.entries[1], 'first activity');
  assert.equal(next.entries[3], first.entries[3], 'nested agent');
  assert.notEqual(next.entries[2], first.entries[2], 'the reply no longer ends the agent\'s replies');
  assert.equal(next.entries[2].message, first.entries[2].message);
});

test('needsFiles asks for Claude Code\'s transcript only for ended Claude Code agents without steps here', () => {
  const ended = agent('a1', { state: 'done', output: 'ok' });
  assert.equal(needsFiles(ended, []), true);
  assert.equal(needsFiles(ended, [tool('s1', 'a1')]), false);
  assert.equal(needsFiles(agent('a1'), []), false, 'running: its steps arrive live');
  assert.equal(needsFiles({ ...ended, tool: 'mcp__meshy__delegate' }, []), false, 'model agents have no such file');
  assert.equal(needsFiles(null, []), true, 'only known by its id');
});

test('agent URLs carry the session and the agent path; bad ids are dropped', () => {
  assert.equal(agentUrl('s-1', []), '?session=s-1');
  assert.equal(agentUrl('s-1', ['toolu_A', 'toolu_B']), '?session=s-1&agent=toolu_A&agent=toolu_B');
  assert.equal(agentUrl(null), '/');
  assert.deepEqual(parseAgentUrl('?session=s-1&agent=toolu_A&agent=toolu_B'), { session: 's-1', agents: ['toolu_A', 'toolu_B'] });
  assert.deepEqual(parseAgentUrl('?agent=../x&agent=ok'), { session: null, agents: ['ok'] });
});
