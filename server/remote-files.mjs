// The UI's look into a remote session's folder, over ssh (one command each): `@` file
// completion, the Changes panel (git), the file preview and images the agent names. The
// same answers as files.mjs and file-search.mjs give for a local folder, within the
// same limits; the untracked files of the Changes panel are listed without their diff.
import crypto from 'node:crypto';
import path from 'node:path';
import { httpError } from './errors.mjs';
import { MAX_PREVIEW_BYTES, isEnvFile, parseNumstat, parsePorcelain, shownPath, statusWord } from './files.mjs';
import { withDirectories } from './file-search.mjs';
import { shQuote } from './remote-command.mjs';
import { runSsh } from './ssh.mjs';

const MAX_FILE_ITEMS = 250;
const MAX_UNTRACKED_LISTED = 200;
const MAX_DIFF_BYTES = 4_000_000;
const HIDDEN_FILE_ENTRIES = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
export const UNTRACKED_REMOTE_NOTICE = 'New files on this cluster are listed without their contents.';

/** Splits output written as sections, each followed by "\n<boundary>\n". */
function sections(text, boundary) {
  return text.split(`\n${boundary}\n`);
}

export function createRemoteFiles({ ssh = runSsh } = {}) {
  /** `@` completion candidates of a remote folder: [{path, directory}], like listProjectEntries. */
  async function entries(cluster, cwd) {
    const script = [
      `cd -- ${shQuote(cwd)} || exit 3`,
      'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf "G\\n"; timeout 3 git ls-files --cached --others --exclude-standard -z 2>/dev/null | head -c 6000000',
      "else printf 'W\\n'; timeout 3 find . -mindepth 1 -maxdepth 6 \\( -type d \\( -name .git -o -name node_modules -o -name .venv -o -name __pycache__ -o -name .pixi -o -name '.*' \\) \\) -prune -o \\( -type d -exec printf 'd %s\\0' {} + -o -exec printf 'f %s\\0' {} + \\) 2>/dev/null | head -c 3000000; fi",
    ].join('\n');
    const out = await ssh(cluster.host, script, { timeoutMs: 15_000 });
    const kind = out.slice(0, 1);
    const items = out.slice(2).split('\0').filter(Boolean);
    if (kind === 'G') return withDirectories(items);
    return items
      .map((item) => ({ path: item.slice(2).replace(/^\.\//, ''), directory: item[0] === 'd' }))
      .filter((entry) => entry.path && !entry.path.split('/').some(isEnvFile));
  }

  /** The Changes panel of a remote folder: what gitChanges answers, untracked files undiffed. */
  async function changes(cluster, cwd) {
    const boundary = crypto.randomBytes(12).toString('hex');
    const end = `printf '\\n%s\\n' ${boundary}`;
    const script = [
      `cd -- ${shQuote(cwd)} 2>/dev/null || { echo 'The project folder no longer exists.' >&2; exit 3; }`,
      'export GIT_OPTIONAL_LOCKS=0',
      'git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 4; }',
      `git branch --show-current 2>/dev/null; ${end}`,
      `git status --porcelain -z --untracked-files=no; ${end}`,
      'if git rev-parse --verify --quiet HEAD >/dev/null; then base=HEAD; else base=$(git hash-object -t tree /dev/null); fi',
      `git diff "$base" --no-ext-diff --no-color | head -c ${MAX_DIFF_BYTES}; ${end}`,
      `git diff "$base" --numstat -z --no-ext-diff; ${end}`,
      'timeout 3 git ls-files --others --exclude-standard -z 2>/dev/null | head -c 400000',
    ].join('\n');
    let out;
    try {
      out = await ssh(cluster.host, script, { timeoutMs: 30_000 });
    } catch (error) {
      const detail = String(error.stderr || error.message || '');
      const message = /not a git repository/i.test(detail)
        ? 'This folder is not a Git repository.'
        : error.code === 3
          ? 'The project folder no longer exists.'
          : `Git changes are unavailable on ${cluster.label}: ${detail.trim().split('\n').pop()?.slice(0, 200) || 'no answer'}`;
      return { diff: '', status: '', branch: '', files: [], error: message };
    }
    const [branchText = '', porcelain = '', diff = '', numstat = '', untrackedText = ''] = sections(out, boundary);
    const codes = parsePorcelain(porcelain);
    const untracked = untrackedText.split('\0').filter(Boolean);
    const files = parseNumstat(numstat).map((file) => ({ path: file.path, status: statusWord(codes.get(file.path)), adds: file.adds, dels: file.dels }));
    for (const file of untracked.slice(0, MAX_UNTRACKED_LISTED)) {
      if (!file.split('/').some(isEnvFile)) files.push({ path: file, status: 'untracked', adds: 0, dels: 0 });
    }
    const status = [...[...codes].map(([file, code]) => `${code} ${file}`), ...untracked.map((file) => `?? ${file}`)].map((line) => line + '\n').join('');
    return { diff, status, branch: branchText.trim() || 'Working tree', files, ...(untracked.length ? { notice: UNTRACKED_REMOTE_NOTICE } : {}) };
  }

  /** The file preview of a remote folder (or any absolute path there): what previewFile answers. */
  async function preview(cluster, cwd, value) {
    const target = path.posix.resolve(cwd, String(value || '.'));
    const script = [
      `p=${shQuote(target)}`,
      'if [ -d "$p" ]; then printf "D\\n"; cd -- "$p" && for f in * .[!.]* ..?*; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; if [ -d "$f" ]; then printf "d %s\\0" "$f"; else printf "f %s\\0" "$f"; fi; done',
      `elif [ -f "$p" ]; then if [ "$(wc -c < "$p")" -gt ${MAX_PREVIEW_BYTES} ]; then printf "L\\n"; else printf "F\\n"; cat -- "$p"; fi`,
      'else printf "N\\n"; fi',
    ].join('\n');
    const out = await ssh(cluster.host, script, { timeoutMs: 20_000, encoding: null });
    const kind = out.subarray(0, 1).toString();
    const relative = shownPath(cwd, target, path.posix);
    if (kind === 'N') throw httpError(404, 'File not found.');
    if (kind === 'L') throw httpError(413, 'This file is too large to preview.');
    if (kind === 'D') {
      const items = out
        .subarray(2)
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((item) => ({ name: item.slice(2), directory: item[0] === 'd' }))
        .filter((entry) => !HIDDEN_FILE_ENTRIES.has(entry.name) && !isEnvFile(entry.name))
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
        .slice(0, MAX_FILE_ITEMS)
        .map((entry) => ({ ...entry, path: path.posix.join(relative, entry.name) }));
      return { path: relative, directory: true, items };
    }
    const content = out.subarray(2);
    if (content.includes(0)) throw httpError(415, 'Binary file preview is not available.');
    return { path: relative, directory: false, content: content.toString() };
  }

  /** A file of at most `maxBytes` on the cluster (an image the agent names), or null. */
  async function readFile(cluster, file, maxBytes) {
    const script = `p=${shQuote(file)}; [ -f "$p" ] || exit 3; [ "$(wc -c < "$p")" -le ${maxBytes} ] || exit 4; cat -- "$p"`;
    try {
      return await ssh(cluster.host, script, { timeoutMs: 30_000, encoding: null, maxBytes: maxBytes + 1 });
    } catch (error) {
      if (error.code === 3) return null;
      if (error.code === 4) throw httpError(413, 'This image is too large to show.');
      throw httpError(502, `Could not read the file on ${cluster.label}: ${error.message}`);
    }
  }

  return { entries, changes, preview, readFile };
}
