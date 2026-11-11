// Forking a session (fork.mjs): finding a message in Claude Code's transcript, the SDK's
// fork on a fixture Claude Code home, and the API route. Never touches the real ~/.claude.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../server/agent-transcript.mjs';
import { createApp } from '../server/app.mjs';
import { createClusters } from '../server/clusters.mjs';
import { REPO_DIR } from '../server/config.mjs';
import { createEvents } from '../server/events.mjs';
import { createForks, forkTitle, locatePrompt, promptEntry, readPrompts, samePrompt, sdkForker } from '../server/fork.mjs';
import { createRunner } from '../server/runner.mjs';
import { listenOnSocket } from '../server/socket.mjs';
import { createStore, publicSession } from '../server/store.mjs';
import { createUploads } from '../server/uploads.mjs';
import { createFakeCli } from './fake-cli.mjs';

const uuid = () => crypto.randomUUID();
const FAKE_SSH = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url));
const user = (text, extra = {}) => ({ id: uuid(), role: 'user', text, at: 1, delivery: 'done', ...extra });
const prompt = (text, extra = {}) => ({ uuid: uuid(), parentUuid: uuid(), text, ...extra });

describe('finding a message in the transcript', () => {
  test('prompt entries: user text, text blocks, mid-turn messages; not tool results or injected text', () => {
    const base = { uuid: 'u', parentUuid: 'p' };
    assert.deepEqual(promptEntry({ ...base, type: 'user', message: { content: 'hi' } }), { uuid: 'u', parentUuid: 'p', text: 'hi' });
    const blocks = [{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
    assert.equal(promptEntry({ ...base, type: 'user', message: { content: blocks } }).text, 'a\n\nb');
    assert.equal(promptEntry({ ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }), null);
    assert.equal(promptEntry({ ...base, type: 'user', isMeta: true, message: { content: 'x' } }), null);
    assert.equal(promptEntry({ ...base, type: 'user', isCompactSummary: true, message: { content: 'x' } }), null);
    assert.equal(promptEntry({ ...base, type: 'user', isSidechain: true, message: { content: 'x' } }), null);
    const queued = { type: 'queued_command', prompt: 'steer', source_uuid: 's', commandMode: 'prompt' };
    assert.deepEqual(promptEntry({ ...base, type: 'attachment', attachment: queued }), { uuid: 'u', parentUuid: 'p', text: 'steer', sourceUuid: 's' });
    assert.equal(promptEntry({ ...base, type: 'attachment', attachment: { ...queued, commandMode: 'task-notification' } }), null);
    assert.equal(promptEntry({ ...base, type: 'attachment', attachment: { type: 'todo_reminder' } }), null);
  });

  test('a message matches its prompt by the uuid it was sent with, else by text', () => {
    const sent = user('hello', { sdkUuid: 'abc' });
    assert.ok(samePrompt(prompt('other', { uuid: 'abc' }), sent));
    assert.ok(samePrompt(prompt('other', { sourceUuid: 'abc' }), sent));
    assert.ok(!samePrompt(prompt('hello'), sent), 'a recorded uuid is the only match');
    assert.ok(samePrompt(prompt('hello'), user('hello')));
    assert.ok(samePrompt(prompt('Note: switched models.\n\nhello'), user('hello')), 'model-switch note in front');
    assert.ok(samePrompt(prompt('hello\n\nAttached files:\n- /x/a.png (image, shown above)'), user('hello')));
    assert.ok(samePrompt(prompt('Attached files:\n- /x/a.png'), user('')), 'attachment-only message');
    assert.ok(samePrompt(prompt('first\nsecond'), user('first')), 'messages taken together: the first matches');
    assert.ok(samePrompt(prompt('<command-name>/compact</command-name>\n<command-args></command-args>'), user('/compact')));
    assert.ok(!samePrompt(prompt('hello there'), user('hello')));
  });

  test('alignment skips messages Claude Code never got instead of drifting', () => {
    // "continue" was stopped before Claude Code read it, then sent again.
    const messages = [user('start'), user('continue', { delivery: 'stopped' }), user('continue'), user('next')];
    const prompts = [prompt('start'), prompt('continue'), prompt('next')];
    assert.equal(locatePrompt(prompts, messages, 3), prompts[2]);
    assert.equal(locatePrompt(prompts, messages, 0), prompts[0]);
    // Imported messages from before a compaction are not in the transcript at all.
    const imported = [user('old', { imported: true }), user('older', { imported: true }), user('new')];
    assert.equal(locatePrompt([prompt('new')], imported, 0), null);
    assert.equal(locatePrompt([prompt('new')], imported, 2).text, 'new');
    // Queued and nested messages are never fork points.
    assert.equal(locatePrompt(prompts, [user('start', { delivery: 'queued' })], 0), null);
  });

  test('fork titles', () => {
    assert.equal(forkTitle('Fix the bug'), 'Fix the bug (fork)');
    assert.equal(forkTitle('Fix the bug (fork)'), 'Fix the bug (fork)');
    assert.equal(forkTitle('x'.repeat(120)).length, 100);
    assert.ok(forkTitle('x'.repeat(120)).endsWith(' (fork)'));
  });
});

// A Claude Code transcript like 2.1.290 writes: two turns, the second with a message the
// user sent mid-turn (a queued_command attachment), then a third turn.
function writeTranscript(home, cwd, ids) {
  const sessionId = uuid();
  const dir = path.join(home, 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const common = { isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.290' };
  let time = Date.parse('2026-10-12T10:00:00Z');
  const entry = (fields) => ({ ...common, timestamp: new Date((time += 1000)).toISOString(), ...fields });
  const said = (id, parentUuid, text) => entry({ type: 'assistant', uuid: id, parentUuid, message: { id: 'msg_' + id, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } });
  const lines = [
    entry({ type: 'user', uuid: ids.first, parentUuid: null, message: { role: 'user', content: 'first question' } }),
    said(ids.a1, ids.first, 'first answer'),
    entry({ type: 'user', uuid: ids.second, parentUuid: ids.a1, message: { role: 'user', content: 'second question' } }),
    entry({ type: 'assistant', uuid: ids.a2, parentUuid: ids.second, message: { id: 'msg_a2', role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } }),
    entry({ type: 'user', uuid: ids.r2, parentUuid: ids.a2, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
    entry({ type: 'attachment', uuid: ids.steer, parentUuid: ids.r2, attachment: { type: 'queued_command', prompt: 'also this', source_uuid: ids.steerSent, commandMode: 'prompt' } }),
    said(ids.a3, ids.steer, 'second answer'),
    entry({ type: 'user', uuid: ids.third, parentUuid: ids.a3, message: { role: 'user', content: 'third question' } }),
    said(ids.a4, ids.third, 'third answer'),
  ];
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { sessionId, file };
}

function readEntries(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const OWNER = 'owner@example.com';
const HOST = 'workbench.example:18544';

describe('forking sessions', () => {
  let base;
  let home;
  let cwd;
  let store;
  let events;
  let runner;
  let uploads;
  let server;
  let socketPath;
  let ids;
  let transcript;
  let remoteTranscript;
  let remoteProjects;
  let clusters;
  let remoteHome;
  let savedSsh;
  let fake;
  const sdkCalls = [];
  // What the fake Claude Code answers a rewindFiles with (null: its default).
  let rewindAnswer = () => null;

  before(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-fork-')));
    home = path.join(base, 'claude-home');
    cwd = path.join(base, 'home', 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const config = {
      owner: OWNER,
      publicHost: HOST,
      origin: 'https://' + HOST,
      homeRoot: path.join(base, 'home'),
      repoDir: REPO_DIR,
      publicDir: path.join(REPO_DIR, 'public'),
      dataDir: path.join(base, 'data'),
      gatewayUrl: 'http://127.0.0.1:9',
      claudeExecutable: '/nonexistent/claude',
      claudeConfigDir: home,
    };
    store = createStore({ dataDir: config.dataDir });
    store.load();
    events = createEvents({ save: store.save, toPublic: publicSession });
    fake = createFakeCli(async function* () {}, { rewindFiles: (uuid, request) => rewindAnswer(uuid, request) });
    runner = createRunner({ config, events, query: fake.query });
    uploads = createUploads({ dataDir: config.dataDir });
    // A second "machine": the stand-in ssh runs this one's commands in `remoteHome`, as
    // sshd would start them there (tests/fake-ssh.mjs).
    remoteHome = path.join(base, 'cluster-home');
    fs.mkdirSync(remoteHome, { recursive: true });
    const sshScript = path.join(base, 'ssh');
    fs.writeFileSync(
      sshScript,
      `#!/bin/sh\ncase "$*" in *down-login*) echo "ssh: connect to host down-login: no route to host" >&2; exit 255;; esac\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SSH)} --home ${JSON.stringify(remoteHome)} "$@"\n`,
      { mode: 0o700 },
    );
    savedSsh = process.env.WORKBENCH_SSH;
    process.env.WORKBENCH_SSH = sshScript;
    clusters = createClusters({
      list: [
        { id: 'local', label: 'Here', host: null },
        { id: 'lab', label: 'Lab', host: 'lab-login' },
        { id: 'down', label: 'Down', host: 'down-login' },
      ],
      log: () => {},
    });
    // The real SDK fork, in a child process for this fixture home (sdkForker).
    const real = sdkForker(config);
    const forkTranscript = async (id, options) => {
      sdkCalls.push({ id, options });
      return real(id, options);
    };
    const forks = createForks({ config, store, events, uploads, clusters, forkTranscript });
    socketPath = path.join(base, 'web.sock');
    server = await listenOnSocket(createApp({ config, store, events, runner, uploads, forks, clusters }), socketPath);
    ids = Object.fromEntries(['first', 'a1', 'second', 'a2', 'r2', 'steer', 'steerSent', 'a3', 'third', 'a4'].map((k) => [k, uuid()]));
    transcript = writeTranscript(home, cwd, ids);
    // The same session's transcript as the "cluster" has it, under its own HOME.
    remoteTranscript = writeTranscript(path.join(remoteHome, '.claude'), cwd, ids);
    remoteProjects = path.join(remoteHome, '.claude', 'projects', projectSlug(cwd));
  });

  after(async () => {
    if (savedSsh === undefined) delete process.env.WORKBENCH_SSH;
    else process.env.WORKBENCH_SSH = savedSsh;
    runner.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  });

  function post(route, body) {
    return new Promise((resolve, reject) => {
      const headers = { 'Tailscale-User-Login': OWNER, Origin: 'https://' + HOST, 'Content-Type': 'application/json' };
      const req = http.request({ socketPath, path: route, method: 'POST', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body ?? {}));
    });
  }

  /** A Harbor session over the fixture transcript: the messages as the runner records them. */
  function seed(extra = {}) {
    const session = {
      id: uuid(),
      title: 'Research',
      cwd,
      model: 'claude-opus-5-5',
      mode: 'default',
      efforts: { 'claude-opus-5-5': 'high' },
      status: 'idle',
      pending: [],
      createdAt: 1,
      updatedAt: 1,
      sdkSessionId: transcript.sessionId,
      lastTurnModel: 'claude-opus-5-5',
      allowRules: ['Bash(ls:*)'],
      todos: [{ content: 'later', status: 'pending' }],
      messages: [
        user('first question', { id: 'm-first' }),
        { id: 'm-a1', role: 'assistant', text: 'first answer', at: 2 },
        // From before Harbor recorded uuids: found by text.
        user('second question', { id: 'm-second' }),
        { id: 'm-t1', role: 'tool', tool: 'Bash', toolId: 'toolu_1', state: 'done', input: { command: 'ls' }, output: 'ok' },
        { id: 'm-todo', role: 'tool', tool: 'TodoWrite', toolId: 'toolu_t', state: 'done', input: { todos: [{ content: 'early', status: 'in_progress' }] } },
        user('also this', { id: 'm-steer', sdkUuid: ids.steerSent }),
        { id: 'm-a3', role: 'assistant', text: 'second answer', at: 3 },
        { id: 'm-bg', role: 'tool', tool: 'Agent', toolId: 'toolu_bg', state: 'running', background: true, input: {} },
        user('third question', { id: 'm-third', sdkUuid: ids.third }),
        { id: 'm-a4', role: 'assistant', text: 'third answer', at: 4 },
        user('waiting', { id: 'm-queued', delivery: 'queued' }),
      ],
      queue: [{ id: 'm-queued', text: 'waiting' }],
      ...extra,
    };
    store.insert(session);
    return session;
  }

  test('fork the whole session: a copy with its own Claude Code transcript', async () => {
    const source = seed();
    const response = await post(`/api/sessions/${source.id}/fork`, {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { session, draft } = response.body;
    assert.equal(draft, undefined);
    assert.notEqual(session.id, source.id);
    assert.equal(session.title, 'Research (fork)');
    assert.deepEqual(session.forkedFrom, { id: source.id, title: 'Research' });
    assert.equal(session.status, 'idle');
    assert.equal(session.cwd, cwd);
    assert.deepEqual(session.efforts, { 'claude-opus-5-5': 'high' });
    assert.deepEqual(session.allowRules, ['Bash(ls:*)']);
    assert.equal(session.sdkSessionId, undefined, 'never sent to the client');
    assert.equal(session.sdkAncestors, undefined);
    // Everything but the queued message, then the notice.
    const shown = session.messages.map((m) => m.id);
    assert.deepEqual(shown.slice(0, -1), source.messages.filter((m) => m.id !== 'm-queued').map((m) => m.id));
    assert.deepEqual(session.messages.at(-1), { ...session.messages.at(-1), role: 'notice', level: 'info', text: 'Forked from “Research”.', forkOf: source.id });
    const bg = session.messages.find((m) => m.id === 'm-bg');
    assert.equal(bg.state, 'error');
    assert.match(bg.output, /original session/);
    assert.equal(source.messages.find((m) => m.id === 'm-bg').state, 'running', 'the original is untouched');
    assert.deepEqual(session.todos, source.todos);

    const fork = store.get(session.id);
    assert.equal(fork.lastTurnModel, 'claude-opus-5-5');
    assert.deepEqual(fork.sdkAncestors, [transcript.sessionId]);
    assert.ok(fork.sdkSessionId && fork.sdkSessionId !== transcript.sessionId);
    const entries = readEntries(path.join(path.dirname(transcript.file), fork.sdkSessionId + '.jsonl'));
    const copied = entries.filter((e) => e.forkedFrom).map((e) => e.forkedFrom.messageUuid);
    assert.deepEqual(copied, [ids.first, ids.a1, ids.second, ids.a2, ids.r2, ids.steer, ids.a3, ids.third, ids.a4]);
    assert.equal(entries.find((e) => e.type === 'custom-title')?.customTitle, 'Research (fork)');
    // The original transcript is unchanged.
    assert.equal(readEntries(transcript.file).length, 9);
  });

  test('fork before a message: history up to it, the message comes back as the draft', async () => {
    const image = await uploads.save({ scope: 'draft', name: 'shot.png', type: 'image/png', data: Buffer.from('not really a png') });
    const source = seed();
    uploads.claim([image.id], source.id);
    source.messages.find((m) => m.id === 'm-third').attachments = [{ id: image.id, name: 'shot.png' }];
    const response = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-third' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { session, draft } = response.body;
    assert.equal(draft.text, 'third question');
    assert.equal(draft.attachments.length, 1);
    assert.notEqual(draft.attachments[0].id, image.id, 'a copy the fork owns');
    assert.equal(uploads.get(draft.attachments[0].id).scope, session.id);
    assert.equal(fs.readFileSync(uploads.get(draft.attachments[0].id).path, 'utf8'), 'not really a png');
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ['m-first', 'm-a1', 'm-second', 'm-t1', 'm-todo', 'm-steer', 'm-a3', 'm-bg', session.messages.at(-1).id],
    );
    assert.equal(session.messages.at(-1).text, 'Forked from “Research” before your message.');
    assert.deepEqual(session.forkedFrom, { id: source.id, title: 'Research', messageId: 'm-third' });
    assert.deepEqual(session.todos, [{ content: 'early', status: 'in_progress' }], 'the checklist as of the fork point');
    // Claude Code's copy ends with the turn before the message.
    const fork = store.get(session.id);
    assert.equal(fork.lastTurnModel, undefined, 'taken from the copied replies');
    const entries = readEntries(path.join(path.dirname(transcript.file), fork.sdkSessionId + '.jsonl'));
    assert.deepEqual(
      entries.filter((e) => e.forkedFrom).map((e) => e.forkedFrom.messageUuid),
      [ids.first, ids.a1, ids.second, ids.a2, ids.r2, ids.steer, ids.a3],
    );
    assert.equal(sdkCalls.at(-1).options.upToMessageId, ids.a3);
  });

  test('fork before a message sent mid-turn, and before one found by its text', async () => {
    const source = seed();
    const steer = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-steer' });
    assert.equal(steer.status, 200, JSON.stringify(steer.body));
    assert.equal(sdkCalls.at(-1).options.upToMessageId, ids.r2);
    assert.equal(steer.body.draft.text, 'also this');
    const second = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-second' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(sdkCalls.at(-1).options.upToMessageId, ids.a1);
    assert.deepEqual(second.body.session.messages.slice(0, -1).map((m) => m.id), ['m-first', 'm-a1']);
  });

  test('fork before the first message: a fresh session with the message as its draft', async () => {
    const source = seed();
    const calls = sdkCalls.length;
    const response = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-first' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(sdkCalls.length, calls, 'nothing to fork in Claude Code');
    assert.equal(store.get(response.body.session.id).sdkSessionId, undefined);
    assert.equal(response.body.session.messages.length, 1);
    assert.equal(response.body.draft.text, 'first question');
  });

  test('refusals', async () => {
    const source = seed({ status: 'running' });
    const busy = await post(`/api/sessions/${source.id}/fork`, {});
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /Wait for the turn to end/);
    // Forking before a message works mid-turn: it copies only what came before.
    assert.equal((await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-second' })).status, 200);
    assert.equal((await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-a1' })).status, 404, 'not a user message');
    assert.equal((await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-queued' })).status, 404);
    assert.equal((await post(`/api/sessions/${source.id}/fork`, { messageId: 42 })).status, 400);
    const lost = seed();
    lost.messages.splice(2, 0, user('before the compaction', { id: 'm-lost', imported: true }));
    const missing = await post(`/api/sessions/${lost.id}/fork`, { messageId: 'm-lost' });
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /Fork the whole session instead/);
    const trashed = seed({ removed: true });
    assert.equal((await post(`/api/sessions/${trashed.id}/fork`, {})).status, 409);
  });

  test('a session Claude Code never ran is copied as it is', async () => {
    const source = seed({ sdkSessionId: undefined, handoff: 'Earlier, in Codex: …', messages: [user('codex says', { imported: true, id: 'm-x' })] });
    const calls = sdkCalls.length;
    const whole = await post(`/api/sessions/${source.id}/fork`, {});
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    assert.equal(sdkCalls.length, calls);
    assert.equal(store.get(whole.body.session.id).handoff, 'Earlier, in Codex: …', 'the history still goes over on the first turn');
    const inside = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-x' });
    assert.equal(inside.status, 409);
    // A message after the imported history (stopped before Claude Code read it).
    source.messages.push(user('my turn', { id: 'm-mine', delivery: 'stopped' }));
    const after = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-mine' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(store.get(after.body.session.id).handoff, 'Earlier, in Codex: …');
    assert.equal(after.body.draft.text, 'my turn');
  });

  test('fork a session on another cluster: its transcript is read there and the fork written back', async () => {
    const source = seed({ cluster: 'lab', sdkSessionId: remoteTranscript.sessionId });
    const calls = sdkCalls.length;
    const response = await post(`/api/sessions/${source.id}/fork`, {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(sdkCalls.length, calls, 'the remote transcript is forked in its own home');
    const session = store.get(response.body.session.id);
    assert.equal(session.cluster, 'lab', 'the fork runs where the original does');
    assert.equal(session.title, 'Research (fork)');
    const entries = readEntries(path.join(remoteProjects, session.sdkSessionId + '.jsonl'));
    assert.deepEqual(
      entries.filter((entry) => entry.forkedFrom).map((entry) => entry.forkedFrom.messageUuid),
      [ids.first, ids.a1, ids.second, ids.a2, ids.r2, ids.steer, ids.a3, ids.third, ids.a4],
    );
    assert.equal(entries.find((entry) => entry.type === 'custom-title')?.customTitle, 'Research (fork)');
    assert.equal(readEntries(remoteTranscript.file).length, 9, 'the original is untouched');
    assert.equal(fs.existsSync(path.join(home, 'projects', projectSlug(cwd), session.sdkSessionId + '.jsonl')), false, 'nothing is kept here');
  });

  test('fork a remote session before a message: cut on the cluster, the message as the draft', async () => {
    const source = seed({ cluster: 'lab', sdkSessionId: remoteTranscript.sessionId });
    const response = await post(`/api/sessions/${source.id}/fork`, { messageId: 'm-third' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.draft.text, 'third question');
    assert.equal(response.body.session.cluster, 'lab');
    const fork = store.get(response.body.session.id);
    const entries = readEntries(path.join(remoteProjects, fork.sdkSessionId + '.jsonl'));
    assert.deepEqual(
      entries.filter((entry) => entry.forkedFrom).map((entry) => entry.forkedFrom.messageUuid),
      [ids.first, ids.a1, ids.second, ids.a2, ids.r2, ids.steer, ids.a3],
    );
    assert.equal(readEntries(remoteTranscript.file).length, 9, 'the original is untouched');
  });

  test('a remote fork needs the transcript on the cluster and a reachable cluster', async () => {
    const gone = seed({ cluster: 'lab', sdkSessionId: uuid() });
    const missing = await post(`/api/sessions/${gone.id}/fork`, {});
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /gone/);
    const down = seed({ cluster: 'down', sdkSessionId: remoteTranscript.sessionId });
    const unreachable = await post(`/api/sessions/${down.id}/fork`, {});
    assert.equal(unreachable.status, 502);
    assert.match(unreachable.body.error, /Could not reach Down/);
    // Never in Claude Code: copied as it is, on the same cluster, without asking the cluster.
    const never = seed({ cluster: 'lab', sdkSessionId: undefined, messages: [user('hello', { id: 'm-hello' })] });
    const forked = await post(`/api/sessions/${never.id}/fork`, {});
    assert.equal(forked.status, 200, JSON.stringify(forked.body));
    assert.equal(store.get(forked.body.session.id).cluster, 'lab');
  });

  test('rewind before a message: the conversation is cut in place and resumes before it', async () => {
    const source = seed({ model: 'opus' });
    source.messages.find((m) => m.id === 'm-third').attachments = [{ id: 'up-1', name: 'shot.png' }];
    const response = await post(`/api/sessions/${source.id}/rewind`, { messageId: 'm-third' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.files, undefined);
    assert.equal(response.body.draft.text, 'third question');
    assert.deepEqual(response.body.draft.attachments.map((a) => a.id), ['up-1'], 'the same uploads');
    const session = store.get(source.id);
    assert.deepEqual(
      session.messages.map((m) => m.id),
      ['m-first', 'm-a1', 'm-second', 'm-t1', 'm-todo', 'm-steer', 'm-a3', 'm-bg', 'm-queued', session.messages.at(-1).id],
      'the queued message stays',
    );
    assert.equal(session.messages.at(-1).text, 'Rewound to before your message.');
    assert.equal(session.sdkSessionId, transcript.sessionId, 'the same conversation');
    assert.equal(session.resumeAt, ids.a3, 'the next turn branches off after the reply before the message');
    assert.deepEqual(session.todos, [{ content: 'early', status: 'in_progress' }]);
    assert.equal(readEntries(transcript.file).length, 9, 'the transcript is untouched');
  });

  test('rewind with the code: a preview, then the files put back before the conversation is cut', async () => {
    const source = seed({ model: 'opus' });
    const preview = await post(`/api/sessions/${source.id}/rewind`, { messageId: 'm-third', dryRun: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.files, { canRewind: true, filesChanged: [`${cwd}/a.txt`], insertions: 1, deletions: 1 });
    assert.equal(store.get(source.id).messages.length, source.messages.length, 'a preview changes nothing');

    const response = await post(`/api/sessions/${source.id}/rewind`, { messageId: 'm-third', code: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const proc = fake.processes.findLast((p) => p.options.resume === transcript.sessionId);
    assert.equal(proc.options.enableFileCheckpointing, true);
    assert.deepEqual(
      proc.controls.filter((c) => c[0] === 'rewindFiles').slice(-2),
      [
        ['rewindFiles', ids.third, { dryRun: true }],
        ['rewindFiles', ids.third, { dryRun: false }],
      ],
    );
    assert.equal(store.get(source.id).messages.at(-1).text, 'Rewound to before your message and restored 1 file.');
    assert.equal(store.get(source.id).resumeAt, ids.a3);
    // The process that restored the files is gone: the next one resumes at the rewind point.
    for (let i = 0; i < 100 && runner.pool.get(source.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runner.pool.get(source.id), undefined);
  });

  test('a fork of a rewound session copies only what is left', async () => {
    const source = seed();
    assert.equal((await post(`/api/sessions/${source.id}/rewind`, { messageId: 'm-third' })).status, 200);
    const response = await post(`/api/sessions/${source.id}/fork`, {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(sdkCalls.at(-1).options.upToMessageId, ids.a3);
  });

  test('rewind refusals: a running session, code that cannot be restored, an unknown message', async () => {
    const running = seed({ status: 'running' });
    const busy = await post(`/api/sessions/${running.id}/rewind`, { messageId: 'm-third' });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /Wait for the turn/);

    rewindAnswer = () => ({ canRewind: false, error: 'No file checkpoint found for this message' });
    try {
      const source = seed({ model: 'opus' });
      const before = structuredClone(store.get(source.id).messages);
      const failed = await post(`/api/sessions/${source.id}/rewind`, { messageId: 'm-third', code: true });
      assert.equal(failed.status, 409);
      assert.match(failed.body.error, /No file checkpoint found.*conversation only/);
      assert.deepEqual(store.get(source.id).messages, before, 'nothing cut');
      assert.equal(store.get(source.id).resumeAt, undefined);
    } finally {
      rewindAnswer = () => null;
    }

    const source = seed();
    assert.equal((await post(`/api/sessions/${source.id}/rewind`, { messageId: 'm-a1' })).status, 404);
    assert.equal((await post(`/api/sessions/${source.id}/rewind`, {})).status, 400);
  });
});
