// Subagents (Agent / Task tool calls) and model agents (Harbor's parallel workers on any
// model, one per `delegate` call): which are still working in the background, what one
// is doing now, the stats of a finished one, and whether one waits for an approval.
import { formatDuration, formatTokens } from './format.js';
import { runningLabel, toolDisplayName } from './tools.js';

export const DELEGATE_TOOL = 'mcp__meshy__delegate';
export const AGENT_TOOLS = new Set(['Agent', 'Task', DELEGATE_TOOL]);
// The lead's other tools for its workers; each names them by the id its delegate call
// returned (`id`, or `ids` for the ones that take several).
export const MESSAGE_TOOL = 'mcp__meshy__message_agent';
export const STOP_TOOL = 'mcp__meshy__stop_agent';
export const WORKER_TOOLS = new Set([MESSAGE_TOOL, STOP_TOOL, 'mcp__meshy__check_agents', 'mcp__meshy__wait_agents']);

export function isAgentTool(message) {
  return message?.role === 'tool' && AGENT_TOOLS.has(message.tool);
}

// A model agent's card: the delegate call that started it.
export function isModelAgent(message) {
  return message?.role === 'tool' && message.tool === DELEGATE_TOOL;
}

// How a stopped agent was stopped: by the lead (its stop_agent call, with a reason it
// gave) or by the user (the Stop button, or the session's own stop).
export const stoppedLabel = (card) => (card?.stoppedBy === 'lead' ? 'Stopped by the lead' : 'Stopped');
export const stopReason = (card) => (typeof card?.stopReason === 'string' ? card.stopReason.trim() : '');

// Who a message to an agent came from, as the rows say it: the user, or the lead (the
// session's main model; imported Claude Code follow-ups carry no `from` and are its too).
export const steerFrom = (message) => (message?.from === 'user' ? 'user' : 'lead');

// What to tell about a message's delivery to the agent (empty once it is read):
// `sent` waits for the agent's next step; `dropped` never got there (it ended first).
export function steerNote(message) {
  if (message?.delivery === 'sent') return 'Read at its next step';
  if (message?.delivery === 'dropped') return 'Not delivered';
  return '';
}

// "GPT-6.1 Sol agent" for a model id (by the catalog in /api/info).
export function modelAgentLabel(id, info) {
  const model = info?.models?.find((m) => m.id === id);
  return `${model?.name || id || 'Model'} agent`;
}

// The same for a model agent's card, else ''.
export function modelAgentName(message, info) {
  if (!isModelAgent(message)) return '';
  return modelAgentLabel(message.agentModel || message.input?.model || '', info);
}

// What kind of agent it is, for badges: the subagent type, or the model agent's model.
export function agentKind(message, info) {
  if (isModelAgent(message)) return modelAgentName(message, info);
  return message?.input?.subagent_type || '';
}

// The model a Claude Code subagent runs on: the Agent call's `model` (an alias the
// catalog shares: opus, sonnet, fable, haiku), else the session's own model, which the
// subagent inherits. "" when neither is known. A model agent's card has its own model.
export function subagentModelLabel(message, info, sessionModel) {
  if (!message || isModelAgent(message)) return '';
  const models = info?.models || [];
  const alias = typeof message.input?.model === 'string' ? message.input.model : '';
  const explicit = models.find((m) => m.id === alias);
  if (explicit) return explicit.name;
  const inherited = models.find((m) => m.id === sessionModel);
  if (inherited) return `${inherited.name} (session model)`;
  return sessionModel || '';
}

// The task an agent was given (Claude Code's `prompt`, a model agent's `task`).
export function agentTask(message) {
  const input = message?.input || {};
  return typeof input.task === 'string' ? input.task : typeof input.prompt === 'string' ? input.prompt : '';
}

// Top-level subagents still running after their turn handed them to the background.
export function runningBackgroundAgents(messages) {
  return (messages || []).filter((m) => isAgentTool(m) && m.state === 'running' && m.background && !m.parentToolId);
}

// The latest tool call a subagent made (its own top level), or null.
export function latestStep(messages, toolId) {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role === 'tool' && m.parentToolId === toolId) return m;
  }
  return null;
}

// One line saying what a running subagent is doing now.
export function agentActivity(agent, step, cwd) {
  if (step) return runningLabel(step, cwd);
  const progress = agent?.progress;
  if (progress?.waitingOn) return progress.description;
  if (progress?.lastTool) return `Using ${toolDisplayName(progress.lastTool)}`;
  return progress?.description || 'Starting…';
}

// "3 tool uses · 12k tokens · 1m 4s" for a subagent that has ended (empty while unknown).
export function agentStats(message) {
  const usage = message?.usage;
  if (!usage) return '';
  const parts = [];
  if (usage.toolUses) parts.push(`${usage.toolUses} ${usage.toolUses === 1 ? 'tool use' : 'tool uses'}`);
  if (usage.tokens) parts.push(`${formatTokens(usage.tokens)} tokens`);
  if (usage.durationMs) parts.push(formatDuration(usage.durationMs));
  return parts.join(' · ');
}

// True when a permission request from inside this subagent waits for the user.
export function agentAwaiting(pending, toolId) {
  return (pending || []).some((p) => p.agent?.toolId === toolId);
}
