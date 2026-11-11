// Highlighted code views shared by the tool cards and the side panel: numbered
// listings (CodeView), plain highlighted blocks (CodeBlock) and diffs (DiffView).
// Large views are rendered as one HTML string (highlight.js output is escaped and
// only adds <span class="hljs-…">), which is much faster than thousands of vnodes.
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { escapeHtml, highlight, highlightLines } from '../lib/highlight.js';
import { splitLines } from '../lib/diff.js';
import './Code.css';

// Diffs and listings larger than this are shown without syntax colors.
const HIGHLIGHT_MAX_LINES = 6000;

function numberedRows(htmlLines, startLine, count, target) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const no = startLine + i;
    out += `<tr data-line="${no}"${no === target ? ' class="is-target"' : ''}><td class="ln">${no}</td><td class="lc">${htmlLines[i] || ' '}</td></tr>`;
  }
  return out;
}

// A numbered, highlighted listing. Pass `lines` (already split) or `code`.
// `maxLines` collapses long listings behind a "Show all" button; `target` marks a
// line (and `onTarget(rowElement)` lets the caller scroll to it).
export function CodeView({ code, lines, language, startLine = 1, maxLines = 0, target = null, onTarget, class: className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const all = useMemo(() => lines ?? splitLines(code), [code, lines]);
  const html = useMemo(
    () => (all.length <= HIGHLIGHT_MAX_LINES ? highlightLines(all.join('\n'), language) : all.map(escapeHtml)),
    [all, language],
  );
  // Only collapse when it hides a meaningful amount.
  const clipped = maxLines > 0 && !expanded && all.length > maxLines + 8 && !(target && target - startLine >= maxLines);
  const count = clipped ? maxLines : all.length;
  const rows = useMemo(() => numberedRows(html, startLine, count, target), [html, startLine, count, target]);
  const body = useRef(null);

  useLayoutEffect(() => {
    if (target && onTarget && body.current) {
      const row = body.current.querySelector(`tr[data-line="${target}"]`);
      if (row) onTarget(row);
    }
  }, [rows, target]);

  return (
    <div class={`code-view ${className}`}>
      <div class="code-scroll">
        <table class="code-table">
          <tbody ref={body} dangerouslySetInnerHTML={{ __html: rows }} />
        </table>
      </div>
      {clipped && (
        <button type="button" class="show-all" onClick={() => setExpanded(true)}>
          Show all {all.length.toLocaleString('en-US')} lines
        </button>
      )}
    </div>
  );
}

// Highlighted code without line numbers (commands, JSON).
export function CodeBlock({ code, language, class: className = '' }) {
  const html = useMemo(() => highlight(code, language), [code, language]);
  return <pre class={`code-pre ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Per-row highlighted HTML for diff rows. Each stretch between hunk headers is
// highlighted as its old and new text, so multi-line strings and comments color
// correctly; rows then pick their line from the side they belong to.
export function highlightDiffRows(rows, language) {
  if (!language || rows.length > HIGHLIGHT_MAX_LINES) return rows.map((row) => escapeHtml(row.text ?? ''));
  const out = new Array(rows.length).fill('');
  let start = 0;
  const flush = (end) => {
    const oldLines = [];
    const newLines = [];
    const refs = [];
    for (let i = start; i < end; i++) {
      const row = rows[i];
      if (row.type === 'del') refs.push([i, 'old', oldLines.push(row.text) - 1]);
      else if (row.type === 'add') refs.push([i, 'new', newLines.push(row.text) - 1]);
      else if (row.type === 'context') {
        oldLines.push(row.text);
        refs.push([i, 'new', newLines.push(row.text) - 1]);
      }
    }
    const oldHtml = oldLines.length ? highlightLines(oldLines.join('\n'), language) : [];
    const newHtml = newLines.length ? highlightLines(newLines.join('\n'), language) : [];
    for (const [i, side, index] of refs) out[i] = (side === 'old' ? oldHtml : newHtml)[index] ?? '';
  };
  rows.forEach((row, i) => {
    if (row.type === 'hunk' || row.type === 'skip' || row.type === 'meta') {
      flush(i);
      start = i + 1;
    }
  });
  flush(rows.length);
  return out;
}

const SIGNS = { add: '+', del: '−', context: ' ' };

function diffRowsHtml(rows, htmlLines, numbers) {
  const span = numbers ? 3 : 1;
  let out = '';
  rows.forEach((row, i) => {
    if (row.type === 'hunk' || row.type === 'meta') {
      out += `<tr class="d-${row.type}"><td colspan="${span}">${escapeHtml(row.text)}</td></tr>`;
    } else if (row.type === 'skip') {
      out += `<tr class="d-skip"><td colspan="${span}">⋯ ${row.count} unchanged ${row.count === 1 ? 'line' : 'lines'}</td></tr>`;
    } else {
      const cells = numbers ? `<td class="ln">${row.oldNo ?? ''}</td><td class="ln">${row.newNo ?? ''}</td>` : '';
      out += `<tr class="d-${row.type}">${cells}<td class="lc"><span class="sign">${SIGNS[row.type]}</span>${htmlLines[i] || ' '}</td></tr>`;
    }
  });
  return out;
}

// GitHub-style unified diff. `rows` from parseDiff / diffLines / collapseContext.
export function DiffView({ rows, language, numbers = true, class: className = '' }) {
  const html = useMemo(() => diffRowsHtml(rows, highlightDiffRows(rows, language), numbers), [rows, language, numbers]);
  return (
    <div class={`diff-view ${numbers ? '' : 'no-numbers'} ${className}`}>
      <table class="diff-table">
        <tbody dangerouslySetInnerHTML={{ __html: html }} />
      </table>
    </div>
  );
}
