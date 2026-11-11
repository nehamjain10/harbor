// MCP tools and the fallback: pretty JSON input and the output (JSON highlighted,
// MCP content blocks unwrapped to their text).
import { mcpOutputText, prettyJson } from '../../lib/toolOutput.js';
import { CodeBlock } from '../Code.jsx';
import { Note, OutputBlock, Section } from './shared.jsx';

function InputSection({ input }) {
  const keys = input && typeof input === 'object' ? Object.keys(input) : [];
  if (!keys.length) return null;
  return (
    <Section label="Input">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </Section>
  );
}

function OutputSection({ text, error, running }) {
  if (!text) return running ? <Note>Running…</Note> : null;
  const json = prettyJson(text);
  return (
    <Section label={error ? 'Error' : 'Output'}>
      {json && !error ? <CodeBlock code={json} language="json" /> : <OutputBlock text={text} error={error} />}
    </Section>
  );
}

export function McpDetail({ message, output }) {
  return (
    <>
      <InputSection input={message.input} />
      <OutputSection text={mcpOutputText(output)} error={message.state === 'error'} running={message.state === 'running'} />
    </>
  );
}

export function GenericDetail({ message, output }) {
  return (
    <>
      <InputSection input={message.input} />
      <OutputSection text={output} error={message.state === 'error'} running={message.state === 'running'} />
    </>
  );
}
