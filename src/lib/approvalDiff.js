// Line diffs for Edit / MultiEdit / Write approval previews. Rows use the same shape
// as parseDiff() in diff.js ({type: add|del|context|hunk, oldNo, newNo, text}) so the
// transcript's diff renderer can take over at merge time.

const MAX_CELLS = 4_000_000;

const splitLines = (text) => {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// Longest-common-subsequence line diff. Falls back to "all removed, all added" for
// inputs too large to compare cheaply.
export function lineDiff(oldText, newText) {
  const a = oldText === '' ? [] : splitLines(oldText);
  const b = newText === '' ? [] : splitLines(newText);
  const rows = [];
  if (a.length * b.length > MAX_CELLS) {
    a.forEach((text, i) => rows.push({ type: 'del', oldNo: i + 1, newNo: null, text }));
    b.forEach((text, i) => rows.push({ type: 'add', oldNo: null, newNo: i + 1, text }));
    return rows;
  }
  // lcs[i][j] = LCS length of a[i:] and b[j:], in a flat typed array.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ type: 'context', oldNo: i + 1, newNo: j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      // Deletions first, like git.
      rows.push({ type: 'del', oldNo: i + 1, newNo: null, text: a[i] });
      i += 1;
    } else {
      rows.push({ type: 'add', oldNo: null, newNo: j + 1, text: b[j] });
      j += 1;
    }
  }
  return rows;
}

export function countRows(rows) {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds += 1;
    else if (row.type === 'del') dels += 1;
  }
  return { adds, dels };
}

// The change a file tool would make: [{ title?, rows, adds, dels }] (one block per
// edit), or null when the tool is not a file change.
export function fileChangeBlocks(tool, input = {}) {
  const block = (rows, title) => ({ title, rows, ...countRows(rows) });
  if (tool === 'Edit') return [block(lineDiff(input.old_string ?? '', input.new_string ?? ''))];
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.map((edit, index) => block(lineDiff(edit?.old_string ?? '', edit?.new_string ?? ''), edits.length > 1 ? `Edit ${index + 1} of ${edits.length}` : undefined));
  }
  if (tool === 'Write') return [block(lineDiff('', input.content ?? ''))];
  if (tool === 'NotebookEdit') return [block(lineDiff('', input.new_source ?? ''), input.edit_mode ? `Cell · ${input.edit_mode}` : undefined)];
  return null;
}
