// End-to-end checks for the command palette, pins, unread, notifications, the
// shortcuts dialog and the phone drawer, against a mocked v2 server (harness.mjs).
// Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitSession, launch, notifications, openApp, setVisibility } from './harness.mjs';

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

const activeRow = (page) => page.locator('.palette-row.is-active');
const find = (server, id) => server.sessions.find((s) => s.id === id);
const patches = (server) => server.requests.filter((r) => r.method === 'PATCH').map((r) => [r.path, r.body]);

async function openPalette(page) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette[open] .palette-input');
}

test('palette: fuzzy search a session and open it; the open session is excluded', async () => {
  const { page, context, server } = await openApp(browser);
  await openPalette(page);
  const recent = await page.locator('.palette-section').first().locator('.palette-label').allTextContents();
  assert.deepEqual(recent.slice(0, 2), ['Split server.mjs into readable modules', 'Pick a deploy window for v2'], 'recent first');

  await page.keyboard.type('gpu prof');
  assert.match(await activeRow(page).textContent(), /Review GPU memory profile/);
  assert.ok((await activeRow(page).locator('mark').count()) > 0, 'matched characters are highlighted');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.palette', { state: 'detached' });
  await page.waitForFunction(() => location.search === '?session=s-idle');
  assert.equal(await page.locator('.crumb-title').textContent(), 'Review GPU memory profile');

  await openPalette(page);
  const labels = await page.locator('.palette-label').allTextContents();
  assert.ok(!labels.includes('Review GPU memory profile'), 'current session excluded');
  for (const label of ['Rename session', 'Pin session', 'Copy session link', 'Open Changes', 'Open Files', 'Open Plan', 'Archive session', 'Move to Trash', 'Keyboard shortcuts']) {
    assert.ok(labels.includes(label), label);
  }
  const hints = await page.locator('.palette-row', { hasText: 'New session' }).first().locator('kbd').allTextContents();
  assert.deepEqual(hints, ['Ctrl', 'Shift', 'O'], 'shortcut shown on the action');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('palette: model sub-page, deep search and effort send PATCHes', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await openPalette(page);
  await page.keyboard.type('switch model');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.palette-crumb').textContent(), 'Model');
  assert.match(await page.locator('.palette-row.is-selected').textContent(), /Claude Opus 5\.5/);
  assert.match(await activeRow(page).textContent(), /Claude Opus 5\.5/, 'starts on the current model');
  await page.keyboard.press('ArrowDown');
  assert.match(await activeRow(page).textContent(), /Claude Sonnet 5\.5/);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.palette', { state: 'detached' });
  await waitFor(() => server.requests.length === 1, { message: 'model PATCH' });

  await openPalette(page);
  await page.keyboard.type('luna');
  assert.match(await activeRow(page).textContent(), /Model: GPT-6 Luna/);
  await page.keyboard.press('Enter');
  await waitFor(() => server.requests.length === 2, { message: 'second model PATCH' });

  await openPalette(page);
  await page.keyboard.type('effort');
  await page.keyboard.press('Enter');
  await page.keyboard.type('xhigh');
  assert.match(await activeRow(page).textContent(), /Extra high/);
  await page.keyboard.press('Enter');
  await waitFor(() => server.requests.length === 3, { message: 'effort PATCH' });

  assert.deepEqual(patches(server), [
    ['sessions/s-idle', { model: 'sonnet' }],
    ['sessions/s-idle', { model: 'luna' }],
    ['sessions/s-idle', { effort: 'xhigh' }],
  ]);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('palette: theme page, Esc and Backspace go back, deep "light" switches theme', async () => {
  const { page, context, server } = await openApp(browser);
  await openPalette(page);
  await page.keyboard.type('theme');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.palette-crumb').textContent(), 'Theme');
  assert.match(await activeRow(page).textContent(), /Dark/, 'current theme highlighted');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.palette-crumb').count(), 0, 'Esc on a sub-page goes back');
  assert.ok(await page.locator('.palette[open]').count(), 'and keeps the palette open');
  assert.match(await activeRow(page).textContent(), /Change theme/, 'back on the opener');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('.palette-crumb').count(), 0, 'Backspace on an empty query goes back');

  await page.keyboard.type('light');
  assert.match(await activeRow(page).textContent(), /Theme: Light/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('mesh-code-theme')), 'light');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('pins: row hover button, options dialog and palette PATCH {pinned}', async () => {
  const { page, context, server } = await openApp(browser);
  const row = page.locator('.session-row', { hasText: 'Review GPU memory profile' });
  await row.hover();
  await row.locator('.session-pin').click();
  await waitFor(() => server.requests.length === 1, { message: 'pin PATCH' });
  await page.waitForFunction(() => document.querySelector('.session-group').textContent.includes('Review GPU memory profile'));
  assert.equal(await page.locator('.session-group').first().locator('.session-group-label').textContent(), 'Pinned');

  await row.hover();
  await row.locator('.session-more').click();
  await page.locator('dialog.dialog').getByRole('button', { name: 'Unpin', exact: true }).click();
  await waitFor(() => server.requests.length === 2, { message: 'unpin PATCH' });

  await row.locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  await openPalette(page);
  await page.keyboard.type('pin');
  assert.match(await activeRow(page).textContent(), /Pin session/);
  await page.keyboard.press('Enter');
  await waitFor(() => server.requests.length === 3, { message: 'palette pin PATCH' });

  assert.deepEqual(patches(server), [
    ['sessions/s-idle', { pinned: true }],
    ['sessions/s-idle', { pinned: false }],
    ['sessions/s-idle', { pinned: true }],
  ]);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('unread: dot after a newer turnEndedAt, cleared by viewing, one PATCH per turn', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-run' });
  const row = page.locator('.session-row', { hasText: 'Review GPU memory profile' });
  assert.equal(await row.locator('.dot-unread').count(), 0);
  assert.equal(await page.title(), '(2) Split server.mjs into readable modules · Harbor');

  const idle = find(server, 's-idle');
  idle.turnEndedAt = idle.updatedAt = Date.now();
  await emitSession(page, idle);
  await row.locator('.dot-unread').waitFor();
  assert.match(await row.getAttribute('class'), /is-unread/);
  assert.equal(await page.title(), '(3) Split server.mjs into readable modules · Harbor');
  assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), '/favicon-dot.svg');

  await row.locator('.session-main').click();
  await waitFor(() => server.requests.some((r) => r.body?.viewed), { message: 'viewed PATCH' });
  await row.locator('.dot-unread').waitFor({ state: 'detached' });
  await page.locator('.session-row', { hasText: 'Split server.mjs' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-run');
  await row.locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  await page.waitForTimeout(150);
  assert.deepEqual(patches(server), [['sessions/s-idle', { viewed: true }]], 'viewed once for this turn');
  assert.equal(await page.title(), '(2) Review GPU memory profile · Harbor');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('unread: the open session is marked viewed only once the page is visible', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await setVisibility(page, 'hidden');
  const idle = find(server, 's-idle');
  idle.turnEndedAt = idle.updatedAt = Date.now();
  await emitSession(page, idle);
  await page.waitForFunction(() => document.title.startsWith('(3) '));
  await page.waitForTimeout(150);
  assert.deepEqual(patches(server), [], 'nothing while hidden');
  await setVisibility(page, 'visible');
  await waitFor(() => server.requests.length === 1, { message: 'viewed PATCH on visible' });
  assert.deepEqual(patches(server), [['sessions/s-idle', { viewed: true }]]);
  await page.waitForFunction(() => document.title === '(2) Review GPU memory profile · Harbor');
  await context.close();
});

test('notifications: finished turns and approvals while hidden, de-duplicated, click opens the session', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle', permission: 'default' });
  await context.grantPermissions(['notifications']);
  await page.getByRole('button', { name: 'Settings' }).click();
  const toggle = page.getByRole('switch', { name: /Desktop notifications/ });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('mesh-code-notify')), 'on');
  await page.keyboard.press('Escape');
  assert.deepEqual(await notifications(page), [], 'nothing for state from before the page loaded');

  await setVisibility(page, 'hidden');
  const old = find(server, 's-old');
  old.turnEndedAt = old.updatedAt = Date.now();
  old.messages.push({ id: 'a-done', role: 'assistant', text: '**All 14 tests pass.**\nFull log below.', model: 'luna' });
  await emitSession(page, old);
  await waitFor(async () => (await notifications(page)).length === 1, { message: 'finished notification' });
  await emitSession(page, old);
  await page.waitForTimeout(150);

  const idle = find(server, 's-idle');
  Object.assign(idle, { status: 'error', turnEndedAt: Date.now(), updatedAt: Date.now() });
  await emitSession(page, idle);

  Object.assign(old, { status: 'waiting', updatedAt: Date.now(), pending: [{ id: 'p-bash', kind: 'permission', tool: 'Bash', input: { command: 'rm -rf build' } }] });
  await emitSession(page, old);
  const unread = find(server, 's-unread');
  Object.assign(unread, { status: 'waiting', updatedAt: Date.now(), pending: [{ id: 'p-plan', kind: 'plan', tool: 'ExitPlanMode', input: { plan: '1. Do it' } }] });
  await emitSession(page, unread);
  const run = find(server, 's-run');
  Object.assign(run, { status: 'waiting', updatedAt: Date.now(), pending: [{ id: 'p-q', kind: 'question', tool: 'AskUserQuestion', input: {} }] });
  await emitSession(page, run);
  await emitSession(page, run);
  await waitFor(async () => (await notifications(page)).length === 5, { message: 'five notifications' });
  await page.waitForTimeout(150);

  assert.deepEqual(await notifications(page), [
    { title: 'Benchmark the tokenizer', body: 'All 14 tests pass.', tag: 'harbor:s-old' },
    { title: 'Review GPU memory profile', body: 'Finished with an error', tag: 'harbor:s-idle' },
    { title: 'Benchmark the tokenizer', body: 'Needs your approval: Bash', tag: 'harbor:s-old' },
    { title: 'Fix the sidebar scroll jump on mobile Safari when the keyboard opens', body: 'Plan ready for review', tag: 'harbor:s-unread' },
    { title: 'Split server.mjs into readable modules', body: 'Has a question for you', tag: 'harbor:s-run' },
  ]);
  // Needs you: s-wait, s-old, s-unread, s-run; unread: s-idle (open but hidden).
  assert.equal(await page.title(), '(5) Review GPU memory profile · Harbor');

  await setVisibility(page, 'visible');
  await page.evaluate(() => window.__notifications.findLast((n) => n.options.tag === 'harbor:s-old').onclick());
  await page.waitForFunction(() => location.search === '?session=s-old');
  assert.deepEqual(await page.evaluate(() => window.__notifications.map((n) => n.closed)), [false, false, true, false, false], 'the clicked one closes');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('notifications: nothing while looking at the session, or when turned off', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle', permission: 'granted', storage: { 'mesh-code-notify': 'on' } });
  const idle = find(server, 's-idle');
  idle.turnEndedAt = idle.updatedAt = Date.now();
  await emitSession(page, idle);
  await page.waitForTimeout(150);
  assert.deepEqual(await notifications(page), [], 'visible and open');

  await openPalette(page);
  await page.keyboard.type('notifications');
  assert.match(await activeRow(page).textContent(), /Turn off desktop notifications/);
  await page.keyboard.press('Enter');
  await setVisibility(page, 'hidden');
  const old = find(server, 's-old');
  old.turnEndedAt = old.updatedAt = Date.now();
  await emitSession(page, old);
  await page.waitForTimeout(150);
  assert.deepEqual(await notifications(page), [], 'turned off');
  assert.equal(await page.evaluate(() => localStorage.getItem('mesh-code-notify')), 'off');
  await context.close();
});

test('shortcuts: ? opens the list (not while typing), Ctrl+J panel, Ctrl+Shift+O new session', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('?');
  const dialog = page.locator('dialog.shortcuts-dialog');
  await dialog.waitFor();
  const text = await dialog.textContent();
  for (const label of ['Command palette', 'New session', 'Toggle sidebar', 'Toggle side panel', 'Send message', 'Allow once']) assert.ok(text.includes(label), label);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await page.locator('.composer-input').focus();
  await page.keyboard.press('?');
  await page.waitForTimeout(100);
  assert.equal(await dialog.count(), 0, 'typing a ? does not open it');
  assert.equal(await page.locator('.composer-input').inputValue(), '?');
  await page.locator('.composer-input').fill('');

  await page.keyboard.press('Control+j');
  await page.waitForSelector('.topbar [aria-pressed="true"]');
  await page.keyboard.press('Control+j');
  await page.waitForSelector('.topbar [aria-pressed="false"]');

  await openPalette(page);
  await page.keyboard.type('keyboard');
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Shift+O');
  await page.waitForFunction(() => location.search === '');
  assert.equal(await page.locator('.crumb-title').textContent(), 'New session');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('mobile: edge swipe opens the drawer, picking a session closes it, swipe left closes', async () => {
  const { page, context, server } = await openApp(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const cdp = await context.newCDPSession(page);
  const swipe = async (points) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0], y: 420 }] });
    for (const x of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 424 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  assert.equal(await page.locator('.app.drawer-open').count(), 0);
  await swipe([6, 30, 90, 170, 250]);
  await page.waitForSelector('.app.drawer-open');
  await page.locator('.session-row', { hasText: 'Benchmark the tokenizer' }).locator('.session-main').tap();
  await page.waitForFunction(() => location.search === '?session=s-old');
  await page.waitForSelector('.app:not(.drawer-open)');

  await swipe([200, 190, 120, 40]);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.app.drawer-open').count(), 0, 'a swipe that does not start at the edge does nothing');
  await swipe([6, 30, 90, 170, 250]);
  await page.waitForSelector('.app.drawer-open');
  await swipe([280, 260, 180, 80]);
  await page.waitForSelector('.app:not(.drawer-open)');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('palette: accessible results, "No results" status, and long titles keep their project · model', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  find(server, 's-old').title = 'Benchmark the tokenizer on every shard of the pretraining corpus and compare it with the previous release in detail';
  await emitSession(page, find(server, 's-old'));
  await openPalette(page);
  assert.equal(await page.locator('.palette-list').getAttribute('role'), 'listbox');
  assert.equal(await page.locator('.palette-list').getAttribute('aria-label'), 'Results');
  const titles = page.locator('.palette-section-title');
  assert.ok((await titles.count()) > 0);
  for (const title of await titles.all()) assert.equal(await title.getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('[role="status"].palette-status').textContent(), '', 'status is empty while there are results');

  await page.keyboard.type('Benchmark the tokenizer');
  const row = page.locator('.palette-row', { hasText: 'Benchmark the tokenizer' }).first();
  const widths = await row.evaluate((el) => ({
    row: el.querySelector('.palette-text').getBoundingClientRect().width,
    label: el.querySelector('.palette-label').getBoundingClientRect().width,
    description: el.querySelector('.palette-description').getBoundingClientRect().width,
  }));
  assert.ok(widths.description >= 80, `the description keeps room (${widths.description}px)`);
  assert.ok(widths.label <= widths.row * 0.75, 'the title is capped');

  await page.keyboard.press('Control+a');
  await page.keyboard.type('zzqxv nothing matches');
  const status = page.locator('[role="status"].palette-status');
  await page.waitForFunction(() => /No results/.test(document.querySelector('.palette-status').textContent));
  assert.match(await status.textContent(), /No results for “zzqxv nothing matches”/);
  assert.equal(await page.locator('.palette-list').isHidden(), true, 'the empty listbox is hidden');
  assert.deepEqual(server.errors, []);
  await context.close();
});
