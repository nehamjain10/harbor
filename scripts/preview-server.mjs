// Preview site: a newer frontend build served on its own socket (and port),
// talking to the LIVE server for everything else. Sessions, turns and settings are the
// live ones; only the page and its bundle come from the preview build.
//
// Usage: node preview-server.mjs   (run from the preview directory; see scripts/preview.sh)
//   PREVIEW_DIR      holds public/ (the built frontend) and web.sock   (default: cwd)
//   PREVIEW_ORIGIN   https://<host>:<port> the preview is served at
//   LIVE_ORIGIN      https://<host>:<port> of the live server
//   LIVE_SOCKET      the live server's unix socket
//   WORKBENCH_OWNER  the only Tailscale login let in
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createStaticAssets } from './static.mjs';

const dir = path.resolve(process.env.PREVIEW_DIR || process.cwd());
const publicDir = path.join(dir, 'public');
const socketPath = path.join(dir, 'web.sock');
const owner = required('WORKBENCH_OWNER');
const origin = required('PREVIEW_ORIGIN');
const liveOrigin = required('LIVE_ORIGIN');
const liveSocket = required('LIVE_SOCKET');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

// The live server's page headers (server/app.mjs), so the preview page runs under the same policy.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};

const app = express();
app.disable('x-powered-by');

// Same checks as the live server; the live server checks again (with its own origin).
app.use((req, res, next) => {
  if (req.get('Tailscale-User-Login') !== owner) {
    res.set(SECURITY_HEADERS);
    return res.status(403).json({ error: 'Connect with your Tailscale account to open this workspace.' });
  }
  if (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') !== origin) {
    res.set(SECURITY_HEADERS);
    return res.status(403).json({ error: 'Invalid origin' });
  }
  next();
});

// Everything under /api (sessions, the event stream, uploads, files) is the live server's.
function forward(req, res) {
  const headers = { ...req.headers };
  if (headers.origin) headers.origin = liveOrigin;
  if (headers.referer) headers.referer = liveOrigin + '/';
  const upstream = http.request({ socketPath: liveSocket, path: req.originalUrl, method: req.method, headers }, (answer) => {
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', (error) => {
    if (res.headersSent) return res.destroy();
    res.status(502).json({ error: 'The live server is not answering: ' + error.message });
  });
  // An event stream ends when the page goes away.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
app.use('/api', forward);

const assets = createStaticAssets({ publicDir });
app.use((req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
});
app.get(['/', '/index.html'], assets.index);
app.use('/dist', assets.dist);
app.use(express.static(publicDir, { etag: false, index: false }));
// Anything else the page asks for (vendor files and the like) comes from the live server too.
app.use(forward);

try {
  fs.unlinkSync(socketPath);
} catch {}
const server = http.createServer(app);
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  console.log('Preview listening on', socketPath, '->', liveSocket);
  assets.warm().catch(() => {});
});
// Event streams stay open for hours.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
process.on('SIGTERM', () => server.close(() => process.exit(0)));
