// Subagent flows: background agents running in parallel past their turn (strip, status
// pill, their ends marked in the transcript and Claude following up), stopping one from
// the strip, an approval asked from inside an agent, and a running agent's transcript
// followed in the side panel (and read back from Claude Code's own files).
import assert from 'node:assert/strict';
import { createSession, flow, send, textOf, toolsOf, turnsOf, waitFor, waitForPending, waitForText, waitForTurns } from './helpers.mjs';

export function agentFlows(ctx) {
  flow(ctx, 'background agents: they outlive their turn in the strip and pill, one is stopped from the strip, their ends are marked and Claude follows up', async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Agents' });
    const { page } = await openSession(session.id);

    // Two agents at once, in the background: the turn ends, they keep working.
    await send(page, 'Two probes please. [[mock:agents]]');
    let current = await waitForTurns(stack, session.id, 1);
    const agents = toolsOf(current, 'Agent');
    assert.deepEqual(
      agents.map((m) => [m.input.description, m.background]),
      [
        ['First probe', true],
        ['Second probe', true],
      ],
    );
    assert.ok(current.backgroundAgents >= 1, 'still running after the turn');
    const strip = page.locator('.agents-strip');
    await strip.waitFor();
    await waitForText(page.locator('.status-pill'), /agents? running$/);
    await waitForText(strip.locator('.agent-line').last(), /^Second probe Explore .+ \d+s$/);

    // Both end on their own; each end is marked, then Claude reads the report.
    current = await waitFor(
      async () => {
        const s = await stack.api('GET', `sessions/${session.id}`);
        return turnsOf(s).length >= 3 && s.status === 'idle' && s.backgroundAgents === 0 ? s : null;
      },
      { timeout: 30_000, message: 'both agents to finish and Claude to follow up' },
    );
    for (const agent of toolsOf(current, 'Agent')) {
      assert.equal(agent.state, 'done');
      assert.equal(agent.usage.toolUses, 1);
    }
    await strip.waitFor({ state: 'detached' });
    await waitForText(page.locator('.status-pill'), /^Ready$/);
    const events = page.locator('.agent-event');
    await waitFor(async () => (await events.count()) === 2, { message: 'two agent end rows' });
    assert.match(await textOf(events.nth(0).locator('.agent-event-row')), /^First probe finished 1 tool use · .+ tokens · \d+s$/);
    assert.match(await textOf(events.nth(1).locator('.agent-event-row')), /^Second probe finished/);

    // A slow one, stopped from the strip; the session carries on.
    await send(page, 'One more. [[mock:agent-slow]]');
    const stop = page.getByRole('button', { name: 'Stop agent Check the workspace slowly' });
    await stop.waitFor();
    await stop.click();
    current = await waitFor(
      async () => {
        const s = await stack.api('GET', `sessions/${session.id}`);
        const slow = toolsOf(s, 'Agent').find((m) => m.input.description === 'Check the workspace slowly');
        return slow?.stopped && s.status === 'idle' ? s : null;
      },
      { timeout: 20_000, message: 'the agent to stop' },
    );
    await waitFor(async () => (await events.count()) === 3, { message: 'the stopped agent row' });
    await waitForText(events.nth(2).locator('.agent-event-row'), /^Check the workspace slowly stopped/);
    await strip.waitFor({ state: 'detached' });
  });

  flow(ctx, "a running background agent's transcript opens from the strip and follows its steps to the report; Claude Code's own transcript of it matches", async ({ stack, openSession }) => {
    const session = await createSession(stack, { title: 'Agent transcript' });
    const { page } = await openSession(session.id);
    await send(page, 'Survey it in steps. [[mock:agent-steps:3]]');

    // Open it from the strip while it works.
    const line = page.locator('.agents-strip .agent-line-open', { hasText: 'Survey in steps' });
    await line.waitFor({ timeout: 30_000 });
    await line.click();
    const panel = page.locator('.side-panel.is-agent');
    await panel.waitFor();
    const [agent] = toolsOf(await stack.api('GET', `sessions/${session.id}`), 'Agent');
    await page.waitForFunction((toolId) => new URLSearchParams(location.search).getAll('agent').join() === toolId, agent.toolId);
    assert.equal(await textOf(panel.locator('.agent-panel-title')), 'Survey in steps');
    const column = panel.locator('.transcript-column');
    assert.match(await textOf(column.locator('.agent-prompt .user-bubble')), /Survey the workspace step by step\.$/);

    // Its steps arrive while the panel is open (the second joins the first one's group),
    // then its report and the end.
    await column.locator('.tool-target', { hasText: 'echo step-one' }).first().waitFor({ timeout: 20_000 });
    await waitForText(panel.locator('.agent-status'), /^Running \d+s/);
    await column.getByText('Surveying.').waitFor();
    await waitForText(column.locator('.activity-head'), /^(Ran 2 commands|Working · Running echo step-two)/, { timeout: 20_000 });
    assert.equal(await column.locator('.agent-report').count(), 0, 'no report while it runs');
    await waitForText(column.locator('.agent-report .markdown'), /^Survey complete: two steps ran\.$/, { timeout: 30_000 });
    assert.equal(await column.getByText('Survey complete: two steps ran.').count(), 1, 'its last reply shows once, as the report');
    await waitForText(column.locator('.agent-end'), /^Done 2 tool uses · .+ tokens · \d+s$/);
    await waitForText(panel.locator('.agent-status'), /^Finished 2 tool uses/);

    // Claude Code's transcript of the agent (read from its files by the server) has the
    // same steps, and the panel shows it on request. The file can trail the report a moment.
    const files = await waitFor(
      async () => {
        const read = await stack.api('GET', `sessions/${session.id}/agents/${agent.toolId}/transcript`);
        return read.messages.some((m) => m.role === 'assistant' && m.text === 'Survey complete: two steps ran.') ? read : null;
      },
      { timeout: 10_000, message: "the report in Claude Code's transcript file" },
    );
    assert.equal(files.toolId, agent.toolId);
    assert.equal(files.truncated, false);
    assert.deepEqual(
      toolsOf(files, 'Bash').map((m) => [m.input.command, m.state, m.parentToolId]),
      [
        ['echo step-one', 'done', agent.toolId],
        ['echo step-two', 'done', agent.toolId],
      ],
    );
    await panel.getByRole('button', { name: 'Full transcript' }).click();
    await waitForText(panel.locator('.agent-files-note'), /^From Claude Code's transcript of this agent\.$/);
    await waitForText(column.locator('.activity-head'), /^Ran 2 commands$/);
    await waitForText(column.locator('.agent-report .markdown'), /^Survey complete: two steps ran\.$/);

    // Esc closes it.
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('agent'));
  });

  flow(ctx, 'an approval asked from inside an agent names the agent on the card and its row', async ({ stack, openSession }) => {
    const session = await createSession(stack, { mode: 'default', title: 'Agent asks' });
    const { page } = await openSession(session.id);
    await send(page, 'Create it via an agent. [[mock:agent-ask]]');
    const waiting = await waitForPending(stack, session.id);
    const [agent] = toolsOf(waiting, 'Agent');
    assert.deepEqual(waiting.pending[0].agent, { toolId: agent.toolId, description: 'Touch a file', subagentType: 'general-purpose' });
    const card = page.locator('.approval');
    await waitForText(card.locator('.approval-agent'), /^Touch a file general-purpose$/);
    await waitForText(page.locator('.tool', { has: page.locator('.tool-target', { hasText: 'Touch a file' }) }).locator('.tool-row .tool-status'), /^Needs approval$/);
    await card.getByRole('button', { name: /Allow once/ }).click();
    const done = await waitForTurns(stack, session.id, 1);
    assert.equal(toolsOf(done, 'Agent')[0].state, 'done');
    assert.equal(toolsOf(done, 'Bash')[0].state, 'done');
  });
}
