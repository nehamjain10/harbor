// Session persistence: one JSON file per session in the data directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LARGE_SAVE_BYTES, LARGE_SAVE_INTERVAL_MS, MAX_PUBLIC_TOOL_OUTPUT } from './config.mjs';
import { httpError } from './errors.mjs';
import { cachedJson } from './json-cache.mjs';
import { settleTasks } from './tasks.mjs';

export const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const DEFAULT_MODE = 'bypassPermissions';
const LEGACY_MODES = new Map([
  ['yolo', 'bypassPermissions'],
  ['ask', 'default'],
]);
// Models Harbor no longer offers, and what their conversations continue on.
const RETIRED_MODELS = new Map([['glm', 'deepseek']]);

// Claude Code's subagents, and Harbor's model agents (their delegate call; model-agents.mjs).
const AGENT_TOOLS = new Set(['Agent', 'Task', 'mcp__meshy__delegate']);

export const RESTART_NOTICE = 'The server restarted. Resuming this conversation automatically.';

/** Canonical mode for a current or legacy (v1) mode name, or null when unknown. */
export function normalizeMode(value) {
  if (MODES.includes(value)) return value;
  return LEGACY_MODES.get(value) ?? null;
}

/** Mode for a session read from disk. v1 ran any unrecognized mode with approvals on. */
export function migrateMode(value) {
  return normalizeMode(value) ?? 'default';
}

export function addMessage(session, role, text, extra = {}) {
  const message = { id: crypto.randomUUID(), role, text, at: Date.now(), ...extra };
  session.messages.push(message);
  return message;
}

/** A transcript notice; `level` is info, warning or error. */
export function addNotice(session, text, level = 'info', extra = {}) {
  return addMessage(session, 'notice', text, { level, ...extra });
}

function runningBackgroundAgents(session) {
  let count = 0;
  for (const message of session.messages) {
    if (message.role === 'tool' && message.state === 'running' && message.background && !message.parentToolId && AGENT_TOOLS.has(message.tool)) count += 1;
  }
  return count;
}

// Message -> its cut copy (publicMessage), kept while the message's own fields are the
// same, so the copy keeps its cached JSON (json-cache.mjs) from one publish to the next.
const publicCopies = new WeakMap();

/** Whether `copy` is still `message` with its output cut: the same values under the same keys. */
function currentCopy(copy, message) {
  const keys = Object.keys(message);
  const copied = Object.keys(copy);
  const extra = Object.hasOwn(message, 'outputTruncated') ? 0 : 1;
  if (copied.length !== keys.length + extra) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (copied[i] !== key || (key !== 'output' && key !== 'outputTruncated' && copy[key] !== message[key])) return false;
  }
  return true;
}

/** The pushed copy of a message: long tool output is cut (full text via the message route). */
export function publicMessage(message) {
  if (message.role !== 'tool' || typeof message.output !== 'string' || message.output.length <= MAX_PUBLIC_TOOL_OUTPUT) {
    return message;
  }
  const kept = publicCopies.get(message);
  if (kept && kept.output === message.output && currentCopy(kept.copy, message)) return kept.copy;
  const copy = { ...message, output: message.output.slice(0, MAX_PUBLIC_TOOL_OUTPUT), outputTruncated: true };
  publicCopies.set(message, { output: message.output, copy });
  return copy;
}

/** A brand-new idle session. Field order matches v1's files. */
export function createSession({ cwd, model, mode, effort = 'default', title = 'New session', cluster = 'local' }) {
  const now = Date.now();
  return {
    efforts: { [model]: effort },
    id: crypto.randomUUID(),
    title: title.slice(0, 100),
    cwd,
    model,
    mode,
    status: 'idle',
    messages: [],
    pending: [],
    createdAt: now,
    updatedAt: now,
    // Where its Claude Code runs (clusters.mjs), set once; sessions here leave it out.
    ...(cluster && cluster !== 'local' ? { cluster } : {}),
  };
}

/**
 * The client-facing copy of a session. The SDK session id never leaves the server;
 * list views (full = false) also drop the transcript and the streaming text. Fields
 * added in v2 get their empty value for sessions written by v1.
 */
export function publicSession(session, full = false) {
  // Imported history keeps its original times; an import sorts by when it was imported.
  // A message to a model agent (nested under its card) is not the user's turn.
  const lastMessageAt = session.messages.reduce(
    (latest, message) => (message.role === 'user' && !message.imported && !message.parentToolId ? Math.max(latest, message.at) : latest),
    session.createdAt,
  );
  const copy = {
    ...session,
    live: session.live ?? '',
    liveThinking: session.liveThinking ?? '',
    todos: session.todos ?? [],
    plan: session.plan ?? null,
    context: session.context ?? null,
    totals: session.totals ?? { cost: 0, outputTokens: 0, turns: 0 },
    mcp: session.mcp ?? [],
    lastMessageAt,
    // Subagents still working after their turn ended (the session reads idle meanwhile).
    backgroundAgents: runningBackgroundAgents(session),
    // Background commands and Monitors running now, and the jobs that will wake the
    // session later (see tasks.mjs).
    liveTasks: session.liveTasks ?? [],
    crons: session.crons ?? [],
  };
  // Sidebar flags and "allow always" grants; empty for sessions that predate them.
  copy.pinned = session.pinned ?? false;
  copy.turnEndedAt = session.turnEndedAt ?? 0;
  copy.lastViewedAt = session.lastViewedAt ?? 0;
  copy.allowRules = session.allowRules ?? [];
  copy.allowDirectories = session.allowDirectories ?? [];
  // MCP servers switched off for this session (see mcp.mjs); new sessions start with none.
  copy.mcpDisabled = session.mcpDisabled ?? [];
  // The /goal Claude Code is working towards (runner.mjs goalOf); null when none.
  copy.goal = session.goal ?? null;
  // The cluster its Claude Code runs on (clusters.mjs); sessions from before ran here.
  copy.cluster = session.cluster || 'local';
  // Messages sent mid-turn that Claude has not read yet (see the API contract).
  copy.steering = session.steering ?? [];
  // How long the transcript is: clients size their caches and background loads by it.
  copy.messageCount = session.messages.length;
  delete copy.sdkSessionId;
  delete copy.sdkTotals;
  // Import plumbing for the first turn (see importer.mjs): the original Claude Code
  // session to fork, or the condensed Codex history.
  delete copy.forkFrom;
  delete copy.handoff;
  // A fork's ancestors in Claude Code, where its copied agent cards ran (see fork.mjs).
  delete copy.sdkAncestors;
  if (full) {
    copy.messages = session.messages.map(publicMessage);
  } else {
    delete copy.messages;
    delete copy.live;
    delete copy.liveThinking;
  }
  return copy;
}

/** The notice for one-shot wakeups (ScheduleWakeup) that died with their process. */
export function lostWakeupsNotice(count) {
  return count === 1
    ? 'A scheduled wakeup was lost when Claude Code restarted. Recurring jobs carry on.'
    : `${count} scheduled wakeups were lost when Claude Code restarted. Recurring jobs carry on.`;
}

/**
 * Tool calls still marked running when their turn is over will never get a result,
 * except those `keep` picks (background subagents the process is still running).
 */
export function settleOrphanedTools(session, at = Date.now(), keep = () => false) {
  for (const message of session.messages) {
    if (message.role !== 'tool' || message.state !== 'running' || keep(message)) continue;
    message.state = 'error';
    message.output ||= 'Interrupted before this tool call finished.';
    message.endedAt = at;
    delete message.elapsed;
  }
}

/**
 * Prepares a session read from disk: migrates v1 mode names and retired models, and marks turns that
 * were cut off by a restart as interrupted with a notice in the transcript.
 */
export function reviveSession(session, { live = false } = {}) {
  session.mode = migrateMode(session.mode);
  const successor = RETIRED_MODELS.get(session.model);
  if (successor) {
    // Its effort levels need not exist on the successor, which starts on its default.
    if (session.efforts) delete session.efforts[session.model];
    session.model = successor;
  }
  // Its Claude Code process is still running in the CLI host (cli-host.mjs) and the
  // runner takes it back: the turn, its tools and background work carry on. Approvals
  // it was waiting on are asked again by the process, so the old ones go.
  if (live) {
    delete session.restartRecovery;
    session.pending = [];
    if (session.status === 'waiting') session.status = 'running';
    return session;
  }
  // No Claude Code process survives a restart: nothing still marked running (a cut-off
  // turn's tools, or background subagents of an idle session) will ever report back.
  settleOrphanedTools(session);
  delete session.compacting;
  // Nor any background task, or a one-shot wakeup (recurring jobs come back when the
  // conversation is resumed: see runner.resumeScheduled).
  const wakeups = settleTasks(session);
  if (wakeups) addNotice(session, lostWakeupsNotice(wakeups), 'warning');
  if (session.status === 'running' || session.status === 'waiting') {
    session.status = 'interrupted';
    session.pending = [];
    if (!session.stopRequested && !session.removed) session.restartRecovery = true;
    addNotice(session, session.restartRecovery ? RESTART_NOTICE : 'The server restarted. This conversation remains stopped.', 'warning');
  }
  // Messages to a model agent that it never read: its process is gone with the restart.
  for (const message of session.messages) {
    if (message.role === 'user' && message.parentToolId && message.delivery === 'sent') message.delivery = 'dropped';
  }
  // Messages sent mid-turn that Claude never read wait at the front of the paused queue.
  if (session.steering?.length) {
    session.queue ??= [];
    for (const { id, text } of [...session.steering].reverse()) {
      const message = session.messages.find((m) => m.id === id);
      if (!message || session.queue.some((item) => item.id === id)) continue;
      message.delivery = 'queued';
      session.queue.unshift({ id, text });
    }
    session.steering = [];
    session.queuePaused = true;
  }
  return session;
}

// Large session files are written in pieces of about this many characters.
const WRITE_CHUNK = 1 << 20;

/**
 * `JSON.stringify(session)` as a list of strings (joined, the same text), the messages'
 * from json-cache.mjs: a long session's file costs only its changed messages.
 */
export function sessionJsonParts(session) {
  const parts = [];
  let first = true;
  for (const key of Object.keys(session)) {
    const value = session[key];
    if (key === 'messages' && Array.isArray(value)) {
      parts.push(`${first ? '{' : ','}${JSON.stringify(key)}:[`);
      first = false;
      for (let i = 0; i < value.length; i++) {
        const message = value[i];
        const text = message !== null && typeof message === 'object' ? cachedJson(message) : JSON.stringify(message);
        parts.push(i ? ',' + (text ?? 'null') : (text ?? 'null'));
      }
      parts.push(']');
      continue;
    }
    const json = JSON.stringify(value);
    // Left out by JSON.stringify too: undefined, functions, symbols.
    if (json === undefined) continue;
    parts.push(`${first ? '{' : ','}${JSON.stringify(key)}:${json}`);
    first = false;
  }
  parts.push(first ? '{}' : '}');
  return parts;
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir  directory holding one <id>.json per session
 * @param {(message: string) => void} [deps.log]  where skipped files and save failures are reported
 * @param {number} [deps.largeSaveBytes]  files this large are written off the event loop (persist)
 * @param {number} [deps.largeSaveIntervalMs]  least time between two such writes of a session
 */
export function createStore({ dataDir, log = console.error, largeSaveBytes = LARGE_SAVE_BYTES, largeSaveIntervalMs = LARGE_SAVE_INTERVAL_MS }) {
  const sessions = new Map();

  function filePath(id) {
    return path.join(dataDir, id + '.json');
  }

  /**
   * Reads every session file. A corrupt file is reported and skipped so the server still
   * starts. `live`: ids of sessions whose process outlived the last server (CLI host).
   */
  function load({ live = new Set() } = {}) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(dataDir).filter((name) => name.endsWith('.json'))) {
      try {
        const text = fs.readFileSync(path.join(dataDir, file));
        const parsed = JSON.parse(text);
        const session = reviveSession(parsed, { live: live.has(parsed.id) });
        sessions.set(session.id, session);
        sizes.set(session.id, text.length);
      } catch (error) {
        log(`Skipping unreadable session file ${path.join(dataDir, file)}: ${error.message}`);
      }
    }
    return sessions.size;
  }

  // Session id -> bytes of its file when last read or written: what persist() goes by.
  const sizes = new Map();
  // Session id -> {timer, writing, dirty, endedAt, generation}: its writes off the event loop.
  const writes = new Map();

  function writeState(id) {
    let state = writes.get(id);
    if (!state) writes.set(id, (state = { timer: null, writing: false, dirty: false, endedAt: 0, generation: 0 }));
    return state;
  }

  /** Crash-safe write: a private temp file renamed over the real one. */
  function save(session) {
    session.updatedAt = Date.now();
    const target = filePath(session.id);
    const text = JSON.stringify(session);
    // Newer than any write under way: that one must not be renamed over this.
    const state = writes.get(session.id);
    if (state) {
      state.generation += 1;
      clearTimeout(state.timer);
      state.timer = null;
      state.dirty = false;
    }
    fs.writeFileSync(target + '.tmp', text, { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
    sizes.set(session.id, text.length);
  }

  /**
   * `save` for publishes. A long session's file (tens of MB) is not written on the event
   * loop: its JSON is assembled from the messages' cached JSON (json-cache.mjs) as they
   * are now, then written in chunks to a temp file and renamed over the real one, at most
   * once per LARGE_SAVE_INTERVAL_MS after the previous write ended. Shutdown (saveAll)
   * still writes everything at once.
   */
  function persist(session) {
    if ((sizes.get(session.id) ?? 0) < largeSaveBytes) return save(session);
    session.updatedAt = Date.now();
    const state = writeState(session.id);
    state.dirty = true;
    armWrite(session, state);
  }

  function armWrite(session, state) {
    if (state.timer || state.writing) return;
    const wait = Math.max(0, state.endedAt + largeSaveIntervalMs - Date.now());
    state.timer = setTimeout(() => {
      state.timer = null;
      void writeLarge(session, state);
    }, wait);
  }

  async function writeLarge(session, state) {
    if (!state.dirty) return;
    state.dirty = false;
    state.writing = true;
    const generation = ++state.generation;
    const target = filePath(session.id);
    const temp = target + '.tmp-large';
    let handle;
    try {
      // All of it as it is now, before the first await (the transcript may change while
      // the chunks are written).
      const parts = sessionJsonParts(session);
      handle = await fs.promises.open(temp, 'w', 0o600);
      let bytes = 0;
      let chunk = '';
      for (const part of parts) {
        chunk += part;
        if (chunk.length < WRITE_CHUNK) continue;
        bytes += (await handle.write(chunk)).bytesWritten;
        chunk = '';
      }
      if (chunk) bytes += (await handle.write(chunk)).bytesWritten;
      await handle.close();
      handle = null;
      // A synchronous save since (shutdown) is newer: keep that. The rename is synchronous,
      // so nothing can save in between the check and it.
      if (generation === state.generation) {
        fs.renameSync(temp, target);
        sizes.set(session.id, bytes);
      } else await fs.promises.rm(temp, { force: true });
    } catch (error) {
      log(`Could not save session ${session.id}: ${error.message}`);
      await handle?.close().catch(() => {});
    } finally {
      state.writing = false;
      state.endedAt = Date.now();
      if (state.dirty) armWrite(session, state);
    }
  }

  /** Saves every session (shutdown). Failures are reported and do not stop the others. */
  function saveAll() {
    for (const session of sessions.values()) {
      try {
        save(session);
      } catch (error) {
        log(`Could not save session ${session.id}: ${error.message}`);
      }
    }
  }

  function get(id) {
    const session = sessions.get(id);
    if (!session) throw httpError(404, 'Session not found');
    return session;
  }

  function insert(session) {
    sessions.set(session.id, session);
    return session;
  }

  /** All sessions, most recently updated first. */
  function list() {
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Forgets a session for good: out of memory and its file deleted (Empty Trash). */
  function remove(id) {
    const state = writes.get(id);
    if (state) {
      // A write under way must not rename a file back after this.
      state.generation += 1;
      clearTimeout(state.timer);
      state.timer = null;
      state.dirty = false;
    }
    writes.delete(id);
    sizes.delete(id);
    sessions.delete(id);
    for (const suffix of ['.json', '.json.tmp', '.json.tmp-large']) fs.rmSync(path.join(dataDir, id + suffix), { force: true });
  }

  return { sessions, dataDir, load, save, persist, saveAll, get, insert, list, remove };
}
