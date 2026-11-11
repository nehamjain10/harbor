// One long-lived Claude Code process per session, end to end: real CLI turns through the
// runner, the normalizing proxy and the mock gateway. Counts process launches, checks
// that each request extends the previous one (the prompt-cache prefix) within a process,
// across an idle restart and across model switches, that the Claude Code session id the
// gateway keys its cache on stays the same, and that messages sent mid-turn reach the
// model in the same turn. Isolated: no settings sources, a throwaway CLAUDE_CONFIG_DIR.
//
// Claude ("direct") turns are pointed at the mock as well, so no test here reaches a
// real model: see `beforeSpawn` below.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { NOTICES, createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startMockGateway } from '../mock-gateway.mjs';
import { closeRunners, observedQuery } from './helpers.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TURN_TIMEOUT_MS = 60_000;

let base;
let mock;
let proxy;
const runners = [];

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-live-'));
  mock = await startMockGateway({ keepBodies: true });
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
});

afterEach(() => closeRunners(runners));

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** A runner wired like server.mjs over its own folder and config dir. */
function harness({ model = 'luna', idleMs, stopGraceMs } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const work = path.join(dir, 'work');
  const claudeConfigDir = path.join(dir, 'claude-config');
  fs.mkdirSync(work);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\n');
  const store = createStore({ dataDir: path.join(dir, 'data') });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const query = observedQuery({
    beforeSpawn: ({ options }) => {
      // A Claude route would use the CLI's own login: send it to the mock instead.
      // A direct Claude process on the mock: tool search on, as on Anthropic's API (and the relay).
      if (!options.env.ANTHROPIC_BASE_URL) Object.assign(options.env, { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: mock.key, ENABLE_TOOL_SEARCH: 'true' });
      options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      assert.ok([mock.url, proxy.url].includes(options.env.ANTHROPIC_BASE_URL), 'never a real model');
    },
  });
  const logs = [];
  const config = { claudeExecutable: CLAUDE, gatewayUrl: mock.url, settingSources: [], claudeConfigDir };
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, query, idleMs, stopGraceMs, log: (line) => logs.push(line) });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: work, model, mode: 'bypassPermissions' }));
  return { runner, session, spawns: query.spawns, logs, work };
}

async function waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const footers = (session) => session.messages.filter((m) => m.role === 'turn').length;

/** Sends a message and waits for its turn (and anything it set off) to finish. */
async function runTurn({ runner, session }, text) {
  const before = footers(session);
  runner.enqueue(session, { text });
  await waitFor(() => footers(session) > before && !runner.isRunning(session.id));
  return session;
}

/** Main-model requests (with tools) the mock received for this Claude Code session. */
const mainRequests = (sessionId, since = 0) => mock.requests.slice(since).filter((request) => request.tools.length && request.sessionId === sessionId);

// --- prompt-cache prefix -------------------------------------------------------------

const withoutCacheControl = (value) => JSON.parse(JSON.stringify(value ?? null, (key, inner) => (key === 'cache_control' ? undefined : inner)));

/** A message as the model reads it: a plain string equals one text block; cache markers aside. */
function normalized(message) {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  return JSON.stringify({ role: message.role, content: withoutCacheControl(content) });
}

/** A message's content layout, for reporting raw differences: `string` or `[text+cc, ...]`. */
function shape(content) {
  if (typeof content === 'string') return 'string';
  return `[${content.map((block) => block.type + (block.cache_control ? '+cache_control' : '')).join(', ')}]`;
}

// Web search is the one tool that depends on the route: Claude Code's WebSearch on the Claude
// login, Harbor's web_search on gateway routes (whose WebSearch is switched off).
const SEARCH_TOOLS = new Set(['WebSearch', 'mcp__meshy__web_search']);
const withoutSearch = (tools) => (tools || []).filter((tool) => !SEARCH_TOOLS.has(tool.name));
// Sent with its schema, or named for tool search (deferred: WebSearch is, on the Claude route).
const searchTool = (request) => [...(request.body.tools || []).map((tool) => tool.name), ...(request.deferred || [])].filter((name) => SEARCH_TOOLS.has(name));
const isDirect = (request) => request.model.startsWith('claude-');

/**
 * How `later` continues `earlier`: whether system and tools are byte-identical (apart
 * from cache markers), and whether its messages start with all of `earlier`'s. `raw`
 * says whether that prefix is also byte-identical before normalizing; `differences`
 * lists what normalizing had to hide.
 */
function continuation(earlier, later) {
  const a = earlier.body;
  const b = later.body;
  const report = {
    system: JSON.stringify(withoutCacheControl(a.system)) === JSON.stringify(withoutCacheControl(b.system)),
    tools: JSON.stringify(withoutCacheControl(a.tools)) === JSON.stringify(withoutCacheControl(b.tools)),
    toolsButSearch: JSON.stringify(withoutCacheControl(withoutSearch(a.tools))) === JSON.stringify(withoutCacheControl(withoutSearch(b.tools))),
    prefix: b.messages.length >= a.messages.length,
    raw: true,
    differences: [],
  };
  for (const [index, message] of a.messages.entries()) {
    const next = b.messages[index];
    if (!next || normalized(message) !== normalized(next)) {
      report.prefix = false;
      report.differences.push(`message ${index} (${message.role}) changed: ${normalized(message).slice(0, 300)} -> ${next ? normalized(next).slice(0, 300) : 'missing'}`);
      break;
    }
    if (JSON.stringify(message) !== JSON.stringify(next)) {
      report.raw = false;
      const fields = [...new Set([...Object.keys(message), ...Object.keys(next)])].filter(
        (key) => key !== 'content' && JSON.stringify(message[key]) !== JSON.stringify(next[key]),
      );
      const content = JSON.stringify(message.content) === JSON.stringify(next.content) ? 'content same' : `${shape(message.content)} -> ${shape(next.content)}`;
      report.differences.push(`message ${index} (${message.role}): ${content}${fields.length ? `; other fields differ: ${fields.join(', ')}` : ''}`);
    }
  }
  return report;
}

/** Asserts that every main request continues the one before it; returns the raw notes. */
function assertPrefixChain(requests, label) {
  assert.ok(requests.length >= 2, `${label}: at least two requests`);
  const notes = [];
  for (let index = 1; index < requests.length; index += 1) {
    const report = continuation(requests[index - 1], requests[index]);
    const where = `${label}: request ${index - 1} -> ${index} (${requests[index - 1].model} -> ${requests[index].model})`;
    assert.ok(report.system, `${where}: system prompt changed`);
    // A route switch swaps the web search tool and nothing else.
    if (isDirect(requests[index - 1]) === isDirect(requests[index])) assert.ok(report.tools, `${where}: tool list changed`);
    else assert.ok(report.toolsButSearch, `${where}: tool list changed beyond the web search tool`);
    for (const request of [requests[index - 1], requests[index]]) {
      // Offered (an earlier route's deferred-tool note stays in the history, naming its own).
      assert.ok(searchTool(request).includes(isDirect(request) ? 'WebSearch' : 'mcp__meshy__web_search'), `${where}: the route's own web search`);
      if (!isDirect(request)) assert.ok(!(request.body.tools || []).some((tool) => tool.name === 'WebSearch'), `${where}: no WebSearch on a gateway route`);
    }
    assert.ok(report.prefix, `${where}: messages are not a continuation\n${report.differences.join('\n')}`);
    notes.push(...report.differences.map((line) => `${where}: ${line}`));
  }
  return notes;
}

/** The PIDs of Claude Code processes this test process started. */
function childClis() {
  const out = execFileSync('ps', ['--ppid', String(process.pid), '-o', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('stream-json'))
    .map((line) => Number(line.split(/\s+/)[0]));
}

describe('one Claude Code process per session (real CLI, mock gateway)', { skip }, () => {
  test('three turns run in one process; each request extends the previous one; the session id is stable', async (t) => {
    const setup = harness();
    const since = mock.requests.length;
    await runTurn(setup, 'hello');
    await runTurn(setup, '[[mock:bash]] run something');
    await runTurn(setup, '[[mock:thinking]] and think');
    const { session, spawns } = setup;

    assert.equal(spawns.length, 1, 'exactly one CLI launch for three turns');
    assert.deepEqual(childClis().length, 1, 'one CLI process alive');
    assert.deepEqual(session.messages.filter((m) => m.role === 'user').map((m) => m.delivery), ['done', 'done', 'done']);
    assert.equal(footers(session), 3);
    assert.equal(session.status, 'idle');

    const requests = mainRequests(session.sdkSessionId, since);
    assert.ok(requests.length >= 4, `turns and the tool round: ${requests.length}`);
    assert.ok(
      mock.requests.slice(since).filter((request) => request.tools.length).every((request) => request.sessionId === session.sdkSessionId),
      'every request carries the Claude Code session id header',
    );
    const notes = assertPrefixChain(requests, 'one process');
    t.diagnostic(`raw differences hidden by normalizing: ${notes.length ? notes.join(' | ') : 'none'}`);
  });

  test('a gateway model switch is applied in place and keeps the prefix', async (t) => {
    const setup = harness();
    const since = mock.requests.length;
    await runTurn(setup, 'hello');
    setup.session.model = 'deepseek';
    setup.session.efforts.deepseek = 'high';
    await runTurn(setup, 'who are you now?');
    await runTurn(setup, 'and now?');
    const { session, spawns } = setup;

    assert.equal(spawns.length, 1);
    assert.deepEqual(
      spawns[0].controls.filter(([method]) => method !== 'setPermissionMode'),
      [
        ['setModel', 'litellm/DeepSeek-V4-Flash'],
        // DeepSeek and Luna both default to 400k: nothing to apply.
        ['applyFlagSettings', { effortLevel: 'high' }],
      ],
    );
    const requests = mainRequests(session.sdkSessionId, since);
    assert.equal(requests[0].model, 'codex/gpt-6-luna');
    assert.equal(requests.at(-1).model, 'litellm/DeepSeek-V4-Flash');
    const switched = requests.find((request) => request.human.includes('who are you now?'));
    assert.match(switched.human, /\[Harbor: from this message on you are DeepSeek V4.1 Flash .*earlier turns in this conversation ran on GPT-6 Luna\./);
    assert.equal(switched.body.output_config?.effort, 'high', 'the new effort reached the request');
    const notes = assertPrefixChain(requests, 'setModel');
    t.diagnostic(`raw differences: ${notes.length ? notes.join(' | ') : 'none'}`);
    assert.deepEqual(session.messages.filter((m) => m.role === 'turn').map((m) => m.model), ['luna', 'deepseek', 'deepseek']);
  });

  test('a switch to a Claude model and back restarts the process with resume; the session id never changes', async (t) => {
    const setup = harness();
    const since = mock.requests.length;
    await runTurn(setup, 'on luna');
    const sessionId = setup.session.sdkSessionId;
    setup.session.model = 'opus';
    await runTurn(setup, 'on opus');
    setup.session.model = 'sonnet';
    await runTurn(setup, 'on sonnet');
    setup.session.model = 'luna';
    await runTurn(setup, 'back on luna');
    const { session, spawns } = setup;

    assert.equal(spawns.length, 3, 'gateway -> Claude restarts, Claude -> Claude does not, Claude -> gateway restarts');
    assert.equal(spawns[1].options.resume, sessionId);
    assert.equal(spawns[1].options.model, 'claude-opus-5-5');
    assert.deepEqual(spawns[1].controls.filter(([method]) => method === 'setModel'), [['setModel', 'claude-sonnet-5-5']]);
    assert.equal(spawns[2].options.resume, sessionId);
    assert.equal(session.sdkSessionId, sessionId);
    const requests = mainRequests(sessionId, since);
    assert.ok(requests.length >= 4);
    assert.ok(mock.requests.slice(since).filter((request) => request.tools.length).every((request) => request.sessionId === sessionId));
    const notes = assertPrefixChain(requests, 'route switches');
    t.diagnostic(`raw differences: ${notes.length ? notes.join(' | ') : 'none'}`);
    assert.equal(session.messages.filter((m) => m.role === 'notice').length, 0);
  });

  test('a message sent mid-turn reaches the model in the same turn', async () => {
    const setup = harness();
    const { runner, session, spawns } = setup;
    const since = mock.requests.length;
    runner.enqueue(session, { text: '[[mock:bash:sleep 2]] run it' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool' && m.tool === 'Bash'));
    const sent = runner.enqueue(session, { text: 'please also say banana' });
    assert.deepEqual(sent, { queued: false, steering: true });
    const steer = session.messages.find((m) => m.text === 'please also say banana');
    assert.equal(steer.delivery, 'sent');
    await waitFor(() => !runner.isRunning(session.id));

    assert.equal(spawns.length, 1);
    assert.equal(footers(session), 1, 'one turn');
    assert.equal(steer.delivery, 'done');
    assert.deepEqual(session.steering, []);
    const order = session.messages.map((m) => (m.role === 'user' ? m.text : m.role === 'tool' ? `tool:${m.tool}` : m.role));
    assert.ok(order.indexOf('please also say banana') > order.indexOf('tool:Bash'), `shown after the tool it followed: ${order.join(', ')}`);
    const requests = mainRequests(session.sdkSessionId, since);
    const reached = requests.filter((request) => JSON.stringify(request.body.messages).includes('please also say banana'));
    assert.ok(reached.length >= 1, 'the model saw the message');
    assert.ok(requests.indexOf(reached[0]) >= 1, 'in a request after the tool call, not a new turn');
    assert.equal(session.status, 'idle');
  });

  test('a message not read yet can be cancelled and never reaches the model', async () => {
    const setup = harness();
    const { runner, session } = setup;
    runner.enqueue(session, { text: '[[mock:bash:sleep 3]] run it' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool' && m.tool === 'Bash'));
    runner.enqueue(session, { text: 'never mind this one' });
    const steer = session.messages.find((m) => m.text === 'never mind this one');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await runner.cancelQueued(session, steer.id), true);
    assert.equal(steer.delivery, 'cancelled');
    await waitFor(() => !runner.isRunning(session.id));
    assert.ok(!mock.requests.some((request) => JSON.stringify(request.body?.messages ?? []).includes('never mind this one')));
    assert.equal(footers(session), 1);
  });

  test('stop interrupts the turn and keeps the process; the next turn runs in it', async () => {
    const setup = harness();
    const { runner, session, spawns } = setup;
    runner.enqueue(session, { text: '[[mock:slow]] stream slowly' });
    await waitFor(() => session.live.includes('chunk 2'));
    const stoppedAt = Date.now();
    runner.stop(session);
    await waitFor(() => !runner.isRunning(session.id));
    assert.ok(Date.now() - stoppedAt < 4500, 'ended by interrupt(), before the kill grace period');
    assert.equal(session.messages[0].delivery, 'stopped');
    assert.deepEqual(session.messages.filter((m) => m.role === 'notice').map((m) => m.text), [NOTICES.stopped]);
    assert.deepEqual(spawns[0].controls.find(([method]) => method === 'interrupt'), ['interrupt', { cancelQueued: true }]);
    assert.equal(runner.pool.size, 1, 'the process is still there');

    session.queuePaused = false;
    await runTurn(setup, 'after the stop');
    assert.equal(spawns.length, 1);
    assert.equal(session.messages.find((m) => m.text === 'after the stop').delivery, 'done');
    assert.equal(session.status, 'idle');
  });

  test('interrupt and send now: a long step ends, the waiting message is answered at once, background work keeps running', async () => {
    const setup = harness();
    const { runner, session, spawns, work } = setup;
    // A background Bash (sleep 5, then touch bg-done.txt), then a foreground `sleep 60`.
    runner.enqueue(session, { text: '[[mock:bg-then-wait:5]] go' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool' && m.input?.command === 'sleep 60'));
    runner.enqueue(session, { text: 'please say banana' });
    const steer = session.messages.find((m) => m.text === 'please say banana');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(steer.delivery, 'sent', 'waiting for the long step');

    const interruptedAt = Date.now();
    assert.equal(await runner.interrupt(session), true);
    await waitFor(() => steer.delivery === 'done', 10_000);
    assert.ok(Date.now() - interruptedAt < 10_000, 'answered long before the step would have ended');
    assert.deepEqual(spawns[0].controls.find(([method]) => method === 'interrupt'), ['interrupt'], 'a plain interrupt, without cancelQueued');
    const main = session.messages.find((m) => m.text === '[[mock:bg-then-wait:5]] go');
    assert.equal(main.delivery, 'interrupted');
    const order = session.messages.map((m) => (m.role === 'user' ? m.text : m.role));
    assert.ok(order.indexOf('please say banana') < order.lastIndexOf('assistant'), `answered after it: ${order.join(', ')}`);
    assert.ok(mock.requests.some((request) => JSON.stringify(request.body?.messages ?? []).includes('please say banana')), 'the model saw it');

    // The background command was not interrupted with the step.
    await waitFor(() => fs.existsSync(path.join(work, 'bg-done.txt')), 15_000);
    await waitFor(() => !runner.isRunning(session.id));
    assert.equal(spawns.length, 1);
    assert.equal(session.status, 'idle', 'not error');
    assert.equal(session.queuePaused, false);
    assert.deepEqual(session.steering, []);
    const notices = session.messages.filter((m) => m.role === 'notice');
    assert.deepEqual(notices.map(({ text, level }) => [text, level]), [[NOTICES.interrupted, 'info']]);
    const footers = session.messages.filter((m) => m.role === 'turn');
    assert.equal(footers[0].interrupted, true);
    assert.ok(footers.every((footer) => !footer.isError));
  });

  test('an idle process closes; the next turn resumes it with the same prefix and session id', async (t) => {
    const setup = harness({ idleMs: 400 });
    const { runner, session, spawns } = setup;
    const since = mock.requests.length;
    await runTurn(setup, 'hello');
    await waitFor(() => runner.pool.size === 0, 10_000);
    assert.deepEqual(childClis(), [], 'the CLI exited');
    assert.ok(!spawns[0].controls.some(([method]) => method === 'close'), 'closed by ending its input');
    await runTurn(setup, 'hello after a pause');
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].options.resume, session.sdkSessionId);
    const requests = mainRequests(session.sdkSessionId, since);
    assert.equal(requests.length, 2);
    const notes = assertPrefixChain(requests, 'idle restart');
    t.diagnostic(`raw differences: ${notes.length ? notes.join(' | ') : 'none'}`);
    assert.equal(session.messages.filter((m) => m.role === 'notice').length, 0);
  });

  test('a crash mid-turn settles the turn with a notice; the next turn resumes in a new process', async () => {
    const setup = harness();
    const { runner, session, spawns } = setup;
    await runTurn(setup, 'hello');
    runner.enqueue(session, { text: '[[mock:slow]] stream slowly' });
    await waitFor(() => session.live.includes('chunk 2'));
    const [pid] = childClis();
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !runner.isRunning(session.id));
    assert.equal(session.status, 'error');
    assert.equal(session.queuePaused, true);
    assert.equal(session.messages.find((m) => m.text.startsWith('[[mock:slow]]')).delivery, 'error');
    const notice = session.messages.find((m) => m.role === 'notice');
    assert.equal(notice.level, 'error');
    assert.ok(notice.text.length > 0);

    await runTurn(setup, 'are you back?');
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].options.resume, session.sdkSessionId);
    assert.equal(session.messages.find((m) => m.text === 'are you back?').delivery, 'done');
    assert.equal(session.status, 'idle');
  });
});
