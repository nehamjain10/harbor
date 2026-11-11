// Per-session options: copy link, rename, fork, pin, archive, trash / restore.
import { useState } from 'preact/hooks';
import { Archive, ArchiveRestore, GitBranch, Link, Pencil, Pin, PinOff, RotateCcw, ShieldCheck, Trash2 } from 'lucide-preact';
import { closeDialog, copySessionLink, forkSession, openDialog, patchSession, toast, toggleArchived, togglePinned, toggleRemoved } from '../actions.js';
import { useAppState } from '../state.js';
import { basename } from '../lib/format.js';
import { isBusy } from '../lib/sessions.js';
import { allowRuleTexts } from '../lib/approvals.js';
import { Dialog } from './Dialog.jsx';
import './SessionOptions.css';

export function Option({ icon: Icon, label, note, onClick, disabled, danger }) {
  return (
    <button type="button" class={`option-row ${danger ? 'is-danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span class="option-icon">
        <Icon size={16} />
      </span>
      <span class="option-text">
        <span class="option-label">{label}</span>
        {note && <span class="option-note">{note}</span>}
      </span>
    </button>
  );
}

export function SessionOptions({ id }) {
  const { session, isV2, grants } = useAppState(
    (s) => ({
      session: s.sessions.find((x) => x.id === id) || null,
      isV2: s.isV2,
      // "Always allow" grants (allowRules / allowDirectories), freshest copy first.
      grants: s.current?.id === id ? s.current : s.sessions.find((x) => x.id === id) || null,
    }),
    (a, b) =>
      a.session === b.session &&
      a.isV2 === b.isV2 &&
      a.grants?.allowRules === b.grants?.allowRules &&
      a.grants?.allowDirectories === b.grants?.allowDirectories,
  );
  if (!session) return null;
  const busy = isBusy(session);
  const run = (fn) => () => {
    closeDialog();
    fn(id);
  };

  return (
    <Dialog title="Session options" subtitle={`${session.title} · ${basename(session.cwd)}`} onClose={closeDialog} size="sm">
      <div class="options-list">
        <Option icon={Link} label="Copy session link" note="Continue on your other device" onClick={run(copySessionLink)} />
        <Option icon={Pencil} label="Rename" onClick={() => openDialog('rename', { id })} />
        {!session.removed && (
          <Option
            icon={GitBranch}
            label="Fork"
            note={busy ? 'Wait for the turn to end' : 'Copy this conversation into a new session'}
            onClick={run(forkSession)}
            disabled={busy}
          />
        )}
        {(isV2 || 'pinned' in session) && !session.removed && (
          <Option icon={session.pinned ? PinOff : Pin} label={session.pinned ? 'Unpin' : 'Pin to top'} onClick={run(togglePinned)} />
        )}
        {!session.removed && (
          <Option
            icon={session.archived ? ArchiveRestore : Archive}
            label={session.archived ? 'Unarchive' : 'Archive'}
            note={busy ? 'Stop the session first' : null}
            onClick={run(toggleArchived)}
            disabled={busy}
          />
        )}
        {session.removed ? (
          <Option icon={RotateCcw} label="Restore from Trash" onClick={run(toggleRemoved)} />
        ) : (
          <Option icon={Trash2} label="Move to Trash" note={busy ? 'Stop the session first' : 'You can restore it later'} onClick={run(toggleRemoved)} disabled={busy} danger />
        )}
      </div>
      <AllowedRules
        id={id}
        rules={allowRuleTexts(grants?.allowRules)}
        directories={Array.isArray(grants?.allowDirectories) ? grants.allowDirectories.filter((d) => typeof d === 'string') : []}
      />
    </Dialog>
  );
}

// What "Always allow" granted in this session (read-only), with Clear.
function AllowedRules({ id, rules, directories }) {
  const [clearing, setClearing] = useState(false);
  if (!rules.length && !directories.length) return null;
  const clear = async () => {
    setClearing(true);
    try {
      await patchSession(id, { allowRules: [], allowDirectories: [] });
      toast('Cleared. It will ask again.');
    } catch (error) {
      toast(error.message);
    } finally {
      setClearing(false);
    }
  };
  return (
    <div class="allowed-rules">
      <div class="allowed-head">
        <div class="eyebrow">
          <ShieldCheck size={13} />
          Allowed this session
        </div>
        <button type="button" class="btn btn-sm btn-ghost" onClick={clear} disabled={clearing}>
          Clear
        </button>
      </div>
      <ul>
        {rules.map((rule) => (
          <li key={'r' + rule}>
            <code>{rule}</code>
          </li>
        ))}
        {directories.map((dir) => (
          <li key={'d' + dir}>
            <code class="allowed-dir">access to {dir}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
