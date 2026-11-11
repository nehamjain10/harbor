// Model agents end to end: real Claude Code processes (the session's and each worker's)
// through the runner, the normalizing proxy and the mock gateway (the `delegate` and
// `worker` scripts in mock-gateway.mjs). Fan-out and fan-in on three models at once
// (timed: the wall time is about one worker's, not the sum), reports arriving by
// themselves, approvals from a worker, worktree isolation, stopping one worker and the
// whole session. Steering: the lead's message folded into a worker at its next step, and
// one that arrives as the worker streams its final answer (a turn of its own). Plus two facts the design rests on: Claude Code runs MCP calls from one
// message concurrently only when they are marked read-only, and native subagents of a
// gateway model run in parallel. Isolated: no settings sources, a throwaway
// CLAUDE_CONFIG_DIR, gateway models only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { DELEGATE_TOOL } from '../../server/model-agents.mjs';
import { sdkEnv } from '../../server/models.mjs';
import { createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startMockGateway } from '../mock-gateway.mjs';
import { closeRunners, observedQuery } from './helpers.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TURN_TIMEOUT_MS = 90_000;

let base;
let mock;
let proxy;
const runners = [];

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-model-agents-'));
  mock = await startMockGateway();
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
});

afterEach(() => closeRunners(runners));

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** A runner wired like server.mjs over its own folder and config dir (gateway models only). */
function harness({ model = 'luna', mode = 'bypassPermissions', idleMs, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const work = path.join(dir, 'work');
  const claudeConfigDir = path.join(dir, 'claude-config');
  const worktreesDir = path.join(dir, 'worktrees');
  fs.mkdirSync(work);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\n');
  if (git) {
    const run = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });
    run('init', '-q', '-b', 'main');
    run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '-A');
    run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
  }
  const store = createStore({ dataDir: path.join(dir, 'data') });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const query = observedQuery({
    beforeSpawn: ({ options }) => {
      options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      assert.equal(options.env.ANTHROPIC_BASE_URL, proxy.url, 'never a real model');
    },
  });
  const config = { claudeExecutable: CLAUDE, gatewayUrl: mock.url, settingSources: [], claudeConfigDir, worktreesDir };
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, query, idleMs, log: () => {} });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: work, model, mode }));
  return { runner, session, spawns: query.spawns, work, worktreesDir };
}

async function waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const footers = (session) => session.messages.filter((m) => m.role === 'turn').length;
const workers = (session) => session.messages.filter((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL);
const childrenOf = (session, toolId) => session.messages.filter((m) => m.parentToolId === toolId);
const agentNotices = (session) => session.messages.filter((m) => m.role === 'notice' && m.agentToolId);
const lastReply = (session) => session.messages.findLast((m) => m.role === 'assistant' && !m.parentToolId)?.text ?? '';
const idle = (runner, session, turns) => () => footers(session) >= turns && !runner.isRunning(session.id);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

describe('model agents (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('three workers on three models run in parallel; wait_agents collects them (wall time about one worker, not the sum)', async () => {
    const { runner, session, spawns } = harness();
    const started = Date.now();
    runner.enqueue(session, { text: '[[mock:delegate:luna,deepseek,sol;wait;sleep=3]] split the work' });
    await waitFor(idle(runner, session, 1));
    const wall = Date.now() - started;

    const cards = workers(session);
    assert.deepEqual(cards.map((card) => card.agentModel), ['luna', 'deepseek', 'sol']);
    const bashes = [];
    for (const card of cards) {
      assert.equal(card.state, 'done', card.output);
      assert.match(card.agentId, new RegExp(`^${card.agentModel}-[0-9a-f]{6}$`));
      assert.equal(card.background, true);
      assert.match(card.output, /Worker finished\. Tool result: ok — worker-ok/);
      assert.match(card.output, /Commands \(1\): `sleep 3 && echo worker-ok`/);
      assert.equal(card.usage.toolUses, 1);
      assert.ok(card.usage.tokens > 0);
      const [bash] = childrenOf(session, card.toolId).filter((m) => m.role === 'tool');
      assert.equal(bash.tool, 'Bash');
      assert.equal(bash.state, 'done');
      bashes.push(bash);
      assert.ok(childrenOf(session, card.toolId).some((m) => m.role === 'assistant' && /Worker finished/.test(m.text)), 'the worker’s reply is nested');
    }
    // Every worker's 3-second command was running at the same moment.
    const latestStart = Math.max(...bashes.map((m) => m.at));
    const earliestEnd = Math.min(...bashes.map((m) => m.endedAt));
    assert.ok(latestStart < earliestEnd, `the three commands overlap (${latestStart} < ${earliestEnd})`);
    const sum = cards.reduce((total, card) => total + card.usage.durationMs, 0);
    const longest = Math.max(...cards.map((card) => card.usage.durationMs));
    console.log(`# 3 workers: wall ${wall} ms, longest worker ${longest} ms, sum ${sum} ms`);
    assert.ok(wall < sum * 0.7, `wall ${wall} ms is well under the sum ${sum} ms`);
    assert.ok(wall < longest + 6000, `wall ${wall} ms is about the longest worker (${longest} ms)`);

    // wait_agents returned the reports, so none arrives again by itself.
    assert.match(lastReply(session), /^Tool result: ok — GPT-6 Luna agent luna-[0-9a-f]{6} “Part 1” finished/);
    assert.deepEqual(agentNotices(session), []);
    await sleep(500);
    assert.equal(footers(session), 1);

    // One process for the session (pooled), one per worker (not pooled), each on its model.
    assert.equal(runner.pool.size, 1);
    assert.equal(spawns.length, 4);
    assert.deepEqual(spawns.slice(1).map((spawn) => spawn.options.model).sort(), ['codex/gpt-6-luna', 'codex/gpt-6.1-sol', 'litellm/DeepSeek-V4-Flash']);
    assert.ok(spawns[0].options.mcpServers?.meshy, 'the session gets the Harbor tools');
    // Workers cannot delegate; on gateway routes they only get Harbor's web_search.
    for (const spawn of spawns.slice(1)) assert.deepEqual(Object.keys(spawn.options.mcpServers?.meshy?.instance._registeredTools ?? {}), ['web_search'], 'workers cannot delegate');
    assert.ok(mock.requests.some((r) => r.model === 'codex/gpt-6.1-sol' && /\[\[mock:worker:3\]\] Do part-3\./.test(r.human)));
    assert.deepEqual(Object.keys(session.totals.models).sort(), ['deepseek', 'luna', 'sol']);
    assert.equal(publicSession(session).backgroundAgents, 0);
  });

  test('a worker the main model does not wait for reports by itself: a notice and a turn of its own', async () => {
    const { runner, session } = harness({ model: 'deepseek', idleMs: 300 });
    runner.enqueue(session, { text: '[[mock:delegate:luna;sleep=2]] start it and carry on' });
    await waitFor(idle(runner, session, 1));
    const [card] = workers(session);
    assert.equal(card.state, 'running', 'the turn ended; the worker goes on');
    assert.match(lastReply(session), /^Tool result: ok — Started worker luna-[0-9a-f]{6} \(GPT-6 Luna agent, “Part 1”\)/);
    assert.equal(session.status, 'idle');
    assert.equal(publicSession(session).backgroundAgents, 1);
    await sleep(800);
    assert.equal(runner.pool.size, 1, 'the idle close waits for the worker');

    await waitFor(() => card.state !== 'running');
    assert.equal(card.state, 'done');
    const [notice] = agentNotices(session);
    assert.equal(notice.text, 'GPT-6 Luna agent “Part 1” finished.');
    assert.equal(notice.agentToolId, card.toolId);
    // The main model reads the report in a turn Claude Code starts for it.
    await waitFor(idle(runner, session, 2));
    const report = mock.requests.find((r) => r.model === 'litellm/DeepSeek-V4-Flash' && r.human.startsWith('[GPT-6 Luna agent finished]'));
    assert.ok(report, 'the report reached the main model');
    assert.match(report.human, /Worker finished\./);
    assert.ok(session.messages.indexOf(notice) < session.messages.findLastIndex((m) => m.role === 'turn'));
    await waitFor(() => runner.pool.size === 0, 10_000);
  });

  test('a worker asks for approval through the session, named by its model', async () => {
    const { runner, session, work } = harness({ mode: 'default' });
    runner.enqueue(session, { text: '[[mock:delegate:luna;ask;wait;sleep=1]] start a worker that asks' });
    const answered = new Set();
    const asked = [];
    // The worker's `touch` asks (`sleep && echo` is read-only; delegate and wait_agents never ask).
    while (!(footers(session) >= 1 && !runner.isRunning(session.id))) {
      await waitFor(() => session.pending?.some((p) => !answered.has(p.id)) || (footers(session) >= 1 && !runner.isRunning(session.id)));
      for (const pending of session.pending || []) {
        if (answered.has(pending.id)) continue;
        answered.add(pending.id);
        assert.equal(pending.tool, 'Bash');
        asked.push(pending.input.command);
        assert.equal(pending.agent.subagentType, 'GPT-6 Luna agent');
        assert.equal(pending.agent.description, 'Part 1');
        assert.equal(pending.agent.toolId, workers(session)[0].toolId);
        assert.equal(runner.resolveApproval(pending.id, { decision: 'allow' }), true);
      }
    }
    assert.deepEqual(asked, ['touch part-1.txt']);
    assert.equal(workers(session)[0].state, 'done');
    assert.ok(fs.existsSync(path.join(work, 'part-1.txt')));
  });

  test('isolation "worktree": a worker that changed files leaves a branch to merge; one that did not leaves nothing', async () => {
    const { runner, session, work, worktreesDir } = harness({ git: true });
    runner.enqueue(session, { text: '[[mock:delegate:luna;worktree;edit;wait]] isolated edit' });
    await waitFor(idle(runner, session, 1));
    const [card] = workers(session);
    assert.equal(card.state, 'done', card.output);
    const branch = `harbor/${card.agentId}`;
    assert.deepEqual(card.worktree, { branch, path: path.join(worktreesDir, `work-${card.agentId}`), commits: 1 });
    assert.match(card.output, new RegExp(`Worktree: branch \`${branch}\` at .*, 1 commit on top of [0-9a-f]{12}`));
    assert.match(card.output, /part-1\.txt \| 1 \+/);
    assert.match(card.output, /Files changed: `part-1\.txt`/);
    // The work is on the branch, not in the session's folder.
    assert.ok(!fs.existsSync(path.join(work, 'part-1.txt')));
    assert.equal(git(work, 'show', `${branch}:part-1.txt`), 'written by a worker');
    assert.equal(git(work, 'status', '--porcelain'), '', 'the main checkout is untouched');
    assert.match(lastReply(session), /Tool result: ok — GPT-6 Luna agent/);

    runner.enqueue(session, { text: '[[mock:delegate:deepseek;worktree;wait]] isolated, no edits' });
    await waitFor(idle(runner, session, 2));
    const second = workers(session)[1];
    assert.equal(second.state, 'done');
    assert.deepEqual(second.worktree, { removed: true });
    assert.match(second.output, /no changes, so its worktree and branch were removed/);
    assert.equal(git(work, 'branch', '--list', `harbor/${second.agentId}`), '');
    assert.ok(!fs.existsSync(path.join(worktreesDir, `work-${second.agentId}`)));
    assert.match(git(work, 'worktree', 'list'), new RegExp(card.agentId), 'the first one stays for review');
  });

  test('isolation "worktree" outside a git repository is refused with a reason', async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:delegate:luna;worktree;wait]] isolated' });
    await waitFor(idle(runner, session, 1));
    const [card] = workers(session);
    assert.equal(card.state, 'error');
    assert.match(card.output, /needs a git repository/);
    assert.equal(card.agentId, undefined);
  });

  test('stopping one worker ends only it (and tells the main model); Stop ends the rest silently', async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:delegate:luna,deepseek;sleep=30]] two long workers' });
    await waitFor(idle(runner, session, 1));
    const [first, second] = workers(session);
    await waitFor(() => childrenOf(session, first.toolId).length > 0 && childrenOf(session, second.toolId).length > 0);
    assert.equal(runner.modelAgents.running(session.id), 2);

    assert.equal(await runner.stopAgent(session, first.toolId), true);
    await waitFor(() => first.state !== 'running', 10_000);
    assert.equal(first.state, 'error');
    assert.equal(first.stopped, true);
    assert.match(first.output, /Stopped by the user before it finished\./);
    assert.equal(childrenOf(session, first.toolId).find((m) => m.tool === 'Bash').state, 'error', 'its command ended with it');
    assert.equal(second.state, 'running');
    assert.deepEqual((await runner.stopAgent(session, first.toolId)).status, 409);
    // The main model hears about it in a turn of its own.
    await waitFor(idle(runner, session, 2));
    assert.ok(mock.requests.some((r) => r.human.startsWith('[GPT-6 Luna agent stopped]')));

    runner.stop(session);
    await waitFor(() => second.state !== 'running', 10_000);
    assert.equal(second.stopped, true);
    assert.equal(runner.modelAgents.running(session.id), 0);
    await sleep(800);
    assert.equal(footers(session), 2, 'Stop reports nothing back');
    assert.ok(!mock.requests.some((r) => r.human.startsWith('[DeepSeek V4.1 Flash agent')));
  });

  test('Stop while the main model waits for its workers ends the turn and the workers', async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:delegate:luna;wait;sleep=30]] wait for a long worker' });
    const [card] = await (async () => {
      await waitFor(() => workers(session)[0] && childrenOf(session, workers(session)[0].toolId).length > 0);
      return workers(session);
    })();
    assert.ok(runner.isRunning(session.id), 'the turn is waiting in wait_agents');
    const stoppedAt = Date.now();
    runner.stop(session);
    await waitFor(() => !runner.isRunning(session.id) && card.state !== 'running', 15_000);
    assert.ok(Date.now() - stoppedAt < 8000, 'the wait did not hold up the stop');
    assert.equal(card.stopped, true);
    assert.equal(session.messages.find((m) => m.role === 'turn')?.stopped, true);
    await sleep(800);
    assert.equal(footers(session), 1);
  });
});

describe('steering model agents (real Claude Code CLI, mock gateway)', { skip }, () => {
  /** A worker started the way delegate does, on a card of its own. */
  async function startWorker(runner, session, task) {
    session.messages.push({ id: 'card-1', role: 'tool', tool: DELEGATE_TOOL, toolId: 'toolu_steer', input: {}, state: 'running', at: Date.now() });
    await runner.modelAgents.tools(session).delegate({ model: 'luna', task }, { _meta: { 'claudecode/toolUseId': 'toolu_steer' } });
    return session.messages.find((m) => m.toolId === 'toolu_steer');
  }
  const lunaRequest = (predicate) => mock.requests.find((r) => r.model === 'codex/gpt-6-luna' && predicate(r));
  const toWorker = (session) => session.messages.filter((m) => m.role === 'user' && m.parentToolId === 'toolu_steer');

  test('a message to a worker in the middle of a command is read at its next step, folded into the turn', async () => {
    const { runner, session } = harness();
    const first = mock.requests.length;
    const card = await startWorker(runner, session, '[[mock:worker:3]] Work for a while.');
    await waitFor(() => childrenOf(session, 'toolu_steer').some((m) => m.tool === 'Bash'));
    const message = runner.messageAgent(session, 'toolu_steer', { text: 'Also mention steering-ok.', clientId: 'c1' });
    assert.equal(typeof message.messageId, 'string');
    assert.equal(toWorker(session)[0].delivery, 'sent', 'the command is still running');
    await waitFor(() => card.state !== 'running');
    assert.equal(card.state, 'done');
    assert.deepEqual(toWorker(session).map((m) => [m.from, m.text, m.delivery]), [['user', 'Also mention steering-ok.', 'done']]);
    // Folded into the turn the command was part of: the model's next request carries it, as a note after the tool result.
    const folded = lunaRequest((r) => r.notes.some((note) => note.includes('[Message from the user]') && note.includes('Also mention steering-ok.')));
    assert.ok(folded, 'the next request carries the message');
    assert.equal(mock.requests.slice(first).filter((r) => r.model === 'codex/gpt-6-luna' && r.tools?.length).length, 2, 'no turn of its own for it');
  });

  test('a worker whose turn ends with a background command running waits for it, taking messages, and finishes after the command’s turn', async () => {
    const { runner, session } = harness();
    // Five one-second ticks in the background; the worker's turn ends at once ("Started.").
    const card = await startWorker(runner, session, '[[mock:bg:5]] Start ticking.');
    const ticking = () => {
      try {
        return execFileSync('pgrep', ['-u', String(process.getuid()), '-f', 'seq 1 5;'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    await waitFor(() => childrenOf(session, 'toolu_steer').some((m) => m.role === 'assistant' && m.text === 'Started.'));
    const startedAt = Date.now();
    await waitFor(() => card.progress?.waitingOn === 1, 5_000);
    assert.equal(card.state, 'running', 'its command will wake it');
    assert.equal(card.progress.description, 'Waiting on 1 background task');
    // A message between turns is taken at once and answered.
    const sent = runner.messageAgent(session, 'toolu_steer', { text: 'Now say ok. [[mock:text]]' });
    assert.equal(typeof sent.messageId, 'string', JSON.stringify(sent));
    await waitFor(() => toWorker(session)[0]?.delivery === 'done', 10_000);
    await waitFor(() => card.state !== 'running', 30_000);
    assert.ok(Date.now() - startedAt >= 3_000, 'not before its command ended');
    assert.equal(card.state, 'done', card.output);
    assert.equal(card.stopped, undefined);
    await waitFor(() => ticking().length === 0, 5_000);
    assert.equal(runner.messageAgent(session, 'toolu_steer', { text: 'Too late.' }).status, 409);
  });

  test('a message that arrives as the worker streams its final answer gets a turn of its own before the worker ends', async () => {
    const { runner, session } = harness();
    const card = await startWorker(runner, session, '[[mock:slow]] Stream for a while.');
    // The model is answering (the mock streams for about 3 s): the turn is past its last step.
    await waitFor(() => lunaRequest((r) => /Stream for a while/.test(r.human)));
    await sleep(1000);
    assert.equal(card.state, 'running');
    runner.messageAgent(session, 'toolu_steer', { text: 'Now say ok. [[mock:text]]' });
    await waitFor(() => card.state !== 'running');
    assert.equal(card.state, 'done', card.output);
    assert.deepEqual(toWorker(session).map((m) => [m.from, m.delivery]), [['user', 'done']]);
    // The message started a turn: its own request, with the message as the user's words.
    assert.ok(lunaRequest((r) => r.human.startsWith('[Message from the user]\n\nNow say ok.')), 'a turn of its own');
    assert.match(card.output, /^chunk 0 [\s\S]*\n\nAfter a message that reached it as it finished:\n\nok\n\nThe user wrote to it directly \(not through you\): “Now say ok\. \[\[mock:text\]\]”$/, 'the report keeps both answers');
    assert.ok(childrenOf(session, 'toolu_steer').some((m) => m.role === 'assistant' && m.text === 'ok'));
  });
});

describe('parallelism in Claude Code itself (real CLI, mock gateway)', { skip }, () => {
  test('MCP calls from one message run concurrently only when the tool is marked read-only', async () => {
    const dir = fs.mkdtempSync(path.join(base, 'mcp-'));
    const claudeConfigDir = path.join(dir, 'claude-config');
    fs.mkdirSync(claudeConfigDir);
    const spans = [];
    const slow = (name, readOnly) =>
      tool(
        name,
        'Sleeps 2 seconds',
        { index: z.number().optional() },
        async (args, extra) => {
          const start = Date.now();
          await sleep(2000);
          spans.push({ name, start, end: Date.now(), toolUseId: extra?._meta?.['claudecode/toolUseId'] });
          return { content: [{ type: 'text', text: `done ${args.index}` }] };
        },
        readOnly ? { annotations: { readOnlyHint: true } } : {},
      );
    const wall = {};
    for (const name of ['slow_rw', 'slow_ro']) {
      const server = createSdkMcpServer({ name: 'probe', tools: [slow('slow_rw', false), slow('slow_ro', true)] });
      const env = { ...sdkEnv(false, { gatewayUrl: proxy.url, apiKey: proxy.secret, claudeConfigDir }), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const started = Date.now();
      const stream = query({
        prompt: `[[mock:tools:mcp__probe__${name}*2]] go`,
        options: { cwd: dir, model: 'codex/gpt-6-luna', pathToClaudeCodeExecutable: CLAUDE, env, settingSources: [], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, mcpServers: { probe: server }, persistSession: false },
      });
      for await (const message of stream) if (message.type === 'result') assert.equal(message.is_error, false);
      wall[name] = Date.now() - started;
    }
    const [rw1, rw2, ro1, ro2] = spans;
    assert.ok(rw2.start >= rw1.end - 5, 'not read-only: one after the other');
    assert.ok(Math.abs(ro1.start - ro2.start) < 500, 'read-only: both at once');
    assert.ok(spans.every((span) => /^toolu_mock_/.test(span.toolUseId)), 'the handler gets the tool_use id in _meta');
    console.log(`# two 2 s MCP calls in one message: not read-only ${wall.slow_rw} ms, read-only ${wall.slow_ro} ms`);
  });

  test('native subagents of a gateway model run in parallel (two Agent calls in one message)', async () => {
    const { runner, session } = harness({ model: 'sol' });
    const started = Date.now();
    runner.enqueue(session, { text: '[[mock:agents:foreground]] two at once' });
    await waitFor(idle(runner, session, 1));
    const wall = Date.now() - started;
    const agents = session.messages.filter((m) => m.role === 'tool' && m.tool === 'Agent');
    assert.equal(agents.length, 2);
    // "First probe" takes 2 s, "Second probe" 4 s after its command: one after the other would be 6 s+.
    const [first, second] = agents;
    const secondCommand = childrenOf(session, second.toolId).find((m) => m.role === 'tool');
    assert.ok(secondCommand.at < first.endedAt, 'the second agent was working before the first ended');
    console.log(`# two foreground Agent calls (2 s + 4 s) on a gateway model: wall ${wall} ms`);
    assert.ok(wall < 6000 + 1500, `wall ${wall} ms`);
  });
});
