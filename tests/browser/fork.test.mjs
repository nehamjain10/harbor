// Fork: a new session with a copy of the conversation. The Session options entry, the
// palette, "Fork from here" under the user's messages, /fork, and the notice that links
// back, against the mocked v2 server (harness.mjs; the fork route is mocked here).
// Run with `npm run test:browser`.
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

async function waitFor(check, { timeout = 3000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const find = (server, id) => server.sessions.find((s) => s.id === id);
const text = async (locator) => (await locator.textContent()).replace(/\s+/g, ' ').trim();
const forks = (server) => server.requests.filter((r) => r.path.endsWith('/fork')).map((r) => [r.path, r.body]);
const openId = (page) => page.evaluate(() => new URLSearchParams(location.search).get('session'));
const forkButtons = (page) => page.locator('.msg-action', { hasText: 'Fork from here' });
const toastText = (page) => text(page.locator('.toast'));

// POST /api/sessions/:id/fork as the server answers it: a copy of the conversation (up
// to the message, or all of it) as a new session ending in the notice, plus the message
// as `draft` for a fork from it. `server.forkError` and `server.forkDelay` change the answer.
function mockFork(server) {
  server.forkError = null;
  server.forkDelay = 0;
  let count = 0;
  server.routes.push(async ({ route, method, body }) => {
    const match = method === 'POST' && route.match(/^sessions\/([^/]+)\/fork$/);
    if (!match) return null;
    if (server.forkDelay) await new Promise((resolve) => setTimeout(resolve, server.forkDelay));
    if (server.forkError) return { status: server.forkError.status, json: { error: server.forkError.error } };
    const original = find(server, decodeURIComponent(match[1]));
    const index = body.messageId ? original.messages.findIndex((m) => m.id === body.messageId) : original.messages.length;
    const now = Date.now();
    count += 1;
    const notice = { id: 'n-fork' + count, role: 'notice', level: 'info', forkOf: original.id, at: now, text: `Forked from “${original.title}”${body.messageId ? ' before your message' : ''}.` };
    const session = {
      ...original,
      id: 's-fork-' + count,
      title: `${original.title} (fork)`,
      status: 'idle',
      pending: [],
      queue: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      forkedFrom: { id: original.id, title: original.title, ...(body.messageId ? { messageId: body.messageId } : {}) },
      messages: [...original.messages.slice(0, index), notice],
    };
    server.sessions.push(session);
    const message = body.messageId && original.messages[index];
    return { json: { session, ...(message ? { draft: { text: message.text, attachments: message.attachments || [] } } : {}) } };
  });
}

// GET /api/commands (the slash menu), which the harness does not answer.
const mockCommands = (server) => server.routes.push(({ route, method }) => (route.startsWith('commands') && method === 'GET' ? { json: { commands: [] } } : null));

async function openOptions(page) {
  await page.locator('[aria-label="Session options"]').click();
  await page.locator('.options-list').waitFor();
}

async function openPalette(page) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette[open] .palette-input');
}

test('fork: Session options and the palette offer it; it is disabled while the turn runs and gone in the Trash', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await page.locator('.crumb-title', { hasText: 'Review GPU memory profile' }).waitFor();
  const forkRow = page.locator('.option-row', { hasText: 'Fork' });

  await openOptions(page);
  assert.deepEqual(await forkRow.locator('.option-label, .option-note').allTextContents(), ['Fork', 'Copy this conversation into a new session']);
  assert.equal(await forkRow.isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('.options-list').waitFor({ state: 'detached' });

  await openPalette(page);
  await page.keyboard.type('clone');
  assert.match(await text(page.locator('.palette-row.is-active')), /^Fork session/, 'found by its keywords');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });

  // In the Trash there is nothing to fork.
  await emitSession(page, { ...find(server, 's-idle'), removed: true, updatedAt: Date.now() + 10 });
  await openOptions(page);
  await page.locator('.option-row', { hasText: 'Restore from Trash' }).waitFor();
  assert.equal(await forkRow.count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('.options-list').waitFor({ state: 'detached' });
  await openPalette(page);
  assert.ok(!(await page.locator('.palette-label').allTextContents()).includes('Fork session'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });

  // A running turn: shown, disabled, and the note says why.
  await page.locator('.session-row', { hasText: 'Split server.mjs' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-run');
  await openOptions(page);
  assert.deepEqual(await forkRow.locator('.option-label, .option-note').allTextContents(), ['Fork', 'Wait for the turn to end']);
  assert.equal(await forkRow.isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('.options-list').waitFor({ state: 'detached' });
  await openPalette(page);
  await page.keyboard.type('fork');
  const row = page.locator('.palette-row', { hasText: 'Fork session' });
  assert.match(await text(row), /Wait for the turn to end/);
  assert.match(await row.getAttribute('class'), /is-disabled/);
  assert.deepEqual(forks(server), []);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('fork: the whole session from Session options opens the copy, and its notice links back', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  mockFork(server);
  await page.locator('.crumb-title', { hasText: 'Review GPU memory profile' }).waitFor();
  await openOptions(page);
  await page.locator('.option-row', { hasText: 'Fork' }).click();
  await page.waitForFunction(() => location.search === '?session=s-fork-1');
  assert.deepEqual(forks(server), [['sessions/s-idle/fork', {}]]);
  assert.equal(await text(page.locator('.crumb-title')), 'Review GPU memory profile (fork)');
  assert.equal(await toastText(page), 'Forked into a new session.');
  assert.equal(await page.locator('.composer-input').inputValue(), '', 'no draft for a fork of the whole session');
  await page.locator('.session-row.is-active', { hasText: 'Review GPU memory profile (fork)' }).waitFor();
  assert.equal(find(server, 's-idle').messages.length, 3, 'the original is untouched');

  // The conversation is there, ending in the notice, whose title opens the original.
  await page.locator('.msg-assistant', { hasText: 'Peak is 71 GB' }).waitFor();
  const notice = page.locator('.notice');
  assert.equal(await text(notice), 'Forked from “Review GPU memory profile”.');
  await notice.locator('.notice-link', { hasText: 'Review GPU memory profile' }).click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  await page.locator('.crumb-title', { hasText: /^Review GPU memory profile$/ }).waitFor();
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('fork: the notice is only text once the original is gone', async () => {
  const { page, context, server } = await openApp(browser);
  const now = Date.now();
  server.sessions.push({
    ...find(server, 's-idle'),
    id: 's-copy',
    title: 'Deleted notes (fork)',
    messages: [{ id: 'n1', role: 'notice', level: 'info', forkOf: 's-deleted', at: now, text: 'Forked from “Deleted notes”.' }],
    forkedFrom: { id: 's-deleted', title: 'Deleted notes' },
    updatedAt: now,
    lastMessageAt: now,
  });
  await page.goto(new URL('/?session=s-copy', page.url()).href);
  await page.locator('.notice').waitFor();
  assert.equal(await text(page.locator('.notice')), 'Forked from “Deleted notes”.');
  assert.equal(await page.locator('.notice-link').count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('fork from here: the copy keeps what came before the message and its text and files wait in the composer', async () => {
  const { page, context, server } = await openApp(browser);
  mockFork(server);
  const session = find(server, 's-idle');
  const notes = { id: 'att1', name: 'notes.txt', size: 120, type: 'text/plain', image: false, url: '/api/uploads/att1' };
  const at = Date.now() - 3_600_000;
  session.messages.push(
    { id: 'u-second', role: 'user', text: 'Now compare it with the notes.\nKeep it short.', attachments: [notes], delivery: 'done', at },
    { id: 'a-second', role: 'assistant', text: 'Compared.', model: 'opus', at: at + 5000 },
    { id: 'u-queued', role: 'user', text: 'Then deploy.', delivery: 'queued', at: at + 9000 },
  );
  await page.locator('.session-row', { hasText: 'Review GPU memory profile' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  await page.locator('.msg-assistant', { hasText: 'Compared.' }).waitFor();

  // On each message the transcript shows (a queued one waits above the composer instead).
  const bubbles = page.locator('.msg-user');
  assert.equal(await bubbles.count(), 2);
  assert.equal(await forkButtons(page).count(), 2);
  const button = bubbles.nth(1).locator('.msg-action', { hasText: 'Fork from here' });
  assert.match(await button.getAttribute('title'), /everything before this message; this message goes into the composer to edit/);

  // It shows when the message is hovered (or focused), like Copy under a reply.
  const actions = bubbles.nth(1).locator('.msg-actions');
  const opacity = () => actions.evaluate((el) => getComputedStyle(el).opacity);
  assert.equal(await opacity(), '0');
  await bubbles.nth(1).hover();
  await waitFor(async () => (await opacity()) === '1', { message: 'the action to show on hover' });
  await page.mouse.move(0, 0);
  await waitFor(async () => (await opacity()) === '0', { message: 'the action to hide' });
  await button.focus();
  await waitFor(async () => (await opacity()) === '1', { message: 'the action to show on focus' });

  await button.click();
  await page.waitForFunction(() => location.search === '?session=s-fork-1');
  assert.deepEqual(forks(server), [['sessions/s-idle/fork', { messageId: 'u-second' }]]);
  assert.equal(await toastText(page), 'Forked. Edit your message and send it.');
  assert.equal(await page.locator('.composer-input').inputValue(), 'Now compare it with the notes.\nKeep it short.');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('composer-input')), true, 'the composer has focus');
  const chip = page.locator('.attach-tray .attach-chip');
  assert.equal(await text(chip.locator('.attach-name')), 'notes.txt');
  assert.match(await chip.getAttribute('class'), /is-done/, 'ready to send from the new session');

  // Before the message: its first turn, then the notice.
  await page.locator('.notice').waitFor();
  assert.equal(await text(page.locator('.notice')), 'Forked from “Review GPU memory profile” before your message.');
  assert.deepEqual(await page.locator('.msg-user .user-bubble').allTextContents(), ['Profile memory of the trainer.']);
  assert.equal(await page.locator('.msg-assistant', { hasText: 'Compared.' }).count(), 0);

  // The draft is stored with the session, so a reload keeps it.
  await page.reload();
  await page.locator('.notice').waitFor();
  await waitFor(async () => (await page.locator('.composer-input').inputValue()) === 'Now compare it with the notes.\nKeep it short.', { message: 'the draft after a reload' });
  assert.equal(await text(page.locator('.attach-tray .attach-name')), 'notes.txt');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('fork from here: not on history imported from Codex or in the Trash', async () => {
  const { page, context, server } = await openApp(browser, { imports: true });
  await page.locator('.session-row', { hasText: 'Switch the trainer' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-imp-codex');
  await page.locator('.msg-user .user-bubble', { hasText: 'Switch the trainer to mixed precision' }).waitFor();
  assert.equal(await forkButtons(page).count(), 0);

  // Claude Code's own history can be forked from, until the session goes to the Trash.
  await page.locator('.session-row', { hasText: 'Fix the deploy timeout' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-imp-claude');
  await page.locator('.msg-user .user-bubble', { hasText: 'still hangs at the first all-reduce' }).waitFor();
  assert.equal(await forkButtons(page).count(), 1);
  await emitSession(page, { ...find(server, 's-imp-claude'), removed: true, updatedAt: Date.now() + 10 });
  await waitFor(async () => (await forkButtons(page).count()) === 0, { message: 'the action to go in the Trash' });
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('fork from here: allowed while a turn runs; a refusal is a toast, and a double click forks once', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-run' });
  mockFork(server);
  await page.locator('.msg-user', { hasText: 'Split server.mjs into modules' }).waitFor();
  assert.equal(await page.locator('.send-btn.is-steer').count(), 1, 'the turn is running');

  server.forkError = { status: 409, error: 'That message is not in Claude Code’s transcript yet.' };
  await forkButtons(page).click();
  await page.locator('.toast', { hasText: 'That message is not in Claude Code’s transcript yet.' }).waitFor();
  assert.equal(await openId(page), 's-run', 'nothing opened');
  assert.equal(await page.locator('.session-row', { hasText: '(fork)' }).count(), 0);

  server.forkError = null;
  server.forkDelay = 300;
  await forkButtons(page).dblclick();
  await page.waitForFunction(() => location.search === '?session=s-fork-1');
  await page.waitForTimeout(400);
  assert.deepEqual(forks(server).map(([, body]) => body), [{ messageId: 'u1' }, { messageId: 'u1' }], 'the refused try, then one fork');
  assert.equal(server.sessions.filter((s) => s.forkedFrom).length, 1);
  assert.equal(await page.locator('.composer-input').inputValue(), 'Split server.mjs into modules under server/.');
  // The refusal is the only error the browser logged.
  assert.deepEqual(server.errors, ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
  await context.close();
});

test('/fork: forks the open session, and says why when it cannot', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  mockFork(server);
  mockCommands(server);
  const input = page.locator('.composer-input');
  await page.locator('.crumb-title', { hasText: 'Review GPU memory profile' }).waitFor();
  await input.click();
  await page.keyboard.type('/fork');
  await page.locator('.suggest-row', { hasText: 'Copy this chat into a new one' }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.search === '?session=s-fork-1');
  assert.deepEqual(forks(server), [['sessions/s-idle/fork', {}]]);
  assert.equal(await input.inputValue(), '');

  // A running turn: no request, a toast.
  await page.locator('.session-row', { hasText: 'Split server.mjs' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-run');
  await input.click();
  await page.keyboard.type('/fork');
  await page.locator('.suggest-row', { hasText: 'Copy this chat into a new one' }).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.toast', { hasText: 'Wait for the turn to end, then fork.' }).waitFor();
  assert.equal(forks(server).length, 1);

  // No session yet.
  await page.locator('.new-session').click();
  await page.waitForFunction(() => location.search === '');
  await input.click();
  await page.keyboard.type('/fork');
  await page.locator('.suggest-row', { hasText: 'Copy this chat into a new one' }).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.toast', { hasText: 'there is nothing to fork yet' }).waitFor();
  assert.equal(forks(server).length, 1);
  assert.deepEqual(server.errors, []);
  await context.close();
});

// POST /api/sessions/:id/rewind as the server answers it: a preview of the files (dryRun),
// else the message back as `draft` (the session itself changes through its events).
function mockRewind(server, files = { canRewind: true, filesChanged: ['/w/a.py'], insertions: 3, deletions: 1 }) {
  server.routes.push(async ({ route, method, body }) => {
    const match = method === 'POST' && route.match(/^sessions\/([^/]+)\/rewind$/);
    if (!match) return null;
    if (body.dryRun) return { json: { files } };
    const message = find(server, decodeURIComponent(match[1])).messages.find((m) => m.id === body.messageId);
    return { json: { ...(body.code ? { files } : {}), draft: { text: message.text, attachments: message.attachments ?? [] } } };
  });
}

const rewinds = (server) => server.requests.filter((r) => r.path.endsWith('/rewind')).map((r) => r.body);

test('rewind: back to before a message in place, with the code or without; the message waits in the composer', async () => {
  const { page, context, server } = await openApp(browser);
  mockRewind(server);
  const session = find(server, 's-idle');
  const notes = { id: 'att1', name: 'notes.txt', size: 120, type: 'text/plain', image: false, url: '/api/uploads/att1' };
  const at = Date.now() - 3_600_000;
  session.messages.push(
    { id: 'u-second', role: 'user', text: 'Now compare it with the notes.', attachments: [notes], delivery: 'done', at },
    { id: 'a-second', role: 'assistant', text: 'Compared.', model: 'opus', at: at + 5000 },
  );
  await page.locator('.session-row', { hasText: 'Review GPU memory profile' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  await page.locator('.msg-assistant', { hasText: 'Compared.' }).waitFor();

  await page.locator('.msg-user').nth(1).hover();
  await page.locator('.msg-user').nth(1).getByRole('button', { name: 'Rewind to here' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByText('Puts back 1 file').waitFor();
  assert.equal(await text(dialog.locator('.dialog-subtitle')), '“Now compare it with the notes.”');
  assert.equal(await text(dialog.locator('.rewind-stats')), '+3 −1');
  await dialog.getByRole('button', { name: /Conversation and code/ }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(rewinds(server), [
    { messageId: 'u-second', dryRun: true },
    { messageId: 'u-second', code: true },
  ]);
  assert.equal(await toastText(page), 'Rewound, code restored. Edit your message and send it.');
  assert.equal(await openId(page), 's-idle', 'the same session');
  await waitFor(async () => (await page.locator('.composer-input').inputValue()) === 'Now compare it with the notes.', { message: 'the message in the composer' });
  assert.equal(await text(page.locator('.attach-tray .attach-name')), 'notes.txt');

  // The server cuts the conversation; the transcript follows its events.
  const cut = { ...session, messages: [...session.messages.slice(0, -2), { id: 'n-rw', role: 'notice', level: 'info', text: 'Rewound to before your message and restored 1 file.', at: Date.now() }], updatedAt: Date.now() + 10 };
  await emitSession(page, cut);
  await page.locator('.notice', { hasText: 'Rewound to before your message' }).waitFor();
  assert.equal(await page.locator('.msg-assistant', { hasText: 'Compared.' }).count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('rewind: code that cannot be restored leaves only the conversation; not while a turn runs', async () => {
  const { page, context, server } = await openApp(browser);
  mockRewind(server, { canRewind: false, error: 'No file checkpoint found for this message' });
  await page.locator('.session-row', { hasText: 'Review GPU memory profile' }).locator('.session-main').click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  const bubble = page.locator('.msg-user').first();
  await bubble.waitFor();
  await bubble.hover();
  await bubble.getByRole('button', { name: 'Rewind to here' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByText("Can't restore: No file checkpoint found for this message").waitFor();
  assert.equal(await dialog.getByRole('button', { name: /Conversation and code/ }).isDisabled(), true);
  await dialog.getByRole('button', { name: /Conversation only/ }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(rewinds(server).at(-1), { messageId: find(server, 's-idle').messages.find((m) => m.role === 'user').id, code: false });
  assert.equal(await toastText(page), 'Rewound. Edit your message and send it.');

  await page.goto(page.url().replace(/\?.*$/, '?session=s-run'));
  await page.locator('.msg-user', { hasText: 'Split server.mjs into modules' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Rewind to here' }).count(), 0, 'a running turn has to end first');
  assert.ok((await forkButtons(page).count()) > 0, 'forking still works');
  await context.close();
});
