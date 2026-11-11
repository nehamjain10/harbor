// Real-browser checks for subagents against the mocked v2 server (harness.mjs): the
// background agents strip (what each does, Stop), the status pill and sidebar dot while
// only agents work, an approval asked from inside an agent, a finished agent's stats,
// and the transcript row marking a background agent's end. Run with `npm run test:browser`.
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

function agentMessages(at) {
  const agent = (id, description, type, fields) => ({ id: 'm-' + id, role: 'tool', tool: 'Agent', toolId: id, input: { description, subagent_type: type, prompt: 'Go.' }, at, ...fields });
  return [
    { id: 'u1', role: 'user', text: 'Survey the repo and draft notes, in the background.', at: at - 5000, delivery: 'done' },
    agent('a0', 'Check the tests', 'general-purpose', { state: 'done', endedAt: at + 64_000, output: 'All green.', usage: { toolUses: 3, tokens: 12_400, durationMs: 64_000 } }),
    agent('a1', 'Survey the repo', 'Explore', { state: 'running', background: true, taskId: 't1', output: 'Async agent launched successfully.' }),
    agent('a2', 'Draft the notes', 'general-purpose', { state: 'running', background: true, taskId: 't2', output: 'Async agent launched successfully.' }),
    { id: 'c1', role: 'tool', tool: 'Bash', toolId: 'c1', parentToolId: 'a1', input: { command: 'ls -la' }, state: 'running', at: at + 1000 },
    { id: 'c2', role: 'tool', tool: 'Bash', toolId: 'c2', parentToolId: 'a2', input: { command: 'touch notes.md' }, state: 'running', at: at + 1000 },
    { id: 'r1', role: 'assistant', text: 'Both agents are working.', model: 'opus', at: at + 2000 },
    { id: 'turn1', role: 'turn', duration: 3000, outputTokens: 100, cost: 0, model: 'opus' },
  ];
}

test('background agents: strip with steps and Stop, agent-aware approval, stats, pill and dot; their end shows in the transcript', async () => {
  const { page, context, server } = await openApp(browser);
  const stops = [];
  await context.route(`${ORIGIN}/api/sessions/*/agents/*/stop`, (route) => {
    stops.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ok: true } });
  });
  const at = Date.now() - 30_000;
  const session = server.sessions.find((s) => s.id === 's-old');
  const pending = [
    {
      id: 'p1',
      kind: 'permission',
      tool: 'Bash',
      input: { command: 'touch notes.md', description: 'Create the notes file' },
      toolUseID: 'c2',
      at: Date.now(),
      agent: { toolId: 'a2', description: 'Draft the notes', subagentType: 'general-purpose' },
    },
  ];
  Object.assign(session, { messages: agentMessages(at), status: 'waiting', pending, backgroundAgents: 2 });
  await page.locator('.session-main', { hasText: session.title }).click();
  await page.waitForFunction(() => location.search === '?session=s-old');

  // The strip: one line per background agent, with what it does now.
  const lines = page.locator('.agents-strip .agent-line');
  await lines.first().waitFor();
  assert.equal(await lines.count(), 2);
  assert.match(await text(lines.nth(0)), /^Survey the repo Explore Running ls -la \d+s$/);
  assert.match(await text(lines.nth(1)), /^Draft the notes general-purpose Needs approval \d+s$/);
  assert.equal(await lines.nth(1).evaluate((el) => el.classList.contains('is-awaiting')), true);

  // The approval card names the agent that asks; so does its (folded) row.
  assert.equal(await text(page.locator('.approval .approval-agent')), 'Draft the notes general-purpose');
  const asking = page.locator('.tool', { has: page.locator('.tool-target', { hasText: 'Draft the notes' }) }).first();
  assert.equal(await text(asking.locator('.tool-row .tool-status')), 'Needs approval');

  // A finished agent says what it took.
  const finished = page.locator('.tool', { has: page.locator('.tool-target', { hasText: 'Check the tests' }) }).first();
  assert.equal(await text(finished.locator('.tool-row .tool-meta')), '3 tool uses · 12k tokens · 1m 4s');

  // Stop one agent from the strip.
  await page.getByRole('button', { name: 'Stop agent Survey the repo' }).click();
  await page.waitForFunction(() => document.querySelector('.agent-line-stop')?.disabled === true);
  assert.deepEqual(stops, ['/api/sessions/s-old/agents/a1/stop']);

  // Between turns, with nothing to approve: the session still reads as working.
  const idle = { ...session, status: 'idle', pending: [], updatedAt: Date.now() + 1000 };
  await emitSession(page, idle);
  await page.waitForFunction(() => document.querySelector('.status-pill')?.textContent.includes('2 agents running'));
  assert.equal(await page.locator('.status-pill').evaluate((el) => el.classList.contains('pill-running')), true);
  assert.equal(await page.locator('.session-row', { hasText: session.title }).locator('.status-dot.dot-running').count(), 1);

  // Both end: the strip goes, and each end is marked where Claude picks up the report.
  const messages = agentMessages(at).map((m) => {
    if (m.toolId === 'a1') return { ...m, state: 'error', stopped: true, endedAt: at + 5000 };
    if (m.toolId === 'a2') return { ...m, state: 'done', output: 'Notes drafted.', endedAt: at + 9000, usage: { toolUses: 1, tokens: 900, durationMs: 9000 } };
    if (m.role === 'tool' && m.parentToolId) return { ...m, state: 'done' };
    return m;
  });
  messages.push(
    { id: 'n1', role: 'notice', level: 'info', text: 'Background agent “Survey the repo” was stopped.', agentToolId: 'a1', at: at + 5000 },
    { id: 'n2', role: 'notice', level: 'info', text: 'Background agent “Draft the notes” finished.', agentToolId: 'a2', at: at + 9000 },
    { id: 'r2', role: 'assistant', text: 'The notes are ready.', model: 'opus', at: at + 10_000 },
    { id: 'turn2', role: 'turn', duration: 1000, outputTokens: 50, cost: 0, model: 'opus' },
  );
  await emitSession(page, { ...idle, messages, backgroundAgents: 0, updatedAt: Date.now() + 2000 });
  await page.locator('.agent-event').nth(1).waitFor();
  assert.equal(await page.locator('.agents-strip').count(), 0);
  assert.equal(await text(page.locator('.status-pill')), 'Ready');
  const events = page.locator('.agent-event');
  // One line each, not the agent's whole card again.
  assert.equal(await text(events.nth(0).locator('.agent-event-row')), 'Survey the repo stopped');
  assert.equal(await events.nth(0).locator('.tool-row').count(), 0);
  assert.equal(await text(events.nth(1).locator('.agent-event-row')), 'Draft the notes finished 1 tool use · 900 tokens · 9s');
  // It opens on the agent's own steps and report.
  await events.nth(1).locator('.agent-event-row').click();
  await events.nth(1).locator('.agent-event-detail').getByText('Notes drafted.').waitFor();
  assert.deepEqual(server.errors, []);
  await context.close();
});
