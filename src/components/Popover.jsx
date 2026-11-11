// Anchored popover menu. Render it next to its trigger inside a `.popover-anchor`
// wrapper; it closes on outside pointer-down and Esc, and is nudged back inside the
// viewport when it would overflow horizontally.
import { useLayoutEffect, useRef } from 'preact/hooks';
import './Popover.css';

// `onEscape` may handle Esc itself (return true), e.g. to close a submenu first.
export function Popover({ onClose, onEscape, placement = 'top-start', class: className = '', children, label, autoFocus = true }) {
  const ref = useRef(null);

  // Position, focus, and give focus back to the trigger on close.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const trigger = el.parentElement?.querySelector('[aria-expanded]');
    const previous = document.activeElement && document.activeElement !== document.body ? document.activeElement : trigger;

    el.style.removeProperty('--nudge');
    // Use layout offsets: the entry animation scales the box, which would skew a
    // getBoundingClientRect() measurement.
    const parent = el.offsetParent || el.parentElement;
    const left = parent.getBoundingClientRect().left + el.offsetLeft;
    const right = left + el.offsetWidth;
    const margin = 8;
    let nudge = 0;
    if (right > window.innerWidth - margin) nudge = window.innerWidth - margin - right;
    if (left + nudge < margin) nudge = margin - left;
    if (nudge) el.style.setProperty('--nudge', nudge + 'px');
    if (autoFocus) {
      const target = el.querySelector('[aria-selected="true"], [aria-checked="true"]') || el.querySelector('button:not(:disabled), input');
      target?.focus({ preventScroll: true });
    }

    return () => {
      // Only when focus would otherwise be lost (not when the user clicked into
      // something else to close the popover).
      const active = document.activeElement;
      if ((!active || active === document.body || el.contains(active)) && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Layout effect so Esc and outside clicks work from the very first frame.
  useLayoutEffect(() => {
    const onPointer = (event) => {
      const el = ref.current;
      if (!el || el.contains(event.target)) return;
      // Clicks on the trigger toggle it themselves.
      if (el.parentElement?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (onEscape?.() !== true) onClose();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, onEscape]);

  const onKeyDown = (event) => moveMenuFocus(ref.current, event);

  return (
    <div ref={ref} class={`popover popover-${placement} ${className}`} role="dialog" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** Arrow keys, Home and End move focus between the rows of a menu (`container`). */
export function moveMenuFocus(container, event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  // Home and End stay with a text field (its caret).
  if ((event.key === 'Home' || event.key === 'End') && event.target?.tagName === 'INPUT') return;
  const rows = [...container.querySelectorAll('[role="option"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)')];
  if (!rows.length) return;
  event.preventDefault();
  const index = rows.indexOf(document.activeElement);
  let next = 0;
  if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % rows.length;
  else if (event.key === 'ArrowUp') next = index <= 0 ? rows.length - 1 : index - 1;
  else if (event.key === 'End') next = rows.length - 1;
  rows[next].focus();
}

// A selectable row: icon, label, muted description, check when selected.
export function MenuRow({ icon, label, description, selected, onSelect, trailing, disabled, role = 'option', class: className = '', ...rest }) {
  return (
    <button
      {...rest}
      type="button"
      role={role}
      class={`menu-row ${selected ? 'is-selected' : ''} ${className}`}
      aria-selected={role === 'option' ? String(!!selected) : undefined}
      aria-checked={role === 'menuitemradio' ? String(!!selected) : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon && <span class="menu-row-icon">{icon}</span>}
      <span class="menu-row-text">
        <span class="menu-row-label">{label}</span>
        {description && <span class="menu-row-description">{description}</span>}
      </span>
      {trailing}
    </button>
  );
}
