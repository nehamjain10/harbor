// One-line summaries of tool calls for the compact activity rows and group headers.
import { editDiff, splitLines } from './diff.js';
import { firstLine, relativePath } from './format.js';
import { patchFiles, patchStats } from './patch.js';

// tool → [verb while running, verb when done, icon kind]
const VERBS = {
  Bash: ['Running', 'Ran', 'terminal'],
  BashOutput: ['Reading output', 'Read output', 'terminal'],
  TaskOutput: ['Reading output', 'Read output', 'terminal'],
  KillShell: ['Stopping', 'Stopped', 'terminal'],
  KillBash: ['Stopping', 'Stopped', 'terminal'],
  TaskStop: ['Stopping', 'Stopped', 'terminal'],
  Monitor: ['Monitoring', 'Monitored', 'terminal'],
  Read: ['Reading', 'Read', 'file'],
  Edit: ['Editing', 'Edited', 'edit'],
  MultiEdit: ['Editing', 'Edited', 'edit'],
  ApplyPatch: ['Editing', 'Edited', 'edit'],
  Write: ['Writing', 'Wrote', 'write'],
  NotebookEdit: ['Editing', 'Edited', 'notebook'],
  Grep: ['Searching', 'Searched', 'search'],
  Glob: ['Finding files', 'Found files', 'search'],
  LS: ['Listing', 'Listed', 'folder'],
  WebFetch: ['Fetching', 'Fetched', 'web'],
  WebSearch: ['Searching the web', 'Searched the web', 'web'],
  Task: ['Running agent', 'Ran agent', 'agent'],
  Agent: ['Running agent', 'Ran agent', 'agent'],
  TodoWrite: ['Updating tasks', 'Updated tasks', 'tasks'],
  TaskCreate: ['Adding task', 'Added task', 'tasks'],
  TaskUpdate: ['Updating task', 'Updated task', 'tasks'],
  TaskList: ['Listing tasks', 'Listed tasks', 'tasks'],
  TaskGet: ['Reading task', 'Read task', 'tasks'],
  Skill: ['Using skill', 'Used skill', 'skill'],
  ExitPlanMode: ['Proposing plan', 'Proposed plan', 'plan'],
  EnterPlanMode: ['Entering plan mode', 'Entered plan mode', 'plan'],
  AskUserQuestion: ['Asking', 'Asked', 'question'],
  ToolSearch: ['Loading tools', 'Loaded tools', 'tool'],
  // claude.ai artifacts (a published one shows as a card, ArtifactCard.jsx).
  Artifact: ['Publishing', 'Published', 'artifact'],
  ArtifactComments: ['Reading artifact comments', 'Read artifact comments', 'artifact'],
  ArtifactData: ['Updating artifact data', 'Updated artifact data', 'artifact'],
  SendMessage: ['Messaging agent', 'Messaged agent', 'agent'],
  // Codex's own tools, in imported Codex sessions.
  exec: ['Running script', 'Ran script', 'terminal'],
  write_stdin: ['Writing input', 'Wrote input', 'terminal'],
  sleep: ['Waiting', 'Waited', 'wait'],
  wait: ['Waiting', 'Waited', 'wait'],
  wait_agent: ['Waiting for agents', 'Waited for agents', 'wait'],
  spawn_agent: ['Starting agent', 'Started agent', 'agent'],
  send_message: ['Messaging agent', 'Messaged agent', 'agent'],
  followup_task: ['Assigning agent', 'Assigned agent', 'agent'],
  list_agents: ['Listing agents', 'Listed agents', 'agent'],
  interrupt_agent: ['Stopping agent', 'Stopped agent', 'agent'],
  // Harbor's model agents (parallel workers on any model).
  mcp__meshy__delegate: ['Running agent', 'Ran agent', 'agent'],
  mcp__meshy__wait_agents: ['Waiting for agents', 'Waited for agents', 'wait'],
  mcp__meshy__message_agent: ['Messaging agent', 'Messaged agent', 'message'],
  mcp__meshy__stop_agent: ['Stopping agent', 'Stopped agent', 'stop'],
  mcp__meshy__check_agents: ['Checking agents', 'Checked agents', 'check'],
  // Harbor's web search for gateway models (server/web-search.mjs).
  mcp__meshy__web_search: ['Searching the web', 'Searched the web', 'web'],
};

// The Artifact tool's other actions ("publish" is the default).
const ARTIFACT_VERBS = {
  read: ['Reading artifact', 'Read artifact'],
  list: ['Listing artifacts', 'Listed artifacts'],
  delete: ['Deleting artifact', 'Deleted artifact'],
  open: ['Opening artifact', 'Opened artifact'],
  pin: ['Pinning artifact', 'Pinned artifact'],
  unpin: ['Unpinning artifact', 'Unpinned artifact'],
  quickstart: ['Choosing an artifact type', 'Chose an artifact type'],
};

const ARTIFACT_URL = /https:\/\/(?:[\w-]+\.)*claude\.ai\/(?:code\/)?artifact\/[\w-]+/;

// The artifact a call published or names: its link from the result, else the one it
// was given.
export function artifactLink(message) {
  const found = String(message.output || '').match(ARTIFACT_URL);
  if (found) return found[0];
  const given = String(message.input?.url || '');
  return ARTIFACT_URL.test(given) ? given.match(ARTIFACT_URL)[0] : '';
}

// Its name: the title it was given, else its file's name ("gpu-report.html" → "gpu-report").
export function artifactTitle(message) {
  const input = message.input || {};
  if (input.title) return String(input.title);
  const file = String(input.file_path || '').split('/').pop().replace(/\.(?:html?|md)$/i, '');
  return file || 'Artifact';
}

// A page that was published (or republished): shown as a card rather than a step.
export function isPublishedArtifact(message) {
  const input = message.input || {};
  return message.tool === 'Artifact' && message.state === 'done' && (input.action ?? 'publish') === 'publish' && !input.asset && !input.type_url && !!artifactLink(message);
}

// Tools whose target is prose rather than a path or command.
const PROSE_TARGETS = new Set(['Artifact', 'Task', 'Agent', 'mcp__meshy__delegate', 'mcp__meshy__wait_agents', 'mcp__meshy__message_agent', 'mcp__meshy__stop_agent', 'mcp__meshy__check_agents', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'WebSearch', 'mcp__meshy__web_search', 'AskUserQuestion', 'ExitPlanMode', 'Skill', 'Monitor', 'SendMessage', 'sleep', 'wait', 'wait_agent']);
const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'LS']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ApplyPatch']);

export const PATH_TARGET_LIMIT = 64;

// Shortens a long path from the start, keeping whole trailing segments:
// `…/server/runner.mjs:40-120`. Paths that fit are returned unchanged.
export function truncatePath(value, max = PATH_TARGET_LIMIT) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const parts = text.split('/');
  let tail = parts.pop();
  while (parts.length && parts.at(-1) !== '' && tail.length + parts.at(-1).length + 3 <= max) tail = parts.pop() + '/' + tail;
  if (tail.length + 2 > max) return '…' + tail.slice(tail.length - max + 1);
  return '…/' + tail;
}

// Where a search ran, relative to the project; the project root itself needs no label.
export function searchScope(path, cwd) {
  if (!path) return '';
  const rel = relativePath(path, cwd);
  return rel === '.' ? '' : rel;
}

function lineRange(input) {
  const offset = Number(input?.offset);
  const limit = Number(input?.limit);
  if (!offset && !limit) return '';
  const start = offset || 1;
  return limit ? `:${start}-${start + limit - 1}` : `:${start}`;
}

// { adds, dels } for an edit tool call, or null when there is nothing to count.
export function editStats(message) {
  const input = message?.input || {};
  if (message?.tool === 'Write') {
    const lines = typeof input.content === 'string' ? splitLines(input.content).length : 0;
    return { adds: lines, dels: 0 };
  }
  if (message?.tool === 'Edit' || message?.tool === 'MultiEdit') {
    const { adds, dels, hunks } = editDiff(input);
    return hunks.length ? { adds, dels } : null;
  }
  if (message?.tool === 'ApplyPatch') {
    const files = patchFiles(input);
    return files.length ? patchStats(files) : null;
  }
  return null;
}

export function isMcpTool(tool) {
  return /^mcp__.+?__.+/.test(String(tool || ''));
}

// `mcp__server__tool` → `server · tool` for display.
export function toolDisplayName(tool) {
  const match = String(tool || '').match(/^mcp__(.+?)__(.+)$/);
  return match ? `${match[1]} · ${match[2]}` : String(tool || 'Tool');
}

// Where a patched file ends up (its new name when the patch moves it).
export function patchPath(file) {
  return file.movePath || file.path;
}

// The file a tool call is about, if any (absolute as the model sent it).
export function toolPath(message) {
  const input = message?.input || {};
  return input.file_path || input.notebook_path || (message?.tool === 'LS' ? input.path : '') || '';
}

// The worker ids a message_agent, stop_agent, check_agents or wait_agents call names.
export function workerIds(message) {
  const input = message?.input || {};
  if (Array.isArray(input.ids)) return input.ids.filter((id) => typeof id === 'string');
  return typeof input.id === 'string' && input.id ? [input.id] : [];
}

// A worker named by id: its description from its delegate card when `workers` (the
// workers a call names, see lib/transcript.js, each with its model's `name`) has it.
const workerOf = (workers, id) => workers?.find((worker) => worker.id === id) || null;

// The workers a call names, by what they do ("Parser tests"), else by id.
function workerTargets(ids, workers) {
  return ids.map((id) => workerOf(workers, id)?.description || id).join(', ');
}

function rawTarget(message, cwd, workers) {
  const input = message.input || {};
  switch (message.tool) {
    case 'Bash':
    case 'Monitor':
      return message.tool === 'Monitor' ? input.description || firstLine(input.command, 200) : firstLine(input.command, 200);
    case 'BashOutput':
    case 'TaskOutput':
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return input.bash_id || input.shell_id || input.task_id || '';
    case 'Read':
      return relativePath(input.file_path, cwd) + lineRange(input);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'LS':
      return relativePath(toolPath(message), cwd);
    case 'ApplyPatch': {
      const files = patchFiles(input);
      return files.length === 1 ? relativePath(patchPath(files[0]), cwd) : files.length ? `${files.length} files` : '';
    }
    case 'Grep': {
      const where = searchScope(input.path, cwd) || input.glob || '';
      return (input.pattern || '') + (where ? ' in ' + where : '');
    }
    case 'Glob': {
      const where = searchScope(input.path, cwd);
      return (input.pattern || '') + (where ? ' in ' + where : '');
    }
    case 'SendMessage':
      // Agents are addressed by id; what the message is about says more.
      return input.summary || firstLine(input.message, 120) || input.to || '';
    case 'exec':
      return scriptTools(input.code);
    case 'write_stdin':
      return input.session_id !== undefined ? String(input.session_id) : '';
    case 'sleep':
    case 'wait':
    case 'wait_agent': {
      const ms = Number(input.duration_ms ?? input.timeout_ms ?? input.yield_time_ms);
      return ms > 0 ? `${ms >= 1000 ? Math.round(ms / 1000) + ' s' : ms + ' ms'}` : '';
    }
    case 'spawn_agent':
      return agentName(input.task_name);
    case 'send_message':
    case 'followup_task':
    case 'interrupt_agent':
      return agentName(input.target);
    case 'list_agents':
      return '';
    case 'WebFetch':
      return String(input.url || '').replace(/^https?:\/\//, '');
    case 'WebSearch':
    case 'mcp__meshy__web_search':
      return input.query || '';
    case 'Task':
    case 'Agent':
      return input.description || firstLine(input.prompt, 120);
    case 'mcp__meshy__delegate':
      return input.description || firstLine(input.task, 120);
    case 'mcp__meshy__wait_agents': {
      const ids = Array.isArray(input.ids) ? input.ids : [];
      const which = ids.length ? workerTargets(ids, workers) : 'all workers';
      return input.mode === 'any' ? `first of ${which}` : which;
    }
    case 'mcp__meshy__message_agent':
      return firstLine(input.message, 160) || workerTargets(workerIds(message), workers);
    case 'mcp__meshy__stop_agent':
      return workerTargets(workerIds(message), workers);
    case 'mcp__meshy__check_agents':
      return workerIds(message).length ? workerTargets(workerIds(message), workers) : 'all workers';
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const active = todos.find((t) => t?.status === 'in_progress');
      return active ? active.activeForm || active.content : todos.length ? `${todos.length} items` : '';
    }
    case 'TaskCreate':
      return input.subject || '';
    case 'TaskUpdate':
      return [input.subject || (input.taskId ? `#${input.taskId}` : ''), input.status].filter(Boolean).join(' → ');
    case 'Skill':
      return input.skill || input.command || input.name || '';
    case 'AskUserQuestion': {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      return questions[0]?.question || '';
    }
    case 'ExitPlanMode':
      return plainLine(input.plan);
    case 'ToolSearch':
      return input.query || '';
    case 'Artifact':
      return input.title || input.file_path || input.url || input.type_url || '';
    default:
      return input.description || input.file_path || input.path || input.command || input.pattern || input.query || input.url || firstString(input);
  }
}

// The tools a Codex code-mode script calls, by their short names:
// `tools.mcp__codex_apps__github_search(` → `github_search`.
function scriptTools(code) {
  const names = [];
  for (const match of String(code || '').matchAll(/\btools\.(\w+)\(/g)) {
    const name = match[1].replace(/^mcp__.+?__/, '').replace(/^codex_apps__/, '');
    if (!names.includes(name)) names.push(name);
  }
  return names.join(', ') || firstLine(code, 120);
}

// A Codex subagent's name without its path ("/root/seed_runtime" → "seed_runtime").
function agentName(value) {
  return String(value || '').replace(/^\/root\//, '');
}

// First line of a markdown text without its markup (`# Plan: split \`x\``  →  `Plan: split x`).
function plainLine(text) {
  const line = firstLine(String(text || '').replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/gm, ''), 120);
  return line.replace(/\*\*|__|`/g, '');
}

// The first short string argument of an unknown tool, as a hint of what it did.
function firstString(input) {
  for (const value of Object.values(input || {})) {
    if (typeof value === 'string' && value.trim()) return firstLine(value, 120);
  }
  return '';
}

// → { verb, target, kind, mono, path, stats } for a tool message. `cwd` shortens paths;
// `path` is true when the target is a file path (truncate from the start). `workers` are
// the model agents a lead tool names, resolved from their delegate cards: [{ id,
// description, name }] with the model's name as "GPT-6 Luna agent".
export function toolSummary(message, cwd, workers = null) {
  const name = toolDisplayName(message.tool);
  const [running, done, kind] = VERBS[message.tool] || [name, name, isMcpTool(message.tool) ? 'plug' : 'tool'];
  let verb = message.state === 'running' ? running : done;
  if (message.tool === 'Artifact') {
    const action = message.input?.action ?? 'publish';
    const [busy, finished] = ARTIFACT_VERBS[action] || (message.input?.url ? ['Updating', 'Updated'] : [running, done]);
    verb = message.state === 'running' ? busy : finished;
  }
  // "Messaged GPT-6 Luna agent": the model is part of what the lead did.
  if (message.tool === 'mcp__meshy__message_agent' && workers?.length === 1 && workers[0].name) verb = `${verb.replace(/ agent$/, '')} ${workers[0].name}`;
  // A patch names its file when it touches one, otherwise how many.
  const path = PATH_TOOLS.has(message.tool) || (message.tool === 'ApplyPatch' && patchFiles(message.input).length === 1);
  let target = firstLine(rawTarget(message, cwd, workers), 200);
  if (path) target = truncatePath(target);
  return {
    verb,
    target,
    kind,
    mono: !PROSE_TARGETS.has(message.tool) && (message.tool !== 'ApplyPatch' || path),
    path,
    stats: EDIT_TOOLS.has(message.tool) ? editStats(message) : null,
  };
}

// Group summary phrases: [category, singular, plural, verb], in display order.
const CATEGORIES = [
  ['read', 'file', 'files', 'read'],
  ['edit', 'file', 'files', 'edited'],
  ['write', 'file', 'files', 'wrote'],
  ['command', 'command', 'commands', 'ran'],
  ['search', 'search', 'searches', 'ran'],
  ['list', 'folder', 'folders', 'listed'],
  ['fetch', 'page', 'pages', 'fetched'],
  ['websearch', 'web search', 'web searches', 'ran'],
  ['script', 'script', 'scripts', 'ran'],
  ['agent', 'agent', 'agents', 'ran'],
  ['message', 'agent message', 'agent messages', 'sent'],
  ['stop', 'agent', 'agents', 'stopped'],
  ['skill', 'skill', 'skills', 'used'],
  ['question', 'question', 'questions', 'asked'],
  ['plan', 'plan', 'plans', 'proposed'],
  ['tasks', 'task list update', 'task list updates', 'made'],
  ['wait', 'wait', 'waits', 'made'],
  ['check', 'check', 'checks', 'made'],
  ['artifact', 'artifact step', 'artifact steps', 'made'],
  ['tool', 'tool', 'tools', 'used'],
];

const CATEGORY_OF = {
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  ApplyPatch: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'command',
  BashOutput: 'command',
  TaskOutput: 'command',
  KillShell: 'command',
  KillBash: 'command',
  TaskStop: 'command',
  Monitor: 'command',
  Grep: 'search',
  Glob: 'search',
  LS: 'list',
  WebFetch: 'fetch',
  WebSearch: 'websearch',
  Agent: 'agent',
  Task: 'agent',
  Skill: 'skill',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
  TodoWrite: 'tasks',
  TaskCreate: 'tasks',
  TaskUpdate: 'tasks',
  SendMessage: 'message',
  exec: 'script',
  write_stdin: 'command',
  spawn_agent: 'agent',
  send_message: 'message',
  followup_task: 'message',
  interrupt_agent: 'message',
  list_agents: 'message',
  sleep: 'wait',
  wait: 'wait',
  wait_agent: 'wait',
  mcp__meshy__delegate: 'agent',
  mcp__meshy__wait_agents: 'wait',
  mcp__meshy__message_agent: 'message',
  mcp__meshy__stop_agent: 'stop',
  mcp__meshy__check_agents: 'check',
  mcp__meshy__web_search: 'websearch',
  Artifact: 'artifact',
  ArtifactComments: 'artifact',
  ArtifactData: 'artifact',
};

// Categories said the same way however many calls they have.
const FIXED_PHRASES = { tasks: 'updated tasks', wait: 'waited', check: 'checked agents', artifact: 'worked on artifacts' };

// Files count once per path ("read 3 files" for three distinct files); everything
// else counts calls.
const BY_PATH = new Set(['read', 'edit', 'write']);

// "Read 3 files, ran 2 commands, edited 1 file" for a list of tool messages.
export function groupSummary(tools) {
  const counts = new Map();
  for (const message of tools) {
    const category = CATEGORY_OF[message.tool] || 'tool';
    if (!counts.has(category)) counts.set(category, new Set());
    const keys = message.tool === 'ApplyPatch' ? patchFiles(message.input).map(patchPath) : [];
    if (!keys.length) keys.push(BY_PATH.has(category) && toolPath(message) ? toolPath(message) : message.id || message.toolId || counts.get(category).size);
    for (const key of keys) counts.get(category).add(key);
  }
  const phrases = [];
  for (const [category, singular, plural, verb] of CATEGORIES) {
    const n = counts.get(category)?.size;
    if (!n) continue;
    phrases.push(FIXED_PHRASES[category] || `${verb} ${n} ${n === 1 ? singular : plural}`);
  }
  const text = phrases.join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) : 'No steps';
}

// The step Claude is on in the foreground: its newest running main-thread tool call
// (background subagents run on their own), or null. Looks at the latest `scan` entries.
export function currentStep(messages, scan = 200) {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - scan); i--) {
    const message = messages[i];
    if (message.role === 'tool' && message.state === 'running' && !message.parentToolId && !message.background) return message;
  }
  return null;
}

// "Reading server/runner.mjs:40-120" for the running group header.
export function runningLabel(message, cwd) {
  const { verb, target } = toolSummary({ ...message, state: 'running' }, cwd);
  return target ? `${verb} ${target}` : verb;
}
