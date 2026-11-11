// Real-browser checks for model agents against the mocked v2 server (harness.mjs): the
// Agents view (topbar, `/agents`, palette) and a model agent's card in the transcript
// and the strip (model badge, steps, task, branch, Stop, report and the end event).
// Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, buildApp, emitSession, launch, openApp } from './harness.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
const DELEGATE = 'mcp__meshy__delegate';

function workerMessages(at) {
  const worker = (id, model, description, fields) => ({
    id: 'm-' + id,
    role: 'tool',
    tool: DELEGATE,
    toolId: id,
    input: { model, task: `Write the tests for ${description.toLowerCase()}. Only touch tests/.`, description },
    at,
    background: true,
    agentModel: model,
    agentId: `${model}-a1b2c3`,
    taskId: `${model}-a1b2c3`,
    ...fields,
  });
  return [
    { id: 'u1', role: 'user', text: 'Split this across a Luna and a DeepSeek worker.', at: at - 5000, delivery: 'done' },
    worker('d1', 'luna', 'Parser tests', {
      state: 'running',
      output: 'Started worker luna-a1b2c3 (GPT-6 Luna agent, “Parser tests”).',
      worktree: { branch: 'harbor/luna-a1b2c3', path: '/tmp/wt/luna-a1b2c3' },
      progress: { description: 'Working', toolUses: 1, tokens: 3200, lastTool: 'Bash' },
    }),
    worker('d2', 'deepseek', 'Lexer tests', { state: 'running', output: 'Started worker deepseek-a1b2c3.' }),
    { id: 'c1', role: 'tool', tool: 'Bash', toolId: 'c1', parentToolId: 'd1', input: { command: 'npm test -- parser' }, state: 'running', at: at + 1000 },
    { id: 'r1', role: 'assistant', text: 'Both workers are running.', model: 'opus', at: at + 2000 },
    { id: 'turn1', role: 'turn', duration: 3000, outputTokens: 100, cost: 0, model: 'opus' },
  ];
}

test('the Agents view lists model agents, Claude Code subagents and what works now; topbar, /agents and the palette open it', async () => {
  const { page, server } = await openApp(browser);
  await page.context().route('**/api/commands**', (route) => route.fulfill({ json: { commands: [] } }));
  const session = server.sessions.find((s) => s.id === 's-old');
  Object.assign(session, { messages: workerMessages(Date.now() - 30_000), backgroundAgents: 2 });
  await page.locator('.session-main', { hasText: session.title }).click();
  await page.waitForFunction(() => location.search === '?session=s-old');

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const dialog = page.locator('dialog.agents-dialog');
  await dialog.locator('.agents-section[aria-label="Claude Code subagents"] .agents-item').first().waitFor();
  assert.equal(await text(dialog.locator('#dialog-title')), 'Agents');

  const working = dialog.locator('.agents-section[aria-label="Working now"] .agents-item');
  assert.equal(await working.count(), 2);
  assert.equal(await text(working.nth(0)), 'Parser tests GPT-6 Luna agent');

  const models = dialog.locator('.agents-section[aria-label="Model agents"] .agents-item');
  assert.equal(await models.count(), server.info.models.length);
  assert.equal(await text(models.nth(4).locator('.agents-item-title')), 'GPT-6 Luna agent ChatGPT subscription luna');
  assert.equal(await text(models.nth(0).locator('.agents-item-title')), 'Claude Opus 5.5 agent Claude subscription opus');

  const subagents = dialog.locator('.agents-section[aria-label="Claude Code subagents"] .agents-item');
  assert.equal(await subagents.count(), 3);
  assert.equal(await text(subagents.nth(0).locator('.agents-item-title')), 'Explore Session model');
  assert.equal(await text(subagents.nth(2).locator('.agents-item-title')), 'statusline-setup sonnet');
  assert.deepEqual(server.agentLoads, [session.cwd]);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // `/agents` in the composer.
  const input = page.locator('.composer textarea');
  await input.fill('/agents');
  await input.press('Enter');
  await dialog.waitFor();
  assert.equal(await input.inputValue(), '');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // The palette.
  await page.keyboard.press('Control+k');
  await page.locator('.palette input').fill('show agents');
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  assert.equal(server.agentLoads.length, 1, 'the list is cached');
  assert.deepEqual(server.errors, []);
});

test('a model agent shows as an agent card named by its model: steps, task, branch, Stop, strip; then its report and end', async () => {
  const { page, context, server } = await openApp(browser);
  const stops = [];
  await context.route(`${ORIGIN}/api/sessions/*/agents/*/stop`, (route) => {
    stops.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ok: true } });
  });
  const at = Date.now() - 30_000;
  const session = server.sessions.find((s) => s.id === 's-old');
  Object.assign(session, { messages: workerMessages(at), status: 'idle', backgroundAgents: 2 });
  await page.locator('.session-main', { hasText: session.title }).click();
  await page.waitForFunction(() => location.search === '?session=s-old');

  // The strip names each worker's model and what it does.
  const lines = page.locator('.agents-strip .agent-line');
  await lines.first().waitFor();
  assert.equal(await lines.count(), 2);
  assert.match(await text(lines.nth(0)), /^Parser tests GPT-6 Luna agent Running npm test -- parser \d+s$/);
  assert.match(await text(lines.nth(1)), /^Lexer tests DeepSeek V4.1 Flash agent Starting… \d+s$/);
  assert.match(await text(page.locator('.status-pill')), /2 agents running/);

  // The card row: verb, label, model badge, steps; no "background" badge.
  const card = page.locator('.tool', { has: page.locator('.tool-target', { hasText: 'Parser tests' }) }).first();
  assert.match(await text(card.locator('.tool-row')), /^Running agent Parser tests GPT-6 Luna agent 1 step \d+s$/);
  assert.equal(await card.locator('.tool-badge.badge-model').count(), 1);
  assert.equal(await text(card.locator('.tool-subline')), 'Running npm test -- parser');

  await card.locator('.tool-row').click();
  const detail = card.locator('.tool-detail').first();
  await detail.waitFor();
  assert.match(await text(detail.locator('.agent-head')), /^GPT-6 Luna agent Parser tests Transcript Stop agent$/);
  assert.equal(await text(detail.locator('.tool-note').first()), 'Working on branch harbor/luna-a1b2c3 in /tmp/wt/luna-a1b2c3');
  await detail.getByRole('button', { name: 'Task' }).click();
  assert.equal(await text(detail.locator('.prompt-text')), 'Write the tests for parser tests. Only touch tests/.');
  await detail.getByRole('button', { name: 'Stop agent' }).click();
  await detail.locator('.agent-stop:disabled').waitFor();
  assert.deepEqual(stops, ['/api/sessions/s-old/agents/d1/stop']);

  // Both end: the strip goes, the end shows with the model's name, the card holds the report.
  const report = 'Added 12 parser tests; all pass.\n\nFiles changed: `tests/parser.test.mjs`\n\nCommands (1): `npm test -- parser`';
  const messages = workerMessages(at).map((m) => {
    if (m.toolId === 'd1') {
      return { ...m, state: 'done', output: report, endedAt: at + 64_000, usage: { toolUses: 3, tokens: 12_400, durationMs: 64_000 }, worktree: { branch: 'harbor/luna-a1b2c3', path: '/tmp/wt/luna-a1b2c3', commits: 1 }, progress: undefined };
    }
    if (m.toolId === 'd2') return { ...m, state: 'error', stopped: true, output: 'Stopped by the user before it finished.', endedAt: at + 5000 };
    if (m.parentToolId) return { ...m, state: 'done', endedAt: at + 3000 };
    return m;
  });
  messages.push(
    { id: 'n1', role: 'notice', level: 'info', text: 'DeepSeek V4.1 Flash agent “Lexer tests” was stopped.', agentToolId: 'd2', at: at + 5000 },
    { id: 'n2', role: 'notice', level: 'info', text: 'GPT-6 Luna agent “Parser tests” finished.', agentToolId: 'd1', at: at + 64_000 },
    { id: 'r2', role: 'assistant', text: 'Merged the parser tests.', model: 'opus', at: at + 65_000 },
    { id: 'turn2', role: 'turn', duration: 1000, outputTokens: 50, cost: 0, model: 'opus' },
  );
  await emitSession(page, { ...session, messages, backgroundAgents: 0, updatedAt: Date.now() + 2000 });
  await page.locator('.agent-event').nth(1).waitFor();
  assert.equal(await page.locator('.agents-strip').count(), 0);
  const events = page.locator('.agent-event');
  // One line each: the task's label, the model, how it ended and its stats.
  assert.match(await text(events.nth(0).locator('.agent-event-row')), /^Lexer tests DeepSeek V4.1 Flash agent stopped/);
  assert.equal(await text(events.nth(1).locator('.agent-event-row')), 'Parser tests GPT-6 Luna agent finished 3 tool uses · 12k tokens · 1m 4s');
  await events.nth(1).locator('.agent-event-row').click();
  const finished = events.nth(1).locator('.agent-event-detail');
  await finished.getByText('Added 12 parser tests; all pass.').waitFor();
  assert.equal(await text(finished.locator('.tool-note').first()), 'Branch harbor/luna-a1b2c3 · 1 commit in /tmp/wt/luna-a1b2c3');
  assert.equal(await finished.getByRole('button', { name: 'Stop agent' }).count(), 0);
  assert.deepEqual(server.errors, []);
  await context.close();
});
