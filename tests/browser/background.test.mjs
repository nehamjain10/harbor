// The Background tab (BackgroundPanel.jsx) against the mocked server: the topbar button
// and its count, running / scheduled / finished rows, live output, Stop, the list
// reloading when the live set changes, and /tasks. Run with `npm run test:browser`.
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

const NOW = Date.now();

/** Puts background work on s-idle and answers the tasks routes from `state`. */
function stageTasks(server) {
  const session = server.sessions.find((s) => s.id === 's-idle');
  session.liveTasks = [{ id: 'bk1', type: 'local_bash', description: 'Count ticks', since: NOW - 5000 }];
  session.crons = [{ id: 'c1', schedule: '*/30 * * * *', recurring: true, prompt: 'Check the training run and report anything odd.', since: NOW - 60_000 }];
  const state = {
    loads: 0,
    outputLoads: 0,
    output: 'tick 1\n',
    running: [{ id: 'bk1', kind: 'shell', toolId: 'toolu_bk1', tool: 'Bash', description: 'Count ticks', command: 'for i in $(seq 1 60); do echo tick $i; sleep 1; done', startedAt: NOW - 5000, status: 'running' }],
    finished: [
      { id: 'bf1', kind: 'shell', toolId: 'toolu_bf1', tool: 'Bash', description: 'Build the bundle', command: 'npm run build', startedAt: NOW - 600_000, endedAt: NOW - 535_000, status: 'completed', exitCode: 0 },
      { id: 'bf2', kind: 'monitor', toolId: 'toolu_bf2', tool: 'Monitor', description: 'Watch job 331773', command: 'tail -f log', startedAt: NOW - 900_000, endedAt: NOW - 800_000, status: 'failed', exitCode: 2 },
    ],
  };
  server.routes.push(({ route, method }) => {
    if (route === 'sessions/s-idle/tasks' && method === 'GET') {
      state.loads += 1;
      return { json: { running: state.running, finished: state.finished, scheduled: session.crons || [], utcOffset: 0 } };
    }
    if (route === 'sessions/s-idle/tasks/bk1/output' && method === 'GET') {
      state.outputLoads += 1;
      return { json: { text: state.output, size: state.output.length, truncated: false, exitCode: null } };
    }
    if (route === 'sessions/s-idle/tasks/bf2/output') return { status: 404, json: { error: 'This task has no output on disk.' } };
    if (route === 'sessions/s-idle/tasks/bk1/stop' && method === 'POST') return { json: { ok: true } };
    return null;
  });
  return { session, state };
}

test('background: the topbar shows running work; the tab lists running, scheduled and finished tasks with live output and Stop', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-unread' });
  const { session, state } = stageTasks(server);
  await page.locator('.session-main', { hasText: 'Review GPU memory profile' }).click();
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();

  const button = page.locator('.topbar-background');
  await button.waitFor();
  assert.equal(await button.locator('.topbar-badge').textContent(), '1');
  assert.match(await button.getAttribute('aria-label'), /1 running in the background, 1 scheduled/);
  await button.click();

  const tab = page.locator('.panel-tabs button[aria-selected="true"]');
  assert.match(await tab.textContent(), /^Background1$/);
  const running = page.locator('.bg-section[aria-label="Running"] .bg-task');
  await running.waitFor();
  assert.match(await running.locator('.bg-task-title').textContent(), /Count ticks/);
  assert.match(await running.locator('.bg-task-command').textContent(), /^for i in/);
  assert.match(await running.locator('.bg-time').textContent(), /^\d+s$/);

  const job = page.locator('.bg-section[aria-label="Scheduled"] .bg-task');
  assert.equal(await job.locator('.bg-task-title').textContent(), 'Every 30 minutes');
  assert.match(await job.locator('.bg-job-prompt').textContent(), /Check the training run/);
  assert.match(await job.locator('.bg-time').textContent(), /· in \d+ min|in under a minute/);

  // Finished starts folded, with its count.
  const finishedToggle = page.locator('.bg-heading-toggle');
  assert.match(await finishedToggle.textContent(), /Finished\s*2/);
  assert.equal(await page.locator('.bg-finished').count(), 0);
  await finishedToggle.click();
  const finished = page.locator('.bg-finished .bg-task');
  assert.equal(await finished.count(), 2);
  assert.match(await finished.nth(0).locator('.bg-time').textContent(), /^Done · 1m 5s$/);
  assert.match(await finished.nth(1).locator('.bg-time').textContent(), /^Exit 2 · 1m 40s$/);
  await finished.nth(1).locator('.bg-task-head').click();
  await page.locator('.bg-finished .bg-output-note', { hasText: 'No output on disk' }).waitFor();

  // A running task's output follows the file.
  await running.locator('.bg-task-head').click();
  const output = running.locator('.bg-output');
  await output.waitFor();
  assert.equal(await output.textContent(), 'tick 1\n');
  state.output = 'tick 1\ntick 2\n';
  await page.waitForFunction(() => document.querySelector('.bg-section[aria-label="Running"] .bg-output')?.textContent.includes('tick 2'), null, { timeout: 4000 });

  await running.locator('.bg-stop').click();
  await page.waitForFunction(() => document.querySelector('.bg-stop')?.disabled);
  assert.ok(server.requests.some((r) => r.method === 'POST' && r.path === 'sessions/s-idle/tasks/bk1/stop'));

  // The task ends: the live set empties, the list reloads, and the topbar keeps the job.
  const loads = state.loads;
  state.running = [];
  state.finished = [{ ...state.finished[0], id: 'bk1', description: 'Count ticks', status: 'stopped', endedAt: Date.now() }, ...state.finished];
  await emitSession(page, { ...session, liveTasks: [], updatedAt: Date.now() + 1000 });
  await page.waitForFunction(() => !document.querySelector('.bg-section[aria-label="Running"]'));
  assert.ok(state.loads > loads);
  assert.match(await finishedToggle.textContent(), /Finished\s*3/);
  assert.equal(await button.locator('.topbar-badge').count(), 0);
  assert.match(await button.getAttribute('aria-label'), /^Background tasks: 1 scheduled$/);
  assert.match(await page.locator('.panel-tabs button[aria-selected="true"]').textContent(), /^Background$/);

  // The button closes the tab again.
  await button.click();
  await page.waitForFunction(() => !document.querySelector('.side-panel'));
  // Only the output that was not on disk.
  assert.deepEqual(server.errors, ['Failed to load resource: the server responded with a status of 404 (Not Found)']);
  await context.close();
});

test('background: /tasks opens the tab; a session with nothing in the background says so and has no topbar button', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-idle' });
  server.routes.push(({ route }) => (route === 'sessions/s-idle/tasks' ? { json: { running: [], finished: [], scheduled: [], utcOffset: 0 } } : null));
  await page.locator('.transcript-column', { hasText: 'Peak is 71 GB' }).waitFor();
  assert.equal(await page.locator('.topbar-background').count(), 0);
  const composer = page.locator('.composer textarea');
  await context.route('**/api/commands**', (route) => route.fulfill({ json: { commands: [] } }));
  await composer.fill('/tasks');
  await composer.press('Enter');
  await page.locator('.panel-message b', { hasText: 'Nothing in the background' }).waitFor();
  assert.equal(await composer.inputValue(), '');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('background: a background command in the chat reads as running while it runs, and its button opens it in the tab', async () => {
  const { page, context, server } = await openApp(browser, { url: '/?session=s-unread' });
  const { session, state } = stageTasks(server);
  const at = NOW - 4000;
  session.messages.push(
    { id: 'm-bk1', role: 'tool', tool: 'Bash', toolId: 'toolu_bk1', taskId: 'bk1', background: true, task: { kind: 'shell' }, state: 'done', at, endedAt: at, input: { command: 'for i in $(seq 1 60); do echo tick $i; sleep 1; done', description: 'Count ticks', run_in_background: true }, output: 'Command running in background with ID: bk1.' },
    { id: 'm-a1', role: 'assistant', text: 'Counting in the background.', at: at + 1 },
    { id: 'm-bf1', role: 'tool', tool: 'Bash', toolId: 'toolu_bf1', taskId: 'bf1', background: true, task: { kind: 'shell', status: 'completed' }, state: 'done', at: at + 2, endedAt: at + 2, input: { command: 'npm run build', description: 'Build the bundle', run_in_background: true }, output: 'Command running in background with ID: bf1.' },
    { id: 'm-a2', role: 'assistant', text: 'Building too.', at: at + 3 },
  );
  server.routes.push(({ route }) => (route === 'sessions/s-idle/tasks/bf1/output' ? { json: { text: 'built in 240 ms\n\n[exited with code 0]\n', size: 40, truncated: false, exitCode: 0 } } : null));
  await page.locator('.session-main', { hasText: 'Review GPU memory profile' }).click();
  await page.locator('.transcript-column', { hasText: 'Building too.' }).waitFor();

  const rows = page.locator('.tool.is-task');
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.nth(0).locator('.tool-badge').textContent(), 'running in background');
  assert.equal(await rows.nth(1).locator('.tool-badge').textContent(), 'background');

  // The finished one: the tab opens on it, Finished unfolded and its output shown.
  await rows.nth(1).locator('.agent-open-btn').click();
  const finished = page.locator('.bg-finished .bg-task[data-task="bf1"]');
  await finished.locator('.bg-output').waitFor();
  assert.match(await finished.locator('.bg-output').textContent(), /built in 240 ms/);
  assert.equal(await page.locator('.bg-section[aria-label="Running"] .bg-output').count(), 0, 'only that task opened');

  // The task ends: the chat row stops saying it runs.
  state.running = [];
  await emitSession(page, { ...session, liveTasks: [], updatedAt: Date.now() + 1000 });
  await page.waitForFunction(() => document.querySelector('.tool.is-task .tool-badge')?.textContent === 'background');
  assert.deepEqual(server.errors, []);
  await context.close();
});
