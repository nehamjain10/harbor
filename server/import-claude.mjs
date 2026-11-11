// Claude Code sessions for import: listing (the SDK's own session index) and converting a
// transcript (`~/.claude/projects/<project>/<session>.jsonl`) into Harbor messages.
// Everything here only reads; continuing an import forks the session in the runner.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { IMAGE_PLACEHOLDER, IMPORT_LIMITS, capHistory, createHistory, stripReminders, timeOf } from './import-history.mjs';
import { forEachLine, parseLine, readLineAt } from './jsonl.mjs';
import { catalogIdForModel } from './models.mjs';
import { NOTICES } from './transcript.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Transcript entries that take part in the conversation chain (as the SDK reads them).
const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'progress']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
export const INTERRUPTED = 'Interrupted by the user.';

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The Claude Code configuration directory the CLI and the SDK use. */
export function claudeHomeDir(config, env = process.env) {
  return config.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * Interactive Claude Code sessions (terminal and desktop app) from the SDK's index,
 * newest first. Programmatic sessions, Harbor's own included, are left out.
 *
 * The SDK takes the directory from CLAUDE_CONFIG_DIR. `configDir` (tests, staging) is
 * put there only around the synchronous start of the call: the SDK reads it right away,
 * and every CLI the server launches copies process.env, so it must never stay set
 * while a turn could start (with it, the CLI reads `<dir>/.claude.json` instead of
 * `~/.claude.json` and loses the user's MCP servers and project settings).
 */
export function listClaudeSessions(configDir, env = process.env) {
  if (!configDir || env.CLAUDE_CONFIG_DIR === configDir) return listSessions({ includeProgrammatic: false });
  const previous = env.CLAUDE_CONFIG_DIR;
  env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return listSessions({ includeProgrammatic: false });
  } finally {
    if (previous === undefined) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = previous;
  }
}

/**
 * Every top-level transcript under `<claudeHome>/projects` as `{id, file, projectDir,
 * mtimeMs, size}`. Cheap (a readdir and a stat per file); used to tell whether the
 * SDK's listing needs to run again and where each session's file is.
 */
export async function scanClaudeTranscripts(claudeHome) {
  const projects = path.join(claudeHome, 'projects');
  let dirs;
  try {
    dirs = await fsp.readdir(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(projects, dir.name);
    let names;
    try {
      names = await fsp.readdir(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.slice(0, -'.jsonl'.length);
      if (!name.endsWith('.jsonl') || !isSessionId(id)) continue;
      try {
        const stats = await fsp.stat(path.join(projectDir, name));
        files.push({ id, file: path.join(projectDir, name), projectDir, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        // Removed while listing.
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------------------
// The conversation chain

/**
 * Pass one over a transcript: the line offsets of every chain entry and the chain from
 * the conversation's current leaf back to its start, oldest first. A transcript can hold
 * the same entry many times (resumed and forked sessions copy history) and abandoned
 * branches (rewinds), so like the SDK the leaf is the newest user or assistant entry at
 * the end of a branch, and the chain follows parent links from there. Unlike the SDK it
 * also crosses compaction boundaries (via `logicalParentUuid`) so the whole history
 * shows, not just what the model saw after the last compaction. `results` maps each
 * tool call to the entry holding its result: results of parallel tool calls can sit on
 * a side branch of the chain.
 */
export async function readChain(file) {
  const entries = new Map();
  const results = new Map();
  const sessionIds = new Set();
  let index = 0;
  await forEachLine(file, (text, offset, length) => {
    index += 1;
    const line = parseLine(text);
    if (!line || typeof line.uuid !== 'string' || !CHAIN_TYPES.has(line.type)) return;
    if (typeof line.sessionId === 'string') sessionIds.add(line.sessionId);
    if (line.type === 'user' && Array.isArray(line.message?.content)) {
      for (const block of line.message.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') results.set(block.tool_use_id, line.uuid);
      }
    }
    entries.set(line.uuid, {
      parent: typeof line.parentUuid === 'string' ? line.parentUuid : null,
      logicalParent: typeof line.logicalParentUuid === 'string' ? line.logicalParentUuid : null,
      offset,
      length,
      index,
      conversational: line.type === 'user' || line.type === 'assistant',
      main: !line.isSidechain && !line.teamName && !line.isMeta,
    });
  });

  const referenced = new Set();
  for (const entry of entries.values()) if (entry.parent) referenced.add(entry.parent);
  let leaf = null;
  let fallback = null;
  for (const [uuid, entry] of entries) {
    if (referenced.has(uuid)) continue;
    // Up from the end of the branch to its last user or assistant entry.
    let current = entry;
    let currentId = uuid;
    const visited = new Set();
    while (current && !current.conversational && current.parent && !visited.has(currentId)) {
      visited.add(currentId);
      currentId = current.parent;
      current = entries.get(currentId);
    }
    if (!current?.conversational) continue;
    if (!fallback || current.index > fallback.entry.index) fallback = { id: currentId, entry: current };
    if (current.main && (!leaf || current.index > leaf.entry.index)) leaf = { id: currentId, entry: current };
  }
  const start = leaf ?? fallback;
  const chain = [];
  const visited = new Set();
  for (let id = start?.id; id && !visited.has(id); ) {
    const entry = entries.get(id);
    if (!entry) break;
    visited.add(id);
    chain.push({ ...entry, id });
    id = entry.parent ?? entry.logicalParent;
  }
  return { chain: chain.reverse(), entries, results, sessionIds };
}

// ---------------------------------------------------------------------------------------
// Converting entries

/** `<tag>…</tag>` content, or undefined. */
function tagged(text, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1] : undefined;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** User-visible text of a message's content (string or blocks), images as placeholders. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block?.type === 'text' ? block.text : block?.type === 'image' ? IMAGE_PLACEHOLDER : ''))
    .filter(Boolean)
    .join('\n');
}

/** A background task's completion (`<task-notification>`), as the SDK's system message. */
function taskNotification(text) {
  const toolUseId = tagged(text, 'tool-use-id');
  if (!toolUseId) return null;
  const status = tagged(text, 'status')?.trim();
  return {
    type: 'system',
    subtype: 'task_notification',
    tool_use_id: toolUseId.trim(),
    status: status === 'completed' ? 'completed' : status === 'killed' || status === 'stopped' ? 'stopped' : 'failed',
    summary: (tagged(text, 'result') ?? tagged(text, 'summary') ?? '').trim(),
  };
}

/**
 * What a typed user entry shows: `{user}` text, a `{notice}`, a background task's
 * `{task}` completion (null when it names no tool call), or null for text Claude Code
 * injected (caveats, reminders).
 */
export function classifyUserText(raw) {
  const text = stripReminders(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('<task-notification>')) return { task: taskNotification(text) };
  if (text.startsWith('<local-command-caveat>')) return null;
  const command = tagged(text, 'command-name');
  if (command !== undefined && text.startsWith('<command-')) {
    const name = command.trim();
    const args = (tagged(text, 'command-args') ?? '').trim();
    return { user: (name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '') };
  }
  for (const [tag, level] of [
    ['local-command-stdout', 'info'],
    ['local-command-stderr', 'warning'],
    ['bash-stdout', 'info'],
    ['bash-stderr', 'warning'],
  ]) {
    if (!text.startsWith(`<${tag}>`)) continue;
    let output = (tagged(text, tag) ?? '').replace(ANSI, '').trim();
    if (tag.startsWith('local-command')) {
      // "Compacted (ctrl+o to see full summary)": the compaction has its own notice.
      if (/^Compacted\b/.test(output)) return null;
      // Notices are plain text: "Set model to `Opus 5.5`" loses its code marks.
      output = output.replace(/`([^`\n]+)`/g, '$1');
    }
    return output ? { notice: output, level } : null;
  }
  const bash = tagged(text, 'bash-input');
  if (bash !== undefined && text.startsWith('<bash-input>')) return { user: '! ' + bash.trim() };
  if (/^\[Request interrupted by user/.test(text)) return { notice: INTERRUPTED, level: 'info' };
  return { user: text };
}

/**
 * Applies one transcript entry to the history. `parentToolId` is the Agent tool call a
 * subagent's entries belong under; with `followUps`, messages sent to a subagent while it
 * worked show as its user messages. Returns the model name of a top-level reply.
 */
function convertEntry(history, line, { parentToolId, followUps = false } = {}) {
  const at = timeOf(line.timestamp);
  const nested = parentToolId ? { parent_tool_use_id: parentToolId } : {};
  if (line.type === 'assistant') {
    const message = line.message;
    if (!message || !Array.isArray(message.content)) return;
    const failed = Boolean(line.isApiErrorMessage || line.error);
    // Claude Code's placeholder replies ("No response requested.") are not the model's.
    if (message.model === '<synthetic>' && !failed) return;
    const model = catalogIdForModel(message.model) ?? message.model;
    history.apply({ type: 'assistant', uuid: line.uuid, message, ...nested, ...(failed ? { error: 'api_error' } : {}) }, { at, model });
    return parentToolId || failed ? undefined : message.model;
  }
  if (line.type === 'user') {
    if (line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly) return;
    const content = line.message?.content;
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
      const results = content
        .filter((block) => block?.type === 'tool_result')
        .map((block) => ({
          ...block,
          content: typeof block.content === 'string' ? stripReminders(block.content) : Array.isArray(block.content) ? block.content.map((part) => (part?.type === 'text' ? { ...part, text: stripReminders(part.text) } : part)) : block.content,
        }));
      history.apply({ type: 'user', message: { role: 'user', content: results }, tool_use_result: line.toolUseResult, ...nested }, { at });
      // "[Request interrupted by user for tool use]" rides along with the results.
      const extra = classifyUserText(content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n'));
      if (extra?.notice && !parentToolId) history.notice(extra.notice, extra.level, at);
      return;
    }
    if (parentToolId) {
      // A subagent's first message, its prompt, is already on its Agent card.
      if (line.parentUuid) applySubagentTyped(history, contentText(content), at, parentToolId, followUps);
      return;
    }
    applyTyped(history, contentText(content), at);
    return;
  }
  if (line.type === 'attachment') {
    // A message the user sent while Claude was working.
    const attachment = line.attachment;
    if (attachment?.type !== 'queued_command' || attachment.isMeta) return;
    if (parentToolId) applySubagentTyped(history, contentText(attachment.prompt), at, parentToolId, followUps);
    else applyTyped(history, contentText(attachment.prompt), at);
    return;
  }
  if (line.type === 'system' && !parentToolId) {
    if (line.subtype === 'compact_boundary') {
      history.apply({ type: 'system', subtype: 'compact_boundary', compact_metadata: line.compactMetadata }, { at });
    } else if (line.subtype === 'local_command' && typeof line.content === 'string') {
      const shown = classifyUserText(line.content);
      if (shown?.notice) history.notice(shown.notice, shown.level, at);
    }
  }
}

const isCompactedNotice = (message) => message?.role === 'notice' && message.text === NOTICES.compacted;

function applyTyped(history, text, at) {
  const shown = classifyUserText(text);
  if (!shown) return;
  // Background task completions update their tool card; other notifications (monitor
  // events) are for the model only.
  if ('task' in shown) {
    if (shown.task) history.apply(shown.task, { at });
  } else if (shown.notice) history.notice(shown.notice, shown.level, at);
  else if (/^\/compact\b/.test(shown.user) && isCompactedNotice(history.session.messages.at(-1))) {
    // Claude Code records the compaction before the /compact that asked for it.
    const compacted = history.session.messages.pop();
    history.add('user', shown.user, { delivery: 'done' }, compacted.at ?? at);
    history.session.messages.push(compacted);
  } else history.add('user', shown.user, { delivery: 'done' }, at);
}

/**
 * Typed text inside a subagent: the end of a background task it started (a task
 * notification) settles that task's card; with `followUps`, other text (a message sent to
 * it with SendMessage) is one of its user messages.
 */
function applySubagentTyped(history, text, at, parentToolId, followUps) {
  const shown = classifyUserText(text);
  if (shown?.task) history.apply(shown.task, { at });
  else if (shown?.user && followUps) history.add('user', shown.user, { delivery: 'done', parentToolId }, at);
}

// ---------------------------------------------------------------------------------------
// Subagents

/**
 * Subagent transcripts by the Agent tool call that started them: Claude Code keeps them
 * in `<project>/<session>/subagents/agent-<id>.jsonl` with a `.meta.json` naming the
 * call (agents started by subagents sit in the same folder). A transcript continued from
 * another session carries that session's history, so every session id seen in the
 * transcript is searched. With `meta`, the map's values are `{file, meta}`.
 */
export async function subagentFiles(projectDir, sessionIds, { meta: withMeta = false } = {}) {
  const files = new Map();
  for (const sessionId of sessionIds) {
    if (!isSessionId(sessionId)) continue;
    const dir = path.join(projectDir, sessionId, 'subagents');
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const transcript = path.join(dir, name.slice(0, -'.meta.json'.length) + '.jsonl');
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
        if (typeof meta.toolUseId === 'string' && fs.existsSync(transcript)) files.set(meta.toolUseId, withMeta ? { file: transcript, meta } : transcript);
      } catch {
        // Unreadable metadata: that subagent shows without its messages.
      }
    }
  }
  return files;
}

/**
 * A subagent's latest `keep` messages, nested under its Agent card (`toolId`), with
 * `omitted`, how many of its own (top-level) messages were left out. Only the last
 * `maxFileBytes` of the transcript are read (`partial` when that left some out). Tool
 * calls that never got a result end as interrupted unless `settle` is false (an agent
 * still at work). `followUps`: see convertEntry.
 */
async function readSubagent(file, toolId, { keep = IMPORT_LIMITS.subagentMessages, maxFileBytes = Infinity, settle = true, followUps = false } = {}) {
  const own = (message) => message.parentToolId === toolId;
  const history = createHistory({ keep, counts: own });
  const seen = new Set();
  const start = Number.isFinite(maxFileBytes) ? Math.max(0, (await fsp.stat(file)).size - maxFileBytes) : 0;
  await forEachLine(
    file,
    (text) => {
      const line = parseLine(text);
      if (!line || (line.uuid && seen.has(line.uuid))) return;
      if (line.uuid) seen.add(line.uuid);
      convertEntry(history, line, { parentToolId: toolId, followUps });
    },
    { start },
  );
  const { messages } = settle ? history.settle() : history.session;
  const cut = messages.length - keep;
  return {
    messages: cut > 0 ? messages.slice(cut) : messages,
    omitted: history.omitted + (cut > 0 ? messages.slice(0, cut).filter(own).length : 0),
    partial: start > 0,
  };
}

/**
 * Subagent messages for every Agent card in `messages`, by toolId (nested ones too, at
 * most `depth` levels down). `options` go to readSubagent; `partial` is set on `read`
 * when a transcript was only read in part.
 */
async function loadSubagents(messages, files, { depth = IMPORT_LIMITS.subagentDepth, read = {}, ...options } = {}) {
  const children = new Map();
  let frontier = messages;
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next = [];
    for (const message of frontier) {
      if (message.role !== 'tool' || !AGENT_TOOLS.has(message.tool) || children.has(message.toolId)) continue;
      const file = files.get(message.toolId);
      if (!file) continue;
      const nested = await readSubagent(file, message.toolId, options);
      if (nested.partial) read.partial = true;
      // Only the subagent's own top level; deeper agents get their own entry.
      const own = nested.messages.filter((child) => child.parentToolId === message.toolId);
      children.set(message.toolId, own);
      next.push(...own);
    }
    frontier = next;
  }
  return children;
}

/**
 * One subagent's whole conversation (`files` maps Agent call ids to transcripts, see
 * subagentFiles) as Harbor messages rooted at its Agent card `toolId`: its own
 * messages carry `parentToolId: toolId`, the agents it started nest under their cards,
 * and messages sent to it while it worked are user messages (its prompt is on its card).
 * At most `messages` messages and `bytes` of JSON in all (the latest ones; nested
 * agents keep their latest `nestedMessages`), reading at most the last `fileBytes` of
 * each transcript. Returns `{messages, omitted, partial}` (`omitted`: the agent's own
 * messages left out; `partial`: a transcript was too large to read whole), or null when
 * `files` has no transcript for `toolId`.
 */
export async function convertAgentTranscript(files, toolId, { messages: maxMessages, bytes, nestedMessages, fileBytes = Infinity, settle = true } = {}) {
  const file = files.get(toolId);
  if (!file) return null;
  const options = { maxFileBytes: fileBytes, settle, followUps: true };
  const own = await readSubagent(file, toolId, { ...options, keep: maxMessages });
  const read = { partial: own.partial };
  const children = await loadSubagents(own.messages, files, { ...options, keep: nestedMessages, read });
  // Its own top level: messages of the agents it started follow their cards (capHistory).
  const top = own.messages.filter((message) => message.parentToolId === toolId);
  const capped = capHistory(top, children, { maxMessages, maxBytes: bytes });
  return { messages: capped.messages, omitted: own.omitted + capped.omitted, partial: read.partial };
}

// ---------------------------------------------------------------------------------------

/**
 * Converts a Claude Code transcript into Harbor messages. Bounded memory: one pass
 * indexes line offsets, a second reads only the conversation chain, line by line.
 * Returns `{messages, omitted, todos, plan, lastModel, lastAt}`.
 * @param {string} file  the session's transcript
 * @param {string} projectDir  its project folder (subagent transcripts live there)
 */
export async function convertClaudeSession(file, projectDir = path.dirname(file)) {
  const { chain, entries, results, sessionIds } = await readChain(file);
  const onChain = new Set(chain.map((entry) => entry.id));
  const applied = new Set();
  const history = createHistory();
  let lastModel;
  const handle = await fsp.open(file, 'r');
  const read = async (entry) => parseLine(await readLineAt(handle, entry.offset, entry.length));
  try {
    for (const entry of chain) {
      const line = await read(entry);
      if (!line || line.isSidechain) continue;
      lastModel = convertEntry(history, line) ?? lastModel;
      if (line.type !== 'assistant' || !Array.isArray(line.message?.content)) continue;
      // Results of parallel tool calls that sit off the chain, right after their call.
      for (const block of line.message.content) {
        const resultId = block?.type === 'tool_use' ? results.get(block.id) : undefined;
        if (!resultId || onChain.has(resultId) || applied.has(resultId) || !entries.has(resultId)) continue;
        applied.add(resultId);
        const result = await read(entries.get(resultId));
        if (result && !result.isSidechain) convertEntry(history, result);
      }
    }
  } finally {
    await handle.close();
  }
  const session = history.settle();
  const files = await subagentFiles(projectDir, sessionIds);
  const children = await loadSubagents(session.messages, files);
  const capped = capHistory(session.messages, children);
  return {
    messages: capped.messages,
    omitted: history.omitted + capped.omitted,
    todos: session.todos,
    plan: session.plan,
    lastModel,
    lastAt: history.lastAt,
  };
}
