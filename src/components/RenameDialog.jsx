import { useState } from 'preact/hooks';
import { closeDialog, renameSession, toast } from '../actions.js';
import { useAppState } from '../state.js';
import { Dialog } from './Dialog.jsx';

export function RenameDialog({ id }) {
  const session = useAppState((s) => s.sessions.find((x) => x.id === id) || (s.current?.id === id ? s.current : null));
  const [title, setTitle] = useState(session?.title || '');
  const [saving, setSaving] = useState(false);
  if (!session) return null;

  const save = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await renameSession(id, title.trim());
      closeDialog();
    } catch (error) {
      toast(error.message);
      setSaving(false);
    }
  };

  return (
    <Dialog title="Rename session" onClose={closeDialog} size="sm" initialFocus="input">
      <form id="rename-form" onSubmit={save}>
        <input
          class="input"
          value={title}
          maxLength={100}
          required
          aria-label="Session name"
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
        <div class="rename-actions">
          <button type="button" class="btn btn-ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={saving || !title.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
