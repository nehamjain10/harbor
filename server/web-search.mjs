// Real web search for gateway models. Claude Code's WebSearch tool runs Anthropic's
// server-side search in a request of its own on the session's route; through the model
// gateway that server tool is dropped (it means nothing to OpenAI, GLM…), so a gateway
// model "searched" by making results up. Sessions and workers on gateway routes get
// `web_search` on Harbor's own MCP server instead, and their built-in WebSearch is
// switched off (buildQueryOptions).
//
// Each call runs one short Claude Code process on the Claude login (Haiku, WebSearch as
// its only tool, nothing saved to ~/.claude/projects) and returns WebSearch's own result
// as is: the query, the links and the summary, the same text a Claude session reads (and
// the transcript renders as a web search). The process is closed once that result is in,
// before Haiku would answer it. Measured on Claude Code 2.1.290: about 8 s a search.
import os from 'node:os';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { sdkEnv } from './models.mjs';

export const SEARCH_MODEL = 'claude-haiku-5-5';
export const SEARCH_TIMEOUT_MS = 90_000;
export const SEARCHES_MAX = 4;

const SYSTEM_PROMPT =
  'You run web searches for another agent. Call the WebSearch tool exactly once with exactly the input you are given, then stop without commentary.';

export const WEB_SEARCH_DESCRIPTION =
  'Search the web and return results with links and a short summary of what they say. ' +
  'Use it for current events, recent releases and anything after your knowledge cutoff, or to find pages to read with WebFetch. ' +
  'After answering from the results, list the sources you used as markdown links. ' +
  'allowed_domains / blocked_domains limit the results to, or keep them away from, the given domains (not both at once).';

/** The input WebSearch gets: the query, plus the domain filters and mode when given. */
export function searchInput({ query, allowed_domains, blocked_domains, mode }) {
  const input = { query };
  if (allowed_domains?.length) input.allowed_domains = allowed_domains;
  if (blocked_domains?.length) input.blocked_domains = blocked_domains;
  if (mode) input.mode = mode;
  return input;
}

function resultText(block) {
  const { content } = block;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part?.type === 'text' ? part.text : '')).join('');
  return '';
}

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

/**
 * @param {object} deps
 * @param {Function} deps.query  the SDK query function
 * @param {string} deps.claudeExecutable
 * @param {string} [deps.claudeConfigDir]  replaces ~/.claude (test isolation)
 * @param {number} [deps.timeoutMs]  a search that takes longer is abandoned
 * @param {number} [deps.maxRunning]  searches at once; more wait their turn
 */
export function createWebSearch({ query, claudeExecutable, claudeConfigDir, timeoutMs = SEARCH_TIMEOUT_MS, maxRunning = SEARCHES_MAX, log = console.error }) {
  let running = 0;
  const waiting = [];

  async function slot(signal) {
    if (running < maxRunning) {
      running += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      waiting.push(entry);
      signal?.addEventListener('abort', () => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        reject(new Error('cancelled'));
      }, { once: true });
    });
  }

  function release() {
    const next = waiting.shift();
    if (next) next.resolve();
    else running -= 1;
  }

  /**
   * Runs one search. Resolves to an MCP tool result: WebSearch's text, or an error the
   * model can read (never rejects).
   * @param {{query: string, allowed_domains?: string[], blocked_domains?: string[], mode?: string}} args
   * @param {{signal?: AbortSignal}} [extra]  the tool call's own cancellation
   */
  async function search(args, extra = {}) {
    const input = searchInput(args);
    const abortController = new AbortController();
    const cancel = () => abortController.abort();
    if (extra.signal?.aborted) return text('The search was cancelled.', true);
    extra.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await slot(abortController.signal);
    } catch {
      return text('The search was cancelled.', true);
    }
    const timer = setTimeout(() => abortController.abort(new Error('timeout')), timeoutMs);
    try {
      const stream = query({
        prompt: `Call WebSearch with this input: ${JSON.stringify(input)}`,
        options: {
          model: SEARCH_MODEL,
          cwd: os.tmpdir(),
          pathToClaudeCodeExecutable: claudeExecutable,
          env: sdkEnv(true, { claudeConfigDir }),
          settingSources: [],
          tools: ['WebSearch'],
          allowedTools: ['WebSearch'],
          permissionMode: 'dontAsk',
          persistSession: false,
          maxTurns: 2,
          systemPrompt: SYSTEM_PROMPT,
          abortController,
        },
      });
      let callId;
      for await (const message of stream) {
        if (message.type === 'assistant') {
          const call = message.message?.content?.find?.((block) => block.type === 'tool_use' && block.name === 'WebSearch');
          if (call) callId = call.id;
        } else if (message.type === 'user' && callId && Array.isArray(message.message?.content)) {
          const result = message.message.content.find((block) => block.type === 'tool_result' && block.tool_use_id === callId);
          if (result) {
            const body = resultText(result);
            // Leaving the loop closes the process before Haiku answers the result.
            if (result.is_error) return text(`The web search failed: ${body || 'no details'}`, true);
            return text(body || `No results for "${input.query}".`);
          }
        } else if (message.type === 'result') {
          if (message.is_error || message.subtype !== 'success') {
            const detail = message.errors?.join('; ') || message.result || message.subtype;
            return text(`The web search could not run: ${detail}`, true);
          }
          return text('The web search did not run.', true);
        }
      }
      return text('The web search did not run.', true);
    } catch (error) {
      if (abortController.signal.reason?.message === 'timeout') return text(`The web search timed out after ${Math.round(timeoutMs / 1000)} s.`, true);
      if (extra.signal?.aborted) return text('The search was cancelled.', true);
      log(`Web search failed: ${error.message}`);
      return text(`The web search could not run: ${error.message}`, true);
    } finally {
      clearTimeout(timer);
      extra.signal?.removeEventListener('abort', cancel);
      abortController.abort();
      release();
    }
  }

  /** The `web_search` tool, for Harbor's own MCP server. */
  function searchTool() {
    return tool(
      'web_search',
      WEB_SEARCH_DESCRIPTION,
      {
        query: z.string().min(2).describe('The search query'),
        allowed_domains: z.array(z.string()).optional().describe('Only return results from these domains'),
        blocked_domains: z.array(z.string()).optional().describe('Never return results from these domains'),
        mode: z.enum(['standard', 'extended']).optional().describe('standard (default): quick; extended: more thorough and fresher, for niche or very recent facts'),
      },
      (args, extra) => search(args, extra),
      // Only reads the web: Claude Code may run several at once.
      { annotations: { readOnlyHint: true, openWorldHint: true } },
    );
  }

  return { search, tool: searchTool, running: () => running };
}
