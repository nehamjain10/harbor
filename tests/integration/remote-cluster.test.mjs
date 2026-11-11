// Sessions on another cluster (remote-spawn.mjs): a real Claude Code process started
// through the CLI host over "ssh", here tests/fake-ssh.mjs, which runs the remote command
// on this machine in a fake remote HOME and relays the reverse tunnel. Its turns reach
// the mock gateway through the tunnel and the gateway proxy; its workers run there too;
// ending the process ends the remote one; a server restart takes it back. Run with
// `npm run test:integration`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sessionKey } from '../../server/cli-pool.mjs';
import { startHost } from '../../server/cli-host.mjs';
import { createClusters } from '../../server/clusters.mjs';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { listHost } from '../../server/host-client.mjs';
import { DELEGATE_TOOL, workerKey } from '../../server/model-agents.mjs';
import { localClaude } from '../../server/remote-claude.mjs';
import { pickTunnelPort } from '../../server/remote-command.mjs';
import { createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startMockGateway } from '../mock-gateway.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const FAKE_SSH = fileURLToPath(new URL('../fake-ssh.mjs', import.meta.url));
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TIMEOUT_MS = 60_000;
const CLUSTERS = [
  { id: 'local', label: 'Here', host: null },
  { id: 'fake', label: 'Fake cluster', host: 'fake-login' },
];

let base;
let remoteHome;
let pidFile;
let mock;
let host;
let hostSocket;
let savedSsh;
const servers = [];

before(async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-remote-'));
  remoteHome = path.join(base, 'remote-home');
  fs.mkdirSync(remoteHome);
  pidFile = path.join(base, 'remote-pids');
  // The "ssh" every part of Harbor runs (WORKBENCH_SSH): the fake, in the fake remote HOME.
  const ssh = path.join(base, 'ssh');
  fs.writeFileSync(ssh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SSH)} --home ${JSON.stringify(remoteHome)} --pids ${JSON.stringify(pidFile)} "$@"\n`, { mode: 0o700 });
  savedSsh = process.env.WORKBENCH_SSH;
  process.env.WORKBENCH_SSH = ssh;
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
  // Remote commands the fake left running (none should be).
  for (const pid of remotePids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  if (savedSsh === undefined) delete process.env.WORKBENCH_SSH;
  else process.env.WORKBENCH_SSH = savedSsh;
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

async function waitFor(predicate, message = 'condition', timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The remote commands the fake ssh started (their sh pids). */
function remotePids() {
  if (!pidFile || !fs.existsSync(pidFile)) return [];
  return fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0]));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Running processes whose executable is the copy of Claude Code in the remote HOME. */
function remoteClaudes() {
  const shipped = path.join(remoteHome, '.local/share/harbor');
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.readlinkSync(`/proc/${entry}/exe`).startsWith(shipped)) found.push(Number(entry));
    } catch {
      // not ours, or gone
    }
  }
  return found;
}

/** Every process command line that mentions `needle`. */
function commandLinesWith(needle) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const line = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (line.includes(needle)) found.push(line.replaceAll('\0', ' '));
    } catch {
      // gone
    }
  }
  return found;
}

/** One "server": store, events, gateway proxy and runner with the fake cluster. */
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
  const clusters = createClusters({ list: CLUSTERS, log: () => {} });
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, clusters, log: () => {} });
  const server = { store, events, proxy, runner };
  servers.push(server);
  const taken = await runner.reattach(procs, (id) => store.sessions.get(id));
  return { ...server, taken };
}

async function stopServer(server) {
  server.runner.detach();
  server.store.saveAll();
  await server.proxy.close();
}

function setupDir() {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  fs.mkdirSync(path.join(dir, 'claude-config'));
  const work = fs.mkdtempSync(path.join(remoteHome, 'work-'));
  return { dir, work };
}

const remoteSession = (store, work, extra = {}) => store.insert(createSession({ cwd: work, model: 'luna', mode: 'bypassPermissions', cluster: 'fake', ...extra }));
const lastText = (session) => session.messages.filter((m) => m.role === 'assistant' && m.text).at(-1)?.text ?? '';

describe('sessions on another cluster', { skip }, () => {
  test('a turn runs there: the copied CLI, its HOME and folder, the gateway through the tunnel, no secret on a command line', async () => {
    const { dir, work } = setupDir();
    const a = await startServer(dir);
    const session = remoteSession(a.store, work);
    // Another user holds the first tunnel port: the next one is used.
    const taken = net.createServer();
    await new Promise((resolve) => taken.listen(pickTunnelPort(sessionKey(session.id), 0), '127.0.0.1', resolve));
    try {
      a.runner.enqueue(session, { text: '[[mock:bash:pwd > where.txt; printf %s "$HOME" > home.txt]] where are you' });
      await waitFor(() => !a.runner.isRunning(session.id) && session.messages.some((m) => m.role === 'assistant'), 'the remote turn');
      assert.equal(session.status, 'idle', JSON.stringify(session.messages.filter((m) => m.role === 'notice')));
      assert.match(lastText(session), /Tool result/);
      assert.equal(fs.readFileSync(path.join(work, 'where.txt'), 'utf8').trim(), work, 'it ran in the session folder');
      assert.equal(fs.readFileSync(path.join(work, 'home.txt'), 'utf8'), remoteHome, 'with the remote HOME');
      const { version } = localClaude(CLAUDE);
      assert.ok(fs.existsSync(path.join(remoteHome, '.local/share/harbor', `claude-${version}`)), 'this machine’s CLI was copied there');
      assert.ok(mock.requests.some((r) => r.path === '/v1/messages' && r.model === 'codex/gpt-6-luna'), 'the gateway answered through the tunnel');
      assert.deepEqual(commandLinesWith(a.proxy.secret), [], 'the proxy secret is on no command line');
      assert.equal(remoteClaudes().length, 1, 'one remote CLI');
    } finally {
      taken.close();
    }
    await a.runner.pool.close(session.id);
    await waitFor(() => remoteClaudes().length === 0, 'the remote CLI to exit');
    await stopServer(a);
  });

  test('a worker of a remote session runs on the same cluster, in the lead’s folder; a worktree worker gets its worktree there too', async () => {
    const { dir, work } = setupDir();
    const a = await startServer(dir);
    const session = remoteSession(a.store, work);
    a.runner.enqueue(session, { text: '[[mock:delegate:luna;wait;sleep=1;edit]] split the work' });
    const card = () => session.messages.find((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL && m.agentId);
    await waitFor(() => card(), 'the worker');
    await waitFor(async () => (await listHost(hostSocket)).some((p) => p.key === workerKey(card().agentId)), 'the worker in the host');
    await waitFor(() => !a.runner.isRunning(session.id) && a.runner.modelAgents.running(session.id) === 0, 'the lead and the worker');
    assert.equal(card().state, 'done', card().output);
    assert.match(card().output, /Worker finished/);
    assert.ok(fs.existsSync(path.join(work, 'part-1.txt')), 'the worker wrote in the remote folder');

    // Isolation 'worktree': git runs on the cluster, so the worktree is in its home.
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: work, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    const made = await a.runner.modelAgents.tools(session).delegate({ model: 'luna', task: '[[mock:worker:0,edit=part-2.txt]] go', isolation: 'worktree' }, {});
    assert.notEqual(made.isError, true, made.content?.[0]?.text);
    assert.match(made.content[0].text, /in worktree /);
    await waitFor(() => a.runner.modelAgents.running(session.id) === 0, 'the worktree worker');
    const treeCard = session.messages.filter((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL && m.agentId).at(-1);
    assert.match(treeCard.output, /Worktree: branch `harbor\/luna-[0-9a-f]{6}` at .+, 1 commit on top of/);
    const trees = path.join(remoteHome, '.local/share/harbor/worktrees');
    assert.equal(fs.readdirSync(trees).length, 1, 'the worktree is on the cluster');
    await a.runner.pool.close(session.id);
    await waitFor(() => remoteClaudes().length === 0, 'the remote CLIs to exit');
    await stopServer(a);
  });

  test('killing the process ends the remote one', async () => {
    const { dir, work } = setupDir();
    const a = await startServer(dir);
    const session = remoteSession(a.store, work);
    a.runner.enqueue(session, { text: '[[mock:slow]] tell me slowly' });
    await waitFor(() => (session.live || '').length > 5, 'the reply to stream');
    const [pid] = remoteClaudes();
    assert.ok(pid, 'the remote CLI runs');
    await a.runner.pool.kill(session.id);
    await waitFor(() => !alive(pid), 'the remote CLI to end', 15_000);
    await waitFor(() => !a.runner.isRunning(session.id), 'the turn to settle');
    await stopServer(a);
  });

  test('a server restart takes the remote process back: the stream goes on, the next turn reuses it', async () => {
    const { dir, work } = setupDir();
    const a = await startServer(dir);
    const session = remoteSession(a.store, work);
    a.runner.enqueue(session, { text: '[[mock:slow]] tell me slowly' });
    await waitFor(() => (session.live || '').length > 5, 'the reply to stream');
    const [pid] = remoteClaudes();
    await stopServer(a);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const b = await startServer(dir, { proxyAddress: { port: a.proxy.port, secret: a.proxy.secret } });
    assert.deepEqual(b.taken, [session.id]);
    const revived = b.store.sessions.get(session.id);
    assert.equal(revived.cluster, 'fake', 'the session keeps its cluster');
    await waitFor(() => !b.runner.isRunning(session.id), 'the slow turn to finish');
    assert.equal(revived.status, 'idle');
    assert.ok(lastText(revived).length > 20);
    b.runner.enqueue(revived, { text: 'and once more' });
    await waitFor(() => !b.runner.isRunning(session.id) && revived.messages.filter((m) => m.role === 'assistant').length >= 2, 'the next turn');
    assert.equal(lastText(revived), 'ok');
    assert.deepEqual(remoteClaudes(), [pid], 'the same remote CLI');
    assert.equal(b.runner.pool.spawned, 0, 'the new server started no process');
    await b.runner.pool.close(session.id);
    await waitFor(() => remoteClaudes().length === 0, 'the remote CLI to exit');
    await stopServer(b);
  });
});
