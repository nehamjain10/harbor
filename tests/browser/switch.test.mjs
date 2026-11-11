// Switching sessions: a session opened before paints from memory at once (kept current
// by SSE events) and is then refreshed from the server; patches answer with the list
// form and leave the open transcript alone. Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitSession, launch, openApp } from './harness.mjs';

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

const row = (page, title) => page.locator('.session-main', { hasText: title });
const shows = (page, text) => page.locator('.transcript-column', { hasText: text });
const openId = (page) => page.evaluate(() => new URLSearchParams(location.search).get('session'));

test('switch: a session opened before shows at once from memory, then the fresh copy', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-unread' });
  await shows(page, 'visualViewport').waitFor();
  // Opening an unread session marks it viewed; the list-form answer keeps the transcript.
  await waitFor(() => server.requests.some((r) => r.method === 'PATCH' && r.body?.viewed), { message: 'viewed PATCH' });
  await page.waitForTimeout(100);
  assert.equal(await shows(page, 'visualViewport').count(), 1);

  await row(page, 'Review GPU memory profile').click();
  await shows(page, 'Peak is 71 GB').waitFor();

  // While another session is open, an SSE event updates the copy in memory.
  const unread = server.sessions.find((s) => s.id === 's-unread');
  unread.messages.push({ id: 'a-sse', role: 'assistant', text: 'Pushed while you were away.', at: Date.now() });
  unread.updatedAt = Date.now();
  await emitSession(page, unread);
  // The server has moved on further, and answers slowly.
  unread.messages.push({ id: 'a-later', role: 'assistant', text: 'Only on the server so far.', at: Date.now() });
  unread.updatedAt = Date.now() + 1;
  server.sessionDelay = 1500;

  const started = Date.now();
  await row(page, 'Fix the sidebar scroll jump').click();
  await shows(page, 'Pushed while you were away.').waitFor({ timeout: 1000 });
  assert.ok(Date.now() - started < 1000, 'painted without waiting for the server');
  assert.equal(await openId(page), 's-unread');
  assert.equal(await shows(page, 'Only on the server so far.').count(), 0);
  await shows(page, 'Only on the server so far.').waitFor({ timeout: 3000 });

  // A session not opened before still waits for the server.
  await row(page, 'Benchmark the tokenizer').click();
  await page.waitForTimeout(300);
  assert.equal(await openId(page), 's-unread');
  await waitFor(async () => (await openId(page)) === 's-old', { message: 'the slow session to open' });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('switch: renaming the open session keeps its transcript (list-form answer)', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  // Rename through the row's options dialog.
  await row(page, 'Review GPU memory profile').hover();
  await page.locator('.session-more[aria-label="Options for Review GPU memory profile"]').click();
  await page.locator('.option-row', { hasText: 'Rename' }).click();
  const input = page.locator('#rename-form input');
  await input.fill('GPU memory, renamed');
  await input.press('Enter');
  await waitFor(() => server.requests.some((r) => r.method === 'PATCH' && r.body?.title === 'GPU memory, renamed'), { message: 'rename PATCH' });
  await page.locator('.session-title', { hasText: 'GPU memory, renamed' }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await shows(page, 'Peak is 71 GB').count(), 1, 'the transcript is still there');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('switch: a session held at the server\'s revision is not sent again', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  server.sessions.find((s) => s.id === 's-old').rev = 7;
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, '1.2M tokens/s').waitFor();
  await row(page, 'Review GPU memory profile').click();
  await shows(page, 'Peak is 71 GB').waitFor();

  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, '1.2M tokens/s').waitFor();
  await waitFor(() => server.unchangedFetches['s-old'] === 1, { message: 'the "unchanged" answer' });
  assert.equal(server.sessionFetches['s-old'], 2);
  await page.waitForTimeout(100);
  assert.equal(await shows(page, '1.2M tokens/s').count(), 1, 'the copy held stays');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('switch: resting the pointer on a row loads that session, so the click shows it at once', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  // Passing over a row does not load it.
  const box = await row(page, 'Benchmark the tokenizer').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + 400);
  await page.waitForTimeout(300);
  assert.equal(server.sessionFetches['s-old'], undefined);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await waitFor(() => server.sessionFetches['s-old'] === 1, { message: 'the load on hover' });
  await page.waitForTimeout(100);
  server.sessionDelay = 1500;
  const started = Date.now();
  await page.mouse.down();
  await page.mouse.up();
  await shows(page, '1.2M tokens/s').waitFor({ timeout: 1000 });
  assert.ok(Date.now() - started < 1000, 'painted without waiting for the server');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('switch: after the page loads, recent sessions load in the background (not archived ones)', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle', storage: { 'mesh-code-warm-up': '1' } });
  await shows(page, 'Peak is 71 GB').waitFor();
  const others = server.sessions.filter((s) => !s.archived && !s.removed && s.id !== 's-idle').map((s) => s.id);
  await waitFor(() => others.every((id) => server.sessionFetches[id] === 1), { timeout: 8000, message: 'the background loads' });
  assert.equal(server.sessionFetches['s-arch'], undefined);

  server.sessionDelay = 1500;
  const started = Date.now();
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, '1.2M tokens/s').waitFor({ timeout: 1000 });
  assert.ok(Date.now() - started < 1000, 'painted without waiting for the server');
  assert.deepEqual(server.errors, []);
  await context.close();
});
