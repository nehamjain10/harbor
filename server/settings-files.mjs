// The files of Claude Code's own setup that the settings dialog edits: settings.json
// (permissions, hooks), CLAUDE.md files and the auto-memory folder. Only a fixed list of
// files is reachable, each resolved from (scope, project folder) and checked with
// realpath, so no name, `..` or symlink can lead anywhere else:
//
//   user     <config dir>/settings.json, <config dir>/CLAUDE.md
//   project  <cwd>/.claude/settings.json, <cwd>/CLAUDE.md, <cwd>/.claude/CLAUDE.md
//   local    <cwd>/.claude/settings.local.json, <cwd>/CLAUDE.local.md
//   memory   <config dir>/projects/<slug>/memory/*.md  (names: see MEMORY_NAME)
//
// Writes need the version (a content hash) the editor started from: when the file changed
// meanwhile they fail with a conflict carrying the current copy. Each write keeps the
// previous copy under <data dir>/backups/settings, replaces the file atomically (a temp
// file in the same folder, renamed) with its old permissions, and does nothing when the
// content would not change. Settings are edited member by member (json-edit.mjs), so
// everything the dialog does not touch stays byte for byte.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectSlug } from './agent-transcript.mjs';
import { httpError } from './errors.mjs';
import { claudeHomeDir } from './import-claude.mjs';
import { REMOVE, editJson } from './json-edit.mjs';
import { MEMORY_NAME, addIndexLine, memoryTitle, parseFrontmatter, parseIndex, removeIndexLines } from './memory-format.mjs';
import { PERMISSION_LISTS, hooksProblem, hooksView, permissionsProblem, permissionsView, settingsProblem } from './settings-schema.mjs';

// Settings and CLAUDE.md files are small; the JSON body limit is 1 MB anyway.
export const MAX_FILE_BYTES = 512 * 1024;
export const BACKUPS_KEPT = 50;
export const INDEX_NAME = 'MEMORY.md';
const MAX_MEMORY_FILES = 500;
const BACKUP_NAME = /^\d{8}T\d{9}Z-/;

/** The editable files of each scope. `label` names a file in backups. */
const SCOPE_FILES = {
  user: [
    { id: 'settings', kind: 'settings', rel: 'settings.json', label: 'settings.json' },
    { id: 'claude-md', kind: 'markdown', rel: 'CLAUDE.md', label: 'CLAUDE.md' },
  ],
  project: [
    { id: 'settings', kind: 'settings', rel: '.claude/settings.json', label: 'settings.json' },
    { id: 'claude-md', kind: 'markdown', rel: 'CLAUDE.md', label: 'CLAUDE.md' },
    { id: 'dot-claude-md', kind: 'markdown', rel: '.claude/CLAUDE.md', label: 'dot-claude-CLAUDE.md' },
  ],
  local: [
    { id: 'settings', kind: 'settings', rel: '.claude/settings.local.json', label: 'settings.local.json' },
    { id: 'claude-md', kind: 'markdown', rel: 'CLAUDE.local.md', label: 'CLAUDE.local.md' },
  ],
};

export const SCOPES = [...Object.keys(SCOPE_FILES), 'memory'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

/** `realpath`, but for a path that does not exist yet: its nearest existing parent, resolved, plus the rest. */
async function realpathLoose(target) {
  try {
    return await fsp.realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realpathLoose(parent), path.basename(target));
  }
}

/** The 409 for a stale write: carries the file as it is now, for the editor's conflict view. */
function conflictError(current) {
  return Object.assign(httpError(409, 'This file changed on disk since you opened it.'), { conflict: true, current });
}

/** A settings file's text as the parts the dialog shows: permissions and hooks, or why it cannot be read. */
function parseSettings(content) {
  if (!content.trim()) return { valid: true, empty: true, permissions: permissionsView({}), hooks: {}, keys: [] };
  let settings;
  try {
    settings = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { valid: false, error: error.message };
  }
  if (!isObject(settings)) return { valid: false, error: 'A settings file holds a JSON object.' };
  const warning = settingsProblem(settings);
  return { valid: true, permissions: permissionsView(settings), hooks: hooksView(settings), keys: Object.keys(settings), ...(warning ? { warning } : {}) };
}

/**
 * @param {object} deps
 * @param {object} deps.config  from loadConfig(): dataDir, claudeConfigDir (else CLAUDE_CONFIG_DIR, else ~/.claude)
 */
export function createSettingsFiles({ config, log = console.error }) {
  const claudeHome = claudeHomeDir(config);
  const backupDir = path.join(config.dataDir, 'backups', 'settings');
  const tails = new Map();
  let lastBackupMs = 0;

  /** Runs `fn` after every earlier job on the same key (one write at a time per file). */
  async function withLock(key, fn) {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  /** A file's current state: `{exists: false}` or content, size, mtime, mode and version (a content hash). */
  async function readState(real) {
    let stats;
    try {
      stats = await fsp.stat(real);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, content: '', version: null };
      throw error;
    }
    if (!stats.isFile()) throw httpError(400, 'This path is not a regular file.');
    if (stats.size > MAX_FILE_BYTES) throw httpError(413, `This file is larger than ${MAX_FILE_BYTES / 1024} KB, too large to edit here.`);
    const buffer = await fsp.readFile(real);
    const content = buffer.toString('utf8');
    if (buffer.includes(0) || !Buffer.from(content, 'utf8').equals(buffer)) throw httpError(415, 'This file is not UTF-8 text.');
    return { exists: true, content, size: stats.size, mtime: Math.round(stats.mtimeMs), mode: stats.mode & 0o7777, version: hash(buffer) };
  }

  /** The previous copy of a file, 0600, under the data dir; only the newest BACKUPS_KEPT stay. */
  async function backup(scope, label, content) {
    await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
    lastBackupMs = Math.max(Date.now(), lastBackupMs + 1);
    for (;;) {
      const stamp = new Date(lastBackupMs).toISOString().replace(/[-:.]/g, '');
      const name = `${stamp}-${scope}-${label}`;
      try {
        await fsp.writeFile(path.join(backupDir, name), content, { flag: 'wx', mode: 0o600 });
        await fsp.chmod(path.join(backupDir, name), 0o600);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        lastBackupMs += 1;
      }
    }
    try {
      const names = (await fsp.readdir(backupDir)).filter((name) => BACKUP_NAME.test(name)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) await fsp.unlink(path.join(backupDir, name));
    } catch (error) {
      log(`Could not prune the settings backups: ${error.message}`);
    }
  }

  /** Writes a temp file in the target's folder, then renames it over the target (keeping its mode). */
  async function writeAtomic(real, content, { mode, dirMode }) {
    const dir = path.dirname(real);
    await fsp.mkdir(dir, { recursive: true, mode: dirMode });
    const temp = path.join(dir, `.${path.basename(real)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    // New files get the usual permissions (the umask applies); existing ones keep theirs.
    const handle = await fsp.open(temp, 'wx', mode ?? 0o666);
    try {
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (mode !== undefined) await fsp.chmod(temp, mode);
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      throw error;
    }
    return temp;
  }

  /**
   * The one way a file changes. `build(current)` returns the new text (or null for "no
   * change"); `version` is what the editor started from (null: the file did not exist);
   * `force` skips that check for writes derived from the current content (index lines).
   * Resolves to `{current, changed, created, before}` where `current` is the file now.
   */
  function commit({ scope, label, real, version, build, force = false, dirMode = 0o755 }) {
    return withLock(real, async () => {
      const before = await readState(real);
      const content = build(before);
      if (content === null || (before.exists && content === before.content)) return { current: before, changed: false, created: false, before };
      if (!force && version !== (before.exists ? before.version : null)) throw conflictError(before);
      if (before.exists) await backup(scope, label, before.content);
      const temp = await writeAtomic(real, content, { mode: before.exists ? before.mode : undefined, dirMode });
      try {
        // Another writer between our read and now (Claude Code saving its own settings):
        // leave their file alone.
        const now = await readState(real);
        if (now.version !== before.version) throw conflictError(now);
        await fsp.rename(temp, real);
      } catch (error) {
        await fsp.unlink(temp).catch(() => {});
        throw error;
      }
      return { current: await readState(real), changed: true, created: !before.exists, before };
    });
  }

  /** Where a scope's files live: the base folder (as written and as resolved) they must stay inside. */
  async function scopeBase(scope, cwd) {
    if (scope === 'user') return { dir: claudeHome, real: await realpathLoose(claudeHome) };
    if (!cwd) throw httpError(400, 'Choose a project folder.');
    return { dir: cwd, real: cwd };
  }

  /** The file entry of (scope, id) and the path to read and write (symlinks inside the scope followed). */
  async function locate(scope, id, cwd) {
    const entry = SCOPE_FILES[scope]?.find((file) => file.id === id);
    if (!entry) throw httpError(404, 'Unknown settings file.');
    const base = await scopeBase(scope, cwd);
    const lexical = path.join(base.dir, entry.rel);
    const real = await realpathLoose(lexical);
    if (!isInside(real, base.real)) throw httpError(403, `${entry.rel} is a link that leaves ${scope === 'user' ? 'the Claude config folder' : 'the project folder'}, so it cannot be edited here.`);
    return { entry, lexical, real };
  }

  const fileView = (scope, entry, lexical, state) => ({
    scope,
    id: entry.id,
    kind: entry.kind,
    name: path.basename(entry.rel),
    rel: entry.rel,
    path: lexical,
    exists: state.exists,
    size: state.size ?? 0,
    mtime: state.mtime ?? null,
    version: state.version,
    content: state.content,
    ...(entry.kind === 'settings' ? { parsed: parseSettings(state.content) } : {}),
  });

  /** All editable files of the user scope and of a project (scope project and local), without content. */
  async function list(cwd) {
    const files = [];
    for (const scope of cwd ? Object.keys(SCOPE_FILES) : ['user']) {
      for (const entry of SCOPE_FILES[scope]) {
        try {
          const { lexical, real } = await locate(scope, entry.id, cwd);
          const { content, ...view } = fileView(scope, entry, lexical, await readState(real));
          files.push(view);
        } catch (error) {
          files.push({ scope, id: entry.id, kind: entry.kind, name: path.basename(entry.rel), rel: entry.rel, path: path.join(scope === 'user' ? claudeHome : cwd, entry.rel), exists: true, error: error.message });
        }
      }
    }
    return { configDir: claudeHome, cwd: cwd ?? null, files };
  }

  async function read(scope, id, cwd) {
    const { entry, lexical, real } = await locate(scope, id, cwd);
    return fileView(scope, entry, lexical, await readState(real));
  }

  /** The `affects` of a write: which sessions' processes should restart (none when nothing changed). */
  const affects = (scope, cwd, changed) => (changed ? { scope, cwd: scope === 'user' ? null : cwd } : null);

  /** Replaces a whole file (CLAUDE.md files, or settings edited as raw JSON). */
  async function write(scope, id, cwd, { content, version }) {
    if (typeof content !== 'string') throw httpError(400, 'Send the new content as text.');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw httpError(413, `A file can be at most ${MAX_FILE_BYTES / 1024} KB.`);
    if (content.includes('\0')) throw httpError(400, 'A text file cannot contain null characters.');
    const { entry, lexical, real } = await locate(scope, id, cwd);
    if (entry.kind === 'settings') {
      let settings;
      try {
        settings = JSON.parse(content.replace(/^\uFEFF/, '') || '{}');
      } catch (error) {
        throw httpError(400, `Invalid JSON: ${error.message}`);
      }
      const problem = settingsProblem(settings);
      if (problem) throw httpError(400, problem);
    }
    const result = await commit({ scope, label: entry.label, real, version, build: () => content });
    return { file: fileView(scope, entry, lexical, result.current), changed: result.changed, affects: affects(scope, cwd, result.changed) };
  }

  /** `permissions` changes from a request: lists, `defaultMode` and `additionalDirectories`, null/empty to remove. */
  function permissionsEdits(patch) {
    if (!isObject(patch)) throw httpError(400, '"permissions" must be an object.');
    const known = [...PERMISSION_LISTS, 'defaultMode', 'additionalDirectories'];
    const unknown = Object.keys(patch).filter((key) => !known.includes(key));
    if (unknown.length) throw httpError(400, `Unknown permissions setting: ${unknown.join(', ')}.`);
    const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null && value !== ''));
    const problem = permissionsProblem(set);
    if (problem) throw httpError(400, problem);
    return Object.keys(patch).map((key) => {
      const value = set[key];
      // A rule listed twice is kept once.
      const unique = Array.isArray(value) ? [...new Set(value)] : value;
      return { path: ['permissions', key], value: unique === undefined || (Array.isArray(unique) && !unique.length) ? REMOVE : unique };
    });
  }

  /**
   * Changes `permissions` and/or `hooks` of a settings file, leaving all its other
   * content untouched. Emptied lists, an emptied `permissions` and empty hooks are removed.
   */
  async function patchSettings(scope, id, cwd, { version, permissions, hooks }) {
    const { entry, lexical, real } = await locate(scope, id, cwd);
    if (entry.kind !== 'settings') throw httpError(400, 'This is not a settings file.');
    const edits = permissions === undefined ? [] : permissionsEdits(permissions);
    if (hooks !== undefined && hooks !== null) {
      const problem = hooksProblem(hooks);
      if (problem) throw httpError(400, problem);
    }
    const result = await commit({
      scope,
      label: entry.label,
      real,
      version,
      build: (before) => {
        const source = before.content.trim() ? before.content : '{}\n';
        let settings;
        try {
          settings = JSON.parse(source.replace(/^\uFEFF/, ''));
        } catch (error) {
          throw httpError(400, `This file is not valid JSON (${error.message}). Fix it first.`);
        }
        if (!isObject(settings)) throw httpError(400, 'A settings file holds a JSON object.');
        const all = [...edits];
        if (permissions !== undefined) {
          // The permissions object left empty by removals goes too.
          const remaining = { ...(isObject(settings.permissions) ? settings.permissions : {}) };
          for (const edit of edits) {
            if (edit.value === REMOVE) delete remaining[edit.path[1]];
            else remaining[edit.path[1]] = edit.value;
          }
          if (!Object.keys(remaining).length) all.splice(0, all.length, { path: ['permissions'], value: REMOVE });
        }
        if (hooks !== undefined) all.push({ path: ['hooks'], value: hooks === null || !Object.keys(hooks).length ? REMOVE : hooks });
        const next = editJson(source, all);
        // Nothing to write into a file that does not exist.
        if (!before.exists && !Object.keys(JSON.parse(next)).length) return null;
        return next;
      },
    });
    return { file: fileView(scope, entry, lexical, result.current), changed: result.changed, affects: affects(scope, cwd, result.changed) };
  }

  /* Memory */

  /** The project's memory folder (as written and resolved), which must stay inside <config>/projects. */
  async function memoryDir(cwd) {
    if (!cwd) throw httpError(400, 'Choose a project folder.');
    const projects = path.join(claudeHome, 'projects');
    const dir = path.join(projects, projectSlug(cwd), 'memory');
    const real = await realpathLoose(dir);
    if (!isInside(real, await realpathLoose(projects))) throw httpError(403, "This project's memory folder is a link that leaves the Claude config folder.");
    return { dir, real };
  }

  function memoryName(name) {
    if (typeof name !== 'string' || !MEMORY_NAME.test(name)) {
      throw httpError(400, 'A memory file name is letters, digits, dots, dashes and underscores, ending in .md.');
    }
    return name;
  }

  /** The path to read and write for a memory file: directly inside the memory folder, links included. */
  async function memoryTarget(cwd, name) {
    memoryName(name);
    const folder = await memoryDir(cwd);
    const lexical = path.join(folder.dir, name);
    const real = await realpathLoose(lexical);
    if (!isInside(real, folder.real)) throw httpError(403, `${name} is a link that leaves the memory folder, so it cannot be edited here.`);
    return { folder, lexical, real };
  }

  /** The index (MEMORY.md) lines with the memory files they point to. */
  function indexView(state) {
    return { exists: state.exists, size: state.size ?? 0, mtime: state.mtime ?? null, version: state.version, content: state.content, lines: parseIndex(state.content) };
  }

  const memoryView = (name, lexical, state) => {
    const { data, body, type } = parseFrontmatter(state.content);
    return {
      scope: 'memory',
      name,
      path: lexical,
      exists: state.exists,
      size: state.size ?? 0,
      mtime: state.mtime ?? null,
      version: state.version,
      content: state.content,
      frontmatter: { name: data.name ?? '', description: data.description ?? '', type },
      body,
    };
  };

  /** The project's memories (frontmatter, no content) and its index. */
  async function memoryList(cwd) {
    const folder = await memoryDir(cwd);
    let entries;
    try {
      entries = await fsp.readdir(folder.real, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return { dir: folder.dir, exists: false, cwd, index: indexView({ exists: false, content: '', version: null }), files: [], missing: [] };
    }
    const indexTarget = await memoryTarget(cwd, INDEX_NAME).catch(() => null);
    const index = indexView(indexTarget ? await readState(indexTarget.real) : { exists: false, content: '', version: null });
    const linked = new Set(index.lines.map((line) => line.file));
    const files = [];
    const names = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name !== INDEX_NAME && MEMORY_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_MEMORY_FILES);
    for (const name of names) {
      try {
        const { lexical, real } = await memoryTarget(cwd, name);
        const view = memoryView(name, lexical, await readState(real));
        if (!view.exists) continue;
        const { content, body, ...row } = view;
        files.push({ ...row, inIndex: linked.has(name) });
      } catch (error) {
        files.push({ scope: 'memory', name, path: path.join(folder.dir, name), exists: true, error: error.message, inIndex: linked.has(name) });
      }
    }
    const present = new Set(entries.map((entry) => entry.name));
    const missing = index.lines.filter((line) => !present.has(line.file));
    return { dir: folder.dir, exists: true, cwd, index, files, missing };
  }

  async function memoryRead(cwd, name) {
    const { lexical, real } = await memoryTarget(cwd, name);
    return memoryView(name, lexical, await readState(real));
  }

  /** Adds or removes an index line for a memory file (derived from the index as it is now). */
  async function syncIndex(cwd, change) {
    const { real } = await memoryTarget(cwd, INDEX_NAME);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await commit({ scope: 'memory', label: INDEX_NAME, real, force: true, dirMode: 0o700, build: (before) => change(before.content) });
        return result.changed;
      } catch (error) {
        // Edited by someone else between our read and the rename: derive it again.
        if (!error.conflict || attempt >= 3) throw error;
      }
    }
  }

  /**
   * Creates (`version` null) or replaces a memory file. A new one also gets its index
   * line, `- [Title](file.md) — hook`, from `index` or from its frontmatter.
   */
  async function memoryWrite(cwd, name, { content, version, index }) {
    if (typeof content !== 'string') throw httpError(400, 'Send the new content as text.');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw httpError(413, `A file can be at most ${MAX_FILE_BYTES / 1024} KB.`);
    if (content.includes('\0')) throw httpError(400, 'A text file cannot contain null characters.');
    const { lexical, real } = await memoryTarget(cwd, name);
    const result = await commit({ scope: 'memory', label: name, real, version, dirMode: 0o700, build: () => content });
    let indexChanged = name === INDEX_NAME && result.changed;
    if (result.created && name !== INDEX_NAME) {
      const { data } = parseFrontmatter(content);
      const entry = { title: index?.title || memoryTitle(name, data), file: name, hook: index?.hook ?? data.description ?? '' };
      indexChanged = await syncIndex(cwd, (text) => addIndexLine(text, entry));
    }
    return { file: memoryView(name, lexical, result.current), changed: result.changed, affects: affects('memory', cwd, indexChanged) };
  }

  /** Deletes a memory file (backed up first) and its index lines. */
  async function memoryDelete(cwd, name, { version }) {
    if (name === INDEX_NAME) throw httpError(400, 'The index cannot be deleted; empty it instead.');
    const { lexical, real } = await memoryTarget(cwd, name);
    await withLock(real, async () => {
      const current = await readState(real);
      if (!current.exists) throw httpError(404, 'This memory no longer exists.');
      if (version !== current.version) throw conflictError(memoryView(name, lexical, current));
      await backup('memory', name, current.content);
      // The entry in the folder goes (a link, not the file it points to).
      await fsp.unlink(lexical);
    });
    const indexChanged = await syncIndex(cwd, (text) => (text.trim() ? removeIndexLines(text, name) : null));
    return { deleted: true, name, affects: affects('memory', cwd, indexChanged) };
  }

  return { list, read, write, patchSettings, memoryList, memoryRead, memoryWrite, memoryDelete, claudeHome, backupDir };
}
