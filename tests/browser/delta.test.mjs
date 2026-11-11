// Live updates as deltas (server/events.mjs): the open session, the list and cached
// copies take what changed; a copy at another revision is fetched again. Run with
// `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitDelta, launch, openApp } from './harness.mjs';

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

const transcript = (page, text) => page.locator('.transcript-column', { hasText: text });
const row = (page, title) => page.locator('.session-main', { hasText: title });

// The harness served s-idle without a revision: give it one and reopen it, so the page
// holds a copy at that revision before the test sends deltas.
async function reopenAtRevision(page, server, rev) {
  const idle = server.sessions.find((s) => s.id === 's-idle');
  idle.rev = rev;
  // A viewed-mark PATCH may stamp the page's copy first: the refetch must not look older.
  idle.updatedAt = Date.now() + 5000;
  // Listening from the start: once s-old is open the list may re-sort and leave the
  // pointer on s-idle's row, whose hover prefetch is then the refetch.
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions/s-idle' && response.request().method() === 'GET');
  await row(page, 'Benchmark the tokenizer').click();
  await page.waitForFunction(() => location.search.includes('s-old'));
  await row(page, 'Review GPU memory profile').click();
  await refetched;
  await transcript(page, 'Peak is 71 GB').waitFor();
  await page.waitForTimeout(100);
  return idle;
}

test('delta: the open session takes new and changed messages and fields without a refetch', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const idle = await reopenAtRevision(page, server, 100);
  const fetches = server.sessionFetches['s-idle'];
  const count = idle.messages.length;

  const now = Date.now();
  await emitDelta(page, {
    id: 's-idle', rev: 101, base: 100, count: count + 1,
    fields: { status: 'running', title: 'GPU memory, live', updatedAt: now + 1000 },
    messages: [{ id: 'a-delta', role: 'assistant', text: 'Streaming in by delta.', at: now }],
  });
  await transcript(page, 'Streaming in by delta.').waitFor();
  await page.locator('.session-title', { hasText: 'GPU memory, live' }).waitFor();
  await emitDelta(page, {
    id: 's-idle', rev: 102, base: 101, count: count + 1,
    fields: { updatedAt: now + 2000 },
    messages: [{ id: 'a-delta', role: 'assistant', text: 'Streaming in by delta, edited.', at: now }],
  });
  await transcript(page, 'Streaming in by delta, edited.').waitFor();
  assert.equal(await page.locator('.transcript-column', { hasText: 'Streaming in by delta.' }).count(), 0, 'the message was replaced, not appended');
  assert.equal(server.sessionFetches['s-idle'], fetches, 'no refetch');

  // A delta the page cannot apply (it missed 103): the session is fetched again.
  idle.messages.push({ id: 'a-server', role: 'assistant', text: 'Only the server had this.', at: now });
  idle.rev = 104;
  idle.updatedAt = now + 4000;
  await emitDelta(page, { id: 's-idle', rev: 104, base: 103, count: 99, fields: { updatedAt: now + 4000 } });
  await transcript(page, 'Only the server had this.').waitFor();
  assert.equal(server.sessionFetches['s-idle'], fetches + 1);
  // ...and deltas from there on apply again.
  await emitDelta(page, { id: 's-idle', rev: 105, base: 104, count: idle.messages.length + 1, fields: { updatedAt: now + 5000 }, messages: [{ id: 'a-after', role: 'assistant', text: 'Back in step.', at: now }] });
  await transcript(page, 'Back in step.').waitFor();
  assert.equal(server.sessionFetches['s-idle'], fetches + 1);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('delta: the reply that streamed as live text replaces the live bubble', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const idle = await reopenAtRevision(page, server, 200);
  const fetches = server.sessionFetches['s-idle'];
  const count = idle.messages.length;

  const now = Date.now() + 10_000;
  await emitDelta(page, { id: 's-idle', rev: 201, base: 200, count, fields: { status: 'running', updatedAt: now, live: '', liveThinking: '' } });
  await page.evaluate((data) => window.__emit('live', data), { id: 's-idle', live: 'Half a rep', liveThinking: '', status: 'running', updatedAt: now + 100 });
  await page.locator('.msg-assistant.is-live', { hasText: 'Half a rep' }).waitFor();
  // The next delta always carries the live fields, so the bubble goes even though the
  // live text is '' again, as it was at revision 201.
  await emitDelta(page, {
    id: 's-idle', rev: 202, base: 201, count: count + 1,
    fields: { status: 'idle', updatedAt: now + 200, live: '', liveThinking: '' },
    messages: [{ id: 'a-live', role: 'assistant', text: 'Half a reply, now whole.', at: now }],
  });
  await transcript(page, 'Half a reply, now whole.').waitFor();
  assert.equal(await page.locator('.msg-assistant.is-live').count(), 0);
  assert.equal(server.sessionFetches['s-idle'], fetches, 'no refetch');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('delta: other sessions update in the list and in memory; unknown ones join the list', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-unread' });
  const unread = server.sessions.find((s) => s.id === 's-unread');
  await transcript(page, 'visualViewport').waitFor();
  // s-unread was fetched without a revision; give it one and reopen it to cache that copy.
  unread.rev = 50;
  await row(page, 'Review GPU memory profile').click();
  await transcript(page, 'Peak is 71 GB').waitFor();
  await row(page, 'Fix the sidebar scroll jump').click();
  await waitFor(() => server.sessionFetches['s-unread'] >= 2, { message: 'refetch' });
  await page.waitForTimeout(100);
  await row(page, 'Review GPU memory profile').click();
  await transcript(page, 'Peak is 71 GB').waitFor();

  const now = Date.now();
  await emitDelta(page, {
    id: 's-unread', rev: 51, base: 50, count: unread.messages.length + 1,
    fields: { title: 'Sidebar jump, renamed', updatedAt: now },
    messages: [{ id: 'a-bg', role: 'assistant', text: 'Written while you were elsewhere.', at: now }],
  });
  await page.locator('.session-title', { hasText: 'Sidebar jump, renamed' }).waitFor();
  // Back to it while the server is slow: the cached copy already has the delta.
  server.sessionDelay = 1500;
  await row(page, 'Sidebar jump, renamed').click();
  await transcript(page, 'Written while you were elsewhere.').waitFor({ timeout: 1000 });
  server.sessionDelay = 0;

  // A session created elsewhere: a delta without a base carries its list form.
  await emitDelta(page, { id: 's-new', rev: 1, base: null, fields: { id: 's-new', title: 'Created on the phone', cwd: '/home/you', status: 'idle', createdAt: now, updatedAt: now, pending: [] } });
  await page.locator('.session-title', { hasText: 'Created on the phone' }).waitFor();
  assert.deepEqual(server.errors, []);
  await context.close();
});
