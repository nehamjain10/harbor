// App shell flows: the side panel, the command palette and theme, pins and unread dots,
// and the phone layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSession,
  flow,
  send,
  sendAndWait,
  textOf,
  waitFor,
  waitForPending,
  waitForText,
  waitForTurns,
} from './helpers.mjs';

const sessionRow = (page, title) => page.locator('.session-row', { has: page.locator('.session-title', { hasText: title }) });

export function shellFlows(ctx) {
  flow(ctx, 'side panel: Changes shows the diff of an edit, Files lists and opens repo files, Plan is empty', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Panel' });
    const { page } = await openSession(session.id);
    await sendAndWait(stack, page, session.id, 'Fix the greeting. [[mock:edit]]');

    const changes = await stack.api('GET', `sessions/${session.id}/changes`);
    assert.equal(changes.branch, 'main');
    assert.match(changes.diff, /-hello world\n\+goodbye world/);

    await page.getByRole('button', { name: 'Show files and changes' }).click();
    const panel = page.locator('.side-panel');
    await panel.waitFor();
    assert.equal(await panel.getByRole('tab', { selected: true }).textContent(), 'Changes');
    await waitForText(panel.locator('.changes-summary'), /main.*1 file · \+1 −1/);
    assert.equal(await textOf(panel.locator('.changes-item .changes-name')), 'hello.txt');
    const diff = panel.locator('.diff-file');
    await waitForText(diff.locator('.diff-file-head'), /hello\.txt/);
    await waitForText(diff.locator('.diff-body'), /hello world.*goodbye world/);

    await panel.getByRole('tab', { name: 'Files' }).click();
    const list = panel.locator('.file-list');
    await list.waitFor();
    await waitFor(async () => (await list.locator('.file-name').count()) >= 3, { message: 'the file list' });
    assert.deepEqual(await list.locator('.file-name').allTextContents(), ['src', 'hello.txt', 'notes.md']);
    await list.locator('.file-item', { hasText: 'hello.txt' }).click();
    await waitForText(panel.locator('.file-view'), /goodbye world/);
    await waitForText(panel.locator('.file-meta'), /2 lines/);
    await panel.locator('.crumbs-path .crumb').first().click();
    await list.locator('.file-item', { hasText: 'src' }).click();
    await waitForText(list, /app\.py/);

    await panel.getByRole('tab', { name: 'Plan' }).click();
    await waitForText(panel.locator('.panel-message'), /No plan yet/);
    await panel.getByRole('button', { name: 'Close panel' }).click();
    await panel.waitFor({ state: 'detached' });
  });

  flow(ctx, 'changes API lists the changed files with status and line counts', async ({ stack }) => {
    const repo = stack.makeRepo('changes');
    fs.writeFileSync(path.join(repo, 'hello.txt'), 'goodbye world\nsecond line\n');
    fs.writeFileSync(path.join(repo, 'added.txt'), 'new\n');
    const session = await createSession(stack, { cwd: repo, title: 'Changes API' });
    const changes = await stack.api('GET', `sessions/${session.id}/changes`);
    assert.ok(Array.isArray(changes.files), 'files is a list');
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]));
    assert.deepEqual(Object.keys(byPath).sort(), ['added.txt', 'hello.txt']);
    assert.ok(byPath['hello.txt'].status && byPath['added.txt'].status);
    assert.deepEqual([byPath['hello.txt'].adds, byPath['hello.txt'].dels], [1, 1]);
    assert.deepEqual([byPath['added.txt'].adds, byPath['added.txt'].dels], [1, 0]);
  });

  flow(ctx, 'palette: Ctrl+K finds a session by title and opens it; the light theme survives a reload', async ({ stack, openSession }) => {
    const target = await createSession(stack, { title: 'Palette target alpha' });
    const other = await createSession(stack, { title: 'Palette starting point' });
    const { page } = await openSession(other.id);

    await page.keyboard.press('Control+k');
    const input = page.locator('.palette[open] .palette-input');
    await input.waitFor();
    await input.pressSequentially('palette target');
    await waitForText(page.locator('.palette-row.is-active'), /Palette target alpha/);
    await input.press('Enter');
    await page.locator('.palette').waitFor({ state: 'detached' });
    await page.waitForFunction((id) => new URLSearchParams(location.search).get('session') === id, target.id);
    await waitForText(page.locator('.crumb-title'), /^Palette target alpha$/);
    await waitFor(async () => (await sessionRow(page, 'Palette target alpha').getAttribute('class')).includes('is-active'), { message: 'the row to be active' });

    // Theme: dark by default; Light from the palette's theme page persists.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.keyboard.press('Control+k');
    await input.waitFor();
    await input.pressSequentially('theme');
    await waitForText(page.locator('.palette-row.is-active'), /theme/i);
    await input.press('Enter');
    await waitForText(page.locator('.palette-crumb'), /^Theme$/);
    await input.pressSequentially('light');
    await waitForText(page.locator('.palette-row.is-active'), /Light/);
    await input.press('Enter');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await page.evaluate(() => localStorage.getItem('mesh-code-theme')), 'light');
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.reload();
    await page.locator('.crumb-title').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), lightBackground);
    await waitForText(page.locator('.crumb-title'), /^Palette target alpha$/);
  });

  flow(ctx, 'pins and unread: a pinned row moves to Pinned; a turn finishing in another session shows its unread dot until opened', async ({ stack, openSession }) => {
    const sessionA = await createSession(stack, { title: 'Unread A' });
    const sessionB = await createSession(stack, { title: 'Viewer B' });
    const { page } = await openSession(sessionB.id);
    const rowA = sessionRow(page, 'Unread A');
    await rowA.waitFor();

    await rowA.hover();
    await rowA.getByRole('button', { name: 'Pin Unread A' }).click();
    const pinned = page.locator('.session-group', { has: page.locator('.session-group-label', { hasText: 'Pinned' }) });
    await waitFor(async () => (await pinned.locator('.session-title').allTextContents()).includes('Unread A'), { message: 'A under Pinned' });
    assert.equal((await stack.api('GET', `sessions/${sessionA.id}`)).pinned, true);
    assert.ok(!(await pinned.locator('.session-title').allTextContents()).includes('Viewer B'));

    // A turn in A finishes while B is open.
    await stack.api('POST', `sessions/${sessionA.id}/messages`, { text: 'hello from elsewhere', clientId: 'e2e-unread-1' });
    const finished = await waitForTurns(stack, sessionA.id, 1);
    assert.ok(finished.turnEndedAt > (finished.lastViewedAt || 0), 'unread on the server');
    await rowA.locator('.status-dot.dot-unread').waitFor();
    assert.ok((await rowA.getAttribute('class')).includes('is-unread'));
    assert.equal(await sessionRow(page, 'Viewer B').locator('.status-dot').count(), 0);

    // Opening A clears it, on the server too.
    await rowA.locator('.session-main').click();
    await waitForText(page.locator('.crumb-title'), /^Unread A$/);
    await rowA.locator('.status-dot').waitFor({ state: 'detached' });
    await waitFor(
      async () => {
        const viewed = await stack.api('GET', `sessions/${sessionA.id}`);
        return viewed.lastViewedAt >= viewed.turnEndedAt;
      },
      { message: 'lastViewedAt to catch up' },
    );
    await waitForText(page.locator('.msg-assistant').last(), /\bok\b/);
  });

  flow(ctx, 'phone (390×844): the drawer opens and closes, the composer sends, an approval card fits the screen', async ({ stack, openSession }) => {
    const repo = stack.makeRepo('mobile');
    const session = await createSession(stack, { cwd: repo, mode: 'default', title: 'On the phone' });
    const { page } = await openSession(session.id, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const app = page.locator('.app');
    const sidebar = page.locator('.sidebar');
    const onScreen = async (locator) => {
      const box = await locator.boundingBox();
      return box && box.x >= -1 && box.x + box.width <= 391;
    };

    assert.ok(!(await app.getAttribute('class')).includes('drawer-open'));
    assert.equal(await onScreen(sidebar), false, 'the drawer starts closed');
    await page.locator('.topbar-sidebar-toggle').tap();
    await waitFor(async () => (await app.getAttribute('class')).includes('drawer-open'), { message: 'the drawer to open' });
    await waitFor(() => onScreen(sidebar), { message: 'the drawer on screen' });
    await sessionRow(page, 'On the phone').waitFor();
    await page.locator('.drawer-scrim').tap({ position: { x: 370, y: 400 } });
    await waitFor(async () => !(await app.getAttribute('class')).includes('drawer-open'), { message: 'the drawer to close' });
    await waitFor(async () => !(await onScreen(sidebar)), { message: 'the drawer off screen' });

    await sendAndWait(stack, page, session.id, 'hello from the phone', { button: true });
    await waitForText(page.locator('.msg-assistant').last(), /\bok\b/);

    await send(page, 'Make a file. [[mock:bash:touch phone.txt]]', { button: true });
    await waitForPending(stack, session.id);
    const card = page.locator('.approval-permission');
    await card.waitFor();
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `card within the width: ${JSON.stringify(box)}`);
    assert.ok(box.y >= 0 && box.y + box.height <= 844, `card within the height: ${JSON.stringify(box)}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, 'no horizontal scroll');
    const allow = card.getByRole('button', { name: /Allow once/ });
    assert.ok(await onScreen(allow));
    await allow.tap();
    await waitForTurns(stack, session.id, 2);
    assert.ok(fs.existsSync(path.join(repo, 'phone.txt')));
    await card.waitFor({ state: 'detached' });
  });
}
