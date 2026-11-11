import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dateGroup, dirname, formatCost, formatDuration, formatTokens, relativePath, relativeTime } from '../src/lib/format.js';
import { availableModes, canonicalMode, isV2Info, modeLabel, wireMode } from '../src/lib/modes.js';
import { effectiveEffort, effortOptions, filterOpenRouterModels, findModel, groupModels, openRouterDescription, providerNote } from '../src/lib/models.js';
import { groupSessions, isBusy, recentProjects, sessionDot, upsertSession } from '../src/lib/sessions.js';
import { buildEntries, buildTranscript, liveEntries } from '../src/lib/transcript.js';
import { toolSummary } from '../src/lib/tools.js';
import { parseDiff } from '../src/lib/diff.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A fixed local "now": 2026-10-05 15:00 local time.
const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime();

test('dateGroup buckets by local calendar day', () => {
  assert.equal(dateGroup(NOW - HOUR, NOW), 'Today');
  assert.equal(dateGroup(new Date(2026, 9, 5, 0, 1).getTime(), NOW), 'Today');
  assert.equal(dateGroup(new Date(2026, 9, 4, 23, 59).getTime(), NOW), 'Yesterday');
  assert.equal(dateGroup(new Date(2026, 9, 4, 0, 0).getTime(), NOW), 'Yesterday');
  assert.equal(dateGroup(new Date(2026, 9, 3, 12).getTime(), NOW), 'Previous 7 days');
  assert.equal(dateGroup(new Date(2026, 8, 28, 12).getTime(), NOW), 'Previous 7 days');
  assert.equal(dateGroup(new Date(2026, 8, 20).getTime(), NOW), 'Earlier');
});

test('relativeTime and durations', () => {
  assert.equal(relativeTime(NOW - 10_000, NOW), 'Just now');
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(relativeTime(NOW - 3 * HOUR, NOW), '3h ago');
  assert.equal(formatDuration(41_400), '41s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(2 * HOUR + 60_000), '2h 1m');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(84_200), '84k');
  assert.equal(formatTokens(1_250_000), '1.3M');
  assert.equal(formatCost(0), '');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(1.234), '$1.23');
});

test('path helpers', () => {
  assert.equal(basename('/home/me/zenit-research'), 'zenit-research');
  assert.equal(basename('/home/me/repo/'), 'repo');
  assert.equal(basename(''), 'Workspace');
  assert.equal(basename(undefined, 'x'), 'x');
  assert.equal(dirname('src/lib/a.js'), 'src/lib');
  assert.equal(dirname('a.js'), '');
  assert.equal(relativePath('/repo/src/a.js', '/repo'), 'src/a.js');
  assert.equal(relativePath('/repo/src/a.js', '/repo/'), 'src/a.js');
  assert.equal(relativePath('/other/a.js', '/repo'), '/other/a.js');
  assert.equal(relativePath('/repo', '/repo'), '.');
});

test('mode names map between v1 and v2', () => {
  assert.equal(canonicalMode('yolo'), 'bypassPermissions');
  assert.equal(canonicalMode('ask'), 'default');
  assert.equal(canonicalMode('plan'), 'plan');
  assert.equal(canonicalMode('acceptEdits'), 'acceptEdits');
  assert.equal(modeLabel('yolo'), 'Bypass');
  assert.equal(modeLabel('bypassPermissions'), 'Bypass');
  assert.equal(modeLabel('ask'), 'Ask');
  assert.equal(modeLabel('default'), 'Ask');
  assert.equal(modeLabel('acceptEdits'), 'Accept edits');
  assert.equal(modeLabel('plan'), 'Plan');
  assert.equal(modeLabel('auto'), 'Auto');
  assert.equal(wireMode('bypassPermissions', false), 'yolo');
  assert.equal(wireMode('default', false), 'ask');
  assert.equal(wireMode('plan', false), 'plan');
  assert.equal(wireMode('acceptEdits', false), 'ask');
  assert.equal(wireMode('yolo', true), 'bypassPermissions');
  assert.equal(wireMode('acceptEdits', true), 'acceptEdits');
});

test('availableModes: v1 trio, v2 list filtered per model', () => {
  const v1 = availableModes({ models: [] }, null);
  assert.deepEqual(v1.map((m) => m.id), ['bypassPermissions', 'default', 'plan']);
  assert.equal(isV2Info({ models: [] }), false);
  const info = {
    modes: [
      { id: 'default', label: 'Ask', description: 'a' },
      { id: 'acceptEdits', label: 'Accept edits', description: 'b' },
      { id: 'plan', label: 'Plan', description: 'c' },
      { id: 'auto', label: 'Auto', description: 'd' },
      { id: 'bypassPermissions', label: 'Bypass', description: 'e' },
    ],
  };
  assert.equal(isV2Info(info), true);
  assert.equal(availableModes(info, { id: 'opus' }).length, 5);
  const luna = availableModes(info, { id: 'luna', modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] });
  assert.deepEqual(luna.map((m) => m.id), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  assert.equal(luna[0].description, 'a');
});

test('models: grouping, lookup, effort', () => {
  const models = [
    { id: 'opus', name: 'Claude Opus 5.5', provider: 'Claude', efforts: ['low', 'high'], defaultEffort: 'medium' },
    { id: 'astra', name: 'GPT-6 Astra', provider: 'OpenAI' },
    { id: 'deepseek', name: 'DeepSeek V4.1 Flash', provider: 'SGLang' },
    { id: 'deepseek', name: 'DeepSeek V4.1 Flash', provider: 'DeepSeek' },
  ];
  assert.deepEqual(groupModels(models).map((g) => [g.name, g.models.length]), [['Claude', 1], ['OpenAI', 1], ['Gateway', 2]]);
  assert.equal(findModel({ models }, 'astra').name, 'GPT-6 Astra');
  assert.equal(findModel({ models }, 'missing').name, 'missing');
  assert.equal(findModel(null, 'opus').provider, 'Claude');
  assert.deepEqual(effortOptions(models[0]), ['default', 'low', 'high']);
  assert.equal(effectiveEffort(models[0], 'default'), 'medium');
  assert.equal(effectiveEffort(models[0], 'high'), 'high');
});

test('models: OpenRouter group, or: ids with and without the fetched list, side menu search', () => {
  const modes = ['default', 'auto', 'plan'].map((id) => ({ id, label: id }));
  const kimi = { id: 'or:moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', vendor: 'MoonshotAI', contextWindow: 1_048_576, vision: true, reasoning: true, price: { in: 0.95, out: 4 } };
  const tiny = { id: 'or:acme/tiny', name: 'Tiny', vendor: 'Acme', contextWindow: 131_072, vision: false, reasoning: false, price: { in: 0.015, out: 0 } };
  const models = [
    { id: 'opus', name: 'Claude Opus 5.5', provider: 'Claude' },
    { id: 'argon', name: 'Gemini 4 Argon', provider: 'OpenRouter' },
    { id: 'kimi', name: 'Kimi K3', provider: 'SGLang' },
  ];
  assert.deepEqual(groupModels(models).map((g) => g.name), ['Claude', 'Gateway', 'OpenRouter']);
  assert.equal(providerNote(models[1]), 'Zero data retention');

  // Before the list is fetched: named after the id, a reasoning model, gateway modes.
  const bare = findModel({ models, modes }, 'or:acme/tiny');
  assert.deepEqual([bare.name, bare.provider, bare.efforts, bare.modes], ['tiny', 'OpenRouter', ['low', 'medium', 'high'], ['default', 'plan']]);
  const info = { models, modes, openrouterModels: [kimi, tiny] };
  const known = findModel(info, 'or:acme/tiny');
  assert.deepEqual([known.name, known.efforts, known.defaultEffort, known.contextWindow], ['Tiny', [], null, 131_072]);
  assert.equal(findModel(info, 'or:acme/tiny'), known, 'the same object between renders');
  assert.equal(findModel(info, 'or:moonshotai/kimi-k3.1-pro').contextWindow, 1_000_000);
  // `or:` alone is not an OpenRouter model.
  assert.equal(findModel(info, 'or:').provider, 'Claude');

  assert.equal(openRouterDescription(kimi), 'MoonshotAI · $0.95/$4 per M · 1.0M context');
  assert.equal(openRouterDescription(tiny), 'Acme · $0.015/$0 per M · 131k context');
  assert.equal(openRouterDescription({ ...tiny, price: { in: null, out: null } }), 'Acme · 131k context');
  assert.deepEqual(filterOpenRouterModels([kimi, tiny], 'moonshot pro').map((m) => m.id), [kimi.id]);
  assert.deepEqual(filterOpenRouterModels([kimi, tiny], 'ACME/T').map((m) => m.id), [tiny.id]);
  assert.equal(filterOpenRouterModels([kimi, tiny], '  ').length, 2);
});

test('groupSessions filters, searches, pins and buckets', () => {
  const sessions = [
    { id: 'a', title: 'Fix login', cwd: '/r/web', lastMessageAt: NOW - HOUR },
    { id: 'b', title: 'Old idea', cwd: '/r/ml', createdAt: NOW - 30 * DAY },
    { id: 'c', title: 'Archived thing', cwd: '/r/web', archived: true, lastMessageAt: NOW - 2 * HOUR },
    { id: 'd', title: 'Trashed', cwd: '/r/web', removed: true, archived: true, lastMessageAt: NOW },
    { id: 'e', title: 'Pinned one', cwd: '/r/ml', pinned: true, lastMessageAt: NOW - 40 * DAY },
    { id: 'f', title: 'Yesterday work', cwd: '/r/ml', lastMessageAt: NOW - DAY },
  ];
  const active = groupSessions(sessions, { filter: 'active', now: NOW });
  assert.deepEqual(active.map((g) => [g.label, g.sessions.map((s) => s.id)]), [
    ['Pinned', ['e']],
    ['Today', ['a']],
    ['Yesterday', ['f']],
    ['Earlier', ['b']],
  ]);
  assert.deepEqual(groupSessions(sessions, { filter: 'archived', now: NOW }).flatMap((g) => g.sessions.map((s) => s.id)), ['c']);
  assert.deepEqual(groupSessions(sessions, { filter: 'trash', now: NOW }).flatMap((g) => g.sessions.map((s) => s.id)), ['d']);
  assert.deepEqual(groupSessions(sessions, { filter: 'active', query: 'ML', now: NOW }).flatMap((g) => g.sessions.map((s) => s.id)), ['e', 'f', 'b']);
  assert.deepEqual(groupSessions(sessions, { filter: 'active', query: 'nothing', now: NOW }), []);
});

test('groupSessions by device: pinned first, then clusters in list order, unknown ids last', () => {
  const clusters = [{ id: 'local', label: 'Here' }, { id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }];
  const sessions = [
    { id: 'a', cwd: '/r', lastMessageAt: NOW - HOUR },
    { id: 'b', cwd: '/r', cluster: 'alpha', lastMessageAt: NOW - 2 * HOUR },
    { id: 'c', cwd: '/r', cluster: 'gone', lastMessageAt: NOW - 3 * HOUR },
    { id: 'd', cwd: '/r', cluster: 'local', lastMessageAt: NOW - 30 * DAY },
    { id: 'e', cwd: '/r', cluster: 'alpha', pinned: true, lastMessageAt: NOW - 40 * DAY },
  ];
  const groups = groupSessions(sessions, { filter: 'active', now: NOW, by: 'cluster', clusters });
  assert.deepEqual(groups.map((g) => [g.label, g.cluster, g.sessions.map((s) => s.id)]), [
    ['Pinned', null, ['e']],
    ['Here', 'local', ['a', 'd']],
    ['Alpha', 'alpha', ['b']],
    ['gone', 'gone', ['c']],
  ]);
});

test('status dots and busy state', () => {
  assert.equal(sessionDot({ status: 'running' }), 'running');
  assert.equal(sessionDot({ status: 'waiting' }), 'needs-you');
  assert.equal(sessionDot({ status: 'running', pending: [{}] }), 'needs-you');
  assert.equal(sessionDot({ status: 'error' }), 'error');
  assert.equal(sessionDot({ status: 'idle', turnEndedAt: 10, lastViewedAt: 5 }), 'unread');
  assert.equal(sessionDot({ status: 'idle', turnEndedAt: 10, lastViewedAt: 5 }, { current: true }), null);
  assert.equal(sessionDot({ status: 'idle' }), null);
  assert.equal(isBusy({ status: 'waiting' }), true);
  assert.equal(isBusy({ status: 'interrupted' }), false);
  assert.equal(isBusy(null), false);
});

test('upsertSession strips heavy fields and replaces in place', () => {
  const list = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const next = upsertSession(list, { id: 'b', title: 'B2', messages: [1], live: 'x', liveThinking: 'y' });
  assert.notEqual(next, list);
  assert.deepEqual(next[1], { id: 'b', title: 'B2' });
  assert.equal(upsertSession(list, { id: 'c', title: 'C' }).length, 3);
});

test('recentProjects returns unique folders newest first', () => {
  const sessions = [
    { cwd: '/a', lastMessageAt: 1 },
    { cwd: '/b', lastMessageAt: 3 },
    { cwd: '/a', lastMessageAt: 5 },
    { cwd: '/c', lastMessageAt: 4, removed: true },
  ];
  assert.deepEqual(recentProjects(sessions), ['/a', '/b']);
});

test('buildTranscript groups tools, hides queued messages and marks turns', () => {
  const session = {
    status: 'idle',
    cwd: '/repo',
    usage: { duration: 41000, cost: 0.2, models: { x: { outputTokens: 100 } } },
    messages: [
      { id: 'u1', role: 'user', text: 'hi', at: 1, delivery: 'done' },
      { id: 'a1', role: 'assistant', text: 'Looking', at: 2 },
      { id: 't1', role: 'tool', tool: 'Read', toolId: 'T1', state: 'done', input: { file_path: '/repo/a.js' } },
      { id: 't2', role: 'tool', tool: 'Bash', toolId: 'T2', state: 'error', input: { command: 'npm test' } },
      { id: 'a2', role: 'assistant', text: 'Done', at: 3 },
      { id: 'n1', role: 'notice', text: 'note', at: 4 },
      { id: 'u2', role: 'user', text: 'later', at: 5, delivery: 'queued' },
      { id: 'u3', role: 'user', text: 'nope', at: 6, delivery: 'cancelled' },
      // Sent mid-turn, not read by Claude yet: shown above the composer instead.
      { id: 'u4', role: 'user', text: 'steer', at: 7, delivery: 'sent' },
    ],
  };
  const entries = buildTranscript(session);
  assert.deepEqual(entries.map((e) => e.type), ['user', 'assistant', 'activity', 'assistant', 'notice', 'summary']);
  assert.equal(entries[1].showHeader, true);
  assert.equal(entries[3].showHeader, false);
  assert.equal(entries[2].tools, 2);
  assert.equal(entries[2].items.length, 2);
  assert.equal(entries[2].errors, 1);
  assert.equal(entries[3].turnEnd, true);
  assert.equal(entries[3].turnText, 'Looking\n\nDone');
  assert.equal(entries[1].turnEnd, undefined);
  assert.equal(entries.at(-1).tokens, 100);
});

test('buildEntries names the model only when it changes, and a normal turn end joins its reply', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'one', at: 1 },
    { id: 'a1', role: 'assistant', text: 'First', model: 'opus', at: 2 },
    { id: 't1', role: 'turn', duration: 4000, outputTokens: 12, at: 3 },
    { id: 'u2', role: 'user', text: 'two', at: 4 },
    { id: 'a2', role: 'assistant', text: 'Same model', model: 'opus', at: 5 },
    { id: 't2', role: 'turn', stopped: true, at: 6 },
    { id: 'u3', role: 'user', text: 'three', at: 7 },
    { id: 'a3', role: 'assistant', text: 'Switched', model: 'sonnet', at: 8 },
    { id: 't3', role: 'turn', isError: true, at: 9 },
  ];
  const { entries, headerModel } = buildEntries(messages);
  const replies = entries.filter((e) => e.type === 'assistant');
  assert.deepEqual(replies.map((e) => e.showHeader), [true, false, true]);
  assert.equal(headerModel, 'sonnet');
  // A normal end is the reply's footer; a stopped or failed one keeps its own row.
  assert.equal(replies[0].footer.id, 't1');
  assert.equal(entries.find((e) => e.key === 't1').merged, true);
  assert.equal(replies[1].footer, undefined);
  assert.equal(entries.find((e) => e.key === 't2').merged, undefined);
  assert.equal(entries.find((e) => e.key === 't3').merged, undefined);
  // Live text is headed only when the session's model is not the last one named.
  const base = buildEntries(messages.slice(0, 4));
  assert.equal(liveEntries({ status: 'running', model: 'opus', live: 'x', messages }, base).at(-1).showHeader, false);
  assert.equal(liveEntries({ status: 'running', model: 'sonnet', live: 'x', messages }, base).at(-1).showHeader, true);
});

test('buildTranscript: live text, working indicator, v2 turn footers, subagent nesting', () => {
  const base = {
    status: 'running',
    currentMessageId: 'u1',
    messages: [
      { id: 'u1', role: 'user', text: 'go', at: 100, startedAt: 150, delivery: 'running' },
      { id: 'th', role: 'thinking', text: 'hmm' },
      { id: 'ag', role: 'tool', tool: 'Agent', toolId: 'AG', state: 'running', input: { description: 'explore' } },
      { id: 'sub', role: 'tool', tool: 'Read', toolId: 'S1', parentToolId: 'AG', state: 'done', input: {} },
    ],
  };
  const working = buildTranscript(base);
  // Thinking right before a tool call joins the activity group; the running Agent
  // call shows in its row, so there is no working row.
  assert.deepEqual(working.map((e) => e.type), ['user', 'activity']);
  assert.deepEqual(working[1].items.map((n) => n.kind), ['thinking', 'tool']);
  assert.equal(working[1].items[1].children.length, 1);
  const waiting = buildTranscript({ ...base, status: 'waiting' });
  assert.deepEqual(waiting.map((e) => e.type), ['user', 'activity', 'working']);
  assert.equal(waiting.at(-1).tool, 'Agent');
  assert.equal(waiting.at(-1).startedAt, 150);

  const live = buildTranscript({ ...base, live: 'Partial **answer**', liveThinking: 'pondering' });
  assert.deepEqual(live.slice(-2).map((e) => e.type), ['live-thinking', 'live']);
  assert.equal(live.at(-1).showHeader, true);

  const done = buildTranscript({
    status: 'idle',
    usage: { duration: 1 },
    messages: [
      { id: 'u1', role: 'user', text: 'go', at: 1 },
      { id: 'a1', role: 'assistant', text: 'ok', at: 2 },
      { id: 'f1', role: 'turn', duration: 1200, outputTokens: 5, cost: 0.01 },
    ],
  });
  assert.deepEqual(done.map((e) => e.type), ['user', 'assistant', 'turn']);
});

test('toolSummary verbs and targets', () => {
  const cwd = '/repo';
  assert.deepEqual(
    pick(toolSummary({ tool: 'Read', state: 'done', input: { file_path: '/repo/server/runner.mjs', offset: 40, limit: 81 } }, cwd)),
    { verb: 'Read', target: 'server/runner.mjs:40-120' },
  );
  assert.deepEqual(pick(toolSummary({ tool: 'Bash', state: 'running', input: { command: 'npm test\necho done' } }, cwd)), { verb: 'Running', target: 'npm test' });
  const edit = toolSummary({ tool: 'Edit', state: 'done', input: { file_path: '/repo/src/app.jsx', old_string: 'a\nb\nc', new_string: 'x' } }, cwd);
  assert.equal(edit.verb, 'Edited');
  assert.equal(edit.target, 'src/app.jsx');
  assert.deepEqual(edit.stats, { adds: 1, dels: 3 });
  assert.equal(toolSummary({ tool: 'mcp__comet__list_projects', state: 'done', input: {} }).verb, 'comet · list_projects');
  assert.equal(toolSummary({ tool: 'Grep', state: 'done', input: { pattern: 'foo', path: '/repo/src' } }, cwd).target, 'foo in src');
});

function pick({ verb, target }) {
  return { verb, target };
}

test('parseDiff numbers lines and counts changes', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,3 +10,3 @@ function x() {',
    ' keep',
    '-old',
    '+new',
    ' tail',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    '',
  ].join('\n');
  const files = parseDiff(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[0].adds, 1);
  assert.equal(files[0].dels, 1);
  assert.deepEqual(files[0].rows.map((r) => [r.type, r.oldNo ?? null, r.newNo ?? null]), [
    ['hunk', null, null],
    ['context', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['context', 12, 12],
  ]);
  assert.equal(files[1].status, 'added');
  assert.equal(files[1].adds, 2);
  assert.deepEqual(parseDiff(''), []);
});

test('parseDiff: header patterns only apply before the first hunk', () => {
  const diff = [
    'diff --git a/db/schema.sql b/db/schema.sql',
    'index 111..222 100644',
    '--- a/db/schema.sql',
    '+++ b/db/schema.sql',
    '@@ -1,3 +1,3 @@',
    '--- sql comment that was removed',
    '+++ added line starting with two pluses',
    '+index of things',
    ' create table t (id int);',
    'diff --git a/logo.png b/logo.png',
    'index 333..444 100644',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');
  const [sql, binary] = parseDiff(diff);
  assert.equal(sql.path, 'db/schema.sql');
  assert.equal(sql.dels, 1);
  assert.equal(sql.adds, 2);
  assert.deepEqual(sql.rows.map((r) => [r.type, r.text]), [
    ['hunk', '@@ -1,3 +1,3 @@'],
    ['del', '-- sql comment that was removed'],
    ['add', '++ added line starting with two pluses'],
    ['add', 'index of things'],
    ['context', 'create table t (id int);'],
  ]);
  assert.equal(binary.path, 'logo.png');
  assert.deepEqual(binary.rows, [{ type: 'meta', text: 'Binary files a/logo.png and b/logo.png differ' }]);
});

test('transcript: entries built from messages are reused while only live state changes', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'hi', at: 1 },
    { id: 't1', role: 'tool', tool: 'Bash', toolId: 'T1', state: 'running', input: { command: 'ls' } },
  ];
  const base = buildEntries(messages);
  assert.equal(base.runningTool.id, 't1');
  const tick1 = { id: 's', status: 'running', messages, live: 'Hel', currentMessageId: 'u1' };
  const tick2 = { ...tick1, live: 'Hello' };
  const [live1] = liveEntries(tick1, base);
  const [live2] = liveEntries(tick2, base);
  assert.equal(live1.key, live2.key);
  assert.equal(live2.text, 'Hello');
  assert.equal(live2.showHeader, true);
  // buildTranscript is the same composition.
  assert.deepEqual(buildTranscript(tick2), [...base.entries, live2]);
  // Without live text a running tool shows only in its own row; waiting on an
  // approval adds the working row.
  assert.deepEqual(liveEntries({ ...tick1, live: '' }, base), []);
  assert.deepEqual(liveEntries({ ...tick1, live: '', status: 'waiting' }, base).map((e) => [e.type, e.tool]), [['working', 'Bash']]);
  assert.deepEqual(buildEntries(null).entries, []);
  assert.deepEqual(liveEntries(null, buildEntries(null)), []);
});
