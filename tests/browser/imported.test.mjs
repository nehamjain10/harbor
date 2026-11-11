// Imported sessions: source badges in the sidebar and palette, the banner shown until
// the first turn here, and the ApplyPatch card of imported Codex edits, against the
// mocked v2 server (harness.mjs). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitSession, launch, openApp } from './harness.mjs';

const textOf = async (locator) => (await locator.textContent()).replace(/\s+/g, ' ').trim();

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

test('imported sessions: named in the row tooltip and badged in the palette, banner until the first turn', async () => {
  const { page, context, server } = await openApp(browser, { imports: true });
  const claudeRow = page.locator('.session-row', { hasText: 'Fix the deploy timeout' });
  // Rows are a single line; where a session came from is in its tooltip.
  assert.equal(await page.locator('.session-row .source-badge').count(), 0);
  await claudeRow.locator('.session-main').hover();
  assert.match(await claudeRow.locator('.session-main').getAttribute('title'), /\nImported from Claude Code$/);
  const codexRow = page.locator('.session-row', { hasText: 'Switch the trainer' });
  await codexRow.locator('.session-main').hover();
  assert.match(await codexRow.locator('.session-main').getAttribute('title'), /\nImported from Codex$/);
  const plainRow = page.locator('.session-row', { hasText: 'Review GPU memory profile' });
  await plainRow.locator('.session-main').hover();
  assert.doesNotMatch(await plainRow.locator('.session-main').getAttribute('title'), /Imported/);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('codex');
  const result = page.locator('.palette-row', { hasText: 'Switch the trainer to mixed precision' });
  assert.equal(await result.locator('.source-badge').textContent(), 'Codex');
  await page.keyboard.press('Escape');

  await claudeRow.locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-imp-claude');
  const banner = page.locator('.import-banner');
  assert.match(await page.locator('.msg-assistant .assistant-time').first().textContent(), /^\w{3} \d+, \d+:\d{2}\s[AP]M$/, 'imported replies show their date');
  assert.match(await banner.textContent(), /^Imported from Claude Code · \w{3} \d+\. Your next message continues it on Claude Opus 5\.5 in a copy; the original is unchanged\.$/);
  // The omitted-history notice leads the transcript.
  assert.match(await page.locator('.transcript-column > :first-child').textContent(), /1,240 earlier messages are not shown/);

  // Switching the model updates the banner; a turn of its own removes it.
  const session = server.sessions.find((s) => s.id === 's-imp-claude');
  await emitSession(page, { ...session, model: 'luna', updatedAt: Date.now() });
  await page.locator('.import-banner', { hasText: 'continues it on GPT-6 Luna' }).waitFor();
  await emitSession(page, {
    ...session,
    updatedAt: Date.now() + 1,
    status: 'running',
    messages: [...session.messages, { id: 'own1', role: 'user', text: 'Drop the pin.', at: Date.now(), delivery: 'running' }],
  });
  await banner.waitFor({ state: 'detached' });

  await page.locator('.session-row', { hasText: 'Switch the trainer' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-imp-codex');
  assert.match(
    await page.locator('.import-banner').textContent(),
    /^Imported from Codex · \w{3} \d+\. Codex conversations can’t be resumed directly; your next message starts a new conversation that carries a summary of this one\.$/,
  );
  await page.locator('.import-banner-close').click();
  assert.equal(await page.locator('.import-banner').count(), 0, 'the banner can be closed');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('ApplyPatch card: "Edited 3 files" with a diff per file', async () => {
  const { page, context, server } = await openApp(browser, { imports: true, url: '/?session=s-imp-codex' });
  await page.locator('.activity-head').first().click();
  const toolRow = page.locator('.tool-row', { hasText: 'Edited' });
  assert.match(await toolRow.textContent(), /Edited\s*3 files\s*\+7\s*−3/);
  assert.match(await page.locator('.activity-summary').first().textContent(), /Edited 3 files, ran 1 command/);
  await toolRow.click();
  const files = page.locator('.patch-file');
  assert.equal(await files.count(), 3);
  assert.match(await files.nth(0).locator('.path-label').textContent(), /src\/train\/loop\.py/);
  assert.equal(await files.nth(0).locator('.d-hunk').first().textContent(), 'def train_step(batch, model, optimizer):');
  assert.equal(await files.nth(0).locator('.d-add').count(), 4);
  assert.equal(await files.nth(0).locator('.d-del').count(), 3);
  assert.equal(await files.nth(1).locator('.tool-chip').textContent(), 'Added');
  // Zero counts are left out: the added file shows only its additions.
  assert.equal(await files.nth(0).locator('.tool-stats').textContent(), '+4 −3');
  assert.equal(await files.nth(1).locator('.tool-stats').textContent(), '+3');
  assert.equal(await files.nth(2).locator('.tool-stats').count(), 0, 'a deleted file has no counts');
  assert.equal(await files.nth(2).locator('.tool-chip').textContent(), 'Deleted');
  assert.equal(await files.nth(2).locator('.open-btn').count(), 0, 'a deleted file has nothing to open');
  const fileRequest = page.waitForRequest((request) => request.url().includes('/files?path=src'));
  await files.nth(1).locator('.open-btn').click();
  assert.match((await fileRequest).url(), /\/api\/sessions\/s-imp-codex\/files\?path=src%2Ftrain%2Famp\.py$/, 'relative patch paths open in the session folder');
  // Imported Codex replies name their model with the OpenAI glyph.
  assert.equal(await page.locator('.assistant-head .model-icon-openai').count(), 1);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('diff counts leave out zeros: "+3" for an added file, "−2" for removed lines only', async () => {
  const { page, context, server } = await openApp(browser, { imports: true, url: '/?session=s-imp-codex' });
  const session = server.sessions.find((s) => s.id === 's-imp-codex');
  const at = Date.now();
  const tool = (id, input) => ({ id, role: 'tool', imported: true, tool: 'ApplyPatch', toolId: id, state: 'done', at, endedAt: at, input: { patch: input.join('\n') }, output: 'Success.' });
  const added = tool('add1', ['*** Begin Patch', '*** Add File: greet.sh', '+#!/bin/sh', '+# Print a greeting', '+echo hello', '*** End Patch']);
  const trimmed = tool('del1', ['*** Begin Patch', '*** Update File: notes.md', '@@', '-old line', '-another old line', ' kept', '*** End Patch']);
  const edit = { id: 'edit1', role: 'tool', tool: 'Edit', toolId: 'edit1', state: 'done', at, endedAt: at, input: { file_path: `${session.cwd}/a.py`, old_string: 'x = 1', new_string: 'x = 1\ny = 2' }, output: 'ok' };
  await emitSession(page, { ...session, updatedAt: at, messages: [...session.messages, { id: 'u9', role: 'user', text: 'More edits', at, delivery: 'done' }, added, trimmed, edit, { id: 'a9', role: 'assistant', text: 'Done.', at }] });
  const group = page.locator('.activity', { has: page.locator('.activity-summary', { hasText: /^Edited 3 files$/ }) });
  await group.locator('.activity-head').click();
  const row = (target) => page.locator('.tool-row', { has: page.locator('.tool-target', { hasText: target }) });
  assert.equal(await textOf(row('greet.sh').locator('.tool-stats')), '+3');
  assert.equal(await textOf(row('notes.md').locator('.tool-stats')), '−2');
  assert.equal(await textOf(row('a.py').locator('.tool-stats')), '+1');
  await row('greet.sh').click();
  assert.equal(await textOf(page.locator('.patch-file .tool-stats').first()), '+3');
  await row('a.py').click();
  assert.equal(await textOf(page.locator('.tool', { has: row('a.py') }).locator('.tool-detail .tool-stats')), '+1');
  assert.deepEqual(server.errors, []);
  await context.close();
});
