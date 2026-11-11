// Slash commands for the composer: the client-side ("local") commands, merging them
// with GET /api/commands, grouping for the menu, and the per-project cache.
import { fuzzyScore } from './mentions.js';

export const LOCAL_COMMANDS = [
  { name: 'clear', description: 'Start a new chat in this project (keeps model and mode)', source: 'local' },
  { name: 'model', description: 'Switch the model', source: 'local' },
  { name: 'mode', description: 'Change the permission mode', source: 'local' },
  { name: 'effort', description: 'Change the reasoning effort', source: 'local' },
  { name: 'rename', description: 'Rename this chat', argumentHint: '<title>', source: 'local' },
  { name: 'fork', description: 'Copy this chat into a new one; the original stays as it is', source: 'local' },
  { name: 'import', description: 'Import Claude Code or Codex sessions', source: 'local' },
  { name: 'agents', description: 'Agents this session can use: model agents and subagents', source: 'local' },
  { name: 'tasks', description: 'Background commands, Monitors and scheduled jobs', source: 'local' },
  { name: 'settings', description: 'Claude Code settings: permissions, hooks, CLAUDE.md, memory', argumentHint: '[permissions|hooks|claude.md|memory|mcp]', source: 'local' },
  { name: 'mcp', description: 'MCP servers: switch them for this chat, sign in, reconnect', source: 'local' },
  { name: 'help', description: 'Shortcuts and commands', source: 'local' },
];

const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((c) => c.name));

export const COMMAND_GROUPS = [
  { id: 'local', label: 'Local' },
  { id: 'skill', label: 'Skills' },
  { id: 'sdk', label: 'Commands' },
];

const cleanName = (name) => String(name || '').replace(/^\//, '').trim();

// Server commands plus the local ones (local definitions win on a name clash).
export function mergeCommands(serverCommands = []) {
  const seen = new Set(LOCAL_NAMES);
  const merged = [...LOCAL_COMMANDS];
  for (const command of Array.isArray(serverCommands) ? serverCommands : []) {
    const name = cleanName(command?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push({
      name,
      description: command.description || '',
      argumentHint: command.argumentHint || '',
      source: command.source === 'skill' ? 'skill' : command.source === 'local' ? 'local' : 'sdk',
    });
  }
  return merged;
}

// Commands matching `query` (fuzzy on the name, weaker on the description), grouped
// Local / Skills / Commands. With a query the groups follow the best match's order.
export function groupCommands(commands, query = '') {
  const q = query.trim().toLowerCase();
  const scored = commands
    .map((command, index) => {
      const byName = fuzzyScore(q, command.name);
      const byDescription = q.length >= 3 && String(command.description || '').toLowerCase().includes(q) ? 50 : -1;
      return { command, index, score: Math.max(byName, byDescription) };
    })
    .filter((entry) => entry.score >= 0);
  const groups = COMMAND_GROUPS.map((group) => {
    const items = scored
      .filter((entry) => entry.command.source === group.id)
      .sort((a, b) => (q ? b.score - a.score : 0) || a.index - b.index);
    return { ...group, best: items[0]?.score ?? -1, items: items.map((entry) => entry.command) };
  }).filter((group) => group.items.length);
  if (q) groups.sort((a, b) => b.best - a.best);
  return groups.map(({ best, ...group }) => group);
}

// A submitted text that is a local command: { name, args }, else null.
export function parseLocalCommand(text) {
  const match = String(text || '').trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!match || !LOCAL_NAMES.has(match[1])) return null;
  return { name: match[1], args: (match[2] || '').trim() };
}

// Commands are fetched once per cwd and kept in memory; an entry older than `maxAge`
// is still served but refreshed in the background.
export function createCommandCache({ load, now = () => Date.now(), maxAge = 5 * 60_000 }) {
  const entries = new Map();

  function refresh(cwd) {
    const entry = entries.get(cwd) || { commands: null, at: 0, promise: null };
    if (entry.promise) return entry.promise;
    entry.promise = Promise.resolve()
      .then(() => load(cwd))
      .then((commands) => {
        entry.commands = mergeCommands(commands);
        entry.at = now();
        return entry.commands;
      })
      .finally(() => {
        entry.promise = null;
      });
    entries.set(cwd, entry);
    return entry.promise;
  }

  return {
    // Cached commands for `cwd` (local ones only until the first fetch lands).
    peek(cwd) {
      return entries.get(cwd)?.commands || null;
    },
    // Ensures the cache is warm: fetches when missing or stale. Resolves to the list.
    ensure(cwd) {
      const entry = entries.get(cwd);
      if (entry?.commands && now() - entry.at < maxAge) return Promise.resolve(entry.commands);
      return refresh(cwd);
    },
    isStale(cwd) {
      const entry = entries.get(cwd);
      return !entry?.commands || now() - entry.at >= maxAge;
    },
  };
}
