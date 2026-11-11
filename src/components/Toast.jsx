import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { dismissToast, toast as showToast } from '../actions.js';
import { useAppState } from '../state.js';
import './Toast.css';

export function Toast() {
  const toast = useAppState((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  // A manual popover is shown in the top layer, above an open modal dialog (the settings
  // dialog saves with a toast; without this it would sit beneath the backdrop).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el?.showPopover && !el.matches(':popover-open')) el.showPopover();
  }, [toast?.id]);
  if (!toast) return null;

  const undo = async () => {
    setBusy(true);
    try {
      await toast.undo();
      dismissToast();
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="toast" role="status" key={toast.id} ref={ref} popover="manual">
      <span class="toast-text">{toast.text}</span>
      {toast.undo && (
        <button type="button" class="toast-action" onClick={undo} disabled={busy}>
          Undo
        </button>
      )}
      <button type="button" class="icon-btn icon-btn-sm toast-close" onClick={dismissToast} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
