// Composer paste handling and the /help dialog. Run with `npm run test:browser`.
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

// Dispatches a paste of `text` and/or a tiny PNG; returns whether the app took over the paste.
function paste(page, { text, image, target = '.composer-input' }) {
  return page.evaluate(
    ({ text, image, target }) => {
      const data = new DataTransfer();
      if (text) data.setData('text/plain', text);
      if (image) data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'image.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      (target === 'body' ? document.body : document.querySelector(target)).dispatchEvent(event);
      return event.defaultPrevented;
    },
    { text, image, target },
  );
}

const uploads = (server) => server.requests.filter((r) => r.path.startsWith('uploads'));

test('pasting cells from a spreadsheet pastes the text, not a picture of it', async () => {
  const { page, server } = await openApp(browser, { url: '/?session=s-run' });
  await page.waitForSelector('.composer-input');
  assert.equal(await paste(page, { text: 'a\tb\n1\t2', image: true }), false, 'the browser pastes the text');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.attach-chip').count(), 0);
  assert.deepEqual(uploads(server), []);
  await page.close();
});

test('a paste with no text field focused (dictation apps paste with ⌘V) goes into the message box at its caret', async () => {
  const { page } = await openApp(browser, { url: '/?session=s-run' });
  const box = page.locator('.composer-input');
  await box.click();
  await page.keyboard.type('hello world');
  await box.evaluate((el) => el.setSelectionRange(6, 6));
  await box.evaluate((el) => el.blur());
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  assert.equal(await paste(page, { text: 'dictated ', target: 'body' }), true);
  assert.equal(await box.inputValue(), 'hello dictated world');
  assert.equal(await box.evaluate((el) => document.activeElement === el && el.selectionStart), 15, 'focused, caret after the text');
  // A paste into another field stays there.
  const search = page.locator('.sidebar input').first();
  if (await search.count()) {
    await search.focus();
    assert.equal(await paste(page, { text: 'query', target: '.sidebar input' }), false);
    assert.equal(await box.inputValue(), 'hello dictated world');
  }
  await page.close();
});

test('pasting a screenshot attaches it', async () => {
  const { page } = await openApp(browser, { url: '/?session=s-run' });
  await page.waitForSelector('.composer-input');
  assert.equal(await paste(page, { image: true }), true);
  await page.waitForSelector('.attach-chip');
  assert.equal(await page.locator('.attach-chip').count(), 1);
  await page.close();
});

test('/help lists the same shortcuts as the shortcuts dialog', async () => {
  const { page } = await openApp(browser, { url: '/?session=s-run' });
  await page.context().route('**/api/commands**', (route) => route.fulfill({ json: { commands: [] } }));
  await page.click('.composer-input');
  await page.keyboard.type('/help');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  const dialog = page.locator('.help-dialog');
  await dialog.waitFor();
  const rows = await dialog.locator('.help-key-row').allInnerTexts();
  const palette = rows.find((row) => row.includes('Command palette'));
  assert.ok(palette && /K/.test(palette), 'mod+K opens the command palette');
  assert.ok(rows.some((row) => row.includes('New session') && /O/.test(row)), 'New session is mod+shift+O');
  assert.ok(!rows.some((row) => /new chat/i.test(row)), 'no stale "New chat" binding');
  await page.close();
});

test('messages waiting for a long step show the step and its time, and can interrupt it to be read now', async () => {
  const { page, server } = await openApp(browser, { url: '/?session=s-run' });
  const interrupts = [];
  await page.context().route('**/api/sessions/s-run/interrupt', (route) => {
    interrupts.push(route.request().method());
    return route.fulfill({ json: { ok: true } });
  });
  await page.locator('.composer-input').waitFor();
  const session = structuredClone(server.sessions.find((s) => s.id === 's-run'));
  const now = Date.now();
  // A step that just started: Claude reads the message when it ends; nothing to cut short yet.
  session.messages.push({ id: 't-wait', role: 'tool', tool: 'Bash', toolId: 'toolu_wait', input: { command: 'until test -f done; do sleep 30; done' }, state: 'running', at: now - 2000 });
  session.messages.push({ id: 'm-steer', role: 'user', text: 'stop waiting, check the logs', at: now, delivery: 'sent' });
  session.steering = [{ id: 'm-steer', text: 'stop waiting, check the logs' }];
  await emitSession(page, session);
  const steering = page.locator('.queue-section.is-steering');
  await steering.waitFor();
  assert.match(await steering.locator('.queue-head').innerText(), /1 sent to Claude\s*Read when this step finishes/);
  assert.equal(await steering.locator('.queue-step-label').innerText(), 'Running until test -f done; do sleep 30; done');
  const first = await steering.locator('.queue-step-time').innerText();
  assert.match(first, /^\d+s$/);
  await page.waitForFunction((before) => document.querySelector('.queue-step-time').textContent !== before, first);
  assert.equal(await steering.getByRole('button', { name: 'Interrupt and send now' }).count(), 0);

  // The same step a minute in: it can be interrupted so the message is read now.
  session.messages.find((m) => m.id === 't-wait').at = now - 65_000;
  await emitSession(page, session);
  await page.waitForFunction(() => /^1m \d+s$/.test(document.querySelector('.queue-step-time')?.textContent || ''));
  await steering.getByRole('button', { name: 'Interrupt and send now' }).click();
  await waitUntil(() => interrupts.length === 1);
  assert.deepEqual(interrupts, ['POST']);
  await page.waitForFunction(() => /Interrupting…/.test(document.querySelector('.queue-section.is-steering .queue-note')?.textContent || ''));
  assert.equal(await steering.getByRole('button', { name: 'Interrupt and send now' }).count(), 0, 'pressed once');

  // Claude reads it: the bar goes, the message shows in the transcript.
  session.messages.find((m) => m.id === 't-wait').state = 'error';
  session.messages.find((m) => m.id === 'm-steer').delivery = 'running';
  session.steering = [];
  await emitSession(page, session);
  await page.locator('.user-bubble', { hasText: 'stop waiting, check the logs' }).waitFor();
  assert.equal(await page.locator('.queue-section.is-steering').count(), 0);
  assert.deepEqual(server.errors, []);
  await page.close();
});

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('while a turn runs, Enter sends into it, Alt+Enter or the queue button keeps it for after', async () => {
  const { page, server } = await openApp(browser, { url: '/?session=s-run' });
  const posts = [];
  await page.context().route('**/api/sessions/s-run/messages', async (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    await route.fulfill({ json: body.queue ? { ok: true, queued: true } : { ok: true, queued: false, steering: true } });
  });
  const cancels = [];
  await page.context().route('**/api/sessions/s-run/queue/*/cancel', (route) => {
    cancels.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ok: true } });
  });
  const input = page.locator('.composer-input');
  await input.waitFor();
  assert.equal(await input.getAttribute('placeholder'), 'Message Claude while it works…');
  assert.equal(await page.locator('.send-btn.is-steer').getAttribute('aria-label'), 'Send now');
  assert.equal(await page.locator('.queue-btn').getAttribute('title'), 'Queue for after this turn (Alt+Enter)');

  await input.click();
  await page.keyboard.type('also check the tests');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.composer-input').value === '');
  await page.keyboard.type('then deploy');
  await page.keyboard.press('Alt+Enter');
  await page.waitForFunction(() => document.querySelector('.composer-input').value === '');
  await page.keyboard.type('and tidy up');
  await page.locator('.queue-btn').click();
  await page.waitForFunction(() => document.querySelector('.composer-input').value === '');
  assert.deepEqual(
    posts.map(({ text, queue }) => ({ text, queue })),
    [
      { text: 'also check the tests', queue: undefined },
      { text: 'then deploy', queue: true },
      { text: 'and tidy up', queue: true },
    ],
  );

  // The server lists the message Claude has not read yet above the composer, not in the transcript.
  const session = structuredClone(server.sessions.find((s) => s.id === 's-run'));
  session.messages.push({ id: 'm-steer', role: 'user', text: 'also check the tests', at: Date.now(), delivery: 'sent' });
  session.messages.push({ id: 'm-later', role: 'user', text: 'then deploy', at: Date.now(), delivery: 'queued' });
  session.steering = [{ id: 'm-steer', text: 'also check the tests' }];
  session.queue = [{ id: 'm-later', text: 'then deploy' }];
  await emitSession(page, session);
  const steering = page.locator('.queue-section.is-steering');
  await steering.waitFor();
  assert.match(await steering.locator('.queue-head').innerText(), /1 sent to Claude\s*Read at its next step/);
  assert.match(await page.locator('.queue-section:not(.is-steering) .queue-title').innerText(), /1 queued/);
  assert.equal(await page.locator('.user-bubble', { hasText: 'also check the tests' }).count(), 0);
  await steering.getByRole('button', { name: 'Take back message' }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !cancels.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(cancels, ['/api/sessions/s-run/queue/m-steer/cancel']);

  // Once Claude reads it, it shows in the transcript where it was read.
  session.messages.find((m) => m.id === 'm-steer').delivery = 'running';
  session.steering = [];
  await emitSession(page, session);
  await page.locator('.user-bubble', { hasText: 'also check the tests' }).waitFor();
  assert.equal(await page.locator('.queue-section.is-steering').count(), 0);

  // Files can only start a turn: with an attachment the send button queues.
  await paste(page, { image: true });
  await page.waitForSelector('.attach-chip');
  assert.equal(await page.locator('.send-btn.is-queue').getAttribute('aria-label'), 'Queue message');
  assert.equal(await page.locator('.queue-btn').count(), 0);
  // (The pasted file's upload is not mocked here.)
  assert.deepEqual(server.errors.filter((error) => !/404/.test(error)), []);
  await page.close();
});
