// Grep / Glob: the query as chips and the results as links into the side panel.
import { useState } from 'preact/hooks';
import { FileText } from 'lucide-preact';
import { openFile } from '../../actions.js';
import { searchScope } from '../../lib/tools.js';
import { parseSearchOutput, stripReminders } from '../../lib/toolOutput.js';
import { Chip, Note, OutputBlock, PathLabel } from './shared.jsx';

const SHOWN = 30;
// Lines (matches and context) shown per file before "N more lines".
const LINES_SHOWN = 20;

const GREP_FLAGS = [
  ['-i', 'case-insensitive'],
  ['-n', 'line numbers'],
  ['-o', 'only matching'],
  ['multiline', 'multiline'],
];

function QueryChips({ tool, input, cwd }) {
  const context = input['-C'] ?? input.context;
  return (
    <div class="chip-row">
      <Chip tone="accent" mono>
        {input.pattern}
      </Chip>
      {searchScope(input.path, cwd) && <Chip mono>in {searchScope(input.path, cwd)}</Chip>}
      {input.glob && <Chip mono>{input.glob}</Chip>}
      {input.type && <Chip mono>type: {input.type}</Chip>}
      {tool === 'Grep' && input.output_mode && <Chip>{input.output_mode.replace(/_/g, ' ')}</Chip>}
      {GREP_FLAGS.filter(([flag]) => input[flag]).map(([flag, label]) => (
        <Chip key={flag}>{label}</Chip>
      ))}
      {context != null && <Chip>±{context} lines</Chip>}
      {input['-A'] != null && <Chip>{input['-A']} after</Chip>}
      {input['-B'] != null && <Chip>{input['-B']} before</Chip>}
      {input.head_limit != null && <Chip>first {input.head_limit}</Chip>}
    </div>
  );
}

// Consecutive results for the same file share one header (content mode).
function groupByFile(items) {
  const groups = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.path === item.path && item.line != null) last.lines.push(item);
    else groups.push({ path: item.path, lines: item.line != null ? [item] : [], note: item.line == null ? item.text : '' });
  }
  return groups;
}

// One file's results: its path, then its lines (the first LINES_SHOWN, with a
// button for the rest when there are clearly more).
function SearchFile({ group }) {
  const [showAll, setShowAll] = useState(false);
  const clipped = !showAll && group.lines.length > LINES_SHOWN + 5;
  const lines = clipped ? group.lines.slice(0, LINES_SHOWN) : group.lines;
  const hidden = group.lines.length - lines.length;
  return (
    <div class="search-file">
      <button type="button" class="search-path" onClick={() => openFile(group.path, group.lines[0]?.line ?? null)} title={`Open ${group.path}`}>
        <FileText size={13} />
        <PathLabel path={group.path} />
        {group.note && <span class="search-count">{group.note}</span>}
      </button>
      {lines.map((item) => (
        <button
          type="button"
          key={item.line}
          class={`search-line ${item.context ? 'is-context' : ''}`}
          onClick={() => openFile(group.path, item.line)}
          title={`Open ${group.path}:${item.line}`}
        >
          <span class="search-line-no">{item.line}</span>
          <span class="search-line-text mono">{item.text || ' '}</span>
        </button>
      ))}
      {hidden > 0 && (
        <button type="button" class="more-btn search-more" onClick={() => setShowAll(true)}>
          {hidden} more {hidden === 1 ? 'line' : 'lines'} in this file
        </button>
      )}
    </div>
  );
}

export function SearchDetail({ message, output, cwd }) {
  const input = message.input || {};
  const [showAll, setShowAll] = useState(false);
  const error = message.state === 'error';
  const result = error ? null : parseSearchOutput(output, { cwd, tool: message.tool, file: input.path });
  const groups = result ? groupByFile(result.items) : [];
  const shown = showAll ? groups : groups.slice(0, SHOWN);
  return (
    <>
      <QueryChips tool={message.tool} input={input} cwd={cwd} />
      {error && <OutputBlock text={stripReminders(output)} error />}
      {result && (result.header || !groups.length) && (
        <p class="search-header">{result.header || (message.state === 'running' ? 'Searching…' : output.trim() ? '' : 'No results')}</p>
      )}
      {shown.length > 0 && (
        <div class="search-results">
          {shown.map((group, i) => (
            <SearchFile group={group} key={group.path + i} />
          ))}
        </div>
      )}
      {groups.length > SHOWN && !showAll && (
        <button type="button" class="more-btn" onClick={() => setShowAll(true)}>
          {groups.length - SHOWN} more {groups.length - SHOWN === 1 ? 'file' : 'files'}
        </button>
      )}
      {result?.note && <Note>{result.note}</Note>}
    </>
  );
}
