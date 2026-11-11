// End-to-end harness check: real Claude Code turns (the CLI at ~/.local/bin/claude) run
// through the runner, the normalizing proxy and the mock gateway. Isolated from the
// user's setup: no settings sources and a throwaway CLAUDE_CONFIG_DIR. Spawns the CLI,
// so it lives outside the fast `npm test` glob: run `npm run test:integration`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { NOTICES, createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startMockGateway } from '../mock-gateway.mjs';
import { closeRunners } from './helpers.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TURN_TIMEOUT_MS = 60_000;

let base;
let work;
let mock;
let proxy;
// Every runner keeps its Claude Code processes alive; all are closed at the end.
const runners = [];

before(async () => {
  // No update checks or telemetry from the test CLI.
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-harness-'));
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(base, 'claude-config'));
  fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\nsecond line\n');
  mock = await startMockGateway();
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
});

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** A runner wired like server.mjs, pointed at the proxy (or straight at the mock). */
function harness({ viaProxy = true } = {}) {
  const store = createStore({ dataDir: fs.mkdtempSync(path.join(base, 'data-')) });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const frames = [];
  events.subscribe({ write: (frame) => frames.push(frame) });
  const config = {
    claudeExecutable: CLAUDE,
    gatewayUrl: mock.url,
    settingSources: [],
    claudeConfigDir: path.join(base, 'claude-config'),
  };
  const gateway = viaProxy ? { url: proxy.url, apiKey: proxy.secret } : { url: mock.url, apiKey: mock.key };
  const runner = createRunner({ config, events, gateway, log: () => {} });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: work, model: 'luna', mode: 'bypassPermissions' }));
  return { runner, session, frames };
}

async function waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runTurn({ runner, session }, text) {
  runner.enqueue(session, { text });
  await waitFor(() => !runner.isRunning(session.id));
  return session;
}

const tools = (session, name) => session.messages.filter((m) => m.role === 'tool' && m.tool === name);
const lastAssistant = (session) => session.messages.findLast((m) => m.role === 'assistant')?.text;

describe('model harness end to end (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('Read with pages:"" fails straight to the gateway and succeeds through the proxy', async () => {
    const direct = await runTurn(harness({ viaProxy: false }), '[[mock:read-empty-pages]] read the file');
    const [failed] = tools(direct, 'Read');
    assert.equal(failed.state, 'error');
    assert.match(failed.output, /InputValidationError|tool_use_error/);
    assert.match(lastAssistant(direct), /^Tool result: error/);

    const proxied = await runTurn(harness(), '[[mock:read-empty-pages]] read the file');
    const [read] = tools(proxied, 'Read');
    assert.equal(read.state, 'done', read.output);
    assert.deepEqual(read.input, { file_path: path.join(work, 'hello.txt'), offset: 1 });
    assert.match(read.output, /hello world/);
    assert.match(lastAssistant(proxied), /^Tool result: ok/);
    assert.equal(proxied.status, 'idle');
    assert.deepEqual(proxied.context, { used: 1000, window: 400_000, compactAt: 287_000 });
    const turn = proxied.messages.find((m) => m.role === 'turn');
    assert.equal(turn.isError, false);
    assert.equal(turn.model, 'luna');
    assert.equal(proxied.messages[0].delivery, 'done');
  });

  test('TodoWrite with todos sent as a JSON string fills session.todos', async () => {
    const session = await runTurn(harness(), '[[mock:todos-as-string]] plan the work');
    assert.equal(tools(session, 'TodoWrite')[0].state, 'done');
    assert.deepEqual(
      session.todos.map((todo) => [todo.content, todo.status]),
      [
        ['Inspect the repository', 'completed'],
        ['Write the fix', 'in_progress'],
        ['Run the tests', 'pending'],
      ],
    );
  });

  test('thinking blocks are captured', async () => {
    const session = await runTurn(harness(), '[[mock:thinking]] think first');
    const thinking = session.messages.find((m) => m.role === 'thinking');
    assert.equal(thinking?.text, 'Let me think about this step by step. The answer is 42.');
    assert.equal(lastAssistant(session), 'The answer is 42.');
  });

  test('the recorded system prompt names the first model; a switch is announced in that turn\'s user message', async () => {
    const setup = harness();
    const lastRequest = () => mock.requests.findLast((request) => request.tools.length);
    await runTurn(setup, 'hello');
    const first = lastRequest();
    assert.equal(first.model, 'codex/gpt-6-luna');
    assert.match(first.system, /Model identity: you are GPT-6 Luna \(route codex\/gpt-6-luna, provider OpenAI\), selected by the user in Harbor\./);
    assert.match(first.system, /When calling tools, send arguments with their correct JSON types/);
    assert.doesNotMatch(first.system, /omit the pages parameter/);
    assert.doesNotMatch(first.human, /\[Harbor:/);

    // Same model: the resumed turn replays the recorded prompt.
    await runTurn(setup, 'hello again');
    const again = lastRequest();
    assert.equal(again.system, first.system);
    assert.doesNotMatch(again.human, /\[Harbor:/);

    // Switch: the prompt stays the recorded one (cache prefix intact); the user message
    // of the switched turn carries the note.
    setup.session.model = 'deepseek';
    await runTurn(setup, 'who are you now?');
    const switched = lastRequest();
    assert.equal(switched.model, 'litellm/DeepSeek-V4-Flash');
    assert.equal(switched.system, first.system, 'system prompt identical across the switch');
    assert.match(
      switched.human,
      /\[Harbor: from this message on you are DeepSeek V4.1 Flash \(route litellm\/DeepSeek-V4-Flash, provider DeepSeek\); earlier turns in this conversation ran on GPT-6 Luna\. When calling tools, [^\]]+\]\n\nwho are you now\?/,
    );
    assert.ok(switched.messageCount > first.messageCount, 'the switched turn resumed the conversation');

    // Next turn on the same new model: no new note, same prompt.
    await runTurn(setup, 'and now?');
    const after = lastRequest();
    assert.equal(after.system, first.system);
    assert.doesNotMatch(after.human, /\[Harbor:/);

    // The transcript shows what the user typed, never the note.
    const typed = setup.session.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.deepEqual(typed, ['hello', 'hello again', 'who are you now?', 'and now?']);
    assert.equal(setup.session.lastTurnModel, 'deepseek');
    assert.equal(setup.session.totals.turns, 4);
  });

  test('stop during a slow stream interrupts the turn: stopped, not an error', async () => {
    const setup = harness();
    const { runner, session, frames } = setup;
    runner.enqueue(session, { text: '[[mock:slow]] stream slowly' });
    await waitFor(() => session.live.includes('chunk 2'));
    const stoppedAt = Date.now();
    runner.stop(session);
    await waitFor(() => !runner.isRunning(session.id));

    assert.ok(Date.now() - stoppedAt < 4500, 'ended by interrupt(), before the hard-abort grace period');
    assert.equal(session.status, 'idle');
    assert.equal(session.queuePaused, true);
    assert.equal(session.messages[0].delivery, 'stopped');
    const notices = session.messages.filter((m) => m.role === 'notice');
    assert.deepEqual(notices.map(({ text, level }) => ({ text, level })), [{ text: NOTICES.stopped, level: 'info' }]);
    assert.ok(!session.messages.some((m) => m.role === 'turn' && m.isError));
    assert.ok(frames.some((frame) => frame.startsWith('event: live\n')), 'streaming went out as live events');
  });
});
