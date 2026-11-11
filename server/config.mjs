// Runtime configuration: environment, paths and fixed limits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClusters } from './clusters.mjs';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(REPO_DIR, 'public');
export const DEFAULT_GATEWAY = 'http://127.0.0.1:3425';
// The API key sent to the gateway when WORKBENCH_GATEWAY_KEY is unset.
export const GATEWAY_PLACEHOLDER_KEY = 'harbor';

export const MAX_MESSAGE_LENGTH = 150_000;
export const MAX_QUEUED_MESSAGES = 30;
export const MAX_TOOL_OUTPUT = 60_000;
export const PUBLISH_THROTTLE_MS = 120;
// A session whose publish took at least SLOW_PUBLISH_MS (a long transcript) publishes
// again only PUBLISH_COST_FACTOR times that later, flushes included, so publishing one
// session never takes more than about a fifth of the event loop (see events.mjs).
export const SLOW_PUBLISH_MS = 10;
export const PUBLISH_COST_FACTOR = 4;
// Session files this large are written off the event loop, at most once per
// LARGE_SAVE_INTERVAL_MS after the previous write (see store.mjs persist).
export const LARGE_SAVE_BYTES = 2 * 1024 * 1024;
export const LARGE_SAVE_INTERVAL_MS = 2_000;
export const HEARTBEAT_MS = 15_000;
export const SHUTDOWN_GRACE_MS = 2_000;
export const STOP_GRACE_MS = 5_000;
// Long-lived Claude Code processes (see cli-pool.mjs). An idle CLI holds ~235-265 MB;
// a process unused this long exits (the next turn resumes it), at most this many stay
// alive (least recently used idle ones close first), and a graceful close may take this
// long before the process is killed. A resumed process re-sends the conversation without
// its prompt cache (only the part every session shares is reused), so the idle limit
// matches Claude Code's one-hour cache: closing earlier would throw away a warm cache.
export const CLI_IDLE_MS = 60 * 60_000;
export const CLI_MAX_PROCESSES = 10;
export const CLI_CLOSE_GRACE_MS = 3_000;
// Each model agent is a Claude Code process of its own (~250 MB). No cap by default
// (the user's choice, 10-28); WORKBENCH_MODEL_AGENTS_MAX sets one.
export const MODEL_AGENTS_MAX = Infinity;
export const LIVE_THROTTLE_MS = 120;
export const MAX_PUBLIC_TOOL_OUTPUT = 4_000;
// A client whose unsent SSE backlog grows past this is cut off; it reconnects and
// receives the full state again.
export const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;

const SETTING_SOURCES = ['user', 'project', 'local'];

/** Claude Code setting sources from a comma list; `none` means no settings files at all. */
export function parseSettingSources(value) {
  if (value === undefined || value === null || value.trim() === '') return [...SETTING_SOURCES];
  if (value.trim() === 'none') return [];
  const sources = value.split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = sources.filter((source) => !SETTING_SOURCES.includes(source));
  if (unknown.length) throw new Error(`WORKBENCH_SETTING_SOURCES: unknown source ${unknown.join(', ')} (use user, project, local or none)`);
  return sources;
}

/** A positive number from the environment, or the fallback when unset or invalid. */
function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name}: expected a positive number, got "${value}"`);
  return number;
}

/**
 * Reads the server configuration from the environment. Throws when the
 * required identity variables are missing. Has no side effects.
 */
export function loadConfig(env = process.env) {
  const owner = env.WORKBENCH_OWNER;
  const publicHost = env.WORKBENCH_HOST;
  if (!owner || !publicHost) throw new Error('WORKBENCH_OWNER and WORKBENCH_HOST are required');

  // The home directory is the outer boundary for every project and file path.
  const homeRoot = fs.realpathSync(os.homedir());

  const dataDir = path.resolve(env.WORKBENCH_DATA_DIR || path.join(REPO_DIR, 'data'));
  return {
    owner,
    publicHost,
    origin: 'https://' + publicHost,
    homeRoot,
    repoDir: REPO_DIR,
    publicDir: PUBLIC_DIR,
    dataDir,
    // The CLI host (cli-host.mjs) owns the Claude Code processes so they outlive server
    // restarts; WORKBENCH_CLI_HOST=0 runs them as children of the server instead.
    cliHostSocket: env.WORKBENCH_CLI_HOST === '0' ? null : path.join(dataDir, 'cli-host.sock'),
    cliHostLog: path.join(dataDir, 'cli-host.log'),
    // Unix socket only (see socket.mjs); there is deliberately no TCP option.
    socketPath: path.resolve(env.WORKBENCH_SOCKET || path.join(REPO_DIR, 'web.sock')),
    gatewayUrl: (env.WORKBENCH_GATEWAY || DEFAULT_GATEWAY).replace(/\/+$/, ''),
    // The placeholder suits a gateway that accepts any key; staging and e2e point at the
    // authenticated mock gateway.
    gatewayKey: env.WORKBENCH_GATEWAY_KEY || GATEWAY_PLACEHOLDER_KEY,
    claudeExecutable: path.join(homeRoot, '.local/bin/claude'),
    // Test isolation: which settings files Claude Code loads, and an alternative ~/.claude.
    settingSources: parseSettingSources(env.WORKBENCH_SETTING_SOURCES),
    claudeConfigDir: env.WORKBENCH_CLAUDE_CONFIG_DIR ? path.resolve(env.WORKBENCH_CLAUDE_CONFIG_DIR) : undefined,
    // Where session import finds Codex sessions (read only).
    codexHome: path.resolve(env.WORKBENCH_CODEX_HOME || path.join(homeRoot, '.codex')),
    // The gateway's usage dashboard, linked from the sidebar (no link when unset).
    dashboardUrl: env.WORKBENCH_DASHBOARD_URL || null,
    // The folder a new chat starts in (absolute, or relative to the home folder) when it
    // exists; the home folder otherwise.
    defaultProject: env.WORKBENCH_DEFAULT_PROJECT || null,
    // How long an unused Claude Code process stays alive, and how many may.
    cliIdleMs: Math.round(positiveNumber(env.WORKBENCH_CLI_IDLE_MINUTES, CLI_IDLE_MS / 60_000, 'WORKBENCH_CLI_IDLE_MINUTES') * 60_000),
    cliMaxProcesses: Math.floor(positiveNumber(env.WORKBENCH_CLI_MAX_PROCESSES, CLI_MAX_PROCESSES, 'WORKBENCH_CLI_MAX_PROCESSES')) || 1,
    // Claude routes through the gateway's Claude relay (account switching) while it
    // answers. The relay is probed at relayStatusPath on the gateway; without one there is
    // no relay and Claude goes direct.
    claudeRelay: env.WORKBENCH_CLAUDE_RELAY !== '0',
    relayStatusPath: env.WORKBENCH_RELAY_STATUS_PATH || null,
    // The key the gateway proxy puts on relayed Claude requests (see gateway-proxy.mjs).
    relayKeyFile: env.WORKBENCH_RELAY_KEY_FILE ? path.resolve(env.WORKBENCH_RELAY_KEY_FILE) : null,
    // Model agents (parallel workers, model-agents.mjs) running at once per session (Infinity: no cap).
    modelAgentsMax: Math.floor(positiveNumber(env.WORKBENCH_MODEL_AGENTS_MAX, MODEL_AGENTS_MAX, 'WORKBENCH_MODEL_AGENTS_MAX')) || 1,
    // Where sessions can run (clusters.mjs): this machine and the login nodes over ssh.
    clusters: loadClusters(env),
  };
}
