// Forking: real Claude Code turns write the transcript, the SDK forks it, and the fork's
// next turn shows what the model is sent: the history before the fork point only.
import assert from 'node:assert/strict';
import { createSession, flow, turnRequests, turnsOf, waitFor, waitForText, waitForTurns, sendAndWait } from './helpers.mjs';

// Everything the model was sent in a request, as one string.
const history = (request) => JSON.stringify(request.body?.messages ?? []);

export function forkFlows(ctx) {
  flow(ctx, 'fork from here: the new session keeps what came before, the message comes back to edit, the original is untouched', async ({ stack, openSession }) => {
    const repo = stack.makeRepo('fork');
    const session = await createSession(stack, { cwd: repo });
    const { page } = await openSession(session.id);
    await sendAndWait(stack, page, session.id, 'alpha one');
    await sendAndWait(stack, page, session.id, 'bravo two');
    await sendAndWait(stack, page, session.id, 'charlie three');

    const bubble = page.locator('.msg-user', { hasText: 'bravo two' });
    await bubble.hover();
    await bubble.getByRole('button', { name: /Fork from here/ }).click();
    await page.waitForFunction((id) => {
      const open = new URLSearchParams(location.search).get('session');
      return open && open !== id;
    }, session.id);
    const forkId = new URL(page.url()).searchParams.get('session');
    const input = page.locator('.composer-input');
    await waitFor(async () => (await input.inputValue()) === 'bravo two', { message: 'the message in the composer' });
    await waitForText(page.locator('.crumb-title'), /\(fork\)$/);
    await waitForText(page.locator('.notice').last(), /Forked from/);

    const fork = await stack.api('GET', `sessions/${forkId}`);
    assert.deepEqual(
      fork.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['alpha one'],
    );
    assert.equal(fork.forkedFrom.id, session.id);

    // The edited message goes out from the fork; Claude Code resumes the forked transcript.
    await input.fill('bravo edited');
    await input.press('Enter');
    await waitForTurns(stack, forkId, 2);
    const sent = history(turnRequests(stack).at(-1));
    assert.match(sent, /alpha one/);
    assert.match(sent, /bravo edited/);
    assert.doesNotMatch(sent, /bravo two/);
    assert.doesNotMatch(sent, /charlie three/);

    // The original goes on as before.
    const original = await stack.api('GET', `sessions/${session.id}`);
    assert.equal(turnsOf(original).length, 3);
    assert.deepEqual(
      original.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['alpha one', 'bravo two', 'charlie three'],
    );

    // A whole fork carries everything.
    const whole = await stack.api('POST', `sessions/${session.id}/fork`, {});
    await stack.api('POST', `sessions/${whole.session.id}/messages`, { text: 'delta four' });
    await waitForTurns(stack, whole.session.id, 4);
    const all = history(turnRequests(stack).at(-1));
    for (const text of ['alpha one', 'bravo two', 'charlie three', 'delta four']) assert.match(all, new RegExp(text));
  });
}
