// Composer flows: attachments on vision and text-only routes, `@` file mentions and the
// `/` command menu.
import assert from 'node:assert/strict';
import { createSession, flow, pngBuffer, send, textOf, turnRequests, waitFor, waitForText, waitForTurns } from './helpers.mjs';

const PNG = { name: 'pixel.png', mimeType: 'image/png', buffer: pngBuffer() };
const TEXT = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember the milk.\n') };

async function attach(page, files) {
  await page.locator('.composer input[type=file]').setInputFiles(files);
  await waitFor(async () => (await page.locator('.attach-chip.is-done').count()) === files.length, { message: 'the uploads to finish' });
}

export function composerFlows(ctx) {
  flow(ctx, 'attachments: a PNG and a .txt go inline to a vision route, both listed by path', async ({ stack, openSession }) => {
    // Vision route (luna): the image goes inline, both files are listed by path.
    const vision = await createSession(stack, { model: 'luna', title: 'Attach on luna' });
    const { page } = await openSession(vision.id);
    await attach(page, [PNG, TEXT]);
    assert.equal(await page.locator('.attach-note').count(), 0, 'no "sent as a path" note on a vision model');
    await send(page, 'Describe these files.');
    let done = await waitForTurns(stack, vision.id, 1);
    const sent = done.messages.find((m) => m.role === 'user');
    assert.deepEqual(
      sent.attachments.map((a) => [a.name, a.image]),
      [
        ['pixel.png', true],
        ['notes.txt', false],
      ],
    );
    let request = turnRequests(stack).at(-1);
    assert.equal(request.model, 'codex/gpt-6-luna');
    assert.ok(request.humanBlocks.includes('image'), `image block sent inline: ${request.humanBlocks}`);
    assert.match(request.human, /Describe these files\.\n\nAttached files:\n- \S+pixel\.png \(image, shown above\)\n- \S+notes\.txt/);

    const bubble = page.locator('.msg-user').last();
    const thumb = bubble.locator('.sent-thumb img');
    await thumb.waitFor();
    await waitFor(() => thumb.evaluate((img) => img.complete && img.naturalWidth === 8), { message: 'the thumbnail to load from the server' });
    assert.equal(await textOf(bubble.locator('.sent-file .attach-name')), 'notes.txt');
    // The thumbnail opens the full image; Esc closes it.
    await bubble.locator('.sent-thumb').click();
    const lightbox = page.locator('dialog.lightbox[open]');
    await lightbox.waitFor();
    await waitFor(() => lightbox.locator('img').evaluate((img) => img.complete && img.naturalWidth === 8), { message: 'the full image' });
    await page.keyboard.press('Escape');
    await lightbox.waitFor({ state: 'detached' });
    assert.equal(await textOf(bubble.locator('.user-bubble')), 'Describe these files.');
    assert.equal(await page.locator('.attach-tray').count(), 0, 'the tray empties after sending');

    // Every catalog model has vision now; the text-only path (paths only, no image
    // block) is covered in composer-api.test.mjs with a route marked text-only.
  });

  flow(ctx, 'new-session view: @ and / use the chosen project; a draft attachment moves into the new session', async ({ stack, openPage }) => {
    const repo = stack.makeRepo('draft');
    const { page } = await openPage({ storage: { 'mesh-code-project': repo } });
    await page.locator('.empty-title').waitFor();
    const input = page.locator('.composer-input');

    await input.click();
    await input.pressSequentially('@note');
    const files = page.locator('.suggest-files');
    await waitFor(async () => (await files.locator('.mention-name').first().textContent().catch(() => '')) === 'notes.md', { message: 'notes.md from the project' });
    await input.press('Escape');
    await files.waitFor({ state: 'detached' });
    await input.fill('');
    await input.pressSequentially('/');
    const commands = page.locator('.suggest-commands');
    await waitFor(async () => (await commands.locator('.is-sdk').count()) > 0, { timeout: 30_000, message: 'Claude Code commands for the project' });
    await input.press('Escape');
    await input.fill('');

    // Attach before the session exists (a draft upload), then send.
    await attach(page, [PNG]);
    await send(page, 'What is in this image?');
    await page.waitForFunction(() => new URLSearchParams(location.search).has('session'));
    const id = new URL(page.url()).searchParams.get('session');
    const done = await waitForTurns(stack, id, 1);
    assert.equal(done.cwd, repo);
    assert.equal(done.model, 'luna');
    const [attachment] = done.messages.find((m) => m.role === 'user').attachments;
    assert.equal(attachment.name, 'pixel.png');
    const request = turnRequests(stack).at(-1);
    assert.ok(request.humanBlocks.includes('image'), 'the draft image reached the model');
    assert.match(request.human, new RegExp(`- \\S*/uploads/${id}/\\S+ \\(image, shown above\\)`), 'the file moved into the session folder');
    const thumb = page.locator('.msg-user .sent-thumb img');
    await thumb.waitFor();
    await waitFor(() => thumb.evaluate((img) => img.complete && img.naturalWidth === 8), { message: 'the thumbnail to load' });
    assert.equal(await page.locator('.attach-tray').count(), 0);
  });

  flow(ctx, 'composer menus: @ lists repo files and inserts the path; / lists local and Claude Code commands; /model opens the picker', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Menus' });
    const { page } = await openSession(session.id);
    const input = page.locator('.composer-input');

    // `@`: every tracked file of the repo, then a fuzzy match inserted as a mention.
    await input.click();
    await input.pressSequentially('Look at @');
    const files = page.locator('.suggest-files');
    await files.waitFor();
    await waitFor(async () => (await files.locator('.mention-name').count()) >= 3, { message: 'the file list' });
    const names = await files.locator('.mention-name').allTextContents();
    for (const name of ['hello.txt', 'notes.md', 'app.py']) assert.ok(names.includes(name), `${name} in ${names}`);
    await input.pressSequentially('hel');
    await waitFor(async () => (await files.locator('.mention-name').first().textContent()) === 'hello.txt', { message: 'hello.txt first' });
    await input.press('Enter');
    await files.waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), 'Look at @hello.txt ');
    await input.fill('');

    // `/`: local commands and the ones Claude Code reports for this project.
    await input.pressSequentially('/');
    const commands = page.locator('.suggest-commands');
    await commands.waitFor();
    await waitFor(async () => (await commands.locator('.is-sdk, .is-skill').count()) > 0, { timeout: 30_000, message: 'Claude Code commands' });
    const listed = await commands.locator('.command-name').allTextContents();
    for (const name of ['/model', '/mode', '/effort', '/clear', '/rename', '/help']) assert.ok(listed.includes(name), `${name} in ${listed}`);
    const sdk = await commands.locator('.is-sdk .command-name').allTextContents();
    assert.ok(sdk.includes('/compact'), `Claude Code's /compact is listed: ${sdk}`);
    const { commands: served } = await stack.api('GET', `commands?cwd=${encodeURIComponent(session.cwd)}`);
    assert.ok(served.some((c) => c.source === 'sdk' && c.name === 'compact'));

    await input.pressSequentially('model');
    await waitForText(commands.locator('.suggest-row.is-active .command-name'), /^\/model$/);
    await input.press('Enter');
    const picker = page.locator('.picker-popover[aria-label="Choose a model"]');
    await picker.waitFor();
    assert.equal(await input.inputValue(), '', 'the local command is not sent');
    await waitForText(picker.locator('.menu-row.is-selected'), /GPT-6 Luna/);
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'detached' });
    const after = await stack.api('GET', `sessions/${session.id}`);
    assert.equal(after.messages.length, 0, 'nothing was sent');
  });

  flow(ctx, 'a paste goes in from the event even when the browser inserts nothing (dictation apps)', async ({ stack, openSession }) => {
    const session = await createSession(stack, { model: 'luna', title: 'Paste from the event' });
    const { page } = await openSession(session.id);
    const box = page.locator('.composer-input');
    await box.click();
    await page.keyboard.type('First line');
    await page.keyboard.press('Shift+Enter');
    // A synthetic paste has no default action, as when Chrome re-reads a clipboard that
    // Wispr Flow has already restored: the event's own text must still land.
    for (const text of ['Second line.', ' And more.']) {
      await box.evaluate((el, value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
    }
    assert.equal(await box.inputValue(), 'First line\nSecond line. And more.');
    // The draft saw it (the input event fired): it survives a reload.
    await page.waitForTimeout(300);
    await page.reload();
    await waitFor(async () => (await box.inputValue()) === 'First line\nSecond line. And more.', { message: 'the draft to come back' });
  });

}
