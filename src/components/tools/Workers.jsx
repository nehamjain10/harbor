// The lead's tools for its model agents: message_agent (what it told one), stop_agent
// (why, and the partial report it handed back) and check_agents (how each one stands).
// Workers are named from their delegate cards (node.workers, lib/transcript.js); an id
// the session has no card for shows as the id.
import { Bot, PanelRightOpen } from 'lucide-preact';
import { useAppState } from '../../state.js';
import { modelAgentLabel } from '../../lib/agents.js';
import { agentReport, mcpOutputText } from '../../lib/toolOutput.js';
import { workerIds } from '../../lib/tools.js';
import { Markdown } from '../Markdown.jsx';
import { useOpenAgent } from '../agentScope.js';
import { Chip, Clamp, Note, OutputBlock, Section } from './shared.jsx';

// One chip row per named worker: its model, what it does, its id, and a way to its
// transcript. Ids without a card (an older session, a worker of another one) show alone.
function WorkerLines({ message, node }) {
  const info = useAppState((s) => s.info);
  const open = useOpenAgent();
  const ids = workerIds(message);
  if (!ids.length) return null;
  return ids.map((id) => {
    const worker = node.workers?.find((w) => w.id === id);
    return (
      <div class="agent-head" key={id}>
        {worker && (
          <Chip tone="accent">
            <Bot size={12} />
            {modelAgentLabel(worker.model, info)}
          </Chip>
        )}
        {worker?.description && <span class="agent-desc">{worker.description}</span>}
        <Chip mono>{id}</Chip>
        {worker?.toolId && (
          <button type="button" class="btn btn-sm btn-ghost agent-open" onClick={() => open(worker.toolId)} title="Open its conversation in the side panel">
            <PanelRightOpen size={13} />
            Transcript
          </button>
        )}
      </div>
    );
  });
}

export function MessageAgentDetail({ message, output, node }) {
  const text = typeof message.input?.message === 'string' ? message.input.message : '';
  const failed = message.state === 'error';
  return (
    <>
      <WorkerLines message={message} node={node} />
      {text && (
        <Section label="Message">
          <Clamp maxHeight={220}>
            <div class="steer-quote">{text}</div>
          </Clamp>
        </Section>
      )}
      {output && (failed ? <OutputBlock text={mcpOutputText(output)} error /> : <Note>{mcpOutputText(output)}</Note>)}
    </>
  );
}

export function StopAgentDetail({ message, output, node }) {
  const reason = typeof message.input?.reason === 'string' ? message.input.reason.trim() : '';
  const failed = message.state === 'error';
  const report = failed ? '' : agentReport(mcpOutputText(output));
  return (
    <>
      <WorkerLines message={message} node={node} />
      {reason && <Note>Reason: {reason}</Note>}
      {report && (
        <Section label="Partial report">
          <Clamp maxHeight={360} class="tool-markdown">
            <Markdown text={report} class="markdown-sm" />
          </Clamp>
        </Section>
      )}
      {failed && output && <OutputBlock text={mcpOutputText(output)} error />}
      {!output && message.state === 'running' && <Note>Stopping…</Note>}
    </>
  );
}

export function CheckAgentsDetail({ message, output, node }) {
  const text = mcpOutputText(output);
  return (
    <>
      <WorkerLines message={message} node={node} />
      {text ? <OutputBlock text={text} error={message.state === 'error'} maxLines={24} /> : message.state === 'running' ? <Note>Checking…</Note> : null}
    </>
  );
}
