// Subagents end to end: real Claude Code turns through the runner, the normalizing proxy
// and the mock gateway (see the agent scripts in mock-gateway.mjs). Background agents
// outliving their turn and the idle timeout, parallel agents on a gateway model, a
// permission request from inside an agent, and stopping one agent. Isolated: no
// settings sources, a throwaway CLAUDE_CONFIG_DIR, gateway models only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { createRunner } from '../../server/runner.mjs';
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-agents-'));
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
function harness({ model = 'luna', mode = 'bypassPermissions', idleMs } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const work = path.join(dir, 'work');
  const claudeConfigDir = path.join(dir, 'claude-config');
  fs.mkdirSync(work);
  fs.mkdirSync(claudeConfigDir);
  const store = createStore({ dataDir: path.join(dir, 'data') });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const query = observedQuery({
    beforeSpawn: ({ options }) => {
      options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      assert.equal(options.env.ANTHROPIC_BASE_URL, proxy.url, 'never a real model');
    },
  });
  const config = { claudeExecutable: CLAUDE, gatewayUrl: mock.url, settingSources: [], claudeConfigDir };
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, query, idleMs, log: () => {} });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: work, model, mode }));
  return { runner, session, spawns: query.spawns, work };
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
const agents = (session) => session.messages.filter((m) => m.role === 'tool' && m.tool === 'Agent');
const childrenOf = (session, toolId) => session.messages.filter((m) => m.parentToolId === toolId);
const agentNotices = (session) => session.messages.filter((m) => m.role === 'notice' && m.agentToolId);

describe('subagents (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('a background agent outlives its turn and the idle timeout, then ends with usage, a notice and a follow-up turn', async () => {
    const { runner, session, spawns } = harness({ idleMs: 300 });
    runner.enqueue(session, { text: '[[mock:agent-slow]] delegate this' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));

    const [agent] = agents(session);
    assert.equal(agent.state, 'running');
    assert.equal(agent.background, true);
    assert.ok(agent.taskId, 'the task id is recorded when the agent starts');
    assert.equal(session.status, 'idle');
    assert.equal(publicSession(session).backgroundAgents, 1);

    // Well past the idle timeout: the process stays while its agent works.
    await sleep(1200);
    assert.equal(agent.state, 'running');
    assert.equal(runner.pool.size, 1, 'idle close waits for background work');

    await waitFor(() => agent.state !== 'running');
    assert.equal(agent.state, 'done');
    assert.match(agent.output, /Subagent finished\./);
    assert.equal(agent.usage.toolUses, 1);
    assert.ok(agent.usage.tokens > 0);
    assert.ok(childrenOf(session, agent.toolId).some((m) => m.role === 'tool' && m.tool === 'Bash' && m.state === 'done'));
    const [notice] = agentNotices(session);
    assert.equal(notice.agentToolId, agent.toolId);
    assert.equal(notice.text, 'Background agent “Check the workspace slowly” finished.');
    assert.equal(publicSession(session).backgroundAgents, 0);

    // Claude Code reads the report in a turn of its own, after the notice.
    await waitFor(() => footers(session) === 2 && !runner.isRunning(session.id));
    assert.ok(session.messages.indexOf(notice) < session.messages.findLastIndex((m) => m.role === 'assistant' && !m.parentToolId));
    assert.equal(spawns.length, 1);
    // Nothing keeps it now: it closes when idle.
    await waitFor(() => runner.pool.size === 0, 10_000);
  });

  test('parallel foreground agents on a gateway model nest their own steps and finish with usage', async () => {
    const { runner, session } = harness({ model: 'deepseek' });
    runner.enqueue(session, { text: '[[mock:agents:foreground]] two at once' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));
    const both = agents(session);
    assert.deepEqual(
      both.map((m) => m.input.description),
      ['First probe', 'Second probe'],
    );
    for (const agent of both) {
      assert.equal(agent.state, 'done');
      assert.ok(!agent.background);
      assert.ok(agent.taskId);
      assert.equal(agent.usage.toolUses, 1);
      const steps = childrenOf(session, agent.toolId).filter((m) => m.role === 'tool');
      assert.equal(steps.length, 1, `${agent.input.description} has its own Bash call`);
      assert.match(agent.output, /Subagent finished\./);
    }
    assert.notEqual(both[0].taskId, both[1].taskId);
    assert.deepEqual(agentNotices(session), [], 'foreground agents need no notice');
    assert.equal(session.status, 'idle');
  });

  test('a permission request from inside an agent names the agent', async () => {
    const { runner, session, work } = harness({ mode: 'default' });
    runner.enqueue(session, { text: '[[mock:agent-ask]] create it through an agent' });
    await waitFor(() => session.pending?.length > 0);
    const [agent] = agents(session);
    const [pending] = session.pending;
    assert.equal(pending.tool, 'Bash');
    assert.deepEqual(pending.agent, { toolId: agent.toolId, description: 'Touch a file', subagentType: 'general-purpose' });
    assert.equal(runner.resolveApproval(pending.id, { decision: 'allow' }), true);
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));
    assert.equal(agent.state, 'done');
    assert.ok(fs.existsSync(path.join(work, 'subagent.txt')));
  });

  test('stopping a background agent ends it as stopped; the session carries on', async () => {
    const setup = harness();
    const { runner, session, spawns } = setup;
    runner.enqueue(session, { text: '[[mock:agent-slow]] delegate this' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));
    const [agent] = agents(session);
    assert.equal(agent.state, 'running');

    assert.deepEqual(await runner.stopAgent(session, 'toolu_unknown'), { status: 404, error: 'Agent not found' });
    assert.equal(await runner.stopAgent(session, agent.toolId), true);
    assert.deepEqual(spawns[0].controls.find(([method]) => method === 'stopTask'), ['stopTask', agent.taskId]);
    await waitFor(() => agent.state !== 'running', 10_000);
    assert.equal(agent.state, 'error');
    assert.equal(agent.stopped, true);
    assert.equal(agentNotices(session)[0].text, 'Background agent “Check the workspace slowly” was stopped.');
    assert.equal((await runner.stopAgent(session, agent.toolId)).status, 409);

    // Claude Code tells the model; then the session takes the next message as usual.
    await waitFor(() => !runner.isRunning(session.id) && footers(session) >= 1);
    await sleep(500);
    await waitFor(() => !runner.isRunning(session.id));
    const before = footers(session);
    runner.enqueue(session, { text: 'still there?' });
    await waitFor(() => footers(session) > before && !runner.isRunning(session.id));
    assert.equal(session.status, 'idle');
  });

  test('stopping a foreground agent ends only that agent; the turn goes on', async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:agent-slow:foreground]] delegate and wait' });
    await waitFor(() => agents(session)[0]?.taskId && childrenOf(session, agents(session)[0].toolId).length > 0);
    const [agent] = agents(session);
    assert.equal(await runner.stopAgent(session, agent.toolId), true);
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));
    assert.equal(agent.state, 'error');
    assert.equal(agent.stopped, true);
    const turn = session.messages.find((m) => m.role === 'turn');
    assert.ok(!turn.stopped, 'the turn itself was not stopped');
    assert.match(session.messages.findLast((m) => m.role === 'assistant' && !m.parentToolId).text, /^Tool result: error/);
  });
});
