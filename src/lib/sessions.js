// Pure helpers for the session list: filtering, grouping, status.
import { DATE_GROUPS, dateGroup } from './format.js';
import { LOCAL_CLUSTER } from './clusters.js';

export const FILTERS = [
  { id: 'active', label: 'Chats' },
  { id: 'archived', label: 'Archived' },
  { id: 'trash', label: 'Trash' },
];

export function sortTime(session) {
  return session.lastMessageAt || session.createdAt || 0;
}

export function matchesFilter(session, filter) {
  if (filter === 'trash') return !!session.removed;
  if (session.removed) return false;
  return filter === 'archived' ? !!session.archived : !session.archived;
}

export function matchesSearch(session, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${session.title || ''} ${session.cwd || ''}`.toLowerCase().includes(q);
}

// Ways the sidebar can group sessions: by date bucket, or by the cluster (device) each
// session runs on.
export const GROUP_BYS = [
  { id: 'date', label: 'Date' },
  { id: 'cluster', label: 'Device' },
];

// Returns [{ label, sessions }] in display order: Pinned first (only when some
// session carries the v2 `pinned` flag), then the date buckets, or with `by: 'cluster'`
// one group per cluster in the order of `clusters` (ids it does not know last).
export function groupSessions(sessions, { filter = 'active', query = '', now = Date.now(), by = 'date', clusters = [] } = {}) {
  const visible = sessions
    .filter((s) => matchesFilter(s, filter) && matchesSearch(s, query))
    .sort((a, b) => sortTime(b) - sortTime(a));
  const groups = new Map();
  const add = (label, session) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(session);
  };
  const pinned = (session) => session.pinned && filter !== 'trash';
  if (by === 'cluster') {
    const order = clusters.length ? clusters : [LOCAL_CLUSTER];
    for (const session of visible) add(pinned(session) ? '\0pinned' : session.cluster || 'local', session);
    const ids = ['\0pinned', ...order.map((c) => c.id), ...[...groups.keys()].filter((id) => id !== '\0pinned' && !order.some((c) => c.id === id))];
    return ids
      .filter((id) => groups.has(id))
      .map((id) => ({ label: id === '\0pinned' ? 'Pinned' : order.find((c) => c.id === id)?.label || id, cluster: id === '\0pinned' ? null : id, sessions: groups.get(id) }));
  }
  for (const session of visible) {
    add(pinned(session) ? 'Pinned' : dateGroup(sortTime(session), now), session);
  }
  return ['Pinned', ...DATE_GROUPS]
    .filter((label) => groups.has(label))
    .map((label) => ({ label, sessions: groups.get(label) }));
}

export function readGroupBy(saved) {
  return GROUP_BYS.some((g) => g.id === saved) ? saved : 'date';
}

export function countForFilter(sessions, filter) {
  return sessions.filter((s) => matchesFilter(s, filter)).length;
}

export function isBusy(session) {
  return session?.status === 'running' || session?.status === 'waiting';
}

export function isUnread(session) {
  return !!session?.turnEndedAt && session.turnEndedAt > (session.lastViewedAt || 0);
}

// Status dot for a sidebar row: running | needs-you | error | unread | null.
export function sessionDot(session, { current = false } = {}) {
  if (!session) return null;
  if (session.status === 'waiting' || session.pending?.length) return 'needs-you';
  if (session.status === 'running') return 'running';
  if (session.status === 'error') return 'error';
  // Background subagents keep working after their turn ended.
  if (session.backgroundAgents > 0) return 'running';
  if (!current && isUnread(session)) return 'unread';
  return null;
}

export const STATUS_LABELS = {
  running: 'Working',
  waiting: 'Needs you',
  error: 'Error',
  interrupted: 'Interrupted',
  idle: 'Ready',
};

export function statusLabel(status, backgroundAgents = 0) {
  if (backgroundAgents > 0 && (!status || status === 'idle')) return backgroundAgents === 1 ? '1 agent running' : `${backgroundAgents} agents running`;
  return STATUS_LABELS[status] || 'Ready';
}

// The list endpoint omits the heavy fields; keep list entries light the same way (and
// without the window a tail copy holds).
export function briefSession(session) {
  const { messages, live, liveThinking, messagesFrom, ...brief } = session;
  return brief;
}

// An entry at a later revision (src/store.js applyDeltaToList) is not replaced by an
// older copy, such as a PATCH reply that arrives after the next delta.
export function upsertSession(list, session) {
  const brief = briefSession(session);
  const index = list.findIndex((s) => s.id === session.id);
  if (index < 0) return [...list, brief];
  if (session.rev != null && list[index].rev != null && session.rev < list[index].rev) return list;
  const next = list.slice();
  next[index] = brief;
  return next;
}

// Unique recent project folders, newest first.
export function recentProjects(sessions, limit = 4) {
  const seen = new Set();
  const result = [];
  for (const s of [...sessions].filter((s) => !s.removed).sort((a, b) => sortTime(b) - sortTime(a))) {
    if (!s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    result.push(s.cwd);
    if (result.length >= limit) break;
  }
  return result;
}
