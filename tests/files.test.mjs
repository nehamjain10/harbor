import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { UNTRACKED_HINTS_NOTICE, UNTRACKED_SKIPPED_NOTICE, createChangesCache, gitChanges, listProjects, previewFile, projectPath, safePath, writtenFiles } from '../server/files.mjs';

// Layout:
//   <tmp>/outside/secret.txt
//   <tmp>/home/                    <- root
//   <tmp>/home/project/notes.txt
//   <tmp>/home/project/.env, .git/, node_modules/, src/, blob.bin
//   <tmp>/home/project/escape   -> <tmp>/outside       (symlink out of root)
//   <tmp>/home/project/inner    -> <tmp>/home/other    (symlink within root)
//   <tmp>/home/other/
let base;
let root;
let project;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-files-')));
  root = path.join(base, 'home');
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, 'other'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(project, 'src'));
  fs.mkdirSync(path.join(project, 'node_modules'));
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(project, '.env'), 'TOKEN=x');
  fs.writeFileSync(path.join(project, 'blob.bin'), Buffer.from([1, 0, 2]));
  fs.symlinkSync(path.join(base, 'outside'), path.join(project, 'escape'));
  fs.symlinkSync(path.join(root, 'other'), path.join(project, 'inner'));
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const isForbidden = (error) =>
  error.status === 403 && error.message === 'Choose a folder inside your home directory.';

describe('safePath', () => {
  test('accepts the root itself and paths inside it', async () => {
    assert.equal(await safePath('', { root }), root);
    assert.equal(await safePath('.', { root }), root);
    assert.equal(await safePath('project', { root }), project);
    assert.equal(await safePath(project, { root }), project);
    assert.equal(await safePath('notes.txt', { root, base: project }), path.join(project, 'notes.txt'));
  });

  test('rejects .. escapes', async () => {
    await assert.rejects(safePath('..', { root }), isForbidden);
    await assert.rejects(safePath('../outside/secret.txt', { root }), isForbidden);
    await assert.rejects(safePath('../../outside', { root, base: project }), isForbidden);
  });

  test('rejects absolute paths outside the root', async () => {
    await assert.rejects(safePath(path.join(base, 'outside'), { root }), isForbidden);
    await assert.rejects(safePath('/', { root }), isForbidden);
  });

  test('rejects symlinks that point outside the root', async () => {
    await assert.rejects(safePath('project/escape', { root }), isForbidden);
    await assert.rejects(safePath('escape/secret.txt', { root, base: project }), isForbidden);
  });

  test('follows symlinks that stay inside the root', async () => {
    assert.equal(await safePath('project/inner', { root }), path.join(root, 'other'));
  });

  test('rejects a sibling directory that only shares the prefix', async () => {
    const sibling = root + '-evil';
    fs.mkdirSync(sibling);
    try {
      await assert.rejects(safePath(sibling, { root }), isForbidden);
    } finally {
      fs.rmSync(sibling, { recursive: true });
    }
  });

  test('missing paths fail', async () => {
    await assert.rejects(safePath('does-not-exist', { root }), { code: 'ENOENT' });
  });
});

describe('projectPath', () => {
  test('requires a directory', async () => {
    assert.equal(await projectPath('project', root), project);
    await assert.rejects(projectPath('project/notes.txt', root), { message: 'Choose a directory' });
  });
});

describe('listProjects', () => {
  test('lists visible subdirectories with the parent link', async () => {
    const listing = await listProjects(undefined, root);
    assert.equal(listing.path, root);
    assert.equal(listing.parent, null);
    assert.deepEqual(listing.items.map((item) => item.name), ['other', 'project']);

    const inner = await listProjects(project, root);
    assert.equal(inner.parent, root);
    // Symlinks, dot-folders and node_modules are not offered as projects.
    assert.deepEqual(inner.items.map((item) => item.name), ['src']);
    assert.equal(listing.items.find((item) => item.name === 'project').git, true);
  });
});

describe('previewFile', () => {
  test('lists a project directory without env files', async () => {
    const listing = await previewFile(project, undefined);
    assert.equal(listing.directory, true);
    assert.equal(listing.path, '');
    const names = listing.items.map((item) => item.name);
    for (const hidden of ['.env', '.git', 'node_modules']) assert.ok(!names.includes(hidden), hidden);
    assert.equal(listing.items[0].name, 'src', 'directories first');
    assert.ok(listing.items.some((item) => item.name === 'notes.txt'));
  });

  test('reads text files', async () => {
    assert.deepEqual(await previewFile(project, 'notes.txt'), {
      path: 'notes.txt',
      directory: false,
      content: 'hello',
    });
  });

  test('shows files outside the project by their absolute path', async () => {
    const other = await previewFile(project, '../other');
    assert.equal(other.path, path.join(root, 'other'));
    assert.equal(other.directory, true);
    const secret = await previewFile(project, 'escape/secret.txt');
    assert.equal(secret.path, fs.realpathSync(path.join(project, 'escape/secret.txt')));
    assert.equal(secret.directory, false);
  });

  test('refuses binary files', async () => {
    await assert.rejects(previewFile(project, 'blob.bin'), { status: 415 });
  });
});

describe('gitChanges', () => {
  // Isolated from the user's git config: no signing, no hooks, fixed identity.
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd });
  let previousCeiling;

  before(() => {
    // Never let git discover a repository above the temp dir.
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
  });

  after(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });

  function makeRepo(name) {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    return repo;
  }

  test('a folder that is not a repository gets the error shape', async () => {
    assert.deepEqual(await gitChanges(path.join(root, 'other'), root), {
      diff: '',
      status: '',
      branch: '',
      files: [],
      error: 'This folder is not a Git repository.',
    });
  });

  test('other git failures say changes are unavailable, with git\'s reason', async () => {
    const repo = makeRepo('repo-broken');
    // A corrupt index makes `git status` fail.
    fs.writeFileSync(path.join(repo, '.git', 'index'), 'garbage');
    const changes = await gitChanges(repo, root);
    assert.deepEqual([changes.diff, changes.files], ['', []]);
    assert.match(changes.error, /^Git changes are unavailable: .*index/);
    const missing = await gitChanges(path.join(root, 'does-not-exist'), root);
    assert.equal(missing.error, 'The project folder no longer exists.');
  });

  test('tracked edits and untracked text files are diffed; env files, escapes and binaries are left out', async () => {
    const repo = makeRepo('repo-committed');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');

    fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh line\n');
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=dotenv\n');
    fs.writeFileSync(path.join(repo, '.env.local'), 'TOKEN=dotenvlocal\n');
    fs.mkdirSync(path.join(repo, 'config', '.env.d'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', '.env.d', 'prod'), 'TOKEN=nested\n');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(repo, 'huge.txt'), 'x'.repeat(100_001));
    // Inside the root but outside this project, and outside the root entirely.
    fs.writeFileSync(path.join(root, 'other', 'neighbour.txt'), 'NEIGHBOUR\n');
    fs.symlinkSync(path.join(root, 'other', 'neighbour.txt'), path.join(repo, 'link-neighbour'));
    fs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(repo, 'link-secret'));

    const changes = await gitChanges(repo, root);
    assert.equal(changes.error, undefined);
    assert.equal(changes.branch, 'main');
    assert.match(changes.status, / M tracked\.txt/);
    assert.match(changes.status, /\?\? new\.txt/);
    assert.match(changes.diff, /-one\n\+two/);
    assert.match(changes.diff, /diff --git a\/new\.txt b\/new\.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+fresh line\n(?!\+)/);
    for (const hidden of ['TOKEN', 'NEIGHBOUR', 'secret', 'link-', 'blob.bin', 'huge.txt']) {
      assert.ok(!changes.diff.includes(hidden), `diff must not include ${hidden}`);
    }
  });

  test('files lists each change with status and line counts (numstat + porcelain)', async () => {
    const repo = makeRepo('repo-files');
    fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
    const dated = 'docs/plans/2026-10-05-workbench-v2-api.md';
    fs.writeFileSync(path.join(repo, dated), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
    fs.writeFileSync(path.join(repo, 'old-name.txt'), 'same content\nacross a rename\n');
    fs.writeFileSync(path.join(repo, 'image.bin'), Buffer.from([1, 0, 2]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    fs.writeFileSync(path.join(repo, dated), 'a\nB\nc\nd\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    fs.writeFileSync(path.join(repo, 'image.bin'), Buffer.from([3, 0, 4]));
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'one\ntwo\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'untracked file.txt'), 'x\ny\nz');
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=1\n');
    fs.writeFileSync(path.join(repo, 'empty.txt'), '');

    const changes = await gitChanges(repo, root);
    assert.equal(changes.error, undefined);
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, [f.status, f.adds, f.dels]]));
    assert.deepEqual(byPath, {
      [dated]: ['modified', 2, 1],
      'gone.txt': ['deleted', 0, 1],
      'new-name.txt': ['renamed', 0, 0],
      'image.bin': ['modified', 0, 0],
      'staged.txt': ['added', 2, 0],
      'untracked file.txt': ['untracked', 3, 0],
      'empty.txt': ['untracked', 0, 0],
    });
    // Every listed text change has its diff under the same path.
    for (const file of [dated, 'gone.txt', 'staged.txt', 'untracked file.txt', 'empty.txt']) {
      assert.ok(changes.diff.includes(`+++ b/${file}`) || changes.diff.includes(`--- a/${file}`) || changes.diff.includes(`b/${file}\n`), file);
    }
    assert.match(changes.diff, /\+\+\+ b\/untracked file\.txt\n@@ -0,0 \+1,3 @@\n\+x\n\+y\n\+z\n\\ No newline at end of file\n/);
  });

  test('a slow untracked scan is cut short: tracked changes, the session\'s own new files and a notice', async () => {
    const repo = makeRepo('repo-slow');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'written.py'), 'print(1)\n');
    fs.writeFileSync(path.join(repo, 'stray.log'), 'not from this session\n');
    const hints = [path.join(repo, 'src', 'written.py'), 'tracked.txt', path.join(root, 'other', 'secret.txt'), '/etc/passwd'];

    // A git whose full untracked scan hangs (a pathspec-limited one does not).
    const bin = path.join(base, 'slow-git');
    fs.mkdirSync(bin, { recursive: true });
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = --others ] && others=1; [ "$a" = -- ] && limited=1; done\n[ -n "$others" ] && [ -z "$limited" ] && exec sleep 5\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    let cut;
    try {
      cut = await gitChanges(repo, root, { hints, scanMs: 300 });
    } finally {
      process.env.PATH = previousPath;
    }
    assert.equal(cut.error, undefined);
    assert.equal(cut.notice, UNTRACKED_HINTS_NOTICE);
    assert.deepEqual(cut.files.map((f) => [f.path, f.status]), [['tracked.txt', 'modified'], ['src/written.py', 'untracked']]);
    assert.match(cut.diff, /-one\n\+two/);
    assert.match(cut.diff, /\+\+\+ b\/src\/written\.py/);
    assert.ok(!cut.diff.includes('stray'));

    // The folder is remembered as slow: no full scan for a while, even with time to spare.
    const again = await gitChanges(repo, root, { hints: [] });
    assert.equal(again.notice, UNTRACKED_SKIPPED_NOTICE);
    assert.deepEqual(again.files.map((f) => f.path), ['tracked.txt']);
  });

  test('writtenFiles: files written or edited in the session, newest first', () => {
    const tool = (name, input) => ({ role: 'tool', tool: name, input });
    const messages = [
      tool('Write', { file_path: '/p/a.py' }),
      tool('Read', { file_path: '/p/read-only.py' }),
      { role: 'assistant', text: 'file_path: /p/nope' },
      tool('Edit', { file_path: '/p/b.py' }),
      tool('NotebookEdit', { notebook_path: '/p/n.ipynb' }),
      tool('MultiEdit', { file_path: '/p/a.py' }),
      tool('Bash', { command: 'touch /p/c.py' }),
    ];
    assert.deepEqual(writtenFiles(messages), ['/p/a.py', '/p/n.ipynb', '/p/b.py']);
    assert.deepEqual(writtenFiles(undefined), []);
  });

  test('a repository without commits compares with the empty tree', async () => {
    const repo = makeRepo('repo-fresh');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged then edited\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'hello\n');
    const changes = await gitChanges(repo, root);
    assert.equal(changes.error, undefined);
    assert.equal(changes.branch, 'main');
    assert.match(changes.diff, /\+staged then edited/);
    assert.match(changes.diff, /\+\+\+ b\/untracked\.txt/);
    assert.deepEqual(changes.files, [
      { path: 'staged.txt', status: 'added', adds: 1, dels: 0 },
      { path: 'untracked.txt', status: 'untracked', adds: 1, dels: 0 },
    ]);
  });
});

describe('createChangesCache', () => {
  test('joins a run in progress, reuses a recent result, and reruns when fresh or expired', async () => {
    let clock = 1000;
    const runs = [];
    const run = (cwd, root, { hints }) =>
      new Promise((resolve) => {
        runs.push({ cwd, hints, resolve });
      });
    const changes = createChangesCache({ ttlMs: 5000, run, now: () => clock });
    const first = changes('/p', '/', { hints: ['a'] });
    const joined = changes('/p', '/', { hints: ['a'] });
    assert.equal(joined, first, 'a run in progress is shared');
    assert.equal(runs.length, 1);
    changes('/p', '/', { hints: ['b'] });
    assert.equal(runs.length, 2, 'other hints are another run');
    runs[0].resolve({ files: [1] });
    assert.deepEqual(await first, { files: [1] });

    clock += 4000;
    assert.equal(changes('/p', '/', { hints: ['a'] }), first, 'reused within the TTL');
    const fresh = changes('/p', '/', { hints: ['a'], fresh: true });
    assert.notEqual(fresh, first);
    assert.equal(runs.length, 3);
    runs[2].resolve({ files: [2] });
    await fresh;
    assert.equal(changes('/p', '/', { hints: ['a'] }), fresh, 'the fresh result is the cached one now');
    clock += 5000;
    changes('/p', '/', { hints: ['a'] });
    assert.equal(runs.length, 4, 'expired');
  });
});
