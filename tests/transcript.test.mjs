// applySdkMessage: synthetic edge cases plus replays of real SDK message sequences
// recorded from Claude Code against the mock gateway (tests/fixtures/record.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { NOTICES, applySdkMessage, requestingAgent, toolOutputText } from '../server/transcript.mjs';

function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/sdk-${name}.json`, import.meta.url)));
}

function newSession(extra = {}) {
  return { id: 's1', model: 'luna', status: 'running', messages: [], pending: [], live: '', liveThinking: '', ...extra };
}

/** A ctx that records which publishing callbacks ran. */
function track(extra = {}) {
  const calls = [];
  const ctx = {
    model: 'luna',
    effort: 'medium',
    contextWindow: 200_000,
    stopping: () => false,
    tick: () => calls.push('tick'),
    schedule: () => calls.push('schedule'),
    flush: () => calls.push('flush'),
    ...extra,
  };
  return { calls, ctx };
}

function replay(name, { session = newSession(), ctx = track().ctx } = {}) {
  const recorded = fixture(name);
  for (const message of recorded.messages) applySdkMessage(session, message, ctx);
  return { session, recorded };
}

const byRole = (session, role) => session.messages.filter((message) => message.role === role);
const delta = (type, value, extra = {}) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index: 0, delta: { type, [type === 'text_delta' ? 'text' : 'thinking']: value } },
  ...extra,
});

describe('applySdkMessage: streaming', () => {
  test('top-level text and thinking deltas feed live / liveThinking with a live tick', () => {
    const session = newSession({ status: 'running' });
    const { calls, ctx } = track();
    applySdkMessage(session, delta('thinking_delta', 'Hmm, '), ctx);
    applySdkMessage(session, delta('thinking_delta', 'yes.'), ctx);
    applySdkMessage(session, delta('text_delta', 'Hel', { session_id: 'sdk-1' }), ctx);
    applySdkMessage(session, delta('text_delta', 'lo'), ctx);
    applySdkMessage(session, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } }, ctx);
    assert.equal(session.live, 'Hello');
    assert.equal(session.liveThinking, 'Hmm, yes.');
    assert.equal(session.sdkSessionId, 'sdk-1');
    assert.deepEqual(calls, ['tick', 'tick', 'tick', 'tick'], 'streaming never triggers a full publish');
  });

  test('subagent deltas do not touch live text', () => {
    const session = newSession();
    const { calls, ctx } = track();
    applySdkMessage(session, delta('text_delta', 'sub', { parent_tool_use_id: 'toolu_agent' }), ctx);
    assert.equal(session.live, '');
    assert.deepEqual(calls, []);
  });

  test('message_start clears stale live text; pending approvals keep the waiting status', () => {
    const session = newSession({ live: 'old', liveThinking: 'old', status: 'waiting', pending: [{ id: 'p' }] });
    const { ctx } = track();
    applySdkMessage(session, { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } }, ctx);
    assert.equal(session.live, '');
    assert.equal(session.liveThinking, '');
    applySdkMessage(session, delta('text_delta', 'x'), ctx);
    assert.equal(session.status, 'waiting');
  });
});

describe('applySdkMessage: messages', () => {
  test('assistant blocks are recorded once each, live text is cleared, context is filled', () => {
    const session = newSession({ live: 'partial', liveThinking: 'thinking' });
    const { calls, ctx } = track({ model: 'deepseek', effort: 'high' });
    const assistant = {
      type: 'assistant',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        content: [{ type: 'thinking', thinking: 'Plan it.' }, { type: 'text', text: '' }, { type: 'text', text: 'Hi' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 3 },
      },
    };
    applySdkMessage(session, assistant, ctx);
    applySdkMessage(session, assistant, ctx);
    assert.equal(session.live, '');
    assert.equal(session.liveThinking, '');
    assert.deepEqual(
      session.messages.map(({ role, text, sdkId, model, effort }) => ({ role, text, sdkId, model, effort })),
      [
        { role: 'thinking', text: 'Plan it.', sdkId: 'u1', model: undefined, effort: undefined },
        { role: 'assistant', text: 'Hi', sdkId: 'u1', model: 'deepseek', effort: 'high' },
      ],
    );
    assert.deepEqual(session.context, { used: 1000, window: 200_000 });
    assert.deepEqual(calls, ['flush', 'flush']);
  });

  test('blocks sharing a message id (no uuid) are all kept', () => {
    const session = newSession();
    const { ctx } = track();
    applySdkMessage(session, { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'one' }] } }, ctx);
    applySdkMessage(session, { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'two' }] } }, ctx);
    assert.deepEqual(byRole(session, 'assistant').map((m) => m.text), ['one', 'two']);
  });

  test('tool results record state, output and end time; progress updates elapsed', () => {
    const session = newSession();
    const { calls, ctx } = track();
    applySdkMessage(session, { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } }, ctx);
    applySdkMessage(session, { type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 12.4 }, ctx);
    const [tool] = byRole(session, 'tool');
    assert.equal(tool.state, 'running');
    assert.equal(tool.elapsed, 12);
    assert.equal(calls.at(-1), 'schedule');

    const output = [{ type: 'text', text: 'built' }, { type: 'image', source: {} }];
    applySdkMessage(session, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: output, is_error: true }] } }, ctx);
    assert.equal(tool.state, 'error');
    assert.equal(tool.output, 'built\n[Image]');
    assert.equal(typeof tool.endedAt, 'number');
    assert.equal(tool.elapsed, undefined);
  });

  test('tool output is capped for storage', () => {
    assert.equal(toolOutputText('x'.repeat(70_000)).length, 60_000 + '\n[Output truncated]'.length);
    assert.equal(toolOutputText(undefined), '');
  });

  test('a failed TodoWrite leaves the checklist alone', () => {
    const session = newSession({ todos: [{ content: 'keep', status: 'pending' }] });
    const { ctx } = track();
    const input = { todos: '[{"content":"x","status":"pending","activeForm":"x"}]' };
    applySdkMessage(session, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input }] } }, ctx);
    applySdkMessage(session, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'bad', is_error: true }] } }, ctx);
    assert.deepEqual(session.todos, [{ content: 'keep', status: 'pending' }]);
  });
});

describe('applySdkMessage: system messages', () => {
  test('init records MCP servers (publishing only when they change)', () => {
    const session = newSession();
    const { calls, ctx } = track();
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'comet', status: 'connected', source: 'user' }] };
    applySdkMessage(session, init, ctx);
    applySdkMessage(session, init, ctx);
    assert.deepEqual(session.mcp, [{ name: 'comet', status: 'connected' }]);
    assert.deepEqual(calls, ['flush']);
  });

  test('compaction adds a notice and shrinks the context fill', () => {
    const session = newSession({ context: { used: 150_000, window: 200_000 } });
    applySdkMessage(session, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 20_000 } }, track().ctx);
    assert.deepEqual(session.messages.map(({ role, text, level }) => ({ role, text, level })), [{ role: 'notice', text: NOTICES.compacted, level: 'info' }]);
    assert.deepEqual(session.context, { used: 20_000, window: 200_000 });
  });

  test('compacting shows while Claude Code summarizes, until the boundary', () => {
    const session = newSession({ context: { used: 150_000, window: 200_000 } });
    const { calls, ctx } = track();
    applySdkMessage(session, { type: 'system', subtype: 'status', status: 'compacting' }, { ...ctx, at: 1234 });
    assert.equal(session.compacting, 1234);
    applySdkMessage(session, { type: 'system', subtype: 'status', status: 'compacting' }, ctx);
    assert.equal(session.compacting, 1234, 'repeats change nothing');
    applySdkMessage(session, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', post_tokens: 20_000 } }, ctx);
    assert.equal(session.compacting, undefined);
    applySdkMessage(session, { type: 'system', subtype: 'status', status: 'compacting' }, ctx);
    applySdkMessage(session, { type: 'system', subtype: 'status', status: null }, ctx);
    assert.equal(session.compacting, undefined);
    assert.equal(calls.filter((c) => c === 'flush').length, 4);
  });

  test('API retries show as one warning notice updated in place', () => {
    const session = newSession();
    const retry = (attempt) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' });
    applySdkMessage(session, retry(1), track().ctx);
    applySdkMessage(session, retry(2), track().ctx);
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].level, 'warning');
    assert.equal(session.messages[0].text, 'The model API failed (HTTP 529); retrying, attempt 2 of 10.');
  });
});

describe('applySdkMessage: subagent tasks', () => {
  const agentCall = (id, input = {}) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg-' + id, content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Look around', subagent_type: 'Explore', ...input } }] },
  });
  const task = (subtype, fields) => ({ type: 'system', subtype, ...fields });

  test('task_started records the task id and a background start; task_updated moves a foreground agent to the background', () => {
    const session = newSession();
    const { calls, ctx } = track();
    applySdkMessage(session, agentCall('a1'), ctx);
    applySdkMessage(session, agentCall('a2'), ctx);
    applySdkMessage(session, task('task_started', { task_id: 't1', tool_use_id: 'a1', is_backgrounded: true }), ctx);
    applySdkMessage(session, task('task_started', { task_id: 't2', tool_use_id: 'a2', is_backgrounded: false }), ctx);
    const [first, second] = byRole(session, 'tool');
    assert.deepEqual([first.taskId, first.background], ['t1', true]);
    assert.deepEqual([second.taskId, second.background], ['t2', undefined]);
    assert.ok(calls.includes('flush'));

    applySdkMessage(session, task('task_updated', { task_id: 't2', patch: { is_backgrounded: true } }), ctx);
    assert.equal(second.background, true);
    applySdkMessage(session, task('task_updated', { task_id: 'unknown', patch: { is_backgrounded: true } }), ctx);
  });

  test('a stopped or failed background agent ends with its usage and a notice saying so', () => {
    const session = newSession({ status: 'idle' });
    const { ctx } = track();
    applySdkMessage(session, agentCall('a1'), ctx);
    applySdkMessage(session, agentCall('a2', { description: '' }), ctx);
    for (const [id, taskId] of [['a1', 't1'], ['a2', 't2']]) {
      applySdkMessage(session, task('task_started', { task_id: taskId, tool_use_id: id, is_backgrounded: true }), ctx);
    }
    const usage = { total_tokens: 5000, tool_uses: 4, duration_ms: 61_000 };
    applySdkMessage(session, task('task_notification', { task_id: 't1', tool_use_id: 'a1', status: 'stopped', summary: '', usage }), ctx);
    applySdkMessage(session, task('task_notification', { task_id: 't2', tool_use_id: 'a2', status: 'failed', summary: 'Boom' }), ctx);
    const [stopped, failed] = byRole(session, 'tool');
    assert.deepEqual([stopped.state, stopped.stopped, stopped.usage], ['error', true, { tokens: 5000, toolUses: 4, durationMs: 61_000 }]);
    assert.deepEqual([failed.state, failed.stopped, failed.output], ['error', undefined, 'Boom']);
    assert.deepEqual(
      byRole(session, 'notice').map((m) => [m.text, m.level, m.agentToolId]),
      [
        ['Background agent “Look around” was stopped.', 'info', 'a1'],
        ['Background agent failed.', 'warning', 'a2'],
      ],
    );
    // A repeated notification changes nothing.
    applySdkMessage(session, task('task_notification', { task_id: 't1', tool_use_id: 'a1', status: 'completed', summary: 'late' }), ctx);
    assert.equal(byRole(session, 'notice').length, 2);
    assert.equal(stopped.state, 'error');
  });

  test('requestingAgent finds the asking subagent by task id, or by the nested tool call', () => {
    const session = newSession();
    const { ctx } = track();
    applySdkMessage(session, agentCall('a1'), ctx);
    applySdkMessage(session, task('task_started', { task_id: 't1', tool_use_id: 'a1' }), ctx);
    applySdkMessage(session, { type: 'assistant', parent_tool_use_id: 'a1', message: { id: 'n1', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } }, ctx);
    const expected = { toolId: 'a1', description: 'Look around', subagentType: 'Explore' };
    assert.deepEqual(requestingAgent(session, { agentID: 't1', toolUseID: 'zzz' }), expected);
    assert.deepEqual(requestingAgent(session, { toolUseID: 'b1' }), expected);
    assert.equal(requestingAgent(session, { toolUseID: 'a1' }), undefined, 'the main thread calling Agent');
    assert.equal(requestingAgent(session, {}), undefined);
  });
});

describe('applySdkMessage: results', () => {
  const result = (extra = {}) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1500,
    num_turns: 1,
    total_cost_usd: 0.01,
    modelUsage: { a: { outputTokens: 30 }, b: { outputTokens: 12 } },
    session_id: 'sdk-1',
    ...extra,
  });

  test('a result appends the turn footer and updates totals', () => {
    const session = newSession({ live: 'x', liveThinking: 'y' });
    applySdkMessage(session, result(), track({ model: 'opus' }).ctx);
    const [turn] = byRole(session, 'turn');
    assert.deepEqual(
      { duration: turn.duration, outputTokens: turn.outputTokens, cost: turn.cost, model: turn.model, isError: turn.isError },
      { duration: 1500, outputTokens: 42, cost: 0.01, model: 'opus', isError: false },
    );
    assert.deepEqual(session.totals, { cost: 0.01, outputTokens: 42, turns: 1, models: { opus: { cost: 0.01, outputTokens: 42 } } });
    assert.equal(session.turnEndedAt, undefined, 'set by the runner when the turn is over');
    assert.deepEqual(session.usage, { cost: 0.01, duration: 1500, turns: 1, models: result().modelUsage });
    assert.equal(session.live, '');
    assert.equal(session.liveThinking, '');
    assert.equal(session.status, 'running', 'the runner decides when the turn is really over');
  });

  test('cumulative SDK totals are turned into per-turn figures, also across resumes', () => {
    const session = newSession();
    const { ctx } = track();
    applySdkMessage(session, result({ total_cost_usd: 0.01, modelUsage: { m: { outputTokens: 20 } } }), ctx);
    // A resumed query reports the running total of the same SDK session.
    applySdkMessage(session, result({ total_cost_usd: 0.03, modelUsage: { m: { outputTokens: 50 } } }), ctx);
    // After /clear (or a new SDK session) the counter starts again.
    applySdkMessage(session, result({ total_cost_usd: 0.004, modelUsage: { m: { outputTokens: 5 } } }), ctx);
    applySdkMessage(session, result({ session_id: 'sdk-2', total_cost_usd: 0.02, modelUsage: { m: { outputTokens: 70 } } }), ctx);
    const turns = byRole(session, 'turn').map((m) => [Number(m.cost.toFixed(6)), m.outputTokens]);
    assert.deepEqual(turns, [[0.01, 20], [0.02, 30], [0.004, 5], [0.02, 70]]);
    assert.equal(Number(session.totals.cost.toFixed(6)), 0.054);
    assert.deepEqual({ ...session.totals, cost: 0, models: undefined }, { cost: 0, outputTokens: 125, turns: 4, models: undefined });
    assert.equal(session.totals.models.luna.outputTokens, 125, 'under the model that ran the turns');
  });

  test('a zeroed result (crash, startup error) keeps the cumulative baseline', () => {
    const session = newSession();
    const { ctx } = track();
    for (const cost of [0.1, 0.15, 0, 0.2]) {
      applySdkMessage(session, result({ total_cost_usd: cost, modelUsage: { m: { outputTokens: cost * 1000 } } }), ctx);
    }
    assert.equal(Number(session.totals.cost.toFixed(6)), 0.2);
  });

  test('error results add an error notice and the error status', () => {
    const session = newSession();
    applySdkMessage(session, result({ is_error: true, subtype: 'error_during_execution', errors: ['first', 'second'] }), track().ctx);
    assert.equal(session.status, 'error');
    const notice = byRole(session, 'notice')[0];
    assert.equal(notice.text, 'first\nsecond');
    assert.equal(notice.level, 'error');
    assert.equal(byRole(session, 'turn')[0].isError, true);
  });

  test('error results without details use the fallback notice', () => {
    const session = newSession();
    applySdkMessage(session, { type: 'result', is_error: true }, track().ctx);
    assert.equal(byRole(session, 'notice')[0].text, NOTICES.turnFailed);
  });

  test('a result that arrives while stopping is not an error', () => {
    const session = newSession();
    applySdkMessage(session, result({ is_error: true, subtype: 'error_during_execution', errors: ['x'] }), track({ stopping: () => true }).ctx);
    assert.equal(session.status, 'running');
    assert.equal(byRole(session, 'notice').length, 0);
    const [turn] = byRole(session, 'turn');
    assert.equal(turn.isError, false);
    assert.equal(turn.stopped, true);
  });
});

describe('applySdkMessage: recorded Claude Code sessions', () => {
  test('read-empty-pages: the proxied Read succeeds and context is measured', () => {
    const { session, recorded } = replay('read-empty-pages');
    const [tool] = byRole(session, 'tool');
    assert.equal(tool.tool, 'Read');
    assert.deepEqual(tool.input, { file_path: '/work/hello.txt', offset: 1 }, 'the proxy dropped pages:"" and limit:""');
    assert.equal(tool.state, 'done');
    assert.match(tool.output, /hello world/);
    assert.match(byRole(session, 'assistant').at(-1).text, /^Tool result: ok/);
    assert.deepEqual(session.context, { used: 1000, window: 200_000 });
    assert.equal(byRole(session, 'turn').length, 1);
    assert.equal(session.sdkSessionId, recorded.messages[0].session_id);
    assert.equal(session.live, '');
  });

  test('todos: TodoWrite sent as a JSON string fills the checklist', () => {
    const { session } = replay('todos');
    assert.deepEqual(session.todos, [
      { content: 'Inspect the repository', status: 'completed', activeForm: 'Inspecting the repository' },
      { content: 'Write the fix', status: 'in_progress', activeForm: 'Writing the fix' },
      { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
    ]);
    assert.equal(byRole(session, 'tool')[0].state, 'done');
  });

  test('thinking: the thinking block is captured and streamed', () => {
    const session = newSession();
    const seen = [];
    const { ctx } = track({ tick: (s) => seen.push(s.liveThinking) });
    replay('thinking', { session, ctx });
    const [thinking] = byRole(session, 'thinking');
    assert.equal(thinking.text, 'Let me think about this step by step. The answer is 42.');
    assert.ok(seen.some((text) => text.startsWith('Let me think')), 'liveThinking streamed');
    assert.equal(byRole(session, 'assistant')[0].text, 'The answer is 42.');
    assert.equal(session.liveThinking, '');
  });

  test('agent: subagent activity nests under the Agent card, which runs until the task ends', () => {
    const { session } = replay('agent');
    const agent = byRole(session, 'tool').find((m) => m.tool === 'Agent');
    assert.equal(agent.parentToolId, undefined);
    assert.equal(agent.state, 'done', 'finished by the task notification');
    assert.equal(agent.background, true);
    assert.equal(agent.output, 'Subagent finished.');
    const nested = session.messages.filter((m) => m.parentToolId === agent.toolId);
    assert.deepEqual(
      nested.map((m) => [m.role, m.tool ?? m.text]),
      [
        ['tool', 'Bash'],
        ['assistant', 'Subagent finished.'],
      ],
    );
    assert.equal(nested[0].state, 'done');
    assert.equal(nested[0].output, 'subagent-ok');
    assert.equal(agent.taskId, 'ae85f37269d6b0955');
    assert.deepEqual(agent.usage, { tokens: 1020, toolUses: 1, durationMs: 142 });
    // Its end is marked where it happened, before the turn that reads its report.
    const notice = byRole(session, 'notice').find((m) => m.agentToolId === agent.toolId);
    assert.equal(notice.text, 'Background agent “Check the workspace” finished.');
    assert.equal(notice.level, 'info');
    assert.ok(session.messages.indexOf(notice) < session.messages.findLastIndex((m) => m.role === 'assistant' && !m.parentToolId));
    assert.ok(session.messages.indexOf(notice) > session.messages.indexOf(byRole(session, 'turn')[0]));
    // The background task finishing starts a second turn; costs are per turn.
    const turns = byRole(session, 'turn');
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((m) => Number(m.cost.toFixed(6))), [0.0036, 0.0024]);
    assert.equal(session.totals.turns, 2);
    assert.equal(Number(session.totals.cost.toFixed(6)), 0.006);
  });

  test('agent-foreground: nested steps, then the clean subagent report as the card output', () => {
    const { session } = replay('agent-foreground');
    const agent = byRole(session, 'tool').find((m) => m.tool === 'Agent');
    assert.equal(agent.state, 'done');
    assert.equal(agent.background, undefined);
    assert.equal(agent.output, 'Subagent finished.', 'no [Subagent hand-back] frame');
    assert.equal(agent.taskId, 'ae961a941bc861bbd');
    assert.deepEqual(agent.usage, { tokens: 1020, toolUses: 1, durationMs: 117 }, 'from the tool result totals');
    assert.deepEqual(byRole(session, 'notice'), [], 'a foreground agent needs no notice');
    const nested = session.messages.filter((m) => m.parentToolId === agent.toolId);
    assert.deepEqual(nested.map((m) => [m.role, m.tool, m.state, m.output]), [['tool', 'Bash', 'done', 'subagent-ok']]);
    assert.ok(session.messages.indexOf(nested[0]) > session.messages.indexOf(agent));
    assert.equal(byRole(session, 'turn').length, 1);
  });

  test('plan: the plan file text reaches session.plan', () => {
    const { session } = replay('plan');
    const exit = byRole(session, 'tool').find((m) => m.tool === 'ExitPlanMode');
    assert.deepEqual(session.plan && { text: session.plan.text, toolId: session.plan.toolId }, {
      text: '# Plan\n\n1. Read the code\n2. Make the change\n3. Run the tests',
      toolId: exit.toolId,
    });
    assert.equal(typeof session.plan.at, 'number');
  });

  test('interrupt: a stopped turn is not an error', () => {
    const { ctx } = track({ stopping: () => true });
    const { session, recorded } = replay('interrupt', { ctx });
    assert.match(recorded.thrown, /error result/, 'the SDK also throws after this result');
    assert.notEqual(session.status, 'error');
    assert.equal(byRole(session, 'notice').length, 0);
    assert.equal(byRole(session, 'turn')[0].stopped, true);
    assert.equal(byRole(session, 'assistant')[0].text, 'chunk 0 chunk 1 chunk 2 ');
  });

  test('api-error: the failure is shown once, as an error notice', () => {
    const { session } = replay('api-error');
    assert.equal(session.status, 'error');
    assert.deepEqual(
      byRole(session, 'notice').map(({ text, level }) => ({ text, level })),
      [{ text: 'API Error: 400 Mock API error', level: 'error' }],
    );
    assert.equal(byRole(session, 'assistant').length, 0);
  });
});
