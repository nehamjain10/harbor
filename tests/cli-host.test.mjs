// The CLI host keeps processes alive across server connections (cli-host.mjs, host-client.mjs).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../server/cli-host.mjs';
import { HostProcess, listHost } from '../server/host-client.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/fake-cli-host-child.mjs', import.meta.url));
let dir;
let socketPath;
let server;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-host-'));
  socketPath = path.join(dir, 'host.sock');
  server = await startHost(socketPath, { log: () => {} });
});

after(() => {
  server.host.killAll('SIGKILL');
  server.host.disconnectAll();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A connection that collects parsed stdout lines, as the SDK would read them. */
function client(first, options = {}) {
  const proc = new HostProcess(socketPath, first, { log: () => {}, ...options });
  const lines = [];
  let rest = '';
  proc.stdout.on('data', (chunk) => {
    rest += chunk;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(rest.slice(0, i)));
      rest = rest.slice(i + 1);
    }
  });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  const send = (value) => proc.stdin.write(JSON.stringify(value) + '\n');
  return { proc, lines, send, exited };
}

async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const spawnFrame = (key, meta) => ({ op: 'spawn', key, command: process.execPath, args: [CHILD], cwd: dir, env: process.env, meta });
const numbers = (lines) => lines.filter((l) => l.type === 'line').map((l) => l.n);

test('a detached process keeps running; the next connection gets every line it had not read, once', async () => {
  const a = client(spawnFrame('s:one', { turn: 'x' }));
  await a.proc.ready;
  a.send({ cmd: 'emit', n: 5 });
  await until(() => numbers(a.lines).length === 5);
  a.send({ cmd: 'emit', n: 20, delay: 20 });
  await until(() => numbers(a.lines).length >= 8);
  a.proc.setMeta({ turn: 'y' });
  a.proc.detach();
  const seenByA = numbers(a.lines);
  await new Promise((r) => setTimeout(r, 300));
  const listed = (await listHost(socketPath)).find((p) => p.key === 's:one');
  assert.equal(listed.attached, false);
  assert.equal(listed.exit, null);
  assert.deepEqual(listed.meta, { turn: 'y' });

  const b = client({ op: 'attach', key: 's:one' });
  const attached = await b.proc.ready;
  assert.deepEqual(attached.meta, { turn: 'y' });
  assert.equal(attached.gap, false);
  await until(() => numbers(b.lines).at(-1) === 25, 5000);
  assert.deepEqual([...seenByA, ...numbers(b.lines)], Array.from({ length: 25 }, (_, i) => i + 1));
  b.send({ cmd: 'exit' });
  assert.equal(await b.exited, 0);
});

test('a request nobody answered is sent again to the next connection; answers to the old one are dropped', async () => {
  const a = client(spawnFrame('s:two'));
  await a.proc.ready;
  a.send({ cmd: 'request', id: 'approve-1' });
  // The SDK asks for approvals again itself (from its `initialize` answer): not resent.
  a.send({ cmd: 'request', id: 'tool-1', subtype: 'can_use_tool' });
  // The old connection asks Claude Code something; the answer comes after it left.
  a.send({ type: 'control_request', request_id: 'old-ask', request: {}, delay: 400 });
  await until(() => a.lines.some((l) => l.request_id === 'tool-1'));
  a.proc.detach();

  const b = client({ op: 'attach', key: 's:two' });
  await b.proc.ready;
  await until(() => b.lines.some((l) => l.request_id === 'approve-1'));
  b.send({ type: 'control_response', response: { subtype: 'success', request_id: 'approve-1' } });
  await until(() => b.lines.some((l) => l.type === 'got' && l.id === 'approve-1'));
  assert.equal(b.lines.filter((l) => l.request_id === 'tool-1').length, 0, 'an approval request is left to the SDK');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(b.lines.filter((l) => l.type === 'control_response').length, 0, 'the old answer is not delivered');

  // Answered now: a third connection does not get it again.
  b.proc.detach();
  const c = client({ op: 'attach', key: 's:two' });
  await c.proc.ready;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.lines.filter((l) => l.request_id === 'approve-1').length, 0);
  c.send({ cmd: 'exit' });
  await c.exited;
});

test('a process that exits while detached hands over its last lines and its exit', async () => {
  const a = client(spawnFrame('s:three'));
  await a.proc.ready;
  a.send({ cmd: 'emit', n: 2 });
  await until(() => numbers(a.lines).length === 2);
  a.send({ cmd: 'emit', n: 3, delay: 100 });
  a.send({ cmd: 'exit', code: 3 });
  a.proc.detach();
  await new Promise((r) => setTimeout(r, 600));
  const b = client({ op: 'attach', key: 's:three' });
  await b.proc.ready;
  assert.equal(await b.exited, 3);
  assert.equal(numbers(a.lines).length + numbers(b.lines).length >= 2, true);
  assert.deepEqual([...numbers(a.lines), ...numbers(b.lines)], [...new Set([...numbers(a.lines), ...numbers(b.lines)])], 'no line twice');
});

test('a spawn waits for the key’s old process to finish dying; a live one still refuses it', async () => {
  const a = client(spawnFrame('s:dying'));
  await a.proc.ready;
  a.send({ cmd: 'slowTerm', ms: 400 });
  await until(() => a.lines.some((l) => l.type === 'slowTerm'));

  const twin = client(spawnFrame('s:dying'), { keyFreeWaitMs: 200 });
  assert.match((await twin.proc.ready.catch((error) => error)).message, /already running/);

  a.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 20));
  const b = client(spawnFrame('s:dying'));
  b.send({ cmd: 'emit', n: 2 });
  await b.proc.ready;
  assert.equal(await a.exited, 143);
  await until(() => numbers(b.lines).length === 2);
  b.send({ cmd: 'exit' });
  assert.equal(await b.exited, 0);
});

test('attaching to a key the host does not have fails as missing', async () => {
  const x = client({ op: 'attach', key: 's:nope' });
  await assert.rejects(x.proc.ready, (error) => error.missing === true);
});
