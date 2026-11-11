import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  INLINE_IMAGE_MAX_BYTES,
  attachmentContent,
  createUploads,
  isUploadScope,
  publicAttachment,
  sanitizeContentType,
  sanitizeUploadName,
  sniffImageType,
} from '../server/uploads.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SESSION = '0b3a54a4-4f53-4d0e-9a51-2a9f5a7b8c10';
const OTHER = '6f1c9e8e-2a77-4c7b-8a43-0d2f8e1b9a55';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempUploads(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-uploads-'));
  tempDirs.push(dataDir);
  return { dataDir, uploads: createUploads({ dataDir, log: () => {}, ...options }) };
}

const mode = (file) => fs.statSync(file).mode & 0o777;

describe('upload names, types and scopes', () => {
  test('names keep only the base name, without traversal, controls or leading dots', () => {
    assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeUploadName('..\\..\\windows\\win.ini'), 'win.ini');
    assert.equal(sanitizeUploadName('/abs/path/photo.png'), 'photo.png');
    assert.equal(sanitizeUploadName('.bashrc'), 'bashrc');
    assert.equal(sanitizeUploadName('...'), 'file');
    assert.equal(sanitizeUploadName('..'), 'file');
    assert.equal(sanitizeUploadName('dir/'), 'file');
    assert.equal(sanitizeUploadName(''), 'file');
    assert.equal(sanitizeUploadName(undefined), 'file');
    assert.equal(sanitizeUploadName('a\u0000b\nc\u007f.txt'), 'abc.txt');
    // A right-to-left override could make "evil‮gnp.exe" read as "evilexe.png".
    assert.equal(sanitizeUploadName('evil‮gnp.exe'), 'evilgnp.exe');
    assert.equal(sanitizeUploadName('  report final.pdf  '), 'report final.pdf');
    assert.equal(sanitizeUploadName('日本語.txt'), '日本語.txt');
  });

  test('long names are capped at 200 UTF-8 bytes on whole characters and keep their extension', () => {
    const long = sanitizeUploadName('x'.repeat(300) + '.tar.gz');
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('.gz'));
    assert.equal(sanitizeUploadName('y'.repeat(300)).length, 200);
    const chinese = sanitizeUploadName('文'.repeat(95) + '.png');
    assert.ok(Buffer.byteLength(chinese) <= 200 && chinese.endsWith('.png'));
    const emoji = sanitizeUploadName('a'.repeat(195) + '😀😀😀' + '.png');
    assert.doesNotThrow(() => encodeURIComponent(emoji), 'never half a character');
    assert.ok(emoji.endsWith('.png'));
    assert.doesNotThrow(() => encodeURIComponent(sanitizeUploadName('bad\uD800name.txt')), 'lone surrogates are replaced');
  });

  test('content types are reduced to their essence; junk becomes octet-stream', () => {
    assert.equal(sanitizeContentType('text/plain; charset=utf-8'), 'text/plain');
    assert.equal(sanitizeContentType('Image/PNG'), 'image/png');
    assert.equal(sanitizeContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(sanitizeContentType(''), 'application/octet-stream');
    assert.equal(sanitizeContentType(undefined), 'application/octet-stream');
    assert.equal(sanitizeContentType('text/html\r\nX-Evil: 1'), 'application/octet-stream');
    assert.equal(sanitizeContentType('nonsense'), 'application/octet-stream');
  });

  test('raster images are recognized by their bytes', () => {
    assert.equal(sniffImageType(PNG), 'image/png');
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.from('GIF89a......')), 'image/gif');
    assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });

  test('scopes are draft or id-shaped; anything path-like is refused', () => {
    assert.ok(isUploadScope('draft'));
    assert.ok(isUploadScope(SESSION));
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.', 'x'.repeat(65), undefined, null, 5]) {
      assert.equal(isUploadScope(bad), false, String(bad));
    }
  });
});

describe('upload storage', () => {
  test('save stores the bytes privately under the scope folder with a sidecar', async () => {
    const { dataDir, uploads } = tempUploads();
    const record = await uploads.save({ scope: 'draft', name: '../../notes.txt', type: 'text/plain; charset=utf-8', data: Buffer.from('hi') });
    assert.equal(record.name, 'notes.txt');
    assert.equal(record.type, 'text/plain');
    assert.equal(record.size, 2);
    assert.equal(record.image, false);
    assert.equal(record.path, path.join(dataDir, 'uploads', 'draft', `${record.id}-notes.txt`));
    assert.equal(fs.readFileSync(record.path, 'utf8'), 'hi');
    assert.equal(mode(record.path), 0o600);
    assert.equal(mode(path.join(dataDir, 'uploads')), 0o700);
    assert.equal(mode(path.join(dataDir, 'uploads', 'draft')), 0o700);
    assert.equal(mode(path.join(dataDir, 'uploads', 'draft', `${record.id}.meta.json`)), 0o600);
    assert.deepEqual(publicAttachment(record), {
      id: record.id,
      name: 'notes.txt',
      type: 'text/plain',
      size: 2,
      image: false,
      url: `/api/uploads/${record.id}`,
    });
  });

  test('images are typed by their bytes, not the declared type', async () => {
    const { uploads } = tempUploads();
    const png = await uploads.save({ scope: 'draft', name: 'shot', type: 'application/octet-stream', data: PNG });
    assert.equal(png.type, 'image/png');
    assert.equal(png.image, true);
    const fake = await uploads.save({ scope: 'draft', name: 'fake.png', type: 'image/png', data: Buffer.from('not a png') });
    assert.equal(fake.image, false);
    const svg = await uploads.save({ scope: 'draft', name: 'x.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>') });
    assert.equal(svg.type, 'image/svg+xml');
    assert.equal(svg.image, false);
  });

  test('a path-like scope never reaches the filesystem', async () => {
    const { dataDir, uploads } = tempUploads();
    await assert.rejects(uploads.save({ scope: '../escape', name: 'a.txt', type: 'text/plain', data: Buffer.from('x') }), { status: 400 });
    assert.equal(fs.existsSync(path.join(dataDir, 'escape')), false);
  });

  test('claim moves drafts into the session folder and refuses another session\'s uploads', async () => {
    const { dataDir, uploads } = tempUploads();
    const draft = await uploads.save({ scope: 'draft', name: 'a.txt', type: 'text/plain', data: Buffer.from('a') });
    const own = await uploads.save({ scope: SESSION, name: 'b.txt', type: 'text/plain', data: Buffer.from('b') });
    const foreign = await uploads.save({ scope: OTHER, name: 'c.txt', type: 'text/plain', data: Buffer.from('c') });
    const oldPath = draft.path;

    assert.throws(() => uploads.claim([draft.id, foreign.id], SESSION), { status: 400 });
    assert.equal(uploads.get(draft.id).scope, 'draft', 'nothing moves when any id is refused');
    assert.throws(() => uploads.claim(['missing'], SESSION), { status: 400 });
    assert.throws(() => uploads.claim([{ id: draft.id }], SESSION), { status: 400 });

    const claimed = uploads.claim([own.id, draft.id], SESSION);
    assert.deepEqual(claimed.map((record) => record.id), [own.id, draft.id]);
    const sessionDir = path.join(dataDir, 'uploads', SESSION);
    assert.equal(uploads.sessionDir(SESSION), sessionDir);
    assert.equal(draft.path, path.join(sessionDir, `${draft.id}-a.txt`));
    assert.equal(fs.readFileSync(draft.path, 'utf8'), 'a');
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'uploads', 'draft', `${draft.id}.meta.json`)), false);
    // Claiming again (a retried send) is fine.
    assert.equal(uploads.claim([draft.id], SESSION)[0].scope, SESSION);
  });

  test('records survive a restart; stale drafts are cleaned up', async () => {
    let clock = 1_000_000;
    const { dataDir, uploads } = tempUploads({ now: () => clock });
    const kept = await uploads.save({ scope: SESSION, name: 'keep.txt', type: 'text/plain', data: Buffer.from('k') });
    const stale = await uploads.save({ scope: 'draft', name: 'old.txt', type: 'text/plain', data: Buffer.from('o') });
    const fresh = await uploads.save({ scope: 'draft', name: 'new.txt', type: 'text/plain', data: Buffer.from('n') });
    fresh.createdAt = clock + 8 * 24 * 3600 * 1000;
    fs.writeFileSync(path.join(dataDir, 'uploads', 'draft', `${fresh.id}.meta.json`), JSON.stringify(fresh));
    fs.writeFileSync(path.join(dataDir, 'uploads', 'draft', 'garbage.meta.json'), '{');

    clock += 8 * 24 * 3600 * 1000;
    const reloaded = createUploads({ dataDir, log: () => {}, now: () => clock });
    assert.equal(reloaded.load(), 2);
    assert.equal(reloaded.get(kept.id).path, kept.path);
    assert.equal(reloaded.get(stale.id), null);
    assert.equal(fs.existsSync(stale.path), false);
    assert.ok(reloaded.get(fresh.id));
  });

  test('a tampered sidecar cannot make a non-image display inline after a restart', async () => {
    const { dataDir, uploads } = tempUploads();
    const page = await uploads.save({ scope: SESSION, name: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') });
    const sidecar = path.join(dataDir, 'uploads', SESSION, `${page.id}.meta.json`);
    fs.writeFileSync(sidecar, JSON.stringify({ ...page, type: 'image/png', image: true, name: '../evil\u0007.png' }));
    const reloaded = createUploads({ dataDir, log: () => {} });
    reloaded.load();
    const record = reloaded.get(page.id);
    assert.equal(record.image, false);
    assert.equal(record.type, 'image/png', 'the declared type is kept as data, but image is false so it is never served inline');
    assert.equal(record.name, 'evil.png');
  });
});

describe('attachment prompt content', () => {
  const read = async (file) => (file.endsWith('.png') ? PNG : Buffer.from('text'));
  const image = { id: '1', name: 'shot.png', type: 'image/png', size: PNG.length, image: true, path: '/srv/uploads/s/1-shot.png' };
  const notes = { id: '2', name: 'notes.txt', type: 'text/plain', size: 4, image: false, path: '/srv/uploads/s/2-notes.txt' };

  test('vision models get image blocks first, then the text with every path', async () => {
    const blocks = await attachmentContent('Look at these', [image, notes], { vision: true, readFile: read });
    assert.deepEqual(blocks, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      {
        type: 'text',
        text: 'Look at these\n\nAttached files:\n- /srv/uploads/s/1-shot.png (image, shown above)\n- /srv/uploads/s/2-notes.txt',
      },
    ]);
  });

  test('text-only models get the paths alone', async () => {
    const blocks = await attachmentContent('Look', [image, notes], { vision: false, readFile: read });
    assert.deepEqual(blocks, [
      { type: 'text', text: 'Look\n\nAttached files:\n- /srv/uploads/s/1-shot.png\n- /srv/uploads/s/2-notes.txt' },
    ]);
  });

  test('every image within the upload limit is inlined (Claude Code downsizes); empty text is fine', async () => {
    const huge = { ...image, size: INLINE_IMAGE_MAX_BYTES + 1 };
    const blocks = await attachmentContent('', [huge], { vision: true, readFile: read });
    assert.deepEqual(blocks, [{ type: 'text', text: 'Attached files:\n- /srv/uploads/s/1-shot.png' }]);
  });
});
