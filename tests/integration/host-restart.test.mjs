// Server restarts with the CLI host (cli-host.mjs): a real Claude Code process keeps its
// turn, its pending approval and its conversation while the "server" (store, runner,
// gateway proxy) is replaced, and the new server carries on with it. Run with
// `npm run test:integration`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startHost } from '../../server/cli-host.mjs';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { listHost } from '../../server/host-client.mjs';
import { DELEGATE_TOOL, workerKey } from '../../server/model-agents.mjs';
import { createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startMockGateway } from '../mock-gateway.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TIMEOUT_MS = 60_000;

let base;
let mock;
let host;
let hostSocket;
const servers = [];

before(async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-host-restart-'));
  mock = await startMockGateway();
  hostSocket = path.join(base, 'host.sock');
  host = await startHost(hostSocket, { log: () => {} });
});

after(async () => {
  for (const server of servers) await server.proxy.close().catch(() => {});
  host?.host.killAll('SIGKILL');
  host?.host.disconnectAll();
  host?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

async function waitFor(predicate, message = 'condition', timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** One "server": store, events, gateway proxy and runner over a shared data folder. */
async function startServer(dir, { proxyAddress } = {}) {
  const store = createStore({ dataDir: path.join(dir, 'data') });
  const procs = await listHost(hostSocket);
  store.load({ live: new Set(procs.filter((p) => p.key.startsWith('s:')).map((p) => p.key.slice(2))) });
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {}, ...(proxyAddress ?? {}) });
  const config = {
    claudeExecutable: CLAUDE,
    gatewayUrl: mock.url,
    settingSources: [],
    claudeConfigDir: path.join(dir, 'claude-config'),
    cliHostSocket: hostSocket,
    claudeRelay: false,
  };
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, log: () => {} });
  const server = { store, events, proxy, runner };
  servers.push(server);
  const taken = await runner.reattach(procs, (id) => store.sessions.get(id));
  return { ...server, taken };
}

/** What a deploy does to the old server: SIGTERM with a CLI host. */
async function stopServer(server) {
  server.runner.detach();
  server.store.saveAll();
  await server.proxy.close();
}

function setupDir() {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  fs.mkdirSync(path.join(dir, 'work'));
  fs.mkdirSync(path.join(dir, 'claude-config'));
  return dir;
}

const lastText = (session) => session.messages.filter((m) => m.role === 'assistant' && m.text).at(-1)?.text ?? '';

describe('server restarts with the CLI host', { skip }, () => {
  test('a turn waiting on an approval survives a restart; the new server asks again and finishes it', async () => {
    const dir = setupDir();
    const a = await startServer(dir);
    const session = a.store.insert(createSession({ cwd: path.join(dir, 'work'), model: 'luna', mode: 'default' }));
    a.runner.enqueue(session, { text: '[[mock:bash:touch survived.txt]] make it' });
    await waitFor(() => session.pending?.length > 0, 'the approval');
    const procsBefore = await listHost(hostSocket);
    const pid = procsBefore.find((p) => p.key === `s:${session.id}`).pid;

    await stopServer(a);
    const b = await startServer(dir, { proxyAddress: { port: a.proxy.port, secret: a.proxy.secret } });
    assert.deepEqual(b.taken, [session.id]);
    const revived = b.store.sessions.get(session.id);
    assert.notEqual(revived.status, 'interrupted');
    assert.ok(b.runner.isRunning(session.id), 'the turn is still under way');

    await waitFor(() => revived.pending?.length > 0, 'the approval asked again');
    assert.equal(revived.pending[0].tool, 'Bash');
    assert.equal(b.runner.resolveApproval(revived.pending[0].id, { decision: 'allow' }), true);
    await waitFor(() => !b.runner.isRunning(session.id), 'the turn to finish');
    assert.ok(fs.existsSync(path.join(dir, 'work', 'survived.txt')), 'the approved command ran');
    assert.match(lastText(revived), /Tool result: ok/);
    assert.equal(revived.status, 'idle');
    assert.deepEqual(revived.pending, [], 'asked once, not again by the host and the SDK');
    assert.equal(revived.messages.find((m) => m.role === 'user').delivery, 'done');
    const procsAfter = await listHost(hostSocket);
    assert.equal(procsAfter.find((p) => p.key === `s:${session.id}`).pid, pid, 'the same Claude Code process');
    assert.ok(!revived.messages.some((m) => m.kind === 'notice' && /restarted/.test(m.text || '')), 'no restart notice');
    await stopServer(b);
  });

  test('a streaming reply goes on across a restart, and the next turn reuses the process', async () => {
    const dir = setupDir();
    const a = await startServer(dir);
    const session = a.store.insert(createSession({ cwd: path.join(dir, 'work'), model: 'luna', mode: 'bypassPermissions' }));
    a.runner.enqueue(session, { text: '[[mock:slow]] tell me slowly' });
    await waitFor(() => (session.live || '').length > 5, 'the reply to start streaming');
    await stopServer(a);
    // The process keeps streaming into the host while no server is attached.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const b = await startServer(dir, { proxyAddress: { port: a.proxy.port, secret: a.proxy.secret } });
    const revived = b.store.sessions.get(session.id);
    await waitFor(() => !b.runner.isRunning(session.id), 'the slow turn to finish');
    assert.equal(revived.status, 'idle');
    const reply = lastText(revived);
    assert.ok(reply.length > 20, `a whole reply: ${reply}`);
    assert.equal(revived.messages.filter((m) => m.role === 'assistant' && m.text === reply).length, 1, 'not applied twice');

    // An idle reattached process takes the next turn: no new spawn.
    const pid = (await listHost(hostSocket)).find((p) => p.key === `s:${session.id}`).pid;
    b.runner.enqueue(revived, { text: 'and once more' });
    await waitFor(() => !b.runner.isRunning(session.id) && revived.messages.filter((m) => m.role === 'assistant').length >= 2, 'the next turn');
    assert.equal(lastText(revived), 'ok');
    assert.equal((await listHost(hostSocket)).find((p) => p.key === `s:${session.id}`).pid, pid);
    assert.equal(b.runner.pool.spawned, 0, 'the new server started no process');
    await stopServer(b);
  });

  test('a worker mid-command and the lead waiting on it both carry on: one report, one worker', async () => {
    const dir = setupDir();
    const a = await startServer(dir);
    const session = a.store.insert(createSession({ cwd: path.join(dir, 'work'), model: 'luna', mode: 'bypassPermissions' }));
    a.runner.enqueue(session, { text: '[[mock:delegate:luna;wait;sleep=4]] split the work' });
    const card = () => a.store.sessions.get(session.id).messages.find((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL && m.agentId);
    await waitFor(() => card() && session.messages.some((m) => m.parentToolId === card().toolId && m.role === 'tool' && m.tool === 'Bash'), 'the worker’s command');
    const agentId = card().agentId;
    const workerPid = (await listHost(hostSocket)).find((p) => p.key === workerKey(agentId))?.pid;
    assert.ok(workerPid, 'the worker runs in the host');

    await stopServer(a);
    const b = await startServer(dir, { proxyAddress: { port: a.proxy.port, secret: a.proxy.secret } });
    const revived = b.store.sessions.get(session.id);
    assert.equal(b.runner.modelAgents.list(session.id).length, 1, 'the worker is taken back');
    await waitFor(() => !b.runner.isRunning(session.id) && b.runner.modelAgents.running(session.id) === 0, 'the lead and the worker to finish');
    const cards = revived.messages.filter((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL);
    assert.equal(cards.length, 1, 'one worker, not started again');
    assert.equal(cards[0].state, 'done', cards[0].output);
    assert.match(cards[0].output, /Worker finished/);
    assert.match(cards[0].output, /Commands \(1\): `sleep 4 && echo worker-ok`/, 'its report includes what it did before the restart');
    const waitCall = revived.messages.find((m) => m.role === 'tool' && /wait_agents/.test(m.tool));
    assert.equal(waitCall?.state, 'done');
    assert.match(waitCall.output, /Worker finished/, 'wait_agents returned the report');
    assert.equal(revived.status, 'idle');
    assert.ok(!revived.messages.some((m) => m.role === 'notice' && m.agentToolId), 'no separate report: the lead waited for it');
    assert.equal(b.runner.pool.spawned, 0);
    await stopServer(b);
  });

  test('a worker waiting on an approval is asked again by the new server, once', async () => {
    const dir = setupDir();
    const a = await startServer(dir);
    const session = a.store.insert(createSession({ cwd: path.join(dir, 'work'), model: 'luna', mode: 'default' }));
    a.runner.enqueue(session, { text: '[[mock:delegate:luna;wait;sleep=1;ask]] split the work' });
    await waitFor(() => session.pending?.some((p) => p.agent), 'the worker’s approval');

    await stopServer(a);
    const b = await startServer(dir, { proxyAddress: { port: a.proxy.port, secret: a.proxy.secret } });
    const revived = b.store.sessions.get(session.id);
    await waitFor(() => revived.pending?.length > 0, 'the approval asked again');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(revived.pending.length, 1, 'asked once');
    assert.ok(revived.pending[0].agent, 'labelled with the worker');
    assert.equal(b.runner.resolveApproval(revived.pending[0].id, { decision: 'allow' }), true);
    await waitFor(() => !b.runner.isRunning(session.id) && b.runner.modelAgents.running(session.id) === 0, 'the lead and the worker to finish');
    assert.ok(fs.existsSync(path.join(dir, 'work', 'part-1.txt')), 'the approved command ran');
    const [card] = revived.messages.filter((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL);
    assert.equal(card.state, 'done', card.output);
    assert.deepEqual(revived.pending, []);
    await stopServer(b);
  });
});
