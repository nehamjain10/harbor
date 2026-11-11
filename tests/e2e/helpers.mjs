// Small helpers shared by the e2e flows: polling, turns, the composer, error checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

export const TURN_TIMEOUT_MS = 60_000;

/** Polls `check` until it returns something truthy, and returns that. */
export async function waitFor(check, { timeout = 15_000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${message}${lastError ? ` (last error: ${lastError.message})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export const turnsOf = (session) => session.messages.filter((m) => m.role === 'turn');
export const toolsOf = (session, name) => session.messages.filter((m) => m.role === 'tool' && (!name || m.tool === name));
export const lastAssistant = (session) => session.messages.findLast((m) => m.role === 'assistant' && !m.parentToolId)?.text;

/** Waits until the session has finished `count` turns and is idle; returns the session. */
export function waitForTurns(stack, id, count, { timeout = TURN_TIMEOUT_MS } = {}) {
  return waitFor(
    async () => {
      const session = await stack.api('GET', `sessions/${id}`);
      return turnsOf(session).length >= count && session.status === 'idle' ? session : null;
    },
    { timeout, interval: 100, message: `turn ${count} of session ${id} to finish` },
  );
}

/** Waits until the session asks for an approval; returns the session. */
export function waitForPending(stack, id, { timeout = TURN_TIMEOUT_MS } = {}) {
  return waitFor(
    async () => {
      const session = await stack.api('GET', `sessions/${id}`);
      return session.status === 'waiting' && session.pending.length ? session : null;
    },
    { timeout, interval: 100, message: `an approval request in session ${id}` },
  );
}

/**
 * Registers one e2e flow. `fn` gets `{stack, openPage, openSession}`; every page it
 * opens is checked for browser errors and closed afterwards, and no session may have
 * used a direct Claude model. On failure a screenshot of each page and the server log go
 * to $E2E_ARTIFACTS (when set; E2E_SCREENSHOTS=1 also keeps passing flows' last state).
 */
export function flow(ctx, name, options, fn) {
  if (typeof options === 'function') [options, fn] = [{}, options];
  test(name, { timeout: 180_000, ...options }, async () => {
    const opened = [];
    const track = async (promise) => {
      const result = await promise;
      opened.push(result);
      return result;
    };
    const { stack } = ctx;
    const artifacts = process.env.E2E_ARTIFACTS;
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80);
    const screenshots = async (suffix) => {
      fs.mkdirSync(artifacts, { recursive: true });
      for (const [index, { page }] of opened.entries()) {
        await page.screenshot({ path: path.join(artifacts, `${slug}-${index}${suffix}.png`) }).catch(() => {});
      }
    };
    try {
      await fn({
        stack,
        openPage: (options) => track(stack.openPage(options)),
        openSession: (id, options) => track(openSession(stack, id, options)),
      });
      for (const { errors } of opened) assertNoBrowserErrors(errors);
      await stack.assertNoDirectModels();
      // E2E_SCREENSHOTS=1 keeps the final state of passing flows too (for review).
      if (artifacts && process.env.E2E_SCREENSHOTS) await screenshots('-final');
    } catch (error) {
      if (artifacts) {
        await screenshots('-failed');
        fs.writeFileSync(path.join(artifacts, `${slug}-server.log`), stack.serverLog());
      }
      throw error;
    } finally {
      for (const { context } of opened) await context.close().catch(() => {});
    }
  });
}

/** Creates a session through the API (always on a gateway model). */
export async function createSession(stack, { cwd, model = 'luna', mode = 'bypassPermissions', title } = {}) {
  assert.ok(!['opus', 'sonnet', 'fable'].includes(model), 'e2e sessions use gateway models only');
  return stack.api('POST', 'sessions', { cwd: cwd || stack.makeRepo(), model, mode, ...(title ? { title } : {}) });
}

/** Opens a session in a fresh page and waits for its transcript or empty state. */
export async function openSession(stack, id, options = {}) {
  const opened = await stack.openPage({ path: `/?session=${encodeURIComponent(id)}`, ...options });
  await opened.page.waitForFunction((sessionId) => new URLSearchParams(location.search).get('session') === sessionId, id);
  await opened.page.locator('.crumb-title').waitFor();
  // Live updates connected (the footer sits in the drawer on phones, hence attached).
  await opened.page.locator('.connection.conn-live').waitFor({ state: 'attached' });
  return opened;
}

/**
 * Types into the composer and sends with Enter (desktop) or the send button (phone).
 * `queue` keeps it for after the running turn (Alt+Enter) instead of sending it into it.
 */
export async function send(page, text, { button = false, queue = false } = {}) {
  const input = page.locator('.composer-input');
  await input.click();
  await input.fill(text);
  if (button) await page.locator(queue ? '.queue-btn' : '.send-btn').click();
  else await input.press(queue ? 'Alt+Enter' : 'Enter');
  // The composer empties once the server accepted the message.
  await waitFor(async () => (await input.inputValue()) === '', { message: 'the composer to clear after sending' });
}

/** Sends from the composer and waits for the turn to finish on the server. */
export async function sendAndWait(stack, page, id, text, options = {}) {
  const before = turnsOf(await stack.api('GET', `sessions/${id}`)).length;
  await send(page, text, options);
  return waitForTurns(stack, id, before + 1);
}

/** The text of a locator with whitespace collapsed. */
export async function textOf(locator) {
  return (await locator.innerText()).replace(/\s+/g, ' ').trim();
}

/** Waits until the locator's collapsed text matches `pattern`. */
export async function waitForText(locator, pattern, { timeout = 15_000 } = {}) {
  return waitFor(
    async () => {
      if (!(await locator.count())) return null;
      const text = await textOf(locator.first());
      return pattern.test(text) ? text : null;
    },
    { timeout, message: `text matching ${pattern}` },
  );
}

/** Mock requests that carried tools (real turns, not title or small-model calls). */
export const turnRequests = (stack) => stack.mock.requests.filter((request) => request.tools?.length);

const blockText = (content) => (typeof content === 'string' ? content : (content || []).map((block) => block.text || '').join('\n'));

/** The working directory a request's Claude Code announced (system prompt or system message). */
function requestCwd(body) {
  const texts = [blockText(body?.system), ...(body?.messages || []).filter((m) => m.role === 'system').map((m) => blockText(m.content))];
  for (const text of texts) {
    const match = /(?:Primary working directory|Working directory):\s*(\S+)/.exec(text);
    if (match) return match[1];
  }
  return null;
}

/** Turn requests made for the session working in `cwd` (each e2e session has its own repo). */
export const sessionRequests = (stack, cwd) => turnRequests(stack).filter((request) => request.body && requestCwd(request.body) === cwd);

// Console messages that are expected and harmless. Keep this list short and explain
// each entry.
const BENIGN_ERRORS = [
  // The browser logs every non-2xx fetch. A pasted sign-in address that Claude Code refuses
  // (an old link, a wrong state) is answered with a 4xx the MCP panel turns into a note.
  /Failed to load resource: the server responded with a status of 4\d\d .*\/mcp\/[^/]+\/auth\/callback/,
];

/** Fails on any page error or console error that is not on the benign list. */
export function assertNoBrowserErrors(errors) {
  const real = errors.filter((error) => !BENIGN_ERRORS.some((pattern) => pattern.test(error)));
  assert.deepEqual(real, [], 'browser console / page errors');
}

/** A small valid PNG (solid color, `size`×`size`). */
export function pngBuffer(size = 8, rgb = [200, 255, 0]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
