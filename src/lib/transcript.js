// Turns a session's flat message list into render entries for the transcript.
import { DELEGATE_TOOL, WORKER_TOOLS } from './agents.js';
import { isPublishedArtifact, workerIds } from './tools.js';
import { share } from './share.js';

// Queued and mid-turn ('sent') messages show in the bar above the composer until they
// run or Claude reads them; cancelled ones never show.
const HIDDEN_DELIVERY = new Set(['queued', 'sent', 'cancelled']);
// Guards against malformed nesting (a tool listed as its own ancestor).
const MAX_NESTING = 8;

// Entry types: user, assistant, thinking, notice, agent-event (a background subagent
// ended: the notice plus its Agent call's node), turn, activity (consecutive tool
// calls, plus the thinking between them), steer (a message to the agent whose
// transcript this is, agent view only), and transient ones derived from live state:
// live-thinking, live, working, summary (v1 last-turn footer when the server sends no
// `turn` messages).
//
// An activity entry holds `items`: nodes of { kind: 'tool', message, children } or
// { kind: 'thinking', message, duration }. A tool's `children` are the nodes of its
// subagent (messages whose parentToolId is the tool's toolId), including
// { kind: 'text', message } for the subagent's own replies and { kind: 'steer', message }
// for the messages the lead or the user sent it. A user message under an agent
// (`parentToolId`) is never a turn of the conversation it sits in: it is only shown in
// that agent's own view (steer entry) and as a step of its card (steer node). A tool
// that names workers (message_agent, stop_agent, check_agents, wait_agents) carries
// them as `workers`, from the delegate cards: [{ id, toolId, model, description }].
export function buildTranscript(session) {
  const base = buildEntries(session?.messages);
  return [...base.entries, ...liveEntries(session, base)];
}

// Milliseconds each thinking message took. The server stamps `at` when a content
// block arrives, which is when it finished, so a thinking block ran from the end of
// the previous message in the same scope (top level, or the same subagent) to its
// own `at`. The first block of a turn starts when the user message started running;
// the first block of a subagent when its Agent call was made. Unknown (missing
// timestamps) is left out.
function thinkingDurations(messages, scopeOf, scopeStart) {
  const durations = new Map();
  const previous = new Map();
  for (const m of messages) {
    // Queued messages sit mid-turn in the list until they start; they end nothing.
    // Nor does one sent to an agent: it is read at the agent's next step.
    if (m.role === 'user' && (m.parentToolId || HIDDEN_DELIVERY.has(m.delivery))) continue;
    const scope = scopeOf(m);
    if (m.role === 'thinking' && m.at) {
      const start = previous.has(scope) ? endOf(previous.get(scope), m.at) : scopeStart(scope);
      if (start) durations.set(m, Math.max(0, m.at - start));
    }
    previous.set(scope, m);
  }
  return durations;
}

// When `message` stopped occupying the timeline before something that finished at
// `before`: a user message when its turn started; anything else when it ended (a
// tool that was still running then counts from when it was called).
function endOf(message, before) {
  if (message.role === 'user') return message.startedAt || message.at || null;
  if (message.endedAt && message.endedAt <= before) return message.endedAt;
  return message.at || null;
}

// The entries that depend only on the message list. Pass the previous result as
// `previous` to reuse every entry whose content is unchanged (same object), so
// memoized rows re-render only when their own messages change. `startedAt` is when the
// top level began, for a list without user messages (an agent's, from its call); `root`
// is that agent's call id, whose messages are the top level and so are not nested.
export function buildEntries(list, previous = null, { startedAt = null, root = null } = {}) {
  const messages = list || [];
  // toolId -> when the call was made (a subagent's scope starts there).
  const toolStarts = new Map();
  const toolsById = new Map();
  // Model agent id (as the lead names it) -> its card's identity, for tools that name one.
  const workers = new Map();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    if (m.tool === DELEGATE_TOOL && m.agentId && !workers.has(m.agentId)) {
      workers.set(m.agentId, { id: m.agentId, toolId: m.toolId, model: m.agentModel || m.input?.model || '', description: m.input?.description || '' });
    }
    if (!m.toolId || toolStarts.has(m.toolId)) continue;
    toolStarts.set(m.toolId, m.at || null);
    toolsById.set(m.toolId, m);
  }
  const isNested = (m) => !!m.parentToolId && toolStarts.has(m.parentToolId);
  const durations = thinkingDurations(messages, (m) => (isNested(m) ? m.parentToolId : ''), (scope) => (scope ? toolStarts.get(scope) : startedAt));

  const childMessages = new Map();
  for (const m of messages) {
    if (!isNested(m)) continue;
    if (!childMessages.has(m.parentToolId)) childMessages.set(m.parentToolId, []);
    childMessages.get(m.parentToolId).push(m);
  }

  const thinkingNode = (m) => ({ kind: 'thinking', message: m, duration: durations.get(m) ?? null });
  const toolNode = (m, depth = 0) => {
    const node = {
      kind: 'tool',
      message: m,
      children: depth >= MAX_NESTING ? [] : (childMessages.get(m.toolId) || []).map((child) => childNode(child, depth + 1)).filter(Boolean),
    };
    const named = WORKER_TOOLS.has(m.tool) ? workerIds(m).map((id) => workers.get(id)).filter(Boolean) : [];
    if (named.length) node.workers = named;
    return node;
  };
  const childNode = (m, depth) => {
    if (m.role === 'tool') return m.toolId === m.parentToolId ? null : toolNode(m, depth);
    if (m.role === 'thinking' && m.text) return thinkingNode(m);
    if (m.role === 'assistant' && m.text) return { kind: 'text', message: m };
    if (m.role === 'user' && m.text) return { kind: 'steer', message: m };
    return null;
  };

  const entries = [];
  let pendingThinking = [];
  let assistantSeen = false;
  // The model named by the last reply header: a turn's first reply is headed only when
  // the model changed (the first reply always is).
  let headerModel = NO_HEADER;
  let hasTurnFooters = false;
  let runningTool = null;
  let lastActivityAt = 0;

  // Thinking right before a tool call joins that tool's activity group; otherwise
  // it is shown on its own before whatever follows.
  const flushThinking = () => {
    for (const m of pendingThinking) entries.push({ type: 'thinking', key: m.id, message: m, duration: durations.get(m) ?? null });
    pendingThinking = [];
  };

  for (const m of messages) {
    if (isNested(m)) continue;
    if (m.role === 'user' && m.parentToolId) {
      // A message to an agent whose call is not in this list (its parent is cut off, or
      // this list is the agent's own): a step of the agent's view, never a turn.
      if (m.parentToolId === root && m.text) {
        flushThinking();
        // Keyed as the "Sending…" row it replaces (lib/agentTranscript.js), so it stays put.
        entries.push({ type: 'steer', key: m.clientId || m.id, message: m });
        assistantSeen = false;
      }
      continue;
    }
    lastActivityAt = Math.max(lastActivityAt, m.endedAt || 0, m.at || 0);
    if (m.role === 'user' && HIDDEN_DELIVERY.has(m.delivery)) continue;
    if (m.role === 'thinking') {
      if (m.text) pendingThinking.push(m);
      continue;
    }
    if (m.role === 'tool' && isPublishedArtifact(m)) {
      flushThinking();
      entries.push({ type: 'artifact', key: 'artifact-' + (m.toolId || m.id), message: m });
      continue;
    }
    if (m.role === 'tool') {
      if (m.state === 'running') runningTool = m;
      let group = entries.at(-1);
      if (group?.type !== 'activity') {
        group = { type: 'activity', key: 'activity-' + (pendingThinking[0]?.id || m.id), items: [], tools: 0, running: 0, errors: 0 };
        entries.push(group);
      }
      for (const thinking of pendingThinking) group.items.push(thinkingNode(thinking));
      pendingThinking = [];
      group.items.push(toolNode(m));
      group.tools += 1;
      if (m.state === 'running') group.running += 1;
      if (m.state === 'error') group.errors += 1;
      continue;
    }
    flushThinking();
    if (m.role === 'user') {
      assistantSeen = false;
      entries.push({ type: 'user', key: m.id, message: m });
    } else if (m.role === 'assistant') {
      const showHeader = !assistantSeen && m.model !== headerModel;
      if (showHeader) headerModel = m.model;
      entries.push({ type: 'assistant', key: m.id, message: m, showHeader });
      assistantSeen = true;
    } else if (m.role === 'turn') {
      hasTurnFooters = true;
      entries.push({ type: 'turn', key: m.id, message: m });
    } else if (m.role === 'notice' && m.agentToolId && toolsById.has(m.agentToolId)) {
      // A background subagent ended: its card again, where Claude picks up its report.
      entries.push({ type: 'agent-event', key: m.id, message: m, node: toolNode(toolsById.get(m.agentToolId)) });
      assistantSeen = false;
    } else if (m.role === 'notice') {
      entries.push({ type: 'notice', key: m.id, message: m });
    }
  }
  flushThinking();
  markTurnEnds(entries);

  if (previous?.entries?.length) {
    const byKey = new Map(previous.entries.map((entry) => [entry.key, entry]));
    for (let i = 0; i < entries.length; i++) entries[i] = share(byKey.get(entries[i].key), entries[i]);
  }
  return { entries, assistantSeen, headerModel, hasTurnFooters, runningTool, lastActivityAt, messageCount: messages.length };
}

// No reply header shown yet (any model, even none, differs from it).
const NO_HEADER = Symbol('no header');

// The transient entries after the messages: streaming thinking and text, the working
// indicator (thinking or waiting; a running tool shows in its own row), or the v1
// usage footer. Cheap; recomputed on every streaming tick.
export function liveEntries(session, base) {
  if (!session) return [];
  const entries = [];
  const busy = session.status === 'running' || session.status === 'waiting';
  const turnKey = session.currentMessageId || 'turn';
  // A running tool already shows itself (row, group header, elapsed time); the
  // working row is only for thinking and waiting for an approval.
  const last = base.entries?.at(-1);
  const toolShown = session.status === 'running' && last?.type === 'activity' && last.running > 0;
  if (session.liveThinking) {
    entries.push({ type: 'live-thinking', key: 'live-thinking-' + turnKey, text: session.liveThinking });
  }
  if (session.live) {
    entries.push({ type: 'live', key: 'live-' + turnKey, text: session.live, showHeader: !base.assistantSeen && session.model !== base.headerModel });
  } else if (busy && !session.liveThinking && !toolShown) {
    const waiting = session.status === 'waiting';
    const tool = base.runningTool;
    entries.push({
      type: 'working',
      key: 'working-' + turnKey,
      startedAt: turnStartedAt(session),
      waiting,
      tool: tool?.tool || null,
      toolAt: tool?.at || null,
      toolElapsed: tool?.elapsed ?? null,
      // Claude Code is summarizing the conversation (auto-compact or /compact).
      compacting: session.compacting || null,
      // When nothing is running the model is thinking since the last activity.
      since: waiting ? session.pending?.[0]?.at || base.lastActivityAt : Math.max(base.lastActivityAt || 0, turnStartedAt(session)),
    });
  } else if (!busy && !base.hasTurnFooters && session.usage && base.messageCount) {
    const tokens = Object.values(session.usage.models || {}).reduce((n, m) => n + (m.outputTokens || 0), 0);
    entries.push({ type: 'summary', key: 'turn-summary', duration: session.usage.duration || 0, tokens, cost: session.usage.cost || 0 });
  }
  return entries;
}

// The last assistant entry of each turn carries the turn's full reply text, which
// the copy action uses. A turn that ended normally right after that reply hands it its
// stats (`footer`, shown with the reply's actions) instead of a row of its own.
function markTurnEnds(entries) {
  let texts = [];
  let last = null;
  const close = () => {
    if (last) {
      last.turnEnd = true;
      last.turnText = texts.join('\n\n');
    }
    texts = [];
    last = null;
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'user') close();
    else if (entry.type === 'assistant') {
      texts.push(entry.message.text || '');
      last = entry;
    } else if (entry.type === 'turn' && last && entries[i - 1] === last && endedNormally(entry.message)) {
      last.footer = entry.message;
      entry.merged = true;
    }
  }
  close();
}

const endedNormally = (turn) => !turn.isError && !turn.stopped && !turn.interrupted;

export function turnStartedAt(session) {
  const messages = session?.messages || [];
  const current = messages.find((m) => m.id === session?.currentMessageId);
  // The latest message of the conversation (not one sent to an agent).
  return current?.startedAt || current?.at || messages.findLast((m) => m.role === 'user' && !m.parentToolId)?.at || Date.now();
}

// Tool messages of an activity entry (top level only), for its summary.
export function activityTools(entry) {
  return entry.items.filter((node) => node.kind === 'tool').map((node) => node.message);
}

// The tool to name in a running group's header: the latest one still running.
export function currentTool(entry) {
  for (let i = entry.items.length - 1; i >= 0; i--) {
    const node = entry.items[i];
    if (node.kind === 'tool' && node.message.state === 'running') return node.message;
  }
  return null;
}
