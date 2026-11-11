// Codex `apply_patch` envelopes (imported as the ApplyPatch tool) parsed into
// per-file diff rows for DiffView:
//
//   *** Begin Patch
//   *** Update File: src/app.py
//   *** Move to: src/main.py
//   @@ def main():
//   -    print("hi")
//   +    print("hello")
//   *** Add File: notes.md
//   +# Notes
//   *** Delete File: old.txt
//   *** End Patch
//
// The format carries no line numbers; `@@` lines hold an optional anchor (the line a
// hunk follows), shown as the hunk header.

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const END_OF_FILE = '*** End of File';
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/;
const MOVE_TO = /^\*\*\* Move to:\s*(.+?)\s*$/;

const STATUS = { Add: 'added', Update: 'modified', Delete: 'deleted' };

// The patch text in an ApplyPatch input: `{patch}`, a raw custom-tool `{input}`, or a
// shell call (`apply_patch <<'EOF' …` as a string or `["apply_patch", patch]`).
export function patchText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const value of [input.patch, input.input, input.command, input.cmd]) {
    if (typeof value === 'string' && value.includes(BEGIN)) return value;
    if (Array.isArray(value)) {
      const part = value.find((item) => typeof item === 'string' && item.includes(BEGIN));
      if (part) return part;
    }
  }
  return typeof input.patch === 'string' ? input.patch : '';
}

// → [{ path, movePath, status: added | modified | deleted | renamed, adds, dels, rows }]
// with rows of { type: hunk | context | add | del, text } (no line numbers).
export function parsePatch(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const files = [];
  let file = null;
  let hunks = 0;

  const finish = () => {
    if (!file) return;
    // Blank lines between sections are not part of the last hunk.
    while (file.rows.length && file.rows.at(-1).type === 'context' && file.rows.at(-1).text === '') file.rows.pop();
    file = null;
  };

  for (const line of lines) {
    // Inside a file, a line starting with a space is context, even when its text is
    // "*** End Patch" (a patch to a document about patches).
    const trimmed = file && line.startsWith(' ') ? null : line.trim();
    if (trimmed === BEGIN) continue;
    if (trimmed === END) {
      finish();
      continue;
    }
    const header = line.match(FILE_HEADER);
    if (header) {
      finish();
      file = { path: header[2], movePath: '', status: STATUS[header[1]], adds: 0, dels: 0, rows: [] };
      files.push(file);
      hunks = 0;
      continue;
    }
    if (!file || file.status === 'deleted') continue;
    if (trimmed === END_OF_FILE) continue;

    if (file.status === 'added') {
      if (line.startsWith('+')) {
        file.rows.push({ type: 'add', text: line.slice(1) });
        file.adds += 1;
      }
      continue;
    }

    const move = line.match(MOVE_TO);
    if (move && !file.rows.length && !hunks) {
      file.movePath = move[1];
      file.status = 'renamed';
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      // The first hunk needs no header unless it names its anchor; later ones are
      // separated from the previous hunk either way.
      if (anchor || hunks > 0) file.rows.push({ type: 'hunk', text: anchor || '⋯' });
      hunks += 1;
    } else if (line.startsWith('+')) {
      file.rows.push({ type: 'add', text: line.slice(1) });
      file.adds += 1;
    } else if (line.startsWith('-')) {
      file.rows.push({ type: 'del', text: line.slice(1) });
      file.dels += 1;
    } else {
      // Context lines start with a space; an empty line is an empty context line.
      file.rows.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  finish();
  return files;
}

const cache = new WeakMap();

// Parsed files of an ApplyPatch tool call, cached per input object.
export function patchFiles(input) {
  if (!input || typeof input !== 'object') return parsePatch(patchText(input));
  if (!cache.has(input)) cache.set(input, parsePatch(patchText(input)));
  return cache.get(input);
}

// Total { adds, dels } over a patch's files.
export function patchStats(files) {
  return files.reduce((sum, file) => ({ adds: sum.adds + file.adds, dels: sum.dels + file.dels }), { adds: 0, dels: 0 });
}
