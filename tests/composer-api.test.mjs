// The composer endpoints over a private unix socket: uploads, attachments in turns,
// `@` file search and `/` commands. The SDK is faked; no CLI is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { createApp } from '../server/app.mjs';
import { findModel } from '../server/models.mjs';
import { LOCAL_COMMANDS } from '../server/commands.mjs';
import { REPO_DIR } from '../server/config.mjs';
import { createEvents } from '../server/events.mjs';
import { createRunner } from '../server/runner.mjs';
import { listenOnSocket } from '../server/socket.mjs';
import { createStore, publicSession } from '../server/store.mjs';
import { createUploads } from '../server/uploads.mjs';
import { createFakeCli } from './fake-cli.mjs';

const OWNER = 'owner@example.com';
const HOST = 'workbench.example:18544';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let base;
let homeRoot;
let dataDir;
let socketPath;
let server;
let store;
let runner;
const queryCalls = [];
const commandRequests = [];

/** The default fake turn: just finishes (the message is recorded per turn below). */
async function* recordingTurn() {
  yield { type: 'result', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
}
let turnScript = recordingTurn;

before(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-composer-')));
  homeRoot = path.join(base, 'home');
  fs.mkdirSync(path.join(homeRoot, 'project', 'server'), { recursive: true });
  fs.writeFileSync(path.join(homeRoot, 'project', 'server', 'runner.mjs'), '');
  fs.writeFileSync(path.join(homeRoot, 'project', '.env'), 'TOKEN=x');
  fs.mkdirSync(path.join(base, 'outside'));
  dataDir = path.join(base, 'data');
  const config = {
    owner: OWNER,
    publicHost: HOST,
    origin: 'https://' + HOST,
    homeRoot,
    repoDir: REPO_DIR,
    publicDir: path.join(REPO_DIR, 'public'),
    dataDir,
    gatewayUrl: 'http://127.0.0.1:9',
    claudeExecutable: '/nonexistent/claude',
    dashboardUrl: 'https://dashboard.example/',
  };
  store = createStore({ dataDir });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const uploads = createUploads({ dataDir });
  uploads.load();
  // Fake Claude Code processes: each user message is recorded, then runs turnScript.
  const fakeCli = createFakeCli((turn) => {
    const args = {
      prompt: turn.content,
      options: turn.options,
      turn,
      message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: turn.content } },
    };
    queryCalls.push(args);
    return turnScript(args);
  });
  runner = createRunner({ config, events, query: fakeCli.query, uploads, log: () => {} });
  const commands = {
    list: async (cwd) => {
      commandRequests.push(cwd);
      return [{ name: 'compact', description: 'Compact', argumentHint: '', source: 'sdk' }, ...LOCAL_COMMANDS];
    },
    agents: async (cwd) => {
      commandRequests.push(cwd);
      return [{ name: 'Explore', description: 'Read-only search', model: 'inherit' }];
    },
  };
  const app = createApp({ config, store, events, runner, uploads, commands });
  socketPath = path.join(base, 'web.sock');
  server = await listenOnSocket(app, socketPath);
});

afterEach(() => {
  turnScript = recordingTurn;
});

after(async () => {
  runner.shutdown();
  await waitFor(() => runner.pool.size === 0);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(base, { recursive: true, force: true });
});

const authed = { 'Tailscale-User-Login': OWNER };
const writeHeaders = { ...authed, Origin: 'https://' + HOST };

function request(method, route, { headers = authed, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const json = res.headers['content-type']?.startsWith('application/json');
        resolve({ status: res.statusCode, headers: res.headers, raw, body: json && raw.length ? JSON.parse(raw) : raw.toString() });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (route, body) =>
  request('POST', route, { headers: { ...writeHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function upload(scope, name, data, type) {
  const headers = { ...writeHeaders, ...(type ? { 'Content-Type': type } : {}) };
  return request('POST', `/api/uploads?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`, { headers, body: data });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function newSession(model = 'astra') {
  const response = await postJson('/api/sessions', { cwd: 'project', model });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return store.get(response.body.id);
}

describe('local images', () => {
  test('raster images anywhere are served by sniffed type; relative paths are the session\'s', async () => {
    fs.writeFileSync(path.join(base, 'outside', 'plot.png'), PNG);
    fs.writeFileSync(path.join(homeRoot, 'project', 'shot.dat'), PNG);
    fs.writeFileSync(path.join(base, 'outside', 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const outside = await request('GET', '/api/local-image?path=' + encodeURIComponent(path.join(base, 'outside', 'plot.png')));
    assert.equal(outside.status, 200);
    assert.equal(outside.headers['content-type'], 'image/png');
    assert.equal(outside.headers['content-disposition'].split(';')[0], 'inline');
    assert.deepEqual(outside.raw, PNG);

    const session = await newSession();
    const relative = await request('GET', `/api/local-image?path=shot.dat&session=${session.id}`);
    assert.equal(relative.status, 200);
    assert.equal(relative.headers['content-type'], 'image/png');
    assert.equal((await request('GET', '/api/local-image?path=~/project/shot.dat')).status, 200);

    assert.equal((await request('GET', '/api/local-image?path=shot.dat')).status, 400);
    assert.equal((await request('GET', '/api/local-image?path=' + encodeURIComponent(path.join(base, 'outside', 'page.svg')))).status, 415);
    assert.equal((await request('GET', '/api/local-image?path=' + encodeURIComponent(path.join(base, 'missing.png')))).status, 404);
    assert.equal((await request('GET', '/api/local-image?path=' + encodeURIComponent(base))).status, 404);
    assert.equal((await request('GET', '/api/local-image?path=' + encodeURIComponent(path.join(base, 'outside', 'plot.png')), { headers: {} })).status, 403);
    fs.rmSync(path.join(homeRoot, 'project', 'shot.dat')); // other tests list the project's files
  });
});

describe('uploads API', () => {
  test('drafts and session uploads return the Attachment shape; bytes come back with their type', async () => {
    const response = await upload('draft', 'notes.txt', 'hello', 'text/plain; charset=utf-8');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const attachment = response.body;
    assert.deepEqual(Object.keys(attachment).sort(), ['id', 'image', 'name', 'size', 'type', 'url']);
    assert.deepEqual({ ...attachment, id: undefined }, {
      id: undefined,
      name: 'notes.txt',
      type: 'text/plain',
      size: 5,
      image: false,
      url: `/api/uploads/${attachment.id}`,
    });

    const file = await request('GET', attachment.url);
    assert.equal(file.status, 200);
    assert.equal(file.raw.toString(), 'hello');
    assert.equal(file.headers['content-type'], 'application/octet-stream', 'non-images are opaque bytes');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.equal(file.headers['content-disposition'], `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`);

    const session = await newSession();
    const image = await upload(session.id, 'shot.png', PNG, 'image/png');
    assert.equal(image.body.image, true);
    const shown = await request('GET', image.body.url);
    assert.equal(shown.headers['content-type'], 'image/png');
    assert.match(shown.headers['content-disposition'], /^inline; /);
    assert.ok(shown.raw.equals(PNG));
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', session.id, `${image.body.id}-shot.png`)));
  });

  test('svg and html never display inline; names are sanitized; a missing Content-Type still uploads', async () => {
    const svg = await upload('draft', '../../evil.svg', '<svg onload="alert(1)"/>', 'image/svg+xml');
    assert.equal(svg.body.name, 'evil.svg');
    assert.equal(svg.body.image, false);
    const served = await request('GET', svg.body.url);
    assert.equal(served.headers['content-type'], 'application/octet-stream');
    assert.match(served.headers['content-disposition'], /^attachment; /);
    assert.match(served.headers['content-security-policy'], /default-src 'self'/);

    const html = await upload('draft', 'page.html', '<script>alert(1)</script>', 'text/html');
    assert.match((await request('GET', html.body.url)).headers['content-disposition'], /^attachment; /);

    const untyped = await upload('draft', 'data.bin', Buffer.from([1, 2, 3]));
    assert.equal(untyped.status, 200);
    assert.equal(untyped.body.type, 'application/octet-stream');
    assert.equal(untyped.body.size, 3);

    // A JSON file is stored as bytes, not parsed by the API's JSON body parser.
    const json = await upload('draft', 'data.json', '{"a": 1}', 'application/json');
    assert.equal(json.body.size, 8);
    assert.equal((await request('GET', json.body.url)).raw.toString(), '{"a": 1}');

    const unicode = await upload('draft', 'résumé "final".pdf', 'x', 'application/pdf');
    const header = (await request('GET', unicode.body.url)).headers['content-disposition'];
    assert.equal(header, `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`);
  });

  test('unknown scopes, traversal, wrong origin, unknown ids and oversized bodies are refused', async () => {
    for (const scope of ['', '../data', 'nope', 'draft/../x']) {
      const response = await upload(scope, 'a.txt', 'x', 'text/plain');
      assert.equal(response.status, 400, scope);
    }
    assert.ok(!fs.existsSync(path.join(base, 'x')));
    const noOrigin = await request('POST', '/api/uploads?scope=draft&name=a.txt', { headers: authed, body: 'x' });
    assert.equal(noOrigin.status, 403);
    const anonymous = await request('GET', '/api/uploads/whatever', { headers: {} });
    assert.equal(anonymous.status, 403);
    assert.equal((await request('GET', '/api/uploads/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await request('GET', '/api/uploads/..%2F..%2Fsecret')).status, 404);

    const boundary = await upload('draft', 'boundary.bin', Buffer.alloc(50 * 1024 * 1024), 'application/octet-stream');
    assert.equal(boundary.status, 200);
    assert.equal(boundary.body.size, 50 * 1024 * 1024);

    const big = await upload('draft', 'big.bin', Buffer.alloc(50 * 1024 * 1024 + 1), 'application/octet-stream');
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'Files can be at most 50 MB.');
  });
});

describe('attachments in turns', () => {
  test('a vision model gets image blocks and the file list; drafts move into the session folder', async () => {
    const image = (await upload('draft', 'shot.png', PNG, 'image/png')).body;
    const notes = (await upload('draft', 'notes.txt', 'hello', 'text/plain')).body;
    const session = await newSession('astra');
    const calls = queryCalls.length;
    const sent = await postJson(`/api/sessions/${session.id}/messages`, { text: 'What is this?', clientId: 'c1', attachments: [image.id, notes.id] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await waitFor(() => session.status === 'idle' && queryCalls.length > calls && queryCalls.at(-1).message);

    const sessionDir = path.join(dataDir, 'uploads', session.id);
    const imagePath = path.join(sessionDir, `${image.id}-shot.png`);
    const notesPath = path.join(sessionDir, `${notes.id}-notes.txt`);
    assert.ok(fs.existsSync(imagePath) && fs.existsSync(notesPath));
    assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'draft', `${image.id}-shot.png`)));

    const { message, options } = queryCalls.at(-1);
    assert.deepEqual(message, {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
          { type: 'text', text: `What is this?\n\nAttached files:\n- ${imagePath} (image, shown above)\n- ${notesPath}` },
        ],
      },
    });
    assert.equal(options.additionalDirectories, undefined, 'never a working directory');
    assert.ok(options.settings.permissions.allow.includes(`Read(/${sessionDir}/**)`));

    // The stored message carries the public attachments; no server paths leave the server.
    const user = (await request('GET', `/api/sessions/${session.id}`)).body.messages.find((m) => m.role === 'user');
    assert.equal(user.text, 'What is this?');
    assert.deepEqual(user.attachments, [image, notes]);
    assert.ok(!JSON.stringify(user).includes(dataDir));
    assert.equal(user.delivery, 'done');

    // A retried send with the same clientId is acknowledged without a second turn.
    const retried = await postJson(`/api/sessions/${session.id}/messages`, { text: 'What is this?', clientId: 'c1', attachments: [image.id] });
    assert.equal(retried.status, 200);
    assert.equal(session.messages.filter((m) => m.role === 'user').length, 1);
  });

  test('a text-only model gets one text block with every path; text-only turns stay a string', async () => {
    // No catalog model is text-only now: DeepSeek is made text-only for this test.
    const deepseek = findModel('deepseek');
    const vision = deepseek.vision;
    deepseek.vision = false;
    try {
      const image = (await upload('draft', 'shot.png', PNG, 'image/png')).body;
      const session = await newSession('deepseek');
      await postJson(`/api/sessions/${session.id}/messages`, { text: 'Describe it', attachments: [image.id] });
      await waitFor(() => session.status === 'idle' && queryCalls.at(-1).message);
      const imagePath = path.join(dataDir, 'uploads', session.id, `${image.id}-shot.png`);
      assert.deepEqual(queryCalls.at(-1).message.message.content, [
        { type: 'text', text: `Describe it\n\nAttached files:\n- ${imagePath}` },
      ]);

      const before = queryCalls.length;
      await postJson(`/api/sessions/${session.id}/messages`, { text: 'plain follow-up' });
      await waitFor(() => queryCalls.length > before && session.status === 'idle');
      assert.equal(queryCalls.at(-1).prompt, 'plain follow-up');
      // Earlier uploads stay readable without prompts on later turns.
      assert.ok(queryCalls.at(-1).options.settings.permissions.allow.includes(`Read(/${path.join(dataDir, 'uploads', session.id)}/**)`));
    } finally {
      deepseek.vision = vision;
    }
  });

  test('an attachment-only message is accepted and titles the session', async () => {
    const notes = (await upload('draft', 'report.csv', 'a,b', 'text/csv')).body;
    const session = await newSession('astra');
    const sent = await postJson(`/api/sessions/${session.id}/messages`, { text: '', attachments: [notes.id] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await waitFor(() => session.status === 'idle' && queryCalls.at(-1).message);
    assert.equal(session.title, 'report.csv');
    assert.match(queryCalls.at(-1).message.message.content[0].text, /^Attached files:\n- \/.*report\.csv$/);
  });

  test('bad attachment lists are refused before anything is queued', async () => {
    const session = await newSession('astra');
    const other = await newSession('astra');
    const foreign = (await upload(other.id, 'theirs.txt', 'x', 'text/plain')).body;
    const route = `/api/sessions/${session.id}/messages`;
    const eleven = Array.from({ length: 11 }, (_, index) => `id-${index}`);
    assert.equal((await postJson(route, { text: 'hi', attachments: eleven })).status, 400);
    assert.equal((await postJson(route, { text: 'hi', attachments: 'nope' })).status, 400);
    assert.equal((await postJson(route, { text: 'hi', attachments: ['missing'] })).status, 400);
    assert.equal((await postJson(route, { text: 'hi', attachments: [foreign.id] })).status, 400);
    assert.equal((await postJson(route, { text: '' })).status, 400);
    assert.equal(session.messages.length, 0);
    assert.equal(store.get(other.id).messages.length, 0);
  });

  test('an attachment turn and the plain turns after it share one Claude Code process', async () => {
    const notes = (await upload('draft', 'a.txt', 'a', 'text/plain')).body;
    const session = await newSession('astra');
    const before = queryCalls.length;
    await postJson(`/api/sessions/${session.id}/messages`, { text: 'go', attachments: [notes.id] });
    await waitFor(() => queryCalls.length === before + 1 && session.status === 'idle');
    await postJson(`/api/sessions/${session.id}/messages`, { text: 'and then' });
    await waitFor(() => queryCalls.length === before + 2 && session.status === 'idle');
    const [withFile, plain] = queryCalls.slice(before);
    assert.ok(Array.isArray(withFile.prompt));
    assert.equal(plain.prompt, 'and then');
    assert.equal(plain.turn.proc, withFile.turn.proc);
  });

  test('a stop interrupts an attachment turn and keeps the process', async () => {
    const notes = (await upload('draft', 'b.txt', 'b', 'text/plain')).body;
    turnScript = async function* ({ turn }) {
      await turn.interrupted;
    };
    const session = await newSession('astra');
    await postJson(`/api/sessions/${session.id}/messages`, { text: 'go', attachments: [notes.id] });
    await waitFor(() => runner.isRunning(session.id) && queryCalls.at(-1).prompt !== undefined && session.sdkSessionId);
    const { proc } = queryCalls.at(-1).turn;
    await postJson(`/api/sessions/${session.id}/stop`, {});
    await waitFor(() => session.status === 'idle');
    assert.deepEqual(proc.controls.filter(([name]) => name === 'interrupt'), [['interrupt', { cancelQueued: true }]]);
    assert.equal(proc.ended, false);
    assert.equal(session.messages.find((m) => m.role === 'user').delivery, 'stopped');
  });
});

describe('file search API', () => {
  test('ranks files of a folder or a session folder; hides .env; stays inside the home folder', async () => {
    const byCwd = await request('GET', `/api/complete/files?cwd=${encodeURIComponent(path.join(homeRoot, 'project'))}&q=runr`);
    assert.equal(byCwd.status, 200);
    assert.deepEqual(byCwd.body.items[0], { path: 'server/runner.mjs', directory: false });

    const session = await newSession();
    const bySession = await request('GET', `/api/complete/files?session=${session.id}&q=`);
    assert.deepEqual(bySession.body.items.map((item) => item.path).sort(), ['server', 'server/runner.mjs']);

    const outside = await request('GET', `/api/complete/files?cwd=${encodeURIComponent(path.join(base, 'outside'))}&q=a`);
    assert.equal(outside.status, 403);
    const escape = await request('GET', `/api/complete/files?cwd=${encodeURIComponent(homeRoot + '/../outside')}&q=a`);
    assert.equal(escape.status, 403);
    assert.equal((await request('GET', '/api/complete/files?q=a')).status, 400);
    assert.equal((await request('GET', '/api/complete/files?session=nope&q=a')).status, 404);
  });
});

describe('commands API', () => {
  test('lists commands for a confined folder; a bad folder gets the local commands without discovery', async () => {
    const response = await request('GET', `/api/commands?cwd=${encodeURIComponent(path.join(homeRoot, 'project'))}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.commands.map((command) => command.name), ['compact', 'clear', 'model', 'mode', 'effort', 'rename', 'fork', 'import', 'agents', 'settings', 'mcp', 'help']);
    assert.deepEqual(commandRequests, [path.join(homeRoot, 'project')]);

    const outside = await request('GET', `/api/commands?cwd=${encodeURIComponent(path.join(base, 'outside'))}`);
    assert.equal(outside.status, 200);
    assert.deepEqual(outside.body.commands, LOCAL_COMMANDS);
    assert.equal(commandRequests.length, 1);
  });

  test('lists Claude Code agents for a confined folder and the model agents always', async () => {
    commandRequests.length = 0;
    const response = await request('GET', `/api/agents?cwd=${encodeURIComponent(path.join(homeRoot, 'project'))}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.agents, [{ name: 'Explore', description: 'Read-only search', model: 'inherit' }]);
    assert.deepEqual(
      response.body.models.map((model) => model.id),
      ['opus', 'sonnet', 'fable', 'haiku', 'sol', 'terra', 'astra', 'luna', 'deepseek', 'grok', 'kimi', 'kimi31', 'argon'],
    );
    const sol = response.body.models.find((model) => model.id === 'sol');
    assert.equal(sol.name, 'GPT-6.1 Sol agent');
    assert.equal(sol.direct, false);
    assert.ok(sol.hint);

    const outside = await request('GET', `/api/agents?cwd=${encodeURIComponent(path.join(base, 'outside'))}`);
    assert.deepEqual(outside.body.agents, []);
    assert.equal(outside.body.models.length, 13);
    assert.equal(commandRequests.length, 1);
  });
});
