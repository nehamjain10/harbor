// Streaming replies: text that arrives in a burst plays out over the next frames, and
// each step re-renders only the block still being written (finished paragraphs keep
// their DOM, so a selection in them survives). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, launch, openApp, setVisibility } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const live = (page, text, at) => page.evaluate((data) => window.__emit('live', data), { id: 's-idle', live: text, liveThinking: '', status: 'running', updatedAt: at });
const shownText = (page) => page.evaluate(() => document.querySelector('.msg-assistant.is-live .markdown')?.textContent ?? '');

test('streaming: a burst plays out over several frames, then shows in full', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();
  const now = Date.now() + 10_000;
  await live(page, 'Start.', now);
  await page.locator('.msg-assistant.is-live', { hasText: 'Start.' }).waitFor();

  const burst = 'Start. ' + 'word '.repeat(400);
  await live(page, burst, now + 1);
  // Sampled every frame: the text grows in steps instead of jumping to the end.
  const lengths = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const seen = [];
        const sample = () => {
          seen.push((document.querySelector('.msg-assistant.is-live .markdown')?.textContent ?? '').length);
          if (seen.length < 120 && seen.at(-1) < 2000) requestAnimationFrame(sample);
          else resolve(seen);
        };
        requestAnimationFrame(sample);
      }),
  );
  const distinct = new Set(lengths).size;
  assert.ok(distinct >= 4, `several steps (${[...new Set(lengths)].join(', ')})`);
  await page.waitForFunction((n) => (document.querySelector('.msg-assistant.is-live .markdown')?.textContent ?? '').trim().length >= n, burst.trim().length, { timeout: 3000 });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('streaming: finished blocks keep their DOM; one cursor, after the growing block', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();
  const now = Date.now() + 10_000;
  await live(page, 'First paragraph, finished.\n\nSecond one is', now);
  await page.waitForFunction(() => document.querySelector('.msg-assistant.is-live')?.textContent.includes('Second one is'));
  await page.evaluate(() => {
    document.querySelector('.msg-assistant.is-live .md-block p').__kept = true;
  });
  await live(page, 'First paragraph, finished.\n\nSecond one is now longer.\n\n- a list item', now + 1);
  await page.waitForFunction(() => document.querySelector('.msg-assistant.is-live')?.textContent.includes('a list item'));
  const state = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.msg-assistant.is-live .md-block')];
    const cursorOn = [...document.querySelectorAll('.msg-assistant.is-live .markdown *')].filter((el) => getComputedStyle(el, '::after').content !== 'none');
    return {
      kept: blocks[0].querySelector('p').__kept === true,
      blocks: blocks.length,
      cursors: cursorOn.map((el) => el.tagName),
    };
  });
  assert.equal(state.kept, true, 'the first paragraph was not re-rendered');
  assert.equal(state.blocks, 3);
  assert.deepEqual(state.cursors, ['UL'], 'one cursor, after the last block');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('streaming: on a hidden page new text shows at once', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();
  const now = Date.now() + 10_000;
  await live(page, 'Start.', now);
  await page.locator('.msg-assistant.is-live', { hasText: 'Start.' }).waitFor();
  await setVisibility(page, 'hidden');
  const burst = 'Start. ' + 'more '.repeat(300);
  await live(page, burst, now + 1);
  await page.waitForFunction((n) => (document.querySelector('.msg-assistant.is-live .markdown')?.textContent ?? '').trim().length >= n, burst.trim().length, { timeout: 1000 });
  assert.ok((await shownText(page)).trim().length >= burst.trim().length);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('motion: a new entry rises into place; opening another session animates nothing', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();
  await page.evaluate(() => {
    window.__animated = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.closest('.transcript-column')) window.__animated.push(this.className);
      return animate.apply(this, args);
    };
  });
  await live(page, 'Start.', Date.now() + 10_000);
  await page.locator('.msg-assistant.is-live', { hasText: 'Start.' }).waitFor();
  const risen = await page.evaluate(() => window.__animated);
  assert.ok(risen.some((name) => name.includes('is-live')), `the live reply rose in (${risen.join(' | ')})`);

  await page.evaluate(() => (window.__animated = []));
  await page.locator('.session-main', { hasText: 'Benchmark the tokenizer' }).click();
  await page.waitForFunction(() => location.search.includes('s-old'));
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.__animated), [], 'a switch paints at once');
  assert.deepEqual(server.errors, []);
  await context.close();
});
