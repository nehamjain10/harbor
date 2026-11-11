// Model agents with fake Claude Code processes (fake-cli.mjs): which card a worker
// belongs to (tool_use id from `_meta`, or by input), its steps nested under that card,
// the report and usage, wait_agents, reports delivered by themselves, approvals, stop,
// and the session's process staying up while workers run. Steering: message_agent,
// stop_agent and check_agents, the messages recorded under the card (sent, then done when
// the process takes them), and a message arriving as the worker gives its final answer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createEvents } from '../server/events.mjs';
import { DELEGATE_TOOL, MODEL_AGENT_TOOLS, createModelAgents, createWorktree, finishWorktree, modelAgentList, remoteMachine } from '../server/model-agents.mjs';
import { createRunner } from '../server/runner.mjs';
import { createSession, createStore, publicSession } from '../server/store.mjs';
import { createFakeCli, successResult } from './fake-cli.mjs';

const tempDirs = [];
const runners = [];

afterEach(async () => {
  while (runners.length) {
    const runner = runners.pop();
    runner.shutdown();
    await waitFor(() => runner.pool.size === 0);
    await sleep(5);
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

const toolUse = (id, name, input, parent = null) => ({ type: 'assistant', uuid: 'u-' + id, parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content = 'ok', isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});
const say = (text, usage) => ({ type: 'assistant', uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } });
const meta = (id) => ({ _meta: { 'claudecode/toolUseId': id } });
const textOf = (result) => result.content.map((block) => block.text).join('\n');
// The tool names an in-process (SDK) MCP server offers.
const registeredTools = (server) => Object.keys(server.instance._registeredTools);
// A worker's process (its own system prompt), as opposed to the session's.
const isWorker = (options) => /running as a worker agent/.test(options.systemPrompt?.append || '');
const cards = (session) => session.messages.filter((m) => m.role === 'tool' && m.tool === DELEGATE_TOOL);

// A stand-in for ssh that runs the remote command here (as tests/fake-ssh.mjs does), with
// the status of a failed command as ssh's error code.
const localSsh = (host, script) => {
  try {
    return Promise.resolve(execFileSync('sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));
  } catch (error) {
    return Promise.reject(Object.assign(new Error(String(error.stderr || '').trim() || `exit ${error.status}`), { code: error.status }));
  }
};

/** A git repository with one commit (temporary). */
function gitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-git-'));
  tempDirs.push(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return repo;
}

// Worker processes run tasks like "work <name>": a Bash call, then (once `gates[name]`
// opens, if there is one) a final answer with usage and cost. A name starting with `fold`
// reads the messages waiting for it before it answers, as Claude Code does between steps;
// the others leave them to a turn of their own, which answers the message.
function workerScript(gates) {
  return async function* (turn) {
    const steer = /^\[Message from the (lead agent|user)\]\n\n([\s\S]*)$/.exec(turn.text);
    if (steer) {
      // Whether the worker's input was already closed when this turn ran (it must not be).
      await sleep(20);
      turn.proc.inputClosedDuringReply = turn.proc.inputEnded;
      yield say(`Answering ${steer[1]}: ${steer[2]}`);
      yield successResult({ result: `Answered ${steer[1]}: ${steer[2]}`, total_cost_usd: 0.03, modelUsage: { m: { outputTokens: 70 } } });
      return;
    }
    const name = turn.text.replace(/^work /, '');
    const id = `bash-${name}`;
    yield toolUse(id, 'Bash', { command: `echo ${name}` });
    yield toolResult(id, name);
    if (name.startsWith('edit')) {
      yield toolUse(`write-${name}`, 'Write', { file_path: path.join(turn.options.cwd, `${name}.txt`), content: 'x' });
      yield toolResult(`write-${name}`, 'written');
    }
    if (name.startsWith('ask')) await turn.tool('Bash', { command: 'touch asked.txt' }, `ask-${name}`);
    if (gates[name]) await gates[name].promise;
    const read = name.startsWith('fold') ? turn.fold() : [];
    const answer = `Worker ${name} done.${read.length ? ` Read: ${read.join(' | ')}` : ''}`;
    yield say(answer, { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 });
    yield successResult({ result: answer, total_cost_usd: 0.02, modelUsage: { m: { outputTokens: 50 } } });
  };
}

/**
 * A runner whose session process runs `main(turn, ctx)` and whose model agents run
 * workerScript. `ctx.delegate(args, id)` makes the main model call delegate like
 * Claude Code does: the tool_use in the transcript, the handler, then the result.
 */
function setup(main, { mode = 'bypassPermissions', idleMs, gates = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-model-agents-'));
  tempDirs.push(dataDir);
  const store = createStore({ dataDir });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession, throttleMs: 1 });
  const worker = workerScript(gates);
  let runner;
  let session;
  const ctx = {
    async *delegate(args, id = `toolu_${crypto.randomUUID().slice(0, 8)}`) {
      yield toolUse(id, DELEGATE_TOOL, args);
      // Claude Code runs the tool after reporting the call; the report may still be on its way.
      const result = await runner.modelAgents.tools(session).delegate(args, meta(id));
      yield toolResult(id, textOf(result), Boolean(result.isError));
      ctx.last = result;
    },
    /** Any of the Harbor tools (message_agent, stop_agent, check_agents) as a tool call of the main model. */
    async *call(name, args, id = `toolu_${crypto.randomUUID().slice(0, 8)}`) {
      yield toolUse(id, `mcp__meshy__${name}`, args);
      const result = await runner.modelAgents.tools(session)[name](args, {});
      yield toolResult(id, textOf(result), Boolean(result.isError));
      ctx.last = result;
    },
    async *wait(args = {}, id = `toolu_${crypto.randomUUID().slice(0, 8)}`) {
      yield toolUse(id, 'mcp__meshy__wait_agents', args);
      const result = await runner.modelAgents.tools(session).wait_agents(args, {});
      yield toolResult(id, textOf(result));
      ctx.last = result;
    },
  };
  const cli = createFakeCli((turn) => (isWorker(turn.options) ? worker(turn) : main(turn, ctx)));
  const config = { gatewayUrl: 'http://127.0.0.1:9', claudeExecutable: '/nonexistent/claude', worktreesDir: path.join(dataDir, 'worktrees') };
  runner = createRunner({ config, events, query: cli.query, idleMs, closeGraceMs: 50, log: () => {} });
  runners.push(runner);
  session = store.insert(createSession({ cwd: dataDir, model: 'astra', mode }));
  const mainProcesses = () => cli.processes.filter((proc) => !isWorker(proc.options));
  const workerProcesses = () => cli.processes.filter((proc) => isWorker(proc.options));
  return { runner, session, cli, ctx, mainProcesses, workerProcesses, dataDir };
}

const settled = (runner, session) => () => !runner.isRunning(session.id) && session.status !== 'running';

describe('model agents in the runner', () => {
  test('the session process gets the Harbor tools, allowed without asking; workers get neither, only web_search on a gateway route', async () => {
    const gates = { a: gate() };
    const { runner, session, mainProcesses, workerProcesses } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') yield* ctx.delegate({ model: 'luna', task: 'work a', description: 'Part A' });
      yield say('ok');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => workerProcesses().length === 1);
    const [main] = mainProcesses();
    assert.equal(main.options.mcpServers.meshy.type, 'sdk');
    assert.deepEqual(main.options.allowedTools, ['mcp__meshy__delegate', 'mcp__meshy__wait_agents', 'mcp__meshy__message_agent', 'mcp__meshy__stop_agent', 'mcp__meshy__check_agents']);
    assert.deepEqual(main.options.allowedTools, MODEL_AGENT_TOOLS);
    const [worker] = workerProcesses();
    // Gateway routes have no working WebSearch: the worker searches through Harbor's web_search.
    assert.deepEqual(Object.keys(worker.options.mcpServers), ['meshy']);
    assert.deepEqual(registeredTools(worker.options.mcpServers.meshy), ['web_search']);
    assert.deepEqual(registeredTools(main.options.mcpServers.meshy), ['delegate', 'wait_agents', 'message_agent', 'stop_agent', 'check_agents', 'web_search']);
    assert.equal(worker.options.model, 'codex/gpt-6-luna');
    assert.equal(worker.options.cwd, session.cwd);
    assert.equal(worker.options.persistSession, true);
    assert.equal(worker.options.resume, undefined);
    assert.deepEqual(worker.options.disallowedTools, ['WebSearch', 'ExitPlanMode', 'EnterPlanMode']);
    assert.match(worker.options.systemPrompt.append, /ask them with AskUserQuestion/);
    assert.match(worker.options.systemPrompt.append, /you are GPT-6 Luna .* running as a worker agent in Harbor/);
    assert.match(worker.options.systemPrompt.append, /lead agent \(GPT-6 Astra\)/);
    assert.match(worker.options.systemPrompt.append, /The lead \(or the user\) may send you messages while you work, marked \[Message from the lead agent\] \/ \[Message from the user\]; read them and adjust\./);
    assert.deepEqual(worker.options.extraArgs, { 'replay-user-messages': null }, 'its process echoes the messages it takes');
    assert.equal(worker.options.permissionMode, 'bypassPermissions');
    assert.equal(worker.received[0].content, 'work a');
    gates.a.open();
    await waitFor(() => cards(session)[0].state === 'done');
  });

  test('the card stays running after the call returns; the worker’s steps nest under it; the report, usage and a notice close it', async () => {
    const gates = { a: gate() };
    const { runner, session, ctx, mainProcesses } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') yield* ctx.delegate({ model: 'luna', task: 'work a', description: 'Part A' }, 'toolu_one');
      yield say(turn.text === 'go' ? 'started' : 'read the report');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));

    const [card] = cards(session);
    assert.equal(card.toolId, 'toolu_one');
    assert.equal(card.state, 'running', 'the tool result does not end the card');
    assert.equal(card.background, true);
    assert.match(card.agentId, /^luna-[0-9a-f]{6}$/);
    assert.equal(card.taskId, card.agentId);
    assert.equal(card.agentModel, 'luna');
    assert.match(textOf(ctx.last), new RegExp(`^Started worker ${card.agentId} \\(GPT-6 Luna agent, “Part A”\\)\\. It works in parallel with you\\.`));
    assert.equal(publicSession(session).backgroundAgents, 1);
    assert.equal(session.status, 'idle');
    await waitFor(() => session.messages.some((m) => m.parentToolId === 'toolu_one' && m.role === 'tool'));
    const bash = session.messages.find((m) => m.parentToolId === 'toolu_one' && m.role === 'tool');
    assert.equal(bash.tool, 'Bash');
    assert.equal(bash.state, 'done');
    assert.equal(card.progress.toolUses, 1);
    assert.equal(session.sdkSessionId, 'sdk-1', 'the worker’s Claude Code session id never replaces the session’s');

    gates.a.open();
    await waitFor(() => card.state === 'done');
    assert.match(card.output, /^Worker a done\.\n\nCommands \(1\): `echo a`$/);
    assert.deepEqual({ ...card.usage, durationMs: 0 }, { tokens: 1050, toolUses: 1, durationMs: 0, cost: 0.02, outputTokens: 50 });
    assert.ok(session.messages.some((m) => m.parentToolId === 'toolu_one' && m.role === 'assistant' && m.text === 'Worker a done.'));
    assert.deepEqual(session.totals.models.luna, { cost: 0.02, outputTokens: 50 });
    const notice = session.messages.find((m) => m.role === 'notice' && m.agentToolId === 'toolu_one');
    assert.equal(notice.text, 'GPT-6 Luna agent “Part A” finished.');

    // The main model gets the report as a message: a turn of its own, the session busy meanwhile.
    await waitFor(() => mainProcesses()[0].received.length === 2);
    const report = mainProcesses()[0].received[1];
    assert.equal(report.priority, 'next');
    assert.match(report.content, /^\[GPT-6 Luna agent finished\] Automatic report from Harbor \(not a message from the user\)/);
    assert.match(report.content, new RegExp(`GPT-6 Luna agent ${card.agentId} “Part A” finished \\(1 tool use · 1\\.1k tokens · \\d+s\\)\\.\\n\\nWorker a done\\.`));
    await waitFor(() => session.messages.filter((m) => m.role === 'turn').length === 2 && settled(runner, session)());
    assert.equal(session.messages.findLast((m) => m.role === 'assistant' && !m.parentToolId).text, 'read the report');
    assert.ok(!session.messages.some((m) => m.role === 'user' && m.text.startsWith('[')), 'the report is not shown as a user message');
  });

  test('a report that arrives while a turn runs is read at its next step', async () => {
    const reports = [];
    const { runner, session, mainProcesses } = setup(async function* (turn, ctx) {
      yield* ctx.delegate({ model: 'deepseek', task: 'work b' });
      // Keep the turn going until the report is in, as Claude Code folds it in between steps.
      await waitFor(() => turn.proc.commands.length > 0);
      reports.push(...turn.fold());
      yield say('saw it');
    });
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => reports.length === 1 && settled(runner, session)());
    assert.match(reports[0], /^\[DeepSeek V4.1 Flash agent finished\]/);
    assert.equal(mainProcesses()[0].received[1].priority, 'next');
    assert.equal(session.messages.filter((m) => m.role === 'turn').length, 1, 'no extra turn');
  });

  test('wait_agents collects the reports; those never arrive again by themselves', async () => {
    const gates = { fast: gate(), slow: gate() };
    const { runner, session, ctx, mainProcesses } = setup(async function* (turn, ctx) {
      if (turn.text !== 'go') return yield say('unexpected');
      yield* ctx.delegate({ model: 'luna', task: 'work fast', description: 'Fast' });
      yield* ctx.delegate({ model: 'sol', task: 'work slow', description: 'Slow' });
      setTimeout(() => gates.fast.open(), 20);
      setTimeout(() => gates.slow.open(), 60);
      yield* ctx.wait();
      yield say('collected');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));
    const output = textOf(ctx.last);
    assert.match(output, /GPT-6 Luna agent luna-[0-9a-f]{6} “Fast” finished \(.*\)\.\n\nWorker fast done\./);
    assert.match(output, /\n\n---\n\nGPT-6\.1 Sol agent sol-[0-9a-f]{6} “Slow” finished/);
    assert.deepEqual(cards(session).map((card) => card.state), ['done', 'done']);
    await sleep(50);
    assert.equal(mainProcesses()[0].received.length, 1, 'nothing delivered after the wait');
    assert.ok(!session.messages.some((m) => m.role === 'notice' && m.agentToolId));
  });

  test('after Stop a worker carries on; its report waits in the paused queue', async () => {
    const gates = { a: gate() };
    const { runner, session, mainProcesses } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') yield* ctx.delegate({ model: 'luna', task: 'work a', description: 'A' });
      yield say('ok');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));
    runner.stop(session);
    gates.a.open();
    await waitFor(() => cards(session)[0].state === 'done');
    await waitFor(() => session.queue?.length === 1);
    assert.match(session.queue[0].text, /^\[GPT-6 Luna agent finished\]/);
    assert.equal(mainProcesses()[0].received.length, 1, 'the main agent is not woken');
  });

  test('the session’s process stays up while a worker runs, then closes when idle', async () => {
    const gates = { a: gate() };
    const { runner, session } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') yield* ctx.delegate({ model: 'luna', task: 'work a' });
      yield say('ok');
    }, { gates, idleMs: 30 });
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));
    await sleep(120);
    assert.equal(runner.pool.size, 1);
    assert.equal(runner.modelAgents.running(session.id), 1);
    gates.a.open();
    await waitFor(() => runner.pool.size === 0);
    assert.equal(session.messages.filter((m) => m.role === 'turn').length, 2, 'the report turn ran before the close');
  });

  test('a worker’s approval goes through the session, labelled with its model; Stop leaves it', async () => {
    const { runner, session } = setup(async function* (turn, ctx) {
      yield* ctx.delegate({ model: 'kimi', task: 'work ask', description: 'Asker' }, 'toolu_ask');
      yield say('ok');
    }, { mode: 'default' });
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => session.pending?.length === 1);
    const [pending] = session.pending;
    assert.equal(pending.tool, 'Bash');
    assert.deepEqual(pending.agent, { toolId: 'toolu_ask', description: 'Asker', subagentType: 'Kimi K3 agent' });
    assert.equal(session.status, 'waiting');

    await waitFor(settled(runner, session) || (() => true));
    runner.stop(session);
    await sleep(30);
    assert.equal(cards(session)[0].state, 'running', 'Stop ends only the main agent');
    assert.deepEqual(session.pending.map((p) => p.id), [pending.id], 'the worker still waits for its answer');
    assert.equal(runner.resolveApproval(pending.id, { decision: 'deny' }), true);
  });

  test('stopping one worker leaves the others; the stop is reported to the main model', async () => {
    const gates = { a: gate(), b: gate() };
    const { runner, session, mainProcesses } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') {
        yield* ctx.delegate({ model: 'luna', task: 'work a' }, 'toolu_a');
        yield* ctx.delegate({ model: 'deepseek', task: 'work b' }, 'toolu_b');
      }
      yield say('ok');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => settled(runner, session)() && runner.modelAgents.running(session.id) === 2);
    assert.equal(await runner.stopAgent(session, 'toolu_a'), true);
    const [a, b] = cards(session);
    await waitFor(() => a.state === 'error');
    assert.equal(a.stopped, true);
    assert.equal(b.state, 'running');
    assert.deepEqual(await runner.stopAgent(session, 'toolu_a'), { status: 409, error: 'This agent is not running.' });
    await waitFor(() => mainProcesses()[0].received.length === 2);
    assert.match(mainProcesses()[0].received[1].content, /^\[GPT-6 Luna agent stopped\]/);
    gates.b.open();
    await waitFor(() => b.state === 'done');
  });

  test('the main model steers a worker: message, check, then wait; the message is the worker’s, never a top-level user message', async () => {
    const gates = { 'fold-a': gate() };
    const seen = {};
    const { runner, session, ctx, mainProcesses, workerProcesses } = setup(async function* (turn, ctx) {
      if (turn.text !== 'go') return yield say('unexpected');
      yield* ctx.delegate({ model: 'luna', task: 'work fold-a', description: 'Part A' });
      const id = /^Started worker (\S+)/.exec(textOf(ctx.last))[1];
      await waitFor(() => workerProcesses()[0]?.received.length === 1);
      yield* ctx.call('message_agent', { id, message: 'Also cover b.txt' });
      seen.message = textOf(ctx.last);
      await waitFor(() => workerProcesses()[0].received.length === 2);
      yield* ctx.call('check_agents', {});
      seen.check = textOf(ctx.last);
      gates['fold-a'].open();
      yield* ctx.wait();
      yield say('collected');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));

    assert.match(seen.message, /^Sent to GPT-6 Luna agent luna-[0-9a-f]{6}; it reads it at its next step\.$/);
    assert.match(seen.check, /“Part A”: running \(1 tool use · \d+s\)\.\nLatest step: Bash `echo fold-a`\nMessages it has not read yet: 1$/);
    const [card] = cards(session);
    const nested = toWorker(session, card.toolId);
    assert.deepEqual(nested.map((m) => [m.text, m.from, m.delivery]), [['Also cover b.txt', 'lead', 'done']]);
    assert.equal(workerProcesses()[0].received[1].content, '[Message from the lead agent]\n\nAlso cover b.txt');
    assert.match(textOf(ctx.last), /Worker fold-a done\. Read: \[Message from the lead agent\]\n\nAlso cover b\.txt/);
    // Only the user's own message is a top-level user message; nothing was handed to the main model by itself.
    assert.deepEqual(session.messages.filter((m) => m.role === 'user' && !m.parentToolId).map((m) => m.text), ['go']);
    assert.equal(mainProcesses()[0].received.length, 1);
    assert.equal(publicSession(session).lastMessageAt, session.messages.find((m) => m.text === 'go').at);
    assert.ok(session.messages.some((m) => m.role === 'tool' && m.tool === 'mcp__meshy__message_agent' && m.state === 'done'));
  });

  test('the lead stops a worker: its partial report is the tool result, no report follows, and the card says who stopped it', async () => {
    const gates = { a: gate() };
    const seen = {};
    const { runner, session, mainProcesses, workerProcesses } = setup(async function* (turn, ctx) {
      if (turn.text !== 'go') return yield say('unexpected');
      yield* ctx.delegate({ model: 'luna', task: 'work a', description: 'Part A' });
      const id = /^Started worker (\S+)/.exec(textOf(ctx.last))[1];
      await waitFor(() => workerProcesses()[0]?.received.length === 1);
      yield* ctx.call('stop_agent', { id, reason: 'not needed any more' });
      seen.stop = textOf(ctx.last);
      yield say('stopped it');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));
    assert.match(seen.stop, /^GPT-6 Luna agent luna-[0-9a-f]{6} “Part A” was stopped \(1 tool use · \d+s\)\.\n\nStopped by the lead: not needed any more\n\nCommands \(1\): `echo a`$/);
    const [card] = cards(session);
    assert.deepEqual([card.state, card.stopped, card.stoppedBy, card.stopReason], ['error', true, 'lead', 'not needed any more']);
    assert.notEqual(session.messages.find((m) => m.parentToolId === card.toolId && m.tool === 'Bash').state, 'running');
    await sleep(60);
    assert.equal(mainProcesses()[0].received.length, 1, 'no automatic report');
    assert.ok(!session.messages.some((m) => m.role === 'notice' && m.agentToolId));
    assert.equal(session.messages.filter((m) => m.role === 'turn').length, 1);
    assert.equal(publicSession(session).backgroundAgents, 0);
  });

  test('messageAgent (the card’s route): unknown and native cards, a worker that is gone, a running one, and Stop dropping what it has not read', async () => {
    const gates = { a: gate() };
    const { runner, session, workerProcesses } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') yield* ctx.delegate({ model: 'luna', task: 'work a' }, 'toolu_w');
      yield say('ok');
    }, { gates });
    session.messages.push(
      { id: 'n1', role: 'tool', tool: 'Agent', toolId: 'toolu_native', input: {}, state: 'running', background: true, taskId: 't1', at: 1 },
      { id: 'n2', role: 'tool', tool: 'Bash', toolId: 'toolu_bash', input: {}, state: 'done', at: 2 },
      { id: 'n3', role: 'tool', tool: DELEGATE_TOOL, toolId: 'toolu_refused', input: {}, state: 'error', at: 3 },
      { id: 'n4', role: 'tool', tool: DELEGATE_TOOL, toolId: 'toolu_gone', input: {}, state: 'error', agentId: 'luna-ffffff', at: 4 },
    );
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => settled(runner, session)() && workerProcesses()[0]?.received.length === 1);

    const body = { text: 'hello', clientId: 'c1' };
    assert.deepEqual(runner.messageAgent(session, 'toolu_nope', body), { status: 404, error: 'Agent not found' });
    assert.deepEqual(runner.messageAgent(session, 'toolu_bash', body), { status: 404, error: 'Agent not found' });
    assert.deepEqual(runner.messageAgent(session, 'toolu_native', body), { status: 409, error: 'Only model agents take messages.' });
    assert.deepEqual(runner.messageAgent(session, 'toolu_refused', body), { status: 409, error: 'This agent is not running.' });
    assert.deepEqual(runner.messageAgent(session, 'toolu_gone', body), { status: 409, error: 'This agent is not running.' });
    assert.deepEqual(runner.messageAgent(session, 'toolu_w', { text: '  ' }), { status: 400, error: 'Write a message first.' });
    const sent = runner.messageAgent(session, 'toolu_w', body);
    assert.equal(typeof sent.messageId, 'string');
    assert.equal(workerProcesses()[0].received.length, 1, 'written to its input asynchronously');
    await waitFor(() => workerProcesses()[0].received.length === 2);
    assert.equal(workerProcesses()[0].received[1].content, '[Message from the user]\n\nhello');
    assert.equal(session.messages.find((m) => m.id === sent.messageId).delivery, 'sent');

    // The user's Stop ends the main agent only: the worker keeps taking messages.
    runner.stop(session);
    await sleep(30);
    assert.equal(session.messages.find((m) => m.toolId === 'toolu_w').state, 'running');
    const more = runner.messageAgent(session, 'toolu_w', { text: 'one more', clientId: 'c2' });
    assert.equal(typeof more.messageId, 'string');
    await waitFor(() => workerProcesses()[0].received.length === 3);
  });

  test('a crash of the session’s process leaves workers running', async () => {
    const gates = { a: gate() };
    const { runner, session, mainProcesses } = setup(async function* (turn, ctx) {
      if (turn.text === 'go') yield* ctx.delegate({ model: 'luna', task: 'work a' }, 'toolu_a');
      yield say('ok');
    }, { gates });
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => settled(runner, session)() && session.messages.some((m) => m.parentToolId === 'toolu_a'));
    mainProcesses()[0].crash();
    await waitFor(() => runner.pool.size === 0);
    const [card] = cards(session);
    assert.equal(card.state, 'running');
    assert.equal(session.messages.find((m) => m.parentToolId === 'toolu_a').state, 'done');
    // With no process to tell, the report waits in the queue and starts a turn.
    gates.a.open();
    await waitFor(() => card.state === 'done' && mainProcesses().length === 2);
    assert.match(mainProcesses()[1].received[0].content, /^\[GPT-6 Luna agent finished\]/);
  });
});

/** createModelAgents alone, with workers on fake processes. */
function bare({ gates = {}, attachWaitMs = 200, maxRunning, cwd = os.tmpdir(), behavior, query, stopWaitMs, dropWaitMs, exitWaitMs, cluster, machineFor } = {}) {
  const cli = createFakeCli(workerScript(gates), behavior);
  const delivered = [];
  const published = [];
  const session = createSession({ cwd, model: 'opus', mode: 'bypassPermissions', cluster });
  const agents = createModelAgents({
    query: query ?? cli.query,
    queryOptions: (s, { model, cwd, abortController, canUseTool }) => ({ model: model.model, cwd, abortController, canUseTool, settings: {} }),
    approvals: () => async (tool, input) => ({ behavior: 'allow', updatedInput: input }),
    deliver: (s, text) => delivered.push(text),
    flush: () => published.push('flush'),
    schedule: () => published.push('schedule'),
    worktreesDir: os.tmpdir(),
    ...(machineFor ? { machineFor } : {}),
    attachWaitMs,
    maxRunning,
    stopWaitMs,
    dropWaitMs,
    exitWaitMs,
    log: () => {},
  });
  return { agents, tools: agents.tools(session), session, delivered, cli, published };
}

const callCard = (session, id, input) =>
  session.messages.push({ id: 'm-' + id, role: 'tool', tool: DELEGATE_TOOL, toolId: id, input, state: 'running', at: Date.now() });

describe('delegate', () => {
  test('without the id in _meta, calls are matched to their cards by input, in order; a missing card is added', async () => {
    const { tools, session } = bare({ gates: { a: gate(), b: gate(), c: gate() } });
    const input = { model: 'luna', task: 'work a' };
    callCard(session, 'toolu_1', input);
    callCard(session, 'toolu_2', input);
    await tools.delegate(input, {});
    await tools.delegate(input, {});
    assert.deepEqual(cards(session).map((card) => [card.toolId, Boolean(card.agentId)]), [['toolu_1', true], ['toolu_2', true]]);

    // A card reported a moment after the call is still found.
    const later = { model: 'deepseek', task: 'work b' };
    setTimeout(() => callCard(session, 'toolu_3', later), 50);
    await tools.delegate(later, {});
    assert.ok(cards(session)[2].agentId);

    // No card at all: the worker gets one of its own.
    await tools.delegate({ model: 'sol', task: 'work c' }, {});
    const own = cards(session)[3];
    assert.match(own.toolId, /^harbor-/);
    assert.equal(own.agentModel, 'sol');
  });

  test('refuses unknown models, empty tasks and more than the cap', async () => {
    const { tools, session } = bare({ gates: { a: gate() }, maxRunning: 1 });
    assert.match(textOf(await tools.delegate({ model: 'gpt-2', task: 'x' }, meta('t0'))), /Unknown model "gpt-2"\. Use one of: opus, sonnet/);
    assert.equal((await tools.delegate({ model: 'luna', task: '  ' }, meta('t1'))).isError, true);
    callCard(session, 't2', {});
    assert.equal((await tools.delegate({ model: 'luna', task: 'work a' }, meta('t2'))).isError, undefined);
    const third = await tools.delegate({ model: 'luna', task: 'work b' }, meta('t3'));
    assert.equal(third.isError, true);
    assert.match(textOf(third), /1 workers are already running/);
  });

  test('effort: a valid one is used, otherwise the session’s choice or the model default', async () => {
    const { tools, session, agents } = bare();
    session.efforts = { deepseek: 'max' };
    callCard(session, 'e1', {});
    callCard(session, 'e2', {});
    callCard(session, 'e3', {});
    await tools.delegate({ model: 'luna', task: 'work a', effort: 'xhigh' }, meta('e1'));
    await tools.delegate({ model: 'deepseek', task: 'work b', effort: 'medium' }, meta('e2'));
    await tools.delegate({ model: 'kimi', task: 'work c' }, meta('e3'));
    assert.deepEqual(agents.list(session.id).map((agent) => agent.effort), ['xhigh', 'max', 'high']);
  });

  test('the report lists files changed and commands (failures marked)', async () => {
    const { tools, session } = bare();
    callCard(session, 'r1', {});
    await tools.delegate({ model: 'luna', task: 'work edit-x' }, meta('r1'));
    await waitFor(() => cards(session)[0].state === 'done');
    assert.equal(cards(session)[0].output, 'Worker edit-x done.\n\nFiles changed: `edit-x.txt`\n\nCommands (1): `echo edit-x`');
  });
});

describe('wait_agents', () => {
  test('a worker on a worktree counts as running until its branch is committed, so no report misses it', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-git-'));
    tempDirs.push(repo);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    const gates = { a: gate(), b: gate() };
    const { tools, session, agents } = bare({ gates, cwd: repo });
    callCard(session, 'g1', {});
    callCard(session, 'g2', {});
    await tools.delegate({ model: 'luna', task: 'work a', isolation: 'worktree' }, meta('g1'));
    await tools.delegate({ model: 'deepseek', task: 'work b', isolation: 'worktree' }, meta('g2'));
    // Both change their worktree, then end together. (Their folders go even if this fails.)
    for (const agent of agents.list(session.id)) {
      tempDirs.push(agent.worktree.dir);
      fs.writeFileSync(path.join(agent.worktree.dir, `${agent.id}.txt`), 'x\n');
    }
    const all = tools.wait_agents({}, {});
    gates.a.open();
    gates.b.open();
    const reports = textOf(await all).split('\n\n---\n\n');
    assert.equal(reports.length, 2);
    for (const report of reports) assert.match(report, /Worktree: branch `harbor\/(luna|deepseek)-[0-9a-f]{6}` at .+, 1 commit on top of/);
  });

  test('a session on another cluster gets its worktree there, made and committed over ssh', async () => {
    const repo = gitRepo();
    const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-wt-'));
    tempDirs.push(fallback);
    const scripts = [];
    const ssh = (host, script) => {
      scripts.push(script);
      return localSsh(host, script);
    };
    const machine = remoteMachine('fake-login', { ssh, worktreesDir: fallback });
    const gates = { a: gate() };
    const { tools, session, agents } = bare({ gates, cwd: repo, cluster: 'fake', machineFor: async () => machine });
    callCard(session, 'g1', {});
    const started = textOf(await tools.delegate({ model: 'luna', task: 'work a', isolation: 'worktree' }, meta('g1')));
    assert.match(started, /in worktree /);
    const agent = agents.list(session.id)[0];
    assert.ok(agent.worktree.dir.startsWith(fallback), 'the fallback folder is on the cluster');
    assert.equal(agent.cwd, agent.worktree.cwd);
    assert.ok(scripts.some((script) => script.startsWith('git -C')), 'git ran through ssh');
    assert.ok(fs.existsSync(agent.worktree.dir));
    fs.writeFileSync(path.join(agent.worktree.dir, 'x.txt'), 'x\n');
    gates.a.open();
    await waitFor(() => cards(session)[0].state === 'done');
    assert.match(cards(session)[0].output, /Worktree: branch `harbor\/luna-[0-9a-f]{6}` at .+, 1 commit on top of/);
    assert.ok(scripts.some((script) => script.includes('commit')), 'the commit ran through ssh');
  });

  test('a cluster that does not answer is not mistaken for a folder without a repository', async () => {
    const repo = gitRepo();
    const offline = () => Promise.reject(Object.assign(new Error('no route'), { code: 255 }));
    await assert.rejects(createWorktree(repo, 'luna-abc123', os.tmpdir(), remoteMachine('fake-login', { ssh: offline })), /Could not reach fake-login: no route/);
    // Not even when only the folder check fails (it would otherwise fall back to Harbor's folder).
    const machine = remoteMachine('fake-login', {
      ssh: (host, script) =>
        script.includes('check-ignore') ? Promise.reject(Object.assign(new Error('connection lost'), { code: 255 })) : localSsh(host, script),
      worktreesDir: os.tmpdir(),
    });
    await assert.rejects(createWorktree(repo, 'luna-abc123', os.tmpdir(), machine), /Could not reach fake-login: connection lost/);
  });

  test('finishWorktree over ssh commits what the worker left and removes an empty one', async () => {
    const repo = gitRepo();
    const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-wt-'));
    tempDirs.push(fallback);
    const machine = remoteMachine('fake-login', { ssh: localSsh, worktreesDir: fallback });
    const empty = await createWorktree(repo, 'luna-empty1', fallback, machine);
    assert.deepEqual(await finishWorktree(empty, 'empty work', machine), { branch: 'harbor/luna-empty1', path: empty.dir, removed: true, commits: 0, diffstat: '' });
    assert.equal(fs.existsSync(empty.dir), false);
    const changed = await createWorktree(repo, 'luna-change', fallback, machine);
    assert.equal(changed.cwd, changed.dir, 'a session at the repository root works in the worktree');
    fs.writeFileSync(path.join(changed.dir, 'x.txt'), 'x\n');
    const done = await finishWorktree(changed, 'some work', machine);
    assert.equal(done.commits, 1);
    assert.match(done.diffstat, /x\.txt/);
  });

  test('all waits for every one; any returns at the first; finished ones never block', async () => {
    const gates = { a: gate(), b: gate() };
    const { tools, session, delivered } = bare({ gates });
    callCard(session, 'w1', {});
    callCard(session, 'w2', {});
    test('wait_agents counts a reply that arrived before the process reported taking the message', async () => {
  const gates = { a: gate() };
  const { tools, session } = bare({ gates });
  session.messages.push({ id: 'main', role: 'user', text: 'do it', delivery: 'done', at: 1000 });
  session.currentMessageId = 'main';
  callCard(session, 'k1', {});
  await tools.delegate({ model: 'luna', task: 'work a' }, meta('k1'));
  // Sent at 2000, answered at 3000, reported taken afterwards: moved to the end.
  session.messages.push({ id: 'old', role: 'assistant', text: 'Starting.', at: 1500 });
  session.messages.push({ id: 'reply', role: 'assistant', text: 'Still building.', at: 3000 });
  session.messages.push({ id: 'steer', role: 'user', text: 'progress?', delivery: 'running', at: 2000, startedAt: 3100 });
  const waiting = tools.wait_agents({}, {});
  gates.a.open();
  assert.doesNotMatch(textOf(await waiting), /Not waiting yet/);
  // Only text from before it was sent: still owed.
  session.messages.splice(session.messages.findIndex((m) => m.id === 'reply'), 1);
  const refused = await tools.wait_agents({}, {});
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /^Not waiting yet: the user wrote “progress\?”/);
});

const idOf = (result) => /^Started worker (\S+) /.exec(textOf(result))[1];
    const a = idOf(await tools.delegate({ model: 'luna', task: 'work a' }, meta('w1')));
    const b = idOf(await tools.delegate({ model: 'deepseek', task: 'work b' }, meta('w2')));
    assert.match(a, /^luna-/);
    assert.match(b, /^deepseek-/);

    const any = tools.wait_agents({ mode: 'any' }, {});
    await sleep(30);
    gates.a.open();
    const first = textOf(await any);
    assert.match(first, /GPT-6 Luna agent luna-.* finished/);
    assert.match(first, /DeepSeek V4.1 Flash agent deepseek-.* is still running/);

    const all = tools.wait_agents({ ids: [a, b, 'nope-000000'] }, {});
    await sleep(30);
    gates.b.open();
    const both = textOf(await all);
    assert.match(both, /GPT-6 Luna agent luna-.* finished; its report was delivered earlier/);
    assert.match(both, /DeepSeek V4.1 Flash agent deepseek-.* finished \(/);
    assert.match(both, /Unknown worker ids: nope-000000\./);
    assert.deepEqual(delivered, [], 'every report went to a waiter');

    const started = Date.now();
    assert.match(textOf(await tools.wait_agents({ ids: [a] }, {})), /delivered earlier/);
    assert.ok(Date.now() - started < 50);
    assert.match(textOf(await tools.wait_agents({}, {})), /^No workers to wait for/);
  });

  test('a timeout returns what is done; a worker ending later reports by itself', async () => {
    const gates = { a: gate() };
    const { tools, session, delivered } = bare({ gates });
    callCard(session, 't1', {});
    await tools.delegate({ model: 'luna', task: 'work a', description: 'Later' }, meta('t1'));
    const output = textOf(await tools.wait_agents({ timeout_seconds: 1 }, {}));
    assert.match(output, /^Timed out after 1s; 1 still running\./);
    assert.match(output, /GPT-6 Luna agent luna-[0-9a-f]{6} “Later” is still running \(1 tool use · 1s\)\./);
    gates.a.open();
    await waitFor(() => delivered.length === 1);
    assert.match(delivered[0], /^\[GPT-6 Luna agent finished\]/);
    assert.ok(session.messages.some((m) => m.role === 'notice' && m.text === 'GPT-6 Luna agent “Later” finished.'));
  });

  test('a worker the wait does not name returns the wait early with its report', async () => {
    const gates = { a: gate(), b: gate() };
    const { agents, tools, session, delivered } = bare({ gates });
    callCard(session, 'o1', {});
    callCard(session, 'o2', {});
    const a = idOf(await tools.delegate({ model: 'luna', task: 'work a', description: 'Long one' }, meta('o1')));
    await tools.delegate({ model: 'deepseek', task: 'work b', description: 'Short one' }, meta('o2'));
    const waiting = tools.wait_agents({ ids: [a] }, {});
    await sleep(20);
    gates.b.open();
    const output = textOf(await waiting);
    assert.match(output, /GPT-6 Luna agent luna-.* “Long one” is still running/);
    assert.match(output, /Returned early: another worker of yours ended meanwhile[^]*DeepSeek V4.1 Flash agent deepseek-.* finished/);
    assert.deepEqual(delivered, [], 'its report came back with the wait, not as a message');
    assert.ok(session.messages.some((m) => m.role === 'notice' && m.text === 'DeepSeek V4.1 Flash agent “Short one” finished.'));
    gates.a.open();
    await waitFor(() => delivered.length === 1, 3000);
    assert.equal(agents.list(session.id).length, 2);
  });

  test('a user message wakes the wait; a cancelled wait leaves reports to arrive by themselves', async () => {
    const gates = { a: gate(), b: gate() };
    const { agents, tools, session, delivered } = bare({ gates });
    callCard(session, 'k1', {});
    callCard(session, 'k2', {});
    await tools.delegate({ model: 'luna', task: 'work a' }, meta('k1'));
    await tools.delegate({ model: 'deepseek', task: 'work b' }, meta('k2'));
    const waiting = tools.wait_agents({}, {});
    await sleep(20);
    agents.wake(session.id);
    assert.match(textOf(await waiting), /^Returned early because the user sent a message\./);

    const controller = new AbortController();
    const cancelled = tools.wait_agents({ ids: agents.list(session.id).map((agent) => agent.id) }, { signal: controller.signal });
    gates.a.open();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.deepEqual(delivered, [], 'held for the waiter');
    controller.abort();
    assert.equal((await cancelled).isError, true);
    assert.equal(delivered.length, 1, 'the finished one reports once the wait is gone');
    gates.b.open();
    await waitFor(() => delivered.length === 2);
  });

  test('wait_agents will not wait while a message the user sent into the turn has no visible reply', async () => {
    const gates = { a: gate() };
    const { tools, session } = bare({ gates });
    session.messages.push({ id: 'main', role: 'user', text: 'do it', delivery: 'done' });
    session.currentMessageId = 'main';
    callCard(session, 'k1', {});
    await tools.delegate({ model: 'luna', task: 'work a' }, meta('k1'));
    // The turn's own message never counts: waiting right after delegating is fine.
    const first = tools.wait_agents({ timeout_seconds: 1 }, {});
    assert.match(textOf(await first), /Timed out/);

    session.messages.push({ id: 'steer', role: 'user', text: 'progress?', delivery: 'running' });
    session.messages.push({ id: 'think', role: 'thinking', text: 'I should check, then report back.' });
    const refused = await tools.wait_agents({}, {});
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /^Not waiting yet: the user wrote “progress\?”/);

    // Not taken by the process yet: the model has not read it, nothing is owed.
    session.messages.at(-2).delivery = 'sent';
    assert.match(textOf(await tools.wait_agents({ timeout_seconds: 1 }, {})), /Timed out/);
    session.messages.at(-2).delivery = 'running';

    session.messages.push({ id: 'reply', role: 'assistant', text: 'Still building; about 5 minutes left.' });
    const waiting = tools.wait_agents({}, {});
    gates.a.open();
    assert.doesNotMatch(textOf(await waiting), /Not waiting yet/);
  });
});

const idOf = (result) => /^Started worker (\S+) /.exec(textOf(result))[1];

/** Starts a worker on a card of its own; resolves its id and the card's tool_use id. */
async function start({ tools, session }, task, { model = 'luna', description } = {}) {
  const toolId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  callCard(session, toolId, {});
  const id = idOf(await tools.delegate({ model, task, ...(description ? { description } : {}) }, meta(toolId)));
  return { id, toolId };
}

const toWorker = (session, toolId) => session.messages.filter((m) => m.role === 'user' && m.parentToolId === toolId);

/**
 * Worker processes the test drives by hand: `emit(message)` is what a process prints,
 * `received` what was written to it, `exit()` ends its output. They ignore aborts (a
 * process that is slow to die), so the end of a worker is the test's to decide.
 */
function manualCli({ abortKills = false } = {}) {
  const procs = [];
  function query({ prompt, options }) {
    const proc = { options, received: [], inputEnded: false, finished: false };
    const out = [];
    let wake = null;
    proc.emit = (message) => {
      out.push(message);
      wake?.();
    };
    proc.exit = () => {
      proc.finished = true;
      wake?.();
    };
    // `abortKills`: like the SDK, an abort kills the process and the stream throws
    // (otherwise the process stands in for one slow to shut down).
    if (abortKills) options.abortController?.signal.addEventListener('abort', () => {
      proc.aborted = true;
      wake?.();
    });
    (async () => {
      for await (const message of prompt) proc.received.push(message);
      proc.inputEnded = true;
    })();
    procs.push(proc);
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (out.length) {
            yield out.shift();
            continue;
          }
          if (proc.aborted) throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });
          if (proc.finished) return;
          await new Promise((resolve) => (wake = resolve));
        }
      },
      setPermissionMode: async () => {},
    };
  }
  return { query, procs, get proc() { return procs.at(-1); } };
}

const taking = (uuid) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: 'x' }, parent_tool_use_id: null });
const lifecycle = (uuid, state) => ({ type: 'command_lifecycle', command_uuid: uuid, state });
const result = (text, uuids) => successResult({ result: text, user_message_uuids: uuids });

describe('message_agent', () => {
  test('reaches the running worker with priority next and the lead’s prefix; recorded under its card, sent until the process takes it', async () => {
    const gates = { 'fold-a': gate() };
    const { tools, session, cli, published, agents } = bare({ gates });
    const { id, toolId } = await start({ tools, session }, 'work fold-a');
    await waitFor(() => cli.processes[0]?.received.length === 1);
    published.length = 0;

    const reply = await tools.message_agent({ id, message: '  Also cover b.txt  ' });
    assert.equal(reply.isError, undefined);
    assert.equal(textOf(reply), `Sent to GPT-6 Luna agent ${id}; it reads it at its next step.`);
    await waitFor(() => cli.processes[0].received.length === 2);
    const [command, ...more] = cli.processes[0].received.slice(1);
    assert.equal(more.length, 0);
    assert.equal(command.content, '[Message from the lead agent]\n\nAlso cover b.txt');
    assert.equal(command.priority, 'next');
    assert.match(command.uuid, /^[0-9a-f-]{36}$/);

    const [message] = toWorker(session, toolId);
    assert.deepEqual({ ...message, id: typeof message.id, at: typeof message.at }, { id: 'string', role: 'user', text: 'Also cover b.txt', parentToolId: toolId, from: 'lead', delivery: 'sent', at: 'number' });
    assert.ok(published.includes('flush'), 'published at once');
    assert.equal(publicSession(session).lastMessageAt, session.createdAt, 'not one of the session’s own messages');

    // The process has not taken it yet; once the worker reads it (between its steps) it is delivered.
    await sleep(30);
    assert.equal(message.delivery, 'sent');
    gates['fold-a'].open();
    await waitFor(() => message.delivery === 'done');
    await waitFor(() => cards(session)[0].state === 'done');
    assert.match(cards(session)[0].output, /^Worker fold-a done\. Read: \[Message from the lead agent\]\n\nAlso cover b\.txt/);
    assert.equal(agents.list(session.id)[0].outstanding.size, 0);
  });

  test('the user’s message (from the card) carries the user’s prefix and clientId; a retried send is not sent twice', async () => {
    const gates = { 'fold-a': gate() };
    const { tools, session, cli, agents } = bare({ gates });
    const { id, toolId } = await start({ tools, session }, 'work fold-a');
    await waitFor(() => cli.processes[0]?.received.length === 1);

    const sent = agents.messageCard(session, toolId, { text: ' use tabs ', clientId: 'c-1' });
    assert.equal(typeof sent.messageId, 'string');
    await waitFor(() => cli.processes[0].received.length === 2);
    assert.equal(cli.processes[0].received[1].content, '[Message from the user]\n\nuse tabs');
    assert.equal(cli.processes[0].received[1].priority, 'next');
    const [message] = toWorker(session, toolId);
    assert.equal(message.id, sent.messageId);
    assert.deepEqual([message.text, message.from, message.delivery, message.clientId], ['use tabs', 'user', 'sent', 'c-1']);

    assert.deepEqual(agents.messageCard(session, toolId, { text: 'use tabs', clientId: 'c-1' }), { messageId: sent.messageId });
    await sleep(20);
    assert.equal(cli.processes[0].received.length, 2, 'the retry sent nothing');
    assert.equal(toWorker(session, toolId).length, 1);

    // Both kinds are read by the worker, in the order they were sent.
    await tools.message_agent({ id, message: 'and add a test' });
    assert.deepEqual(toWorker(session, toolId).map((m) => m.from), ['user', 'lead']);
    await waitFor(() => cli.processes[0].received.length === 3);
    gates['fold-a'].open();
    await waitFor(() => cards(session)[0].state === 'done');
    assert.deepEqual(toWorker(session, toolId).map((m) => m.delivery), ['done', 'done']);
    assert.match(cards(session)[0].output, /Read: \[Message from the user\]\n\nuse tabs \| \[Message from the lead agent\]\n\nand add a test/);
    // The lead did not send the user's message: its report says what the user told it.
    assert.match(cards(session)[0].output, /\n\nThe user wrote to it directly \(not through you\): “use tabs”\n\nCommands/);
  });

  test('refuses unknown ids, another session’s worker, a finished worker and empty or oversized messages', async () => {
    const gates = { a: gate() };
    const { tools, session, agents, delivered } = bare({ gates });
    const { id, toolId } = await start({ tools, session }, 'work a');

    const unknown = await tools.message_agent({ id: 'luna-000000', message: 'hi' });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), new RegExp(`^Unknown worker id "luna-000000"\\. Workers of this session: ${id}\\.`));
    const other = createSession({ cwd: os.tmpdir(), model: 'opus', mode: 'bypassPermissions' });
    const foreign = await agents.tools(other).message_agent({ id, message: 'hi' });
    assert.equal(foreign.isError, true);
    assert.match(textOf(foreign), /^Unknown worker id/);

    for (const message of ['', '   ', undefined]) {
      const empty = await tools.message_agent({ id, message });
      assert.equal(empty.isError, true);
      assert.equal(textOf(empty), 'Give the message some text.');
    }
    const long = await tools.message_agent({ id, message: 'x'.repeat(150_001) });
    assert.equal(long.isError, true);
    assert.match(textOf(long), /^The message is too long/);
    assert.deepEqual(toWorker(session, toolId), [], 'none of them was recorded');

    gates.a.open();
    await waitFor(() => cards(session)[0].state === 'done');
    await waitFor(() => delivered.length === 1);
    const late = await tools.message_agent({ id, message: 'too late' });
    assert.equal(late.isError, true);
    assert.equal(textOf(late), `GPT-6 Luna agent ${id} already finished; its report was delivered earlier in the conversation. Start a new worker if more work is needed.`);
    assert.deepEqual(toWorker(session, toolId), []);
    assert.deepEqual(agents.messageCard(session, toolId, { text: 'too late' }), { status: 409, error: 'This agent is not running.' });
    assert.deepEqual(agents.messageCard(session, toolId, { text: '  ' }), { status: 400, error: 'Write a message first.' });
    assert.deepEqual(agents.messageCard(session, toolId, { text: 'x'.repeat(150_001) }), { status: 400, error: 'This message is too long.' });
    assert.deepEqual(agents.messageCard(session, 'toolu_nope', { text: 'hi' }), { status: 409, error: 'This agent is not running.' });
  });

  test('a finished worker whose report has not been collected says so', async () => {
    const { tools, session, agents } = bare();
    const { id } = await start({ tools, session }, 'work a');
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    agents.list(session.id)[0].delivered = false;
    assert.match(textOf(await tools.message_agent({ id, message: 'hi' })), /already finished; its report has not been collected yet: wait_agents returns it\.$/);
  });

  test('a message needs only the replayed user message to count as read (a CLI without lifecycle frames)', async () => {
    const gates = { 'fold-a': gate() };
    const { tools, session, cli } = bare({ gates, behavior: { lifecycle: false } });
    const { id, toolId } = await start({ tools, session }, 'work fold-a');
    await waitFor(() => cli.processes[0]?.received.length === 1);
    await tools.message_agent({ id, message: 'hello' });
    gates['fold-a'].open();
    await waitFor(() => toWorker(session, toolId)[0].delivery === 'done');
    assert.ok(!cli.processes[0].commands.length);
  });

  test('a message reads in the transcript where the worker took it, after the steps it had made by then', async () => {
    const cli = manualCli();
    const { tools, session } = bare({ query: cli.query });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'hello' });
    await waitFor(() => proc.received.length === 2);
    const [message] = toWorker(session, toolId);
    proc.emit(toolUse('t1', 'Bash', { command: 'ls' }));
    await waitFor(() => session.messages.some((m) => m.toolId === 't1'));
    assert.equal(session.messages.at(-1).toolId, 't1');
    proc.emit(taking(proc.received[1].uuid));
    await waitFor(() => message.delivery === 'done');
    assert.equal(session.messages.at(-1), message);
    assert.equal(session.messages.filter((m) => m === message).length, 1);
  });

  test('a message the process cancels, or never takes before the worker ends, is dropped', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'first' });
    await tools.message_agent({ id, message: 'second' });
    await waitFor(() => proc.received.length === 3);
    proc.emit(lifecycle(proc.received[1].uuid, 'cancelled'));
    await waitFor(() => toWorker(session, toolId)[0].delivery === 'dropped');
    assert.equal(toWorker(session, toolId)[1].delivery, 'sent');
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state !== 'running');
    assert.deepEqual(toWorker(session, toolId).map((m) => m.delivery), ['dropped', 'dropped']);
  });

  test('a stopped worker’s unread messages are dropped, and a worker that is stopping takes no more', async () => {
    const gates = { a: gate() };
    const { tools, session, agents } = bare({ gates });
    const { id, toolId } = await start({ tools, session }, 'work a');
    await waitFor(() => agents.list(session.id)[0].stream);
    await tools.message_agent({ id, message: 'unread' });
    agents.stop(session, toolId);
    assert.match(textOf(await tools.message_agent({ id, message: 'more' })), /already finished; its report is on its way/);
    await waitFor(() => agents.list(session.id)[0].state === 'stopped');
    assert.deepEqual(toWorker(session, toolId).map((m) => [m.text, m.delivery]), [['unread', 'dropped']]);
  });
});

describe('a message as the worker gives its final answer', () => {
  test('a turn of its own for the message runs before the input is closed (real process stand-in)', async () => {
    const gates = { late: gate() };
    const { tools, session, cli, agents } = bare({ gates });
    const { id, toolId } = await start({ tools, session }, 'work late');
    await waitFor(() => cli.processes[0]?.received.length === 1);
    await tools.message_agent({ id, message: 'also b' });
    gates.late.open();
    await waitFor(() => agents.list(session.id)[0].state === 'done');

    const [agent] = agents.list(session.id);
    const [message] = toWorker(session, toolId);
    assert.equal(message.delivery, 'done');
    // The worker did not read it before answering: its turn is the second one, and its answer is the report.
    assert.equal(agent.result.result, 'Answered lead agent: also b');
    // Its report keeps what it concluded before the message as well as its answer to it.
    assert.match(cards(session)[0].output, /^Worker late done\.\n\nAfter a message that reached it as it finished:\n\nAnswered lead agent: also b\n\nCommands/);
    assert.ok(session.messages.some((m) => m.role === 'assistant' && m.parentToolId === toolId && m.text === 'Answering lead agent: also b'));
    assert.equal(cli.processes[0].inputClosedDuringReply, false, 'the input was still open while the message’s turn ran');
    assert.equal(cli.processes[0].inputEnded, true);
    assert.deepEqual(session.totals.models.luna, { cost: 0.03, outputTokens: 70 }, 'the session’s total cost, counted once');
  });

  test('the input stays open while a message waits for its turn, and ends after the result that answers it', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query, dropWaitMs: 5000 });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'also b' });
    await waitFor(() => proc.received.length === 2);
    const { uuid } = proc.received[1];

    // The first turn ends without the message: its input is not closed.
    proc.emit(say('final answer'));
    proc.emit(result('final answer', []));
    await sleep(40);
    assert.equal(proc.inputEnded, false);
    assert.equal(agents.list(session.id)[0].state, 'running');
    assert.equal(toWorker(session, toolId)[0].delivery, 'sent');
    assert.match(textOf(await tools.check_agents({})), /Messages it has not read yet: 1/);

    // Its turn starts (the process takes the message) and ends with its own result.
    proc.emit(lifecycle(uuid, 'started'));
    await waitFor(() => toWorker(session, toolId)[0].delivery === 'done');
    assert.equal(proc.inputEnded, false, 'its turn is running');
    proc.emit(say('answer to b'));
    proc.emit(result('answer to b', [uuid]));
    await waitFor(() => proc.inputEnded);
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.match(cards(session)[0].output, /^final answer\n\nAfter a message that reached it as it finished:\n\nanswer to b/);
    assert.equal(cards(session)[0].state, 'done');
  });

  test('a message taken and answered in the turn that ends needs no further turn', async () => {
    const cli = manualCli();
    const { tools, session } = bare({ query: cli.query, dropWaitMs: 5000 });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'hello' });
    await waitFor(() => proc.received.length === 2);
    const { uuid } = proc.received[1];
    proc.emit(taking(uuid));
    proc.emit(say('read it'));
    proc.emit(result('read it', [uuid]));
    await waitFor(() => proc.inputEnded, 500);
    assert.equal(toWorker(session, toolId)[0].delivery, 'done');
  });

  test('a message the process took but whose answer is not in this result still needs its own turn', async () => {
    const cli = manualCli();
    const { tools, session } = bare({ query: cli.query, dropWaitMs: 60 });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'hello' });
    await waitFor(() => proc.received.length === 2);
    const { uuid } = proc.received[1];
    proc.emit(taking(uuid));
    proc.emit(result('first', []));
    await sleep(30);
    assert.equal(proc.inputEnded, false, 'waits for the turn it started');
    assert.equal(toWorker(session, toolId)[0].delivery, 'done');
    // Its work shows: the wait is over, and only its result ends the worker.
    proc.emit(say('second'));
    await sleep(120);
    assert.equal(proc.inputEnded, false);
    proc.emit(result('second', [uuid]));
    await waitFor(() => proc.inputEnded);
  });

  test('a process that stays quiet after a result with a message it never took has dropped it: the input closes and the message is marked', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query, dropWaitMs: 40 });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'lost' });
    await waitFor(() => proc.received.length === 2);
    proc.emit(say('final answer'));
    proc.emit(result('final answer', []));
    await sleep(15);
    assert.equal(proc.inputEnded, false, 'given a moment first');
    await waitFor(() => proc.inputEnded, 500);
    assert.equal(toWorker(session, toolId)[0].delivery, 'dropped');
    // Never a hang: the worker ends with the answer it had.
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.match(cards(session)[0].output, /^final answer$/, 'the answer it had');
  });

  test('a worker whose process stays quiet after a message taken but unanswered also ends', async () => {
    const cli = manualCli();
    const { tools, session } = bare({ query: cli.query, dropWaitMs: 40 });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    await tools.message_agent({ id, message: 'hello' });
    await waitFor(() => proc.received.length === 2);
    proc.emit(taking(proc.received[1].uuid));
    proc.emit(result('first', []));
    await waitFor(() => proc.inputEnded, 500);
    assert.equal(toWorker(session, toolId)[0].delivery, 'done', 'it was taken, only never answered');
  });

  test('no message to the worker once its input is closed: it has finished, whatever the process is still doing', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(result('done', []));
    await waitFor(() => proc.inputEnded);
    assert.equal(agents.list(session.id)[0].state, 'running', 'the process is still exiting');
    const late = await tools.message_agent({ id, message: 'too late' });
    assert.equal(late.isError, true);
    assert.match(textOf(late), /already finished; its report is on its way/);
    assert.deepEqual(agents.messageCard(session, toolId, { text: 'too late' }), { status: 409, error: 'This agent is not running.' });
    assert.deepEqual(toWorker(session, toolId), []);
    assert.equal(proc.received.length, 1);
  });
});

describe('a worker’s background tasks', () => {
  const tasksChanged = (...tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map(([id, description, type = 'local_bash']) => ({ task_id: id, task_type: type, description })) });

  test('a turn that ends with a Monitor of its own still running is not the end: its events start turns, and it finishes when one ends with none left', async () => {
    const cli = manualCli();
    const { tools, session, agents, delivered } = bare({ query: cli.query, dropWaitMs: 40 });
    const { id } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(tasksChanged(['m1', 'ticks', 'monitor']));
    proc.emit(say('Watching the ticks.'));
    proc.emit(result('Watching the ticks.', []));
    await sleep(80);
    assert.equal(proc.inputEnded, false, 'its Monitor will wake it');
    assert.equal(agents.list(session.id)[0].state, 'running');
    assert.deepEqual(cards(session)[0].progress, { description: 'Waiting on 1 background task', toolUses: 0, tokens: 0, waitingOn: 1 });
    assert.match(textOf(await tools.check_agents({ ids: [id] })), /Between turns, waiting on: ticks \(monitor\)\. Their events wake it/);
    // A Monitor event: a turn of its own, the Monitor still up.
    proc.emit(say('tick 1'));
    await waitFor(() => cards(session)[0].progress.description === 'Working');
    proc.emit(result('tick 1', []));
    await sleep(80);
    assert.equal(proc.inputEnded, false);
    // The Monitor ends; its last event's turn ends with nothing left.
    proc.emit(tasksChanged());
    proc.emit(say('Final: tick 8.'));
    proc.emit(result('Final: tick 8.', []));
    await waitFor(() => proc.inputEnded, 500);
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.equal(cards(session)[0].output, 'Final: tick 8.', 'the turns its tasks started supersede the earlier answers');
    assert.match(delivered.at(-1), /^\[GPT-6 Luna agent finished\]/);
  });

  test('while it waits on its tasks it takes messages; the answer to one keeps the answer before it', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query, dropWaitMs: 40 });
    const { id, toolId } = await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(tasksChanged(['b1', 'build']));
    proc.emit(result('Build started.', []));
    await sleep(60);
    const sent = await tools.message_agent({ id, message: 'Also say ok.' });
    assert.equal(sent.isError, undefined, textOf(sent));
    assert.deepEqual(agents.messageCard(session, toolId, { text: 'And mango.' }).messageId?.length > 0, true);
    await waitFor(() => proc.received.length === 3);
    proc.emit(taking(proc.received[1].uuid));
    proc.emit(taking(proc.received[2].uuid));
    proc.emit(tasksChanged());
    proc.emit(say('ok, mango'));
    proc.emit(result('ok, mango', [proc.received[1].uuid, proc.received[2].uuid]));
    await waitFor(() => proc.inputEnded, 500);
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.equal(cards(session)[0].output, 'Build started.\n\nAfter a message that reached it as it finished:\n\nok, mango\n\nThe user wrote to it directly (not through you): “And mango.”');
    assert.deepEqual(toWorker(session, toolId).map((m) => m.delivery), ['done', 'done']);
  });

  test('its last task ending between turns with no turn after it finishes the worker after dropWaitMs', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query, dropWaitMs: 40 });
    await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(tasksChanged(['b1', 'build']));
    proc.emit(result('Build started.', []));
    await sleep(60);
    proc.emit(tasksChanged());
    await sleep(15);
    assert.equal(proc.inputEnded, false, 'a turn for its end may be on its way');
    await waitFor(() => proc.inputEnded, 500);
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.equal(cards(session)[0].output, 'Build started.');
  });

  test('an ambient task never keeps it waiting', async () => {
    const cli = manualCli();
    const { tools, session } = bare({ query: cli.query });
    await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'x1', task_type: 'local_bash', description: 'housekeeping', ambient: true }] });
    proc.emit(result('done', []));
    await waitFor(() => proc.inputEnded, 500);
  });

  test('a process that does not exit once its input is closed is ended after exitWaitMs: the worker finished, nobody stopped it', async () => {
    const cli = manualCli({ abortKills: true });
    const { tools, session, agents, delivered } = bare({ query: cli.query, exitWaitMs: 60 });
    await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(say('all done'));
    proc.emit(result('all done', []));
    await waitFor(() => proc.inputEnded);
    await sleep(20);
    assert.equal(proc.aborted, undefined, 'given a moment to exit by itself');
    await waitFor(() => proc.aborted, 1000);
    await waitFor(() => agents.list(session.id)[0].state !== 'running');
    assert.equal(agents.list(session.id)[0].state, 'done');
    const [card] = cards(session);
    assert.equal(card.state, 'done');
    assert.equal(card.stopped, undefined);
    assert.equal(card.output, 'all done');
    assert.match(delivered.at(-1), /^\[GPT-6 Luna agent finished\]/);
  });

  test('the backstop never ends a turn under way: a slow turn after the input closed runs to its result', async () => {
    const cli = manualCli({ abortKills: true });
    const { tools, session, agents } = bare({ query: cli.query, dropWaitMs: 30, exitWaitMs: 60 });
    await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(tasksChanged(['b1', 'build']));
    proc.emit(result('Build started.', []));
    await sleep(50);
    // The build ends; its turn is slow to start, so the worker counts as finished.
    proc.emit(tasksChanged());
    await waitFor(() => proc.inputEnded, 500);
    proc.emit(say('The build passed; running the tests now.'));
    await sleep(200);
    assert.equal(proc.aborted, undefined, 'the turn goes on');
    proc.emit(result('Build and tests passed.', []));
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    assert.equal(cards(session)[0].output, 'Build and tests passed.');
  });

  test('one that exits in time is left alone', async () => {
    const cli = manualCli({ abortKills: true });
    const { tools, session, agents } = bare({ query: cli.query, exitWaitMs: 60 });
    await start({ tools, session }, 'work a');
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);
    proc.emit(result('all done', []));
    await waitFor(() => proc.inputEnded);
    proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
    await sleep(120);
    assert.equal(proc.aborted, undefined);
  });
});

describe('stop_agent', () => {
  test('halts a running worker and returns its partial report: stopped by the lead, with its reason; no report follows by itself', async () => {
    const gates = { 'edit-a': gate() };
    const { tools, session, delivered, agents } = bare({ gates });
    const { id, toolId } = await start({ tools, session }, 'work edit-a');
    await waitFor(() => session.messages.some((m) => m.parentToolId === toolId && m.tool === 'Write'));

    const stopped = await tools.stop_agent({ id, reason: 'wrong approach,\n use the other one' });
    assert.equal(stopped.isError, undefined);
    assert.match(textOf(stopped), new RegExp(`^GPT-6 Luna agent ${id} was stopped \\(2 tool uses · \\d+s\\)\\.\\n\\nStopped by the lead: wrong approach, use the other one\\n\\nFiles changed: \`edit-a\\.txt\`\\n\\nCommands \\(1\\): \`echo edit-a\`$`));
    const [agent] = agents.list(session.id);
    assert.deepEqual([agent.state, agent.stoppedBy, agent.stopReason, agent.delivered], ['stopped', 'lead', 'wrong approach, use the other one', true]);
    const [card] = cards(session);
    assert.deepEqual([card.state, card.stopped, card.stoppedBy, card.stopReason], ['error', true, 'lead', 'wrong approach, use the other one']);
    assert.match(card.output, /^Stopped by the lead: wrong approach/);

    await sleep(50);
    assert.deepEqual(delivered, [], 'the report was the tool result');
    assert.ok(!session.messages.some((m) => m.role === 'notice' && m.agentToolId));
    assert.match(textOf(await tools.wait_agents({ ids: [id] })), /was stopped; its report was delivered earlier/);
    // Stopping it again, or messaging it: it is over.
    assert.match(textOf(await tools.stop_agent({ id })), /already finished; its report was delivered earlier/);
    assert.equal((await tools.stop_agent({ id })).isError, true);
  });

  test('without a reason; an unknown id and another session’s worker are refused', async () => {
    const gates = { a: gate() };
    const { tools, session, agents } = bare({ gates });
    const { id } = await start({ tools, session }, 'work a');
    const unknown = await tools.stop_agent({ id: 'deepseek-123456' });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /^Unknown worker id "deepseek-123456"/);
    const other = createSession({ cwd: os.tmpdir(), model: 'opus', mode: 'bypassPermissions' });
    assert.equal((await agents.tools(other).stop_agent({ id })).isError, true);
    assert.equal(agents.list(session.id)[0].state, 'running', 'untouched');

    assert.match(textOf(await tools.stop_agent({ id })), /Stopped by the lead before it finished\./);
  });

  test('a worker that has not ended in time is said to be stopping; its report then arrives as usual', async () => {
    const cli = manualCli();
    const { tools, session, delivered, agents } = bare({ query: cli.query, stopWaitMs: 40 });
    const { id } = await start({ tools, session }, 'work a');
    await waitFor(() => cli.proc.received.length === 1);
    const slow = await tools.stop_agent({ id, reason: 'no longer needed' });
    assert.equal(slow.isError, undefined);
    assert.match(textOf(slow), new RegExp(`^Asked GPT-6 Luna agent ${id} to stop, but it has not finished after \\ds \\(still shutting down\\)\\. Its report arrives as a message when it ends\\.$`));
    assert.equal(agents.list(session.id)[0].delivered, false);
    cli.proc.exit();
    await waitFor(() => delivered.length === 1);
    assert.match(delivered[0], /^\[GPT-6 Luna agent stopped\] Automatic report from Harbor/);
    assert.match(delivered[0], /Stopped by the lead: no longer needed/);
    assert.ok(session.messages.some((m) => m.role === 'notice' && m.agentToolId));
  });

  test('a cancelled call returns; a worker the user already stopped stays the user’s stop', async () => {
    const cli = manualCli();
    const { tools, session, agents } = bare({ query: cli.query });
    const { id, toolId } = await start({ tools, session }, 'work a');
    await waitFor(() => cli.proc.received.length === 1);
    agents.stop(session, toolId);
    const controller = new AbortController();
    const waiting = tools.stop_agent({ id, reason: 'me too' }, { signal: controller.signal });
    controller.abort();
    assert.equal((await waiting).isError, true);
    cli.proc.exit();
    await waitFor(() => agents.list(session.id)[0].state === 'stopped');
    assert.equal(agents.list(session.id)[0].stoppedBy, undefined);
    assert.match(cards(session)[0].output, /^Stopped by the user before it finished\./);
  });
});

describe('check_agents', () => {
  test('a worker waiting on the user says what it asked', async () => {
    const cli = manualCli();
    const { tools, session } = bare({ query: cli.query });
    const { toolId } = await start({ tools, session }, 'work a', { description: 'Part A' });
    await waitFor(() => cli.proc.received.length === 1);
    session.pending = [
      { id: 'p1', kind: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which branch?' }] }, agent: { toolId } },
      { id: 'p2', kind: 'permission', tool: 'Bash', input: {}, agent: { toolId: 'other' } },
    ];
    const lines = textOf(await tools.check_agents({})).split('\n');
    assert.deepEqual(lines.filter((line) => line.startsWith('Waiting for the user')), ['Waiting for the user: its question “Which branch?”']);
  });

  test('state, time, tool uses, tokens, the latest step, the last words and the messages not read yet', async () => {
    const cli = manualCli();
    const { tools, session, delivered } = bare({ query: cli.query });
    const { id, toolId } = await start({ tools, session }, 'work a', { description: 'Part A' });
    const { proc } = cli;
    await waitFor(() => proc.received.length === 1);

    assert.match(textOf(await tools.check_agents({})), new RegExp(`^GPT-6 Luna agent ${id} “Part A”: running \\(0 tool uses · \\d+s\\)\\.\\nLatest step: none yet\\nMessages it has not read yet: 0$`));

    proc.emit(toolUse('t1', 'Bash', { command: 'npm test --\n   --reporter=dot ' + 'x'.repeat(300) }));
    await tools.message_agent({ id, message: 'one' });
    await tools.message_agent({ id, message: 'two' });
    await waitFor(() => session.messages.some((m) => m.toolId === 't1'));
    let report = textOf(await tools.check_agents({ ids: [id] }));
    const lines = report.split('\n');
    assert.match(lines[0], new RegExp(`^GPT-6 Luna agent ${id} “Part A”: running \\(1 tool use · \\d+s\\)\\.$`));
    assert.match(lines[1], /^Latest step: Bash `npm test -- --reporter=dot x+…` \(running now\)$/);
    assert.ok(lines[1].length < 190, 'the command is clipped');
    assert.equal(lines.at(-1), 'Messages it has not read yet: 2');

    proc.emit(toolResult('t1', 'ok'));
    proc.emit(toolUse('t2', 'Edit', { file_path: '/work/src/app.js', old_string: 'a', new_string: 'b' }));
    proc.emit(say('x'.repeat(900), { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 }));
    await waitFor(() => session.messages.some((m) => m.role === 'assistant' && m.parentToolId === toolId));
    report = textOf(await tools.check_agents());
    assert.match(report, /\(2 tool uses · 1\.1k tokens · \d+s\)/);
    assert.match(report, /\nLatest step: Edit `\/work\/src\/app\.js` \(running now\)\n/);
    assert.match(report, /Last said: x{600}\n\[…cut\]\nMessages it has not read yet: 2$/);

    // A finished step is not "running now".
    proc.emit(toolResult('t2', 'ok'));
    await waitFor(() => session.messages.find((m) => m.toolId === 't2')?.state === 'done');
    assert.match(textOf(await tools.check_agents()), /\nLatest step: Edit `\/work\/src\/app\.js`\n/);
    assert.deepEqual(delivered, []);
  });

  test('never blocks and never collects: finished workers show until their report is collected', async () => {
    const gates = { slow: gate() };
    const { tools, session, agents, delivered } = bare({ gates });
    const a = await start({ tools, session }, 'work a', { model: 'deepseek' });
    const slow = await start({ tools, session }, 'work slow', { description: 'Slow one' });
    await waitFor(() => agents.list(session.id).find((agent) => agent.id === a.id).state === 'done');
    // Its report goes to the main model by itself (nobody waits): it is on its way, not collected by a check.
    await waitFor(() => delivered.length === 1);

    const started = Date.now();
    const report = textOf(await tools.check_agents());
    assert.ok(Date.now() - started < 50);
    assert.ok(!report.includes(a.id), 'a delivered report is not listed by default');
    assert.match(report, /Slow one”: running/);

    // By id: a worker that finished is shown with its state and where its report is.
    const done = textOf(await tools.check_agents({ ids: [a.id, 'nope-000000'] }));
    assert.match(done, new RegExp(`DeepSeek V4.1 Flash agent ${a.id}: finished \\(1 tool use · .*\\)\\.\\nLatest step: Bash \`echo a\`\\nLast said: Worker a done\\.\\nIts report was delivered earlier in the conversation\\.`));
    assert.match(done, /\n\n---\n\nUnknown worker ids: nope-000000\.$/);

    // A finished worker nobody has collected: listed, and checking it does not collect it.
    agents.list(session.id).find((agent) => agent.id === a.id).delivered = false;
    assert.match(textOf(await tools.check_agents()), /Its report has not been collected yet: wait_agents returns it\./);
    assert.equal(agents.list(session.id).find((agent) => agent.id === a.id).delivered, false);
    assert.match(textOf(await tools.wait_agents({ ids: [a.id] })), /DeepSeek V4.1 Flash agent .* finished \(/, 'wait_agents still returns it');

    gates.slow.open();
    await waitFor(() => delivered.length === 2);
    assert.match(textOf(await tools.check_agents({})), /^No workers running, and every report has been delivered\.$/);
    const missing = await tools.check_agents({ ids: ['nope-000000'] });
    assert.equal(missing.isError, true);
    assert.equal(textOf(missing), 'Unknown worker ids: nope-000000.');
    void slow;
  });

  test('only this session’s workers', async () => {
    const gates = { a: gate() };
    const { tools, session, agents } = bare({ gates });
    const { id } = await start({ tools, session }, 'work a');
    const other = createSession({ cwd: os.tmpdir(), model: 'opus', mode: 'bypassPermissions' });
    const there = await agents.tools(other).check_agents({ ids: [id] });
    assert.equal(there.isError, true);
    assert.match(textOf(await agents.tools(other).check_agents({})), /^No workers running/);
    gates.a.open();
    await waitFor(() => agents.list(session.id)[0].state === 'done');
  });
});

describe('model agent list', () => {
  test('every catalog model, named as an agent, with a hint', () => {
    const list = modelAgentList();
    assert.equal(list.length, 13);
    assert.deepEqual(list[0], {
      id: 'opus',
      name: 'Claude Opus 5.5 agent',
      model: 'Claude Opus 5.5',
      provider: 'Claude',
      hint: list[0].hint,
      direct: true,
      vision: true,
    });
    assert.ok(list.every((entry) => entry.hint));
  });
});
