// `/` commands for the composer: what Claude Code offers in a project (its own commands,
// plus skills and custom commands from the user, project and plugins), followed by the
// commands Harbor handles in the browser. The same no-prompt Claude Code process also
// lists the project's subagents (built in, user, project and plugin agents) for the
// Agents view.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { MODELS, resolveEffort, runsDirect } from './models.mjs';
import { buildQueryOptions } from './runner.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;

export const LOCAL_COMMANDS = [
  { name: 'clear', description: 'Start a new session in this project', argumentHint: '', source: 'local' },
  { name: 'model', description: 'Switch the model', argumentHint: '<model>', source: 'local' },
  { name: 'mode', description: 'Change the permission mode', argumentHint: '<mode>', source: 'local' },
  { name: 'effort', description: 'Set the reasoning effort', argumentHint: '<effort>', source: 'local' },
  { name: 'rename', description: 'Rename this session', argumentHint: '<title>', source: 'local' },
  { name: 'fork', description: 'Copy this conversation into a new session', argumentHint: '', source: 'local' },
  { name: 'import', description: 'Import Claude Code or Codex sessions', argumentHint: '', source: 'local' },
  { name: 'agents', description: 'Show the agents this session can use', argumentHint: '', source: 'local' },
  { name: 'settings', description: 'Edit Claude Code permissions, hooks, CLAUDE.md and memory', argumentHint: '[permissions|hooks|claude.md|memory|mcp]', source: 'local' },
  { name: 'mcp', description: 'Show and manage this session’s MCP servers', argumentHint: '', source: 'local' },
  { name: 'help', description: 'Show the available commands', argumentHint: '', source: 'local' },
];
const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((command) => command.name));

/**
 * The SDK's SlashCommand rows in the API shape. Claude Code's own commands are `sdk`;
 * rows the SDK does not mark builtin (skills, custom and plugin commands) are `skill`.
 * A name listed twice keeps its builtin row, which is the one `/name` runs. Names the
 * browser handles itself are left to the local commands; internal `__` rows are dropped.
 */
export function toCommandList(sdkCommands) {
  const byName = new Map();
  for (const command of sdkCommands || []) {
    // `__name` rows are Claude Code internals, not meant to be typed.
    if (!command?.name || command.name.startsWith('__') || LOCAL_NAMES.has(command.name)) continue;
    const existing = byName.get(command.name);
    if (existing && (existing.source === 'sdk' || !command.builtin)) continue;
    byName.set(command.name, {
      name: command.name,
      description: command.description || '',
      argumentHint: command.argumentHint || '',
      source: command.builtin ? 'sdk' : 'skill',
    });
  }
  return [...byName.values(), ...LOCAL_COMMANDS];
}

/** Claude Code's AgentInfo rows as `{name, description, model}` (`inherit`: the session's model). */
export function toAgentList(sdkAgents) {
  const seen = new Set();
  const agents = [];
  for (const agent of sdkAgents || []) {
    if (!agent?.name || seen.has(agent.name)) continue;
    seen.add(agent.name);
    agents.push({ name: agent.name, description: agent.description || '', model: agent.model || 'inherit' });
  }
  return agents;
}

/** Asks a Claude Code process for its commands and agents without sending it any message. */
async function discoverProject(cwd, { config, gateway, query, timeoutMs }) {
  // A gateway route, so starting the CLI never touches the Claude subscription; no
  // message is sent, so no model is called either.
  const model = MODELS.find((entry) => !runsDirect(entry));
  const abortController = new AbortController();
  const options = buildQueryOptions(
    { cwd, mode: 'default' },
    {
      model,
      effort: resolveEffort(model.id, {}),
      claudeExecutable: config.claudeExecutable,
      gateway,
      settingSources: config.settingSources,
      claudeConfigDir: config.claudeConfigDir,
      abortController,
    },
  );
  options.persistSession = false;
  options.includePartialMessages = false;

  // The prompt stream stays open (and empty) until discovery is over: the SDK ends the
  // control channel when its prompt iterable finishes.
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const prompt = (async function* idle() {
    await released;
  })();

  let timer;
  let stream;
  try {
    stream = query({ prompt, options });
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Command discovery timed out')), timeoutMs);
    });
    // Agents are a bonus: a CLI without the request still lists its commands.
    const agents = stream.supportedAgents ? stream.supportedAgents().catch(() => []) : Promise.resolve([]);
    const [commands, agentList] = await Promise.race([Promise.all([stream.supportedCommands(), agents]), timeout]);
    return { commands, agents: agentList };
  } finally {
    clearTimeout(timer);
    stream?.close();
    abortController.abort();
    release();
  }
}

const MAX_CONCURRENT_DISCOVERIES = 2;
const MAX_CACHED_FOLDERS = 50;

/**
 * @param {object} deps
 * @param {{claudeExecutable: string, settingSources?: string[], claudeConfigDir?: string}} deps.config
 * @param {{url: string, apiKey: string}} [deps.gateway]  the normalizing proxy (as for turns)
 * @param {Function} [deps.query]  the SDK query function (replaceable in tests)
 */
export function createCommandCatalog({
  config,
  gateway,
  query = sdkQuery,
  log = console.error,
  ttlMs = CACHE_TTL_MS,
  failureTtlMs = FAILURE_TTL_MS,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  now = Date.now,
}) {
  const cache = new Map(); // cwd -> { expires, commands: Promise }, oldest first
  // Each discovery launches a CLI (and the project's SessionStart hooks): few at a time.
  let running = 0;
  const waiting = [];
  async function limited(task) {
    if (running >= MAX_CONCURRENT_DISCOVERIES) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  /** `{commands, agents}` for a project folder (already confined); never rejects. */
  function discover(cwd) {
    const hit = cache.get(cwd);
    if (hit && hit.expires > now()) return hit.found;
    cache.delete(cwd);
    while (cache.size >= MAX_CACHED_FOLDERS) cache.delete(cache.keys().next().value);
    const entry = { expires: Infinity };
    entry.found = limited(() => discoverProject(cwd, { config, gateway, query, timeoutMs })).then(
      ({ commands, agents }) => {
        entry.expires = now() + ttlMs;
        return { commands: toCommandList(commands), agents: toAgentList(agents) };
      },
      (error) => {
        log(`Command discovery failed in ${cwd}: ${error.message}`);
        entry.expires = now() + failureTtlMs;
        return { commands: toCommandList([]), agents: [] };
      },
    );
    cache.set(cwd, entry);
    return entry.found;
  }

  /** The command list for a project folder (already confined); never rejects. */
  async function list(cwd) {
    return (await discover(cwd)).commands;
  }

  /** Claude Code's subagents in a project folder (already confined); never rejects. */
  async function agents(cwd) {
    return (await discover(cwd)).agents;
  }

  return { list, agents };
}
