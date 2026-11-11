// `@` mentions in the composer: the files and folders of a project, fuzzy ranked.
// The candidate list comes from git (tracked plus untracked, ignoring what .gitignore
// ignores) or, outside a repository, from a bounded walk. Paths are relative to the
// project folder and never leave it.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isEnvFile } from './files.mjs';

export const MAX_RESULTS = 50;
const MAX_GIT_ENTRIES = 50_000;
const GIT_TIMEOUT_MS = 3_000;
const WALK_TIMEOUT_MS = 3000;
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 6;
const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.pixi']);
const CACHE_TTL_MS = 30_000;
const MAX_CACHED_PROJECTS = 20;
const MAX_QUERY_LENGTH = 200;

/** True for a relative path that stays inside its folder and shows no .env file. */
function isListable(relative) {
  if (!relative || path.isAbsolute(relative)) return false;
  const parts = relative.split('/');
  return !parts.some((part) => part === '' || part === '.' || part === '..' || isEnvFile(part));
}

/**
 * `git ls-files` for the folder, or null when it is not in a repository. Stops at
 * MAX_GIT_ENTRIES; a slow listing (huge untracked trees) is cut off after 3 s and
 * whatever arrived is used.
 */
function gitFiles(cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = [];
    let rest = '';
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setTimeout(() => finish(files.length ? files : null), GIT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const parts = (rest + chunk).split('\0');
      rest = parts.pop();
      for (const part of parts) {
        files.push(part);
        if (files.length >= MAX_GIT_ENTRIES) return finish(files);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? files : null));
  });
}

/** Breadth-first listing for folders outside git: bounded in depth, size and time. */
async function walkFiles(cwd) {
  const entries = [];
  const deadline = Date.now() + WALK_TIMEOUT_MS;
  let level = [''];
  for (let depth = 0; depth < MAX_WALK_DEPTH && level.length; depth += 1) {
    const next = [];
    for (const dir of level) {
      if (Date.now() > deadline) return entries;
      let items;
      try {
        // opendir streams entries, so a huge folder is never read whole.
        items = await fsp.opendir(path.join(cwd, dir));
      } catch {
        continue;
      }
      for await (const item of items) {
        const relative = dir ? `${dir}/${item.name}` : item.name;
        // Symlinks are listed but never followed.
        const directory = item.isDirectory();
        if (directory && (WALK_SKIP.has(item.name) || item.name.startsWith('.'))) continue;
        entries.push({ path: relative, directory });
        // Returning from for-await closes the directory handle.
        if (entries.length >= MAX_WALK_ENTRIES || Date.now() > deadline) return entries;
        if (directory) next.push(relative);
      }
    }
    level = next;
  }
  return entries;
}

/** Files plus every folder above them, deduplicated, without hidden or escaping paths. */
export function withDirectories(files) {
  const entries = new Map();
  for (const file of files) {
    if (!isListable(file) || entries.has(file)) continue;
    entries.set(file, { path: file, directory: false });
    let dir = path.posix.dirname(file);
    while (dir !== '.' && !entries.has(dir)) {
      entries.set(dir, { path: dir, directory: true });
      dir = path.posix.dirname(dir);
    }
  }
  return [...entries.values()];
}

/** Every candidate entry of a project folder (an absolute, already confined path). */
export async function listProjectEntries(cwd) {
  const files = await gitFiles(cwd);
  // An ignored folder inside a repo lists nothing through git: walk it instead.
  if (files?.length) return withDirectories(files);
  return (await walkFiles(cwd)).filter((entry) => isListable(entry.path));
}

function isSubsequence(needle, haystack) {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * How well `entry` matches the lower-case query, lower is better, or null for no match:
 * 0 exact base name, 1 base-name prefix, 2 path-segment prefix, 3 subsequence of the base
 * name, 4 subsequence of the whole path.
 */
export function matchTier(entry, query) {
  if (!query) return 0;
  const lowerPath = entry.path.toLowerCase();
  const base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  if (base === query || lowerPath === query) return 0;
  if (base.startsWith(query)) return 1;
  if (('/' + lowerPath).includes('/' + query)) return 2;
  if (isSubsequence(query, base)) return 3;
  if (isSubsequence(query, lowerPath)) return 4;
  return null;
}

/** The best `limit` entries for a query; shorter paths win ties, then alphabetical order. */
export function rankEntries(entries, rawQuery, limit = MAX_RESULTS) {
  const query = String(rawQuery ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.\//, '')
    .slice(0, MAX_QUERY_LENGTH);
  const scored = [];
  for (const entry of entries) {
    const tier = matchTier(entry, query);
    if (tier !== null) scored.push({ entry, tier });
  }
  scored.sort(
    (a, b) => a.tier - b.tier || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path),
  );
  return scored.slice(0, limit).map(({ entry }) => ({ path: entry.path, directory: entry.directory }));
}

/**
 * A per-folder cache of candidate lists (30 s), shared by concurrent requests.
 * @param {object} [deps]
 * @param {(cwd: string) => Promise<object[]>} [deps.list]  replaceable in tests
 */
export function createFileSearch({ list = listProjectEntries, ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
  const cache = new Map(); // cwd -> { expires, entries: Promise }

  function entriesFor(cwd) {
    const hit = cache.get(cwd);
    if (hit && hit.expires > now()) return hit.entries;
    cache.delete(cwd);
    const entries = list(cwd).catch(() => []);
    cache.set(cwd, { expires: now() + ttlMs, entries });
    // Keep the newest folders only.
    while (cache.size > MAX_CACHED_PROJECTS) cache.delete(cache.keys().next().value);
    return entries;
  }

  /** `cwd` must already be resolved and confined (see projectPath). */
  async function search(cwd, query) {
    return rankEntries(await entriesFor(cwd), query);
  }

  return { search };
}
