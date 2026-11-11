// One agent's conversation for the agent view in the side panel: where it sits among
// the session's agents (its path, for breadcrumbs and the URL), the messages under its
// card (its own and those of the agents it started), and the render entries built from
// them with the main transcript's builder (lib/transcript.js), framed by its task, its
// report and how it ended.
import { agentStats, agentTask, isAgentTool, isModelAgent, stopReason, stoppedLabel } from './agents.js';
import { formatDuration } from './format.js';
import { agentReport, isAsyncAgentLaunch } from './toolOutput.js';
import { share } from './share.js';
import { buildEntries } from './transcript.js';
import { messageChanges } from '../store.js';

// Claude Code's tool_use ids (`toolu_…`) and Harbor's fallback ids (as on the server).
export const AGENT_ID = /^[A-Za-z0-9_-]{1,200}$/;
// Guards against malformed nesting, as lib/transcript.js does.
const MAX_DEPTH = 16;
// Claude Code's own agents; Claude Code keeps a transcript of each (the server reads it).
const NATIVE_AGENTS = new Set(['Agent', 'Task']);

/**
 * The agents from the top level (or from below `stop`) down to the agent call `toolId`,
 * by the tool calls in `messages`: `[outer, …, toolId]`. Null when `toolId` is not an
 * agent call there.
 */
export function agentPath(messages, toolId, stop = null) {
  const tools = new Map();
  for (const m of messages || []) if (m.role === 'tool' && m.toolId && !tools.has(m.toolId)) tools.set(m.toolId, m);
  let card = tools.get(toolId);
  if (!isAgentTool(card)) return null;
  const path = [];
  while (card && path.length < MAX_DEPTH) {
    if (isAgentTool(card)) path.unshift(card.toolId);
    if (!card.parentToolId || card.parentToolId === stop || card.parentToolId === card.toolId) break;
    card = tools.get(card.parentToolId);
  }
  return path;
}

/**
 * Follows one agent in a message list: `update(list)` returns `{card, messages}`, the
 * agent's call in that list (null when it is not there, as in its own transcript from
 * disk) and every message under it in list order. The result keeps its identity while
 * neither changes. A list made by a delta (store.js) is followed from the messages the
 * delta replaced and added, so a streaming session costs a look at those alone; any
 * other list is read in full.
 */
export function createAgentSubtree(rootId) {
  let list = null;
  let result = { card: null, messages: [] };
  // The agent's own id and every tool call under it: whose children belong to it.
  let members = new Set([rootId]);
  // Message id -> position in result.messages.
  let positions = new Map();

  function scan(source) {
    const parents = new Map();
    for (const m of source) if (m.role === 'tool' && m.toolId && !parents.has(m.toolId)) parents.set(m.toolId, m.parentToolId || '');
    const inside = new Map([[rootId, true]]);
    const under = (toolId, depth = 0) => {
      if (inside.has(toolId)) return inside.get(toolId);
      const parent = parents.get(toolId);
      const yes = !!parent && parent !== toolId && depth < MAX_DEPTH && under(parent, depth + 1);
      inside.set(toolId, yes);
      return yes;
    };
    let card = null;
    const messages = [];
    members = new Set([rootId]);
    positions = new Map();
    for (const m of source) {
      if (m.role === 'tool' && m.toolId === rootId) {
        card ??= m;
        continue;
      }
      if (!m.parentToolId || !under(m.parentToolId)) continue;
      positions.set(m.id, messages.length);
      messages.push(m);
      if (m.role === 'tool' && m.toolId) members.add(m.toolId);
    }
    return { card, messages };
  }

  // Null when the changes cannot be applied on their own (the full read follows).
  function follow(changes) {
    let card = result.card;
    let messages = null;
    for (const m of changes.replaced) {
      if (m.role === 'tool' && m.toolId === rootId) {
        card = m;
        continue;
      }
      const at = positions.get(m.id);
      if (at !== undefined) {
        messages ??= result.messages.slice();
        messages[at] = m;
      } else if (m.parentToolId && members.has(m.parentToolId)) {
        // A message already listed moved under this agent: not in order to append.
        return null;
      }
    }
    for (const m of changes.added) {
      if (m.role === 'tool' && m.toolId === rootId) {
        card ??= m;
        continue;
      }
      if (!m.parentToolId || !members.has(m.parentToolId)) continue;
      messages ??= result.messages.slice();
      positions.set(m.id, messages.length);
      messages.push(m);
      if (m.role === 'tool' && m.toolId) members.add(m.toolId);
    }
    return { card, messages: messages || result.messages };
  }

  return function update(source) {
    const next = source || [];
    if (next === list) return result;
    const changes = list ? messageChanges(next) : null;
    const found = (changes && changes.previous === list && follow(changes)) || scan(next);
    list = next;
    if (found.card !== result.card || found.messages !== result.messages) result = found;
    return result;
  };
}

/**
 * How an agent stands: running, finished, failed, stopped, `launched` (an older
 * background agent whose card ended at its launch; its report came later), or unknown
 * (no card, or a placeholder for an agent only Claude Code's transcripts know).
 */
export function agentOutcome(card) {
  if (!card || card.placeholder) return 'unknown';
  if (card.state === 'running') return 'running';
  if (card.stopped) return 'stopped';
  if (card.state === 'error') return 'failed';
  if (!isModelAgent(card) && isAsyncAgentLaunch(card.output)) return 'launched';
  return 'finished';
}

/**
 * Whether to show Claude Code's own transcript of an agent rather than the steps the
 * session recorded: a Claude Code agent that has ended without any of its steps here
 * (foreground agents of older or imported sessions), or one only known by its id.
 */
export function needsFiles(card, messages) {
  if (!card) return true;
  return NATIVE_AGENTS.has(card.tool) && card.state !== 'running' && !(messages?.length > 0);
}

// Whether Claude Code keeps a transcript of the agent (not of model agents).
export function hasFiles(card) {
  return !card || NATIVE_AGENTS.has(card.tool);
}

/**
 * The agent view's entries: the task as the first user message, the agent's steps and
 * replies as in the main transcript, then (while it runs) the working row, or its report
 * and a closing line. Pass the previous result as `previous` to keep unchanged entries.
 * The agent's last reply is usually its report (Claude Code hands it back as is; a model
 * agent's report adds the files and commands): it shows once, as the report.
 */
export function buildAgentEntries(card, messages, previous = null) {
  const base = buildEntries(messages, previous?.base, { startedAt: card?.at ?? null, root: card?.toolId ?? null });
  const outcome = agentOutcome(card);
  const report = outcome === 'finished' ? agentReport(card.output) : '';
  let body = base.entries;
  if (report) {
    const last = body.findLast((entry) => entry.type === 'assistant');
    const text = last?.message.text?.trim();
    if (text && report.startsWith(text)) body = body.filter((entry) => entry !== last);
  }

  const entries = [];
  const task = agentTask(card);
  if (task) entries.push({ type: 'agent-prompt', key: 'agent-prompt', text: task, at: card.at ?? null });
  entries.push(...body);
  if (outcome === 'running') {
    // A running tool shows itself (its row and elapsed time).
    const tail = body.at(-1);
    if (!(tail?.type === 'activity' && tail.running > 0)) {
      const waitingOn = card.progress?.waitingOn || 0;
      entries.push({ type: 'working', key: 'agent-working', startedAt: card.at || null, since: Math.max(base.lastActivityAt || 0, card.at || 0), tool: null, ...(waitingOn ? { waitingOn } : {}) });
    }
  } else if (outcome === 'launched') {
    entries.push({ type: 'notice', key: 'agent-launched', message: { id: 'agent-launched', role: 'notice', level: 'info', text: 'Started in the background. Its report arrived later in the conversation.' } });
  } else if (outcome !== 'unknown') {
    if (report) entries.push({ type: 'agent-report', key: 'agent-report', text: report });
    else if (outcome === 'failed' && card.output) entries.push({ type: 'agent-report', key: 'agent-report', text: agentReport(card.output), error: true });
    const end = { type: 'agent-end', key: 'agent-end', outcome, stats: endStats(card) };
    if (outcome === 'stopped') Object.assign(end, { label: stoppedLabel(card), reason: stopReason(card) });
    entries.push(end);
  }

  if (previous?.entries?.length) {
    const byKey = new Map(previous.entries.map((entry) => [entry.key, entry]));
    for (let i = 0; i < entries.length; i++) entries[i] = share(byKey.get(entries[i].key), entries[i]);
  }
  return { base, entries };
}

// How many of the latest messages to look through for the copy of a message just sent.
const ARRIVAL_WINDOW = 30;
const NONE = [];

/**
 * The "Sending…" steer entries for messages the user sent this agent from its panel
 * (`sends`, state.agentOutgoing) whose copy has not come back from the server yet: the
 * copy is the agent's message with the same clientId.
 */
export function sendingEntries(sends, sessionId, toolId, messages) {
  const mine = sends.filter((send) => send.sessionId === sessionId && send.toolId === toolId);
  if (!mine.length) return NONE;
  const arrived = new Set();
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - ARRIVAL_WINDOW); i--) if (messages[i].clientId) arrived.add(messages[i].clientId);
  const waiting = mine.filter((send) => !arrived.has(send.clientId));
  if (!waiting.length) return NONE;
  return waiting.map((send) => ({
    type: 'steer',
    key: send.clientId,
    message: { id: send.clientId, role: 'user', text: send.text, parentToolId: toolId, from: 'user', delivery: 'sending', clientId: send.clientId, at: send.at },
  }));
}

// `entries` with the sending ones before the working row (or at the end).
export function withSending(entries, sending) {
  if (!sending.length) return entries;
  return entries.at(-1)?.type === 'working' ? [...entries.slice(0, -1), ...sending, entries.at(-1)] : [...entries, ...sending];
}

// "3 tool uses · 12k tokens · 1m 4s", else how long it took.
function endStats(card) {
  const stats = agentStats(card);
  if (stats) return stats;
  return card.endedAt && card.at ? formatDuration(card.endedAt - card.at) : '';
}

// The name an agent goes by: its description, else its kind.
export function agentLabel(card, kind = '') {
  return card?.input?.description || kind || card?.input?.subagent_type || 'Agent';
}

/* The page URL: `?session=<id>&agent=<outer>&agent=<inner>` while an agent is shown. */

export function agentUrl(sessionId, path = []) {
  if (!sessionId) return '/';
  const params = new URLSearchParams({ session: sessionId });
  for (const toolId of path) params.append('agent', toolId);
  return '?' + params.toString();
}

export function parseAgentUrl(search) {
  const params = new URLSearchParams(search || '');
  const agents = params.getAll('agent').filter((id) => AGENT_ID.test(id)).slice(0, MAX_DEPTH);
  return { session: params.get('session') || null, agents };
}

export function samePath(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
