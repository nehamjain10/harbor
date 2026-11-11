// Real-browser checks for tool cards in the transcript, against the mocked v2
// server (harness.mjs). Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitSession, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const find = (server, id) => server.sessions.find((s) => s.id === id);

// Replaces a fixture session's messages, then opens it from the sidebar.
async function openWithMessages(page, server, id, messages) {
  find(server, id).messages = messages;
  await page.locator('.session-main', { hasText: find(server, id).title }).click();
  await page.waitForFunction((sessionId) => location.search === `?session=${sessionId}`, id);
}

test('web tools: only http(s) URLs become links', async () => {
  const { page, context, server } = await openApp(browser);
  const at = Date.now() - 60_000;
  const links = [
    { title: 'Evil', url: 'javascript:window.__pwned=1' },
    { title: 'Data', url: 'data:text/html,<script>window.__pwned=2</script>' },
    { title: 'Docs', url: 'https://example.com/docs' },
  ];
  await openWithMessages(page, server, 's-old', [
    { id: 'u1', role: 'user', text: 'Look these up.', at, delivery: 'done' },
    { id: 't1', role: 'tool', tool: 'WebFetch', toolId: 'tu1', state: 'done', at: at + 1000, endedAt: at + 2000, input: { url: 'javascript:window.__pwned=3', prompt: 'Summarize' }, output: 'Nothing here.' },
    { id: 't2', role: 'tool', tool: 'WebSearch', toolId: 'tu2', state: 'done', at: at + 3000, endedAt: at + 4000, input: { query: 'harbor' }, output: `Web search results for query: "harbor"\n\nLinks: ${JSON.stringify(links)}` },
    { id: 't3', role: 'tool', tool: 'WebFetch', toolId: 'tu3', state: 'done', at: at + 5000, endedAt: at + 6000, input: { url: 'https://example.com/page', prompt: 'Summarize' }, output: 'A page.' },
  ]);
  await page.locator('.activity-head').click();
  for (const row of await page.locator('.tool-row').all()) await row.click();
  await page.waitForSelector('.link-list');

  const anchors = await page.locator('.tool-detail a').evaluateAll((list) => list.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
  assert.deepEqual(
    anchors.map((a) => a.href),
    ['https://example.com/docs', 'https://example.com/page'],
    'only the https URLs are anchors',
  );
  for (const anchor of anchors) {
    assert.equal(anchor.target, '_blank');
    assert.equal(anchor.rel, 'noopener noreferrer');
  }
  assert.equal(await page.locator('a[href^="javascript:" i], a[href^="data:" i]').count(), 0);
  // The unsafe URLs are still shown, as text.
  assert.match(await page.locator('.tool-link.is-plain').textContent(), /javascript:window\.__pwned=3/);
  assert.deepEqual(await page.locator('.link-plain .link-title').allTextContents(), ['Evil', 'Data']);

  for (const element of await page.locator('.tool-link.is-plain, .link-plain').all()) await element.click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test("Harbor's web search (gateway models) reads as a web search: its row, links and approval card", async () => {
  const { page, context, server } = await openApp(browser);
  const at = Date.now() - 60_000;
  const links = [{ title: 'Agent SDK', url: 'https://platform.claude.com/docs/en/agent-sdk' }];
  await openWithMessages(page, server, 's-old', [
    { id: 'u1', role: 'user', text: 'What changed in the SDK?', at, delivery: 'done' },
    { id: 't1', role: 'tool', tool: 'mcp__meshy__web_search', toolId: 'tu1', state: 'done', at: at + 1000, endedAt: at + 8000, input: { query: 'claude agent sdk release notes', allowed_domains: ['platform.claude.com'] }, output: `Web search results for query: "claude agent sdk release notes"\n\nLinks: ${JSON.stringify(links)}\n\nThe SDK has changelogs on GitHub.` },
    { id: 'a1', role: 'assistant', text: 'See the changelog.', at: at + 9000 },
  ]);
  const row = page.locator('.tool-row').first();
  if (!(await row.isVisible())) await page.locator('.activity-head').click();
  assert.match(await row.textContent(), /Searched the web\s*claude agent sdk release notes/);
  await row.click();
  await page.locator('.tool-detail .link-list').waitFor();
  assert.deepEqual(await page.locator('.tool-detail a').evaluateAll((list) => list.map((a) => a.getAttribute('href'))), ['https://platform.claude.com/docs/en/agent-sdk']);
  assert.match(await page.locator('.tool-detail .chip-row').textContent(), /claude agent sdk release notes.*only platform\.claude\.com/);

  const session = find(server, 's-old');
  const pending = [{ id: 'p1', kind: 'permission', tool: 'mcp__meshy__web_search', at: Date.now(), toolUseID: 'tu2', input: { query: 'qwen 27b vl' } }];
  await emitSession(page, { ...session, status: 'waiting', updatedAt: Date.now() + 1000, pending });
  const card = page.locator('.approval');
  await card.waitFor();
  assert.equal(await card.locator('.approval-title').textContent(), 'Search the web?');
  assert.match(await card.locator('.approval-url').textContent(), /qwen 27b vl/);
  assert.doesNotMatch(await card.textContent(), /MCP server harbor/);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('bash output: collapsed output has no inner scrollbar; expanded output scrolls', async () => {
  const { page, context, server } = await openApp(browser);
  const at = Date.now() - 60_000;
  const output = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
  const long = 'x'.repeat(20_000);
  await openWithMessages(page, server, 's-old', [
    { id: 'u1', role: 'user', text: 'Run it.', at, delivery: 'done' },
    { id: 't1', role: 'tool', tool: 'Bash', toolId: 'tu1', state: 'done', at: at + 1000, endedAt: at + 2000, input: { command: 'seq 120' }, output },
    { id: 't2', role: 'tool', tool: 'Bash', toolId: 'tu2', state: 'done', at: at + 3000, endedAt: at + 4000, input: { command: 'cat min.js' }, output: long },
  ]);
  await page.locator('.activity-head').click();
  for (const row of await page.locator('.tool-row').all()) await row.click();
  const [lines, chars] = await page.locator('.output-pre').all();
  await lines.waitFor();
  const metrics = (pre) => pre.evaluate((el) => ({ text: el.textContent, scroll: el.scrollHeight, client: el.clientHeight }));

  const collapsed = await metrics(lines);
  assert.equal(collapsed.text.split('\n').length, 30);
  assert.ok(collapsed.scroll <= collapsed.client + 1, `no inner scroll (${collapsed.scroll} > ${collapsed.client})`);
  const wrapped = await metrics(chars);
  assert.ok(wrapped.text.length <= 3000, 'long lines are cut by characters');
  assert.ok(wrapped.scroll <= wrapped.client + 1);
  assert.deepEqual(await page.locator('.output-block .show-all').allTextContents(), ['Show all 120 lines', 'Show all 20,000 characters']);

  await page.locator('.output-block .show-all').first().click();
  const expanded = await metrics(page.locator('.output-pre').first());
  assert.equal(expanded.text.split('\n').length, 120);
  assert.ok(expanded.scroll > expanded.client, 'expanded output scrolls inside its 70vh box');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('grep results: at most 20 lines per file, then "N more lines"', async () => {
  const { page, context, server } = await openApp(browser);
  const at = Date.now() - 60_000;
  const cwd = find(server, 's-old').cwd;
  const output = [
    ...Array.from({ length: 60 }, (_, i) => `${cwd}/docs/plans/2026-10-05-notes.md:${i + 1}:match ${i + 1}`),
    `${cwd}/src/a.js:3:match`,
    `${cwd}/src/a.js-4-context`,
  ].join('\n');
  await openWithMessages(page, server, 's-old', [
    { id: 'u1', role: 'user', text: 'Find it.', at, delivery: 'done' },
    { id: 't1', role: 'tool', tool: 'Grep', toolId: 'tu1', state: 'done', at: at + 1000, endedAt: at + 2000, input: { pattern: 'match', output_mode: 'content', '-n': true }, output },
  ]);
  await page.locator('.tool-row').click();
  await page.waitForSelector('.search-file');
  const files = page.locator('.search-file');
  assert.equal(await files.count(), 2);
  assert.match(await files.nth(0).locator('.search-path').textContent(), /2026-10-05-notes\.md/);
  assert.equal(await files.nth(0).locator('.search-line').count(), 20);
  assert.equal(await files.nth(0).locator('.search-more').textContent(), '40 more lines in this file');
  assert.equal(await files.nth(1).locator('.search-line').count(), 2);
  assert.equal(await files.nth(1).locator('.search-more').count(), 0);
  await files.nth(0).locator('.search-more').click();
  assert.equal(await files.nth(0).locator('.search-line').count(), 60);
  assert.equal(await files.nth(0).locator('.search-more').count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});
