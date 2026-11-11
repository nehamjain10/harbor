// A subagent's whole conversation from Claude Code's own transcript, for the agent view
// when Harbor holds less of it than Claude Code does: agents captured without their
// steps (foreground agents of older or imported sessions), or cut short by a restart.
// Claude Code keeps every subagent's transcript in
// `<claude home>/projects/<project>/<session>/subagents/agent-<id>.jsonl`, next to an
// `agent-<id>.meta.json` naming its Agent call (`toolUseId`); agents started by
// subagents sit in the same folder. Lines are read with the session importer's parser
// (import-claude.mjs). Everything here only reads.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './errors.mjs';
import { claudeHomeDir, convertAgentTranscript, isSessionId, subagentFiles } from './import-claude.mjs';

export const AGENT_TRANSCRIPT_LIMITS = {
  // Messages returned in all (the latest ones), and their JSON.
  messages: 2000,
  bytes: 8 * 1024 * 1024,
  // Latest messages kept of each agent the subagent started.
  nestedMessages: 500,
  // Read from the end of each transcript file; anything before that is left out.
  fileBytes: 32 * 1024 * 1024,
};

// Claude Code's tool_use ids (`toolu_…`) and Harbor's fallback ids (`harbor-<uuid>`; older
// sessions have other prefixes): TOOL_ID accepts any of them.
const TOOL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const NATIVE_AGENTS = new Set(['Agent', 'Task']);
const DELEGATE_TOOL = 'mcp__meshy__delegate';

/** Claude Code's project folder name for a working directory: anything but letters and digits becomes `-`. */
export function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * @param {object} deps
 * @param {object} deps.config  from loadConfig(): claudeConfigDir (else CLAUDE_CONFIG_DIR, else ~/.claude)
 * @param {object} [deps.limits]  AGENT_TRANSCRIPT_LIMITS overrides (tests)
 */
export function createAgentTranscripts({ config, limits = {} }) {
  const projects = path.join(claudeHomeDir(config), 'projects');
  const caps = { ...AGENT_TRANSCRIPT_LIMITS, ...limits };

  /**
   * The Claude Code sessions whose subagents can be this session's: its own, and for an
   * import the original it was forked from (agents of the imported history ran there),
   * and for a fork the sessions its copied history came from.
   */
  function claudeSessions(session) {
    const ids = [
      session.sdkSessionId,
      session.forkFrom,
      session.source?.kind === 'claude' ? session.source.id : null,
      ...(Array.isArray(session.sdkAncestors) ? session.sdkAncestors : []),
    ];
    return [...new Set(ids.filter(isSessionId))];
  }

  /**
   * The subagent transcripts of those sessions by Agent call id, as `{file, meta}`: in the
   * project folder Claude Code names after the session's folder, else in whichever project
   * folder holds them (a long path's folder name is shortened, an import ran elsewhere).
   */
  async function findFiles(session, toolId) {
    const ids = claudeSessions(session);
    if (!ids.length) return null;
    const named = new Set([projectSlug(session.cwd)]);
    try {
      named.add(projectSlug(await fsp.realpath(session.cwd)));
    } catch {
      // A folder that is gone can still have its transcripts.
    }
    for (const name of named) {
      const files = await subagentFiles(path.join(projects, name), ids, { meta: true });
      if (files.has(toolId)) return files;
    }
    let dirs = [];
    try {
      dirs = await fsp.readdir(projects, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || named.has(dir.name)) continue;
      const files = await subagentFiles(path.join(projects, dir.name), ids, { meta: true });
      if (files.has(toolId)) return files;
    }
    return null;
  }

  /**
   * GET /api/sessions/:id/agents/:toolId/transcript: the agent's conversation in the
   * session's message format, rooted at its Agent call (see convertAgentTranscript).
   * `toolId` may also name an agent that only Claude Code's transcripts know (one started
   * by a subagent whose steps were not captured).
   */
  async function read(session, toolId) {
    if (typeof toolId !== 'string' || !TOOL_ID.test(toolId)) throw httpError(400, 'Invalid agent id.');
    const card = session.messages.find((m) => m.role === 'tool' && m.toolId === toolId);
    if (card?.tool === DELEGATE_TOOL) throw httpError(404, "A model agent's steps are only recorded live; Claude Code keeps no transcript of it here.");
    if (card && !NATIVE_AGENTS.has(card.tool)) throw httpError(404, 'Agent not found');
    const found = await findFiles(session, toolId);
    if (!found) throw httpError(404, 'Claude Code has no transcript of this agent.');
    const { meta } = found.get(toolId);
    const files = new Map([...found].map(([id, entry]) => [id, entry.file]));
    // Tool calls still in flight are not interrupted while the agent (or, for one only on
    // disk, any agent of the session) is still at work.
    const running = card ? card.state === 'running' : session.messages.some((m) => m.role === 'tool' && m.state === 'running' && (NATIVE_AGENTS.has(m.tool) || m.tool === DELEGATE_TOOL));
    const converted = await convertAgentTranscript(files, toolId, { ...caps, settle: !running });
    const agentId = path.basename(files.get(toolId), '.jsonl').replace(/^agent-/, '');
    return {
      toolId,
      agentId,
      ...(typeof meta.agentType === 'string' ? { agentType: meta.agentType } : {}),
      ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
      messages: converted.messages,
      omitted: converted.omitted,
      partial: converted.partial,
      truncated: converted.omitted > 0 || converted.partial,
    };
  }

  return { read };
}
