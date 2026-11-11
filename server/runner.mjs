// Turn execution: the per-session message queue, one long-lived Claude Code process per
// active session (cli-pool.mjs), messages sent mid-turn (steering), and tool approvals.
// Knows nothing about HTTP; state changes go out through events.
//
// A session's process takes every turn: the first message starts it (resuming the saved
// conversation, forking an imported one, or starting fresh with an imported Codex
// history), later messages are written to its input. Model, effort and mode changes are
// applied in place; a change between Claude and gateway routes, revoked grants, or an
// import that has to start over restart it (resuming). A turn ends at its `result`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  allowedBySession,
  bypassAnswer,
  applyApprovalToSession,
  decideApproval,
  parseApprovalChoice,
  pendingEntry,
  QUESTION_TIMEOUT_MESSAGE,
  QUESTION_TIMEOUT_MS,
  sessionPermissionSettings,
} from './approvals.mjs';
import { createCliPool, sessionKey } from './cli-pool.mjs';
import { createTitler } from './titles.mjs';
import { isRemote, sessionCluster } from './clusters.mjs';
import { AGENT_SERVER, DELEGATE_TOOL, MODEL_AGENT_TOOLS, createModelAgents, localMachine, remoteMachine } from './model-agents.mjs';
import { CLI_CLOSE_GRACE_MS, DEFAULT_GATEWAY, GATEWAY_PLACEHOLDER_KEY, STOP_GRACE_MS, parseSettingSources } from './config.mjs';
import { disabledServers, mcpDenyRules } from './mcp-status.mjs';
import {
  compactThreshold,
  contextSettings,
  findModel,
  modelSwitchNote,
  resolveEffort,
  runsDirect,
  sdkEnv,
  sdkModelId,
  systemPromptAppend,
  TODO_TOOL_ENV,
  turnMode,
} from './models.mjs';
import { addMessage, addNotice, lostWakeupsNotice, settleOrphanedTools } from './store.mjs';
import { cronsFromTranscript, liveCrons, setCrons, setLiveTasks, settleTasks } from './tasks.mjs';
import { NOTICES, applySdkMessage, requestingAgent, setPlan } from './transcript.mjs';
import { createRemoteClaude } from './remote-claude.mjs';
import { remoteSpawn, remoteUploadDir } from './remote-spawn.mjs';
import { shQuote } from './remote-command.mjs';
import { runSsh } from './ssh.mjs';
import { attachmentContent, isUploadScope } from './uploads.mjs';
import { createWebSearch } from './web-search.mjs';

export { NOTICES, applySdkMessage };

// Stored session mode -> SDK permissionMode.
const SDK_PERMISSION_MODES = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
};

const AGENT_TOOLS = new Set(['Agent', 'Task']);

const RELAY_PROBE_MS = 15_000;

// How long a new chat's prepared process waits for its first message.
const PREPARED_TTL_MS = 10 * 60_000;

// Slash commands that change the process's model or effort behind the runner's back:
// the next turn applies the session's own values again.
const RESETTING_COMMANDS = /^\/(model|effort|config|fast)\b/;

export function permissionModeFor(mode) {
  return SDK_PERMISSION_MODES[mode] ?? 'default';
}

/**
 * The SDK options that start a session's Claude Code process.
 * @param {object} session  needs `mode`, `cwd` and optionally `sdkSessionId` or `forkFrom`
 *   (an imported Claude Code session not yet continued: the process forks it, so the
 *   original transcript is never written), `mcpDisabled` (MCP servers switched off)
 * @param {object} turn
 * @param {object} turn.model  catalog entry
 * @param {{url: string, apiKey: string, claudeRelay?: string}} [turn.gateway]  where non-Claude
 *   routes go; `claudeRelay`: where Claude routes go (the gateway's Claude relay), when it is up
 * @param {string[]} [turn.settingSources]  Claude Code settings files to load
 * @param {string} [turn.claudeConfigDir]  replaces ~/.claude (test isolation)
 * @param {boolean} [turn.fresh]  start a new conversation instead of resuming (a turn that
 *   carries an imported Codex session's history)
 * @param {boolean} [turn.mcpDeny]  put the session's switched-off MCP servers in the start
 *   settings (default). A long-lived process turns them off after it started instead
 *   (startCli): a tool denied at start is gone for good, one denied later can come back.
 */
export function buildQueryOptions(
  session,
  {
    model,
    effort,
    claudeExecutable,
    gateway = { url: DEFAULT_GATEWAY, apiKey: GATEWAY_PLACEHOLDER_KEY },
    settingSources = parseSettingSources(),
    claudeConfigDir,
    abortController,
    canUseTool,
    fresh = false,
    mcpDeny = true,
  },
) {
  const direct = runsDirect(model);
  // The TodoWrite switch also goes in flag settings: a user settings `env` could otherwise
  // turn the TaskCreate family back on, which the Tasks strip does not track.
  const context = contextSettings(model);
  const settings = { effortLevel: effort, remoteControlAtStartup: false, env: { ...TODO_TOOL_ENV, ...context.env } };
  if (context.autoCompactWindow) settings.autoCompactWindow = context.autoCompactWindow;
  // "Allow always" grants live on the session, so a restarted process keeps them.
  const permissions = sessionPermissionSettings(session);
  if (permissions) settings.permissions = permissions;
  // MCP servers the user switched off for this session: their tools are denied from the
  // first request on, whenever the server finishes connecting (see mcp-status.mjs).
  const denied = mcpDeny ? mcpDenyRules(disabledServers(session)) : [];
  if (denied.length) settings.permissions = { ...settings.permissions, deny: denied };

  const options = {
    effort,
    cwd: session.cwd,
    model: sdkModelId(model),
    pathToClaudeCodeExecutable: claudeExecutable,
    env: sdkEnv(direct, { gatewayUrl: gateway.url, apiKey: gateway.apiKey, claudeConfigDir, claudeRelay: gateway.claudeRelay }),
    permissionMode: permissionModeFor(turnMode(model, session.mode)),
    // Always allowed so a live switch into bypass mode works mid-turn.
    allowDangerouslySkipPermissions: true,
    permissionPrompts: 'host',
    settingSources: [...settingSources],
    settings,
    // Recorded with the session's first turn and replayed verbatim on every resume, so the
    // prompt-cache prefix and earlier thinking survive a restarted process (whose fresh
    // render could differ). A later model switch is announced by turnPrompt().
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend(model), snapshot: true },
    includePartialMessages: true,
    persistSession: true,
    // Claude Code echoes each user message (with our uuid) when it takes it: that is
    // when a message sent mid-turn is shown as delivered.
    extraArgs: { 'replay-user-messages': null },
    // Backups of the files Claude edits, so a rewind can put them back (fork.mjs rewind).
    enableFileCheckpointing: true,
    abortController,
    canUseTool,
  };
  if (direct) options.thinking = { type: 'adaptive', display: 'summarized' };
  // Its server-side search is dropped by the gateway, so the model would make results up:
  // gateway routes search with Harbor's web_search instead (web-search.mjs).
  else options.disallowedTools = ['WebSearch'];
  if (session.forkFrom) {
    options.resume = session.forkFrom;
    options.forkSession = true;
  } else if (session.sdkSessionId && !fresh) {
    options.resume = session.sdkSessionId;
    // Rewound: the next turn branches off before the messages the rewind cut.
    if (session.resumeAt) options.resumeSessionAt = session.resumeAt;
  }
  return options;
}

/** The catalog id of the model that ran the session's previous turn, if known. */
function previousTurnModel(session) {
  if (session.lastTurnModel) return session.lastTurnModel;
  // Sessions from before lastTurnModel existed: the newest reply records its model.
  return session.messages.findLast((m) => (m.role === 'assistant' || m.role === 'turn') && m.model)?.model;
}

/** True for an SDK message showing the model answered: a reply or a successful result. */
function answered(message) {
  if (message.type === 'assistant') return !message.parent_tool_use_id && !message.error;
  return message.type === 'result' && !message.is_error;
}

/** True for the start of work on the main thread (not a subagent's). */
function mainThreadWork(message) {
  return (message.type === 'stream_event' || message.type === 'assistant') && !message.parent_tool_use_id;
}

/** Claude Code runs a string prompt starting with `/name` as a slash command. */
/** A session's goal from Claude Code's active_goal value; null when there is none. */
export function goalOf(value) {
  if (!value || typeof value.condition !== 'string' || !value.condition.trim()) return null;
  const goal = { condition: value.condition, iterations: Number(value.iterations) || 0, setAt: Number(value.set_at) || Date.now() };
  if (typeof value.last_reason === 'string' && value.last_reason) goal.lastReason = value.last_reason;
  return goal;
}

/** The condition of a "Goal set: …" reply to /goal, or null. */
export function goalSetText(message) {
  const content = message.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text).join('') : '';
  const match = /^Goal set:\s*([^]+)$/.exec(text.trim());
  return match ? match[1].trim() : null;
}

export function isSlashCommand(content) {
  return typeof content === 'string' && /^\/[^\s/]/.test(content);
}

/**
 * True when this turn carries an imported Codex session's history: the session still has
 * its handoff and the message is not a slash command (which must be sent bare).
 */
export function carriesHandoff(session, content) {
  return Boolean(session.handoff) && !isSlashCommand(content);
}

function prepend(note, content) {
  if (typeof content === 'string') return `${note}\n\n${content}`;
  return [{ type: 'text', text: note }, ...content];
}

/**
 * What a turn sends to Claude Code as the user's message: the stored text (or content
 * blocks, when the message has attachments) with a model-switch note in front when a
 * resumed conversation continues on a different model than its previous turn, and an
 * imported Codex session's history in front of the first turn. Both go to the model
 * only; the transcript keeps the user's own text.
 * @param {object} session  needs `messages`, optionally `sdkSessionId`, `forkFrom`,
 *   `lastTurnModel` and `handoff`
 * @param {object} model  catalog entry this turn runs on
 * @param {string | object[]} content  message text, or Anthropic content blocks
 */
export function turnPrompt(session, model, content) {
  // Anything in front of a slash command would turn it into plain text; the switch note
  // and the handoff wait for the next ordinary turn (lastTurnModel is left alone).
  if (isSlashCommand(content)) return content;
  // A turn with the Codex history starts a new conversation: nothing to switch from.
  if (carriesHandoff(session, content)) return prepend(session.handoff, content);
  const resumed = session.sdkSessionId || session.forkFrom;
  const previous = resumed ? previousTurnModel(session) : undefined;
  if (!previous || previous === model.id) return content;
  return prepend(modelSwitchNote(model, previous), content);
}

/**
 * Running background subagents and everything nested under them keep running, as do
 * working model agents (`live`: their tool_use ids), wherever their card is.
 */
function backgroundWork(session, live = new Set(), { subagents = true } = {}) {
  const keep = new Set();
  for (const message of session.messages) {
    if (message.role !== 'tool' || message.state !== 'running') continue;
    const root = live.has(message.toolId) || (subagents && message.background && !message.parentToolId);
    if (root || keep.has(message.parentToolId)) keep.add(message.toolId);
  }
  return (message) => keep.has(message.toolId);
}

/**
 * @param {object} deps
 * @param {{claudeExecutable: string, gatewayUrl: string, settingSources?: string[], claudeConfigDir?: string,
 *   cliIdleMs?: number, cliMaxProcesses?: number}} deps.config
 * @param {{flush: Function, schedule: Function, scheduleLive?: Function}} deps.events  publishing (which also saves)
 * @param {{url: string, apiKey: string}} [deps.gateway]  endpoint for non-Claude routes
 *   (the normalizing proxy); defaults to the configured gateway itself
 * @param {Function} [deps.query]  the SDK query function (replaceable in tests)
 * @param {number} [deps.stopGraceMs]  how long stop waits for interrupt() before killing
 * @param {number} [deps.idleMs]  close a session's process after this long unused
 * @param {number} [deps.maxProcesses]  live processes kept at most (idle ones close first)
 * @param {number} [deps.closeGraceMs]  how long a graceful close may take before the kill
 * @param {boolean} [deps.claudeRelay]  send Claude routes through the gateway's Claude relay
 *   while it answers (default; WORKBENCH_CLAUDE_RELAY=0 turns it off). The relay is
 *   probed at config.relayStatusPath on the gateway; without that path there is none.
 * @param {object} [deps.clusters]  from createClusters(): sessions on another cluster run
 *   their processes there over ssh (remote-spawn.mjs); without it every session runs here
 * @param {Function} [deps.ssh]  runSsh (replaceable in tests)
 */
export function createRunner({
  config,
  events,
  gateway = { url: config.gatewayUrl, apiKey: config.gatewayKey || GATEWAY_PLACEHOLDER_KEY },
  query = sdkQuery,
  uploads = null,
  stopGraceMs = STOP_GRACE_MS,
  questionTimeoutMs = QUESTION_TIMEOUT_MS,
  idleMs = config.cliIdleMs,
  maxProcesses = config.cliMaxProcesses,
  closeGraceMs = CLI_CLOSE_GRACE_MS,
  claudeRelay = config.claudeRelay !== false,
  hostSocket = config.cliHostSocket ?? null,
  clusters = null,
  ssh = runSsh,
  log = console.error,
}) {
  // session id -> the turn in progress:
  //   kind       'user' (started by a message) or 'agent' (Claude Code's own: a
  //              background task finished)
  //   cli        the process it runs in, once its message was sent (`ready`)
  //   model, effort   catalog entry and effort it runs with
  //   mainId     the message that started it; messageIds: every message taken into it
  //   started    Claude Code has taken the message (or begun its own turn)
  //   held       messages sent mid-turn before the process was ready
  const runs = new Map();

  // Claude routes go through the gateway's Claude relay (it switches Claude accounts when
  // one is out of its allowance) while it answers, else direct. Checked every
  // RELAY_PROBE_MS at the gateway's relay status path; a process keeps the route it
  // started with. The relay is the gateway's own (config.gatewayUrl), not the tool-input
  // proxy that `gateway` may be. Processes wait for the first check, so none started at
  // boot goes direct. Without a status path there is no relay.
  let relayUp = false;
  const upstreamUrl = (config.gatewayUrl || gateway.url).replace(/\/$/, '');
  const statusPath = config.relayStatusPath || null;
  const relayUrl = claudeRelay && statusPath ? upstreamUrl + '/claude-relay' : null;
  async function probeRelay() {
    try {
      const response = await fetch(upstreamUrl + statusPath, { signal: AbortSignal.timeout(1000) });
      const next = response.ok;
      if (next !== relayUp) log(next ? 'Claude routes go through the gateway Claude relay.' : 'The gateway Claude relay is not answering; Claude routes go direct.');
      relayUp = next;
    } catch {
      if (relayUp) log('The gateway Claude relay is not answering; Claude routes go direct.');
      relayUp = false;
    }
  }
  const relayTimer = relayUrl ? setInterval(probeRelay, RELAY_PROBE_MS) : null;
  relayTimer?.unref?.();
  const firstProbe = relayUrl ? probeRelay() : Promise.resolve();
  const routes = () => (relayUp && relayUrl ? { ...gateway, claudeRelay: relayUrl } : gateway);

  // Chat titles from Haiku (titles.mjs); only with the real SDK, so tests' fake processes
  // see the turns they script and nothing else.
  const titler =
    query === sdkQuery
      ? createTitler({
          query,
          claudeExecutable: config.claudeExecutable,
          env: () => {
            const r = routes();
            return sdkEnv(true, { gatewayUrl: r.url, apiKey: r.apiKey, claudeConfigDir: config.claudeConfigDir, claudeRelay: r.claudeRelay });
          },
          log,
        })
      : null;
  let titling = 0;
  const titleWaiting = [];

  /** The chat's first user message and its first answer, or null before there is an answer. */
  function firstExchange(session) {
    const first = session.messages.find((m) => m.role === 'user' && !m.parentToolId && typeof m.text === 'string' && m.text.trim());
    const reply = first && session.messages.find((m) => m.role === 'assistant' && !m.parentToolId && m.text?.trim() && m.at >= (first.at || 0));
    return first && reply ? { first: first.text, reply: reply.text } : null;
  }

  /** Has Haiku name the chat once, unless the user named it; two at a time. */
  function autoTitle(session) {
    if (!titler || session.titled || session.titleAuto === false || session.removed) return;
    const exchange = firstExchange(session);
    if (!exchange) return;
    session.titled = true;
    const run = async () => {
      titling += 1;
      try {
        const title = await titler(exchange.first, exchange.reply);
        if (title && session.titleAuto !== false && !session.removed) {
          session.title = title;
          flush(session);
        }
      } finally {
        titling -= 1;
        titleWaiting.shift()?.();
      }
    };
    if (titling < 2) void run();
    else titleWaiting.push(() => void run());
  }

  /**
   * Chats from before titles came from Haiku, still named by the start of their first
   * message, get a title once (at server start).
   */
  function backfillTitles(sessions) {
    for (const session of sessions) {
      if (session.titled || session.titleAuto === false || session.removed) continue;
      const exchange = firstExchange(session);
      const prefix = exchange?.first.replace(/\s+/g, ' ').slice(0, 70);
      if (prefix && session.title === prefix) {
        session.titleAuto = true;
        autoTitle(session);
      }
    }
  }

  // Sessions on another cluster: this machine's Claude Code is copied there once, and each
  // process runs over ssh with its gateway traffic tunnelled back (remote-spawn.mjs).
  const remoteClaude = clusters ? createRemoteClaude({ executable: config.claudeExecutable, home: clusters.home, ssh, log }) : null;
  const remoteHomes = new Map(); // cluster id -> home, once known
  function sessionHost(session) {
    if (!isRemote(session)) return null;
    const cluster = clusters?.find(sessionCluster(session));
    if (!cluster?.host) throw new Error(`This session runs on cluster "${sessionCluster(session)}", which Harbor does not know.`);
    return cluster;
  }
  /** Learns a remote session's home before its options are built (uploads live there). */
  async function knowHome(session) {
    const cluster = sessionHost(session);
    if (cluster && !remoteHomes.has(cluster.id)) remoteHomes.set(cluster.id, await clusters.home(cluster));
    return cluster;
  }
  /**
   * The git and folders a session's worktree is made with: here for a local session, on
   * its cluster (its home) for a remote one.
   */
  async function machineFor(session) {
    const cluster = sessionHost(session);
    if (!cluster) return localMachine;
    const home = await clusters.home(cluster);
    return remoteMachine(cluster.host, { ssh, worktreesDir: path.posix.join(home, '.local/share/harbor/worktrees') });
  }
  /**
   * A new remote session: its cluster gets this machine's Claude Code now, so the first
   * message does not wait for the copy. Never rejects.
   */
  function readyCluster(session) {
    try {
      const cluster = sessionHost(session);
      if (cluster) remoteClaude.ensure(cluster).catch((error) => log(`Could not copy Claude Code to ${cluster.label}: ${error.message}`));
    } catch (error) {
      log(error.message);
    }
  }

  /** The CLI host spawn hook of a remote session's process (`key`), or null for a local one. */
  function remotePrepare(session, key) {
    const cluster = sessionHost(session);
    if (!cluster) return null;
    return async (options) => {
      const remotePath = await remoteClaude.ensure(cluster);
      return remoteSpawn(options, {
        cluster,
        key,
        remoteClaude: remotePath,
        proxyPort: Number(new URL(gateway.url).port),
        gatewayUrl: gateway.url,
        relayUrl,
        secret: gateway.apiKey,
      });
    };
  }
  const approvals = new Map(); // approval id -> { session, target, entry, finish }
  let shuttingDown = false;
  const { flush, schedule } = events;
  const tick = events.scheduleLive ?? (() => {});

  const pool = createCliPool({
    query,
    isBusy,
    idleMs,
    maxProcesses,
    closeGraceMs,
    hostSocket,
    log,
  });

  // Parallel workers on any model (model-agents.mjs): separate short-lived Claude Code
  // processes, outside the pool, started through the session's Harbor MCP tools.
  // Real web search for gateway routes (web-search.mjs), on the Claude login.
  const webSearch = createWebSearch({ query, claudeExecutable: config.claudeExecutable, claudeConfigDir: config.claudeConfigDir, log });

  const modelAgents = createModelAgents({
    query,
    webSearch,
    queryOptions: workerOptions,
    approvals: (session, agent, signal) => approvalHandler(session, { agent, signal }),
    deliver: deliverAgentReport,
    flush,
    schedule,
    worktreesDir: config.worktreesDir ?? path.join(config.dataDir ?? os.tmpdir(), 'worktrees'),
    maxRunning: config.modelAgentsMax,
    hostSocket,
    spawnPrepare: remotePrepare,
    beforeStart: knowHome,
    machineFor,
    log,
  });

  /** A session's process must stay up while it has work: see cli-pool.mjs. */
  function isBusy(sessionId, cli) {
    if (runs.has(sessionId)) return true;
    // Workers report back to it when they end.
    if (modelAgents.running(sessionId) > 0) return true;
    if (cli && (cli.outstanding.size > 0 || cli.backgroundTasks > 0)) return true;
    // Scheduled jobs only fire while the process is up.
    if (cli?.session && liveCrons(cli.session).length > 0) return true;
    // An MCP call is waiting on this process (mcp.mjs holding), or a sign-in under way keeps
    // its OAuth state in it (see mcpSignIn).
    if (cli && (cli.holds > 0 || cli.signInUntil > Date.now())) return true;
    return [...approvals.values()].some((approval) => approval.session === sessionId);
  }

  function isRunning(sessionId) {
    return runs.has(sessionId);
  }

  function findMessage(session, id) {
    return session.messages.find((m) => m.id === id);
  }

  /** Moves a message to the end, so the transcript reads in the order Claude saw it. */
  function moveToEnd(session, message) {
    session.messages.splice(session.messages.indexOf(message), 1);
    session.messages.push(message);
  }

  function beginRun(session, fields) {
    const run = { kind: 'user', session, started: false, ready: false, stopping: false, messageIds: new Set(), held: [], ...fields };
    runs.set(session.id, run);
    session.status = session.pending?.length ? 'waiting' : 'running';
    session.live = '';
    session.liveThinking = '';
    return run;
  }

  /** Starts the next queued message when the session is free. */
  function drain(session) {
    if (shuttingDown || runs.has(session.id) || session.queuePaused || !session.queue?.length) return;
    const item = session.queue.shift();
    session.currentMessageId = item.id;
    const message = findMessage(session, item.id);
    if (message) {
      message.delivery = 'running';
      message.startedAt = Date.now();
      moveToEnd(session, message);
    }
    // runTurn publishes (and so saves) the new state before its first await.
    void runTurn(session, item);
  }

  function setTitle(session, text, attachments) {
    const titleText = text || attachments?.[0]?.name || '';
    if (session.title === 'New session' && titleText) {
      session.title = titleText.replace(/\s+/g, ' ').slice(0, 70);
      session.titleAuto = true; // Haiku renames it after the first answer (autoTitle)
    }
  }

  /**
   * A message from the user. While a turn runs, a message (not a slash command, not
   * explicitly queued; attachments go along as content blocks) goes to Claude Code at once
   * and is read at its next step ("steering"); anything else waits for the turn to end.
   * Returns `{queued}` (waiting behind something) and `steering` (sent mid-turn).
   * `hold`: queued without resuming a paused queue (a worker's report after a Stop).
   */
  function enqueue(session, { text, clientId, attachments, queue = false, hold = false }) {
    if (!hold) {
      delete session.stopRequested;
      delete session.restartRecovery;
    }
    session.queue ??= [];
    session.steering ??= [];
    setTitle(session, text, attachments);
    const run = runs.get(session.id);
    const steer = run && !run.stopping && !shuttingDown && !queue && !isSlashCommand(text);
    if (steer && (!run.ready || !run.cli.closing)) {
      const message = addMessage(session, 'user', text, { clientId, delivery: 'sent', ...(attachments?.length ? { attachments } : {}) });
      session.steering.push({ id: message.id, text });
      // A main model waiting for its workers stops waiting so it can read this.
      modelAgents.wake(session.id);
      if (run.ready) sendSteering(session, run.cli, message.id);
      else run.held.push(message.id);
      flush(session);
      return { queued: false, steering: true };
    }
    // Attachments are public Attachment objects (see uploads.mjs); their files are
    // looked up again by id when the turn runs.
    const files = attachments?.length ? { attachments } : {};
    const message = addMessage(session, 'user', text, { clientId, delivery: 'queued', ...files });
    session.queue.push({ id: message.id, text, ...files });
    if (!hold) session.queuePaused = false;
    flush(session);
    drain(session);
    return { queued: session.queue.some((item) => item.id === message.id) };
  }

  /** Writes a user message to the process; `taken()` runs when Claude Code picks it up. */
  function send(cli, messageId, content, priority) {
    const uuid = crypto.randomUUID();
    cli.outstanding.set(uuid, messageId);
    try {
      cli.send(content, { uuid, priority });
    } catch (error) {
      cli.outstanding.delete(uuid);
      throw error;
    }
    return uuid;
  }

  /**
   * Sends a mid-turn message: its text, or content blocks when it has attachments (built
   * off the event loop, so the sends of one run are chained to keep their order).
   */
  function sendSteering(session, cli, messageId) {
    const message = findMessage(session, messageId);
    if (!message) return;
    const run = runs.get(session.id);
    const write = (content) => {
      try {
        send(cli, messageId, content, 'next');
      } catch (error) {
        log(`Could not send a message to session ${session.id}'s Claude Code process: ${error.message}`);
        requeue(session, messageId);
      }
    };
    if (!message.attachments?.length) {
      if (run?.steerChain) run.steerChain = run.steerChain.then(() => write(message.text));
      else write(message.text);
      return;
    }
    const model = run?.model ?? findModel(cli.catalogId);
    const content = messageContent(session, model, message.text, message.attachments);
    const chain = (run?.steerChain ?? Promise.resolve()).then(() => content).then(write, (error) => {
      log(`Could not attach files to a message in session ${session.id}: ${error.message}`);
      requeue(session, messageId);
    });
    if (run) run.steerChain = chain;
  }

  /** A message sent mid-turn that never reached Claude goes back to the front of the queue. */
  function requeue(session, messageId) {
    session.steering = (session.steering || []).filter((item) => item.id !== messageId);
    const message = findMessage(session, messageId);
    if (!message) return;
    session.queue ??= [];
    if (session.queue.some((item) => item.id === messageId)) return;
    message.delivery = 'queued';
    session.queue.unshift({ id: messageId, text: message.text, ...(message.attachments ? { attachments: message.attachments } : {}) });
    // Never sent on its own: a stop paused everything, and a crash wants a look first.
    session.queuePaused = true;
  }

  /**
   * Removes a message that Claude has not read yet: a queued one, or one sent mid-turn
   * (Claude Code is asked to drop it). Resolves false when it is too late.
   */
  async function cancelQueued(session, messageId) {
    const index = (session.queue || []).findIndex((item) => item.id === messageId);
    if (index >= 0) {
      session.queue.splice(index, 1);
      const message = findMessage(session, messageId);
      if (message) message.delivery = 'cancelled';
      flush(session);
      return true;
    }
    if (!session.steering?.some((item) => item.id === messageId)) return false;
    const run = runs.get(session.id);
    if (run?.held.includes(messageId)) {
      run.held = run.held.filter((id) => id !== messageId);
      markCancelled(session, messageId);
      return true;
    }
    const cli = run?.cli ?? pool.get(session.id);
    const uuid = [...(cli?.outstanding ?? [])].find(([, id]) => id === messageId)?.[0];
    if (!uuid) return false;
    cli.cancelled.add(uuid);
    let cancelled = false;
    try {
      cancelled = await cli.stream.cancelAsyncMessage(uuid);
    } catch (error) {
      log(`Could not cancel a message for session ${session.id}: ${error.message}`);
    }
    if (!cancelled) {
      cli.cancelled.delete(uuid);
      return false;
    }
    cli.outstanding.delete(uuid);
    markCancelled(session, messageId);
    return true;
  }

  function markCancelled(session, messageId) {
    session.steering = (session.steering || []).filter((item) => item.id !== messageId);
    const message = findMessage(session, messageId);
    if (message && message.delivery === 'sent') message.delivery = 'cancelled';
    flush(session);
  }

  /** `mainOnly`: leave the approvals a worker or subagent is waiting on (`entry.agent`). */
  function denyApprovals(sessionId, decision, { mainOnly = false } = {}) {
    for (const approval of [...approvals.values()]) {
      if (approval.session === sessionId && !(mainOnly && approval.entry.agent)) approval.finish(decision);
    }
  }

  /**
   * Stops the main agent's turn: its pending approvals are denied, and Claude Code is asked
   * to interrupt it and drop every message it has not read yet (they go back to the paused
   * queue). The process is killed if the turn has not ended after the grace period, or
   * on a second stop; the next turn then starts a new one. The queue stays paused until
   * the user resumes it. Workers and background subagents carry on (each card has its own
   * stop); a report that comes in meanwhile waits in the paused queue.
   */
  function stop(session) {
    session.stopRequested = true;
    delete session.restartRecovery;
    session.queuePaused = true;
    const run = runs.get(session.id);
    if (!run) {
      // Nothing running in the foreground: a waiting subagent keeps its question.
    } else if (run.stopping) {
      if (run.ready) void pool.kill(session.id, 'stop');
    } else {
      run.stopping = true;
      if (run.cli) run.cli.interrupting = false;
      denyApprovals(session.id, { behavior: 'deny', message: 'Session stopped', interrupt: true }, { mainOnly: true });
      for (const id of run.held) requeue(session, id);
      run.held = [];
      // Not ready yet: runTurn sees `stopping` before it sends anything.
      if (run.ready) {
        const { cli } = run;
        cli.stream
          .interrupt({ cancelQueued: true })
          .then((receipt) => {
            for (const uuid of receipt?.cancelled ?? []) untaken(session, cli, uuid);
          })
          .catch((error) => {
            log(`Interrupt failed for session ${session.id}: ${error.message}`);
            if (runs.get(session.id) === run) void pool.kill(session.id, 'stop');
          });
        run.stopTimer = setTimeout(() => {
          if (runs.get(session.id) === run) void pool.kill(session.id, 'stop');
        }, stopGraceMs);
        run.stopTimer.unref?.();
      }
    }
    flush(session);
  }

  /**
   * "Interrupt and send now": ends the step Claude is on (a long tool call, say) so the
   * messages sent mid-turn run at once, in the same process. Unlike a stop, a plain
   * interrupt leaves those messages queued in Claude Code (they start its next turn),
   * background tasks keep running, and the session neither errors nor pauses its queue.
   * Messages Claude Code drops anyway are sent again (see resendDropped).
   */
  async function interrupt(session) {
    const run = runs.get(session.id);
    if (!run || run.stopping || shuttingDown) return { status: 409, error: 'Claude is not working on anything.' };
    if (!session.steering?.length) return { status: 409, error: 'No messages are waiting for Claude.' };
    // Still starting, or between turns: the messages go in next anyway.
    if (!run.ready || !run.started || run.interrupting) return true;
    const { cli } = run;
    run.interrupting = true;
    cli.interrupting = true;
    // Only these can have been dropped; anything sent later is not this interrupt's.
    run.waiting = new Set(cli.outstanding.keys());
    run.receipt = cli.stream.interrupt();
    try {
      await run.receipt;
      return true;
    } catch (error) {
      log(`Interrupt failed for session ${session.id}: ${error.message}`);
      if (runs.get(session.id) === run) run.interrupting = false;
      cli.interrupting = false;
      return { status: 502, error: 'Claude Code could not be interrupted. Your messages are still waiting.' };
    }
  }

  /**
   * After an interrupt: messages Claude Code was holding but did not keep (missing from
   * the receipt's `still_queued`) are sent again so they run now. Without a receipt (an
   * older CLI) nothing is known to be lost.
   */
  function resendDropped(session, cli, receipt, waiting) {
    Promise.resolve(receipt).then(
      (value) => {
        const kept = value?.still_queued;
        if (!Array.isArray(kept)) return;
        for (const uuid of waiting ?? []) {
          if (kept.includes(uuid) || cli.cancelled.has(uuid) || !cli.outstanding.has(uuid)) continue;
          const messageId = cli.outstanding.get(uuid);
          cli.outstanding.delete(uuid);
          resendNow(session, cli, messageId);
        }
      },
      () => {},
    );
  }

  /** Sends a message Claude Code dropped during an interrupt again, to run right away. */
  function resendNow(session, cli, messageId) {
    const message = findMessage(session, messageId);
    if (!message) return;
    try {
      if (cli.exited || cli.closing) throw new Error('The Claude Code process is closing.');
      send(cli, messageId, message.text);
    } catch {
      // No process to take it: first in the queue, which is not paused (no stop asked for it).
      requeue(session, messageId);
      session.queuePaused = false;
      queueMicrotask(() => drain(session));
    }
    flush(session);
  }

  /** Applies the session's (possibly changed) mode to its live process, if any. */
  function applyMode(session) {
    const cli = pool.get(session.id);
    const model = runs.get(session.id)?.model ?? findModel(cli?.catalogId);
    if (!cli || !model) return;
    const mode = permissionModeFor(turnMode(model, session.mode));
    cli.mode = mode;
    cli.stream.setPermissionMode(mode).catch((error) => log(`Could not switch session ${session.id} to ${mode}: ${error.message}`));
  }

  /**
   * Marks the session's live process stale: it restarts (resuming the conversation) as
   * soon as the session is not busy, since a live process reads Claude Code's settings
   * files, CLAUDE.md and memory only at start and cannot forget granted rules. Returns
   * whether there was a process to mark.
   */
  function markStale(session) {
    const cli = pool.get(session.id);
    if (!cli) return false;
    cli.stale = true;
    if (!isBusy(session.id, cli)) void pool.close(session.id, 'restart');
    return true;
  }

  /**
   * After a settings change: revoked "allow always" grants need a new process (a live one
   * cannot forget them), so it restarts once the session is not busy; a removed or
   * archived session's process closes.
   */
  function sessionChanged(session, changes) {
    if ('mode' in changes) {
      applyMode(session);
      modelAgents.applyMode(session);
    }
    if (changes.removed || changes.archived) modelAgents.stopAll(session);
    const cli = pool.get(session.id);
    if (!cli) return;
    if (changes.allowRules || changes.allowDirectories) cli.stale = true;
    if (changes.removed || changes.archived) cli.stale = true;
    if (cli.stale && !isBusy(session.id, cli)) void pool.close(session.id, 'restart');
  }

  /**
   * Claude Code's settings files, CLAUDE.md or memory changed on disk: every live process
   * among `sessions` restarts when idle (see markStale). Returns how many were marked.
   */
  function settingsChanged(sessions) {
    let marked = 0;
    for (const session of sessions) if (markStale(session)) marked += 1;
    return marked;
  }

  /**
   * Stops one running subagent (background or not) through Claude Code, which ends it
   * with a `stopped` task notification; the rest of the session carries on. Resolves
   * `{status, error}` when there is nothing to stop.
   */
  async function stopAgent(session, toolId) {
    const tool = session.messages.find((m) => m.role === 'tool' && m.toolId === toolId);
    if (tool?.agentId) return modelAgents.stop(session, toolId);
    if (!tool || !AGENT_TOOLS.has(tool.tool)) return { status: 404, error: 'Agent not found' };
    const cli = pool.get(session.id);
    if (tool.state !== 'running' || !tool.taskId || !cli) return { status: 409, error: 'This agent is not running.' };
    try {
      await cli.stream.stopTask(tool.taskId);
    } catch (error) {
      log(`Could not stop agent ${tool.taskId} in session ${session.id}: ${error.message}`);
      return { status: 409, error: 'This agent could not be stopped. It may have just finished.' };
    }
    return true;
  }

  /**
   * The user's message to a running model agent (its delegate card): read at the worker's
   * next step. Claude Code's own subagents take none. Resolves `{messageId}` or
   * `{status, error}`.
   */
  function messageAgent(session, toolId, body) {
    const tool = session.messages.find((m) => m.role === 'tool' && m.toolId === toolId);
    if (tool && AGENT_TOOLS.has(tool.tool)) return { status: 409, error: 'Only model agents take messages.' };
    if (!tool || tool.tool !== DELEGATE_TOOL) return { status: 404, error: 'Agent not found' };
    // A refused delegate call, or a worker that is gone (finished long ago, or a restart).
    if (!tool.agentId) return { status: 409, error: 'This agent is not running.' };
    return modelAgents.messageCard(session, toolId, body);
  }

  function resumeQueue(session) {
    delete session.stopRequested;
    session.queuePaused = false;
    flush(session);
    drain(session);
  }

  function hasApproval(approvalId) {
    return approvals.has(approvalId);
  }

  /**
   * Answers a pending approval. `answer` is `{decision: allow|allowAlways|deny, reason?,
   * answers?, mode?}` or v1's `{allow: boolean, ...}`. Returns false when the approval is
   * no longer pending or the answer is invalid.
   */
  function resolveApproval(approvalId, answer) {
    const approval = approvals.get(approvalId);
    if (!approval) return false;
    let { choice, error } = parseApprovalChoice(answer);
    if (!choice) return { status: 400, error };
    const run = runs.get(approval.session);
    if (run?.stopping) return { status: 409, error: 'The session was stopped.' };
    if (approval.entry.kind === 'question' && choice.decision !== 'deny' && !choice.answers) {
      return { status: 400, error: 'Answer the question, or skip it.' };
    }
    const cli = pool.get(approval.session);
    const model = run?.model ?? findModel(cli?.catalogId) ?? findModel(approval.target.model);
    // The stored mode must be one this model really runs (auto is Claude-only).
    if (approval.entry.kind === 'plan' && choice.mode && model) choice = { ...choice, mode: turnMode(model, choice.mode) };
    const decided = decideApproval(approval.entry, choice, {
      sessionMode: approval.target.mode,
      sdkMode: (mode) => permissionModeFor(turnMode(model, mode)),
    });
    // Recorded before the turn continues, so the stored mode follows the user's choice.
    applyApprovalToSession(approval.target, decided);
    if (decided.mode && cli && model) cli.mode = permissionModeFor(turnMode(model, decided.mode));
    approval.finish(decided.result);
    return true;
  }

  /**
   * SDK permission callback: parks the tool call as a pending approval until the user
   * answers. A model agent's process passes its own label and stop signal.
   */
  function approvalHandler(session, { agent: worker, signal: workerSignal } = {}) {
    return async (tool, input, options) => {
      const { toolUseID } = options;
      const signal = workerSignal && options.signal ? AbortSignal.any([options.signal, workerSignal]) : (options.signal ?? workerSignal);
      // A request the CLI had in flight when the user pressed Stop: never show it.
      const run = runs.get(session.id);
      if (shuttingDown || run?.stopping || signal?.aborted) return { behavior: 'deny', message: 'Session stopped', interrupt: true };
      if (allowedBySession(session, tool, input, options)) return { behavior: 'allow', updatedInput: input };
      const bypassed = bypassAnswer(session.mode, tool, input, options);
      if (bypassed) return bypassed;
      const entry = pendingEntry({ id: crypto.randomUUID(), tool, input, options });
      // Which subagent asks, so the card can say (parallel agents look alike otherwise).
      const agent = requestingAgent(session, options) ?? worker;
      if (agent) entry.agent = agent;
      const { id } = entry;
      if (tool === 'ExitPlanMode') setPlan(session, input?.plan, toolUseID);
      session.pending ??= [];
      session.pending.push(entry);
      session.status = 'waiting';
      flush(session);
      return new Promise((resolve) => {
        let timer;
        const finish = (result) => {
          clearTimeout(timer);
          approvals.delete(id);
          session.pending = session.pending.filter((p) => p.id !== id);
          // A background subagent can ask while no turn runs.
          if (session.pending.length) session.status = 'waiting';
          else if (runs.has(session.id)) session.status = 'running';
          else if (session.status === 'waiting') session.status = 'idle';
          // Settle the SDK's promise first so the turn can never hang on a publish problem.
          resolve(result);
          flush(session);
        };
        approvals.set(id, { session: session.id, target: session, entry, finish });
        if (entry.kind === 'question') {
          timer = setTimeout(() => {
            if (!approvals.has(id)) return;
            addNotice(session, 'No answer for an hour, so the agent is deciding on your behalf.', 'info');
            finish({ behavior: 'deny', message: QUESTION_TIMEOUT_MESSAGE });
          }, questionTimeoutMs);
          timer.unref?.();
        }
        signal?.addEventListener(
          'abort',
          () => {
            if (approvals.has(id)) finish({ behavior: 'deny', message: 'Session stopped', interrupt: true });
          },
          { once: true },
        );
      });
    };
  }

  /** A message's text, or content blocks with its attachments (mid-turn messages). */
  async function messageContent(session, model, text, attachments) {
    if (!attachments?.length || !uploads) return text;
    const records = [];
    for (const attachment of attachments) {
      const record = uploads.get(attachment.id);
      if (record && fs.existsSync(record.path)) records.push(record);
      else addNotice(session, `The attachment ${attachment.name} is no longer available.`, 'warning');
    }
    if (!records.length) return text;
    return isRemote(session) ? remoteAttachmentContent(session, text, records, model) : attachmentContent(text, records, { vision: model?.vision });
  }

  /** What the turn sends: the text, or content blocks when it has attachments. */
  async function turnInput(session, model, text, attachments, run) {
    if (!attachments?.length || !uploads) {
      run.handoff = carriesHandoff(session, text);
      return turnPrompt(session, model, text);
    }
    const records = [];
    for (const attachment of attachments) {
      const record = uploads.get(attachment.id);
      if (record && fs.existsSync(record.path)) records.push(record);
      else addNotice(session, `The attachment ${attachment.name} is no longer available.`, 'warning');
    }
    if (!records.length) {
      if (!text.trim()) throw new Error('The attached files are no longer available. Attach them again and resend.');
      run.handoff = carriesHandoff(session, text);
      return turnPrompt(session, model, text);
    }
    const content = isRemote(session) ? await remoteAttachmentContent(session, text, records, model) : await attachmentContent(text, records, { vision: model.vision });
    run.handoff = carriesHandoff(session, content);
    return turnPrompt(session, model, content);
  }

  /**
   * A remote session's attachments are copied to its upload folder on the cluster
   * (~/.local/share/harbor/uploads/<session>/), and the message names them there.
   */
  async function remoteAttachmentContent(session, text, records, model) {
    const cluster = await knowHome(session);
    const dir = remoteUploadDir(remoteHomes.get(cluster.id), session.id);
    const local = new Map();
    const copies = [];
    for (const record of records) {
      const target = path.posix.join(dir, path.basename(record.path));
      await ssh(cluster.host, `umask 077 && mkdir -p ${shQuote(dir)} && cat > ${shQuote(target)}`, { input: fs.createReadStream(record.path), timeoutMs: 120_000 });
      local.set(target, record.path);
      copies.push({ ...record, path: target });
    }
    return attachmentContent(text, copies, { vision: model.vision, readFile: (file) => fs.promises.readFile(local.get(file)) });
  }

  /**
   * Read-only access to the session's upload folder, so reading attachments never asks.
   * Not an additional working directory: that would let the model write there (and in
   * accept-edits mode without asking). Granted even before the folder exists: the process
   * outlives the turn, and a later turn may bring the first attachment.
   */
  function uploadReadRules(session) {
    if (!uploads || !isUploadScope(session.id)) return [];
    // A remote session's uploads are copied to the cluster (remoteAttachmentContent).
    const cluster = sessionHost(session);
    const dir = cluster ? remoteHomes.has(cluster.id) && remoteUploadDir(remoteHomes.get(cluster.id), session.id) : uploads.sessionDir(session.id);
    if (!dir) return [];
    // `//` marks an absolute path in Claude Code permission rules.
    return [`Read(/${dir}/**)`];
  }

  /**
   * An imported session's first turn is under way once the model answers (or the turn
   * ends without an error): the fork exists with this turn's prompt in it, and the Codex
   * history has been delivered. Until then a retry forks again or resends the history.
   */
  function importStarted(session, run) {
    if (!session.forkFrom && !(run.handoff && session.handoff)) return;
    delete session.forkFrom;
    if (run.handoff) delete session.handoff;
    run.handoff = false;
  }

  function addUploadReadRules(session, options) {
    const readRules = uploadReadRules(session);
    if (!readRules.length) return;
    options.settings.permissions ??= {};
    options.settings.permissions.allow = [...(options.settings.permissions.allow || []), ...readRules];
  }

  /**
   * A model agent's process: the session's grants, mode and settings on the worker's own
   * model, folder and approval callback; a new conversation every time.
   */
  function workerOptions(session, { model, effort, cwd, abortController, canUseTool }) {
    const { mode, allowRules, allowDirectories, mcpDisabled } = session;
    const options = buildQueryOptions(
      { cwd, mode, allowRules, allowDirectories, mcpDisabled },
      {
        model,
        effort,
        claudeExecutable: config.claudeExecutable,
        gateway: routes(),
        settingSources: config.settingSources,
        claudeConfigDir: config.claudeConfigDir,
        abortController,
        canUseTool,
      },
    );
    addUploadReadRules(session, options);
    return options;
  }

  /**
   * A model agent's report for the main model. The live process gets it as a message: at
   * the next step of a running turn, or as a turn of its own when idle (Claude Code
   * starts one, as for a finished background subagent). Without a usable process the
   * report waits in the queue like any message.
   */
  function deliverAgentReport(session, text) {
    if (shuttingDown) return;
    const cli = pool.get(session.id);
    const run = runs.get(session.id);
    // After a Stop the report waits in the paused queue rather than waking the main agent.
    if (cli && !cli.closing && !run?.stopping && !session.queuePaused && (!run || run.cli === cli)) {
      try {
        cli.send(text, { uuid: crypto.randomUUID(), priority: 'next' });
        return;
      } catch (error) {
        log(`Could not send a model agent's report to session ${session.id}: ${error.message}`);
      }
    }
    enqueue(session, { text, queue: true, hold: Boolean(session.queuePaused) });
  }

  /**
   * Starts the session's process for this turn's model. The MCP servers switched off for the
   * session are hidden before anything is sent to it: a deny rule applied through flag
   * settings right after the start. (As a start option the rule would remove those tools for
   * good, measured on Claude Code 2.1.290: clearing it later brings none back, so the switch
   * could not be turned on again without a restart. Applied after the start it is a filter
   * on every request, in both directions, and holds for servers that connect late.)
   */
  /**
   * The SDK options of a session's process. A reattach builds them the same way, so the
   * SDK side (approvals, hooks and their callback ids, Harbor's MCP server) matches
   * what the running process was started with.
   */
  function cliOptions(session, { model, effort, handoff }) {
    const options = buildQueryOptions(session, {
      model,
      effort,
      claudeExecutable: config.claudeExecutable,
      gateway: routes(),
      settingSources: config.settingSources,
      claudeConfigDir: config.claudeConfigDir,
      canUseTool: approvalHandler(session),
      // The Codex history always opens a new conversation, so a retry never repeats it.
      fresh: handoff,
      mcpDeny: false,
    });
    addUploadReadRules(session, options);
    // The end of every turn names the scheduled jobs that will wake the session later.
    options.hooks = { ...options.hooks, Stop: [...(options.hooks?.Stop || []), { hooks: [cronHook(session)] }] };
    // Harbor's own tools: start model agents and collect their reports, never asking.
    options.mcpServers = { ...(options.mcpServers || {}), [AGENT_SERVER]: modelAgents.server(session, { webSearch: !runsDirect(model) }) };
    options.allowedTools = [...(options.allowedTools || []), ...MODEL_AGENT_TOOLS];
    return options;
  }

  const cliHandlers = (session) => ({
    onMessage: (message, cli) => onCliMessage(session, cli, message),
    onExit: (error, cli) => onCliExit(session, cli, error),
  });

  async function startCli(session, run) {
    const { model, effort } = run;
    await firstProbe;
    await knowHome(session);
    const options = cliOptions(session, { model, effort, handoff: run.handoff });
    const cli = pool.start(session.id, {
      options,
      prepare: remotePrepare(session, sessionKey(session.id)),
      state: {
        catalogId: model.id,
        modelId: options.model,
        effort,
        direct: runsDirect(model),
        mode: options.permissionMode,
        cwd: session.cwd,
        context: JSON.stringify(contextSettings(model)),
        // What it was started with: Claude Code reads autoCompactWindow and the context env
        // only at start (a live applyFlagSettings left it compacting at the old window).
        launchContext: JSON.stringify(contextSettings(model)),
        session, // whose scheduled jobs keep it up (isBusy)
        cancelled: new Set(), // uuids the user cancelled (vs. dropped by a stop)
        lifecycle: false, // this CLI reports command_lifecycle frames
        relayManaged: Boolean(options.env.CLAUDE_CODE_OAUTH_TOKEN === 'harbor-relay'),
        checkpoints: true, // keeps file checkpoints (rewindFiles)
        resumedAt: options.resumeSessionAt, // the rewind point it resumed at
      },
      ...cliHandlers(session),
    });
    if (disabledServers(session).length) {
      try {
        await cli.stream.applyFlagSettings({ permissions: { deny: mcpDenyRules(disabledServers(session)) } });
      } catch (error) {
        // Never let a request through with the tools of a server the user switched off.
        await pool.kill(session.id, 'restart');
        throw new Error(`Claude Code could not hide the MCP servers switched off for this session: ${error.message}`);
      }
    }
    return cli;
  }

  /** A Stop hook keeping the session's scheduled jobs (`crons`) up to date. */
  function cronHook(session) {
    return async (input) => {
      if (!Array.isArray(input?.session_crons)) return {};
      // From now on the hook's list is the truth, even when it is empty (cronsFromTranscript).
      const first = !session.cronsKnown;
      session.cronsKnown = true;
      if (setCrons(session, input.session_crons) || first) flush(session);
      return {};
    };
  }

  // Starting, replacing and closing a session's process is one step at a time: a turn and
  // an MCP request (ensureCli) can ask at once.
  const cliLocks = new Map();
  function withCliLock(sessionId, task) {
    const result = (cliLocks.get(sessionId) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => {});
    cliLocks.set(sessionId, tail);
    void tail.then(() => {
      if (cliLocks.get(sessionId) === tail) cliLocks.delete(sessionId);
    });
    return result;
  }

  /**
   * The session's process, ready for this turn: the live one with model, effort and
   * mode switched in place, or a new one when the route (Claude vs gateway) changes, the
   * grants were revoked, or the turn must start a new conversation.
   */
  function cliFor(session, run) {
    return withCliLock(session.id, () => acquireCli(session, run));
  }

  /**
   * The session's process for something that is not a turn (an MCP sign-in, say): the
   * live one, or a new one started without sending it anything, so it costs no model call.
   * It lives like any other (idle timeout, cap) and the next turn picks it up.
   */
  function ensureCli(session) {
    return withCliLock(session.id, async () => {
      const live = pool.get(session.id);
      if (live) return live;
      if (shuttingDown) throw new Error('The server is shutting down.');
      const model = findModel(session.model);
      if (!model) throw new Error(`Unknown model "${session.model}". Choose another model first.`);
      // A process still closing has to be gone before the next one starts.
      await pool.close(session.id, 'restart');
      return startCli(session, { model, effort: resolveEffort(session.model, session.efforts), handoff: false });
    });
  }

  /**
   * Starts the process of a session that has none, ahead of its next message, so that
   * message does not wait for Claude Code to start (seconds: MCP servers, tools). Sent
   * nothing, it costs no model call. Not for a conversation still to be forked (an
   * import), which its first turn starts itself.
   */
  function warm(session) {
    if (shuttingDown || session.removed || session.forkFrom || session.handoff || pool.get(session.id) || runs.has(session.id)) return false;
    ensureCli(session).catch((error) => log(`Could not warm up session ${session.id}'s Claude Code process: ${error.message}`));
    return true;
  }

  // A new chat's session made while its first message is written (prepare), its process
  // started; the send adopts it. One at a time.
  let prepared = null;

  /**
   * Prepares `session` (not yet in the store, never published: `session.prepared`) and
   * starts its process. Replaces an earlier prepared session unless that one matches
   * `key`, which is then kept. Returns the prepared session's id.
   */
  function prepare(session, key) {
    if (prepared?.key === key) {
      prepared.timer.refresh();
      return prepared.session.id;
    }
    discardPrepared();
    if (shuttingDown) return null;
    session.prepared = true;
    const timer = setTimeout(discardPrepared, PREPARED_TTL_MS);
    timer.unref?.();
    prepared = { session, key, timer };
    ensureCli(session).then(
      // Replaced while it started: nobody will adopt it.
      () => session.prepared && prepared?.session !== session && void pool.close(session.id, 'closed'),
      (error) => {
        log(`Could not prepare a Claude Code process for a new chat: ${error.message}`);
        if (prepared?.session === session) discardPrepared();
      },
    );
    return session.id;
  }

  /** The prepared session `id` for a send made with `key`, which is now the caller's; else null. */
  function adopt(id, key) {
    if (!prepared || prepared.session.id !== id) return null;
    if (prepared.key !== key) {
      discardPrepared();
      return null;
    }
    const { session, timer } = prepared;
    clearTimeout(timer);
    prepared = null;
    delete session.prepared;
    return session;
  }

  function discardPrepared() {
    if (!prepared) return;
    clearTimeout(prepared.timer);
    const { session } = prepared;
    prepared = null;
    void pool.close(session.id, 'closed');
  }

  /**
   * Hides the session's switched-off MCP servers from its live process (and shows the
   * others): one deny rule per server in the process's flag settings. False when there is
   * no live process; the next start applies the list itself (startCli).
   */
  async function applyMcpDisabled(session) {
    const cli = pool.get(session.id);
    if (!cli) return false;
    await cli.stream.applyFlagSettings({ permissions: { deny: mcpDenyRules(disabledServers(session)) } });
    return true;
  }

  async function acquireCli(session, run) {
    const { model, effort } = run;
    const direct = runsDirect(model);
    let cli = pool.get(session.id);
    // A changed context window takes a new process (it resumes the conversation): Claude
    // Code keeps the window it started with. One from before launchContext was recorded
    // is replaced once, since its real start window is not known.
    const context = contextSettings(model);
    const contextKey = JSON.stringify(context);
    const contextChanged = cli && cli.launchContext !== contextKey;
    // Older local processes still use this machine's own login. Replace them at the next turn,
    // preserving their conversation and letting the gateway's relay supply the account instead.
    const needsRelayAuth = direct && relayUp && !isRemote(session) && !cli?.relayManaged;
    if (cli && (run.handoff || cli.stale || cli.direct !== direct || cli.cwd !== session.cwd || contextChanged || needsRelayAuth)) cli = null;
    if (cli) {
      try {
        const modelId = sdkModelId(model);
        if (cli.modelId !== modelId) {
          await cli.stream.setModel(modelId);
          cli.modelId = modelId;
        }
        cli.catalogId = model.id;
        if (cli.effort !== effort) {
          await cli.stream.applyFlagSettings({ effortLevel: effort });
          cli.effort = effort;
        }
        // Always: a mode Claude Code changed itself (leaving plan mode) is not tracked.
        const mode = permissionModeFor(turnMode(model, session.mode));
        await cli.stream.setPermissionMode(mode);
        cli.mode = mode;
        if (!cli.closing) return cli;
      } catch (error) {
        log(`Could not update session ${session.id}'s Claude Code process; restarting it: ${error.message}`);
        await pool.kill(session.id, 'restart');
      }
    }
    // Ends a process that is still there (route change, closing) before the new one.
    await pool.close(session.id, 'restart');
    return startCli(session, run);
  }

  async function runTurn(session, item) {
    const run = beginRun(session, { mainId: item.id });
    run.messageIds.add(item.id);
    flush(session);
    try {
      const model = findModel(session.model);
      if (!model) throw new Error(`Unknown model "${session.model}". Choose another model and resend.`);
      const effort = resolveEffort(session.model, session.efforts);
      Object.assign(run, { model, effort });
      const prompt = await turnInput(session, model, item.text, item.attachments, run);
      run.slash = isSlashCommand(prompt);
      // `/goal clear` ends the goal; Claude Code reports a goal it sets or checks itself.
      if (run.slash && /^\/goal\s+clear\b/i.test(prompt.trim()) && session.goal) {
        session.goal = null;
        flush(session);
      }
      run.importTurn = Boolean(session.forkFrom) || run.handoff;
      if (run.stopping) return settleRun(session, run, 'stopped');
      const cli = await cliFor(session, run);
      if (run.stopping || shuttingDown) return settleRun(session, run, 'stopped');
      run.mainUuid = send(cli, item.id, prompt);
      run.cli = cli;
      run.ready = true;
      for (const id of run.held) sendSteering(session, cli, id);
      run.held = [];
      if (run.slash && RESETTING_COMMANDS.test(prompt)) {
        cli.modelId = null;
        cli.effort = null;
      }
    } catch (error) {
      if (runs.get(session.id) !== run) return;
      addNotice(session, error.message || NOTICES.connectionFailed, 'error');
      settleRun(session, run, 'error');
    }
  }

  /** Claude Code took a message: it is part of the running turn from here on. */
  function taken(session, cli, uuid) {
    const messageId = cli.outstanding.get(uuid);
    if (!messageId) return;
    cli.outstanding.delete(uuid);
    session.steering = (session.steering || []).filter((item) => item.id !== messageId);
    let run = runs.get(session.id);
    if (!run) run = beginRun(session, { cli, ready: true, model: findModel(cli.catalogId), effort: cli.effort });
    if (run.cli !== cli) return;
    if (!run.started) cli.interrupting = false;
    run.started = true;
    run.mainId ??= messageId;
    run.messageIds.add(messageId);
    session.currentMessageId ??= run.mainId;
    const message = findMessage(session, messageId);
    // Claude Code's transcript keeps this uuid: a fork finds the message by it (fork.mjs).
    if (message) message.sdkUuid = uuid;
    // The conversation has branched off at the rewind point: resume it plainly from now on.
    if (session.resumeAt && cli.resumedAt === session.resumeAt) delete session.resumeAt;
    if (message && message.delivery !== 'running') {
      message.delivery = 'running';
      message.startedAt = Date.now();
      moveToEnd(session, message);
    }
    flush(session);
  }

  /** Claude Code dropped a message it had not read (a stop, or the user cancelled it). */
  function untaken(session, cli, uuid) {
    const messageId = cli.outstanding.get(uuid);
    if (!messageId) return;
    cli.outstanding.delete(uuid);
    const run = runs.get(session.id);
    if (run?.cli === cli && run.mainId === messageId && !run.started) {
      settleRun(session, run, 'stopped');
      return;
    }
    if (cli.cancelled.has(uuid)) markCancelled(session, messageId);
    else if (cli.interrupting && !run?.stopping) resendNow(session, cli, messageId);
    else {
      requeue(session, messageId);
      flush(session);
    }
  }

  function onCliMessage(session, cli, message) {
    if (message.type === 'command_lifecycle') {
      cli.lifecycle = true;
      if (message.state === 'started') taken(session, cli, message.command_uuid);
      else if (message.state === 'cancelled') untaken(session, cli, message.command_uuid);
      return;
    }
    if (message.type === 'user' && message.isReplay) {
      // The user's own message is already in the transcript.
      if (message.uuid) taken(session, cli, message.uuid);
      return;
    }
    // The /goal under way (null once met or cleared): checked at every turn's end.
    if (message.type === 'active_goal') {
      session.goal = goalOf(message.value);
      flush(session);
      return;
    }
    // A goal just set by /goal: reported as its reply before the first check.
    const goalSet = runs.get(session.id)?.slash && message.type === 'assistant' && !message.parent_tool_use_id && goalSetText(message);
    if (goalSet) {
      session.goal = { condition: goalSet, iterations: 0, setAt: Date.now() };
      flush(session);
    }
    if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      cli.backgroundTasks = (message.tasks || []).filter((task) => !task.ambient).length;
      if (setLiveTasks(session, message.tasks)) flush(session);
      return;
    }
    if (message.type === 'result') {
      for (const uuid of message.user_message_uuids ?? []) taken(session, cli, uuid);
    }

    let run = runs.get(session.id);
    // Claude Code starting a turn of its own (a background task finished).
    if (!run && mainThreadWork(message) && !shuttingDown) {
      run = beginRun(session, { kind: 'agent', cli, ready: true, started: true, model: findModel(cli.catalogId), effort: cli.effort });
      flush(session);
    }
    if (run && run.cli !== cli) run = undefined;
    // An older CLI without lifecycle frames: the result is the turn's.
    if (run && !run.started && message.type === 'result' && !cli.lifecycle) run.started = true;

    // Claude Code has the prompt (and with it any switch note) once it answers. An
    // import's first turn records it only on the answer: a retry forks the original
    // again and needs the note again.
    if (run?.kind === 'user' && run.started && !run.slash && run.model) {
      const answer = answered(message);
      const unstartedImport = Boolean(session.forkFrom) || (run.handoff && Boolean(session.handoff));
      if (answer || !unstartedImport) session.lastTurnModel = run.model.id;
      if (answer) importStarted(session, run);
    }

    const model = findModel(cli.catalogId);
    applySdkMessage(session, message, {
      model: cli.catalogId,
      effort: cli.effort ?? run?.effort,
      contextWindow: model?.contextWindow,
      compactAt: model && compactThreshold(model),
      stopping: () => Boolean(run?.stopping),
      interrupted: () => Boolean(run?.interrupting && !run.stopping),
      tick,
      schedule,
      flush,
    });
    if (message.type === 'result' && run?.started) endTurn(session, run, message);
  }

  /**
   * A turn's result. Messages sent mid-turn that Claude Code has not read yet run as its
   * next turn right away, so the session stays busy instead of flashing idle.
   */
  function endTurn(session, run, result) {
    const outcome = run.stopping ? 'stopped' : run.interrupting ? 'interrupted' : result.is_error ? 'error' : 'done';
    if (outcome === 'interrupted') {
      addNotice(session, NOTICES.interrupted);
      resendDropped(session, run.cli, run.receipt, run.waiting);
    }
    if (outcome === 'stopped' || !run.cli.outstanding.size || shuttingDown) return settleRun(session, run, outcome);
    finishMessages(session, run, outcome);
    settleTools(session, false);
    Object.assign(run, { kind: 'user', started: false, mainId: undefined, messageIds: new Set(), slash: false });
    Object.assign(run, { interrupting: false, receipt: undefined, waiting: undefined });
    session.status = session.pending?.length ? 'waiting' : 'running';
    flush(session);
  }

  function finishMessages(session, run, outcome) {
    const delivery = ['stopped', 'error', 'interrupted'].includes(outcome) ? outcome : 'done';
    for (const id of run.messageIds) {
      const message = findMessage(session, id);
      if (message && (message.delivery === 'running' || id === run.mainId)) message.delivery = delivery;
    }
    if (run.messageIds.has(session.currentMessageId)) delete session.currentMessageId;
  }

  /**
   * Tool calls that will never finish; background subagents keep running unless the
   * process died. Model agents run in processes of their own and keep running either way.
   */
  function settleTools(session, all) {
    settleOrphanedTools(session, Date.now(), backgroundWork(session, modelAgents.liveTools(session.id), { subagents: !all }));
  }

  /** The turn is over: final deliveries, notices and status, then the queue moves on. */
  function settleRun(session, run, outcome, { exited = false } = {}) {
    if (runs.get(session.id) !== run) return;
    clearTimeout(run.stopTimer);
    runs.delete(session.id);
    if (run.cli) run.cli.interrupting = false;
    for (const id of run.held) requeue(session, id);
    run.held = [];
    session.live = '';
    session.liveThinking = '';
    settleTools(session, exited);
    session.turnEndedAt = Date.now();
    if (outcome === 'stopped') addNotice(session, shuttingDown ? NOTICES.maintenance : NOTICES.stopped);
    finishMessages(session, run, outcome);
    delete session.currentMessageId;
    if (outcome === 'error' || session.status === 'error') {
      session.status = 'error';
      session.queuePaused = true;
    } else session.status = session.pending?.length ? 'waiting' : 'idle';
    if (outcome !== 'error' && outcome !== 'stopped' && session.titleAuto) autoTitle(session);
    const cli = pool.get(session.id);
    if (cli && !exited) {
      // An import's first turn that never got an answer: the retry forks the original
      // again, or sends the Codex history again, from a new process.
      const unstartedImport = run.importTurn && (session.forkFrom || (run.handoff && session.handoff));
      if (unstartedImport) cli.stale = true;
      if (cli.stale && !isBusy(session.id, cli)) void pool.close(session.id, 'restart');
    }
    flush(session);
    queueMicrotask(() => drain(session));
  }

  /** The process is gone: on purpose (idle, restart, stop, shutdown) or not (a crash). */
  function onCliExit(session, cli, error) {
    cli.backgroundTasks = 0;
    delete session.compacting;
    // Its background tasks and one-shot wakeups are gone with it (recurring jobs come
    // back with the conversation).
    const wakeups = settleTasks(session);
    if (wakeups) addNotice(session, lostWakeupsNotice(wakeups), 'warning');
    const run = runs.get(session.id);
    const mine = run?.cli === cli;
    denyApprovals(session.id, { behavior: 'deny', message: 'Claude Code exited', interrupt: true });
    // Messages it never read go back to the paused queue.
    for (const messageId of cli.outstanding.values()) {
      if (mine && messageId === run.mainId && !run.started) continue;
      requeue(session, messageId);
    }
    cli.outstanding.clear();
    if (mine) {
      const expected = run.stopping || shuttingDown;
      if (!expected) {
        log(`Session ${session.id}'s Claude Code process ended mid-turn: ${error?.message || 'no result'}`);
        addNotice(session, error?.message || NOTICES.connectionFailed, 'error');
      }
      settleRun(session, run, expected ? 'stopped' : 'error', { exited: true });
      return;
    }
    if (error && !cli.closing) log(`Session ${session.id}'s Claude Code process ended: ${error.message}`);
    // Background subagents it was running are gone.
    if (!run) {
      settleTools(session, true);
      if (session.status === 'running' || session.status === 'waiting') session.status = 'idle';
    } else {
      // Replaced while a new turn waits for its own process (a route change): only the
      // old process's background work ends with it.
      const background = backgroundWork(session);
      const workers = backgroundWork(session, modelAgents.liveTools(session.id), { subagents: false });
      settleOrphanedTools(session, Date.now(), (message) => !background(message) || workers(message));
    }
    flush(session);
  }

  /** Boot: reconnect surviving processes; resume work whose process was lost. */
  function startQueued(sessions) {
    for (const session of sessions) {
      if (session.restartRecovery && !session.stopRequested && !session.removed && !runs.has(session.id)) {
        // Persist before starting: a crash loop must not spend tokens indefinitely.
        const now = Date.now();
        const attempts = (session.restartAttempts ?? []).filter((at) => now - at < 10 * 60_000);
        delete session.restartRecovery;
        if (attempts.length >= 3) {
          session.queuePaused = true;
          addNotice(session, 'Automatic recovery paused after three restarts in ten minutes. Send a message to try again.', 'warning');
          flush(session);
          continue;
        }
        session.restartAttempts = [...attempts, now];
        // A new prompt asks the model to reconcile tool side effects against disk and
        // job state. Replaying the interrupted user prompt could submit work twice.
        const text = '[Harbor recovery] The server restarted and your process was lost during ongoing work. Continue the user’s unfinished task from the saved conversation. First inspect the current files, running jobs, and outputs to determine what already completed. An interrupted tool may have taken effect even if its result is missing: do not blindly repeat commands, submissions, or external actions. Re-establish any monitoring needed. Preserve existing user instructions and permission requirements. If the task already finished, report that instead.';
        session.queue ??= [];
        const pendingRecovery = session.queue.find((item) => findMessage(session, item.id)?.recovery);
        if (!pendingRecovery) {
          const message = addMessage(session, 'user', text, { delivery: 'queued', recovery: true });
          session.queue.unshift({ id: message.id, text });
        }
        session.queuePaused = false;
        flush(session);
        drain(session);
      } else if (session.status === 'interrupted') session.queuePaused = true;
      else drain(session);
    }
  }

  /**
   * Boot: sessions with recurring jobs get their process back (resumed, sent nothing),
   * so the jobs go on firing; one at a time, `staggerMs` apart.
   */
  async function resumeScheduled(sessions, { staggerMs = 500 } = {}) {
    for (const session of sessions) {
      if (shuttingDown) return;
      // Jobs made before Harbor kept track of them: read back from the transcript, once.
      if (!session.cronsKnown && !session.crons && !session.removed) {
        const jobs = cronsFromTranscript(session);
        if (jobs.length && liveCrons({ crons: jobs }).length) {
          session.crons = jobs;
          flush(session);
        }
      }
      // A session in the Trash stays quiet.
      if (session.removed || !liveCrons(session).some((cron) => cron.recurring) || pool.get(session.id)) continue;
      try {
        await ensureCli(session);
      } catch (error) {
        log(`Could not resume session ${session.id} for its scheduled jobs: ${error.message}`);
      }
      if (staggerMs) await new Promise((resolve) => setTimeout(resolve, staggerMs).unref?.());
    }
  }

  /** Whether something is still at work in the session: a rewind must wait for it. */
  function rewindBlocked(session) {
    const cli = pool.get(session.id);
    if (runs.has(session.id) || session.status === 'running' || session.status === 'waiting') return true;
    if (modelAgents.running(session.id) > 0 || (cli && (cli.outstanding.size > 0 || cli.backgroundTasks > 0))) return true;
    return [...approvals.values()].some((approval) => approval.session === session.id);
  }

  /**
   * Puts the files Claude edited since the prompt `uuid` back as they were (Claude Code's
   * file checkpoints), or with `dryRun` only says what that would change. A process from
   * before checkpoints were kept is replaced first.
   */
  async function rewindFiles(session, uuid, { dryRun = false } = {}) {
    const live = pool.get(session.id);
    if (live && !live.checkpoints && !rewindBlocked(session)) await withCliLock(session.id, () => pool.close(session.id, 'restart'));
    const cli = await ensureCli(session);
    return cli.stream.rewindFiles(uuid, { dryRun });
  }

  /** Ends the session's process so the next one resumes at the rewind point. */
  async function restartCli(session) {
    await withCliLock(session.id, () => pool.close(session.id, 'restart'));
    // Scheduled jobs only fire while a process is up.
    if (liveCrons(session).some((cron) => cron.recurring)) {
      ensureCli(session).catch((error) => log(`Could not restart session ${session.id}'s Claude Code process: ${error.message}`));
    }
  }

  /**
   * Stops one background task (a command, a Monitor) through Claude Code, which ends it
   * with a `stopped` task notification. Resolves `{status, error}` when there is nothing
   * to stop.
   */
  async function stopTask(session, taskId) {
    const cli = pool.get(session.id);
    if (!(session.liveTasks || []).some((task) => task.id === taskId) || !cli) return { status: 409, error: 'This task is not running.' };
    try {
      await cli.stream.stopTask(taskId);
    } catch (error) {
      log(`Could not stop task ${taskId} in session ${session.id}: ${error.message}`);
      return { status: 409, error: 'This task could not be stopped. It may have just finished.' };
    }
    return true;
  }

  // What a process's next server needs to carry on with it (kept in the CLI host).
  const CLI_STATE = ['catalogId', 'modelId', 'effort', 'direct', 'mode', 'cwd', 'context', 'launchContext', 'lifecycle', 'stale', 'checkpoints', 'resumedAt', 'relayManaged'];
  function describeCli(cli) {
    const state = Object.fromEntries(CLI_STATE.map((key) => [key, cli[key]]));
    const run = runs.get(cli.sessionId);
    const turn =
      run && run.cli === cli
        ? {
            kind: run.kind,
            mainId: run.mainId,
            messageIds: [...run.messageIds],
            started: run.started,
            mainUuid: run.mainUuid,
            slash: run.slash,
            importTurn: run.importTurn,
            handoff: run.handoff,
            effort: run.effort,
            stopping: run.stopping,
            interrupting: Boolean(run.interrupting),
          }
        : null;
    return { version: 1, sessionId: cli.sessionId, state, outstanding: [...cli.outstanding], cancelled: [...cli.cancelled], run: turn };
  }

  // Kept current in the host too, so a server that dies without a shutdown leaves it.
  const describeTimer = hostSocket
    ? setInterval(() => {
        for (const cli of pool.live()) {
          if (!cli.detached && cli.proc && !cli.exited) cli.proc.setMeta(describeCli(cli));
        }
        modelAgents.saveMeta();
      }, 5000)
    : null;
  describeTimer?.unref?.();

  /**
   * Boot with a CLI host: takes back the processes the previous server left running.
   * `procs` is the host's list; `sessions` looks a session up by id. A process whose
   * session is gone is ended. Returns the ids of the sessions taken back.
   */
  async function reattach(procs, sessions) {
    // Workers first: the leads' wait_agents calls, asked again, look them up.
    await modelAgents.reattach(procs, sessions);
    const taken = [];
    for (const proc of procs) {
      if (!proc.key?.startsWith('s:')) continue;
      const sessionId = proc.key.slice(2);
      const session = sessions(sessionId);
      const meta = proc.meta?.version === 1 ? proc.meta : null;
      const model = session && findModel(meta?.state?.catalogId ?? session.model);
      if (!session || session.removed || !model || pool.get(sessionId)) {
        log(`Ending a Claude Code process left by the previous server: ${proc.key} (${session ? 'cannot take it back' : 'no such session'}).`);
        killHostProcess(proc.key);
        continue;
      }
      const effort = meta?.state?.effort ?? resolveEffort(session.model, session.efforts);
      try {
        await knowHome(session).catch((error) => log(`Session ${sessionId}'s cluster did not answer: ${error.message}`));
        const options = cliOptions(session, { model, effort, handoff: meta?.run?.handoff });
        const state = {
          ...(meta?.state ?? {}),
          catalogId: model.id,
          session,
          cancelled: new Set(meta?.cancelled ?? []),
          lifecycle: Boolean(meta?.state?.lifecycle),
        };
        // The turn under way goes on: its messages and where it stands.
        if (meta?.run) {
          const turn = meta.run;
          const run = beginRun(session, {
            kind: turn.kind,
            mainId: turn.mainId,
            messageIds: new Set(turn.messageIds ?? []),
            started: Boolean(turn.started),
            ready: true,
            mainUuid: turn.mainUuid,
            slash: Boolean(turn.slash),
            importTurn: Boolean(turn.importTurn),
            handoff: turn.handoff,
            model,
            effort: turn.effort ?? effort,
            stopping: Boolean(turn.stopping),
            interrupting: Boolean(turn.interrupting),
          });
          if (turn.mainId) session.currentMessageId = turn.mainId;
          // beginRun reset these for a new turn; this one already has its state.
          session.status = 'running';
          taken.push(sessionId);
        }
        await pool.reattach(sessionId, { options, state, ...cliHandlers(session) }, (cli) => {
          const run = runs.get(sessionId);
          if (run && !run.cli) run.cli = cli;
          for (const [uuid, messageId] of meta?.outstanding ?? []) cli.outstanding.set(uuid, messageId);
        });
        if (!meta?.run) taken.push(sessionId);
        flush(session);
      } catch (error) {
        log(`Could not take back session ${sessionId}'s Claude Code process: ${error.message}`);
        // Nobody can drive it now: it would only run on unseen.
        if (!error.missing) killHostProcess(proc.key);
        const run = runs.get(sessionId);
        if (run && !run.cli) {
          addNotice(session, NOTICES.connectionFailed, 'error');
          settleRun(session, run, 'error', { exited: true });
        }
      }
    }
    return taken;
  }

  function killHostProcess(key) {
    if (!hostSocket) return;
    import('./host-client.mjs')
      .then(({ killInHost }) => killInHost(hostSocket, key))
      .catch((error) => log(`Could not end ${key} in the CLI host: ${error.message}`));
  }

  /**
   * SIGTERM with a CLI host (a deploy): every process, its turn, its approvals and its
   * background work keep going in the host; the next server takes them back (reattach).
   */
  function detach() {
    shuttingDown = true;
    clearInterval(relayTimer);
    clearInterval(describeTimer);
    discardPrepared();
    modelAgents.detachAll();
    pool.detachAll(describeCli);
  }

  /** SIGTERM: refuse new turns, end the running ones and close every process. */
  function shutdown() {
    shuttingDown = true;
    clearInterval(describeTimer);
    clearInterval(relayTimer);
    discardPrepared();
    modelAgents.shutdown();
    for (const [sessionId, run] of runs) {
      run.stopping = true;
      denyApprovals(sessionId, { behavior: 'deny', message: 'Server shutting down', interrupt: true });
      // Not sent yet: nothing in a process to wait for.
      if (!run.ready) settleRun(run.session, run, 'stopped');
    }
    pool.closeAll();
  }

  return {
    backfillTitles,
    isRunning,
    drain,
    enqueue,
    cancelQueued,
    stop,
    interrupt,
    applyMode,
    ensureCli,
    applyMcpDisabled,
    warm,
    prepare,
    adopt,
    sessionChanged,
    settingsChanged,
    resumeQueue,
    stopAgent,
    stopTask,
    rewindBlocked,
    rewindFiles,
    restartCli,
    resumeScheduled,
    messageAgent,
    hasApproval,
    resolveApproval,
    startQueued,
    shutdown,
    detach,
    reattach,
    readyCluster,
    /** The live process pool (diagnostics and tests). */
    pool,
    /** Parallel workers on other models (diagnostics and tests). */
    modelAgents,
  };
}
