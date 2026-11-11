// Pure helpers for the approval cards: kinds, titles, permission rules, question
// answers, request bodies and the waiting timer.
import { modeLabel } from './modes.js';

export function approvalKind(pending) {
  if (pending?.kind) return pending.kind;
  if (pending?.tool === 'AskUserQuestion') return 'question';
  if (pending?.tool === 'ExitPlanMode') return 'plan';
  return 'permission';
}

// `mcp__server__tool` → { server, tool }; null for built-in tools.
export function mcpParts(toolName) {
  const match = String(toolName || '').match(/^mcp__(.+?)__(.+)$/);
  return match ? { server: match[1], tool: match[2] } : null;
}

// Harbor's own web search (gateway routes, server/web-search.mjs): shown as WebSearch.
export const WEB_SEARCH_TOOL = 'mcp__meshy__web_search';

export function isWebSearch(toolName) {
  return toolName === 'WebSearch' || toolName === WEB_SEARCH_TOOL;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

export function permissionTitle(toolName, displayName) {
  if (isWebSearch(toolName)) return 'Search the web?';
  const mcp = mcpParts(toolName);
  if (mcp) return `Use ${mcp.server} · ${mcp.tool}?`;
  if (toolName === 'Bash') return 'Run a command?';
  if (EDIT_TOOLS.has(toolName)) return 'Edit a file?';
  if (toolName === 'Write') return 'Write a file?';
  if (toolName === 'WebFetch') return 'Fetch a URL?';
  if (toolName === 'Read') return 'Read a file?';
  if (toolName === 'Glob' || toolName === 'Grep') return 'Search files?';
  if (displayName) return `${displayName}?`;
  return `Use ${toolName || 'a tool'}?`;
}

// `{toolName, ruleContent}` → "Bash(npm test:*)".
export function ruleText(rule) {
  if (!rule) return '';
  if (typeof rule === 'string') return rule;
  if (!rule.toolName) return '';
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

// What "Always allow" grants, from the SDK's PermissionUpdate[]:
// [{ type: 'rule' | 'directory' | 'mode', text }], e.g. `Bash(npm run *)`,
// "access to /srv/x", "switches the session to Accept edits".
export function suggestionItems(suggestions) {
  const out = [];
  const seen = new Set();
  const push = (type, text) => {
    if (!text || seen.has(type + text)) return;
    seen.add(type + text);
    out.push({ type, text });
  };
  for (const update of Array.isArray(suggestions) ? suggestions : []) {
    if (!update) continue;
    if (typeof update === 'string') push('rule', update);
    else if (Array.isArray(update.rules)) {
      if (update.type === 'removeRules' || update.behavior === 'deny' || update.behavior === 'ask') continue;
      for (const rule of update.rules) push('rule', ruleText(rule));
    } else if (update.type === 'setMode' && update.mode) push('mode', `switches the session to ${modeLabel(update.mode)}`);
    else if (update.type === 'addDirectories') for (const dir of update.directories || []) push('directory', `access to ${dir}`);
    else if (update.toolName) push('rule', ruleText(update));
  }
  return out;
}

export function suggestionRules(suggestions) {
  return suggestionItems(suggestions).map((item) => item.text);
}

// The session's `allowRules` (strings, rule values or PermissionUpdates) as text.
export function allowRuleTexts(allowRules) {
  if (!Array.isArray(allowRules)) return [];
  return suggestionRules(allowRules.map((rule) => (rule && typeof rule === 'object' && !rule.type && !rule.rules ? { rules: [rule] } : rule)));
}

// The plan an ExitPlanMode request shows. Claude Code fills `input.plan` from its plan
// file; a model that passed the plan inline instead (no file) leaves it empty, but the
// session recorded that plan from the tool call (`session.plan.toolId` is the call).
export function planText(pending, sessionPlan) {
  const fromFile = pending?.input?.plan;
  if (typeof fromFile === 'string' && fromFile.trim()) return fromFile;
  if (sessionPlan?.toolId && sessionPlan.toolId === pending?.toolUseID && typeof sessionPlan.text === 'string') return sessionPlan.text;
  return '';
}

// Plan approval may only switch to a mode the session's model supports; the
// server coerces anything else to `default`, so do the same up front.
export function planMode(mode, allowedModes) {
  if (!Array.isArray(allowedModes) || !allowedModes.length) return mode;
  return allowedModes.includes(mode) ? mode : 'default';
}

// AskUserQuestion answers keyed by question text; multi-select picks are joined
// with ", ". `state[i] = { picked: string[], otherText: string }`: the text is a note on
// the picked option(s), or the answer itself when nothing is picked.
export function questionAnswer(question, state) {
  const note = String(state?.otherText || '').trim();
  const picked = (state?.picked || []).filter(Boolean);
  const choice = question?.multiSelect ? picked.join(', ') : picked[0] || '';
  if (choice && note) return `${choice} — Note: ${note}`;
  return choice || note;
}

export function buildAnswers(questions, states) {
  const answers = {};
  (questions || []).forEach((question, index) => {
    answers[question.question] = questionAnswer(question, states[index]);
  });
  return answers;
}

export function allAnswered(questions, states) {
  return (questions || []).every((question, index) => !!questionAnswer(question, states[index]));
}

// POST /api/approvals/:id bodies. `allow` is kept for v1 servers.
export function approvalBody(decision, { reason, answers, mode } = {}) {
  const body = { decision, allow: decision !== 'deny' };
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text) body.reason = text;
  if (answers) body.answers = answers;
  if (mode) body.mode = mode;
  return body;
}

// "0:07", "4:32", "1h 05m".
export function waitingLabel(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
