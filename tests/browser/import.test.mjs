// Session import: the picker dialog opened from the palette, /import and the sidebar,
// against the mocked v2 server (harness.mjs). Run with `npm run test:browser`.
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

const dialog = (page) => page.locator('dialog.import-dialog');
const rows = (page) => page.locator('.import-row');
const row = (page, title) => page.locator('.import-row', { hasText: title });
const tab = (page, name) => page.locator('.import-tabs [role="tab"]', { hasText: name });
const imports = (server) => server.requests.filter((r) => r.path === 'import').map((r) => r.body);

async function openFromSidebar(page) {
  await page.locator('.import-sessions').click();
  await dialog(page).waitFor();
  await page.waitForSelector('.import-row');
}

test('import: the palette opens it; each tab loads the first time it is shown', async () => {
  const { page, context, server } = await openApp(browser);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('import sessions');
  assert.match(await page.locator('.palette-row.is-active').textContent(), /Import sessions…/);
  await page.keyboard.press('Enter');
  await dialog(page).waitFor();
  await page.waitForSelector('.import-row');
  assert.deepEqual(server.importLoads, ['claude'], 'only the shown tab loads');
  assert.equal(await tab(page, 'Claude Code').getAttribute('aria-selected'), 'true');
  assert.equal(await tab(page, 'Claude Code').locator('.import-tab-count').textContent(), '13');
  assert.equal(await tab(page, 'Codex').locator('.import-tab-count').count(), 0, 'no count before the Codex list loads');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.import-search') != null), true, 'search is focused');

  const first = rows(page).first();
  assert.equal(await first.locator('.import-title').textContent(), 'Port the image resizer into webapp');
  assert.equal(await first.locator('.import-folder').textContent(), '~/webapp');
  assert.equal(await first.locator('.import-time').textContent(), '2h ago');
  assert.equal(await first.locator('.import-size').textContent(), '48 MB');

  await tab(page, 'Codex').click();
  await waitFor(() => page.locator('.import-row .import-chip').count().then((n) => n > 0), { message: 'Codex rows' });
  assert.deepEqual(server.importLoads, ['claude', 'codex']);
  assert.equal(await tab(page, 'Codex').locator('.import-tab-count').textContent(), '31');
  const chips = new Set(await page.locator('.import-chip').allTextContents());
  for (const label of ['Desktop', 'Terminal', 'Exec']) assert.ok(chips.has(label), label);
  await page.locator('.import-search input').fill('lucide');
  assert.equal(await row(page, 'bump lucide-preact').locator('.import-chip').textContent(), 'codex_cloud', 'unknown originators as-is');

  // Switching back does not reload; reopening does (fresh "Imported" state).
  await tab(page, 'Claude Code').click();
  assert.deepEqual(server.importLoads, ['claude', 'codex']);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  await openFromSidebar(page);
  assert.deepEqual(server.importLoads, ['claude', 'codex', 'claude'], 'the last tab is remembered');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: /import opens it and /help lists it', async () => {
  const { page, context, server } = await openApp(browser);
  await context.route('**/api/commands**', (route) => route.fulfill({ json: { commands: [] } }));
  const composer = page.locator('.composer textarea');
  await composer.click();
  await page.keyboard.type('/import');
  await page.keyboard.press('Enter');
  await dialog(page).waitFor();
  assert.equal(await composer.inputValue(), '', 'the command is not sent');
  assert.equal(server.requests.filter((r) => r.path.endsWith('/messages')).length, 0);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });

  await composer.click();
  await page.keyboard.type('/help');
  await page.keyboard.press('Enter');
  const help = page.locator('.help-dialog');
  await help.waitFor();
  assert.match(await help.locator('.help-command', { hasText: '/import' }).textContent(), /Import Claude Code or Codex sessions/);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: a home-folder row ("~") has no gap before its size, on a desktop and a phone', async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = viewport.width < 400;
    const { page, context, server } = await openApp(browser, { viewport, isMobile: phone, hasTouch: phone, waitForSessions: !phone });
    if (phone) await page.locator('.topbar-sidebar-toggle').click();
    await openFromSidebar(page);
    await tab(page, 'Codex').click();
    const home = row(page, 'Clean up stale tmux monitor sessions');
    await home.waitFor();
    assert.equal(await home.locator('.import-folder').textContent(), '~');
    const measure = (target) =>
      target.evaluate((el) => {
        // From the end of the folder's text (not its box) to the size.
        const folder = el.querySelector('.import-folder');
        const text = folder.querySelector('bdi').getBoundingClientRect();
        return { gap: el.querySelector('.import-size').getBoundingClientRect().left - text.right, cut: folder.scrollWidth > folder.clientWidth };
      });
    const short = await measure(home);
    assert.ok(short.gap <= 7, `gap after "~": ${short.gap}px at ${viewport.width}px`);
    assert.equal(short.cut, false);
    // A longer folder keeps its share of the line.
    const long = await measure(row(page, 'Batch-rate the queued rows'));
    assert.ok(long.gap <= 7, `gap after a long folder: ${long.gap}px`);
    assert.deepEqual(server.errors, []);
    await context.close();
  }
});

test('import: search over titles and folders, folder filter, clear filters', async () => {
  const { page, context, server } = await openApp(browser);
  await openFromSidebar(page);
  await page.keyboard.type('monorepo');
  const folders = await page.locator('.import-folder').allTextContents();
  assert.ok(folders.length >= 4 && folders.every((f) => f === '~/monorepo'), folders.join());
  assert.match(await page.locator('.import-shown').textContent(), /^\d of 13$/);

  await page.locator('.import-search input').fill('xz flip');
  assert.deepEqual(await page.locator('.import-title').allTextContents(), ['Debug the axis flip in the export step']);
  await page.locator('.import-search input').fill('');

  await page.locator('.import-project select').selectOption({ label: '~/api-server (2)' });
  assert.deepEqual(await page.locator('.import-title').allTextContents(), ['Fix the deploy timeout in the multi-node launcher', 'Search ranking study: title boost + boxes']);
  await page.locator('.import-search input').fill('nothing matches this');
  await page.locator('.import-state', { hasText: 'No sessions match' }).waitFor();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await rows(page).count(), 13);
  assert.equal(await page.locator('.import-project select').inputValue(), '');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: tick rows on both tabs; batches of 20 with the new-session model and mode; opens the first', async () => {
  const { page, context, server } = await openApp(browser, { storage: { 'mesh-code-model': 'sonnet', 'mesh-code-mode': 'plan' } });
  await openFromSidebar(page);
  await row(page, 'Port the image resizer').click();
  assert.equal(await row(page, 'Port the image resizer').getAttribute('aria-selected'), 'true');
  await tab(page, 'Codex').click();
  await page.waitForSelector('.import-chip');
  await page.locator('.import-select-all').click();
  // 31 rows: one is not importable.
  assert.equal(await page.locator('.import-select-all').getAttribute('aria-checked'), 'true');
  const importButton = dialog(page).locator('.dialog-footer .btn-primary');
  assert.equal(await importButton.textContent(), 'Import 31');
  assert.ok(await tab(page, 'Claude Code').locator('.import-tab-ticked').count(), 'the other tab shows it has ticked rows');

  server.importDelay = 150;
  // More than 20 asks once; Back returns to the selection.
  await importButton.click();
  await page.locator('.import-confirm', { hasText: 'Import 31 sessions?' }).waitFor();
  assert.deepEqual(imports(server), [], 'nothing sent before confirming');
  await dialog(page).locator('.dialog-footer .import-cancel').click();
  assert.equal(await importButton.textContent(), 'Import 31');
  assert.ok(await dialog(page).isVisible(), 'Back keeps the dialog open');
  await importButton.click();
  assert.equal(await importButton.textContent(), 'Import all 31');
  await importButton.click();
  await page.locator('.import-summary', { hasText: /Importing 31 sessions…|Imported \d+ of 31…/ }).waitFor();
  assert.equal(await page.locator('.import-controls').evaluate((el) => el.disabled), true, 'controls are disabled while importing');
  await dialog(page).waitFor({ state: 'detached', timeout: 5000 });

  const bodies = imports(server);
  assert.deepEqual(bodies.map((b) => [b.source, b.ids.length]), [['codex', 20], ['codex', 10], ['claude', 1]], 'the shown tab first, at most 20 per request');
  for (const body of bodies) {
    assert.equal(body.model, 'sonnet');
    assert.equal(body.mode, 'plan');
  }
  assert.ok(!bodies[0].ids.includes('x8'), 'the disabled row is not sent');
  assert.equal(bodies[0].ids[0], 'x1', 'newest first');
  await page.waitForFunction(() => location.search === '?session=imp-x1');
  assert.match(await page.locator('.toast').textContent(), /Imported 31 sessions\./);
  await page.locator('.session-row', { hasText: 'Relabel the 10-02 user uploads' }).waitFor();
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: Imported rows open their session; disabled rows show why and cannot be ticked', async () => {
  const { page, context, server } = await openApp(browser, { imports: true });
  await openFromSidebar(page);
  const blocked = row(page, 'Scratch build of the tokenizer bench');
  assert.equal(await blocked.getAttribute('aria-disabled'), 'true');
  assert.equal(await blocked.locator('.import-reason').textContent(), 'The folder is outside your home directory.');
  await blocked.click({ force: true });
  assert.equal(await blocked.getAttribute('aria-selected'), 'false');
  assert.equal(await dialog(page).locator('.dialog-footer .btn-primary').isDisabled(), true);

  const imported = row(page, 'Fix the deploy timeout');
  assert.match(await imported.locator('.import-status').textContent(), /Imported/);
  await imported.click();
  await dialog(page).waitFor({ state: 'detached' });
  await page.waitForFunction(() => location.search === '?session=s-imp-claude');
  assert.equal(imports(server).length, 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: keyboard — ↓ into the list, Space ticks, Enter imports; letters go back to search', async () => {
  const { page, context, server } = await openApp(browser);
  await openFromSidebar(page);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'import-list');
  assert.equal(await page.locator('.import-row.is-active .import-title').textContent(), 'Port the image resizer into webapp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  assert.deepEqual(await page.locator('.import-row[aria-selected="true"] .import-title').allTextContents(), ['Why does the data loader use 59 GB per process?']);
  // Up from the first row returns to the search box; typing there filters.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.import-search') != null), true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('po');
  assert.equal(await page.locator('.import-search input').inputValue(), 'po', 'typing in the list goes to search');
  await page.keyboard.press('Enter');
  await dialog(page).waitFor({ state: 'detached' });
  assert.deepEqual(imports(server).map((b) => b.ids), [['c2']]);
  await page.waitForFunction(() => location.search === '?session=imp-c2');
  assert.match(await page.locator('.toast').textContent(), /Imported “Why does the data loader use 59 GB per process\?”/);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: Enter with nothing ticked imports the highlighted row', async () => {
  const { page, context, server } = await openApp(browser);
  await openFromSidebar(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await dialog(page).waitFor({ state: 'detached' });
  assert.deepEqual(imports(server).map((b) => b.ids), [['c2']]);
  await context.close();
});

test('import: partial failures are listed; failed rows stay ticked for a retry', async () => {
  const { page, context, server } = await openApp(browser);
  server.importErrors = { c3: 'Session file is locked by another process.' };
  await openFromSidebar(page);
  for (const title of ['Port the image resizer', 'Add thumbnail renders', 'Debug the axis flip']) await row(page, title).click();
  await dialog(page).locator('.dialog-footer .btn-primary').click();
  const report = page.locator('.import-report');
  await report.waitFor();
  assert.match(await report.locator('.import-report-head').textContent(), /Imported 2\. 1 session couldn’t be imported:/);
  assert.equal(await report.locator('.import-report-title').textContent(), 'Add thumbnail renders to the gallery stitcher');
  assert.equal(await report.locator('.import-report-error').textContent(), 'Session file is locked by another process.');
  assert.equal(await row(page, 'Port the image resizer').locator('.import-status').count(), 1, 'imported rows turn into links');
  assert.equal(await row(page, 'Add thumbnail renders').getAttribute('aria-selected'), 'true');
  assert.equal(await dialog(page).locator('.dialog-footer .btn-primary').textContent(), 'Import 1');

  server.importErrors = {};
  await dialog(page).locator('.dialog-footer .btn-primary').click();
  await dialog(page).waitFor({ state: 'detached' });
  await page.waitForFunction(() => location.search === '?session=imp-c3');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: closing during an import lets it finish in the background', async () => {
  const { page, context, server } = await openApp(browser);
  server.importDelay = 400;
  await openFromSidebar(page);
  await row(page, 'Port the image resizer').click();
  await dialog(page).locator('.dialog-footer .btn-primary').click();
  await page.locator('.import-progress').waitFor();
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  assert.match(await page.locator('.toast').textContent(), /continues in the background/);
  await page.locator('.toast', { hasText: 'Imported “Port the image resizer into webapp”.' }).waitFor();
  await page.locator('.session-row', { hasText: 'Port the image resizer into webapp' }).waitFor();
  assert.equal(await page.evaluate(() => location.search), '', 'no jump to the session after closing');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: a failed list load offers Try again', async () => {
  const { page, context, server } = await openApp(browser);
  server.importListError = { claude: 'Could not read ~/.claude/projects.' };
  await page.locator('.import-sessions').click();
  const state = page.locator('.import-state[role="alert"]');
  await state.waitFor();
  assert.match(await state.textContent(), /Couldn’t load Claude Code sessions.*Could not read ~\/\.claude\/projects\./);
  server.importListError = {};
  await state.getByRole('button', { name: 'Try again' }).click();
  await page.waitForSelector('.import-row');
  assert.equal(await rows(page).count(), 13);
  // The failed response is a console error in the browser; nothing else is.
  assert.deepEqual(server.errors.filter((e) => !/500/.test(e)), []);
  await context.close();
});

test('import: 1,200 rows are windowed and stay usable', async () => {
  const { page, context, server } = await openApp(browser);
  const now = Date.now();
  server.candidates.codex = Array.from({ length: 1200 }, (_, i) => ({
    id: 'r' + i,
    title: `Rollout ${i + 1}`,
    cwd: `/home/you/project-${i % 40}`,
    createdAt: now - i * 3_600_000 - 60_000,
    updatedAt: now - i * 3_600_000,
    size: 50_000 + i * 1000,
    originator: 'Codex Desktop',
    importable: true,
  }));
  await openFromSidebar(page);
  await tab(page, 'Codex').click();
  await page.locator('.import-row', { hasText: 'Rollout 1' }).first().waitFor();
  assert.equal(await tab(page, 'Codex').locator('.import-tab-count').textContent(), '1,200');
  const rendered = await rows(page).count();
  assert.ok(rendered < 60, `only the visible rows are in the DOM (${rendered})`);
  await page.locator('#import-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.locator('.import-row', { hasText: 'Rollout 1200' }).waitFor();
  assert.ok((await rows(page).count()) < 60);
  await page.locator('.import-row', { hasText: 'Rollout 1200' }).click();
  // End jumps to (and reveals) the last row.
  await page.locator('#import-list').evaluate((el) => (el.scrollTop = 0));
  await page.locator('#import-list').focus();
  await page.keyboard.press('End');
  assert.equal(await page.locator('.import-row.is-active .import-title').textContent(), 'Rollout 1200');
  await page.locator('.import-select-all').click();
  assert.equal(await dialog(page).locator('.dialog-footer .btn-primary').textContent(), 'Import 1,200');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('import: fits a 320 px phone in both themes', async () => {
  for (const theme of ['dark', 'light']) {
    const { page, context, server } = await openApp(browser, { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, theme, colorScheme: theme, waitForSessions: false });
    await page.locator('.topbar-sidebar-toggle').click();
    await page.locator('.import-sessions').click();
    await dialog(page).waitFor();
    await page.waitForSelector('.import-row');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'INPUT'), false, 'no keyboard pops up on open');
    assert.equal(await page.evaluate(() => document.querySelector('.drawer-open')), null, 'the drawer closed');
    await tab(page, 'Codex').click();
    await page.waitForSelector('.import-chip');
    await rows(page).nth(1).click();
    const layout = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const panel = box(document.querySelector('dialog.import-dialog'));
      const inside = (el) => {
        const r = box(el);
        return r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5;
      };
      const parts = [...document.querySelectorAll('.import-tabs, .import-search, .import-project, .import-row, .import-time, .import-chip, .dialog-footer .btn-primary')];
      return {
        width: panel.width,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        outside: parts.filter((el) => !inside(el)).map((el) => el.className),
        timeCut: [...document.querySelectorAll('.import-time')].some((el) => el.scrollWidth > el.clientWidth + 1),
      };
    });
    assert.ok(layout.width <= 320, `sheet width ${layout.width}`);
    assert.equal(layout.pageOverflow, false);
    assert.deepEqual(layout.outside, []);
    assert.equal(layout.timeCut, false);
    assert.equal(await dialog(page).locator('.dialog-footer .btn-primary').textContent(), 'Import 1');
    assert.ok(await dialog(page).locator('.dialog-footer .btn-primary').isVisible());
    assert.deepEqual(server.errors, []);
    await context.close();
  }
});
