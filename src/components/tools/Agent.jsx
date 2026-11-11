// Agent / Task: the subagent's type and prompt, its nested activity (rendered with
// the same compact rows, recursively) and its final report. Harbor's model agents (the
// delegate tool) use the same card, named by their model, with their task and branch.
// The whole conversation opens in the side panel (AgentPanel.jsx).
import { useState } from 'preact/hooks';
import { Bot, ChevronRight, CircleStop, GitBranch, Layers, LoaderCircle, PanelRightOpen, Square } from 'lucide-preact';
import { stopAgent } from '../../actions.js';
import { useAppState } from '../../state.js';
import { agentTask, isModelAgent, modelAgentName, stopReason, stoppedLabel } from '../../lib/agents.js';
import { agentReport, isAsyncAgentLaunch } from '../../lib/toolOutput.js';
import { formatTokens } from '../../lib/format.js';
import { Markdown } from '../Markdown.jsx';
import { useOpenAgent } from '../agentScope.js';
import { Chip, Clamp, Note, OutputBlock, Section } from './shared.jsx';

// Most recent steps shown first time; older ones behind a button.
const RECENT_STEPS = 40;

// Tool calls in a subagent tree (nested agents count their own steps too).
export function countSteps(children) {
  let steps = 0;
  for (const node of children || []) {
    if (node.kind !== 'tool') continue;
    steps += 1 + countSteps(node.children);
  }
  return steps;
}

export function AgentDetail({ message, output, node, cwd, Children }) {
  const input = message.input || {};
  const modelAgent = isModelAgent(message);
  const modelName = useAppState((s) => modelAgentName(message, s.info));
  const task = agentTask(message);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const running = message.state === 'running';
  const children = node.children || [];
  const steps = Math.max(countSteps(children), message.progress?.toolUses || 0);
  const hidden = showOlder ? 0 : Math.max(0, children.length - RECENT_STEPS);
  const launched = !modelAgent && message.state === 'done' && isAsyncAgentLaunch(output);
  const report = message.state === 'done' && !launched ? agentReport(output) : '';
  const openAgent = useOpenAgent();
  return (
    <>
      <div class="agent-head">
        <Chip tone="accent">
          <Bot size={12} />
          {modelAgent ? modelName : input.subagent_type || 'general-purpose'}
        </Chip>
        {input.model && !modelAgent && <Chip>{input.model}</Chip>}
        {modelAgent && input.effort && <Chip>{input.effort} effort</Chip>}
        {input.isolation && <Chip>{input.isolation}</Chip>}
        <span class="agent-desc">{input.description}</span>
        <button type="button" class="btn btn-sm btn-ghost agent-open" onClick={() => openAgent(message.toolId)} title="Open the whole conversation in the side panel">
          <PanelRightOpen size={13} />
          Transcript
        </button>
        {running && message.taskId && <StopAgentButton toolId={message.toolId} />}
      </div>

      {task && (
        <div class={`disclosure ${showPrompt ? 'is-open' : ''}`}>
          <button type="button" class="disclosure-toggle" onClick={() => setShowPrompt(!showPrompt)} aria-expanded={String(showPrompt)}>
            <ChevronRight size={13} class="chevron" />
            {modelAgent ? 'Task' : 'Prompt'}
          </button>
          {showPrompt && <pre class="prompt-text">{task}</pre>}
        </div>
      )}

      {message.worktree?.branch && (
        <Note icon={GitBranch}>
          {message.state === 'running' ? 'Working on branch ' : 'Branch '}
          <code>{message.worktree.branch}</code>
          {message.worktree.commits ? ` · ${message.worktree.commits} ${message.worktree.commits === 1 ? 'commit' : 'commits'}` : ''}
          {' in '}
          <code>{message.worktree.path}</code>
        </Note>
      )}

      {(children.length > 0 || running) && (
        <Section
          label={`${steps} ${steps === 1 ? 'step' : 'steps'}`}
          aside={
            running && (
              <span class="agent-running">
                <LoaderCircle size={12} class="spin" />
                {message.progress?.description || 'Working'}
                {message.progress?.tokens ? ` · ${formatTokens(message.progress.tokens)} tokens` : ''}
              </span>
            )
          }
        >
          {children.length > 0 ? (
            <div class="agent-steps">
              {hidden > 0 && (
                <button type="button" class="more-btn" onClick={() => setShowOlder(true)}>
                  {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
                </button>
              )}
              <Children nodes={hidden ? children.slice(hidden) : children} cwd={cwd} />
            </div>
          ) : (
            <Note>Starting…</Note>
          )}
        </Section>
      )}

      {launched && <Note icon={Layers}>Started in the background. Its report arrives later in the conversation.</Note>}
      {message.stopped && (
        <Note icon={CircleStop}>
          {stoppedLabel(message)} before it finished{stopReason(message) ? `: ${stopReason(message)}` : '.'}
        </Note>
      )}
      {message.state === 'error' && !message.stopped && output && <OutputBlock text={agentReport(output)} error />}
      {report && (
        <Section label="Result">
          <Clamp maxHeight={360} class="tool-markdown">
            <Markdown text={report} class="markdown-sm" />
          </Clamp>
        </Section>
      )}
    </>
  );
}

// Stops just this subagent; the turn (or the rest of the session) carries on.
function StopAgentButton({ toolId }) {
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await stopAgent(toolId);
  };
  return (
    <button type="button" class="btn btn-sm btn-ghost agent-stop" onClick={stop} disabled={stopping} title="Stop this agent; Claude carries on without its report">
      <Square size={11} fill="currentColor" />
      {stopping ? 'Stopping…' : 'Stop agent'}
    </button>
  );
}
