// Session import end to end against the real Claude Code CLI and the mock gateway:
// a Claude Code session continues as a fork with its history (the original transcript
// untouched), and a Codex session's condensed history reaches the model with the first
// turn only. Isolated: no settings sources and throwaway Claude and Codex folders.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { createImporter } from '../../server/importer.mjs';
import { createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { CODEX_SESSION, copyImportFixtures } from '../fixtures/import/setup.mjs';
import { startMockGateway } from '../mock-gateway.mjs';
import { closeRunners } from './helpers.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TURN_TIMEOUT_MS = 60_000;

let base;
let home;
let work;
let claudeHome;
let mock;
let proxy;
// Every runner keeps its Claude Code processes alive; all are closed at the end.
const runners = [];

before(async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-import-')));
  home = path.join(base, 'home');
  work = path.join(home, 'proj');
  fs.mkdirSync(work, { recursive: true });
  claudeHome = path.join(base, 'claude-config');
  fs.mkdirSync(claudeHome);
  mock = await startMockGateway({ keepBodies: true });
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
});

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** A store, runner and importer wired like server.mjs (a fresh Harbor each call). */
function harbor({ codexHome = path.join(base, 'no-codex') } = {}) {
  const store = createStore({ dataDir: fs.mkdtempSync(path.join(base, 'data-')) });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const config = {
    claudeExecutable: CLAUDE,
    gatewayUrl: mock.url,
    settingSources: [],
    claudeConfigDir: claudeHome,
    homeRoot: home,
    codexHome,
  };
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, log: () => {} });
  runners.push(runner);
  const importer = createImporter({ config, store, events, log: () => {} });
  return { store, runner, importer };
}

async function waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runTurn(runner, session, text) {
  runner.enqueue(session, { text });
  await waitFor(() => !runner.isRunning(session.id));
  assert.equal(session.status, 'idle', JSON.stringify(session.messages.at(-1)));
  return session;
}

/** The model request of the latest turn (the one with tools; titles have none). */
const lastTurnRequest = () => mock.requests.findLast((request) => request.tools.length && request.body);

const messageText = (message) =>
  typeof message.content === 'string' ? message.content : (message.content || []).map((block) => block.text ?? '').join('\n');

function fingerprint(file) {
  const stats = fs.statSync(file);
  return { size: stats.size, mtimeMs: stats.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

function findTranscript(id) {
  const projects = path.join(claudeHome, 'projects');
  for (const dir of fs.readdirSync(projects)) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

describe('session import end to end (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('a Claude Code session continues as a fork with its history; the original is untouched', async () => {
    // A conversation in the throwaway Claude folder, made the way Harbor makes one,
    // then marked as a terminal session so the import list offers it.
    const first = harbor();
    const made = first.store.insert(createSession({ cwd: work, model: 'luna', mode: 'bypassPermissions' }));
    await runTurn(first.runner, made, 'Remember the word PINEAPPLE');
    const originalId = made.sdkSessionId;
    assert.ok(originalId);
    const original = findTranscript(originalId);
    fs.writeFileSync(original, fs.readFileSync(original, 'utf8').replaceAll('"entrypoint":"sdk-ts"', '"entrypoint":"cli"'));
    const before = fingerprint(original);

    const { store, runner, importer } = harbor();
    const listed = (await importer.list('claude')).items.find((item) => item.id === originalId);
    assert.equal(listed?.importable, true, JSON.stringify(listed));
    assert.equal(listed.title, 'Remember the word PINEAPPLE');
    const { sessions, errors } = await importer.importSessions({ source: 'claude', ids: [originalId] });
    assert.deepEqual(errors, []);
    const session = store.get(sessions[0].id);
    assert.equal(session.model, 'luna', 'the model the conversation last ran on');
    assert.equal(session.forkFrom, originalId);
    assert.deepEqual(
      session.messages.map((message) => [message.role, message.text]),
      [
        ['user', 'Remember the word PINEAPPLE'],
        ['assistant', 'ok'],
      ],
    );

    await runTurn(runner, session, 'Which word did I ask you to remember?');
    const request = lastTurnRequest();
    assert.equal(request.human, 'Which word did I ask you to remember?', 'same model: no switch note');
    assert.ok(request.messageCount >= 3, `the earlier turn is in the request (${request.messageCount} messages)`);
    assert.match(messageText(request.body.messages[0]), /Remember the word PINEAPPLE/);
    assert.equal(request.body.messages.filter((message) => /PINEAPPLE/.test(messageText(message))).length, 1);

    assert.equal(session.forkFrom, undefined, 'cleared once the model answered');
    assert.ok(session.sdkSessionId && session.sdkSessionId !== originalId, 'continues as a new Claude Code session');
    assert.ok(findTranscript(session.sdkSessionId), 'the fork has its own transcript');
    assert.deepEqual(fingerprint(original), before, 'the original transcript is byte for byte unchanged');

    // The next turn resumes the fork, not the original.
    await runTurn(runner, session, 'And once more?');
    assert.ok(lastTurnRequest().messageCount > request.messageCount);
    assert.deepEqual(fingerprint(original), before);
    assert.deepEqual(
      session.messages.filter((message) => message.role === 'user').map((message) => [message.text, Boolean(message.imported)]),
      [
        ['Remember the word PINEAPPLE', true],
        ['Which word did I ask you to remember?', false],
        ['And once more?', false],
      ],
    );
  });

  test('a Codex session: the first turn carries the condensed history, the next does not repeat it', async () => {
    const fixtures = copyImportFixtures(path.join(base, 'codex-fixtures'), { cwd: work });
    const { store, runner, importer } = harbor({ codexHome: fixtures.codexHome });
    const { sessions, errors } = await importer.importSessions({ source: 'codex', ids: [CODEX_SESSION], model: 'luna' });
    assert.deepEqual(errors, []);
    const session = store.get(sessions[0].id);
    assert.ok(session.handoff);

    await runTurn(runner, session, 'Please continue where Codex left off');
    const first = lastTurnRequest();
    // Claude Code puts its own context blocks in front; the prompt is the last block.
    const prompt = first.body.messages[0].content.at(-1).text;
    assert.match(prompt, /^\[Harbor: the user imported this conversation from a Codex session \("Write the README"\)/);
    assert.match(prompt, /<codex_history>\n## Turn 1 \([^)]*\)\nUser: Add a README\n/);
    assert.match(prompt, /<\/codex_history>\n\nPlease continue where Codex left off$/);
    assert.equal(first.body.messages.filter((message) => message.role !== 'system').length, 1, 'a new conversation');
    assert.equal(session.handoff, undefined);

    await runTurn(runner, session, 'Anything else?');
    const second = lastTurnRequest();
    assert.equal(second.human, 'Anything else?');
    assert.ok(second.messageCount > first.messageCount, 'the same conversation continues');
    assert.equal(second.body.messages.filter((message) => /<codex_history>/.test(messageText(message))).length, 1, 'the history is in it once');
    assert.equal(
      session.messages.filter((message) => message.role === 'user' && !message.imported).map((message) => message.text).join('|'),
      'Please continue where Codex left off|Anything else?',
      'the transcript shows what the user typed',
    );
  });
});
