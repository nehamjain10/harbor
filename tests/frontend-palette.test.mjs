import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, highlightRuns, matchFields, rankCommands, rankSessions } from '../src/lib/palette.js';
import {
  attentionCount,
  createNotifier,
  documentTitle,
  finishedBody,
  isUnreadFor,
  lastAssistantLine,
  pendingBody,
  plainText,
  shouldMarkViewed,
  turnWasStopped,
} from '../src/lib/notify.js';
import { isUnread, sessionDot } from '../src/lib/sessions.js';
import { keyLabels, matchShortcut, shortcutText } from '../src/lib/shortcuts.js';

const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime();
const HOUR = 3_600_000;

/* Fuzzy matching */

test('fuzzyMatch prefers prefix, then word start, then inside a word, then scattered', () => {
  const prefix = fuzzyMatch('ser', 'server split');
  const wordStart = fuzzyMatch('ser', 'split server');
  const inside = fuzzyMatch('ser', 'observe logs');
  const scattered = fuzzyMatch('ser', 'stop every run');
  assert.ok(prefix.score > wordStart.score, 'prefix beats word start');
  assert.ok(wordStart.score > inside.score, 'word start beats inside a word');
  assert.ok(inside.score > scattered.score, 'contiguous beats scattered');
  assert.deepEqual(prefix.indices, [0, 1, 2]);
  assert.deepEqual(wordStart.indices, [6, 7, 8]);
});

test('fuzzyMatch handles camelCase, acronyms, misses and one-letter tokens', () => {
  assert.deepEqual(fuzzyMatch('sm', 'split modules').indices, [0, 6], 'initials jump to word starts');
  assert.ok(fuzzyMatch('pm', 'PaletteMenu'), 'camelCase boundary');
  assert.deepEqual(fuzzyMatch('serm', 'server modules').indices, [0, 1, 2, 7], 'falls back when word-start jumps strand the rest');
  assert.equal(fuzzyMatch('ser', 'zenit-research'), null, 'short scattered matches must follow word starts');
  assert.equal(fuzzyMatch('ser', 'Toggle sidebar'), null);
  assert.deepEqual(fuzzyMatch('gmp', 'GPU memory profile').indices, [0, 4, 11], 'initials');
  assert.equal(fuzzyMatch('xyz', 'server'), null);
  assert.equal(fuzzyMatch('e', 'server'), null, 'one letter only at a word start');
  assert.deepEqual(fuzzyMatch('s', 'fix server').indices, [4]);
});

test('matchFields needs every token and reports matches per field', () => {
  const fields = [
    { key: 'title', text: 'Split server.mjs', weight: 1 },
    { key: 'project', text: 'zenit-research', weight: 0.75 },
  ];
  const result = matchFields('split zenit', fields);
  assert.ok(result);
  assert.deepEqual(result.matches.title, [0, 1, 2, 3, 4]);
  assert.deepEqual(result.matches.project, [0, 1, 2, 3, 4]);
  assert.equal(matchFields('split nope', fields), null);
});

test('highlightRuns groups matched characters', () => {
  assert.deepEqual(highlightRuns('server', [0, 1, 4]), [
    { text: 'se', match: true },
    { text: 'rv', match: false },
    { text: 'e', match: true },
    { text: 'r', match: false },
  ]);
});

/* Session ranking */

const sessions = [
  { id: 'a', title: 'Split server.mjs into modules', cwd: '/w/zenit-research', model: 'opus', lastMessageAt: NOW - 2 * HOUR },
  { id: 'b', title: 'Fix the sidebar scroll', cwd: '/w/claude-workbench', model: 'sonnet', lastMessageAt: NOW - HOUR },
  { id: 'c', title: 'Server logs review', cwd: '/w/claude-workbench', model: 'luna', lastMessageAt: NOW - 30 * 24 * HOUR },
  { id: 'd', title: 'Old server notes', cwd: '/w/x', model: 'opus', lastMessageAt: NOW - 10, archived: true },
  { id: 'e', title: 'Deleted server thing', cwd: '/w/x', model: 'opus', lastMessageAt: NOW, removed: true },
  { id: 'cur', title: 'Server current', cwd: '/w/x', model: 'opus', lastMessageAt: NOW },
];
const modelName = (id) => ({ opus: 'Claude Opus 5.5', sonnet: 'Claude Sonnet 5.5', luna: 'GPT-6 Luna' })[id] || id;

test('rankSessions without a query lists recent active sessions, current and trashed excluded', () => {
  const ids = rankSessions(sessions, '', { currentId: 'cur', modelName, now: NOW }).map((r) => r.session.id);
  assert.deepEqual(ids, ['b', 'a', 'c']);
});

test('rankSessions ranks by match quality, then recency; archived rank lower', () => {
  const ids = rankSessions(sessions, 'server', { currentId: 'cur', modelName, now: NOW }).map((r) => r.session.id);
  // c starts with "Server" (prefix) and beats a's word-start match despite being older;
  // archived d matches at a word start but is pushed below.
  assert.deepEqual(ids, ['c', 'a', 'd']);
  // Equal match quality: the more recent one wins.
  const tie = rankSessions(
    [
      { id: 'old', title: 'deploy notes', cwd: '/p', lastMessageAt: NOW - 5 * 24 * HOUR },
      { id: 'new', title: 'deploy notes', cwd: '/p', lastMessageAt: NOW - HOUR },
    ],
    'deploy',
    { now: NOW },
  );
  assert.deepEqual(tie.map((r) => r.session.id), ['new', 'old']);
});

test('rankSessions matches project and model names', () => {
  assert.deepEqual(rankSessions(sessions, 'workbench', { modelName, now: NOW }).map((r) => r.session.id).sort(), ['b', 'c']);
  const luna = rankSessions(sessions, 'luna', { modelName, now: NOW });
  assert.deepEqual(luna.map((r) => r.session.id), ['c']);
  assert.deepEqual(luna[0].matches.model, [6, 7, 8, 9]);
});

test('rankCommands keeps list order without a query and hides search-only commands', () => {
  const commands = [
    { id: 'new', label: 'New session' },
    { id: 'model', label: 'Switch model…', keywords: 'opus sonnet llm' },
    { id: 'theme-dark', label: 'Theme: Dark', searchOnly: true },
    { id: 'panel', label: 'Toggle side panel', keywords: 'changes files diff' },
  ];
  assert.deepEqual(rankCommands(commands, '').map((r) => r.command.id), ['new', 'model', 'panel']);
  assert.deepEqual(rankCommands(commands, 'dark').map((r) => r.command.id), ['theme-dark']);
  assert.deepEqual(rankCommands(commands, 'diff').map((r) => r.command.id), ['panel']);
  assert.equal(rankCommands(commands, 'mod')[0].command.id, 'model');
});

/* Unread and title count */

test('unread: a finished turn newer than the last view, except the open session while visible', () => {
  const s = { id: 's', status: 'idle', turnEndedAt: 200, lastViewedAt: 100 };
  assert.equal(isUnread(s), true);
  assert.equal(isUnread({ ...s, lastViewedAt: 200 }), false);
  assert.equal(isUnread({ id: 'v1', status: 'idle' }), false, 'v1 sessions have no turnEndedAt');
  assert.equal(isUnreadFor(s, { currentId: 's', visible: true }), false);
  assert.equal(isUnreadFor(s, { currentId: 's', visible: false }), true);
  assert.equal(isUnreadFor({ ...s, status: 'running' }, {}), false, 'a running follow-up is not unread yet');
  assert.equal(sessionDot(s), 'unread');
  assert.equal(sessionDot(s, { current: true }), null);
  assert.equal(sessionDot({ ...s, status: 'waiting' }, { current: true }), 'needs-you', 'waiting always shows');
});

test('shouldMarkViewed fires once per new turnEndedAt', () => {
  const marks = new Map();
  const s = { id: 's', turnEndedAt: 200, lastViewedAt: 100 };
  assert.equal(shouldMarkViewed(s, marks), true);
  marks.set('s', 200);
  assert.equal(shouldMarkViewed(s, marks), false);
  assert.equal(shouldMarkViewed({ ...s, turnEndedAt: 300 }, marks), true);
  assert.equal(shouldMarkViewed({ ...s, lastViewedAt: 200 }, new Map()), false);
});

test('attentionCount and documentTitle', () => {
  const list = [
    { id: 'w', status: 'waiting', pending: [{ id: 'p' }] },
    { id: 'u', status: 'idle', turnEndedAt: 5, lastViewedAt: 1 },
    { id: 'cur', status: 'idle', turnEndedAt: 5, lastViewedAt: 1 },
    { id: 'r', status: 'running', turnEndedAt: 5, lastViewedAt: 1 },
    { id: 'seen', status: 'idle', turnEndedAt: 5, lastViewedAt: 5 },
    { id: 'arch', status: 'idle', turnEndedAt: 5, lastViewedAt: 1, archived: true },
    { id: 'gone', status: 'waiting', removed: true },
  ];
  assert.equal(attentionCount(list, { currentId: 'cur', visible: true }), 2);
  assert.equal(attentionCount(list, { currentId: 'cur', visible: false }), 3);
  assert.equal(attentionCount([], {}), 0);
  assert.equal(documentTitle(null, 0), 'Harbor');
  assert.equal(documentTitle(null, 3), '(3) Harbor');
  assert.equal(documentTitle('Fix bug', 2), '(2) Fix bug · Harbor');
});

/* Notifications */

const base = (over = {}) => ({ id: 's1', title: 'Fix bug', status: 'idle', turnEndedAt: 100, pending: [], ...over });

test('notifier records the initial state without announcing it', () => {
  const notifier = createNotifier();
  const first = notifier.observe([base({ status: 'waiting', pending: [{ id: 'p0', kind: 'permission', tool: 'Bash' }] })], { visible: false });
  assert.deepEqual(first, []);
  // Same state again: still nothing.
  assert.deepEqual(notifier.observe([base({ status: 'waiting', pending: [{ id: 'p0' }] })], { visible: false }), []);
});

test('notifier announces each finished turn once, only when hidden or another session is open', () => {
  const notifier = createNotifier();
  notifier.observe([base()], { visible: false });
  const done = notifier.observe([base({ turnEndedAt: 200 })], { visible: false });
  assert.equal(done.length, 1);
  assert.equal(done[0].type, 'finished');
  assert.equal(done[0].key, 's1:200');
  assert.deepEqual(notifier.observe([base({ turnEndedAt: 200 })], { visible: false }), [], 'de-duplicated');

  // Visible and looking at it: quiet. Visible but another session open: announced.
  assert.deepEqual(notifier.observe([base({ turnEndedAt: 300 })], { visible: true, currentId: 's1' }), []);
  assert.equal(notifier.observe([base({ turnEndedAt: 400 })], { visible: true, currentId: 'other' }).length, 1);

  // Disabled: recorded, not announced, and not replayed when enabled later.
  assert.deepEqual(notifier.observe([base({ turnEndedAt: 500 })], { visible: false, enabled: false }), []);
  assert.deepEqual(notifier.observe([base({ turnEndedAt: 500 })], { visible: false, enabled: true }), []);
});

test('notifier skips turns that continue (queue) or were stopped', () => {
  const notifier = createNotifier();
  notifier.observe([base()], { visible: false });
  assert.deepEqual(notifier.observe([base({ turnEndedAt: 200, status: 'running' })], { visible: false }), []);
  assert.deepEqual(notifier.observe([base({ turnEndedAt: 300, status: 'interrupted' })], { visible: false }), []);
  assert.equal(notifier.observe([base({ turnEndedAt: 400, status: 'error' })], { visible: false })[0].type, 'finished');
});

test('notifier announces each new pending request once', () => {
  const notifier = createNotifier();
  notifier.observe([base()], { visible: false });
  const pending = { id: 'p1', kind: 'permission', tool: 'Bash' };
  const events = notifier.observe([base({ status: 'waiting', pending: [pending] })], { visible: false });
  assert.deepEqual(events.map((e) => [e.type, e.key]), [['waiting', 'pending:p1']]);
  assert.deepEqual(notifier.observe([base({ status: 'waiting', pending: [pending] })], { visible: false }), []);
});

test('notifier: the first loaded list is the baseline; sessions that appear later are new', () => {
  const notifier = createNotifier();
  // Before the list loads (booting) nothing counts as the baseline yet.
  assert.deepEqual(notifier.observe([], { visible: false, loaded: false }), []);
  const waiting = base({ id: 'old', status: 'waiting', turnEndedAt: 50, pending: [{ id: 'p-old', kind: 'question' }] });
  assert.deepEqual(notifier.observe([waiting], { visible: false, loaded: true }), [], 'state from before the page loaded');

  // Created on another device after boot: first seen running, then it finishes.
  const elsewhere = base({ id: 'phone', status: 'running', turnEndedAt: 0 });
  assert.deepEqual(notifier.observe([waiting, elsewhere], { visible: false }), []);
  const done = notifier.observe([waiting, { ...elsewhere, status: 'idle', turnEndedAt: 900 }], { visible: false });
  assert.deepEqual(done.map((e) => [e.type, e.key]), [['finished', 'phone:900']]);

  // First seen after boot already finished, or already waiting: announced.
  const finished = base({ id: 'phone2', turnEndedAt: 700 });
  const asking = base({ id: 'phone3', status: 'waiting', turnEndedAt: 0, pending: [{ id: 'p3', kind: 'plan' }] });
  const events = notifier.observe([waiting, finished, asking], { visible: false });
  assert.deepEqual(events.map((e) => [e.type, e.key]), [['finished', 'phone2:700'], ['waiting', 'pending:p3']]);
  // Still quiet while looking at it.
  const open = base({ id: 'phone4', turnEndedAt: 800 });
  assert.deepEqual(notifier.observe([open], { visible: true, currentId: 'phone4' }), []);
});

test('turnWasStopped: from the turn message, or the stopped user message when no result came', () => {
  assert.equal(turnWasStopped([]), false);
  assert.equal(turnWasStopped([{ role: 'user', delivery: 'done' }, { role: 'assistant', text: 'x' }, { role: 'turn', stopped: true }]), true);
  assert.equal(turnWasStopped([{ role: 'user', delivery: 'done' }, { role: 'turn' }]), false);
  assert.equal(turnWasStopped([{ role: 'turn' }, { role: 'user', delivery: 'stopped' }, { role: 'notice', text: 'Stopped.' }]), true);
  // A message queued behind it does not count.
  assert.equal(turnWasStopped([{ role: 'user', delivery: 'done' }, { role: 'turn', stopped: true }, { role: 'user', delivery: 'queued' }]), true);
  assert.equal(turnWasStopped([{ role: 'user', delivery: 'done' }, { role: 'turn', stopped: true }, { role: 'user', delivery: 'sent' }]), true);
  assert.equal(turnWasStopped([{ role: 'turn', stopped: true }, { role: 'user', delivery: 'done' }, { role: 'turn' }]), false);
});

test('notification texts', () => {
  assert.equal(pendingBody({ kind: 'permission', tool: 'Bash' }), 'Needs your approval: Bash');
  assert.equal(pendingBody({ kind: 'question' }), 'Has a question for you');
  assert.equal(pendingBody({ kind: 'plan' }), 'Plan ready for review');
  const messages = [
    { role: 'assistant', text: 'First answer' },
    { role: 'assistant', text: 'From a subagent', parentToolId: 'T' },
    { role: 'assistant', text: '\n\nAll **tests** pass now.\nDetails below.' },
    { role: 'tool', tool: 'Bash' },
    { role: 'turn', isError: false },
  ];
  assert.equal(lastAssistantLine(messages), 'All tests pass now.');
  assert.equal(finishedBody({ status: 'idle', messages }), 'All tests pass now.');
  assert.equal(plainText('## Done: see [store.mjs](server/store.mjs:12) and `npm test`'), 'Done: see store.mjs and npm test');
  assert.equal(finishedBody({ status: 'error', messages }), 'Finished with an error');
  assert.equal(finishedBody({ status: 'idle', messages: [...messages, { role: 'turn', isError: true }] }), 'Finished with an error');
  assert.equal(finishedBody({ status: 'idle' }), 'Finished');
});

/* Shortcuts */

test('shortcut matching and labels', () => {
  const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, ...extra });
  assert.equal(matchShortcut(key('k', { metaKey: true }), true), 'palette');
  assert.equal(matchShortcut(key('K', { ctrlKey: true }), false), 'palette');
  assert.equal(matchShortcut(key('O', { ctrlKey: true, shiftKey: true }), false), 'newSession');
  assert.equal(matchShortcut(key('j', { metaKey: true }), true), 'panel');
  assert.equal(matchShortcut(key('b', { ctrlKey: true }), false), 'sidebar');
  // On a Mac, Ctrl+K / Ctrl+B stay text-editing keys.
  assert.equal(matchShortcut(key('k', { ctrlKey: true }), true), null);
  assert.equal(matchShortcut(key('b', { ctrlKey: true }), true), null);
  assert.equal(matchShortcut(key('?', { shiftKey: true })), 'help');
  assert.equal(matchShortcut(key('?', { shiftKey: true, target: { tagName: 'TEXTAREA' } })), null, 'not while typing');
  assert.equal(matchShortcut(key('k')), null);
  assert.deepEqual(keyLabels(['mod', 'shift', 'O'], true), ['⌘', '⇧', 'O']);
  assert.equal(shortcutText(['mod', 'shift', 'O'], false), 'Ctrl+Shift+O');
});
