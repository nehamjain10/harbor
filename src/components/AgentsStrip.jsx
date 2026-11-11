// Subagents working in the background, above the composer: they outlive the turn that
// started them, so they stay visible (with what each is doing and a Stop button) after
// their card has scrolled away. A line opens the agent's transcript in the side panel.
import { useMemo, useState } from 'preact/hooks';
import { Bot, Hand, LoaderCircle, Square } from 'lucide-preact';
import { openAgent, stopAgent } from '../actions.js';
import { shallowEqual, useAppState } from '../state.js';
import { agentActivity, agentAwaiting, agentKind, latestStep, runningBackgroundAgents, subagentModelLabel } from '../lib/agents.js';
import { Elapsed } from './Elapsed.jsx';
import './AgentsStrip.css';

export function AgentsStrip() {
  // Most sessions have none: only then read the transcript.
  const count = useAppState((s) => s.current?.backgroundAgents || 0);
  return count > 0 ? <AgentsList /> : null;
}

function AgentsList() {
  const { messages, pending, cwd } = useAppState(
    (s) => ({ messages: s.current?.messages, pending: s.current?.pending, cwd: s.current?.cwd || '' }),
    shallowEqual,
  );
  const agents = useMemo(() => runningBackgroundAgents(messages), [messages]);
  if (!agents.length) return null;
  return (
    <div class="agents-strip" role="region" aria-label="Background agents">
      {agents.map((agent) => (
        <AgentLine
          key={agent.id}
          agent={agent}
          step={latestStep(messages, agent.toolId)}
          awaiting={agentAwaiting(pending, agent.toolId)}
          cwd={cwd}
        />
      ))}
    </div>
  );
}

function AgentLine({ agent, step, awaiting, cwd }) {
  const [stopping, setStopping] = useState(false);
  const input = agent.input || {};
  const name = input.description || agent.agentId || 'Agent';
  const kind = useAppState((s) => agentKind(agent, s.info));
  const model = useAppState((s) => subagentModelLabel(agent, s.info, s.current?.model));
  const stop = async () => {
    setStopping(true);
    await stopAgent(agent.toolId);
  };
  return (
    <div class={`agent-line ${awaiting ? 'is-awaiting' : ''}`}>
      <button type="button" class="agent-line-open" onClick={() => openAgent(agent.toolId)} title={`Open the transcript of ${name}`}>
        {awaiting ? <Hand size={14} class="agent-line-icon" /> : <LoaderCircle size={14} class="spin agent-line-icon" aria-hidden="true" />}
        <span class="agent-line-name">
          <Bot size={13} aria-hidden="true" />
          {name}
        </span>
        {kind && <span class="agent-line-type">{kind}</span>}
        {model && <span class="agent-line-model">{model}</span>}
        <span class="agent-line-step">{awaiting ? 'Needs approval' : agentActivity(agent, step, cwd)}</span>
        <Elapsed since={agent.at} elapsed={agent.elapsed ?? null} class="agent-line-time" />
      </button>
      {agent.taskId && (
        <button
          type="button"
          class="icon-btn icon-btn-sm agent-line-stop"
          onClick={stop}
          disabled={stopping}
          aria-label={`Stop agent ${name}`}
          title="Stop this agent"
        >
          <Square size={11} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
