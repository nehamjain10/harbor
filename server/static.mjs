// The built frontend (public/dist) and the page that loads it. The browser is remote
// (Tailscale, often through a relay), so the ~0.5 MB bundle is sent compressed and
// cached: each file is read, hashed and compressed (br, gzip) once per version, in
// memory. index.html links the files with `?v=<hash>`, and those URLs are immutable
// for a year: a deploy (or rebuild) changes the hash, so the next page load fetches
// the new code while index.html itself is never cached. Requests without the current
// hash (fonts linked from older CSS, source maps) revalidate with the ETag.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

/** The version tag of an asset's bytes (also used by scripts/build.mjs for fonts). */
export function assetVersion(data) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
}

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.js', '.css', '.map']);
const IMMUTABLE = 'private, max-age=31536000, immutable';
// Best brotli for the bundle (~0.4 s once per version, off the event loop); the 2 MB
// source map, only fetched with devtools open, gets a cheaper level.
const BROTLI_BEST_MAX_BYTES = 1_000_000;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

function compress(encoding, data) {
  if (encoding === 'gzip') return gzip(data, { level: 9 });
  const quality = data.length <= BROTLI_BEST_MAX_BYTES ? 11 : 5;
  return brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
}

/**
 * @param {object} options
 * @param {string} options.publicDir  holds index.html and dist/
 * @returns {{index: Function, dist: Function, warm: () => Promise<void>}}
 *   `index` serves the page (GET / and /index.html), `dist` the files under /dist
 *   (unknown types fall through to the next handler), `warm` prepares the bundle.
 */
export function createStaticAssets({ publicDir }) {
  const distDir = path.join(publicDir, 'dist');
  const indexPath = path.join(publicDir, 'index.html');
  // Absolute path -> {mtimeMs, size, data, version, encoded: Map(encoding -> Promise<Buffer>)}.
  const files = new Map();

  async function load(file) {
    const stats = await fsp.stat(file);
    if (!stats.isFile()) return null;
    const cached = files.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;
    const data = await fsp.readFile(file);
    const entry = { mtimeMs: stats.mtimeMs, size: stats.size, data, version: assetVersion(data), encoded: new Map() };
    files.set(file, entry);
    return entry;
  }

  function encoded(entry, encoding) {
    if (!entry.encoded.has(encoding)) {
      const promise = compress(encoding, entry.data);
      // A failed compression is retried next time (and that response goes out plain).
      promise.catch(() => entry.encoded.delete(encoding));
      entry.encoded.set(encoding, promise);
    }
    return entry.encoded.get(encoding);
  }

  // `/dist/x` in index.html -> `/dist/x?v=<hash>` for files that exist.
  async function versionedIndex() {
    const html = (await load(indexPath)).data.toString('utf8');
    const refs = [...new Set([...html.matchAll(/(["'])\/dist\/([^"'?#]+)\1/g)].map((match) => match[2]))];
    const versions = new Map();
    await Promise.all(
      refs.map(async (ref) => {
        const file = path.join(distDir, ref);
        if (!file.startsWith(distDir + path.sep)) return;
        const entry = await load(file).catch(() => null);
        if (entry) versions.set(ref, entry.version);
      }),
    );
    return html.replace(/(["'])\/dist\/([^"'?#]+)\1/g, (whole, quote, ref) =>
      versions.has(ref) ? `${quote}/dist/${ref}?v=${versions.get(ref)}${quote}` : whole,
    );
  }

  async function index(req, res) {
    res.type('html').send(await versionedIndex());
  }

  async function dist(req, res, next) {
    let relative;
    try {
      relative = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const type = TYPES[path.extname(relative)];
    const file = path.join(distDir, relative);
    if (!type || !file.startsWith(distDir + path.sep)) return next();
    const entry = await load(file).catch(() => null);
    if (!entry) return next();
    // Weak: the br, gzip and plain bodies of one version share it.
    const etag = `W/"${entry.version}"`;
    res.set({
      'Content-Type': type,
      ETag: etag,
      'Cache-Control': req.query.v === entry.version ? IMMUTABLE : 'no-cache',
    });
    const compressible = COMPRESSIBLE.has(path.extname(relative));
    if (compressible) res.vary('Accept-Encoding');
    if (String(req.get('If-None-Match') || '').split(/\s*,\s*/).includes(etag)) return res.status(304).end();
    const encoding = compressible ? ['br', 'gzip'].find((name) => req.acceptsEncodings(name) === name) : null;
    let body = entry.data;
    if (encoding) {
      try {
        body = await encoded(entry, encoding);
        res.set('Content-Encoding', encoding);
      } catch {
        body = entry.data;
      }
    }
    res.send(body);
  }

  // Loads and compresses what index.html links, so the first page load after a
  // deploy does not wait for brotli.
  async function warm() {
    const html = (await load(indexPath)).data.toString('utf8');
    for (const [, , ref] of html.matchAll(/(["'])\/dist\/([^"'?#]+)\1/g)) {
      const file = path.join(distDir, ref);
      const extension = path.extname(ref);
      if (!file.startsWith(distDir + path.sep) || !COMPRESSIBLE.has(extension)) continue;
      const entry = await load(file).catch(() => null);
      if (entry) await Promise.all([encoded(entry, 'br'), encoded(entry, 'gzip')]).catch(() => {});
    }
  }

  return { index, dist, warm };
}
