import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCliPool, createInputStream } from '../server/cli-pool.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

/**
 * A minimal SDK query(): echoes each input message back, and exits when its input ends
 * (unless `stubborn`, which only a kill ends).
 */
function fakeQuery({ stubborn = false } = {}) {
  const started = [];
  const query = ({ prompt, options }) => {
    const out = [];
    let wake;
    let done = false;
    const finish = () => {
      done = true;
      wake?.();
    };
    options.abortController.signal.addEventListener('abort', finish);
    (async () => {
      for await (const message of prompt) {
        out.push({ type: 'echo', uuid: message.uuid, content: message.message.content, priority: message.priority });
        wake?.();
      }
      if (!stubborn) finish();
    })();
    const stream = {
      closed: false,
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (out.length) yield out.shift();
          if (done) return;
          await new Promise((resolve) => (wake = resolve));
        }
      },
      close() {
        stream.closed = true;
        finish();
      },
    };
    started.push(stream);
    return stream;
  };
  return { query, started };
}

function startOn(pool, sessionId, received = [], exits = []) {
  return pool.start(sessionId, {
    options: {},
    state: { model: 'm' },
    onMessage: (message) => received.push(message),
    onExit: (error, cli) => exits.push({ error, closing: cli.closing }),
  });
}

describe('createInputStream', () => {
  test('yields pushed messages in order and finishes after end()', async () => {
    const input = createInputStream();
    input.push(1);
    input.push(2);
    const seen = [];
    const reading = (async () => {
      for await (const item of input) seen.push(item);
    })();
    await sleep(5);
    input.push(3);
    input.end();
    await reading;
    assert.deepEqual(seen, [1, 2, 3]);
    assert.throws(() => input.push(4), /closing/);
  });
});

describe('createCliPool', () => {
  test('one process per session; messages go in, everything that comes out reaches onMessage', async () => {
    const { query, started } = fakeQuery();
    const pool = createCliPool({ query, log: () => {} });
    const received = [];
    const cli = startOn(pool, 's1', received);
    assert.equal(cli.model, 'm', 'state is kept on the process');
    assert.throws(() => startOn(pool, 's1'), /already has a Claude Code process/);
    cli.send('hello', { uuid: 'u1' });
    cli.send('steer', { uuid: 'u2', priority: 'next' });
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, [
      { type: 'echo', uuid: 'u1', content: 'hello', priority: undefined },
      { type: 'echo', uuid: 'u2', content: 'steer', priority: 'next' },
    ]);
    assert.equal(pool.get('s1'), cli);
    assert.equal(pool.spawned, 1);
    assert.equal(started.length, 1);
    await pool.close('s1');
  });

  test('a process unused for the idle time closes gracefully; a busy one stays', async () => {
    const { query, started } = fakeQuery();
    let busy = true;
    const pool = createCliPool({ query, idleMs: 30, isBusy: () => busy, log: () => {} });
    const exits = [];
    startOn(pool, 's1', [], exits);
    await sleep(80);
    assert.equal(pool.size, 1, 'busy: kept');
    busy = false;
    await waitFor(() => exits.length === 1);
    assert.deepEqual(exits, [{ error: null, closing: 'idle' }]);
    assert.equal(started[0].closed, false, 'ended its input instead of killing it');
    assert.equal(pool.size, 0);
    assert.equal(pool.get('s1'), undefined);
  });

  test('a graceful close that hangs is followed by a kill', async () => {
    const { query, started } = fakeQuery({ stubborn: true });
    const pool = createCliPool({ query, closeGraceMs: 20, log: () => {} });
    const exits = [];
    startOn(pool, 's1', [], exits);
    const closing = pool.close('s1', 'restart');
    assert.equal(pool.get('s1'), undefined, 'a closing process takes no new turns');
    await closing;
    assert.equal(started[0].closed, true);
    assert.deepEqual(exits, [{ error: null, closing: 'restart' }]);
  });

  test('at the cap the least recently used idle process closes; busy ones never do', async () => {
    const { query } = fakeQuery();
    const busy = new Set();
    const logged = [];
    const pool = createCliPool({ query, maxProcesses: 2, isBusy: (id) => busy.has(id), log: (line) => logged.push(line) });
    const exits = { a: [], b: [], c: [], d: [] };
    const a = startOn(pool, 'a', [], exits.a);
    await sleep(2);
    startOn(pool, 'b', [], exits.b);
    await sleep(2);
    pool.touch(a);
    startOn(pool, 'c', [], exits.c);
    await waitFor(() => exits.b.length === 1);
    assert.deepEqual(exits.b, [{ error: null, closing: 'evicted' }]);
    assert.equal(exits.a.length, 0);

    busy.add('a');
    busy.add('c');
    startOn(pool, 'd', [], exits.d);
    assert.equal(pool.size, 3, 'all busy: one over the cap rather than cutting a turn off');
    assert.match(logged[0], /All 2 Claude Code processes are busy/);
    busy.clear();
    pool.closeAll();
    await waitFor(() => pool.size === 0);
  });

  test('closeAll kills busy processes and closes idle ones', async () => {
    const { query, started } = fakeQuery({ stubborn: true });
    const pool = createCliPool({ query, closeGraceMs: 20, isBusy: (id) => id === 'busy', log: () => {} });
    const exits = { busy: [], idle: [] };
    startOn(pool, 'busy', [], exits.busy);
    startOn(pool, 'idle', [], exits.idle);
    pool.closeAll();
    await waitFor(() => exits.busy.length === 1);
    assert.equal(exits.idle.length, 0, 'the idle one gets its grace period');
    assert.equal(started[0].closed, true);
    await waitFor(() => exits.idle.length === 1);
    assert.deepEqual([exits.busy[0].closing, exits.idle[0].closing], ['shutdown', 'shutdown']);
  });

  test('a crash reaches onExit with the error, and a throwing onMessage never stops the reader', async () => {
    const logged = [];
    const query = () => ({
      async *[Symbol.asyncIterator]() {
        yield { n: 1 };
        yield { n: 2 };
        throw new Error('exited with code 1');
      },
    });
    const pool = createCliPool({ query, log: (line) => logged.push(line) });
    const exits = [];
    const seen = [];
    pool.start('s1', {
      options: {},
      onMessage: (message) => {
        seen.push(message.n);
        if (message.n === 1) throw new Error('bad message');
      },
      onExit: (error, cli) => exits.push({ error: error?.message, closing: cli.closing }),
    });
    await waitFor(() => exits.length === 1);
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(exits, [{ error: 'exited with code 1', closing: null }]);
    assert.match(logged[0], /bad message/);
    assert.equal(pool.size, 0);
  });
});
