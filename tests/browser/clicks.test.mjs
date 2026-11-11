// Clicks answer at once: what a click asks the server for shows before the server
// answers (and is taken back if it refuses), and state a message does not show never
// re-renders it. Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitDelta, emitSession, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

async function waitFor(check, { timeout = 3000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Well under the server delays below: the click is answered locally.
const AT_ONCE = 600;
const SLOW = 2500;

const row = (page, title) => page.locator('.session-main', { hasText: title });
const shows = (page, text) => page.locator('.transcript-column', { hasText: text });
const chip = (page, kind) => page.locator(`.chip-${kind} .chip-label`);
const chipText = (page, kind) => chip(page, kind).textContent();
const option = (page, label) => page.locator('.picker-popover .menu-row', { has: page.locator('.menu-row-label', { hasText: new RegExp(`^${label}$`) }) });

// Runs `act` and returns the ms until `check` holds.
async function timed(act, check, message) {
  const start = Date.now();
  await act();
  await waitFor(check, { timeout: SLOW, message });
  return Date.now() - start;
}

test('clicks: mode, model and effort show before the PATCH answers', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  server.patchDelay = SLOW;
  assert.equal(await chipText(page, 'mode'), 'Bypass');

  await page.locator('.chip-mode').click();
  let ms = await timed(() => option(page, 'Plan').click(), async () => (await chipText(page, 'mode')) === 'Plan', 'the mode chip');
  assert.ok(ms < AT_ONCE, `mode shown after ${ms} ms`);
  assert.ok(server.requests.some((r) => r.method === 'PATCH' && r.body?.mode === 'plan'));

  await page.locator('.chip-model').click();
  ms = await timed(() => option(page, 'Claude Sonnet 5.5').click(), async () => (await chipText(page, 'model')) === 'Sonnet 5.5', 'the model chip');
  assert.ok(ms < AT_ONCE, `model shown after ${ms} ms`);

  await page.locator('.chip-effort').click();
  const pick = page.locator('.picker-popover .menu-row:not(.is-selected)').first();
  const label = await pick.locator('.menu-row-label').textContent();
  ms = await timed(() => pick.click(), async () => (await chipText(page, 'effort')) === label, 'the effort chip');
  assert.ok(ms < AT_ONCE, `effort shown after ${ms} ms`);

  // The answers agree, so nothing changes back.
  await waitFor(() => server.sessions.find((s) => s.id === 's-idle').mode === 'plan', { timeout: SLOW * 2, message: 'the server to apply' });
  await page.waitForTimeout(SLOW + 300);
  assert.equal(await chipText(page, 'mode'), 'Plan');
  assert.equal(await chipText(page, 'model'), 'Sonnet 5.5');
  assert.equal(await chipText(page, 'effort'), label);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('clicks: a refused mode switch goes back and says why', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  server.patchDelay = 400;
  server.patchError = { status: 500, error: 'Could not save the mode.' };
  await page.locator('.chip-mode').click();
  await option(page, 'Plan').click();
  await waitFor(async () => (await chipText(page, 'mode')) === 'Plan', { timeout: AT_ONCE, message: 'the optimistic mode' });
  await waitFor(async () => (await chipText(page, 'mode')) === 'Bypass', { message: 'the rollback' });
  await page.locator('.toast', { hasText: 'Could not save the mode.' }).waitFor();
  assert.equal(server.sessions.find((s) => s.id === 's-idle').mode, 'bypassPermissions');
  await context.close();
});

test('clicks: Stop shows "Stopping…" at once and stays until the turn ends', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-run' });
  await page.locator('.stop-btn').waitFor();
  server.stopDelay = SLOW;
  const ms = await timed(() => page.locator('.stop-btn').click(), () => page.locator('.stop-btn.is-stopping').isVisible(), 'the stopping state');
  assert.ok(ms < AT_ONCE, `stopping shown after ${ms} ms`);
  assert.equal(await page.locator('.stop-btn').isDisabled(), true, 'no second stop');
  assert.equal(await page.locator('.stop-btn').getAttribute('aria-label'), 'Stopping');
  // The answer alone does not end it; the turn ending does.
  await page.waitForTimeout(SLOW + 200);
  assert.equal(await page.locator('.stop-btn.is-stopping').count(), 1);
  const session = server.sessions.find((s) => s.id === 's-run');
  await emitSession(page, { ...session, status: 'idle', turnEndedAt: Date.now(), updatedAt: Date.now() + 1000 });
  await waitFor(async () => (await page.locator('.stop-btn').count()) === 0, { message: 'the stop button to go' });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('clicks: an approval card goes at once, and comes back if the answer fails', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-run' });
  let answer = { status: 200, json: { ok: true } };
  await context.route('**/api/approvals/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return route.fulfill(answer);
  });
  const session = server.sessions.find((s) => s.id === 's-run');
  const card = (id) => ({ id, kind: 'permission', tool: 'Bash', at: Date.now(), toolUseID: id, input: { command: 'ls build' } });
  await emitSession(page, { ...session, status: 'waiting', updatedAt: Date.now() + 1000, pending: [card('pa')] });
  await page.waitForSelector('.approval');
  await page.waitForTimeout(600);
  const ms = await timed(() => page.locator('.approval button', { hasText: 'Allow once' }).click(), async () => (await page.locator('.approval').count()) === 0, 'the card to go');
  assert.ok(ms < AT_ONCE, `card gone after ${ms} ms`);

  answer = { status: 500, json: { error: 'The session is gone.' } };
  await emitSession(page, { ...session, status: 'waiting', updatedAt: Date.now() + 2000, pending: [card('pb')] });
  await page.waitForSelector('.approval');
  await page.waitForTimeout(600);
  await page.locator('.approval button', { hasText: 'Allow once' }).click();
  await waitFor(async () => (await page.locator('.approval').count()) === 0, { timeout: AT_ONCE, message: 'the card to go' });
  await page.locator('.approval').waitFor({ timeout: SLOW });
  await page.locator('.toast', { hasText: 'The session is gone.' }).waitFor();
  await context.close();
});

test('clicks: a sent message shows as "Sending…" until the server has it', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  let sent = null;
  await context.route('**/api/sessions/s-idle/messages', async (route) => {
    sent = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return route.fulfill({ json: { ok: true, queued: false } });
  });
  await page.locator('.composer-input').fill('Now profile the forward pass.');
  const ms = await timed(
    () => page.locator('.composer-input').press('Enter'),
    () => page.locator('.queue-section.is-outgoing', { hasText: 'Now profile the forward pass.' }).isVisible(),
    'the outgoing row',
  );
  assert.ok(ms < AT_ONCE, `outgoing row after ${ms} ms`);
  assert.equal(await page.inputValue('.composer-input'), '', 'the composer clears at once');
  // The server's copy arrives (over the event stream, before the POST answers).
  const idle = server.sessions.find((s) => s.id === 's-idle');
  await emitSession(page, { ...idle, status: 'running', updatedAt: Date.now() + 1000, messages: [...idle.messages, { id: 'u-new', role: 'user', text: 'Now profile the forward pass.', clientId: sent.clientId, at: Date.now(), delivery: 'running' }] });
  await waitFor(async () => (await page.locator('.queue-section.is-outgoing').count()) === 0, { message: 'the outgoing row to go' });
  await shows(page, 'Now profile the forward pass.').waitFor();

  // Two sent back to back both show, and go out in order (the second waits for the first).
  await waitFor(async () => (await page.locator('.send-btn').count()) > 0, { message: 'the send button' });
  const posts = [];
  await context.route('**/api/sessions/s-idle/messages', async (route) => {
    posts.push(route.request().postDataJSON().text);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return route.fulfill({ json: { ok: true, queued: false, steering: true } });
  });
  await page.locator('.composer-input').fill('First of two.');
  await page.locator('.composer-input').press('Enter');
  await page.locator('.composer-input').fill('Second of two.');
  await page.locator('.composer-input').press('Enter');
  assert.deepEqual(await page.locator('.queue-section.is-outgoing .queue-text').allTextContents(), ['First of two.', 'Second of two.']);
  assert.equal(await page.inputValue('.composer-input'), '');
  await waitFor(async () => posts.length === 2, { message: 'both posts' });
  assert.deepEqual(posts, ['First of two.', 'Second of two.']);
  await waitFor(async () => (await page.locator('.queue-section.is-outgoing').count()) === 0, { message: 'both sent' });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('clicks: model, mode and field changes re-render no message', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-old', storage: { 'mesh-code-debug-renders': '1' } });
  await shows(page, '1.2M tokens/s').waitFor();
  // Open s-idle at a revision, so deltas apply to it.
  const idle = server.sessions.find((s) => s.id === 's-idle');
  idle.rev = 100;
  idle.updatedAt = Date.now() + 5000;
  await row(page, 'Review GPU memory profile').click();
  await shows(page, 'Peak is 71 GB').waitFor();
  await page.waitForTimeout(300);
  const renders = () => page.evaluate(() => window.__harborRenders.Entry || 0);
  const reset = () => page.evaluate(() => (window.__harborRenders = {}));
  await reset();

  await page.locator('.chip-mode').click();
  await option(page, 'Plan').click();
  await page.locator('.chip-model').click();
  await option(page, 'Claude Sonnet 5.5').click();
  await waitFor(() => server.sessions.find((s) => s.id === 's-idle').model === 'sonnet', { message: 'the PATCH' });
  await page.waitForTimeout(200);
  assert.equal(await renders(), 0, 'a model or mode change re-renders no message');

  await emitDelta(page, { id: 's-idle', rev: 101, base: 100, count: idle.messages.length, fields: { title: 'GPU memory, live', context: { used: 90_000, window: 200_000 }, updatedAt: Date.now() + 6000 } });
  await page.locator('.session-title', { hasText: 'GPU memory, live' }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await renders(), 0, 'a field delta re-renders no message');

  await emitDelta(page, { id: 's-idle', rev: 102, base: 101, count: idle.messages.length + 1, fields: { updatedAt: Date.now() + 7000 }, messages: [{ id: 'a-new', role: 'assistant', text: 'One more thing.', at: Date.now() }] });
  await shows(page, 'One more thing.').waitFor();
  await page.waitForTimeout(100);
  assert.ok((await renders()) <= 2, `a new message renders itself (and at most its neighbour), got ${await renders()}`);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('clicks: a long session opens with its latest messages; older ones load on the way up', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  const old = server.sessions.find((s) => s.id === 's-old');
  const at = Date.now() - 3600_000;
  old.messages = [];
  for (let i = 0; i < 150; i++) {
    old.messages.push({ id: `u-${i}`, role: 'user', text: `Question ${i}`, at: at + i * 1000, delivery: 'done' });
    old.messages.push({ id: `a-${i}`, role: 'assistant', text: `Answer ${i}`, model: 'luna', at: at + i * 1000 + 500 });
  }
  old.updatedAt = Date.now();
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, 'Answer 149').waitFor();
  const users = () => page.locator('.transcript-column .msg-user').count();
  const first = await users();
  assert.ok(first < 60, `opens with the latest entries only (${first} questions rendered)`);
  // Scrolling up brings the rest, and keeps the reader where they were.
  for (let i = 0; i < 10 && (await shows(page, 'Question 0').count()) === 0; i++) {
    await page.locator('.transcript').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(150);
  }
  assert.equal(await users(), 150, 'all loaded');

  // Find in page sees everything at once. (Left at the bottom, the session opens there
  // again, with only the latest entries.)
  await page.locator('.transcript').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(100);
  await row(page, 'Review GPU memory profile').click();
  await shows(page, 'Peak is 71 GB').waitFor();
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, 'Answer 149').waitFor();
  assert.ok((await users()) < 60);
  await page.keyboard.press('Control+f');
  await waitFor(async () => (await users()) === 150, { message: 'all rows for find' });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('clicks: a session left scrolled up opens where the reader was; one left at the bottom, at the bottom', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  const old = server.sessions.find((s) => s.id === 's-old');
  const at = Date.now() - 3600_000;
  old.messages = [];
  for (let i = 0; i < 150; i++) {
    old.messages.push({ id: `u-${i}`, role: 'user', text: `Question ${i}`, at: at + i * 1000, delivery: 'done' });
    old.messages.push({ id: `a-${i}`, role: 'assistant', text: `Answer ${i}`, model: 'luna', at: at + i * 1000 + 500 });
  }
  old.updatedAt = Date.now();
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, 'Answer 149').waitFor();
  const offsetOf = (text) =>
    page.evaluate((text) => {
      const scroller = document.querySelector('.transcript');
      const bubble = [...document.querySelectorAll('.transcript-column .msg-user')].find((el) => el.textContent.includes(text));
      return bubble ? Math.round(bubble.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null;
    }, text);
  await page.evaluate(() => {
    const bubble = [...document.querySelectorAll('.transcript-column .msg-user')].find((el) => el.textContent.includes('Question 130'));
    const scroller = document.querySelector('.transcript');
    scroller.scrollTop += bubble.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
  });
  await page.waitForTimeout(150);
  const before = await offsetOf('Question 130');
  await page.locator('.jump-latest').waitFor();

  await row(page, 'Review GPU memory profile').click();
  await shows(page, 'Peak is 71 GB').waitFor();
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, 'Answer 149').waitFor();
  const after = await offsetOf('Question 130');
  assert.ok(after !== null && Math.abs(after - before) <= 2, `back at Question 130 (${before} -> ${after})`);
  await page.locator('.jump-latest').waitFor();

  // Page Down from the composer pages the conversation.
  const top = await page.locator('.transcript').evaluate((el) => el.scrollTop);
  await page.locator('.composer textarea').focus();
  await page.keyboard.press('PageDown');
  await waitFor(async () => (await page.locator('.transcript').evaluate((el) => el.scrollTop)) > top + 100, { message: 'paged down' });

  // "Latest", then away and back: the bottom.
  await page.locator('.jump-latest').click();
  await page.locator('.jump-latest').waitFor({ state: 'detached' });
  await row(page, 'Review GPU memory profile').click();
  await shows(page, 'Peak is 71 GB').waitFor();
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, 'Answer 149').waitFor();
  await page.waitForTimeout(100);
  const gap = await page.locator('.transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(gap < 2, `at the bottom (${gap}px above it)`);
  assert.equal(await page.locator('.jump-latest').count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('clicks: pressing a session row starts loading it; the click uses that load', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  server.sessionDelay = 500;
  const box = await row(page, 'Benchmark the tokenizer').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await waitFor(async () => server.sessionFetches['s-old'] === 1, { message: 'the fetch on press' });
  await page.waitForTimeout(400);
  const released = Date.now();
  await page.mouse.up();
  await shows(page, '1.2M tokens/s').waitFor();
  assert.ok(Date.now() - released < 400, 'most of the wait happened during the press');
  assert.equal(server.sessionFetches['s-old'], 1, 'one request');

  // A press that does not become a click is let go; opening the session later works.
  const other = await row(page, 'Fix the sidebar scroll jump').boundingBox();
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
  await page.mouse.down();
  await page.mouse.move(other.x + other.width / 2, other.y + 300);
  await page.mouse.up();
  await waitFor(async () => server.sessionFetches['s-unread'] === 1, { message: 'the pressed fetch' });
  await page.waitForTimeout(3300);
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('session')), 's-old');
  server.sessionDelay = 0;
  await row(page, 'Fix the sidebar scroll jump').click();
  await shows(page, 'visualViewport').waitFor();
  assert.equal(server.sessionFetches['s-unread'], 2);
  assert.deepEqual(server.errors, []);
  await context.close();
});
