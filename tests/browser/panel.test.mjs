// Real-browser checks for the side panel (Changes / Plan), against the mocked v2
// server (harness.mjs). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, buildApp, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

// Answers the Changes request with `body` (routes added later take precedence).
async function mockChanges(context, body) {
  await context.route(`${ORIGIN}/api/sessions/*/changes*`, (route) => route.fulfill({ json: body }));
}

async function openChanges(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+j');
  await page.waitForFunction(() => {
    const title = document.querySelector('.panel-message b')?.textContent;
    return title && !/^Loading/.test(title);
  });
  return page.locator('.panel-message');
}

test('changes: "No Git repository" only when the server says so', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await mockChanges(context, { diff: '', status: '', branch: '', files: [], error: 'This folder is not a Git repository.' });
  const message = await openChanges(page);
  assert.equal(await message.locator('b').textContent(), 'No Git repository');
  assert.match(await message.textContent(), /not a Git repository/);
  assert.equal(await message.locator('button', { hasText: 'Try again' }).count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('changes: other failures say "Changes unavailable" with the server message and a retry', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  let calls = 0;
  await context.route(`${ORIGIN}/api/sessions/*/changes*`, (route) => {
    calls += 1;
    route.fulfill({ json: { diff: '', status: '', branch: '', files: [], error: 'Git changes are unavailable: detected dubious ownership' } });
  });
  const message = await openChanges(page);
  assert.equal(await message.locator('b').textContent(), 'Changes unavailable');
  assert.match(await message.textContent(), /detected dubious ownership/);
  const before = calls;
  await message.locator('button', { hasText: 'Try again' }).click();
  const start = Date.now();
  while (calls === before && Date.now() - start < 3000) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(calls > before, 'retry refetches');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('changes: a cut-short scan shows the tracked changes with a note; a refresh asks for a fresh run', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const urls = [];
  const notice = 'Untracked files are not listed: Git takes too long to scan this folder.';
  await context.route(`${ORIGIN}/api/sessions/*/changes*`, (route) => {
    urls.push(new URL(route.request().url()).search);
    route.fulfill({ json: { diff: '', status: '', branch: 'main', files: [], notice } });
  });
  const message = await openChanges(page);
  assert.equal(await message.locator('b').textContent(), 'No changes');
  assert.equal(await page.locator('.changes-notice').textContent(), notice);
  assert.deepEqual(urls, [''], 'opening the panel may reuse a recent result');
  await page.locator('[aria-label="Refresh changes"]').click();
  const start = Date.now();
  while (urls.length < 2 && Date.now() - start < 3000) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(urls, ['', '?fresh=1']);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('changes: wrapped diff lines continue under the code, not under the sign', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const long = 'word '.repeat(60).trim();
  const diff = `diff --git a/notes.txt b/notes.txt\nindex 1..2 100644\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,2 @@\n context\n+${long}\n`;
  await mockChanges(context, { diff, status: ' M notes.txt', branch: 'main', files: [{ path: 'notes.txt', status: 'modified', adds: 1, dels: 0 }] });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+j');
  await page.waitForSelector('.diff-table .d-add .lc');
  const layout = await page.evaluate(() => {
    const cell = document.querySelector('.diff-table .d-add .lc');
    const sign = cell.querySelector('.sign');
    const text = [...cell.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const range = document.createRange();
    range.selectNodeContents(text);
    // Leftmost fragment of each line box (trailing spaces add fragments at the right).
    const starts = new Map();
    for (const rect of range.getClientRects()) {
      const top = Math.round(rect.top);
      starts.set(top, Math.min(starts.get(top) ?? Infinity, Math.round(rect.left)));
    }
    const lines = [...starts.values()];
    return { lines, sign: Math.round(sign.getBoundingClientRect().left) };
  });
  assert.ok(layout.lines.length >= 2, `the long line wraps (${layout.lines.length} line boxes)`);
  assert.ok(layout.lines.every((left) => Math.abs(left - layout.lines[0]) <= 1), `continuations align: ${layout.lines}`);
  assert.ok(layout.sign < layout.lines[0] - 8, 'the sign sits left of the code');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('changes: zero counts are left out (a new file shows "+3", a removal "−2")', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const diff = [
    'diff --git a/greet.sh b/greet.sh',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/greet.sh',
    '@@ -0,0 +1,3 @@',
    '+#!/bin/sh',
    '+# Print a greeting',
    '+echo hello',
    'diff --git a/notes.md b/notes.md',
    'index 2222222..3333333 100644',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1,3 +1,1 @@',
    ' # Notes',
    '-old line',
    '-another old line',
    '',
  ].join('\n');
  await mockChanges(context, {
    diff,
    status: 'A  greet.sh\n M notes.md',
    branch: 'main',
    files: [
      { path: 'greet.sh', status: 'added', adds: 3, dels: 0 },
      { path: 'notes.md', status: 'modified', adds: 0, dels: 2 },
    ],
  });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+j');
  await page.waitForSelector('.diff-file-head');
  const text = async (locator) => (await locator.textContent()).replace(/\s+/g, ' ').trim();
  assert.equal(await text(page.locator('.changes-stats')), '2 files · +3 −2');
  const counts = page.locator('.changes-item .diff-count');
  assert.deepEqual(await counts.allTextContents(), ['+3', '−2']);
  const heads = page.locator('.diff-file-head .diff-count');
  assert.deepEqual(await heads.allTextContents(), ['+3', '−2']);
  assert.deepEqual(server.errors, []);
  await context.close();
});
