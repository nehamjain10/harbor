// MCP server flows: the real server, real Claude Code turns against the mock gateway, and
// Chromium. A project's .mcp.json holds a stdio echo server and (for the sign-in) a local
// OAuth MCP server; the test plays the user's browser for the authorization page. Covers the
// topbar chip, the panel, a server switched off for one session (its tool leaves the very
// next request, comes back when switched on, and Claude Code's own project config is never
// written), `/mcp` and the palette, and a full OAuth sign-in with the pasted callback address.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOAuthMcpServer } from '../fixtures/mcp/oauth-server.mjs';
import { createSession, flow, sendAndWait, sessionRequests, textOf, toolsOf, waitFor, waitForText } from './helpers.mjs';

const ECHO = fileURLToPath(new URL('../fixtures/mcp/echo-server.mjs', import.meta.url));

const dialogOf = (page) => page.locator('dialog.mcp-dialog');
const rowOf = (page, name) => dialogOf(page).locator('.mcp-row', { has: page.locator('.mcp-name', { hasText: new RegExp(`^${name}$`) }) });

/** A repo whose .mcp.json starts the given servers. */
function repoWithServers(stack, servers) {
  const repo = stack.makeRepo('mcp');
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  return repo;
}

const echoServer = { command: process.execPath, args: [ECHO] };

/** The tools the newest model request the session's Claude Code made offers: sent, or named for tool search. */
const lastTools = (stack, repo) => {
  const request = sessionRequests(stack, repo).at(-1);
  return [...request.tools, ...(request.deferred || [])];
};

/** Servers Claude Code's own config marks as disabled for any project (must stay empty). */
function projectsDisabled(stack) {
  const file = path.join(stack.claudeConfigDir, '.claude.json');
  if (!fs.existsSync(file)) return {};
  const projects = JSON.parse(fs.readFileSync(file, 'utf8')).projects || {};
  return Object.fromEntries(Object.entries(projects).filter(([, value]) => value.disabledMcpServers?.length));
}

export function mcpFlows(ctx) {
  flow(ctx, 'MCP: the chip and panel list a project’s servers; switching one off hides its tool from the very next request, on shows it again, and Claude Code’s project config stays untouched', async ({ stack, openSession }) => {
    const repo = repoWithServers(stack, { echo: echoServer });
    const session = await createSession(stack, { cwd: repo, title: 'MCP switch' });
    const { page } = await openSession(session.id);
    await sendAndWait(stack, page, session.id, 'hello');
    // Deferred (tool search): named once the server has connected, maybe after the first request.
    await sendAndWait(stack, page, session.id, 'hello again');
    assert.ok(lastTools(stack, repo).includes('mcp__echo__echo'), 'the tool is offered while the server is on');

    // The chip opens the panel: this session's own process answers.
    const chip = page.getByRole('button', { name: /^MCP servers/ });
    await chip.click();
    const dialog = dialogOf(page);
    await dialog.locator('.mcp-row').first().waitFor();
    await waitForText(dialog.locator('.mcp-meta-text'), /^Live from this session’s Claude Code · /);
    const echo = rowOf(page, 'echo');
    await waitForText(echo.locator('.mcp-row-head'), /^echo Connected$/);
    assert.equal(await textOf(echo.locator('.mcp-detail')), '1 tool · local command');
    assert.equal(await textOf(rowOf(page, 'meshy').locator('.mcp-always')), 'Always on');
    await waitForText(page.locator('.mcp-chip-count'), /^1$/);

    // Off for this session: the panel says what it costs, and the next request has no echo tool.
    const toggle = echo.getByRole('switch', { name: 'Use echo in this session' });
    await toggle.click();
    await dialog.locator('.mcp-note-info').waitFor();
    assert.match(await textOf(dialog.locator('.mcp-note-info')), /re-reads the conversation once/);
    await waitForText(echo.locator('.mcp-row-head'), /^echo Off for this session$/);
    assert.deepEqual((await stack.api('GET', `sessions/${session.id}`)).mcpDisabled, ['echo']);
    assert.equal(await page.locator('.mcp-chip-count').count(), 0, 'nothing connected counts');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await sendAndWait(stack, page, session.id, 'again');
    assert.equal(lastTools(stack, repo).includes('mcp__echo__echo'), false, 'the very next request carries no echo tool');
    assert.deepEqual(projectsDisabled(stack), {}, 'Claude Code’s own list of disabled servers for the project was not written');

    // A new process (the old one died) keeps it off, from its very first request.
    const cwd = fs.realpathSync(repo);
    const mine = () => stack.cliProcesses().filter((proc) => proc.cwd === cwd).map((proc) => proc.pid);
    const [oldPid] = mine();
    assert.ok(oldPid, 'the session has a process');
    process.kill(oldPid, 'SIGKILL');
    await waitFor(async () => !mine().includes(oldPid), { message: 'the old process to be gone' });
    await sendAndWait(stack, page, session.id, 'after a restart');
    assert.ok(mine().length === 1 && !mine().includes(oldPid), 'another process answered');
    assert.equal(lastTools(stack, repo).includes('mcp__echo__echo'), false, 'still no echo tool');

    // On again, from the panel opened with /mcp.
    const input = page.locator('.composer-input');
    await input.fill('/mcp');
    await input.press('Enter');
    await dialog.locator('.mcp-row').first().waitFor();
    await toggle.click();
    await waitForText(echo.locator('.mcp-row-head'), /^echo Connected$/);
    await page.keyboard.press('Escape');
    // Back on, the model can use it again (tool search finds it; Claude Code does not name it again).
    await sendAndWait(stack, page, session.id, '[[mock:tools:mcp__echo__echo*1]] and back');
    const calls = (await stack.api('GET', `sessions/${session.id}`)).messages.filter((message) => message.role === 'tool' && message.tool === 'mcp__echo__echo');
    assert.equal(calls.at(-1)?.state, 'done', 'the echo tool ran');
    assert.deepEqual((await stack.api('GET', `sessions/${session.id}`)).mcpDisabled, []);

    // Another session in the same folder was never affected, and the palette opens the panel.
    const other = await createSession(stack, { cwd: repo, title: 'MCP sibling' });
    assert.deepEqual(other.mcpDisabled, []);
    await page.keyboard.press('Control+k');
    await page.locator('.palette input').fill('mcp servers');
    await page.keyboard.press('Enter');
    await dialog.locator('.mcp-row').first().waitFor();
    assert.deepEqual(projectsDisabled(stack), {});
  });

  flow(ctx, 'MCP: signing in to an OAuth server from the panel: the link, the pasted callback address, connected with its tools, usable by the model; then sign out', async ({ stack, openSession }) => {
    const oauth = await startOAuthMcpServer();
    try {
      const repo = repoWithServers(stack, { oauthy: { type: 'http', url: oauth.url } });
      const session = await createSession(stack, { cwd: repo, title: 'MCP sign-in' });
      const { page } = await openSession(session.id);
      const chip = page.getByRole('button', { name: /^MCP servers/ });
      await chip.click();
      const dialog = dialogOf(page);
      // No process yet: a no-prompt listing of the folder answers.
      await dialog.locator('.mcp-row').first().waitFor({ timeout: 60_000 });
      const row = rowOf(page, 'oauthy');
      await waitForText(row.locator('.mcp-row-head'), /^oauthy Needs sign-in$/);
      assert.equal(await page.locator('.mcp-chip-dot').count(), 1, 'a server that needs a sign-in asks for attention');

      await row.getByRole('button', { name: 'Sign in…' }).click();
      const box = row.locator('.mcp-signin');
      await box.waitFor({ timeout: 60_000 });
      const link = box.getByRole('link', { name: 'Open sign-in page' });
      const authUrl = await link.getAttribute('href');
      assert.ok(authUrl.startsWith(`${oauth.origin}/authorize?`), 'the authorization endpoint the server announced');
      assert.equal(await link.getAttribute('target'), '_blank');
      await waitForText(box.locator('.mcp-countdown'), /^Link expires in (5:00|4:[345]\d)$/);
      assert.equal(await box.locator('.mcp-steps li').count(), 3);

      // The user approves in their browser, which ends on a localhost page that cannot load.
      const callback = oauth.approve(authUrl);
      const finish = box.getByRole('button', { name: 'Finish sign-in' });
      await box.getByLabel('Address copied from the browser').fill(callback);
      await finish.click();
      await waitForText(row.locator('.mcp-row-head'), /^oauthy Connected$/, { timeout: 60_000 });
      assert.equal(await textOf(row.locator('.mcp-row-note')), 'Signed in and connected.');
      assert.equal(await box.count(), 0);
      assert.equal(await textOf(row.locator('.mcp-detail')), `1 tool · ${oauth.origin}/mcp`);
      await waitForText(page.locator('.mcp-chip-count'), /^1$/);
      assert.equal(await page.locator('.mcp-chip-dot').count(), 0);
      await waitForText(page.locator('.toast'), /^oauthy is connected\.$/);
      assert.equal(oauth.tokens.size, 1);
      assert.doesNotMatch(stack.serverLog(), /code-|token-/, 'neither the code nor the token is logged');

      // The model can use the server in this very session.
      await page.keyboard.press('Escape');
      await sendAndWait(stack, page, session.id, '[[mock:tools:mcp__oauthy__whoami*1]] who am I');
      const [call] = toolsOf(await stack.api('GET', `sessions/${session.id}`), 'mcp__oauthy__whoami');
      assert.equal(call.state, 'done');
      assert.match(JSON.stringify(call.output), /signed in as test-user/);

      // Sign out: the token goes, the server needs a sign-in again.
      await chip.click();
      await dialog.locator('.mcp-row').first().waitFor();
      await row.getByRole('button', { name: 'Sign out' }).click();
      await waitForText(row.locator('.mcp-row-note'), /^Signed out\.$/);
      await waitForText(row.locator('.mcp-row-head'), /^oauthy Needs sign-in$/);
    } finally {
      await oauth.close();
    }
  });

  flow(ctx, 'MCP: a pasted address with no sign-in waiting is refused in plain words, and the stale link can be replaced', async ({ stack, openSession }) => {
    const oauth = await startOAuthMcpServer();
    try {
      const repo = repoWithServers(stack, { oauthy: { type: 'http', url: oauth.url } });
      const session = await createSession(stack, { cwd: repo, title: 'MCP stale' });
      const { page } = await openSession(session.id);
      await page.getByRole('button', { name: /^MCP servers/ }).click();
      const row = rowOf(page, 'oauthy');
      await row.getByRole('button', { name: 'Sign in…' }).waitFor({ timeout: 60_000 });
      await row.getByRole('button', { name: 'Sign in…' }).click();
      const box = row.locator('.mcp-signin');
      await box.waitFor({ timeout: 60_000 });
      const first = await box.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href');

      // Get a new link: the first link's address is then refused.
      await box.getByRole('button', { name: 'Get a new link' }).click();
      await waitFor(async () => (await box.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href')) !== first, { message: 'a new link' });
      await box.getByLabel('Address copied from the browser').fill(oauth.approve(first));
      await box.getByRole('button', { name: 'Finish sign-in' }).click();
      await waitForText(row.locator('.mcp-row-note'), /earlier sign-in attempt/);
      assert.equal(await box.count(), 1, 'the steps stay, so the newest link can still be used');
      assert.equal(oauth.tokens.size, 0);

      const second = await box.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href');
      await box.getByLabel('Address copied from the browser').fill(oauth.approve(second));
      await box.getByRole('button', { name: 'Finish sign-in' }).click();
      await waitForText(row.locator('.mcp-row-head'), /^oauthy Connected$/, { timeout: 60_000 });
    } finally {
      await oauth.close();
    }
  });

  flow(ctx, 'MCP: with no session open the panel is a read-only look at the chosen project’s servers, from a no-prompt listing', async ({ stack, openPage }) => {
    const repo = repoWithServers(stack, { echo: echoServer });
    const before = stack.cliProcesses().length;
    const { page } = await openPage({ storage: { 'mesh-code-project': repo } });
    await page.getByRole('button', { name: /^MCP servers/ }).click();
    const dialog = dialogOf(page);
    await dialog.locator('.mcp-row').first().waitFor({ timeout: 60_000 });
    assert.equal(await textOf(dialog.locator('.dialog-subtitle')), path.basename(repo));
    assert.match(await textOf(dialog.locator('.mcp-note-warn')), /read-only look/);
    const echo = rowOf(page, 'echo');
    await waitForText(echo.locator('.mcp-row-head'), /^echo Connected$/);
    assert.equal(await echo.getByRole('switch').isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: /Sign in|Reconnect/ }).count(), 0);
    // The listing is made by a short-lived process nobody prompted, and it is gone again.
    await waitFor(async () => stack.cliProcesses().length === before, { message: 'the listing process to exit' });
    assert.deepEqual(stack.mock.requests.filter((request) => JSON.stringify(request.body ?? '').includes(repo)), [], 'no model request mentions the folder');
  });

  flow(ctx, 'MCP: on a phone the panel fits the screen and the switch works', async ({ stack, openSession }) => {
    const repo = repoWithServers(stack, { echo: echoServer });
    const session = await createSession(stack, { cwd: repo, title: 'MCP phone' });
    const { page } = await openSession(session.id, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.getByRole('button', { name: /^MCP servers/ }).tap();
    const dialog = dialogOf(page);
    await dialog.locator('.mcp-row').first().waitFor({ timeout: 60_000 });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `the dialog stays inside the screen: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    const echo = rowOf(page, 'echo');
    await echo.getByRole('switch', { name: 'Use echo in this session' }).tap();
    await waitForText(echo.locator('.mcp-row-head'), /^echo Off for this session$/);
    assert.deepEqual((await stack.api('GET', `sessions/${session.id}`)).mcpDisabled, ['echo']);
  });
}
