// Tail loading in a real browser against the mocked server (harness.mjs, which cuts
// tails and older pages as server/tail.mjs does): a long session opens with its recent
// messages, older pages load as the reader scrolls up without moving what they read,
// find in page loads everything, deltas apply to the tail, and an agent from before the
// window still opens. Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, buildApp, emitDelta, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

async function waitFor(check, { timeout = 5000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const TURNS = 1000;
const row = (page, title) => page.locator('.session-main', { hasText: title });
const shows = (page, text) => page.locator('.transcript-column', { hasText: text });
const questions = (page) => page.locator('.transcript-column .msg-user').count();

// `turns` turns of a question and an answer.
function longChat(turns, at = Date.now() - 86_400_000) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ id: `u-${i}`, role: 'user', text: `Question ${i}`, at: at + i * 1000, delivery: 'done' });
    messages.push({ id: `a-${i}`, role: 'assistant', text: `Answer ${i}`, model: 'luna', at: at + i * 1000 + 500 });
  }
  return messages;
}

async function openLong(page, server, messages = longChat(TURNS)) {
  const session = server.sessions.find((s) => s.id === 's-old');
  Object.assign(session, { messages, status: 'idle', rev: 100, updatedAt: Date.now() });
  await row(page, 'Benchmark the tokenizer').click();
  await shows(page, `Answer ${TURNS - 1}`).waitFor();
  return session;
}

test('tail: a long session opens with its recent messages; scrolling up loads older pages and keeps the reader in place', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  const session = await openLong(page, server);
  assert.equal(server.tails.at(-1), 300, 'asked for a tail');
  assert.equal(await shows(page, 'Question 0').count(), 0);
  assert.ok((await questions(page)) <= 50, 'the first entries only');

  // Up to where the copy starts: then a page loads, while the reader stays where they are.
  server.olderDelay = 400;
  const older = page.locator('.transcript-older');
  for (let i = 0; i < 40 && !server.olderLoads.length; i++) {
    await page.locator('.transcript').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(40);
  }
  assert.equal(server.olderLoads.length, 1, 'the first page');
  assert.match(await older.innerText(), /Loading earlier messages/);
  assert.equal(await questions(page), 150, 'every entry held is shown first');
  const load = server.olderLoads[0];
  assert.deepEqual(load, { id: 's-old', before: 2 * TURNS - 300, limit: 400, beforeId: `u-${TURNS - 150}` });
  // The question at the top now, and where it is on screen.
  const top = await page.locator('.transcript').evaluate((scroller) => {
    const box = scroller.getBoundingClientRect();
    const first = [...scroller.querySelectorAll('.msg-user')].find((el) => el.getBoundingClientRect().bottom > box.top);
    return { text: first.innerText.trim().split('\n')[0], y: first.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
  });
  assert.equal(top.text, `Question ${TURNS - 150}`);
  await waitFor(async () => (await questions(page)) > 150, { message: 'the page shown' });
  const after = await page.locator('.transcript').evaluate((scroller, text) => {
    const el = [...scroller.querySelectorAll('.msg-user')].find((node) => node.innerText.trim().split('\n')[0] === text);
    return { y: el.getBoundingClientRect().top, scrollTop: scroller.scrollTop };
  }, top.text);
  assert.ok(Math.abs(after.y - top.y) <= 1, `the question stayed put (${top.y} -> ${after.y})`);
  assert.ok(after.scrollTop > top.scrollTop + 1000, 'the page went in above it');

  // On to the first message.
  server.olderDelay = 0;
  for (let i = 0; i < 200 && !(await shows(page, 'Question 0').count()); i++) {
    await page.locator('.transcript').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(40);
  }
  assert.equal(await questions(page), TURNS, 'every question');
  assert.equal(await page.locator('.transcript-older').count(), 0, 'nothing older left');
  // Pages of 400; the last 100 come with the one before them (no page that small).
  assert.deepEqual(
    server.olderLoads.map((l) => [l.before, l.beforeId]),
    [1700, 1300, 900, 500].map((before) => [before, `u-${before / 2}`]),
  );
  assert.equal(server.sessionFetches['s-old'], 1, 'the session itself was fetched once');
  assert.deepEqual(server.errors, []);
  assert.equal(session.messages.length, 2 * TURNS);
  await context.close();
});

test('tail: find in page loads every message first', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  await openLong(page, server);
  await page.keyboard.press('Control+f');
  await waitFor(async () => (await questions(page)) === TURNS, { message: 'all rows for find' });
  assert.deepEqual(server.olderLoads, [{ id: 's-old', before: 2 * TURNS - 300, limit: 2 * TURNS - 300, beforeId: `u-${TURNS - 150}` }]);
  assert.equal(await page.locator('.transcript-older').count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('tail: deltas apply to the tail; one that does not fit fetches it again', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  const session = await openLong(page, server);
  const fetches = server.sessionFetches['s-old'];
  const reply = { id: 'late', role: 'assistant', text: 'A late reply', model: 'luna', at: Date.now() };
  session.messages.push(reply);
  session.rev = 101;
  // A change before the window comes along too: the copy skips it.
  await emitDelta(page, { id: 's-old', base: 100, rev: 101, fields: {}, count: 2 * TURNS + 1, messages: [{ ...session.messages[3], text: 'Edited' }, reply] });
  await shows(page, 'A late reply').waitFor();
  assert.equal(server.sessionFetches['s-old'], fetches, 'applied, not fetched');
  // A count that does not add up: the session is fetched again (its tail).
  const another = { id: 'later', role: 'assistant', text: 'Another reply', model: 'luna', at: Date.now() };
  session.messages.push(another);
  session.rev = 102;
  await emitDelta(page, { id: 's-old', base: 101, rev: 102, fields: {}, count: 2 * TURNS + 5, messages: [another] });
  await shows(page, 'Another reply').waitFor();
  assert.equal(server.sessionFetches['s-old'], fetches + 1);
  assert.equal(server.tails.at(-1), 300);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('tail: an agent from before the window opens once the earlier messages load', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await shows(page, 'Peak is 71 GB').waitFor();
  const at = Date.now() - 90_000_000;
  const messages = [
    { id: 'u-start', role: 'user', text: 'Map the code first', at, delivery: 'done' },
    { id: 'card', role: 'tool', tool: 'Agent', toolId: 'early', at: at + 100, input: { description: 'Map the old code', subagent_type: 'Explore', prompt: 'Map it.' }, state: 'done', endedAt: at + 9000, output: 'Mapped.', usage: { toolUses: 1, tokens: 900, durationMs: 8900 } },
    { id: 'step', role: 'tool', tool: 'Read', toolId: 'r-early', parentToolId: 'early', at: at + 200, input: { file_path: '/repo/legacy/map.txt' }, state: 'done', output: 'ok' },
    { id: 'said', role: 'assistant', text: 'The old code is mapped.', parentToolId: 'early', at: at + 8000 },
    ...longChat(TURNS, at + 10_000),
  ];
  const session = server.sessions.find((s) => s.id === 's-old');
  Object.assign(session, { messages, status: 'idle', rev: 100, updatedAt: Date.now() });
  server.olderDelay = 500;
  await page.goto(ORIGIN + '/?session=s-old&agent=early');
  const panel = page.locator('.side-panel.is-agent');
  await panel.locator('.agent-files-note', { hasText: 'Loading the earlier part of the session' }).waitFor();
  await panel.locator('.agent-panel-title', { hasText: 'Map the old code' }).waitFor();
  await panel.locator('.transcript-column', { hasText: 'The old code is mapped.' }).waitFor();
  assert.equal(server.tails.at(-1), 300);
  assert.equal(server.olderLoads.length, 1);
  assert.equal(server.olderLoads[0].limit, server.olderLoads[0].before, 'everything before the window');
  assert.deepEqual(server.transcriptLoads, [], "Claude Code's transcript was not needed");
  assert.equal(await panel.locator('.agent-files-note').count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});
