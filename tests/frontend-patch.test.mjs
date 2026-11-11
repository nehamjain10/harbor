// The apply_patch parser (src/lib/patch.js) and the ApplyPatch tool summaries
// (imported Codex edits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch, patchFiles, patchStats, patchText } from '../src/lib/patch.js';
import { groupSummary, runningLabel, toolSummary } from '../src/lib/tools.js';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/app.py',
  '@@ def main():',
  '     args = parse()',
  '-    print("hi")',
  '+    print("hello")',
  '+    return 0',
  '@@',
  '-DEBUG = True',
  '+DEBUG = False',
  '',
  '*** End of File',
  '*** Add File: docs/notes.md',
  '+# Notes',
  '+',
  '+First line',
  '*** Delete File: old/legacy.py',
  '*** Update File: lib/a.js',
  '*** Move to: lib/b.js',
  '@@ export function a() {',
  '-  return 1;',
  '+  return 2;',
  '*** End Patch',
].join('\n');

test('parsePatch: update, add, delete and move sections', () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(
    files.map((f) => [f.path, f.movePath, f.status, f.adds, f.dels]),
    [
      ['src/app.py', '', 'modified', 3, 2],
      ['docs/notes.md', '', 'added', 3, 0],
      ['old/legacy.py', '', 'deleted', 0, 0],
      ['lib/a.js', 'lib/b.js', 'renamed', 1, 1],
    ],
  );
  const rows = files[0].rows.map((r) => `${r.type}:${r.text}`);
  assert.deepEqual(rows, [
    'hunk:def main():',
    'context:    args = parse()',
    'del:    print("hi")',
    'add:    print("hello")',
    'add:    return 0',
    'hunk:⋯',
    'del:DEBUG = True',
    'add:DEBUG = False',
  ]);
  assert.deepEqual(files[1].rows.map((r) => r.text), ['# Notes', '', 'First line']);
  assert.deepEqual(files[2].rows, []);
  assert.deepEqual(patchStats(files), { adds: 7, dels: 3 });
});

test('parsePatch: a bare first @@ has no header; empty lines are context; CRLF and junk outside the envelope', () => {
  const text = "apply_patch <<'EOF'\r\n*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n one\r\n\r\n-two\r\n+2\r\n*** End Patch\r\nEOF\r\n";
  const [file] = parsePatch(text);
  assert.deepEqual(file.rows.map((r) => `${r.type}:${r.text}`), ['context:one', 'context:', 'del:two', 'add:2']);
  assert.equal(parsePatch('EOF').length, 0, 'nothing outside a file section');
  assert.deepEqual(parsePatch(''), []);
  assert.deepEqual(parsePatch(null), []);
});

test('patchText finds the patch in the shapes Codex uses', () => {
  assert.equal(patchText({ patch: PATCH }), PATCH);
  assert.equal(patchText({ input: PATCH }), PATCH);
  assert.equal(patchText(PATCH), PATCH);
  assert.equal(patchText({ command: ['apply_patch', PATCH] }), PATCH);
  assert.equal(patchText({ command: `apply_patch <<'EOF'\n${PATCH}\nEOF` }).includes('*** Begin Patch'), true);
  assert.equal(patchText({ command: 'ls' }), '');
  assert.equal(patchText(null), '');
});

test('patchFiles caches per input object', () => {
  const input = { patch: PATCH };
  assert.equal(patchFiles(input), patchFiles(input));
  assert.equal(patchFiles(input).length, 4);
});

test('ApplyPatch summaries: one file by name, several by count, files counted in groups', () => {
  const single = { tool: 'ApplyPatch', state: 'done', input: { patch: '*** Begin Patch\n*** Update File: /repo/src/app.py\n@@\n-a\n+b\n+c\n*** End Patch' } };
  const summary = toolSummary(single, '/repo');
  assert.deepEqual([summary.verb, summary.target, summary.kind, summary.path, summary.mono], ['Edited', 'src/app.py', 'edit', true, true]);
  assert.deepEqual(summary.stats, { adds: 2, dels: 1 });

  const several = { id: 'm2', tool: 'ApplyPatch', state: 'done', input: { patch: PATCH } };
  const many = toolSummary(several, '/repo');
  assert.deepEqual([many.verb, many.target, many.path, many.mono], ['Edited', '4 files', false, false]);
  assert.deepEqual(many.stats, { adds: 7, dels: 3 });
  assert.equal(runningLabel(several, '/repo'), 'Editing 4 files');

  // Four patched files plus an Edit of one of them (by absolute path) → 5 distinct paths.
  const edit = { id: 'm3', tool: 'Edit', input: { file_path: '/repo/other.py', old_string: 'a', new_string: 'b' } };
  assert.equal(groupSummary([several, edit, { id: 'm4', tool: 'Bash', input: { command: 'ls' } }]), 'Edited 5 files, ran 1 command');
  assert.equal(groupSummary([{ id: 'm5', tool: 'ApplyPatch', input: { patch: 'garbage' } }]), 'Edited 1 file', 'an unparsable patch counts once');
});

test('parsePatch: a context line reading "*** End Patch" does not end the file', () => {
  const patch = ['*** Begin Patch', '*** Update File: docs/patches.md', '@@', ' The envelope ends with', ' *** End Patch', '-old', '+new', '*** End Patch'].join('\n');
  const [file] = parsePatch(patch);
  assert.equal(file.path, 'docs/patches.md');
  assert.deepEqual(
    file.rows.filter((row) => row.type !== 'hunk').map((row) => [row.type, row.text]),
    [
      ['context', 'The envelope ends with'],
      ['context', '*** End Patch'],
      ['del', 'old'],
      ['add', 'new'],
    ],
  );
  assert.equal(file.adds, 1);
  assert.equal(file.dels, 1);
});
