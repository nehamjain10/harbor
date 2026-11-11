// The CLI host: a small long-lived process that owns Harbor's Claude Code processes, so
// a restart of the web server (a deploy) does not end them. The server starts it once
// (host-client.mjs ensureHost) and talks to it over a unix socket in the data folder;
// every Claude Code process is a child of the host instead of the server.
//
// Each process has a key (`s:<session>` for a session's process, `w:<agent>` for a model
// agent). One server connection at a time is attached to it. What the process prints is
// numbered line by line and kept until the server acknowledges it (`ack`): a server that
// goes away mid-stream gets every line it had not confirmed when it, or its successor,
// attaches again. Claude Code's own requests that the server has not answered yet (a tool
// approval, an MCP call such as wait_agents, a hook) are sent again to a server that
// attaches, and answers to requests a previous server made are dropped.
//
// Protocol: newline-delimited JSON frames. The first frame of a connection says what it
// is for:
//   {op:'list'}                         -> {op:'list', procs:[...]} and the connection closes
//   {op:'spawn', key, command, args, cwd, env, meta}   starts a process and attaches
//   {op:'attach', key, from}            attaches to a live (or just exited) process,
//                                       replaying lines numbered `from` and later
//   {op:'kill', key, signal}            signals a process (no attachment needed)
// Attached, the server sends {op:'in', data} (stdin), {op:'end'} (close stdin),
// {op:'kill', signal}, {op:'ack', seq}, {op:'meta', meta} (opaque state kept for the next
// server) and {op:'detach'}; the host sends {op:'attached', seq, pid, meta, gap},
// {op:'out', seq, line} (seq null for a resent request) and {op:'exit', code, signal}.
//
// Run as `node server/cli-host.mjs <socket path>`; it logs to stderr.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const HOST_PROTOCOL = 1;
// Lines a process may have unconfirmed before the oldest are dropped (a server that never
// comes back must not grow the host without bound); the next attach then reports a gap.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// A process that exited while no server was attached is kept this long for one to collect.
const EXITED_KEEP_MS = 30 * 60_000;

/** Frames in, one JSON object per line. */
function frameReader(onFrame) {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    let index;
    while ((index = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, index);
      rest = rest.slice(index + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      onFrame(frame);
    }
  };
}

// Requests the SDK asks Claude Code for again itself when it attaches (the answer to its
// `initialize` lists them): resending them too would ask the user twice.
const SDK_REPLAYS = new Set(['can_use_tool', 'request_user_dialog']);

const send = (conn, frame) => {
  if (conn && !conn.destroyed) conn.write(JSON.stringify(frame) + '\n');
};

// Claude Code's control frames: requests it makes of the server, and answers to the
// server's. Only lines that can be one are parsed.
function controlFrame(line) {
  if (!line.includes('"control_')) return null;
  try {
    const frame = JSON.parse(line);
    if (frame?.type === 'control_request' && frame.request_id) return { kind: 'request', id: frame.request_id, subtype: frame.request?.subtype };
    if (frame?.type === 'control_response') {
      const id = frame.response?.request_id ?? frame.request_id;
      return id ? { kind: 'response', id } : null;
    }
    if (frame?.type === 'control_cancel_request' && frame.request_id) return { kind: 'cancel', id: frame.request_id };
  } catch {
    // not JSON: an ordinary line
  }
  return null;
}

export function createHost({ log = (line) => process.stderr.write(line + '\n'), now = Date.now } = {}) {
  const procs = new Map();
  const conns = new Set();

  function publicProc(proc) {
    return {
      key: proc.key,
      pid: proc.child?.pid ?? null,
      startedAt: proc.startedAt,
      seq: proc.seq,
      acked: proc.acked,
      attached: Boolean(proc.conn),
      exit: proc.exit,
      meta: proc.meta,
    };
  }

  function trim(proc) {
    while (proc.bufferBytes > MAX_BUFFER_BYTES && proc.buffer.length) {
      const dropped = proc.buffer.shift();
      proc.bufferBytes -= dropped.line.length;
      proc.gap = true;
    }
  }

  // An answer to a request an earlier server made is of no use to the attached one.
  const stale = (proc, entry) => entry.forGeneration !== undefined && entry.forGeneration !== proc.generation;

  function onStdoutLine(proc, line) {
    proc.seq += 1;
    const seq = proc.seq;
    const control = controlFrame(line);
    const entry = { seq, line };
    if (control?.kind === 'request') proc.cliRequests.set(control.id, { seq, line, subtype: control.subtype });
    else if (control?.kind === 'cancel') proc.cliRequests.delete(control.id);
    else if (control?.kind === 'response' && proc.sdkRequests.has(control.id)) {
      entry.forGeneration = proc.sdkRequests.get(control.id);
      proc.sdkRequests.delete(control.id);
    }
    proc.buffer.push(entry);
    proc.bufferBytes += line.length;
    trim(proc);
    if (proc.conn && !stale(proc, entry)) send(proc.conn, { op: 'out', seq, line });
  }

  function onStdinLine(proc, line) {
    const control = controlFrame(line);
    // The server answered one of Claude Code's requests: it is not owed any more.
    if (control?.kind === 'response') proc.cliRequests.delete(control.id);
    else if (control?.kind === 'request') proc.sdkRequests.set(control.id, proc.generation);
  }

  function writeStdin(proc, data) {
    if (!proc.child || proc.exit || proc.stdinEnded) return;
    proc.stdinRest += data;
    let index;
    while ((index = proc.stdinRest.indexOf('\n')) >= 0) {
      onStdinLine(proc, proc.stdinRest.slice(0, index));
      proc.stdinRest = proc.stdinRest.slice(index + 1);
    }
    proc.child.stdin.write(data);
  }

  function ack(proc, seq) {
    if (!Number.isInteger(seq) || seq <= proc.acked) return;
    proc.acked = Math.min(seq, proc.seq);
    while (proc.buffer.length && proc.buffer[0].seq <= proc.acked) proc.bufferBytes -= proc.buffer.shift().line.length;
  }

  // An exited process nobody collects is dropped after a while.
  function scheduleForget(proc) {
    clearTimeout(proc.forgetTimer);
    proc.forgetTimer = setTimeout(() => forget(proc), EXITED_KEEP_MS);
    proc.forgetTimer.unref?.();
  }

  function forget(proc) {
    clearTimeout(proc.forgetTimer);
    if (procs.get(proc.key) === proc) procs.delete(proc.key);
  }

  function attach(proc, conn, from) {
    if (proc.conn && proc.conn !== conn) {
      send(proc.conn, { op: 'replaced' });
      proc.conn.end();
    }
    proc.conn = conn;
    proc.generation += 1;
    clearTimeout(proc.forgetTimer);
    // Lines before `from` the server has; anything it skipped past was confirmed.
    ack(proc, from - 1);
    const firstBuffered = proc.buffer[0]?.seq ?? proc.seq + 1;
    send(conn, { op: 'attached', key: proc.key, seq: proc.seq, pid: proc.child?.pid ?? null, meta: proc.meta, gap: proc.gap || firstBuffered > from });
    proc.gap = false;
    // Requests made before `from` and still unanswered go first, then every line since.
    for (const [, request] of proc.cliRequests) {
      if (request.seq < from && !SDK_REPLAYS.has(request.subtype)) send(conn, { op: 'out', seq: null, line: request.line });
    }
    for (const entry of proc.buffer) {
      if (entry.seq >= from && !stale(proc, entry)) send(conn, { op: 'out', seq: entry.seq, line: entry.line });
    }
    if (proc.exit) send(conn, { op: 'exit', ...proc.exit });
  }

  function detach(proc, conn) {
    if (proc.conn !== conn) return;
    proc.conn = null;
    if (proc.exit) scheduleForget(proc);
  }

  function spawnProc(conn, frame) {
    const existing = procs.get(frame.key);
    if (existing && !existing.exit) {
      send(conn, { op: 'error', error: `${frame.key} is already running` });
      conn.end();
      return null;
    }
    if (existing) forget(existing);
    const proc = {
      key: frame.key,
      child: null,
      meta: frame.meta ?? null,
      startedAt: now(),
      seq: 0,
      acked: 0,
      buffer: [],
      bufferBytes: 0,
      gap: false,
      cliRequests: new Map(), // request id -> {seq, line}: Claude Code asked, nobody answered yet
      sdkRequests: new Map(), // request id -> generation of the server that asked
      generation: 0,
      conn: null,
      exit: null,
      stdinRest: '',
      stdinEnded: false,
      forgetTimer: null,
    };
    let child;
    try {
      child = spawn(frame.command, frame.args ?? [], { cwd: frame.cwd, env: frame.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      send(conn, { op: 'error', error: error.message });
      conn.end();
      return null;
    }
    proc.child = child;
    procs.set(proc.key, proc);
    child.stdout.setEncoding('utf8');
    let rest = '';
    child.stdout.on('data', (chunk) => {
      rest += chunk;
      let index;
      while ((index = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, index);
        rest = rest.slice(index + 1);
        if (line) onStdoutLine(proc, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) log(`[${proc.key}] ${line}`);
    });
    child.stdin.on('error', () => {}); // a write after the process exited
    child.on('error', (error) => log(`[${proc.key}] ${error.message}`));
    child.on('exit', (code, signal) => {
      if (rest) onStdoutLine(proc, rest);
      rest = '';
      proc.exit = { code, signal };
      log(`[${proc.key}] exited (${signal || code})`);
      if (proc.conn) send(proc.conn, { op: 'exit', code, signal });
      else scheduleForget(proc);
    });
    log(`[${proc.key}] started pid ${child.pid}`);
    return proc;
  }

  function onConnection(conn) {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.setEncoding('utf8');
    let proc = null;
    let first = true;
    conn.on(
      'data',
      frameReader((frame) => {
        if (first) {
          first = false;
          if (frame.op === 'list') {
            send(conn, { op: 'list', protocol: HOST_PROTOCOL, pid: process.pid, procs: [...procs.values()].map(publicProc) });
            conn.end();
          } else if (frame.op === 'kill') {
            const target = procs.get(frame.key);
            if (target?.child && !target.exit) target.child.kill(frame.signal || 'SIGTERM');
            send(conn, { op: 'killed', found: Boolean(target) });
            conn.end();
          } else if (frame.op === 'spawn') {
            proc = spawnProc(conn, frame);
            if (proc) attach(proc, conn, 1);
          } else if (frame.op === 'attach') {
            proc = procs.get(frame.key) ?? null;
            if (!proc) {
              send(conn, { op: 'error', error: `${frame.key} is not running`, missing: true });
              conn.end();
            } else attach(proc, conn, Number.isInteger(frame.from) && frame.from > 0 ? frame.from : proc.acked + 1);
          } else {
            send(conn, { op: 'error', error: `unknown op ${frame.op}` });
            conn.end();
          }
          return;
        }
        if (!proc || proc.conn !== conn) return;
        switch (frame.op) {
          case 'in':
            writeStdin(proc, String(frame.data ?? ''));
            break;
          case 'end':
            if (!proc.exit && !proc.stdinEnded) {
              proc.stdinEnded = true;
              proc.child.stdin.end();
            }
            break;
          case 'kill':
            if (!proc.exit) proc.child.kill(frame.signal || 'SIGTERM');
            break;
          case 'ack':
            ack(proc, frame.seq);
            break;
          case 'meta':
            proc.meta = frame.meta ?? null;
            break;
          case 'detach':
            detach(proc, conn);
            conn.end();
            break;
        }
      }),
    );
    conn.on('close', () => {
      if (proc) detach(proc, conn);
    });
    conn.on('error', () => {});
  }

  function killAll(signal = 'SIGTERM') {
    for (const proc of procs.values()) {
      clearTimeout(proc.forgetTimer);
      if (proc.child && !proc.exit) proc.child.kill(signal);
    }
  }

  /** Drops every connection (stopping the host, tests). */
  function disconnectAll() {
    for (const conn of conns) conn.destroy();
  }

  return { onConnection, procs, killAll, disconnectAll, publicProc };
}

/** Listens on `socketPath` (mode 0600). Resolves the net.Server once listening. */
export async function startHost(socketPath, options = {}) {
  const host = createHost(options);
  // A socket file left by a host that died: nobody answers on it.
  if (fs.existsSync(socketPath)) {
    const alive = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (alive) throw new Error(`A CLI host is already listening on ${socketPath}`);
    fs.rmSync(socketPath, { force: true });
  }
  const server = net.createServer(host.onConnection);
  const oldMask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } finally {
    process.umask(oldMask);
  }
  fs.chmodSync(socketPath, 0o600);
  server.host = host;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error('usage: node server/cli-host.mjs <socket path>');
    process.exit(2);
  }
  const stamp = () => new Date().toISOString();
  const log = (line) => process.stderr.write(`${stamp()} ${line}\n`);
  startHost(socketPath, { log }).then(
    (server) => {
      log(`CLI host ${process.pid} listening on ${socketPath}`);
      // The host outlives server restarts; SIGTERM to the host itself ends its processes.
      const stop = (signal) => {
        log(`CLI host stopping (${signal}); ending ${server.host.procs.size} processes`);
        server.host.killAll('SIGTERM');
        server.close();
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGHUP', () => {}); // the terminal that started it is not its owner
    },
    (error) => {
      log(error.message);
      process.exit(1);
    },
  );
}
