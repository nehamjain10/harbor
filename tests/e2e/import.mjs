// Session import flows: the lists read only the stack's throwaway folders; a Claude Code
// session (made by the real CLI as the desktop app makes one) is imported from the
// palette and continued as a fork; a Codex rollout is imported with /import and its
// condensed history goes with the first message only; the dialog then marks both as
// imported and keeps a folder outside the home directory disabled.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { flow, sendAndWait, textOf, turnRequests, waitFor, waitForText } from './helpers.mjs';
import { CODEX_IDS, CODEX_OUTSIDE, CODEX_SESSION, makeClaudeDesktopSession } from './import-fixtures.mjs';

const OUTSIDE_REASON = 'Its folder is outside your home directory.';

function fingerprint(file) {
  const stats = fs.statSync(file);
  return { size: stats.size, mtimeMs: stats.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

const messageText = (message) =>
  typeof message.content === 'string' ? message.content : (message.content || []).map((block) => block.text ?? JSON.stringify(block.input ?? block.content ?? '')).join('\n');

const sessionRow = (page, title) => page.locator('.session-row', { has: page.locator('.session-title', { hasText: title }) });
// A row's tooltip (the full title, the project and time, where it was imported from),
// set when the pointer comes to rest on it.
async function rowTooltip(page, title) {
  const main = sessionRow(page, title).locator('.session-main');
  await main.hover();
  return (await main.getAttribute('title')) || '';
}
const importRow = (page, title) => page.locator('.import-row', { has: page.locator('.import-title', { hasText: title }) });

/** The CLI-made Claude Code session, created once per stack. */
function desktopSession(ctx) {
  ctx.desktopSession ??= makeClaudeDesktopSession(ctx.stack);
  return ctx.desktopSession;
}

/** Opens the import dialog with the palette's "Import sessions…" and waits for a tab's list. */
async function openImportFromPalette(page) {
  await page.keyboard.press('Control+k');
  const input = page.locator('.palette[open] .palette-input');
  await input.waitFor();
  await input.pressSequentially('import sessions');
  await waitForText(page.locator('.palette-row.is-active'), /Import sessions/);
  await input.press('Enter');
  const dialog = page.locator('.import-dialog[open]');
  await dialog.waitFor();
  return dialog;
}

async function chooseTab(dialog, label) {
  await dialog.getByRole('tab', { name: label }).click();
  await waitFor(async () => (await dialog.getByRole('tab', { name: label }).getAttribute('aria-selected')) === 'true', { message: `the ${label} tab` });
  await dialog.locator('.import-list[aria-busy]').waitFor({ state: 'detached' });
}

export function importFlows(ctx) {
  flow(ctx, 'import lists read only the throwaway Claude Code folder and Codex home', async ({ stack }) => {
    assert.ok(stack.codexHome.startsWith(path.dirname(stack.claudeConfigDir) + path.sep), 'the Codex home is in the stack temp directory');
    const codex = await stack.api('GET', 'import/codex');
    assert.deepEqual(codex.items.map((item) => item.id).sort(), [...CODEX_IDS].sort(), 'only the fixture rollouts');
    assert.equal(codex.total, CODEX_IDS.length);

    // Harbor's own sessions from the earlier flows live in the same Claude folder and
    // are left out; the only interactive session there is the one the CLI made.
    const made = await desktopSession(ctx);
    const claude = await stack.api('GET', 'import/claude');
    assert.deepEqual(
      claude.items.map((item) => item.id),
      [made.id],
      'only the session made in the throwaway Claude folder',
    );
    assert.equal(claude.items[0].title, made.title);
    assert.equal(claude.items[0].cwd, made.cwd);
    assert.equal(claude.items[0].importable, true);
  });

  flow(ctx, 'Claude Code import from the palette: history, badge and banner, then the next message continues a fork with that history', async ({ stack, openPage }) => {
    const made = await desktopSession(ctx);
    const original = fingerprint(made.file);
    const projectDir = path.dirname(made.file);
    const transcriptsBefore = new Set(fs.readdirSync(projectDir));
    const { page } = await openPage();

    const dialog = await openImportFromPalette(page);
    await chooseTab(dialog, /Claude Code/);
    const row = importRow(page, made.title);
    await row.waitFor();
    assert.match(await textOf(row.locator('.import-folder')), new RegExp(`^~/scratch/.*${path.basename(made.cwd)}$`));
    await row.click();
    assert.equal(await row.getAttribute('aria-selected'), 'true');
    await dialog.locator('.dialog-footer .btn-primary', { hasText: 'Import 1' }).click();
    await dialog.waitFor({ state: 'detached' });
    await waitForText(page.locator('.toast-text'), /^Imported “Remember the word PINEAPPLE”\.$/);

    await page.waitForFunction(() => new URLSearchParams(location.search).has('session'));
    const id = new URL(page.url()).searchParams.get('session');
    const imported = await stack.api('GET', `sessions/${id}`);
    assert.equal(imported.source.kind, 'claude');
    assert.equal(imported.source.id, made.id);
    assert.equal(imported.model, 'luna', 'the model the conversation last ran on');
    assert.equal(imported.forkFrom, undefined, 'server-only fields stay on the server');
    assert.deepEqual(
      imported.messages.map((m) => [m.role, m.tool ?? m.text]),
      [
        ['user', 'Check the shell first. [[mock:bash]]'],
        ['tool', 'Bash'],
        ['assistant', 'Tool result: ok — mock-bash'],
        ['user', 'Remember the word PINEAPPLE'],
        ['assistant', 'ok'],
      ],
    );
    assert.ok(imported.messages.every((m) => m.imported));

    // The history as the transcript shows it.
    assert.deepEqual(
      (await page.locator('.user-bubble').allTextContents()).map((text) => text.trim()),
      ['Check the shell first. [[mock:bash]]', 'Remember the word PINEAPPLE'],
    );
    const bash = page.locator('.tool', { has: page.locator('.tool-row', { hasText: 'echo mock-bash' }) });
    assert.equal(await textOf(bash.locator('.tool-verb')), 'Ran');
    await bash.locator('.tool-row').click();
    await waitForText(bash.locator('.output-pre'), /^mock-bash$/);
    await waitForText(page.locator('.msg-assistant').first(), /Tool result: ok — mock-bash/);
    assert.equal(await textOf(page.locator('.msg-assistant .assistant-model').first()), 'GPT-6 Luna');
    assert.match(await rowTooltip(page, made.title), /Imported from Claude Code$/);
    const banner = page.locator('.import-banner');
    assert.match(
      await textOf(banner),
      /^Imported from Claude Code · \w{3} \d+\. Your next message continues it on GPT-6 Luna in a copy; the original is unchanged\.$/,
    );

    await sendAndWait(stack, page, id, 'Which word did I ask you to remember?');
    const request = turnRequests(stack).at(-1);
    assert.equal(request.model, 'codex/gpt-6-luna');
    assert.equal(request.human, 'Which word did I ask you to remember?', 'same model: no switch note');
    const history = request.body.messages.map(messageText);
    assert.equal(history.filter((text) => /Remember the word PINEAPPLE/.test(text)).length, 1, 'the earlier turns, once');
    assert.ok(history.some((text) => /echo mock-bash/.test(text)), 'the earlier Bash call');
    assert.ok(
      request.body.messages.some((m) => Array.isArray(m.content) && m.content.some((block) => block.type === 'tool_result' && /mock-bash/.test(messageText({ content: [block] })))),
      'the earlier Bash result',
    );

    // The fork is a new Claude Code session with its own transcript (Harbor's own, so
    // the import list leaves it out); the original is not written.
    const forks = fs.readdirSync(projectDir).filter((name) => name.endsWith('.jsonl') && !transcriptsBefore.has(name));
    assert.equal(forks.length, 1, `one new transcript (${forks})`);
    const fork = fs.readFileSync(path.join(projectDir, forks[0]), 'utf8');
    assert.match(fork, /Remember the word PINEAPPLE/);
    assert.match(fork, /Which word did I ask you to remember\?/);
    assert.deepEqual((await stack.api('GET', 'import/claude')).items.map((item) => [item.id, item.importedAs]), [[made.id, id]]);
    assert.deepEqual(fingerprint(made.file), original, 'the original transcript is byte for byte unchanged');
    await banner.waitFor({ state: 'detached' });
    await waitFor(async () => (await page.locator('.msg-assistant').count()) === 3, { message: 'the new reply' });
    await waitForText(page.locator('.msg-assistant').last().locator('.markdown'), /^ok$/);
  });

  flow(ctx, 'Codex import with /import: shell and patch cards, then the first message carries the condensed history and the second does not', async ({ stack, openPage }) => {
    const { page } = await openPage();
    const input = page.locator('.composer-input');
    await input.click();
    await input.fill('/import');
    await input.press('Enter');
    const dialog = page.locator('.import-dialog[open]');
    await dialog.waitFor();
    await chooseTab(dialog, /Codex/);
    const row = importRow(page, CODEX_SESSION.title);
    await row.waitFor();
    assert.equal(await textOf(row.locator('.import-chip')), 'Terminal', 'codex-tui');
    await row.click();
    await dialog.locator('.dialog-footer .btn-primary', { hasText: 'Import 1' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.waitForFunction(() => new URLSearchParams(location.search).has('session'));
    const id = new URL(page.url()).searchParams.get('session');
    const imported = await stack.api('GET', `sessions/${id}`);
    assert.equal(imported.source.kind, 'codex');
    assert.equal(imported.source.originator, 'codex-tui');
    assert.equal(imported.model, 'luna', 'the model picked for new sessions');
    assert.equal(imported.handoff, undefined, 'server-only fields stay on the server');

    // Cards: the shell command, then the two patches (one file each).
    const group = page.locator('.activity', { has: page.locator('.activity-summary', { hasText: /^Edited 2 files, ran 1 command$/ }) });
    await group.locator('.activity-head').click();
    const bash = group.locator('.tool', { has: page.locator('.tool-verb', { hasText: /^Ran$/ }) });
    assert.equal(await textOf(bash.locator('.tool-target')), 'ls');
    await bash.locator('.tool-row').click();
    await waitForText(bash.locator('.output-pre'), /^hello\.txt notes\.md src$/);
    const greet = group.locator('.tool', { has: page.locator('.tool-row .tool-target', { hasText: 'greet.sh' }) });
    assert.equal(await textOf(greet.locator('.tool-row .tool-verb')), 'Edited');
    assert.equal(await textOf(greet.locator('.tool-row .tool-stats')), '+3', 'an added file: no "−0"');
    await greet.locator('.tool-row').click();
    const patch = greet.locator('.patch-file');
    assert.equal(await textOf(patch.locator('.tool-chip')), 'Added');
    assert.equal(await patch.locator('.d-add').count(), 3);
    const notes = group.locator('.tool', { has: page.locator('.tool-row .tool-target', { hasText: 'notes.md' }) });
    assert.equal(await textOf(notes.locator('.tool-row .tool-stats')), '+1 −1');
    await waitForText(page.locator('.msg-assistant').last(), new RegExp(CODEX_SESSION.answer.replace(/\./g, '\\.')));
    assert.match(await rowTooltip(page, CODEX_SESSION.title), /Imported from Codex$/);
    assert.match(
      await textOf(page.locator('.import-banner')),
      /^Imported from Codex · \w{3} \d+\. Codex conversations can’t be resumed directly; your next message starts a new conversation that carries a summary of this one\.$/,
    );

    await sendAndWait(stack, page, id, 'Please continue where Codex left off');
    const first = turnRequests(stack).at(-1);
    const prompt = first.body.messages.find((m) => m.role === 'user').content.at(-1).text;
    assert.match(prompt, /^\[Harbor: the user imported this conversation from a Codex session \("Add a greeting script"\)/);
    assert.match(prompt, /<codex_history>\n## Turn 1 \([^)]*\)\nUser: Add a greeting script and mention it in the notes\nCommands Codex ran:\n- `ls`\n/);
    assert.match(prompt, /Files Codex changed: greet\.sh, notes\.md\nCodex answered: I added greet\.sh/);
    assert.match(prompt, /<\/codex_history>\n\nPlease continue where Codex left off$/);
    assert.equal(first.body.messages.filter((m) => m.role !== 'system').length, 1, 'a new conversation');
    await page.locator('.import-banner').waitFor({ state: 'detached' });
    assert.equal(await textOf(page.locator('.user-bubble').last()), 'Please continue where Codex left off', 'the bubble shows what the user typed');

    await sendAndWait(stack, page, id, 'Anything else?');
    const second = turnRequests(stack).at(-1);
    assert.equal(second.human, 'Anything else?');
    assert.ok(second.messageCount > first.messageCount, 'the same conversation continues');
    assert.equal(second.body.messages.filter((m) => /<codex_history>/.test(messageText(m))).length, 1, 'the history is in it once');
  });

  flow(ctx, 'import dialog again: imported rows say "Imported" and open their session; a folder outside home is disabled with its reason', async ({ stack, openPage }) => {
    // Imported by the flows above, or here when this flow runs on its own (importing an
    // imported id again returns the same session).
    const made = await desktopSession(ctx);
    const claude = (await stack.api('POST', 'import', { source: 'claude', ids: [made.id], model: 'luna' })).sessions[0];
    const codex = (await stack.api('POST', 'import', { source: 'codex', ids: [CODEX_SESSION.id], model: 'luna' })).sessions[0];
    const { page } = await openPage();

    let dialog = await openImportFromPalette(page);
    await chooseTab(dialog, /Claude Code/);
    let row = importRow(page, made.title);
    await waitForText(row.locator('.import-status'), /^Imported$/);
    assert.match(await row.getAttribute('class'), /is-imported/);
    await row.click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction((sessionId) => new URLSearchParams(location.search).get('session') === sessionId, claude.id);
    await waitForText(page.locator('.crumb-title'), /^Remember the word PINEAPPLE$/);

    dialog = await openImportFromPalette(page);
    await chooseTab(dialog, /Codex/);
    assert.equal(await textOf(dialog.getByRole('tab', { name: /Codex/ }).locator('.import-tab-count')), '2');
    const outside = importRow(page, CODEX_OUTSIDE.title);
    assert.equal(await outside.getAttribute('aria-disabled'), 'true');
    assert.match(await outside.getAttribute('class'), /is-blocked/);
    assert.equal(await textOf(outside.locator('.import-reason')), OUTSIDE_REASON);
    assert.equal(await textOf(outside.locator('.import-folder')), '/tmp');
    await outside.click({ force: true });
    assert.equal(await outside.getAttribute('aria-selected'), 'false', 'a blocked row cannot be ticked');
    assert.equal(await dialog.locator('.dialog-footer .btn-primary').isDisabled(), true);
    const rejected = await stack.api('POST', 'import', { source: 'codex', ids: [CODEX_OUTSIDE.id] });
    assert.deepEqual(rejected, { sessions: [], errors: [{ id: CODEX_OUTSIDE.id, error: OUTSIDE_REASON }] });

    row = importRow(page, CODEX_SESSION.title);
    await waitForText(row.locator('.import-status'), /^Imported$/);
    await row.click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction((sessionId) => new URLSearchParams(location.search).get('session') === sessionId, codex.id);
    await waitForText(page.locator('.crumb-title'), /^Add a greeting script$/);
    assert.equal((await stack.api('GET', 'sessions')).filter((s) => s.source?.id === CODEX_SESSION.id).length, 1, 'no duplicate import');
  });
}
