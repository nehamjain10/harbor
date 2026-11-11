// Model agent flows: the main model fans work out to workers on other gateway models with
// Harbor's delegate tool (each on its own git worktree), they run in parallel as cards named
// by their model, Claude collects them with wait_agents; a worker nobody waits for is
// stopped from the strip; and the Agents view lists the catalog and Claude Code's subagents.
// Steering through the API (no browser): the lead messages, checks and stops a worker with
// Harbor's tools, and the user messages one through the card's endpoint.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { STEER_TEXT } from '../mock-gateway.mjs';
import { createSession, flow, lastAssistant, send, sessionRequests, textOf, toolsOf, turnsOf, waitFor, waitForText, waitForTurns } from './helpers.mjs';

const DELEGATE = 'mcp__meshy__delegate';
const LUNA = 'codex/gpt-6-luna';
const DeepSeek = 'litellm/DeepSeek-V4-Flash';

/** The user messages sent to the worker under a delegate card. */
const toWorker = (session, card) => session.messages.filter((m) => m.role === 'user' && m.parentToolId === card.toolId);

/** A request the mock got from the worker's model that carried `needle` anywhere in its messages. */
const workerRequest = (stack, model, needle) => stack.mock.requests.find((request) => request.model === model && request.body && JSON.stringify(request.body.messages).includes(needle));

export function modelAgentFlows(ctx) {
  flow(ctx, 'model agents: two gateway workers run in parallel on their own worktrees, as cards named by their model; Claude waits for both and the branches hold their work', async ({ stack, openSession }) => {
    const repo = stack.makeRepo('workers');
    const session = await createSession(stack, { cwd: repo, title: 'Workers' });
    const { page } = await openSession(session.id);

    await send(page, 'Split it. [[mock:delegate:luna,deepseek;wait;sleep=3;worktree;edit]]');
    const strip = page.locator('.agents-strip');
    await strip.waitFor();
    await waitForText(strip.locator('.agent-line').first(), /^Part 1 GPT-6 Luna agent .+ \d+s$/);
    await waitForText(strip.locator('.agent-line').last(), /^Part 2 DeepSeek V4.1 Flash agent .+ \d+s$/);

    const done = await waitForTurns(stack, session.id, 1);
    const workers = toolsOf(done, DELEGATE);
    assert.deepEqual(
      workers.map((m) => [m.input.description, m.agentModel, m.state]),
      [
        ['Part 1', 'luna', 'done'],
        ['Part 2', 'deepseek', 'done'],
      ],
    );
    // Each worker's own steps sit under its card, and the two ran at the same time.
    const steps = workers.map((worker) => toolsOf(done).filter((m) => m.parentToolId === worker.toolId));
    for (const [index, nested] of steps.entries()) assert.deepEqual(nested.map((m) => [m.tool, m.state]), [['Bash', 'done'], ['Write', 'done']], `steps of Part ${index + 1}`);
    const [first, second] = steps.map((nested) => nested[0]);
    assert.ok(first.at < second.endedAt && second.at < first.endedAt, 'the two workers sleep at the same time');

    // Their work is on their branches, not in the project's checkout.
    for (const [index, worker] of workers.entries()) {
      const part = `part-${index + 1}.txt`;
      assert.match(worker.worktree.branch, new RegExp(`^harbor/${worker.agentModel}-[0-9a-f]{6}$`));
      assert.equal(worker.worktree.commits, 1);
      assert.equal(fs.readFileSync(`${worker.worktree.path}/${part}`, 'utf8'), 'written by a worker\n');
      assert.equal(execFileSync('git', ['show', `${worker.worktree.branch}:${part}`], { cwd: repo, encoding: 'utf8' }), 'written by a worker\n');
      assert.equal(fs.existsSync(`${repo}/${part}`), false);
      assert.equal(worker.usage.toolUses, 2);
    }
    // wait_agents handed both reports to Claude, so neither arrives again by itself.
    const [waited] = toolsOf(done, 'mcp__meshy__wait_agents');
    assert.equal(waited.state, 'done');
    assert.match(waited.output, /“Part 1” finished[\s\S]*Worker finished\.[\s\S]*Files changed: `[^`]*part-1\.txt`[\s\S]*harbor\/luna-/);
    assert.match(waited.output, /“Part 2” finished[\s\S]*Worker finished\.[\s\S]*Files changed: `[^`]*part-2\.txt`[\s\S]*harbor\/deepseek-/);
    assert.match(lastAssistant(done), /^Tool result: ok — GPT-6 Luna agent luna-[0-9a-f]{6} “Part 1” finished/);

    await strip.waitFor({ state: 'detached' });
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    assert.equal(await page.locator('.agent-event').count(), 0);
    // The finished group folds to a summary; open it for the cards.
    const group = page.locator('.activity:not(.is-single)').last();
    await waitForText(group.locator('.activity-summary'), /^Ran 2 agents, waited$/);
    await group.locator('.activity-head').click();
    const card = group.locator('.tool', { has: page.locator('.tool-target', { hasText: 'Part 1' }) }).first();
    await waitForText(card.locator('.tool-row'), /^Ran agent Part 1 GPT-6 Luna agent 2 tool uses · .+$/);
    await card.locator('.tool-row').click();
    await waitForText(card.locator('.tool-note').first(), /^Branch harbor\/luna-[0-9a-f]{6} · 1 commit in .+$/);
    await waitForText(card.locator('.tool-detail').first(), /Worker finished\./);
    const after = await stack.api('GET', `sessions/${session.id}`);
    assert.ok(after.totals.models.deepseek, 'the worker counts under its own model');
  });

  flow(ctx, 'a model agent nobody waits for outlives its turn; Stop in the strip ends it and its process, the end is marked by model, and Claude hears of it', async ({ stack, openSession }) => {
    const repo = stack.makeRepo('slow-worker');
    const session = await createSession(stack, { cwd: repo, title: 'Slow worker' });
    const { page } = await openSession(session.id);

    await send(page, 'Start one and carry on. [[mock:delegate:deepseek;sleep=60]]');
    let current = await waitForTurns(stack, session.id, 1);
    const [card] = toolsOf(current, DELEGATE);
    assert.equal(card.state, 'running');
    assert.equal(current.backgroundAgents, 1);
    await waitForText(page.locator('.status-pill'), /agent running$/);
    // The worker's process and its command, both in the project folder.
    const clis = () => stack.cliProcesses().filter((proc) => proc.cwd === repo).length;
    const sleepers = () => {
      let out = '';
      try {
        out = execFileSync('pgrep', ['-f', 'sleep 60 && echo worker-ok'], { encoding: 'utf8' });
      } catch {
        return 0; // none
      }
      return out.split('\n').filter((pid) => {
        try {
          return pid && fs.readlinkSync(`/proc/${pid}/cwd`) === repo;
        } catch {
          return false;
        }
      }).length;
    };
    await waitFor(() => sleepers() > 0, { timeout: 30_000, message: 'the worker to start its command' });
    assert.equal(clis(), 2, 'the main CLI and the worker');

    await page.getByRole('button', { name: 'Stop agent Part 1' }).click();
    current = await waitFor(
      async () => {
        const s = await stack.api('GET', `sessions/${session.id}`);
        const worker = toolsOf(s, DELEGATE)[0];
        return worker.stopped && s.backgroundAgents === 0 && s.status === 'idle' && turnsOf(s).length >= 2 ? s : null;
      },
      { timeout: 30_000, message: 'the worker to stop and Claude to hear of it' },
    );
    assert.equal(toolsOf(current, DELEGATE)[0].state, 'error');
    assert.notEqual(toolsOf(current, 'Bash')[0].state, 'running');
    await waitFor(() => clis() <= 1 && sleepers() === 0, { timeout: 10_000, message: 'the worker process and its command to end' });
    const events = page.locator('.agent-event');
    await waitFor(async () => /DeepSeek V4.1 Flash agent stopped/.test((await events.first().locator('.agent-event-row').innerText())?.replace(/\s+/g, ' ').trim()), { message: 'the end row' });
    await page.locator('.agents-strip').waitFor({ state: 'detached' });
    const told = stack.mock.requests.find((r) => r.human.startsWith('[DeepSeek V4.1 Flash agent stopped]'));
    assert.ok(told, 'the main model is told the worker was stopped');
  });

  flow(ctx, 'the Agents view lists the model agents of the catalog and Claude Code’s own subagents for the project', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Agents view' });
    const { page } = await openSession(session.id);
    const info = await stack.api('GET', 'info');
    await page.locator('.topbar-agents').click();
    const dialog = page.locator('dialog.agents-dialog');
    const subagents = dialog.locator('.agents-section[aria-label="Claude Code subagents"] .agents-item');
    await subagents.first().waitFor({ timeout: 30_000 });
    const names = await subagents.locator('.agents-item-name').allTextContents();
    assert.ok(names.includes('general-purpose') && names.includes('Explore'), names.join(', '));
    const models = await dialog.locator('.agents-section[aria-label="Model agents"] .agents-item-name').allTextContents();
    assert.deepEqual(
      models,
      info.models.map((m) => `${m.name} agent`),
    );
    assert.match(await textOf(dialog.locator('.agents-section[aria-label="Model agents"] .agents-note')), /delegate/);
  });

  flow(ctx, 'model agents: the lead messages a running worker, checks on it and collects it; the worker’s model gets the message and it sits under its card as delivered', async ({ stack }) => {
    const repo = stack.makeRepo('lead-steers');
    const session = await createSession(stack, { cwd: repo, model: 'sol', title: 'Lead steers' });
    await stack.api('POST', `sessions/${session.id}/messages`, { text: 'Start one and steer it. [[mock:delegate:luna;message;check;wait;sleep=6]]', clientId: 'lead-steers-1' });
    const done = await waitForTurns(stack, session.id, 1);

    const [card] = toolsOf(done, DELEGATE);
    assert.equal(card.state, 'done');
    assert.deepEqual(
      toWorker(done, card).map((m) => [m.text, m.from, m.delivery]),
      [[STEER_TEXT, 'lead', 'done']],
      'recorded under the worker’s card and read by it',
    );
    assert.equal(done.messages.filter((m) => m.role === 'user' && !m.parentToolId).length, 1, 'the only top-level user message is the user’s own');
    // Its model was handed the message with the lead's marker.
    assert.ok(workerRequest(stack, LUNA, '[Message from the lead agent]'), 'the worker’s request carries the marker');
    assert.ok(workerRequest(stack, LUNA, STEER_TEXT), 'and the text');

    const [messaged] = toolsOf(done, 'mcp__meshy__message_agent');
    assert.equal(messaged.state, 'done');
    assert.match(messaged.output, /^Sent to GPT-6 Luna agent luna-[0-9a-f]{6}; it reads it at its next step\.$/);
    // The check came while the worker's command ran: its state and step, not a blocking wait.
    const [checked] = toolsOf(done, 'mcp__meshy__check_agents');
    assert.match(checked.output, /^GPT-6 Luna agent luna-[0-9a-f]{6} “Part 1”: running \(\d+ tool uses? · .*\)\.\nLatest step: Bash `sleep 6 && echo worker-ok` \(running now\)\n/);
    assert.match(checked.output, /\nMessages it has not read yet: [01]$/);
    // wait_agents collected the report, so none arrives by itself.
    const [waited] = toolsOf(done, 'mcp__meshy__wait_agents');
    assert.match(waited.output, /“Part 1” finished[\s\S]*Worker finished\./);
    assert.equal(done.backgroundAgents, 0);
    assert.equal(turnsOf(done).length, 1);
    assert.ok(!done.messages.some((m) => m.role === 'notice' && m.agentToolId));
  });

  flow(ctx, 'model agents: the lead stops a worker with stop_agent: its partial report comes back as the tool result, nothing follows by itself, and the unread message is dropped', async ({ stack }) => {
    const repo = stack.makeRepo('lead-stops');
    const session = await createSession(stack, { cwd: repo, model: 'sol', title: 'Lead stops' });
    await stack.api('POST', `sessions/${session.id}/messages`, { text: 'Start one, tell it something and stop it. [[mock:delegate:deepseek;message;stop;sleep=60]]', clientId: 'lead-stops-1' });
    const done = await waitForTurns(stack, session.id, 1);

    const [card] = toolsOf(done, DELEGATE);
    assert.deepEqual([card.state, card.stopped, card.stoppedBy, card.stopReason], ['error', true, 'lead', 'mock stop']);
    assert.equal(card.output, 'Stopped by the lead: mock stop');
    const [stopped] = toolsOf(done, 'mcp__meshy__stop_agent');
    assert.equal(stopped.state, 'done');
    assert.match(stopped.output, /^DeepSeek V4.1 Flash agent deepseek-[0-9a-f]{6} “Part 1” was stopped \(1 tool use · .*\)\.\n\nStopped by the lead: mock stop$/);
    // Its command was running when the message came, so the worker never read it.
    assert.deepEqual(toWorker(done, card).map((m) => [m.from, m.delivery]), [['lead', 'dropped']]);
    assert.equal(toolsOf(done, 'Bash').find((m) => m.parentToolId === card.toolId).state, 'error', 'its command ended with it');
    assert.equal(done.backgroundAgents, 0);
    // The report was the tool result: no notice, no message to the main model, no second turn.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await stack.api('GET', `sessions/${session.id}`);
    assert.equal(turnsOf(after).length, 1);
    assert.ok(!after.messages.some((m) => m.role === 'notice' && m.agentToolId));
    assert.ok(!sessionRequests(stack, repo).some((r) => r.human.startsWith('[DeepSeek V4.1 Flash agent')), 'no report for the main model');
    await waitFor(() => stack.cliProcesses().filter((proc) => proc.cwd === repo).length <= 1, { timeout: 10_000, message: 'the worker process to end (the session’s own stays)' });
  });

  flow(ctx, 'model agents, API only: POST /agents/:toolId/message sends the user’s message to a running worker, which reads it; errors for unknown, empty and finished', async ({ stack }) => {
    const repo = stack.makeRepo('user-steers');
    const session = await createSession(stack, { cwd: repo, model: 'sol', title: 'User steers' });
    await stack.api('POST', `sessions/${session.id}/messages`, { text: 'Start one and carry on. [[mock:delegate:luna;sleep=8]]', clientId: 'user-steers-1' });
    // The worker is at work: its command runs.
    const { card } = await waitFor(
      async () => {
        const current = await stack.api('GET', `sessions/${session.id}`);
        const [worker] = toolsOf(current, DELEGATE);
        const running = worker?.state === 'running' && current.messages.some((m) => m.parentToolId === worker.toolId && m.tool === 'Bash' && m.state === 'running');
        return running ? { card: worker } : null;
      },
      { timeout: 60_000, message: 'the worker to run its command' },
    );
    const route = (toolId) => `sessions/${session.id}/agents/${toolId}/message`;
    const refused = async (toolId, body) => stack.api('POST', route(toolId), body).then(() => assert.fail('expected a refusal'), (error) => error);
    const unknown = await refused('toolu_nope', { text: 'hello' });
    assert.equal(unknown.status, 404);
    assert.match(unknown.message, /Agent not found/);
    const empty = await refused(card.toolId, { text: '   ' });
    assert.equal(empty.status, 400);
    const missing = await stack.api('POST', `sessions/nope/agents/${card.toolId}/message`, { text: 'hello' }).catch((error) => error);
    assert.equal(missing.status, 404);
    assert.equal(toWorker(await stack.api('GET', `sessions/${session.id}`), card).length, 0, 'none of those reached the worker');

    const text = 'Please also mention user-steering-ok.';
    const sent = await stack.api('POST', route(card.toolId), { text, clientId: 'user-msg-1' });
    assert.equal(sent.ok, true);
    assert.equal(typeof sent.messageId, 'string');
    // At once it is in the transcript, unread (the worker's command is still running).
    let current = await stack.api('GET', `sessions/${session.id}`);
    const [message] = toWorker(current, card);
    assert.deepEqual([message.id, message.text, message.from, message.delivery, message.clientId], [sent.messageId, text, 'user', 'sent', 'user-msg-1']);
    assert.equal(current.status, 'idle', 'a message to a worker does not touch the main conversation');
    assert.deepEqual([current.steering, current.queue ?? []], [[], []]);
    assert.equal(current.messages.filter((m) => m.role === 'user' && !m.parentToolId).length, 1);
    // A retry of the same send is acknowledged, not sent again.
    assert.deepEqual(await stack.api('POST', route(card.toolId), { text, clientId: 'user-msg-1' }), { ok: true, messageId: sent.messageId });

    // The worker reads it at its next step (once the command ends), and the model gets it with the user's marker.
    current = await waitFor(
      async () => {
        const latest = await stack.api('GET', `sessions/${session.id}`);
        return toWorker(latest, card)[0]?.delivery === 'done' ? latest : null;
      },
      { timeout: 60_000, message: 'the worker to read the message' },
    );
    assert.equal(toWorker(current, card).length, 1);
    // (The request follows the process taking the message: the mock may still be logging it.)
    await waitFor(() => workerRequest(stack, LUNA, '[Message from the user]'), { message: 'the worker’s request with the user’s marker' });
    assert.ok(workerRequest(stack, LUNA, text), 'the text');

    // Once it has finished the endpoint says so; its report starts the main model's next turn.
    const finished = await waitForTurns(stack, session.id, 2);
    assert.equal(toolsOf(finished, DELEGATE)[0].state, 'done');
    const late = await refused(card.toolId, { text: 'too late' });
    assert.equal(late.status, 409);
    assert.match(late.message, /This agent is not running\./);
    assert.equal(toWorker(await stack.api('GET', `sessions/${session.id}`), card).length, 1);
  });
}
