// Chat titles: after a chat's first answer, Haiku names it in a few words. Until then
// (and whenever this fails) the title is the start of the first message, as before.
// A title the user set themselves is never replaced (session.titleAuto is cleared).
import os from 'node:os';

export const TITLE_MODEL = 'claude-haiku-5-5';
const TITLE_TIMEOUT_MS = 30_000;
const MAX_INPUT = 2000;
const MAX_TITLE = 60;

const SYSTEM_PROMPT =
  'You name chat conversations. Reply with a title of 2 to 6 words for the conversation you are given: what it is about, specific (name the project, file or topic), in sentence case, with no quotes, no ending punctuation and nothing else.';

/** The conversation as Haiku sees it: the first message and the start of the answer. */
export function titlePrompt(first, reply) {
  const clip = (text) => (text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) + '…' : text);
  return `First message:\n${clip(first.trim())}\n\nStart of the answer:\n${clip((reply || '').trim())}\n\nTitle:`;
}

/** Haiku's answer as a title, or null when it is not usable. */
export function cleanTitle(text) {
  let title = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!title) return null;
  title = title
    .replace(/^(title)\s*:\s*/i, '')
    .replace(/^["'“‘`*#\s]+|["'”’`*\s]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || title.length > MAX_TITLE * 2) return null;
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1).trimEnd() + '…' : title;
}

/**
 * @param {object} deps
 * @param {Function} deps.query  the Agent SDK's query
 * @param {string} deps.claudeExecutable
 * @param {() => object} deps.env  the process env for a Claude call (the relay while it is up)
 * @returns {(first: string, reply: string) => Promise<string | null>}
 */
export function createTitler({ query, claudeExecutable, env, timeoutMs = TITLE_TIMEOUT_MS, log = console.error }) {
  return async function title(first, reply) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const stream = query({
        prompt: titlePrompt(first, reply),
        options: {
          model: TITLE_MODEL,
          cwd: os.tmpdir(),
          pathToClaudeCodeExecutable: claudeExecutable,
          env: env(),
          settingSources: [],
          tools: [],
          permissionMode: 'dontAsk',
          persistSession: false,
          maxTurns: 1,
          systemPrompt: SYSTEM_PROMPT,
          abortController,
        },
      });
      for await (const message of stream) {
        if (message.type === 'result') return message.subtype === 'success' && !message.is_error ? cleanTitle(message.result) : null;
      }
      return null;
    } catch (error) {
      if (!abortController.signal.aborted) log(`Could not title a chat: ${error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
