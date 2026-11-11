// Fields the editors share: a Markdown text area with a preview, and the editor of a
// whole Markdown file (CLAUDE.md, the MEMORY.md index).
import { useMemo, useState } from 'preact/hooks';
import { joinEol, splitEol } from '../../lib/settings.js';
import { Markdown } from '../Markdown.jsx';
import { EditorShell } from './parts.jsx';

/** A monospace text area for Markdown with an Edit / Preview switch. `fill` stretches it to the room there is. */
export function MarkdownField({ id, label, value, onInput, placeholder, rows = 14, fill = false }) {
  const [preview, setPreview] = useState(false);
  return (
    <div class={`md-field ${fill ? 'is-fill' : ''}`}>
      <div class="md-field-head">
        <label class="settings-label" for={id}>
          {label}
        </label>
        <div class="segmented md-toggle" role="radiogroup" aria-label={`${label}: edit or preview`}>
          <button type="button" role="radio" aria-checked={String(!preview)} aria-pressed={String(!preview)} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button type="button" role="radio" aria-checked={String(preview)} aria-pressed={String(preview)} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      </div>
      {preview ? (
        <div class="md-preview" aria-label={`${label} preview`}>
          {value.trim() ? <Markdown text={value} /> : <p class="rule-empty">Nothing to preview yet.</p>}
        </div>
      ) : (
        <textarea
          id={id}
          class="settings-textarea mono"
          value={value}
          onInput={(event) => onInput(event.currentTarget.value)}
          placeholder={placeholder}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          rows={rows}
        />
      )}
    </div>
  );
}

/**
 * Edits a whole Markdown file: `file` is a view with `content` and `version`;
 * `save(content, version)` writes it (line endings are put back as the file had them).
 */
export function TextFileEditor({ file, label, save, onSaved, onReload, live = false, note }) {
  const original = useMemo(() => splitEol(file.content), [file]);
  const [text, setText] = useState(original.text);
  return (
    <EditorShell
      file={file}
      textOf={(view) => splitEol(view.content).text}
      text={text}
      dirty={text !== original.text}
      live={live}
      save={(version) => save(joinEol(text, original.eol), version)}
      onSaved={onSaved}
      onReload={onReload}
      onRevert={() => setText(original.text)}
    >
      {note}
      <MarkdownField id={`file-${file.scope}-${file.id || file.name}`} label={label} value={text} onInput={setText} fill />
    </EditorShell>
  );
}
