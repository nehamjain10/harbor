// MCP servers against the real Claude Code CLI (no model: the gateway is the mock, and
// discovery sends no prompt): listing a project's servers, switching one off for a session
// with a deny rule (tools leave the very next request, a restarted process starts without
// them, and the CLI's own project config is never written), Reconnect, and a full OAuth
// sign-in against a local OAuth MCP server: the authorization link, the pasted callback
// address, the token exchange, the reconnect, a second session picking the token up, and
// sign-out. Isolated: a throwaway CLAUDE_CONFIG_DIR, only the project's .mcp.json as a
// settings source; the real ~/.claude is never read or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { createMcpManager } from '../../server/mcp.mjs';
import { createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startOAuthMcpServer } from '../fixtures/mcp/oauth-server.mjs';
import { startMockGateway } from '../mock-gateway.mjs';
import { closeRunners, observedQuery } from './helpers.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const ECHO = fileURLToPath(new URL('../fixtures/mcp/echo-server.mjs', import.meta.url));
const TIMEOUT_MS = 60_000;

let base;
let mock;
let proxy;
let oauth;
const runners = [];

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mcp-int-'));
  mock = await startMockGateway({ keepBodies: true });
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
  oauth = await startOAuthMcpServer();
});

afterEach(() => closeRunners(runners));

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  await oauth?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A project with the echo server (stdio) and the local OAuth server (http), and the manager over a runner like server.mjs's. */
function harness({ idleMs, echoDelayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const work = path.join(dir, 'work');
  const claudeConfigDir = path.join(dir, 'claude-config');
  const pidFile = path.join(dir, 'echo.pids');
  fs.mkdirSync(work);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(
    path.join(work, '.mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [ECHO], env: { MCP_ECHO_PIDFILE: pidFile, MCP_ECHO_DELAY_MS: String(echoDelayMs) } }, oauthy: { type: 'http', url: oauth.url } } }),
  );
  const store = createStore({ dataDir: path.join(dir, 'data') });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const query = observedQuery({
    beforeSpawn: ({ options }) => {
      assert.ok([mock.url, proxy.url].includes(options.env.ANTHROPIC_BASE_URL), 'never a real model');
      options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    },
  });
  const logs = [];
  const config = { claudeExecutable: CLAUDE, gatewayUrl: mock.url, settingSources: ['project'], claudeConfigDir };
  const gateway = { url: proxy.url, apiKey: proxy.secret };
  const runner = createRunner({ config, events, gateway, query, idleMs, log: (line) => logs.push(line) });
  runners.push(runner);
  const mcp = createMcpManager({ config, gateway, runner, query, log: (line) => logs.push(line) });
  const session = () => store.insert(createSession({ cwd: work, model: 'luna', mode: 'bypassPermissions' }));
  return { runner, mcp, session, spawns: query.spawns, logs, work, claudeConfigDir, pidFile };
}

const byName = (found, name) => found.servers.find((server) => server.name === name);
const pids = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const footers = (session) => session.messages.filter((message) => message.role === 'turn').length;

/** Sends a message and waits for its turn; returns the model requests (with tools) it made. */
async function turn({ runner }, session, text) {
  const since = mock.requests.length;
  const before = footers(session);
  runner.enqueue(session, { text });
  await waitFor(() => footers(session) > before && !runner.isRunning(session.id));
  return mock.requests.slice(since).filter((request) => request.tools.length && request.sessionId === session.sdkSessionId);
}

// Offered either way: schemas sent, or named for tool search (deferred).
const mcpTools = (requests) => [...new Set(requests.flatMap((request) => [...request.tools, ...(request.deferred || [])]).filter((name) => name.startsWith('mcp__') && !name.startsWith('mcp__meshy__')))].sort();

/** The CLI's own record of servers switched off per project, in the throwaway config dir. */
function projectsDisabled(claudeConfigDir) {
  const file = path.join(claudeConfigDir, '.claude.json');
  if (!fs.existsSync(file)) return {};
  const projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects || {};
  return Object.fromEntries(Object.entries(projects).filter(([, value]) => value.disabledMcpServers?.length));
}

describe('MCP servers (real CLI, mock gateway, local servers)', { skip }, () => {
  test('a listing without a process shows the project’s servers and Harbor’s own, and sends no message to any model', async () => {
    const setup = harness();
    const session = setup.session();
    const since = mock.requests.length;
    const found = await setup.mcp.list(session);
    assert.equal(found.live, false);
    assert.equal(found.route, 'gateway');
    assert.deepEqual(found.servers.map((server) => [server.name, server.status]), [
      ['echo', 'connected'],
      ['oauthy', 'needs-auth'],
      ['meshy', 'connected'],
    ]);
    const echo = byName(found, 'echo');
    assert.deepEqual([echo.group, echo.type, echo.auth, echo.toolCount, echo.tools[0].name, echo.tools[0].readOnly], ['project', 'stdio', null, 1, 'echo', true]);
    const oauthy = byName(found, 'oauthy');
    assert.deepEqual([oauthy.group, oauthy.type, oauthy.auth, oauthy.url], ['project', 'http', 'oauth', oauth.url]);
    assert.doesNotMatch(JSON.stringify(found), new RegExp(ECHO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no command line in the answer');
    assert.equal(byName(found, 'meshy').builtin, true);
    assert.equal(mock.requests.length, since, 'no request reached the gateway');
    assert.equal(setup.spawns.length, 1);
    assert.equal(setup.runner.pool.get(session.id), undefined, 'the discovery process is gone, and no session process was started');
    // A second ask inside the minute is served from the cache.
    await setup.mcp.list(session);
    assert.equal(setup.spawns.length, 1);
  });

  test('switching a server off hides its tools from the next request, survives a restart of the process, and never writes Claude Code’s project config', async () => {
    const setup = harness();
    const session = setup.session();
    // Deferred (tool search): named once the server has connected, which may be after the first request.
    const opening = [...(await turn(setup, session, 'hello')), ...(await turn(setup, session, 'hello there'))];
    assert.deepEqual(mcpTools(opening), ['mcp__echo__echo']);
    // The model can use it while it is on.
    await turn(setup, session, '[[mock:tools:mcp__echo__echo*1]] call it');
    const call = session.messages.find((message) => message.role === 'tool' && message.tool === 'mcp__echo__echo');
    assert.equal(call?.state, 'done', 'the echo tool ran');

    const off = await setup.mcp.toggle(session, 'echo', false);
    assert.deepEqual([off.live, off.mcpDisabled, off.projectEnabled], [true, ['echo'], false]);
    assert.deepEqual(mcpTools(await turn(setup, session, 'hello again')), [], 'the very next request has no echo tool');
    const [first] = setup.spawns;
    assert.deepEqual(first.controls.filter(([method]) => method === 'applyFlagSettings').at(-1), ['applyFlagSettings', { permissions: { deny: ['mcp__echo'] } }]);
    assert.equal(first.controls.some(([method]) => method === 'toggleMcpServer'), false, 'Claude Code’s own toggle (which writes ~/.claude.json) is never used');
    const listed = await setup.mcp.list(session);
    assert.deepEqual([byName(listed, 'echo').status, byName(listed, 'echo').disabledInSession], ['connected', true]);

    // A new process (idle close, restart, route switch) starts with the rule: not even its first request has the tool.
    await setup.runner.pool.close(session.id, 'restart');
    await waitFor(() => !setup.runner.pool.get(session.id));
    assert.deepEqual(mcpTools(await turn(setup, session, 'after the restart')), []);
    assert.equal(setup.spawns.length, 2);
    assert.deepEqual(setup.spawns[1].controls[0], ['applyFlagSettings', { permissions: { deny: ['mcp__echo'] } }], 'applied right after the start, before the message');
    assert.equal(setup.spawns[1].options.settings.permissions?.deny, undefined, 'not a start option: a tool denied at start can never come back');

    const on = await setup.mcp.toggle(session, 'echo', true);
    assert.deepEqual(on.mcpDisabled, []);
    // Back on, it works again (tool search finds it; Claude Code does not re-announce it).
    await turn(setup, session, '[[mock:tools:mcp__echo__echo*1]] and back on');
    const calls = session.messages.filter((message) => message.role === 'tool' && message.tool === 'mcp__echo__echo');
    assert.equal(calls.at(-1)?.state, 'done', 'the echo tool ran again');
    assert.deepEqual(projectsDisabled(setup.claudeConfigDir), {}, 'the project’s own list of disabled servers was never written');

    // Another session in the same folder was never affected.
    const sibling = setup.session();
    assert.deepEqual(mcpTools([...(await turn(setup, sibling, 'sibling hello')), ...(await turn(setup, sibling, 'sibling again'))]), ['mcp__echo__echo']);
  });

  test('a server that connects late (as plugin and claude.ai servers do) is still hidden, and shows when switched on', async () => {
    const setup = harness({ echoDelayMs: 2500 });
    const session = setup.session();
    session.mcpDisabled = ['echo'];
    await setup.runner.ensureCli(session);
    await waitFor(async () => (await setup.mcp.list(session)).servers.find((server) => server.name === 'echo')?.status === 'connected', 30_000);
    assert.deepEqual(mcpTools(await turn(setup, session, 'hello')), [], 'connected after the rule was applied, still no tools');
    await setup.mcp.toggle(session, 'echo', true);
    assert.deepEqual(mcpTools(await turn(setup, session, 'now on')), ['mcp__echo__echo']);
    assert.equal(setup.spawns.length, 1, 'one process throughout: nothing had to restart');
  });

  test('Reconnect restarts a stdio server’s process', async () => {
    const setup = harness();
    const session = setup.session();
    await setup.runner.ensureCli(session);
    await waitFor(async () => (await setup.mcp.list(session)).servers.find((server) => server.name === 'echo')?.status === 'connected');
    const before = pids(setup.pidFile).length;
    const result = await setup.mcp.reconnect(session, 'echo');
    assert.deepEqual([result.ok, result.live, result.server.status], [true, true, 'connected']);
    assert.equal(pids(setup.pidFile).length, before + 1, 'the server was started again');
  });

  test('a full OAuth sign-in: link, pasted callback address, token exchange, reconnect; the process waits meanwhile; another session connects with the stored token; sign out', async () => {
    const setup = harness({ idleMs: 1500 });
    const session = setup.session();
    const auth = await setup.mcp.authenticate(session, 'oauthy');
    assert.equal(auth.kind, 'oauth');
    assert.ok(auth.authUrl.startsWith(`${oauth.origin}/authorize?`), 'the authorization endpoint the server announced');
    assert.ok(auth.callbackPort > 0);
    assert.equal(auth.expiresInSeconds, 300);
    assert.equal(auth.instructions.length, 3);

    // The process that holds the OAuth state outlives the idle timeout while the sign-in waits.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.ok(setup.runner.pool.get(session.id), 'still the session’s process');
    assert.equal(setup.spawns.length, 1);

    // The user approves; the browser ends on a localhost page that cannot load and they paste its address.
    const callback = oauth.approve(auth.authUrl);
    const stale = await setup.mcp.submitCallback(session, 'oauthy', callback.replace(/state=[^&]+/, 'state=another')).catch((error) => error);
    assert.equal(stale.status, 400, 'an address of another attempt is refused before it reaches Claude Code');
    const done = await setup.mcp.submitCallback(session, 'oauthy', callback);
    assert.deepEqual([done.ok, done.server.status, done.server.toolCount, done.server.tools[0]?.name], [true, 'connected', 1, 'whoami']);
    assert.equal(oauth.tokens.size, 1, 'the code was exchanged for a token');
    assert.ok(fs.existsSync(path.join(setup.claudeConfigDir, '.credentials.json')), 'stored in the CLI’s own credential store (here a throwaway dir)');
    assert.equal(setup.logs.some((line) => /code-|token-/.test(line)), false, 'neither the code nor the token is ever logged');
    assert.equal(setup.spawns.length, 1, 'no other process was needed');

    // The sign-in is over: the process is an ordinary idle one again.
    await waitFor(() => !setup.runner.pool.get(session.id), 20_000);

    // Another session of the project: its own process connects with the stored token, at once.
    const other = setup.session();
    const again = await setup.mcp.list(other);
    assert.deepEqual([byName(again, 'oauthy').status, byName(again, 'oauthy').toolCount], ['connected', 1]);
    assert.equal(byName(again, 'oauthy').auth, 'oauth');

    // Sign out: the server needs a sign-in again.
    const out = await setup.mcp.clearAuth(other, 'oauthy');
    assert.equal(out.ok, true);
    assert.equal(out.server.status, 'needs-auth');
  });

  test('a pasted address with no sign-in waiting, or after Claude Code restarted, is a 409', async () => {
    const setup = harness();
    const session = setup.session();
    const address = 'http://localhost:1/callback?code=x&state=y';
    assert.equal((await setup.mcp.submitCallback(session, 'oauthy', address).catch((error) => error)).status, 409);
    await setup.mcp.authenticate(session, 'oauthy');
    await setup.runner.pool.close(session.id, 'restart');
    await waitFor(() => !setup.runner.pool.get(session.id));
    assert.equal((await setup.mcp.submitCallback(session, 'oauthy', address).catch((error) => error)).status, 409);
  });

  test('Get a new link: a second sign-in replaces the first, whose address is then refused', async () => {
    const setup = harness();
    const session = setup.session();
    const first = await setup.mcp.authenticate(session, 'oauthy');
    const second = await setup.mcp.authenticate(session, 'oauthy');
    assert.notEqual(new URL(first.authUrl).searchParams.get('state'), new URL(second.authUrl).searchParams.get('state'));
    const old = oauth.approve(first.authUrl);
    assert.equal((await setup.mcp.submitCallback(session, 'oauthy', old).catch((error) => error)).status, 400);
    const done = await setup.mcp.submitCallback(session, 'oauthy', oauth.approve(second.authUrl));
    assert.deepEqual([done.ok, done.server.status], [true, 'connected']);
  });

  test('servers that cannot sign in are refused before they reach Claude Code', async () => {
    const setup = harness();
    const session = setup.session();
    assert.equal((await setup.mcp.authenticate(session, 'echo').catch((error) => error)).status, 400);
    assert.equal((await setup.mcp.authenticate(session, 'nope').catch((error) => error)).status, 404);
    assert.equal((await setup.mcp.authenticate(session, 'meshy').catch((error) => error)).status, 400);
    assert.equal(setup.spawns[0].controls.some(([method]) => method === 'mcpAuthenticate'), false);
  });
});
