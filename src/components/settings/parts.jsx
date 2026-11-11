// Building blocks of the settings tabs: notices, the diff panel, the conflict view and
// EditorShell, the frame every editor sits in (review step, save, "changed on disk").
import { useMemo, useState } from 'preact/hooks';
import { CircleAlert, Info, LoaderCircle, TriangleAlert } from 'lucide-preact';
import { toast } from '../../actions.js';
import { collapseContext, countChanges, diffLines } from '../../lib/diff.js';
import { savedText } from '../../lib/settings.js';
import { DiffView } from '../Code.jsx';
import { useDirty } from './hooks.js';

const NOTICE_ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info };

/** A boxed message: `tone` error, warning or info; `action` is an optional button row. */
export function Notice({ tone = 'info', children, action }) {
  const Icon = NOTICE_ICONS[tone];
  return (
    <div class={`settings-notice is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={15} aria-hidden="true" />
      <div class="notice-text">{children}</div>
      {action}
    </div>
  );
}

export function Loading({ children = 'Loading…' }) {
  return (
    <p class="settings-loading" role="status">
      <LoaderCircle size={14} class="spin" /> {children}
    </p>
  );
}

/** A failed load with a Retry button. */
export function LoadFailed({ message, onRetry }) {
  return (
    <Notice
      tone="error"
      action={
        <button type="button" class="btn btn-sm btn-secondary" onClick={onRetry}>
          Retry
        </button>
      }
    >
      {message}
    </Notice>
  );
}

/** Line diff of `before` against `after`, with the +/− counts. */
export function DiffPanel({ before, after, language, labels = ['On disk', 'Yours'] }) {
  const rows = useMemo(() => collapseContext(diffLines(before, after)), [before, after]);
  const { adds, dels } = useMemo(() => countChanges(rows), [rows]);
  if (!adds && !dels) return <p class="settings-note">No differences.</p>;
  return (
    <div class="diff-panel">
      <div class="diff-panel-head">
        <span class="eyebrow">
          {labels[0]} → {labels[1]}
        </span>
        <span class="diff-counts">
          <span class="stat-adds">+{adds}</span> <span class="stat-dels">−{dels}</span>
        </span>
      </div>
      <DiffView rows={rows} language={language} numbers={false} />
    </div>
  );
}

/** The file changed on disk while it was open: its current text against the draft, and the way out. */
function ConflictPanel({ path, disk, mine, language, busy, onReload, onOverwrite }) {
  return (
    <div class="settings-conflict">
      <Notice tone="warning">
        <strong>Changed on disk.</strong> <code>{path}</code> was changed since you opened it, by Claude Code, an editor or another window. Below is what is on disk now
        compared with your version.
      </Notice>
      <DiffPanel before={disk} after={mine} language={language} labels={['On disk now', 'Your version']} />
      <div class="editor-actions">
        <span class="spacer" />
        <button type="button" class="btn btn-secondary" onClick={onReload} disabled={busy}>
          Reload from disk
        </button>
        <button type="button" class="btn btn-danger" onClick={onOverwrite} disabled={busy}>
          Overwrite with mine
        </button>
      </div>
    </div>
  );
}

/**
 * The frame of an editor. The parent owns the draft and gives `text`, the draft as
 * comparable text (`textOf(view)` gives the same for any copy of the file), whether it is
 * `dirty` and, if it cannot be saved, `problem`. `save(version)` does the request.
 *
 * Saving shows a diff first when `review` is on. A 409 from `save` switches to the
 * conflict view: reload (the parent gets the disk copy through `onReload`) or overwrite
 * (saves again against the disk copy's version).
 */
export function EditorShell({ file, textOf, text, dirty, problem, review = true, save, onSaved, onReload, onRevert, language, live = false, saveLabel = 'Save', extra, children }) {
  const [step, setStep] = useState('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);
  useDirty(dirty);

  const run = async (version) => {
    setBusy(true);
    setError('');
    try {
      const result = await save(version);
      toast(savedText(result, { live }));
      setConflict(null);
      setStep('edit');
      onSaved(result);
    } catch (failure) {
      if (failure.status === 409 && failure.data?.current) {
        setConflict(failure.data.current);
        setStep('edit');
      } else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  if (conflict) {
    return (
      <ConflictPanel
        path={file.path}
        disk={textOf(conflict)}
        mine={text}
        language={language}
        busy={busy}
        onReload={() => onReload(conflict)}
        onOverwrite={() => run(conflict.version)}
      />
    );
  }

  const reviewing = step === 'review';
  return (
    <div class="settings-editor">
      <div class="editor-body">{reviewing ? <DiffPanel before={textOf(file)} after={text} language={language} labels={['Saved', 'Your changes']} /> : children}</div>
      {error && <Notice tone="error">{error}</Notice>}
      <div class="editor-actions">
        {problem && !reviewing ? <span class="editor-problem">{problem}</span> : <span class="spacer" />}
        {extra}
        {dirty && !reviewing && (
          <button type="button" class="btn btn-ghost" onClick={onRevert} disabled={busy}>
            Revert
          </button>
        )}
        {reviewing ? (
          <>
            <button type="button" class="btn btn-ghost" onClick={() => setStep('edit')} disabled={busy}>
              Keep editing
            </button>
            <button type="button" class="btn btn-primary" onClick={() => run(file.version)} disabled={busy}>
              {saveLabel}
            </button>
          </>
        ) : review ? (
          <button type="button" class="btn btn-primary" onClick={() => setStep('review')} disabled={!dirty || !!problem}>
            Review changes
          </button>
        ) : (
          <button type="button" class="btn btn-primary" onClick={() => run(file.version)} disabled={!dirty || !!problem || busy}>
            {saveLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** Where a file lives, shortened to `~/…` inside the home directory. */
export function shortPath(path, home) {
  if (home && path && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length);
  return path || '';
}
