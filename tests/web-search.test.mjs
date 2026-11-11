// Harbor's web_search (server/web-search.mjs): one short Claude Code process on the Claude
// login runs WebSearch and its result comes back as is; errors, timeouts, cancelling and
// the limit on searches at once. The SDK query is a fake that records what it was given.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SEARCH_MODEL, createWebSearch, searchInput } from '../server/web-search.mjs';

const RESULT =
  'Web search results for query: "claude agent sdk"\n\n' +
  'Links: [{"title":"agent sdk","url":"https://platform.claude.com/docs/en/agent-sdk"}]\n\n' +
  'The Agent SDK has full changelogs on GitHub.\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';

const init = { type: 'system', subtype: 'init', tools: ['WebSearch'] };
const call = (input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_ws', name: 'WebSearch', input }] } });
const result = (content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ws', content, ...(isError ? { is_error: true } : {}) }] } });
const answer = { type: 'assistant', message: { content: [{ type: 'text', text: 'Here is what I found…' }] } };
const textOf = (out) => out.content.map((block) => block.text).join('');

/** A fake SDK query: each call runs `script(options, prompt)` as the message stream. */
function fakeQuery(script) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const run = { prompt, options, pulled: [], closed: false };
    calls.push(run);
    const inner = script(options, prompt, run);
    return {
      async next() {
        const step = await inner.next();
        if (!step.done) run.pulled.push(step.value);
        return step;
      },
      async return() {
        run.closed = true;
        await inner.return?.();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  return { query, calls };
}

const make = (script, opts = {}) => {
  const fake = fakeQuery(script);
  const search = createWebSearch({ query: fake.query, claudeExecutable: '/home/me/.local/bin/claude', claudeConfigDir: '/tmp/cfg', log: () => {}, ...opts });
  return { ...fake, search };
};

function untilAborted(options) {
  return new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
}

describe('web_search', () => {
  test("returns WebSearch's own result from a Haiku process on the Claude login, closed before Haiku answers", async () => {
    const { search, calls } = make(async function* (options, prompt) {
      yield init;
      yield call(JSON.parse(prompt.slice(prompt.indexOf('{'))));
      yield result([{ type: 'text', text: RESULT }]);
      yield answer;
      yield { type: 'result', subtype: 'success', is_error: false };
    });
    const out = await search.search({ query: 'claude agent sdk', allowed_domains: ['platform.claude.com'], blocked_domains: [], mode: 'extended' });
    assert.equal(out.isError, undefined);
    assert.equal(textOf(out), RESULT);
    const [run] = calls;
    assert.equal(run.prompt, 'Call WebSearch with this input: {"query":"claude agent sdk","allowed_domains":["platform.claude.com"],"mode":"extended"}');
    const { options } = run;
    assert.equal(options.model, SEARCH_MODEL);
    assert.equal(options.pathToClaudeCodeExecutable, '/home/me/.local/bin/claude');
    assert.equal(options.env.ANTHROPIC_BASE_URL, undefined, 'the Claude login, not the gateway');
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/tmp/cfg');
    assert.deepEqual(options.tools, ['WebSearch']);
    assert.deepEqual(options.allowedTools, ['WebSearch']);
    assert.deepEqual(options.settingSources, [], 'no hooks, MCP servers or plugins of the user');
    assert.equal(options.persistSession, false, 'nothing saved to ~/.claude/projects');
    assert.equal(run.closed, true);
    assert.equal(run.pulled.includes(answer), false, "Haiku's own answer is never waited for");
    assert.equal(options.abortController.signal.aborted, true, 'the process is stopped');
    assert.equal(search.running(), 0);
  });

  test("WebSearch's own failure, a run that never searched and a process that could not start read as errors", async () => {
    let script;
    const { search } = make((...args) => script(...args));
    script = async function* () {
      yield call({ query: 'q1' });
      yield result('Error: blocked_domains and allowed_domains cannot both be set', true);
    };
    let out = await search.search({ query: 'q1' });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^The web search failed: Error: blocked_domains and allowed_domains/);

    script = async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'I cannot search.' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'I cannot search.' };
    };
    out = await search.search({ query: 'q2' });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), 'The web search did not run.');

    script = async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not logged in · Please run /login'] };
    };
    out = await search.search({ query: 'q3' });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), 'The web search could not run: Not logged in · Please run /login');

    script = async function* () {
      throw new Error('Claude Code process exited with code 1');
    };
    out = await search.search({ query: 'q4' });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), 'The web search could not run: Claude Code process exited with code 1');
    assert.equal(search.running(), 0);
  });

  test('a search that takes too long is stopped; a cancelled tool call stops its search', async () => {
    const { search, calls } = make(async function* (options) {
      yield call({ query: 'slow' });
      await untilAborted(options);
    }, { timeoutMs: 50 });
    let out = await search.search({ query: 'slow' });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), 'The web search timed out after 0 s.');
    assert.equal(calls[0].options.abortController.signal.aborted, true);

    const cancel = new AbortController();
    const pending = search.search({ query: 'slow' }, { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 10);
    out = await pending;
    assert.equal(textOf(out), 'The search was cancelled.');
    assert.equal(search.running(), 0);
  });

  test('at most maxRunning searches run at once; the rest wait their turn (or are cancelled waiting)', async () => {
    const gates = [];
    const { search, calls } = make(async function* (_options, prompt) {
      yield call({ query: prompt });
      await new Promise((resolve) => gates.push(resolve));
      yield result(`results for ${JSON.parse(prompt.slice(prompt.indexOf('{'))).query}`);
    }, { maxRunning: 1 });
    const first = search.search({ query: 'one' });
    const second = search.search({ query: 'two' });
    const cancel = new AbortController();
    const third = search.search({ query: 'three' }, { signal: cancel.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'the second waits');
    cancel.abort();
    assert.equal(textOf(await third), 'The search was cancelled.');
    gates.shift()();
    assert.equal(textOf(await first), 'results for one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 2);
    gates.shift()();
    assert.equal(textOf(await second), 'results for two');
    assert.equal(calls.length, 2, 'the cancelled one never started');
    assert.equal(search.running(), 0);
  });

  test('searchInput keeps only the filters and mode that were given', () => {
    assert.deepEqual(searchInput({ query: 'x', allowed_domains: [], blocked_domains: undefined }), { query: 'x' });
    assert.deepEqual(searchInput({ query: 'x', blocked_domains: ['a.com'], mode: 'standard' }), { query: 'x', blocked_domains: ['a.com'], mode: 'standard' });
  });

  test('the tool is read-only and open-world, with the domain filters and mode in its schema', () => {
    const { search } = make(async function* () {});
    const definition = search.tool();
    assert.equal(definition.name, 'web_search');
    assert.deepEqual(definition.annotations, { readOnlyHint: true, openWorldHint: true });
    assert.deepEqual(Object.keys(definition.inputSchema), ['query', 'allowed_domains', 'blocked_domains', 'mode']);
  });
});
