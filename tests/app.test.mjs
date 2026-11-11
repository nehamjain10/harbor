// The HTTP API end to end over a private unix socket (never TCP: this is a shared host).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, afterEach, before, describe, test } from 'node:test';
import { createAgentTranscripts } from '../server/agent-transcript.mjs';
import { createApp } from '../server/app.mjs';
import { REPO_DIR } from '../server/config.mjs';
import { createEvents } from '../server/events.mjs';
import { createImporter } from '../server/importer.mjs';
import { setOpenRouterModels } from '../server/openrouter.mjs';
import { createRunner } from '../server/runner.mjs';
import { listenOnSocket } from '../server/socket.mjs';
import { createStore, publicSession } from '../server/store.mjs';
import { AGENT_SESSION, NESTED_AGENT, ROOT_AGENT, copyAgentFixtures } from './fixtures/agent-transcript/setup.mjs';
import { CLAUDE_SESSION, CODEX_SESSION, copyImportFixtures } from './fixtures/import/setup.mjs';
import { createFakeCli } from './fake-cli.mjs';

const OWNER = 'owner@example.com';
const HOST = 'workbench.example:18544';
let base;
let homeRoot;
let socketPath;
let server;
let store;
let events;
let runner;
// One entry per turn: what the fake Claude Code process received and its options.
const queryCalls = [];

// Like the real SDK, a turn fails on first read rather than at call time.
async function* failingTurn() {
  throw new Error('no model calls in tests');
}
let turnScript = failingTurn;
let fakeCli;

before(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-app-')));
  homeRoot = path.join(base, 'home');
  fs.mkdirSync(path.join(homeRoot, 'project'), { recursive: true });
  fs.mkdirSync(path.join(homeRoot, 'other'));
  fs.writeFileSync(path.join(homeRoot, 'project', 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(homeRoot, 'other', 'secret.txt'), 'secret');
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
  // Fake Claude Code processes; each user message runs the current turnScript.
  fakeCli = createFakeCli((turn) => {
    const args = { prompt: turn.content, options: turn.options, turn };
    queryCalls.push(args);
    return turnScript(args);
  });
  runner = createRunner({ config, events, query: fakeCli.query });
  // Session import reads fixture copies, never the real ~/.claude or ~/.codex.
  const fixtures = copyImportFixtures(path.join(base, 'import'), { cwd: path.join(homeRoot, 'project') });
  const importer = createImporter({ config: { ...config, claudeConfigDir: fixtures.claudeHome, codexHome: fixtures.codexHome }, store, events });
  // Subagent transcripts of the project folder's sessions, in the same fixture copy.
  copyAgentFixtures(fixtures.claudeHome, { cwd: path.join(homeRoot, 'project') });
  const agentTranscripts = createAgentTranscripts({ config: { ...config, claudeConfigDir: fixtures.claudeHome } });
  const app = createApp({ config, store, events, runner, importer, agentTranscripts });
  socketPath = path.join(base, 'web.sock');
  server = await listenOnSocket(app, socketPath);
});

afterEach(() => {
  turnScript = failingTurn;
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

function api(method, route, body, headers = body === undefined ? authed : writeHeaders) {
  return request(method, route, { headers, body });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function newSession(fields = {}) {
  const response = await api('POST', '/api/sessions', { cwd: 'project', ...fields });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return store.get(response.body.id);
}

/** A turn that waits on a canUseTool approval for Bash, then finishes. */
function approvalTurn(decisions) {
  return async function* ({ options }) {
    const signal = options.abortController.signal;
    decisions.push(await options.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 't1' }));
    yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
  };
}

describe('auth and headers', () => {
  test('requests without the Tailscale identity get 403', async () => {
    const response = await api('GET', '/api/sessions', undefined, {});
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'Connect with your Tailscale account to open this workspace.' });
    const wrongUser = await api('GET', '/api/sessions', undefined, { 'Tailscale-User-Login': 'someone@else' });
    assert.equal(wrongUser.status, 403);
  });

  test('writes without the right Origin get 403', async () => {
    const noOrigin = await api('POST', '/api/sessions', {}, { ...authed, 'Content-Type': 'application/json' });
    assert.equal(noOrigin.status, 403);
    assert.deepEqual(noOrigin.body, { error: 'Invalid origin' });
    const wrongOrigin = await api('POST', '/api/sessions', {}, { ...writeHeaders, Origin: 'https://evil.example' });
    assert.equal(wrongOrigin.status, 403);
  });

  test('security headers are set on every response, with blob: images allowed', async () => {
    const response = await api('GET', '/api/sessions', undefined, {});
    assert.equal(
      response.headers['content-security-policy'],
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'same-origin');
    assert.equal(response.headers['x-powered-by'], undefined);
  });

  test('the socket is private', () => {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  });
});

describe('sessions API', () => {
  test('POST accepts legacy and new mode names and stores the new names', async () => {
    const cases = [
      ['yolo', 'bypassPermissions'],
      ['ask', 'default'],
      ['plan', 'plan'],
      ['acceptEdits', 'acceptEdits'],
      ['auto', 'auto'],
      ['bypassPermissions', 'bypassPermissions'],
      [undefined, 'bypassPermissions'],
      [null, 'bypassPermissions'],
      ['', 'bypassPermissions'],
    ];
    for (const [requested, stored] of cases) {
      const response = await api('POST', '/api/sessions', { cwd: 'project', model: 'opus', mode: requested });
      assert.equal(response.status, 200, String(requested));
      assert.equal(response.body.mode, stored, String(requested));
      assert.equal(store.get(response.body.id).mode, stored);
      const onDisk = JSON.parse(fs.readFileSync(path.join(base, 'data', response.body.id + '.json')));
      assert.equal(onDisk.mode, stored);
    }
  });

  test('POST refuses an unknown mode instead of defaulting to bypass', async () => {
    const before = store.sessions.size;
    for (const mode of ['bogus', 'dontAsk', 'YOLO', 3, true]) {
      const response = await api('POST', '/api/sessions', { cwd: 'project', mode });
      assert.equal(response.status, 400, String(mode));
      assert.deepEqual(response.body, { error: 'Unknown mode' });
    }
    assert.equal(store.sessions.size, before);
  });

  test('POST builds a v1-shaped session', async () => {
    const response = await api('POST', '/api/sessions', { cwd: 'project', model: 'deepseek', effort: 'max', title: 'T' });
    assert.equal(response.status, 200);
    const session = response.body;
    assert.deepEqual(Object.keys(session), [
      'efforts', 'id', 'title', 'cwd', 'model', 'mode', 'status', 'messages', 'pending', 'createdAt', 'updatedAt',
      // v2 fields, present with their empty values from the start
      'live', 'liveThinking', 'todos', 'plan', 'context', 'totals', 'mcp', 'lastMessageAt', 'backgroundAgents', 'liveTasks', 'crons',
      'pinned', 'turnEndedAt', 'lastViewedAt', 'allowRules', 'allowDirectories', 'mcpDisabled', 'goal', 'cluster', 'steering', 'messageCount',
      // the revision of the last delta event it includes
      'rev',
    ]);
    assert.equal(session.backgroundAgents, 0);
    assert.deepEqual(
      [session.pinned, session.turnEndedAt, session.lastViewedAt, session.allowRules, session.allowDirectories],
      [false, 0, 0, [], []],
    );
    assert.deepEqual(session.totals, { cost: 0, outputTokens: 0, turns: 0 });
    assert.deepEqual([session.todos, session.plan, session.context, session.mcp, session.mcpDisabled], [[], null, null, [], []]);
    assert.deepEqual(session.efforts, { deepseek: 'max' });
    assert.equal(session.cwd, path.join(homeRoot, 'project'));
    assert.equal(session.title, 'T');
  });

  test('POST validates model, effort and project folder', async () => {
    assert.deepEqual((await api('POST', '/api/sessions', { model: 'gpt-2' })).body, { error: 'Unknown model' });
    assert.deepEqual((await api('POST', '/api/sessions', { model: 'deepseek', effort: 'medium' })).body, {
      error: 'Unsupported effort for this model',
    });
    const outside = await api('POST', '/api/sessions', { cwd: '..' });
    assert.equal(outside.status, 403);
    assert.deepEqual(outside.body, { error: 'Choose a folder inside your home directory.' });
  });

  test('PATCH accepts legacy and new mode names and rejects unknown ones', async () => {
    const session = await newSession({ mode: 'plan' });
    const route = `/api/sessions/${session.id}`;
    assert.equal((await api('PATCH', route, { mode: 'ask' })).body.mode, 'default');
    assert.equal((await api('PATCH', route, { mode: 'yolo' })).body.mode, 'bypassPermissions');
    assert.equal((await api('PATCH', route, { mode: 'acceptEdits' })).body.mode, 'acceptEdits');
    assert.equal((await api('PATCH', route, { mode: 'auto' })).body.mode, 'auto');
    const bad = await api('PATCH', route, { mode: 'dontAsk' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'Unknown mode' });
    assert.equal(session.mode, 'auto');
  });

  test('PATCH updates title, effort and flags', async () => {
    const session = await newSession();
    const route = `/api/sessions/${session.id}`;
    const updated = (await api('PATCH', route, { title: '  Renamed  ', effort: 'max', archived: true })).body;
    assert.equal(updated.title, 'Renamed');
    assert.deepEqual(updated.efforts, { opus: 'max' });
    assert.equal(updated.archived, true);
    // Effort is recorded for the model being switched to.
    const switched = (await api('PATCH', route, { model: 'deepseek', effort: 'high' })).body;
    assert.deepEqual(switched.efforts, { opus: 'max', deepseek: 'high' });
    assert.equal((await api('PATCH', route, { removed: true })).body.queuePaused, true);
    // Blank titles are ignored.
    assert.equal((await api('PATCH', route, { title: '   ' })).body.title, 'Renamed');
  });

  test('OpenRouter models: listed for the picker, and a session can switch to one (or: ids)', async () => {
    const tiny = { id: 'or:acme/tiny', name: 'Tiny', vendor: 'Acme', contextWindow: 131_072, vision: false, reasoning: false, price: { in: 2, out: 8 } };
    setOpenRouterModels([tiny]);
    assert.deepEqual((await api('GET', '/api/openrouter-models')).body, [tiny]);
    const session = await newSession();
    const route = `/api/sessions/${session.id}`;
    assert.equal((await api('PATCH', route, { model: 'or:acme/tiny' })).body.model, 'or:acme/tiny');
    // Not (yet) listed: still a well-formed id, so it is accepted.
    const later = await api('PATCH', route, { model: 'or:newco/model-9', effort: 'high' });
    assert.equal(later.body.model, 'or:newco/model-9');
    assert.equal(later.body.efforts['or:newco/model-9'], 'high');
    for (const model of ['or:', 'or:tiny', 'or:acme/tiny:free']) {
      assert.deepEqual((await api('PATCH', route, { model })).body, { error: 'Unknown model' }, model);
    }
    // No reasoning on Tiny: no effort to choose.
    assert.deepEqual((await api('PATCH', route, { model: 'or:acme/tiny', effort: 'high' })).body, { error: 'Unsupported effort for this model' });
    assert.equal((await api('POST', '/api/sessions', { model: 'or:acme/tiny' })).body.model, 'or:acme/tiny');
    assert.equal(session.model, 'or:newco/model-9');
  });

  test('Empty Trash deletes trashed sessions for good; DELETE needs one in Trash', async () => {
    const kept = await newSession();
    const trashed = await newSession();
    const route = `/api/sessions/${trashed.id}`;
    assert.equal((await api('DELETE', `/api/sessions/${kept.id}`, undefined, writeHeaders)).status, 409);
    await api('PATCH', route, { removed: true });
    const file = path.join(store.dataDir, trashed.id + '.json');
    store.save(store.get(trashed.id));
    assert.ok(fs.existsSync(file));
    const emptied = (await api('POST', '/api/trash/empty', {})).body;
    assert.ok(emptied.deleted.includes(trashed.id));
    assert.ok(!emptied.deleted.includes(kept.id));
    assert.equal(fs.existsSync(file), false);
    assert.equal((await api('GET', route)).status, 404);
    assert.equal((await api('GET', `/api/sessions/${kept.id}`)).status, 200);
  });

  test('PATCH sets pinned and viewed flags, also mid-turn', async () => {
    const session = await newSession();
    const route = `/api/sessions/${session.id}`;
    const pinned = await api('PATCH', route, { pinned: true });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.pinned, true);
    assert.equal((await api('PATCH', route, { pinned: false })).body.pinned, false);

    const before = Date.now();
    const viewed = (await api('PATCH', route, { viewed: true })).body;
    assert.ok(viewed.lastViewedAt >= before);
    assert.equal(session.lastViewedAt, viewed.lastViewedAt);
    assert.equal(viewed.messages, undefined, 'a patch answers with the list form');

    for (const [body, error] of [
      [{ pinned: 'yes' }, 'Pinned must be true or false.'],
      [{ viewed: false }, 'Viewed can only be true.'],
      [{ title: 'Changed', pinned: 1 }, 'Pinned must be true or false.'],
    ]) {
      const response = await api('PATCH', route, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(response.body, { error });
    }
    assert.equal(session.title, 'New session', 'no partial change');

    // "Allow always" grants can be cleared, never added.
    session.allowRules = [{ toolName: 'Bash', ruleContent: 'make' }];
    session.allowDirectories = ['/d'];
    assert.equal((await api('PATCH', route, { allowRules: [{ toolName: 'Bash' }] })).status, 400);
    assert.equal((await api('PATCH', route, { allowRules: [], allowDirectories: [] })).status, 200);
    assert.deepEqual([session.allowRules, session.allowDirectories], [[], []]);

    // Allowed while a turn runs.
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    turnScript = async function* () {
      await gate;
      yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };
    await api('POST', `${route}/messages`, { text: 'work' });
    assert.equal(session.status, 'running');
    assert.equal((await api('PATCH', route, { pinned: true, viewed: true })).status, 200);
    release();
    await waitFor(() => session.status === 'idle');
    assert.ok(session.turnEndedAt >= session.lastViewedAt, 'the finished turn is unread');
  });

  test('PATCH applies nothing when any field is rejected', async () => {
    const session = await newSession({ model: 'opus', mode: 'plan', title: 'Original' });
    const route = `/api/sessions/${session.id}`;
    const snapshot = JSON.stringify(session);
    const rejected = [
      [{ title: 'Changed', model: 'deepseek', mode: 'nope' }, 400, 'Unknown mode'],
      [{ title: 'Changed', archived: true, model: 'gpt-2' }, 400, 'Unknown model'],
      [{ model: 'deepseek', effort: 'low' }, 400, 'Unsupported effort for this model'],
      [{ mode: 'default', title: 42 }, 400, 'The title must be text.'],
    ];
    for (const [body, status, error] of rejected) {
      const response = await api('PATCH', route, body);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.deepEqual(response.body, { error });
      assert.equal(JSON.stringify(session), snapshot, `no partial change for ${JSON.stringify(body)}`);
    }
  });

  test('PATCH switches model and mode mid-turn but refuses remove and archive', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    turnScript = async function* () {
      await gate;
      yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };
    const liveModes = () => fakeCli.last.controls.filter(([name]) => name === 'setPermissionMode').map(([, mode]) => mode);
    const session = await newSession({ model: 'astra', title: 'Busy' });
    const route = `/api/sessions/${session.id}`;
    await api('POST', `${route}/messages`, { text: 'work' });
    assert.equal(session.status, 'running');
    await waitFor(() => queryCalls.at(-1)?.prompt === 'work');
    const snapshot = JSON.stringify({ ...session, updatedAt: 0 });
    const rejected = [
      [{ title: 'Renamed', removed: true }, 'Stop the session before removing it.'],
      [{ title: 'Renamed', archived: false }, 'Stop the session before archiving.'],
    ];
    for (const [body, error] of rejected) {
      const response = await api('PATCH', route, body);
      assert.equal(response.status, 409);
      assert.deepEqual(response.body, { error });
      assert.equal(JSON.stringify({ ...session, updatedAt: 0 }), snapshot, 'no partial change');
    }

    const switched = await api('PATCH', route, { mode: 'acceptEdits' });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.mode, 'acceptEdits');
    // Auto is stored as chosen but runs as default on a gateway model.
    assert.equal((await api('PATCH', route, { mode: 'auto' })).body.mode, 'auto');
    assert.deepEqual(liveModes(), ['acceptEdits', 'default']);

    const model = await api('PATCH', route, { model: 'deepseek', effort: 'max' });
    assert.equal(model.status, 200);
    assert.equal(model.body.model, 'deepseek');
    assert.deepEqual(model.body.efforts, { astra: 'default', deepseek: 'max' });
    assert.equal(queryCalls.at(-1).options.model, 'codex/gpt-6-astra', 'the running turn keeps its model');
    // Title and effort alone are fine mid-turn.
    assert.equal((await api('PATCH', route, { title: 'Renamed', effort: 'high' })).status, 200);
    release();
    await waitFor(() => session.status === 'idle');
  });

  test('pushed copies cut long tool output; the message route returns it whole', async () => {
    const session = await newSession();
    const output = 'line\n'.repeat(2000);
    session.messages.push({ id: 'tool-1', role: 'tool', text: '', at: 1, tool: 'Bash', input: {}, toolId: 't', state: 'done', output });
    session.messages.push({ id: 'tool-2', role: 'tool', text: '', at: 2, tool: 'Bash', input: {}, toolId: 'u', state: 'done', output: 'short' });

    const full = (await api('GET', `/api/sessions/${session.id}`)).body;
    const [long, short] = full.messages;
    assert.equal(long.output.length, 4000);
    assert.equal(long.outputTruncated, true);
    assert.equal(short.output, 'short');
    assert.equal(short.outputTruncated, undefined);
    assert.equal(session.messages[0].output.length, output.length, 'the stored copy is untouched');

    const message = await api('GET', `/api/sessions/${session.id}/messages/tool-1`);
    assert.equal(message.status, 200);
    assert.equal(message.body.output, output);
    assert.equal(message.body.outputTruncated, undefined);
    assert.equal((await api('GET', `/api/sessions/${session.id}/messages/nope`)).status, 404);
    assert.equal((await api('GET', `/api/sessions/nope/messages/tool-1`)).status, 404);
  });

  test('POST /api/admin/reload reloads the model catalog and tells open pages', async () => {
    const written = [];
    const unsubscribe = events.subscribe({ write: (chunk) => written.push(String(chunk)), writableLength: 0 });
    const response = await api('POST', '/api/admin/reload', {});
    unsubscribe();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.catalog.models.includes('opus'));
    assert.ok(written.some((chunk) => chunk.startsWith('event: info')), written.join(''));
    assert.equal((await api('POST', '/api/admin/reload', {}, authed)).status, 403, 'needs the Origin like any write');
  });

  test('GET /api/info lists model capabilities and the permission modes', async () => {
    const info = (await api('GET', '/api/info')).body;
    assert.equal(info.gateway, false, 'the test gateway is unreachable');
    const deepseek = info.models.find((model) => model.id === 'deepseek');
    assert.deepEqual(
      { contextWindow: deepseek.contextWindow, vision: deepseek.vision, modes: deepseek.modes },
      { contextWindow: 400_000, vision: true, modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
    );
    assert.equal(info.models.find((model) => model.id === 'opus').modes.includes('auto'), true);
    assert.deepEqual(
      info.modes.map((mode) => [mode.id, mode.label]),
      [
        ['default', 'Ask'],
        ['acceptEdits', 'Accept edits'],
        ['plan', 'Plan'],
        ['auto', 'Auto'],
        ['bypassPermissions', 'Bypass'],
      ],
    );
  });

  test('GET returns the full session without the SDK session id; list omits messages', async () => {
    const session = await newSession();
    session.sdkSessionId = 'secret';
    const full = (await api('GET', `/api/sessions/${session.id}`)).body;
    assert.equal(full.sdkSessionId, undefined);
    assert.deepEqual(full.messages, []);
    const list = (await api('GET', '/api/sessions')).body;
    const entry = list.find((s) => s.id === session.id);
    assert.equal(entry.messages, undefined);
    assert.equal(entry.sdkSessionId, undefined);
    assert.equal((await api('GET', '/api/sessions/nope')).status, 404);
  });

  test('GET with the revision the client holds answers "unchanged" while it is current', async () => {
    const session = await newSession();
    const full = (await api('GET', `/api/sessions/${session.id}`)).body;
    assert.equal(full.messageCount, 0);
    const same = await api('GET', `/api/sessions/${session.id}?rev=${full.rev}`);
    assert.deepEqual(same.body, { id: session.id, rev: full.rev, unchanged: true });
    // A change the client has not seen: the whole session, at a newer revision.
    session.messages.push({ id: 'm-new', role: 'notice', text: 'changed', level: 'info', at: 1 });
    const changed = (await api('GET', `/api/sessions/${session.id}?rev=${full.rev}`)).body;
    assert.equal(changed.unchanged, undefined);
    assert.ok(changed.rev > full.rev);
    assert.equal(changed.messages.at(-1).id, 'm-new');
    assert.equal(changed.messageCount, 1);
    assert.equal((await api('GET', `/api/sessions/${session.id}?rev=1`)).body.unchanged, undefined, 'an unknown revision gets the session');
  });

  // `turns` turns of a user message and a reply, pushed into `session` (ids u<i>, a<i>).
  function pushTurns(session, turns, start = 0) {
    for (let i = start; i < start + turns; i++) {
      session.messages.push({ id: `u${i}`, role: 'user', text: `Question ${i}`, at: i, delivery: 'done' });
      session.messages.push({ id: `a${i}`, role: 'assistant', text: `Answer ${i}`, at: i });
    }
  }

  test('GET ?tail=N: the recent end of the messages, cut at a turn, with where it starts', async () => {
    const session = await newSession();
    session.sdkSessionId = 'secret';
    pushTurns(session, 30);
    const route = `/api/sessions/${session.id}`;
    const tail = (await api('GET', `${route}?tail=10`)).body;
    assert.deepEqual([tail.messagesFrom, tail.messageCount, tail.messages.length], [50, 60, 10]);
    assert.deepEqual(tail.messages.map((m) => m.id), session.messages.slice(50).map((m) => m.id));
    assert.equal(tail.messages[0].role, 'user');
    assert.equal(tail.sdkSessionId, undefined);
    assert.equal(tail.title, session.title);
    // The revision the client holds, with a tail: unchanged; the full form has the same one.
    const same = await api('GET', `${route}?tail=10&rev=${tail.rev}`);
    assert.deepEqual(same.body, { id: session.id, rev: tail.rev, unchanged: true });
    const full = (await api('GET', route)).body;
    assert.equal(full.rev, tail.rev);
    assert.equal(full.messagesFrom, undefined, 'without ?tail: the full form, as before');
    assert.equal(full.messages.length, 60);
    // A change: the tail at a newer revision.
    session.messages.push({ id: 'late', role: 'notice', text: 'changed', level: 'info', at: 99 });
    const changed = (await api('GET', `${route}?tail=10&rev=${tail.rev}`)).body;
    assert.ok(changed.rev > tail.rev);
    assert.deepEqual([changed.messagesFrom, changed.messageCount, changed.messages.at(-1).id], [50, 61, 'late']);
    // Within the limit: everything, from 0.
    assert.equal((await api('GET', `${route}?tail=1000`)).body.messagesFrom, 0);
    for (const bad of ['0', '-1', 'x', '1.5']) {
      const refused = await api('GET', `${route}?tail=${bad}`);
      assert.deepEqual([refused.status, refused.body], [400, { error: 'The tail must be a number of messages.' }], bad);
    }
  });

  test("GET ?tail=N reaches back to the agent call of every message in it", async () => {
    const session = await newSession();
    pushTurns(session, 10);
    session.messages.push({ id: 'card', role: 'tool', text: '', at: 10, tool: 'Agent', input: {}, toolId: 'bg', state: 'done', background: true });
    pushTurns(session, 20, 10);
    session.messages.push({ id: 'end', role: 'notice', text: 'Background agent finished.', level: 'info', at: 50, agentToolId: 'bg' });
    const tail = (await api('GET', `/api/sessions/${session.id}?tail=10`)).body;
    assert.equal(tail.messagesFrom, 20);
    assert.equal(tail.messages[0].id, 'card');
  });

  test('GET /api/sessions/:id/messages: the page before the first message a client holds', async () => {
    const session = await newSession();
    const output = 'line\n'.repeat(2000);
    session.messages.push({ id: 'tool-0', role: 'tool', text: '', at: 0, tool: 'Bash', input: {}, toolId: 't0', state: 'done', output });
    pushTurns(session, 60);
    const route = `/api/sessions/${session.id}/messages`;
    const tail = (await api('GET', `/api/sessions/${session.id}?tail=20`)).body;
    assert.equal(tail.messagesFrom, 101);
    const page = (await api('GET', `${route}?before=101&limit=40&beforeId=u50`)).body;
    assert.deepEqual([page.from, page.before, page.messageCount, page.rev, page.messages.length], [61, 101, 121, tail.rev, 40]);
    assert.deepEqual(page.messages.map((m) => m.id), session.messages.slice(61, 101).map((m) => m.id));
    // The rest: down to the first message, cut long output as in every pushed copy.
    const rest = (await api('GET', `${route}?before=61&limit=61&beforeId=u30`)).body;
    assert.deepEqual([rest.from, rest.messages.length, rest.messages[0].output.length, rest.messages[0].outputTruncated], [0, 61, 4000, true]);
    // Defaults: before the end, a page of 300.
    assert.deepEqual((await api('GET', route)).body.messages.length, 121);
    // The list moved meanwhile: the page is cut where the message is now.
    session.messages.splice(5, 1);
    const moved = (await api('GET', `${route}?before=101&limit=40&beforeId=u50`)).body;
    assert.deepEqual([moved.before, moved.messages.at(-1).id], [100, 'a49']);
    session.messages.splice(100, 1);
    const gone = await api('GET', `${route}?before=100&limit=40&beforeId=u50`);
    assert.deepEqual([gone.status, gone.body], [409, { error: 'This conversation changed. Open it again to see it.' }]);
    for (const query of ['before=-1', 'before=x', 'before=500', 'before=10&limit=0', 'before=10&limit=abc']) {
      assert.equal((await api('GET', `${route}?${query}`)).status, 400, query);
    }
    assert.equal((await api('GET', '/api/sessions/nope/messages')).status, 404);
  });

  test('fork ?tail=N answers with the new session in its tail form', async () => {
    const session = await newSession();
    pushTurns(session, 30);
    const forked = await api('POST', `/api/sessions/${session.id}/fork?tail=10`, {});
    assert.equal(forked.status, 200, JSON.stringify(forked.body));
    const copy = forked.body.session;
    // The copy's messages and the fork's notice after them.
    assert.deepEqual([copy.messagesFrom, copy.messageCount, copy.messages.length, copy.messages[0].id], [50, 61, 11, 'u25']);
    const whole = await api('POST', `/api/sessions/${session.id}/fork`, {});
    assert.equal(whole.body.session.messagesFrom, undefined);
    assert.equal(whole.body.session.messages.length, 61);
    assert.equal((await api('POST', `/api/sessions/${session.id}/fork?tail=0`, {})).status, 400);
  });

  test('messages are validated, deduplicated by clientId and capped at 30 queued', async () => {
    const session = await newSession();
    const route = `/api/sessions/${session.id}/messages`;
    assert.deepEqual((await api('POST', route, { text: '   ' })).body, { error: 'Write a message first.' });
    assert.deepEqual((await api('POST', route, { text: 'x'.repeat(150_001) })).body, { error: 'This message is too long.' });

    session.queue = Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, text: 'queued' }));
    const full = await api('POST', route, { text: 'one more', clientId: 'c-full' });
    assert.equal(full.status, 429);
    assert.deepEqual(full.body, { error: 'There are 30 messages queued. Wait for a turn to finish.' });

    session.queue = [];
    session.messages.push({ id: 'm1', role: 'user', text: 'sent', clientId: 'dup', at: 1 });
    const before = session.messages.length;
    assert.deepEqual((await api('POST', route, { text: 'sent', clientId: 'dup' })).body, { ok: true });
    assert.equal(session.messages.length, before);

    // A message to a model agent (nested under its card) is not one of the session's own.
    session.messages.push({ id: 'm2', role: 'user', text: 'to a worker', clientId: 'nested', parentToolId: 'toolu_a', from: 'user', delivery: 'done', at: 2 });
    assert.deepEqual((await api('POST', route, { text: 'mine', clientId: 'nested' })).body, { ok: true, queued: false });
    assert.ok(session.messages.some((m) => m.text === 'mine' && !m.parentToolId));
    await waitFor(() => !runner.isRunning(session.id));
  });

  test('queued is false when the message starts at once and true when it waits behind a turn', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    turnScript = async function* () {
      await gate;
      yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };
    const session = await newSession({ model: 'astra' });
    const route = `/api/sessions/${session.id}/messages`;
    assert.deepEqual((await api('POST', route, { text: 'first', clientId: 'a' })).body, { ok: true, queued: false });
    assert.deepEqual((await api('POST', route, { text: 'second', clientId: 'b', queue: true })).body, { ok: true, queued: true });
    // Without `queue`, a message sent mid-turn goes to Claude at once.
    assert.deepEqual((await api('POST', route, { text: 'steer', clientId: 'c' })).body, { ok: true, queued: false, steering: true });
    assert.deepEqual(session.steering.map((item) => item.text), ['steer']);
    assert.equal((await api('POST', route, { text: 'x', queue: 'yes' })).status, 400);
    release();
    await waitFor(() => session.status === 'idle' && !session.queue.length && !session.steering.length);
  });

  test('a failing turn surfaces as a notice', async () => {
    const session = await newSession({ model: 'astra' });
    const before = queryCalls.length;
    const response = await api('POST', `/api/sessions/${session.id}/messages`, { text: 'hello', clientId: 'c1' });
    assert.deepEqual(response.body, { ok: true, queued: false });
    await waitFor(() => session.status === 'error');
    assert.equal(queryCalls.length, before + 1);
    assert.equal(session.messages.at(-1).text, 'no model calls in tests');
    assert.equal(session.title, 'hello');
  });

  test('queue cancel reports a message that already started with 409', async () => {
    const session = await newSession();
    const cancel = await api('POST', `/api/sessions/${session.id}/queue/nope/cancel`, {});
    assert.equal(cancel.status, 409);
    assert.deepEqual(cancel.body, { error: 'This message has already started.' });
  });

  test('stopping an agent: 404 for an unknown call, 409 when it is not running; the count of background agents is published', async () => {
    const session = await newSession();
    const route = (toolId) => `/api/sessions/${session.id}/agents/${toolId}/stop`;
    const unknown = await api('POST', route('toolu_nope'), {});
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'Agent not found' });

    const agent = { id: 'm1', role: 'tool', tool: 'Agent', toolId: 'toolu_a', input: { description: 'Look around' }, state: 'running', background: true, taskId: 't1', at: Date.now() };
    session.messages.push(agent, { id: 'm2', role: 'tool', tool: 'Agent', toolId: 'toolu_b', state: 'done', background: true });
    assert.equal((await api('GET', `/api/sessions/${session.id}`)).body.backgroundAgents, 1);
    assert.equal((await api('GET', '/api/sessions')).body.find((s) => s.id === session.id).backgroundAgents, 1);
    // No Claude Code process runs it here, so there is nothing to stop.
    const orphan = await api('POST', route('toolu_a'), {});
    assert.equal(orphan.status, 409);
    assert.deepEqual(orphan.body, { error: 'This agent is not running.' });
    assert.equal((await api('POST', route('toolu_b'), {})).status, 409);
  });

  test('a message to a model agent: it is read at its next step and shows under its card; 404, 409 and 400 otherwise', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    // The worker waits, reads the messages that came meanwhile, and answers.
    turnScript = async function* ({ turn }) {
      await gate;
      const read = turn.fold();
      yield { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `read ${read.length}` }] } };
      yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };
    const session = await newSession({ model: 'astra' });
    session.messages.push(
      { id: 'c1', role: 'tool', tool: 'mcp__meshy__delegate', toolId: 'toolu_w', input: { model: 'luna', task: 'go' }, state: 'running', at: Date.now() },
      { id: 'c2', role: 'tool', tool: 'Agent', toolId: 'toolu_native', input: {}, state: 'running', background: true, taskId: 't1', at: Date.now() },
    );
    await runner.modelAgents.tools(session).delegate({ model: 'luna', task: 'go' }, { _meta: { 'claudecode/toolUseId': 'toolu_w' } });
    const proc = fakeCli.processes.at(-1);
    const route = (toolId) => `/api/sessions/${session.id}/agents/${toolId}/message`;

    assert.equal((await api('POST', `/api/sessions/nope/agents/toolu_w/message`, { text: 'hi' })).status, 404);
    const unknown = await api('POST', route('toolu_nope'), { text: 'hi' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'Agent not found' });
    const native = await api('POST', route('toolu_native'), { text: 'hi' });
    assert.equal(native.status, 409);
    assert.deepEqual(native.body, { error: 'Only model agents take messages.' });
    for (const text of ['', '   ', undefined, 7]) {
      const empty = await api('POST', route('toolu_w'), { text });
      assert.equal(empty.status, 400);
      assert.deepEqual(empty.body, { error: 'Write a message first.' });
    }
    const long = await api('POST', route('toolu_w'), { text: 'x'.repeat(150_001) });
    assert.equal(long.status, 400);
    assert.deepEqual(long.body, { error: 'This message is too long.' });
    // The same checks as the other writes: the Tailscale identity and the origin.
    assert.equal((await api('POST', route('toolu_w'), { text: 'hi' }, { ...authed, 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await api('POST', route('toolu_w'), { text: 'hi' }, { 'Origin': 'https://' + HOST, 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await request('POST', route('toolu_w'), { headers: writeHeaders, body: '{"text":' })).status, 400);
    assert.deepEqual(session.messages.filter((m) => m.parentToolId), [], 'none of those reached it');

    const sent = await api('POST', route('toolu_w'), { text: '  use tabs  ', clientId: 'c-1' });
    assert.equal(sent.status, 200);
    assert.deepEqual(Object.keys(sent.body).sort(), ['messageId', 'ok']);
    assert.equal(sent.body.ok, true);
    const [message] = session.messages.filter((m) => m.role === 'user' && m.parentToolId === 'toolu_w');
    assert.equal(message.id, sent.body.messageId);
    assert.deepEqual([message.text, message.from, message.delivery, message.clientId], ['use tabs', 'user', 'sent', 'c-1']);
    // It shows in the session as the nested message it is: not queued, not steering the main turn.
    const shown = (await api('GET', `/api/sessions/${session.id}`)).body;
    assert.equal(shown.messages.find((m) => m.id === message.id).parentToolId, 'toolu_w');
    assert.deepEqual([session.queue?.length ?? 0, shown.steering], [0, []]);
    await waitFor(() => proc.received.length === 2);
    assert.deepEqual([proc.received[1].content, proc.received[1].priority], ['[Message from the user]\n\nuse tabs', 'next']);

    const again = await api('POST', route('toolu_w'), { text: 'use tabs', clientId: 'c-1' });
    assert.deepEqual(again.body, { ok: true, messageId: sent.body.messageId });
    assert.equal(session.messages.filter((m) => m.parentToolId === 'toolu_w' && m.role === 'user').length, 1);

    release();
    await waitFor(() => message.delivery === 'done');
    await waitFor(() => session.messages.find((m) => m.toolId === 'toolu_w').state === 'done');
    assert.ok(session.messages.some((m) => m.role === 'assistant' && m.parentToolId === 'toolu_w' && m.text === 'read 1'));
    const late = await api('POST', route('toolu_w'), { text: 'too late' });
    assert.equal(late.status, 409);
    assert.deepEqual(late.body, { error: 'This agent is not running.' });
    // The worker's report starts a turn of the main model: let it end before the next test.
    await waitFor(() => !runner.isRunning(session.id) && session.status !== 'running');
  });

  test("an agent's transcript from Claude Code's files: messages rooted at its call; 400, 404 for bad or unknown ids", async () => {
    const session = await newSession();
    session.sdkSessionId = AGENT_SESSION;
    session.messages.push({ id: 'm1', role: 'tool', tool: 'Agent', toolId: ROOT_AGENT, input: { description: 'Survey the repo', prompt: 'Survey.' }, state: 'done', at: Date.now() });
    const route = (toolId) => `/api/sessions/${session.id}/agents/${toolId}/transcript`;
    const found = await api('GET', route(ROOT_AGENT));
    assert.equal(found.status, 200);
    assert.equal(found.body.toolId, ROOT_AGENT);
    assert.equal(found.body.description, 'Survey the repo');
    assert.equal(found.body.truncated, false);
    const own = found.body.messages.filter((m) => m.parentToolId === ROOT_AGENT);
    const nested = found.body.messages.filter((m) => m.parentToolId === NESTED_AGENT);
    assert.deepEqual([own.length, nested.length], [7, 2]);
    assert.equal(own.at(-1).text, 'The repository has two packages, core and cli, under the MIT license.');
    // The session is unchanged: the transcript is read, never stored.
    assert.equal(session.messages.length, 1);

    // The importer's fixture session holds agent toolu_02 in another project folder.
    // (A session holding that id would leave it out of the import list: put it back.)
    session.sdkSessionId = CLAUDE_SESSION;
    const other = await api('GET', route('toolu_02'));
    session.sdkSessionId = AGENT_SESSION;
    assert.equal(other.status, 200);
    assert.deepEqual(other.body.messages.map((m) => m.tool || m.text), ['Grep', 'The bug is in add(): it subtracts.']);

    assert.deepEqual((await api('GET', route('toolu_nope'))).body, { error: 'Claude Code has no transcript of this agent.' });
    assert.equal((await api('GET', route('toolu_nope'))).status, 404);
    const bad = await api('GET', route('..%2F..%2Fetc'));
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'Invalid agent id.' });
    assert.equal((await api('GET', `/api/sessions/nope/agents/${ROOT_AGENT}/transcript`)).status, 404);
  });

  test('malformed JSON is a 400 with an error body', async () => {
    const response = await request('POST', '/api/sessions', { headers: writeHeaders, body: '{"cwd":' });
    assert.equal(response.status, 400);
    assert.equal(typeof response.body.error, 'string');
  });
});

describe('approvals API', () => {
  test('unknown approvals get 409', async () => {
    const approval = await api('POST', '/api/approvals/unknown', { allow: true });
    assert.equal(approval.status, 409);
    assert.deepEqual(approval.body, { error: 'This request has already been resolved.' });
  });

  test('allow must be a boolean; a valid answer resolves the tool call', async () => {
    const decisions = [];
    turnScript = approvalTurn(decisions);
    const session = await newSession({ model: 'astra', mode: 'default' });
    await api('POST', `/api/sessions/${session.id}/messages`, { text: 'run ls' });
    await waitFor(() => session.pending.length === 1);
    const route = `/api/approvals/${session.pending[0].id}`;

    for (const allow of ['yes', 1, null, undefined]) {
      const response = await api('POST', route, { allow });
      assert.equal(response.status, 400, String(allow));
      assert.deepEqual(response.body, { error: 'Choose Allow or Deny.' });
    }
    assert.equal(session.pending.length, 1, 'still waiting after invalid answers');

    assert.deepEqual((await api('POST', route, { allow: false, reason: 'Not now' })).body, { ok: true });
    await waitFor(() => session.status === 'idle');
    assert.deepEqual(decisions, [{ behavior: 'deny', message: 'Not now' }]);
    assert.equal((await api('POST', route, { allow: true })).status, 409);
  });

  test('v2 decisions: validation, allow always with session-scoped suggestions, plan mode', async () => {
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    ];
    const decisions = [];
    turnScript = async function* ({ options }) {
      const signal = options.abortController.signal;
      decisions.push(await options.canUseTool('Bash', { command: 'npm test' }, { signal, toolUseID: 't1', suggestions, title: 'Claude wants to run npm test' }));
      decisions.push(await options.canUseTool('ExitPlanMode', { plan: '# Plan' }, { signal, toolUseID: 't2' }));
      yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };
    const session = await newSession({ model: 'opus', mode: 'plan' });
    await api('POST', `/api/sessions/${session.id}/messages`, { text: 'test it' });
    await waitFor(() => session.pending.length === 1);
    const [bash] = session.pending;
    assert.equal(bash.kind, 'permission');
    assert.equal(bash.title, 'Claude wants to run npm test');
    assert.deepEqual(bash.suggestions, suggestions);
    const pushed = (await api('GET', `/api/sessions/${session.id}`)).body.pending[0];
    assert.deepEqual(pushed, JSON.parse(JSON.stringify(bash)), 'the public session carries the full entry');

    const route = `/api/approvals/${bash.id}`;
    for (const [body, error] of [
      [{ decision: 'maybe' }, 'Choose Allow or Deny.'],
      [{ decision: 'allow', answers: 'Small fix' }, 'Answers must map each question to its answer.'],
      [{ decision: 'allow', reason: 7 }, 'The reason must be text.'],
      [{ decision: 'allow', mode: 'plan' }, 'Unknown mode'],
    ]) {
      const response = await api('POST', route, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(response.body, { error });
    }
    assert.equal(session.pending.length, 1, 'still waiting after invalid answers');

    assert.deepEqual((await api('POST', route, { decision: 'allowAlways' })).body, { ok: true });
    await waitFor(() => session.pending[0]?.kind === 'plan');
    assert.deepEqual(decisions[0].updatedPermissions, [{ ...suggestions[0], destination: 'session' }]);
    assert.deepEqual(session.allowRules, [{ toolName: 'Bash', ruleContent: 'npm test:*' }]);

    await api('POST', `/api/approvals/${session.pending[0].id}`, { decision: 'allow', mode: 'acceptEdits' });
    await waitFor(() => session.status === 'idle');
    assert.deepEqual(decisions[1], {
      behavior: 'allow',
      updatedInput: { plan: '# Plan' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    const after = (await api('GET', `/api/sessions/${session.id}`)).body;
    assert.equal(after.mode, 'acceptEdits');
    assert.deepEqual(after.allowRules, [{ toolName: 'Bash', ruleContent: 'npm test:*' }]);
  });
});

describe('files API', () => {
  test('project browser stays inside the home root', async () => {
    const listing = await api('GET', '/api/projects');
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.items.map((item) => item.name), ['other', 'project']);
    assert.equal(listing.body.parent, null);
    assert.equal((await api('GET', '/api/projects?path=..')).status, 403);
  });

  test('file preview shows the session folder, and files elsewhere by their absolute path', async () => {
    const session = await newSession();
    const files = (value) => api('GET', `/api/sessions/${session.id}/files?path=${encodeURIComponent(value)}`);

    const notes = await files('notes.txt');
    assert.equal(notes.status, 200);
    assert.deepEqual(notes.body, { path: 'notes.txt', directory: false, content: 'hello' });

    // Outside the project (a report an agent wrote under /data): shown by its absolute path.
    const secretPath = fs.realpathSync(path.join(homeRoot, 'other', 'secret.txt'));
    for (const value of ['../other/secret.txt', secretPath]) {
      const response = await files(value);
      assert.equal(response.status, 200, value);
      assert.deepEqual(response.body, { path: secretPath, directory: false, content: 'secret' }, value);
    }
    const parent = await files('..');
    assert.equal(parent.body.path, fs.realpathSync(homeRoot));
    assert.ok(parent.body.items.every((item) => path.isAbsolute(item.path) || !item.path.startsWith('..')));
    assert.equal((await files('/no/such/file')).status, 404);
  });

  test('git changes report the error shape outside a repository and a diff inside one', async () => {
    const plain = await newSession();
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base; // never discover a repository above the temp dir
    try {
      const noRepo = await api('GET', `/api/sessions/${plain.id}/changes`);
      assert.equal(noRepo.status, 200);
      assert.deepEqual(noRepo.body, { diff: '', status: '', branch: '', files: [], error: 'This folder is not a Git repository.' });

      const repo = path.join(homeRoot, 'repo');
      fs.mkdirSync(repo);
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n');
      fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=secret\n');
      fs.symlinkSync(path.join(homeRoot, 'other', 'secret.txt'), path.join(repo, 'outside-link'));
      const session = await newSession({ cwd: 'repo' });
      const changes = await api('GET', `/api/sessions/${session.id}/changes`);
      assert.equal(changes.status, 200);
      assert.equal(changes.body.branch, 'main');
      assert.match(changes.body.status, /\?\? new\.txt/);
      assert.match(changes.body.diff, /\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+fresh\n/);
      assert.doesNotMatch(changes.body.diff, /TOKEN|\.env|outside-link|secret/);
      // Per-file list (contract): env files are left out; the link is listed by name only.
      assert.deepEqual(changes.body.files, [
        { path: 'new.txt', status: 'untracked', adds: 1, dels: 0 },
        { path: 'outside-link', status: 'untracked', adds: 0, dels: 0 },
      ]);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });
});

describe('events API', () => {
  test('the SSE stream sends ready, then session updates, and forgets clients that disconnect', async () => {
    const listenersBefore = events.listeners.size;
    const req = http.request({ socketPath, path: '/api/events', headers: { ...authed, 'Accept-Encoding': 'br, gzip' } });
    req.end();
    const [res] = await once(req, 'response');
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    assert.equal(res.headers['content-encoding'], undefined, 'the stream is never compressed (or buffered)');
    res.setEncoding('utf8');
    let received = '';
    const readUntil = (marker) =>
      new Promise((resolve) => {
        const check = () => {
          if (received.includes(marker)) {
            res.off('data', onData);
            resolve();
          }
        };
        const onData = (chunk) => {
          received += chunk;
          check();
        };
        res.on('data', onData);
        check();
      });

    await readUntil('event: ready');
    assert.equal(events.listeners.size, listenersBefore + 1);
    const session = await newSession();
    await readUntil(session.id);
    // Created: a delta with the list form, the first one for this session.
    const deltas = () => received.split('\n\n').filter((frame) => frame.startsWith('event: delta\n')).map((frame) => JSON.parse(frame.split('data: ')[1]));
    const created = deltas().find((delta) => delta.id === session.id);
    assert.equal(created.base, null);
    assert.equal(created.fields.title, 'New session');
    assert.equal(created.fields.messages, undefined);

    // Nothing changed since: a GET is at the revision of the last delta.
    assert.equal((await api('GET', `/api/sessions/${session.id}`)).body.rev, created.rev);
    // A GET that sees a change not broadcast yet is at a new revision, which it broadcasts.
    session.messages.push({ id: 'm-old', role: 'user', text: 'history', at: Date.now() });
    const { rev } = (await api('GET', `/api/sessions/${session.id}`)).body;
    await readUntil('history');
    const seen = deltas().at(-1);
    assert.deepEqual([seen.rev, seen.base], [rev, created.rev]);
    assert.deepEqual(seen.messages.map((m) => m.id), ['m-old']);

    // Later changes send only what changed since that revision.
    const reply = await api('PATCH', `/api/sessions/${session.id}`, { title: 'Patched title' });
    assert.equal(reply.status, 200);
    await readUntil('Patched title');
    const patched = deltas().at(-1);
    assert.equal(patched.base, rev);
    assert.equal(patched.fields.title, 'Patched title');
    assert.equal(patched.messages, undefined, 'not the history');
    assert.equal(reply.body.rev, patched.rev, 'the PATCH reply (list form) carries its revision');
    assert.equal(reply.body.messages, undefined);
    session.messages.push({ id: 'm-new', role: 'user', text: 'one more', at: Date.now() });
    events.flush(session);
    await readUntil('one more');
    const next = deltas().at(-1);
    assert.equal(next.base, patched.rev);
    assert.deepEqual(next.messages.map((m) => m.id), ['m-new']);
    assert.equal(next.count, 2);
    assert.equal(next.ids, undefined);

    req.destroy();
    await waitFor(() => events.listeners.size === listenersBefore);
  });
});

describe('session import', () => {
  test('lists candidates per source and refuses unknown sources', async () => {
    const claude = await api('GET', '/api/import/claude');
    assert.equal(claude.status, 200);
    const candidate = claude.body.items.find((item) => item.id === CLAUDE_SESSION);
    assert.equal(candidate.title, 'Fix the add bug');
    assert.equal(candidate.cwd, path.join(homeRoot, 'project'));
    assert.equal(candidate.importable, true);
    assert.equal(claude.body.total, claude.body.items.length);
    const codex = await api('GET', '/api/import/codex');
    assert.equal(codex.status, 200);
    assert.equal(codex.body.items[0].id, CODEX_SESSION);
    const unknown = await api('GET', '/api/import/cursor');
    assert.equal(unknown.status, 400);
    assert.equal(typeof unknown.body.error, 'string');
    assert.equal((await api('GET', '/api/import/claude', undefined, {})).status, 403);
  });

  test('imports picked sessions as idle sessions with their history', async () => {
    const body = { source: 'codex', ids: [CODEX_SESSION, 'missing'], model: 'luna' };
    assert.equal((await api('POST', '/api/import', body, { ...authed, 'Content-Type': 'application/json' })).status, 403, 'writes need the origin');
    const response = await api('POST', '/api/import', body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.errors, [{ id: 'missing', error: 'This session was not found.' }]);
    const [imported] = response.body.sessions;
    assert.equal(imported.title, 'Write the README');
    assert.equal(imported.model, 'luna');
    assert.equal(imported.status, 'idle');
    assert.equal(imported.source.kind, 'codex');
    assert.equal(imported.source.id, CODEX_SESSION);
    assert.equal(imported.handoff, undefined);
    assert.equal(imported.messages, undefined, 'the list form');

    const full = await api('GET', `/api/sessions/${imported.id}`);
    assert.equal(full.body.messages[0].text, 'Add a README');
    assert.equal(full.body.messages[0].imported, true);
    assert.ok((await api('GET', '/api/sessions')).body.some((session) => session.id === imported.id));
    const listed = await api('GET', '/api/import/codex');
    assert.equal(listed.body.items.find((item) => item.id === CODEX_SESSION).importedAs, imported.id);

    for (const bad of [{ source: 'codex' }, { source: 'codex', ids: 'x' }, { source: 'nope', ids: ['x'] }, { source: 'codex', ids: ['x'], model: 'gpt-2' }]) {
      assert.equal((await api('POST', '/api/import', bad)).status, 400, JSON.stringify(bad));
    }
    store.sessions.delete(imported.id);
  });
});

describe('compression', () => {
  // Raw bytes and headers (the shared helper decodes text).
  function fetchRaw(route, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: route, headers: { ...authed, ...headers } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('large JSON responses are sent with br or gzip when accepted; small ones and others as is', async () => {
    const session = await newSession();
    for (let i = 0; i < 40; i++) session.messages.push({ id: 'c' + i, role: 'assistant', text: 'A long reply that compresses well. '.repeat(20), at: Date.now() });
    const route = `/api/sessions/${session.id}`;
    const plain = await fetchRaw(route);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.headers.vary, /Accept-Encoding/);
    const expected = JSON.parse(plain.body.toString('utf8'));
    assert.equal(expected.messages.length, 40);

    const br = await fetchRaw(route, { 'Accept-Encoding': 'gzip, deflate, br, zstd' });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(br.headers['content-type'], /^application\/json/);
    assert.equal(Number(br.headers['content-length']), br.body.length);
    assert.ok(br.body.length * 4 < plain.body.length, `${br.body.length} vs ${plain.body.length} bytes`);
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body).toString('utf8')), expected);

    const gz = await fetchRaw(route, { 'Accept-Encoding': 'gzip, br;q=0' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body).toString('utf8')), expected);

    assert.equal((await fetchRaw(route, { 'Accept-Encoding': 'identity' })).headers['content-encoding'], undefined);
    const small = await fetchRaw(`/api/sessions/${session.id}/messages/c0`, { 'Accept-Encoding': 'br' });
    assert.equal(small.headers['content-encoding'], undefined, 'under 1 KB stays plain');
    assert.equal(JSON.parse(small.body.toString('utf8')).id, 'c0');
    store.sessions.delete(session.id);
  });
});

describe('model settings API', () => {
  test('lists each model\'s context range and sets, refuses and resets a limit', async () => {
    const before = (await api('GET', '/api/model-settings')).body.models.find((m) => m.id === 'kimi');
    assert.deepEqual(before, { id: 'kimi', name: 'Kimi K3', provider: 'SGLang', contextWindow: 524_288, maxContext: 524_288, defaultContext: 524_288, minContext: 100_000, custom: false });
    const set = await api('PUT', '/api/model-settings', { context: { kimi: 200_000 } });
    assert.equal(set.status, 200);
    assert.equal(set.body.models.find((m) => m.id === 'kimi').contextWindow, 200_000);
    assert.equal((await api('GET', '/api/info')).body.models.find((m) => m.id === 'kimi').contextWindow, 200_000);
    const refused = await api('PUT', '/api/model-settings', { context: { kimi: 99_999 } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /from 100000 to 524288/);
    assert.equal((await api('PUT', '/api/model-settings', { context: { kimi: null } })).body.models.find((m) => m.id === 'kimi').contextWindow, 524_288);
  });
});

describe('starting Claude Code ahead of the first message', () => {
  test('a prepared new chat is unlisted until the create adopts it; other settings get a fresh session', async () => {
    const cwd = path.join(homeRoot, 'project');
    const spawns = fakeCli.spawns;
    const prepared = await api('POST', '/api/sessions/prepare', { cwd, model: 'luna', mode: 'bypassPermissions' });
    assert.equal(prepared.status, 200);
    const { prepareId } = prepared.body;
    assert.ok(prepareId);
    await waitFor(() => fakeCli.spawns === spawns + 1);
    assert.ok(!(await api('GET', '/api/sessions')).body.some((s) => s.id === prepareId), 'not listed');

    const created = await api('POST', '/api/sessions', { cwd, model: 'luna', mode: 'bypassPermissions', prepareId });
    assert.equal(created.body.id, prepareId);
    assert.equal(created.body.prepared, undefined);
    assert.ok((await api('GET', '/api/sessions')).body.some((s) => s.id === prepareId));

    const again = (await api('POST', '/api/sessions/prepare', { cwd, model: 'luna', mode: 'bypassPermissions' })).body.prepareId;
    const other = await api('POST', '/api/sessions', { cwd, model: 'astra', mode: 'bypassPermissions', prepareId: again });
    assert.notEqual(other.body.id, again, 'a different model: a new session');
    assert.equal((await api('POST', '/api/sessions/prepare', { cwd, model: 'nope' })).status, 400);
  });

  test('warm starts an open session\'s process', async () => {
    const session = (await api('POST', '/api/sessions', { cwd: path.join(homeRoot, 'project'), model: 'astra', mode: 'bypassPermissions' })).body;
    const spawns = fakeCli.spawns;
    assert.deepEqual((await api('POST', `/api/sessions/${session.id}/warm`, {})).body, { started: true });
    await waitFor(() => fakeCli.spawns === spawns + 1);
    assert.deepEqual((await api('POST', `/api/sessions/${session.id}/warm`, {})).body, { started: false });
    assert.equal((await api('POST', '/api/sessions/nope/warm', {})).status, 404);
  });
});
