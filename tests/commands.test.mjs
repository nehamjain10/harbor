import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOCAL_COMMANDS, createCommandCatalog, toAgentList, toCommandList } from '../server/commands.mjs';

const config = { claudeExecutable: '/opt/claude', settingSources: ['project'], claudeConfigDir: '/tmp/claude-config' };
const gateway = { url: 'http://127.0.0.1:18999', apiKey: 'proxy-secret' };
const localNames = LOCAL_COMMANDS.map((command) => command.name);

/** A fake SDK query whose supportedCommands() answers with `result` (or throws it), and supportedAgents() with `agents`. */
function fakeQuery(result, { delayMs = 0, agents } = {}) {
  const calls = [];
  const query = ({ prompt, options }) => {
    const call = { prompt, options, closed: false, promptDone: false };
    calls.push(call);
    // Like the SDK: read the prompt stream in the background.
    (async () => {
      for await (const message of prompt) call.yielded = message;
      call.promptDone = true;
    })();
    return {
      supportedCommands: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (result instanceof Error) throw result;
        return result;
      },
      ...(agents ? { supportedAgents: async () => (agents instanceof Error ? Promise.reject(agents) : agents) } : {}),
      close: () => (call.closed = true),
    };
  };
  return { query, calls };
}

describe('command list', () => {
  test('builtin rows are sdk, the rest skill; local names win; duplicates keep the builtin row', () => {
    const list = toCommandList([
      { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '<instructions>', builtin: true },
      { name: 'review', description: 'Project review skill', argumentHint: '' },
      { name: 'review', description: 'Builtin review', argumentHint: '', builtin: true },
      { name: 'deploy', description: 'Deploy', argumentHint: '<env>' },
      { name: 'deploy', description: 'Second deploy', argumentHint: '' },
      { name: 'clear', description: 'Builtin clear', argumentHint: '', builtin: true },
      { name: 'model', description: 'Builtin model', argumentHint: '', builtin: true },
      { name: '', description: 'nameless' },
      { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
      null,
    ]);
    assert.deepEqual(list.slice(0, 3), [
      { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '<instructions>', source: 'sdk' },
      { name: 'review', description: 'Builtin review', argumentHint: '', source: 'sdk' },
      { name: 'deploy', description: 'Deploy', argumentHint: '<env>', source: 'skill' },
    ]);
    assert.deepEqual(list.slice(3), LOCAL_COMMANDS);
    assert.deepEqual(localNames, ['clear', 'model', 'mode', 'effort', 'rename', 'fork', 'import', 'agents', 'settings', 'mcp', 'help']);
    assert.ok(LOCAL_COMMANDS.every((command) => command.source === 'local' && command.description));
  });

  test('no SDK commands leaves the local ones', () => {
    assert.deepEqual(toCommandList(undefined), LOCAL_COMMANDS);
  });
});

describe('command discovery', () => {
  test('starts Claude Code on a gateway route with the turn settings, sends nothing, then closes', async () => {
    const { query, calls } = fakeQuery([{ name: 'compact', description: 'Compact', argumentHint: '', builtin: true }]);
    const catalog = createCommandCatalog({ config, gateway, query, log: () => {} });
    const commands = await catalog.list('/home/me/project');
    assert.deepEqual(commands.map((command) => command.name), ['compact', ...localNames]);

    const [{ options, closed }] = calls;
    assert.equal(options.cwd, '/home/me/project');
    assert.equal(options.model, 'codex/gpt-6.1-sol');
    assert.equal(options.env.ANTHROPIC_BASE_URL, gateway.url);
    assert.equal(options.env.ANTHROPIC_API_KEY, gateway.apiKey);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, config.claudeConfigDir);
    assert.deepEqual(options.settingSources, ['project']);
    assert.equal(options.pathToClaudeCodeExecutable, '/opt/claude');
    assert.equal(options.persistSession, false);
    assert.equal(options.canUseTool, undefined);
    assert.equal(options.abortController.signal.aborted, true);
    assert.equal(closed, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls[0].yielded, undefined, 'no message was sent');
    assert.equal(calls[0].promptDone, true, 'the prompt stream ends once discovery is over');
  });

  test('the same process lists the subagents; a CLI that cannot still lists its commands', async () => {
    const sdkAgents = [
      { name: 'Explore', description: 'Read-only search', model: 'inherit' },
      { name: 'general-purpose', description: 'Anything' },
      { name: 'statusline-setup', description: 'Status line', model: 'sonnet' },
      { name: 'Explore', description: 'duplicate' },
      { name: '', description: 'nameless' },
    ];
    const { query, calls } = fakeQuery([{ name: 'compact', description: 'Compact', argumentHint: '', builtin: true }], { agents: sdkAgents });
    const catalog = createCommandCatalog({ config, gateway, query, log: () => {} });
    assert.deepEqual(await catalog.agents('/p'), [
      { name: 'Explore', description: 'Read-only search', model: 'inherit' },
      { name: 'general-purpose', description: 'Anything', model: 'inherit' },
      { name: 'statusline-setup', description: 'Status line', model: 'sonnet' },
    ]);
    assert.equal((await catalog.list('/p'))[0].name, 'compact');
    assert.equal(calls.length, 1, 'commands and agents share one discovery');

    const failing = fakeQuery([{ name: 'compact', description: '', argumentHint: '', builtin: true }], { agents: new Error('unsupported') });
    const other = createCommandCatalog({ config, gateway, query: failing.query, log: () => {} });
    assert.deepEqual(await other.agents('/p'), []);
    assert.equal((await other.list('/p'))[0].name, 'compact');
    assert.deepEqual(toAgentList(undefined), []);
  });

  test('caches per folder for 10 minutes and shares concurrent requests', async () => {
    let clock = 0;
    const { query, calls } = fakeQuery([], { delayMs: 10 });
    const catalog = createCommandCatalog({ config, gateway, query, log: () => {}, now: () => clock });
    await Promise.all([catalog.list('/a'), catalog.list('/a'), catalog.list('/a')]);
    assert.equal(calls.length, 1);
    await catalog.list('/b');
    assert.equal(calls.length, 2);
    clock += 9 * 60 * 1000;
    await catalog.list('/a');
    assert.equal(calls.length, 2);
    clock += 2 * 60 * 1000;
    await catalog.list('/a');
    assert.equal(calls.length, 3);
  });

  test('failures and timeouts give the local commands and are retried after 30 s', async () => {
    let clock = 0;
    const logs = [];
    const failing = fakeQuery(new Error('spawn ENOENT'));
    const catalog = createCommandCatalog({ config, gateway, query: failing.query, log: (line) => logs.push(line), now: () => clock });
    assert.deepEqual(await catalog.list('/a'), LOCAL_COMMANDS);
    assert.match(logs[0], /spawn ENOENT/);
    assert.equal(failing.calls[0].closed, true);
    await catalog.list('/a');
    assert.equal(failing.calls.length, 1);
    clock += 31_000;
    await catalog.list('/a');
    assert.equal(failing.calls.length, 2);

    const slow = fakeQuery([], { delayMs: 200 });
    const timed = createCommandCatalog({ config, gateway, query: slow.query, log: (line) => logs.push(line), timeoutMs: 20 });
    assert.deepEqual(await timed.list('/a'), LOCAL_COMMANDS);
    assert.match(logs.at(-1), /timed out/);

    const throwing = createCommandCatalog({
      config,
      gateway,
      query: () => {
        throw new Error('bad options');
      },
      log: () => {},
    });
    assert.deepEqual(await throwing.list('/a'), LOCAL_COMMANDS);
  });
});
