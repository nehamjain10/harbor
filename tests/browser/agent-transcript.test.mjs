// Real-browser checks for the agent view (the side panel's agent mode) against the
// mocked v2 server (harness.mjs): opening an agent's transcript from its card, its row,
// the strip, the end row and the Agents view; following it live; nested agents and the
// way back (breadcrumbs, Back, Esc); reload; a long agent opening windowed; Claude
// Code's own transcript for an agent without recorded steps; a model agent. Run with
// `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, buildApp, emitDelta, emitSession, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

async function waitFor(check, { timeout = 5000, message = 'condition' } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const PROMPT = 'Survey this repository: list the layout, read package.json and the README, and report the packages.';
const REPORT = 'Two packages, **core** and **cli**, under `packages/`.';

// Agent a1 ("Survey the repo", Explore, in the background): thinking, a reply, Bash,
// Read, a nested agent a2 ("Read the README", finished) with its own Read and reply,
// then a Bash still running (or, `done`, its report and the end row).
function agentMessages(at, { done = false } = {}) {
  const tool = (id, parent, name, input, fields = {}) => ({ id: 'm-' + id, role: 'tool', tool: name, toolId: id, parentToolId: parent, input, state: 'done', at, endedAt: at + 900, output: 'ok', ...fields });
  const say = (id, parent, words, t) => ({ id, role: 'assistant', text: words, parentToolId: parent, model: 'opus', at: at + t });
  const messages = [
    { id: 'u1', role: 'user', text: 'Survey the repo in the background.', at: at - 5000, delivery: 'done' },
    {
      id: 'm-a1',
      role: 'tool',
      tool: 'Agent',
      toolId: 'a1',
      at,
      input: { description: 'Survey the repo', subagent_type: 'Explore', prompt: PROMPT, run_in_background: true },
      state: done ? 'done' : 'running',
      background: true,
      taskId: 't1',
      output: done ? REPORT : 'Async agent launched successfully.',
      ...(done ? { endedAt: at + 64_000, usage: { toolUses: 5, tokens: 31_200, durationMs: 64_000 } } : { progress: { description: 'Searching', toolUses: 4, tokens: 24_000 } }),
    },
    { id: 'th1', role: 'thinking', text: 'Layout first, then package.json.', parentToolId: 'a1', at: at + 2500 },
    say('t1', 'a1', "I'll start with the top level.", 2600),
    tool('b1', 'a1', 'Bash', { command: 'ls -la', description: 'List the top level' }, { output: 'packages\ntests\nREADME.md' }),
    tool('r1', 'a1', 'Read', { file_path: '/home/you/claude-workbench/package.json' }),
    {
      id: 'm-a2',
      role: 'tool',
      tool: 'Agent',
      toolId: 'a2',
      parentToolId: 'a1',
      at: at + 10_000,
      input: { description: 'Read the README', subagent_type: 'general-purpose', prompt: 'Read README.md and sum it up.' },
      state: 'done',
      endedAt: at + 21_000,
      output: 'The README describes two packages.',
      usage: { toolUses: 1, tokens: 5000, durationMs: 11_000 },
    },
    tool('r2', 'a2', 'Read', { file_path: '/home/you/claude-workbench/README.md' }, { at: at + 11_000 }),
    say('t3', 'a2', 'The README describes two packages.', 20_000),
    tool('b2', 'a1', 'Bash', { command: 'node --test tests/', description: 'Run the tests' }, done ? { at: at + 30_000, output: '# pass 42' } : { at: at + 30_000, state: 'running', output: '' }),
  ];
  if (done) {
    messages.push(say('t4', 'a1', REPORT, 60_000));
    messages.push({ id: 'n1', role: 'notice', level: 'info', text: 'Background agent “Survey the repo” finished.', agentToolId: 'a1', at: at + 64_000 });
    messages.push({ id: 'r2', role: 'assistant', text: 'The survey is in.', model: 'opus', at: at + 66_000 });
    messages.push({ id: 'turn2', role: 'turn', duration: 2000, outputTokens: 60, cost: 0, model: 'opus' });
  } else {
    messages.push({ id: 'r1', role: 'assistant', text: 'The survey runs in the background.', model: 'opus', at: at + 1000 });
    messages.push({ id: 'turn1', role: 'turn', duration: 3000, outputTokens: 100, cost: 0, model: 'opus' });
  }
  return messages;
}

async function openSession(page, server, messages, fields = {}) {
  const session = server.sessions.find((s) => s.id === 's-old');
  Object.assign(session, { messages, status: 'idle', backgroundAgents: messages.some((m) => m.state === 'running' && m.background && !m.parentToolId) ? 1 : 0, ...fields });
  await page.locator('.session-main', { hasText: session.title }).click();
  await page.waitForFunction(() => location.search === '?session=s-old');
  await page.locator('.transcript-column', { hasText: 'Survey the repo' }).first().waitFor();
  return session;
}

const panel = (page) => page.locator('.side-panel.is-agent');
const panelRow = (page, target) => panel(page).locator('.tool', { has: page.locator('.tool-target', { hasText: target }) }).first();
const atBottom = (page) => panel(page).locator('.transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2);

test('from the card: the agent transcript opens beside the conversation, follows it live, drills into a nested agent and back; Back, Esc and reload', async () => {
  const { page, server } = await openApp(browser);
  const at = Date.now() - 50_000;
  await openSession(page, server, agentMessages(at), { rev: 10 });

  // The card's Transcript button.
  const card = page.locator('.transcript-column > * .tool', { has: page.locator('.tool-target', { hasText: 'Survey the repo' }) }).first();
  await card.locator('.tool-row').click();
  await card.getByRole('button', { name: 'Transcript', exact: true }).click();
  await panel(page).waitFor();
  await page.waitForFunction(() => location.search === '?session=s-old&agent=a1');
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Survey the repo');
  assert.equal(await text(panel(page).locator('.agent-panel-kind')), 'Explore');
  assert.match(await text(panel(page).locator('.agent-status')), /^Running \d+s 5 tool uses · 24k tokens$/);
  assert.equal(await panel(page).getByRole('button', { name: 'Stop' }).count(), 1);

  // Its conversation: the task first, its thinking and reply, its steps, the nested agent.
  const column = panel(page).locator('.transcript-column');
  assert.equal(await text(column.locator('> :first-child .user-bubble')), PROMPT);
  assert.match(await text(column.locator('.thinking-toggle').first()), /^Thought for 3s/);
  assert.equal(await text(column.locator('.msg-assistant .assistant-model').first()), 'Explore', 'replies are the agent\'s');
  await column.getByText("I'll start with the top level.").waitFor();
  const running = column.locator('.activity').last();
  assert.match(await text(running.locator('.activity-head')), /^Working · Running node --test tests\/ · \d+s$/);
  assert.equal(await panelRow(page, 'Read the README').count(), 1);
  assert.equal(await panelRow(page, 'ls -la').count(), 1);
  assert.equal(await column.locator('.working').count(), 0, 'a running step shows itself');

  // Live: a new step arrives by delta and the view stays at the bottom.
  const now = Date.now();
  await emitDelta(page, {
    id: 's-old', rev: 11, base: 10, count: agentMessages(at).length + 2,
    fields: { updatedAt: now + 1000 },
    messages: [
      { id: 'm-b2', role: 'tool', tool: 'Bash', toolId: 'b2', parentToolId: 'a1', input: { command: 'node --test tests/' }, state: 'done', at: at + 30_000, endedAt: now, output: '# pass 42' },
      { id: 't5', role: 'assistant', text: 'All 42 tests pass.', parentToolId: 'a1', model: 'opus', at: now },
      { id: 'm-g1', role: 'tool', tool: 'Grep', toolId: 'g1', parentToolId: 'a1', input: { pattern: 'TODO' }, state: 'running', at: now },
    ],
  });
  await column.getByText('All 42 tests pass.').waitFor();
  await panelRow(page, 'TODO').waitFor();
  await waitFor(() => atBottom(page), { message: 'pinned to the bottom' });
  // Between steps: the working row.
  await emitDelta(page, {
    id: 's-old', rev: 12, base: 11, count: agentMessages(at).length + 2,
    fields: { updatedAt: now + 2000 },
    messages: [{ id: 'm-g1', role: 'tool', tool: 'Grep', toolId: 'g1', parentToolId: 'a1', input: { pattern: 'TODO' }, state: 'done', at: now, endedAt: now + 500, output: 'none' }],
  });
  await column.locator('.working').waitFor();
  assert.match(await text(column.locator('.working')), /^Thinking · \d+s$/);

  // The nested agent opens in the same panel, under it (its group has folded: the steps ended).
  await column.locator('.activity-head').first().click();
  await panelRow(page, 'Read the README').locator('.agent-open-btn').click();
  await page.waitForFunction(() => location.search === '?session=s-old&agent=a1&agent=a2');
  assert.equal(await text(panel(page).locator('.agent-crumbs')), 'Survey the repo Read the README');
  assert.match(await text(panel(page).locator('.agent-status')), /^Finished 1 tool use · 5\.0k tokens · 11s Full transcript$/);
  assert.equal(await text(column.locator('> :first-child .user-bubble')), 'Read README.md and sum it up.');
  assert.equal(await text(column.locator('.agent-report .markdown')), 'The README describes two packages.');
  assert.equal(await column.getByText('The README describes two packages.').count(), 1, 'its last reply shows once, as the report');
  assert.match(await text(column.locator('.agent-end')), /^Done 1 tool use · 5\.0k tokens · 11s$/);

  // Breadcrumb back, then Back closes the panel and Forward opens it again.
  await panel(page).getByRole('button', { name: 'Survey the repo' }).click();
  await page.waitForFunction(() => location.search === '?session=s-old&agent=a1');
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Survey the repo');
  await page.goBack();
  await panel(page).waitFor({ state: 'detached' });
  assert.equal(new URL(page.url()).search, '?session=s-old');
  await page.goForward();
  await panel(page).waitFor();
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Survey the repo');

  // Esc closes it, also from the composer while Claude works (the press does not count
  // toward stopping the turn).
  await emitDelta(page, { id: 's-old', rev: 13, base: 12, count: agentMessages(at).length + 2, fields: { status: 'running', updatedAt: now + 3000 } });
  await page.locator('.composer textarea').focus();
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });
  await page.waitForFunction(() => location.search === '?session=s-old');
  assert.equal(await page.locator('.esc-hint').count(), 0);
  assert.equal(await page.locator('.side-panel').count(), 0, 'the panel was closed before: it closes with the agent');
  await page.keyboard.press('Escape');
  await page.locator('.esc-hint').waitFor();

  // A reload opens the nested agent again, crumbs and all.
  await card.locator(':scope > .agent-open-btn').click();
  await column.locator('.activity-head').first().click();
  await panelRow(page, 'Read the README').locator('.agent-open-btn').click();
  await page.waitForFunction(() => location.search === '?session=s-old&agent=a1&agent=a2');
  await page.reload();
  await panel(page).waitFor();
  assert.equal(await text(panel(page).locator('.agent-crumbs')), 'Survey the repo Read the README');
  await column.getByText('The README describes two packages.').waitFor();
  // Closing goes back down the history it came up.
  await panel(page).getByRole('button', { name: 'Close agent transcript' }).click();
  await panel(page).waitFor({ state: 'detached' });
  await page.waitForFunction(() => location.search === '?session=s-old');
  assert.deepEqual(server.errors, []);
  assert.deepEqual(server.transcriptLoads, [], 'recorded steps need no transcript from disk');
  await page.context().close();
});

test('from the strip, the Agents view and the end row; Stop in the panel; the finished agent\'s report; the panel keeps its tab', async () => {
  const { page, context, server } = await openApp(browser);
  const stops = [];
  await context.route(`${ORIGIN}/api/sessions/*/agents/*/stop`, (route) => {
    stops.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ok: true } });
  });
  const at = Date.now() - 50_000;
  const session = await openSession(page, server, agentMessages(at));

  // The strip's line.
  await page.locator('.agents-strip .agent-line-open').click();
  await panel(page).waitFor();
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Survey the repo');
  await panel(page).getByRole('button', { name: 'Stop' }).click();
  await panel(page).locator('.agent-panel-stop:disabled').waitFor();
  assert.deepEqual(stops, ['/api/sessions/s-old/agents/a1/stop']);
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });

  // The Agents view's working agents.
  await page.locator('.topbar-agents').click();
  const dialog = page.locator('.agents-dialog');
  await dialog.locator('.agents-open', { hasText: 'Survey the repo' }).click();
  await dialog.waitFor({ state: 'detached' });
  await panel(page).waitFor();
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });

  // With the Files tab open, an agent takes the panel and gives it back when closed.
  await page.getByRole('button', { name: 'Show files and changes' }).click();
  await page.locator('.side-panel .panel-tabs').waitFor();
  await page.locator('.agents-strip .agent-line-open').click();
  await panel(page).waitFor();
  assert.equal(await page.locator('.side-panel .panel-tabs').count(), 0);

  // It finishes while open: the report and the end, with stats.
  await emitSession(page, { ...session, messages: agentMessages(at, { done: true }), backgroundAgents: 0, updatedAt: Date.now() + 2000 });
  const column = panel(page).locator('.transcript-column');
  await column.locator('.agent-end').waitFor();
  assert.match(await text(panel(page).locator('.agent-status')), /^Finished 5 tool uses · 31k tokens · 1m 4s Full transcript$/);
  assert.equal(await text(column.locator('.agent-report .markdown')), 'Two packages, core and cli, under packages/.');
  assert.equal(await column.getByText('Two packages, core and cli').count(), 1);
  assert.equal(await text(column.locator('.agent-end')), 'Done 5 tool uses · 31k tokens · 1m 4s');
  assert.equal(await panel(page).getByRole('button', { name: 'Stop' }).count(), 0);
  await panel(page).getByRole('button', { name: 'Close agent transcript' }).click();
  await page.locator('.side-panel .panel-tabs').waitFor();

  // The end row: its button opens the transcript; the row itself still expands in place.
  const end = page.locator('.agent-event');
  await end.locator('.agent-event-row').click();
  await end.locator('.agent-event-detail').getByText('Two packages,').first().waitFor();
  await end.getByRole('button', { name: 'Open the transcript of Survey the repo' }).click();
  await panel(page).waitFor();
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Survey the repo');
  assert.deepEqual(server.errors, []);
  await context.close();
});

test('a 300-step agent opens windowed and fills in as it scrolls up; widen; Claude Code\'s transcript for an agent without steps; a model agent', async () => {
  const { page, server } = await openApp(browser);
  const at = Date.now() - 3_600_000;
  const steps = [];
  for (let i = 0; i < 300; i++) {
    steps.push({ id: 'm-s' + i, role: 'tool', tool: 'Bash', toolId: 's' + i, parentToolId: 'a1', input: { command: `echo step-${i}` }, state: 'done', at: at + i * 1000, endedAt: at + i * 1000 + 500, output: 'ok' });
    steps.push({ id: 't' + i, role: 'assistant', text: `Step ${i} done.`, parentToolId: 'a1', model: 'opus', at: at + i * 1000 + 600 });
  }
  const long = {
    id: 'm-a1', role: 'tool', tool: 'Agent', toolId: 'a1', at, input: { description: 'Walk every file', subagent_type: 'general-purpose', prompt: 'Walk them all.' },
    state: 'done', endedAt: at + 400_000, output: 'Walked them all.', usage: { toolUses: 300, tokens: 90_000, durationMs: 400_000 },
  };
  // A foreground agent from an older session: its card, none of its steps.
  const quiet = { id: 'm-a3', role: 'tool', tool: 'Agent', toolId: 'a3', at, input: { description: 'Check the license', subagent_type: 'Explore', prompt: 'Which license?' }, state: 'done', endedAt: at + 9000, output: 'MIT.' };
  // A model agent on its own branch.
  const worker = {
    id: 'm-d1', role: 'tool', tool: 'mcp__meshy__delegate', toolId: 'd1', at, input: { model: 'luna', task: 'Write the parser tests.', description: 'Parser tests' }, agentModel: 'luna', agentId: 'luna-a1b2c3', taskId: 'luna-a1b2c3',
    state: 'done', endedAt: at + 64_000, output: 'Added 12 tests.\n\nFiles changed: `tests/parser.test.mjs`', usage: { toolUses: 1, tokens: 12_400, durationMs: 64_000 }, worktree: { branch: 'harbor/luna-a1b2c3', path: '/tmp/wt/luna-a1b2c3', commits: 1 },
  };
  const messages = [
    { id: 'u1', role: 'user', text: 'Survey the repo.', at: at - 5000, delivery: 'done' },
    long, ...steps,
    { id: 'r0', role: 'assistant', text: 'Now the license.', model: 'opus', at: at + 400_000 },
    quiet,
    { id: 'r00', role: 'assistant', text: 'And the parser tests.', model: 'opus', at: at + 410_000 },
    { id: 'm-c1', role: 'tool', tool: 'Bash', toolId: 'c1', parentToolId: 'd1', input: { command: 'npm test -- parser' }, state: 'done', at: at + 1000, endedAt: at + 2000, output: 'ok' },
    { id: 'tw', role: 'assistant', text: 'Added 12 tests.', parentToolId: 'd1', model: 'luna', at: at + 3000 },
    worker,
    { id: 'r1', role: 'assistant', text: 'Survey the repo: done.', model: 'opus', at: at + 500_000 },
  ];
  server.agentTranscripts['s-old a3'] = {
    toolId: 'a3', agentId: 'a0c0ffee', agentType: 'Explore', description: 'Check the license', omitted: 0, partial: false, truncated: false,
    messages: [
      { id: 'f1', role: 'tool', tool: 'Read', toolId: 'f-r1', parentToolId: 'a3', input: { file_path: '/repo/LICENSE' }, state: 'done', at: at + 2000, output: 'MIT License' },
      { id: 'f2', role: 'assistant', text: 'MIT.', parentToolId: 'a3', at: at + 8000 },
    ],
  };
  await openSession(page, server, messages);

  // Opens with the latest entries only; more join as it scrolls up.
  const started = Date.now();
  await page.locator('.transcript-column > * .tool', { has: page.locator('.tool-target', { hasText: 'Walk every file' }) }).first().locator('.agent-open-btn').click();
  const column = panel(page).locator('.transcript-column');
  await column.locator('.agent-end').waitFor();
  const opened = Date.now() - started;
  const first = await column.locator(':scope > *').count();
  assert.ok(first <= 60, `rendered ${first} entries at first`);
  assert.ok(opened < 3000, `opened in ${opened} ms`);
  assert.equal(await column.getByText('Step 299 done.').count(), 1, 'the latest steps');
  assert.equal(await column.getByText('Step 0 done.').count(), 0, 'not the first ones');
  assert.equal(await text(column.locator('.agent-report .markdown')), 'Walked them all.');
  await panel(page).locator('.transcript').evaluate((el) => {
    el.scrollTop = 0;
  });
  await waitFor(async () => (await column.locator(':scope > *').count()) > first, { message: 'older entries' });
  assert.equal(await column.locator('.agent-prompt').count(), 0, 'not up to the task yet');

  // Widen and narrow.
  const narrow = (await panel(page).boundingBox()).width;
  await panel(page).getByRole('button', { name: 'Widen the panel' }).click();
  await waitFor(async () => (await panel(page).boundingBox()).width > narrow + 100, { message: 'a wider panel' });
  await panel(page).getByRole('button', { name: 'Narrow the panel' }).click();
  await waitFor(async () => Math.abs((await panel(page).boundingBox()).width - narrow) < 2, { message: 'the panel back' });

  // No recorded steps: Claude Code's transcript is read and shown, marked as such.
  await page.locator('.transcript-column > * .tool', { has: page.locator('.tool-target', { hasText: 'Check the license' }) }).first().locator('.agent-open-btn').click();
  await panelRow(page, '/repo/LICENSE').waitFor();
  assert.deepEqual(server.transcriptLoads, ['s-old a3']);
  assert.equal(await text(panel(page).locator('.agent-files-note')), "From Claude Code's transcript of this agent.");
  assert.equal(await text(column.locator('.agent-report .markdown')), 'MIT.');
  assert.equal(await panel(page).locator('.agent-files-btn').count(), 0, 'nothing recorded to switch back to');

  // A recorded agent: the switch reads its transcript on request (none here: it says so).
  await page.goBack();
  await panel(page).waitFor();
  assert.equal(await text(panel(page).locator('.agent-panel-title')), 'Walk every file');
  await panel(page).locator('.agent-files-btn').click();
  await panel(page).locator('.agent-files-note', { hasText: 'Could not read' }).waitFor();
  assert.deepEqual(server.transcriptLoads, ['s-old a3', 's-old a1']);
  assert.equal(await text(panel(page).locator('.agent-files-note')), "Could not read Claude Code's transcript: Claude Code has no transcript of this agent.");
  assert.equal(await panelRow(page, 'echo step-299').count(), 1, 'the recorded steps stay');
  // Asked again once there is a file: read again and shown, with what was left out; then
  // back to the recorded steps.
  server.agentTranscripts['s-old a1'] = { toolId: 'a1', agentId: 'abc', description: 'Walk every file', omitted: 520, partial: false, truncated: true, messages: steps.slice(-80) };
  await panel(page).locator('.agent-files-btn').click();
  await panel(page).locator('.agent-files-note', { hasText: 'From Claude Code' }).waitFor();
  assert.equal(await text(panel(page).locator('.agent-files-note')), "From Claude Code's transcript of this agent. The first 520 messages are left out.");
  assert.equal(await panel(page).locator('.agent-files-btn').getAttribute('aria-pressed'), 'true');
  await panel(page).locator('.agent-files-btn').click();
  await panel(page).locator('.agent-files-note').waitFor({ state: 'detached' });
  assert.equal(await panel(page).locator('.agent-files-btn').getAttribute('aria-pressed'), 'false');

  // A model agent: its replies under its model's name, its branch in the status line.
  await page.locator('.transcript-column > * .tool', { has: page.locator('.tool-target', { hasText: 'Parser tests' }) }).first().locator('.agent-open-btn').click();
  await panel(page).locator('.agent-status-branch').waitFor();
  assert.equal(await text(panel(page).locator('.agent-panel-kind')), 'GPT-6 Luna agent');
  assert.equal(await text(panel(page).locator('.agent-status-branch')), 'harbor/luna-a1b2c3');
  assert.equal(await text(column.locator('> :first-child .user-bubble')), 'Write the parser tests.');
  assert.match(await text(column.locator('.agent-report .markdown')), /^Added 12 tests\. Files changed: tests\/parser\.test\.mjs$/);
  assert.equal(await panel(page).locator('.agent-files-btn').count(), 0, 'Claude Code keeps no transcript of a model agent');
  assert.deepEqual(server.transcriptLoads, ['s-old a3', 's-old a1', 's-old a1']);
  // The browser logs the 404 asked for above.
  assert.deepEqual(server.errors.filter((error) => !/status of 404/.test(error)), []);
  await page.context().close();
});
