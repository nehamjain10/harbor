// Model agents: parallel workers on any model in the catalog, started by the session's
// main model through Harbor's in-process MCP server (AGENT_SERVER). Claude Code's own subagents
// always call the endpoint of the CLI that runs them, so a Claude-direct session cannot
// run a GPT worker (or the other way round); here each worker is a Claude Code process of
// its own (an SDK query) on its model's route.
//
//   delegate      starts a worker and returns at once with its id (fan-out); the main
//                 model keeps working, and can start several in one message
//   wait_agents   blocks until some or all workers are done and returns their reports
//                 (fan-in); it never waits for a worker that has already finished
//   message_agent steers a running worker: the message is read at its next step, mid-turn
//   stop_agent    halts a running worker and returns its partial report
//   check_agents  what the workers are doing now, without waiting (read only)
//
// A worker the main model is not waiting for reports back by itself when it ends: the
// runner sends its report to the main model as a message (read at the next step of a
// running turn, or starting a turn when the session is idle).
//
// Messages to a worker (from the main model, or from the user through the card) are
// written to its input with priority `next`, like steering in the main session, and are
// recorded under its card as user messages (`from`, `delivery`: sent, then done when its
// process takes them, or dropped). A message that reaches the process just as the worker
// gives its final answer starts a turn of its own: the worker's input stays open until
// that turn has run (see onResult).
//
// In the transcript a worker is its `delegate` tool call: the card stays running (like a
// background subagent) with the worker's own steps nested under it (parentToolId), then
// ends with its report and usage. Approvals go through the session's flow, labelled with
// the worker's model. `isolation: 'worktree'` runs a worker in a git worktree and branch
// of its own, made on the session's machine (this machine's git, or its cluster's over
// ssh); one that changed nothing is removed when it ends.
//
// With a CLI host (cli-host.mjs) a worker's process runs there under `w:<id>` and keeps
// what its report is made of with it (describe), so a server restart does not end it: the
// next server takes it back (reattach) before the lead's process, whose wait_agents call
// the host asks again.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createInputStream } from './cli-pool.mjs';
import { isRemote } from './clusters.mjs';
import { hostSpawner, killInHost } from './host-client.mjs';
import { MAX_MESSAGE_LENGTH, MODEL_AGENTS_MAX } from './config.mjs';
import { AGENT_HINTS, MODELS, TOOL_HYGIENE, findModel, resolveEffort, runsDirect, turnMode } from './models.mjs';
import { shQuote } from './remote-command.mjs';
import { runSsh } from './ssh.mjs';
import { addMessage, addNotice } from './store.mjs';
import { addUsage, applySdkMessage, toolOutputText } from './transcript.mjs';

const execFileAsync = promisify(execFile);

export const AGENT_SERVER = 'meshy';
export const DELEGATE_TOOL = `mcp__${AGENT_SERVER}__delegate`;
export const WAIT_TOOL = `mcp__${AGENT_SERVER}__wait_agents`;
export const MESSAGE_TOOL = `mcp__${AGENT_SERVER}__message_agent`;
export const STOP_TOOL = `mcp__${AGENT_SERVER}__stop_agent`;
export const CHECK_TOOL = `mcp__${AGENT_SERVER}__check_agents`;
/** Allowed without asking in every mode: they only start, steer, stop and read the session's own workers. */
export const MODEL_AGENT_TOOLS = [DELEGATE_TOOL, WAIT_TOOL, MESSAGE_TOOL, STOP_TOOL, CHECK_TOOL];


const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// A worker has no plan of its own to review. Its questions (AskUserQuestion) go to the
// user like its approvals, on a card labelled with the worker.
const WORKER_DISALLOWED_TOOLS = ['ExitPlanMode', 'EnterPlanMode'];
// Messages from a worker's process that belong in the transcript (besides its own
// replies and tool calls): its own subagents' progress.
const NESTED_SYSTEM = new Set(['task_started', 'task_updated', 'task_progress', 'task_notification']);
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Claude Code allows an MCP call about 28 hours by default; wait_agents stays well inside.
const MCP_TIMEOUT_MS = 12 * 60 * 60_000;
const DEFAULT_WAIT_SECONDS = 30 * 60;
const MAX_WAIT_SECONDS = 4 * 60 * 60;
const MAX_ANSWER_CHARS = 12_000;
const MAX_LISTED = 12;
const MAX_USER_MESSAGES = 5;
const MAX_FINISHED_KEPT = 200;
const GIT_TIMEOUT_MS = 60_000;
// stop_agent waits this long for the worker to end (its worktree is committed meanwhile).
const STOP_WAIT_MS = 15_000;
// After a result with messages the process has not taken yet, how long it may stay quiet
// before they count as dropped (a live process starts their turn within milliseconds).
const DROP_WAIT_MS = 5_000;
// Once its input is closed, how long the worker's process may sit between turns without
// exiting before it is ended (a backstop: it normally exits at once).
const EXIT_WAIT_MS = 15_000;
// Claude Code's task types that never wake the worker (as for the session, tasks.mjs).
const QUIET_TASK_TYPES = new Set(['dream']);
const MAX_LAST_TEXT = 600;
const MAX_STEP_CHARS = 140;
// What the worker's model sees in front of a message (the transcript keeps the bare text).
const MESSAGE_PREFIX = { lead: '[Message from the lead agent]', user: '[Message from the user]' };

/** The model agents for the Agents view: every catalog model, with what it is good for. */
export function modelAgentList() {
  return MODELS.map((model) => ({
    id: model.id,
    name: agentName(model),
    model: model.name,
    provider: model.provider,
    hint: AGENT_HINTS[model.id] ?? model.description,
    direct: runsDirect(model),
    vision: model.vision,
  }));
}

/** What a worker's pending approval asks the user, in one line. */
function pendingSummary(entry) {
  if (entry.kind === 'question') {
    const questions = Array.isArray(entry.input?.questions) ? entry.input.questions.map((q) => q?.question).filter((q) => typeof q === 'string') : [];
    return `its question “${oneLine(questions.join(' / ') || 'a question', MAX_STEP_CHARS)}”`;
  }
  return `approval to run ${entry.tool}`;
}

/** "GPT-6.1 Sol agent". */
export function agentName(model) {
  return `${model?.name ?? 'Model'} agent`;
}

function delegateDescription() {
  const models = MODELS.map((model) => `- ${model.id}: ${model.name}, ${AGENT_HINTS[model.id] ?? model.description}`).join('\n');
  return [
    'Start a parallel worker: a full coding agent (Read, Edit, Write, Bash and the rest of your tools) on any model below, working in the same project at the same time as you. ' +
      'Use it to split independent work across parallel workers: give each one a self-contained task with a clear scope, then keep working yourself or collect the results with wait_agents.',
    'Returns at once with the worker id; it does not wait for the work. Start several in one message to run them in parallel. ' +
      "When a worker finishes and you are not waiting for it, its report arrives in the conversation as a message starting with \"[<model> agent finished]\" (that message comes from Harbor, not the user).",
    'While workers run you can steer them: check_agents shows what each is doing now (without waiting), message_agent sends a running worker a message it reads at its next step (redirect it, add a constraint, tell it to wrap up), and stop_agent halts one that is off track and returns its partial report.',
    'Writing the task: the worker sees none of this conversation, only `task`. Say what to do and why, which files or directories it owns (and must not touch), constraints, how to verify (tests to run), and what to report back.',
    "Workers share the project folder unless isolation is 'worktree': give parallel workers disjoint files, or use isolation 'worktree' (git repositories only) to run a worker on its own branch and worktree, starting from the last commit (uncommitted changes are not in it). When it finishes, its leftover changes are committed on that branch and the report names the branch, the worktree path and a diffstat for you to review and merge; a worktree with no changes is removed.",
    'Pick models by difficulty and cost: the strongest for the hard parts, cheap fast ones for grunt work. Workers run in the session\'s permission mode; their approvals go to the user, labelled with the worker.',
    `Models:\n${models}`,
  ].join('\n\n');
}

const MESSAGE_DESCRIPTION =
  'Send a message to a worker you started with delegate that is still running. It reads the message at its next step, in the middle of its work, so use it to redirect the worker, add a constraint, answer something the task left open, or tell it to wrap up. ' +
  'Returns at once; the worker answers by carrying on (its report at the end reflects it). Fails when the worker has already finished: its report is then collected with wait_agents. The user sees the message on the worker\'s card.';

const STOP_DESCRIPTION =
  'Stop a running worker that is off track or no longer needed. Its process ends (what it already wrote to disk stays), and for up to 15 seconds this waits for it to finish (a worktree is committed meanwhile), then returns its partial report: what it did, files changed, commands run, the worktree branch. ' +
  'You get the report here, so no automatic report follows. `reason` is recorded on its card and in the report. If it has not finished in time this says so, and the report arrives later as usual.';

const CHECK_DESCRIPTION =
  'Look at workers without waiting for them: for each, its state, how long it has run, tool uses and tokens, its latest step (the tool and what it was given), its last words, and how many of your messages it has not read yet. ' +
  'Never blocks and does not collect reports (wait_agents does). Without ids it covers every worker of this session that is running or whose report you have not received yet.';

const WAIT_DESCRIPTION =
  'Wait for workers started with delegate and return their reports (final answer, files changed, commands run, worktree branch). ' +
  'Without ids it waits for every worker of this session whose report you have not received yet. mode "all" (default) returns when all are done, "any" when the first one is; ' +
  'finished workers never make it wait. On timeout (default 30 minutes) it returns what is done and lists the workers still running. ' +
  'It returns early when the user sends a message.';

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function findTool(session, toolId) {
  return session.messages.find((message) => message.role === 'tool' && message.toolId === toolId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatTokens(count) {
  if (!count) return '0';
  if (count < 1000) return String(count);
  return count < 100_000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(count / 1000)}k`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clip(value, max) {
  const textValue = String(value ?? '');
  return textValue.length > max ? textValue.slice(0, max) + '\n[…cut]' : textValue;
}

/** One line, cut with an ellipsis. */
function oneLine(value, max) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

// What identifies a tool call in a summary of it: the command, the file, the pattern...
const STEP_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path', 'skill'];

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * The git and folders a worktree is made with: this machine's, or a session's cluster's
 * over ssh (remoteMachine). Every path given to one is a path on that machine.
 */
export const localMachine = {
  git,
  exists: async (dir) => fs.existsSync(dir),
  mkdir: async (dir) => fs.mkdirSync(dir, { recursive: true }),
  realpath: async (dir) => fs.realpathSync(dir),
};

/**
 * The same on `host` over ssh. `worktreesDir` is where its worktrees go when the
 * repository has no folder for them. A cluster that does not answer is not an empty
 * answer: those errors are marked fatal, so a missing repository is never invented.
 */
export function remoteMachine(host, { ssh = runSsh, worktreesDir } = {}) {
  const run = async (script) => {
    try {
      return await ssh(host, script, { timeoutMs: GIT_TIMEOUT_MS });
    } catch (error) {
      if (error.code === null || error.code === 255) throw Object.assign(new Error(`Could not reach ${host}: ${error.message}`), { fatal: true });
      throw error;
    }
  };
  return {
    worktreesDir,
    git: async (cwd, args) => (await run(`git -C ${shQuote(cwd)} ${args.map(shQuote).join(' ')}`)).trim(),
    exists: (dir) =>
      run(`test -e ${shQuote(dir)}`).then(
        () => true,
        (error) => {
          if (error.code === 1) return false;
          throw error;
        },
      ),
    mkdir: (dir) => run(`mkdir -p -- ${shQuote(dir)}`),
    realpath: async (dir) => (await run(`cd -- ${shQuote(dir)} && pwd -P`)).trim(),
  };
}

/**
 * Where a worker's worktree goes: the repository's own ignored `.worktrees/` or
 * `.claude/worktrees/` when it has one (Claude Code's convention), else Harbor's folder.
 * Never a folder the repository would see as new files.
 */
async function worktreeDir(root, id, fallbackRoot, machine) {
  for (const folder of ['.worktrees', '.claude/worktrees']) {
    try {
      await machine.git(root, ['check-ignore', '-q', `${folder}/${id}`]);
      return path.join(root, folder, id);
    } catch (error) {
      if (error.fatal) throw error;
      // Not ignored (or no such convention): try the next one.
    }
  }
  return path.join(fallbackRoot, `${path.basename(root)}-${id}`);
}

/** A git worktree on a new branch `harbor/<id>` at HEAD for a worker started in `cwd`. */
export async function createWorktree(cwd, id, fallbackRoot, machine = localMachine) {
  let root;
  try {
    root = await machine.git(cwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if (error.fatal) throw error;
    throw new Error(`isolation "worktree" needs a git repository, and ${cwd} is not in one. Run the worker without isolation and give it files no other worker touches.`);
  }
  let base;
  try {
    base = await machine.git(root, ['rev-parse', 'HEAD']);
  } catch (error) {
    if (error.fatal) throw error;
    throw new Error('isolation "worktree" needs a commit to start from; this repository has none yet.');
  }
  const branch = `harbor/${id}`;
  const dir = await worktreeDir(root, id, fallbackRoot, machine);
  await machine.mkdir(path.dirname(dir));
  await machine.git(root, ['worktree', 'add', '-q', '-b', branch, dir, base]);
  // The worker starts in the same subfolder of the repository as the session.
  const relative = path.relative(root, await machine.realpath(cwd));
  const workCwd = relative && !relative.startsWith('..') ? path.join(dir, relative) : dir;
  return { root, dir, branch, base, cwd: (await machine.exists(workCwd)) ? workCwd : dir };
}

/**
 * After the worker: leftover changes are committed on its branch; a branch with nothing
 * new is removed with its worktree. Returns what the lead needs to merge it.
 */
export async function finishWorktree(worktree, message, machine = localMachine) {
  const { root, dir, branch, base } = worktree;
  if (!(await machine.exists(dir))) return { branch, path: dir, removed: true, commits: 0, diffstat: '' };
  if (await machine.git(dir, ['status', '--porcelain'])) {
    const identity = (await machine.git(dir, ['config', 'user.email']).catch(() => '')) ? [] : ['-c', 'user.name=Harbor', '-c', 'user.email=harbor@localhost'];
    await machine.git(dir, ['add', '-A']);
    await machine.git(dir, [...identity, 'commit', '-q', '--no-verify', '-m', message]);
  }
  const commits = Number(await machine.git(dir, ['rev-list', '--count', `${base}..HEAD`])) || 0;
  if (!commits) {
    await machine.git(root, ['worktree', 'remove', '--force', dir]);
    await machine.git(root, ['branch', '-D', branch]).catch(() => '');
    return { branch, path: dir, removed: true, commits: 0, diffstat: '' };
  }
  // Every line flush left (git indents them all; trimming the output only fixed the first).
  const diffstat = (await machine.git(dir, ['diff', '--stat', `${base}..HEAD`])).split('\n').map((line) => line.trim()).join('\n');
  return { branch, path: dir, base: base.slice(0, 12), commits, diffstat };
}

/**
 * @param {object} deps
 * @param {Function} deps.query  the SDK query function
 * @param {(session: object, run: {model, effort, cwd, abortController, canUseTool}) => object} deps.queryOptions
 *   the SDK options for a worker (the runner's buildQueryOptions for the session's grants)
 * @param {(session: object, agent: object, signal: AbortSignal) => Function} deps.approvals
 *   a canUseTool callback that parks requests in the session's approval flow, labelled `agent`
 * @param {(session: object, text: string) => void} deps.deliver  sends a report to the main model
 * @param {Function} deps.flush  immediate publish
 * @param {Function} deps.schedule  throttled publish
 * @param {string} deps.worktreesDir  where local worktrees go when the repository has no folder for them
 * @param {{tool: Function}} [deps.webSearch]  web-search.mjs: `web_search` for workers on gateway routes
 * @param {number} [deps.stopWaitMs]  how long stop_agent waits for the worker to end
 * @param {number} [deps.dropWaitMs]  how long a worker's process may stay quiet after a result
 *   before messages it has not taken count as dropped
 * @param {number} [deps.exitWaitMs]  how long a worker's process, idle with its input closed,
 *   may take to exit
 * @param {(session: object, key: string) => Function|null} [deps.spawnPrepare]  the CLI host
 *   spawn hook for a worker of a session on another cluster (it runs there too), else null
 * @param {(session: object) => Promise} [deps.beforeStart]  runs before a worker's options are
 *   built (the runner learns a remote cluster's home)
 * @param {(session: object) => Promise<object>} [deps.machineFor]  the git and folders a
 *   session's worktree is made with: this machine's (localMachine), or the session's
 *   cluster's over ssh (remoteMachine)
 */
/** The CLI host's key for a worker's process. */
export const workerKey = (id) => `w:${id}`;

export function createModelAgents({
  query,
  queryOptions,
  approvals,
  deliver,
  flush,
  schedule,
  worktreesDir,
  webSearch = null,
  maxRunning = MODEL_AGENTS_MAX,
  attachWaitMs = 3000,
  stopWaitMs = STOP_WAIT_MS,
  dropWaitMs = DROP_WAIT_MS,
  exitWaitMs = EXIT_WAIT_MS,
  hostSocket = null,
  spawnPrepare = () => null,
  beforeStart = async () => {},
  machineFor = () => localMachine,
  log = console.error,
  now = Date.now,
}) {
  const agents = new Map(); // agent id -> agent
  const waiters = new Set(); // wait_agents calls in progress
  const claimed = new Set(); // delegate tool_use ids already given to an agent
  let shuttingDown = false;

  const ofSession = (sessionId) => [...agents.values()].filter((agent) => agent.session.id === sessionId);
  const isRunning = (agent) => agent.state === 'running';

  /** How many workers of a session are working now (the runner keeps the session busy meanwhile). */
  function running(sessionId) {
    return ofSession(sessionId).filter(isRunning).length;
  }

  /** The tool_use ids of the session's working workers (their cards must stay running). */
  function liveTools(sessionId) {
    return new Set(ofSession(sessionId).filter(isRunning).map((agent) => agent.toolId));
  }

  function newId(model) {
    let id;
    do id = `${model.id}-${crypto.randomBytes(3).toString('hex')}`;
    while (agents.has(id));
    return id;
  }

  /** Drops the oldest finished workers once there are many (their reports are on their cards). */
  function prune() {
    const finished = [...agents.values()].filter((agent) => !isRunning(agent) && agent.delivered);
    for (const agent of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_KEPT))) agents.delete(agent.id);
  }

  /**
   * The delegate call's tool_use id when Claude Code did not pass it (`_meta`): the oldest
   * delegate call in the transcript with the same input that no worker has yet.
   */
  async function claimToolUse(session, args) {
    const same = JSON.stringify(args);
    const deadline = now() + attachWaitMs;
    while (true) {
      const match = session.messages.find(
        (m) => m.role === 'tool' && m.tool === DELEGATE_TOOL && !m.agentId && !claimed.has(m.toolId) && JSON.stringify(m.input) === same,
      );
      if (match) return match.toolId;
      if (now() >= deadline) return `harbor-${crypto.randomUUID()}`;
      await sleep(20);
    }
  }

  /**
   * Marks the delegate call's card as this worker's. The card normally exists already:
   * Claude Code reports the tool call before running it, but the report can still be on
   * its way, so this waits a moment and otherwise adds the card itself.
   */
  async function attachTool(session, agent, args) {
    let card = findTool(session, agent.toolId);
    const deadline = now() + attachWaitMs;
    while (!card && now() < deadline) {
      await sleep(20);
      card = findTool(session, agent.toolId);
    }
    card ??= addMessage(session, 'tool', '', { tool: DELEGATE_TOOL, input: args, toolId: agent.toolId, state: 'running', at: now() });
    Object.assign(card, { state: 'running', background: true, agentId: agent.id, taskId: agent.id, agentModel: agent.model.id });
    if (agent.worktree) card.worktree = { branch: agent.worktree.branch, path: agent.worktree.dir };
    flush(session);
  }

  function workerPrompt(agent) {
    const lead = findModel(agent.session.model);
    const lines = [
      `Model identity: you are ${agent.model.name} (route ${agent.model.model}, provider ${agent.model.provider}), running as a worker agent in Harbor.`,
      `A lead agent${lead ? ` (${lead.name})` : ''} gave you this task and may run other workers in parallel. Work autonomously: make reasonable choices and say which.`,
      'Only when you are blocked on a decision that is genuinely the user\'s (one the task, the code and sensible defaults cannot settle), ask them with AskUserQuestion. You pause until they answer, and the lead keeps waiting for you, so ask rarely and early.',
      'Stay inside the scope the task gives you. Other workers may be editing other files at the same time: do not touch files outside your scope and do not undo changes you did not make.',
      'The lead (or the user) may send you messages while you work, marked [Message from the lead agent] / [Message from the user]; read them and adjust.',
    ];
    if (agent.worktree) {
      lines.push(`You work in your own git worktree (${agent.worktree.dir}) on branch ${agent.worktree.branch}. Commit there if you like; whatever you leave uncommitted is committed on that branch when you finish.`);
    }
    lines.push(
      'Finish with a concise report for the lead: what you did, the files you changed, the commands you ran and how they went (failures especially), and anything left undone.',
      'While a Monitor or background command of yours runs you keep running (its events wake you), and the lead keeps waiting for your report. So before your final report, stop the ones you no longer need (TaskStop). Anything that must keep running after you (a server, a relay) you start detached, e.g. `setsid nohup CMD > LOG 2>&1 &`, and name it in the report.',
    );
    if (!runsDirect(agent.model)) lines.push(TOOL_HYGIENE);
    return lines.join('\n');
  }

  /** A running worker's record; `fields` are what describe() keeps. */
  function newAgent(fields) {
    return {
      ...fields,
      state: 'running',
      abort: new AbortController(),
      input: createInputStream(),
      outstanding: new Map(), // uuid -> message id: written to its input, not yet taken by the process
      taken: new Set(), // uuids taken since its last result
      earlier: [], // answers of turns before the last (a message that arrived as it finished got a turn of its own)
      tasks: [], // its process's live background tasks (Monitors, commands): their events wake it
      idle: false, // between turns: its last turn ended, nothing has started since
      toolUses: 0,
      tokens: 0,
      calls: new Map(), // tool_use id -> block, for the report
      files: new Set(),
      commands: [],
      lastText: '',
      delivered: false,
      silent: false,
    };
  }

  async function delegate(session, args, extra) {
    const model = findModel(args?.model);
    if (!model) return text(`Unknown model "${args?.model}". Use one of: ${MODELS.map((m) => m.id).join(', ')}.`, true);
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return text('Give the worker a task.', true);
    // The same call asked again after a restart (the host resends what was not answered):
    // its worker is already running.
    const metaId = extra?._meta?.['claudecode/toolUseId'];
    const started = metaId && [...agents.values()].find((agent) => agent.toolId === metaId && agent.session.id === session.id);
    if (started) return text(`Started worker ${started.id} (${agentName(started.model)}). It works in parallel with you. Collect its report with wait_agents.`);
    if (shuttingDown) return text('Harbor is restarting; no new workers can start now.', true);
    if (running(session.id) >= maxRunning) {
      return text(`${maxRunning} workers are already running in this session. Collect some with wait_agents before starting more.`, true);
    }
    const toolId = metaId || (await claimToolUse(session, args));
    claimed.add(toolId);
    const id = newId(model);
    const effort = EFFORTS.includes(args.effort) && model.efforts.includes(args.effort) ? args.effort : resolveEffort(model.id, session.efforts);
    const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim().slice(0, 80) : '';
    const agent = newAgent({ id, session, model, effort, toolId, task, description, startedAt: now() });
    if (args.isolation === 'worktree') {
      try {
        // A remote session's folder and git are on its cluster.
        const machine = await machineFor(session);
        agent.worktree = await createWorktree(session.cwd, id, machine.worktreesDir ?? worktreesDir, machine);
      } catch (error) {
        claimed.delete(toolId);
        return text(`Could not start the worker: ${error.message}`, true);
      }
    }
    agent.cwd = agent.worktree?.cwd ?? session.cwd;
    agents.set(id, agent);
    prune();
    await attachTool(session, agent, args);
    agent.done = work(agent);
    const where = agent.worktree ? ` in worktree ${agent.worktree.dir} (branch ${agent.worktree.branch})` : '';
    return text(
      `Started worker ${id} (${agentName(model)}${description ? `, “${description}”` : ''})${where}. It works in parallel with you. ` +
        'Collect its report with wait_agents, or keep working: the report arrives as a message when it finishes.',
    );
  }

  /** Runs the worker's Claude Code process to the end; never rejects. */
  async function work(agent) {
    const { session, model, input } = agent;
    try {
      // A remote session's cluster is reached first (a local worker starts at once). One
      // taken back after a restart is already running: its cluster may be slow to answer.
      if (isRemote(session)) {
        await beforeStart(session).catch((error) => {
          if (!agent.reattached) throw error;
        });
      }
      const prepare = agent.reattached ? null : spawnPrepare(session, workerKey(agent.id));
      if (prepare && !hostSocket) throw new Error('Workers of a session on another cluster need the CLI host.');
      const options = queryOptions(session, {
        model,
        effort: agent.effort,
        cwd: agent.cwd,
        abortController: agent.abort,
        canUseTool: approvals(session, approvalLabel(agent), agent.abort.signal),
      });
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: workerPrompt(agent) };
      options.disallowedTools = [...(options.disallowedTools || []), ...WORKER_DISALLOWED_TOOLS];
      // Gateway routes have no working WebSearch (see web-search.mjs): the worker searches through Harbor.
      if (webSearch && !runsDirect(model)) {
        options.mcpServers = { ...(options.mcpServers || {}), [AGENT_SERVER]: createSdkMcpServer({ name: AGENT_SERVER, version: '1.0.0', alwaysLoad: true, tools: [webSearch.tool()] }) };
      }
      options.includePartialMessages = false;
      options.persistSession = true;
      delete options.resume;
      delete options.forkSession;
      // Claude Code echoes each message with our uuid when it takes it: that is when a
      // message to the worker counts as delivered (see taken).
      options.extraArgs = { 'replay-user-messages': null };
      if (hostSocket) {
        options.spawnClaudeCodeProcess = hostSpawner(hostSocket, workerKey(agent.id), {
          attach: Boolean(agent.reattached),
          prepare,
          log,
          onProcess: (proc) => (agent.proc = proc),
        });
      }
      // Streaming input, so the permission mode can follow the session's.
      const stream = query({ prompt: input, options });
      agent.stream = stream;
      if (!agent.reattached) input.push({ type: 'user', message: { role: 'user', content: agent.task }, parent_tool_use_id: null });
      // It had finished before the restart: its input stays closed.
      else if (agent.closed) close(agent);
      for await (const message of stream) {
        if (message.type === 'result') {
          onResult(agent, message);
          continue;
        }
        if (message.type === 'command_lifecycle') {
          if (message.state === 'started') taken(agent, message.command_uuid);
          else if (message.state === 'cancelled') untaken(agent, message.command_uuid);
          continue;
        }
        if (message.type === 'user' && message.isReplay) {
          // It took input (a message, a task's event): a turn is under way.
          agent.idle = false;
          if (message.uuid) taken(agent, message.uuid);
          continue;
        }
        if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
          onTasks(agent, message.tasks);
          continue;
        }
        // The process is working again: it took up the messages (or the task event) it was waiting on.
        if (message.type === 'assistant' || message.type === 'stream_event') {
          stopQuietTimer(agent);
          agent.idle = false;
        }
        try {
          onMessage(agent, message);
        } catch (error) {
          log(`Could not apply a message from ${agent.id}: ${error.stack || error.message}`);
        }
      }
    } catch (error) {
      if (!agent.abort.signal.aborted && !agent.detached) {
        agent.error = error;
        log(`Model agent ${agent.id} failed: ${error.message}`);
      }
    } finally {
      // Let go of for the next server: it is still running in the host.
      if (!agent.detached) {
        input.end();
        await finish(agent);
      }
    }
  }

  /** What the next server needs to carry on with a running worker (reattach). */
  function describe(agent) {
    return {
      version: 1,
      kind: 'worker',
      ...Object.fromEntries(['id', 'toolId', 'task', 'description', 'effort', 'startedAt', 'cwd', 'worktree', 'earlier', 'tasks', 'idle', 'toolUses', 'tokens', 'lastText', 'lastTool', 'result', 'stopRequested', 'stoppedBy', 'stopReason', 'silent'].map((key) => [key, agent[key]])),
      sessionId: agent.session.id,
      modelId: agent.model.id,
      closed: agent.input.ended,
      outstanding: [...agent.outstanding],
      taken: [...agent.taken],
      // Only what the report reads of each call (see onMessage).
      calls: [...agent.calls].map(([id, call]) => [id, { name: call.name, input: { file_path: call.input?.file_path, notebook_path: call.input?.notebook_path, command: call.input?.command } }]),
      files: [...agent.files],
      commands: agent.commands,
    };
  }

  function saveMeta() {
    for (const agent of agents.values()) {
      if (isRunning(agent) && !agent.detached && agent.proc && !agent.finishing) agent.proc.setMeta(describe(agent));
    }
  }

  /**
   * Server shutdown with a CLI host: running workers keep going there, each with what it
   * has done so far (describe), for the next server.
   */
  function detachAll() {
    shuttingDown = true;
    for (const waiter of [...waiters]) waiter.drop();
    for (const agent of agents.values()) {
      if (!isRunning(agent) || agent.finishing || !agent.proc) continue;
      agent.detached = true;
      stopQuietTimer(agent);
      clearTimeout(agent.exitTimer);
      try {
        agent.proc.setMeta(describe(agent));
      } catch (error) {
        log(`Could not keep the state of worker ${agent.id}: ${error.message}`);
      }
      agent.proc.detach();
    }
  }

  /**
   * Boot with a CLI host: takes back the workers a previous server left running there
   * (`procs`: the host's list; `sessions` looks a session up). One whose session or model
   * is gone is ended. Returns the ids taken back.
   */
  async function reattach(procs, sessions) {
    const taken = [];
    for (const proc of procs) {
      if (!proc.key?.startsWith('w:')) continue;
      const meta = proc.meta?.version === 1 && proc.meta.kind === 'worker' ? proc.meta : null;
      const session = meta && sessions(meta.sessionId);
      const model = meta && findModel(meta.modelId);
      if (!session || session.removed || !model || agents.has(meta.id)) {
        log(`Ending a worker process left by the previous server: ${proc.key}.`);
        killInHost(hostSocket, proc.key).catch((error) => log(`Could not end ${proc.key}: ${error.message}`));
        continue;
      }
      const agent = newAgent({ ...meta, session, model, reattached: true });
      for (const key of ['version', 'kind', 'sessionId', 'modelId', 'closed']) delete agent[key];
      agent.closed = meta.closed;
      agent.outstanding = new Map(meta.outstanding ?? []);
      agent.taken = new Set(meta.taken ?? []);
      agent.calls = new Map(meta.calls ?? []);
      agent.files = new Set(meta.files ?? []);
      agent.commands = meta.commands ?? [];
      agent.earlier = meta.earlier ?? [];
      agent.tasks = meta.tasks ?? [];
      agents.set(agent.id, agent);
      claimed.add(agent.toolId);
      const card = findTool(session, agent.toolId);
      if (card) Object.assign(card, { state: 'running', background: true, agentId: agent.id, taskId: agent.id, agentModel: model.id });
      agent.done = work(agent);
      taken.push(agent.id);
    }
    return taken;
  }

  /**
   * A turn of the worker ended. It has finished when nothing can start another: no
   * message to it still needs a turn (one the process has not taken yet, or one it took
   * but whose answer is not in this result) and no background task of its own is left to
   * wake it (a Monitor's events, a command's end start turns of their own). Then its input
   * is closed, so the process exits. Until then it is still working: it takes messages, and
   * the next result decides again. A live process that stays quiet for dropWaitMs has
   * dropped the messages it owes: they are marked so.
   */
  function onResult(agent, result) {
    const before = agent.result;
    const listed = result.user_message_uuids;
    for (const uuid of listed ?? []) taken(agent, uuid);
    // An earlier turn's answer stays in the report when a message to the worker started
    // this one (it answered that message); a turn a background task started supersedes it.
    if (agent.taken.size === 0) agent.earlier = [];
    else if (before && !before.is_error && typeof before.result === 'string' && before.result.trim()) agent.earlier.push(before.result.trim());
    agent.result = result;
    const owed = agent.outstanding.size > 0 || (Array.isArray(listed) && [...agent.taken].some((uuid) => !listed.includes(uuid)));
    agent.taken.clear();
    agent.idle = true;
    stopQuietTimer(agent);
    if (!owed || agent.input.ended) {
      settle(agent);
      return;
    }

    agent.quietTimer = setTimeout(() => {
      agent.quietTimer = undefined;
      for (const uuid of [...agent.outstanding.keys()]) untaken(agent, uuid);
      settle(agent);
    }, dropWaitMs);
  }

  /** Between turns with nothing owed: finished, unless a background task of its own will wake it. */
  function settle(agent) {
    if (!agent.input.ended && agent.tasks.length) {
      showProgress(agent);
      return;
    }
    close(agent);
  }

  /**
   * Its process's live background tasks changed (`background_tasks_changed`, the whole set).
   * When the last one ends between turns, its event normally starts a turn (whose result
   * settles the worker); if none starts within dropWaitMs, the worker has finished.
   */
  function onTasks(agent, tasks) {
    agent.tasks = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task?.task_id && !task.ambient && !QUIET_TASK_TYPES.has(task.task_type))
      .map((task) => ({ id: task.task_id, type: task.task_type || '', description: task.description || '' }));
    showProgress(agent);
    if (!agent.idle || agent.quietTimer || agent.input.ended || agent.tasks.length) return;
    agent.quietTimer = setTimeout(() => {
      agent.quietTimer = undefined;
      if (agent.idle && !agent.tasks.length) close(agent);
    }, dropWaitMs);
  }

  /** The card's live line: its stats, and what it waits on between turns. */
  function showProgress(agent) {
    const card = findTool(agent.session, agent.toolId);
    if (card?.state !== 'running') return;
    const waitingOn = agent.idle && !agent.input.ended ? agent.tasks.length : 0;
    card.progress = {
      description: waitingOn ? `Waiting on ${waitingOn} background ${waitingOn === 1 ? 'task' : 'tasks'}` : 'Working',
      toolUses: agent.toolUses,
      tokens: agent.tokens,
      ...(agent.lastTool && !waitingOn ? { lastTool: agent.lastTool } : {}),
      ...(waitingOn ? { waitingOn } : {}),
    };
    schedule(agent.session);
  }

  /**
   * The worker has finished: its input closes, so its process exits (after the turn it may
   * still be in). One that sits between turns for exitWaitMs without exiting is ended, with
   * whatever it still runs. Its report is complete either way: it finishes as done, not
   * stopped.
   */
  function close(agent) {
    agent.input.end();
    armExitTimer(agent);
  }

  function armExitTimer(agent) {
    if (agent.exitTimer) return;
    agent.exitTimer = setTimeout(() => {
      agent.exitTimer = undefined;
      if (!isRunning(agent) || agent.finishing) return;
      // A turn under way ends by itself, and the process exits after it.
      if (!agent.idle) return armExitTimer(agent);
      log(`Model agent ${agent.id} had not exited ${formatDuration(exitWaitMs)} after it finished; ending it.`);
      agent.abort.abort();
    }, exitWaitMs);
    agent.exitTimer.unref?.();
  }

  /** The process started working on something: it is not dropping the messages it waits on. */
  function stopQuietTimer(agent) {
    if (!agent.quietTimer) return;
    clearTimeout(agent.quietTimer);
    agent.quietTimer = undefined;
  }

  /** The process took a message to the worker (into a turn, or as the start of one): delivered. */
  function taken(agent, uuid) {
    const messageId = agent.outstanding.get(uuid);
    if (!messageId) return;
    agent.outstanding.delete(uuid);
    agent.taken.add(uuid);
    stopQuietTimer(agent);
    const { session } = agent;
    const message = session.messages.find((m) => m.id === messageId);
    if (message?.delivery === 'sent') {
      message.delivery = 'done';
      // The transcript reads in the order the worker saw things: where it was read.
      session.messages.splice(session.messages.indexOf(message), 1);
      session.messages.push(message);
      flush(session);
    }
  }

  /** The process will never read a message (cancelled, or the worker ended first). */
  function untaken(agent, uuid) {
    const messageId = agent.outstanding.get(uuid);
    if (!messageId) return;
    agent.outstanding.delete(uuid);
    const message = agent.session.messages.find((m) => m.id === messageId);
    if (message?.delivery === 'sent') {
      message.delivery = 'dropped';
      flush(agent.session);
    }
  }

  function approvalLabel(agent) {
    return { toolId: agent.toolId, description: agent.description || agent.id, subagentType: agentName(agent.model) };
  }

  /** One message from the worker's process: into the transcript under its card, and its stats. */
  function onMessage(agent, message) {
    if (message.type === 'stream_event' || (message.type === 'user' && message.isReplay)) return;
    if (message.type === 'system' && !NESTED_SYSTEM.has(message.subtype)) return;
    const top = !message.parent_tool_use_id;
    const nested = { ...message, parent_tool_use_id: message.parent_tool_use_id || agent.toolId };
    // The worker's own Claude Code session is not the main conversation's.
    delete nested.session_id;
    const { session } = agent;
    applySdkMessage(session, nested, { model: agent.model.id, effort: agent.effort, flush, schedule });
    if (!top) return;
    if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block.type === 'tool_use') {
          agent.toolUses += 1;
          agent.lastTool = block.name;
          agent.lastCall = block;
          agent.lastCallDone = false;
          agent.calls.set(block.id, block);
        } else if (block.type === 'text' && block.text?.trim()) agent.lastText = block.text;
      }
      const usage = message.message?.usage;
      // Context size after its latest step. Some gateway routes report zeros per message
      // (seen on GPT-6 Luna); those keep the last real figure (or none: the stats omit it).
      const tokens = usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0) : 0;
      if (tokens > 0) agent.tokens = tokens;
    } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        const call = block.type === 'tool_result' ? agent.calls.get(block.tool_use_id) : null;
        if (!call) continue;
        if (call === agent.lastCall) agent.lastCallDone = true;
        const file = call.input?.file_path || call.input?.notebook_path;
        if (FILE_TOOLS.has(call.name) && !block.is_error && typeof file === 'string') agent.files.add(path.relative(agent.cwd, path.resolve(agent.cwd, file)) || file);
        if (call.name === 'Bash' && typeof call.input?.command === 'string') agent.commands.push({ command: call.input.command, failed: Boolean(block.is_error) });
      }
    }
    showProgress(agent);
  }

  function stats(agent) {
    const parts = [`${agent.toolUses} tool ${agent.toolUses === 1 ? 'use' : 'uses'}`];
    if (agent.tokens) parts.push(`${formatTokens(agent.tokens)} tokens`);
    parts.push(formatDuration((agent.endedAt ?? now()) - agent.startedAt));
    return parts.join(' · ');
  }

  function outcome(agent) {
    return agent.state === 'done' ? 'finished' : agent.state === 'stopped' ? 'was stopped' : 'failed';
  }

  /** The worker's report as the lead reads it: answer, files, commands, worktree. */
  function report(agent) {
    const parts = [];
    const result = agent.result;
    const last = (result && !result.is_error && typeof result.result === 'string' ? result.result : agent.lastText).trim();
    const answer = agent.earlier.length ? [...agent.earlier, 'After a message that reached it as it finished:', last].join('\n\n') : last;
    if (agent.state === 'stopped') {
      if (agent.stoppedBy !== 'lead') parts.push('Stopped by the user before it finished.');
      else parts.push(agent.stopReason ? `Stopped by the lead: ${agent.stopReason}` : 'Stopped by the lead before it finished.');
    }
    else if (agent.state === 'failed') {
      const reason = result?.errors?.length ? result.errors.join('\n') : result?.is_error && result.result ? result.result : agent.error?.message || 'the process ended without an answer';
      parts.push(`Failed: ${clip(reason, 2000)}`);
    }
    if (answer) parts.push(clip(answer, MAX_ANSWER_CHARS));
    // What the user told it from its card: the lead did not send it, so it would not know.
    const fromUser = agent.session.messages.filter((m) => m.role === 'user' && m.parentToolId === agent.toolId && m.from === 'user' && m.delivery === 'done');
    if (fromUser.length) {
      const shown = fromUser.slice(-MAX_USER_MESSAGES).map((m) => `“${clip(oneLine(m.text, 300), 300)}”`);
      parts.push(`The user wrote to it directly (not through you): ${shown.join('; ')}${fromUser.length > shown.length ? ` and ${fromUser.length - shown.length} earlier` : ''}`);
    }
    if (agent.files.size) {
      const files = [...agent.files];
      parts.push(`Files changed: ${files.slice(0, 30).map((file) => `\`${file}\``).join(', ')}${files.length > 30 ? ` and ${files.length - 30} more` : ''}`);
    }
    if (agent.commands.length) {
      const shown = agent.commands.slice(-MAX_LISTED);
      const failed = agent.commands.filter((command) => command.failed).length;
      const list = shown.map(({ command, failed: bad }) => `\`${clip(command.replace(/\s+/g, ' '), 140).replace(/`/g, "'")}\`${bad ? ' (failed)' : ''}`);
      const earlier = agent.commands.length - shown.length;
      parts.push(`Commands (${agent.commands.length}${failed ? `, ${failed} failed` : ''}): ${list.join(', ')}${earlier ? ` and ${earlier} earlier` : ''}`);
    }
    const tree = agent.worktreeResult;
    if (tree?.error) parts.push(`Worktree: ${agent.worktree.dir} on branch ${agent.worktree.branch} (could not be finished: ${tree.error})`);
    else if (tree?.removed) parts.push('Worktree: no changes, so its worktree and branch were removed.');
    else if (tree) {
      parts.push(
        `Worktree: branch \`${tree.branch}\` at ${tree.path}, ${tree.commits} ${tree.commits === 1 ? 'commit' : 'commits'} on top of ${tree.base}. Review and merge it (e.g. \`git merge ${tree.branch}\`), then remove the worktree.\n` +
          clip(tree.diffstat.split('\n').slice(-40).join('\n'), 4000),
      );
    }
    return parts.join('\n\n') || 'No report.';
  }

  /** The report with a header naming the worker, as the main model receives it. */
  function reportForModel(agent) {
    const label = agent.description ? ` “${agent.description}”` : '';
    return `${agentName(agent.model)} ${agent.id}${label} ${outcome(agent)} (${stats(agent)}).\n\n${report(agent)}`;
  }

  async function finish(agent) {
    const { session } = agent;
    // From here it takes no more messages (message_agent says it has finished), and what
    // its process never took will not be read.
    agent.finishing = true;
    stopQuietTimer(agent);
    clearTimeout(agent.exitTimer);
    for (const uuid of [...agent.outstanding.keys()]) untaken(agent, uuid);
    agent.endedAt = now();
    const result = agent.result;
    // It counts as running (for wait_agents, isBusy and the cap) until its worktree is
    // committed, so no report goes out without the branch.
    if (agent.worktree) {
      try {
        agent.worktreeResult = await finishWorktree(agent.worktree, `${agentName(agent.model)} ${agent.id}: ${agent.description || 'work'}`, await machineFor(session));
      } catch (error) {
        agent.worktreeResult = { error: error.message };
        log(`Could not finish the worktree of ${agent.id}: ${error.message}`);
      }
    }
    agent.state = agent.stopRequested ? 'stopped' : result && !result.is_error ? 'done' : 'failed';
    const cost = result?.total_cost_usd || 0;
    const outputTokens = Object.values(result?.modelUsage || {}).reduce((sum, usage) => sum + (usage?.outputTokens || 0), 0);
    addUsage(session, agent.model.id, cost, outputTokens);
    const card = findTool(session, agent.toolId);
    if (card) {
      card.state = agent.state === 'done' ? 'done' : 'error';
      if (agent.state === 'stopped') card.stopped = true;
      if (agent.state === 'stopped' && agent.stoppedBy) Object.assign(card, { stoppedBy: agent.stoppedBy, ...(agent.stopReason ? { stopReason: agent.stopReason } : {}) });
      card.output = toolOutputText(report(agent));
      card.usage = { tokens: agent.tokens, toolUses: agent.toolUses, durationMs: agent.endedAt - agent.startedAt, cost, outputTokens };
      card.endedAt = agent.endedAt;
      delete card.progress;
      delete card.elapsed;
      if (agent.worktreeResult && !agent.worktreeResult.error) {
        card.worktree = agent.worktreeResult.removed ? { removed: true } : { branch: agent.worktreeResult.branch, path: agent.worktreeResult.path, commits: agent.worktreeResult.commits };
      }
    }
    // Tool calls the worker never finished (it was stopped mid-call) end with it.
    const inside = new Set([agent.toolId]);
    for (const message of session.messages) {
      if (!message.parentToolId || !inside.has(message.parentToolId)) continue;
      if (message.role === 'tool') {
        inside.add(message.toolId);
        if (message.state === 'running') {
          message.state = 'error';
          message.output ||= 'Interrupted before this tool call finished.';
          message.endedAt = agent.endedAt;
        }
      }
    }
    flush(session);
    // A wait_agents call that names it returns it. One waiting on other workers returns
    // early with it (a report sent into the turn is not read until that call returns,
    // which can be an hour). Otherwise it reports by itself.
    const awaited = [...waiters].some((waiter) => waiter.sessionId === session.id && waiter.ids.has(agent.id));
    const other = !awaited && [...waiters].find((waiter) => waiter.sessionId === session.id && waiter.collect);
    if (other) other.others.push(agent.id);
    for (const waiter of [...waiters]) waiter.check();
    if (other) other.finish('other');
    else if (!awaited) announce(agent);
  }

  /** Tells the main model (and the transcript) that a worker ended, unless it was stopped with the session. */
  function announce(agent) {
    if (agent.delivered || agent.silent || shuttingDown) return;
    agent.delivered = true;
    const { session } = agent;
    const label = agent.description ? ` “${agent.description}”` : '';
    addNotice(session, `${agentName(agent.model)}${label} ${outcome(agent)}.`, agent.state === 'failed' ? 'warning' : 'info', { agentToolId: agent.toolId });
    flush(session);
    const verb = agent.state === 'done' ? 'finished' : agent.state === 'stopped' ? 'stopped' : 'failed';
    deliver(
      session,
      `[${agentName(agent.model)} ${verb}] Automatic report from Harbor (not a message from the user) for the worker you started with delegate.\n\n${reportForModel(agent)}`,
    );
  }

  /**
   * Resolves `{why, others}`: why is 'ready' when every one (mode 'all') or the first (mode
   * 'any') of the workers `ids` has ended, 'timeout' after `ms`, 'aborted' when the call is
   * cancelled, 'woken' when the user sends a message, or 'other' when (with `collect`) a
   * worker it does not name ends: `others` lists those. A worker named by a waiter (or
   * collected) does not report by itself when it ends (see finish): the caller returns its report.
   */
  function awaitAgents(sessionId, ids, { mode = 'all', ms, signal, collect = false }) {
    return new Promise((resolve) => {
      // `others`: workers it did not name that ended meanwhile (wait_agents, `collect`); it returns their reports.
      const waiter = { sessionId, ids: new Set(ids), collect, others: [], done: false };
      const onAbort = () => waiter.finish('aborted');
      const timer = setTimeout(() => waiter.finish('timeout'), ms);
      // Let go of without an answer (detachAll): the next server answers the call, asked again.
      waiter.drop = () => {
        waiter.done = true;
        waiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      waiter.finish = (reason) => {
        if (waiter.done) return;
        waiter.done = true;
        waiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ why: reason, others: waiter.others });
      };
      waiter.check = () => {
        const ended = ids.filter((id) => !isRunning(agents.get(id))).length;
        if (mode === 'any' ? ended > 0 : ended === ids.length) waiter.finish('ready');
      };
      if (signal?.aborted) return waiter.finish('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
      waiter.check();
    });
  }

  /**
   * A message the user sent into the running turn that the main model has read but not
   * answered in text: nothing visible to the user written after it was sent. Messages before the turn's own
   * (and ones the process has not taken yet) do not count.
   */
  function unansweredMessage(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i];
      if (message.parentToolId) continue;
      if (message.role === 'assistant' && message.text?.trim()) return null;
      if (message.role !== 'user') continue;
      if (message.id === session.currentMessageId) return null;
      if (message.delivery !== 'running' && message.delivery !== 'done') continue;
      // The process may answer a message before it reports taking it, which moves the
      // message after that answer (runner.mjs taken): text written since it was sent counts.
      const replied = session.messages.some((m) => !m.parentToolId && m.role === 'assistant' && m.text?.trim() && m.at >= message.at);
      return replied ? null : message;
    }
    return null;
  }

  async function wait(session, args, extra) {
    // Models read a mid-turn message, think about it and wait again: the user, who cannot
    // see thinking, gets no reply until the workers finish. So it must answer first.
    const owed = unansweredMessage(session);
    if (owed) {
      return text(
        `Not waiting yet: the user wrote “${clip(oneLine(owed.text || '', 300), 300)}” during this turn and has had no reply they can see (thinking is not shown). Answer them in a text message now, then call wait_agents again.`,
        true,
      );
    }
    const requested = Array.isArray(args?.ids) && args.ids.length ? [...new Set(args.ids.map(String))] : null;
    const known = requested
      ? requested.filter((id) => agents.get(id)?.session.id === session.id)
      : ofSession(session.id)
          .filter((agent) => isRunning(agent) || !agent.delivered)
          .map((agent) => agent.id);
    const unknown = requested ? requested.filter((id) => !known.includes(id)) : [];
    const unknownLine = unknown.length ? `Unknown worker ids: ${unknown.join(', ')}.` : '';
    if (!known.length) return text([requested ? '' : 'No workers to wait for: every report has been delivered.', unknownLine].filter(Boolean).join('\n'), Boolean(requested));

    const mode = args?.mode === 'any' ? 'any' : 'all';
    const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(args?.timeout_seconds) || DEFAULT_WAIT_SECONDS));
    const { why, others } = await awaitAgents(session.id, known, { mode, ms: seconds * 1000, signal: extra?.signal, collect: true });
    const finishedOthers = others.map((id) => agents.get(id)).filter((agent) => agent && !agent.delivered);

    const list = known.map((id) => agents.get(id)).filter(Boolean);
    if (why === 'aborted') {
      // The call was cancelled (the turn stopped): workers that ended meanwhile report by themselves.
      for (const agent of [...list, ...finishedOthers]) if (!isRunning(agent) && !agent.delivered) announce(agent);
      return text('Interrupted.', true);
    }
    const sections = [];
    const still = list.filter(isRunning);
    if (why === 'timeout') sections.push(`Timed out after ${formatDuration(seconds * 1000)}; ${still.length} still running.`);
    if (why === 'woken') {
      // Models tend to answer in their thinking and wait again, which leaves the user
      // with no reply at all.
      sections.push(
        'Returned early because the user sent a message. Reply to it in text the user can see now (thinking is not shown to them) before you wait again or do more work.',
      );
    }
    for (const agent of list) {
      if (isRunning(agent)) {
        sections.push(`${agentName(agent.model)} ${agent.id}${agent.description ? ` “${agent.description}”` : ''} is still running (${stats(agent)}).`);
      } else if (agent.delivered) {
        sections.push(`${agentName(agent.model)} ${agent.id} ${outcome(agent)}; its report was delivered earlier in the conversation.`);
      } else {
        agent.delivered = true;
        sections.push(reportForModel(agent));
      }
    }
    for (const agent of finishedOthers) {
      agent.delivered = true;
      const label = agent.description ? ` “${agent.description}”` : '';
      addNotice(session, `${agentName(agent.model)}${label} ${outcome(agent)}.`, agent.state === 'failed' ? 'warning' : 'info', { agentToolId: agent.toolId });
      sections.push(`Returned early: another worker of yours ended meanwhile (not one you were waiting for). Its report:\n\n${reportForModel(agent)}`);
    }
    if (unknownLine) sections.push(unknownLine);
    return text(sections.join('\n\n---\n\n'));
  }

  /** The worker of this session with that id, or undefined. */
  function ofSessionById(session, id) {
    const agent = agents.get(String(id ?? ''));
    return agent?.session.id === session.id ? agent : undefined;
  }

  /** True while the worker's process can still take a message. */
  function acceptsMessages(agent) {
    return isRunning(agent) && !agent.finishing && !agent.stopRequested && !agent.input.ended;
  }

  /** Why a worker that cannot take a message (or be stopped) is past that, for the main model. */
  function finishedText(agent) {
    const base = `${agentName(agent.model)} ${agent.id} already finished`;
    if (isRunning(agent)) return `${base}; its report is on its way (wait_agents returns it).`;
    if (agent.delivered) return `${base}; its report was delivered earlier in the conversation. Start a new worker if more work is needed.`;
    return `${base}; its report has not been collected yet: wait_agents returns it.`;
  }

  /** The text of a message to a worker, trimmed; an error `{status, error}` when it cannot be sent. */
  function checkMessageText(value) {
    const body = typeof value === 'string' ? value.trim() : '';
    if (!body) return { status: 400, error: 'Write a message first.' };
    if (body.length > MAX_MESSAGE_LENGTH) return { status: 400, error: 'This message is too long.' };
    return { text: body };
  }

  /**
   * Writes a message to a running worker's input, to be read at its next step
   * (priority `next`, as for the main session), and records it under its card.
   * `from` is 'lead' (message_agent) or 'user' (the card's composer). Returns
   * `{messageId}` or `{status, error}`.
   */
  function steer(agent, { text: body, from, clientId }) {
    if (!acceptsMessages(agent)) return { status: 409, error: 'This agent is not running.' };
    const { session } = agent;
    const uuid = crypto.randomUUID();
    try {
      agent.input.push({ type: 'user', message: { role: 'user', content: `${MESSAGE_PREFIX[from]}\n\n${body}` }, parent_tool_use_id: null, uuid, priority: 'next' });
    } catch {
      return { status: 409, error: 'This agent is not running.' };
    }
    const message = addMessage(session, 'user', body, { parentToolId: agent.toolId, from, delivery: 'sent', ...(clientId ? { clientId } : {}), at: now() });
    agent.outstanding.set(uuid, message.id);
    flush(session);
    return { messageId: message.id };
  }

  /** The user's message to a worker, by its delegate card (POST .../agents/:toolId/message). */
  function messageCard(session, toolId, { text: value, clientId } = {}) {
    const agent = ofSession(session.id).find((item) => item.toolId === toolId);
    if (!agent) return { status: 409, error: 'This agent is not running.' };
    const checked = checkMessageText(value);
    if (checked.error) return checked;
    // A retried send (same clientId) is acknowledged without sending it twice.
    const sent = clientId && session.messages.find((m) => m.role === 'user' && m.parentToolId === toolId && m.clientId === clientId);
    if (sent) return { messageId: sent.id };
    return steer(agent, { text: checked.text, from: 'user', clientId });
  }

  /** message_agent: the main model's message to a running worker. */
  function message(session, args) {
    const agent = ofSessionById(session, args?.id);
    if (!agent) return text(`Unknown worker id "${args?.id ?? ''}". Workers of this session: ${ofSession(session.id).map((item) => item.id).join(', ') || 'none'}.`, true);
    if (!acceptsMessages(agent)) return text(finishedText(agent), true);
    const checked = checkMessageText(args?.message);
    if (checked.error) return text(checked.error === 'This message is too long.' ? `The message is too long (at most ${MAX_MESSAGE_LENGTH} characters).` : 'Give the message some text.', true);
    const sent = steer(agent, { text: checked.text, from: 'lead' });
    if (sent.error) return text(finishedText(agent), true);
    return text(`Sent to ${agentName(agent.model)} ${agent.id}; it reads it at its next step.`);
  }

  /** stop_agent: halts a running worker and returns its partial report. */
  async function stopAgent(session, args, extra) {
    const agent = ofSessionById(session, args?.id);
    if (!agent) return text(`Unknown worker id "${args?.id ?? ''}". Workers of this session: ${ofSession(session.id).map((item) => item.id).join(', ') || 'none'}.`, true);
    if (!isRunning(agent)) return text(finishedText(agent), true);
    const reason = typeof args?.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    // One that is already winding down (committing its worktree) is only waited for.
    const halting = !agent.finishing && !agent.stopRequested;
    if (halting) {
      agent.stoppedBy = 'lead';
      if (reason) agent.stopReason = reason;
    }
    // Named by a waiter, so the report comes back here and not as a message of its own.
    const ended = awaitAgents(session.id, [agent.id], { ms: stopWaitMs, signal: extra?.signal });
    if (!agent.finishing) halt(agent);
    const { why } = await ended;
    if (why === 'aborted') {
      if (!isRunning(agent) && !agent.delivered) announce(agent);
      return text('Interrupted.', true);
    }
    if (isRunning(agent)) {
      return text(`Asked ${agentName(agent.model)} ${agent.id} to stop, but it has not finished after ${formatDuration(stopWaitMs)} (still ${agent.worktree ? 'committing its worktree' : 'shutting down'}). Its report arrives as a message when it ends.`);
    }
    if (agent.delivered) return text(`${agentName(agent.model)} ${agent.id} ${outcome(agent)}; its report was delivered earlier in the conversation.`);
    agent.delivered = true;
    return text(reportForModel(agent));
  }

  /** The latest tool call of a worker: its name and a short summary of what it was given. */
  function latestStep(agent) {
    const call = agent.lastCall;
    if (!call) return '';
    const input = call.input && typeof call.input === 'object' ? call.input : {};
    const key = STEP_KEYS.find((name) => typeof input[name] === 'string' && input[name].trim());
    const value = key ? input[key] : Object.values(input).find((item) => typeof item === 'string' && item.trim());
    const detail = value ? oneLine(value, MAX_STEP_CHARS) : '';
    return `${call.name}${detail ? ` \`${detail.replace(/`/g, "'")}\`` : ''}${agent.lastCallDone ? '' : ' (running now)'}`;
  }

  function describeAgent(agent) {
    const label = agent.description ? ` “${agent.description}”` : '';
    const state = isRunning(agent) ? 'running' : agent.state === 'done' ? 'finished' : agent.state;
    const lines = [`${agentName(agent.model)} ${agent.id}${label}: ${state} (${stats(agent)}).`];
    lines.push(`Latest step: ${latestStep(agent) || 'none yet'}`);
    if (agent.lastText.trim()) lines.push(`Last said: ${clip(agent.lastText.trim(), MAX_LAST_TEXT)}`);
    if (isRunning(agent) && agent.tasks.length) {
      const list = agent.tasks.slice(0, MAX_LISTED).map((task) => `${task.description || task.id}${task.type ? ` (${task.type})` : ''}`);
      lines.push(`${agent.idle && !agent.input.ended ? 'Between turns, waiting on' : 'Background tasks running'}: ${list.join('; ')}. Their events wake it; it finishes when a turn ends with none left (stop_agent ends it sooner).`);
    }
    if (isRunning(agent)) {
      const asks = (agent.session.pending || []).filter((entry) => entry.agent?.toolId === agent.toolId);
      for (const entry of asks.slice(0, MAX_LISTED)) lines.push(`Waiting for the user: ${pendingSummary(entry)}`);
      lines.push(`Messages it has not read yet: ${agent.outstanding.size}`);
    }
    else lines.push(agent.delivered ? 'Its report was delivered earlier in the conversation.' : 'Its report has not been collected yet: wait_agents returns it.');
    return lines.join('\n');
  }

  /** check_agents: where the workers are now. Read only; never waits and never collects a report. */
  function check(session, args) {
    const requested = Array.isArray(args?.ids) && args.ids.length ? [...new Set(args.ids.map(String))] : null;
    const list = requested
      ? requested.map((id) => ofSessionById(session, id)).filter(Boolean)
      : ofSession(session.id).filter((agent) => isRunning(agent) || !agent.delivered);
    const unknown = requested ? requested.filter((id) => !ofSessionById(session, id)) : [];
    const unknownLine = unknown.length ? `Unknown worker ids: ${unknown.join(', ')}.` : '';
    if (!list.length) return text([requested ? '' : 'No workers running, and every report has been delivered.', unknownLine].filter(Boolean).join('\n'), Boolean(requested));
    return text([...list.map(describeAgent), ...(unknownLine ? [unknownLine] : [])].join('\n\n---\n\n'));
  }

  /** The tool handlers for one session (what the MCP server calls; tests call them directly). */
  function tools(session) {
    return {
      delegate: (args, extra) => delegate(session, args, extra),
      wait_agents: (args, extra) => wait(session, args, extra),
      message_agent: (args) => message(session, args),
      stop_agent: (args, extra) => stopAgent(session, args, extra),
      check_agents: (args) => check(session, args),
    };
  }

  /**
   * The AGENT_SERVER MCP server for one session's Claude Code process; `webSearch` adds
   * `web_search` (gateway routes, whose built-in WebSearch does not work).
   */
  function server(session, { webSearch: withSearch = false } = {}) {
    const ids = MODELS.map((model) => model.id);
    const handlers = tools(session);
    return createSdkMcpServer({
      name: AGENT_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      timeout: MCP_TIMEOUT_MS,
      tools: [
        tool(
          'delegate',
          delegateDescription(),
          {
            model: z.enum(ids).describe('Catalog id of the model that runs the worker'),
            task: z.string().describe('Self-contained instructions: goal, scope (files or directories it owns), constraints, how to verify, what to report'),
            description: z.string().optional().describe('A 3-6 word label shown to the user'),
            effort: z.enum(EFFORTS).optional().describe("Reasoning effort; omit for the model's default"),
            isolation: z.enum(['worktree']).optional().describe('worktree: run on its own git branch and worktree (git repositories only)'),
          },
          handlers.delegate,
        ),
        tool(
          'wait_agents',
          WAIT_DESCRIPTION,
          {
            ids: z.array(z.string()).optional().describe('Worker ids from delegate; omit for every worker whose report you have not received'),
            mode: z.enum(['all', 'any']).optional().describe('all (default): when every one is done; any: when the first one is'),
            timeout_seconds: z.number().optional().describe(`Give up after this many seconds (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS})`),
          },
          handlers.wait_agents,
          // Only waits: Claude Code may run it alongside other tool calls.
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          'message_agent',
          MESSAGE_DESCRIPTION,
          {
            id: z.string().describe('Worker id from delegate'),
            message: z.string().describe('What to tell the worker; it reads it at its next step'),
          },
          handlers.message_agent,
          // Returns at once and changes nothing of the lead's own: no need to run alone.
          { annotations: { readOnlyHint: true } },
        ),
        tool(
          'stop_agent',
          STOP_DESCRIPTION,
          {
            id: z.string().describe('Worker id from delegate'),
            reason: z.string().optional().describe('Why it is stopped; recorded on its card and in its report'),
          },
          handlers.stop_agent,
        ),
        tool(
          'check_agents',
          CHECK_DESCRIPTION,
          {
            ids: z.array(z.string()).optional().describe('Worker ids from delegate; omit for every worker running or not reported yet'),
          },
          handlers.check_agents,
          { annotations: { readOnlyHint: true } },
        ),
        ...(withSearch && webSearch ? [webSearch.tool()] : []),
      ],
    });
  }

  function halt(agent, { silent = false } = {}) {
    if (!isRunning(agent)) return;
    agent.stopRequested = true;
    if (silent) agent.silent = true;
    // Kills the worker's process (its transcript so far is saved); its pending approvals are withdrawn.
    agent.abort.abort();
  }

  /** Stops one worker by its card; the session and the other workers carry on. */
  function stop(session, toolId) {
    const agent = ofSession(session.id).find((item) => item.toolId === toolId);
    if (!agent) return { status: 404, error: 'Agent not found' };
    if (!isRunning(agent)) return { status: 409, error: 'This agent is not running.' };
    halt(agent);
    return true;
  }

  /** Stops every worker of a session without reporting to the main model (Stop, removal). */
  function stopAll(session) {
    for (const agent of ofSession(session.id)) halt(agent, { silent: true });
  }

  /** The session's permission mode changed: running workers follow it. */
  function applyMode(session) {
    for (const agent of ofSession(session.id).filter(isRunning)) {
      agent.stream?.setPermissionMode(turnMode(agent.model, session.mode)).catch((error) => log(`Could not switch ${agent.id} to ${session.mode}: ${error.message}`));
    }
  }

  /** The user sent a message mid-turn: a wait_agents call returns so the main model reads it. */
  function wake(sessionId) {
    for (const waiter of [...waiters]) if (waiter.sessionId === sessionId) waiter.finish('woken');
  }

  function shutdown() {
    shuttingDown = true;
    for (const agent of agents.values()) halt(agent, { silent: true });
  }

  return {
    server,
    tools,
    running,
    liveTools,
    stop,
    stopAll,
    messageCard,
    applyMode,
    wake,
    shutdown,
    detachAll,
    reattach,
    saveMeta,
    /** Every worker of a session (tests and diagnostics). */
    list: ofSession,
  };
}
