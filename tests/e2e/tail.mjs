// Tail loading against the real server: a long session (a Codex rollout of many turns,
// imported, so no model runs; an import keeps the last 500 messages) is answered in its
// tail form and in older pages that add up to the whole list; the browser opens it with
// its recent messages and loads the rest as the reader scrolls up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flow, waitFor } from './helpers.mjs';

const ROLLOUT_ID = '019b0e2e-0000-7000-8000-0000000000a1';
const TURNS = 300;

/** A Codex rollout of `TURNS` question-and-answer turns in the stack's Codex home. */
function writeLongRollout(stack, cwd) {
  const start = Date.parse('2026-10-05T09:00:00.000Z');
  const line = (index, type, payload) => JSON.stringify({ timestamp: new Date(start + index * 1000).toISOString(), type, payload }) + '\n';
  const lines = [line(0, 'session_meta', { id: ROLLOUT_ID, timestamp: new Date(start).toISOString(), cwd, originator: 'codex-tui', cli_version: '0.200.0' })];
  for (let i = 0; i < TURNS; i++) {
    lines.push(line(2 * i + 1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Question ${i}` }] }));
    lines.push(line(2 * i + 2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Answer ${i}` }], phase: 'final_answer' }));
  }
  const day = path.join(stack.codexHome, 'sessions', '2026', '10', '05');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-10-05T09-00-00-${ROLLOUT_ID}.jsonl`), lines.join(''));
}

export function tailFlows(ctx) {
  flow(ctx, 'a long session opens with its tail; older pages load from the server as the reader scrolls up', async ({ stack, openSession }) => {
    writeLongRollout(stack, stack.makeRepo('tail'));
    const { sessions } = await stack.api('POST', 'import', { source: 'codex', ids: [ROLLOUT_ID], model: 'luna' });
    const id = sessions[0].id;

    // The server: a tail and the pages before it add up to the full form.
    const full = await stack.api('GET', `sessions/${id}`);
    const ids = full.messages.map((m) => m.id);
    const questions = full.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.ok(ids.length > 400 && questions.at(-1) === `Question ${TURNS - 1}`, `${ids.length} messages`);
    const tail = await stack.api('GET', `sessions/${id}?tail=300`);
    assert.equal(tail.messageCount, ids.length);
    assert.ok(tail.messagesFrom > 0 && ids.length - tail.messagesFrom >= 300 && ids.length - tail.messagesFrom < 600, `from ${tail.messagesFrom}`);
    assert.deepEqual(tail.messages.map((m) => m.id), ids.slice(tail.messagesFrom));
    assert.equal(tail.messages[0].role, 'user', 'cut where a turn starts');
    assert.equal(tail.rev, full.rev);
    assert.deepEqual(await stack.api('GET', `sessions/${id}?tail=300&rev=${tail.rev}`), { id, rev: tail.rev, unchanged: true });
    let before = tail.messagesFrom;
    const held = [...tail.messages.map((m) => m.id)];
    while (before > 0) {
      const page = await stack.api('GET', `sessions/${id}/messages?before=${before}&limit=400&beforeId=${encodeURIComponent(held[0])}`);
      assert.equal(page.before, before);
      assert.equal(page.from + page.messages.length, before);
      held.unshift(...page.messages.map((m) => m.id));
      before = page.from;
    }
    assert.deepEqual(held, ids);

    // The browser: the recent end first, the rest as the reader scrolls up.
    const { page } = await openSession(id);
    const column = page.locator('.transcript-column').first();
    await column.locator('.msg-user', { hasText: `Question ${TURNS - 1}` }).waitFor();
    const first = new RegExp(`^${questions[0]}$`);
    assert.equal(await column.locator('.msg-user .user-bubble', { hasText: first }).count(), 0);
    const pages = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/sessions/${id}/messages` && request.method() === 'GET') pages.push(Number(url.searchParams.get('before')));
    });
    await waitFor(
      async () => {
        await page.locator('.transcript').first().evaluate((el) => (el.scrollTop = 0));
        return (await column.locator('.msg-user .user-bubble', { hasText: first }).count()) > 0;
      },
      { timeout: 30_000, interval: 100, message: 'the first question' },
    );
    assert.equal(await column.locator('.msg-user').count(), questions.length);
    assert.deepEqual(pages, [tail.messagesFrom], 'one older page, before the tail');
  });
}
