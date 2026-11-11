import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileHref, fileReference } from '../src/lib/fileReference.js';

const ORIGIN = 'https://workbench.example:18544';

test('plain relative paths are file references', () => {
  assert.deepEqual(fileReference('src/app.js', ORIGIN), { path: 'src/app.js', line: null });
  assert.deepEqual(fileReference('README.md', ORIGIN), { path: 'README.md', line: null });
});

test('absolute paths are file references', () => {
  assert.deepEqual(fileReference('/home/me/project/server.mjs', ORIGIN), { path: '/home/me/project/server.mjs', line: null });
});

test('line suffixes: colon, range and #L anchors', () => {
  assert.deepEqual(fileReference('src/app.js:42', ORIGIN), { path: 'src/app.js', line: 42 });
  assert.deepEqual(fileReference('src/app.js:42-50', ORIGIN), { path: 'src/app.js', line: 42 });
  assert.deepEqual(fileReference('src/app.js#L7', ORIGIN), { path: 'src/app.js', line: 7 });
  assert.deepEqual(fileReference('src/app.js#L7-L9', ORIGIN), { path: 'src/app.js', line: 7 });
  assert.deepEqual(fileReference('src/app.js#12', ORIGIN), { path: 'src/app.js', line: 12 });
});

test('bare file:line looks like a URL scheme but is a file', () => {
  assert.deepEqual(fileReference('server.mjs:40', ORIGIN), { path: 'server.mjs', line: 40 });
  assert.deepEqual(fileReference('server.mjs:40-120', ORIGIN), { path: 'server.mjs', line: 40 });
});

test('line 0 is treated as no line', () => {
  assert.deepEqual(fileReference('src/app.js:0', ORIGIN), { path: 'src/app.js', line: null });
});

test('other schemes and foreign origins are not files', () => {
  assert.equal(fileReference('https://example.com/src/app.js', ORIGIN), null);
  assert.equal(fileReference('mailto:me@example.com', ORIGIN), null);
  assert.equal(fileReference('javascript:alert(1)', ORIGIN), null);
  assert.equal(fileReference('vscode://file/src/app.js', ORIGIN), null);
});

test('same-origin URLs are files when the path has an extension', () => {
  assert.deepEqual(fileReference(ORIGIN + '/src/app.js#L3', ORIGIN), { path: '/src/app.js', line: 3 });
  assert.equal(fileReference(ORIGIN + '/?session=abc', ORIGIN), null);
});

test('our own /__file/ links round-trip', () => {
  const href = fileHref({ path: 'src/some dir/app.js', line: 12 });
  assert.equal(href, '/__file/src%2Fsome%20dir%2Fapp.js#L12');
  assert.deepEqual(fileReference(href, ORIGIN), { path: 'src/some dir/app.js', line: 12 });
  assert.equal(fileHref({ path: 'a.txt', line: null }), '/__file/a.txt');
});

test('rejects anchors, queries, protocol-relative URLs, paths without extensions, bad escapes', () => {
  assert.equal(fileReference('#section', ORIGIN), null);
  assert.equal(fileReference('', ORIGIN), null);
  assert.equal(fileReference(null, ORIGIN), null);
  assert.equal(fileReference('src/app.js?raw=1', ORIGIN), null);
  assert.equal(fileReference('//evil.example/app.js', ORIGIN), null);
  assert.equal(fileReference('src/Makefile', ORIGIN), null);
  assert.equal(fileReference('docs/', ORIGIN), null);
  assert.equal(fileReference('src/%E0%A4%A.js', ORIGIN), null);
});

test('dot directories work; a bare dotfile has no extension (v1 behavior)', () => {
  assert.deepEqual(fileReference('.github/workflows/ci.yml:3', ORIGIN), { path: '.github/workflows/ci.yml', line: 3 });
  assert.equal(fileReference('.env', ORIGIN), null);
  assert.deepEqual(fileReference('config/.env.local', ORIGIN), { path: 'config/.env.local', line: null });
});
