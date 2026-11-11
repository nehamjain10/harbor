// Approval cards must never be answered by keystrokes meant for the composer, or by a
// quick double press on a card the user has not seen yet. Run with `npm run test:browser`.
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const approvalPosts = (server) => server.requests.filter((r) => r.path.startsWith('approvals/'));
const bash = (id, command, extra = {}) => ({ id, kind: 'permission', tool: 'Bash', at: Date.now(), toolUseID: id, input: { command }, ...extra });
const always = [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }] }];

async function showPending(page, server, pending) {
  const session = server.sessions.find((s) => s.id === 's-run');
  await emitSession(page, { ...session, status: 'waiting', updatedAt: Date.now() + 1000, pending });
  await page.waitForSelector('.approval');
}

test('typing in the composer when a card arrives stays in the composer', async () => {
  const { page, server } = await openApp(browser, { url: '/?session=s-run' });
  await page.waitForSelector('.composer-input');
  await page.click('.composer-input');
  await showPending(page, server, [bash('p1', 'rm -rf build', { suggestions: always })]);
  await sleep(500);
  await page.keyboard.type('2 more things');
  await sleep(200);
  assert.deepEqual(approvalPosts(server), [], '"2" must not grant always-allow');
  assert.equal(await page.inputValue('.composer-input'), '2 more things');
  await page.close();
});

test('a cautious card does not pull focus out of a non-empty composer', async () => {
  const { page, server } = await openApp(browser, { url: '/?session=s-run' });
  await page.waitForSelector('.composer-input');
  await page.click('.composer-input');
  await page.keyboard.type('fix the tests');
  await showPending(page, server, [bash('p2', 'cat ~/.ssh/id_rsa', { defaultToNo: true, decisionReason: 'sensitive file' })]);
  await page.keyboard.type(' and then lint');
  assert.deepEqual(approvalPosts(server), []);
  assert.equal(await page.inputValue('.composer-input'), 'fix the tests and then lint');
  await page.close();
});

test('a double press right after a card appears answers nothing unseen', async () => {
  const { page, server } = await openApp(browser, { url: '/?session=s-run' });
  await page.context().route('**/api/approvals/**', (route) => {
    server.requests.push({ method: 'POST', path: new URL(route.request().url()).pathname.replace('/api/', ''), body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.waitForSelector('.composer-input');
  await showPending(page, server, [bash('pa', 'ls'), bash('pb', 'git push --force')]);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await sleep(150);
  await page.keyboard.press('1');
  await sleep(200);
  assert.deepEqual(approvalPosts(server), [], 'keys are ignored while the card is new');
  await sleep(300);
  await page.keyboard.press('1');
  await sleep(200);
  assert.deepEqual(approvalPosts(server).map((r) => r.path), ['approvals/pa'], 'once armed, 1 answers only the visible card');
  await page.close();
});
