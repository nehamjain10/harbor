// Filesystem access for the UI: path confinement, the project picker, file preview
// and git changes. Every path is resolved through realpath and confined to `root`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { httpError } from './errors.mjs';

const exec = promisify(execFile);

const HIDDEN_PROJECT_DIRS = new Set(['node_modules', '__pycache__']);
const HIDDEN_FILE_ENTRIES = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const MAX_PROJECT_ITEMS = 150;
const MAX_FILE_ITEMS = 250;
export const MAX_PREVIEW_BYTES = 350_000;
const MAX_UNTRACKED_FILES = 30;
const MAX_UNTRACKED_BYTES = 100_000;
// Untracked files listed in the Changes panel (only the first MAX_UNTRACKED_FILES are diffed).
const MAX_UNTRACKED_LISTED = 200;
const GIT_TIMEOUT_MS = 15_000;
// Listing untracked files walks the whole tree, which in a big folder on NFS takes
// ~10 s (the tracked changes take ~0.1 s). Past this budget the full scan is skipped
// for a while, and only the session's own new files are looked up.
const UNTRACKED_SCAN_MS = 3000;
const SLOW_SCAN_RETRY_MS = 10 * 60_000;
const MAX_HINTS = 200;
// Folder -> when to try a full untracked scan again.
const slowScans = new Map();
// Tools whose input names a file they write.
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const UNTRACKED_SKIPPED_NOTICE = 'Untracked files are not listed: Git takes too long to scan this folder.';
export const UNTRACKED_HINTS_NOTICE = 'Only new files written in this session are listed: Git takes too long to scan this folder for others.';

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

export function isEnvFile(name) {
  return name.startsWith('.env');
}

/**
 * Resolves `value` against `base` (default `root`), following symlinks, and rejects
 * anything that ends up outside `root`. The path must exist.
 */
export async function safePath(value, { root, base = root }) {
  const absolute = await fsp.realpath(path.resolve(base, value || '.'));
  if (!isInside(absolute, root)) throw httpError(403, 'Choose a folder inside your home directory.');
  return absolute;
}

export async function projectPath(value, root) {
  const resolved = await safePath(value, { root });
  if (!(await fsp.stat(resolved)).isDirectory()) throw new Error('Choose a directory');
  return resolved;
}

/** Subdirectories of a folder for the project picker. */
export async function listProjects(value, root) {
  const dir = await projectPath(value || root, root);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !HIDDEN_PROJECT_DIRS.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PROJECT_ITEMS)
    .map((entry) => ({
      name: entry.name,
      path: path.join(dir, entry.name),
      git: fs.existsSync(path.join(dir, entry.name, '.git')),
    }));
  return { path: dir, parent: dir === root ? null : path.dirname(dir), items };
}

/**
 * How the preview names a path: relative inside the project folder, absolute outside it
 * (a file an agent wrote elsewhere, e.g. under /data).
 */
export function shownPath(cwd, target, posix = path) {
  const relative = posix.relative(cwd, target);
  return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative)) ? relative : target;
}

/**
 * A directory listing or a text file's content: in the project folder (a relative path)
 * or anywhere this server's user can read (an absolute one). Only the owner reaches it.
 */
export async function previewFile(cwd, value) {
  const target = await fsp.realpath(path.resolve(cwd, value || '.')).catch((error) => {
    throw error.code === 'ENOENT' ? httpError(404, 'File not found.') : error;
  });
  const stats = await fsp.stat(target);

  if (stats.isDirectory()) {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const items = entries
      .filter((entry) => !HIDDEN_FILE_ENTRIES.has(entry.name) && !isEnvFile(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, MAX_FILE_ITEMS)
      .map((entry) => ({
        name: entry.name,
        path: shownPath(cwd, path.join(target, entry.name)),
        directory: entry.isDirectory(),
      }));
    return { path: shownPath(cwd, target), directory: true, items };
  }

  if (stats.size > MAX_PREVIEW_BYTES) throw httpError(413, 'This file is too large to preview.');
  const content = await fsp.readFile(target);
  if (content.includes(0)) throw httpError(415, 'Binary file preview is not available.');
  return { path: shownPath(cwd, target), directory: false, content: content.toString() };
}

/**
 * Untracked text files rendered as "new file" diff hunks. Returns the diff text and
 * the line count of each file it includes.
 */
async function untrackedDiff(cwd, root, files) {
  let diff = '';
  const lineCounts = new Map();
  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    if (file.split('/').some(isEnvFile)) continue;
    try {
      const target = await safePath(file, { root, base: cwd });
      if (!target.startsWith(cwd + path.sep)) continue;
      const stats = await fsp.stat(target);
      if (stats.size > MAX_UNTRACKED_BYTES) continue;
      const content = await fsp.readFile(target);
      if (content.includes(0)) continue;
      const text = content.toString();
      const lines = text ? text.replace(/\n$/, '').split('\n') : [];
      diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`;
      if (lines.length) diff += `@@ -0,0 +1,${lines.length} @@\n` + lines.map((line) => '+' + line).join('\n') + '\n';
      if (text && !text.endsWith('\n')) diff += '\\ No newline at end of file\n';
      lineCounts.set(file, lines.length);
    } catch {
      // Unreadable or vanished files are simply left out.
    }
  }
  return { diff, lineCounts };
}

/** `git status --porcelain -z` as path -> two-letter code (renames under the new path). */
export function parsePorcelain(text) {
  const codes = new Map();
  const entries = text.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    codes.set(entry.slice(3), code);
    // A rename or copy is followed by its original path.
    if (/[RC]/.test(code)) i += 1;
  }
  return codes;
}

/** `git diff --numstat -z` as [{path, adds, dels}]; binary files count 0 lines. */
export function parseNumstat(text) {
  const files = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const match = parts[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    let file = match[3];
    // A rename: the old and new paths follow as separate entries.
    if (!file) {
      file = parts[i + 2] || '';
      i += 2;
    }
    if (file) files.push({ path: file, adds: Number(match[1]) || 0, dels: Number(match[2]) || 0 });
  }
  return files;
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** A porcelain status code as a word: modified, added, deleted, renamed, copied, untracked or conflicted. */
export function statusWord(code = '') {
  if (code === '??') return 'untracked';
  if (CONFLICT_CODES.has(code)) return 'conflicted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('C')) return 'copied';
  if (code[0] === 'A') return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

function gitErrorMessage(error, cwd) {
  const detail = String(error?.stderr || error?.message || '');
  if (/not a git repository/i.test(detail)) return 'This folder is not a Git repository.';
  if (error?.code === 'ENOENT') return fs.existsSync(cwd) ? 'Git is not installed on the server.' : 'The project folder no longer exists.';
  if (error?.killed) return 'Git took too long to list the changes.';
  const line = detail
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .find(Boolean);
  return line ? `Git changes are unavailable: ${line.slice(0, 200)}` : 'Git changes are unavailable for this folder.';
}

/** Files this session wrote (Write, Edit, ...), newest first: where to look for new files when a full scan is too slow. */
export function writtenFiles(messages = []) {
  const seen = new Set();
  for (let i = messages.length - 1; i >= 0 && seen.size < MAX_HINTS; i--) {
    const message = messages[i];
    if (message?.role !== 'tool' || !WRITING_TOOLS.has(message.tool)) continue;
    const file = message.input?.file_path || message.input?.notebook_path;
    if (typeof file === 'string' && file) seen.add(file);
  }
  return [...seen];
}

/**
 * Untracked files under `cwd` (relative paths) within UNTRACKED_SCAN_MS, else only
 * those among `hints` (absolute or relative paths), with a `notice` saying so.
 */
async function untrackedFiles(cwd, hints, options) {
  const list = async (...args) => (await exec('git', ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', ...args], options)).stdout.split('\0').filter(Boolean);
  if (!(slowScans.get(cwd) > Date.now())) {
    try {
      const files = await list();
      slowScans.delete(cwd);
      return { files };
    } catch (error) {
      if (!error.killed) throw error;
      slowScans.set(cwd, Date.now() + SLOW_SCAN_RETRY_MS);
    }
  }
  const paths = [...new Set(hints.map((hint) => path.relative(cwd, path.resolve(cwd, hint))))].filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (!paths.length) return { files: [], notice: UNTRACKED_SKIPPED_NOTICE };
  return { files: await list('--', ...paths), notice: UNTRACKED_HINTS_NOTICE };
}

/**
 * Working-tree status and diff (including untracked files) for a project folder:
 * `{diff, status, branch, files: [{path, status, adds, dels}], notice?}`, or the same
 * with empty values and an `error` message. Git runs read-only. `hints` are files the
 * session wrote, listed when scanning the folder for untracked files takes too long
 * (`notice` then says what is missing).
 */
export async function gitChanges(cwd, root, { hints = [], scanMs = UNTRACKED_SCAN_MS } = {}) {
  // Read-only: git never takes the index lock to refresh it (the user's own git may be running).
  const options = { cwd, maxBuffer: 2 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const git = async (...args) => (await exec('git', args, options)).stdout;
  try {
    // Tracked files only: the untracked scan is the slow part, done once below.
    const codes = parsePorcelain(await git('status', '--porcelain', '-z', '--untracked-files=no'));
    let branch = 'Working tree';
    try {
      branch = (await git('branch', '--show-current')).trim();
    } catch {
      // Keep the placeholder name.
    }
    // Compare with HEAD; a repository without commits compares with the empty tree.
    let base = 'HEAD';
    try {
      await git('rev-parse', '--verify', '--quiet', 'HEAD');
    } catch {
      base = (await git('hash-object', '-t', 'tree', '/dev/null')).trim();
    }
    let diff = await git('diff', base, '--no-ext-diff', '--no-color');
    const numstat = parseNumstat(await git('diff', base, '--numstat', '-z', '--no-ext-diff'));
    const scan = await untrackedFiles(cwd, hints, { ...options, timeout: scanMs });
    const untracked = await untrackedDiff(cwd, root, scan.files);
    diff += untracked.diff;

    const files = numstat.map((file) => ({ path: file.path, status: statusWord(codes.get(file.path)), adds: file.adds, dels: file.dels }));
    for (const file of scan.files.slice(0, MAX_UNTRACKED_LISTED)) {
      if (file.split('/').some(isEnvFile)) continue;
      files.push({ path: file, status: 'untracked', adds: untracked.lineCounts.get(file) ?? 0, dels: 0 });
    }
    // `git status --short` lines, from what was gathered above.
    const status = [...[...codes].map(([file, code]) => `${code} ${file}`), ...scan.files.map((file) => `?? ${file}`)].map((line) => line + '\n').join('');
    return { diff, status, branch, files, ...(scan.notice ? { notice: scan.notice } : {}) };
  } catch (error) {
    return { diff: '', status: '', branch: '', files: [], error: gitErrorMessage(error, cwd) };
  }
}

/**
 * Shares gitChanges runs: requests for the same folder and hints join a run in
 * progress or reuse a result up to `ttlMs` old (switching between sessions with the
 * Changes panel open). `fresh` (a reload after an edit or the refresh button) always
 * runs git again.
 */
export function createChangesCache({ ttlMs = 5000, run = gitChanges, now = Date.now } = {}) {
  const entries = new Map();
  return function changes(cwd, root, { hints = [], fresh = false } = {}) {
    const key = cwd + '\0' + hints.join('\0');
    const entry = entries.get(key);
    if (!fresh && entry && (entry.pending || now() - entry.at < ttlMs)) return entry.promise;
    const next = { at: now(), pending: true, promise: null };
    next.promise = run(cwd, root, { hints }).finally(() => {
      next.pending = false;
      next.at = now();
    });
    entries.set(key, next);
    // Drop expired results so the map stays small.
    for (const [other, value] of entries) if (!value.pending && now() - value.at >= ttlMs) entries.delete(other);
    return next.promise;
  };
}
