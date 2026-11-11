// Diffs: parses `git diff` text into files and numbered rows for the Changes panel,
// and computes line diffs (Myers) for Edit / MultiEdit tool cards.

// File header lines, dropped from the rows. They only appear before a file's first
// hunk; inside a hunk a line such as `--- x` is a deleted line whose text starts "-- ".
const HEADER = [/^diff --git /, /^index /, /^--- /, /^\+\+\+ /, /^new file mode/, /^deleted file mode/, /^similarity index/, /^rename (from|to) /, /^old mode/, /^new mode/];

export function parseDiff(text) {
  if (!text) return [];
  return text
    .split(/(?=^diff --git )/m)
    .filter((block) => block.trim())
    .map(parseFile);
}

function parseFile(block) {
  const lines = block.replace(/\n$/, '').split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const header = firstHunk < 0 ? lines : lines.slice(0, firstHunk);
  const path = header.find((l) => l.startsWith('+++ b/'))?.slice(6)
    || header.find((l) => l.startsWith('--- a/'))?.slice(6)
    || lines[0].split(' b/').pop();
  const isNew = header.some((l) => l.startsWith('new file mode'));
  const isDeleted = header.some((l) => l.startsWith('deleted file mode'));

  const rows = [];
  for (const line of header) {
    // Anything else in the header ("Binary files … differ") is shown as a note.
    if (!HEADER.some((re) => re.test(line))) rows.push({ type: 'meta', text: line });
  }

  let oldLine = 0;
  let newLine = 0;
  let adds = 0;
  let dels = 0;
  for (const line of firstHunk < 0 ? [] : lines.slice(firstHunk)) {
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      rows.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      adds += 1;
      rows.push({ type: 'add', oldNo: null, newNo: newLine++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      dels += 1;
      rows.push({ type: 'del', oldNo: oldLine++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      rows.push({ type: 'meta', text: line });
    } else {
      rows.push({ type: 'context', oldNo: oldLine++, newNo: newLine++, text: line.slice(1) });
    }
  }
  return { path, status: isNew ? 'added' : isDeleted ? 'deleted' : 'modified', adds, dels, rows };
}

// ---------------------------------------------------------------------------
// Line diff between two texts (for Edit / MultiEdit tool cards).

// Above this many differing lines (after trimming the common head and tail) the
// middle is shown as a plain replacement instead of running the O(ND) search.
const MAX_DIFF_LINES = 4000;
// The search also gives up past this many edits: its trace holds about D² numbers
// (1000 → ~4 MB), and a diff that large reads no better than a plain replacement.
const MAX_EDIT_DISTANCE = 1000;

// `text` as lines; a trailing newline does not add an empty last line.
export function splitLines(text) {
  const value = String(text ?? '');
  if (!value) return [];
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// Myers' O(ND) shortest edit script between line arrays `a` and `b`, as a list of
// [type, aIndex, bIndex] with type context | del | add, or null when it needs more
// than `maxEdits` edits.
function myers(a, b, maxEdits = MAX_EDIT_DISTANCE) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the part of `v` that step d reads: diagonals -(d + 1)..(d + 1).
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > maxEdits) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const window = trace[d];
    const at = (k) => window[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(['context', x - 1, y - 1]);
      x -= 1;
      y -= 1;
    }
    if (d > 0) ops.push(x === prevX ? ['add', null, y - 1] : ['del', x - 1, null]);
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// Rows of { type: context | del | add, oldNo, newNo, text } turning `oldText` into
// `newText`. Line numbers are 1-based within each text.
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const rows = [];
  const context = (i, j) => rows.push({ type: 'context', oldNo: i + 1, newNo: j + 1, text: a[i] });
  for (let i = 0; i < head; i++) context(i, i);

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops = midA.length + midB.length > MAX_DIFF_LINES ? null : myers(midA, midB);
  if (ops) {
    for (const [type, i, j] of ops) {
      if (type === 'context') context(head + i, head + j);
      else if (type === 'del') rows.push({ type, oldNo: head + i + 1, newNo: null, text: midA[i] });
      else rows.push({ type, oldNo: null, newNo: head + j + 1, text: midB[j] });
    }
  } else {
    midA.forEach((text, i) => rows.push({ type: 'del', oldNo: head + i + 1, newNo: null, text }));
    midB.forEach((text, j) => rows.push({ type: 'add', oldNo: null, newNo: head + j + 1, text }));
  }

  for (let t = tail; t > 0; t--) context(a.length - t, b.length - t);
  return rows;
}

export function countChanges(rows) {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds += 1;
    else if (row.type === 'del') dels += 1;
  }
  return { adds, dels };
}

// Replaces unchanged runs longer than 2 * `context` + 2 lines with one
// { type: 'skip', count } row, keeping `context` lines around each change.
export function collapseContext(rows, context = 3) {
  const out = [];
  let run = [];
  const flush = (atStart, atEnd) => {
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    if (run.length > keepHead + keepTail + 2) {
      out.push(...run.slice(0, keepHead), { type: 'skip', count: run.length - keepHead - keepTail }, ...run.slice(run.length - keepTail));
    } else out.push(...run);
    run = [];
  };
  let seenChange = false;
  for (const row of rows) {
    if (row.type === 'context') run.push(row);
    else {
      flush(!seenChange, false);
      seenChange = true;
      out.push(row);
    }
  }
  if (seenChange) flush(false, true);
  else out.push(...run);
  return out;
}

const editCache = new WeakMap();

// The hunks of an Edit / MultiEdit call: one per edit, each { rows, replaceAll },
// plus total { adds, dels }. Cached per input object.
export function editDiff(input) {
  if (!input || typeof input !== 'object') return { hunks: [], adds: 0, dels: 0 };
  if (editCache.has(input)) return editCache.get(input);
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  let adds = 0;
  let dels = 0;
  const hunks = edits
    .filter((edit) => edit && (typeof edit.old_string === 'string' || typeof edit.new_string === 'string'))
    .map((edit) => {
      const rows = diffLines(edit.old_string, edit.new_string);
      const counts = countChanges(rows);
      adds += counts.adds;
      dels += counts.dels;
      return { rows, replaceAll: !!(edit.replace_all ?? input.replace_all) };
    });
  const result = { hunks, adds, dels };
  editCache.set(input, result);
  return result;
}

// One-letter git status for the Changes list: M, A, D, R, U (untracked) or ?.
export function statusLetter(status) {
  const value = String(status || '').trim();
  const words = { modified: 'M', added: 'A', new: 'A', deleted: 'D', removed: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' };
  if (words[value.toLowerCase()]) return words[value.toLowerCase()];
  if (value === '??') return 'U';
  const letter = value.replace(/\s/g, '')[0];
  return letter ? letter.toUpperCase() : 'M';
}
