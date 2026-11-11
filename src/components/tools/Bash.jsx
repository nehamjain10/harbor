// Bash (command + output) and the background-shell helpers.
import { Hourglass } from 'lucide-preact';
import { stripAnsi } from '../../lib/toolOutput.js';
import { formatDuration } from '../../lib/format.js';
import { CodeBlock } from '../Code.jsx';
import { Chip, CopyButton, Note, OutputBlock } from './shared.jsx';

export function BashDetail({ message, output }) {
  const input = message.input || {};
  const text = stripAnsi(output).replace(/\s+$/, '');
  const running = message.state === 'running';
  return (
    <>
      {input.description && <p class="tool-desc">{input.description}</p>}
      <div class="command-block">
        <span class="command-prompt" aria-hidden="true">
          $
        </span>
        <CodeBlock code={input.command || ''} language="bash" class="command-text" />
        <CopyButton text={input.command || ''} label="Copy command" />
      </div>
      {input.timeout && (
        <div class="chip-row">
          <Chip>
            <Hourglass size={12} />
            Timeout {formatDuration(input.timeout)}
          </Chip>
        </div>
      )}
      {text ? (
        <OutputBlock text={text} error={message.state === 'error'} />
      ) : (
        <Note>{running ? 'Waiting for output…' : 'No output'}</Note>
      )}
    </>
  );
}

// BashOutput / TaskOutput / KillShell / TaskStop: which shell, and what came back.
export function ShellDetail({ message, output }) {
  const input = message.input || {};
  const text = stripAnsi(output).replace(/\s+$/, '');
  return (
    <>
      {input.filter && (
        <div class="chip-row">
          <Chip mono>filter: {input.filter}</Chip>
        </div>
      )}
      {text ? <OutputBlock text={text} error={message.state === 'error'} maxLines={20} /> : <Note>No output</Note>}
    </>
  );
}
