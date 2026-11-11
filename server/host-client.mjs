// The web server's side of the CLI host (cli-host.mjs): starting the host when it is not
// running, listing its processes, and HostProcess, which the SDK drives like a child
// process (its `spawnClaudeCodeProcess` option) while the real one lives in the host.
//
// A HostProcess hands the SDK each line the host sends and confirms it (`ack`) once it
// has. detach() is for a server shutting down: it stops reading, confirms what it handed
// over and lets go, leaving the process running for the next server to attach() to.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HOST_SCRIPT = fileURLToPath(new URL('./cli-host.mjs', import.meta.url));
const ACK_MS = 250;
const START_WAIT_MS = 5000;
// A spawn waits up to this long for a process the host still has under the same key to
// exit: the SDK lets go of a killed process before it has died, and a new one started at
// once would be refused as "already running" (a host from before cli-host's own wait).
const KEY_FREE_WAIT_MS = 10_000;
const KEY_FREE_POLL_MS = 100;

function frames(onFrame) {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    let index;
    while ((index = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, index);
      rest = rest.slice(index + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line));
      } catch {
        // a broken frame: skipped
      }
    }
  };
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    conn.once('connect', () => {
      conn.off('error', reject);
      resolve(conn);
    });
    conn.once('error', reject);
  });
}

/** One request, one reply: `list` and `kill`. */
async function ask(socketPath, frame) {
  const conn = await connect(socketPath);
  conn.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let reply = null;
    conn.on(
      'data',
      frames((value) => {
        reply = value;
      }),
    );
    conn.on('close', () => (reply ? resolve(reply) : reject(new Error('The CLI host closed the connection without an answer.'))));
    conn.on('error', reject);
    conn.write(JSON.stringify(frame) + '\n');
  });
}

/** The host's processes: [{key, pid, startedAt, seq, acked, attached, exit, meta}]. */
export async function listHost(socketPath) {
  const reply = await ask(socketPath, { op: 'list' });
  return reply.procs ?? [];
}

/** Waits (up to `ms`) until the host has no live process under `key`. */
export async function waitKeyFree(socketPath, key, ms = KEY_FREE_WAIT_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const procs = await listHost(socketPath).catch(() => []);
    if (!procs.some((proc) => proc.key === key && !proc.exit)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, KEY_FREE_POLL_MS));
  }
}

export async function killInHost(socketPath, key, signal = 'SIGTERM') {
  return ask(socketPath, { op: 'kill', key, signal });
}

/**
 * Makes sure a host answers on `socketPath`, starting one (detached, in its own session,
 * so it outlives this server) when none does. Resolves its pid.
 */
export async function ensureHost({ socketPath, logFile, nodePath = process.execPath, log = console.error }) {
  try {
    return (await ask(socketPath, { op: 'list' })).pid;
  } catch {
    // not running: start it
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const out = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(nodePath, [HOST_SCRIPT, socketPath], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const pid = (await ask(socketPath, { op: 'list' })).pid;
      log(`Started the CLI host (pid ${pid}); Claude Code processes now outlive server restarts.`);
      return pid;
    } catch {
      // not listening yet
    }
  }
  throw new Error(`The CLI host did not start; see ${logFile}`);
}

/**
 * A process in the host as the SDK sees a child process. `first` is the connection's
 * opening frame: {op:'spawn', ...} or {op:'attach', key, from}.
 */
export class HostProcess extends EventEmitter {
  constructor(socketPath, first, { key = first.key, log = console.error, keyFreeWaitMs = KEY_FREE_WAIT_MS } = {}) {
    super();
    this.key = key;
    this.keyFreeWaitMs = keyFreeWaitMs;
    this.socketPath = socketPath;
    this.log = log;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.pid = null;
    this.acked = 0;
    // Numbered lines written to stdout and where each ends in the byte stream: a line
    // counts as handed over once the SDK has read past its end.
    this.written = [];
    this.writtenBytes = 0;
    this.detached = false;
    this.exited = false;
    this.meta = null; // what the host kept for this process (attach)
    this.gap = false;
    this.conn = null;
    this.pending = []; // frames written before the connection is up
    this.stdout = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => {
        this.write({ op: 'in', data: String(chunk) });
        callback();
      },
      final: (callback) => {
        this.write({ op: 'end' });
        callback();
      },
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.open(first);
  }

  async open(first) {
    let conn;
    try {
      // A remote process prepares its spawn first (remote-spawn.mjs): the binary, ssh.
      first = await first;
    } catch (error) {
      this.fail(error);
      return;
    }
    if (first.op === 'spawn') await waitKeyFree(this.socketPath, first.key, this.keyFreeWaitMs);
    if (this.killed) {
      // Killed (the SDK gave up) before it was started: it never is.
      this.finish(null, 'SIGTERM');
      return;
    }
    try {
      conn = await connect(this.socketPath);
    } catch (error) {
      this.fail(new Error(`The CLI host is not answering: ${error.message}`));
      return;
    }
    this.conn = conn;
    conn.setEncoding('utf8');
    conn.on('data', frames((frame) => this.onFrame(frame)));
    conn.on('close', () => this.onClose());
    conn.on('error', () => {});
    conn.write(JSON.stringify(first) + '\n');
    for (const frame of this.pending) conn.write(JSON.stringify(frame) + '\n');
    this.pending = [];
    this.ackTimer = setInterval(() => this.ack(), ACK_MS);
    this.ackTimer.unref?.();
  }

  write(frame) {
    if (this.detached) return;
    if (!this.conn) this.pending.push(frame);
    else if (!this.conn.destroyed) this.conn.write(JSON.stringify(frame) + '\n');
  }

  /** The last numbered line the SDK has read. */
  consumed() {
    const read = this.writtenBytes - this.stdout.readableLength;
    let seq = this.acked;
    while (this.written.length && this.written[0].end <= read) seq = this.written.shift().seq;
    return seq;
  }

  ack() {
    const seq = this.consumed();
    if (seq > this.acked && this.conn && !this.conn.destroyed) {
      this.acked = seq;
      this.conn.write(JSON.stringify({ op: 'ack', seq }) + '\n');
    }
  }

  onFrame(frame) {
    if (this.detached) return;
    switch (frame.op) {
      case 'attached':
        this.pid = frame.pid;
        this.meta = frame.meta ?? null;
        this.gap = Boolean(frame.gap);
        this.resolveReady(frame);
        break;
      case 'out': {
        // Killed: like a child process nobody reads any more, its last words are not heard.
        if (this.killed) break;
        const text = frame.line + '\n';
        this.writtenBytes += Buffer.byteLength(text);
        // A resent request (seq null) is not numbered: nothing to confirm.
        if (Number.isInteger(frame.seq)) this.written.push({ seq: frame.seq, end: this.writtenBytes });
        this.stdout.write(text);
        break;
      }
      case 'exit':
        this.finish(frame.code ?? null, frame.signal ?? null);
        break;
      case 'error':
        this.fail(Object.assign(new Error(frame.error), { missing: Boolean(frame.missing) }));
        break;
      case 'replaced':
        // Another connection took the process over (a second server): this one is done.
        this.detached = true;
        this.finish(null, 'SIGHUP');
        break;
    }
  }

  onClose() {
    clearInterval(this.ackTimer);
    if (this.detached || this.exited) return;
    // The host went away under a live process: as far as the SDK knows, it died.
    this.log(`Lost the CLI host connection for ${this.key}.`);
    this.finish(1, null);
  }

  fail(error) {
    this.rejectReady(error);
    this.emit('error', error);
    this.finish(1, null);
  }

  finish(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    clearInterval(this.ackTimer);
    this.stdout.end();
    this.emit('exit', code, signal);
    if (this.conn && !this.conn.destroyed) {
      this.ack();
      this.conn.end();
    }
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.write({ op: 'kill', signal });
    return true;
  }

  /** Keeps state with the process for the next server (see attach's `meta`). */
  setMeta(meta) {
    this.write({ op: 'meta', meta });
  }

  /**
   * Lets go without ending the process: nothing more reaches the SDK, what it was handed is
   * confirmed, and the rest waits in the host for the next server.
   */
  detach() {
    if (this.detached || this.exited) return;
    this.ack();
    this.write({ op: 'detach' });
    this.detached = true;
    clearInterval(this.ackTimer);
    this.conn?.end();
  }
}

/**
 * An SDK `spawnClaudeCodeProcess` that runs Claude Code in the host under `key`, or, with
 * `attach`, connects the SDK to the process already running there under that key.
 * `prepare(options)` may turn the SDK's spawn request into another one (async): a remote
 * session's runs Claude Code over ssh (remote-spawn.mjs).
 */
export function hostSpawner(socketPath, key, { meta = null, attach = false, prepare = null, log = console.error, onProcess = () => {} } = {}) {
  return (options) => {
    const spawnFrame = (request) => ({ op: 'spawn', key, command: request.command, args: request.args, cwd: request.cwd, env: request.env, meta });
    const first = attach ? { op: 'attach', key } : prepare ? Promise.resolve().then(() => prepare(options)).then(spawnFrame) : spawnFrame(options);
    const proc = new HostProcess(socketPath, first, { key, log });
    // The SDK aborts after the stdin-EOF grace: that is a kill.
    options.signal?.addEventListener?.('abort', () => {
      if (!proc.detached && !proc.exited) proc.kill('SIGTERM');
    });
    onProcess(proc);
    return proc;
  };
}
