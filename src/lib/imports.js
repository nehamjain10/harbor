// Session import (Claude Code and Codex): pure helpers for the import picker, the
// source badge and the "imported" banner. Unit tested in tests/frontend-imports.test.mjs.
import { clockTime, relativeTime } from './format.js';

export const IMPORT_SOURCES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

// The server accepts at most this many ids per POST /api/import.
export const IMPORT_BATCH_SIZE = 20;

const SOURCE_LABELS = { claude: 'Claude Code', codex: 'Codex' };

export function sourceLabel(kind) {
  return SOURCE_LABELS[kind] || '';
}

// Which Codex client wrote a rollout, in a word.
const ORIGINATORS = { 'Codex Desktop': 'Desktop', 'codex-tui': 'Terminal', codex_exec: 'Exec' };

export function originatorLabel(originator) {
  if (!originator) return '';
  return ORIGINATORS[originator] || String(originator);
}

// `/home/me/project` → `~/project` when inside `home`.
export function tildePath(path, home) {
  const value = String(path || '');
  const base = String(home || '').replace(/\/+$/, '');
  if (!base || !value) return value;
  if (value === base) return '~';
  if (value.startsWith(base + '/')) return '~' + value.slice(base.length);
  return value;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}

// "Just now", "5m ago", "3h ago", "Oct 4", or "Oct 4, 2025" outside the current year.
export function importTime(ts, now = Date.now()) {
  if (!ts) return '';
  if (new Date(ts).getFullYear() === new Date(now).getFullYear() || now - ts < 86_400_000) return relativeTime(ts, now);
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// Calendar date for the banner: "Oct 4" (this year) or "Oct 4, 2025".
export function importDate(ts, now = Date.now()) {
  if (!ts) return '';
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

// When an imported message was sent: the clock time today, else the date too
// ("Oct 2, 8:29 PM"; the year when it is not this one).
export function messageTime(ts, now = Date.now()) {
  if (!ts) return '';
  const date = new Date(ts);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clockTime(ts);
  const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (date.getFullYear() !== today.getFullYear()) options.year = 'numeric';
  return date.toLocaleString([], options);
}

const searchText = new WeakMap();

function haystack(item, home) {
  let text = searchText.get(item);
  if (text === undefined) {
    text = `${item.title || ''} ${tildePath(item.cwd, home)} ${item.cwd || ''}`.toLowerCase();
    searchText.set(item, text);
  }
  return text;
}

// Candidates matching every word of `query` (title or folder) and, when given, the
// exact `project` folder. Keeps the server's order (newest first).
export function filterCandidates(items, { query = '', project = '', home = '' } = {}) {
  const words = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length && !project) return items;
  return items.filter((item) => {
    if (project && item.cwd !== project) return false;
    if (!words.length) return true;
    const text = haystack(item, home);
    return words.every((word) => text.includes(word));
  });
}

// Folders for the project filter: [{ cwd, count }], most recently used first.
export function projectChoices(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item.cwd) continue;
    counts.set(item.cwd, (counts.get(item.cwd) || 0) + 1);
  }
  return [...counts].map(([cwd, count]) => ({ cwd, count }));
}

export function chunk(list, size = IMPORT_BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return batches;
}

// Whether a row can be ticked: importable and not already imported.
export function isSelectable(item) {
  return !!item && item.importable !== false && !item.importedAs;
}

// The candidate id each imported session came from: the server's `source.id`, or
// (when a brief lacks it) the requested ids that did not fail, in order.
export function importedIds(ids, sessions, errors) {
  const failed = new Set((errors || []).map((e) => e.id));
  const remaining = ids.filter((id) => !failed.has(id));
  return (sessions || []).map((session, i) => ({ id: session?.source?.id || remaining[i], sessionId: session?.id }));
}

/* Imported sessions */

// True until the session has a turn of its own in Harbor (a user message that
// did not come from the import). A copy holding only the end of the session (a tail)
// may start after such a turn: the server's lastMessageAt (the latest own turn, else
// the session's creation) tells.
export function awaitingFirstTurn(session) {
  if (!session?.source) return false;
  if ((session.messages || []).some((m) => m.role === 'user' && !m.imported && !m.parentToolId)) return false;
  return !(session.messagesFrom > 0 && session.lastMessageAt > session.createdAt);
}

// The banner shown on an imported session before its first turn here.
export function importBanner(session, modelName, now = Date.now()) {
  if (!awaitingFirstTurn(session)) return null;
  const { kind, updatedAt, createdAt } = session.source;
  const date = importDate(updatedAt || createdAt, now);
  const lead = `Imported from ${sourceLabel(kind) || 'another app'}${date ? ' · ' + date : ''}.`;
  if (kind === 'codex') {
    return {
      lead,
      text: 'Codex conversations can’t be resumed directly; your next message starts a new conversation that carries a summary of this one.',
    };
  }
  return { lead, text: `Your next message continues it on ${modelName} in a copy; the original is unchanged.` };
}
