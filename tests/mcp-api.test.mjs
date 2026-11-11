// The MCP routes end to end over a private unix socket (never TCP): the real app, runner
// and process pool with fake Claude Code processes (tests/fake-cli.mjs) that answer the MCP
// control requests as Claude Code 2.1.290 does. Discovery (a session without a live
// process) uses a second fake. No real CLI, no network, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.mjs';
import { REPO_DIR } from '../server/config.mjs';
import { createEvents } from '../server/events.mjs';
import { createMcpManager } from '../server/mcp.mjs';
import { createRunner } from '../server/runner.mjs';
import { listenOnSocket } from '../server/socket.mjs';
import { createStore, publicSession } from '../server/store.mjs';
import { createFakeCli } from './fake-cli.mjs';

const OWNER = 'owner@example.com';
const HOST = 'workbench.example:18544';
const SECRET = 'SECRET-TOKEN-1234';

const connector = (name, status, extra = {}) => ({
  name,
  status,
  scope: 'claudeai',
  source: 'claudeai',
  config: { type: 'claudeai-proxy', url: `https://${name.split(' ')[1].toLowerCase()}.example/mcp`, id: `mcpsrv_${name.split(' ')[1]}` },
  ...extra,
});
const pluginSlack = (extra = {}) => ({
  name: 'plugin:slack:slack',
  status: 'needs-auth',
  scope: 'dynamic',
  source: 'plugin',
  config: { type: 'http', url: 'https://mcp.slack.example/mcp', oauth: { clientId: '1601185624273.8899143856786', callbackPort: 3118 } },
  ...extra,
});

/** What each process lists: claude.ai connectors only on the Claude route (no gateway URL in its env), Harbor's own server in live ones. */
function serversFor(options) {
  const gateway = Boolean(options.env?.ANTHROPIC_BASE_URL);
  const live = Boolean(options.mcpServers?.meshy);
  const rows = [
    { name: 'echo', status: 'connected', scope: 'project', source: 'project', config: { type: 'stdio', command: 'node', args: ['--key', SECRET], env: { API_KEY: SECRET } }, tools: [{ name: 'echo', annotations: { readOnly: true } }] },
    { name: 'wiki', status: 'failed', scope: 'user', source: 'user', error: `connect ECONNREFUSED https://wiki.example/mcp?token=${SECRET}`, config: { type: 'http', url: `https://wiki.example/mcp?token=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } } },
  ];
  if (gateway) rows.push(pluginSlack());
  else {
    rows.push(
      connector('claude.ai Slack', 'needs-auth'),
      connector('claude.ai Gmail', 'connected', { tools: [{ name: 'search_threads' }, { name: 'send_draft', annotations: { destructive: true } }] }),
      connector('claude.ai Linear', 'needs-auth'),
    );
  }
  if (live) rows.push({ name: 'meshy', status: 'connected', tools: [{ name: 'delegate' }, { name: 'wait_agents', annotations: { readOnly: true } }] });
  return rows;
}

// What the debug log of a listing says Claude Code left out (see parseHiddenServers).
const DEBUG_LOG = [
  '2026-10-12T18:50:27.816Z [DEBUG] [MCP] Lazy dedup: suppressing 2 plugin server(s) that duplicate claude.ai connectors: plugin:ghost:ghost, plugin:slack:slack',
  '2026-10-12T18:50:27.828Z [DEBUG] Suppressing claude.ai connector "claude.ai Ghost": duplicates manually-configured "plugin:ghost:ghost"',
].join('\n');

let base;
let homeRoot;
let socketPath;
let server;
let store;
let events;
let runner;
let live; // fake processes of sessions (the runner's)
const liveBehavior = { mcp: serversFor, mcpDelayMs: 0 };
let discovery; // fake no-prompt processes of the listing
let mcp;
let logs;

before(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-')));
  homeRoot = path.join(base, 'home');
  fs.mkdirSync(path.join(homeRoot, 'project'), { recursive: true });
  fs.mkdirSync(path.join(homeRoot, 'other'));
  const config = {
    owner: OWNER,
    publicHost: HOST,
    origin: 'https://' + HOST,
    homeRoot,
    repoDir: REPO_DIR,
    publicDir: path.join(REPO_DIR, 'public'),
    dataDir: path.join(base, 'data'),
    gatewayUrl: 'http://127.0.0.1:9',
    claudeExecutable: '/nonexistent/claude',
    dashboardUrl: 'https://dashboard.example/',
  };
  store = createStore({ dataDir: config.dataDir });
  store.load();
  events = createEvents({ save: store.save, toPublic: publicSession });
  logs = [];
  live = createFakeCli(async function* () {}, liveBehavior);
  discovery = createFakeCli(async function* () {}, { mcp: serversFor, debugLog: DEBUG_LOG });
  // A short idle timeout: the tests check that a sign-in keeps its process up past it.
  runner = createRunner({ config, events, query: live.query, idleMs: 300, closeGraceMs: 50, log: (line) => logs.push(line) });
  mcp = createMcpManager({ config, gateway: { url: 'http://127.0.0.1:18999', apiKey: 'proxy-secret' }, runner, query: discovery.query, log: (line) => logs.push(line), pollMs: 1, timeoutMs: 500 });
  const app = createApp({ config, store, events, runner, mcp });
  socketPath = path.join(base, 'web.sock');
  server = await listenOnSocket(app, socketPath);
});

after(async () => {
  runner.shutdown();
  await waitFor(() => runner.pool.size === 0);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(base, { recursive: true, force: true });
});

const authed = { 'Tailscale-User-Login': OWNER };
const writeHeaders = { ...authed, Origin: 'https://' + HOST, 'Content-Type': 'application/json' };

function request(method, route, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        const json = res.headers['content-type']?.startsWith('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: json && text ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const api = (method, route, body, headers = method === 'GET' ? authed : writeHeaders) => request(method, route, { headers, body });
const enc = encodeURIComponent;
const mcpRoute = (session, name, tail = '') => `/api/sessions/${session.id}/mcp/${enc(name)}${tail}`;

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let folder = 0;
/** A session in its own project folder (listings are cached per folder). */
async function newSession(fields = {}) {
  folder += 1;
  const dir = path.join(homeRoot, 'project', `p${folder}`);
  fs.mkdirSync(dir, { recursive: true });
  const response = await api('POST', '/api/sessions', { cwd: dir, model: 'deepseek', ...fields });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return store.get(response.body.id);
}

/** Starts the session's process the way sending a message does (and lets the turn finish). */
async function startProcess(session) {
  const before = live.spawns;
  runner.enqueue(session, { text: 'hello' });
  await waitFor(() => live.spawns > before && !runner.isRunning(session.id));
  return live.last;
}

const byName = (body, name) => body.servers.find((server) => server.name === name);
const signInProcess = (session) => runner.pool.get(session.id);

describe('listing', () => {
  test('without a live process a no-prompt process lists the folder on the session’s route, then closes; the list is cached', async () => {
    const session = await newSession({ model: 'deepseek' });
    const spawns = discovery.spawns;
    const response = await api('GET', `/api/sessions/${session.id}/mcp`);
    assert.equal(response.status, 200);
    assert.equal(response.body.live, false);
    assert.equal(response.body.route, 'gateway');
    assert.equal(discovery.spawns, spawns + 1);
    const proc = discovery.last;
    assert.equal(proc.options.cwd, session.cwd);
    assert.equal(proc.options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18999');
    assert.equal(proc.options.persistSession, false);
    assert.deepEqual(proc.received, [], 'no message was sent, so no model was called');
    await waitFor(() => proc.ended);
    assert.deepEqual(response.body.servers.map((server) => server.name), ['echo', 'wiki', 'plugin:slack:slack', 'meshy']);
    // Harbor's own server is listed even though only a session's process carries it.
    assert.deepEqual(byName(response.body, 'meshy'), {
      name: 'meshy', status: 'connected', scope: 'sdk', source: 'sdk', group: 'builtin', type: 'sdk',
      tools: [
        { name: 'delegate', description: 'Start a worker on another model and carry on.' },
        { name: 'wait_agents', description: 'Collect the reports of the workers started with delegate.', readOnly: true },
        { name: 'message_agent', description: 'Send a running worker a message; it reads it at its next step.', readOnly: true },
        { name: 'stop_agent', description: 'Stop a worker and get its partial report.' },
        { name: 'check_agents', description: "Each worker's latest step and what it last said, without waiting.", readOnly: true },
      ],
      toolCount: 5, builtin: true, disabledInSession: false, auth: null,
    });
    await api('GET', `/api/sessions/${session.id}/mcp`);
    assert.equal(discovery.spawns, spawns + 1, 'a second request inside the minute reuses the listing');
    // `fresh` asks again.
    await api('GET', `/api/sessions/${session.id}/mcp?fresh=1`);
    assert.equal(discovery.spawns, spawns + 2);
  });

  test('the Claude route lists claude.ai connectors (the plugin whose address one of them has is not there); the gateway route has none', async () => {
    const claude = await newSession({ model: 'opus' });
    const gateway = await newSession({ model: 'luna' });
    const onClaude = (await api('GET', `/api/sessions/${claude.id}/mcp`)).body;
    assert.equal(discovery.last.options.env.ANTHROPIC_BASE_URL, undefined, 'the Claude route uses the login, not the gateway');
    const onGateway = (await api('GET', `/api/sessions/${gateway.id}/mcp`)).body;
    assert.equal(onClaude.route, 'claude');
    assert.deepEqual(onClaude.servers.filter((s) => s.group === 'claudeai').map((s) => s.name), ['claude.ai Slack', 'claude.ai Gmail', 'claude.ai Linear']);
    assert.equal(onClaude.servers.some((s) => s.group === 'plugin'), false);
    assert.equal(onGateway.servers.some((s) => s.group === 'claudeai'), false);
    assert.equal(byName(onGateway, 'plugin:slack:slack').status, 'needs-auth');
    assert.deepEqual(
      [byName(onClaude, 'claude.ai Gmail').status, byName(onClaude, 'claude.ai Gmail').toolCount, byName(onClaude, 'claude.ai Gmail').auth],
      ['connected', 2, 'claudeai'],
    );
  });

  test('rows carry no secret: no header, env, command line or query string', async () => {
    const session = await newSession({ model: 'deepseek' });
    const response = await api('GET', `/api/sessions/${session.id}/mcp`);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(SECRET));
    assert.deepEqual(
      [byName(response.body, 'wiki').url, byName(response.body, 'wiki').type, byName(response.body, 'wiki').group],
      ['https://wiki.example/mcp', 'http', 'user'],
    );
    assert.match(byName(response.body, 'wiki').error, /ECONNREFUSED https:\/\/wiki\.example\/mcp$/);
    assert.equal(byName(response.body, 'echo').url, undefined);
    assert.equal(byName(response.body, 'echo').type, 'stdio');
  });

  test('a live process answers for itself, with the session’s switches; `cached` never starts a process', async () => {
    const session = await newSession({ model: 'luna' });
    const idle = await api('GET', `/api/sessions/${session.id}/mcp?cached=1`);
    assert.deepEqual([idle.body.live, idle.body.servers], [false, null]);
    const proc = await startProcess(session);
    const spawns = discovery.spawns;
    const response = await api('GET', `/api/sessions/${session.id}/mcp?cached=1`);
    assert.equal(response.body.live, true);
    assert.equal(discovery.spawns, spawns, 'the live process answered');
    assert.ok(proc.mcp.calls.some(([call]) => call === 'mcpServerStatus'));
    assert.equal(byName(response.body, 'meshy').builtin, true);
    // A recent listing also answers `cached` while nothing is live.
    const other = await newSession({ model: 'luna' });
    await api('GET', `/api/sessions/${other.id}/mcp`);
    const hit = await api('GET', `/api/sessions/${other.id}/mcp?cached=1`);
    assert.deepEqual([hit.body.live, hit.body.servers.length > 0], [false, true]);
  });

  test('a listing that cannot start Claude Code says so, with Harbor’s own server alone', async () => {
    const before = discovery.spawns;
    const session = await newSession({ model: 'luna' });
    const original = discovery.query;
    const failing = createMcpManager({
      config: { claudeExecutable: '/x' },
      gateway: { url: 'http://127.0.0.1:1', apiKey: 'k' },
      runner,
      query: () => {
        throw new Error('spawn ENOENT');
      },
      log: () => {},
      pollMs: 1,
    });
    const found = await failing.list(session);
    assert.match(found.error, /ENOENT/);
    assert.deepEqual(found.servers.map((s) => s.name), ['meshy']);
    assert.equal(discovery.spawns, before);
    assert.equal(original, discovery.query);
  });

  test('a project folder lists without a session (read only); unknown sessions are 404', async () => {
    const response = await api('GET', `/api/mcp?cwd=${enc(path.join(homeRoot, 'other'))}&route=gateway`);
    assert.equal(response.status, 200);
    assert.deepEqual([response.body.route, response.body.live, byName(response.body, 'plugin:slack:slack').status], ['gateway', false, 'needs-auth']);
    assert.equal((await api('GET', `/api/mcp?cwd=${enc(path.join(homeRoot, 'other'))}`)).body.route, 'claude');
    assert.equal((await api('GET', `/api/mcp?cwd=${enc('/etc')}`)).status, 403, 'outside the home folder, as for every folder route');
    assert.equal((await api('GET', '/api/sessions/nope/mcp')).status, 404);
  });
});

describe('servers Claude Code leaves out', () => {
  test('a listing says which, from the process’s debug log (dropping the ones the list shows), then removes the log', async () => {
    const gateway = await newSession({ model: 'luna' });
    const onGateway = (await api('GET', `/api/sessions/${gateway.id}/mcp`)).body;
    const options = discovery.last.options;
    assert.match(options.debugFile, /harbor-mcp-[^/]+\/debug\.log$/);
    await waitFor(() => !fs.existsSync(path.dirname(options.debugFile)));
    assert.deepEqual(onGateway.hidden.map((entry) => entry.name), ['plugin:ghost:ghost', 'claude.ai Ghost'], 'plugin:slack:slack is listed on this route, so it is not hidden');
    assert.equal(onGateway.hidden[1].reason, 'It has the same address as plugin:ghost:ghost.');
    const claude = await newSession({ model: 'opus' });
    const onClaude = (await api('GET', `/api/sessions/${claude.id}/mcp`)).body;
    assert.deepEqual(onClaude.hidden.map((entry) => entry.name), ['plugin:ghost:ghost', 'plugin:slack:slack', 'claude.ai Ghost']);
  });

  test('a live process cannot tell, so its list carries what the folder’s last listing found; only discovery runs with a debug log', async () => {
    const session = await newSession({ model: 'luna' });
    assert.deepEqual((await api('GET', `/api/sessions/${session.id}/mcp?cached=1`)).body.servers, null);
    await api('GET', `/api/sessions/${session.id}/mcp`);
    const proc = await startProcess(session);
    assert.equal(proc.options.debugFile, undefined);
    await api('POST', mcpRoute(session, 'echo', '/toggle'), { enabled: false }); // clears the listing cache
    const live = (await api('GET', `/api/sessions/${session.id}/mcp`)).body;
    assert.equal(live.live, true);
    assert.deepEqual(live.hidden.map((entry) => entry.name), ['plugin:ghost:ghost', 'claude.ai Ghost']);
  });

  test('a project folder without a session lists them too', async () => {
    const response = await api('GET', `/api/mcp?cwd=${enc(path.join(homeRoot, 'other'))}&route=gateway`);
    assert.deepEqual(response.body.hidden.map((entry) => entry.name), ['plugin:ghost:ghost', 'claude.ai Ghost']);
  });
});

describe('switching a server off for a session', () => {
  test('is validated against the session’s own list; Harbor’s server cannot be switched', async () => {
    const session = await newSession({ model: 'opus' });
    const toggle = (name, body) => api('POST', mcpRoute(session, name, '/toggle'), body);
    assert.equal((await toggle('nope', { enabled: false })).status, 404);
    // On the Claude route the Slack plugin is not there; only the connector is.
    assert.equal((await toggle('plugin:slack:slack', { enabled: false })).status, 404);
    assert.equal((await toggle('claude.ai Gmail', { enabled: 'no' })).body.error, 'Enabled must be true or false.');
    assert.equal((await toggle('claude.ai Gmail', {})).status, 400);
    const builtin = await toggle('meshy', { enabled: false });
    assert.equal(builtin.status, 400);
    assert.match(builtin.body.error, /built in and cannot be switched off/);
    assert.equal(session.mcpDisabled, undefined);
    assert.equal((await api('POST', mcpRoute(session, 'claude.ai Gmail', '/toggle'), { enabled: false }, authed)).status, 403, 'the same Origin check as every write');
  });

  test('without a live process the choice is kept on the session (and on disk) and no process starts', async () => {
    const session = await newSession({ model: 'opus' });
    const spawns = live.spawns;
    const off = await api('POST', mcpRoute(session, 'claude.ai Gmail', '/toggle'), { enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual([off.body.ok, off.body.enabled, off.body.mcpDisabled, off.body.live], [true, false, ['claude.ai Gmail'], false]);
    assert.equal(live.spawns, spawns);
    assert.deepEqual(session.mcpDisabled, ['claude.ai Gmail']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(base, 'data', `${session.id}.json`), 'utf8'));
    assert.deepEqual(onDisk.mcpDisabled, ['claude.ai Gmail']);
    // The list shows it; the session carries it (the topbar and the panel read it there).
    assert.equal(byName((await api('GET', `/api/sessions/${session.id}/mcp`)).body, 'claude.ai Gmail').disabledInSession, true);
    assert.deepEqual((await api('GET', `/api/sessions/${session.id}`)).body.mcpDisabled, ['claude.ai Gmail']);
    // Switching it off twice changes nothing; switching on empties the list.
    assert.deepEqual((await api('POST', mcpRoute(session, 'claude.ai Gmail', '/toggle'), { enabled: false })).body.mcpDisabled, ['claude.ai Gmail']);
    assert.deepEqual((await api('POST', mcpRoute(session, 'claude.ai Gmail', '/toggle'), { enabled: true })).body.mcpDisabled, []);
    assert.equal('mcpDisabled' in session, false);
    assert.deepEqual((await api('GET', `/api/sessions/${session.id}`)).body.mcpDisabled, []);
  });

  test('a live process hides the server’s tools at once with a deny rule, never with Claude Code’s own toggle; switching on shows them again', async () => {
    const session = await newSession({ model: 'luna' });
    const proc = await startProcess(session);
    assert.ok(proc.toolsOffered().includes('mcp__echo__echo'));
    const off = await api('POST', mcpRoute(session, 'echo', '/toggle'), { enabled: false });
    assert.deepEqual([off.body.live, off.body.mcpDisabled, off.body.projectEnabled], [true, ['echo'], false]);
    assert.deepEqual(proc.controls.filter(([name]) => name === 'applyFlagSettings').at(-1), ['applyFlagSettings', { permissions: { deny: ['mcp__echo'] } }]);
    assert.equal(proc.toolsOffered().includes('mcp__echo__echo'), false);
    assert.ok(proc.toolsOffered().includes('mcp__meshy__delegate'));
    // mcp_toggle would write the server as disabled into ~/.claude.json for every session in the folder.
    assert.equal(proc.mcp.calls.some(([call]) => call === 'toggleMcpServer'), false);
    const listed = (await api('GET', `/api/sessions/${session.id}/mcp`)).body;
    assert.deepEqual([listed.live, byName(listed, 'echo').status, byName(listed, 'echo').disabledInSession], [true, 'connected', true]);
    const on = await api('POST', mcpRoute(session, 'echo', '/toggle'), { enabled: true });
    assert.deepEqual(on.body.mcpDisabled, []);
    assert.deepEqual(proc.flags.permissions.deny, []);
    assert.ok(proc.toolsOffered().includes('mcp__echo__echo'));
    assert.equal(proc.mcp.calls.some(([call]) => call === 'toggleMcpServer'), false);
  });

  test('claude.ai connector and plugin names (spaces, dots, colons) are addressed URL-encoded and denied by the CLI’s own tool prefix', async () => {
    const connectorSession = await newSession({ model: 'opus' });
    const proc = await startProcess(connectorSession);
    assert.equal((await api('POST', mcpRoute(connectorSession, 'claude.ai Gmail', '/toggle'), { enabled: false })).status, 200);
    assert.deepEqual(proc.flags.permissions.deny, ['mcp__claude_ai_Gmail']);
    assert.equal(proc.toolsOffered().some((tool) => tool.startsWith('mcp__claude_ai_Gmail__')), false);
    const pluginSession = await newSession({ model: 'luna' });
    const pluginProc = await startProcess(pluginSession);
    assert.equal((await api('POST', `/api/sessions/${pluginSession.id}/mcp/plugin%3Aslack%3Aslack/toggle`, { enabled: false })).status, 200);
    assert.deepEqual(pluginProc.flags.permissions.deny, ['mcp__plugin_slack_slack']);
  });

  test('every later process gets the list before its first message; sessions inherit nothing', async () => {
    const session = await newSession({ model: 'luna' });
    const first = await startProcess(session);
    await api('POST', mcpRoute(session, 'echo', '/toggle'), { enabled: false });
    await api('POST', mcpRoute(session, 'wiki', '/toggle'), { enabled: false });
    assert.deepEqual(first.flags.permissions.deny, ['mcp__echo', 'mcp__wiki']);
    // The process goes away (idle, a restart, a route switch...) and the next message starts a new one.
    await runner.pool.close(session.id, 'restart');
    await waitFor(() => first.ended);
    const second = await startProcess(session);
    assert.notEqual(second, first);
    // Applied through flag settings right after the start and before anything is sent, not as a
    // start option: a tool denied at start is gone for good (measured), one denied later can come back.
    assert.deepEqual(second.events.slice(0, 2), ['flags', 'user'], 'so not even the first request carries these tools');
    assert.deepEqual(second.flags.permissions.deny, ['mcp__echo', 'mcp__wiki']);
    assert.equal(second.options.settings.permissions?.deny, undefined);
    assert.equal(second.received[0].content, 'hello');
    assert.equal(second.toolsOffered().includes('mcp__echo__echo'), false);
    assert.ok(second.toolsOffered().includes('mcp__meshy__delegate'));
    // A server restart reads it back from disk.
    const reloaded = createStore({ dataDir: path.join(base, 'data'), log: () => {} });
    reloaded.load();
    assert.deepEqual(reloaded.get(session.id).mcpDisabled, ['echo', 'wiki']);
    // New sessions start with nothing switched off, even in the same folder.
    const sibling = await api('POST', '/api/sessions', { cwd: session.cwd, model: 'luna' });
    assert.deepEqual(sibling.body.mcpDisabled, []);
    const siblingProc = await startProcess(store.get(sibling.body.id));
    assert.equal(siblingProc.options.settings.permissions?.deny, undefined);
    assert.equal(siblingProc.events.includes('flags'), false, 'nothing to hide, nothing applied');
    assert.ok(siblingProc.toolsOffered().includes('mcp__echo__echo'));
  });

  test('PATCH cannot set the list', async () => {
    const session = await newSession();
    const patched = await api('PATCH', `/api/sessions/${session.id}`, { mcpDisabled: ['echo'] });
    assert.equal(patched.status, 200);
    assert.equal(session.mcpDisabled, undefined);
  });

  test('a process that refuses the change leaves the list as it was (502)', async () => {
    const session = await newSession({ model: 'luna' });
    const proc = await startProcess(session);
    const original = proc.stream.applyFlagSettings;
    proc.stream.applyFlagSettings = async () => {
      throw new Error('flag settings refused');
    };
    const response = await api('POST', mcpRoute(session, 'echo', '/toggle'), { enabled: false });
    proc.stream.applyFlagSettings = original;
    assert.equal(response.status, 502);
    assert.match(response.body.error, /could not apply this change: flag settings refused/);
    assert.equal(session.mcpDisabled, undefined);
  });

  test('a server switched off in Claude Code itself comes back through its own switch (the one case that writes its config)', async () => {
    const cli = createFakeCli(async function* () {}, { mcp: () => [{ name: 'comet', status: 'disabled', scope: 'user', source: 'user', config: { type: 'http', url: 'https://comet.example/mcp' } }] });
    const config = { owner: OWNER, publicHost: HOST, origin: 'https://' + HOST, homeRoot, repoDir: REPO_DIR, publicDir: path.join(REPO_DIR, 'public'), dataDir: path.join(base, 'data2'), gatewayUrl: 'http://127.0.0.1:9', claudeExecutable: '/x' };
    const ownStore = createStore({ dataDir: config.dataDir });
    ownStore.load();
    const ownEvents = createEvents({ save: ownStore.save, toPublic: publicSession });
    const ownRunner = createRunner({ config, events: ownEvents, query: cli.query, closeGraceMs: 50, log: () => {} });
    const manager = createMcpManager({ config, gateway: { url: 'http://x', apiKey: 'k' }, runner: ownRunner, query: cli.query, log: () => {}, pollMs: 1 });
    const session = ownStore.insert({ id: 's1', cwd: path.join(homeRoot, 'project'), model: 'luna', mode: 'default', efforts: {}, messages: [], pending: [], status: 'idle', createdAt: 1, updatedAt: 1 });
    try {
      const listed = await manager.list(session);
      assert.equal(listed.servers.find((s) => s.name === 'comet').status, 'disabled');
      const before = cli.spawns;
      const result = await manager.toggle(session, 'comet', true);
      assert.deepEqual([result.projectEnabled, result.live], [true, true]);
      assert.equal(cli.spawns, before + 1, 'a process was started to ask Claude Code');
      assert.deepEqual(cli.last.mcp.calls.filter(([call]) => call === 'toggleMcpServer'), [['toggleMcpServer', 'comet', true]]);
    } finally {
      ownRunner.shutdown();
      await waitFor(() => ownRunner.pool.size === 0);
    }
  });
});

describe('reconnecting', () => {
  test('a live process retries the connection and the answer says whether it connected', async () => {
    const session = await newSession({ model: 'luna' });
    const proc = await startProcess(session);
    proc.mcp.servers.get('wiki').onReconnect = 'connected';
    const fixed = await api('POST', mcpRoute(session, 'wiki', '/reconnect'));
    assert.equal(fixed.status, 200);
    assert.deepEqual([fixed.body.ok, fixed.body.live, fixed.body.server.status], [true, true, 'connected']);
    assert.equal('error' in fixed.body, false);
    assert.deepEqual(proc.mcp.calls.filter(([call]) => call === 'reconnectMcpServer'), [['reconnectMcpServer', 'wiki']]);
    // Still failing: the error is the server's own.
    proc.mcp.servers.get('wiki').status = 'failed';
    proc.mcp.servers.get('wiki').onReconnect = 'failed';
    proc.mcp.servers.get('wiki').error = 'connect ECONNREFUSED';
    const failed = await api('POST', mcpRoute(session, 'wiki', '/reconnect'));
    assert.deepEqual([failed.status, failed.body.ok, failed.body.server.status], [200, false, 'failed']);
    assert.match(failed.body.error, /ECONNREFUSED/);
  });

  test('a server that still needs a sign-in stays needs-auth and says so (claude.ai connectors answer “Server status: needs-auth”)', async () => {
    const session = await newSession({ model: 'opus' });
    await startProcess(session);
    const response = await api('POST', mcpRoute(session, 'claude.ai Slack', '/reconnect'));
    assert.equal(response.status, 200);
    assert.deepEqual([response.body.ok, response.body.server.status], [false, 'needs-auth']);
    assert.match(response.body.error, /needs you to sign in/);
  });

  test('after signing in on claude.ai a reconnect connects it', async () => {
    const session = await newSession({ model: 'opus' });
    const proc = await startProcess(session);
    proc.mcp.servers.get('claude.ai Slack').onReconnect = 'connected';
    const response = await api('POST', mcpRoute(session, 'claude.ai Slack', '/reconnect'));
    assert.deepEqual([response.body.ok, response.body.server.status], [true, 'connected']);
  });

  test('without a live process a fresh listing is the retry; Harbor’s own server and unknown names are refused', async () => {
    const session = await newSession({ model: 'luna' });
    await api('GET', `/api/sessions/${session.id}/mcp`);
    const spawns = discovery.spawns;
    const response = await api('POST', mcpRoute(session, 'wiki', '/reconnect'));
    assert.deepEqual([response.body.live, response.body.ok, response.body.server.status], [false, false, 'failed']);
    assert.equal(discovery.spawns, spawns + 1, 'a new listing, not the cached one');
    assert.equal((await api('POST', mcpRoute(session, 'meshy', '/reconnect'))).status, 400);
    assert.equal((await api('POST', mcpRoute(session, 'nope', '/reconnect'))).status, 404);
  });
});

describe('signing in', () => {
  test('an OAuth server: a process is started without a prompt, the answer carries the authorization link and the steps, and the process stays up while the sign-in waits', async () => {
    const session = await newSession({ model: 'luna' });
    assert.equal(runner.pool.get(session.id), undefined);
    const spawns = live.spawns;
    const response = await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth'));
    assert.equal(response.status, 200);
    assert.equal(live.spawns, spawns + 1);
    const proc = live.last;
    assert.deepEqual(proc.received, [], 'no prompt was sent');
    assert.equal(response.body.kind, 'oauth');
    assert.match(response.body.authUrl, /^https:\/\/auth\.example\/oauth\/authorize\?.*redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback/);
    assert.equal(response.body.callbackPort, 3118);
    assert.equal(response.body.expiresInSeconds, 300, 'the flow expires after about five minutes');
    assert.equal(response.body.instructions.length, 3);
    assert.match(response.body.instructions[1], /http:\/\/localhost:3118\/callback/);
    assert.deepEqual(proc.mcp.calls.find(([call]) => call === 'mcpAuthenticate'), ['mcpAuthenticate', 'plugin:slack:slack', undefined], 'no custom redirect: the CLI’s own localhost listener');
    // Past the idle timeout (300 ms) the process is still the session’s.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(runner.pool.get(session.id), signInProcess(session));
    assert.equal(proc.ended, false);
    assert.equal(logs.some((line) => /authorize/.test(line)), false, 'the link is never logged');
  });

  test('a slow answer from Claude Code does not let the idle close take the process away mid-call', async () => {
    // Every MCP control request answers after more than the idle timeout (300 ms).
    liveBehavior.mcpDelayMs = 450;
    try {
      for (const [tail, body] of [['/reconnect', {}], ['/auth', {}], ['/auth/clear', {}]]) {
        const session = await newSession({ model: 'deepseek' });
        const proc = await startProcess(session);
        const pooled = runner.pool.get(session.id);
        const spawns = live.spawns;
        const response = await api('POST', mcpRoute(session, 'plugin:slack:slack', tail), body);
        assert.equal(response.status, 200, `${tail}: ${JSON.stringify(response.body)}`);
        assert.equal(proc.ended, false, `${tail}: the process was still up when the call ended`);
        assert.equal(runner.pool.get(session.id), pooled);
        assert.equal(live.spawns, spawns, `${tail}: no second process was started`);
      }
    } finally {
      liveBehavior.mcpDelayMs = 0;
    }
  });

  test('pasting the address the browser failed to open finishes it: the server connects, the process is kept for the session, other live processes reconnect', async () => {
    const session = await newSession({ model: 'luna' });
    const other = await newSession({ model: 'luna' });
    const otherProc = await startProcess(other);
    otherProc.mcp.servers.get('plugin:slack:slack').onReconnect = 'connected';
    const auth = (await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth'))).body;
    const proc = live.last;
    const state = new URL(auth.authUrl).searchParams.get('state');
    const pasted = `http://localhost:3118/callback?code=THE-CODE&state=${state}`;
    const done = await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth/callback'), { url: pasted });
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.ok, done.body.server.status, done.body.server.name], [true, 'connected', 'plugin:slack:slack']);
    assert.deepEqual(proc.mcp.calls.find(([call]) => call === 'mcpSubmitOAuthCallbackUrl'), ['mcpSubmitOAuthCallbackUrl', 'plugin:slack:slack', pasted]);
    // Claude Code stores the token but leaves the server needing a sign-in until it is asked to connect again.
    const calls = proc.mcp.calls.map(([call]) => call);
    assert.ok(calls.indexOf('reconnectMcpServer') > calls.indexOf('mcpSubmitOAuthCallbackUrl'), 'it reconnects the server itself after the code is exchanged');
    assert.doesNotMatch(JSON.stringify(done.body), /THE-CODE/);
    assert.equal(logs.some((line) => /THE-CODE/.test(line)), false, 'the authorization code is never logged');
    // The token is shared: another session's live process picks the server up.
    await waitFor(() => otherProc.mcp.calls.some(([call, name]) => call === 'reconnectMcpServer' && name === 'plugin:slack:slack'));
    await waitFor(() => otherProc.mcp.servers.get('plugin:slack:slack').status === 'connected');
    // The sign-in is over, so the process is an ordinary idle one again (it closes after the idle timeout).
    await waitFor(() => !runner.pool.get(session.id));
    assert.equal(proc.ended, true);
  });

  test('the pasted address is checked before it reaches Claude Code, and the reasons are plain', async () => {
    const session = await newSession({ model: 'luna' });
    const auth = (await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth'))).body;
    const proc = live.last;
    const state = new URL(auth.authUrl).searchParams.get('state');
    const submit = (url) => api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth/callback'), { url });
    const submitted = () => proc.mcp.calls.filter(([call]) => call === 'mcpSubmitOAuthCallbackUrl').length;
    for (const [url, pattern] of [
      [undefined, /Paste the address/],
      ['', /Paste the address/],
      ['notaurl', /not a web address/],
      ['javascript:alert(1)', /must start with http/],
      ['https://slack.com/oauth/v2/authorize?code=1', /localhost/],
      ['http://localhost:3118/callback', /no code/],
      ['http://localhost:3118/callback?code=1&state=another', /earlier sign-in attempt/],
      [`http://localhost:3118/callback?error=access_denied&state=${state}`, /did not approve the sign-in \(access_denied\)/],
    ]) {
      const response = await submit(url);
      assert.equal(response.status, 400, String(url));
      assert.match(response.body.error, pattern, String(url));
    }
    assert.equal(submitted(), 0, 'none of them reached the process');
    assert.equal((await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth/callback'), 'not json')).status, 400);
    // The right one still works afterwards.
    assert.equal((await submit(`http://localhost:3118/callback?code=ok&state=${state}`)).status, 200);
  });

  test('without a sign-in waiting (expired, restarted, never started) the answer is 409', async () => {
    const session = await newSession({ model: 'luna' });
    const none = await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth/callback'), { url: 'http://localhost:3118/callback?code=1&state=2' });
    assert.equal(none.status, 409);
    assert.match(none.body.error, /No sign-in is waiting/);
    const auth = (await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth'))).body;
    assert.ok(auth.authUrl);
    // Claude Code restarted: its OAuth state went with it.
    await runner.pool.close(session.id, 'restart');
    await waitFor(() => !runner.pool.get(session.id));
    assert.equal((await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth/callback'), { url: 'http://localhost:3118/callback?code=1&state=2' })).status, 409);
  });

  test('a sign-in whose connection then fails is reported with the server’s own state, not as success', async () => {
    const session = await newSession({ model: 'luna' });
    const auth = (await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth'))).body;
    live.last.mcp.servers.get('plugin:slack:slack').afterSignIn = 'failed';
    const state = new URL(auth.authUrl).searchParams.get('state');
    const done = await api('POST', mcpRoute(session, 'plugin:slack:slack', '/auth/callback'), { url: `http://localhost:3118/callback?code=1&state=${state}` });
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.ok, done.body.server.status], [false, 'failed']);
    assert.match(done.body.error, /Connection failed/);
  });

  test('a claude.ai connector signs in on claude.ai: the answer is the link and the steps; no paste step exists for it', async () => {
    const session = await newSession({ model: 'opus' });
    const response = await api('POST', mcpRoute(session, 'claude.ai Slack', '/auth'));
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, 'claudeai');
    assert.match(response.body.authUrl, /^https:\/\/claude\.ai\/api\/organizations\/org-1\/mcp\/start-auth\/mcpsrv_Slack/);
    assert.equal(response.body.settingsUrl, 'https://claude.ai/settings/connectors');
    assert.match(response.body.instructions.at(-1), /Reconnect/);
    const callback = await api('POST', mcpRoute(session, 'claude.ai Slack', '/auth/callback'), { url: 'http://localhost:3118/callback?code=1&state=2' });
    assert.equal(callback.status, 409);
  });

  test('servers that cannot sign in, Harbor’s own, unknown names; sign out for OAuth servers only', async () => {
    const session = await newSession({ model: 'opus' });
    assert.match((await api('POST', mcpRoute(session, 'echo', '/auth'))).body.error, /does not use a sign-in/);
    assert.equal((await api('POST', mcpRoute(session, 'meshy', '/auth'))).status, 400);
    assert.equal((await api('POST', mcpRoute(session, 'nope', '/auth'))).status, 404);
    const clear = (name) => api('POST', mcpRoute(session, name, '/auth/clear'));
    assert.match((await clear('claude.ai Slack')).body.error, /signed in on claude\.ai/);
    assert.equal((await clear('echo')).status, 400);
    assert.equal((await clear('meshy')).status, 400);
    assert.equal((await clear('nope')).status, 404);
    const gateway = await newSession({ model: 'luna' });
    const cleared = await api('POST', mcpRoute(gateway, 'plugin:slack:slack', '/auth/clear'));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.server.status, 'needs-auth', 'Claude Code leaves the server needing a sign-in');
    assert.equal(cleared.body.server.error, undefined);
  });

  test('sign-in requests carry the same auth and origin checks as every route', async () => {
    const session = await newSession({ model: 'luna' });
    for (const tail of ['/auth', '/auth/callback', '/auth/clear', '/reconnect', '/toggle']) {
      assert.equal((await request('POST', mcpRoute(session, 'plugin:slack:slack', tail), { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, tail);
      assert.equal((await api('POST', mcpRoute(session, 'plugin:slack:slack', tail), {}, authed)).status, 403, tail + ' without Origin');
    }
    assert.equal((await request('GET', `/api/sessions/${session.id}/mcp`, { headers: {} })).status, 403);
  });
});
