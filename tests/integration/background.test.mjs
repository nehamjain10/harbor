// Background tasks and scheduled jobs end to end: real Claude Code turns through the
// runner, the normalizing proxy and the mock gateway (the bg and cron scripts in
// mock-gateway.mjs). A background command's live set, output file and end; stopping one;
// the jobs from the Stop hook keeping the process up, a one-shot wakeup lost with its
// process, and recurring jobs resumed at boot. Isolated: no settings sources, a throwaway
// CLAUDE_CONFIG_DIR, gateway models only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { createRunner } from '../../server/runner.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { listTasks, readTaskOutput } from '../../server/tasks.mjs';
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-background-'));
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
function harness({ idleMs } = {}) {
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
  const session = store.insert(createSession({ cwd: work, model: 'luna', mode: 'bypassPermissions' }));
  return { runner, session, spawns: query.spawns };
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
const bashCalls = (session) => session.messages.filter((m) => m.role === 'tool' && m.tool === 'Bash');

describe('background tasks (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('a background command is live while it runs, its output is readable, and its end is recorded', async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:bg:3]] count' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));

    const [call] = bashCalls(session);
    assert.equal(call.state, 'done', 'the call itself finished');
    assert.equal(call.background, true);
    assert.equal(call.task.kind, 'shell');
    assert.match(call.task.output, /\/tasks\/[a-z0-9]+\.output$/);
    assert.deepEqual(
      session.liveTasks.map((task) => [task.id, task.type, task.description]),
      [[call.taskId, 'local_bash', 'Count ticks']],
    );
    assert.equal(publicSession(session).liveTasks.length, 1);
    const listed = listTasks(session);
    assert.equal(listed.running.length, 1);
    assert.equal(listed.running[0].toolId, call.toolId);
    assert.match(listed.running[0].command, /^for i in/);

    await waitFor(() => /tick 1/.test(readTaskOutput(session, call.taskId)?.text || ''), 10_000);
    await waitFor(() => call.task.status === 'completed', 15_000);
    assert.equal(session.liveTasks, undefined);
    assert.match(call.task.summary, /completed \(exit code 0\)/);
    const output = readTaskOutput(session, call.taskId);
    assert.match(output.text, /tick 1\ntick 2\ntick 3\n/);
    const done = listTasks(session);
    assert.equal(done.running.length, 0);
    assert.deepEqual(
      done.finished.map((task) => [task.id, task.status, task.exitCode]),
      [[call.taskId, 'completed', 0]],
    );
    // Claude Code reads the notice in a turn of its own.
    await waitFor(() => footers(session) === 2 && !runner.isRunning(session.id));
  });

  test('a running background command stops on request, and the session records it as stopped', async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:bg:60]] count for a minute' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id) && session.liveTasks?.length === 1);
    const [call] = bashCalls(session);
    assert.deepEqual(await runner.stopTask(session, 'nosuchtask'), { status: 409, error: 'This task is not running.' });
    assert.equal(await runner.stopTask(session, call.taskId), true);
    await waitFor(() => call.task.status === 'stopped' && !session.liveTasks, 15_000);
    assert.deepEqual(await runner.stopTask(session, call.taskId), { status: 409, error: 'This task is not running.' });
  });

  test("a background command ends with its process: it shows as stopped and leaves the live set", async () => {
    const { runner, session } = harness();
    runner.enqueue(session, { text: '[[mock:bg:60]] count for a minute' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id) && session.liveTasks?.length === 1);
    const [call] = bashCalls(session);
    await runner.pool.kill(session.id, 'restart');
    assert.equal(call.task.status, 'stopped');
    assert.equal(session.liveTasks, undefined);
    assert.equal(listTasks(session).finished[0].status, 'stopped');
  });

  test('scheduled jobs keep the process up; a one-shot wakeup is lost with it, recurring jobs are resumed at boot', async () => {
    const { runner, session, spawns } = harness({ idleMs: 300 });
    runner.enqueue(session, { text: '[[mock:cron]] schedule' });
    await waitFor(() => footers(session) === 1 && !runner.isRunning(session.id));
    await waitFor(() => (session.crons || []).length === 2, 5_000);
    const [recurring, wakeup] = session.crons;
    assert.deepEqual([recurring.schedule, recurring.recurring, recurring.prompt], ['*/30 * * * *', true, 'Check the run.']);
    assert.equal(wakeup.recurring, false);
    assert.equal(wakeup.prompt, 'Look again.');
    assert.deepEqual(publicSession(session).crons, session.crons);
    assert.equal(listTasks(session).scheduled.length, 2);

    // Well past the idle timeout: the jobs keep it up.
    await sleep(1200);
    assert.equal(runner.pool.size, 1, 'idle close waits for scheduled jobs');

    // The process goes (a restart): the wakeup is lost with a notice, the job stays.
    await runner.pool.kill(session.id, 'restart');
    assert.deepEqual(
      session.crons.map((cron) => cron.id),
      [recurring.id],
    );
    assert.match(session.messages.at(-1).text, /^A scheduled wakeup was lost when Claude Code restarted/);

    // Boot: the conversation is resumed, sent nothing, so the job fires on.
    const turns = footers(session);
    await runner.resumeScheduled([session], { staggerMs: 0 });
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].options.resume, session.sdkSessionId);
    assert.equal(runner.pool.size, 1);
    await sleep(500);
    assert.equal(footers(session), turns, 'no turn was started');
    // The next turn's Stop hook confirms the job came back with the conversation.
    runner.enqueue(session, { text: 'hello again' });
    await waitFor(() => footers(session) === turns + 1 && !runner.isRunning(session.id));
    assert.deepEqual(
      session.crons.map((cron) => [cron.id, cron.since]),
      [[recurring.id, recurring.since]],
    );
    assert.equal(session.cronsKnown, true);

    // A session from before Harbor kept track (no crons recorded): its job is read back
    // from the transcript at boot and the conversation resumed for it.
    await runner.pool.kill(session.id, 'restart');
    delete session.crons;
    delete session.cronsKnown;
    await runner.resumeScheduled([session], { staggerMs: 0 });
    assert.deepEqual(session.crons.map((cron) => [cron.id, cron.schedule, cron.recurring]), [[recurring.id, '*/30 * * * *', true]]);
    assert.equal(spawns.length, 3);
    assert.equal(spawns.at(-1).options.resume, session.sdkSessionId);
    assert.equal(runner.pool.size, 1);
    // Once a Stop hook has reported, its list is the truth: an empty one is never read back.
    await runner.pool.kill(session.id, 'restart');
    session.cronsKnown = true;
    delete session.crons;
    await runner.resumeScheduled([session], { staggerMs: 0 });
    assert.equal(session.crons, undefined);
    assert.equal(runner.pool.size, 0);
  });
});
