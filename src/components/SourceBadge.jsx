// A tiny "Claude Code" / "Codex" chip marking a session imported from that app.
import { sourceLabel } from '../lib/imports.js';
import './SourceBadge.css';

export function SourceBadge({ source, class: className = '' }) {
  const label = sourceLabel(source?.kind);
  if (!label) return null;
  return (
    <span class={`source-badge source-${source.kind} ${className}`} title={`Imported from ${label}`}>
      {label}
    </span>
  );
}
