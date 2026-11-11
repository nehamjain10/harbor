// Context ring next to the send button, with a hover / tap card showing the token
// count and a "Compact" quick action (sends `/compact`).
import { useEffect, useRef, useState } from 'preact/hooks';
import { Shrink } from 'lucide-preact';
import { sendMessage } from '../../actions.js';
import { contextUsage } from '../../lib/context.js';
import { formatTokens } from '../../lib/format.js';
import { Popover } from '../Popover.jsx';
import './composer.css';

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const canHover = () => globalThis.matchMedia?.('(hover: hover)').matches;

export function ContextMeter({ context, busy, sending }) {
  const usage = contextUsage(context);
  const [open, setOpen] = useState(false);
  const byHover = useRef(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);
  if (!usage) return null;

  const hoverIn = () => {
    if (!canHover()) return;
    clearTimeout(timer.current);
    if (!open) {
      timer.current = setTimeout(() => {
        byHover.current = true;
        setOpen(true);
      }, 220);
    }
  };
  const hoverOut = () => {
    clearTimeout(timer.current);
    if (open && byHover.current) timer.current = setTimeout(() => setOpen(false), 180);
  };
  const toggle = () => {
    clearTimeout(timer.current);
    byHover.current = false;
    setOpen(!open);
  };
  const compact = () => {
    setOpen(false);
    sendMessage('/compact');
  };

  const note =
    usage.tone === 'error'
      ? 'Almost full. Compact now to keep the important parts.'
      : usage.tone === 'warning'
        ? 'Getting full. Compacting summarizes older turns.'
        : usage.compactAt
          ? `Compacts automatically near ${formatTokens(usage.compactAt)} tokens.`
          : 'Compacts automatically near the limit.';

  return (
    <div class="popover-anchor context-anchor" onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      <button
        type="button"
        class={`context-ring ring-${usage.tone}`}
        aria-expanded={String(open)}
        aria-label={`Context: ${usage.label}`}
        onClick={toggle}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={RADIUS} class="ring-track" />
          <circle cx="9" cy="9" r={RADIUS} class="ring-value" stroke-dasharray={`${CIRCUMFERENCE * usage.ratio} ${CIRCUMFERENCE}`} transform="rotate(-90 9 9)" />
        </svg>
        {/* The number keeps a small ring from reading as a spinner. */}
        <span class="context-ring-percent">{usage.percent}%</span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} placement="top-end" class="context-popover" label="Context window" autoFocus={false}>
          <div class="context-head">
            <span class="eyebrow">Context window</span>
            <span class={`context-percent tone-${usage.tone}`}>{usage.percent}%</span>
          </div>
          <div class={`context-bar tone-${usage.tone}`} aria-hidden="true">
            <i style={{ width: `${Math.max(2, usage.percent)}%` }} />
          </div>
          <div class="context-label">{usage.label}</div>
          <p class="context-note">{note}</p>
          <button type="button" class={`btn btn-sm ${usage.tone === 'normal' ? 'btn-secondary' : 'btn-primary'} context-compact`} onClick={compact} disabled={sending}>
            <Shrink size={14} />
            {busy ? 'Compact after this turn' : 'Compact now'}
          </button>
        </Popover>
      )}
    </div>
  );
}
