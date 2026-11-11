// Small formatting helpers: times, durations, paths, numbers.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function relativeTime(ts, now = Date.now()) {
  const delta = now - ts;
  if (delta < MINUTE) return 'Just now';
  if (delta < HOUR) return Math.floor(delta / MINUTE) + 'm ago';
  if (delta < DAY) return Math.floor(delta / HOUR) + 'h ago';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Sidebar date bucket, measured in calendar days relative to local midnight.
export const DATE_GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier'];

export function dateGroup(ts, now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - DAY) return 'Yesterday';
  if (ts >= start - 7 * DAY) return 'Previous 7 days';
  return 'Earlier';
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function formatTokens(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}

export function formatCost(value) {
  const n = Number(value || 0);
  if (!n) return '';
  return n < 0.01 ? '<$0.01' : '$' + n.toFixed(2);
}

export function basename(p, fallback = 'Workspace') {
  return String(p || '').split('/').filter(Boolean).pop() || fallback;
}

export function dirname(p) {
  const parts = String(p || '').split('/');
  parts.pop();
  return parts.join('/');
}

// Shows `path` relative to `cwd` when it lives inside it.
export function relativePath(p, cwd) {
  if (!p) return '';
  if (cwd && (p === cwd)) return '.';
  if (cwd && p.startsWith(cwd.replace(/\/$/, '') + '/')) return p.slice(cwd.replace(/\/$/, '').length + 1);
  return p;
}

export function firstLine(text, max = 160) {
  const line = String(text ?? '').split('\n').find((l) => l.trim()) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
