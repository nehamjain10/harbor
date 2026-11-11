// The page and the built bundle (server/static.mjs): versioned links, compression,
// caching and revalidation, and picking up a rebuild at once.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import { listenOnSocket } from '../server/socket.mjs';
import { assetVersion, createStaticAssets } from '../server/static.mjs';

let dir;
let socketPath;
let server;
const JS = 'export const greeting = "hello";\n'.repeat(200);
const CSS = 'body { color: red; }\n'.repeat(100);
const FONT = Buffer.from('wOF2 not really a font');

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-static-'));
  fs.chmodSync(dir, 0o700);
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(path.join(publicDir, 'dist', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<link rel="stylesheet" href="/dist/app.css" />\n<script type="module" src="/dist/app.js"></script>\n<script src="/dist/missing.js"></script>\n');
  fs.writeFileSync(path.join(publicDir, 'dist', 'app.js'), JS);
  fs.writeFileSync(path.join(publicDir, 'dist', 'app.css'), CSS);
  fs.writeFileSync(path.join(publicDir, 'dist', 'fonts', 'face.woff2'), FONT);
  fs.writeFileSync(path.join(publicDir, 'secret.txt'), 'not under dist');
  const assets = createStaticAssets({ publicDir });
  const app = express();
  app.get(['/', '/index.html'], assets.index);
  app.use('/dist', assets.dist);
  app.use((req, res) => res.status(404).send('fell through'));
  socketPath = path.join(dir, 'web.sock');
  server = await listenOnSocket(app, socketPath);
  await assets.warm();
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('index.html links the bundle with its content version; missing files stay as they are', async () => {
  const page = (await get('/')).body.toString();
  assert.match(page, new RegExp(`href="/dist/app.css\\?v=${assetVersion(Buffer.from(CSS))}"`));
  assert.match(page, new RegExp(`src="/dist/app.js\\?v=${assetVersion(Buffer.from(JS))}"`));
  assert.match(page, /src="\/dist\/missing.js"/);
  assert.equal((await get('/index.html')).body.toString(), page);
});

test('a versioned asset is immutable and compressed; others revalidate with the ETag', async () => {
  const version = assetVersion(Buffer.from(JS));
  const br = await get(`/dist/app.js?v=${version}`, { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(br.headers['content-type'], /^text\/javascript/);
  assert.match(br.headers.vary, /Accept-Encoding/);
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), JS);
  assert.ok(br.body.length * 10 < JS.length);

  const gz = await get('/dist/app.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['cache-control'], 'no-cache', 'no version, so it is revalidated');
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.body).toString(), JS);
  assert.equal((await get('/dist/app.js?v=stale')).headers['cache-control'], 'no-cache');

  const plain = await get('/dist/app.css');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), CSS);
  const revalidated = await get('/dist/app.css', { 'If-None-Match': plain.headers.etag });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);

  const font = await get(`/dist/fonts/face.woff2?v=${assetVersion(FONT)}`, { 'Accept-Encoding': 'br' });
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal(font.headers['content-encoding'], undefined, 'woff2 is compressed already');
  assert.equal(font.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.deepEqual(font.body, FONT);
});

test('a rebuild is served at once under a new version', async () => {
  const next = JS + 'export const added = 1;\n';
  const file = path.join(dir, 'public', 'dist', 'app.js');
  fs.writeFileSync(file, next);
  // Same size changes are caught by the modification time.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const page = (await get('/')).body.toString();
  assert.match(page, new RegExp(`src="/dist/app.js\\?v=${assetVersion(Buffer.from(next))}"`));
  const fresh = await get(`/dist/app.js?v=${assetVersion(Buffer.from(next))}`, { 'Accept-Encoding': 'br' });
  assert.equal(zlib.brotliDecompressSync(fresh.body).toString(), next);
  const old = await get(`/dist/app.js?v=${assetVersion(Buffer.from(JS))}`);
  assert.equal(old.headers['cache-control'], 'no-cache', 'the old version is no longer marked immutable');
  assert.equal(old.body.toString(), next);
});

test('only known asset types under dist are served', async () => {
  assert.equal((await get('/dist/../secret.txt')).body.toString(), 'fell through');
  assert.equal((await get('/dist/%2e%2e/secret.txt')).body.toString(), 'fell through');
  assert.equal((await get('/dist/nothing.js')).body.toString(), 'fell through');
  assert.equal((await get('/dist/%E0%A4%A')).body.toString(), 'fell through');
});
