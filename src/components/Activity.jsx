// Tool activity in the transcript: groups of consecutive tool calls with a natural
// summary, compact rows (icon, verb, target, status) that expand into the tool's
// detail card, nested subagent steps, and thinking rows.
import { useMemo, useState } from 'preact/hooks';
import {
  AppWindow,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleStop,
  ClipboardList,
  CornerDownRight,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  Hand,
  Globe,
  Hourglass,
  ListChecks,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestionMark,
  MessageSquareText,
  NotebookPen,
  PanelRightOpen,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-preact';
import { memo } from '../memo.js';
import { countRender } from '../lib/debug.js';
import { useAppState } from '../state.js';
import { firstLine, formatDuration } from '../lib/format.js';
import { groupSummary, runningLabel, toolSummary } from '../lib/tools.js';
import { isAsyncAgentLaunch } from '../lib/toolOutput.js';
import { STOP_TOOL, agentActivity, agentAwaiting, agentKind, agentStats, isAgentTool, isModelAgent, modelAgentLabel, modelAgentName, steerFrom, steerNote, stoppedLabel } from '../lib/agents.js';
import { activityTools, currentTool } from '../lib/transcript.js';
import { Elapsed } from './Elapsed.jsx';
import { Markdown } from './Markdown.jsx';
import { DiffStats } from './DiffStats.jsx';
import { countSteps } from './tools/Agent.jsx';
import { ToolDetail } from './tools/index.jsx';
import { useOpenAgent } from './agentScope.js';
import { openTask } from '../actions.js';
import './Activity.css';

const KIND_ICONS = {
  terminal: SquareTerminal,
  file: FileText,
  edit: FilePen,
  write: FilePlus,
  notebook: NotebookPen,
  search: Search,
  folder: FolderOpen,
  web: Globe,
  agent: Bot,
  tasks: ListTodo,
  skill: Sparkles,
  plan: ClipboardList,
  question: MessageCircleQuestionMark,
  plug: Plug,
  wait: Hourglass,
  message: MessageSquareText,
  stop: CircleStop,
  check: ListChecks,
  artifact: AppWindow,
  tool: Wrench,
};

export function ActivityGroup({ entry, cwd }) {
  countRender('ActivityGroup');
  const [userOpen, setUserOpen] = useState(null);
  const running = entry.running > 0;
  const tools = useMemo(() => activityTools(entry), [entry]);
  // A lone tool call needs no group header: its row already says what happened.
  if (entry.items.length === 1 && entry.items[0].kind === 'tool') {
    return (
      <div class="activity is-single">
        <ToolRow node={entry.items[0]} cwd={cwd} />
      </div>
    );
  }
  const open = userOpen ?? running;
  const current = running ? currentTool(entry) : null;
  return (
    <div class={`activity ${open ? 'is-open' : ''} ${running ? 'is-running' : ''}`}>
      <button type="button" class="activity-head" onClick={() => setUserOpen(!open)} aria-expanded={String(open)}>
        <ChevronRight size={14} class="chevron" />
        {running ? (
          <span class="activity-label">
            <span class="shimmer">Working</span>
            <span class="activity-sep">·</span>
            <span class="activity-current">{current ? runningLabel(current, cwd) : `${tools.length} steps`}</span>
            {current && (
              <>
                <span class="activity-sep">·</span>
                <Elapsed since={current.at} elapsed={current.elapsed ?? null} class="activity-time" />
              </>
            )}
          </span>
        ) : (
          <span class="activity-label">
            <span class="activity-summary">{groupSummary(tools)}</span>
          </span>
        )}
        {entry.errors > 0 && (
          <span class="activity-errors">
            {entry.errors} {entry.errors === 1 ? 'error' : 'errors'}
          </span>
        )}
        {running && <LoaderCircle size={14} class="spin activity-spinner" />}
      </button>
      {open && (
        <div class="activity-list">
          <Nodes nodes={entry.items} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

// Renders activity nodes: tool rows, thinking rows, and (inside a subagent) the
// subagent's own replies as small markdown and the messages sent to it as one line.
function Nodes({ nodes, cwd }) {
  return nodes.map((node) =>
    node.kind === 'tool' ? (
      <ToolRow key={node.message.id} node={node} cwd={cwd} />
    ) : node.kind === 'thinking' ? (
      <ThinkingRow key={node.message.id} node={node} />
    ) : node.kind === 'steer' ? (
      <SteerRow key={node.message.id} message={node.message} />
    ) : (
      <div class="child-text" key={node.message.id}>
        <Markdown text={node.message.text} class="markdown-sm" />
      </div>
    ),
  );
}

// "↳ Lead: Also cover the lexer": a message the lead or the user sent a running agent,
// as a step of its card. The whole text is in the tooltip and the agent's transcript.
const SteerRow = memo(function SteerRow({ message }) {
  const lead = steerFrom(message) === 'lead';
  const note = steerNote(message);
  return (
    <div class={`steer-row ${message.delivery === 'dropped' ? 'is-dropped' : ''}`} title={message.text}>
      <CornerDownRight size={13} class="steer-icon" aria-hidden="true" />
      <span class="steer-who">{lead ? 'Lead:' : 'You:'}</span>
      <span class="steer-text">{firstLine(message.text, 200)}</span>
      {note && <span class="steer-note">{note}</span>}
    </div>
  );
});

const ThinkingRow = memo(function ThinkingRow({ node }) {
  return <ThinkingBlock text={node.message.text} duration={node.duration} compact />;
});

function ToolStatus({ message, isAgent = false }) {
  // Only rows with a pending approval re-render when the pending list changes. A
  // subagent's row also shows a request from inside it (its own rows may be folded).
  const awaiting = useAppState(
    (s) =>
      message.state === 'running' &&
      Boolean(s.current?.pending?.some((p) => p.toolUseID === message.toolId) || (isAgent && agentAwaiting(s.current?.pending, message.toolId))),
  );
  if (awaiting) {
    return (
      <span class="tool-status awaiting">
        <span>Needs approval</span>
        <Hand size={14} aria-hidden="true" />
      </span>
    );
  }
  if (message.state === 'running') {
    return (
      <span class="tool-status running">
        <Elapsed since={message.at} elapsed={message.elapsed ?? null} />
        <LoaderCircle size={14} class="spin" aria-label="Running" />
      </span>
    );
  }
  const took = message.endedAt && message.at ? formatDuration(message.endedAt - message.at) : '';
  if (message.state === 'error') {
    const label = message.stopped ? stoppedLabel(message) : 'Failed';
    return (
      <span class="tool-status error" title={took ? `${label} after ${took}` : label}>
        <X size={14} aria-label={label} />
      </span>
    );
  }
  return (
    <span class="tool-status done" title={took ? `Took ${took}` : 'Done'}>
      <Check size={14} aria-label="Done" />
    </span>
  );
}

// While a subagent runs and its card is closed, a muted line shows its latest step.
function AgentProgress({ node, cwd }) {
  const last = [...(node.children || [])].reverse().find((child) => child.kind === 'tool');
  const text = agentActivity(node.message, last?.message, cwd);
  return (
    <div class="tool-subline" aria-live="polite">
      <span class="tool-subline-text">{text}</span>
    </div>
  );
}

export const ToolRow = memo(function ToolRow({ node, cwd }) {
  countRender('ToolRow');
  const { message } = node;
  const [open, setOpen] = useState(false);
  // The lead's tools for its workers name them by model and description.
  const info = useAppState((s) => (node.workers ? s.info : null));
  const workers = useMemo(() => node.workers?.map((worker) => ({ ...worker, name: modelAgentLabel(worker.model, info) })), [node.workers, info]);
  const summary = toolSummary(message, cwd, workers);
  const Icon = KIND_ICONS[summary.kind] || Wrench;
  const isAgent = isAgentTool(message);
  const modelAgent = isModelAgent(message);
  // A model agent's badge names its model ("GPT-6.1 Sol agent"); the catalog rarely changes.
  const agentBadge = useAppState((s) => (isAgent ? agentKind(message, s.info) : ''));
  // stop_agent says which worker it stopped, as the delegate card names its model.
  const workerBadge = message.tool === STOP_TOOL && workers?.length === 1 ? workers[0].name : '';
  const kind = agentBadge || workerBadge;
  const steps = isAgent ? Math.max(countSteps(node.children), message.progress?.toolUses || 0) : 0;
  // A finished subagent says what it took (tool uses, tokens, time), as Claude Code does.
  const stats = isAgent && message.state !== 'running' ? agentStats(message) : '';
  const state = message.state || 'done';
  const verb = isAgent && message.stopped ? 'Stopped agent' : summary.verb;
  // Model agents always run alongside the main model; their model badge says enough.
  const background = !modelAgent && (message.input?.run_in_background || message.background || (isAgent && message.state === 'done' && isAsyncAgentLaunch(message.output)));
  // A background command or Monitor: live while Claude Code still runs it, and one click
  // from its output in the Background tab.
  const task = !isAgent && !modelAgent && message.taskId && (message.task || message.background) ? message.taskId : null;
  const taskRunning = useAppState((s) => (task ? Boolean(s.current?.liveTasks?.some((t) => t.id === task)) : false));
  const tooltip = message.tool === 'Bash' ? message.input?.description || message.input?.command : undefined;
  return (
    <div class={`tool tool-${state} ${open ? 'is-open' : ''} ${isAgent ? 'is-agent' : ''} ${task ? 'is-task' : ''}`}>
      <button type="button" class="tool-row" onClick={() => setOpen(!open)} aria-expanded={String(open)} title={tooltip}>
        <Icon size={14} class="tool-icon" />
        <span class="tool-verb">{verb}</span>
        {summary.target && (
          <span class={`tool-target ${summary.mono ? 'mono' : ''} ${summary.path ? 'is-path' : ''}`}>
            {summary.path ? <bdi>{summary.target}</bdi> : summary.target}
          </span>
        )}
        {summary.stats && <DiffStats adds={summary.stats.adds} dels={message.tool === 'Write' ? 0 : summary.stats.dels} />}
        {kind && <span class={`tool-badge ${modelAgent || workerBadge ? 'badge-model' : ''}`}>{kind}</span>}
        {isAgent && (stats || steps > 0) && (
          <span class="tool-meta">
            {stats || `${steps} ${steps === 1 ? 'step' : 'steps'}`}
          </span>
        )}
        {(background || task) && <span class={`tool-badge badge-info ${taskRunning ? 'is-live' : ''}`}>{taskRunning ? 'running in background' : 'background'}</span>}
        <ToolStatus message={message} isAgent={isAgent} />
      </button>
      {isAgent && <OpenAgentButton message={message} name={summary.target || kind} />}
      {task && (
        <button type="button" class="icon-btn icon-btn-sm agent-open-btn" onClick={() => openTask(task)} aria-label="Show in the Background tab" title="Show output in the Background tab">
          <PanelRightOpen size={14} />
        </button>
      )}
      {isAgent && state === 'running' && !open && <AgentProgress node={node} cwd={cwd} />}
      {open && <ToolDetail node={node} cwd={cwd} Children={Nodes} />}
    </div>
  );
});

// Opens an agent's transcript in the side panel (next to its row, which expands in place).
function OpenAgentButton({ message, name, class: className = '' }) {
  const open = useOpenAgent();
  return (
    <button
      type="button"
      class={`icon-btn icon-btn-sm agent-open-btn ${className}`}
      onClick={() => open(message.toolId)}
      aria-label={`Open the transcript of ${name || 'this agent'}`}
      title="Open transcript"
    >
      <PanelRightOpen size={14} />
    </button>
  );
}

// A background subagent ended (long after the turn that started it): one line where
// Claude Code starts the turn that reads its report. It opens on the agent's steps and
// report in place, since its original card often sits in a collapsed group far above,
// and its button opens the agent's whole transcript in the side panel.
export function AgentEvent({ entry, cwd }) {
  const { node, message } = entry;
  const [open, setOpen] = useState(false);
  const agent = node.message;
  const outcome = agent.stopped ? 'stopped' : agent.state === 'error' ? 'failed' : 'finished';
  const Icon = outcome === 'finished' ? Check : X;
  const model = useAppState((s) => modelAgentName(agent, s.info));
  const name = agent.input?.description || model || agent.input?.subagent_type || 'Background agent';
  const stats = agentStats(agent);
  return (
    <div class={`agent-event is-${outcome} ${open ? 'is-open' : ''}`} role="note" aria-label={message.text}>
      <button type="button" class="agent-event-row" onClick={() => setOpen(!open)} aria-expanded={String(open)}>
        <Icon size={14} class="agent-event-icon" aria-hidden="true" />
        <span class="agent-event-name">{name}</span>
        {model && name !== model && <span class="agent-event-kind">{model}</span>}
        <span class="agent-event-outcome">{outcome === 'stopped' ? stoppedLabel(agent).toLowerCase() : outcome}</span>
        {stats && <span class="agent-event-stats">{stats}</span>}
        <ChevronRight size={14} class="chevron" aria-hidden="true" />
      </button>
      <OpenAgentButton message={agent} name={name} />
      {open && (
        <div class="agent-event-detail">
          <ToolDetail node={node} cwd={cwd} Children={Nodes} />
        </div>
      )}
    </div>
  );
}

// "Thinking…" (live, with the latest streamed line) or "Thought for 12s"; expands
// to the full text.
export function ThinkingBlock({ text, duration = null, live = false, compact = false }) {
  const [open, setOpen] = useState(false);
  const seconds = duration != null ? Math.max(1, Math.round(duration / 1000)) : null;
  const label = live ? 'Thinking…' : seconds ? `Thought for ${formatDuration(seconds * 1000)}` : 'Thought';
  const latest = live && !open ? latestLine(text) : '';
  return (
    <div class={`thinking ${open ? 'is-open' : ''} ${compact ? 'is-compact' : ''} ${live ? 'is-live' : ''}`}>
      <button type="button" class="thinking-toggle" onClick={() => setOpen(!open)} aria-expanded={String(open)}>
        <Brain size={14} class="thinking-icon" />
        <span class={live ? 'shimmer' : ''}>{label}</span>
        {latest && <span class="thinking-latest">{latest}</span>}
        <ChevronRight size={14} class="chevron" />
      </button>
      {open && <div class="thinking-text">{text}</div>}
    </div>
  );
}

function latestLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) || '';
  return last.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '');
}
