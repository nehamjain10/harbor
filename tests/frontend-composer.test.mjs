import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrigger, fuzzyFilter, fuzzyScore, insertToken, mentionText } from '../src/lib/mentions.js';
import { LOCAL_COMMANDS, createCommandCache, groupCommands, mergeCommands, parseLocalCommand } from '../src/lib/commands.js';
import { MAX_FILE_BYTES, MAX_FILES, checkFiles, formatBytes, uploadFile, uploadName, uploadUrl } from '../src/lib/uploads.js';
import { contextTone, contextUsage } from '../src/lib/context.js';
import { createDoublePress, isTextEntry } from '../src/lib/keys.js';
import {
  allAnswered, allowRuleTexts, approvalBody, approvalKind, buildAnswers, mcpParts, permissionTitle, planMode, planText, questionAnswer, suggestionItems, suggestionRules,
  waitingLabel,
} from '../src/lib/approvals.js';
import { countRows, fileChangeBlocks, lineDiff } from '../src/lib/approvalDiff.js';
import { attachmentsKey, clearSentAttachments, moveNewAttachments, readAttachments, writeAttachments } from '../src/lib/drafts.js';

/* Trigger detection */

test('detectTrigger finds @ mentions only at the start of a word', () => {
  assert.deepEqual(detectTrigger('@', 1), { type: 'mention', query: '', start: 0, end: 1 });
  assert.deepEqual(detectTrigger('look at @src/ser', 16), { type: 'mention', query: 'src/ser', start: 8, end: 16 });
  assert.deepEqual(detectTrigger('(@ab', 4), { type: 'mention', query: 'ab', start: 1, end: 4 });
  // Inside a word, e.g. an email address.
  assert.equal(detectTrigger('mail a@b', 8), null);
  assert.equal(detectTrigger('me@example.com', 11), null);
  // A space ends the mention.
  assert.equal(detectTrigger('@src/a.js and', 13), null);
  assert.equal(detectTrigger('@src/a.js ', 10), null);
  // Caret in the middle of the token: the whole token is replaced later.
  assert.deepEqual(detectTrigger('see @server.mjs now', 8), { type: 'mention', query: 'ser', start: 4, end: 15 });
  // Two @ in a row is not a mention.
  assert.equal(detectTrigger('@@', 2), null);
});

test('detectTrigger finds / commands only as the first character', () => {
  assert.deepEqual(detectTrigger('/', 1), { type: 'command', query: '', start: 0, end: 1 });
  assert.deepEqual(detectTrigger('/comp', 5), { type: 'command', query: 'comp', start: 0, end: 5 });
  assert.deepEqual(detectTrigger('/compact now', 3), { type: 'command', query: 'co', start: 0, end: 8 });
  assert.equal(detectTrigger('/compact now', 12), null);
  assert.equal(detectTrigger('use /tmp/x', 7), null);
  assert.equal(detectTrigger(' /help', 6), null);
  assert.equal(detectTrigger('', 0), null);
  assert.equal(detectTrigger('abc', 9), null);
});

test('insertToken replaces the token and keeps the rest', () => {
  const text = 'see @ser now';
  const trigger = detectTrigger(text, 8);
  assert.deepEqual(insertToken(text, trigger, '@server.mjs '), { text: 'see @server.mjs now', caret: 16 });
  const end = 'open @sr';
  assert.deepEqual(insertToken(end, detectTrigger(end, 8), '@src/'), { text: 'open @src/', caret: 10 });
  const cmd = '/co';
  assert.deepEqual(insertToken(cmd, detectTrigger(cmd, 3), '/compact '), { text: '/compact ', caret: 9 });
  // Removing a token (local command run from the menu).
  assert.deepEqual(insertToken('/hel', detectTrigger('/hel', 4), ''), { text: '', caret: 0 });
});

test('mentionText adds a space after files and a slash after folders', () => {
  assert.equal(mentionText({ path: 'src/app.jsx', directory: false }), '@src/app.jsx ');
  assert.equal(mentionText({ path: 'src/components', directory: true }), '@src/components/');
  assert.equal(mentionText({ path: 'src/', directory: true }), '@src/');
});

/* Fuzzy matching */

test('fuzzyScore ranks exact > prefix > boundary > substring > subsequence', () => {
  const exact = fuzzyScore('help', 'help');
  const prefix = fuzzyScore('comp', 'compact');
  const boundary = fuzzyScore('review', 'code-review');
  const inner = fuzzyScore('view', 'codereview');
  const subsequence = fuzzyScore('cmpt', 'compact');
  assert.ok(exact > prefix && prefix > boundary && boundary > inner && inner > subsequence && subsequence > 0);
  assert.equal(fuzzyScore('zz', 'compact'), -1);
  assert.equal(fuzzyScore('', 'anything'), 1);
  assert.equal(fuzzyScore('CoMp', 'compact') > 0, true);
});

test('fuzzyFilter keeps matches, best first, stable for ties', () => {
  const items = ['security-review', 'review', 'init', 'pr-comments', 'rewind'];
  assert.deepEqual(fuzzyFilter(items, 'rev'), ['review', 'security-review']);
  assert.deepEqual(fuzzyFilter(items, ''), items);
  assert.deepEqual(fuzzyFilter(items, 'rw'), ['rewind', 'review', 'security-review']);
});

/* Commands */

const SERVER = [
  { name: 'compact', description: 'Clear history but keep a summary', source: 'sdk' },
  { name: '/review', description: 'Review a pull request', source: 'sdk' },
  { name: 'brainstorming', description: 'Explore ideas before building', source: 'skill' },
  { name: 'clear', description: 'server clear', source: 'sdk' },
  { name: 'model', description: 'server model', source: 'local' },
];

test('mergeCommands puts local commands first and drops duplicates', () => {
  const merged = mergeCommands(SERVER);
  assert.deepEqual(merged.slice(0, LOCAL_COMMANDS.length).map((c) => c.name), ['clear', 'model', 'mode', 'effort', 'rename', 'fork', 'import', 'agents', 'tasks', 'settings', 'mcp', 'help']);
  assert.equal(merged.filter((c) => c.name === 'clear').length, 1);
  assert.equal(merged.find((c) => c.name === 'clear').source, 'local');
  assert.ok(merged.some((c) => c.name === 'review' && c.source === 'sdk'));
  assert.ok(merged.some((c) => c.name === 'brainstorming' && c.source === 'skill'));
  assert.deepEqual(mergeCommands(null).length, LOCAL_COMMANDS.length);
});

test('groupCommands groups Local / Skills / Commands and filters fuzzily', () => {
  const merged = mergeCommands(SERVER);
  assert.deepEqual(groupCommands(merged, '').map((g) => g.label), ['Local', 'Skills', 'Commands']);
  const comp = groupCommands(merged, 'comp');
  assert.equal(comp[0].label, 'Commands');
  assert.equal(comp[0].items[0].name, 'compact');
  const brain = groupCommands(merged, 'brain');
  assert.deepEqual(brain.map((g) => g.label), ['Skills']);
  // Description matches count for longer queries.
  assert.ok(groupCommands(merged, 'pull request').some((g) => g.items.some((c) => c.name === 'review')));
  assert.deepEqual(groupCommands(merged, 'zzzz'), []);
});

test('parseLocalCommand recognizes only local commands', () => {
  assert.deepEqual(parseLocalCommand('/clear'), { name: 'clear', args: '' });
  assert.deepEqual(parseLocalCommand('  /rename   New title here '), { name: 'rename', args: 'New title here' });
  assert.equal(parseLocalCommand('/compact'), null);
  assert.equal(parseLocalCommand('/brainstorming ideas'), null);
  assert.equal(parseLocalCommand('please /clear'), null);
  assert.equal(parseLocalCommand(''), null);
});

test('command cache fetches once per cwd and refreshes after five minutes', async () => {
  let now = 0;
  const calls = [];
  const cache = createCommandCache({ load: async (cwd) => (calls.push(cwd), SERVER), now: () => now });
  assert.equal(cache.peek('/a'), null);
  const first = await cache.ensure('/a');
  assert.ok(first.some((c) => c.name === 'compact'));
  await cache.ensure('/a');
  assert.deepEqual(calls, ['/a']);
  await cache.ensure('/b');
  assert.deepEqual(calls, ['/a', '/b']);
  now = 5 * 60_000 - 1;
  assert.equal(cache.isStale('/a'), false);
  await cache.ensure('/a');
  assert.deepEqual(calls, ['/a', '/b']);
  now = 5 * 60_000;
  assert.equal(cache.isStale('/a'), true);
  // Stale entries are still served while refreshing.
  assert.ok(cache.peek('/a'));
  await cache.ensure('/a');
  assert.deepEqual(calls, ['/a', '/b', '/a']);
  // Concurrent calls share one request.
  now = 20 * 60_000;
  await Promise.all([cache.ensure('/a'), cache.ensure('/a')]);
  assert.equal(calls.length, 4);
});

/* Attachments */

const file = (name, size, type = 'text/plain') => ({ name, size, type });

test('checkFiles enforces 50 MB per file and 10 files per message', () => {
  assert.equal(MAX_FILE_BYTES, 50 * 1024 * 1024);
  const small = Array.from({ length: 4 }, (_, i) => file(`f${i}.txt`, 100));
  assert.equal(checkFiles(small).accepted.length, 4);
  assert.deepEqual(checkFiles(small).problems, []);

  const big = checkFiles([file('huge.mov', MAX_FILE_BYTES + 1), file('ok.png', MAX_FILE_BYTES)]);
  assert.deepEqual(big.accepted.map((f) => f.name), ['ok.png']);
  assert.deepEqual(big.problems, ['huge.mov is over the 50 MB limit.']);

  const many = checkFiles(Array.from({ length: 5 }, (_, i) => file(`m${i}`, 1)), 7);
  assert.equal(many.accepted.length, MAX_FILES - 7);
  assert.match(many.problems[0], /up to 10 files.*2 were left out/);

  const two = checkFiles([file('a', MAX_FILE_BYTES + 5), file('b', MAX_FILE_BYTES + 5)]);
  assert.deepEqual(two.problems, ['2 files are over the 50 MB limit.']);
  assert.match(checkFiles([file('x', 1)], 10).problems[0], /1 was left out/);
});

test('upload helpers: names, sizes, URL', () => {
  const at = new Date(2026, 9, 5, 9, 4, 7);
  assert.equal(uploadName(file('image.png', 1, 'image/png'), { pasted: true, now: at }), 'Pasted image 2026-10-05 09.04.07.png');
  assert.equal(uploadName(file('', 1, 'image/jpeg'), { pasted: true, now: at }), 'Pasted image 2026-10-05 09.04.07.jpg');
  assert.equal(uploadName(file('diagram.png', 1, 'image/png'), { pasted: true, now: at }), 'diagram.png');
  assert.equal(uploadName(file('image.png', 1, 'image/png')), 'image.png');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
  assert.equal(uploadUrl('draft', 'a b&c.png'), '/api/uploads?scope=draft&name=a%20b%26c.png');
});

class FakeXHR {
  static last = null;
  constructor() {
    FakeXHR.last = this;
    this.headers = {};
    this.upload = {};
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send(body) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status, data) {
    this.status = status;
    this.responseText = JSON.stringify(data);
    this.onload();
  }
}

test('uploadFile posts the raw file with its type and reports progress', async () => {
  const blob = { name: 'shot.png', size: 10, type: 'image/png' };
  const progress = [];
  const { promise } = uploadFile(blob, { scope: 's1', name: 'shot.png', onProgress: (p) => progress.push(p), XHR: FakeXHR });
  const xhr = FakeXHR.last;
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, '/api/uploads?scope=s1&name=shot.png');
  assert.equal(xhr.headers['Content-Type'], 'image/png');
  assert.equal(xhr.body, blob);
  xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
  xhr.respond(200, { id: 'up1', name: 'shot.png', url: '/api/uploads/up1', image: true });
  assert.deepEqual(await promise, { id: 'up1', name: 'shot.png', url: '/api/uploads/up1', image: true });
  assert.deepEqual(progress, [0.5]);

  const failed = uploadFile({ name: 'a', size: 1, type: '' }, { scope: 'draft', XHR: FakeXHR });
  assert.equal(FakeXHR.last.headers['Content-Type'], 'application/octet-stream');
  FakeXHR.last.respond(500, { error: 'Disk full' });
  await assert.rejects(failed.promise, /Disk full/);

  const aborted = uploadFile({ name: 'a', size: 1, type: '' }, { scope: 'draft', XHR: FakeXHR });
  aborted.abort();
  await assert.rejects(aborted.promise, (error) => error.aborted === true);
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

test('draft attachments persist, move to a new session, and clear once sent', () => {
  const storage = memoryStorage();
  const a = { id: 'u1', name: 'a.png', url: '/api/uploads/u1', image: true };
  const b = { id: 'u2', name: 'b.txt', url: '/api/uploads/u2', image: false };
  writeAttachments(storage, null, [a, b]);
  assert.deepEqual(readAttachments(storage, null), [a, b]);
  assert.equal(attachmentsKey(null), 'mesh-code-attachments-new');

  moveNewAttachments(storage, 's1', [a, b]);
  assert.deepEqual(readAttachments(storage, 's1'), [a, b]);
  assert.deepEqual(readAttachments(storage, null), []);

  clearSentAttachments(storage, 's1', ['u1']);
  assert.deepEqual(readAttachments(storage, 's1'), [b]);
  clearSentAttachments(storage, 's1', ['u2']);
  assert.equal(storage.getItem(attachmentsKey('s1')), null);

  storage.setItem(attachmentsKey('bad'), '{not json');
  assert.deepEqual(readAttachments(storage, 'bad'), []);
});

/* Context ring */

test('contextUsage thresholds: warning above 70%, error above 90%', () => {
  assert.equal(contextUsage(null), null);
  assert.equal(contextUsage({ used: 10, window: 0 }), null);
  assert.deepEqual(contextUsage({ used: 62_000, window: 200_000 }), { ratio: 0.31, percent: 31, tone: 'normal', label: '62k / 200k tokens (31%)', compactAt: null });
  assert.equal(contextUsage({ used: 62_000, window: 200_000, compactAt: 127_000 }).compactAt, 127_000);
  assert.equal(contextUsage({ used: 62_000, window: 200_000, compactAt: 250_000 }).compactAt, null, 'past the window: unknown');
  assert.equal(contextUsage({ used: 140_000, window: 200_000 }).tone, 'normal');
  assert.equal(contextUsage({ used: 140_001, window: 200_000 }).tone, 'warning');
  assert.equal(contextUsage({ used: 180_000, window: 200_000 }).tone, 'warning');
  assert.equal(contextUsage({ used: 180_001, window: 200_000 }).tone, 'error');
  assert.equal(contextUsage({ used: 300_000, window: 200_000 }).ratio, 1);
  assert.equal(contextTone(0.5), 'normal');
  assert.equal(contextUsage({ used: 1_250_000, window: 1_000_000 }).label, '1.3M / 1.0M tokens (100%)');
});

/* Esc twice */

test('createDoublePress fires only on a second press within the window', () => {
  let now = 1000;
  const stop = createDoublePress({ windowMs: 1500, now: () => now });
  assert.equal(stop.press(), 'armed');
  assert.equal(stop.armed, true);
  now += 1500;
  assert.equal(stop.press(), 'fire');
  assert.equal(stop.armed, false);
  // A slow second press re-arms instead of firing.
  assert.equal(stop.press(), 'armed');
  now += 1501;
  assert.equal(stop.armed, false);
  assert.equal(stop.press(), 'armed');
  stop.reset();
  assert.equal(stop.press(), 'armed');
  assert.equal(stop.press(), 'fire');
});

test('isTextEntry spots fields that take typed characters', () => {
  const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, ...extra });
  assert.equal(isTextEntry(el('TEXTAREA')), true);
  assert.equal(isTextEntry(el('INPUT', { type: 'text' })), true);
  assert.equal(isTextEntry(el('INPUT', { type: 'search' })), true);
  assert.equal(isTextEntry(el('INPUT', { type: 'radio' })), false);
  assert.equal(isTextEntry(el('BUTTON')), false);
  assert.equal(isTextEntry(el('DIV', { isContentEditable: true })), true);
  assert.equal(isTextEntry(null), false);
});

/* Approvals */

test('approval kinds and titles', () => {
  assert.equal(approvalKind({ kind: 'plan', tool: 'Bash' }), 'plan');
  assert.equal(approvalKind({ tool: 'AskUserQuestion' }), 'question');
  assert.equal(approvalKind({ tool: 'ExitPlanMode' }), 'plan');
  assert.equal(approvalKind({ tool: 'Bash' }), 'permission');
  assert.equal(permissionTitle('Bash'), 'Run a command?');
  assert.equal(permissionTitle('Edit'), 'Edit a file?');
  assert.equal(permissionTitle('MultiEdit'), 'Edit a file?');
  assert.equal(permissionTitle('Write'), 'Write a file?');
  assert.equal(permissionTitle('WebFetch'), 'Fetch a URL?');
  assert.equal(permissionTitle('WebSearch'), 'Search the web?');
  assert.equal(permissionTitle('mcp__meshy__web_search'), 'Search the web?', "Harbor's web search for gateway models");
  assert.equal(permissionTitle('mcp__github__create_issue'), 'Use github · create_issue?');
  assert.equal(permissionTitle('TodoWrite'), 'Use TodoWrite?');
  assert.equal(permissionTitle('Skill', 'Run skill'), 'Run skill?');
  assert.equal(permissionTitle('Bash', 'Run command'), 'Run a command?');
  assert.deepEqual(mcpParts('mcp__claude_ai_Slack__send'), { server: 'claude_ai_Slack', tool: 'send' });
  assert.equal(mcpParts('Bash'), null);
});

test('suggestionRules and allowRuleTexts render permission rules', () => {
  const suggestions = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'deny', destination: 'session' },
  ];
  assert.deepEqual(suggestionRules(suggestions), ['Bash(npm test:*)', 'Read', 'access to /tmp/x', 'switches the session to Accept edits']);
  assert.deepEqual(suggestionItems(suggestions).map((i) => i.type), ['rule', 'rule', 'directory', 'mode']);
  assert.deepEqual(suggestionRules([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run *' }], behavior: 'allow' }]), ['Bash(npm run *)']);
  assert.deepEqual(suggestionRules(undefined), []);
  assert.deepEqual(allowRuleTexts(['Bash(git status)', { toolName: 'WebFetch', ruleContent: 'domain:docs.rs' }, suggestions[0]]), [
    'Bash(git status)',
    'WebFetch(domain:docs.rs)',
    'Bash(npm test:*)',
    'Read',
  ]);
  assert.deepEqual(allowRuleTexts(null), []);
});

test('question answers are keyed by question text; multi-select joins with ", "', () => {
  const questions = [
    { question: 'Which DB?', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { question: 'Which features?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Billing' }] },
  ];
  const states = [
    { picked: ['SQLite'], otherText: '' },
    { picked: [], otherText: ' Webhooks ' },
  ];
  assert.deepEqual(buildAnswers(questions, states), { 'Which DB?': 'SQLite', 'Which features?': 'Webhooks' });
  // The text is a note on the pick, or the answer when nothing is picked.
  assert.equal(questionAnswer(questions[0], { picked: ['SQLite'], otherText: 'DuckDB later' }), 'SQLite — Note: DuckDB later');
  assert.equal(questionAnswer(questions[1], { picked: ['Auth', 'Billing'], otherText: 'Webhooks too' }), 'Auth, Billing — Note: Webhooks too');
  // An empty note leaves the pick alone.
  assert.equal(questionAnswer(questions[0], { picked: ['Postgres'], otherText: '  ' }), 'Postgres');
  assert.equal(allAnswered(questions, states), true);
  assert.equal(allAnswered(questions, [states[0], { picked: [], otherText: '' }]), false);
});

test('approvalBody builds v2 bodies and keeps v1 allow', () => {
  assert.deepEqual(approvalBody('allow'), { decision: 'allow', allow: true });
  assert.deepEqual(approvalBody('allowAlways'), { decision: 'allowAlways', allow: true });
  assert.deepEqual(approvalBody('deny', { reason: '  use pnpm  ' }), { decision: 'deny', allow: false, reason: 'use pnpm' });
  assert.deepEqual(approvalBody('deny', { reason: '   ' }), { decision: 'deny', allow: false });
  assert.deepEqual(approvalBody('allow', { mode: 'acceptEdits' }), { decision: 'allow', allow: true, mode: 'acceptEdits' });
  assert.deepEqual(approvalBody('allow', { answers: { 'Q?': 'A' } }), { decision: 'allow', allow: true, answers: { 'Q?': 'A' } });
});

test('planMode keeps the model to its supported modes', () => {
  assert.equal(planMode('acceptEdits', ['default', 'acceptEdits', 'plan']), 'acceptEdits');
  assert.equal(planMode('auto', ['default', 'acceptEdits', 'plan', 'bypassPermissions']), 'default');
  assert.equal(planMode('acceptEdits', null), 'acceptEdits');
});

test('planText prefers the plan file and falls back to the inline plan of the same call', () => {
  const pending = { kind: 'plan', toolUseID: 'toolu_1', input: {} };
  const recorded = { text: '# Plan\n\n1. Do it', at: 1, toolId: 'toolu_1' };
  assert.equal(planText({ ...pending, input: { plan: '# From file' } }, recorded), '# From file');
  assert.equal(planText(pending, recorded), '# Plan\n\n1. Do it');
  assert.equal(planText(pending, { ...recorded, toolId: 'toolu_other' }), '', 'an older plan is not shown');
  assert.equal(planText({ ...pending, input: { plan: '  ' } }, null), '');
  assert.equal(planText(null, null), '');
});

test('waitingLabel', () => {
  assert.equal(waitingLabel(0), '0:00');
  assert.equal(waitingLabel(7_400), '0:07');
  assert.equal(waitingLabel(272_000), '4:32');
  assert.equal(waitingLabel(3_900_000), '1h 05m');
});

/* Approval diffs */

test('lineDiff produces add / del / context rows', () => {
  const rows = lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(
    rows.map((r) => `${r.type}:${r.text}`),
    ['context:a', 'del:b', 'add:B', 'context:c', 'add:d'],
  );
  assert.deepEqual(countRows(rows), { adds: 2, dels: 1 });
  assert.deepEqual(lineDiff('', 'x\ny\n').map((r) => [r.type, r.newNo]), [['add', 1], ['add', 2]]);
  assert.deepEqual(lineDiff('same', 'same').map((r) => r.type), ['context']);
});

test('fileChangeBlocks covers Edit, MultiEdit and Write', () => {
  assert.equal(fileChangeBlocks('Bash', { command: 'ls' }), null);
  const edit = fileChangeBlocks('Edit', { file_path: '/x', old_string: 'let a = 1;', new_string: 'const a = 1;' });
  assert.equal(edit.length, 1);
  assert.deepEqual([edit[0].adds, edit[0].dels], [1, 1]);
  const multi = fileChangeBlocks('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'c\nd' }] });
  assert.deepEqual(multi.map((b) => b.title), ['Edit 1 of 2', 'Edit 2 of 2']);
  const write = fileChangeBlocks('Write', { content: 'one\ntwo\n' });
  assert.deepEqual([write[0].adds, write[0].dels], [2, 0]);
});
