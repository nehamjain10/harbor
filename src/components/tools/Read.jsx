// Read: the numbered, highlighted excerpt the model saw, with Open in panel.
import { FileImage, FileText } from 'lucide-preact';
import { languageForPath } from '../../lib/highlight.js';
import { relativePath } from '../../lib/format.js';
import { localImageUrl } from '../../lib/localImage.js';
import { parseNumberedLines, readKind, stripReminders } from '../../lib/toolOutput.js';
import { CodeView } from '../Code.jsx';
import { FileHeader, Note, OutputBlock } from './shared.jsx';

function rangeLabel(input, parsed) {
  if (parsed) return `Lines ${parsed.startLine}–${parsed.startLine + parsed.lines.length - 1}`;
  if (input.pages) return `Pages ${input.pages}`;
  return '';
}

export function ReadDetail({ message, output, cwd }) {
  const input = message.input || {};
  const path = input.file_path || '';
  const kind = readKind(path, output);
  const parsed = kind ? null : parseNumberedLines(output);
  const error = message.state === 'error';
  const range = rangeLabel(input, parsed);
  return (
    <>
      <FileHeader path={kind || error ? null : path} display={relativePath(path, cwd)} line={Number(input.offset) || null} icon={kind === 'image' ? FileImage : FileText}>
        {range && <span class="muted">{range}</span>}
      </FileHeader>
      {error ? (
        <OutputBlock text={output} error />
      ) : kind === 'image' ? (
        <a class="read-image" href={localImageUrl(path)} target="_blank" rel="noopener noreferrer" title="Open full size">
          <img src={localImageUrl(path)} alt={relativePath(path, cwd)} loading="lazy" />
        </a>
      ) : kind === 'pdf' ? (
        <Note icon={FileText}>PDF {input.pages ? `pages ${input.pages} ` : ''}sent to the model.</Note>
      ) : parsed ? (
        <CodeView lines={parsed.lines} startLine={parsed.startLine} language={languageForPath(path)} maxLines={40} />
      ) : stripReminders(output) ? (
        <OutputBlock text={stripReminders(output)} maxLines={40} />
      ) : (
        <Note>{message.state === 'running' ? 'Reading…' : 'Empty file'}</Note>
      )}
    </>
  );
}
