// The pure helpers of the settings dialog (src/lib/settings.js), the API wrapper's
// error data and the shared server modules the dialog bundles. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, request } from '../src/api.js';
import {
  duplicateProblem,
  fileSize,
  hookRows,
  hooksText,
  joinEol,
  memoryNameProblem,
  memoryStem,
  parseHooksDraft,
  permissionsPatch,
  permissionsText,
  projectChoices,
  savedText,
  splitEol,
  tabFromArg,
} from '../src/lib/settings.js';

test('tabFromArg maps the words after /settings to a tab id', () => {
  assert.equal(tabFromArg('memory'), 'memory');
  assert.equal(tabFromArg('  Hooks '), 'hooks');
  assert.equal(tabFromArg('CLAUDE.md'), 'instructions');
  assert.equal(tabFromArg('rules'), 'permissions');
  assert.equal(tabFromArg(''), null);
  assert.equal(tabFromArg('mcp'), 'mcp');
  assert.equal(tabFromArg('nonsense'), null);
  assert.equal(tabFromArg(undefined), null);
});

test('savedText says how many running sessions restart', () => {
  assert.equal(savedText({ changed: true, restartsPending: 2 }), 'Saved · applies to 2 sessions after their next restart');
  assert.equal(savedText({ changed: true, restartsPending: 1 }), 'Saved · applies to 1 session after its next restart');
  assert.equal(savedText({ changed: true, restartsPending: 0 }), 'Saved · no running sessions to restart');
  assert.equal(savedText({ changed: true, restartsPending: 0 }, { live: true }), 'Saved');
  assert.equal(savedText({ changed: true, restartsPending: 3 }, { verb: 'Deleted' }), 'Deleted · applies to 3 sessions after their next restart');
  assert.equal(savedText({ changed: false, restartsPending: 0 }), 'Nothing changed.');
});

test('line endings: a textarea works in \\n, the file keeps its own', () => {
  assert.deepEqual(splitEol('a\r\nb\r\n'), { text: 'a\nb\n', eol: '\r\n' });
  assert.deepEqual(splitEol('a\nb\n'), { text: 'a\nb\n', eol: '\n' });
  assert.equal(joinEol('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(joinEol('a\nb\n', '\n'), 'a\nb\n');
  assert.equal(fileSize(812), '812 B');
  assert.equal(fileSize(3481), '3.4 KB');
  assert.equal(fileSize(52_000), '51 KB');
});

test('permissions: the text for diffs and the PATCH body of what changed', () => {
  const base = { allow: ['Bash(ls)', 'Read'], ask: [], deny: ['Bash(rm:*)'], defaultMode: 'plan', additionalDirectories: [] };
  assert.equal(permissionsText(base), 'defaultMode: plan\nallow:\n  Bash(ls)\n  Read\ndeny:\n  Bash(rm:*)\n');
  assert.equal(permissionsText({}), '');
  assert.deepEqual(permissionsPatch(base, { ...base }), {});
  assert.deepEqual(permissionsPatch(base, { ...base, allow: ['Bash(ls)'] }), { allow: ['Bash(ls)'] });
  assert.deepEqual(permissionsPatch(base, { ...base, ask: ['Bash(git push:*)'], defaultMode: null }), { ask: ['Bash(git push:*)'], defaultMode: null });
  assert.deepEqual(permissionsPatch(base, { ...base, allow: ['Read', 'Bash(ls)'] }), { allow: ['Read', 'Bash(ls)'] }, 'order is part of the file');
  assert.equal(duplicateProblem(['a', 'b'], 'b'), 'This one is already in the list.');
  assert.equal(duplicateProblem(['a', 'b'], 'b', 1), null, 'editing a rule to itself is fine');
  assert.equal(duplicateProblem(['a', 'b'], 'c'), null);
});

test('hooks: draft text is checked against the schema; rows are for display', () => {
  assert.equal(hooksText({}), '{}\n');
  assert.equal(hooksText(undefined), '{}\n');
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './a.sh', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], Mystery: [] };
  assert.deepEqual(parseHooksDraft(hooksText(hooks)), { hooks });
  assert.deepEqual(parseHooksDraft('  '), { hooks: {} }, 'blank means no hooks');
  assert.match(parseHooksDraft('{').error, /^Invalid JSON: /);
  assert.match(parseHooksDraft('[]').error, /keyed by event name/);
  assert.equal(parseHooksDraft('{"Stop": {}}').error, 'hooks.Stop must be a list of matcher groups.');
  assert.equal(parseHooksDraft('{"Stop": [{"hooks": [{"type": "command"}]}]}').error, 'hooks.Stop[0].hooks[0].command must be the command to run.');
  assert.deepEqual(hookRows(hooks), [
    { event: 'PreToolUse', known: true, groups: [{ matcher: 'Bash', hooks: [{ type: 'command', summary: './a.sh', timeout: 5 }] }] },
    { event: 'Stop', known: true, groups: [{ matcher: '', hooks: [{ type: 'command', summary: 'say done', timeout: undefined }] }] },
    { event: 'Mystery', known: false, groups: [] },
  ]);
  assert.deepEqual(hookRows(null), []);
});

test('memory file names: a stem from the title, and what is refused', () => {
  assert.equal(memoryStem('Release checklist v2!'), 'release-checklist-v2');
  assert.equal(memoryStem('  --Hello, World--  '), 'hello-world');
  assert.equal(memoryStem(''), '');
  assert.equal(memoryNameProblem('', []), 'Give the file a name.');
  assert.equal(memoryNameProblem('MEMORY', []), 'MEMORY.md is the index.');
  assert.equal(memoryNameProblem('memory', []), 'MEMORY.md is the index.', 'case-insensitive filesystems');
  assert.equal(memoryNameProblem('a/b', []), 'Use letters, digits, dots, dashes and underscores.');
  assert.equal(memoryNameProblem('.hidden', []), 'Use letters, digits, dots, dashes and underscores.');
  assert.equal(memoryNameProblem('alpha', ['Alpha.md']), 'A memory with this name exists.');
  assert.equal(memoryNameProblem('alpha', ['beta.md']), null);
});

test('projectChoices: the chat first, no repeats, no blanks', () => {
  const sessions = [{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/a' }, { cwd: '' }];
  assert.deepEqual(projectChoices({ cwd: '/b', project: '/c', defaultProject: '/a', sessions }), ['/b', '/c', '/a']);
  assert.deepEqual(projectChoices({ cwd: '', project: '', defaultProject: '', sessions: [] }), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ cwd: `/p${i}` }));
  assert.equal(projectChoices({ sessions: many }).length, 30);
});

test('api: put/delete use the verb, and an error keeps the whole body (a 409 carries the file as it is now)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'DELETE') return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    return new Response(JSON.stringify({ error: 'This file changed on disk since you opened it.', conflict: true, current: { version: 'v2' } }), { status: 409 });
  };
  assert.deepEqual(await request('DELETE', 'settings/memory/a.md?cwd=%2Fx', undefined, { fetchImpl }), { deleted: true });
  await assert.rejects(request('PUT', 'settings/files/user/claude-md', { content: 'x', version: 'v1' }, { fetchImpl }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.message, 'This file changed on disk since you opened it.');
    assert.deepEqual(error.data.current, { version: 'v2' });
    return true;
  });
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [['DELETE', '/api/settings/memory/a.md?cwd=%2Fx'], ['PUT', '/api/settings/files/user/claude-md']]);
  assert.equal(calls[1].body, '{"content":"x","version":"v1"}');
});
