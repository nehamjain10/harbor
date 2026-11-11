// Long-lived Claude Code processes: one SDK query() per active session, fed user
// messages through an open input stream, so later turns (and messages sent mid-turn)
// reuse the running CLI instead of launching a new one. This module only manages the
// processes: starting, reading, closing when idle, the cap on how many stay alive.
// What the messages mean for the session is the runner's business (onMessage/onExit).
import { CLI_CLOSE_GRACE_MS, CLI_IDLE_MS, CLI_MAX_PROCESSES } from './config.mjs';
import { hostSpawner } from './host-client.mjs';

/** The CLI host's key for a session's process. */
export const sessionKey = (sessionId) => `s:${sessionId}`;

/**
 * An async iterable of SDK user messages that stays open until end(). The SDK ends the
 * CLI's stdin when its prompt iterable finishes, so ending this closes the process
 * gracefully (it finishes what it is doing, saves its transcript and exits).
 */
export function createInputStream() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(message) {
      if (ended) throw new Error('The Claude Code process is closing.');
      items.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    get ended() {
      return ended;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift();
        if (ended) return;
        await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.query  the SDK query function
 * @param {(sessionId: string, cli: object) => boolean} [deps.isBusy]  true while the
 *   session's process must stay up (a turn, messages it has not taken yet, approvals,
 *   background tasks)
 * @param {number} [deps.idleMs]  close a process that has not been used for this long
 * @param {number} [deps.maxProcesses]  keep at most this many alive (least recently used
 *   idle ones close first; busy ones are never closed to make room)
 * @param {number} [deps.closeGraceMs]  how long a graceful close may take before the kill
 * @param {string} [deps.hostSocket]  the CLI host's socket (cli-host.mjs): processes run there
 *   and outlive this server; detachAll() lets go of them, reattach() takes one back
 */
export function createCliPool({
  query,
  isBusy = () => false,
  idleMs = CLI_IDLE_MS,
  maxProcesses = CLI_MAX_PROCESSES,
  closeGraceMs = CLI_CLOSE_GRACE_MS,
  hostSocket = null,
  log = console.error,
  now = Date.now,
}) {
  const clis = new Map(); // session id -> cli
  let spawned = 0;

  function get(sessionId) {
    const cli = clis.get(sessionId);
    return cli && !cli.closing ? cli : undefined;
  }

  /** Every process that is not closing. */
  function live() {
    return [...clis.values()].filter((cli) => !cli.closing);
  }

  function touch(cli) {
    cli.lastUsed = now();
  }

  /** Closes the process once it has been idle (and not busy) for idleMs. */
  function scheduleIdleCheck(cli, delay = idleMs) {
    clearTimeout(cli.idleTimer);
    cli.idleTimer = setTimeout(() => {
      if (cli.closing || cli.exited) return;
      const unused = now() - cli.lastUsed;
      if (isBusy(cli.sessionId, cli)) scheduleIdleCheck(cli);
      else if (unused < idleMs) scheduleIdleCheck(cli, idleMs - unused);
      else void close(cli.sessionId, 'idle');
    }, delay);
    cli.idleTimer.unref?.();
  }

  /** Closes least recently used idle processes until a new one fits under the cap. */
  function makeRoom() {
    const open = () => [...clis.values()].filter((cli) => !cli.closing);
    while (open().length >= maxProcesses) {
      const idle = open()
        .filter((cli) => !isBusy(cli.sessionId, cli))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      if (!idle.length) {
        log(`All ${open().length} Claude Code processes are busy; starting one more than the cap of ${maxProcesses}.`);
        return;
      }
      void close(idle[0].sessionId, 'evicted');
    }
  }

  /**
   * Starts the session's process. `state` is copied onto the returned cli (the runner
   * keeps model, effort, mode and route there). onMessage(message, cli) gets every SDK
   * message; onExit(error, cli) runs once when the process is gone, whatever the reason
   * (`cli.closing` says why when it was closed on purpose). `prepare` turns the SDK's
   * spawn request into another (a session on another cluster: see remote-spawn.mjs).
   */
  function start(sessionId, { options, state = {}, onMessage, onExit, reattach = false, prepare = null }) {
    if (clis.has(sessionId)) throw new Error(`Session ${sessionId} already has a Claude Code process.`);
    if (prepare && !hostSocket) throw new Error('Sessions on another cluster need the CLI host (WORKBENCH_CLI_HOST is off).');
    if (!reattach) makeRoom();
    const input = createInputStream();
    const abortController = options.abortController ?? new AbortController();
    let proc = null;
    const spawnOptions = hostSocket
      ? { spawnClaudeCodeProcess: hostSpawner(hostSocket, sessionKey(sessionId), { attach: reattach, prepare, log, onProcess: (p) => (proc = p) }) }
      : {};
    const stream = query({ prompt: input, options: { ...options, ...spawnOptions, abortController } });
    if (!reattach) spawned += 1;
    const cli = {
      ...state,
      sessionId,
      stream,
      input,
      abortController,
      outstanding: new Map(), // uuid -> message id: sent, not yet taken by the CLI
      backgroundTasks: 0,
      startedAt: now(),
      lastUsed: now(),
      closing: null, // why it was closed on purpose: idle, evicted, restart, stop, shutdown
      exited: false,
      detached: false, // let go of for the next server (detachAll)
      reattached: reattach,
      /** The process in the CLI host, once the SDK has started (or attached to) it. */
      get proc() {
        return proc;
      },
      /** Writes one user message to the CLI's stdin. */
      send(content, { uuid, priority } = {}) {
        touch(cli);
        input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid, ...(priority ? { priority } : {}) });
      },
    };
    clis.set(sessionId, cli);
    scheduleIdleCheck(cli);
    cli.done = (async () => {
      let failure = null;
      try {
        for await (const message of stream) {
          touch(cli);
          try {
            onMessage(message, cli);
          } catch (error) {
            log(`Could not apply a Claude Code message for session ${sessionId}: ${error.stack || error.message}`);
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        cli.exited = true;
        clearTimeout(cli.idleTimer);
        clearTimeout(cli.killTimer);
        if (clis.get(sessionId) === cli) clis.delete(sessionId);
        try {
          onExit(failure, cli);
        } catch (error) {
          log(`Could not settle the end of session ${sessionId}'s Claude Code process: ${error.message}`);
        }
      }
    })();
    return cli;
  }

  /** Ends the input so the CLI exits on its own; kills it if that takes too long. */
  function close(sessionId, reason = 'closed') {
    const cli = clis.get(sessionId);
    if (!cli) return Promise.resolve();
    if (!cli.closing) {
      cli.closing = reason;
      clearTimeout(cli.idleTimer);
      cli.input.end();
      // Kept referenced: the kill must happen even if nothing else is pending.
      cli.killTimer = setTimeout(() => kill(sessionId, reason), closeGraceMs);
    }
    return cli.done;
  }

  /** Terminates the process at once. */
  function kill(sessionId, reason = 'killed') {
    const cli = clis.get(sessionId);
    if (!cli) return Promise.resolve();
    cli.closing ??= reason;
    clearTimeout(cli.idleTimer);
    try {
      cli.stream.close?.();
    } catch (error) {
      log(`Could not close session ${sessionId}'s Claude Code process: ${error.message}`);
    }
    cli.abortController.abort();
    return cli.done;
  }

  /**
   * Server shutdown with a CLI host: every process keeps running there. `describe(cli)` is
   * kept with each one for the server that attaches next (reattach's `meta`).
   */
  function detachAll(describe = () => null) {
    for (const cli of clis.values()) {
      if (cli.exited) continue;
      cli.detached = true;
      clearTimeout(cli.idleTimer);
      clearTimeout(cli.killTimer);
      try {
        cli.proc?.setMeta(describe(cli));
      } catch (error) {
        log(`Could not keep the state of session ${cli.sessionId}'s process: ${error.message}`);
      }
      cli.proc?.detach();
    }
  }

  /**
   * Takes back a process a previous server left running in the CLI host: like start, but
   * the SDK attaches to it instead of starting one. Resolves the host's `attached` frame
   * ({meta, gap, ...}); rejects (and the cli ends) when the process is not there.
   * `onCli(cli)` runs as soon as the cli exists, before any message of it is applied.
   */
  async function reattach(sessionId, fields, onCli = () => {}) {
    if (!hostSocket) throw new Error('There is no CLI host to reattach to.');
    const cli = start(sessionId, { ...fields, reattach: true });
    // Before any of its messages arrive (they are read asynchronously).
    onCli(cli);
    // The SDK starts its transport on the first read; the process object exists by then.
    for (let i = 0; !cli.proc && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!cli.proc) throw new Error(`The SDK did not attach to session ${sessionId}'s process.`);
    return { cli, attached: await cli.proc.ready };
  }

  /** Server shutdown: busy processes are killed, idle ones asked to exit. */
  function closeAll() {
    for (const [sessionId, cli] of [...clis]) {
      if (isBusy(sessionId, cli)) void kill(sessionId, 'shutdown');
      else void close(sessionId, 'shutdown');
    }
  }

  return {
    get,
    live,
    start,
    reattach,
    touch,
    close,
    kill,
    closeAll,
    detachAll,
    get size() {
      return clis.size;
    },
    /** How many processes this pool has started (tests and diagnostics). */
    get spawned() {
      return spawned;
    },
  };
}
