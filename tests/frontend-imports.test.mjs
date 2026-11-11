// Session import helpers (src/lib/imports.js) and how imported sessions show up in
// the palette search and the model lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitingFirstTurn,
  chunk,
  filterCandidates,
  formatBytes,
  importBanner,
  importDate,
  importTime,
  importedIds,
  isSelectable,
  messageTime,
  originatorLabel,
  projectChoices,
  sourceLabel,
  tildePath,
} from '../src/lib/imports.js';
import { rankSessions } from '../src/lib/palette.js';
import { findModel } from '../src/lib/models.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime();
const HOME = '/home/me';

test('source and originator labels', () => {
  assert.equal(sourceLabel('claude'), 'Claude Code');
  assert.equal(sourceLabel('codex'), 'Codex');
  assert.equal(sourceLabel('other'), '');
  assert.equal(originatorLabel('Codex Desktop'), 'Desktop');
  assert.equal(originatorLabel('codex-tui'), 'Terminal');
  assert.equal(originatorLabel('codex_exec'), 'Exec');
  assert.equal(originatorLabel('codex_cloud'), 'codex_cloud', 'anything else as-is');
  assert.equal(originatorLabel(undefined), '');
});

test('tildePath shortens paths inside home only', () => {
  assert.equal(tildePath(`${HOME}/monorepo/src`, HOME), '~/monorepo/src');
  assert.equal(tildePath(HOME, HOME + '/'), '~');
  assert.equal(tildePath(`${HOME}2/x`, HOME), `${HOME}2/x`, 'a sibling with the same prefix is not home');
  assert.equal(tildePath('/tmp/x', HOME), '/tmp/x');
  assert.equal(tildePath('/tmp/x', ''), '/tmp/x');
  assert.equal(tildePath('', HOME), '');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(812), '812 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(640 * 1024), '640 KB');
  assert.equal(formatBytes(3.14 * 1024 * 1024), '3.1 MB');
  assert.equal(formatBytes(481 * 1024 * 1024), '481 MB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatBytes(-1), '');
});

test('importTime and importDate add the year only outside the current one', () => {
  assert.equal(importTime(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(importTime(NOW - 3 * HOUR, NOW), '3h ago');
  assert.match(importTime(NOW - 4 * DAY, NOW), /^Oct 1$/);
  assert.match(importTime(new Date(2025, 8, 3).getTime(), NOW), /^Sep 3, 2025$/);
  assert.equal(importTime(0, NOW), '');
  assert.match(importDate(NOW - 3 * DAY, NOW), /^Oct 2$/);
  assert.match(importDate(new Date(2025, 11, 30).getTime(), NOW), /^Dec 30, 2025$/);
});

test('messageTime adds the date for older messages', () => {
  assert.equal(messageTime(NOW - HOUR, NOW), new Date(NOW - HOUR).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  assert.match(messageTime(new Date(2026, 9, 2, 20, 29).getTime(), NOW), /^Oct 2, 8:29\sPM$/);
  assert.match(messageTime(new Date(2025, 9, 2, 9, 5).getTime(), NOW), /^Oct 2, 2025, 9:05\sAM$/);
  assert.equal(messageTime(0, NOW), '');
});

const ITEMS = [
  { id: 'a', title: 'Fix the NCCL timeout', cwd: `${HOME}/api-server`, importable: true },
  { id: 'b', title: 'Thumbnail renders', cwd: `${HOME}/monorepo`, importable: true },
  { id: 'c', title: 'Debug the axis flip', cwd: `${HOME}/monorepo`, importable: true, importedAs: 's1' },
  { id: 'd', title: 'Scratch build', cwd: '/tmp/bench', importable: false, reason: 'Outside home' },
  { id: 'e', title: 'No folder', cwd: '' },
];

test('filterCandidates: every word in the title or folder, plus an exact folder filter', () => {
  const ids = (list) => list.map((item) => item.id);
  assert.equal(filterCandidates(ITEMS, {}), ITEMS, 'no filter returns the same list');
  assert.deepEqual(ids(filterCandidates(ITEMS, { query: 'monorepo', home: HOME })), ['b', 'c']);
  assert.deepEqual(ids(filterCandidates(ITEMS, { query: 'AXIS  mono', home: HOME })), ['c'], 'case-insensitive, words in any field');
  assert.deepEqual(ids(filterCandidates(ITEMS, { query: '~/api', home: HOME })), ['a'], 'matches the ~ form');
  assert.deepEqual(ids(filterCandidates(ITEMS, { query: '/tmp/bench' })), ['d']);
  assert.deepEqual(ids(filterCandidates(ITEMS, { project: `${HOME}/monorepo` })), ['b', 'c']);
  assert.deepEqual(ids(filterCandidates(ITEMS, { project: `${HOME}/monorepo`, query: 'thumbnail' })), ['b']);
  assert.deepEqual(filterCandidates(ITEMS, { query: 'nothing-like-this' }), []);
});

test('projectChoices: folders with counts, most recent first', () => {
  assert.deepEqual(projectChoices(ITEMS), [
    { cwd: `${HOME}/api-server`, count: 1 },
    { cwd: `${HOME}/monorepo`, count: 2 },
    { cwd: '/tmp/bench', count: 1 },
  ]);
});

test('chunk splits into batches of 20 by default', () => {
  const ids = Array.from({ length: 45 }, (_, i) => 'id' + i);
  assert.deepEqual(chunk(ids).map((batch) => batch.length), [20, 20, 5]);
  assert.deepEqual(chunk([]), []);
  assert.deepEqual(chunk(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
});

test('isSelectable: importable and not yet imported', () => {
  assert.deepEqual(ITEMS.map(isSelectable), [true, true, false, false, true]);
  assert.equal(isSelectable(null), false);
});

test('importedIds pairs sessions with candidate ids', () => {
  const sessions = [{ id: 's-a', source: { id: 'a' } }, { id: 's-c', source: { id: 'c' } }];
  assert.deepEqual(importedIds(['a', 'b', 'c'], sessions, [{ id: 'b', error: 'x' }]), [
    { id: 'a', sessionId: 's-a' },
    { id: 'c', sessionId: 's-c' },
  ]);
  // Without source ids: the requested ids that did not fail, in order.
  assert.deepEqual(importedIds(['a', 'b', 'c'], [{ id: 's1' }, { id: 's2' }], [{ id: 'b' }]), [
    { id: 'a', sessionId: 's1' },
    { id: 'c', sessionId: 's2' },
  ]);
});

test('awaitingFirstTurn and the banner text', () => {
  const claude = {
    model: 'opus',
    source: { kind: 'claude', id: 'x', updatedAt: NOW - 3 * DAY },
    messages: [
      { role: 'notice', imported: true, text: '12 earlier messages are not shown.' },
      { role: 'user', imported: true, text: 'hi' },
      { role: 'assistant', imported: true, text: 'hello' },
    ],
  };
  assert.equal(awaitingFirstTurn(claude), true);
  const banner = importBanner(claude, 'Claude Opus 5.5', NOW);
  assert.match(banner.lead, /^Imported from Claude Code · Oct 2\.$/);
  assert.equal(banner.text, 'Your next message continues it on Claude Opus 5.5 in a copy; the original is unchanged.');

  const codex = { ...claude, source: { kind: 'codex', id: 'y', updatedAt: new Date(2025, 4, 1).getTime() } };
  const codexBanner = importBanner(codex, 'Claude Sonnet 5.5', NOW);
  assert.match(codexBanner.lead, /^Imported from Codex · May 1, 2025\.$/);
  assert.equal(codexBanner.text, 'Codex conversations can’t be resumed directly; your next message starts a new conversation that carries a summary of this one.');

  // A user message of its own (queued or sent) ends it.
  const continued = { ...claude, messages: [...claude.messages, { role: 'user', text: 'next', delivery: 'queued' }] };
  assert.equal(awaitingFirstTurn(continued), false);
  assert.equal(importBanner(continued, 'Claude Opus 5.5', NOW), null);
  assert.equal(awaitingFirstTurn({ messages: [] }), false, 'not imported');
  assert.equal(awaitingFirstTurn({ source: { kind: 'codex' } }), true, 'no messages yet');
});

test('palette search finds imported sessions by their source', () => {
  const sessions = [
    { id: 'a', title: 'Mixed precision', cwd: '/x/trainer', model: 'opus', source: { kind: 'codex' }, lastMessageAt: NOW - HOUR },
    { id: 'b', title: 'Tokenizer bench', cwd: '/x/tok', model: 'opus', lastMessageAt: NOW - HOUR },
  ];
  assert.deepEqual(rankSessions(sessions, 'codex', { now: NOW }).map((r) => r.session.id), ['a']);
});

test('findModel names an unknown id after itself and guesses its provider', () => {
  const info = { models: [{ id: 'opus', name: 'Claude Opus 5.5', provider: 'Claude' }] };
  assert.equal(findModel(info, 'gpt-6-astra').provider, 'OpenAI');
  assert.equal(findModel(info, 'gpt-6-astra').name, 'gpt-6-astra');
  assert.equal(findModel(info, 'claude-opus-4-1').provider, 'Claude');
  assert.equal(findModel(info, 'opus').name, 'Claude Opus 5.5');
});
