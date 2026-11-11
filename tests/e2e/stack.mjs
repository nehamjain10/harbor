// The end-to-end stack: the built frontend served by the real server (`node server.mjs`)
// on a private unix socket, real Claude Code turns (the CLI at ~/.local/bin/claude)
// against the mock gateway, and Chromium in front of one authenticating TCP proxy.
//
// Safety on a shared login node:
// - The server listens only on a unix socket inside a 0700 temp directory.
// - The browser reaches it through ONE in-process proxy on 127.0.0.1 that refuses every
//   request without this run's random secret header (403), then injects the Tailscale
//   identity and the public Origin. There is no unauthenticated listener.
// - The server runs with a sanitized environment (no CLAUDE_* / ANTHROPIC_*), only the
//   user and project setting sources (the user's are read from the throwaway Claude Code
//   folder, never from ~/.claude), a throwaway Claude Code folder and a throwaway Codex home
//   (so session import never lists the real ~/.claude or ~/.codex; the Codex home holds
//   the fixtures from import-fixtures.mjs), and every flow uses gateway models served by
//   the mock. Claude "direct" models are never selected (see assertNoDirectModels).
// - Everything started here is stopped by stop(), and by exit/signal hooks if the run
//   dies early.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMockGateway } from '../mock-gateway.mjs';
import { writeCodexHome } from './import-fixtures.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OWNER = 'you@example.com';
export const HOST = 'harbor.example.test:18544';
export const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
export const CHROMIUM = process.env.CHROMIUM_PATH || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');

// Catalog ids that run on the user's own Claude subscription: never used here.
export const DIRECT_MODELS = new Set(['opus', 'sonnet', 'fable']);

const SECRET_HEADER = 'x-e2e-secret';
// sun_path is 108 bytes; stay well below it.
const MAX_SOCKET_PATH = 100;
const SERVER_START_TIMEOUT_MS = 30_000;
const SERVER_STOP_TIMEOUT_MS = 8_000;

// Preferences every browser context starts with: a gateway model for new sessions, so a
// session created from the UI never runs on a direct Claude model.
export const DEFAULT_STORAGE = {
  'mesh-code-model': 'luna',
  'mesh-code-mode': 'bypassPermissions',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A private (0700) temp directory. */
function privateTempDir(parent, prefix) {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The server's environment: identity, paths, the mock gateway, and nothing inherited from a Claude host. */
function serverEnv({ dataDir, socketPath, mock, claudeConfigDir, codexHome }) {
  const home = os.homedir();
  return {
    HOME: home,
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    PATH: [path.join(home, '.local/bin'), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    // Less outbound traffic from the test CLI (these pass through the server's env filter).
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    WORKBENCH_OWNER: OWNER,
    WORKBENCH_HOST: HOST,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_SOCKET: socketPath,
    WORKBENCH_GATEWAY: mock.url,
    WORKBENCH_GATEWAY_KEY: mock.key,
    WORKBENCH_SETTING_SOURCES: 'user,project',
    WORKBENCH_CLAUDE_CONFIG_DIR: claudeConfigDir,
    WORKBENCH_CODEX_HOME: codexHome,
  };
}

/** One request to the server over its socket, as the owner. Resolves with {status, body}. */
function socketRequest(socketPath, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Tailscale-User-Login': OWNER, Origin: 'https://' + HOST };
    if (payload !== null) headers['Content-Type'] = 'application/json';
    const req = http.request({ socketPath, path: '/api/' + route.replace(/^\//, ''), method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, body: json ?? text });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${route} timed out`)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * The browser's only way in: 127.0.0.1, random port, per-run secret on every request.
 * Adds the owner's Tailscale identity, rewrites Origin to the public origin, and streams
 * responses (SSE included) without buffering.
 */
async function startAuthProxy({ socketPath, secret }) {
  const expected = Buffer.from(secret);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const given = Buffer.from(String(req.headers[SECRET_HEADER] || ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      req.resume();
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    const headers = { ...req.headers, 'tailscale-user-login': OWNER };
    delete headers[SECRET_HEADER];
    if (headers.origin) headers.origin = 'https://' + HOST;
    const upstream = http.request({ socketPath, path: req.url, method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(error.message);
      } else {
        res.destroy();
      }
    });
    // The browser went away (reload, closed EventSource): drop the upstream request too.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signals the server's whole process group (the server and the CLI processes it spawned). */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * The pid of the CLI host (cli-host.mjs) serving `socket`: it runs in a process group of its
 * own, with the Claude Code processes the server keeps alive as its children.
 */
function hostPid(socket) {
  let out = '';
  try {
    // Only our own processes: everyone's can exceed execFileSync's output buffer on a shared host.
    out = execFileSync('ps', ['-u', String(process.getuid()), '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  const line = out.split('\n').find((entry) => entry.includes('cli-host.mjs') && entry.trim().endsWith(` ${socket}`));
  return line ? Number(line.trim().split(/\s+/)[0]) : null;
}

export async function startStack({ log = () => {} } = {}) {
  const cleanups = [];
  let stopped = false;
  let server = null;
  let hostSocket = null;
  const dirs = [];

  // Synchronous last resort for crashes and signals: kill the server group, remove temp dirs.
  const emergency = () => {
    if (stopped) return;
    stopped = true;
    if (server?.pid) signalGroup(server.pid, 'SIGKILL');
    const host = hostSocket && hostPid(hostSocket);
    if (host) signalGroup(host, 'SIGKILL');
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    emergency();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', emergency);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    log('building the frontend');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, stdio: 'pipe' });

    const base = privateTempDir(process.env.E2E_TMPDIR || os.tmpdir(), 'mc-e2e-');
    dirs.push(base);
    let socketPath = path.join(base, 'w.sock');
    if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH) {
      // A deep temp dir: the socket gets its own short private directory.
      const socketDir = privateTempDir(os.tmpdir(), 'mc-');
      dirs.push(socketDir);
      socketPath = path.join(socketDir, 'w.sock');
    }
    const dataDir = path.join(base, 'data');
    const claudeConfigDir = path.join(base, 'claude-config');
    fs.mkdirSync(claudeConfigDir, { mode: 0o700 });
    // Projects must live inside the home directory (the server confines paths to it).
    const reposDir = privateTempDir(path.join(os.homedir(), 'scratch'), 'harbor-e2e-');
    dirs.push(reposDir);

    let repoCount = 0;
    /** A fresh git repository (committed hello.txt and src/app.py) under ~/scratch. */
    const makeRepo = (name = 'repo') => {
      repoCount += 1;
      const dir = path.join(reposDir, `${name}-${repoCount}`);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nsecond line\n');
      fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nNothing yet.\n');
      fs.writeFileSync(path.join(dir, 'src', 'app.py'), 'def main():\n    print("hi")\n\n\nif __name__ == "__main__":\n    main()\n');
      const git = (...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      git('add', '.');
      git('commit', '-qm', 'init');
      return dir;
    };

    const codexHome = path.join(base, 'codex-home');
    fs.mkdirSync(codexHome, { mode: 0o700 });
    writeCodexHome(codexHome, { cwd: makeRepo('codex') });

    // Request bodies are kept so flows can check the history a turn sent.
    const mock = await startMockGateway({ keepBodies: true });
    cleanups.push(() => mock.close());

    hostSocket = path.join(dataDir, 'cli-host.sock');
    const logFile = path.join(base, 'server.log');
    const logFd = fs.openSync(logFile, 'a');
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: serverEnv({ dataDir, socketPath, mock, claudeConfigDir, codexHome }),
      stdio: ['ignore', logFd, logFd],
      // Its own process group, so stop() also reaches the CLI processes it spawns.
      detached: true,
    });
    fs.closeSync(logFd);
    let exited = null;
    const serverExit = new Promise((resolve) => server.once('exit', (code, signal) => resolve((exited = { code, signal }))));
    const serverLog = () => {
      try {
        return fs.readFileSync(logFile, 'utf8');
      } catch {
        return '';
      }
    };

    const api = async (method, route, body) => {
      const { status, body: data } = await socketRequest(socketPath, method, route, body);
      if (status >= 400) {
        const error = new Error(`${method} /api/${route} → ${status}: ${data?.error || data}`);
        error.status = status;
        throw error;
      }
      return data;
    };

    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    for (;;) {
      if (exited) throw new Error(`The server exited during startup (${JSON.stringify(exited)}):\n${serverLog()}`);
      if (fs.existsSync(socketPath)) {
        const info = await api('GET', 'info').catch(() => null);
        if (info?.models) {
          if (!info.gateway) throw new Error('The server cannot reach the mock gateway');
          break;
        }
      }
      if (Date.now() > deadline) throw new Error(`The server did not start:\n${serverLog()}`);
      await sleep(100);
    }
    log('server listening');

    const secret = crypto.randomBytes(32).toString('hex');
    const proxy = await startAuthProxy({ socketPath, secret });
    cleanups.push(() => proxy.close());

    const browser = await chromium.launch({ executablePath: CHROMIUM });
    cleanups.push(() => browser.close());

    /** A browser context and page with the secret header, seeded localStorage and error capture. */
    const openPage = async ({ path: route = '/', viewport = { width: 1440, height: 900 }, isMobile = false, hasTouch = false, storage = {} } = {}) => {
      const context = await browser.newContext({
        baseURL: proxy.url,
        viewport,
        isMobile,
        hasTouch,
        deviceScaleFactor: isMobile ? 2 : 1,
        colorScheme: 'dark',
        extraHTTPHeaders: { [SECRET_HEADER]: secret },
      });
      // Seeded once per context: a reload keeps whatever the test changed since.
      await context.addInitScript((entries) => {
        try {
          if (localStorage.getItem('e2e-seeded')) return;
          localStorage.setItem('e2e-seeded', '1');
          for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        } catch {
          // about:blank and other opaque origins have no storage.
        }
      }, { ...DEFAULT_STORAGE, ...storage });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()} (${message.location()?.url || ''})`);
      });
      await page.goto(route);
      return { page, context, errors };
    };

    /** The Claude Code processes the server keeps alive (in its CLI host): [{pid, cwd}]. */
    const cliProcesses = () => {
      let out = '';
      const parents = [server.pid, hostPid(hostSocket)].filter(Boolean);
      try {
        out = execFileSync('ps', ['--ppid', parents.join(','), '-o', 'pid=,args='], { encoding: 'utf8' });
      } catch {
        return []; // ps exits 1 when there are none
      }
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('stream-json'))
        .map((line) => {
          const pid = Number(line.split(/\s+/)[0]);
          let cwd = null;
          try {
            cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          } catch {
            // Exited in between.
          }
          return { pid, cwd };
        })
        .filter((proc) => proc.cwd);
    };

    /** Fails when any session ever ran (or is set to run) on a direct Claude model. */
    const assertNoDirectModels = async () => {
      const sessions = await api('GET', 'sessions');
      for (const session of sessions) {
        if (DIRECT_MODELS.has(session.model) || DIRECT_MODELS.has(session.lastTurnModel)) {
          throw new Error(`Session "${session.title}" uses the direct model ${session.model}; e2e flows must use gateway models`);
        }
      }
    };

    const stop = async () => {
      if (stopped) return;
      for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
      if (!exited && server?.pid) {
        signalGroup(server.pid, 'SIGTERM');
        await Promise.race([serverExit, sleep(SERVER_STOP_TIMEOUT_MS)]);
      }
      // Whatever is left of the group goes too, and the CLI host with its Claude Code processes.
      if (server?.pid) signalGroup(server.pid, 'SIGKILL');
      const host = hostPid(hostSocket);
      if (host) signalGroup(host, 'SIGKILL');
      stopped = true;
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
      process.off('exit', emergency);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };

    return {
      url: proxy.url,
      secretHeader: SECRET_HEADER,
      secret,
      mock,
      browser,
      api,
      makeRepo,
      dataDir,
      claudeConfigDir,
      codexHome,
      claudeExecutable: CLAUDE,
      openPage,
      assertNoDirectModels,
      serverLog,
      serverAlive: () => !exited && processAlive(server.pid),
      cliProcesses,
      stop,
    };
  } catch (error) {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    emergency();
    process.off('exit', emergency);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    throw error;
  }
}
