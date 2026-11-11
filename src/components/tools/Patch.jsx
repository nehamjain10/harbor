// ApplyPatch (Codex `apply_patch`, from imported Codex sessions): one diff per file.
import { FileMinus, FilePen, FilePlus, FileSymlink } from 'lucide-preact';
import { languageForPath } from '../../lib/highlight.js';
import { relativePath } from '../../lib/format.js';
import { patchFiles, patchText } from '../../lib/patch.js';
import { patchPath } from '../../lib/tools.js';
import { CodeBlock, DiffView } from '../Code.jsx';
import { DiffStats } from '../DiffStats.jsx';
import { Chip, Clamp, FileHeader, Note, OutputBlock } from './shared.jsx';

const ICONS = { added: FilePlus, deleted: FileMinus, renamed: FileSymlink, modified: FilePen };
const STATUS_CHIPS = { added: ['Added', 'success'], deleted: ['Deleted', 'error'], renamed: ['Moved', 'info'] };

// Patch paths are usually relative to the session folder; the side panel resolves
// them against it.
function PatchFile({ file, cwd }) {
  const target = patchPath(file);
  const chip = STATUS_CHIPS[file.status];
  const deleted = file.status === 'deleted';
  return (
    <div class="patch-file">
      <FileHeader path={deleted ? '' : target} display={relativePath(target, cwd)} icon={ICONS[file.status] || FilePen}>
        {chip && (
          <Chip tone={chip[1]} title={file.movePath ? `Moved from ${relativePath(file.path, cwd)}` : undefined}>
            {chip[0]}
          </Chip>
        )}
        {!deleted && <DiffStats adds={file.adds} dels={file.dels} />}
      </FileHeader>
      {file.movePath && <Note>Moved from {relativePath(file.path, cwd)}</Note>}
      {deleted ? (
        <Note>File deleted.</Note>
      ) : file.rows.length ? (
        <Clamp maxHeight={360}>
          <DiffView rows={file.rows} language={languageForPath(target)} numbers={false} />
        </Clamp>
      ) : (
        <Note>No content changes.</Note>
      )}
    </div>
  );
}

export function ApplyPatchDetail({ message, output, cwd }) {
  const files = patchFiles(message.input);
  const failed = message.state === 'error';
  if (!files.length) {
    const text = patchText(message.input);
    return (
      <>
        {text ? <CodeBlock code={text} language="diff" /> : <Note>Empty patch.</Note>}
        {output && <OutputBlock text={output} error={failed} maxLines={12} />}
      </>
    );
  }
  return (
    <>
      {files.map((file, i) => (
        <PatchFile key={i} file={file} cwd={cwd} />
      ))}
      {failed && output && <OutputBlock text={output} error />}
    </>
  );
}
