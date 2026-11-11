// claude.ai artifacts in the transcript: a published page is a card that opens it in a
// new tab; a publish in progress is an ordinary step. Run with `npm run test:browser`.
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

const URL_ = 'https://claude.ai/code/artifact/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

test('artifacts: a published page shows as a card with Open and Copy link', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();
  const old = server.sessions.find((s) => s.id === 's-old');
  const at = Date.now() - 60_000;
  old.messages = [
    { id: 'u-1', role: 'user', text: 'Chart the GPU memory', at, delivery: 'done' },
    { id: 't-run', toolId: 'toolu_run', role: 'tool', tool: 'Bash', state: 'done', input: { command: 'nvidia-smi' }, output: 'ok', at: at + 100 },
    {
      id: 't-art', toolId: 'toolu_art', role: 'tool', tool: 'Artifact', state: 'done', at: at + 200,
      input: { file_path: '/home/me/gpu-report.html', title: 'GPU memory report', description: 'Peak memory by step.', icon: 'chart' },
      output: `Published to ${URL_}`,
    },
    {
      id: 't-art2', toolId: 'toolu_art2', role: 'tool', tool: 'Artifact', state: 'running', at: at + 300,
      input: { file_path: '/home/me/notes.html', title: 'Run notes' },
    },
  ];
  old.updatedAt = Date.now();
  await page.locator('.session-main', { hasText: 'Benchmark the tokenizer' }).click();
  const card = page.locator('.artifact-card');
  await card.waitFor();
  assert.equal(await card.locator('.artifact-card-title').textContent(), 'GPU memory report');
  assert.match(await card.locator('.artifact-card-sub').textContent(), /Peak memory by step\./);
  const link = card.locator('a.artifact-card-main');
  assert.equal(await link.getAttribute('href'), URL_);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /noopener/);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => void (window.__copied = text) } }),
  );
  await card.locator('.artifact-card-copy').click();
  await page.waitForFunction(() => window.__copied);
  assert.equal(await page.evaluate(() => window.__copied), URL_);
  // The publish still running is a step, not a card.
  assert.equal(await page.locator('.artifact-card').count(), 1);
  await page.locator('.activity', { hasText: 'Publishing' }).waitFor();
  assert.deepEqual(server.errors, []);
  await context.close();
});
