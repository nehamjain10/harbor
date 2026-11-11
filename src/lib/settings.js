// Pure helpers of the settings dialog (permissions, hooks, CLAUDE.md, memory): what a
// save says, text for diffs, drafts of the hooks block, memory file names.
import { MEMORY_NAME } from '../../server/memory-format.mjs';
import { HOOK_EVENTS, PERMISSION_LISTS, hookSummary, hooksProblem } from '../../server/settings-schema.mjs';

// The tabs `/settings <word>` opens.
const TAB_WORDS = {
  permissions: 'permissions',
  permission: 'permissions',
  rules: 'permissions',
  allow: 'permissions',
  hooks: 'hooks',
  hook: 'hooks',
  'claude.md': 'instructions',
  claude: 'instructions',
  instructions: 'instructions',
  memory: 'memory',
  memories: 'memory',
  mcp: 'mcp',
  servers: 'mcp',
};

/** The tab id for a `/settings` argument, or null. */
export const tabFromArg = (arg) => TAB_WORDS[String(arg || '').trim().toLowerCase()] || null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The toast after a write. `restartsPending` is how many live Claude Code processes were
 * marked to restart when idle; `live` is for files Claude reads on demand (a memory's text).
 * A deletion passes `verb: 'Deleted'` and `changed: true`.
 */
export function savedText(result, { live = false, verb = 'Saved' } = {}) {
  if (!result.changed) return 'Nothing changed.';
  const n = result.restartsPending || 0;
  if (n > 0) return `${verb} · applies to ${plural(n, 'session', 'sessions')} after ${n === 1 ? 'its' : 'their'} next restart`;
  return live ? verb : `${verb} · no running sessions to restart`;
}

/** The text with `\n` line ends and the line ending it had (a textarea always reports `\n`). */
export function splitEol(text) {
  const source = String(text ?? '');
  return source.includes('\r\n') ? { text: source.replace(/\r\n/g, '\n'), eol: '\r\n' } : { text: source, eol: '\n' };
}

export const joinEol = (text, eol) => (eol === '\r\n' ? text.replace(/\n/g, eol) : text);

/** A file size for a list row: `812 B`, `3.4 KB`. */
export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/* Permissions */

/** The permissions of a settings file as text, for diffs: one heading per list, rules indented under it. */
export function permissionsText({ allow = [], ask = [], deny = [], defaultMode = null, additionalDirectories = [] } = {}) {
  const lists = { allow, ask, deny };
  const lines = [];
  if (defaultMode) lines.push(`defaultMode: ${defaultMode}`);
  for (const name of PERMISSION_LISTS) {
    if (!lists[name].length) continue;
    lines.push(`${name}:`, ...lists[name].map((rule) => `  ${rule}`));
  }
  if (additionalDirectories.length) lines.push('additionalDirectories:', ...additionalDirectories.map((dir) => `  ${dir}`));
  return lines.length ? lines.join('\n') + '\n' : '';
}

const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

/** What `draft` changes against `base`, as a PATCH `permissions` body (only the changed keys; null removes `defaultMode`). */
export function permissionsPatch(base, draft) {
  const patch = {};
  for (const key of [...PERMISSION_LISTS, 'additionalDirectories']) if (!sameList(base[key], draft[key])) patch[key] = draft[key];
  if ((base.defaultMode || null) !== (draft.defaultMode || null)) patch.defaultMode = draft.defaultMode || null;
  return patch;
}

/** `rule` is a problem for a list that has `items` (already there, or malformed), else null. */
export function duplicateProblem(items, rule, except = -1) {
  return items.some((item, i) => i !== except && item === rule) ? 'This one is already in the list.' : null;
}

/* Hooks */

/** The hooks block as editable text (an empty block is `{}`). */
export const hooksText = (hooks) => JSON.stringify(hooks && Object.keys(hooks).length ? hooks : {}, null, 2) + '\n';

/** `{hooks}` for hooks text that parses and passes the schema, else `{error}`. */
export function parseHooksDraft(text) {
  let hooks;
  try {
    hooks = JSON.parse(text.trim() || '{}');
  } catch (error) {
    return { error: `Invalid JSON: ${error.message}` };
  }
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { error: 'Hooks are an object keyed by event name, like {"PreToolUse": [...]}.' };
  const problem = hooksProblem(hooks);
  return problem ? { error: problem } : { hooks };
}

/** The hooks as rows for display: `[{event, known, groups: [{matcher, hooks: [{type, summary, timeout}]}]}]`. */
export function hookRows(hooks) {
  return Object.entries(hooks || {}).map(([event, groups]) => ({
    event,
    known: HOOK_EVENTS.includes(event),
    groups: (Array.isArray(groups) ? groups : []).map((group) => ({
      matcher: typeof group?.matcher === 'string' ? group.matcher : '',
      hooks: (Array.isArray(group?.hooks) ? group.hooks : []).map((hook) => ({ type: hook?.type || 'command', summary: hookSummary(hook), timeout: hook?.timeout })),
    })),
  }));
}

/* Memory */

/** A file name suggested by a title: `Release checklist` → `release-checklist`. */
export const memoryStem = (title) =>
  String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Why `stem` (the name without `.md`) is not a usable new memory name, or null. */
export function memoryNameProblem(stem, existing = []) {
  const name = `${stem}.md`;
  if (!stem) return 'Give the file a name.';
  if (name.toLowerCase() === 'memory.md') return 'MEMORY.md is the index.';
  if (!MEMORY_NAME.test(name)) return 'Use letters, digits, dots, dashes and underscores.';
  if (existing.some((other) => other.toLowerCase() === name.toLowerCase())) return 'A memory with this name exists.';
  return null;
}

/* Projects */

/** The folders to choose from: the session's, the chosen one, the default, then those of the other sessions. */
export function projectChoices({ cwd, project, defaultProject, sessions }) {
  const seen = new Set();
  const out = [];
  for (const dir of [cwd, project, defaultProject, ...(sessions || []).map((session) => session.cwd)]) {
    if (!dir || typeof dir !== 'string' || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    if (out.length >= 30) break;
  }
  return out;
}
