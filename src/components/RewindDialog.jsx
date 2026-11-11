// Rewind: the open session goes back to just before one of the user's messages, in place,
// with or without the files Claude edited since. The message comes back into the composer.
import { useEffect, useState } from 'preact/hooks';
import { FileCode, MessageSquare } from 'lucide-preact';
import { closeDialog, presetComposer, previewRewind, rewindSession, toast } from '../actions.js';
import { restoreAttachments } from '../composer.js';
import { useAppState } from '../state.js';
import { Dialog } from './Dialog.jsx';
import { DiffStats } from './DiffStats.jsx';
import { Option } from './SessionOptions.jsx';
import './SessionOptions.css';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The note under "Conversation and code": what restoring the files would change. */
function codeNote(files) {
  if (!files) return 'Checking what Claude changed since…';
  if (!files.canRewind) return files.error ? `Can't restore: ${files.error}` : "Can't restore the code for this message";
  const count = files.filesChanged?.length ?? 0;
  if (!count) return 'No file changes to put back';
  return (
    <>
      Puts back {plural(count, 'file')} <DiffStats adds={files.insertions} dels={files.deletions} class="rewind-stats" />
    </>
  );
}

export function RewindDialog({ sessionId, messageId }) {
  const message = useAppState((s) => (s.current?.id === sessionId ? s.current.messages?.find((m) => m.id === messageId) : null) ?? null);
  const [files, setFiles] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    previewRewind(sessionId, messageId).then(
      (answer) => live && setFiles(answer ?? { canRewind: false }),
      (error) => live && setFiles({ canRewind: false, error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [sessionId, messageId]);

  const rewind = async (code) => {
    setWorking(true);
    try {
      const { draft } = await rewindSession(sessionId, messageId, { code });
      closeDialog();
      if (draft?.attachments?.length) restoreAttachments(sessionId, draft.attachments);
      presetComposer(draft?.text ?? '');
      toast(code ? 'Rewound, code restored. Edit your message and send it.' : 'Rewound. Edit your message and send it.');
    } catch (error) {
      toast(error.message);
      setWorking(false);
    }
  };

  const codeReady = Boolean(files?.canRewind && files.filesChanged?.length);
  const excerpt = (message?.text ?? '').trim().split('\n')[0].slice(0, 120);
  return (
    <Dialog
      title="Rewind to before this message"
      subtitle={excerpt ? `“${excerpt}”` : undefined}
      onClose={closeDialog}
      size="sm"
      initialFocus=".option-row:not(:disabled)"
    >
      <div class="options-list">
        <Option icon={FileCode} label="Conversation and code" note={codeNote(files)} onClick={() => rewind(true)} disabled={working || !codeReady} />
        <Option icon={MessageSquare} label="Conversation only" note="Files stay as they are now" onClick={() => rewind(false)} disabled={working} />
      </div>
      <p class="rewind-hint">
        Everything from this message on leaves the chat, and the message goes back into the composer. Only edits made with Claude's file tools can be put
        back, not changes made by commands.
      </p>
    </Dialog>
  );
}
