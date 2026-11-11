// Context-window usage for the composer's ring: `session.context = {used, window}`.
import { formatTokens } from './format.js';

export const CONTEXT_WARNING = 0.7;
export const CONTEXT_ERROR = 0.9;

export function contextTone(ratio) {
  if (ratio > CONTEXT_ERROR) return 'error';
  if (ratio > CONTEXT_WARNING) return 'warning';
  return 'normal';
}

// { ratio, percent, tone, label, compactAt } or null when the session has no usage yet.
// `compactAt`: about where Claude Code compacts on its own (tokens), when known.
export function contextUsage(context) {
  const used = Number(context?.used);
  const window = Number(context?.window);
  if (!window || !Number.isFinite(used) || used < 0) return null;
  const ratio = Math.min(1, used / window);
  const percent = Math.round(ratio * 100);
  return {
    ratio,
    percent,
    tone: contextTone(ratio),
    label: `${formatTokens(used)} / ${formatTokens(window)} tokens (${percent}%)`,
    compactAt: Number(context.compactAt) > 0 && Number(context.compactAt) < window ? Number(context.compactAt) : null,
  };
}
