// The side panel's agent mode: one agent's conversation (a Claude Code subagent or a
// model agent) drawn with the main transcript's rows and following it live: its task,
// its steps and replies, the agents it started (they open in the same panel, and the
// breadcrumbs lead back) and its report. Steps the session did not record (an agent
// that ran in the foreground of an older or imported session) come from Claude Code's
// own transcript of it, which the server reads from disk (server/agent-transcript.mjs).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Bot, ChevronRight, CircleCheck, CircleStop, FileClock, GitBranch, Hand, LoaderCircle, Maximize2, Minimize2, Square, TriangleAlert, X } from 'lucide-preact';
import { closeAgent, loadAgentFiles, loadAllMessages, showAgentFiles, showOuterAgent, stopAgent, toggleAgentWide } from '../actions.js';
import { shallowEqual, store, useAppState } from '../state.js';
import { heldFrom } from '../store.js';
import { agentAwaiting, agentKind, agentStats, isModelAgent, modelAgentName, stoppedLabel, subagentModelLabel } from '../lib/agents.js';
import { agentLabel, agentOutcome, buildAgentEntries, createAgentSubtree, hasFiles, needsFiles, sendingEntries, withSending } from '../lib/agentTranscript.js';
import { formatTokens } from '../lib/format.js';
import { findModel } from '../lib/models.js';
import { AgentMessageBox } from './AgentMessageBox.jsx';
import { AgentScope } from './agentScope.js';
import { Elapsed } from './Elapsed.jsx';
import { ModelIcon } from './ModelIcon.jsx';
import { TranscriptView } from './Transcript.jsx';
import './AgentPanel.css';

const STATES = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  launched: 'Started in the background',
  unknown: '',
};

export function AgentPanel({ path, wide }) {
  const { sessionId, messages, partial, cwd, info, files, sends, sessionModel } = useAppState(
    (s) => ({ sessionId: s.current?.id, messages: s.current?.messages, partial: heldFrom(s.current) > 0, cwd: s.current?.cwd || '', info: s.info, files: s.agentFiles, sends: s.agentOutgoing, sessionModel: s.current?.model }),
    shallowEqual,
  );
  const toolId = path.at(-1);
  // The agent among the session's messages (followed delta by delta), else among those
  // of an outer agent's transcript from Claude Code; and its own transcript from there.
  const live = useMemo(() => createAgentSubtree(toolId), [toolId]);
  const inOuter = useMemo(() => createAgentSubtree(toolId), [toolId]);
  const inOwn = useMemo(() => createAgentSubtree(toolId), [toolId]);
  const recorded = live(messages);
  const outerList = recorded.card ? null : outerFiles(files, path);
  const outer = outerList ? inOuter(outerList) : null;
  const own = files[toolId] || null;
  const placeholder = useMemo(() => placeholderCard(toolId, own?.data), [toolId, own?.data]);
  // The session is held from its tail and the outermost agent's card is not in it: the
  // agent ran earlier in the session, whose older messages load first.
  // Until that load fails, nothing else is read for it (Claude Code's transcript).
  const outside = partial && !recorded.card && !hasCall(messages, path[0]);
  const [failed, setFailed] = useState(null);
  useEffect(() => {
    if (!outside) return;
    let active = true;
    loadAllMessages().then((loaded) => active && !loaded && setFailed(toolId));
    return () => {
      active = false;
    };
  }, [outside, toolId]);
  const loadingSession = outside && failed !== toolId;
  const card = recorded.card || outer?.card || placeholder;
  const showFiles = !!(own?.shown && own.data);
  const view = showFiles ? inOwn(own.data.messages) : outer || recorded;

  // Claude Code's transcript is read when the session holds none of the agent's steps.
  const wanted = !loadingSession && hasFiles(card) && needsFiles(card, view.messages);
  useEffect(() => {
    if (wanted && !own) loadAgentFiles(toolId);
  }, [wanted, toolId, !!own]);

  const previous = useRef(null);
  const built = useMemo(() => {
    const next = buildAgentEntries(card, view.messages, previous.current);
    previous.current = next;
    return next;
  }, [card, view.messages]);
  const note = filesNote(own, showFiles, view.messages.length > 0);
  // Messages sent from this panel that the server has not echoed yet, after the steps.
  const sending = useMemo(() => sendingEntries(sends, sessionId, toolId, view.messages), [sends, sessionId, toolId, view.messages]);
  const entries = useMemo(() => withSending(built.entries, sending), [built.entries, sending]);
  const [sentNonce, setSentNonce] = useState(0);

  const model = useMemo(() => (isModelAgent(card) ? findModel(info, card.agentModel || card.input?.model) : null), [card, info]);
  const kind = card ? agentKind(card, info) : '';
  const modelLabel = card ? subagentModelLabel(card, info, sessionModel) : '';
  const name = card ? agentLabel(card, kind) : 'Agent';
  // Replies are the agent's: named by its kind, or by a model agent's model.
  const speaker = useMemo(() => (model ? { name: model.name, model } : { name: card?.input?.subagent_type || 'Agent', model: null }), [model, card?.input?.subagent_type]);
  const crumbs = useMemo(() => outerNames(path, files, info), [path, files, info, partial]);

  return (
    <AgentScope.Provider value={path}>
      <header class="panel-head agent-panel-head">
        <span class="agent-panel-icon" aria-hidden="true">
          {model ? <ModelIcon model={model} size={16} /> : <Bot size={16} />}
        </span>
        <nav class="agent-crumbs" aria-label="Agents">
          {crumbs.map((crumb, i) => (
            <span class="agent-crumb-step" key={crumb.id}>
              <button type="button" class="agent-crumb" onClick={() => showOuterAgent(i)} title={`Back to ${crumb.name}`}>
                {crumb.name}
              </button>
              <ChevronRight size={13} class="agent-crumb-sep" aria-hidden="true" />
            </span>
          ))}
          <h2 class="agent-panel-title" title={name}>
            {name}
          </h2>
        </nav>
        {kind && kind !== name && <span class="agent-panel-kind">{kind}</span>}
        {modelLabel && <span class="agent-panel-kind agent-panel-model">{modelLabel}</span>}
        <div class="panel-actions">
          {card?.state === 'running' && card.taskId && <StopButton key={toolId} toolId={toolId} name={name} />}
          <button
            type="button"
            class="icon-btn agent-panel-wide"
            onClick={toggleAgentWide}
            aria-pressed={String(wide)}
            aria-label={wide ? 'Narrow the panel' : 'Widen the panel'}
            title={wide ? 'Narrow' : 'Widen'}
          >
            {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" class="icon-btn" onClick={closeAgent} aria-label="Close agent transcript" title="Close (Esc)">
            <X />
          </button>
        </div>
      </header>
      <AgentStatus card={card} messages={view.messages} toolId={toolId} own={own} showFiles={showFiles} canToggle={!!recorded.card && recorded.messages.length > 0} />
      <div class="agent-panel-body">
        <TranscriptView
          entries={entries}
          viewKey={`${sessionId} ${path.join('/')} ${showFiles ? 'files' : 'live'}`}
          scrollNonce={sentNonce}
          cwd={cwd}
          info={info}
          speaker={speaker}
          empty={own?.loading || loadingSession ? '' : 'Nothing to show for this agent.'}
          before={
            loadingSession ? (
              <p class="agent-files-note is-info" role="note">
                <LoaderCircle size={14} class="spin" />
                <span>Loading the earlier part of the session…</span>
              </p>
            ) : (
              note && (
                <p class={`agent-files-note is-${note.level}`} role="note">
                  {note.level === 'warning' ? <TriangleAlert size={14} /> : own.loading ? <LoaderCircle size={14} class="spin" /> : <FileClock size={14} />}
                  <span>{note.text}</span>
                </p>
              )
            )
          }
          class="agent-transcript"
        />
        {isModelAgent(card) && !showFiles && (
          <AgentMessageBox key={toolId} sessionId={sessionId} toolId={toolId} label={modelAgentName(card, info)} running={card.state === 'running'} onSent={() => setSentNonce((n) => n + 1)} />
        )}
      </div>
    </AgentScope.Provider>
  );
}

// Whether `messages` holds the tool call `toolId`.
function hasCall(messages, toolId) {
  return !!toolId && (messages || []).some((m) => m.role === 'tool' && m.toolId === toolId);
}

// The transcript (from Claude Code) of the innermost outer agent that has one loaded.
function outerFiles(files, path) {
  for (let i = path.length - 2; i >= 0; i--) {
    const data = files[path[i]]?.data;
    if (data) return data.messages;
  }
  return null;
}

// An agent known only from Claude Code's transcript (no card here): named by its files.
function placeholderCard(toolId, data) {
  if (!data) return null;
  return { id: 'agent-' + toolId, role: 'tool', tool: 'Agent', toolId, input: { description: data.description, subagent_type: data.agentType }, placeholder: true };
}

// The outer agents' names for the breadcrumbs, from their cards (in the session or in
// a transcript from Claude Code). Read when the path changes, not on every update.
function outerNames(path, files, info) {
  const messages = store.get().current?.messages || [];
  const lists = [messages, ...Object.values(files).map((entry) => entry.data?.messages || [])];
  return path.slice(0, -1).map((id) => {
    let card = null;
    for (const list of lists) {
      card = list.find((m) => m.role === 'tool' && m.toolId === id);
      if (card) break;
    }
    return { id, name: card ? agentLabel(card, agentKind(card, info)) : files[id]?.data ? agentLabel(placeholderCard(id, files[id].data)) : 'Agent' };
  });
}

// A line above a transcript from Claude Code (or while it loads, or why it could not).
function filesNote(own, showFiles, hasSteps) {
  if (!own) return null;
  const note = (level, text) => ({ level, text });
  if (own.loading && own.shown) return note('info', "Reading Claude Code's transcript of this agent…");
  if (own.error && own.shown) return hasSteps ? note('warning', `Could not read Claude Code's transcript: ${own.error.message}`) : note('info', own.error.message);
  if (!showFiles) return null;
  const left = own.data.omitted ? ` The first ${own.data.omitted.toLocaleString('en-US')} messages are left out.` : own.data.partial ? ' Its beginning is left out (a very long file).' : '';
  return note('info', `From Claude Code's transcript of this agent.${left}`);
}

// State, time and stats under the header, and the switch to Claude Code's transcript.
function AgentStatus({ card, messages, toolId, own, showFiles, canToggle }) {
  const outcome = agentOutcome(card);
  const awaiting = useAppState((s) => outcome === 'running' && agentAwaiting(s.current?.pending, toolId));
  const steps = useMemo(() => messages.reduce((n, m) => n + (m.role === 'tool' ? 1 : 0), 0), [messages]);
  let stats = '';
  if (outcome === 'running') {
    const uses = Math.max(steps, card.progress?.toolUses || 0);
    const parts = [`${uses} ${uses === 1 ? 'tool use' : 'tool uses'}`];
    if (card.progress?.tokens) parts.push(`${formatTokens(card.progress.tokens)} tokens`);
    stats = parts.join(' · ');
  } else if (card && !card.placeholder) {
    stats = agentStats(card) || (steps ? `${steps} ${steps === 1 ? 'tool use' : 'tool uses'}` : '');
  }
  const label = awaiting ? 'Needs approval' : outcome === 'stopped' ? stoppedLabel(card) : STATES[outcome] || '';
  const Icon = awaiting ? Hand : outcome === 'running' ? LoaderCircle : outcome === 'failed' ? TriangleAlert : outcome === 'stopped' ? CircleStop : CircleCheck;
  // Claude Code keeps a transcript of its own agents; it can replace the recorded steps.
  const toggle = canToggle && hasFiles(card) && outcome !== 'running';
  return (
    <div class="agent-status" role="status">
      {label && (
        <span class={`agent-state is-${awaiting ? 'awaiting' : outcome}`}>
          <Icon size={13} class={outcome === 'running' && !awaiting ? 'spin' : ''} aria-hidden="true" />
          {label}
        </span>
      )}
      {outcome === 'running' && <Elapsed since={card.at} elapsed={card.elapsed ?? null} class="agent-status-time" />}
      {stats && <span class="agent-status-stats">{stats}</span>}
      {card?.worktree?.branch && (
        <span class="agent-status-branch" title={card.worktree.path}>
          <GitBranch size={12} aria-hidden="true" />
          <span>{card.worktree.branch}</span>
        </span>
      )}
      {toggle && (
        <button
          type="button"
          class={`agent-files-btn ${showFiles ? 'is-on' : ''}`}
          onClick={() => showAgentFiles(toolId, !showFiles)}
          aria-pressed={String(showFiles)}
          disabled={own?.loading}
          title={showFiles ? 'Show the steps this session recorded' : "Read the agent's whole transcript from Claude Code's files"}
        >
          {own?.loading ? <LoaderCircle size={13} class="spin" /> : <FileClock size={13} />}
          Full transcript
        </button>
      )}
    </div>
  );
}

// Stops just this agent; the session carries on without its report.
function StopButton({ toolId, name }) {
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await stopAgent(toolId);
  };
  return (
    <button type="button" class="btn btn-sm btn-ghost agent-panel-stop" onClick={stop} disabled={stopping} title={`Stop ${name}; Claude carries on without its report`}>
      <Square size={11} fill="currentColor" />
      {stopping ? 'Stopping…' : 'Stop'}
    </button>
  );
}
