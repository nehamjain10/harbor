// Real-browser checks for the MCP panel against the mocked v2 server (harness.mjs): the
// topbar chip, the list by group, the per-session switch, Reconnect, both kinds of
// sign-in (claude.ai connector, and OAuth with the pasted address), the entry points,
// and what a listing that fails or is read only looks like. Run with `npm run test:browser`.
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

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
const dialogOf = (page) => page.locator('dialog.mcp-dialog');
const rowOf = (page, name) => dialogOf(page).locator('.mcp-row', { has: page.locator('.mcp-name', { hasText: new RegExp(`^${name}$`) }) });
const posts = (server) => server.requests.filter((r) => r.method === 'POST' && r.path.includes('/mcp/')).map((r) => [r.path.replace('sessions/s-idle/mcp/', ''), r.body]);

async function openPanel(page) {
  await page.getByRole('button', { name: /^MCP servers/ }).click();
  const dialog = dialogOf(page);
  await dialog.locator('.mcp-group').first().waitFor();
  return dialog;
}

test('the chip counts connected servers and flags the ones that need a look; the panel lists them by group, with claude.ai connectors that are not set up folded', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  // No list yet and no recent one: the chip stays a plain plug (it never starts Claude Code).
  await page.waitForSelector('.crumb-title');
  const chip = page.getByRole('button', { name: /^MCP servers/ });
  assert.equal(await chip.locator('.mcp-chip-count').count(), 0);
  assert.equal(await page.locator('dialog').count(), 0);

  // Once a listing exists (the panel asked for it), the chip follows it: Echo and Gmail
  // are connected; wiki failed and Slack's plugin needs a sign-in. The claude.ai
  // connectors that are not set up do not count as needing attention.
  const dialog = await openPanel(page);
  assert.equal(await text(page.locator('.mcp-chip-count')), '2');
  assert.equal(await page.locator('.mcp-chip-dot').count(), 1);
  assert.equal(await chip.getAttribute('aria-label'), 'MCP servers, 2 need attention');
  assert.match(await chip.getAttribute('title'), /^MCP servers: 2 of 11 connected, 2 need attention/);

  assert.equal(await text(dialog.locator('#dialog-title')), 'MCP servers');
  assert.equal(await dialog.locator('.dialog-heading .eyebrow').textContent(), 'This session');
  assert.equal(await text(dialog.locator('.dialog-subtitle')), 'Review GPU memory profile');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close', 'focus starts on Close, not the filter (no keyboard pops up on a phone)');
  const heads = (await dialog.locator('.mcp-group-head').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(heads.map((head) => head.toLowerCase()), ['claude.ai connectors 8', 'plugins 1', 'your servers 1', 'this project 1', 'built in 1']);

  // Seven connectors are not set up: they fold behind one button, Gmail stays.
  const connectors = dialog.locator('.mcp-group[aria-label="claude.ai connectors"] .mcp-row');
  assert.equal(await connectors.count(), 1);
  assert.equal(await text(connectors.first().locator('.mcp-row-head')), 'Gmail Connected');
  await dialog.getByRole('button', { name: 'Show 7 connectors that are not set up' }).click();
  assert.equal(await connectors.count(), 8);
  await dialog.getByRole('button', { name: 'Hide connectors that are not set up' }).click();
  assert.equal(await connectors.count(), 1);

  // Each row says what it is and how it stands.
  assert.equal(await text(rowOf(page, 'echo').locator('.mcp-row-head')), 'echo Connected');
  assert.equal(await text(rowOf(page, 'echo').locator('.mcp-detail')), '1 tool · local command');
  assert.equal(await text(rowOf(page, 'wiki').locator('.mcp-row-head')), 'wiki Failed');
  assert.equal(await text(rowOf(page, 'wiki').locator('.mcp-detail')), 'connect ECONNREFUSED https://wiki.example.com/mcp');
  assert.equal(await text(rowOf(page, 'slack').locator('.mcp-row-head')), 'slack plugin Needs sign-in');
  assert.equal(await text(rowOf(page, 'meshy').locator('.mcp-always')), 'Always on');
  assert.equal(await rowOf(page, 'meshy').locator('[role="switch"]').count(), 0, 'Harbor’s own server cannot be switched');
  assert.match(await text(dialog.locator('.mcp-note').first()), /runs on Claude, so your claude\.ai connectors are available/);

  // A connector's tools open under its row; destructive ones are marked.
  await connectors.first().locator('.mcp-row-head').click();
  const tools = connectors.first().locator('.mcp-tool');
  assert.deepEqual((await tools.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')), ['search threads read only', 'create draft', 'send message changes things']);
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('the switch leaves a server out of this session only: the request, the row and the chip follow; a running process says the next message re-reads the conversation', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const dialog = await openPanel(page);
  const echo = rowOf(page, 'echo');
  const toggle = echo.getByRole('switch', { name: 'Use echo in this session' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.equal(await dialog.locator('.mcp-note-info').count(), 0);

  await toggle.click();
  await page.waitForFunction(() => document.querySelector('.mcp-row.is-off'));
  assert.deepEqual(posts(server), [['echo/toggle', { enabled: false }]]);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await text(echo.locator('.mcp-row-head')), 'echo Off for this session');
  assert.equal(await text(page.locator('.mcp-chip-count')), '1', 'the chip no longer counts it');
  assert.equal(await dialog.locator('.mcp-note-info').count(), 0, 'no process was running, so nothing is re-read');

  // On again, now with a live process: the tool list of a running conversation changes.
  server.mcp.live = true;
  await toggle.click();
  await dialog.locator('.mcp-note-info').waitFor();
  assert.match(await text(dialog.locator('.mcp-note-info')), /re-reads the conversation once/);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(posts(server).at(-1), ['echo/toggle', { enabled: true }]);

  // A refusal is shown on the row and the switch stays where it was.
  server.mcp.toggleError = 'Claude Code could not apply this change: refused';
  await toggle.click();
  await echo.locator('.mcp-row-note.is-error').waitFor();
  assert.equal(await text(echo.locator('.mcp-row-note')), 'Claude Code could not apply this change: refused');
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(server.errors.filter((e) => !/status of 502/.test(e)), []);
  await context.close();
});

test('another tab’s switch arrives with the session and the rows follow it', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await openPanel(page);
  const session = server.sessions.find((s) => s.id === 's-idle');
  await emitSession(page, { ...session, mcpDisabled: ['echo'], messages: undefined });
  await page.waitForFunction(() => document.querySelector('.mcp-row.is-off'));
  assert.equal(await text(rowOf(page, 'echo').locator('.mcp-row-head')), 'echo Off for this session');
  await emitSession(page, { ...session, mcpDisabled: [], messages: undefined });
  await page.waitForFunction(() => !document.querySelector('.mcp-row.is-off'));
  await context.close();
});

test('signing in to Slack’s plugin: the link, the steps, the pasted address, and what each mistake says', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const dialog = await openPanel(page);
  const slack = rowOf(page, 'slack');
  await slack.getByRole('button', { name: 'Sign in…' }).click();
  const box = slack.locator('.mcp-signin');
  await box.waitFor();
  assert.deepEqual(posts(server), [['plugin%3Aslack%3Aslack/auth', {}]]);

  // The link is offered, never opened by the page itself.
  const link = box.getByRole('link', { name: 'Open sign-in page' });
  assert.match(await link.getAttribute('href'), /^https:\/\/auth\.example\.com\/oauth\/authorize\?/);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /noopener/);
  assert.equal(await box.locator('.mcp-steps li').count(), 3);
  assert.match(await text(box.locator('.mcp-steps li').nth(1)), /localhost:3118\/callback\?code=/);
  assert.equal(await slack.getByRole('button', { name: 'Sign in…' }).count(), 0, 'the button gives way to the steps');

  // Until the pasted text is the address, Finish stays off and the hint says why.
  const paste = box.getByLabel('Address copied from the browser');
  const finish = box.getByRole('button', { name: 'Finish sign-in' });
  assert.equal(await finish.isDisabled(), true);
  await paste.fill('https://slack.com/oauth');
  assert.equal(await finish.isDisabled(), true);
  assert.match(await text(box.locator('.mcp-signin-hint')), /starts with http:\/\/localhost and has code= in it/);

  // An address of an earlier attempt: the server says so, the box stays for another try.
  await paste.fill('http://localhost:3118/callback?code=abc&state=wrong');
  await finish.click();
  await slack.locator('.mcp-row-note.is-error').waitFor();
  assert.match(await text(slack.locator('.mcp-row-note')), /belongs to an earlier sign-in attempt/);
  assert.equal(await box.count(), 1);

  // The right one: connected, the steps go, a note and a toast say so, the chip counts it.
  await paste.fill('  http://localhost:3118/callback?code=abc&state=state-1  ');
  await finish.click();
  await slack.locator('.mcp-row-note.is-ok').waitFor();
  assert.deepEqual(posts(server).at(-1), ['plugin%3Aslack%3Aslack/auth/callback', { url: 'http://localhost:3118/callback?code=abc&state=state-1' }]);
  assert.equal(await text(slack.locator('.mcp-row-head')), 'slack plugin Connected');
  assert.equal(await text(slack.locator('.mcp-row-note')), 'Signed in and connected.');
  assert.equal(await box.count(), 0);
  assert.equal(await text(page.locator('.toast')), 'slack is connected.');
  assert.equal(await text(page.locator('.mcp-chip-count')), '3');
  assert.equal(await slack.getByRole('button', { name: 'Sign out' }).count(), 1);
  assert.equal(await dialog.locator('[aria-label="Address copied from the browser"]').count(), 0);
  assert.deepEqual(server.errors.filter((e) => !/status of 4\d\d/.test(e)), []);
  await context.close();
});

test('a sign-in approved in a browser on the machine that runs Harbor connects by itself: the panel notices and drops the steps', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  server.mcp.live = true;
  await openPanel(page);
  const slack = rowOf(page, 'slack');
  await slack.getByRole('button', { name: 'Sign in…' }).click();
  await slack.locator('.mcp-signin').waitFor();
  const loads = server.mcp.loads.length;
  // Claude Code's own localhost listener got the callback and connected the server.
  server.mcp.servers.find((row) => row.name === 'plugin:slack:slack').status = 'connected';
  await slack.locator('.mcp-signin').waitFor({ state: 'detached', timeout: 8000 });
  assert.equal(await text(slack.locator('.mcp-row-head')), 'slack plugin Connected');
  assert.equal(await text(slack.locator('.mcp-row-note')), 'Signed in and connected.');
  assert.match(server.mcp.loads[loads], /cached=1/, 'it asked without starting a process');
  assert.equal(posts(server).filter(([path]) => path.endsWith('/callback')).length, 0);
  await context.close();
});

test('a sign-in that expired on the server is dropped with its reason; one that ends unconnected says Reconnect', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await openPanel(page);
  const slack = rowOf(page, 'slack');
  await slack.getByRole('button', { name: 'Sign in…' }).click();
  const paste = slack.getByLabel('Address copied from the browser');
  await paste.fill('http://localhost:3118/callback?code=abc&state=state-1');
  // Claude Code restarted meanwhile: its OAuth state is gone.
  server.mcp.signIn = {};
  await slack.getByRole('button', { name: 'Finish sign-in' }).click();
  await slack.locator('.mcp-row-note.is-error').waitFor();
  assert.match(await text(slack.locator('.mcp-row-note')), /No sign-in is waiting for this server/);
  assert.equal(await slack.locator('.mcp-signin').count(), 0);
  assert.equal(await slack.getByRole('button', { name: 'Sign in…' }).count(), 1, 'it can be started again');

  server.mcp.afterSignIn = 'failed';
  await slack.getByRole('button', { name: 'Sign in…' }).click();
  await slack.getByLabel('Address copied from the browser').fill('http://localhost:3118/callback?code=abc&state=state-1');
  await slack.getByRole('button', { name: 'Finish sign-in' }).click();
  await slack.locator('.mcp-row-note.is-error').waitFor();
  assert.match(await text(slack.locator('.mcp-row-note')), /did not connect\. Try Reconnect\./);
  assert.equal(await slack.getByRole('button', { name: 'Reconnect' }).count(), 1);
  await context.close();
});

test('a sign-in link counts down, and an expired one is replaced with Get a new link', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await openPanel(page);
  server.mcp.expiresIn = 3;
  const slack = rowOf(page, 'slack');
  await slack.getByRole('button', { name: 'Sign in…' }).click();
  const box = slack.locator('.mcp-signin');
  await box.waitFor();
  const countdown = box.locator('.mcp-countdown');
  assert.match(await text(countdown), /^Link expires in 0:0[1-3]$/);
  assert.equal(await countdown.evaluate((el) => el.classList.contains('is-soon')), true, 'under a minute: warning colour');
  await box.getByText('This sign-in link expired. Links last about five minutes.').waitFor({ timeout: 6000 });
  assert.equal(await box.getByRole('link', { name: 'Open sign-in page' }).count(), 0, 'no dead link is offered');

  server.mcp.expiresIn = 300;
  await box.getByRole('button', { name: 'Get a new link' }).click();
  await box.getByRole('link', { name: 'Open sign-in page' }).waitFor();
  assert.match(await text(box.locator('.mcp-countdown')), /^Link expires in (5:00|4:5\d)$/);
  assert.deepEqual(
    posts(server).map(([path]) => path),
    ['plugin%3Aslack%3Aslack/auth', 'plugin%3Aslack%3Aslack/auth'],
  );
  // While the steps are open the link can be replaced without waiting for it to expire.
  await box.getByRole('button', { name: 'Get a new link' }).click();
  await page.waitForFunction(() => document.querySelector('.mcp-signin .mcp-countdown'));
  assert.equal(posts(server).length, 3);
  await context.close();
});

test('a server switched off in Claude Code’s own settings turns on through its switch, and the panel says that project setting changed', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  server.mcp.servers.push({ name: 'comet', status: 'disabled', scope: 'user', source: 'user', group: 'user', type: 'http', url: 'https://comet.example.com/mcp', tools: [], toolCount: 0, builtin: false, disabledInSession: false, auth: 'oauth' });
  await openPanel(page);
  const comet = rowOf(page, 'comet');
  assert.equal(await text(comet.locator('.mcp-row-head')), 'comet Off in Claude Code');
  const toggle = comet.getByRole('switch');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.match(await toggle.getAttribute('title'), /off in Claude Code for this project\. Turning it on changes that setting too/);
  await toggle.click();
  await comet.locator('.mcp-row-note.is-info').waitFor();
  assert.match(await text(comet.locator('.mcp-row-note')), /switched off in Claude Code for this project, so that setting is now on again/);
  assert.deepEqual(posts(server), [['comet/toggle', { enabled: true }]]);
  assert.equal(await text(comet.locator('.mcp-row-head')), 'comet Connected');
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await context.close();
});

test('servers Claude Code left out as duplicates are named at the end of the list', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  server.mcp.hidden = [{ name: 'plugin:ghost:ghost', reason: 'It has the same address as a claude.ai connector.' }];
  const dialog = await openPanel(page);
  const section = dialog.locator('.mcp-group[aria-label="Left out by Claude Code"]');
  assert.equal((await section.locator('.mcp-group-head').textContent()).toLowerCase(), 'left out by claude code1');
  assert.equal(await text(section.locator('li')), 'plugin:ghost:ghost It has the same address as a claude.ai connector.');
  await dialog.getByLabel('Filter servers and tools').fill('echo');
  assert.equal(await section.count(), 0, 'a filter shows matching servers only');
  await context.close();
});

test('a claude.ai connector signs in on claude.ai: the link, then Reconnect, which tells the truth until it is done; no paste field', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  const dialog = await openPanel(page);
  // 12 servers: the filter appears; Slack is found by name.
  await dialog.getByLabel('Filter servers and tools').fill('slack');
  assert.equal(await dialog.locator('.mcp-row').count(), 2, 'the plugin and the connector');
  const slack = rowOf(page, 'Slack');
  await slack.getByRole('button', { name: 'Connect…' }).click();
  const box = slack.locator('.mcp-signin');
  await box.waitFor();
  assert.deepEqual(posts(server), [['claude.ai%20Slack/auth', {}]]);
  const link = box.getByRole('link', { name: 'Open claude.ai' });
  assert.match(await link.getAttribute('href'), /^https:\/\/claude\.ai\/api\/organizations\/org-1\/mcp\/start-auth\/mcpsrv_Slack/);
  assert.equal(await box.getByLabel('Address copied from the browser').count(), 0);

  // Reconnect before connecting on claude.ai: still needs sign-in.
  server.mcp.reconnect['claude.ai Slack'] = 'needs-auth';
  await box.getByRole('button', { name: 'Reconnect' }).click();
  await slack.locator('.mcp-row-note.is-error').waitFor();
  assert.match(await text(slack.locator('.mcp-row-note')), /still needs you to sign in/);
  assert.equal(await box.count(), 1, 'the steps stay');

  server.mcp.reconnect['claude.ai Slack'] = 'connected';
  await box.getByRole('button', { name: 'Reconnect' }).click();
  await slack.locator('.mcp-row-note.is-ok').waitFor();
  assert.equal(await text(slack.locator('.mcp-row-head')), 'Slack Connected');
  assert.equal(await box.count(), 0);
  await context.close();
});

test('Reconnect on a failed server, and Sign out of one that is connected', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  await openPanel(page);
  const wiki = rowOf(page, 'wiki');
  server.mcp.reconnect.wiki = 'failed';
  await wiki.getByRole('button', { name: 'Reconnect' }).click();
  await wiki.locator('.mcp-row-note.is-error').waitFor();
  assert.equal(await text(wiki.locator('.mcp-row-note')), 'connect ECONNREFUSED');
  server.mcp.reconnect.wiki = 'connected';
  await wiki.getByRole('button', { name: 'Reconnect' }).click();
  await wiki.locator('.mcp-row-note.is-ok').waitFor();
  assert.equal(await text(wiki.locator('.mcp-row-head')), 'wiki Connected');
  assert.equal(await wiki.getByRole('button', { name: 'Reconnect' }).count(), 0);

  await wiki.getByRole('button', { name: 'Sign out' }).click();
  await wiki.locator('.mcp-row-note.is-ok').waitFor();
  assert.equal(await text(wiki.locator('.mcp-row-note')), 'Signed out.');
  assert.deepEqual(
    posts(server).map(([path]) => path),
    ['wiki/reconnect', 'wiki/reconnect', 'wiki/auth/clear'],
  );
  await context.close();
});

test('the panel opens from the topbar, /mcp and the palette; with no session it is a read-only look', async () => {
  const { page, context, server } = await openApp(browser);
  await page.context().route('**/api/commands**', (route) => route.fulfill({ json: { commands: [] } }));
  const dialog = dialogOf(page);

  // No session open: the project's servers, read only (no switches, no sign-in).
  await page.getByRole('button', { name: /^MCP servers/ }).click();
  await dialog.locator('.mcp-group').first().waitFor();
  assert.equal(await dialog.locator('.dialog-heading .eyebrow').textContent(), 'No session open');
  assert.equal(await text(dialog.locator('.dialog-subtitle')), 'zenit-research');
  assert.match(await text(dialog.locator('.mcp-note-warn')), /read-only look/);
  assert.equal(await dialog.getByRole('switch').first().isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: /Sign in/ }).count(), 0);
  assert.match(server.mcp.loads.at(-1), /^\?cwd=.*&route=claude$/);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // `/mcp` in a session, and the palette.
  await page.locator('.session-main', { hasText: 'Review GPU memory profile' }).click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  const input = page.locator('.composer textarea');
  await input.fill('/mcp');
  await input.press('Enter');
  await dialog.locator('.mcp-group').first().waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await dialog.getByRole('switch').first().isDisabled(), false);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await page.keyboard.press('Control+k');
  await page.locator('.palette input').fill('mcp servers');
  assert.equal(await text(page.locator('.palette-row.is-active .palette-label')), 'MCP servers…');
  await page.keyboard.press('Enter');
  await dialog.locator('.mcp-group').first().waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('a gateway chat says claude.ai connectors do not apply; a failed listing is an error with the rows kept, and Refresh asks again', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-old' });
  server.mcp.route = 'gateway';
  server.mcp.live = true;
  server.mcp.servers = server.mcp.servers.filter((row) => row.group !== 'claudeai');
  const dialog = await openPanel(page);
  assert.match(await text(dialog.locator('.mcp-meta-text')), /^Live from this session’s Claude Code · just now$/);
  assert.match(await text(dialog.locator('.mcp-note').first()), /runs through the model gateway, so claude\.ai connectors do not apply/);
  assert.equal(await dialog.locator('.mcp-group[aria-label="claude.ai connectors"]').count(), 0);
  assert.equal(await dialog.getByLabel('Filter servers and tools').count(), 0, 'four servers need no filter');

  server.mcp.error = { status: 502, error: 'Claude Code did not answer: no reply' };
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await dialog.locator('.mcp-error').waitFor();
  assert.equal(await text(dialog.locator('.mcp-error')), 'Could not refresh: Claude Code did not answer: no reply');
  assert.equal(await dialog.locator('.mcp-row').count(), 4, 'the last list stays');
  assert.match(server.mcp.loads.at(-1), /fresh=1/);

  server.mcp.error = null;
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await dialog.locator('.mcp-error').waitFor({ state: 'detached' });
  await context.close();
});

test('on a phone the panel fits the screen: no sideways scroll, rows and the paste field reachable', async () => {
  const { page, context } = await openApp(browser, { url: '/?session=s-idle', viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const dialog = await openPanel(page);
  await rowOf(page, 'slack').getByRole('button', { name: 'Sign in…' }).click();
  await rowOf(page, 'slack').locator('.mcp-paste-input').waitFor();
  const overflow = await dialog.evaluate((el) => ({ panel: el.scrollWidth - el.clientWidth, body: el.querySelector('.dialog-body').scrollWidth - el.querySelector('.dialog-body').clientWidth }));
  assert.deepEqual(overflow, { panel: 0, body: 0 });
  const box = await rowOf(page, 'slack').locator('.mcp-paste-input').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'inside the viewport');
  await context.close();
});
