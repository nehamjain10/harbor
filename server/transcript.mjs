// SDK message -> session state. `applySdkMessage` turns the Claude Agent SDK's message
// stream into the transcript the browser renders (see the v2 API contract): messages,
// subagent nesting, live text, todos, plan, context fill and per-turn usage. It is pure
// apart from the publishing callbacks it is handed.
import { MAX_TOOL_OUTPUT } from './config.mjs';
import { findModel } from './models.mjs';
import { addMessage, addNotice } from './store.mjs';
import { endTask, monitorTaskId, outputPathIn, startTask } from './tasks.mjs';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
// task_updated statuses that end a task.
const TASK_ENDS = new Set(['completed', 'failed', 'killed']);
// A model agent's card (see model-agents.mjs; the name is repeated to avoid an import cycle).
const DELEGATE_TOOL = 'mcp__meshy__delegate';

export const NOTICES = {
  stopped: 'Stopped. Queued messages are paused until you resume.',
  interrupted: 'Interrupted to read your messages.',
  maintenance: 'Server maintenance interrupted this turn. Your conversation and queued messages are saved.',
  connectionFailed: 'The connection to Claude Code failed.',
  turnFailed: 'The turn could not finish. Try again.',
  compacted: 'Context compacted',
};

/** Tool result content (a string or content blocks) as display text, capped for storage. */
export function toolOutputText(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((block) => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[Image]' : JSON.stringify(block)))
      .join('\n');
  } else text = content === undefined || content === null ? '' : JSON.stringify(content);
  if (text.length > MAX_TOOL_OUTPUT) return text.slice(0, MAX_TOOL_OUTPUT) + '\n[Output truncated]';
  return text;
}

function findTool(session, toolId) {
  return session.messages.find((message) => message.role === 'tool' && message.toolId === toolId);
}

function findTask(session, taskId) {
  return session.messages.find((message) => message.role === 'tool' && message.taskId === taskId);
}

/** A task's usage in the contract's shape (`{tokens, toolUses, durationMs}`), or null. */
function taskUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return { tokens: usage.total_tokens ?? 0, toolUses: usage.tool_uses ?? 0, durationMs: usage.duration_ms ?? 0 };
}

/** True for a subagent the main thread is not waiting for (it runs on after its turn). */
function isBackgroundAgent(message) {
  return message.role === 'tool' && AGENT_TOOLS.has(message.tool) && Boolean(message.background) && !message.parentToolId;
}

/**
 * The subagent a permission request comes from, as `{toolId, description, subagentType}`
 * for the approval card, or undefined for the main thread. Found by the SDK's agent id
 * (the task id) or, failing that, by the Agent call the requesting tool call is nested in.
 */
export function requestingAgent(session, { agentID, toolUseID } = {}) {
  let agent = agentID ? findTask(session, agentID) : undefined;
  if (!agent && toolUseID) {
    const parentToolId = findTool(session, toolUseID)?.parentToolId;
    agent = parentToolId ? findTool(session, parentToolId) : undefined;
  }
  if (agent?.tool === DELEGATE_TOOL && agent.agentId) {
    // A model agent: named by its model, as the card is.
    const model = findModel(agent.agentModel);
    const description = typeof agent.input?.description === 'string' && agent.input.description ? agent.input.description : agent.agentId;
    return { toolId: agent.toolId, description, subagentType: `${model?.name ?? 'Model'} agent` };
  }
  if (!agent || !AGENT_TOOLS.has(agent.tool)) return undefined;
  return {
    toolId: agent.toolId,
    description: typeof agent.input?.description === 'string' ? agent.input.description : '',
    ...(typeof agent.input?.subagent_type === 'string' ? { subagentType: agent.input.subagent_type } : {}),
  };
}

/** True when this exact block was already recorded (the SDK can repeat a message). */
function alreadyRecorded(session, role, sdkId, text) {
  return session.messages.some((message) => message.role === role && message.sdkId === sdkId && message.text === text);
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** A TodoWrite list in the contract's shape, or null when it is not a usable list. */
export function todoList(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item) => item && typeof item.content === 'string')
    .map((item) => ({
      content: item.content,
      status: TODO_STATUSES.has(item.status) ? item.status : 'pending',
      ...(typeof item.activeForm === 'string' ? { activeForm: item.activeForm } : {}),
    }));
}

export function setPlan(session, text, toolId, at = Date.now()) {
  if (typeof text === 'string' && text.trim()) session.plan = { text, at, toolId };
}

/** When something happened: the message's own time for imported history, otherwise now. */
function now(ctx) {
  return ctx.at ?? Date.now();
}

function recordToolUse(session, block, nesting, ctx) {
  const existing = findTool(session, block.id);
  if (existing) existing.input = block.input;
  else {
    const fields = { tool: block.name, input: block.input, toolId: block.id, state: 'running', at: now(ctx), ...nesting };
    addMessage(session, 'tool', '', fields);
  }

  // Claude Code adds the plan file's text to ExitPlanMode's input.
  if (block.name === 'ExitPlanMode' && !nesting.parentToolId) setPlan(session, block.input?.plan, block.id, now(ctx));
}

function updateContext(session, usage, ctx) {
  if (!usage || !ctx.contextWindow) return;
  const used = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  if (used > 0) session.context = { used, window: ctx.contextWindow, ...(ctx.compactAt ? { compactAt: ctx.compactAt } : {}) };
}

function applyStreamEvent(session, message, ctx) {
  // Subagent streams are not shown live; their messages land nested under the Agent card.
  if (message.parent_tool_use_id) return;
  const event = message.event;
  if (event?.type === 'message_start') {
    // A new model response (or a retried one) starts from empty live text.
    session.live = '';
    session.liveThinking = '';
    return;
  }
  if (event?.type !== 'content_block_delta') return;
  if (event.delta?.type === 'text_delta') session.live = (session.live || '') + event.delta.text;
  else if (event.delta?.type === 'thinking_delta') session.liveThinking = (session.liveThinking || '') + event.delta.thinking;
  else return;
  if (!session.pending?.length) session.status = 'running';
  ctx.tick(session);
}

function applyAssistant(session, message, ctx) {
  const parentToolId = message.parent_tool_use_id || undefined;
  const nesting = parentToolId ? { parentToolId } : {};
  const sdkId = message.uuid || message.message?.id;
  if (!parentToolId) {
    session.live = '';
    session.liveThinking = '';
  }
  const at = now(ctx);
  for (const block of message.message?.content || []) {
    if (block.type === 'thinking' && block.thinking) {
      if (!alreadyRecorded(session, 'thinking', sdkId, block.thinking)) {
        addMessage(session, 'thinking', block.thinking, { sdkId, at, ...nesting });
      }
    } else if (block.type === 'text' && block.text && message.error && !parentToolId) {
      // A synthetic message carrying an API failure ("API Error: 400 ...").
      if (!alreadyRecorded(session, 'notice', sdkId, block.text)) addNotice(session, block.text, 'error', { sdkId, at });
    } else if (block.type === 'text' && block.text) {
      if (!alreadyRecorded(session, 'assistant', sdkId, block.text)) {
        addMessage(session, 'assistant', block.text, { sdkId, model: ctx.model ?? session.model, effort: ctx.effort, at, ...nesting });
      }
    } else if (block.type === 'tool_use') {
      recordToolUse(session, block, nesting, ctx);
    }
  }
  if (!parentToolId) updateContext(session, message.message?.usage, ctx);
  ctx.flush(session);
}

function applyUser(session, message, ctx) {
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  let changed = false;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const tool = findTool(session, block.tool_use_id);
    if (!tool) continue;
    // A model agent's card belongs to its worker (model-agents.mjs), not to the call
    // that started it: it keeps running until the worker ends.
    if (tool.agentId && !block.is_error) continue;
    const result = message.tool_use_result;
    // A finished subagent's report without the model-directed hand-back frame.
    const report = AGENT_TOOLS.has(tool.tool) && !block.is_error && Array.isArray(result?.content) ? result.content : null;
    tool.output = toolOutputText(report ?? block.content);
    changed = true;
    if (report && result.totalTokens !== undefined) {
      tool.usage = { tokens: result.totalTokens ?? 0, toolUses: result.totalToolUseCount ?? 0, durationMs: result.totalDurationMs ?? 0 };
    }
    if (!block.is_error && result?.status === 'async_launched') {
      // A background subagent: the card keeps running until its task_notification.
      tool.background = true;
      continue;
    }
    // A command running on in the background (asked for, or moved there at its timeout),
    // or a Monitor: the call is done, its task goes on (see tasks.mjs).
    const backgroundId = !block.is_error && (result?.backgroundTaskId || (tool.tool === 'Monitor' && monitorTaskId(tool.output)));
    if (backgroundId) {
      if (!tool.task || tool.taskId !== backgroundId) startTask(tool, { id: backgroundId });
      const output = outputPathIn(tool.output);
      if (output) tool.task.output = output;
    }
    tool.state = block.is_error ? 'error' : 'done';
    tool.endedAt = now(ctx);
    delete tool.elapsed;
    if (block.is_error || tool.parentToolId) continue;
    // The checklist follows what Claude Code accepted, not what the model attempted.
    if (tool.tool === 'TodoWrite') {
      const todos = todoList(result?.newTodos) ?? todoList(tool.input?.todos);
      if (todos) session.todos = todos;
    }
    if (tool.tool === 'ExitPlanMode') setPlan(session, result?.plan, tool.toolId, now(ctx));
  }
  if (changed) ctx.flush(session);
}

function applyToolProgress(session, message, ctx) {
  const tool = findTool(session, message.tool_use_id);
  if (!tool || tool.state !== 'running') return;
  tool.elapsed = Math.round(message.elapsed_time_seconds ?? 0);
  ctx.schedule(session);
}

function applySystem(session, message, ctx) {
  if (message.subtype === 'init') {
    const mcp = (message.mcp_servers || []).map(({ name, status }) => ({ name, status }));
    if (JSON.stringify(mcp) !== JSON.stringify(session.mcp ?? [])) {
      session.mcp = mcp;
      ctx.flush(session);
    }
  } else if (message.subtype === 'status') {
    // Claude Code is summarizing the conversation (auto or /compact); it can take a while.
    const compacting = message.status === 'compacting';
    if (compacting === Boolean(session.compacting)) return;
    if (compacting) session.compacting = now(ctx);
    else delete session.compacting;
    ctx.flush(session);
  } else if (message.subtype === 'compact_boundary') {
    delete session.compacting;
    addNotice(session, NOTICES.compacted, 'info', { at: now(ctx) });
    const after = message.compact_metadata?.post_tokens;
    if (after && session.context) session.context = { ...session.context, used: after };
    ctx.flush(session);
  } else if (message.subtype === 'task_started' && message.tool_use_id) {
    // The task id is what stopping a subagent (and its permission requests) refer to.
    const tool = findTool(session, message.tool_use_id);
    if (!tool || tool.state !== 'running') return;
    tool.taskId = message.task_id;
    if (message.is_backgrounded) tool.background = true;
    // A background command or Monitor (a foreground command is a task too, in case it is
    // moved to the background later; it only shows as one then).
    if (message.is_backgrounded && !AGENT_TOOLS.has(tool.tool) && message.task_type !== 'local_agent') {
      startTask(tool, { id: message.task_id, type: message.task_type });
    }
    ctx.flush(session);
  } else if (message.subtype === 'task_updated') {
    const tool = findTask(session, message.task_id);
    if (!tool) return;
    if (message.patch?.is_backgrounded && tool.state === 'running') {
      // A foreground subagent or command moved to the background: the turn goes on
      // without it.
      tool.background = true;
      if (!AGENT_TOOLS.has(tool.tool)) startTask(tool, { id: message.task_id, type: 'local_bash' });
      ctx.flush(session);
    } else if (tool.task && !tool.task.status && TASK_ENDS.has(message.patch?.status)) {
      endTask(tool, { status: message.patch.status === 'killed' ? 'stopped' : message.patch.status, at: message.patch.end_time ?? now(ctx) });
      ctx.flush(session);
    }
  } else if (message.subtype === 'task_notification' && (message.tool_use_id ? findTool(session, message.tool_use_id) : findTask(session, message.task_id))?.task) {
    // A background command or Monitor ended (its call finished long ago).
    const tool = message.tool_use_id ? findTool(session, message.tool_use_id) : findTask(session, message.task_id);
    endTask(tool, { status: message.status, at: tool.task.endedAt ?? now(ctx), output: message.output_file, summary: message.summary });
    // A notification after the end it reports (task_updated came first) keeps that end.
    tool.task.status = message.status === 'completed' ? 'completed' : message.status === 'failed' ? 'failed' : 'stopped';
    ctx.flush(session);
  } else if (message.subtype === 'task_progress' && message.tool_use_id) {
    const tool = findTool(session, message.tool_use_id);
    if (!tool || tool.state !== 'running') return;
    if (message.task_id) tool.taskId ??= message.task_id;
    tool.elapsed = Math.round((message.usage?.duration_ms ?? 0) / 1000);
    tool.progress = {
      description: message.description,
      toolUses: message.usage?.tool_uses ?? 0,
      tokens: message.usage?.total_tokens ?? 0,
      ...(message.last_tool_name ? { lastTool: message.last_tool_name } : {}),
    };
    ctx.schedule(session);
  } else if (message.subtype === 'task_notification' && message.tool_use_id) {
    const tool = findTool(session, message.tool_use_id);
    if (!tool || tool.state !== 'running') return;
    tool.state = message.status === 'completed' ? 'done' : 'error';
    if (message.status === 'stopped') tool.stopped = true;
    if (message.summary) tool.output = toolOutputText(message.summary);
    const usage = taskUsage(message.usage);
    if (usage) tool.usage = usage;
    tool.endedAt = now(ctx);
    delete tool.elapsed;
    // A background subagent ends long after its turn: say so where it happens, so the
    // turn Claude Code starts next (reading its report) is not an unexplained reply.
    if (isBackgroundAgent(tool)) {
      addNotice(session, agentEndText(tool, message.status), message.status === 'failed' ? 'warning' : 'info', {
        agentToolId: tool.toolId,
        at: now(ctx),
      });
    }
    ctx.flush(session);
  } else if (message.subtype === 'api_retry') {
    // One notice per retry streak, updated in place, so a flaky gateway is visible
    // without flooding the transcript.
    const status = message.error_status ? ` (HTTP ${message.error_status})` : '';
    const text = `The model API failed${status}; retrying, attempt ${message.attempt} of ${message.max_retries}.`;
    const last = session.messages.at(-1);
    if (last?.role === 'notice' && last.retry) {
      last.text = text;
      last.at = Date.now();
    } else addNotice(session, text, 'warning', { retry: true });
    ctx.flush(session);
  }
}

function agentEndText(tool, status) {
  const name = tool.input?.description ? `“${tool.input.description}”` : '';
  const outcome = status === 'completed' ? 'finished' : status === 'stopped' ? 'was stopped' : 'failed';
  return ['Background agent', name, outcome].filter(Boolean).join(' ') + '.';
}

/**
 * Claude Code reports cost and model usage cumulatively for the whole SDK session, and a
 * resumed session continues from the saved totals. The turn's own share is the growth
 * since the last result of the same SDK session (or the whole value after a reset).
 */
function turnUsage(session, message) {
  const cost = message.total_cost_usd || 0;
  const outputTokens = Object.values(message.modelUsage || {}).reduce((sum, usage) => sum + (usage?.outputTokens || 0), 0);
  const base = session.sdkTotals?.sessionId === session.sdkSessionId ? session.sdkTotals : null;
  // Crash and startup-error results may carry zeroed totals; keep the baseline so the
  // next turn's cumulative figure is not counted again in full.
  if (!cost && !outputTokens) return { cost: 0, outputTokens: 0 };
  const grew = base && cost >= base.cost && outputTokens >= base.outputTokens;
  session.sdkTotals = { sessionId: session.sdkSessionId, cost, outputTokens };
  return grew ? { cost: cost - base.cost, outputTokens: outputTokens - base.outputTokens } : { cost, outputTokens };
}

/**
 * Adds usage to the session totals, overall and under the model that spent it
 * (`totals.models[id]`): turns of the main model, and model agents (which run no turn).
 */
export function addUsage(session, modelId, cost, outputTokens, { turn = false } = {}) {
  const totals = session.totals ?? { cost: 0, outputTokens: 0, turns: 0 };
  const models = { ...(totals.models || {}) };
  if (modelId && (cost || outputTokens)) {
    const spent = models[modelId] ?? { cost: 0, outputTokens: 0 };
    models[modelId] = { cost: spent.cost + cost, outputTokens: spent.outputTokens + outputTokens };
  }
  session.totals = {
    cost: totals.cost + cost,
    outputTokens: totals.outputTokens + outputTokens,
    turns: totals.turns + (turn ? 1 : 0),
    ...(Object.keys(models).length ? { models } : {}),
  };
}

function applyResult(session, message, ctx) {
  // Interrupted for the messages sent mid-turn: ended on purpose, like a stop.
  const interrupted = Boolean(ctx.interrupted?.());
  const stopped = Boolean(ctx.stopping?.()) || interrupted;
  session.live = '';
  session.liveThinking = '';
  delete session.compacting;
  // v1's last-turn usage, kept for compatibility.
  session.usage = {
    cost: message.total_cost_usd || 0,
    duration: message.duration_ms || 0,
    turns: message.num_turns,
    models: message.modelUsage,
  };

  const { cost, outputTokens } = turnUsage(session, message);
  const isError = Boolean(message.is_error) && !stopped;
  const model = ctx.model ?? session.model;
  addMessage(session, 'turn', '', {
    duration: message.duration_ms || 0,
    outputTokens,
    cost,
    model,
    isError,
    ...(interrupted ? { interrupted: true } : stopped ? { stopped: true } : {}),
  });
  addUsage(session, model, cost, outputTokens, { turn: true });
  // turnEndedAt is set once, when the runner finishes the turn (unread and notifications key on it).

  if (isError) {
    const text = (message.errors?.length ? message.errors : [message.result || NOTICES.turnFailed]).join('\n');
    // The API error was usually already shown from its synthetic assistant message.
    const shown = session.messages.some((m) => m.role === 'notice' && m.level === 'error' && m.text === text);
    if (!shown) addNotice(session, text, 'error');
    session.status = 'error';
  }
  // Otherwise the status stays as it is: Claude Code can keep working after a result
  // (a background subagent finishing starts another turn), and the runner sets idle
  // when the stream really ends.
  ctx.flush(session);
}

const HANDLERS = {
  stream_event: applyStreamEvent,
  assistant: applyAssistant,
  user: applyUser,
  tool_progress: applyToolProgress,
  system: applySystem,
  result: applyResult,
};

/**
 * Applies one SDK stream message to the session state. Pure apart from the publishing
 * callbacks in `ctx`:
 *   model, effort      catalog model id and effort of the running turn
 *   at                 when the message happened (imported history); default now
 *   contextWindow      the model's context window (catalog)
 *   compactAt          about where Claude Code auto-compacts it
 *   stopping()         true once the user pressed stop
 *   interrupted()      true once the user interrupted the step to send messages at once
 *   tick(session)      throttled `live` event (streaming text)
 *   schedule(session)  throttled full publish
 *   flush(session)     immediate full publish
 */
export function applySdkMessage(session, message, ctx) {
  if (message.session_id && message.session_id !== session.sdkSessionId) {
    // A new conversation: a rewind point in the old one no longer applies.
    delete session.resumeAt;
    session.sdkSessionId = message.session_id;
  }
  const context = { tick: () => {}, schedule: () => {}, flush: () => {}, ...ctx };
  HANDLERS[message.type]?.(session, message, context);
}
