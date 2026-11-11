// Subagent helpers of the frontend: background agents still running, what one does now,
// a finished one's stats, the session status while only agents work, and the transcript
// entry that marks a background agent's end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentActivity, agentAwaiting, agentStats, latestStep, runningBackgroundAgents } from '../src/lib/agents.js';
import { sessionDot, statusLabel } from '../src/lib/sessions.js';
import { buildEntries } from '../src/lib/transcript.js';

const agent = (fields = {}) => ({ id: 'm-' + (fields.toolId || 'a1'), role: 'tool', tool: 'Agent', toolId: 'a1', input: { description: 'Look around' }, state: 'running', at: 1000, ...fields });

test('runningBackgroundAgents keeps top-level background agents that still run', () => {
  const messages = [
    agent({ toolId: 'a1', background: true }),
    agent({ toolId: 'a2' }),
    agent({ toolId: 'a3', background: true, state: 'done' }),
    agent({ toolId: 'a4', background: true, parentToolId: 'a1' }),
    { id: 'b', role: 'tool', tool: 'Bash', toolId: 'b1', state: 'running', background: true },
    agent({ toolId: 'a5', tool: 'Task', background: true }),
  ];
  assert.deepEqual(
    runningBackgroundAgents(messages).map((m) => m.toolId),
    ['a1', 'a5'],
  );
  assert.deepEqual(runningBackgroundAgents(undefined), []);
});

test('agentActivity names the latest step, else the progress tool or description', () => {
  const messages = [
    agent(),
    { id: 's1', role: 'tool', tool: 'Read', toolId: 's1', parentToolId: 'a1', input: { file_path: '/repo/a.txt' }, state: 'done' },
    { id: 's2', role: 'tool', tool: 'Bash', toolId: 's2', parentToolId: 'a1', input: { command: 'npm test' }, state: 'running' },
    { id: 's3', role: 'tool', tool: 'Bash', toolId: 's3', parentToolId: 'other', input: { command: 'ls' }, state: 'running' },
  ];
  const step = latestStep(messages, 'a1');
  assert.equal(step.toolId, 's2');
  assert.equal(agentActivity(messages[0], step, '/repo'), 'Running npm test');
  assert.equal(latestStep(messages, 'none'), null);
  assert.equal(agentActivity(agent({ progress: { lastTool: 'Grep' } }), null), 'Using Grep');
  assert.equal(agentActivity(agent({ progress: { description: 'Reading files' } }), null), 'Reading files');
  // A worker between turns says what it waits on, not its last tool.
  assert.equal(agentActivity(agent({ progress: { description: 'Waiting on 1 background task', waitingOn: 1, lastTool: 'Monitor' } }), null), 'Waiting on 1 background task');
  assert.equal(agentActivity(agent(), null), 'Starting…');
});

test('agentStats says what a finished agent took', () => {
  assert.equal(agentStats(agent({ usage: { toolUses: 12, tokens: 45_300, durationMs: 64_000 } })), '12 tool uses · 45k tokens · 1m 4s');
  assert.equal(agentStats(agent({ usage: { toolUses: 1, tokens: 1020, durationMs: 400 } })), '1 tool use · 1.0k tokens · 0s');
  assert.equal(agentStats(agent({ usage: { toolUses: 0, tokens: 0, durationMs: 0 } })), '');
  assert.equal(agentStats(agent()), '');
});

test('agentAwaiting matches approvals asked from inside the agent', () => {
  const pending = [{ id: 'p1', toolUseID: 's2', agent: { toolId: 'a1', description: 'Look around' } }, { id: 'p2', toolUseID: 'x' }];
  assert.equal(agentAwaiting(pending, 'a1'), true);
  assert.equal(agentAwaiting(pending, 'a2'), false);
  assert.equal(agentAwaiting(undefined, 'a1'), false);
});

test('an idle session with background agents reads as working', () => {
  assert.equal(statusLabel('idle', 1), '1 agent running');
  assert.equal(statusLabel('idle', 3), '3 agents running');
  assert.equal(statusLabel('running', 2), 'Working');
  assert.equal(statusLabel('waiting', 2), 'Needs you');
  assert.equal(statusLabel('idle'), 'Ready');
  assert.equal(sessionDot({ status: 'idle', backgroundAgents: 1 }), 'running');
  assert.equal(sessionDot({ status: 'idle', backgroundAgents: 1, pending: [{}] }), 'needs-you');
  assert.equal(sessionDot({ status: 'error', backgroundAgents: 1 }), 'error');
  assert.equal(sessionDot({ status: 'idle', backgroundAgents: 0 }), null);
});

test('buildEntries shows a background agent ending as its card again, and the reply after it gets a header', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'go', at: 900 },
    agent({ background: true, state: 'done', usage: { toolUses: 1, tokens: 10, durationMs: 5 } }),
    { id: 'c1', role: 'tool', tool: 'Bash', toolId: 'c1', parentToolId: 'a1', input: { command: 'ls' }, state: 'done', at: 1100 },
    { id: 'r1', role: 'assistant', text: 'Started it.', at: 1200 },
    { id: 't1', role: 'turn', at: 1300 },
    { id: 'n1', role: 'notice', text: 'Background agent “Look around” finished.', level: 'info', agentToolId: 'a1', at: 2000 },
    { id: 'r2', role: 'assistant', text: 'It found things.', at: 2100 },
    { id: 't2', role: 'turn', at: 2200 },
    { id: 'n2', role: 'notice', text: 'Background agent finished.', level: 'info', agentToolId: 'gone', at: 2300 },
  ];
  const { entries } = buildEntries(messages);
  assert.deepEqual(
    entries.map((e) => e.type),
    ['user', 'activity', 'assistant', 'turn', 'agent-event', 'assistant', 'turn', 'notice'],
  );
  const event = entries[4];
  assert.equal(event.node.message.toolId, 'a1');
  assert.deepEqual(
    event.node.children.map((child) => child.message.toolId),
    ['c1'],
  );
  assert.equal(entries[5].showHeader, false, 'the same model is not named again after the report');
  // An event whose Agent call is not in the transcript falls back to a plain notice.
  assert.equal(entries[7].message.id, 'n2');
});

test('a subagent shows the model its Agent call names, else the session model it inherits', async () => {
  const { subagentModelLabel } = await import('../src/lib/agents.js');
  const info = { models: [{ id: 'opus', name: 'Claude Opus 5.5' }, { id: 'luna', name: 'GPT-6 Luna' }] };
  const call = (input) => ({ role: 'tool', tool: 'Agent', input });
  assert.equal(subagentModelLabel(call({ model: 'opus' }), info, 'luna'), 'Claude Opus 5.5');
  assert.equal(subagentModelLabel(call({}), info, 'luna'), 'GPT-6 Luna (session model)');
  assert.equal(subagentModelLabel(call({ model: 'nope' }), info, 'opus'), 'Claude Opus 5.5 (session model)');
  assert.equal(subagentModelLabel(call({}), info, ''), '');
  // A model agent names its model on its own card, not here.
  assert.equal(subagentModelLabel({ role: 'tool', tool: 'mcp__meshy__delegate', input: { model: 'luna' } }, info, 'opus'), '');
});
