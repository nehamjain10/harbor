// Composer features against the real Claude Code CLI and the mock gateway: slash-command
// discovery, and attachments reaching the model (image blocks on vision routes, paths
// only on text routes) without breaking interrupt or live mode changes. Isolated from the
// user's setup: project settings only and a throwaway CLAUDE_CONFIG_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createCommandCatalog } from '../../server/commands.mjs';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { NOTICES, createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { createUploads, publicAttachment } from '../../server/uploads.mjs';
import { startMockGateway } from '../mock-gateway.mjs';
import { closeRunners } from './helpers.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TURN_TIMEOUT_MS = 60_000;
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let base;
let work;
let mock;
let proxy;
// Every runner keeps its Claude Code processes alive; all are closed at the end.
const runners = [];
let config;

before(async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-composer-'));
  work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, '.claude/skills/hello-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(work, '.claude/skills/hello-skill/SKILL.md'),
    '---\nname: hello-skill\ndescription: Says hello for tests\n---\nSay hello.\n',
  );
  fs.mkdirSync(path.join(base, 'claude-config'));
  mock = await startMockGateway({ keepBodies: true });
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
  config = {
    claudeExecutable: CLAUDE,
    gatewayUrl: mock.url,
    settingSources: ['project'],
    claudeConfigDir: path.join(base, 'claude-config'),
  };
});

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const gateway = () => ({ url: proxy.url, apiKey: proxy.secret });

function harness(model) {
  const dataDir = fs.mkdtempSync(path.join(base, 'data-'));
  const store = createStore({ dataDir });
  store.load();
  const uploads = createUploads({ dataDir });
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const logs = [];
  const runner = createRunner({ config, events, gateway: gateway(), uploads, log: (line) => logs.push(line) });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: work, model, mode: 'default' }));
  return { runner, session, uploads, logs };
}

/** Uploads files as drafts, claims them for the session, returns the public attachments. */
async function attach({ uploads, session }, files) {
  const records = [];
  for (const file of files) records.push(await uploads.save({ scope: 'draft', ...file }));
  return uploads.claim(records.map((record) => record.id), session.id).map(publicAttachment);
}

async function waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The content blocks of the user message carrying `marker`, from the latest request that has it. */
function sentContent(marker) {
  for (const request of [...mock.requests].reverse()) {
    const message = request.body?.messages?.findLast(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((block) => block.type === 'text' && block.text.includes(marker)),
    );
    if (message) return message.content;
  }
  return null;
}

const messageRequests = () => mock.requests.filter((request) => request.path === '/v1/messages').length;

describe('composer end to end (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('command discovery lists Claude Code commands, project skills and local commands without a model call', async () => {
    const before = messageRequests();
    const catalog = createCommandCatalog({ config, gateway: gateway(), log: (line) => assert.fail(line) });
    const started = Date.now();
    const commands = await catalog.list(work);
    const elapsed = Date.now() - started;

    const byName = new Map(commands.map((command) => [command.name, command]));
    assert.equal(byName.get('compact')?.source, 'sdk');
    assert.deepEqual(byName.get('hello-skill'), {
      name: 'hello-skill',
      description: 'Says hello for tests (project)',
      argumentHint: '',
      source: 'skill',
    });
    for (const name of ['clear', 'model', 'mode', 'effort', 'rename', 'help']) assert.equal(byName.get(name)?.source, 'local', name);
    assert.ok(!commands.some((command) => command.name.startsWith('__')));
    assert.equal(messageRequests(), before, 'discovery never calls a model');
    assert.ok(elapsed < 10_000, `discovery took ${elapsed} ms`);

    // Cached: the second call does not start the CLI again.
    const again = Date.now();
    assert.equal(await catalog.list(work), commands);
    assert.ok(Date.now() - again < 50);
  });

  test('an image reaches a vision route as an image block, with every path in the text', async () => {
    const setup = harness('luna');
    const attachments = await attach(setup, [
      { name: 'dot.png', type: 'image/png', data: PNG },
      { name: 'notes.txt', type: 'text/plain', data: Buffer.from('some notes\n') },
    ]);
    setup.runner.enqueue(setup.session, { text: '[[mock:text]] vision-check', attachments });
    await waitFor(() => !setup.runner.isRunning(setup.session.id));

    assert.equal(setup.session.status, 'idle', JSON.stringify(setup.session.messages));
    const content = sentContent('vision-check');
    assert.ok(content, 'the mock received the message');
    const images = content.filter((block) => block.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].source.type, 'base64');
    assert.equal(images[0].source.media_type, 'image/png');
    assert.equal(Buffer.from(images[0].source.data, 'base64').subarray(0, 8).toString('hex'), PNG.subarray(0, 8).toString('hex'));
    const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const dir = setup.uploads.sessionDir(setup.session.id);
    assert.ok(text.includes(`- ${path.join(dir, `${attachments[0].id}-dot.png`)} (image, shown above)`), text);
    assert.ok(text.includes(`- ${path.join(dir, `${attachments[1].id}-notes.txt`)}`), text);
    assert.deepEqual(setup.session.messages[0].attachments, attachments);
    assert.equal(setup.session.messages[0].delivery, 'done');
  });

  test('the model can Read an attachment without an approval prompt', async () => {
    const setup = harness('luna');
    const [notes] = await attach(setup, [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('attachment body\n') }]);
    const file = path.join(setup.uploads.sessionDir(setup.session.id), `${notes.id}-notes.txt`);
    setup.runner.enqueue(setup.session, { text: `[[mock:read-empty-pages:${file}]] read it`, attachments: [notes] });
    await waitFor(() => !setup.runner.isRunning(setup.session.id));

    const read = setup.session.messages.find((m) => m.role === 'tool' && m.tool === 'Read');
    assert.equal(read?.state, 'done', read?.output);
    assert.match(read.output, /attachment body/);
    assert.equal(setup.session.pending.length, 0);
  });

  test('with attachments, live mode changes and stop (interrupt) still work', async () => {
    const setup = harness('luna');
    const { runner, session, logs } = setup;
    const attachments = await attach(setup, [{ name: 'dot.png', type: 'image/png', data: PNG }]);
    runner.enqueue(session, { text: '[[mock:slow]] stream slowly', attachments });
    await waitFor(() => session.live.includes('chunk 2'));

    session.mode = 'acceptEdits';
    runner.applyMode(session);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(logs, [], 'setPermissionMode was accepted mid-turn');

    const stoppedAt = Date.now();
    runner.stop(session);
    await waitFor(() => !runner.isRunning(session.id));
    assert.ok(Date.now() - stoppedAt < 4500, 'ended by interrupt(), before the hard-abort grace period');
    assert.equal(session.status, 'idle');
    assert.equal(session.messages[0].delivery, 'stopped');
    const notices = session.messages.filter((m) => m.role === 'notice').map((m) => m.text);
    assert.deepEqual(notices, [NOTICES.stopped]);
    assert.deepEqual(logs, []);
  });
});
