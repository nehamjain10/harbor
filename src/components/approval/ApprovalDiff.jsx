// Compact diff for Edit / MultiEdit / Write approvals (GitHub-like rows). Rows come
// from lib/approvalDiff.js in parseDiff()'s row shape, so the transcript's diff
// renderer can replace this component at merge time.
import './approval.css';

const SIGN = { add: '+', del: '−', context: ' ' };

function DiffRows({ rows, numbers, limit }) {
  const shown = rows.slice(0, limit);
  return (
    <div class={`adiff ${numbers ? 'has-numbers' : ''}`} role="table" aria-label="Proposed change">
      {shown.map((row, i) => (
        <div class={`adiff-row adiff-${row.type}`} role="row" key={i}>
          {numbers && <span class="adiff-no">{row.type === 'del' ? row.oldNo : row.newNo}</span>}
          <span class="adiff-sign">{SIGN[row.type] ?? ''}</span>
          <span class="adiff-text">{row.text || ' '}</span>
        </div>
      ))}
      {rows.length > shown.length && <div class="adiff-more">{rows.length - shown.length} more lines</div>}
    </div>
  );
}

// `blocks` = [{ title?, rows }]. Line numbers only when they are meaningful (a whole
// new file); an Edit's snippet has no known position in the file.
export function ApprovalDiff({ blocks, numbers = false, limit = 400 }) {
  if (!blocks?.length) return null;
  return (
    <div class="adiff-blocks">
      {blocks.map((block, i) => (
        <div class="adiff-block" key={i}>
          {block.title && <div class="adiff-title">{block.title}</div>}
          {block.rows.length ? <DiffRows rows={block.rows} numbers={numbers} limit={limit} /> : <div class="adiff-empty">Empty file</div>}
        </div>
      ))}
    </div>
  );
}
