// The settings routes over a private unix socket, with a throwaway Claude config folder
// and projects, and fake Claude Code processes (never the real ~/.claude or a model).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { projectSlug } from '../server/agent-transcript.mjs';
import { createApp } from '../server/app.mjs';
import { REPO_DIR } from '../server/config.mjs';
import { createEvents } from '../server/events.mjs';
import { createRunner } from '../server/runner.mjs';
import { listenOnSocket } from '../server/socket.mjs';
import { createStore, publicSession } from '../server/store.mjs';
import { createFakeCli, successResult } from './fake-cli.mjs';

const OWNER = 'owner@example.com';
const HOST = 'workbench.example:18544';
let base;
let homeRoot;
let configDir;
let alpha;
let beta;
let gamma;
let server;
let socketPath;
let store;
let runner;
let fakeCli;
// What each fake Claude Code process does for a user message: finish at once, unless a test says otherwise.
async function* finishAtOnce() {
  yield successResult();
}
let turnScript = finishAtOnce;

before(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-settings-api-')));
  homeRoot = path.join(base, 'home');
  configDir = path.join(base, 'claude-config');
  alpha = path.join(homeRoot, 'alpha');
  beta = path.join(homeRoot, 'beta');
  gamma = path.join(homeRoot, 'gamma');
  for (const dir of [alpha, beta, gamma, configDir, path.join(base, 'outside')]) fs.mkdirSync(dir, { recursive: true });
  const config = {
    owner: OWNER,
    publicHost: HOST,
    origin: 'https://' + HOST,
    homeRoot,
    repoDir: REPO_DIR,
    publicDir: path.join(REPO_DIR, 'public'),
    dataDir: path.join(base, 'data'),
    claudeConfigDir: configDir,
    gatewayUrl: 'http://127.0.0.1:9',
    claudeExecutable: '/nonexistent/claude',
    dashboardUrl: 'https://dashboard.example/',
  };
  store = createStore({ dataDir: config.dataDir });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  fakeCli = createFakeCli((turn) => turnScript(turn));
  runner = createRunner({ config, events, query: fakeCli.query, log: () => {} });
  server = await listenOnSocket(createApp({ config, store, events, runner }), (socketPath = path.join(base, 'web.sock')));
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
      res.on('end', () => resolve({ status: res.statusCode, body: res.headers['content-type']?.startsWith('application/json') && text ? JSON.parse(text) : text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const api = (method, route, body) => request(method, route, { headers: body === undefined && method === 'GET' ? authed : writeHeaders, body });
const q = (cwd) => `cwd=${encodeURIComponent(cwd)}`;

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A session in `cwd` whose (fake) Claude Code process is running and idle. */
async function liveSession(cwd) {
  const created = await api('POST', '/api/sessions', { cwd, model: 'astra', mode: 'default' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const session = store.get(created.body.id);
  assert.equal((await api('POST', `/api/sessions/${session.id}/messages`, { text: 'hello' })).status, 200);
  await waitFor(() => session.status === 'idle' && runner.pool.get(session.id));
  return session;
}

const settingsPath = (scope, id = 'settings') => `/api/settings/files/${scope}/${id}`;

describe('access', () => {
  test('the owner and the public origin are required, like every other route', async () => {
    assert.equal((await request('GET', '/api/settings/files', { headers: {} })).status, 403);
    assert.equal((await request('PUT', settingsPath('user', 'claude-md'), { headers: authed, body: { content: 'x', version: null } })).status, 403);
    assert.equal(fs.existsSync(path.join(configDir, 'CLAUDE.md')), false);
  });

  test('project folders: required where needed, inside the home directory, and existing', async () => {
    assert.equal((await api('GET', settingsPath('project'))).status, 400);
    assert.equal((await api('GET', `${settingsPath('project')}?${q(path.join(base, 'outside'))}`)).status, 403);
    assert.equal((await api('GET', `${settingsPath('project')}?${q(path.join(homeRoot, 'missing'))}`)).status, 400);
    assert.equal((await api('GET', `${settingsPath('project')}?cwd=a&cwd=b`)).status, 400);
    assert.equal((await api('GET', `/api/settings/memory`)).status, 400);
    assert.equal((await api('GET', `${settingsPath('user')}`)).status, 200, 'the user scope needs no folder');
    assert.equal((await api('GET', `/api/settings/files/memory/settings?${q(alpha)}`)).status, 404);
    assert.equal((await api('GET', `/api/settings/files/user/..%2Fsettings?${q(alpha)}`)).status, 404);
    assert.equal((await api('GET', `/api/settings/files/root/settings?${q(alpha)}`)).status, 404);
  });
});

describe('files', () => {
  test('lists every editable file, reads one with its version and parsed view, and writes it back', async () => {
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, model: 'opus' }, null, 2) + '\n');
    const list = await api('GET', `/api/settings/files?${q(alpha)}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.configDir, configDir);
    assert.deepEqual(list.body.files.map((file) => `${file.scope}/${file.id}:${file.exists}`), [
      'user/settings:true',
      'user/claude-md:false',
      'project/settings:false',
      'project/claude-md:false',
      'project/dot-claude-md:false',
      'local/settings:false',
      'local/claude-md:false',
    ]);
    assert.equal(list.body.files[0].content, undefined);

    const read = await api('GET', settingsPath('user'));
    assert.equal(read.body.parsed.permissions.allow[0], 'Bash(ls)');
    const put = await api('PUT', settingsPath('user'), { content: '{\n  "model": "sonnet"\n}\n', version: read.body.version });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.changed, true);
    assert.equal(put.body.restartsPending, 0, 'no live process yet');
    assert.equal(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'), '{\n  "model": "sonnet"\n}\n');
  });

  test('a stale version answers 409 with the current file; bad JSON answers 400 with the parse error', async () => {
    const created = await api('PUT', settingsPath('project', 'claude-md'), { cwd: alpha, content: 'v1\n', version: null });
    assert.equal(created.status, 200);
    const stale = await api('PUT', settingsPath('project', 'claude-md'), { cwd: alpha, content: 'mine\n', version: 'f00' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.conflict, true);
    assert.match(stale.body.error, /changed on disk/);
    assert.equal(stale.body.current.content, 'v1\n');
    assert.equal(stale.body.current.version, created.body.version);
    assert.equal(fs.readFileSync(path.join(alpha, 'CLAUDE.md'), 'utf8'), 'v1\n');

    const bad = await api('PUT', settingsPath('local'), { cwd: alpha, content: '{"permissions": ', version: null });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^Invalid JSON: /);
    assert.equal(fs.existsSync(path.join(alpha, '.claude')), false);
    assert.equal((await api('PUT', settingsPath('local'), { cwd: alpha, content: '{}' })).status, 400, 'the version is required');
    assert.equal((await api('PUT', settingsPath('local'), { cwd: alpha, content: '{}', version: 3 })).status, 400);
    assert.equal((await api('PUT', settingsPath('local'), { cwd: alpha, version: null })).status, 400, 'content is required');
  });

  test('PATCH edits permissions and hooks structurally and reports a settings file that is not valid JSON', async () => {
    const original = '{\n  "env": {"A": "1"},\n  "permissions": {"defaultMode": "plan"}\n}\n';
    fs.mkdirSync(path.join(beta, '.claude'));
    fs.writeFileSync(path.join(beta, '.claude', 'settings.json'), original);
    const { body: file } = await api('GET', `${settingsPath('project')}?${q(beta)}`);
    const patched = await api('PATCH', settingsPath('project'), { cwd: beta, version: file.version, permissions: { allow: ['Bash(npm test:*)'], ask: [], deny: ['Read(.env)'] } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body.parsed.permissions, { allow: ['Bash(npm test:*)'], ask: [], deny: ['Read(.env)'], defaultMode: 'plan', additionalDirectories: [] });
    assert.equal(fs.readFileSync(path.join(beta, '.claude', 'settings.json'), 'utf8').startsWith('{\n  "env": {"A": "1"},'), true);

    assert.equal((await api('PATCH', settingsPath('project'), { cwd: beta, version: file.version, permissions: { allow: [] } })).status, 409);
    assert.equal((await api('PATCH', settingsPath('project'), { cwd: beta, version: patched.body.version })).status, 400, 'something to change is required');
    const invalid = await api('PATCH', settingsPath('project'), { cwd: beta, version: patched.body.version, permissions: { allow: ['not a rule'] } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /permissions\.allow/);
    const hooks = await api('PATCH', settingsPath('project'), { cwd: beta, version: patched.body.version, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } });
    assert.equal(hooks.status, 200);
    assert.equal(hooks.body.parsed.hooks.Stop[0].hooks[0].command, 'echo done');
    assert.equal((await api('PATCH', settingsPath('project'), { cwd: beta, version: hooks.body.version, hooks: { Stop: 'nope' } })).status, 400);
  });
});

describe('restarting live processes', () => {
  test('user scope marks every session\'s process, project and local scope only that project\'s, an unchanged write none', async () => {
    const a1 = await liveSession(alpha);
    const a2 = await liveSession(alpha);
    const b1 = await liveSession(beta);
    const spawned = fakeCli.spawns;
    const ended = (session) => fakeCli.processes.some((proc) => proc.sessionId === store.get(session.id).sdkSessionId && proc.ended);

    // Local scope: alpha's two.
    const local = await api('PATCH', settingsPath('local'), { cwd: alpha, version: null, permissions: { allow: ['Bash(touch x)'] } });
    assert.equal(local.body.restartsPending, 2);
    await waitFor(() => ended(a1) && ended(a2));
    assert.equal(ended(b1), false, 'beta is another project');
    assert.equal(runner.pool.get(a1.id), undefined, 'an idle process restarts at once: it is gone until the next turn');

    // Same content again: nothing changes, nothing restarts.
    const again = await api('PATCH', settingsPath('local'), { cwd: alpha, version: local.body.version, permissions: { allow: ['Bash(touch x)'] } });
    assert.equal(again.body.changed, false);
    assert.equal(again.body.restartsPending, 0);

    // The next message resumes the same conversation in a new process.
    assert.equal((await api('POST', `/api/sessions/${a1.id}/messages`, { text: 'again' })).status, 200);
    await waitFor(() => fakeCli.spawns === spawned + 1 && a1.status === 'idle');
    assert.equal(fakeCli.last.options.resume, a1.sdkSessionId);

    // User scope: everyone with a live process (a1 again, and beta's).
    const user = await api('PUT', settingsPath('user', 'claude-md'), { content: 'be brief\n', version: null });
    assert.equal(user.body.restartsPending, 2);
    await waitFor(() => !runner.pool.get(a1.id) && !runner.pool.get(b1.id));
  });

  test('project CLAUDE.md files restart that project\'s processes; memory only when its index changes', async () => {
    const a = await liveSession(alpha);
    const b = await liveSession(beta);
    const put = await api('PUT', settingsPath('project', 'dot-claude-md'), { cwd: beta, content: 'rules\n', version: null });
    assert.equal(put.body.restartsPending, 1);
    await waitFor(() => !runner.pool.get(b.id));
    assert.ok(runner.pool.get(a.id), 'alpha keeps its process');

    // Creating a memory changes the index; editing one does not.
    const memory = `---\nname: note\ndescription: "A note"\nmetadata: \n  type: project\n---\nBody\n`;
    const created = await api('PUT', `/api/settings/memory/note.md?`, { cwd: alpha, content: memory, version: null });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.restartsPending, 1);
    await waitFor(() => !runner.pool.get(a.id));
    const c = await liveSession(alpha);
    const edited = await api('PUT', '/api/settings/memory/note.md', { cwd: alpha, content: memory + 'More\n', version: created.body.version });
    assert.equal(edited.body.changed, true);
    assert.equal(edited.body.restartsPending, 0);
    assert.ok(runner.pool.get(c.id));
    await api('PATCH', `/api/sessions/${c.id}`, { removed: true });
  });

  test('a busy session\'s process restarts only once its turn is over', async () => {
    const session = await liveSession(alpha);
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    turnScript = async function* () {
      await hold;
      yield successResult();
    };
    assert.equal((await api('POST', `/api/sessions/${session.id}/messages`, { text: 'work' })).status, 200);
    await waitFor(() => session.status === 'running');
    const proc = fakeCli.processes.find((candidate) => candidate.sessionId === session.sdkSessionId);

    const put = await api('PUT', settingsPath('project', 'claude-md'), { cwd: alpha, content: 'busy rules\n', version: null }).then(async (response) =>
      response.status === 200 ? response : api('PUT', settingsPath('project', 'claude-md'), { cwd: alpha, content: 'busy rules\n', version: response.body.current.version }),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.restartsPending, 1);
    assert.equal(proc.ended, false, 'a running turn is not cut short');
    release();
    await waitFor(() => proc.ended);
    turnScript = finishAtOnce;
    await api('PATCH', `/api/sessions/${session.id}`, { removed: true });
  });
});

describe('memory', () => {
  const note = (name) => `---\nname: ${name}\ndescription: "About ${name}"\nmetadata: \n  type: reference\n---\n\nText of ${name}.\n`;

  test('create, list, read, edit and delete keep MEMORY.md in step', async () => {
    const dir = path.join(configDir, 'projects', projectSlug(beta), 'memory');
    const empty = await api('GET', `/api/settings/memory?${q(beta)}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.exists, false);

    const first = await api('PUT', '/api/settings/memory/first.md', { cwd: beta, content: note('first'), version: null });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.frontmatter, { name: 'first', description: 'About first', type: 'reference' });
    const second = await api('PUT', '/api/settings/memory/second.md', { cwd: beta, content: note('second'), version: null, index: { title: 'Second', hook: 'chosen hook' } });
    assert.equal(second.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), '# Memory Index\n\n- [first](first.md) — About first\n- [Second](second.md) — chosen hook\n');

    const list = await api('GET', `/api/settings/memory?${q(beta)}`);
    assert.deepEqual(list.body.files.map((file) => [file.name, file.frontmatter.type, file.inIndex]), [['first.md', 'reference', true], ['second.md', 'reference', true]]);
    assert.deepEqual(list.body.index.lines.map((line) => line.file), ['first.md', 'second.md']);
    assert.equal((await api('GET', `/api/settings/memory/second.md?${q(beta)}`)).body.body, '\nText of second.\n');

    const stale = await api('DELETE', `/api/settings/memory/first.md?${q(beta)}&version=nope`);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.name, 'first.md');
    const deleted = await api('DELETE', `/api/settings/memory/first.md?${q(beta)}&version=${first.body.version}`);
    assert.deepEqual([deleted.status, deleted.body.deleted], [200, true]);
    assert.equal(fs.existsSync(path.join(dir, 'first.md')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), '# Memory Index\n\n- [Second](second.md) — chosen hook\n');
    assert.equal((await api('DELETE', `/api/settings/memory/second.md?${q(beta)}`)).status, 400, 'the version is required');
    assert.equal((await api('DELETE', `/api/settings/memory/MEMORY.md?${q(beta)}&version=x`)).status, 400);
  });

  test('odd names and traversal never reach the file system', async () => {
    const seen = [];
    for (const name of ['..%2F..%2Fsettings.json', '..%2Fx.md', '.hidden.md', 'x.txt', '%2e%2e%2f.md', 'a%00.md', 'a%5Cb.md', encodeURIComponent('é.md'), 'x.md%2F']) {
      for (const [method, body] of [['GET'], ['PUT', { cwd: gamma, content: 'x', version: null }], ['DELETE']]) {
        const route = `/api/settings/memory/${name}${method === 'PUT' ? '' : `?${q(gamma)}&version=x`}`;
        const response = await api(method, route, body);
        seen.push(`${method} ${name} ${response.status}`);
        assert.ok([400, 404].includes(response.status), `${method} ${name} → ${response.status}`);
      }
    }
    assert.equal(fs.existsSync(path.join(configDir, 'projects', projectSlug(gamma))), false, 'nothing was created for any of them');
    assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), true, 'the user settings written earlier are untouched');
    assert.ok(seen.length > 20);
  });
});

describe('session grants (PATCH)', () => {
  test('grants can be removed one at a time, never added, and a removal restarts the process', async () => {
    const session = await liveSession(alpha);
    session.allowRules = [{ toolName: 'Bash', ruleContent: 'make' }, { toolName: 'Read' }, { toolName: 'Bash', ruleContent: 'npm test:*' }];
    session.allowDirectories = ['/d/one', '/d/two'];
    const route = `/api/sessions/${session.id}`;

    for (const body of [
      { allowRules: [{ toolName: 'Bash', ruleContent: 'rm -rf /' }] },
      { allowRules: [{ toolName: 'Read' }, { toolName: 'Write' }] },
      { allowRules: 'Read' },
      { allowRules: ['Read'] },
      { allowDirectories: ['/d/three'] },
      { allowDirectories: [7] },
    ]) {
      const response = await api('PATCH', route, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(response.body, { error: 'Grants can only be removed.' });
    }
    assert.equal(session.allowRules.length, 3, 'a refused patch changes nothing');
    assert.ok(runner.pool.get(session.id), 'and does not restart the process');

    const kept = await api('PATCH', route, { allowRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }], allowDirectories: ['/d/two'] });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual(session.allowRules, [{ toolName: 'Read' }, { toolName: 'Bash', ruleContent: 'npm test:*' }], 'in the session\'s own order');
    assert.deepEqual(session.allowDirectories, ['/d/two']);
    assert.deepEqual(kept.body.allowRules, session.allowRules);
    await waitFor(() => !runner.pool.get(session.id));

    assert.equal((await api('PATCH', route, { allowRules: [], allowDirectories: [] })).status, 200);
    assert.deepEqual([session.allowRules, session.allowDirectories], [[], []]);
    assert.equal((await api('PATCH', route, { allowRules: [{ toolName: 'Read' }] })).status, 400, 'nothing left to keep');
  });
});
