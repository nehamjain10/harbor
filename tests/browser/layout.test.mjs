// Real-browser layout checks (phone composer, sidebar rows) against the mocked v2
// server (harness.mjs). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const phone = { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, url: '/?session=s-idle', waitForSessions: false };

// Whether the element's center is the topmost thing there (not clipped or covered).
const visibleAtCenter = (locator) =>
  locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hit && el.contains(hit);
  });

test('phone composer: chips scroll sideways and their menus are not clipped', async () => {
  const { page, context, server } = await openApp(browser, phone);
  const chips = page.locator('.composer-chips');
  await chips.waitFor();
  const metrics = await chips.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
  assert.equal(metrics.overflowX, 'auto');
  assert.ok(metrics.scroll > metrics.client, `chips overflow at 320px (${metrics.scroll} > ${metrics.client})`);
  // Every chip keeps its size (scrolls instead of squeezing).
  const composerBox = await page.locator('.composer').boundingBox();
  await chips.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  const effort = page.locator('.composer-chips .chip').last();
  await effort.click();
  const popover = page.locator('.composer .popover');
  await popover.waitFor();
  await page.waitForTimeout(250);
  const box = await popover.boundingBox();
  assert.ok(box.y + box.height <= composerBox.y + 1, 'the menu opens above the composer');
  assert.ok(box.x >= 0 && box.x + box.width <= 320, 'the menu fits the screen');
  assert.ok(await visibleAtCenter(popover), 'the menu is not clipped by the scrolling chips');
  assert.ok(await visibleAtCenter(popover.locator('[role="menuitemradio"], [role="option"]').first()), 'its first row is reachable');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('phone composer: attachments stay on one scrolling row with reachable remove buttons', async () => {
  const { page, context } = await openApp(browser, phone);
  await page.locator('.composer-chips').waitFor();
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `notes-${i + 1}.txt`, mimeType: 'text/plain', buffer: Buffer.from('hello ' + i) }));
  await page.locator('.composer input[type="file"]').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 5);
  const list = page.locator('.attach-list');
  const layout = await list.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    rows: new Set([...el.querySelectorAll('.attach-chip')].map((chip) => chip.offsetTop)).size,
  }));
  assert.equal(layout.rows, 1, 'one row');
  assert.ok(layout.scroll > layout.client, 'scrolls sideways');
  const remove = page.locator('.attach-remove').first();
  await page.waitForTimeout(250);
  assert.ok(await visibleAtCenter(remove), 'the first remove button is not clipped');
  await context.close();
});

test('sidebar rows: one line; the tooltip has the full title, project and time; hovering never reflows the title', async () => {
  const { page, context, server } = await openApp(browser, { waitForSessions: false });
  const long = 'Benchmark the tokenizer on every corpus we have, then compare the throughput with the previous release';
  Object.assign(server.sessions.find((s) => s.id === 's-old'), { title: long, cwd: '/home/you/harborcode-stage-polish-with-an-unusually-long-project-folder-name' });
  await page.reload();
  const row = page.locator('.session-row', { hasText: 'Benchmark the tokenizer' });
  await row.waitFor();
  const measure = () =>
    row.evaluate((el) => {
      const title = el.querySelector('.session-title');
      return { height: el.getBoundingClientRect().height, titleWidth: title.getBoundingClientRect().width, cut: title.scrollWidth > title.clientWidth };
    });
  const resting = await measure();
  assert.ok(resting.height <= 36, `one line (${resting.height}px)`);
  assert.equal(resting.cut, true, 'the long title is cut');
  await row.locator('.session-main').hover();
  const hovered = await measure();
  assert.deepEqual(hovered, resting, 'the buttons overlay the title instead of narrowing it');
  assert.ok(await row.locator('.session-more').isVisible());
  const tip = await row.locator('.session-main').getAttribute('title');
  assert.equal(tip.split('\n')[0], long);
  assert.match(tip.split('\n')[1], /^\/home\/you\/harborcode-stage-polish-with-an-unusually-long-project-folder-name · \S/);
  assert.deepEqual(server.errors, []);
  await context.close();
});
