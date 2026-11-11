// Edit / MultiEdit (inline diff per edit), Write (new content) and NotebookEdit.
import { FilePen, FilePlus, NotebookPen } from 'lucide-preact';
import { collapseContext, editDiff, splitLines } from '../../lib/diff.js';
import { languageForPath } from '../../lib/highlight.js';
import { relativePath } from '../../lib/format.js';
import { writeOutcome } from '../../lib/toolOutput.js';
import { CodeView, DiffView } from '../Code.jsx';
import { DiffStats } from '../DiffStats.jsx';
import { Chip, FileHeader, Note, OutputBlock } from './shared.jsx';

export function EditDetail({ message, output, cwd }) {
  const input = message.input || {};
  const path = input.file_path || '';
  const { hunks, adds, dels } = editDiff(input);
  const language = languageForPath(path);
  const replaceAll = hunks.length === 1 && hunks[0].replaceAll;
  return (
    <>
      <FileHeader path={path} display={relativePath(path, cwd)} icon={FilePen}>
        {replaceAll && <Chip tone="info">Replace all</Chip>}
        {hunks.length > 1 && <span class="muted">{hunks.length} edits</span>}
        <DiffStats adds={adds} dels={dels} />
      </FileHeader>
      {hunks.map((hunk, i) => (
        <div class="edit-hunk" key={i}>
          {hunks.length > 1 && (
            <div class="edit-hunk-label">
              Edit {i + 1} of {hunks.length}
              {hunk.replaceAll && hunks.length > 1 ? ' · all occurrences' : ''}
            </div>
          )}
          {hunk.rows.length ? <DiffView rows={collapseContext(hunk.rows)} language={language} numbers={false} /> : <Note>No change</Note>}
        </div>
      ))}
      {!hunks.length && <Note>No edits in this call.</Note>}
      {message.state === 'error' && output && <OutputBlock text={output} error />}
    </>
  );
}

export function WriteDetail({ message, output, cwd }) {
  const input = message.input || {};
  const path = input.file_path || '';
  const content = typeof input.content === 'string' ? input.content : '';
  const lines = splitLines(content).length;
  const outcome = writeOutcome(output);
  return (
    <>
      <FileHeader path={path} display={relativePath(path, cwd)} icon={FilePlus}>
        {outcome && <Chip tone={outcome === 'created' ? 'success' : 'warning'}>{outcome === 'created' ? 'Created' : 'Overwrote'}</Chip>}
        <span class="tool-stats">
          <span class="stat-adds">+{lines}</span>
          <span class="muted"> {lines === 1 ? 'line' : 'lines'}</span>
        </span>
      </FileHeader>
      {content ? <CodeView code={content} language={languageForPath(path)} maxLines={40} /> : <Note>Empty file</Note>}
      {message.state === 'error' && output && <OutputBlock text={output} error />}
    </>
  );
}

export function NotebookDetail({ message, output, cwd }) {
  const input = message.input || {};
  const path = input.notebook_path || '';
  const mode = input.edit_mode || 'replace';
  return (
    <>
      <FileHeader path={path} display={relativePath(path, cwd)} icon={NotebookPen}>
        <Chip>{mode === 'insert' ? 'Insert cell' : mode === 'delete' ? 'Delete cell' : 'Replace cell'}</Chip>
        {input.cell_id && <Chip mono>{input.cell_id}</Chip>}
        {input.cell_type && <Chip>{input.cell_type}</Chip>}
      </FileHeader>
      {mode !== 'delete' && input.new_source ? (
        <CodeView code={input.new_source} language={input.cell_type === 'markdown' ? 'markdown' : 'python'} maxLines={40} />
      ) : (
        <Note>{mode === 'delete' ? 'Cell removed.' : 'Empty cell'}</Note>
      )}
      {message.state === 'error' && output && <OutputBlock text={output} error />}
    </>
  );
}
