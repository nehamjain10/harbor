// MCP servers as the browser sees them: Claude Code's `mcp_status` rows turned into the
// public shape (no secrets), the rules that switch a server off for one session, and the
// check of the URL a user pastes to finish an OAuth sign-in. Pure functions, no I/O.
import { AGENT_SERVER } from './model-agents.mjs';

const MAX_ERROR_CHARS = 300;
const MAX_TOOL_DESCRIPTION_CHARS = 280;
const MAX_CALLBACK_URL_CHARS = 4096;

/**
 * Claude Code's name for a server inside tool names (`mcp__<name>__<tool>`): characters
 * outside letters, digits, `_` and `-` become `_`; claude.ai connectors also collapse
 * runs of `_` and lose leading and trailing ones (`claude.ai Slack` is `claude_ai_Slack`).
 */
export function normalizeServerName(name) {
  const normalized = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  return String(name).startsWith('claude.ai ') ? normalized.replace(/_+/g, '_').replace(/^_|_$/g, '') : normalized;
}

/**
 * Flag-settings deny rules that hide the listed servers' tools from the model. A deny
 * rule is per process and never written to Claude Code's own config, unlike the
 * `mcp_toggle` control request, which records the server as disabled for the whole
 * project in ~/.claude.json (every session in that folder, and the terminal Claude Code).
 */
export function mcpDenyRules(disabled) {
  return [...new Set((disabled || []).map((name) => `mcp__${normalizeServerName(name)}`))];
}

/** The session's disabled servers as a clean list of names (no duplicates, text only). */
export function disabledServers(session) {
  return [...new Set((session?.mcpDisabled || []).filter((name) => typeof name === 'string' && name))];
}

export const isBuiltin = (raw) => raw?.name === AGENT_SERVER || raw?.config?.type === 'sdk' || raw?.source === 'sdk' || raw?.scope === 'sdk';

/** Where a server comes from: claudeai, plugin, user, project, local, builtin or other. */
export function serverGroup(raw) {
  if (isBuiltin(raw)) return 'builtin';
  if (raw.scope === 'claudeai' || raw.config?.type === 'claudeai-proxy' || String(raw.name).startsWith('claude.ai ')) return 'claudeai';
  if (raw.source === 'plugin' || String(raw.name).startsWith('plugin:')) return 'plugin';
  if (['user', 'project', 'local'].includes(raw.scope)) return raw.scope;
  return 'other';
}

/** How a server signs in: `claudeai` (on claude.ai), `oauth` (the paste flow), or null (it cannot). */
export function authKind(raw) {
  const type = raw?.config?.type;
  if (type === 'claudeai-proxy') return 'claudeai';
  if (type === 'http' || type === 'sse') return 'oauth';
  return null;
}

/** An http/sse server's address without credentials, query or fragment; undefined for the rest. */
export function publicUrl(config) {
  if (!config || (config.type !== 'http' && config.type !== 'sse') || typeof config.url !== 'string') return undefined;
  try {
    const url = new URL(config.url);
    return url.origin + url.pathname;
  } catch {
    return undefined;
  }
}

/** A failure message cut short, on one line, with query strings and bearer tokens removed. */
export function scrubError(text) {
  if (!text) return undefined;
  const clean = String(text)
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 …')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX_ERROR_CHARS ? clean.slice(0, MAX_ERROR_CHARS - 1) + '…' : clean;
}

function publicTool(tool) {
  const description = typeof tool.description === 'string' ? tool.description.trim().slice(0, MAX_TOOL_DESCRIPTION_CHARS) : '';
  return {
    name: String(tool.name),
    description,
    ...(tool.annotations?.readOnly ? { readOnly: true } : {}),
    ...(tool.annotations?.destructive ? { destructive: true } : {}),
  };
}

/**
 * One `mcp_status` row in the API shape: never the config's headers, env, command line
 * or an http server's query string.
 * @param {object} raw  `{name, status, serverInfo?, error?, config?, scope?, source?, tools?}`
 * @param {{disabled?: Set<string>}} [options]  the session's disabled servers
 */
export function publicServer(raw, { disabled = new Set() } = {}) {
  const tools = (raw.tools || []).filter((tool) => tool?.name).map(publicTool);
  const builtin = isBuiltin(raw);
  const type = raw.config?.type ?? (builtin ? 'sdk' : raw.config ? 'stdio' : undefined);
  const url = publicUrl(raw.config);
  return {
    name: raw.name,
    status: raw.status,
    scope: raw.scope,
    source: raw.source,
    group: serverGroup(raw),
    type,
    ...(url ? { url } : {}),
    ...(raw.status === 'failed' && raw.error ? { error: scrubError(raw.error) } : {}),
    ...(raw.serverInfo?.name ? { serverInfo: { name: String(raw.serverInfo.name), ...(raw.serverInfo.version ? { version: String(raw.serverInfo.version) } : {}) } } : {}),
    tools,
    toolCount: tools.length,
    // Harbor's own server can never be switched off; the rest can, per session.
    builtin,
    disabledInSession: !builtin && disabled.has(raw.name),
    auth: authKind(raw),
  };
}

/** The status list in the API shape, sorted by group and then name. */
export function publicServers(rows, session) {
  const disabled = new Set(disabledServers(session));
  return (rows || []).filter((row) => row?.name).map((row) => publicServer(row, { disabled }));
}

/** True when a status row means a sign-in is still to be done. */
export const needsAuth = (server) => server.status === 'needs-auth';

/**
 * Checks the address a user copied from the browser after approving a sign-in: the page
 * `http://localhost:<port>/callback?code=…&state=…` that failed to load on their own
 * machine. Only http(s) on localhost or 127.0.0.1 carrying a `code` or `error` is
 * accepted. Never echoes the address (it holds the authorization code).
 * @returns {{ok: true, url: string, code: boolean, error?: string, state?: string} | {ok: false, error: string}}
 */
export function parseCallbackUrl(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Paste the address from your browser.' };
  // Terminals and chat apps wrap or quote what they copy.
  const text = value.trim().replace(/^[<"'`]+|[>"'`]+$/g, '').trim();
  if (!text) return { ok: false, error: 'Paste the address from your browser.' };
  if (text.length > MAX_CALLBACK_URL_CHARS) return { ok: false, error: 'That address is too long to be the one from the sign-in page.' };
  if (/\s/.test(text)) return { ok: false, error: 'Paste only the address, as one line.' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That is not a web address. Copy the whole address from the browser’s address bar.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The address must start with http://localhost.' };
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return { ok: false, error: 'The address must be the one on localhost that the browser failed to open, not the sign-in page itself.' };
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return { ok: false, error: 'The address has no code. Copy the whole address after approving, including everything after the “?”.' };
  return { ok: true, url: text, code: Boolean(code), ...(error ? { error } : {}), ...(url.searchParams.get('state') ? { state: url.searchParams.get('state') } : {}) };
}

const MAX_HIDDEN = 10;
const cleanName = (text) => String(text).trim().slice(0, 80);

/**
 * Servers Claude Code leaves out of its status list because two entries share an address
 * (its "dedup", which can drop a signed-in plugin server and the claude.ai connector that
 * duplicates it, measured on 2.1.290). Read from the debug log of a no-prompt process:
 *   Lazy dedup: suppressing 1 plugin server(s) that duplicate claude.ai connectors: a, b
 *   Suppressing claude.ai connector "claude.ai Slack": duplicates manually-configured "plugin:slack:slack"
 * @returns {{name: string, reason: string}[]}
 */
export function parseHiddenServers(log) {
  const hidden = new Map();
  for (const line of String(log || '').split('\n')) {
    const plugins = line.match(/Lazy dedup: suppressing \d+ plugin server\(s\) that duplicate claude\.ai connectors: (.+)$/);
    if (plugins) {
      for (const name of plugins[1].split(',').map(cleanName).filter(Boolean)) hidden.set(name, 'It has the same address as a claude.ai connector.');
      continue;
    }
    const connector = line.match(/Suppressing claude\.ai connector "([^"]+)": duplicates manually-configured "([^"]+)"/);
    if (connector) hidden.set(cleanName(connector[1]), `It has the same address as ${cleanName(connector[2])}.`);
  }
  return [...hidden].slice(0, MAX_HIDDEN).map(([name, reason]) => ({ name, reason }));
}
