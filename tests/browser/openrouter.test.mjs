// The model picker's OpenRouter side menu: a searchable list of every ZDR model, opened
// next to the menu (inside it on phones). Run with `npm run test:browser`.
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

async function waitFor(check, { timeout = 3000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const MODELS = [
  { id: 'or:moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', vendor: 'MoonshotAI', contextWindow: 1_048_576, vision: true, reasoning: true, price: { in: 0.95, out: 4 } },
  { id: 'or:qwen/qwen3.8-max', name: 'Qwen3.8 Max', vendor: 'Qwen', contextWindow: 262_144, vision: false, reasoning: true, price: { in: 1.2, out: 6 } },
  { id: 'or:acme/tiny', name: 'Tiny', vendor: 'Acme', contextWindow: 131_072, vision: false, reasoning: false, price: { in: 0.1, out: 0.4 } },
];

/** Answers GET /api/openrouter-models (or fails it while `state.fail`), counting loads. */
function mockList(server, state = {}) {
  state.loads = 0;
  server.routes.push(({ route }) => {
    if (route !== 'openrouter-models') return null;
    state.loads += 1;
    return state.fail ? { status: 502, json: { error: 'Could not load the OpenRouter models.' } } : { json: MODELS };
  });
  return state;
}

const chip = (page) => page.locator('.chip-model');
const sideRow = (page) => page.locator('.openrouter-row');

test('openrouter: the side menu opens next to the model menu, searches, and picks a model for the session', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-unread' });
  const list = mockList(server);
  await chip(page).click();
  assert.equal(list.loads, 0, 'fetched only when the row is opened');
  await sideRow(page).click();
  const side = page.locator('.openrouter-side');
  await side.waitFor();
  await side.locator('.menu-row', { hasText: 'Qwen3.8 Max' }).waitFor();
  assert.equal(list.loads, 1);
  // Next to the menu, not over it: the chip is near the right edge, so on its left.
  const menuBox = await page.locator('.picker-popover:not(.openrouter-side)').boundingBox();
  const sideBox = await side.boundingBox();
  assert.ok(sideBox.x + sideBox.width <= menuBox.x || sideBox.x >= menuBox.x + menuBox.width, `side panel ${sideBox.x}+${sideBox.width}, menu ${menuBox.x}+${menuBox.width}`);
  assert.equal(await side.locator('input').evaluate((el) => el === document.activeElement), true, 'the search box has focus');
  assert.match(await side.locator('.menu-row', { hasText: 'Kimi K3.1 Pro' }).innerText(), /MoonshotAI · \$0\.95\/\$4 per M · 1\.0M context/);

  await page.keyboard.type('qwen');
  assert.equal(await side.locator('.menu-row').count(), 1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitFor(() => server.requests.some((r) => r.method === 'PATCH' && r.body?.model === 'or:qwen/qwen3.8-max'), { message: 'model PATCH' });
  await waitFor(async () => (await chip(page).innerText()).includes('Qwen3.8 Max'), { message: 'chip shows the model' });
  assert.equal(await side.count(), 0);

  // The current OpenRouter model shows on the row and is checked in the side menu; its
  // efforts come from the list (a reasoning model: low/medium/high).
  await chip(page).click();
  assert.match(await sideRow(page).innerText(), /Qwen3\.8 Max · current/);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await side.waitFor();
  assert.equal(await side.locator('.menu-row.is-selected', { hasText: 'Qwen3.8 Max' }).count(), 1);
  // Esc closes the side menu first, then the model menu.
  await page.keyboard.press('Escape');
  await waitFor(async () => (await side.count()) === 0, { message: 'side menu closed' });
  assert.equal(await page.locator('.picker-popover').count(), 1);
  await page.keyboard.press('Escape');
  await waitFor(async () => (await page.locator('.picker-popover').count()) === 0, { message: 'menu closed' });

  await page.locator('.chip-effort').click();
  const efforts = await page.locator('.picker-popover .menu-row-label').allInnerTexts();
  assert.deepEqual(efforts, ['Default', 'Low', 'Medium', 'High']);
  assert.equal(list.loads, 1, 'loaded once');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('openrouter: a failed load says so and can be retried', async () => {
  const { page, context, server } = await openApp(browser);
  const list = mockList(server, { fail: true });
  await chip(page).click();
  await sideRow(page).click();
  const error = page.locator('.openrouter-error');
  await error.waitFor();
  list.fail = false;
  await error.locator('button', { hasText: 'Retry' }).click();
  await page.locator('.openrouter-side .menu-row', { hasText: 'Tiny' }).click();
  // A new chat: the draft model changes, nothing is patched.
  await waitFor(async () => (await chip(page).innerText()).includes('Tiny'), { message: 'chip shows Tiny' });
  assert.equal(server.requests.filter((r) => r.method === 'PATCH' && r.body?.model).length, 0);
  // No reasoning: no effort chip.
  assert.equal(await page.locator('.chip-effort').count(), 0);
  await context.close();
});

test('openrouter: on a phone the list takes the menu’s place, with a back button', async () => {
  const { page, context, server } = await openApp(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, url: '/?session=s-unread' });
  mockList(server);
  await chip(page).click();
  await sideRow(page).click();
  const inline = page.locator('.picker-popover .openrouter-menu');
  await inline.locator('.menu-row', { hasText: 'Kimi K3.1 Pro' }).waitFor();
  assert.equal(await page.locator('.openrouter-side').count(), 0);
  assert.equal(await page.locator('.picker-popover .openrouter-row').count(), 0, 'the model list is replaced');
  const box = await page.locator('.picker-popover').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'inside the screen');
  await inline.locator('.openrouter-back').click();
  await sideRow(page).waitFor();
  await sideRow(page).click();
  await inline.locator('.menu-row', { hasText: 'Kimi K3.1 Pro' }).click();
  await waitFor(() => server.requests.some((r) => r.method === 'PATCH' && r.body?.model === 'or:moonshotai/kimi-k3.1-pro'), { message: 'model PATCH' });
  await context.close();
});
