// Session import: the candidate lists for the import picker and turning picked Claude Code
// or Codex sessions into Harbor sessions. Reads the other tools' files only; ids from
// the client are looked up in the candidate index, never used as paths.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './errors.mjs';
import { claudeHomeDir, convertClaudeSession, listClaudeSessions, scanClaudeTranscripts } from './import-claude.mjs';
import { convertCodexRollout, findRollouts, readRolloutHead, readThreadNames, rolloutStorageId } from './import-codex.mjs';
import { omittedNotice, timeOf, titleLine } from './import-history.mjs';
import { DEFAULT_MODEL, catalogIdForModel, isKnownModel } from './models.mjs';
import { DEFAULT_MODE, addNotice, createSession, normalizeMode, publicSession } from './store.mjs';

export const IMPORT_SOURCES = ['claude', 'codex'];
export const MAX_IMPORT_IDS = 20;
// Rollouts whose heads are read at once when the Codex list is rebuilt.
const LIST_CONCURRENCY = 16;
// Rollouts continuing one another (history_base links) are followed this far back.
const MAX_ROLLOUT_CHAIN = 32;

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * @param {object} deps
 * @param {object} deps.config  from loadConfig(): homeRoot, claudeConfigDir, codexHome
 * @param {object} deps.store   from createStore()
 * @param {object} deps.events  from createEvents()
 */
export function createImporter({ config, store, events, log = console.error }) {
  const claudeHome = claudeHomeDir(config);
  const codexHome = config.codexHome;
  const homeRoot = config.homeRoot;

  let claudeIndex = null; // {fingerprint, entries: Map(id -> {candidate, file, projectDir})}
  const codexHeads = new Map(); // file -> {mtimeMs, size, head}
  let threadNames = { key: '', names: new Map() };
  const inFlight = new Map(); // "source:id" -> promise of the imported session

  /**
   * The folder a session runs in: the real path of `cwd` when it is inside the home
   * folder. Codex sessions may have recorded the home folder through another mount of
   * the same directory (e.g. /home/<user> and an NFS mount of it elsewhere);
   * those are mapped onto the home path. Claude Code imports are not mapped: the CLI
   * finds the original transcript by its recorded folder. Null when unusable.
   */
  function sessionFolder(kind, cwd) {
    const real = fs.realpathSync(cwd);
    if (isInside(real, homeRoot)) return real;
    if (kind !== 'codex') return null;
    const home = fs.statSync(homeRoot);
    for (let dir = real; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const stat = fs.statSync(dir);
      if (stat.dev === home.dev && stat.ino === home.ino) return path.join(homeRoot, path.relative(dir, real));
    }
    return null;
  }

  /** Why a session's folder cannot be used, or null. Results are cached per call. */
  function folderProblem(kind, cwd, cache) {
    if (typeof cwd !== 'string' || !cwd) return 'The session has no project folder.';
    if (!cache.has(cwd)) {
      let problem = null;
      try {
        const folder = sessionFolder(kind, cwd);
        // A path in the home folder can still lead out of it through a link.
        if (!folder) problem = isInside(path.resolve(cwd), homeRoot) ? 'Its folder links outside your home directory.' : 'Its folder is outside your home directory.';
        else if (!fs.statSync(folder).isDirectory()) problem = 'Its folder no longer exists.';
      } catch {
        problem = 'Its folder no longer exists.';
      }
      cache.set(cwd, problem);
    }
    return cache.get(cwd);
  }

  /** The live (not removed) Harbor session imported from this source id, if any. */
  function importedSession(kind, id) {
    for (const session of store.sessions.values()) {
      if (session.source?.kind === kind && session.source.id === id && !session.removed) return session;
    }
    return null;
  }

  function finishCandidate(kind, candidate, folders) {
    const problem = folderProblem(kind, candidate.cwd, folders);
    const imported = importedSession(kind, candidate.id);
    return {
      ...candidate,
      importable: !problem,
      ...(problem ? { reason: problem } : {}),
      ...(imported ? { importedAs: imported.id } : {}),
    };
  }

  // ---- Claude Code ----------------------------------------------------------------------

  async function claudeEntries() {
    const files = await scanClaudeTranscripts(claudeHome);
    const fingerprint = files
      .map((file) => `${file.file}:${file.mtimeMs}:${file.size}`)
      .sort()
      .join('\n');
    if (claudeIndex?.fingerprint === fingerprint) return claudeIndex.entries;
    const byId = new Map(files.map((file) => [file.id, file]));
    const entries = new Map();
    for (const info of await listClaudeSessions(config.claudeConfigDir)) {
      const file = byId.get(info.sessionId);
      if (!file) continue;
      const candidate = {
        id: info.sessionId,
        title: titleLine(info.customTitle || info.summary || info.firstPrompt || 'Untitled session'),
        cwd: info.cwd ?? '',
        createdAt: info.createdAt ?? info.lastModified,
        updatedAt: info.lastModified,
        size: info.fileSize ?? file.size,
        ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
      };
      entries.set(candidate.id, { candidate, file: file.file, projectDir: file.projectDir });
    }
    claudeIndex = { fingerprint, entries };
    return entries;
  }

  async function claudeCandidates() {
    const entries = await claudeEntries();
    // Harbor's own conversations are programmatic and already left out by the SDK;
    // this also covers any whose transcript says otherwise.
    const own = new Set([...store.sessions.values()].map((session) => session.sdkSessionId).filter(Boolean));
    const folders = new Map();
    const index = new Map();
    for (const [id, entry] of entries) {
      if (own.has(id)) continue;
      index.set(id, { ...entry, candidate: finishCandidate('claude', entry.candidate, folders) });
    }
    return index;
  }

  // ---- Codex ----------------------------------------------------------------------------

  async function codexThreadNames() {
    const file = path.join(codexHome, 'session_index.jsonl');
    let key = '';
    try {
      const stats = await fsp.stat(file);
      key = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      // No index.
    }
    if (key !== threadNames.key) threadNames = { key, names: key ? await readThreadNames(codexHome) : new Map() };
    return threadNames.names;
  }

  /**
   * A rollout's head, re-read only when the file changed since the last listing (or when
   * it was read without a title and its thread has lost its name since).
   */
  async function rolloutHead(file, names) {
    let stats;
    try {
      stats = await fsp.stat(file);
    } catch {
      return null;
    }
    const cached = codexHeads.get(file);
    const fresh = cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size;
    // A head read while the thread had a name skipped its first message; read it again if the name is gone.
    const titled = !cached?.head?.meta || cached.head.scannedForPrompt || names.has(cached.head.meta.id);
    if (fresh && titled) return { ...cached, stats };
    let head = null;
    try {
      head = await readRolloutHead(file, { hasTitle: (id) => names.has(id) });
    } catch (error) {
      log(`Could not read Codex session ${file}: ${error.message}`);
    }
    const entry = { mtimeMs: stats.mtimeMs, size: stats.size, head };
    codexHeads.set(file, entry);
    return { ...entry, stats };
  }

  async function codexEntries() {
    const names = await codexThreadNames();
    const files = await findRollouts(codexHome);
    const live = new Set(files);
    for (const file of codexHeads.keys()) if (!live.has(file)) codexHeads.delete(file);
    const heads = new Array(files.length);
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const index = next++;
        heads[index] = await rolloutHead(files[index], names);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, files.length) }, worker));

    // Rollouts by the id their file name ends with, which history_base links name.
    const byStorageId = new Map();
    files.forEach((file, index) => {
      const id = rolloutStorageId(file);
      const read = heads[index];
      if (!id || !read) return;
      const known = byStorageId.get(id);
      if (!known || known.size < read.stats.size) byStorageId.set(id, { file, size: read.stats.size, meta: read.head?.meta });
    });
    const createdAtOf = (meta) => timeOf(meta?.timestamp) ?? timeOf(meta?.lineTimestamp);

    /**
     * The rollouts whose lines come before this one's, oldest first, each with the byte
     * offset it is read up to: a long thread's earlier files, a fork's parent. A link to
     * a missing file ends the chain there.
     */
    function basesOf(file, meta) {
      const bases = [];
      const seen = new Set([file]);
      for (let link = meta.historyBase; link && bases.length < MAX_ROLLOUT_CHAIN; ) {
        const base = byStorageId.get(link.id);
        if (!base || seen.has(base.file)) break;
        seen.add(base.file);
        bases.unshift({ file: base.file, end: Math.min(link.end, base.size), threadId: base.meta?.id, createdAt: createdAtOf(base.meta) });
        link = base.meta?.historyBase;
      }
      return bases;
    }

    const entries = new Map();
    files.forEach((file, index) => {
      const read = heads[index];
      const meta = read?.head?.meta;
      if (!meta || typeof meta.id !== 'string') return;
      const name = names.get(meta.id);
      const bases = basesOf(file, meta);
      // A thread continued in a newer file began with its oldest one.
      const began = bases.filter((base) => base.threadId === meta.id && base.createdAt).map((base) => base.createdAt);
      const candidate = {
        id: meta.id,
        title: titleLine(name || read.head.firstPrompt || 'Untitled Codex session'),
        cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
        createdAt: Math.min(createdAtOf(meta) ?? read.stats.mtimeMs, ...began),
        updatedAt: Math.round(read.stats.mtimeMs),
        size: read.stats.size + bases.reduce((sum, base) => sum + base.end, 0),
        ...(typeof meta.originator === 'string' ? { originator: meta.originator } : {}),
        ...(typeof meta.git?.branch === 'string' ? { gitBranch: meta.git.branch } : {}),
      };
      const entry = { candidate, file, bases };
      // The same thread in two files: the one continuing the other (a long thread's
      // latest file), else the newer one (archived and active copies).
      const existing = entries.get(meta.id);
      const continues = (a, b) => a.bases.some((base) => base.file === b.file);
      if (!existing || continues(entry, existing) || (!continues(existing, entry) && existing.candidate.updatedAt < candidate.updatedAt)) {
        entries.set(meta.id, entry);
      }
    });
    return entries;
  }

  async function codexCandidates() {
    const entries = await codexEntries();
    const folders = new Map();
    const index = new Map();
    for (const [id, entry] of entries) index.set(id, { ...entry, candidate: finishCandidate('codex', entry.candidate, folders) });
    return index;
  }

  // ---- API ------------------------------------------------------------------------------

  function checkSource(source) {
    if (!IMPORT_SOURCES.includes(source)) throw httpError(400, 'Import from claude or codex.');
  }

  async function candidateIndex(source) {
    return source === 'claude' ? claudeCandidates() : codexCandidates();
  }

  /** `{items, total}`: every candidate, newest first. */
  async function list(source) {
    checkSource(source);
    const items = [...(await candidateIndex(source)).values()].map((entry) => entry.candidate).sort((a, b) => b.updatedAt - a.updatedAt);
    return { items, total: items.length };
  }

  /** A new idle session holding the converted history. */
  async function importOne(source, entry, { model, mode }) {
    const { candidate } = entry;
    const cwd = sessionFolder(source, candidate.cwd);
    if (!cwd) throw new Error('Its folder is outside your home directory.');
    const converted =
      source === 'claude'
        ? await convertClaudeSession(entry.file, entry.projectDir)
        : await convertCodexRollout(entry.file, { title: candidate.title, bases: entry.bases });
    // Claude Code imports continue on the model they last ran on when the catalog has it.
    const lastModel = source === 'claude' ? catalogIdForModel(converted.lastModel) : undefined;
    const sessionModel = lastModel ?? model ?? DEFAULT_MODEL;
    const session = createSession({ cwd, model: sessionModel, mode, title: candidate.title || 'Imported session' });
    session.source = {
      kind: source,
      id: candidate.id,
      title: candidate.title,
      createdAt: candidate.createdAt,
      updatedAt: converted.lastAt ?? candidate.updatedAt,
      ...(candidate.originator ? { originator: candidate.originator } : {}),
      ...(converted.omitted ? { omitted: converted.omitted } : {}),
    };
    if (converted.omitted) {
      addNotice(session, omittedNotice(converted.omitted, source), 'info', { imported: true, at: converted.messages[0]?.at ?? session.createdAt });
    }
    session.messages.push(...converted.messages);
    session.todos = converted.todos ?? [];
    session.plan = converted.plan ?? null;
    if (source === 'claude') {
      session.forkFrom = candidate.id;
      // A first turn on another model gets the usual switch note.
      if (converted.lastModel) session.lastTurnModel = lastModel ?? converted.lastModel;
    } else {
      session.handoff = converted.handoff;
    }
    store.insert(session);
    // Only the list entry goes to open browsers; a converted history can be ~1 MB.
    events.announce(session);
    return session;
  }

  /**
   * Imports the picked sessions one at a time (bounded memory). Already imported ids
   * return the existing session. Returns `{sessions, errors: [{id, error}]}`.
   */
  async function importSessions(body) {
    const { source, ids } = body ?? {};
    checkSource(source);
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IMPORT_IDS || !ids.every((id) => typeof id === 'string')) {
      throw httpError(400, `Pick between 1 and ${MAX_IMPORT_IDS} sessions to import.`);
    }
    if (body.model !== undefined && body.model !== null && !isKnownModel(body.model)) throw httpError(400, 'Unknown model');
    const modeGiven = body.mode !== undefined && body.mode !== null && body.mode !== '';
    const mode = modeGiven ? normalizeMode(body.mode) : DEFAULT_MODE;
    if (!mode) throw httpError(400, 'Unknown mode');

    const index = await candidateIndex(source);
    const sessions = [];
    const errors = [];
    for (const id of [...new Set(ids)]) {
      const entry = index.get(id);
      if (!entry) {
        errors.push({ id, error: 'This session was not found.' });
        continue;
      }
      if (!entry.candidate.importable) {
        errors.push({ id, error: entry.candidate.reason });
        continue;
      }
      const key = `${source}:${id}`;
      try {
        const existing = importedSession(source, id);
        if (existing) {
          sessions.push(existing);
          continue;
        }
        // A second request for the same id while the first converts gets the same session.
        if (!inFlight.has(key)) {
          inFlight.set(
            key,
            importOne(source, entry, { model: body.model ?? undefined, mode }).finally(() => inFlight.delete(key)),
          );
        }
        sessions.push(await inFlight.get(key));
      } catch (error) {
        log(`Import of ${key} failed: ${error.stack || error.message}`);
        errors.push({ id, error: `The session could not be imported: ${error.message}` });
      }
    }
    return { sessions: sessions.map((session) => publicSession(session)), errors };
  }

  return { list, importSessions };
}
