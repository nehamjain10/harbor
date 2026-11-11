// Real-browser checks for messages to model agents against the mocked v2 server
// (harness.mjs): a message to a worker is never a turn of the conversation (no bubble,
// no new turn) but a step row of the worker's card and a bubble in the worker's own
// transcript, labelled by who sent it and how far it got; the tool rows and cards of the
// lead's message_agent, stop_agent and check_agents; "Stopped by the lead". Run with
// `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, launch, openApp } from './harness.mjs';
import { openSteerSession, pushDelta, steerMessages } from './steer-fixtures.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
const panel = (page) => page.locator('.side-panel.is-agent');
const mainRow = (page, verb, target) => page.locator('.transcript-column .tool-row', { hasText: verb }).filter({ hasText: target }).first();

test('messages to a worker are no turn of the conversation: no bubble, no break in the activity, the sidebar title stays', async () => {
  const { page, server } = await openApp(browser);
  const session = await openSteerSession(page, server, steerMessages(Date.now() - 100_000));

  // The conversation has its one user message; none of the worker's.
  assert.equal(await page.locator('.transcript-column .msg-user').count(), 1);
  assert.equal(await page.locator('.transcript-column .user-bubble', { hasText: 'Skip the fixtures' }).count(), 0);
  assert.equal(await page.locator('.transcript-column .user-bubble', { hasText: 'Also cover the lexer' }).count(), 0);
  // One activity group holds every worker call and the lead's tools around them.
  assert.equal(await page.locator('.transcript-column .activity').count(), 1);
  assert.match(await text(page.locator('.transcript-column .activity-head')), /^Working/);
  assert.equal(await text(page.locator('.session-row.is-active .session-title, .session-main.is-active .session-title').first()), session.title);

  // A message to a worker arriving live changes none of it (and the reply is not re-headed).
  await pushDelta(page, session, [{ id: 'l9', role: 'user', text: 'One more thing for the parser.', parentToolId: 'd1', from: 'lead', delivery: 'sent', at: Date.now() }]);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.transcript-column .msg-user').count(), 1);
  assert.equal(await page.locator('.transcript-column .msg-assistant .assistant-head').count(), 1);
  assert.equal(await page.locator('.working').count(), 0, 'no working row from it');

  // It is a step of the worker's card, one line each, with where it stands.
  await mainRow(page, 'Running agent', 'Parser tests').click();
  const steps = page.locator('.transcript-column .tool', { has: page.locator('.tool-target', { hasText: 'Parser tests' }) }).first().locator('.steer-row');
  assert.equal(await steps.count(), 3);
  assert.equal(await text(steps.nth(0)), 'Lead: Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.');
  assert.equal(await text(steps.nth(1)), 'You: Skip the fixtures directory, it is generated. Read at its next step');
  assert.equal(await text(steps.nth(2)), 'Lead: One more thing for the parser. Read at its next step');
  // One line, however long the text.
  const height = (await steps.nth(0).boundingBox()).height;
  assert.ok(height < 34, `one line (${height}px)`);
  assert.equal(await steps.nth(0).getAttribute('title'), 'Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.');
  assert.deepEqual(server.errors, []);
});

test('a long run of messages to a worker leaves the conversation as it was (200 of them, the window and the copy action intact)', async () => {
  const { page, server } = await openApp(browser);
  const at = Date.now() - 100_000;
  const messages = steerMessages(at);
  for (let i = 0; i < 200; i++) messages.splice(3, 0, { id: 'bulk' + i, role: 'user', text: 'Bulk message ' + i, parentToolId: 'd1', from: 'lead', delivery: 'done', at: at + 100 + i });
  await openSteerSession(page, server, messages);
  assert.equal(await page.locator('.transcript-column .msg-user').count(), 1);
  assert.equal(await page.locator('.transcript-column .msg-assistant').count(), 1);
  assert.equal(await page.locator('.transcript-column', { hasText: 'Bulk message' }).count(), 0, 'closed cards render none of them');
  // Opened, the card keeps its recent steps behind one button, as for any long agent.
  await mainRow(page, 'Running agent', 'Parser tests').click();
  const steps = page.locator('.transcript-column .tool', { has: page.locator('.tool-target', { hasText: 'Parser tests' }) }).first();
  assert.ok((await steps.locator('.steer-row').count()) <= 40);
  assert.match(await text(steps.locator('.more-btn')), /^\d+ earlier steps$/);
  assert.deepEqual(server.errors, []);
});

test('the worker\'s transcript: the lead\'s and the user\'s messages as bubbles, labelled, with their delivery, live', async () => {
  const { page, server } = await openApp(browser);
  const session = await openSteerSession(page, server, steerMessages(Date.now() - 100_000));
  await mainRow(page, 'Running agent', 'Parser tests').locator('xpath=..').locator('.agent-open-btn').click();
  await panel(page).waitFor();
  const column = panel(page).locator('.transcript-column');
  const bubbles = column.locator('.steer-msg');
  await bubbles.nth(1).waitFor();
  assert.equal(await bubbles.count(), 2);

  const lead = bubbles.nth(0);
  assert.equal(await text(lead.locator('.user-bubble')), 'Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.');
  assert.match(await text(lead.locator('.msg-meta')), /^Lead · Claude Opus 5\.5 · \d{1,2}:\d{2}\s?[AP]M$/);
  assert.ok(await lead.evaluate((el) => el.classList.contains('is-lead')));
  const you = bubbles.nth(1);
  assert.equal(await text(you.locator('.user-bubble')), 'Skip the fixtures directory, it is generated.');
  assert.match(await text(you.locator('.msg-meta')), /^You · \d{1,2}:\d{2}\s?[AP]M · Read at its next step$/);

  // In order among the steps: the lead's message after the reply, before the next read.
  const order = await column.evaluate((el) => [...el.children].map((child) => (child.classList.contains('steer-msg') ? 'steer' : child.classList.contains('msg-assistant') ? 'reply' : child.classList.contains('activity') ? 'steps' : child.classList.contains('agent-prompt') ? 'task' : child.className)));
  assert.deepEqual(order.slice(0, 6), ['task', 'steps', 'reply', 'steer', 'steps', 'steer']);

  // The reply after a message is headed again, as after any message.
  assert.equal(await column.locator('.msg-assistant .assistant-head').count(), 1);

  // Read: the note goes. A lead message arrives live; one the worker never got says so.
  await pushDelta(page, session, [{ ...session.messages.find((m) => m.id === 'l2'), delivery: 'done' }]);
  await page.waitForFunction(() => !document.querySelector('.agent-transcript .steer-msg.is-user .msg-meta-note'));
  assert.match(await text(you.locator('.msg-meta')), /^You · \d{1,2}:\d{2}\s?[AP]M$/);
  await pushDelta(page, session, [{ id: 'l3', role: 'user', text: 'Hold on, wrong branch.', parentToolId: 'd1', from: 'lead', delivery: 'dropped', at: Date.now() }]);
  await bubbles.nth(2).waitFor();
  assert.match(await text(bubbles.nth(2).locator('.msg-meta')), /Lead · Claude Opus 5\.5 · .* · Not delivered$/);
  assert.ok(await bubbles.nth(2).evaluate((el) => el.classList.contains('is-dropped')));
  const normal = await lead.locator('.user-bubble').evaluate((el) => getComputedStyle(el).color);
  const muted = await bubbles.nth(2).locator('.user-bubble').evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(muted, normal, 'a message not delivered is muted');
  // Last among the steps, before the working row.
  const tail = await column.evaluate((el) => [...el.children].slice(-2).map((c) => c.className.split(' ')[0]));
  assert.deepEqual(tail, ['steer-msg', 'working'].map((cls) => (cls === 'steer-msg' ? 'msg-user' : cls)));

  // Between turns with its Monitors up, the working row says what it waits on.
  const card = session.messages.find((m) => m.toolId === 'd1');
  await pushDelta(page, session, [{ ...card, progress: { description: 'Waiting on 2 background tasks', toolUses: 3, tokens: 0, waitingOn: 2 } }]);
  await page.waitForFunction(() => document.querySelector('.agent-transcript .working-label')?.textContent === 'Waiting on 2 background tasks');

  // None of it is in the conversation.
  assert.equal(await page.locator('main .transcript-column .msg-user').count(), 1);
  assert.deepEqual(server.errors, []);
});

test('the lead\'s worker tools: rows with the model, the message and the worker; cards with the message, the reason and the report', async () => {
  const { page, server } = await openApp(browser);
  await openSteerSession(page, server, steerMessages(Date.now() - 100_000));
  const rowText = async (verb, target) => text(mainRow(page, verb, target));

  assert.equal(await text(page.locator('.transcript-column .tool-row', { hasText: 'Messaged' }).locator('.tool-verb')), 'Messaged GPT-6 Luna agent');
  assert.equal(await text(page.locator('.transcript-column .tool-row', { hasText: 'Messaged' }).locator('.tool-target')), 'Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.');
  assert.match(await rowText('Checked agents', 'all workers'), /^Checked agents all workers/);
  const stop = page.locator('.transcript-column .tool-row', { has: page.locator('.tool-badge') }).filter({ hasText: 'Formatter tests' }).last();
  assert.match(await text(stop), /^Stopped agent Formatter tests Kimi K3 agent/);

  // The cards.
  await mainRow(page, 'Messaged', 'lexer').click();
  const card = page.locator('.transcript-column .tool-detail', { hasText: 'Message' }).first();
  assert.match(await text(card.locator('.agent-head')), /^GPT-6 Luna agent Parser tests luna-a1b2c3 Transcript$/);
  assert.equal(await text(card.locator('.steer-quote')), 'Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.');
  assert.equal(await text(card.locator('.tool-note')), 'Sent to GPT-6 Luna agent luna-a1b2c3; it reads it at its next step.');
  await card.getByRole('button', { name: 'Transcript' }).click();
  await panel(page).waitFor();
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Parser tests');
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });

  await stop.click();
  const stopCard = page.locator('.transcript-column .tool-detail', { hasText: 'Partial report' }).first();
  assert.match(await text(stopCard.locator('.agent-head')), /^Kimi K3 agent Formatter tests kimi-a1b2c3 Transcript$/);
  assert.equal(await text(stopCard.locator('.tool-note')), 'Reason: The formatter is being rewritten; these tests would be thrown away.');
  assert.match(await text(stopCard.locator('.tool-markdown')), /It had read server\/format\.mjs and drafted two tests\./);

  await mainRow(page, 'Checked agents', 'all workers').click();
  const check = page.locator('.transcript-column .tool-detail', { hasText: 'running, 3 tool uses' }).first();
  assert.match(await text(check.locator('.output-pre')), /^luna-a1b2c3 \(GPT-6 Luna agent, “Parser tests”\): running, 3 tool uses, 8\.2k tokens deepseek-a1b2c3/);
  assert.deepEqual(server.errors, []);
});

test('rows say what a call named: a worker the session has no card for shows its id; a running call shows the present tense', async () => {
  const { page, server } = await openApp(browser);
  const at = Date.now() - 100_000;
  const messages = steerMessages(at);
  messages.splice(-2, 0,
    { id: 'm-x1', role: 'tool', tool: 'mcp__meshy__message_agent', toolId: 'x1', at, state: 'done', input: { id: 'ghost-000000', message: 'Hello?' }, output: 'Sent to GPT-6 Luna agent ghost-000000; it reads it at its next step.' },
    { id: 'm-x2', role: 'tool', tool: 'mcp__meshy__stop_agent', toolId: 'x2', at, state: 'running', input: { id: 'ghost-000000' } },
    { id: 'm-x3', role: 'tool', tool: 'mcp__meshy__check_agents', toolId: 'x3', at, state: 'running', input: { ids: ['luna-a1b2c3', 'kimi-a1b2c3'] } },
  );
  await openSteerSession(page, server, messages);
  assert.match(await text(mainRow(page, 'Messaged agent', 'Hello?')), /^Messaged agent Hello\?/);
  assert.match(await text(mainRow(page, 'Stopping agent', 'ghost-000000')), /^Stopping agent ghost-000000/);
  assert.match(await text(mainRow(page, 'Checking agents', 'Parser tests, Formatter tests')), /^Checking agents Parser tests, Formatter tests/);
  assert.deepEqual(server.errors, []);
});

test('Stopped by the lead where an agent shows as stopped: card note, panel status and end row, the reason; "Stopped" when the user did it', async () => {
  const { page, server } = await openApp(browser);
  const messages = steerMessages(Date.now() - 100_000);
  // The Kimi worker stopped by the lead; the DeepSeek one by the user.
  const deepseek = messages.findIndex((m) => m.toolId === 'd2');
  messages[deepseek] = { ...messages[deepseek], state: 'error', stopped: true, output: 'Stopped by the user before it finished.' };
  await openSteerSession(page, server, messages);

  // Rows: the status icon's tooltip.
  const kimi = page.locator('.transcript-column .tool', { has: page.locator('.tool-verb', { hasText: 'Stopped agent' }) }).filter({ hasText: 'Formatter tests' }).first();
  assert.equal(await kimi.locator('.tool-status.error').getAttribute('title'), 'Stopped by the lead after 30s');
  const lexer = page.locator('.transcript-column .tool', { has: page.locator('.tool-verb', { hasText: 'Stopped agent' }) }).filter({ hasText: 'Lexer tests' }).first();
  assert.equal(await lexer.locator('.tool-status.error').getAttribute('title'), 'Stopped after 1m 0s');

  // Card.
  await kimi.locator('.tool-row').click();
  assert.equal(await text(kimi.locator('.tool-note').last()), 'Stopped by the lead before it finished: The formatter is being rewritten; these tests would be thrown away.');
  await lexer.locator('.tool-row').click();
  assert.equal(await text(lexer.locator('.tool-note').last()), 'Stopped before it finished.');

  // Panel.
  await kimi.locator('.agent-open-btn').click();
  await panel(page).waitFor();
  assert.match(await text(panel(page).locator('.agent-status')), /^Stopped by the lead/);
  assert.match(await text(panel(page).locator('.agent-end')), /^Stopped by the lead The formatter is being rewritten; these tests would be thrown away\./);
  assert.equal(await panel(page).locator('.agent-message').count(), 0, 'no message box for a stopped agent');
  await lexer.locator('.agent-open-btn').click();
  await page.waitForFunction(() => document.querySelector('.agent-panel-title')?.textContent === 'Lexer tests');
  assert.match(await text(panel(page).locator('.agent-status')), /^Stopped\b(?! by)/);
  assert.equal(await text(panel(page).locator('.agent-end')).then((t) => t.replace(/ \d.*$/, '')), 'Stopped');
  assert.deepEqual(server.errors, []);
});
