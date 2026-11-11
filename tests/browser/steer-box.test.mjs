// Real-browser checks for the message box under a running model agent's transcript
// (AgentMessageBox.jsx) against the mocked v2 server (harness.mjs): who gets one, Enter
// and Shift+Enter, the optimistic bubble and its reconciliation with the server's copy,
// a refused message rolled back with the server's reason, Esc, the agent ending under a
// draft, order, scrolling and the phone. Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, buildApp, launch, openApp } from './harness.mjs';
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
const PLACEHOLDER = 'Message GPT-6 Luna agent…';
const box = (page) => panel(page).locator('.agent-message');
const input = (page) => panel(page).getByPlaceholder(PLACEHOLDER);
const sends = (server) => server.requests.filter((r) => r.method === 'POST' && /^sessions\/[^/]+\/agents\/[^/]+\/message$/.test(r.path));
const sendButton = (page) => box(page).getByRole('button', { name: 'Send message' });

async function waitFor(check, { timeout = 5000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Opens the app on the steering session and an agent's panel from its card's button.
async function openPanel(options = {}, { messages, target = 'Parser tests' } = {}) {
  const { page, server, context } = await openApp(browser, options);
  const session = await openSteerSession(page, server, messages || steerMessages(Date.now() - 100_000));
  await openAgentFromCard(page, target);
  return { page, server, session, context };
}

async function openAgentFromCard(page, target) {
  const row = page.locator('.transcript-column .tool', { has: page.locator('.tool-target', { hasText: target }) }).filter({ has: page.locator('.agent-open-btn') }).first();
  await row.locator('.agent-open-btn').click();
  await page.waitForFunction((name) => document.querySelector('.side-panel.is-agent .agent-panel-title')?.textContent === name, target);
}

test('a running model agent has a message box; finished, stopped and Claude Code agents have none, and no error', async () => {
  const { page, server } = await openPanel();
  assert.equal(await box(page).count(), 1);
  assert.equal(await input(page).count(), 1);
  assert.equal(await sendButton(page).isDisabled(), true, 'nothing to send yet');
  assert.equal(await text(box(page).locator('.agent-message-note')), 'Read at its next step Enter to send · Shift+Enter for a new line');
  // Docked under the transcript, inside the panel.
  const panelBox = await panel(page).boundingBox();
  const boxBox = await box(page).boundingBox();
  assert.ok(Math.abs(boxBox.y + boxBox.height - (panelBox.y + panelBox.height)) < 2, 'at the bottom of the panel');
  assert.ok(Math.abs(boxBox.width - panelBox.width) < 2, 'the panel\'s width');

  for (const [target, why] of [['Lexer tests', 'finished'], ['Formatter tests', 'stopped'], ['Survey the repo', 'Claude Code agent']]) {
    await openAgentFromCard(page, target);
    assert.equal(await panel(page).locator('.agent-message').count(), 0, `none for a ${why} agent`);
    assert.equal(await panel(page).locator('[role=alert]').count(), 0);
    assert.equal(await panel(page).locator('.agent-transcript').count(), 1);
  }
  // The Claude Code agent shows the follow-up its lead sent as the lead's message.
  const followUp = panel(page).locator('.steer-msg');
  assert.equal(await followUp.count(), 1);
  assert.equal(await text(followUp.locator('.user-bubble')), 'Also list the test folders.');
  assert.match(await text(followUp.locator('.msg-meta')), /^Lead · Claude Opus 5\.5 · \d{1,2}:\d{2}\s?[AP]M$/);
  assert.deepEqual(sends(server), [], 'nothing was sent');
  // Back to the running one: the box returns.
  await openAgentFromCard(page, 'Parser tests');
  assert.equal(await input(page).count(), 1);
  assert.deepEqual(server.errors, []);
});

test('Enter sends: the message shows at once as "Sending…", the server\'s copy takes its place, none leaks into the conversation', async () => {
  const { page, server, session } = await openPanel();
  server.agentMessageDelay = 600;
  const column = panel(page).locator('.transcript-column');
  await input(page).click();
  await input(page).fill('Please also run the lexer tests.');
  assert.equal(await sendButton(page).isEnabled(), true);
  const started = Date.now();
  await input(page).press('Enter');

  const bubble = column.locator('.steer-msg.is-sending');
  await bubble.waitFor();
  assert.ok(Date.now() - started < 400, 'at once, not after the server answered');
  assert.equal(await text(bubble.locator('.user-bubble')), 'Please also run the lexer tests.');
  assert.match(await text(bubble.locator('.msg-meta')), /^You · \d{1,2}:\d{2}\s?[AP]M · Sending…$/);
  assert.equal(await input(page).inputValue(), '', 'the box is empty again');
  assert.equal(await input(page).evaluate((el) => document.activeElement === el), true, 'and keeps the focus');
  assert.equal(await sendButton(page).isDisabled(), true);
  // After the steps and the messages before it, ahead of the working row.
  assert.deepEqual(await column.evaluate((el) => [...el.children].slice(-3).map((child) => child.className.trim().replace(/\s+/g, ' '))), ['msg-user steer-msg is-user', 'msg-user steer-msg is-user is-sending', 'working']);
  // The conversation shows nothing of it: no "Sending…" bar above the main composer.
  assert.equal(await page.locator('.queue-bar').count(), 0);
  assert.equal(await page.locator('main .transcript-column .msg-user').count(), 1);

  await waitFor(() => server.agentMessages.length === 1, { message: 'the server to get it' });
  const [request] = sends(server);
  assert.equal(request.path, 'sessions/s-old/agents/d1/message');
  assert.equal(request.body.text, 'Please also run the lexer tests.');
  assert.match(request.body.clientId, /^[0-9a-f-]{16,}$/);
  // Accepted, its copy not here yet: it still shows, one bubble.
  await page.waitForTimeout(700);
  assert.equal(await column.locator('.steer-msg', { hasText: 'run the lexer tests' }).count(), 1);

  // The copy arrives over the stream: the same bubble, now "Read at its next step".
  const handle = await bubble.elementHandle();
  await pushDelta(page, session, [server.agentMessages[0]]);
  await column.locator('.steer-msg.is-sending').waitFor({ state: 'detached' });
  const copies = column.locator('.steer-msg', { hasText: 'run the lexer tests' });
  assert.equal(await copies.count(), 1, 'one bubble, not two');
  assert.match(await text(copies.locator('.msg-meta')), /^You · \d{1,2}:\d{2}\s?[AP]M · Read at its next step$/);
  assert.equal(await handle.evaluate((el) => el.isConnected), true, 'the bubble is the same element');
  // The worker reads it.
  await pushDelta(page, session, [{ ...server.agentMessages[0], delivery: 'done' }]);
  await copies.locator('.msg-meta-note').waitFor({ state: 'detached' });
  // Nothing of it in the conversation, and it gives up no "Sending…" later.
  assert.equal(await page.locator('main .transcript-column .msg-user').count(), 1);
  assert.equal(await page.locator('.queue-bar').count(), 0);
  await page.waitForTimeout(100);
  assert.equal(await column.locator('.steer-msg', { hasText: 'run the lexer tests' }).count(), 1);
  assert.deepEqual(server.errors, []);
});

test('Shift+Enter adds a line and sends nothing; Enter then sends the lines as typed; blank text never sends', async () => {
  const { page, server } = await openPanel();
  await input(page).click();
  await page.keyboard.type('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  assert.equal(await input(page).inputValue(), 'first line\nsecond line');
  assert.deepEqual(sends(server), []);
  // The box grew by a line (and stays within a few).
  const one = await input(page).evaluate((el) => el.offsetHeight);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('third line');
  assert.ok((await input(page).evaluate((el) => el.offsetHeight)) > one, 'grows with the text');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+Enter');
  assert.ok((await input(page).evaluate((el) => el.offsetHeight)) < 200, 'up to a few lines');
  await input(page).fill('first line\nsecond line');
  await page.keyboard.press('Enter');
  await waitFor(() => sends(server).length === 1, { message: 'the send' });
  assert.equal(sends(server)[0].body.text, 'first line\nsecond line');
  const bubble = panel(page).locator('.steer-msg', { hasText: 'first line' });
  assert.equal(await bubble.locator('.user-bubble').evaluate((el) => el.innerText), 'first line\nsecond line');
  assert.equal(await input(page).inputValue(), '');

  // Spaces and newlines alone are nothing.
  await input(page).fill('  \n ');
  assert.equal(await sendButton(page).isDisabled(), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(sends(server).length, 1);
  // The button sends too, and Ctrl+Enter.
  await input(page).fill('by button');
  await sendButton(page).click();
  await input(page).fill('by shortcut');
  await page.keyboard.press('Control+Enter');
  await waitFor(() => sends(server).length === 3, { message: 'both sends' });
  assert.deepEqual(sends(server).map((r) => r.body.text), ['first line\nsecond line', 'by button', 'by shortcut']);
  assert.deepEqual(server.errors, []);
});

test('a message the server refuses (409) leaves the transcript, its text returns to the box and the reason shows under it', async () => {
  const { page, server } = await openPanel();
  server.agentMessageError = { status: 409, error: 'That agent is not running.' };
  server.agentMessageDelay = 300;
  await input(page).fill('Try this instead.');
  await page.keyboard.press('Enter');
  const bubble = panel(page).locator('.steer-msg.is-sending');
  await bubble.waitFor();
  assert.equal(await text(bubble.locator('.user-bubble')), 'Try this instead.');
  // Refused: gone again, the words back in the box, the reason inline.
  await bubble.waitFor({ state: 'detached' });
  assert.equal(await panel(page).locator('.steer-msg', { hasText: 'Try this instead.' }).count(), 0);
  assert.equal(await input(page).inputValue(), 'Try this instead.');
  const alert = box(page).locator('[role=alert]');
  assert.equal(await text(alert), 'That agent is not running.');
  assert.equal(await input(page).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('.toast').count(), 0, 'inline, not a toast');
  assert.equal(await page.locator('main .transcript-column .msg-user').count(), 1);

  // Typing clears the reason; with the server back, the same words go through.
  server.agentMessageError = null;
  server.agentMessageDelay = 0;
  await input(page).press('End');
  await page.keyboard.type(' Thanks.');
  assert.equal(await alert.count(), 0);
  await page.keyboard.press('Enter');
  await waitFor(() => server.agentMessages.length === 1, { message: 'the retry' });
  assert.equal(server.agentMessages[0].text, 'Try this instead. Thanks.');
  assert.equal(sends(server).length, 2);

  // Text typed while a send was failing is kept: the failed words go ahead of it.
  server.agentMessageError = { status: 500, error: 'Something broke on the server.' };
  server.agentMessageDelay = 400;
  await input(page).fill('first try');
  await page.keyboard.press('Enter');
  await input(page).fill('typed meanwhile');
  await waitFor(async () => (await input(page).inputValue()).startsWith('first try'), { message: 'the failed text back' });
  assert.equal(await input(page).inputValue(), 'first try\ntyped meanwhile');
  assert.equal(await text(box(page).locator('[role=alert]')), 'Something broke on the server.');
  assert.deepEqual(server.errors.filter((e) => !/status of (409|500)/.test(e)), []);
});

test('a send that got no answer is recognised as the same message when sent again (same clientId)', async () => {
  const { page, server, context } = await openPanel();
  const tries = [];
  await context.route('**/api/sessions/*/agents/*/message', (route) => {
    tries.push(route.request().postDataJSON());
    if (tries.length === 1) return route.abort('connectionreset');
    return route.fallback();
  });
  await input(page).fill('Did that arrive?');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await box(page).locator('[role=alert]').count()) === 1, { message: 'the failure' });
  assert.equal(await text(box(page).locator('[role=alert]')), 'Cannot reach the server. Check your connection.');
  assert.equal(await input(page).inputValue(), 'Did that arrive?');
  await page.keyboard.press('Enter');
  await waitFor(() => server.agentMessages.length === 1, { message: 'the second try' });
  assert.equal(tries.length, 2);
  assert.equal(tries[0].clientId, tries[1].clientId);
  assert.equal(server.agentMessages[0].clientId, tries[0].clientId);
  assert.deepEqual(server.errors.filter((e) => !/ERR_CONNECTION_RESET|Failed to load resource/.test(e)), []);
});

test('Esc: with words typed it leaves the box and keeps them; again it closes the agent; an empty box closes at once', async () => {
  const { page, server } = await openPanel();
  await input(page).click();
  await page.keyboard.type('half a thought');
  await page.keyboard.press('Escape');
  assert.equal(await input(page).evaluate((el) => document.activeElement === el), false, 'left the box');
  assert.equal(await panel(page).count(), 1, 'the panel stays');
  assert.equal(await input(page).inputValue(), 'half a thought');
  assert.deepEqual(sends(server), []);
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.esc-hint').count(), 0, 'not the composer\'s stop hint');

  // The words wait where they were left.
  await openAgentFromCard(page, 'Parser tests');
  assert.equal(await input(page).inputValue(), 'half a thought');
  // Another agent has its own box; the draft is not carried over.
  await input(page).fill('');
  await input(page).click();
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.page-stopped, .toast').count(), 0);
  assert.deepEqual(server.errors, []);
});

test('the agent ends while words are typed: the box stays disabled with a note until discarded; with nothing typed it goes', async () => {
  const { page, server, session } = await openPanel();
  await input(page).fill('Almost done typing this');
  const messages = steerMessages(Date.now() - 100_000, { lunaRunning: false });
  const done = messages.find((m) => m.toolId === 'd1');
  await pushDelta(page, session, [done]);
  await panel(page).locator('.agent-message.is-ended').waitFor();
  assert.equal(await input(page).isDisabled(), true);
  assert.equal(await input(page).inputValue(), 'Almost done typing this');
  assert.equal(await text(box(page).locator('.agent-message-note')), 'GPT-6 Luna agent has ended, so this was not sent. Discard');
  assert.equal(await sendButton(page).isDisabled(), true);
  await box(page).getByRole('button', { name: 'Discard' }).click();
  await box(page).waitFor({ state: 'detached' });
  assert.deepEqual(sends(server), []);

  // Nothing typed: gone as soon as it ends (it was running again for this part).
  const { page: page2, server: server2, session: session2 } = await openPanel();
  assert.equal(await panel(page2).locator('.agent-message').count(), 1);
  await pushDelta(page2, session2, [done]);
  await panel(page2).locator('.agent-message').waitFor({ state: 'detached' });
  assert.match(await text(panel(page2).locator('.agent-status')), /^Finished/);
  assert.deepEqual([...server.errors, ...server2.errors], []);
});

test('a message still on its way when the agent ends is refused, comes back to the box and says why', async () => {
  const { page, server, session } = await openPanel();
  server.agentMessageDelay = 400;
  await input(page).fill('Too late, probably.');
  await page.keyboard.press('Enter');
  await panel(page).locator('.steer-msg.is-sending').waitFor();
  const messages = steerMessages(Date.now() - 100_000, { lunaRunning: false });
  await pushDelta(page, session, [messages.find((m) => m.toolId === 'd1')]);
  await panel(page).locator('.steer-msg.is-sending').waitFor({ state: 'detached' });
  await panel(page).locator('.agent-message.is-ended').waitFor();
  assert.equal(await text(box(page).locator('[role=alert]')), 'That agent is not running. Discard');
  assert.equal(await input(page).inputValue(), 'Too late, probably.');
  await box(page).getByRole('button', { name: 'Discard' }).click();
  await box(page).waitFor({ state: 'detached' });
  assert.deepEqual(server.errors.filter((e) => !/status of 409/.test(e)), []);
});

test('two messages in a row go out in order and both show; sending scrolls an agent that was read further up back to the end', async () => {
  const at = Date.now() - 100_000;
  const messages = steerMessages(at);
  for (let i = 0; i < 60; i++) messages.splice(4, 0, { id: 'w' + i, role: 'assistant', text: `Step ${i}: still working through the cases.`, parentToolId: 'd1', model: 'luna', at: at + 1000 + i });
  const { page, server } = await openPanel({}, { messages });
  server.agentMessageDelay = 250;
  const scroller = panel(page).locator('.transcript');
  const atBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  assert.equal(await atBottom(), true);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForFunction(() => document.querySelector('.agent-transcript .jump-latest'));
  await input(page).fill('one');
  await page.keyboard.press('Enter');
  await input(page).fill('two');
  await page.keyboard.press('Enter');
  const column = panel(page).locator('.transcript-column');
  await waitFor(async () => (await column.locator('.steer-msg.is-sending').count()) === 2, { message: 'both sending' });
  assert.deepEqual(await column.locator('.steer-msg.is-sending .user-bubble').allInnerTexts(), ['one', 'two']);
  await waitFor(atBottom, { message: 'the end of the agent' });
  await waitFor(() => server.agentMessages.length === 2, { message: 'both on the server' });
  assert.deepEqual(sends(server).map((r) => r.body.text), ['one', 'two']);
  assert.deepEqual(server.agentMessages.map((m) => m.text), ['one', 'two']);
  assert.deepEqual(server.errors, []);
});

test('phone: Enter makes a new line, the button sends; the box sits inside the sheet', async () => {
  const { page, server } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, waitForSessions: false });
  Object.assign(server.sessions.find((s) => s.id === 's-old'), { messages: steerMessages(Date.now() - 100_000), status: 'idle', backgroundAgents: 1, rev: 10, model: 'opus' });
  await page.goto(ORIGIN + '/?session=s-old');
  await page.locator('.transcript-column', { hasText: 'Split the test work' }).first().waitFor();
  await page.locator('.transcript-column .tool', { has: page.locator('.tool-target', { hasText: 'Parser tests' }) }).first().locator('.agent-open-btn').tap();
  await panel(page).waitFor();
  assert.equal(await box(page).count(), 1);
  assert.equal(await box(page).locator('.agent-message-keys').isVisible(), false, 'no key hints without a keyboard');
  await input(page).click();
  await page.keyboard.type('from the phone');
  await page.keyboard.press('Enter');
  await page.keyboard.type('and a second line');
  assert.equal(await input(page).inputValue(), 'from the phone\nand a second line');
  assert.deepEqual(sends(server), []);
  const inside = await box(page).evaluate((el) => {
    const sheet = el.closest('.side-panel').getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return rect.bottom <= sheet.bottom + 1 && rect.left >= sheet.left - 1 && rect.right <= sheet.right + 1;
  });
  assert.equal(inside, true);
  await sendButton(page).tap();
  await waitFor(() => sends(server).length === 1, { message: 'the send' });
  assert.equal(sends(server)[0].body.text, 'from the phone\nand a second line');
  assert.deepEqual(server.errors, []);
});
