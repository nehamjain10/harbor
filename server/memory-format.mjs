// Claude Code auto-memory files as text: the frontmatter of a memory (`name`,
// `description`, `metadata.type`) and the `MEMORY.md` index, one line per memory:
// `- [Title](file.md) — hook`. Pure functions (no Node APIs): the settings dialog bundles
// this module too, so the server and the editor read and write them identically.

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
// `- [Title](file.md) — hook` (the dash may be an em dash, an en dash or a hyphen).
const INDEX_LINE = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)\s*(?:(?:—|–|-{1,2})\s*(.*))?$/;

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
// Memory file names: letters, digits, dot, dash and underscore, not starting with a dot
// (hidden files, and our own temp files), ending in .md.
export const MEMORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/;

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

/**
 * The frontmatter of a memory file. `data` holds the simple `key: value` lines (and the
 * `metadata:` block as an object); `type` is `metadata.type`, else a top-level `type`.
 * `raw` is the frontmatter text without the fences (null when there is none) and
 * `body` everything after it.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  const match = FRONTMATTER.exec(source);
  if (!match) return { data: {}, raw: null, body: source, type: '' };
  const data = {};
  let block = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^[ \t]+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (nested && block) {
      data[block][nested[1]] = unquote(nested[2]);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!top) continue;
    if (top[2].trim() === '') {
      block = top[1];
      data[block] = {};
    } else {
      block = null;
      data[top[1]] = unquote(top[2]);
    }
  }
  const type = typeof data.metadata?.type === 'string' ? data.metadata.type : typeof data.type === 'string' ? data.type : '';
  return { data, raw: match[1], body: source.slice(match[0].length), type };
}

/** A frontmatter value as YAML: plain when it is simple (and not `quote`d), else a double-quoted JSON string. */
function yamlValue(value, quote = false) {
  const text = String(value ?? '');
  return !quote && /^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(text) && !/^(true|false|null|yes|no|on|off|\d+)$/i.test(text) && !text.endsWith(' ')
    ? text
    : JSON.stringify(text);
}

/** Replaces the value of top-level key `key` in frontmatter lines, or inserts the line at `at`. */
function setTopLevel(lines, key, value, at = lines.length, quote = false) {
  const line = `${key}: ${yamlValue(value, quote)}`;
  const index = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (index >= 0) lines[index] = line;
  else lines.splice(at, 0, line);
}

/** Sets `metadata.type` (inside the `metadata:` block, or a top-level `type:` when that is where it is). */
function setType(lines, type) {
  const typeLine = `  type: ${yamlValue(type)}`;
  const block = lines.findIndex((l) => /^metadata:[ \t]*$/.test(l));
  if (block >= 0) {
    let end = block + 1;
    while (end < lines.length && /^[ \t]+\S/.test(lines[end])) end += 1;
    const existing = lines.slice(block + 1, end).findIndex((l) => /^[ \t]+type:/.test(l));
    if (existing >= 0) lines[block + 1 + existing] = typeLine;
    else lines.splice(block + 1, 0, typeLine);
    return;
  }
  const top = lines.findIndex((l) => /^type:/.test(l));
  if (top >= 0) lines[top] = `type: ${yamlValue(type)}`;
  else lines.push('metadata:', typeLine);
}

/**
 * `text` with its frontmatter fields set (`name`, `description`, `type`, each optional)
 * and the body replaced by `body` when given. Every other frontmatter line stays as it
 * was; a file without frontmatter gets one.
 */
export function composeMemory(text, { name, description, type, body } = {}) {
  const parsed = parseFrontmatter(text);
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = parsed.raw === null ? [] : parsed.raw.split(/\r?\n/);
  if (name !== undefined) setTopLevel(lines, 'name', name, 0);
  // Descriptions are prose: always quoted, as Claude Code writes them.
  if (description !== undefined) setTopLevel(lines, 'description', description, lines.findIndex((l) => /^name:/.test(l)) + 1, true);
  if (type !== undefined && type !== '') setType(lines, type);
  const rest = body === undefined ? parsed.body : body;
  if (!lines.length) return rest;
  return `---${eol}${lines.join(eol)}${eol}---${eol}${rest}`;
}

/** The memory's title for the index: its frontmatter `name`, else the file name without `.md`. */
export function memoryTitle(fileName, data = {}) {
  return (typeof data.name === 'string' && data.name.trim()) || fileName.replace(/\.md$/i, '');
}

/** The index lines that link to a file: `{line, title, file, hook}` (line = 0-based line number). */
export function parseIndex(text) {
  const entries = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, line) => {
      const match = INDEX_LINE.exec(raw);
      if (match) entries.push({ line, title: match[1], file: match[2], hook: (match[3] || '').trim() });
    });
  return entries;
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** One index line: `- [Title](file.md) — hook` (no dash without a hook). */
export function indexLine({ title, file, hook }) {
  const label = oneLine(title).replace(/\[/g, '(').replace(/\]/g, ')') || file.replace(/\.md$/i, '');
  const note = oneLine(hook);
  return `- [${label}](${file})${note ? ` — ${note}` : ''}`;
}

/** The index with a line for `file` added at the end (nothing changes when one is there already). */
export function addIndexLine(text, entry) {
  const source = String(text ?? '');
  if (parseIndex(source).some((existing) => existing.file === entry.file)) return source;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const base = source.trim() ? source.replace(/(\r?\n)*$/, '') : '# Memory Index' + eol;
  return `${base}${eol}${indexLine(entry)}${eol}`;
}

/** The index without any line linking to `file`. */
export function removeIndexLines(text, file) {
  const source = String(text ?? '');
  const drop = new Set(parseIndex(source).filter((entry) => entry.file === file).map((entry) => entry.line));
  if (!drop.size) return source;
  return source
    .split(/(?<=\n)/)
    .filter((_, line) => !drop.has(line))
    .join('');
}
