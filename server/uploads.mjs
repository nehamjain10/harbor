// Composer uploads: files the user attaches to a message. Each upload is stored as
// <dataDir>/uploads/<scope>/<id>-<name> with a <id>.meta.json sidecar next to it, where
// scope is a session id or `draft` (attached before the session's first send). Drafts
// move into their session's folder when the message that uses them is sent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './errors.mjs';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
// Claude Code downsizes inline images itself (a 6.8 MB PNG reaches the API as a ~0.5 MB
// JPEG), so every image the upload limit admits is shown to vision models.
export const INLINE_IMAGE_MAX_BYTES = MAX_UPLOAD_BYTES;
export const DRAFT_SCOPE = 'draft';

// On-disk names are `<36-char id>-<name>`; file systems allow 255 bytes.
const MAX_NAME_BYTES = 200;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const META_SUFFIX = '.meta.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^[A-Za-z0-9-]{1,64}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
// C0/C1 controls and the bidi overrides that can disguise a file name's extension.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** The longest prefix of `text` (whole characters) that fits in `budget` UTF-8 bytes. */
function truncateBytes(text, budget) {
  let out = '';
  let used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > budget) break;
    out += char;
  }
  return out;
}

/**
 * A file name that is safe as the last part of a path: the base name only, without
 * control characters, lone surrogates or leading dots, at most 200 UTF-8 bytes (cut at
 * whole characters, the extension kept).
 */
export function sanitizeUploadName(value) {
  const base = String(value ?? '').toWellFormed().split(/[\\/]/).pop();
  let name = base.replace(UNSAFE_NAME_CHARS, '').trim().replace(/^\.+/, '').trim();
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const ext = path.extname(name);
    const keepExt = ext.length > 1 && Buffer.byteLength(ext) <= 16;
    name = keepExt ? truncateBytes(name.slice(0, -ext.length), MAX_NAME_BYTES - Buffer.byteLength(ext)) + ext : truncateBytes(name, MAX_NAME_BYTES);
  }
  return name || 'file';
}

/** The media type without parameters, or application/octet-stream when it is unusable. */
export function sanitizeContentType(value) {
  const essence = String(value ?? '').split(';')[0].trim().toLowerCase();
  return MIME_TYPE.test(essence) ? essence : 'application/octet-stream';
}

/** The raster image type the bytes actually are (png, jpeg, gif, webp), or null. */
export function sniffImageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    return head.subarray(0, fs.readSync(fd, head, 0, 12, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether `value` can name an upload folder: `draft` or a session-id-shaped string. */
export function isUploadScope(value) {
  return typeof value === 'string' && SCOPE.test(value);
}

/** The client-facing Attachment; the stored path stays on the server. */
export function publicAttachment(record) {
  const { id, name, type, size, image } = record;
  return { id, name, type, size, image, url: `/api/uploads/${id}` };
}

/**
 * The content blocks a turn with attachments sends: one image block per image the model
 * can see (vision models, images small enough to inline), then the user's text with the
 * absolute path of every attachment so any model can Read them.
 */
export async function attachmentContent(text, records, { vision, readFile = fsp.readFile }) {
  const blocks = [];
  const lines = [];
  for (const record of records) {
    const inline = vision && record.image && record.size <= INLINE_IMAGE_MAX_BYTES;
    if (inline) {
      const data = (await readFile(record.path)).toString('base64');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: record.type, data } });
    }
    lines.push(`- ${record.path}${inline ? ' (image, shown above)' : ''}`);
  }
  const list = `Attached files:\n${lines.join('\n')}`;
  blocks.push({ type: 'text', text: text ? `${text}\n\n${list}` : list });
  return blocks;
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir  the server's data directory (uploads live in its `uploads/`)
 * @param {(message: string) => void} [deps.log]
 */
export function createUploads({ dataDir, log = console.error, now = Date.now }) {
  const root = path.join(dataDir, 'uploads');
  const records = new Map(); // upload id -> { id, name, type, size, image, scope, path, createdAt }
  let loaded = false;

  function scopeDir(scope) {
    if (!isUploadScope(scope)) throw httpError(400, 'Unknown upload scope.');
    return path.join(root, scope);
  }

  function metaPath(record) {
    return path.join(path.dirname(record.path), record.id + META_SUFFIX);
  }

  function writeMeta(record) {
    const target = metaPath(record);
    fs.writeFileSync(target + '.tmp', JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  }

  function remove(record) {
    records.delete(record.id);
    fs.rmSync(record.path, { force: true });
    fs.rmSync(metaPath(record), { force: true });
  }

  /** Reads every sidecar; drafts nobody sent within a week are deleted. */
  function load() {
    loaded = true;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const scope of fs.readdirSync(root)) {
      const dir = path.join(root, scope);
      if (!isUploadScope(scope) || !fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(META_SUFFIX))) {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(dir, file)));
          if (!UUID.test(record.id) || file !== record.id + META_SUFFIX) continue;
          // The folder is the truth (a move may have stopped half way).
          record.scope = scope;
          record.path = path.join(dir, path.basename(record.path));
          if (!fs.existsSync(record.path)) continue;
          // Never trust a sidecar for how the bytes are served: re-derive it from the file.
          const sniffed = sniffImageType(readHead(record.path));
          record.image = Boolean(sniffed);
          record.type = sniffed ?? sanitizeContentType(record.type);
          record.name = sanitizeUploadName(record.name);
          records.set(record.id, record);
          if (scope === DRAFT_SCOPE && now() - record.createdAt > DRAFT_MAX_AGE_MS) remove(record);
        } catch (error) {
          log(`Skipping unreadable upload record ${path.join(dir, file)}: ${error.message}`);
        }
      }
    }
    return records.size;
  }

  function ensureLoaded() {
    if (!loaded) load();
  }

  /** Stores one upload and returns its private record. `scope` must already be checked. */
  async function save({ scope, name, type, data }) {
    ensureLoaded();
    const dir = scopeDir(scope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    const safeName = sanitizeUploadName(name);
    const sniffed = sniffImageType(data);
    const record = {
      id,
      name: safeName,
      // Raster images are typed by their bytes, so a mislabelled file is never sent to a
      // model as an image it cannot decode.
      type: sniffed ?? sanitizeContentType(type),
      size: data.length,
      image: Boolean(sniffed),
      scope,
      path: path.join(dir, `${id}-${safeName}`),
      createdAt: now(),
    };
    await fsp.writeFile(record.path, data, { mode: 0o600, flag: 'wx' });
    writeMeta(record);
    records.set(id, record);
    return record;
  }

  function get(id) {
    ensureLoaded();
    return records.get(id) ?? null;
  }

  /** The folder holding a session's uploads (may not exist yet). */
  function sessionDir(sessionId) {
    return scopeDir(sessionId);
  }

  /**
   * Checks that every id is a draft or already belongs to this session, then moves the
   * drafts into the session's folder. Returns the records in the given order.
   */
  function claim(ids, sessionId) {
    ensureLoaded();
    const claimed = ids.map((id) => {
      const record = typeof id === 'string' ? records.get(id) : null;
      if (!record || (record.scope !== DRAFT_SCOPE && record.scope !== sessionId)) {
        throw httpError(400, 'An attachment is missing. Attach the file again.');
      }
      return record;
    });
    const dir = sessionDir(sessionId);
    for (const record of claimed) {
      if (record.scope === sessionId) continue;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const oldMeta = metaPath(record);
      const oldPath = record.path;
      const target = path.join(dir, path.basename(record.path));
      // Sidecar first: a crash between the steps leaves a record load() can still find.
      Object.assign(record, { scope: sessionId, path: target });
      writeMeta(record);
      fs.renameSync(oldPath, target);
      fs.rmSync(oldMeta, { force: true });
    }
    return claimed;
  }

  /**
   * New records in `scope` with the same bytes as the uploads `ids` (a fork's draft takes
   * copies, so either session can send or lose its own). Missing ones are left out.
   */
  async function copy(ids, scope) {
    ensureLoaded();
    const dir = scopeDir(scope);
    const copies = [];
    for (const id of ids) {
      const source = records.get(id);
      if (!source || !fs.existsSync(source.path)) continue;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = { ...source, id: crypto.randomUUID(), scope, createdAt: now() };
      record.path = path.join(dir, `${record.id}-${source.name}`);
      await fsp.copyFile(source.path, record.path, fs.constants.COPYFILE_EXCL);
      writeMeta(record);
      records.set(record.id, record);
      copies.push(record);
    }
    return copies;
  }

  return { root, load, save, get, claim, copy, sessionDir };
}
