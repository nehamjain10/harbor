// MCP servers in the browser: grouping and order, wording for statuses, the numbers on the
// topbar chip, and the check of the address pasted to finish a sign-in. Pure functions;
// the rows come from GET /api/sessions/:id/mcp (server/mcp-status.mjs).

export const GROUPS = [
  { id: 'claudeai', label: 'claude.ai connectors', note: 'Connected on claude.ai; Claude models only' },
  { id: 'plugin', label: 'Plugins', note: 'Servers that Claude Code plugins bring' },
  { id: 'user', label: 'Your servers', note: 'From your Claude Code settings' },
  { id: 'project', label: 'This project', note: 'From the project’s .mcp.json' },
  { id: 'local', label: 'Local to this project', note: 'Private to you in this project' },
  { id: 'other', label: 'Other', note: '' },
  { id: 'builtin', label: 'Built in', note: '' },
];

const STATUS_ORDER = { connected: 0, pending: 1, 'needs-auth': 2, failed: 3, disabled: 4 };

const STATUS_LABELS = {
  connected: 'Connected',
  pending: 'Connecting…',
  'needs-auth': 'Needs sign-in',
  failed: 'Failed',
  disabled: 'Off in Claude Code',
};

/** The status as a word, taking this session's switch into account. */
export function statusLabel(server) {
  if (server.disabledInSession) return 'Off for this session';
  return STATUS_LABELS[server.status] || server.status || 'Unknown';
}

/** `ok`, `warn`, `bad`, `busy` or `off`: the colour of the dot in front of a server. */
export function statusTone(server) {
  if (server.disabledInSession || server.status === 'disabled') return 'off';
  if (server.status === 'connected') return 'ok';
  if (server.status === 'pending') return 'busy';
  if (server.status === 'needs-auth') return 'warn';
  return 'bad';
}

/** A server's name for people: `plugin:slack:slack` is `slack` from the plugin `slack`; `claude.ai Slack` is `Slack`. */
export function displayName(server) {
  const name = String(server?.name ?? '');
  const plugin = name.match(/^plugin:([^:]+):(.+)$/);
  if (plugin) return { title: plugin[2], context: plugin[1] === plugin[2] ? 'plugin' : `plugin ${plugin[1]}` };
  if (name.startsWith('claude.ai ')) return { title: name.slice('claude.ai '.length), context: '' };
  return { title: name, context: '' };
}

/** The rows by group (in the order of GROUPS), connected first, then by name; empty groups left out. */
export function groupServers(servers = []) {
  const byStatus = (a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
    displayName(a).title.localeCompare(displayName(b).title, undefined, { sensitivity: 'base' });
  return GROUPS.map((group) => ({ ...group, servers: servers.filter((server) => (server.group || 'other') === group.id).sort(byStatus) })).filter(
    (group) => group.servers.length,
  );
}

/** Rows whose name, address or tools contain every word of `query` (all rows for an empty query). */
export function filterServers(servers = [], query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return servers;
  return servers.filter((server) => {
    const text = [server.name, displayName(server).title, server.url, server.serverInfo?.name, ...(server.tools || []).map((tool) => tool.name)].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * What the topbar chip shows: servers connected (Harbor's own and the ones switched off
 * for this session left out), and whether something needs a look. A broken server does;
 * so does one that wants a sign-in, except a claude.ai connector (every connector of the
 * account is listed, and most of them are simply not set up).
 * @returns {{connected: number, attention: number, total: number}}
 */
export function summarize(servers = []) {
  const own = servers.filter((server) => server.group !== 'builtin' && !server.builtin);
  const active = own.filter((server) => !server.disabledInSession);
  return {
    connected: active.filter((server) => server.status === 'connected').length,
    attention: active.filter((server) => server.status === 'failed' || (server.status === 'needs-auth' && server.group !== 'claudeai')).length,
    total: own.length,
  };
}

/** The group of a server known by name alone (the session's init report). */
export function groupOfName(name) {
  const text = String(name ?? '');
  if (text === 'meshy') return 'builtin';
  if (text.startsWith('claude.ai ')) return 'claudeai';
  if (text.startsWith('plugin:')) return 'plugin';
  return 'other';
}

/**
 * The chip's servers: the last list fetched for the session, else what Claude Code
 * reported when the session's process started (`session.mcp`, name and status only).
 */
export function chipServers(session, fetched) {
  if (fetched?.length) return fetched;
  const disabled = new Set(session?.mcpDisabled || []);
  return (session?.mcp || []).map((row) => ({ name: row.name, status: row.status, group: groupOfName(row.name), disabledInSession: disabled.has(row.name) }));
}

/** The chip's tooltip. */
export function chipTitle({ connected, attention, total }, sessionless = false) {
  if (!total) return sessionless ? 'MCP servers (/mcp)' : 'MCP servers: none configured (/mcp)';
  const parts = [`${connected} of ${total} connected`];
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
  return `MCP servers: ${parts.join(', ')} (/mcp)`;
}

/** Whether the paste field holds something worth sending (the server checks the rest). */
export function looksLikeCallback(text) {
  const value = String(text ?? '').trim();
  return /^[<"'`]*https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(value) && /[?&](code|error)=/.test(value);
}

/** A tool name as people read it: `search_threads` → `search threads`. */
export const toolLabel = (name) => String(name).replace(/_/g, ' ');

/** How long ago, short: `just now`, `3 min ago`, `2 h ago`. */
export function ago(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 20) return 'just now';
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
