// Tool cards, diffs, highlighting and transcript reuse (Task 7 / 10 libraries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseContext, countChanges, diffLines, editDiff, splitLines, statusLetter } from '../src/lib/diff.js';
import { escapeHtml, highlight, highlightLines, languageForPath, resolveLanguage, splitHighlightedLines } from '../src/lib/highlight.js';
import { share, shareMessages } from '../src/lib/share.js';
import { todoProgress, todosVisible } from '../src/lib/todos.js';
import {
  agentReport,
  contentBlocksText,
  isAsyncAgentLaunch,
  parseAnswers,
  parseNumberedLines,
  parseSearchOutput,
  parseWebSearch,
  prettyJson,
  readKind,
  stripAnsi,
  stripReminders,
  unwrapToolError,
  writeOutcome,
} from '../src/lib/toolOutput.js';
import { artifactLink, artifactTitle, currentStep, groupSummary, isPublishedArtifact, runningLabel, searchScope, toolSummary, truncatePath } from '../src/lib/tools.js';
import { activityTools, buildEntries, currentTool, liveEntries } from '../src/lib/transcript.js';
import { mergeSession } from '../src/store.js';

const rowsOf = (rows) => rows.map((r) => (r.type === 'skip' ? `~${r.count}` : `${{ context: ' ', add: '+', del: '-' }[r.type]}${r.text}`));

test('diffLines: additions, removals and context', () => {
  const rows = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(rowsOf(rows), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.deepEqual(countChanges(rows), { adds: 2, dels: 1 });
  // Line numbers follow each side.
  assert.deepEqual(rows.map((r) => [r.oldNo, r.newNo]), [[1, 1], [2, null], [null, 2], [3, 3], [4, 4], [null, 5]]);
});

test('diffLines: identical, empty and one-sided inputs', () => {
  assert.deepEqual(rowsOf(diffLines('x\ny', 'x\ny')), [' x', ' y']);
  assert.deepEqual(diffLines('', ''), []);
  assert.deepEqual(rowsOf(diffLines('', 'new\nlines')), ['+new', '+lines']);
  assert.deepEqual(rowsOf(diffLines('gone\n', '')), ['-gone']);
  // A trailing newline does not add an empty line.
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
});

test('diffLines: separate changes far apart keep the context between them', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].join('\n');
  const after = ['one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'ELEVEN', 'twelve'].join('\n');
  const rows = diffLines(before, after);
  assert.deepEqual(countChanges(rows), { adds: 2, dels: 2 });
  assert.deepEqual(rowsOf(collapseContext(rows, 2)), [' one', '-two', '+TWO', ' three', ' four', '~4', ' nine', ' ten', '-eleven', '+ELEVEN', ' twelve']);
  // Moves are a delete and an insert, and the result is minimal.
  assert.deepEqual(rowsOf(diffLines('a\nb\nc', 'c\na\nb')), ['+c', ' a', ' b', '-c']);
});

test('diffLines: large rewrites finish fast as one delete/add block', () => {
  const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n');
  for (const size of [2000, 4000]) {
    const start = performance.now();
    const rows = diffLines(lines('old', size), lines('new', size));
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 500, `${size} lines took ${elapsed.toFixed(0)} ms`);
    assert.equal(rows.length, 2 * size);
    assert.deepEqual(countChanges(rows), { adds: size, dels: size });
    assert.ok(rows.slice(0, size).every((row) => row.type === 'del') && rows.slice(size).every((row) => row.type === 'add'));
    assert.deepEqual([rows[0].oldNo, rows[size].newNo, rows.at(-1).newNo], [1, 1, size]);
  }
  // Interleaved changes: a real diff while it needs at most 1000 edits, then a block.
  const base = Array.from({ length: 1200 }, (_, i) => `line ${i}`);
  const some = base.map((line, i) => (i % 3 === 1 ? line + ' changed' : line));
  const someRows = diffLines(base.join('\n'), some.join('\n'));
  assert.deepEqual(countChanges(someRows), { adds: 400, dels: 400 });
  assert.equal(someRows.filter((row) => row.type === 'context').length, 800);
  const many = base.map((line, i) => (i % 2 === 1 ? line + ' changed' : line));
  const manyRows = diffLines(base.join('\n'), many.join('\n'));
  assert.deepEqual(countChanges(manyRows), { adds: 1199, dels: 1199 }, 'past 1000 edits: one block between the common head and tail');
  assert.deepEqual(rowsOf(manyRows.slice(0, 2)), [' line 0', '-line 1']);
});

test('editDiff: one hunk per MultiEdit edit, cached per input', () => {
  const input = {
    file_path: '/repo/a.js',
    edits: [
      { old_string: 'const a = 1;', new_string: 'const a = 2;' },
      { old_string: 'x()', new_string: 'x()\ny()', replace_all: true },
    ],
  };
  const result = editDiff(input);
  assert.equal(result.hunks.length, 2);
  assert.deepEqual(rowsOf(result.hunks[1].rows), [' x()', '+y()']);
  assert.equal(result.hunks[1].replaceAll, true);
  assert.deepEqual([result.adds, result.dels], [2, 1]);
  assert.equal(editDiff(input), result);
});

test('statusLetter maps porcelain codes and words', () => {
  assert.equal(statusLetter('M'), 'M');
  assert.equal(statusLetter(' M'), 'M');
  assert.equal(statusLetter('??'), 'U');
  assert.equal(statusLetter('added'), 'A');
  assert.equal(statusLetter('deleted'), 'D');
  assert.equal(statusLetter('renamed'), 'R');
  assert.equal(statusLetter(''), 'M');
});

test('parseNumberedLines reads both cat -n styles and drops reminders', () => {
  assert.deepEqual(parseNumberedLines('    40→const a = 1;\n    41→\n    42→  return a;'), { startLine: 40, lines: ['const a = 1;', '', '  return a;'] });
  assert.deepEqual(parseNumberedLines('1\t# Title\n2\t\n3\tbody\n\n<system-reminder>\nWhenever you read a file…\n</system-reminder>'), {
    startLine: 1,
    lines: ['# Title', '', 'body'],
  });
  assert.equal(parseNumberedLines('File does not exist.'), null);
  assert.equal(parseNumberedLines(''), null);
  assert.equal(stripReminders('x\n<system-reminder>hi</system-reminder>\n'), 'x');
});

test('stripAnsi removes colors, OSC links and carriage-return overwrites', () => {
  assert.equal(stripAnsi('\x1b[32mok\x1b[0m 1 passed'), 'ok 1 passed');
  assert.equal(stripAnsi('\x1b]8;;https://x.dev\x07link\x1b]8;;\x07'), 'link');
  assert.equal(stripAnsi('progress 10%\rprogress 50%\rprogress 100%\ndone'), 'progress 100%\ndone');
  assert.equal(stripAnsi('\x1b[2K\x1b[1Gline'), 'line');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('toolSummary verbs and targets', () => {
  const cwd = '/repo';
  const pick = ({ verb, target }) => ({ verb, target });
  assert.deepEqual(pick(toolSummary({ tool: 'Read', state: 'done', input: { file_path: '/repo/server/runner.mjs', offset: 40, limit: 81 } }, cwd)), {
    verb: 'Read',
    target: 'server/runner.mjs:40-120',
  });
  assert.deepEqual(pick(toolSummary({ tool: 'Bash', state: 'running', input: { command: 'npm test\necho done' } }, cwd)), { verb: 'Running', target: 'npm test' });
  const edit = toolSummary({ tool: 'Edit', state: 'done', input: { file_path: '/repo/src/app.jsx', old_string: 'a\nb\nc', new_string: 'a\nx' } }, cwd);
  assert.deepEqual([edit.verb, edit.target, edit.path], ['Edited', 'src/app.jsx', true]);
  assert.deepEqual(edit.stats, { adds: 1, dels: 2 });
  assert.deepEqual(toolSummary({ tool: 'Write', state: 'done', input: { file_path: '/repo/n.py', content: 'a\nb\n' } }, cwd).stats, { adds: 2, dels: 0 });
  assert.equal(toolSummary({ tool: 'mcp__comet__list_projects', state: 'done', input: {} }).verb, 'comet · list_projects');
  assert.equal(toolSummary({ tool: 'mcp__comet__list_projects', state: 'done', input: {} }).kind, 'plug');
  assert.equal(toolSummary({ tool: 'Grep', state: 'done', input: { pattern: 'foo', path: '/repo/src' } }, cwd).target, 'foo in src');
  assert.equal(toolSummary({ tool: 'Agent', state: 'running', input: { description: 'Explore tests', prompt: 'x' } }, cwd).verb, 'Running agent');
  assert.equal(toolSummary({ tool: 'TodoWrite', state: 'done', input: { todos: [{ content: 'a', status: 'in_progress', activeForm: 'Doing a' }] } }).target, 'Doing a');
  assert.equal(toolSummary({ tool: 'SomethingNew', state: 'done', input: { query: 'q' } }).verb, 'SomethingNew');
  assert.equal(runningLabel({ tool: 'Read', state: 'done', input: { file_path: '/repo/a.js' } }, cwd), 'Reading a.js');
});

test('toolSummary targets drop noise: project root, URL scheme, markdown, unknown tools', () => {
  const cwd = '/repo';
  const target = (message) => toolSummary({ state: 'done', ...message }, cwd).target;
  assert.equal(target({ tool: 'Grep', input: { pattern: 'foo', path: '/repo' } }), 'foo');
  assert.equal(target({ tool: 'Grep', input: { pattern: 'foo', path: '/repo', glob: '*.mjs' } }), 'foo in *.mjs');
  assert.equal(target({ tool: 'Glob', input: { pattern: '**/*.js', path: '/elsewhere' } }), '**/*.js in /elsewhere');
  assert.equal(searchScope('/repo', cwd), '');
  assert.equal(searchScope('/repo/src', cwd), 'src');
  assert.equal(target({ tool: 'WebFetch', input: { url: 'https://preactjs.com/guide/v10/hooks/' } }), 'preactjs.com/guide/v10/hooks/');
  assert.equal(target({ tool: 'ExitPlanMode', input: { plan: '## Plan: split `server.mjs` into **modules**\n\n1. x' } }), 'Plan: split server.mjs into modules');
  assert.equal(target({ tool: 'CronCreate', input: { schedule: '*/30 * * * *', prompt: 'Check' } }), '*/30 * * * *');
});

test('truncatePath keeps the tail of long paths', () => {
  assert.equal(truncatePath('src/app.js', 30), 'src/app.js');
  const long = 'packages/mvecset/src/mvecset/model/vae_mvecset/conv_voxset.py:1260-1469';
  const short = truncatePath(long, 40);
  assert.ok(short.length <= 40, short);
  assert.ok(short.startsWith('…/'), short);
  assert.ok(short.endsWith('conv_voxset.py:1260-1469'), short);
  // A single huge segment is cut from the start.
  assert.equal(truncatePath('x'.repeat(50), 10), '…' + 'x'.repeat(9));
  // Long paths in tool rows are shortened.
  const row = toolSummary({ tool: 'Read', state: 'done', input: { file_path: '/elsewhere/' + 'deep/'.repeat(20) + 'file.py' } }, '/repo');
  assert.ok(row.target.startsWith('…/') && row.target.endsWith('/file.py'), row.target);
});

test('groupSummary reads naturally', () => {
  const tools = [
    { id: '1', tool: 'Read', input: { file_path: '/a' } },
    { id: '2', tool: 'Read', input: { file_path: '/b' } },
    { id: '3', tool: 'Read', input: { file_path: '/a' } },
    { id: '4', tool: 'Bash', input: { command: 'ls' } },
    { id: '5', tool: 'Bash', input: { command: 'pwd' } },
    { id: '6', tool: 'Edit', input: { file_path: '/a' } },
    { id: '7', tool: 'Grep', input: { pattern: 'x' } },
    { id: '8', tool: 'mcp__srv__tool', input: {} },
  ];
  assert.equal(groupSummary(tools), 'Read 2 files, edited 1 file, ran 2 commands, ran 1 search, used 1 tool');
  assert.equal(groupSummary([{ id: 'w', tool: 'WebSearch', input: {} }, { id: 'a', tool: 'Agent', input: {} }]), 'Ran 1 web search, ran 1 agent');
  // Harbor's web search for gateway models counts as a web search.
  assert.equal(groupSummary([{ id: 'w', tool: 'WebSearch', input: {} }, { id: 'h', tool: 'mcp__meshy__web_search', input: {} }]), 'Ran 2 web searches');
  const harbor = toolSummary({ tool: 'mcp__meshy__web_search', state: 'running', input: { query: 'claude agent sdk' } }, '/repo');
  assert.deepEqual([harbor.verb, harbor.target, harbor.kind, harbor.mono], ['Searching the web', 'claude agent sdk', 'web', false]);
  assert.equal(groupSummary([{ id: 't', tool: 'TodoWrite', input: {} }]), 'Updated tasks');
  assert.equal(groupSummary([]), 'No steps');
});

test('Codex tools in imported sessions read as steps, not raw names', () => {
  const summary = (tool, input) => {
    const { verb, target } = toolSummary({ tool, state: 'done', input }, '/repo');
    return { verb, target };
  };
  assert.deepEqual(summary('exec', { code: 'const r = await tools.mcp__codex_apps__github_search({q: 1});\ntext(await tools.exec_command({cmd: "ls"}));\ntext(r);' }), { verb: 'Ran script', target: 'github_search, exec_command' });
  assert.deepEqual(summary('sleep', { duration_ms: 30000 }), { verb: 'Waited', target: '30 s' });
  assert.deepEqual(summary('wait', { cell_id: '4', yield_time_ms: 30000 }), { verb: 'Waited', target: '30 s' });
  assert.deepEqual(summary('spawn_agent', { task_name: 'seed_runtime', message: '[Encrypted]' }), { verb: 'Started agent', target: 'seed_runtime' });
  assert.deepEqual(summary('send_message', { target: '/root/seed_runtime', message: '[Encrypted]' }), { verb: 'Messaged agent', target: 'seed_runtime' });
  assert.deepEqual(summary('followup_task', { target: 'render_path', message: '[Encrypted]' }), { verb: 'Assigned agent', target: 'render_path' });
  assert.deepEqual(summary('wait_agent', { timeout_ms: 10000 }), { verb: 'Waited for agents', target: '10 s' });
  assert.deepEqual(summary('SendMessage', { to: 'a9d50f639409e06f1', summary: 'Add the overlap criterion', message: 'New requirement…' }), { verb: 'Messaged agent', target: 'Add the overlap criterion' });
  assert.deepEqual(summary('SendMessage', { to: 'a9d50f639409e06f1', message: 'Stop after the audit.\nThanks' }), { verb: 'Messaged agent', target: 'Stop after the audit.' });
  const tools = [
    { id: '1', tool: 'Bash', input: { command: 'ls' } },
    { id: '2', tool: 'exec', input: { code: 'x' } },
    { id: '3', tool: 'spawn_agent', input: {} },
    { id: '4', tool: 'send_message', input: {} },
    { id: '5', tool: 'send_message', input: {} },
    { id: '6', tool: 'sleep', input: {} },
    { id: '7', tool: 'wait_agent', input: {} },
  ];
  assert.equal(groupSummary(tools), 'Ran 1 command, ran 1 script, ran 1 agent, sent 2 agent messages, waited');
});

test('search output: file lists, content lines and counts', () => {
  const files = parseSearchOutput('Found 2 files\n/repo/src/a.js\n/repo/src/b.js', { cwd: '/repo' });
  assert.equal(files.header, 'Found 2 files');
  assert.deepEqual(files.items.map((i) => [i.path, i.line]), [['src/a.js', null], ['src/b.js', null]]);
  const content = parseSearchOutput('/repo/src/a.js:12:const foo = 1;\n/repo/src/a.js-13-  next\n--\nsrc/b.js:3:foo()', { cwd: '/repo' });
  assert.deepEqual(content.items.map((i) => [i.path, i.line, i.text, i.context]), [
    ['src/a.js', 12, 'const foo = 1;', false],
    ['src/a.js', 13, '  next', true],
    ['src/b.js', 3, 'foo()', false],
  ]);
  const single = parseSearchOutput('4:import x\n9:x()', { cwd: '/repo', file: '/repo/one.js' });
  assert.deepEqual(single.items.map((i) => [i.path, i.line]), [['one.js', 4], ['one.js', 9]]);
  const counts = parseSearchOutput('src/a.js:3\nsrc/b.js:1', { cwd: '/repo' });
  assert.deepEqual(counts.items.map((i) => i.text), ['3 matches', '1 match']);
  const glob = parseSearchOutput('/repo/a.mjs\n/repo/tests/b.test.mjs\n(Results are truncated. Consider using a more specific path or pattern.)', { cwd: '/repo', tool: 'Glob' });
  assert.deepEqual(glob.items.map((i) => i.path), ['a.mjs', 'tests/b.test.mjs']);
  assert.match(glob.note, /Results are truncated/);
  assert.deepEqual(parseSearchOutput('No files found', { tool: 'Glob' }).items, []);
});

test('parseSearchOutput: dated and hyphenated file names in content mode', () => {
  const plan = '/repo/docs/plans/2026-10-05-workbench-v2-api.md';
  const output = [
    // Context before the file's first match: split after the path seen on a match line.
    `${plan}-11-## Sessions`,
    `${plan}:12:GET /api/sessions/:id/changes`,
    `${plan}-13-Returns {diff, status}`,
    '--',
    '/repo/src/my-file-2.js:7:const x = 1;',
    '/repo/src/my-file-2.js-8-const y = 2;',
    // A log whose context line holds a time (`12:30:45`) is still a context line.
    '/repo/logs/run-2026-10-05.log:40:ERROR boom',
    '/repo/logs/run-2026-10-05.log-41-12:30:45 retry',
  ].join('\n');
  const result = parseSearchOutput(output, { cwd: '/repo' });
  assert.deepEqual(result.items.map((i) => [i.path, i.line, i.text, i.context]), [
    ['docs/plans/2026-10-05-workbench-v2-api.md', 11, '## Sessions', true],
    ['docs/plans/2026-10-05-workbench-v2-api.md', 12, 'GET /api/sessions/:id/changes', false],
    ['docs/plans/2026-10-05-workbench-v2-api.md', 13, 'Returns {diff, status}', true],
    ['src/my-file-2.js', 7, 'const x = 1;', false],
    ['src/my-file-2.js', 8, 'const y = 2;', true],
    ['logs/run-2026-10-05.log', 40, 'ERROR boom', false],
    ['logs/run-2026-10-05.log', 41, '12:30:45 retry', true],
  ]);
  assert.equal(result.note, '');
  // Context lines of a file with no match line fall back to the shortest split.
  const orphan = parseSearchOutput('src/a.js-3-x', { cwd: '/repo' });
  assert.deepEqual(orphan.items.map((i) => [i.path, i.line, i.text, i.context]), [['src/a.js', 3, 'x', true]]);
  // A dated name in count mode.
  const counts = parseSearchOutput('docs/2026-10-05-notes.md:4', { cwd: '/repo' });
  assert.deepEqual(counts.items.map((i) => [i.path, i.text]), [['docs/2026-10-05-notes.md', '4 matches']]);
});

test('content blocks, agent reports, web search, answers and write outcome', () => {
  assert.equal(contentBlocksText('[{"type":"text","text":"a"},{"type":"image","source":{}}]'), 'a\n[Image]');
  assert.equal(contentBlocksText('[1, 2]'), null);
  assert.equal(contentBlocksText('plain'), null);
  const v1 = JSON.stringify([{ type: 'text', text: '[Subagent hand-back] Frame text. The report follows:\n  ## Summary\n  - item\n\nagentId: abc123 (use to resume)' }]);
  assert.equal(agentReport(v1), '## Summary\n- item');
  assert.equal(agentReport('Plain report'), 'Plain report');
  const search = parseWebSearch('Web search results for query: "preact memo"\n\nLinks: [{"title":"Preact docs","url":"https://preactjs.com/guide"}]\n\nSome summary.\n\nREMINDER: You MUST include the sources');
  assert.deepEqual(search.links, [{ title: 'Preact docs', url: 'https://preactjs.com/guide' }]);
  assert.equal(search.text, 'Some summary.');
  assert.deepEqual(parseAnswers({}, 'User has answered your questions: "When?"="Tonight", "Where?"="Lisbon". You can now continue.'), [
    { question: 'When?', answer: 'Tonight' },
    { question: 'Where?', answer: 'Lisbon' },
  ]);
  assert.deepEqual(parseAnswers({ answers: { 'When?': 'Now' } }, ''), [{ question: 'When?', answer: 'Now' }]);
  assert.equal(writeOutcome('File created successfully at: /a.py'), 'created');
  assert.equal(writeOutcome('The file /a.py has been updated successfully.'), 'overwrote');
  assert.equal(writeOutcome('Error'), null);
  assert.equal(readKind('/x/shot.PNG', ''), 'image');
  assert.equal(readKind('/x/paper.pdf', ''), 'pdf');
  assert.equal(readKind('/x/a.py', '1\tx'), null);
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson('nope'), null);
});

test('truncated content blocks, tool errors and background agent launches', () => {
  const full = JSON.stringify([{ type: 'text', text: '[Subagent hand-back] Frame. The report follows:\n  ## Report\n  Line "quoted" \u00e9 and more text' }]);
  assert.equal(agentReport(full), '## Report\nLine "quoted" \u00e9 and more text');
  // Pushed copies are cut mid-string: decode what is there instead of showing raw JSON.
  assert.equal(agentReport(full.slice(0, full.indexOf('and more'))), '## Report\nLine "quoted" \u00e9');
  assert.equal(contentBlocksText('[{"type":"text","text":"half \\u00'), 'half ');
  assert.equal(contentBlocksText('[1, 2'), null);
  assert.equal(unwrapToolError('<tool_use_error>File does not exist.</tool_use_error>'), 'File does not exist.');
  assert.equal(unwrapToolError('Exit code 1\nboom'), 'Exit code 1\nboom');
  // A truncated copy lost the closing tag.
  assert.equal(unwrapToolError('<tool_use_error>String to replace not found in file.\nString: const a'), 'String to replace not found in file.\nString: const a');
  assert.equal(unwrapToolError('<tool_use_error>Long error\n[Output truncated]'), 'Long error\n[Output truncated]');
  assert.equal(unwrapToolError('<tool_use_error>Denied</tool_use_error>\n<system-reminder>for the model</system-reminder>'), 'Denied');
  assert.equal(unwrapToolError(''), '');
  assert.equal(isAsyncAgentLaunch('Async agent launched successfully. agentId: a1'), true);
  assert.equal(isAsyncAgentLaunch(JSON.stringify([{ type: 'text', text: 'Async agent launched successfully.' }])), true);
  assert.equal(isAsyncAgentLaunch('## Report'), false);
});

test('todo progress and strip visibility', () => {
  const todos = [
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
    { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
  ];
  assert.deepEqual(todoProgress(todos), { total: 3, completed: 1, active: todos[1], current: 'Writing tests' });
  assert.equal(todoProgress([{ content: 'Next', status: 'pending' }]).current, 'Next');
  assert.equal(todoProgress(null).total, 0);

  const done = todos.map((t) => ({ ...t, status: 'completed' }));
  const messages = [
    { id: 'u1', role: 'user', delivery: 'done' },
    { id: 't1', role: 'tool', tool: 'TodoWrite', state: 'done' },
  ];
  assert.equal(todosVisible({ todos, messages }), true);
  assert.equal(todosVisible({ todos: [], messages }), false);
  // All done: visible through the turn that finished them…
  assert.equal(todosVisible({ todos: done, messages }), true);
  // …and a queued follow-up does not count as a new turn yet…
  assert.equal(todosVisible({ todos: done, messages: [...messages, { id: 'q', role: 'user', delivery: 'queued' }] }), true);
  assert.equal(todosVisible({ todos: done, messages: [...messages, { id: 's', role: 'user', delivery: 'sent' }] }), true);
  // …but hidden once the next turn starts.
  assert.equal(todosVisible({ todos: done, messages: [...messages, { id: 'u2', role: 'user', delivery: 'running' }] }), false);
});

test('highlight: languages, escaping and per-line splitting', () => {
  assert.equal(resolveLanguage('JS'), 'javascript');
  assert.equal(resolveLanguage('sh'), 'bash');
  assert.equal(resolveLanguage('toml'), 'ini');
  assert.equal(resolveLanguage('cobol'), null);
  assert.equal(languageForPath('src/app.jsx'), 'javascript');
  assert.equal(languageForPath('/x/Dockerfile'), 'dockerfile');
  assert.equal(languageForPath('pyproject.toml'), 'ini');
  assert.equal(languageForPath('train.sbatch'), 'bash');
  assert.equal(languageForPath('README'), null);

  const html = highlight('const a = "<b>";', 'js');
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.ok(html.includes('&lt;b&gt;') && !html.includes('<b>'));
  assert.equal(highlight('<i>x</i>', 'not-a-language'), escapeHtml('<i>x</i>'));
  assert.equal(highlight('a', null), 'a');

  // A multi-line comment's span is closed and reopened on every line.
  const lines = highlightLines('/* one\ntwo */\nx = 1', 'javascript');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^<span class="hljs-comment">\/\* one<\/span>$/);
  assert.match(lines[1], /^<span class="hljs-comment">two \*\/<\/span>$/);
  assert.deepEqual(splitHighlightedLines('a\n<span class="x">b\nc</span>\nd'), ['a', '<span class="x">b</span>', '<span class="x">c</span>', 'd']);
});

test('share keeps identity for equal data and copies only what changed', () => {
  const previous = { a: { x: 1 }, b: [1, { y: 2 }], c: 'same' };
  assert.equal(share(previous, JSON.parse(JSON.stringify(previous))), previous);
  const next = share(previous, { a: { x: 1 }, b: [1, { y: 3 }], c: 'same' });
  assert.notEqual(next, previous);
  assert.equal(next.a, previous.a);
  assert.notEqual(next.b, previous.b);
  assert.equal(share(previous, { ...previous, d: undefined }) === previous, false);

  const list = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }];
  assert.equal(shareMessages(list, JSON.parse(JSON.stringify(list))), list);
  const grown = shareMessages(list, [...JSON.parse(JSON.stringify(list)), { id: 'c', text: 'three' }]);
  assert.equal(grown[0], list[0]);
  assert.equal(grown[1], list[1]);
  const changed = shareMessages(list, [{ id: 'a', text: 'one' }, { id: 'b', text: 'TWO' }]);
  assert.equal(changed[0], list[0]);
  assert.notEqual(changed[1], list[1]);
});

test('mergeSession: a fresh copy of the open session reuses unchanged messages', () => {
  const current = { id: 's', updatedAt: 1, todos: [{ content: 'a', status: 'pending' }], messages: [{ id: 'm1', role: 'user', text: 'hi' }] };
  const fresh = JSON.parse(JSON.stringify({ ...current, updatedAt: 2 }));
  const merged = mergeSession(current, fresh);
  assert.equal(merged.messages, current.messages);
  assert.equal(merged.todos, current.todos);
  assert.equal(merged.updatedAt, 2);
  assert.equal(mergeSession({ id: 'other' }, fresh), fresh);
});

const tool = (id, extra = {}) => ({ id, role: 'tool', tool: 'Read', toolId: id.toUpperCase(), state: 'done', input: { file_path: '/r/' + id }, at: 10, ...extra });

test('buildEntries: thinking before a tool joins its group, otherwise stands alone', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'go', at: 1000, delivery: 'done' },
    { id: 'th1', role: 'thinking', text: 'plan', at: 4000 },
    tool('t1', { at: 5000, endedAt: 6000 }),
    { id: 'th2', role: 'thinking', text: 'more', at: 10000 },
    tool('t2', { at: 10500, endedAt: 11000 }),
    { id: 'th3', role: 'thinking', text: 'wrap up', at: 13000 },
    { id: 'a1', role: 'assistant', text: 'Done', at: 14000 },
  ];
  const { entries } = buildEntries(messages);
  assert.deepEqual(entries.map((e) => e.type), ['user', 'activity', 'thinking', 'assistant']);
  const group = entries[1];
  assert.equal(group.key, 'activity-th1');
  assert.deepEqual(group.items.map((n) => n.kind), ['thinking', 'tool', 'thinking', 'tool']);
  assert.deepEqual(activityTools(group).map((m) => m.id), ['t1', 't2']);
});

// `at` is stamped when a block arrives (finished), so thinking lasts from the end
// of whatever came before it in the same scope.
test('buildEntries: thinking duration runs from the previous message to the thinking block', () => {
  const messages = [
    { id: 'u0', role: 'user', text: 'earlier', at: 100, startedAt: 100, delivery: 'done' },
    { id: 'a0', role: 'assistant', text: 'ok', at: 200 },
    { id: 'f0', role: 'turn', at: 300 },
    // Sent at 1000, started running at 1500 (it waited in the queue).
    { id: 'u1', role: 'user', text: 'go', at: 1000, startedAt: 1500, delivery: 'done' },
    { id: 'th1', role: 'thinking', text: 'plan', at: 4500 },
    tool('t1', { at: 5000, endedAt: 6000 }),
    // A message queued mid-turn is not part of the timeline.
    { id: 'u2', role: 'user', text: 'later', at: 7000, delivery: 'queued' },
    { id: 'th2', role: 'thinking', text: 'more', at: 10000 },
    tool('t2', { at: 10500, endedAt: 11000 }),
    { id: 'th3', role: 'thinking', text: 'and more', at: 11250 },
    { id: 'th4', role: 'thinking', text: 'wrap up', at: 13000 },
    { id: 'a1', role: 'assistant', text: 'Done', at: 14000 },
    { id: 'th5', role: 'thinking', text: 'no time', at: 15000 },
    { id: 'th6', role: 'thinking', text: 'no stamp' },
  ];
  const { entries } = buildEntries(messages);
  const durations = {};
  for (const entry of entries) {
    if (entry.type === 'thinking') durations[entry.message.id] = entry.duration;
    for (const node of entry.items || []) if (node.kind === 'thinking') durations[node.message.id] = node.duration;
  }
  assert.deepEqual(durations, { th1: 3000, th2: 4000, th3: 250, th4: 1750, th5: 1000, th6: null });

  // Without startedAt (v1 data) the turn starts at the user message's `at`.
  const v1 = buildEntries([{ id: 'u', role: 'user', text: 'go', at: 1000 }, { id: 'th', role: 'thinking', text: 'x', at: 3000 }, { id: 'a', role: 'assistant', text: 'y', at: 4000 }]);
  assert.equal(v1.entries[1].duration, 2000);
});

test('buildEntries: subagent thinking is timed within the subagent', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'go', at: 1000, startedAt: 1000, delivery: 'done' },
    { id: 'ag', role: 'tool', tool: 'Agent', toolId: 'AG', state: 'done', input: { run_in_background: true }, at: 2000, endedAt: 2100 },
    { id: 'c1', role: 'thinking', text: 'sub plan', parentToolId: 'AG', at: 5000 },
    { id: 'c2', role: 'tool', tool: 'Read', toolId: 'C2', parentToolId: 'AG', state: 'done', input: {}, at: 5500, endedAt: 6000 },
    // Top-level thinking while the background subagent runs.
    { id: 'top', role: 'thinking', text: 'meanwhile', at: 7000 },
    { id: 'c3', role: 'thinking', text: 'sub more', parentToolId: 'AG', at: 9000 },
    { id: 'c4', role: 'assistant', text: 'report', parentToolId: 'AG', at: 9500 },
    { id: 'bash', role: 'tool', tool: 'Bash', toolId: 'B', state: 'done', input: {}, at: 10000, endedAt: 30000 },
    // A block that finished while the previous call was still running counts from the call.
    { id: 'late', role: 'thinking', text: 'odd order', at: 12000 },
    { id: 'a1', role: 'assistant', text: 'Done', at: 31000 },
  ];
  const { entries } = buildEntries(messages);
  const agent = entries[1].items.find((n) => n.message.id === 'ag');
  assert.deepEqual(agent.children.map((n) => [n.message.id, n.duration ?? null]), [['c1', 3000], ['c2', null], ['c3', 3000], ['c4', null]]);
  const thinking = (id) => [...entries, ...entries.flatMap((e) => e.items || [])].find((n) => n.message?.id === id);
  assert.equal(thinking('top').duration, 4900);
  assert.equal(thinking('late').duration, 2000);
});

test('buildEntries: subagent children nest recursively under their Agent call', () => {
  const messages = [
    { id: 'ag', role: 'tool', tool: 'Agent', toolId: 'AG', state: 'running', input: { description: 'explore' }, at: 1 },
    { id: 'c1', role: 'tool', tool: 'Read', toolId: 'C1', parentToolId: 'AG', state: 'done', input: {}, at: 2 },
    { id: 'c2', role: 'assistant', text: 'found it', parentToolId: 'AG', at: 3 },
    { id: 'inner', role: 'tool', tool: 'Agent', toolId: 'IN', parentToolId: 'AG', state: 'running', input: {}, at: 4 },
    { id: 'c3', role: 'tool', tool: 'Grep', toolId: 'C3', parentToolId: 'IN', state: 'running', input: {}, at: 5 },
    { id: 'self', role: 'tool', tool: 'Read', toolId: 'SELF', parentToolId: 'SELF', state: 'done', input: {}, at: 6 },
  ];
  const { entries, runningTool } = buildEntries(messages);
  assert.equal(entries.length, 1);
  const [agent] = entries[0].items;
  assert.deepEqual(agent.children.map((n) => [n.kind, n.message.id]), [['tool', 'c1'], ['text', 'c2'], ['tool', 'inner']]);
  assert.deepEqual(agent.children[2].children.map((n) => n.message.id), ['c3']);
  assert.equal(runningTool.id, 'ag');
  assert.equal(currentTool(entries[0]).id, 'ag');
});

test('buildEntries reuses unchanged entries so only changed rows re-render', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'go', at: 1, delivery: 'done' },
    tool('t1'),
    tool('t2', { state: 'running' }),
    { id: 'a1', role: 'assistant', text: 'Working on it', at: 3 },
    { id: 'u2', role: 'user', text: 'next', at: 4, delivery: 'running' },
    tool('t3', { state: 'running' }),
  ];
  const first = buildEntries(messages);
  // Same content delivered as fresh objects (an SSE session event), with one change.
  const fresh = JSON.parse(JSON.stringify(messages));
  fresh[5].state = 'done';
  const shared = shareMessages(messages, fresh);
  const second = buildEntries(shared, first);
  const changed = second.entries.filter((entry, i) => entry !== first.entries[i]).map((e) => e.key);
  assert.deepEqual(changed, ['activity-t3']);
  // Nodes inside a changed group are reused too.
  const third = buildEntries(shareMessages(shared, [...JSON.parse(JSON.stringify(fresh)), tool('t4')]), second);
  const group = third.entries.at(-1);
  assert.equal(group.items[0], second.entries.at(-1).items[0]);
  assert.equal(group.items.length, 2);
});

test('liveEntries: working row for thinking time or waiting, not for a running tool', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'go', at: 100, startedAt: 150, delivery: 'running' },
    tool('t1', { state: 'running', tool: 'Bash', at: 200, elapsed: 12 }),
  ];
  const base = buildEntries(messages);
  // The running command already shows in its row (and group header).
  assert.deepEqual(liveEntries({ status: 'running', currentMessageId: 'u1', messages }, base), []);
  // While it waits for an approval the working row says so.
  const [approval] = liveEntries({ status: 'waiting', currentMessageId: 'u1', messages, pending: [{ at: 300 }] }, base);
  assert.deepEqual([approval.type, approval.waiting, approval.tool, approval.toolAt, approval.toolElapsed, approval.startedAt], ['working', true, 'Bash', 200, 12, 150]);
  // A running tool in an earlier group (the turn has moved on) does not hide it.
  const later = [...messages, { id: 'a1', role: 'assistant', text: 'meanwhile', at: 300 }];
  const [still] = liveEntries({ status: 'running', currentMessageId: 'u1', messages: later }, buildEntries(later));
  assert.equal(still.type, 'working');

  const idleMessages = [messages[0], { ...messages[1], state: 'done', endedAt: 400 }];
  const idleBase = buildEntries(idleMessages);
  const [thinking] = liveEntries({ status: 'running', currentMessageId: 'u1', messages: idleMessages }, idleBase);
  assert.deepEqual([thinking.tool, thinking.since], [null, 400]);

  const [waiting] = liveEntries({ status: 'waiting', currentMessageId: 'u1', messages: idleMessages, pending: [{ at: 500 }] }, idleBase);
  assert.deepEqual([waiting.waiting, waiting.since], [true, 500]);
});

test('currentStep: the newest running main-thread tool, not a subagent or a background agent', () => {
  const bash = { id: 'b', role: 'tool', tool: 'Bash', state: 'running', input: { command: 'sleep 60' } };
  const inner = { id: 'i', role: 'tool', tool: 'Read', state: 'running', parentToolId: 'agent' };
  const agent = { id: 'a', role: 'tool', tool: 'Agent', state: 'running', background: true };
  assert.equal(currentStep([bash, inner, agent]), bash);
  assert.equal(currentStep([{ ...bash, state: 'done' }, agent]), null);
  assert.equal(currentStep([]), null);
  assert.equal(currentStep(undefined), null);
});

test('artifacts: a published page is a card with its link and name; other actions are steps', () => {
  const url = 'https://claude.ai/code/artifact/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
  const published = {
    id: 't-art', toolId: 'toolu_art', role: 'tool', tool: 'Artifact', state: 'done',
    input: { file_path: '/home/me/reports/gpu-report.html', icon: 'chart', description: 'GPU memory by step.' },
    output: `Published "GPU report" to ${url} (private; only you can see it).`,
  };
  assert.equal(artifactLink(published), url);
  assert.equal(artifactTitle(published), 'gpu-report');
  assert.equal(artifactTitle({ ...published, input: { ...published.input, title: 'GPU report' } }), 'GPU report');
  assert.equal(isPublishedArtifact(published), true);
  assert.equal(toolSummary(published, '/home/me').verb, 'Published');
  assert.equal(toolSummary({ ...published, state: 'running', output: '' }, '/home/me').verb, 'Publishing');
  assert.equal(toolSummary({ ...published, input: { ...published.input, url } }, '/home/me').verb, 'Updated');

  // Not cards: still running, failed, uploads to the asset store, reads, lists.
  assert.equal(isPublishedArtifact({ ...published, state: 'running', output: '' }), false);
  assert.equal(isPublishedArtifact({ ...published, state: 'error' }), false);
  assert.equal(isPublishedArtifact({ ...published, input: { ...published.input, url, asset: true } }), false);
  const read = { ...published, id: 't-read', toolId: 'toolu_read', input: { action: 'read', url }, output: '<html>…</html>' };
  assert.equal(isPublishedArtifact(read), false);
  assert.equal(toolSummary(read, '/home/me').verb, 'Read artifact');
  assert.equal(artifactLink(read), url, 'the link it was given');
  assert.equal(toolSummary({ ...read, input: { action: 'list' } }, '/home/me').verb, 'Listed artifacts');
  assert.equal(groupSummary([read, { id: 'b', role: 'tool', tool: 'Bash', state: 'done', input: { command: 'ls' } }]), 'Ran 1 command, worked on artifacts');

  // In the transcript the card stands between the steps around it.
  const bash = (id) => ({ id, toolId: 'toolu_' + id, role: 'tool', tool: 'Bash', state: 'done', input: { command: 'ls' }, output: '' });
  const { entries } = buildEntries([{ id: 'u1', role: 'user', text: 'Chart it' }, bash('b1'), published, bash('b2'), { id: 'a1', role: 'assistant', text: 'Done.' }]);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ['user', 'activity', 'artifact', 'activity', 'assistant'],
  );
  assert.equal(entries[2].message, published);
});
