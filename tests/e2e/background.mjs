// Background tasks against the real server and Claude Code: a background command shows in
// the topbar and the Background tab while it runs (its output following the file), then
// lands under Finished with its exit; scheduled jobs from the Stop hook show with their
// schedule in words.
import assert from 'node:assert/strict';
import { createSession, flow, send, textOf, toolsOf, waitFor, waitForText, waitForTurns } from './helpers.mjs';

export function backgroundFlows(ctx) {
  flow(ctx, 'a background command runs in the Background tab with live output, then shows as finished; scheduled jobs are listed', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Background' });
    const { page } = await openSession(session.id);

    await send(page, 'Count for me. [[mock:bg:6]]');
    let current = await waitForTurns(stack, session.id, 1);
    const [call] = toolsOf(current, 'Bash');
    assert.equal(call.task.kind, 'shell');
    assert.equal(current.liveTasks.length, 1);

    const button = page.locator('.topbar-background');
    await waitForText(button.locator('.topbar-badge'), /^1$/);
    await button.click();
    const running = page.locator('.bg-section[aria-label="Running"] .bg-task');
    await waitForText(running.locator('.bg-task-title'), /Count ticks/);
    await running.locator('.bg-task-head').click();
    await waitForText(running.locator('.bg-output'), /\btick 1\b/);
    await waitForText(running.locator('.bg-output'), /\btick 3\b/, { timeout: 10_000 });

    // It ends: under Finished with its exit, and the topbar button goes.
    await page.locator('.bg-section[aria-label="Running"]').waitFor({ state: 'detached', timeout: 20_000 });
    await page.locator('.topbar-background').waitFor({ state: 'detached' });
    const toggle = page.locator('.bg-heading-toggle');
    await waitForText(toggle, /Finished\s*1/);
    await toggle.click();
    const finished = page.locator('.bg-finished .bg-task');
    await waitForText(finished.locator('.bg-time'), /^Done · \d+s$/);
    // Still open from when it ran, now with the whole output and its exit line.
    await waitForText(finished.locator('.bg-output'), /\btick 6\b.*exited with code 0/);
    current = await waitForTurns(stack, session.id, 2);
    assert.equal(toolsOf(current, 'Bash')[0].task.status, 'completed');

    // Scheduled jobs come from the end of the turn.
    await send(page, 'Keep an eye on it. [[mock:cron]]');
    current = await waitForTurns(stack, session.id, 3);
    await waitFor(async () => (await stack.api('GET', `sessions/${session.id}`)).crons?.length === 2, { message: 'two jobs' });
    const jobs = page.locator('.bg-section[aria-label="Scheduled"] .bg-task');
    await waitFor(async () => (await jobs.count()) === 2, { message: 'two job rows' });
    assert.equal(await textOf(jobs.nth(0).locator('.bg-task-title')), 'Every 30 minutes');
    assert.match(await textOf(jobs.nth(1).locator('.bg-task-title')), /^Once at /);
    // The topbar keeps a button for the jobs, without a running count.
    await page.locator('.topbar-background').waitFor();
    assert.equal(await page.locator('.topbar-background .topbar-badge').count(), 0);
  });
}
