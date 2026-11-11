// Forking: a new session holding a copy of a session's conversation, whole or up to one
// of the user's messages, that goes its own way from there. The original is untouched.
// Claude Code's side is the SDK's forkSession (a new transcript file with fresh uuids, cut
// after a given entry), made right away so later turns of the original never leak into
// the fork. Harbor's transcript is copied alongside. Files on disk are not.
//
// Forking at a message cuts Claude Code's transcript just before that message's entry.
// The entry is found by the uuid Harbor sent the message with (`sdkUuid`, recorded when
// Claude Code took it) or, for messages from before that and imported ones, by aligning
// the user's messages with the transcript's prompts by text.
//
// A session on another cluster keeps its Claude Code transcript there (the CLI runs with
// that cluster's HOME): it is read over ssh into a temp Claude Code home here, forked the
// same way, and the new transcript written back where the original was.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { forkSession as sdkForkSession } from '@anthropic-ai/claude-agent-sdk';
import { projectSlug } from './agent-transcript.mjs';
import { isRemote, sessionCluster } from './clusters.mjs';
import { httpError } from './errors.mjs';
import { claudeHomeDir, classifyUserText, isSessionId, readChain } from './import-claude.mjs';
import { shQuote } from './remote-command.mjs';
import { runSsh } from './ssh.mjs';
import { addNotice, createSession } from './store.mjs';
import { todoList } from './transcript.mjs';
import { publicAttachment } from './uploads.mjs';

const FORK_SUFFIX = ' (fork)';
const MAX_TITLE = 100;
// A transcript read over ssh is held whole in memory (the SDK reads it whole too).
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
// A tool card still running in the original (a background agent): its result goes there.
const ORPHANED = 'Still running when this session was forked; its result went to the original session.';
const NOT_FOUND =
  "Couldn't find this message in Claude Code's transcript (a compaction may have summarized it away). Fork the whole session instead.";
const GONE = "Claude Code's transcript of this session is gone, so it can't be forked.";
const REWIND_GONE = "Claude Code's transcript of this session is gone, so it can't be rewound.";
const REWIND_NOT_FOUND =
  "Couldn't find this message in Claude Code's transcript (a compaction may have summarized it away), so it can't be rewound to.";

/** Whether `message` is one of the user's own turns that a fork can start before. */
export function forkable(message) {
  return message?.role === 'user' && !message.parentToolId && message.delivery !== 'queued' && message.delivery !== 'cancelled';
}

function busy(session) {
  return session.status === 'running' || session.status === 'waiting';
}

export function forkTitle(title) {
  const base = String(title || 'New session');
  if (base.endsWith(FORK_SUFFIX)) return base.slice(0, MAX_TITLE);
  return base.slice(0, MAX_TITLE - FORK_SUFFIX.length) + FORK_SUFFIX;
}

/**
 * A transcript line that carries one of the user's prompts, as `{uuid, parentUuid, text,
 * sourceUuid?}`, else null. Prompts are user entries (not tool results or text Claude Code
 * injected) and messages Claude Code took mid-turn (`queued_command` attachments, whose
 * `source_uuid` is the uuid the message was sent with).
 */
export function promptEntry(line) {
  if (!line || typeof line.uuid !== 'string' || line.isSidechain || line.isMeta || line.isCompactSummary) return null;
  const parentUuid = typeof line.parentUuid === 'string' ? line.parentUuid : null;
  if (line.type === 'attachment') {
    const attachment = line.attachment;
    if (attachment?.type !== 'queued_command' || typeof attachment.prompt !== 'string') return null;
    if (attachment.commandMode && attachment.commandMode !== 'prompt') return null;
    return { uuid: line.uuid, parentUuid, text: attachment.prompt, sourceUuid: attachment.source_uuid };
  }
  if (line.type !== 'user') return null;
  const content = line.message?.content;
  if (typeof content === 'string') return { uuid: line.uuid, parentUuid, text: content };
  if (!Array.isArray(content) || content.some((block) => block?.type === 'tool_result')) return null;
  const text = content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
  return { uuid: line.uuid, parentUuid, text };
}

const ATTACHED = /(^|\n\n)Attached files:\n[\s\S]*$/;

/**
 * Whether a transcript prompt is this Harbor message: by the uuid it was sent with, else by
 * its text. Claude Code's copy can carry more: a model-switch note or an imported Codex
 * history in front, the attachment list behind, slash commands in tags, and messages it
 * took together joined by newlines (the first of them matches).
 */
export function samePrompt(prompt, message) {
  if (message.sdkUuid) return prompt.uuid === message.sdkUuid || prompt.sourceUuid === message.sdkUuid;
  const text = (message.text ?? '').trim();
  const body = prompt.text.replace(ATTACHED, '').trim();
  if (body === text || body.endsWith('\n\n' + text)) return true;
  if (text && body.startsWith(text + '\n')) return true;
  return text.startsWith('/') && classifyUserText(prompt.text)?.user === text;
}

/**
 * The transcript prompt of `messages[index]`, or null. The user's messages and the
 * prompts are aligned as a longest common subsequence, so a message Claude Code never
 * got (or one before a compaction) cannot pull later matches out of place.
 */
export function locatePrompt(prompts, messages, index) {
  const users = [];
  for (let i = 0; i <= index; i++) if (forkable(messages[i])) users.push(i);
  const n = users.length;
  const m = prompts.length;
  if (!n || !m || users[n - 1] !== index) return null;
  const same = (i, j) => samePrompt(prompts[j], messages[users[i]]);
  // lcs[i][j]: matches possible between users[i..] and prompts[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(i, j) && lcs[i][j] === lcs[i + 1][j + 1] + 1) {
      if (i === n - 1) return prompts[j];
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i += 1;
    else j += 1;
  }
  return null;
}

/** The prompts on a transcript's current chain, in order. */
export async function readPrompts(file) {
  const { chain } = await readChain(file);
  const onChain = new Set(chain.map((entry) => entry.id));
  const prompts = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const text of lines) {
    if (!/"type":\s*"(user|attachment)"/.test(text)) continue;
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    if (!onChain.has(line?.uuid)) continue;
    const prompt = promptEntry(line);
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

/**
 * The SDK's forkSession for the configured Claude Code home. The SDK reads the home from
 * CLAUDE_CONFIG_DIR at several points of the call, so a home other than the process's own
 * (tests, staging) is forked in a short-lived child process instead of swapping the
 * variable under turns that may start meanwhile.
 */
export function sdkForker(config, env = process.env) {
  const home = config.claudeConfigDir;
  if (!home || env.CLAUDE_CONFIG_DIR === home) return async (id, options) => (await sdkForkSession(id, options)).sessionId;
  const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  const script = `const { forkSession } = await import(process.argv[1]);
const result = await forkSession(process.argv[2], JSON.parse(process.argv[3]));
process.stdout.write(result.sessionId);`;
  const run = promisify(execFile);
  return async (id, options) => {
    try {
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, sdk, id, JSON.stringify(options)], {
        env: { ...env, CLAUDE_CONFIG_DIR: home },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      throw new Error(String(error.stderr || error.message).trim().split('\n').at(-1));
    }
  };
}

/**
 * @param {object} deps
 * @param {object} deps.config  from loadConfig(): claudeConfigDir (else CLAUDE_CONFIG_DIR, else ~/.claude)
 * @param {object} deps.store
 * @param {object} deps.events
 * @param {object} deps.uploads  from createUploads(): the draft's attachments are copied
 * @param {object} [deps.clusters]  from createClusters(): a remote session's transcript is
 *   read and written over ssh
 * @param {Function} [deps.ssh]  runSsh (replaceable in tests)
 * @param {(id: string, options: object) => Promise<string>} [deps.forkTranscript]  the SDK
 *   fork (replaceable in tests); resolves to the new Claude Code session id
 */
export function createForks({ config, store, events, uploads, clusters, ssh = runSsh, forkTranscript = sdkForker(config) }) {
  const projects = path.join(claudeHomeDir(config), 'projects');

  /** A Claude Code session's transcript file: in the folder named after `cwd`, else anywhere. */
  async function findTranscript(id, cwd) {
    const names = [projectSlug(cwd)];
    try {
      names.push(projectSlug(await fsp.realpath(cwd)));
    } catch {
      // A folder that is gone can still have its transcripts.
    }
    let dirs = [];
    try {
      dirs = (await fsp.readdir(projects, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return null;
    }
    for (const name of [...new Set(names), ...dirs]) {
      const file = path.join(projects, name, id + '.jsonl');
      try {
        if ((await fsp.stat(file)).isFile()) return file;
      } catch {
        // Not in this folder.
      }
    }
    return null;
  }

  async function forkClaude(id, cwd, options, fork = forkTranscript) {
    try {
      return await fork(id, { dir: cwd, ...options });
    } catch (error) {
      // An imported session's transcript can sit in another project's folder.
      if (!/not found/i.test(error.message)) throw httpError(500, `Claude Code could not fork this session: ${error.message}`);
      try {
        return await fork(id, options);
      } catch (retry) {
        throw httpError(409, `Claude Code could not fork this session: ${retry.message}`);
      }
    }
  }

  /**
   * A fork of a session Claude Code never ran: nothing on that side. An imported Codex
   * session hands its whole history over on the first turn, so a fork can start after it
   * but not inside it.
   */
  function neverRan(source, cut) {
    if (source.handoff && cut !== source.messages.length && source.messages[cut]?.imported) {
      throw httpError(409, "Forking inside an imported Codex conversation isn't supported. Fork the whole session instead.");
    }
    return {};
  }

  /**
   * The cluster of a remote session and its Claude Code home there: the CLI on the
   * cluster runs with that cluster's own HOME (`~/.claude`), never this machine's.
   */
  async function remoteClaude(source) {
    if (!clusters) throw httpError(500, 'Forking a session on another cluster needs the cluster list.');
    const cluster = clusters.get(sessionCluster(source));
    const home = await clusters.home(cluster).catch((error) => {
      throw httpError(502, `Could not reach ${cluster.label}: ${error.message}`);
    });
    return { cluster, configDir: path.posix.join(home, '.claude') };
  }

  /** A remote session's transcript path: in the folder named after `cwd`, else anywhere. */
  async function findRemoteTranscript(cluster, configDir, id, cwd) {
    const script = [
      `p=${shQuote(path.posix.join(configDir, 'projects'))}`,
      `id=${shQuote(id)}`,
      `real=$(cd -- ${shQuote(cwd)} 2>/dev/null && pwd -P | sed 's/[^a-zA-Z0-9]/-/g')`,
      `for n in ${shQuote(projectSlug(cwd))} "$real"; do [ -n "$n" ] && [ -f "$p/$n/$id.jsonl" ] && { printf '%s\\n' "$p/$n/$id.jsonl"; exit 0; }; done`,
      'for f in "$p"/*/"$id.jsonl"; do [ -f "$f" ] && { printf \'%s\\n\' "$f"; exit 0; }; done',
      'exit 3',
    ].join('\n');
    try {
      return (await ssh(cluster.host, script, { timeoutMs: 20_000 })).trim() || null;
    } catch (error) {
      if (error.code === 3) return null;
      throw httpError(502, `Could not reach ${cluster.label}: ${error.message}`);
    }
  }

  /**
   * A remote transcript staged in a temp Claude Code home (the SDK's fork works on the
   * file here), in the folder name the cluster had it in: `{home, dir, file}`.
   */
  async function stageTranscript(cluster, remoteFile, id) {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-fork-'));
    try {
      const dir = path.join(home, 'projects', path.posix.basename(path.posix.dirname(remoteFile)));
      await fsp.mkdir(dir, { recursive: true });
      const script = `p=${shQuote(remoteFile)}; [ -f "$p" ] || exit 3; cat -- "$p"`;
      let data;
      try {
        data = await ssh(cluster.host, script, { timeoutMs: 120_000, encoding: null, maxBytes: MAX_TRANSCRIPT_BYTES });
      } catch (error) {
        if (error.code === 3) throw httpError(409, GONE);
        throw httpError(502, `Could not read the transcript on ${cluster.label}: ${error.message}`);
      }
      const file = path.join(dir, id + '.jsonl');
      await fsp.writeFile(file, data);
      return { home, dir, file };
    } catch (error) {
      await fsp.rm(home, { recursive: true, force: true });
      throw error;
    }
  }

  /** The fork's transcript on the cluster, where the original was; aside then renamed,
   *  whole (a copy cut short is never taken for a session). */
  async function uploadTranscript(cluster, remoteFile, sdkSessionId, localFile) {
    const folder = path.posix.dirname(remoteFile);
    const target = path.posix.join(folder, sdkSessionId + '.jsonl');
    const tmp = `${shQuote(target + '.tmp.')}$$`;
    const size = (await fsp.stat(localFile)).size;
    const script = `umask 077 && mkdir -p ${shQuote(folder)} && cat > ${tmp} && [ "$(wc -c < ${tmp})" -eq ${size} ] && mv -f ${tmp} ${shQuote(target)} || { rm -f ${tmp}; exit 1; }`;
    try {
      await ssh(cluster.host, script, { input: fs.createReadStream(localFile), timeoutMs: 120_000 });
    } catch (error) {
      throw httpError(502, `Could not write the fork's transcript on ${cluster.label}: ${error.message}`);
    }
  }

  /**
   * Where a fork cut before `messages[cut]` starts in Claude Code's transcript: the
   * `upToMessageId` to cut after, or `{}` when nothing comes along.
   */
  function cutBefore(source, cut, prompts) {
    const prompt = locatePrompt(prompts, source.messages, cut);
    if (!prompt) throw httpError(409, NOT_FOUND);
    if (prompt.parentUuid) return { upToMessageId: prompt.parentUuid };
    // Claude Code's transcript starts with this message: nothing comes along, unless
    // there is history Claude Code got another way (an imported Codex session's).
    if (source.messages.slice(0, cut).some((m) => m.role === 'user' || m.role === 'assistant')) {
      throw httpError(409, "Claude Code's transcript starts at this message, so what came before it can't come along. Fork the whole session instead.");
    }
    return {};
  }

  /**
   * All of a session's conversation: after a rewind its transcript still runs on past
   * the point the next turn resumes at (`resumeAt`), until that turn branches off there.
   */
  function wholeCut(source) {
    return source.resumeAt ? { upToMessageId: source.resumeAt } : {};
  }

  /** The Claude Code side of a fork of a session on another cluster (see the top). */
  async function remoteClaudeSide(source, cut, title) {
    const id = source.sdkSessionId || source.forkFrom;
    const whole = cut === source.messages.length;
    if (!isSessionId(id)) return neverRan(source, cut);
    const { cluster, configDir } = await remoteClaude(source);
    const remoteFile = await findRemoteTranscript(cluster, configDir, id, source.cwd);
    if (!remoteFile) throw httpError(409, GONE);
    const staged = await stageTranscript(cluster, remoteFile, id);
    try {
      const target = whole ? wholeCut(source) : cutBefore(source, cut, await readPrompts(staged.file));
      if (!whole && !target.upToMessageId) return {};
      // The SDK's fork against the staged home (a child process, as sdkForker does for a
      // home other than this process's).
      const sdkSessionId = await forkClaude(id, source.cwd, { ...target, title }, sdkForker({ claudeConfigDir: staged.home }));
      await uploadTranscript(cluster, remoteFile, sdkSessionId, path.join(staged.dir, sdkSessionId + '.jsonl'));
      return { sdkSessionId };
    } finally {
      await fsp.rm(staged.home, { recursive: true, force: true });
    }
  }

  /**
   * The new session's Claude Code side: `{sdkSessionId?}` for a fork cut before
   * `messages[cut]` (or of everything, when `cut` is the end).
   */
  async function claudeSide(source, cut, title) {
    if (isRemote(source)) return remoteClaudeSide(source, cut, title);
    const id = source.sdkSessionId || source.forkFrom;
    const whole = cut === source.messages.length;
    if (!isSessionId(id)) return neverRan(source, cut);
    if (whole) return { sdkSessionId: await forkClaude(id, source.cwd, { title, ...wholeCut(source) }) };
    const file = await findTranscript(id, source.cwd);
    if (!file) throw httpError(409, GONE);
    const target = cutBefore(source, cut, await readPrompts(file));
    return target.upToMessageId ? { sdkSessionId: await forkClaude(id, source.cwd, { ...target, title }) } : {};
  }

  /** Harbor's transcript up to `cut`, as it stands in a session no process runs. */
  function copyMessages(source, cut) {
    const at = Date.now();
    // Queued messages stay with the original's queue.
    const messages = structuredClone(source.messages.slice(0, cut).filter((m) => !(m.role === 'user' && m.delivery === 'queued')));
    for (const message of messages) {
      if (message.role === 'tool' && message.state === 'running') {
        message.state = 'error';
        message.output ||= ORPHANED;
        message.endedAt = at;
        delete message.elapsed;
      }
      if (message.role === 'user' && message.parentToolId && message.delivery === 'sent') message.delivery = 'dropped';
      // A turn cut short by the fork point.
      if (message.role === 'user' && message.delivery === 'running') message.delivery = 'interrupted';
    }
    return messages;
  }

  /** The checklist and plan as of the copied messages. */
  function sidebarState(session, source, whole) {
    if (whole) {
      if (source.todos) session.todos = structuredClone(source.todos);
      if (source.plan) session.plan = structuredClone(source.plan);
      if (source.context) session.context = { ...source.context };
      return;
    }
    const top = session.messages.filter((m) => m.role === 'tool' && m.state === 'done' && !m.parentToolId);
    const todos = todoList(top.findLast((m) => m.tool === 'TodoWrite')?.input?.todos);
    if (todos) session.todos = todos;
    if (source.plan && top.some((m) => m.toolId === source.plan.toolId)) session.plan = structuredClone(source.plan);
  }

  /**
   * Forks `source`: whole, or before the user's message `messageId` (whose text and
   * attachments come back as the new session's draft). Returns `{session, draft?}`.
   */
  async function fork(source, { messageId } = {}) {
    if (source.removed) throw httpError(409, 'Restore this session from the Trash to fork it.');
    let cut = source.messages.length;
    let target = null;
    if (messageId !== undefined && messageId !== null) {
      if (typeof messageId !== 'string') throw httpError(400, 'Choose one of your messages to fork from.');
      cut = source.messages.findIndex((m) => m.id === messageId);
      target = source.messages[cut];
      if (!forkable(target)) throw httpError(404, "That message can't be forked from.");
    } else if (busy(source)) throw httpError(409, 'Wait for the turn to end, or stop it, then fork.');

    const title = forkTitle(source.title);
    const whole = !target;
    const claude = await claudeSide(source, cut, title);
    // A fork runs where its original does (clusters.mjs).
    const session = createSession({ cwd: source.cwd, model: source.model, mode: source.mode, title, cluster: sessionCluster(source) });
    session.efforts = { ...source.efforts };
    session.messages = copyMessages(source, cut);
    session.forkedFrom = { id: source.id, title: source.title, ...(target ? { messageId: target.id } : {}) };
    session.lastViewedAt = Date.now();
    if (claude.sdkSessionId) session.sdkSessionId = claude.sdkSessionId;
    // A Codex import that never ran keeps the history it hands over on the first turn.
    else if (source.handoff) session.handoff = source.handoff;
    // Where the copied agent cards' own transcripts are (see agent-transcript.mjs).
    const ancestors = [
      source.sdkSessionId,
      source.forkFrom,
      source.source?.kind === 'claude' ? source.source.id : null,
      ...(source.sdkAncestors ?? []),
    ].filter(isSessionId);
    if (ancestors.length) session.sdkAncestors = [...new Set(ancestors)];
    // The model the copied history last ran on: a later switch is announced to the model.
    if (whole && source.lastTurnModel) session.lastTurnModel = source.lastTurnModel;
    for (const key of ['mcpDisabled', 'allowRules', 'allowDirectories']) {
      if (Array.isArray(source[key]) && source[key].length) session[key] = structuredClone(source[key]);
    }
    sidebarState(session, source, whole);
    const quoted = `“${source.title}”`;
    addNotice(session, whole ? `Forked from ${quoted}.` : `Forked from ${quoted} before your message.`, 'info', { forkOf: source.id });
    store.insert(session);
    let draft;
    if (target) {
      const ids = (target.attachments ?? []).map((a) => a?.id).filter((id) => typeof id === 'string');
      const copies = ids.length ? await uploads.copy(ids, session.id) : [];
      draft = { text: target.text ?? '', attachments: copies.map(publicAttachment) };
    }
    events.flush(session);
    return { session, draft };
  }

  /**
   * The transcript prompt of `source.messages[cut]` (`{uuid, parentUuid}`), read where the
   * session's Claude Code runs; null when Claude Code never ran it.
   */
  async function promptOf(source, cut) {
    const id = source.sdkSessionId;
    if (!isSessionId(id)) return null;
    let prompts;
    if (isRemote(source)) {
      const { cluster, configDir } = await remoteClaude(source);
      const remoteFile = await findRemoteTranscript(cluster, configDir, id, source.cwd);
      if (!remoteFile) throw httpError(409, REWIND_GONE);
      const staged = await stageTranscript(cluster, remoteFile, id);
      try {
        prompts = await readPrompts(staged.file);
      } finally {
        await fsp.rm(staged.home, { recursive: true, force: true });
      }
    } else {
      const file = await findTranscript(id, source.cwd);
      if (!file) throw httpError(409, REWIND_GONE);
      prompts = await readPrompts(file);
    }
    const prompt = locatePrompt(prompts, source.messages, cut);
    if (!prompt) throw httpError(409, REWIND_NOT_FOUND);
    return prompt;
  }

  /**
   * Rewinds `source` in place to just before the user's message `messageId`: Harbor's
   * transcript is cut there and the next Claude Code process resumes at the entry before
   * it (`resumeAt`, see runner.mjs), so the next turn branches off from there. With
   * `code`, the files Claude edited since are first put back as they were, from Claude
   * Code's file checkpoints (edits through its Edit and Write tools only). `dryRun`
   * changes nothing and answers `{files}`: what restoring the code would do.
   *
   * `runner` gives `busy(session)`, `rewindFiles(session, uuid, {dryRun})` and
   * `restartCli(session)`. Returns `{files?, draft?}`.
   */
  async function rewind(source, { messageId, code = false, dryRun = false } = {}, runner) {
    if (source.removed) throw httpError(409, 'Restore this session from the Trash to rewind it.');
    if (typeof messageId !== 'string') throw httpError(400, 'Choose one of your messages to rewind to.');
    const cut = source.messages.findIndex((m) => m.id === messageId);
    const target = source.messages[cut];
    if (!forkable(target)) throw httpError(404, "That message can't be rewound to.");
    if (source.forkFrom || (source.handoff && target.imported)) throw httpError(409, "Rewinding inside an imported conversation isn't supported. Fork from the message instead.");
    if (!dryRun && runner.busy(source)) throw httpError(409, 'Wait for the turn and its agents to finish, or stop them, then rewind.');

    const prompt = await promptOf(source, cut);
    let files = null;
    if (code || dryRun) {
      // The preview names the files (a real restore only says whether it worked).
      const restore = (dry) => runner.rewindFiles(source, prompt.uuid, { dryRun: dry }).catch((error) => ({ canRewind: false, error: error.message }));
      files = prompt ? await restore(true) : { canRewind: false, error: 'Claude Code never ran this conversation, so there is no code to restore' };
      if (dryRun) return { files };
      if (files.canRewind) {
        const done = await restore(false);
        if (!done.canRewind) files = done;
      }
      if (!files.canRewind) throw httpError(409, `The code could not be restored: ${String(files.error || 'no checkpoint for this message').replace(/\.+$/, '')}. Rewind the conversation only, or fork from the message.`);
    }

    // What came after goes, except messages still waiting in the queue.
    source.messages = [...source.messages.slice(0, cut), ...source.messages.slice(cut).filter((m) => m.role === 'user' && m.delivery === 'queued')];
    if (prompt?.parentUuid) source.resumeAt = prompt.parentUuid;
    else if (prompt) {
      // Claude Code's transcript starts at this message: the next turn starts a new one.
      source.sdkAncestors = [...new Set([...(source.sdkAncestors ?? []), source.sdkSessionId])];
      delete source.sdkSessionId;
      delete source.resumeAt;
    }
    // The checklist and plan as of what is left; the context use is measured anew.
    const { plan } = source;
    for (const key of ['todos', 'plan', 'context']) delete source[key];
    sidebarState(source, { plan }, false);
    await runner.restartCli(source);
    const restored = files?.filesChanged?.length;
    const note = code ? ` and restored ${restored ?? 0} ${restored === 1 ? 'file' : 'files'}` : '';
    addNotice(source, `Rewound to before your message${note}.`, 'info');
    events.flush(source);
    const attachments = (target.attachments ?? []).filter((a) => typeof a?.id === 'string').map(publicAttachment);
    return { ...(files ? { files } : {}), draft: { text: target.text ?? '', attachments } };
  }

  return { fork, rewind };
}
