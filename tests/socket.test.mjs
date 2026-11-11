import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { assertPrivateDirectory, listenOnSocket } from '../server/socket.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-socket-'));
  fs.chmodSync(dir, 0o700);
});

afterEach(() => {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

const app = (req, res) => res.end('ok');

/** Reads the umask without the deprecated no-argument form. */
function currentUmask() {
  const mask = process.umask(0o022);
  process.umask(mask);
  return mask;
}

describe('assertPrivateDirectory', () => {
  test('accepts a 0700 directory owned by this user', () => {
    assert.doesNotThrow(() => assertPrivateDirectory(dir));
  });

  test('rejects directories other users can reach', () => {
    for (const mode of [0o750, 0o705, 0o701, 0o770, 0o777]) {
      fs.chmodSync(dir, mode);
      assert.throws(() => assertPrivateDirectory(dir), /accessible to other users .*Use a directory with mode 0700/, mode.toString(8));
    }
  });

  test('rejects directories owned by someone else', { skip: process.getuid() === 0 && 'running as root' }, () => {
    assert.throws(() => assertPrivateDirectory('/'), /owned by uid 0, not by this user/);
  });

  test('rejects missing paths and non-directories', () => {
    assert.throws(() => assertPrivateDirectory(path.join(dir, 'missing')), /not accessible/);
    fs.writeFileSync(path.join(dir, 'file'), '');
    assert.throws(() => assertPrivateDirectory(path.join(dir, 'file')), /not a directory/);
  });
});

describe('listenOnSocket', () => {
  test('creates a 0600 socket even under a permissive umask, then restores the umask', async () => {
    const socketPath = path.join(dir, 'web.sock');
    const originalUmask = process.umask(0o000);
    let server;
    try {
      server = await listenOnSocket(http.createServer(app), socketPath);
      assert.equal(server.listening, true);
      assert.equal(currentUmask(), 0o000, 'umask restored after binding');
      assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    } finally {
      process.umask(originalUmask);
      await new Promise((resolve) => server?.close(resolve));
    }
  });

  test('refuses a socket directory other users can reach', async () => {
    const shared = path.join(dir, 'shared');
    fs.mkdirSync(shared, { mode: 0o755 });
    fs.chmodSync(shared, 0o755);
    await assert.rejects(listenOnSocket(http.createServer(app), path.join(shared, 'web.sock')), /accessible to other users/);
    assert.equal(fs.existsSync(path.join(shared, 'web.sock')), false);
  });

  test('refuses a socket path the kernel would truncate', async () => {
    const long = path.join(dir, 'x'.repeat(Math.max(1, 108 - Buffer.byteLength(dir) - 1)) + '.sock');
    assert.ok(Buffer.byteLength(long) > 107);
    await assert.rejects(listenOnSocket(http.createServer(app), long), /at most 107/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('never deletes a non-socket file at the socket path', async () => {
    const socketPath = path.join(dir, 'web.sock');
    fs.writeFileSync(socketPath, 'precious');
    await assert.rejects(listenOnSocket(http.createServer(app), socketPath), /exists and is not a socket/);
    assert.equal(fs.readFileSync(socketPath, 'utf8'), 'precious');
  });

  test('replaces a stale socket from a previous run', async () => {
    const socketPath = path.join(dir, 'web.sock');
    // A crashed server leaves its socket file behind; simulate one by copying the inode name.
    const first = await listenOnSocket(http.createServer(app), socketPath);
    fs.linkSync(socketPath, path.join(dir, 'stale.sock'));
    await new Promise((resolve) => first.close(resolve));
    fs.renameSync(path.join(dir, 'stale.sock'), socketPath);
    assert.ok(fs.lstatSync(socketPath).isSocket());

    const second = await listenOnSocket(http.createServer(app), socketPath);
    assert.equal(second.listening, true);
    await new Promise((resolve) => second.close(resolve));
  });

  test('refuses to take over a socket another server is answering on', async () => {
    const socketPath = path.join(dir, 'web.sock');
    const owner = await listenOnSocket(http.createServer(app), socketPath);
    try {
      await assert.rejects(listenOnSocket(http.createServer(app), socketPath), /another server is already listening/);
      assert.ok(fs.lstatSync(socketPath).isSocket(), 'the live socket is left in place');
      const reply = await new Promise((resolve, reject) => {
        http.get({ socketPath, path: '/' }, (res) => res.on('data', resolve)).on('error', reject);
      });
      assert.equal(String(reply), 'ok', 'the first server still serves');
    } finally {
      await new Promise((resolve) => owner.close(resolve));
    }
  });
});
