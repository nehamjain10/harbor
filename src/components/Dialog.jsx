// Modal dialog on the native <dialog> element (focus trap, Esc, top layer for free).
import { useLayoutEffect, useRef } from 'preact/hooks';
import { X } from 'lucide-preact';
import './Dialog.css';

export function Dialog({ open = true, onClose, title, eyebrow, subtitle, children, footer, size = 'md', class: className = '', initialFocus }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    // Remember what had focus, and give it back when the dialog closes or unmounts.
    const previous = document.activeElement;
    if (!dialog.open) dialog.showModal();
    const target = initialFocus ? dialog.querySelector(initialFocus) : null;
    target?.focus();
    if (target?.select) target.select();
    return () => {
      const active = document.activeElement;
      const focusInside = !active || active === document.body || dialog.contains(active);
      // Close first: everything outside an open modal dialog is inert.
      if (dialog.open) dialog.close();
      if (focusInside && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  // Clicks that land on the <dialog> element itself are on the backdrop.
  const onClick = (event) => {
    if (event.target === ref.current) onClose?.();
  };
  const onCancel = (event) => {
    event.preventDefault();
    onClose?.();
  };

  return (
    <dialog ref={ref} class={`dialog dialog-${size} ${className}`} onCancel={onCancel} onClick={onClick} aria-labelledby="dialog-title">
      <div class="dialog-panel">
        <header class="dialog-header">
          <div class="dialog-heading">
            {eyebrow && <div class="eyebrow">{eyebrow}</div>}
            <h2 id="dialog-title">{title}</h2>
            {subtitle && <p class="dialog-subtitle">{subtitle}</p>}
          </div>
          <button type="button" class="icon-btn" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </header>
        <div class="dialog-body">{children}</div>
        {footer && <footer class="dialog-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
