// Background tasks and scheduled jobs (server/tasks.mjs): Claude Code's task frames on
// the transcript (applySdkMessage), the live set, the Stop hook's jobs, what a restart
// does to them, the Background tab's list and reading an output file safely.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { reviveSession } from '../server/store.mjs';
import {
  cronsFromTranscript,
  CRON_LIFETIME_MS,
  isTaskCall,
  listTasks,
  liveCrons,
  readTaskOutput,
  setCrons,
  setLiveTasks,
  settleTasks,
  taskKind,
  taskOutputFile,
} from '../server/tasks.mjs';
import { applySdkMessage } from '../server/transcript.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tasks-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = { model: 'luna', effort: 'medium', stopping: () => false, tick() {}, schedule() {}, flush() {} };

function newSession(extra = {}) {
  return { id: 's1', model: 'luna', status: 'idle', messages: [], pending: [], sdkSessionId: 'conv-1', ...extra };
}

const assistantToolUse = (id, name, input) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: 'msg-' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: {} },
});
const toolResult = (id, content, result) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  tool_use_result: result,
});
const system = (subtype, fields) => ({ type: 'system', subtype, ...fields });

/** Writes an output file where Claude Code keeps one: <root>/<project>/<conversation>/tasks/<id>.output. */
function outputFile(id, text, conversation = 'conv-1') {
  const dir = path.join(root, '-work', conversation, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.output`);
  fs.writeFileSync(file, text);
  return file;
}

/** A background command as Claude Code reports it, up to its call's result. */
function startBackgroundCommand(session, { toolId = 'toolu_bg', taskId = 'bk1', command = 'sleep 9; echo done', description = 'Wait and print' } = {}) {
  const file = path.join(root, '-work', session.sdkSessionId, 'tasks', `${taskId}.output`);
  applySdkMessage(session, assistantToolUse(toolId, 'Bash', { command, description, run_in_background: true }), ctx);
  applySdkMessage(session, system('task_started', { task_id: taskId, tool_use_id: toolId, description, is_backgrounded: true, task_type: 'local_bash' }), ctx);
  setLiveTasks(session, [{ task_id: taskId, task_type: 'local_bash', description }], 1000);
  applySdkMessage(
    session,
    toolResult(toolId, `Command running in background with ID: ${taskId}. Output is being written to: ${file}. You will be notified when it completes.`, {
      stdout: '',
      backgroundTaskId: taskId,
    }),
    ctx,
  );
  return session.messages.find((m) => m.toolId === toolId);
}

describe('task frames on the transcript', () => {
  test('a background command: its call is done, its task records kind, output file and end', () => {
    const session = newSession();
    const call = startBackgroundCommand(session);
    assert.equal(call.state, 'done');
    assert.equal(call.taskId, 'bk1');
    assert.equal(call.background, true);
    assert.equal(call.task.kind, 'shell');
    assert.equal(call.task.output, path.join(root, '-work/conv-1/tasks/bk1.output'));
    assert.equal(call.task.status, undefined);
    assert.ok(isTaskCall(call));

    applySdkMessage(session, system('task_updated', { task_id: 'bk1', patch: { status: 'completed', end_time: 5000 } }), ctx);
    assert.deepEqual([call.task.status, call.task.endedAt], ['completed', 5000]);
    applySdkMessage(
      session,
      system('task_notification', { task_id: 'bk1', tool_use_id: 'toolu_bg', status: 'completed', output_file: call.task.output, summary: 'Background command "Wait and print" completed (exit code 0)' }),
      ctx,
    );
    assert.equal(call.task.status, 'completed');
    assert.equal(call.task.endedAt, 5000, 'the first end recorded stays');
    assert.match(call.task.summary, /exit code 0/);
    assert.equal(call.state, 'done', 'the call is untouched');
  });

  test('a foreground command is a task too, but only shows as one once moved to the background', () => {
    const session = newSession();
    applySdkMessage(session, assistantToolUse('toolu_fg', 'Bash', { command: 'sleep 300', description: 'Long wait' }), ctx);
    applySdkMessage(session, system('task_started', { task_id: 'fg1', tool_use_id: 'toolu_fg', description: 'Long wait', is_backgrounded: false, task_type: 'local_bash' }), ctx);
    const call = session.messages.find((m) => m.toolId === 'toolu_fg');
    assert.equal(call.task, undefined);
    assert.equal(isTaskCall(call), false);
    // Its timeout moves it to the background.
    applySdkMessage(session, system('task_updated', { task_id: 'fg1', patch: { is_backgrounded: true } }), ctx);
    applySdkMessage(
      session,
      toolResult('toolu_fg', 'Command did not complete within its 120s timeout and was moved to the background (ID: fg1). Output is being written to: /tmp/x/tasks/fg1.output.', {
        backgroundTaskId: 'fg1',
      }),
      ctx,
    );
    assert.equal(call.state, 'done');
    assert.equal(call.task.kind, 'shell');
    assert.equal(call.task.output, '/tmp/x/tasks/fg1.output');
    applySdkMessage(session, system('task_notification', { task_id: 'fg1', tool_use_id: 'toolu_fg', status: 'failed', output_file: '', summary: 'Background command "Long wait" failed (exit code 2)' }), ctx);
    assert.equal(call.task.status, 'failed');
  });

  test('a stopped foreground command keeps the existing handling (no task)', () => {
    const session = newSession();
    applySdkMessage(session, assistantToolUse('toolu_fg', 'Bash', { command: 'sleep 60' }), ctx);
    applySdkMessage(session, system('task_started', { task_id: 'fg2', tool_use_id: 'toolu_fg', is_backgrounded: false, task_type: 'local_bash' }), ctx);
    applySdkMessage(session, system('task_notification', { task_id: 'fg2', tool_use_id: 'toolu_fg', status: 'stopped', output_file: '', summary: 'Wait a minute' }), ctx);
    const call = session.messages.find((m) => m.toolId === 'toolu_fg');
    assert.equal(call.task, undefined);
    assert.equal(call.state, 'error');
  });

  test('a Monitor is recognised by its result; a background subagent never becomes a task', () => {
    const session = newSession();
    applySdkMessage(session, assistantToolUse('toolu_mon', 'Monitor', { description: 'Watch the job', command: 'tail -f log', timeout_ms: 60000 }), ctx);
    applySdkMessage(session, toolResult('toolu_mon', 'Monitor started (task bmon1, expires in 1m unless the source ends first).', 'ok'), ctx);
    const monitor = session.messages.find((m) => m.toolId === 'toolu_mon');
    assert.equal(monitor.taskId, 'bmon1');
    assert.equal(monitor.task.kind, 'monitor');
    applySdkMessage(session, system('task_notification', { task_id: 'bmon1', status: 'completed', output_file: '', summary: 'Monitor ended' }), ctx);
    assert.equal(monitor.task.status, 'completed', 'found by task id without a tool_use_id');

    applySdkMessage(session, assistantToolUse('toolu_agent', 'Agent', { description: 'Probe', prompt: 'x', run_in_background: true }), ctx);
    applySdkMessage(session, system('task_started', { task_id: 'ag1', tool_use_id: 'toolu_agent', is_backgrounded: true, task_type: 'local_agent' }), ctx);
    const agent = session.messages.find((m) => m.toolId === 'toolu_agent');
    assert.equal(agent.task, undefined);
    assert.equal(isTaskCall(agent), false);
  });

  test('history: calls made before tasks were recorded still count (taskId + background, or a Monitor result)', () => {
    const old = { role: 'tool', tool: 'Bash', toolId: 't1', taskId: 'b1', background: true, state: 'done', at: 1 };
    const monitor = { role: 'tool', tool: 'Monitor', toolId: 't2', state: 'done', output: 'Monitor started (task b2, expires in 30m …', at: 2 };
    const foreground = { role: 'tool', tool: 'Bash', toolId: 't3', taskId: 'b3', state: 'done', at: 3 };
    assert.deepEqual([old, monitor, foreground].map(isTaskCall), [true, true, false]);
  });
});

describe('live set and scheduled jobs', () => {
  test('the live set leaves out agents and housekeeping, keeps when each task was first seen, and reports changes', () => {
    const session = newSession();
    assert.equal(
      setLiveTasks(session, [
        { task_id: 'b1', task_type: 'local_bash', description: 'Count' },
        { task_id: 'a1', task_type: 'local_agent', description: 'Agent' },
        { task_id: 'd1', task_type: 'dream', description: 'Memory', ambient: true },
        { task_id: 'm1', task_type: 'monitor_mcp', description: 'Watch', ambient: true },
      ], 100),
      true,
    );
    assert.deepEqual(session.liveTasks, [
      { id: 'b1', type: 'local_bash', description: 'Count', since: 100 },
      { id: 'm1', type: 'monitor_mcp', description: 'Watch', since: 100, ambient: true },
    ]);
    assert.equal(setLiveTasks(session, [{ task_id: 'b1', task_type: 'local_bash', description: 'Count' }, { task_id: 'm1', task_type: 'monitor_mcp', description: 'Watch', ambient: true }], 900), false);
    assert.equal(setLiveTasks(session, [], 1000), true);
    assert.equal(session.liveTasks, undefined);
    assert.equal(taskKind('monitor_mcp'), 'monitor');
  });

  test('jobs keep when Harbor first saw them; recurring ones expire after seven days, wakeups when fired', () => {
    const session = newSession();
    const crons = [
      { id: 'c1', schedule: '*/30 * * * *', recurring: true, prompt: 'Check the run.' },
      { id: 'w1', schedule: '40 19 13 10 *', recurring: false, prompt: 'Look again.' },
    ];
    assert.equal(setCrons(session, crons, 1000), true);
    assert.equal(setCrons(session, crons, 2000), false);
    assert.deepEqual(session.crons.map((c) => c.since), [1000, 1000]);
    assert.deepEqual(liveCrons(session, 1000 + CRON_LIFETIME_MS).map((c) => c.id), ['w1']);
    assert.equal(setCrons(session, [crons[0]], 3000), true);
    assert.deepEqual(session.crons, [{ ...crons[0], since: 1000 }]);
    assert.equal(setCrons(session, [], 4000), true);
    assert.equal(session.crons, undefined);
  });

  test("a gone process: its running tasks end as stopped, its wakeups are dropped and counted, recurring jobs stay", () => {
    const session = newSession();
    const call = startBackgroundCommand(session);
    setCrons(session, [
      { id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'Daily' },
      { id: 'w1', schedule: '40 19 13 10 *', recurring: false, prompt: 'Wake' },
    ]);
    assert.equal(settleTasks(session, 7000), 1);
    assert.deepEqual([call.task.status, call.task.endedAt], ['stopped', 7000]);
    assert.equal(session.liveTasks, undefined);
    assert.deepEqual(session.crons.map((c) => c.id), ['c1']);
    assert.equal(settleTasks(session), 0);
  });

  test('a restart (reviveSession) settles tasks and says when wakeups were lost', () => {
    const session = newSession();
    startBackgroundCommand(session);
    setCrons(session, [
      { id: 'w1', schedule: '1 1 1 1 *', recurring: false, prompt: 'a' },
      { id: 'w2', schedule: '2 2 2 2 *', recurring: false, prompt: 'b' },
    ]);
    reviveSession(session);
    assert.equal(session.liveTasks, undefined);
    assert.equal(session.crons, undefined);
    const notice = session.messages.at(-1);
    assert.equal(notice.role, 'notice');
    assert.equal(notice.text, '2 scheduled wakeups were lost when Claude Code restarted. Recurring jobs carry on.');
  });
});

describe('the Background list and output files', () => {
  test('running (newest first, from the live set), finished (recorded end or read back from the file) and scheduled', () => {
    const session = newSession();
    const done = startBackgroundCommand(session, { toolId: 'toolu_a', taskId: 'ba1', description: 'First' });
    done.at = 100;
    applySdkMessage(session, system('task_notification', { task_id: 'ba1', tool_use_id: 'toolu_a', status: 'completed', output_file: '', summary: 'Background command "First" completed (exit code 0)' }), ctx);
    const old = { role: 'tool', tool: 'Bash', toolId: 'toolu_b', taskId: 'bb2', background: true, state: 'done', at: 200, input: { command: 'make', description: 'Build' } };
    const unread = { role: 'tool', tool: 'Bash', toolId: 'toolu_c', taskId: 'bc3', background: true, state: 'done', at: 300, input: { command: 'ls' } };
    session.messages.push(old, unread);
    outputFile('bb2', 'compiling\n\n[exited with code 2]\n');
    const live = startBackgroundCommand(session, { toolId: 'toolu_d', taskId: 'bd4', description: 'Live one' });
    setCrons(session, [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'Poll' }], 50);

    const list = listTasks(session, { root, at: 1000 });
    assert.deepEqual(
      list.running.map((t) => [t.id, t.kind, t.description, t.toolId, t.status]),
      [['bd4', 'shell', 'Live one', 'toolu_d', 'running']],
    );
    assert.equal(list.running[0].startedAt, live.at);
    assert.deepEqual(
      list.finished.map((t) => [t.id, t.status, t.exitCode]),
      [
        ['bc3', 'ended', undefined],
        ['bb2', 'failed', 2],
        ['ba1', 'completed', 0],
      ],
    );
    assert.deepEqual(list.scheduled.map((c) => c.id), ['c1']);
    assert.equal(typeof list.utcOffset, 'number');
  });

  test('output: the tail of the task file, cut at a line; only files Claude Code made for that task', () => {
    const session = newSession({ sdkSessionId: 'conv-2' });
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n[exited with code 0]\n';
    outputFile('bo1', lines, 'conv-2');
    // A Monitor's result names no file: it is found with the conversation's other tasks.
    session.messages.push({ role: 'tool', tool: 'Monitor', toolId: 't', state: 'done', output: 'Monitor started (task bo1, expires in 1m', at: 1 });
    const full = readTaskOutput(session, 'bo1', { root });
    assert.equal(full.truncated, false);
    assert.equal(full.exitCode, 0);
    const tail = readTaskOutput(session, 'bo1', { root, bytes: 100 });
    assert.equal(tail.truncated, true);
    assert.match(tail.text, /^line \d+\n/, 'starts at a whole line');
    assert.ok(tail.text.endsWith('[exited with code 0]\n'));

    // Never a file outside the task root, or not named for the task.
    const outside = path.join(os.tmpdir(), `harbor-outside-${process.pid}.output`);
    fs.writeFileSync(outside, 'secret');
    session.messages.push({ role: 'tool', tool: 'Bash', toolId: 'x', taskId: 'bx1', background: true, task: { kind: 'shell', output: outside }, state: 'done', at: 2 });
    session.messages.push({ role: 'tool', tool: 'Bash', toolId: 'y', taskId: 'by1', background: true, task: { kind: 'shell', output: path.join(root, '-work/conv-2/tasks/bo1.output') }, state: 'done', at: 3 });
    session.messages.push({ role: 'tool', tool: 'Bash', toolId: 'z', taskId: 'bz1', background: true, task: { kind: 'shell', output: path.join(root, '-work/conv-2/tasks/../../../../etc/bz1.output') }, state: 'done', at: 4 });
    assert.equal(taskOutputFile(session, 'bx1', { root }), null);
    assert.equal(taskOutputFile(session, 'by1', { root }), null, 'another task’s file');
    assert.equal(taskOutputFile(session, 'bz1', { root }), null);
    assert.equal(taskOutputFile(session, '../bo1', { root }), null);
    assert.equal(readTaskOutput(session, 'nope1', { root }), null);
    fs.rmSync(outside);
  });

  test('cronsFromTranscript: recurring jobs created and not cancelled, since their creation', () => {
    const tool = (id, toolName, at, input, output, state = 'done') => ({ id, role: 'tool', tool: toolName, toolId: 'tu-' + id, state, at, input, output });
    const session = {
      messages: [
        tool('a', 'CronCreate', 1000, { cron: '17,47 * * * *', prompt: 'monitor v9', recurring: true }, 'Scheduled recurring job 32f4b08a (17,47 * * * *). Session-only (not written to disk, dies when Claude exits).'),
        tool('b', 'CronDelete', 2000, { id: '32f4b08a' }, 'Cancelled job 32f4b08a.'),
        tool('c', 'CronCreate', 3000, { cron: '17,47 * * * *', prompt: 'monitor v10', recurring: true }, 'Scheduled recurring job f1eb0d1e (17,47 * * * *). Session-only (not written to disk, dies when Claude exits).'),
        tool('d', 'ScheduleWakeup', 3500, { delaySeconds: 600, prompt: 'look again' }, 'Next wakeup scheduled for 19:11:00 (in 600s).'),
        tool('e', 'CronCreate', 4000, { cron: '0 9 * * *', prompt: 'failed' }, 'Error: invalid cron', 'error'),
        tool('f', 'CronCreate', 5000, { cron: '13,33,53 * * * *', prompt: 'i2i relay' }, 'Scheduled recurring job 491ecdff (13,33,53 * * * *). Session-only.'),
      ],
    };
    assert.deepEqual(cronsFromTranscript(session), [
      { id: 'f1eb0d1e', schedule: '17,47 * * * *', recurring: true, prompt: 'monitor v10', since: 3000 },
      { id: '491ecdff', schedule: '13,33,53 * * * *', recurring: true, prompt: 'i2i relay', since: 5000 },
    ]);
    assert.deepEqual(cronsFromTranscript({ messages: [] }), []);
  });
});
