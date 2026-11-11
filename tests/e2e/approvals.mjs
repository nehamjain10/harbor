// Approval flows in the browser: Bash permission cards (allow once, always allow, deny
// with a reason), the plan card, and the question card.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSession,
  flow,
  lastAssistant,
  send,
  textOf,
  toolsOf,
  turnRequests,
  turnsOf,
  waitFor,
  waitForPending,
  waitForText,
  waitForTurns,
} from './helpers.mjs';

export function approvalFlows(ctx) {
  flow(ctx, 'approvals in Ask mode: allow once, always allow (no second prompt), deny with a reason', async ({ stack, openSession }) => {
    const repo = stack.makeRepo('approvals');
    const session = await createSession(stack, { cwd: repo, mode: 'default', title: 'Approvals' });
    const { page } = await openSession(session.id);
    const card = page.locator('.approval-permission');
    const command = 'node -p 40+2';

    // Allow once.
    await send(page, `Run it. [[mock:bash:${command}]]`);
    let waiting = await waitForPending(stack, session.id);
    assert.equal(waiting.pending[0].kind, 'permission');
    assert.equal(waiting.pending[0].tool, 'Bash');
    await card.waitFor();
    assert.equal(await textOf(card.locator('.approval-command code')), command);
    await waitForText(page.locator('.status-pill'), /^Needs you$/);
    await waitForText(page.locator('.tool-row', { hasText: command }).locator('.tool-status'), /Needs approval/);
    await card.getByRole('button', { name: /Allow once/ }).click();
    let current = await waitForTurns(stack, session.id, 1);
    assert.equal(toolsOf(current, 'Bash')[0].state, 'done');
    assert.equal(lastAssistant(current), 'Tool result: ok — 42');
    assert.deepEqual(current.allowRules ?? [], [], 'allow once records no grant');
    await card.waitFor({ state: 'detached' });
    const row = page.locator('.tool', { has: page.locator('.tool-row', { hasText: command }) }).first();
    await row.locator('.tool-row').click();
    await waitForText(row.locator('.output-pre'), /^42$/);

    // Always allow: the grant is stored on the session and the same command runs
    // without asking next time (the turn could not finish if it asked).
    // This time by keyboard. Keys typed in the composer stay there (the card never takes
    // focus from it); once the card has focus, `2` = Always allow.
    await send(page, `Again. [[mock:bash:${command}]]`);
    waiting = await waitForPending(stack, session.id);
    assert.ok(waiting.pending[0].suggestions?.length, 'the CLI offered an "always" rule');
    await card.waitFor();
    await waitForText(card.locator('.approval-rule'), /Always allow: .*node.* for this session/);
    const composer = page.locator('.composer-input');
    assert.equal(await composer.evaluate((el) => el === document.activeElement), true, 'focus stays in the composer');
    await composer.press('2');
    // Longer than the card's 400 ms key-arming delay, so the `2` below is not ignored.
    await page.waitForTimeout(500);
    assert.equal(await composer.inputValue(), '2');
    assert.equal((await stack.api('GET', `sessions/${session.id}`)).pending.length, 1, 'typing in the composer did not answer');
    await composer.fill('');
    await card.locator('.approval-title').click();
    await waitFor(() => card.evaluate((el) => el.contains(document.activeElement)), { message: 'the card to take focus' });
    await page.keyboard.press('2');
    current = await waitForTurns(stack, session.id, 2);
    assert.ok(current.allowRules.some((rule) => rule.toolName === 'Bash'), JSON.stringify(current.allowRules));
    assert.equal(lastAssistant(current), 'Tool result: ok — 42');

    const shown = await page.evaluate(() => {
      window.__approvalCards = 0;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && (node.matches('.approval') || node.querySelector('.approval'))) window.__approvalCards += 1;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      return document.querySelectorAll('.approval').length;
    });
    assert.equal(shown, 0);
    await send(page, `Once more. [[mock:bash:${command}]]`);
    current = await waitForTurns(stack, session.id, 3);
    assert.equal(lastAssistant(current), 'Tool result: ok — 42');
    assert.equal(await page.evaluate(() => window.__approvalCards), 0, 'no approval card appeared');

    // Deny with a reason: the model gets the reason as the tool error.
    await send(page, 'Make a file. [[mock:bash:touch denied.txt]]');
    await waitForPending(stack, session.id);
    await card.waitFor();
    await card.getByRole('button', { name: /Deny/ }).click();
    const reason = card.locator('.approval-input');
    await reason.waitFor();
    await reason.fill('Use a temp file instead');
    await reason.press('Enter');
    current = await waitForTurns(stack, session.id, 4);
    const result = turnRequests(stack).at(-1).lastToolResult;
    assert.equal(result.isError, true);
    assert.match(result.content, /Use a temp file instead/);
    assert.match(lastAssistant(current), /^Tool result: error — .*Use a temp file instead/);
    assert.equal(fs.existsSync(path.join(repo, 'denied.txt')), false);
    await waitForText(page.locator('.msg-assistant').last(), /Use a temp file instead/);
    assert.equal(current.mode, 'default');
  });

  flow(ctx, 'an Edit approval shows its diff; a pending approval survives a reload and is answered from a second (phone) tab', async ({ stack, openSession }) => {
    const repo = stack.makeRepo('edit-approval');
    const session = await createSession(stack, { cwd: repo, mode: 'default', title: 'Edit approval' });
    const desktop = await openSession(session.id);
    await send(desktop.page, 'Fix the greeting. [[mock:edit]]');
    const waiting = await waitForPending(stack, session.id);
    assert.equal(waiting.pending[0].tool, 'Edit');
    const card = desktop.page.locator('.approval-permission');
    await card.waitFor();
    await waitForText(card.locator('.approval-title'), /^Edit a file\?$/);
    await waitForText(card.locator('.approval-path'), /^hello\.txt$/);
    await waitForText(card.locator('.approval-stats'), /\+1.*−1/);
    assert.deepEqual(
      (await card.locator('.adiff-row, [class*="adiff-"]:has(> .adiff-sign)').allInnerTexts()).map((row) => row.replace(/\s+/g, ' ').trim()),
      ['− hello', '+ goodbye'],
    );

    // Reload: the same request is shown again.
    await desktop.page.reload();
    await card.waitFor();
    await waitForText(card.locator('.approval-path'), /^hello\.txt$/);

    // A phone opens the same session and answers there; the desktop card goes away.
    const phone = await openSession(session.id, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phoneCard = phone.page.locator('.approval-permission');
    await phoneCard.waitFor();
    await phoneCard.getByRole('button', { name: /Allow once/ }).tap();
    const done = await waitForTurns(stack, session.id, 1);
    assert.match(lastAssistant(done), /^Tool result: ok/);
    assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'goodbye world\nsecond line\n');
    await card.waitFor({ state: 'detached' });
    await phoneCard.waitFor({ state: 'detached' });
    await desktop.page.locator('.msg-assistant.has-turn-end').waitFor();
    await phone.page.locator('.msg-assistant.has-turn-end').waitFor();
  });

  flow(ctx, 'plan mode: the plan card approves with auto-accept edits and the mode chip follows', async ({ stack, openSession }) => {
    const session = await createSession(stack, { mode: 'plan', title: 'Plan first' });
    const { page } = await openSession(session.id);
    await waitForText(page.locator('.chip-mode .chip-label'), /^Plan$/);

    await send(page, 'Plan the change. [[mock:plan]]');
    const waiting = await waitForPending(stack, session.id);
    assert.equal(waiting.pending[0].kind, 'plan');
    const card = page.locator('.approval-plan');
    await card.waitFor();
    await waitForText(card.locator('.approval-title'), /^Ready to code\?$/);
    await waitForText(card.locator('.plan-markdown'), /Plan.*Read the code.*Make the change.*Run the tests/);

    await card.getByRole('button', { name: /Approve & auto-accept edits/ }).click();
    const done = await waitForTurns(stack, session.id, 1);
    assert.equal(done.mode, 'acceptEdits');
    assert.match(done.plan?.text || '', /^# Plan/);
    assert.match(turnRequests(stack).at(-1).lastToolResult.content, /User has approved/);
    await waitForText(page.locator('.chip-mode .chip-label'), /^Accept edits$/);
    await card.waitFor({ state: 'detached' });

    // The side panel's Plan tab shows the approved plan.
    await page.getByRole('button', { name: 'Show files and changes' }).click();
    await page.locator('.panel-tabs').getByRole('tab', { name: 'Plan' }).click();
    await waitForText(page.locator('.plan-view'), /Plan.*Read the code.*Make the change.*Run the tests/);
  });

  flow(ctx, 'plan mode: a plan from the plan file; Keep planning sends the feedback and stays in Plan', async ({ stack, openSession }) => {
    const session = await createSession(stack, { mode: 'plan', title: 'Plan with feedback' });
    const { page } = await openSession(session.id);
    await send(page, 'Plan the change. [[mock:plan:file]]');
    const waiting = await waitForPending(stack, session.id);
    assert.match(waiting.pending[0].input.plan, /^# Plan/, 'Claude Code read the plan file');
    const card = page.locator('.approval-plan');
    await card.waitFor();
    await waitForText(card.locator('.plan-markdown'), /Plan.*Read the code.*Make the change.*Run the tests/);

    await card.getByRole('button', { name: /Keep planning/ }).click();
    const feedback = card.locator('.approval-textarea');
    await feedback.waitFor();
    await feedback.fill('Add tests first');
    await feedback.press('Enter');
    const done = await waitForTurns(stack, session.id, 1);
    const result = turnRequests(stack).at(-1).lastToolResult;
    assert.equal(result.isError, true);
    assert.match(result.content, /keep planning\. Their feedback: Add tests first/);
    assert.equal(done.mode, 'plan');
    await card.waitFor({ state: 'detached' });
    await waitForText(page.locator('.chip-mode .chip-label'), /^Plan$/);
  });

  flow(ctx, 'question card: an option with a note sends both to the model; clicking the pick again unpicks it', async ({ stack, openSession }) => {
    const session = await createSession(stack, { mode: 'default', title: 'Ask me' });
    const { page } = await openSession(session.id);
    await send(page, 'Ask me first. [[mock:ask]]');
    const waiting = await waitForPending(stack, session.id);
    assert.equal(waiting.pending[0].kind, 'question');
    const card = page.locator('.approval-question');
    await card.waitFor();
    await waitForText(card.locator('.q-text'), /^Which approach should I take\?$/);
    assert.deepEqual(await card.locator('.q-label').allTextContents(), ['Small fix', 'Refactor']);
    const submit = card.getByRole('button', { name: /Submit/ });
    assert.equal(await submit.isDisabled(), true, 'nothing picked yet');

    const refactor = card.locator('.q-option', { hasText: 'Refactor' });
    await refactor.click();
    await waitFor(async () => !(await submit.isDisabled()), { message: 'Submit to enable' });
    await refactor.click();
    await waitFor(async () => await submit.isDisabled(), { message: 'the second click to unpick it' });
    await refactor.click();
    // The note box keeps the pick.
    await card.locator('.q-other-input').fill('keep the public API');
    assert.equal(await refactor.evaluate((el) => el.classList.contains('is-checked')), true);
    await submit.click();
    const done = await waitForTurns(stack, session.id, 1);
    const result = turnRequests(stack).at(-1).lastToolResult;
    assert.equal(result.isError, false);
    assert.match(result.content, /"Which approach should I take\?"="Refactor — Note: keep the public API"/);
    assert.match(lastAssistant(done), /^Tool result: ok/);
    assert.equal(turnsOf(done).length, 1);
    await card.waitFor({ state: 'detached' });
    // The finished question shows the answer in its tool card.
    const row = page.locator('.tool', { has: page.locator('.tool-verb', { hasText: 'Asked' }) });
    await row.locator('.tool-row').click();
    await waitForText(row.locator('.tool-detail'), /Refactor/);
  });
}
