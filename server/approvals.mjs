// Tool approvals as plain data: what a pending request looks like, what the user may
// answer, and which SDK PermissionResult (plus session changes) an answer turns into.
// No SDK or HTTP here, so the mapping is unit-testable on its own.
import path from 'node:path';
import { normalizeMode } from './store.mjs';

export const DECISIONS = ['allow', 'allowAlways', 'deny'];
export const DEFAULT_DENY_MESSAGE = 'The user declined this action.';
export const KEEP_PLANNING_MESSAGE = 'The user did not approve this plan and wants to keep planning.';
// An unanswered question does not hold the turn forever: after an hour the user is
// taken to be away, and the model decides for them.
export const QUESTION_TIMEOUT_MS = 60 * 60 * 1000;
export const QUESTION_TIMEOUT_MESSAGE =
  'The user did not answer within an hour and has probably gone to sleep. Do not ask again. Make the decision on their behalf with your best judgment, say which option you chose and why, and carry on.';

// Modes a plan approval can switch to (staying in plan mode is a deny).
const PLAN_EXIT_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

/** `question` for AskUserQuestion, `plan` for ExitPlanMode, `permission` for everything else. */
export function approvalKind(tool) {
  if (tool === 'AskUserQuestion') return 'question';
  if (tool === 'ExitPlanMode') return 'plan';
  return 'permission';
}

/**
 * The pending entry for one canUseTool call (contract "Pending"). `options` are the
 * SDK's canUseTool options; only the fields the UI needs are kept.
 */
export function pendingEntry({ id, tool, input, options = {}, at = Date.now() }) {
  const entry = { id, kind: approvalKind(tool), tool, input, at, toolUseID: options.toolUseID };
  // A suppressed "always" rule would grant more than this one action: offer only "once".
  if (Array.isArray(options.suggestions) && options.suggestions.length && !options.suppressAlwaysAllowRule) {
    entry.suggestions = options.suggestions;
  }
  for (const field of ['blockedPath', 'title', 'description', 'decisionReason', 'displayName']) {
    if (typeof options[field] === 'string' && options[field]) entry[field] = options[field];
  }
  // The UI must not pre-select or one-key approve these.
  if (options.defaultToNo === true) entry.defaultToNo = true;
  return entry;
}

// Claude Code asks about this even in bypassPermissions: an `rm` whose path is built from
// variables that may be empty (`rm -rf $DIR/$x` can become `rm -rf /`).
const EMPTY_VARIABLE_RM = /^Dangerous rm operation on possibly-empty variable path/;

/**
 * Bypass mode means "never ask me": Claude Code still asks about a few commands it will not
 * skip checks for, and Harbor answers those itself. Questions and plans still go to the
 * user. The empty-variable `rm` is not run as written: the model gets Claude Code's own
 * rewrite (`"${DIR:?}"`), which fails safely on an empty variable and runs without asking.
 * Returns the SDK answer, or null when the user should be asked.
 */
export function bypassAnswer(mode, tool, input, options = {}) {
  if (mode !== 'bypassPermissions' || approvalKind(tool) !== 'permission') return null;
  const reason = typeof options.decisionReason === 'string' ? options.decisionReason : '';
  if (EMPTY_VARIABLE_RM.test(reason)) {
    return { behavior: 'deny', message: `Not run: ${reason}. Rewrite the command that way and run it again.` };
  }
  return { behavior: 'allow', updatedInput: input };
}

/** AskUserQuestion answers: question text -> answer; multi-select lists become "a, b". */
function parseAnswers(answers) {
  if (answers === undefined || answers === null) return { answers: undefined };
  if (typeof answers !== 'object' || Array.isArray(answers)) return { error: 'Answers must map each question to its answer.' };
  const parsed = {};
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer === 'string') parsed[question] = answer;
    else if (Array.isArray(answer) && answer.every((item) => typeof item === 'string')) parsed[question] = answer.join(', ');
    else return { error: 'Each answer must be text.' };
  }
  return { answers: parsed };
}

/**
 * Validates an approval answer (POST /api/approvals/:id body). Accepts v2
 * `{decision, reason?, answers?, mode?}` and v1 `{allow: boolean, reason?, answers?}`.
 * Returns `{choice}` or `{error}`.
 */
export function parseApprovalChoice(body = {}) {
  let decision = body.decision;
  if (decision === undefined && typeof body.allow === 'boolean') decision = body.allow ? 'allow' : 'deny';
  if (!DECISIONS.includes(decision)) return { error: 'Choose Allow or Deny.' };

  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    return { error: 'The reason must be text.' };
  }
  const { answers, error } = parseAnswers(body.answers);
  if (error) return { error };

  let mode;
  if (body.mode !== undefined && body.mode !== null && body.mode !== '') {
    mode = normalizeMode(body.mode);
    if (!PLAN_EXIT_MODES.includes(mode)) return { error: 'Unknown mode' };
  }

  const choice = { decision };
  const reason = body.reason?.trim();
  if (reason) choice.reason = reason;
  if (answers) choice.answers = answers;
  if (mode) choice.mode = mode;
  return { choice };
}

// Claude Code's rule syntax: Tool or Tool(content), with \ ( ) escaped inside the parens.
function escapeRuleContent(content) {
  return content.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/** `{toolName: 'Bash', ruleContent: 'npm test:*'}` -> `Bash(npm test:*)`. */
export function ruleString({ toolName, ruleContent }) {
  return ruleContent ? `${toolName}(${escapeRuleContent(ruleContent)})` : toolName;
}

/** The allow rules a list of PermissionUpdates adds. */
function suggestedAllowRules(suggestions = []) {
  return suggestions
    .filter((update) => update.type === 'addRules' && update.behavior === 'allow' && Array.isArray(update.rules))
    .flatMap((update) => update.rules)
    .filter((rule) => rule && typeof rule.toolName === 'string' && rule.toolName)
    .map(({ toolName, ruleContent }) => (ruleContent ? { toolName, ruleContent } : { toolName }));
}

/** `existing` plus the new rules, without duplicates (compared as rule strings). */
export function mergeAllowRules(existing = [], added = []) {
  const seen = new Set();
  const merged = [];
  for (const rule of [...existing, ...added]) {
    const key = ruleString(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rule);
  }
  return merged;
}

function mergeDirectories(existing = [], added = []) {
  return [...new Set([...existing, ...added])];
}

/**
 * Flag-settings `permissions` that re-apply a session's "allow always" grants on a new
 * CLI launch (each turn is one), or undefined when there are none.
 */
export function sessionPermissionSettings(session) {
  const permissions = {};
  if (session.allowRules?.length) permissions.allow = session.allowRules.map(ruleString);
  if (session.allowDirectories?.length) permissions.additionalDirectories = [...session.allowDirectories];
  return Object.keys(permissions).length ? permissions : undefined;
}

function insideAny(target, roots) {
  return roots.some((root) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

/**
 * Backstop for flag settings: true when the session already allowed exactly this call,
 * i.e. a whole-tool rule or the identical Bash command. The flag-settings rules already
 * cover everything they genuinely allow, so when the CLI still asks for a reason of its
 * own (a sensitive file, an ask rule, a path outside the granted directories) the user
 * decides. Questions and plans always need the user.
 */
export function allowedBySession(session, tool, input, options = {}) {
  if (approvalKind(tool) !== 'permission' || !session.allowRules?.length) return false;
  if (options.decisionReason || options.matchedAskRule || options.defaultToNo) return false;
  if (options.blockedPath && !insideAny(path.resolve(session.cwd || '/', options.blockedPath), [session.cwd, ...(session.allowDirectories || [])].filter(Boolean))) {
    return false;
  }
  const granted = new Set(session.allowRules.map(ruleString));
  if (granted.has(tool)) return true;
  return tool === 'Bash' && typeof input?.command === 'string' && granted.has(ruleString({ toolName: 'Bash', ruleContent: input.command }));
}

/** Every update scoped to this session: never write the user's settings files. */
function sessionScoped(suggestions = []) {
  return suggestions.map((update) => ({ ...update, destination: 'session' }));
}

/** The mode a plan approval leaves the session in. */
function modeAfterPlan(choice, sessionMode) {
  if (choice.mode) return choice.mode;
  // Approving a plan ends plan mode; Claude Code itself falls back to default.
  return sessionMode === 'plan' ? 'default' : sessionMode;
}

/**
 * Maps the user's answer to a pending entry onto the SDK PermissionResult and the
 * session changes it implies.
 * @param {object} entry  the pending entry (`kind`, `tool`, `input`, `suggestions?`)
 * @param {object} choice  from parseApprovalChoice
 * @param {object} context
 * @param {string} context.sessionMode  the session's stored mode
 * @param {(mode: string) => string} [context.sdkMode]  stored mode -> the SDK mode this
 *   turn's model runs it as
 * @returns {{result: object, mode?: string, allowRules?: object[], allowDirectories?: string[]}}
 *   `mode`, `allowRules` and `allowDirectories` are what to record on the session
 *   (rules and directories are additions, not yet merged with the session's own).
 */
export function decideApproval(entry, choice, { sessionMode, sdkMode = (mode) => mode } = {}) {
  if (choice.decision === 'deny') {
    if (entry.kind === 'plan') {
      const feedback = choice.reason ? ` Their feedback: ${choice.reason}` : '';
      return { result: { behavior: 'deny', message: KEEP_PLANNING_MESSAGE + feedback } };
    }
    return { result: { behavior: 'deny', message: choice.reason || DEFAULT_DENY_MESSAGE } };
  }

  let updatedInput = entry.input;
  if (entry.kind === 'question' && choice.answers) updatedInput = { ...entry.input, answers: choice.answers };

  if (entry.kind === 'plan') {
    const mode = modeAfterPlan(choice, sessionMode);
    return {
      result: { behavior: 'allow', updatedInput, updatedPermissions: [{ type: 'setMode', mode: sdkMode(mode), destination: 'session' }] },
      mode,
    };
  }

  const result = { behavior: 'allow', updatedInput };
  if (choice.decision !== 'allowAlways' || entry.kind !== 'permission' || !entry.suggestions?.length) return { result };

  result.updatedPermissions = sessionScoped(entry.suggestions);
  const decided = { result, allowRules: mergeAllowRules([], suggestedAllowRules(entry.suggestions)) };
  const directories = entry.suggestions
    .filter((update) => update.type === 'addDirectories' && Array.isArray(update.directories))
    .flatMap((update) => update.directories)
    .filter((directory) => typeof directory === 'string' && directory);
  if (directories.length) decided.allowDirectories = mergeDirectories([], directories);
  const setMode = entry.suggestions.findLast((update) => update.type === 'setMode');
  const mode = normalizeMode(setMode?.mode);
  if (mode) decided.mode = mode;
  return decided;
}

/** Records what decideApproval asked for on the session. */
export function applyApprovalToSession(session, { mode, allowRules, allowDirectories }) {
  if (mode) session.mode = mode;
  if (allowRules?.length) session.allowRules = mergeAllowRules(session.allowRules, allowRules);
  if (allowDirectories?.length) session.allowDirectories = mergeDirectories(session.allowDirectories, allowDirectories);
}
