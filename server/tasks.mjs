// Background tasks and scheduled jobs: what a session's Claude Code process runs or will
// run while no turn is going (the Background tab, GET /api/sessions/:id/tasks).
//
// - Running tasks come from Claude Code's `background_tasks_changed` frames (the whole
//   live set every time), kept on the session as `liveTasks`. Subagents are left out:
//   they have their own strip and dialog.
// - A background command or Monitor is also a tool call in the transcript: Claude Code's
//   task frames put its task id on the call (`taskId`, `background`), and its end on
//   `task` ({status, endedAt, output, summary}). Calls from before `task` existed are
//   read back from their output file's last line.
// - Scheduled jobs (CronCreate, ScheduleWakeup, /loop) come from the Stop hook, which
//   carries the live list at the end of every turn: `crons` on the session. Recurring
//   jobs come back when Claude Code resumes the conversation; one-shot wakeups do not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const DELEGATE_TOOL = 'mcp__meshy__delegate';
// Claude Code's task types that are agents (shown elsewhere) or housekeeping.
const HIDDEN_TYPES = new Set(['local_agent', 'in_process_teammate', 'dream']);
// Claude Code drops a recurring job seven days after it was made.
export const CRON_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// How much of an output file one request returns, at most.
export const MAX_OUTPUT_BYTES = 256 * 1024;
const TASK_ID = /^[a-z0-9]{1,32}$/;
const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\b/;
// A Monitor's result: "Monitor started (task b6unapgc0, expires in 30m …".
const MONITOR_STARTED = /^Monitor started \(task ([a-z0-9]+)/;
const EXIT_LINE = /\[exited with code (-?\d+)\]\s*$/;
// A task notification's summary: `Background command "…" completed (exit code 0)`.
const SUMMARY_EXIT = /\(exit code (-?\d+)\)/;
// The newest finished tasks the list reads back from disk (older ones keep `ended`).
const READ_BACK = 200;

/** Where Claude Code keeps task output: <tmp>/claude-<uid> (see CLAUDE_CODE_TMPDIR). */
export function taskRoot(env = process.env) {
  const base = env.CLAUDE_CODE_TMPDIR || os.tmpdir();
  return path.join(base, `claude-${process.getuid?.() ?? 0}`);
}

/** The kind of task a Claude Code task type or tool call is, as the client names it. */
export function taskKind(type, tool) {
  if (tool === 'Monitor' || /monitor/.test(type || '')) return 'monitor';
  if (type === 'local_bash' || tool === 'Bash') return 'shell';
  if (type === 'local_workflow') return 'workflow';
  if (type === 'remote_agent') return 'remote';
  if (type === 'mcp_task') return 'mcp';
  return type || 'task';
}

/** True for a tool call that started a background task (not a subagent). */
export function isTaskCall(message) {
  return (
    Boolean(callTaskId(message)) &&
    Boolean(message.background || message.task || message.tool === 'Monitor') &&
    !AGENT_TOOLS.has(message.tool) &&
    message.tool !== DELEGATE_TOOL
  );
}

/**
 * Takes Claude Code's live task set. Returns true when it changed what the session
 * shows. Each task keeps the time it was first seen.
 */
export function setLiveTasks(session, tasks, at = Date.now()) {
  const before = new Map((session.liveTasks || []).map((task) => [task.id, task]));
  const next = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task?.task_id || HIDDEN_TYPES.has(task.task_type)) continue;
    const old = before.get(task.task_id);
    next.push({
      id: task.task_id,
      type: task.task_type || '',
      description: task.description || '',
      since: old?.since ?? at,
      ...(task.ambient ? { ambient: true } : {}),
    });
  }
  const changed = JSON.stringify(next) !== JSON.stringify(session.liveTasks || []);
  if (next.length) session.liveTasks = next;
  else delete session.liveTasks;
  return changed;
}

/** The tool call that started task `taskId`, if the transcript has it. */
export function taskCall(session, taskId) {
  return session.messages.find((message) => callTaskId(message) === taskId);
}

/** Records a task's start on its tool call (a background command, a Monitor). */
export function startTask(tool, { id, type = '' }) {
  tool.taskId = id;
  tool.background = true;
  tool.task = { ...tool.task, kind: taskKind(type, tool.tool) };
}

/** Records how a task ended (a task_notification or a task_updated status). */
export function endTask(tool, { status, at = Date.now(), output, summary } = {}) {
  const ended = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped';
  tool.task = { ...tool.task, status: ended, endedAt: tool.task?.endedAt ?? at };
  if (output) tool.task.output = output;
  if (summary) tool.task.summary = summary;
}

/** The task id in a Monitor's result text, or null. */
export function monitorTaskId(text) {
  return MONITOR_STARTED.exec(String(text || ''))?.[1] ?? null;
}

/** The task a tool call started: its recorded id, or a Monitor's from its result. */
function callTaskId(message) {
  if (message.role !== 'tool') return null;
  return message.taskId || (message.tool === 'Monitor' && message.state === 'done' ? monitorTaskId(message.output) : null);
}

/** The output file Claude Code named in a background command's result text. */
export function outputPathIn(text) {
  return OUTPUT_PATH.exec(String(text || ''))?.[1] ?? null;
}

/**
 * The scheduled jobs from a Stop hook's `session_crons`, each keeping when Harbor first
 * saw it. Returns true when the list changed.
 */
export function setCrons(session, crons, at = Date.now()) {
  const before = new Map((session.crons || []).map((cron) => [cron.id, cron]));
  const next = [];
  for (const cron of Array.isArray(crons) ? crons : []) {
    if (!cron?.id) continue;
    next.push({
      id: String(cron.id),
      schedule: String(cron.schedule || ''),
      recurring: Boolean(cron.recurring),
      prompt: String(cron.prompt || ''),
      since: before.get(String(cron.id))?.since ?? at,
    });
  }
  const changed = JSON.stringify(next) !== JSON.stringify(session.crons || []);
  if (next.length) session.crons = next;
  else delete session.crons;
  return changed;
}

// CronCreate's result: "Scheduled recurring job 491ecdff (13,33,53 * * * *). Session-only …".
const CRON_CREATED = /^Scheduled recurring job (\S+) \(/;

/**
 * The recurring jobs a transcript leaves running: created with CronCreate and not cancelled
 * with CronDelete, each `since` its creation (so the seven-day lifetime holds). For sessions
 * whose jobs no Stop hook has reported yet (`cronsKnown`): those from before Harbor kept
 * track, which a restart would otherwise leave asleep until the user's next message.
 */
export function cronsFromTranscript(session) {
  const jobs = new Map();
  for (const message of session.messages || []) {
    if (message.role !== 'tool' || message.state !== 'done') continue;
    if (message.tool === 'CronCreate') {
      const id = CRON_CREATED.exec(String(message.output || ''))?.[1];
      if (id) jobs.set(id, { id, schedule: String(message.input?.cron || ''), recurring: true, prompt: String(message.input?.prompt || ''), since: message.at ?? Date.now() });
    } else if (message.tool === 'CronDelete' && message.input?.id) {
      jobs.delete(String(message.input.id));
    }
  }
  return [...jobs.values()];
}

/** Jobs still due to run: recurring ones younger than Claude Code's seven days, and wakeups. */
export function liveCrons(session, at = Date.now()) {
  return (session.crons || []).filter((cron) => !cron.recurring || at - cron.since < CRON_LIFETIME_MS);
}

/**
 * The session's process is gone (an exit, a restart): its tasks ended with it, and its
 * one-shot wakeups are lost (recurring jobs come back with the conversation). Returns
 * the number of wakeups dropped.
 */
export function settleTasks(session, at = Date.now()) {
  for (const message of session.messages) {
    if (!isTaskCall(message) || message.task?.status) continue;
    if (!(session.liveTasks || []).some((task) => task.id === callTaskId(message))) continue;
    endTask(message, { status: 'stopped', at });
  }
  delete session.liveTasks;
  const wakeups = (session.crons || []).filter((cron) => !cron.recurring).length;
  if (wakeups) setCrons(session, (session.crons || []).filter((cron) => cron.recurring), at);
  return wakeups;
}

/** The number of background tasks running now (the topbar badge). */
export function runningTaskCount(session) {
  return session.liveTasks?.length ?? 0;
}

/** Reads the last `bytes` of a file: {text, size, mtime}, or null when it is not there. */
function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return { text: buffer.toString('utf8'), size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The output file of task `taskId`, or null. Only a file Claude Code made for that task
 * is ever read: <task root>/<project>/<conversation>/tasks/<id>.output.
 */
export function taskOutputFile(session, taskId, { root = taskRoot() } = {}) {
  if (!TASK_ID.test(String(taskId))) return null;
  const tool = taskCall(session, taskId);
  const candidates = [tool?.task?.output, outputPathIn(tool?.output)];
  // A Monitor's result names no file; it sits with the conversation's other tasks.
  for (const id of [session.sdkSessionId, ...(session.sdkAncestors || [])].filter(Boolean)) {
    try {
      for (const project of fs.readdirSync(root)) candidates.push(path.join(root, project, id, 'tasks', `${taskId}.output`));
    } catch {
      break;
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(root + path.sep)) continue;
    if (path.basename(resolved) !== `${taskId}.output` || path.basename(path.dirname(resolved)) !== 'tasks') continue;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

/** The end of task `taskId`'s output: {text, size, truncated, exitCode}, or null. */
export function readTaskOutput(session, taskId, { bytes = MAX_OUTPUT_BYTES, root } = {}) {
  const file = taskOutputFile(session, taskId, { root });
  if (!file) return null;
  const tail = readTail(file, Math.max(1, Math.min(bytes, MAX_OUTPUT_BYTES)));
  if (!tail) return null;
  let text = tail.text;
  const truncated = tail.size > text.length;
  // A cut through a multi-byte character or a line: start at the next whole line.
  if (truncated) text = text.slice(text.indexOf('\n') + 1);
  const exit = EXIT_LINE.exec(text);
  return { text, size: tail.size, truncated, mtime: tail.mtime, exitCode: exit ? Number(exit[1]) : null };
}

/** How a task ended, read from its output file's last line (calls made before `task`). */
function endFromFile(session, taskId, root) {
  const file = taskOutputFile(session, taskId, { root });
  const tail = file && readTail(file, 128);
  const exit = tail && EXIT_LINE.exec(tail.text);
  if (!exit) return { status: 'ended' };
  const code = Number(exit[1]);
  return { status: code === 0 ? 'completed' : 'failed', exitCode: code, endedAt: tail.mtime };
}

function describeCall(tool) {
  const input = tool.input || {};
  return {
    toolId: tool.toolId,
    tool: tool.tool,
    description: input.description || '',
    command: typeof input.command === 'string' ? input.command : '',
    startedAt: tool.at,
    ...(tool.parentToolId ? { agentToolId: tool.parentToolId } : {}),
  };
}

/**
 * The Background tab's content: `running` (newest first), `finished` (newest first) and
 * `scheduled` jobs.
 */
export function listTasks(session, { root = taskRoot(), at = Date.now() } = {}) {
  const live = new Map((session.liveTasks || []).map((task) => [task.id, task]));
  const calls = new Map();
  for (const message of session.messages) {
    const id = callTaskId(message);
    if (id) calls.set(id, message);
  }

  const running = [...live.values()]
    .map((task) => {
      const tool = calls.get(task.id);
      const call = tool ? describeCall(tool) : {};
      return {
        id: task.id,
        kind: taskKind(task.type, tool?.tool),
        ...call,
        description: call.description || task.description,
        startedAt: call.startedAt ?? task.since,
        status: 'running',
        ...(task.ambient ? { ambient: true } : {}),
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);

  const finished = [];
  for (const tool of calls.values()) {
    const id = callTaskId(tool);
    if (live.has(id) || !isTaskCall(tool)) continue;
    finished.push({ tool, entry: { id, kind: tool.task?.kind ?? taskKind('', tool.tool), ...describeCall(tool) } });
  }
  finished.sort((a, b) => b.entry.startedAt - a.entry.startedAt);
  const done = finished.map(({ tool, entry }, index) => {
    const task = tool.task || {};
    if (task.status) {
      const exit = SUMMARY_EXIT.exec(task.summary || '');
      return { ...entry, status: task.status, endedAt: task.endedAt, summary: task.summary || '', ...(exit ? { exitCode: Number(exit[1]) } : {}) };
    }
    return { ...entry, ...(index < READ_BACK ? endFromFile(session, entry.id, root) : { status: 'ended' }) };
  });

  // Claude Code reads schedules in the server's local time.
  return { running, finished: done, scheduled: liveCrons(session, at), utcOffset: -new Date(at).getTimezoneOffset() };
}
