// Conversation flows: a first session from the empty state, tool cards, model switch,
// stop, queueing and steering while a turn runs, one Claude Code process per session,
// and reloading in the middle of a turn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSession,
  flow,
  lastAssistant,
  send,
  sendAndWait,
  sessionRequests,
  textOf,
  toolsOf,
  turnRequests,
  turnsOf,
  waitFor,
  waitForText,
  waitForTurns,
} from './helpers.mjs';

export function chatFlows(ctx) {
  flow(ctx, 'new session from the empty state: hello renders a reply, a turn footer and a titled sidebar row', async ({ stack, openPage }) => {
    const repo = stack.makeRepo('hello');
    const { page } = await openPage({ storage: { 'mesh-code-project': repo } });
    await page.locator('.empty-title').waitFor();
    assert.equal(await textOf(page.locator('.crumb-project')), path.basename(repo));
    await send(page, 'hello');

    await page.waitForFunction(() => new URLSearchParams(location.search).has('session'));
    const id = new URL(page.url()).searchParams.get('session');
    const session = await waitForTurns(stack, id, 1);

    // Server state.
    assert.equal(session.cwd, repo);
    assert.equal(session.model, 'luna');
    assert.equal(session.title, 'hello');
    assert.equal(session.status, 'idle');
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ['user', 'assistant', 'turn'],
    );
    assert.equal(session.messages[0].delivery, 'done');
    assert.equal(lastAssistant(session), 'ok');
    assert.equal(turnRequests(stack).at(-1).model, 'codex/gpt-6-luna');

    // UI state.
    await waitForText(page.locator('.msg-assistant .markdown, .msg-assistant').last(), /\bok\b/);
    // A normal end joins the reply (its stats in the reply's actions row).
    await page.locator('.msg-assistant.has-turn-end').waitFor();
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    assert.equal(await textOf(page.locator('.user-bubble')), 'hello');
    assert.equal(await textOf(page.locator('.crumb-title')), 'hello');
    const row = page.locator('.session-row', { hasText: 'hello' });
    await row.waitFor();
    assert.equal(await textOf(row.locator('.session-title')), 'hello');
    // One-line rows: the project is in the tooltip.
    await row.locator('.session-main').hover();
    assert.match((await row.locator('.session-main').getAttribute('title')) || '', new RegExp(path.basename(repo)));
    assert.equal(await row.getAttribute('class').then((c) => c.includes('is-active')), true);
  });

  flow(ctx, 'tool cards: bash, read, edit, todos, thinking and a foreground agent render with summaries and details', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Tool cards' });
    const { page } = await openSession(session.id);

    await sendAndWait(stack, page, session.id, 'Check the shell. [[mock:bash]]');
    const bash = page.locator('.tool', { has: page.locator('.tool-row', { hasText: 'echo mock-bash' }) });
    assert.equal(await textOf(bash.locator('.tool-verb')), 'Ran');
    assert.equal(await textOf(bash.locator('.tool-target')), 'echo mock-bash');
    await bash.locator('.tool-row').click();
    await waitForText(bash.locator('.command-block'), /echo mock-bash/);
    await waitForText(bash.locator('.output-pre'), /^mock-bash$/);

    await sendAndWait(stack, page, session.id, 'Read it. [[mock:read-empty-pages]]');
    const read = page.locator('.tool', { has: page.locator('.tool-verb', { hasText: /^Read$/ }) }).last();
    assert.match(await textOf(read.locator('.tool-target')), /^hello\.txt(:1)?$/);
    await read.locator('.tool-row').click();
    await waitForText(read.locator('.tool-detail'), /hello world/);

    let current = await sendAndWait(stack, page, session.id, 'Fix the greeting. [[mock:edit]]');
    assert.deepEqual(
      toolsOf(current).slice(-2).map((m) => [m.tool, m.state]),
      [
        ['Read', 'done'],
        ['Edit', 'done'],
      ],
    );
    const group = page.locator('.activity:not(.is-single)').last();
    assert.equal(await textOf(group.locator('.activity-summary')), 'Read 1 file, edited 1 file');
    await group.locator('.activity-head').click();
    const edit = group.locator('.tool', { has: page.locator('.tool-verb', { hasText: 'Edited' }) });
    assert.equal(await textOf(edit.locator('.tool-target')), 'hello.txt');
    assert.equal(await textOf(edit.locator('.tool-stats')), '+1 −1');
    await edit.locator('.tool-row').click();
    await waitForText(edit.locator('.tool-detail'), /goodbye/);

    current = await sendAndWait(stack, page, session.id, 'Plan the work. [[mock:todos-as-string]]');
    assert.deepEqual(
      current.todos.map((todo) => todo.status),
      ['completed', 'in_progress', 'pending'],
    );
    const todos = page.locator('.tool', { has: page.locator('.tool-verb', { hasText: 'Updated tasks' }) });
    assert.equal(await textOf(todos.locator('.tool-target')), 'Writing the fix');
    await todos.locator('.tool-row').click();
    await waitForText(todos.locator('.tool-detail'), /Inspect the repository.*Writing the fix.*Run the tests/);
    const strip = page.locator('.tasks-strip');
    await waitForText(strip.locator('.tasks-count'), /^1 of 3$/);
    assert.equal(await textOf(strip.locator('.tasks-current')), 'Writing the fix');
    await strip.locator('.tasks-head').click();
    await waitForText(strip.locator('.tasks-body'), /Inspect the repository/);

    current = await sendAndWait(stack, page, session.id, 'Think first. [[mock:thinking]]');
    assert.equal(current.messages.find((m) => m.role === 'thinking')?.text, 'Let me think about this step by step. The answer is 42.');
    const thinking = page.locator('.thinking').last();
    await waitForText(thinking.locator('.thinking-toggle'), /^Thought for \d+s$/);
    await thinking.locator('.thinking-toggle').click();
    await waitForText(thinking.locator('.thinking-text'), /The answer is 42/);
    await waitForText(page.locator('.msg-assistant').last(), /The answer is 42\./);

    current = await sendAndWait(stack, page, session.id, 'Delegate. [[mock:agent:foreground]]');
    const agentTool = toolsOf(current, 'Agent')[0];
    assert.equal(agentTool.state, 'done');
    assert.ok(
      current.messages.some((m) => m.parentToolId === agentTool.toolId && m.role === 'tool' && m.tool === 'Bash'),
      'the subagent Bash call is nested under the Agent call',
    );
    const agent = page.locator('.tool', { has: page.locator('.tool-verb', { hasText: 'Ran agent' }) });
    assert.equal(await textOf(agent.locator('.tool-row .tool-target')), 'Check the workspace');
    assert.equal(await textOf(agent.locator('.tool-row .tool-badge')), 'general-purpose');
    // A finished agent says what it took, as Claude Code does.
    await waitForText(agent.locator('.tool-row .tool-meta'), /^1 tool use · \d+(\.\d)?k? tokens · \d+s$/);
    assert.deepEqual(Object.keys(agentTool.usage).sort(), ['durationMs', 'tokens', 'toolUses']);
    await agent.locator('.tool-row').first().click();
    const child = agent.locator('.tool-detail .tool-row', { hasText: 'echo subagent-ok' });
    await child.waitFor();
    assert.equal(await textOf(child.locator('.tool-verb')), 'Ran');
    await waitForText(agent.locator('.tool-detail'), /Subagent finished\./);
  });

  flow(ctx, 'model switch mid-session (luna → deepseek): the next request carries the switch note', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Switch models' });
    const { page } = await openSession(session.id);
    await sendAndWait(stack, page, session.id, 'hello');
    assert.equal(turnRequests(stack).at(-1).model, 'codex/gpt-6-luna');

    await page.locator('.chip-model').click();
    const picker = page.locator('.picker-popover');
    await picker.waitFor();
    await picker.locator('.menu-row', { hasText: 'DeepSeek V4.1 Flash' }).click();
    await waitForText(page.locator('.chip-model .chip-label'), /^DeepSeek V4.1 Flash$/);
    await waitFor(async () => (await stack.api('GET', `sessions/${session.id}`)).model === 'deepseek', { message: 'the model PATCH' });

    const after = await sendAndWait(stack, page, session.id, 'who are you now?');
    const request = turnRequests(stack).at(-1);
    assert.equal(request.model, 'litellm/DeepSeek-V4-Flash');
    assert.match(request.human, /\[Harbor: from this message on you are DeepSeek V4.1 Flash \(route litellm\/DeepSeek-V4-Flash, provider DeepSeek\); earlier turns in this conversation ran on GPT-6 Luna\./);
    assert.match(request.human, /who are you now\?/);
    assert.equal(after.lastTurnModel, 'deepseek');
    // The transcript shows what the user typed, not the note, and the reply's model.
    assert.equal(await textOf(page.locator('.user-bubble').last()), 'who are you now?');
    await waitForText(page.locator('.msg-assistant').last().locator('.assistant-model'), /^DeepSeek V4.1 Flash$/);
  });

  flow(ctx, 'stop: Esc twice during a slow stream marks the turn stopped and leaves the composer usable', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Stop me' });
    const { page } = await openSession(session.id);
    await send(page, 'Stream slowly. [[mock:slow]]');
    await waitForText(page.locator('.msg-assistant.is-live'), /chunk 2/);
    await waitForText(page.locator('.status-pill'), /^Working$/);
    assert.equal(await page.locator('.stop-btn').count(), 1);

    await page.locator('.composer-input').press('Escape');
    await page.locator('.esc-hint').waitFor();
    await page.locator('.composer-input').press('Escape');

    const stopped = await waitFor(
      async () => {
        const current = await stack.api('GET', `sessions/${session.id}`);
        return current.status === 'idle' && current.messages[0].delivery === 'stopped' ? current : null;
      },
      { timeout: 10_000, message: 'the turn to stop' },
    );
    assert.ok(!stopped.messages.some((m) => m.role === 'turn' && m.isError), 'a stop is not an error');
    assert.ok(stopped.messages.some((m) => m.role === 'notice' && /^Stopped\./.test(m.text)));
    await waitForText(page.locator('.msg-user .msg-meta'), /Stopped/);
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    await waitFor(async () => (await page.locator('.stop-btn').count()) === 0, { message: 'the stop button to go away' });
    assert.equal(await page.locator('.composer-input').getAttribute('placeholder'), 'Reply, or describe the next change…');

    // The composer works again (and sending resumes the paused queue).
    const after = await sendAndWait(stack, page, session.id, 'hello again');
    assert.equal(lastAssistant(after), 'ok');
    assert.equal(after.queuePaused, false);
    await waitForText(page.locator('.msg-assistant').last(), /\bok\b/);

    // The Stop button does the same.
    await send(page, 'Stream slowly again. [[mock:slow]]');
    await waitForText(page.locator('.msg-assistant.is-live'), /chunk 1/);
    await page.locator('.stop-btn').click();
    const again = await waitFor(
      async () => {
        const current = await stack.api('GET', `sessions/${session.id}`);
        const last = current.messages.findLast((m) => m.role === 'user');
        return current.status === 'idle' && last.delivery === 'stopped' ? current : null;
      },
      { timeout: 10_000, message: 'the second turn to stop' },
    );
    assert.equal(again.messages.filter((m) => m.role === 'notice' && /^Stopped\./.test(m.text)).length, 2);
    await waitForText(page.locator('.status-pill'), /^Ready$/);
  });

  flow(ctx, 'busy session: a follow-up queues behind the running turn and a mid-turn model switch applies to it', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Queue and switch' });
    const { page } = await openSession(session.id);
    await send(page, 'Stream slowly. [[mock:slow]]');
    await waitForText(page.locator('.msg-assistant.is-live'), /chunk 1/);
    assert.equal(await page.locator('.composer-input').getAttribute('placeholder'), 'Message Claude while it works…');

    // Switch while the turn runs: the chip says it applies next turn.
    await page.locator('.chip-model').click();
    await page.locator('.picker-popover .menu-row', { hasText: 'DeepSeek V4.1 Flash' }).click();
    await waitForText(page.locator('.chip-model'), /DeepSeek V4.1 Flash.*next turn/);

    // Alt+Enter queues it for after the turn instead of sending it into the turn.
    await send(page, 'and then this', { queue: true });
    const queued = await stack.api('GET', `sessions/${session.id}`);
    assert.equal(queued.status, 'running');
    assert.equal(queued.queue.length, 1);
    await waitForText(page.locator('.queue-bar .queue-title'), /^1 queued$/);
    await waitForText(page.locator('.queue-bar .queue-text'), /^and then this$/);

    const done = await waitForTurns(stack, session.id, 2);
    assert.deepEqual(
      done.messages.filter((m) => m.role === 'user').map((m) => [m.text, m.delivery]),
      [
        ['Stream slowly. [[mock:slow]]', 'done'],
        ['and then this', 'done'],
      ],
    );
    const request = turnRequests(stack).at(-1);
    assert.equal(request.model, 'litellm/DeepSeek-V4-Flash');
    assert.match(request.human, /\[Harbor: from this message on you are DeepSeek V4.1 Flash[^\]]*\]\n\nand then this/);
    await page.locator('.queue-bar').waitFor({ state: 'detached' });
    await waitForText(page.locator('.msg-assistant').last().locator('.assistant-model'), /^DeepSeek V4.1 Flash$/);
    assert.doesNotMatch(await textOf(page.locator('.chip-model')), /next turn/);
  });

  flow(ctx, 'steering: a message sent while Claude works reaches it in the same turn', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Steer the turn' });
    const { page } = await openSession(session.id);
    await send(page, 'Run it. [[mock:bash:sleep 3]]');
    await page.locator('.tool', { has: page.locator('.tool-row', { hasText: 'sleep 3' }) }).waitFor();
    assert.equal(await page.locator('.composer-input').getAttribute('placeholder'), 'Message Claude while it works…');

    // Enter sends it into the running turn: it waits above the composer until Claude reads it.
    await send(page, 'also say banana');
    await waitForText(page.locator('.queue-section.is-steering .queue-title'), /^1 sent to Claude$/);
    await waitForText(page.locator('.queue-section.is-steering .queue-text'), /^also say banana$/);
    const running = await stack.api('GET', `sessions/${session.id}`);
    assert.equal(running.status, 'running');
    assert.equal(running.queue.length, 0, 'not queued for later');
    assert.deepEqual(
      running.steering.map((m) => m.text),
      ['also say banana'],
    );

    const done = await waitForTurns(stack, session.id, 1);
    assert.equal(turnsOf(done).length, 1, 'one turn, not a second one after it');
    assert.deepEqual(done.steering, []);
    assert.deepEqual(
      done.messages.filter((m) => m.role === 'user').map((m) => [m.text, m.delivery]),
      [
        ['Run it. [[mock:bash:sleep 3]]', 'done'],
        ['also say banana', 'done'],
      ],
    );
    const order = done.messages.map((m) => (m.role === 'user' ? m.text : m.role === 'tool' ? `tool:${m.tool}` : m.role));
    assert.ok(order.indexOf('also say banana') > order.indexOf('tool:Bash'), `shown after the tool call it followed: ${order.join(', ')}`);
    // The model read it after the tool call, in the same Claude Code session.
    const requests = sessionRequests(stack, session.cwd);
    assert.equal(new Set(requests.map((request) => request.sessionId)).size, 1, 'one Claude Code session id');
    const reached = requests.findIndex((request) => JSON.stringify(request.body.messages).includes('also say banana'));
    assert.ok(reached >= 1, `a request after the tool call carried it (${reached})`);
    assert.equal(requests.length, reached + 1, 'and that request ended the turn');

    // UI: the steering bar is gone and the message sits after the Bash card.
    await page.locator('.queue-bar').waitFor({ state: 'detached' });
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    assert.equal(await page.locator('.msg-assistant.has-turn-end').count(), 1);
    await waitForText(page.locator('.user-bubble').last(), /^also say banana$/);
    const bubbleAfterTool = await page.evaluate(() => {
      const tool = document.querySelector('.tool');
      const bubbles = document.querySelectorAll('.user-bubble');
      return Boolean(tool && bubbles.length === 2 && tool.compareDocumentPosition(bubbles[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(bubbleAfterTool, 'the steering message renders after the tool card');
  });

  flow(ctx, 'interrupt and send now: a long step is cut short and the waiting message runs at once', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Interrupt for me' });
    const { page } = await openSession(session.id);
    await send(page, 'Wait a minute. [[mock:bash:sleep 60]]');
    await page.locator('.tool', { has: page.locator('.tool-row', { hasText: 'sleep 60' }) }).waitFor();
    await send(page, 'never mind, say banana');
    const steering = page.locator('.queue-section.is-steering');
    await waitForText(steering.locator('.queue-note'), /^Read when this step finishes$/);
    await waitForText(steering.locator('.queue-step-label'), /^Running sleep 60$/);

    // Offered once the step has run for a while.
    const button = steering.getByRole('button', { name: 'Interrupt and send now' });
    await button.waitFor({ timeout: 20_000 });
    const clickedAt = Date.now();
    await button.click();
    const done = await waitForTurns(stack, session.id, 2, { timeout: 30_000 });
    assert.ok(Date.now() - clickedAt < 30_000, 'well before the step would have ended');
    assert.equal(done.status, 'idle');
    assert.equal(done.queuePaused, false);
    assert.deepEqual(
      done.messages.filter((m) => m.role === 'user').map((m) => [m.text, m.delivery]),
      [
        ['Wait a minute. [[mock:bash:sleep 60]]', 'interrupted'],
        ['never mind, say banana', 'done'],
      ],
    );
    assert.deepEqual(
      done.messages.filter((m) => m.role === 'notice').map((m) => [m.text, m.level]),
      [['Interrupted to read your messages.', 'info']],
    );
    assert.ok(!turnsOf(done).some((turn) => turn.isError));
    assert.ok(sessionRequests(stack, session.cwd).some((request) => JSON.stringify(request.body.messages).includes('never mind, say banana')));

    await page.locator('.queue-bar').waitFor({ state: 'detached' });
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    await waitForText(page.locator('.turn-footer').first(), /Interrupted for your messages/);
    await waitForText(page.locator('.msg-user .msg-meta').first(), /Interrupted/);
  });

  flow(ctx, 'one Claude Code process per session: turns and a gateway model switch reuse it with one session id', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'One process' });
    const { page } = await openSession(session.id);
    const cwd = fs.realpathSync(session.cwd);
    const mine = () => stack.cliProcesses().filter((proc) => proc.cwd === cwd).map((proc) => proc.pid);

    await sendAndWait(stack, page, session.id, 'hello');
    const first = mine();
    assert.equal(first.length, 1, 'a Claude Code process stays up after the turn');
    await sendAndWait(stack, page, session.id, 'Run something. [[mock:bash]]');
    await sendAndWait(stack, page, session.id, 'And think. [[mock:thinking]]');
    assert.deepEqual(mine(), first, 'the same process ran every turn');

    // A switch between gateway models is applied to the running process.
    await page.locator('.chip-model').click();
    await page.locator('.picker-popover .menu-row', { hasText: 'DeepSeek V4.1 Flash' }).click();
    await waitForText(page.locator('.chip-model'), /DeepSeek V4.1 Flash/);
    const done = await sendAndWait(stack, page, session.id, 'And now you.');
    assert.deepEqual(mine(), first, 'still the same process after the switch');
    assert.equal(turnsOf(done).length, 4);
    assert.ok(done.messages.filter((m) => m.role === 'user').every((m) => m.delivery === 'done'));
    await waitForText(page.locator('.msg-assistant').last().locator('.assistant-model'), /^DeepSeek V4.1 Flash$/);

    // Every request carried the same Claude Code session id (the gateway keys caching on it),
    // and the last one carries the whole conversation.
    const requests = sessionRequests(stack, session.cwd);
    assert.ok(requests.length >= 5, `four turns and a tool round: ${requests.length}`);
    const ids = new Set(requests.map((request) => request.sessionId));
    assert.equal(ids.size, 1, `one Claude Code session id: ${[...ids].join(', ')}`);
    assert.ok([...ids][0], 'sent as X-Claude-Code-Session-Id');
    const last = requests.at(-1);
    assert.equal(last.model, 'litellm/DeepSeek-V4-Flash');
    const history = JSON.stringify(last.body.messages);
    for (const text of ['hello', 'Run something.', 'And think.', 'And now you.']) assert.ok(history.includes(text), `the history has "${text}"`);
  });

  flow(ctx, 'an API error ends the turn with an error notice; the next message works', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'API error' });
    const { page } = await openSession(session.id);
    await send(page, 'Fail please. [[mock:api-error]]');
    const failed = await waitFor(
      async () => {
        const current = await stack.api('GET', `sessions/${session.id}`);
        return ['error', 'idle'].includes(current.status) && current.messages[0].delivery !== 'running' && current.messages.length > 1 ? current : null;
      },
      { timeout: 60_000, message: 'the failed turn to end' },
    );
    assert.equal(failed.status, 'error');
    assert.equal(failed.messages[0].delivery, 'error');
    const notice = failed.messages.find((m) => m.role === 'notice' && m.level === 'error');
    assert.match(notice?.text || '', /Mock API error/);
    await waitForText(page.locator('.notice.notice-error'), /Mock API error/);
    await waitForText(page.locator('.status-pill'), /^Error$/);
    await waitForText(page.locator('.msg-user .msg-meta'), /Failed/);

    // Claude Code re-sends the failed message merged with this one; the mock answers the
    // newest marker, as a gateway would once a transient error is over.
    const after = await sendAndWait(stack, page, session.id, 'hello after the error [[mock:text]]');
    assert.equal(lastAssistant(after), 'ok');
    assert.equal(after.status, 'idle');
    await waitForText(page.locator('.status-pill'), /^Ready$/);
  });

  flow(ctx, 'reload mid-turn: the page reconnects, shows the running turn, then its result', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Reload me' });
    const { page } = await openSession(session.id);
    await send(page, 'Stream slowly. [[mock:slow]]');
    await waitForText(page.locator('.msg-assistant.is-live'), /chunk 3/);

    await page.reload();
    await page.locator('.crumb-title').waitFor();
    await waitForText(page.locator('.status-pill'), /^Working$/);
    await page.locator('.stop-btn').waitFor();
    await waitForText(page.locator('.msg-assistant.is-live'), /chunk \d+/);
    await page.locator('.connection.conn-live').waitFor();

    const done = await waitForTurns(stack, session.id, 1);
    assert.match(lastAssistant(done), /chunk 29/);
    await page.locator('.msg-assistant.has-turn-end').waitFor();
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    await waitForText(page.locator('.msg-assistant').last(), /chunk 29/);
    assert.equal(await page.locator('.msg-assistant.is-live').count(), 0);
    assert.equal(await page.locator('.msg-assistant').count(), 1, 'one reply, not a duplicate of the live text');
  });
}
