import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createFileSearch, listProjectEntries, matchTier, rankEntries, withDirectories } from '../server/file-search.mjs';

const entries = (...paths) => withDirectories(paths);
const ranked = (list, query) => rankEntries(list, query).map((item) => item.path);

describe('ranking', () => {
  const files = entries(
    'server/runner.mjs',
    'tests/runner.test.mjs',
    'server/normalize.mjs',
    'run.sh',
    'docs/plans/2026-10-05-workbench-v2-api.md',
    'public/app.js',
    'server/app.mjs',
    'tests/app.test.mjs',
    'apps/web/app.mjs',
  );

  test('exact base name beats base-name prefix beats segment prefix beats subsequence', () => {
    const list = entries('lib/app', 'app.mjs', 'apples/readme.md', 'my/approach.txt', 'a/p/p.txt', 'xapp.txt');
    const tiers = Object.fromEntries(list.map((entry) => [entry.path, matchTier(entry, 'app')]));
    assert.deepEqual(tiers, {
      'lib/app': 0,
      lib: null,
      'app.mjs': 1,
      apples: 1,
      'my/approach.txt': 1,
      my: null,
      'apples/readme.md': 2,
      'xapp.txt': 3,
      'a/p/p.txt': 4,
      'a/p': null,
      a: null,
    });
    assert.deepEqual(ranked(list, 'app'), ['lib/app', 'apples', 'app.mjs', 'my/approach.txt', 'apples/readme.md', 'xapp.txt', 'a/p/p.txt']);
  });

  test('`runr` finds server/runner.mjs first (subsequence in the base name, shortest path)', () => {
    assert.deepEqual(ranked(files, 'runr').slice(0, 2), ['server/runner.mjs', 'tests/runner.test.mjs']);
  });

  test('shorter paths win ties, then alphabetical order; folders are candidates too', () => {
    assert.deepEqual(ranked(files, 'app.mjs'), ['server/app.mjs', 'apps/web/app.mjs', 'tests/app.test.mjs']);
    assert.deepEqual(ranked(files, 'app').slice(0, 5), ['apps', 'public/app.js', 'server/app.mjs', 'apps/web/app.mjs', 'tests/app.test.mjs']);
    assert.equal(rankEntries(files, 'serv')[0].directory, true);
  });

  test('queries are case-insensitive and may contain folders', () => {
    assert.deepEqual(ranked(files, 'SERVER/RUN'), ['server/runner.mjs']);
    assert.deepEqual(ranked(files, './server/app'), ['server/app.mjs']);
    assert.deepEqual(ranked(files, 'plans/2026'), ['docs/plans/2026-10-05-workbench-v2-api.md']);
  });

  test('an empty query lists the shortest paths; results are capped at 50', () => {
    assert.deepEqual(ranked(files, '').slice(0, 3), ['apps', 'docs', 'tests']);
    const many = entries(...Array.from({ length: 120 }, (_, index) => `src/file${index}.js`));
    assert.equal(rankEntries(many, 'file').length, 50);
    assert.equal(rankEntries(many, 'zzz').length, 0);
  });

  test('withDirectories derives folders, drops .env files and paths that leave the folder', () => {
    assert.deepEqual(withDirectories(['a/b/c.txt', 'a/d.txt', '.env', 'config/.env.local', '../up.txt', '/abs.txt', 'a//x', 'a/./y']), [
      { path: 'a/b/c.txt', directory: false },
      { path: 'a/b', directory: true },
      { path: 'a', directory: true },
      { path: 'a/d.txt', directory: false },
    ]);
  });
});

// Layout under <tmp>/:
//   repo/      git repository: tracked src/main.py, untracked notes.md, ignored build/out.bin, .env
//   plain/     no git: deep nesting, node_modules/, .cache/, .gitignore, .env.local
let base;
before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-search-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'src', 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(repo, 'build', 'out.bin'), 'x');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=x');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', 'src/main.py', '.gitignore');
  fs.writeFileSync(path.join(repo, 'notes.md'), '# notes');

  const plain = path.join(base, 'plain');
  fs.mkdirSync(path.join(plain, 'a/b/c/d/e/f/g'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'a/b/c/d/e/f/g/deep.txt'), 'too deep');
  fs.writeFileSync(path.join(plain, 'a/b/shallow.txt'), 'ok');
  fs.mkdirSync(path.join(plain, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'node_modules/pkg/index.js'), '');
  fs.mkdirSync(path.join(plain, '.cache'));
  fs.writeFileSync(path.join(plain, '.cache/blob'), '');
  fs.writeFileSync(path.join(plain, '.gitignore'), '');
  fs.writeFileSync(path.join(plain, '.env.local'), 'TOKEN=x');
  fs.symlinkSync(base, path.join(plain, 'loop'));
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('project listing', () => {
  test('git folders list tracked and untracked files plus folders, not ignored or .env files', async () => {
    const list = await listProjectEntries(path.join(base, 'repo'));
    assert.deepEqual(list.map((entry) => entry.path).sort(), ['.gitignore', 'notes.md', 'src', 'src/main.py']);
  });

  test('a subfolder of a repository lists paths relative to itself', async () => {
    const list = await listProjectEntries(path.join(base, 'repo', 'src'));
    assert.deepEqual(list, [{ path: 'main.py', directory: false }]);
  });

  test('other folders are walked to depth 6, skipping heavy and dot folders and not following links', async () => {
    const list = await listProjectEntries(path.join(base, 'plain'));
    const paths = list.map((entry) => entry.path);
    assert.ok(paths.includes('a/b/shallow.txt'));
    assert.ok(paths.includes('a/b/c/d/e/f'));
    assert.ok(!paths.some((item) => item.includes('deep.txt') || item.endsWith('/g')));
    assert.ok(!paths.some((item) => item.startsWith('node_modules') || item.startsWith('.cache')));
    assert.ok(paths.includes('.gitignore'));
    assert.ok(!paths.includes('.env.local'));
    assert.deepEqual(list.find((entry) => entry.path === 'loop'), { path: 'loop', directory: false });
  });

  test('the search caches each folder for a while and shares concurrent listings', async () => {
    let clock = 0;
    const calls = [];
    const search = createFileSearch({
      now: () => clock,
      ttlMs: 30_000,
      list: async (cwd) => {
        calls.push(cwd);
        return withDirectories(['src/main.py']);
      },
    });
    const [first, second] = await Promise.all([search.search('/p', 'main'), search.search('/p', 'src')]);
    assert.deepEqual(first, [{ path: 'src/main.py', directory: false }]);
    assert.deepEqual(second, [{ path: 'src', directory: true }, { path: 'src/main.py', directory: false }]);
    assert.equal(calls.length, 1);
    clock = 31_000;
    await search.search('/p', 'main');
    assert.equal(calls.length, 2);
  });

  test('a failing listing yields no results instead of an error', async () => {
    const search = createFileSearch({ list: async () => Promise.reject(new Error('boom')) });
    assert.deepEqual(await search.search('/p', 'x'), []);
  });
});
