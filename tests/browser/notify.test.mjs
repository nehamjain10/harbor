// Real-browser checks for desktop notifications beyond the basics in
// palette.test.mjs: sessions created elsewhere after load, stopped turns, and a
// visible but unfocused window. Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, emitSession, launch, notifications, openApp } from './harness.mjs';

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

const find = (server, id) => server.sessions.find((s) => s.id === id);
const options = { url: '/?session=s-idle', permission: 'granted', storage: { 'mesh-code-notify': 'on' } };

async function setFocused(page, focused) {
  await page.evaluate((value) => {
    document.hasFocus = () => value;
    window.dispatchEvent(new Event(value ? 'focus' : 'blur'));
  }, focused);
}

test('notifications: a visible but unfocused window is notified; the open session is still marked viewed', async () => {
  const { page, context, server } = await openApp(browser, options);
  await setFocused(page, false);
  const idle = find(server, 's-idle');
  idle.turnEndedAt = idle.updatedAt = Date.now();
  idle.messages.push({ id: 'a-new', role: 'assistant', text: 'Peak is now 64 GB.', at: Date.now() }, { id: 't-new', role: 'turn', duration: 1000 });
  await emitSession(page, idle);
  await waitFor(async () => (await notifications(page)).length === 1, { message: 'notification while unfocused' });
  assert.deepEqual(await notifications(page), [{ title: 'Review GPU memory profile', body: 'Peak is now 64 GB.', tag: 'harbor:s-idle' }]);
  await waitFor(() => server.requests.some((r) => r.body?.viewed), { message: 'viewed PATCH while visible' });

  // Focused again: looking at it, so quiet.
  await setFocused(page, true);
  idle.turnEndedAt = idle.updatedAt = Date.now() + 1;
  await emitSession(page, idle);
  await page.waitForTimeout(150);
  assert.equal((await notifications(page)).length, 1);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('notifications: a session created elsewhere after load announces its first finish and approval', async () => {
  const { page, context, server } = await openApp(browser, options);
  await page.evaluate(() => document.activeElement?.blur());
  const now = Date.now();
  const fresh = {
    ...find(server, 's-old'),
    id: 's-phone',
    title: 'Started on the phone',
    status: 'running',
    turnEndedAt: 0,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messages: [{ id: 'pu1', role: 'user', text: 'Check the logs', at: now, delivery: 'running' }],
  };
  server.sessions.push(fresh);
  await emitSession(page, fresh);
  await page.locator('.session-row', { hasText: 'Started on the phone' }).waitFor();
  await page.waitForTimeout(100);
  assert.deepEqual(await notifications(page), [], 'nothing while it runs');

  Object.assign(fresh, { status: 'waiting', updatedAt: now + 1, pending: [{ id: 'p-phone', kind: 'permission', tool: 'Bash', input: { command: 'ls' } }] });
  await emitSession(page, fresh);
  Object.assign(fresh, { status: 'idle', pending: [], turnEndedAt: now + 2, updatedAt: now + 2 });
  fresh.messages = [...fresh.messages, { id: 'pa1', role: 'assistant', text: 'Logs are clean.', at: now + 2 }, { id: 'pt1', role: 'turn', duration: 2 }];
  await emitSession(page, fresh);
  await waitFor(async () => (await notifications(page)).length === 2, { message: 'two notifications' });
  assert.deepEqual(await notifications(page), [
    { title: 'Started on the phone', body: 'Needs your approval: Bash', tag: 'harbor:s-phone' },
    { title: 'Started on the phone', body: 'Logs are clean.', tag: 'harbor:s-phone' },
  ]);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('notifications: a turn the user stopped is not announced', async () => {
  const { page, context, server } = await openApp(browser, options);
  const old = find(server, 's-old');
  const now = Date.now();
  old.messages.push(
    { id: 'u-stop', role: 'user', text: 'Run the whole suite', at: now, delivery: 'stopped' },
    { id: 'a-stop', role: 'assistant', text: 'Starting…', at: now + 1 },
    { id: 't-stop', role: 'turn', stopped: true, duration: 3 },
  );
  Object.assign(old, { status: 'idle', turnEndedAt: now + 5, updatedAt: now + 5 });
  await emitSession(page, old);
  await page.waitForTimeout(300);
  assert.deepEqual(await notifications(page), []);

  // The next, normal turn is announced.
  old.messages.push({ id: 'u-ok', role: 'user', text: 'Again', at: now + 10, delivery: 'done' }, { id: 'a-ok', role: 'assistant', text: 'All green.', at: now + 11 }, { id: 't-ok', role: 'turn', duration: 3 });
  Object.assign(old, { turnEndedAt: now + 20, updatedAt: now + 20 });
  await emitSession(page, old);
  await waitFor(async () => (await notifications(page)).length === 1, { message: 'normal finish' });
  assert.equal((await notifications(page))[0].body, 'All green.');
  assert.deepEqual(server.errors, []);
  await context.close();
});
