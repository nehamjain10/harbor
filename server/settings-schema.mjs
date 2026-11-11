// What Claude Code's settings files may hold in the parts Harbor edits: permission rules,
// `defaultMode`, additional directories and hooks. Pure functions (no Node APIs): the
// settings dialog bundles this module too, so the browser and the server agree on what is
// valid. Anything else in a settings file is none of our business and is never checked.

export const PERMISSION_LISTS = ['allow', 'ask', 'deny'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
// The events Claude Code knows (sdk.d.ts HOOK_EVENTS); others are accepted but flagged.
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit', 'UserPromptExpansion',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay',
];

export const MAX_RULE_LENGTH = 1000;
// `Tool` or `Tool(specifier)`: Bash(npm run test:*), Read(~/secrets/**), mcp__server__tool.
const RULE = /^[A-Za-z0-9_.*:-]+(\([^\n]*\))?$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Why `rule` is not a permission rule, or null when it is one. */
export function ruleProblem(rule) {
  if (typeof rule !== 'string' || !rule.trim()) return 'A rule cannot be empty.';
  if (rule !== rule.trim()) return 'A rule cannot start or end with spaces.';
  if (rule.length > MAX_RULE_LENGTH) return `A rule can be at most ${MAX_RULE_LENGTH} characters.`;
  if (/[\n\r]/.test(rule)) return 'A rule is a single line.';
  if (!RULE.test(rule)) return 'Write a tool name, optionally with a specifier in brackets: Bash(npm run test:*), Read(~/secrets/**), mcp__server__tool.';
  return null;
}

/** Why `value` is not a list of strings that `check` accepts, or null. */
function listProblem(value, label, check) {
  if (!Array.isArray(value)) return `${label} must be a list.`;
  for (const item of value) {
    const problem = check(item);
    if (problem) return `${label}: ${problem}`;
  }
  return null;
}

const directoryProblem = (value) => (typeof value !== 'string' || !value.trim() || /[\n\r]/.test(value) ? 'A directory is a single line of text.' : null);

/** Why a settings `permissions` value (or part of one) is invalid, or null. Unknown keys are fine. */
export function permissionsProblem(permissions) {
  if (permissions === undefined) return null;
  if (!isObject(permissions)) return '"permissions" must be an object.';
  for (const list of PERMISSION_LISTS) {
    if (permissions[list] === undefined) continue;
    const problem = listProblem(permissions[list], `permissions.${list}`, ruleProblem);
    if (problem) return problem;
  }
  if (permissions.additionalDirectories !== undefined) {
    const problem = listProblem(permissions.additionalDirectories, 'permissions.additionalDirectories', directoryProblem);
    if (problem) return problem;
  }
  if (permissions.defaultMode !== undefined && (typeof permissions.defaultMode !== 'string' || !/^[A-Za-z]+$/.test(permissions.defaultMode))) {
    return 'permissions.defaultMode must be a mode name.';
  }
  return null;
}

/** Why a settings `hooks` value is invalid, or null: `{Event: [{matcher?, hooks: [{type, command, timeout?}]}]}`. */
export function hooksProblem(hooks) {
  if (hooks === undefined) return null;
  if (!isObject(hooks)) return '"hooks" must be an object keyed by event name.';
  for (const [event, groups] of Object.entries(hooks)) {
    const at = `hooks.${event}`;
    if (!Array.isArray(groups)) return `${at} must be a list of matcher groups.`;
    for (const [i, group] of groups.entries()) {
      if (!isObject(group)) return `${at}[${i}] must be an object.`;
      if (group.matcher !== undefined && typeof group.matcher !== 'string') return `${at}[${i}].matcher must be text.`;
      if (!Array.isArray(group.hooks)) return `${at}[${i}].hooks must be a list.`;
      for (const [j, hook] of group.hooks.entries()) {
        const where = `${at}[${i}].hooks[${j}]`;
        if (!isObject(hook)) return `${where} must be an object.`;
        if (typeof hook.type !== 'string' || !hook.type) return `${where}.type must be text (for example "command").`;
        if (hook.type === 'command' && (typeof hook.command !== 'string' || !hook.command.trim())) return `${where}.command must be the command to run.`;
        if (hook.timeout !== undefined && (typeof hook.timeout !== 'number' || !(hook.timeout > 0))) return `${where}.timeout must be a number of seconds above 0.`;
      }
    }
  }
  return null;
}

/** Why a whole settings object is invalid (only the parts Harbor knows), or null. */
export function settingsProblem(settings) {
  if (!isObject(settings)) return 'A settings file holds a JSON object.';
  return permissionsProblem(settings.permissions) || hooksProblem(settings.hooks);
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/** The permission rules, default mode and directories of parsed settings, each list present (maybe empty). */
export function permissionsView(settings) {
  const permissions = isObject(settings?.permissions) ? settings.permissions : {};
  return {
    allow: strings(permissions.allow),
    ask: strings(permissions.ask),
    deny: strings(permissions.deny),
    defaultMode: typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null,
    additionalDirectories: strings(permissions.additionalDirectories),
  };
}

/** The hooks of parsed settings (an object keyed by event; `{}` when there are none). */
export function hooksView(settings) {
  return isObject(settings?.hooks) ? settings.hooks : {};
}

/** What a hook runs, for one line of display: its command, prompt, URL or MCP tool. */
export function hookSummary(hook) {
  if (!isObject(hook)) return '';
  return hook.command || hook.prompt || hook.url || (hook.server ? `${hook.server}${hook.tool ? ':' + hook.tool : ''}` : '') || '';
}
