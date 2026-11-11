import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { QUESTION_TIMEOUT_MESSAGE } from '../server/approvals.mjs';
import { createEvents } from '../server/events.mjs';
import { NOTICES, buildQueryOptions, createRunner, goalOf, goalSetText, permissionModeFor, turnPrompt } from '../server/runner.mjs';
import { findModel, setContextLimits } from '../server/models.mjs';
import { createSession, createStore, publicSession } from '../server/store.mjs';
import { createFakeCli, successResult } from './fake-cli.mjs';

const tempDirs = [];
const runners = [];

afterEach(async () => {
  // Ends every fake Claude Code process a test left running, before its files go.
  while (runners.length) {
    const runner = runners.pop();
    runner.shutdown();
    await waitFor(() => runner.pool.size === 0);
    await sleep(5);
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/**
 * A runner over a temp data dir whose Claude Code processes are fakes running `script`
 * once per user message (see fake-cli.mjs).
 */
function setup(script, { save, log, stopGraceMs, questionTimeoutMs, idleMs, maxProcesses, closeGraceMs = 50, behavior, uploads } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-runner-'));
  tempDirs.push(dataDir);
  const store = createStore({ dataDir });
  store.load();
  const events = createEvents({ save: save ?? store.save, toPublic: publicSession, throttleMs: 1, log });
  const cli = createFakeCli(script, behavior);
  const config = { gatewayUrl: 'http://127.0.0.1:9', claudeExecutable: '/nonexistent/claude' };
  const runner = createRunner({ config, events, query: cli.query, uploads, stopGraceMs, questionTimeoutMs, idleMs, maxProcesses, closeGraceMs, log: log ?? (() => {}) });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: dataDir, model: 'astra', mode: 'bypassPermissions' }));
  // Every user message the fake processes received, in order.
  const prompts = () => cli.processes.flatMap((proc) => proc.received.map((command) => command.content));
  return { store, events, runner, session, cli, prompts };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (runner, session) => () => !runner.isRunning(session.id) && session.status !== 'running';
const signal = () => new AbortController().signal;
const say = (text, uuid = crypto.randomUUID()) => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const toolUse = (id, name = 'Bash', input = { command: 'sleep 9' }) => ({
  type: 'assistant',
  uuid: 'u-' + id,
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, content = 'ok') => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const userTexts = (session) => session.messages.filter((m) => m.role === 'user').map((m) => m.text);
const controls = (proc, name) => proc.controls.filter(([control]) => control === name).map(([, arg]) => arg);

/** A gate a script can wait on. */
function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

describe('buildQueryOptions', () => {
  const baseArgs = {
    model: findModel('opus'),
    effort: 'high',
    claudeExecutable: '/home/me/.local/bin/claude',
    gateway: { url: 'http://127.0.0.1:18999', apiKey: 'proxy-secret' },
    abortController: new AbortController(),
    canUseTool: async () => ({ behavior: 'allow' }),
  };
  const gatewayArgs = { ...baseArgs, model: findModel('luna') };

  test('maps stored modes to SDK permission modes and always allows a live switch to bypass', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
      assert.equal(permissionModeFor(mode), mode);
      const options = buildQueryOptions({ mode, cwd: '/w' }, baseArgs);
      assert.equal(options.permissionMode, mode);
      assert.equal(options.allowDangerouslySkipPermissions, true);
    }
    assert.equal(permissionModeFor('yolo'), 'default', 'unmigrated names never bypass');
  });

  test('auto is Claude-only: gateway turns run it as default without touching the stored mode', () => {
    const session = { mode: 'auto', cwd: '/w' };
    assert.equal(buildQueryOptions(session, gatewayArgs).permissionMode, 'default');
    assert.equal(buildQueryOptions(session, baseArgs).permissionMode, 'auto');
    assert.equal(session.mode, 'auto');
  });

  test('Claude turns run direct with adaptive summarized thinking and the identity line', () => {
    const options = buildQueryOptions({ mode: 'default', cwd: '/w' }, baseArgs);
    assert.equal(options.model, 'claude-opus-5-5');
    assert.equal(options.effort, 'high');
    assert.equal(options.cwd, '/w');
    assert.equal(options.pathToClaudeCodeExecutable, '/home/me/.local/bin/claude');
    assert.equal(options.env.ANTHROPIC_BASE_URL, undefined, 'Claude runs direct');
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(options.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(options.settings, { effortLevel: 'high', remoteControlAtStartup: false, env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' }, autoCompactWindow: 400_000 }, 'no forced ask list; compacts by the 400k default');
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.equal(options.permissionPrompts, 'host');
    assert.deepEqual(options.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      append:
        'Model identity: you are Claude Opus 5.5 (route claude/claude-opus-5-5, provider Claude), selected by the user in Harbor. ' +
        'If a later "[Harbor: ...]" note in the conversation says the user switched models, that note is current.',
      snapshot: true,
    });
    assert.equal(options.includePartialMessages, true);
    assert.equal(options.persistSession, true);
    assert.equal('mcpServers' in options, false, 'user MCP servers load');
    assert.deepEqual(options.extraArgs, { 'replay-user-messages': null }, 'user messages echo back when taken; no strict MCP config');
    assert.equal(options.abortController, baseArgs.abortController);
    assert.equal(options.canUseTool, baseArgs.canUseTool);
    assert.equal(options.resume, undefined);
    assert.equal(options.disallowedTools, undefined, 'WebSearch works on the Claude login');
  });

  test('gateway turns go through the proxy with the model\'s window, a compact window at 80% of it and the tool hint', () => {
    const options = buildQueryOptions({ mode: 'bypassPermissions', cwd: '/w', sdkSessionId: 'sdk-1' }, { ...baseArgs, model: findModel('deepseek') });
    assert.equal(options.model, 'litellm/DeepSeek-V4-Flash');
    assert.equal(options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18999');
    assert.equal(options.env.ANTHROPIC_API_KEY, 'proxy-secret');
    assert.equal(options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude/claude-haiku-5-5');
    assert.deepEqual(options.settings, { effortLevel: 'high', remoteControlAtStartup: false, env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000' }, autoCompactWindow: 320_000 });
    assert.equal(options.thinking, undefined);
    assert.match(options.systemPrompt.append, /^Model identity: you are DeepSeek V4.1 Flash \(route litellm\/DeepSeek-V4-Flash, provider DeepSeek\)/);
    assert.match(options.systemPrompt.append, /\nWhen calling tools, send arguments with their correct JSON types and omit optional parameters/);
    assert.doesNotMatch(options.systemPrompt.append, /pages/, 'the v1 "omit pages" workaround is gone');
    assert.equal(options.resume, 'sdk-1');
    // The gateway drops WebSearch's server-side search: the model searches with Harbor's web_search.
    assert.deepEqual(options.disallowedTools, ['WebSearch']);
  });

  test('"allow always" grants are re-applied as flag-settings permissions', () => {
    const session = {
      mode: 'default',
      cwd: '/w',
      allowRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'WebFetch' }],
      allowDirectories: ['/srv/shared'],
    };
    assert.deepEqual(buildQueryOptions(session, baseArgs).settings, {
      effortLevel: 'high',
      remoteControlAtStartup: false,
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' },
      permissions: { allow: ['Bash(npm test:*)', 'WebFetch'], additionalDirectories: ['/srv/shared'] },
      autoCompactWindow: 400_000,
    });
    assert.equal('permissions' in buildQueryOptions({ ...session, allowRules: [], allowDirectories: [] }, baseArgs).settings, false);
  });

  test('setting sources and the Claude config dir can be overridden for isolation', () => {
    const options = buildQueryOptions({ mode: 'default', cwd: '/w' }, { ...gatewayArgs, settingSources: [], claudeConfigDir: '/tmp/cfg' });
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/tmp/cfg');
  });
});

describe('turnPrompt', () => {
  const luna = findModel('luna');
  const deepseek = findModel('deepseek');
  const opus = findModel('opus');
  const NOTE_DEEPSEEK = /^\[Harbor: from this message on you are DeepSeek V4.1 Flash \(route litellm\/DeepSeek-V4-Flash, provider DeepSeek\); earlier turns in this conversation ran on GPT-6 Luna\. When calling tools, [^\]]+\]$/;

  test('first turn and same-model turns send the text unchanged', () => {
    assert.equal(turnPrompt({ messages: [] }, luna, 'hi'), 'hi', 'no SDK session yet: the recorded system prompt names the model');
    assert.equal(turnPrompt({ messages: [], sdkSessionId: 's', lastTurnModel: 'luna' }, luna, 'hi'), 'hi');
    const blocks = [{ type: 'text', text: 'hi' }];
    assert.equal(turnPrompt({ messages: [], sdkSessionId: 's', lastTurnModel: 'luna' }, luna, blocks), blocks);
  });

  test('a resumed turn on a different model gets the switch note in front of the text', () => {
    const prompt = turnPrompt({ messages: [], sdkSessionId: 's', lastTurnModel: 'luna' }, deepseek, 'who are you?');
    const [note, text] = prompt.split('\n\n');
    assert.match(note, NOTE_DEEPSEEK);
    assert.equal(text, 'who are you?');
    assert.doesNotMatch(turnPrompt({ messages: [], sdkSessionId: 's', lastTurnModel: 'deepseek' }, opus, 'x'), /When calling tools/, 'no tool hint for Claude');
  });

  test('slash commands are sent bare so Claude Code still runs them; the note waits', () => {
    const session = { messages: [], sdkSessionId: 's', lastTurnModel: 'luna' };
    assert.equal(turnPrompt(session, deepseek, '/compact keep the plan'), '/compact keep the plan');
    assert.match(turnPrompt(session, deepseek, 'run /compact'), /^\[Harbor/);
    assert.match(turnPrompt(session, deepseek, '/ not a command'), /^\[Harbor/);
  });

  test('content blocks (attachments) get the note as a leading text block', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } };
    const blocks = [image, { type: 'text', text: 'what is this?' }];
    const prompt = turnPrompt({ messages: [], sdkSessionId: 's', lastTurnModel: 'luna' }, deepseek, blocks);
    assert.equal(prompt.length, 3);
    assert.equal(prompt[0].type, 'text');
    assert.match(prompt[0].text, NOTE_DEEPSEEK);
    assert.deepEqual(prompt.slice(1), blocks);
    assert.equal(blocks.length, 2, 'the caller\'s array is not modified');
  });

  test('sessions from before lastTurnModel fall back to the model of the newest reply', () => {
    const session = {
      sdkSessionId: 's',
      messages: [
        { role: 'assistant', text: 'old', model: 'deepseek' },
        { role: 'assistant', text: 'newer', model: 'luna' },
        { role: 'user', text: 'next' },
      ],
    };
    const [note, text] = turnPrompt(session, deepseek, 'next').split('\n\n');
    assert.match(note, NOTE_DEEPSEEK);
    assert.equal(text, 'next');
    assert.equal(turnPrompt(session, luna, 'next'), 'next');
    assert.equal(turnPrompt({ sdkSessionId: 's', messages: [{ role: 'user', text: 'x' }] }, deepseek, 'x'), 'x', 'unknown history: no note');
  });
});



describe('runner turns', () => {
  test('a rewound session resumes at the rewind point once, with file checkpoints kept', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield say('ok');
      yield successResult();
    });
    Object.assign(session, { sdkSessionId: 'sdk-old', resumeAt: 'entry-before' });
    runner.enqueue(session, { text: 'again' });
    await waitFor(settled(runner, session));
    const proc = cli.processes[0];
    assert.equal(proc.options.resume, 'sdk-old');
    assert.equal(proc.options.resumeSessionAt, 'entry-before');
    assert.equal(proc.options.enableFileCheckpointing, true);
    assert.equal(session.resumeAt, undefined, 'branched off: later processes resume plainly');
    assert.equal(buildQueryOptions(session, { model: findModel('astra'), effort: 'medium' }).resumeSessionAt, undefined);
  });

  test('a turn streams, records assistant text and tool results, then goes idle', async () => {
    const { runner, session, cli, store } = setup(async function* () {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } };
      yield {
        type: 'assistant',
        uuid: 'a1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] },
      };
      // A duplicate assistant message (same uuid) must not be recorded twice.
      yield { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Hello' }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'x'.repeat(70_000) }] } };
      yield successResult();
    });

    const { queued } = runner.enqueue(session, { text: 'hi\n  there', clientId: 'c1' });
    assert.equal(queued, false, 'started immediately, so not waiting in the queue');
    await waitFor(settled(runner, session));

    assert.equal(cli.spawns, 1);
    const [proc] = cli.processes;
    assert.deepEqual(proc.received.map((command) => command.content), ['hi\n  there']);
    assert.equal(proc.options.model, 'codex/gpt-6-astra');
    assert.equal(proc.options.effort, 'medium');
    assert.equal(proc.ended, false, 'the process stays up for the next turn');
    assert.equal(session.status, 'idle');
    assert.equal(session.sdkSessionId, 'sdk-1');
    assert.equal(session.live, '');
    assert.equal(session.currentMessageId, undefined);
    assert.equal(session.title, 'hi there');

    // The echoed user message and lifecycle frames add nothing to the transcript.
    const [user, assistant, tool, turn] = session.messages;
    assert.equal(session.messages.length, 4);
    assert.equal(turn.role, 'turn');
    assert.deepEqual(session.totals, { cost: 0.01, outputTokens: 0, turns: 1, models: { [session.model]: { cost: 0.01, outputTokens: 0 } } });
    assert.equal(user.role, 'user');
    assert.equal(user.delivery, 'done');
    assert.equal(user.clientId, 'c1');
    assert.equal(typeof user.startedAt, 'number');
    // The uuid the message went out with, which Claude Code's transcript keeps (forks find it).
    assert.equal(user.sdkUuid, proc.received[0].uuid);
    assert.deepEqual(
      { role: assistant.role, text: assistant.text, sdkId: assistant.sdkId, model: assistant.model, effort: assistant.effort },
      { role: 'assistant', text: 'Hello', sdkId: 'a1', model: 'astra', effort: 'medium' },
    );
    assert.equal(tool.state, 'done');
    assert.equal(tool.output.length, 60_000 + '\n[Output truncated]'.length);

    // Persisted, and the SDK session id stays on disk for resume.
    const saved = JSON.parse(fs.readFileSync(path.join(store.dataDir, session.id + '.json')));
    assert.equal(saved.sdkSessionId, 'sdk-1');
    assert.equal(saved.status, 'idle');
  });

  test('later turns are new messages to the same process; queued messages run in order', async () => {
    const first = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) await first.promise;
      yield say(`reply to ${turn.text}`);
      yield successResult();
    });

    runner.enqueue(session, { text: 'first' });
    const second = runner.enqueue(session, { text: 'second', queue: true });
    assert.equal(second.queued, true);
    assert.equal(session.queue.length, 1);
    assert.equal(session.messages[1].delivery, 'queued');

    first.open();
    await waitFor(() => session.messages.filter((m) => m.role === 'turn').length === 2 && settled(runner, session)());
    runner.enqueue(session, { text: 'third' });
    await waitFor(() => session.messages.filter((m) => m.role === 'turn').length === 3 && settled(runner, session)());

    assert.equal(cli.spawns, 1, 'one Claude Code process for all three turns');
    assert.deepEqual(cli.last.received.map((command) => command.content), ['first', 'second', 'third']);
    assert.equal(cli.last.options.resume, undefined);
    assert.deepEqual(session.messages.filter((m) => m.role === 'user').map((m) => m.delivery), ['done', 'done', 'done']);
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ['user', 'assistant', 'turn', 'user', 'assistant', 'turn', 'user', 'assistant', 'turn'],
    );
    assert.equal(session.queue.length, 0);
  });

  test('a model switch within a route is applied in place and announced to the model once', async () => {
    const { runner, session, cli, prompts } = setup(async function* () {
      yield say('ok');
      yield successResult();
    });
    const turn = async (text) => {
      runner.enqueue(session, { text });
      await waitFor(() => userTexts(session).length && session.messages.at(-1).role === 'turn' && settled(runner, session)());
    };
    await turn('first');
    assert.equal(session.lastTurnModel, 'astra');
    session.model = 'deepseek';
    await turn('second');
    await turn('third');
    session.model = 'astra';
    await turn('fourth');

    assert.equal(cli.spawns, 1, 'gateway to gateway: no restart');
    assert.deepEqual(controls(cli.last, 'setModel'), ['litellm/DeepSeek-V4-Flash', 'codex/gpt-6-astra']);
    const sent = prompts();
    assert.equal(sent[0], 'first');
    assert.match(sent[1], /^\[Harbor: from this message on you are DeepSeek V4.1 Flash .*earlier turns in this conversation ran on GPT-6 Astra\. When calling tools[^\]]*\]\n\nsecond$/);
    assert.equal(sent[2], 'third', 'only the first turn on the new model carries the note');
    assert.match(sent[3], /^\[Harbor: from this message on you are GPT-6 Astra .*ran on DeepSeek V4.1 Flash\..*\]\n\nfourth$/);
    assert.deepEqual(userTexts(session), ['first', 'second', 'third', 'fourth']);
    assert.deepEqual(session.messages.filter((m) => m.role === 'turn').map((m) => m.model), ['astra', 'deepseek', 'deepseek', 'astra']);
    assert.equal(session.lastTurnModel, 'astra');
  });

  test('a switch between Claude and a gateway model restarts the process, resuming the conversation', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield say('ok');
      yield successResult();
    });
    runner.enqueue(session, { text: 'on astra' });
    await waitFor(settled(runner, session));
    session.model = 'opus';
    runner.enqueue(session, { text: 'on opus' });
    await waitFor(() => cli.spawns === 2 && session.messages.at(-1).role === 'turn' && settled(runner, session)());
    session.model = 'sonnet';
    runner.enqueue(session, { text: 'on sonnet' });
    await waitFor(() => session.messages.filter((m) => m.role === 'turn').length === 3 && settled(runner, session)());

    const [gatewayProc, claudeProc] = cli.processes;
    assert.equal(gatewayProc.ended, true, 'the gateway process was closed');
    assert.ok(!gatewayProc.controls.some(([name]) => name === 'close'), 'by ending its input, not killing it');
    assert.equal(claudeProc.options.resume, 'sdk-1');
    assert.equal(claudeProc.options.model, 'claude-opus-5-5');
    assert.equal(claudeProc.options.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(cli.spawns, 2, 'Claude to Claude switches in place');
    assert.deepEqual(controls(claudeProc, 'setModel'), ['claude-sonnet-5-5']);
    assert.equal(session.sdkSessionId, 'sdk-1', 'the Claude Code session id survives the restart');
  });

  test('effort and mode changes go to the live process before the next turn', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield successResult();
    });
    runner.enqueue(session, { text: 'one' });
    await waitFor(settled(runner, session));
    session.efforts.astra = 'high';
    session.mode = 'auto';
    runner.enqueue(session, { text: 'two' });
    await waitFor(() => cli.last.received.length === 2 && settled(runner, session)());
    assert.equal(cli.spawns, 1);
    assert.deepEqual(controls(cli.last, 'applyFlagSettings'), [{ effortLevel: 'high' }]);
    assert.deepEqual(controls(cli.last, 'setPermissionMode'), ['default'], 'auto runs as default on gateway models');
    assert.equal(cli.last.effort, 'high');
  });

  test('approvals park the tool call until the user answers', async () => {
    let decision;
    const { runner, session } = setup(async function* (turn) {
      decision = await turn.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Pick one' }] }, { signal: signal(), toolUseID: 'tu-1' });
      yield successResult();
    });

    runner.enqueue(session, { text: 'ask me' });
    await waitFor(() => session.status === 'waiting');
    const [pending] = session.pending;
    assert.equal(pending.tool, 'AskUserQuestion');
    assert.equal(pending.toolUseID, 'tu-1');
    assert.equal(runner.hasApproval(pending.id), true);

    assert.equal(runner.resolveApproval(pending.id, { allow: true, answers: { 'Pick one': 'A' } }), true);
    await waitFor(settled(runner, session));
    assert.deepEqual(decision, {
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'Pick one' }], answers: { 'Pick one': 'A' } },
    });
    assert.equal(runner.hasApproval(pending.id), false);
    assert.equal(runner.resolveApproval(pending.id, { allow: true }), false);
    assert.deepEqual(session.pending, []);
  });

  test('an unanswered question times out and the model decides for the user', async () => {
    let decision;
    const { runner, session } = setup(async function* (turn) {
      decision = await turn.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Pick one' }] }, { signal: signal(), toolUseID: 'tu-1' });
      yield successResult();
    }, { questionTimeoutMs: 20 });

    runner.enqueue(session, { text: 'ask me' });
    await waitFor(settled(runner, session));
    assert.deepEqual(decision, { behavior: 'deny', message: QUESTION_TIMEOUT_MESSAGE });
    assert.deepEqual(session.pending, []);
    assert.ok(session.messages.some((m) => m.role === 'notice' && /deciding on your behalf/.test(m.text)));
  });

  test('denials carry the reason or the default message', async () => {
    const decisions = [];
    const { runner, session } = setup(async function* (turn) {
      decisions.push(await turn.options.canUseTool('Bash', { command: 'rm -rf x' }, { signal: signal(), toolUseID: 't1' }));
      decisions.push(await turn.options.canUseTool('Bash', { command: 'ls' }, { signal: signal(), toolUseID: 't2' }));
      yield successResult();
    });

    // Bypass would answer these itself (bypassAnswer).
    session.mode = 'default';
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => session.pending.length === 1);
    runner.resolveApproval(session.pending[0].id, { allow: false, reason: 'Not that' });
    await waitFor(() => session.pending.length === 1 && session.pending[0].toolUseID === 't2');
    runner.resolveApproval(session.pending[0].id, { allow: false });
    await waitFor(settled(runner, session));
    assert.deepEqual(decisions, [
      { behavior: 'deny', message: 'Not that' },
      { behavior: 'deny', message: 'The user declined this action.' },
    ]);
  });

  test('pending entries carry kind, suggestions and the SDK prompt text', async () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' }];
    const { runner, session } = setup(async function* (turn) {
      const ask = turn.options.canUseTool;
      await ask('Bash', { command: 'touch x' }, { signal: signal(), toolUseID: 't1', suggestions, blockedPath: '/w/x', title: 'Run touch?', requestId: 'r' });
      await ask('AskUserQuestion', { questions: [] }, { signal: signal(), toolUseID: 't2' });
      await ask('ExitPlanMode', { plan: '# Do it' }, { signal: signal(), toolUseID: 't3' });
      yield successResult();
    });
    // Bypass would answer these itself (bypassAnswer).
    session.mode = 'default';
    runner.enqueue(session, { text: 'go' });
    const kinds = [];
    for (const expected of ['permission', 'question', 'plan']) {
      await waitFor(() => session.pending[0]?.kind === expected);
      kinds.push(session.pending[0]);
      const answers = expected === 'question' ? { Q: 'A' } : undefined;
      if (answers) assert.equal(runner.resolveApproval(session.pending[0].id, { decision: 'allow' }).status, 400, 'a question needs answers');
      runner.resolveApproval(session.pending[0].id, { decision: 'allow', answers });
    }
    await waitFor(settled(runner, session));
    const [bash, question, plan] = kinds;
    assert.deepEqual(Object.keys(bash), ['id', 'kind', 'tool', 'input', 'at', 'toolUseID', 'suggestions', 'blockedPath', 'title']);
    assert.deepEqual(bash.suggestions, suggestions);
    assert.equal(question.kind, 'question');
    assert.equal(plan.kind, 'plan');
    assert.equal(session.plan.text, '# Do it');
  });

  test('allow always records the grants; a later identical call is allowed without asking', async () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch x' }], behavior: 'allow', destination: 'localSettings' }];
    const decisions = [];
    const { runner, session, cli } = setup(async function* (turn) {
      decisions.push(await turn.options.canUseTool('Bash', { command: 'touch x' }, { signal: signal(), toolUseID: 't1', suggestions }));
      yield successResult();
    });
    session.mode = 'default';
    runner.enqueue(session, { text: 'first' });
    await waitFor(() => session.pending.length === 1);
    assert.equal(runner.resolveApproval(session.pending[0].id, { decision: 'allowAlways' }), true);
    await waitFor(settled(runner, session));
    assert.deepEqual(decisions[0], {
      behavior: 'allow',
      updatedInput: { command: 'touch x' },
      updatedPermissions: [{ ...suggestions[0], destination: 'session' }],
    });
    assert.deepEqual(session.allowRules, [{ toolName: 'Bash', ruleContent: 'touch x' }]);

    // Next turn, same process: the backstop answers at once.
    runner.enqueue(session, { text: 'second' });
    await waitFor(() => cli.last.received.length === 2 && settled(runner, session)());
    assert.deepEqual(decisions[1], { behavior: 'allow', updatedInput: { command: 'touch x' } });

    // Revoking the grants restarts the process without them (a live one cannot forget).
    session.allowRules = [];
    runner.sessionChanged(session, { allowRules: [] });
    await waitFor(() => cli.processes[0].ended);
    runner.enqueue(session, { text: 'third' });
    await waitFor(() => cli.spawns === 2);
    assert.equal(cli.last.options.settings.permissions, undefined);
    assert.equal(cli.last.options.resume, 'sdk-1');
    await waitFor(() => session.pending.length === 1);
    runner.resolveApproval(session.pending[0].id, { decision: 'deny' });
    await waitFor(settled(runner, session));
  });

  test('a settings file change marks live processes stale: idle ones restart now, busy ones when their turn ends, sessions without one are not counted', async () => {
    const hold = gate();
    const { runner, session, cli, store } = setup(async function* (turn) {
      if (turn.text === 'hold') await hold.promise;
      yield successResult();
    });
    const busy = store.insert(createSession({ cwd: session.cwd, model: 'astra', mode: 'bypassPermissions' }));
    const cold = store.insert(createSession({ cwd: session.cwd, model: 'astra', mode: 'bypassPermissions' }));
    runner.enqueue(session, { text: 'first' });
    await waitFor(settled(runner, session));
    runner.enqueue(busy, { text: 'hold' });
    await waitFor(() => cli.processes.length === 2 && busy.status === 'running');
    const [idleProc, busyProc] = cli.processes;

    assert.equal(runner.settingsChanged([session, busy, cold]), 2, 'two sessions have a live process');
    await waitFor(() => idleProc.ended);
    assert.equal(busyProc.ended, false, 'a turn is never cut short for a settings change');
    hold.open();
    await waitFor(() => busyProc.ended);
    assert.equal(busy.status, 'idle');

    // Both come back with resume, as new processes (the grants' revoke path).
    runner.enqueue(session, { text: 'second' });
    await waitFor(() => cli.spawns === 3 && settled(runner, session)());
    assert.equal(cli.last.options.resume, 'sdk-1');
    assert.equal(runner.settingsChanged([session]), 1);
    assert.equal(runner.settingsChanged([]), 0);
  });

  test('a restarted process gets the grants as flag settings', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield successResult();
    });
    session.allowRules = [{ toolName: 'Bash', ruleContent: 'touch x' }];
    runner.enqueue(session, { text: 'go' });
    await waitFor(settled(runner, session));
    assert.deepEqual(cli.last.options.settings.permissions, { allow: ['Bash(touch x)'] });
  });

  test('plan approval records the chosen mode before the turn continues; invalid answers are refused', async () => {
    let modeSeenAfterApproval;
    const { runner, session } = setup(async function* (turn) {
      await turn.options.canUseTool('ExitPlanMode', { plan: '# Plan' }, { signal: signal(), toolUseID: 't1' });
      modeSeenAfterApproval = session.mode;
      yield successResult();
    });
    session.mode = 'plan';
    runner.enqueue(session, { text: 'plan it' });
    await waitFor(() => session.pending.length === 1);
    const { id } = session.pending[0];
    assert.equal(runner.resolveApproval(id, { decision: 'nope' }).status, 400);
    assert.equal(runner.resolveApproval(id, { decision: 'allow', mode: 'plan' }).status, 400);
    assert.equal(runner.hasApproval(id), true);
    assert.equal(runner.resolveApproval(id, { decision: 'allow', mode: 'acceptEdits' }), true);
    await waitFor(settled(runner, session));
    assert.equal(modeSeenAfterApproval, 'acceptEdits');
    assert.equal(session.mode, 'acceptEdits');
  });

  test('a failed turn records the error and pauses the queue; the next turn resumes in a new process', async () => {
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) throw new Error('gateway exploded');
      yield successResult();
    });

    runner.enqueue(session, { text: 'boom' });
    await waitFor(settled(runner, session));
    assert.equal(session.status, 'error');
    assert.equal(session.queuePaused, true);
    assert.equal(session.messages.at(-1).text, 'gateway exploded');
    assert.equal(session.messages[0].delivery, 'error');
    assert.equal(typeof session.turnEndedAt, 'number', 'a failed turn still counts as ended (unread)');

    runner.enqueue(session, { text: 'again' });
    await waitFor(() => cli.spawns === 2 && settled(runner, session)());
    assert.equal(cli.last.options.resume, 'sdk-1');
    assert.equal(session.status, 'idle');
    assert.equal(session.messages.find((m) => m.text === 'again').delivery, 'done');
  });

  test('an error result becomes a notice; the process stays for the next turn', async () => {
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) yield successResult({ is_error: true, subtype: 'error_during_execution', errors: ['first', 'second'] });
      yield successResult();
    });
    runner.enqueue(session, { text: 'x' });
    await waitFor(settled(runner, session));
    assert.equal(session.status, 'error');
    assert.equal(session.queuePaused, true);
    assert.equal(session.messages.at(-1).text, 'first\nsecond');
    assert.equal(session.messages[0].delivery, 'error');
    runner.enqueue(session, { text: 'y' });
    await waitFor(() => cli.last.received.length === 2 && settled(runner, session)());
    assert.equal(cli.spawns, 1);
  });

  test('an API error is reported once', async () => {
    const { runner, session } = setup(async function* () {
      yield { type: 'assistant', uuid: 'e1', error: 'unknown', message: { content: [{ type: 'text', text: 'API Error: 400 Mock API error' }] } };
      yield { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 Mock API error', total_cost_usd: 0, modelUsage: {} };
    });
    runner.enqueue(session, { text: 'x' });
    await waitFor(settled(runner, session));
    assert.equal(session.status, 'error');
    assert.equal(session.queuePaused, true);
    const notices = session.messages.filter((m) => m.role === 'notice');
    assert.deepEqual(notices.map(({ text, level }) => ({ text, level })), [{ text: 'API Error: 400 Mock API error', level: 'error' }]);
    assert.equal(session.messages[0].delivery, 'error');
  });

  test('a failing disk does not wedge the turn or the approval', async () => {
    const logged = [];
    let decision;
    const { runner, session } = setup(
      async function* (turn) {
        decision = await turn.options.canUseTool('Bash', { command: 'ls' }, { signal: signal(), toolUseID: 't1' });
        yield say('done', 'a1');
        yield successResult();
      },
      {
        save: () => {
          throw new Error('EROFS: read-only file system');
        },
        log: (message) => logged.push(message),
      },
    );

    // Bypass would answer these itself (bypassAnswer).
    session.mode = 'default';
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => session.pending.length === 1);
    runner.resolveApproval(session.pending[0].id, { allow: true });
    await waitFor(settled(runner, session));
    assert.equal(decision.behavior, 'allow');
    assert.equal(session.status, 'idle');
    assert.equal(session.messages.findLast((m) => m.role === 'assistant').text, 'done');
    assert.ok(logged.length > 0);
    assert.ok(logged.every((message) => message.endsWith('EROFS: read-only file system')));
  });

  test('cancelQueued removes only messages that have not started', async () => {
    const hold = gate();
    const { runner, session } = setup(async function* () {
      await hold.promise;
      yield successResult();
    });
    runner.enqueue(session, { text: 'running' });
    runner.enqueue(session, { text: 'waiting', queue: true });
    const [running, waiting] = session.messages;
    assert.equal(await runner.cancelQueued(session, running.id), false);
    assert.equal(await runner.cancelQueued(session, waiting.id), true);
    assert.equal(waiting.delivery, 'cancelled');
    hold.open();
    await waitFor(settled(runner, session));
  });

  test('boot resumes restart losses once, preserves queued work, and respects explicit stops', async () => {
    const { runner, session, cli } = setup(async function* () { yield successResult(); });
    Object.assign(session, { status: 'interrupted', restartRecovery: true, queuePaused: true });
    session.messages.push({ id: 'later', role: 'user', text: 'queued next', delivery: 'queued' });
    session.queue = [{ id: 'later', text: 'queued next' }];
    runner.startQueued([session]);
    runner.startQueued([session]);
    await waitFor(() => !runner.isRunning(session.id) && !session.queue.length);
    const prompts = cli.processes.flatMap((p) => p.received.map((c) => c.content));
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Harbor recovery.*do not blindly repeat/s);
    assert.equal(prompts[1], 'queued next');
    assert.equal(session.restartAttempts.length, 1);
    assert.equal(session.restartRecovery, undefined);

    session.status = 'running';
    session.restartRecovery = true;
    runner.stop(session);
    runner.startQueued([session]);
    assert.equal(session.stopRequested, true);
    assert.equal(session.restartRecovery, undefined);
    assert.equal(cli.processes.flatMap((p) => p.received).length, 2);
  });

  test('boot recovery backs off during a crash loop', () => {
    const { runner, session, cli } = setup(async function* () { yield successResult(); });
    Object.assign(session, { status: 'interrupted', restartRecovery: true, restartAttempts: [Date.now(), Date.now(), Date.now()] });
    runner.startQueued([session]);
    assert.equal(cli.spawns, 0);
    assert.equal(session.queuePaused, true);
    assert.match(session.messages.at(-1).text, /three restarts/);
  });

  test('startQueued drains idle sessions but leaves interrupted ones paused', async () => {
    const { runner, store, cli } = setup(async function* () {
      yield successResult();
    });
    const idle = store.insert(createSession({ cwd: '/tmp', model: 'astra', mode: 'default' }));
    idle.messages.push({ id: 'q1', role: 'user', text: 'queued', at: 1, delivery: 'queued' });
    idle.queue = [{ id: 'q1', text: 'queued' }];
    const interrupted = store.insert(createSession({ cwd: '/tmp', model: 'astra', mode: 'default' }));
    interrupted.status = 'interrupted';
    interrupted.queue = [{ id: 'q2', text: 'should wait' }];

    runner.startQueued([idle, interrupted]);
    await waitFor(settled(runner, idle));
    assert.equal(cli.spawns, 1);
    assert.deepEqual(cli.last.received.map((command) => command.content), ['queued']);
    assert.equal(interrupted.queuePaused, true);
    assert.equal(interrupted.queue.length, 1);
  });

  test('a model change during a turn applies from the next turn', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) await hold.promise;
      yield successResult();
    });
    runner.enqueue(session, { text: 'first' });
    runner.enqueue(session, { text: 'second', queue: true });
    session.model = 'deepseek';
    hold.open();
    await waitFor(() => cli.last?.received.length === 2 && settled(runner, session)());
    assert.equal(cli.last.options.model, 'codex/gpt-6-astra');
    assert.deepEqual(controls(cli.last, 'setModel'), ['litellm/DeepSeek-V4-Flash']);
    const turns = session.messages.filter((m) => m.role === 'turn').map((m) => m.model);
    assert.deepEqual(turns, ['astra', 'deepseek']);
  });

  test('streaming text goes out as live events without saving the session', async () => {
    const hold = gate();
    const saves = [];
    const { runner, session, events } = setup(
      async function* () {
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } };
        await hold.promise;
        yield successResult();
      },
      { save: (s) => saves.push(s.live) },
    );
    const frames = [];
    events.subscribe({ write: (frame) => frames.push(frame) });
    runner.enqueue(session, { text: 'hi' });
    const liveFrames = () => frames.filter((frame) => frame.startsWith('event: live')).map((frame) => JSON.parse(frame.split('data: ')[1]));
    await waitFor(() => liveFrames().some((payload) => payload.live === 'Hello'));
    // The first delta goes out at once, the rest coalesce into the window's last tick.
    assert.deepEqual(liveFrames().map((payload) => payload.live), ['Hel', 'Hello']);
    const live = liveFrames()[1];
    assert.deepEqual(Object.keys(live), ['id', 'live', 'liveThinking', 'status', 'updatedAt']);
    assert.equal(live.id, session.id);
    assert.equal(live.status, 'running');
    assert.ok(!saves.includes('Hel') && !saves.includes('Hello'), 'ticks never write the session file');
    hold.open();
    await waitFor(settled(runner, session));
  });

  test('an older CLI without lifecycle frames still settles turns and acknowledges steering by its echo', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(
      async function* (turn) {
        if (turn.index === 0) {
          yield toolUse('t1');
          await hold.promise;
          yield toolResult('t1');
          turn.fold();
        }
        yield successResult();
      },
      { behavior: { lifecycle: false } },
    );
    runner.enqueue(session, { text: 'one' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    runner.enqueue(session, { text: 'steer' });
    hold.open();
    await waitFor(settled(runner, session));
    assert.equal(session.messages.find((m) => m.text === 'steer').delivery, 'done');
    runner.enqueue(session, { text: 'two' });
    await waitFor(() => cli.last.received.length === 3 && settled(runner, session)());
    assert.deepEqual(session.messages.filter((m) => m.role === 'user').map((m) => m.delivery), ['done', 'done', 'done']);
  });
});

describe('steering: messages sent while a turn runs', () => {
  test('a plain message goes to the running process at once and is read at the next step', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      yield toolUse('t1');
      await hold.promise;
      yield toolResult('t1');
      const read = turn.fold();
      yield say(`read: ${read.join(', ')}`);
      yield successResult();
    });
    runner.enqueue(session, { text: 'long job' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));

    const result = runner.enqueue(session, { text: 'also check the tests', clientId: 'c2' });
    assert.deepEqual(result, { queued: false, steering: true });
    const steer = session.messages.find((m) => m.text === 'also check the tests');
    assert.equal(steer.delivery, 'sent');
    assert.equal(steer.clientId, 'c2');
    assert.deepEqual(session.steering, [{ id: steer.id, text: 'also check the tests' }]);
    assert.deepEqual(session.queue, []);
    await waitFor(() => cli.last.received.length === 2);
    assert.equal(cli.last.received[1].priority, 'next');
    assert.equal(cli.last.received[1].content, 'also check the tests', 'sent as typed: no switch note or handoff');

    hold.open();
    await waitFor(settled(runner, session));
    assert.equal(cli.spawns, 1);
    assert.equal(steer.delivery, 'done');
    assert.deepEqual(session.steering, []);
    assert.deepEqual(
      session.messages.map((m) => (m.role === 'user' ? `user:${m.text}` : m.role === 'assistant' ? `assistant:${m.text}` : m.role)),
      ['user:long job', 'tool', 'user:also check the tests', 'assistant:read: also check the tests', 'turn'],
      'shown where Claude read it, in one turn',
    );
  });

  test('a message Claude did not fold in runs as its next turn without the session going idle', async () => {
    const hold = gate();
    const statuses = [];
    const { runner, session, cli } = setup(
      async function* (turn) {
        if (turn.index === 0) await hold.promise;
        yield say(`reply to ${turn.text}`);
        yield successResult();
      },
      { save: (s) => statuses.push(s.status) },
    );
    runner.enqueue(session, { text: 'first' });
    await waitFor(() => cli.last?.received.length === 1);
    runner.enqueue(session, { text: 'follow-up' });
    hold.open();
    await waitFor(() => session.messages.filter((m) => m.role === 'turn').length === 2 && settled(runner, session)());
    const busy = statuses.slice(statuses.indexOf('running'));
    assert.equal(busy.at(-1), 'idle');
    assert.ok(!busy.slice(0, -1).includes('idle'), `never idle in between: ${busy.join(',')}`);
    assert.deepEqual(
      session.messages.map((m) => (m.role === 'user' ? `user:${m.text}:${m.delivery}` : m.role)),
      ['user:first:done', 'assistant', 'turn', 'user:follow-up:done', 'assistant', 'turn'],
    );
  });

  test('a message not yet read can be cancelled; once read it cannot', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      yield toolUse('t1');
      await hold.promise;
      yield toolResult('t1');
      turn.fold();
      yield successResult();
    });
    runner.enqueue(session, { text: 'job' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    runner.enqueue(session, { text: 'never mind' });
    runner.enqueue(session, { text: 'keep this' });
    const [dropped, kept] = session.messages.filter((m) => m.delivery === 'sent');
    await waitFor(() => cli.last.received.length === 3);
    assert.equal(await runner.cancelQueued(session, dropped.id), true);
    assert.equal(dropped.delivery, 'cancelled');
    assert.deepEqual(session.steering.map((item) => item.text), ['keep this']);
    assert.deepEqual(controls(cli.last, 'cancelAsyncMessage').length, 1);
    hold.open();
    await waitFor(settled(runner, session));
    assert.equal(kept.delivery, 'done');
    assert.equal(await runner.cancelQueued(session, kept.id), false, 'already read');
    assert.equal(session.messages.filter((m) => m.role === 'turn').length, 1);
  });

  test('a /goal shows on the session: set by its reply, updated by active_goal, cleared by /goal clear', async () => {
    const goal = { condition: 'reach 200 steps', iterations: 2, set_at: 5, tokens_at_start: 0, last_reason: 'at step 40' };
    const { runner, session } = setup(async function* (turn) {
      if (turn.index === 0) {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Goal set: reach 200 steps' }] } };
        yield successResult();
      } else if (turn.index === 1) {
        yield { type: 'active_goal', value: goal, uuid: 'g1', session_id: 's' };
        yield successResult();
      } else yield successResult();
    });
    runner.enqueue(session, { text: '/goal reach 200 steps' });
    await waitFor(() => session.goal?.condition === 'reach 200 steps' && settled(runner, session)());
    assert.equal(publicSession(session).goal.iterations, 0);
    runner.enqueue(session, { text: 'keep going' });
    await waitFor(() => session.goal?.iterations === 2 && settled(runner, session)());
    assert.deepEqual(session.goal, { condition: 'reach 200 steps', iterations: 2, setAt: 5, lastReason: 'at step 40' });
    runner.enqueue(session, { text: '/goal clear' });
    await waitFor(() => session.goal === null && settled(runner, session)());
    assert.equal(publicSession(session).goal, null);
    assert.equal(goalOf(null), null);
    assert.equal(goalSetText({ message: { content: 'Goal set:  x y ' } }), 'x y');
    assert.equal(goalSetText({ message: { content: 'Not a goal' } }), null);
  });

  test('slash commands and explicit queueing wait for the turn to end', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) await hold.promise;
      yield successResult();
    });
    runner.enqueue(session, { text: 'job' });
    await waitFor(() => cli.last?.received.length === 1);
    assert.equal(runner.enqueue(session, { text: '/compact' }).queued, true);
    assert.equal(runner.enqueue(session, { text: 'later', queue: true }).queued, true);
    assert.deepEqual(session.queue.map((item) => item.text), ['/compact', 'later']);
    assert.deepEqual(session.steering, []);
    hold.open();
    await waitFor(() => cli.last.received.length === 3 && settled(runner, session)());
    assert.deepEqual(cli.last.received.map((command) => command.priority), [undefined, undefined, undefined]);
  });

  test('a message with attachments goes into the running turn as content blocks', async () => {
    const hold = gate();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-steer-')), 'a.png');
    tempDirs.push(path.dirname(file));
    fs.writeFileSync(file, 'PNGDATA');
    const record = { id: 'u1', name: 'a.png', type: 'image/png', size: 7, image: true, path: file };
    const uploads = { get: (id) => (id === 'u1' ? record : undefined), sessionDir: () => path.dirname(file) };
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) await hold.promise;
      yield successResult();
    }, { uploads });
    runner.enqueue(session, { text: 'job' });
    await waitFor(() => cli.last?.received.length === 1);
    const attachment = { id: 'u1', name: 'a.png', type: 'image/png', size: 7 };
    assert.deepEqual(runner.enqueue(session, { text: 'see this', attachments: [attachment] }), { queued: false, steering: true });
    await waitFor(() => cli.last.received.length === 2);
    const steered = cli.last.received[1];
    assert.equal(steered.priority, 'next');
    assert.deepEqual(steered.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } },
      { type: 'text', text: `see this\n\nAttached files:\n- ${file} (image, shown above)` },
    ]);
    assert.deepEqual(session.queue, []);
    hold.open();
    await waitFor(settled(runner, session));
  });

  test('stop interrupts the turn and drops unread messages back into the paused queue; the process stays', async () => {
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) {
        yield toolUse('t1');
        await turn.interrupted;
      }
      yield successResult();
    });
    runner.enqueue(session, { text: 'long job' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    runner.enqueue(session, { text: 'steer' });
    runner.enqueue(session, { text: 'later', queue: true });
    await waitFor(() => cli.last.received.length === 2);
    runner.stop(session);
    await waitFor(() => settled(runner, session)() && session.queue.length === 2);

    assert.deepEqual(controls(cli.last, 'interrupt'), [{ cancelQueued: true }]);
    assert.equal(session.status, 'idle');
    assert.equal(session.queuePaused, true);
    assert.deepEqual(session.queue.map((item) => item.text), ['steer', 'later'], 'the unread message waits first');
    assert.equal(session.messages.find((m) => m.text === 'steer').delivery, 'queued');
    assert.deepEqual(session.steering, []);
    assert.equal(session.messages.find((m) => m.text === 'long job').delivery, 'stopped');
    const notices = session.messages.filter((m) => m.role === 'notice');
    assert.deepEqual(notices.map(({ text, level }) => ({ text, level })), [{ text: NOTICES.stopped, level: 'info' }]);
    const turn = session.messages.find((m) => m.role === 'turn');
    assert.equal(turn.isError, false);
    assert.equal(turn.stopped, true);
    assert.equal(session.messages.find((m) => m.role === 'tool').state, 'error', 'a tool cut off by the stop does not spin forever');

    runner.resumeQueue(session);
    await waitFor(() => cli.last.received.length === 4 && settled(runner, session)());
    assert.equal(cli.spawns, 1, 'the interrupted process takes the next turns');
    assert.deepEqual(cli.last.received.slice(2).map((command) => command.content), ['steer', 'later']);
  });

  /** A first turn that runs a tool until it is interrupted; later turns answer their message. */
  const longStep = async function* (turn) {
    if (turn.index === 0) {
      yield toolUse('t1');
      await turn.interrupted;
    }
    yield say(`answer to ${turn.text}`);
    yield successResult();
  };

  test('interrupt and send now ends the step; the waiting messages run next in the same process, without an error or a pause', async () => {
    const { runner, session, cli } = setup(longStep);
    runner.enqueue(session, { text: 'long job' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    runner.enqueue(session, { text: 'steer one' });
    runner.enqueue(session, { text: 'steer two' });
    runner.enqueue(session, { text: 'after', queue: true });
    await waitFor(() => cli.last.received.length === 3);

    assert.equal(await runner.interrupt(session), true);
    await waitFor(() => settled(runner, session)() && session.queue.length === 0);
    assert.deepEqual(controls(cli.last, 'interrupt'), [{}], 'a plain interrupt: the waiting messages stay queued');
    assert.equal(cli.spawns, 1);
    assert.equal(session.status, 'idle');
    assert.equal(session.queuePaused, false);
    assert.deepEqual(session.steering, []);
    const delivery = (text) => session.messages.find((m) => m.role === 'user' && m.text === text).delivery;
    assert.deepEqual(['long job', 'steer one', 'steer two', 'after'].map(delivery), ['interrupted', 'done', 'done', 'done']);
    const notices = session.messages.filter((m) => m.role === 'notice');
    assert.deepEqual(notices.map(({ text, level }) => ({ text, level })), [{ text: NOTICES.interrupted, level: 'info' }]);
    const [first] = session.messages.filter((m) => m.role === 'turn');
    assert.equal(first.isError, false);
    assert.equal(first.interrupted, true);
    assert.equal(first.stopped, undefined);
    assert.equal(session.messages.find((m) => m.role === 'tool').state, 'error', 'the interrupted tool call is settled');
    assert.ok(session.messages.some((m) => m.role === 'assistant' && m.text === 'answer to steer one'));
  });

  for (const drops of ['cancelled', 'silent']) {
    test(`messages Claude Code drops on the interrupt (${drops}) are sent again at once`, async () => {
      const { runner, session, cli } = setup(longStep, { behavior: { interruptDrops: drops } });
      runner.enqueue(session, { text: 'long job' });
      await waitFor(() => session.messages.some((m) => m.role === 'tool'));
      runner.enqueue(session, { text: 'steer' });
      await waitFor(() => cli.last.received.length === 2);
      assert.equal(await runner.interrupt(session), true);
      await waitFor(() => settled(runner, session)() && session.messages.find((m) => m.text === 'steer').delivery === 'done');
      assert.deepEqual(
        cli.last.received.map((command) => command.content),
        ['long job', 'steer', 'steer'],
        'sent again after the drop',
      );
      assert.equal(cli.spawns, 1);
      assert.equal(session.status, 'idle');
      assert.equal(session.queuePaused, false);
      assert.deepEqual(session.queue, []);
      assert.ok(session.messages.some((m) => m.role === 'assistant' && m.text === 'answer to steer'));
    });
  }

  test('interrupt and send now needs a running turn and waiting messages; a failed interrupt leaves them waiting', async () => {
    const { runner, session, cli } = setup(longStep, { behavior: { interruptFails: true } });
    assert.equal((await runner.interrupt(session)).status, 409, 'nothing running');
    runner.enqueue(session, { text: 'long job' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    assert.equal((await runner.interrupt(session)).status, 409, 'nothing waiting');
    runner.enqueue(session, { text: 'steer' });
    const failed = await runner.interrupt(session);
    assert.equal(failed.status, 502);
    assert.deepEqual(session.steering.map((item) => item.text), ['steer']);
    assert.equal(session.status, 'running');
    assert.equal(session.messages.find((m) => m.text === 'long job').delivery, 'running');
    cli.last.current.interrupt(); // the turn ends some other way
    await waitFor(settled(runner, session));
    assert.equal(session.messages.find((m) => m.text === 'steer').delivery, 'done');
  });

  test('a message sent while the turn is still starting is held and follows the first message', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) await hold.promise;
      yield successResult();
    });
    runner.enqueue(session, { text: 'first' });
    // runTurn has not reached the process yet (it awaits the prompt first).
    assert.equal(runner.enqueue(session, { text: 'right behind' }).steering, true);
    await waitFor(() => cli.last?.received.length === 2);
    assert.deepEqual(cli.last.received.map((command) => command.content), ['first', 'right behind']);
    hold.open();
    await waitFor(() => session.messages.filter((m) => m.role === 'turn').length === 2 && settled(runner, session)());
  });
});

describe('stop, live mode changes and process edges', () => {
  test('stop kills the process when the interrupt does not end the turn in time; the next turn resumes', async () => {
    const { runner, session, cli } = setup(
      async function* (turn) {
        if (turn.index === 0) await new Promise(() => {});
        yield successResult();
      },
      { stopGraceMs: 30, behavior: { interruptIgnored: true } },
    );
    runner.enqueue(session, { text: 'stuck' });
    await waitFor(() => session.sdkSessionId === 'sdk-1');
    const started = Date.now();
    runner.stop(session);
    await waitFor(settled(runner, session));
    assert.ok(Date.now() - started >= 25, 'waited for the grace period');
    assert.equal(session.status, 'idle');
    assert.equal(session.messages.at(-1).text, NOTICES.stopped);
    assert.equal(cli.processes[0].ended, true);

    session.queuePaused = false;
    runner.enqueue(session, { text: 'again' });
    await waitFor(() => cli.spawns === 2 && settled(runner, session)());
    assert.equal(cli.last.options.resume, 'sdk-1');
  });

  test('a second stop kills at once', async () => {
    const { runner, session, cli } = setup(
      async function* () {
        await new Promise(() => {});
      },
      { stopGraceMs: 60_000, behavior: { interruptIgnored: true } },
    );
    runner.enqueue(session, { text: 'stuck' });
    await waitFor(() => session.sdkSessionId === 'sdk-1');
    runner.stop(session);
    await sleep(20);
    assert.equal(runner.isRunning(session.id), true, 'still waiting for the interrupt');
    runner.stop(session);
    await waitFor(settled(runner, session));
    assert.equal(session.messages.at(-1).text, NOTICES.stopped);
    assert.equal(cli.last.ended, true);
  });

  test('a failing interrupt is logged and falls back to killing the process', async () => {
    const logged = [];
    const { runner, session } = setup(
      async function* () {
        await new Promise(() => {});
      },
      { stopGraceMs: 60_000, behavior: { interruptFails: true }, log: (message) => logged.push(message) },
    );
    runner.enqueue(session, { text: 'stuck' });
    await waitFor(() => session.sdkSessionId === 'sdk-1');
    runner.stop(session);
    await waitFor(settled(runner, session));
    assert.equal(session.messages.at(-1).text, NOTICES.stopped);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Interrupt failed .*interrupt not supported/);
  });

  test('stop denies pending approvals, and a request in flight when Stop is pressed is denied without a prompt', async () => {
    let decision;
    let late;
    const { runner, session } = setup(async function* (turn) {
      decision = await turn.options.canUseTool('Bash', { command: 'sleep 100' }, { signal: signal(), toolUseID: 't1' });
      late = await turn.options.canUseTool('Bash', { command: 'rm -rf x' }, { signal: signal(), toolUseID: 't9' });
      await turn.interrupted;
    });
    session.mode = 'default';
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => session.status === 'waiting');
    runner.stop(session);
    await waitFor(settled(runner, session));
    assert.deepEqual(decision, { behavior: 'deny', message: 'Session stopped', interrupt: true });
    assert.deepEqual(late, { behavior: 'deny', message: 'Session stopped', interrupt: true });
    assert.deepEqual(session.pending, []);
  });

  test('mode changes reach the live process at once; auto runs as default on gateway models', async () => {
    const hold = gate();
    const logged = [];
    const { runner, session, cli } = setup(
      async function* () {
        await hold.promise;
        yield successResult();
      },
      { log: (message) => logged.push(message), behavior: { failMode: (mode) => mode === 'plan' } },
    );
    runner.applyMode(session); // no process yet: nothing to do
    runner.enqueue(session, { text: 'go' });
    await waitFor(() => session.sdkSessionId === 'sdk-1');
    for (const mode of ['acceptEdits', 'auto', 'plan']) {
      session.mode = mode;
      runner.sessionChanged(session, { mode });
    }
    await waitFor(() => logged.length === 1);
    assert.deepEqual(controls(cli.last, 'setPermissionMode'), ['acceptEdits', 'default', 'plan']);
    assert.match(logged[0], /Could not switch session .* to plan: cannot switch now/);
    hold.open();
    await waitFor(settled(runner, session));
  });

  test('a crash between turns is silent; the next turn resumes in a new process', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield successResult();
    });
    runner.enqueue(session, { text: 'one' });
    await waitFor(settled(runner, session));
    cli.last.crash();
    await sleep(10);
    assert.equal(session.status, 'idle');
    assert.equal(session.messages.filter((m) => m.role === 'notice').length, 0);
    runner.enqueue(session, { text: 'two' });
    await waitFor(() => cli.spawns === 2 && settled(runner, session)());
    assert.equal(cli.last.options.resume, 'sdk-1');
    assert.equal(session.messages.find((m) => m.text === 'two').delivery, 'done');
  });

  test('a crash mid-turn settles the turn with the error and puts unread messages back in the queue', async () => {
    const hold = gate();
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) {
        yield toolUse('t1');
        await hold.promise;
        throw new Error('Claude Code process exited with code 1');
      }
      yield successResult();
    });
    runner.enqueue(session, { text: 'job' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    runner.enqueue(session, { text: 'steer' });
    await waitFor(() => cli.last.received.length === 2);
    hold.open();
    await waitFor(settled(runner, session));
    assert.equal(session.status, 'error');
    assert.equal(session.queuePaused, true);
    assert.equal(session.messages.find((m) => m.role === 'notice').text, 'Claude Code process exited with code 1');
    assert.equal(session.messages.find((m) => m.text === 'job').delivery, 'error');
    assert.equal(session.messages.find((m) => m.role === 'tool').state, 'error');
    assert.deepEqual(session.queue.map((item) => item.text), ['steer']);
    runner.resumeQueue(session);
    await waitFor(() => cli.spawns === 2 && settled(runner, session)());
    assert.equal(cli.last.options.resume, 'sdk-1');
    assert.deepEqual(cli.last.received.map((command) => command.content), ['steer']);
  });

  test('an unused process closes after the idle time; the next turn resumes', async () => {
    const { runner, session, cli } = setup(
      async function* () {
        yield successResult();
      },
      { idleMs: 40 },
    );
    runner.enqueue(session, { text: 'one' });
    await waitFor(settled(runner, session));
    await waitFor(() => cli.last.ended);
    assert.deepEqual(cli.last.controls, [], 'closed by ending its input');
    assert.equal(runner.pool.size, 0);
    assert.equal(session.status, 'idle');
    assert.equal(session.messages.filter((m) => m.role === 'notice').length, 0);
    runner.enqueue(session, { text: 'two' });
    await waitFor(() => cli.spawns === 2 && settled(runner, session)());
    assert.equal(cli.last.options.resume, 'sdk-1');
  });

  test('a process running background work is not closed for being idle', async () => {
    const { runner, session, cli } = setup(
      async function* () {
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_agent', description: 'x' }] };
        yield successResult();
      },
      { idleMs: 30 },
    );
    runner.enqueue(session, { text: 'one' });
    await waitFor(settled(runner, session));
    await sleep(90);
    assert.equal(cli.last.ended, false);
    cli.last.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await waitFor(() => cli.last.ended);
  });

  test('at the process cap the least recently used idle process closes first', async () => {
    const { runner, session, cli, store } = setup(
      async function* () {
        yield successResult();
      },
      { maxProcesses: 2 },
    );
    const second = store.insert(createSession({ cwd: session.cwd, model: 'astra', mode: 'default' }));
    const third = store.insert(createSession({ cwd: session.cwd, model: 'astra', mode: 'default' }));
    for (const target of [session, second]) {
      runner.enqueue(target, { text: 'hi' });
      await waitFor(settled(runner, target));
    }
    // The first session is used again, so the second is now the least recently used.
    runner.enqueue(session, { text: 'again' });
    await waitFor(() => cli.processes[0].received.length === 2 && settled(runner, session)());
    runner.enqueue(third, { text: 'hi' });
    await waitFor(settled(runner, third));
    await waitFor(() => cli.processes[1].ended);
    assert.equal(cli.processes[0].ended, false);
    assert.equal(cli.processes[2].ended, false);
    assert.equal(runner.pool.size, 2);
  });

  test('Claude Code starting a turn of its own (a background agent finished) shows as running, then idle', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield say('started a background agent');
      yield successResult();
    });
    runner.enqueue(session, { text: 'delegate' });
    await waitFor(settled(runner, session));
    const endedAt = session.turnEndedAt;
    const hold = gate();
    cli.last.ownTurn(async function* () {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
      await hold.promise;
      yield say('the agent is done');
      yield successResult();
    });
    await waitFor(() => runner.isRunning(session.id));
    assert.equal(session.status, 'running');
    hold.open();
    await waitFor(settled(runner, session));
    assert.equal(session.status, 'idle');
    assert.ok(session.turnEndedAt >= endedAt);
    assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant', 'turn', 'assistant', 'turn']);
    assert.equal(cli.spawns, 1);
  });

  test('a background subagent keeps running after the turn that started it ends', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield toolUse('agent-1', 'Agent', { description: 'look around', prompt: 'x', run_in_background: true });
      yield {
        type: 'user',
        parent_tool_use_id: null,
        tool_use_result: { status: 'async_launched' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'launched' }] },
      };
      yield toolUse('sub-1', 'Read', { file_path: '/x' });
      yield successResult();
    });
    runner.enqueue(session, { text: 'delegate' });
    await waitFor(settled(runner, session));
    // Nest the Read under the agent the way subagent messages arrive.
    const read = session.messages.find((m) => m.toolId === 'sub-1');
    assert.equal(read.state, 'error', 'a top-level tool without a result is settled');
    const agent = session.messages.find((m) => m.toolId === 'agent-1');
    assert.equal(agent.state, 'running');
    assert.equal(agent.background, true);
    cli.last.emit({ type: 'system', subtype: 'task_notification', tool_use_id: 'agent-1', status: 'completed', summary: 'found it' });
    await waitFor(() => agent.state === 'done');
    assert.equal(session.status, 'idle');
  });

  test('a background subagent ends with its process when a route switch replaces it', async () => {
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) {
        yield toolUse('agent-1', 'Agent', { description: 'look around', prompt: 'x', run_in_background: true });
        yield {
          type: 'user',
          parent_tool_use_id: null,
          tool_use_result: { status: 'async_launched' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'launched' }] },
        };
      }
      yield say('ok');
      yield successResult();
    });
    runner.enqueue(session, { text: 'delegate' });
    await waitFor(settled(runner, session));
    const agent = session.messages.find((m) => m.toolId === 'agent-1');
    assert.equal(agent.state, 'running');
    session.model = 'opus';
    runner.enqueue(session, { text: 'on opus' });
    await waitFor(() => cli.spawns === 2 && session.messages.at(-1).role === 'turn' && settled(runner, session)());
    assert.equal(agent.state, 'error', 'it can never report back now');
    assert.equal(publicSession(session).backgroundAgents, 0);
  });

  test('a permission request from inside a subagent names the agent', async () => {
    const { runner, session } = setup(async function* (turn) {
      yield toolUse('agent-1', 'Agent', { description: 'look around', prompt: 'x', subagent_type: 'Explore' });
      yield { type: 'assistant', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash', input: { command: 'touch x' } }] } };
      // As on the CLI's stdout, the runner has read the call before the request.
      await sleep(20);
      await turn.tool('Bash', { command: 'touch x' }, 'sub-1');
      yield successResult();
    });
    session.mode = 'default';
    runner.enqueue(session, { text: 'delegate' });
    await waitFor(() => session.pending?.length === 1);
    assert.deepEqual(session.pending[0].agent, { toolId: 'agent-1', description: 'look around', subagentType: 'Explore' });
    assert.equal(runner.resolveApproval(session.pending[0].id, { decision: 'allow' }), true);
    await waitFor(settled(runner, session));
  });

  test('shutdown kills running processes with the maintenance notice and blocks new turns', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield toolUse('t1');
      await new Promise(() => {});
    });
    runner.enqueue(session, { text: 'working' });
    await waitFor(() => session.messages.some((m) => m.role === 'tool'));
    runner.enqueue(session, { text: 'steer' });
    runner.enqueue(session, { text: 'next', queue: true });
    await waitFor(() => cli.last.received.length === 2);
    runner.shutdown();
    await waitFor(settled(runner, session));
    assert.equal(session.messages.filter((m) => m.role === 'notice').at(-1).text, NOTICES.maintenance);
    assert.equal(cli.spawns, 1, 'no new turn starts during shutdown');
    assert.equal(cli.last.ended, true);
    assert.deepEqual(session.queue.map((item) => item.text), ['steer', 'next']);
    assert.equal(runner.enqueue(session, { text: 'after' }).queued, true);
    await sleep(10);
    assert.equal(cli.spawns, 1);
  });
});

describe('imported sessions', () => {
  const HANDOFF = '[Harbor: the user imported this conversation from a Codex session]\n\n<codex_history>\n## Turn 1\nUser: add a README\n</codex_history>';
  const optionsArgs = {
    model: findModel('luna'),
    effort: 'medium',
    claudeExecutable: '/c',
    gateway: { url: 'http://127.0.0.1:1', apiKey: 'k' },
    abortController: new AbortController(),
    canUseTool: async () => ({ behavior: 'allow' }),
  };

  test('buildQueryOptions forks an imported Claude Code session and starts a handoff turn fresh', () => {
    const forked = buildQueryOptions({ mode: 'default', cwd: '/w', forkFrom: 'orig', sdkSessionId: 'failed-fork' }, optionsArgs);
    assert.equal(forked.resume, 'orig');
    assert.equal(forked.forkSession, true);
    const fresh = buildQueryOptions({ mode: 'default', cwd: '/w', sdkSessionId: 's' }, { ...optionsArgs, fresh: true });
    assert.equal(fresh.resume, undefined);
    assert.equal(fresh.forkSession, undefined);
    const resumed = buildQueryOptions({ mode: 'default', cwd: '/w', sdkSessionId: 's' }, optionsArgs);
    assert.equal(resumed.resume, 's');
    assert.equal(resumed.forkSession, undefined);
  });

  test('turnPrompt puts the Codex history in front without a switch note; slash commands stay bare', () => {
    const luna = findModel('luna');
    const session = { messages: [{ role: 'assistant', text: 'old', model: 'astra' }], handoff: HANDOFF };
    assert.equal(turnPrompt(session, luna, 'continue'), `${HANDOFF}\n\ncontinue`);
    assert.equal(turnPrompt(session, luna, '/compact'), '/compact');
    const blocks = [{ type: 'text', text: 'see this' }];
    assert.deepEqual(turnPrompt(session, luna, blocks), [{ type: 'text', text: HANDOFF }, ...blocks]);
  });

  test('a forked Claude Code import on another model gets the switch note', () => {
    const session = { messages: [], forkFrom: 'orig', lastTurnModel: 'opus' };
    assert.match(turnPrompt(session, findModel('luna'), 'next'), /^\[Harbor: from this message on you are GPT-6 Luna .*ran on Claude Opus 5\.5\.[^\]]*\]\n\nnext$/);
    assert.equal(turnPrompt({ ...session, lastTurnModel: 'luna' }, findModel('luna'), 'next'), 'next');
  });


  test('the first turn forks the original; the fork is continued in the same process', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield say('ok');
      yield successResult();
    });
    session.forkFrom = 'orig';
    runner.enqueue(session, { text: 'first' });
    await waitFor(settled(runner, session));
    assert.equal(cli.last.options.resume, 'orig');
    assert.equal(cli.last.options.forkSession, true);
    assert.equal(session.forkFrom, undefined);
    assert.equal(session.sdkSessionId, 'sdk-1');

    runner.enqueue(session, { text: 'second' });
    await waitFor(() => cli.last.received.length === 2 && settled(runner, session)());
    assert.equal(cli.spawns, 1);
  });

  test('a first turn that fails before the model answers forks again on retry', async () => {
    const { runner, session, cli } = setup(async function* (turn) {
      if (turn.index === 0) throw new Error('Claude Code could not start');
      // An error result: the process lives on, but holds a half-started fork.
      if (turn.index === 1) yield successResult({ is_error: true, errors: ['gateway exploded'] });
      yield say('ok');
      yield successResult();
    });
    session.forkFrom = 'orig';
    for (const expected of [1, 2, 3]) {
      session.queuePaused = false;
      runner.enqueue(session, { text: `try ${expected}` });
      await waitFor(() => cli.spawns === expected && settled(runner, session)());
      const proc = cli.processes[expected - 1];
      assert.equal(proc.options.resume, 'orig', `attempt ${expected} forks the original`);
      assert.equal(proc.options.forkSession, true);
    }
    assert.equal(session.forkFrom, undefined, 'cleared once the model answered');
    assert.equal(session.sdkSessionId, 'sdk-3');
    await waitFor(() => cli.processes[1].ended);
  });

  test('a failed first turn on another model keeps the switch note for the retry', async () => {
    const { runner, session, prompts } = setup(async function* (turn) {
      if (turn.index === 0) throw new Error('gateway exploded');
      yield say('ok');
      yield successResult();
    });
    session.forkFrom = 'orig';
    session.lastTurnModel = 'luna';
    runner.enqueue(session, { text: 'continue' });
    await waitFor(settled(runner, session));
    assert.notEqual(prompts()[0], 'continue', 'the first attempt carries the switch note');
    assert.equal(session.lastTurnModel, 'luna', 'not recorded before the model answered');

    session.queuePaused = false;
    runner.enqueue(session, { text: 'continue' });
    await waitFor(() => prompts().length === 2 && settled(runner, session)());
    assert.equal(prompts()[1], prompts()[0], 'the retry forks the original again, with the note');
    assert.equal(session.lastTurnModel, 'astra');
  });

  test('the Codex history goes with the first turn only, and a retry never resumes a half-started one', async () => {
    const { runner, session, cli, prompts } = setup(async function* (turn) {
      if (turn.index === 1) throw new Error('gateway exploded');
      yield say('ok');
      yield successResult();
    });
    session.handoff = HANDOFF;
    // A slash command first: sent bare, the history waits.
    runner.enqueue(session, { text: '/compact' });
    await waitFor(settled(runner, session));
    assert.deepEqual(prompts(), ['/compact']);
    assert.equal(session.handoff, HANDOFF);

    runner.enqueue(session, { text: 'go on' });
    await waitFor(() => cli.spawns === 2 && settled(runner, session)());
    assert.equal(prompts()[1], `${HANDOFF}\n\ngo on`);
    assert.equal(cli.processes[1].options.resume, undefined, 'the history opens a new conversation');
    assert.equal(session.handoff, HANDOFF, 'kept: the model never answered');

    session.queuePaused = false;
    runner.enqueue(session, { text: 'go on' });
    await waitFor(() => cli.spawns === 3 && settled(runner, session)());
    assert.equal(prompts()[2], `${HANDOFF}\n\ngo on`);
    assert.equal(cli.processes[2].options.resume, undefined, 'not the half-started sdk-2');
    assert.equal(session.handoff, undefined);

    runner.enqueue(session, { text: 'next' });
    await waitFor(() => prompts().length === 4 && settled(runner, session)());
    assert.equal(prompts()[3], 'next');
    assert.equal(cli.spawns, 3, 'continued in the same process');
    assert.equal(session.sdkSessionId, 'sdk-3');
    assert.deepEqual(userTexts(session), ['/compact', 'go on', 'go on', 'next'], 'the transcript keeps what the user typed');
  });
});

describe('MCP servers switched off for a session', () => {
  const rows = [{ name: 'echo', status: 'connected', scope: 'project', source: 'project', config: { type: 'stdio' }, tools: [{ name: 'echo' }] }];
  const ok = async function* () {
    yield say('ok');
    yield successResult();
  };

  test('worker processes get the deny rules in their start settings; a session process is told after it starts', () => {
    const args = { model: findModel('luna'), effort: 'medium', claudeExecutable: '/x', gateway: { url: 'http://127.0.0.1:1', apiKey: 'k' }, abortController: new AbortController() };
    const session = { mode: 'default', cwd: '/w', mcpDisabled: ['echo', 'claude.ai Slack'] };
    assert.deepEqual(buildQueryOptions(session, args).settings.permissions.deny, ['mcp__echo', 'mcp__claude_ai_Slack']);
    assert.equal(buildQueryOptions(session, { ...args, mcpDeny: false }).settings.permissions, undefined);
    assert.equal(buildQueryOptions({ mode: 'default', cwd: '/w' }, args).settings.permissions, undefined, 'nothing switched off, nothing denied');
    // Grants stay when the deny rules are added.
    const granted = buildQueryOptions({ ...session, allowRules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }, args).settings.permissions;
    assert.deepEqual([granted.allow, granted.deny], [['Bash(ls:*)'], ['mcp__echo', 'mcp__claude_ai_Slack']]);
  });

  test('a new process hides them through flag settings before it is sent anything', async () => {
    const { runner, session, cli } = setup(ok, { behavior: { mcp: rows } });
    session.mcpDisabled = ['echo'];
    runner.enqueue(session, { text: 'hello' });
    await waitFor(settled(runner, session));
    const [proc] = cli.processes;
    assert.deepEqual(proc.events.slice(0, 2), ['flags', 'user']);
    assert.deepEqual(controls(proc, 'applyFlagSettings'), [{ permissions: { deny: ['mcp__echo'] } }]);
    assert.equal(proc.options.settings.permissions?.deny, undefined, 'not a start option: a tool denied at start cannot come back');
    assert.deepEqual(proc.toolsOffered(), []);
  });

  test('a process that cannot hide them is not sent the message: the turn fails and the process goes', async () => {
    const { runner, session, cli } = setup(ok, { behavior: { mcp: rows, applyFlagFails: 'flag settings refused' } });
    session.mcpDisabled = ['echo'];
    runner.enqueue(session, { text: 'hello' });
    await waitFor(settled(runner, session));
    assert.equal(session.status, 'error');
    assert.match(session.messages.at(-1).text, /could not hide the MCP servers switched off for this session: flag settings refused/);
    assert.deepEqual(cli.processes.flatMap((proc) => proc.received), [], 'nothing reached a model');
    await waitFor(() => cli.processes.every((proc) => proc.ended));
  });

  test('sessions with nothing switched off start as before', async () => {
    const { runner, session, cli } = setup(ok, { behavior: { mcp: rows } });
    runner.enqueue(session, { text: 'hello' });
    await waitFor(settled(runner, session));
    assert.deepEqual(cli.last.events, ['user']);
    assert.deepEqual(cli.last.toolsOffered(), ['mcp__echo__echo']);
  });
});

describe('starting Claude Code ahead of a message', () => {
  afterEach(() => setContextLimits({}));

  test('warm starts a session\'s process, sending nothing; the next message uses it', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield successResult();
    });
    assert.equal(runner.warm(session), true);
    await waitFor(() => cli.spawns === 1);
    assert.equal(runner.warm(session), false, 'already up');
    assert.deepEqual(cli.processes[0].received, []);
    runner.enqueue(session, { text: 'hi', clientId: 'c1' });
    await waitFor(settled(runner, session));
    assert.equal(cli.spawns, 1);
    assert.deepEqual(cli.processes[0].received.map((c) => c.content), ['hi']);
    assert.equal(runner.warm({ ...session, id: 'imported', forkFrom: 'abc' }), false, 'an import forks on its first turn');
  });

  test('a prepared session stays unsaved and unpublished until a send with the same settings adopts it', async () => {
    const saved = [];
    const { runner, store, cli } = setup(
      async function* () {
        yield successResult();
      },
      { save: (session) => saved.push(session.id) },
    );
    const first = createSession({ cwd: '/w', model: 'astra', mode: 'bypassPermissions' });
    const id = runner.prepare(first, 'key-a');
    assert.equal(id, first.id);
    await waitFor(() => cli.spawns === 1);
    assert.equal(runner.prepare(createSession({ cwd: '/w', model: 'astra', mode: 'bypassPermissions' }), 'key-a'), id, 'same settings: kept');
    assert.equal(cli.spawns, 1);

    // Other settings replace it, closing its process.
    const second = createSession({ cwd: '/w', model: 'luna', mode: 'bypassPermissions' });
    assert.equal(runner.prepare(second, 'key-b'), second.id);
    await waitFor(() => cli.processes[0].ended && cli.spawns === 2);
    assert.equal(runner.adopt(id, 'key-a'), null, 'gone');
    assert.equal(runner.adopt(second.id, 'key-other'), null, 'a send with other settings does not take it');
    await waitFor(() => cli.processes[1].ended);

    const third = createSession({ cwd: '/w', model: 'astra', mode: 'bypassPermissions' });
    runner.prepare(third, 'key-c');
    await waitFor(() => cli.spawns === 3);
    assert.deepEqual(saved.filter((s) => s === third.id), [], 'never saved while prepared');
    const adopted = runner.adopt(third.id, 'key-c');
    assert.equal(adopted, third);
    assert.equal(adopted.prepared, undefined);
    store.insert(adopted);
    runner.enqueue(adopted, { text: 'hello', clientId: 'c1' });
    await waitFor(settled(runner, adopted));
    assert.equal(cli.spawns, 3, 'the first message went to the prepared process');
    assert.deepEqual(cli.processes[2].received.map((c) => c.content), ['hello']);
    assert.ok(saved.includes(third.id));
  });

  test('a changed context limit starts a new process at the next turn', async () => {
    const { runner, session, cli } = setup(async function* () {
      yield { type: 'assistant', uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: 5000 } } };
      yield successResult();
    });
    runner.enqueue(session, { text: 'one', clientId: 'c1' });
    await waitFor(settled(runner, session));
    assert.equal(cli.processes[0].options.settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '400000');
    setContextLimits({ astra: 150_000 });
    runner.enqueue(session, { text: 'two', clientId: 'c2' });
    await waitFor(() => settled(runner, session)() && cli.spawns === 2 && cli.processes[1].received.length === 1);
    assert.equal(cli.processes[1].options.settings.autoCompactWindow, 120_000);
    assert.equal(cli.processes[1].options.settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '150000');
    assert.deepEqual(session.context, { used: 5010, window: 150_000, compactAt: 87_000 });
  });
});

describe('Claude routes through the gateway Claude relay', () => {
  test('while the relay answers, Claude uses managed relay auth without a local login', async () => {
    let up = true;
    const gatewayServer = (await import('node:http')).createServer((req, res) => {
      res.writeHead(up && req.url === '/_relay/status' ? 200 : 404);
      res.end('{}');
    });
    await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${gatewayServer.address().port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-relay-'));
    tempDirs.push(dataDir);
    const store = createStore({ dataDir });
    const events = createEvents({ save: store.save, toPublic: publicSession, throttleMs: 1 });
    const cli = createFakeCli(async function* () {
      yield successResult();
    });
    // As in server.mjs: the proxy authenticates both gateway and Claude relay traffic.
    const proxy = { url: 'http://127.0.0.1:9/proxy', apiKey: 'proxy-secret' };
    const runner = createRunner({ config: { gatewayUrl: url, relayStatusPath: '/_relay/status', claudeExecutable: '/nonexistent/claude' }, gateway: proxy, events, query: cli.query, closeGraceMs: 50, log: () => {} });
    runners.push(runner);
    try {
      const claude = store.insert(createSession({ cwd: dataDir, model: 'opus', mode: 'bypassPermissions' }));
      runner.enqueue(claude, { text: 'hi', clientId: 'c1' }); // at once: the first check is awaited
      await waitFor(settled(runner, claude));
      const env = cli.processes[0].options.env;
      assert.equal(env.ANTHROPIC_BASE_URL, `${proxy.url}/claude-relay`);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'harbor-relay');
      assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'X-Harbor-Key: proxy-secret');
      assert.equal(env.ANTHROPIC_API_KEY, undefined, 'managed OAuth, no API billing key');
      assert.equal(env.ENABLE_TOOL_SEARCH, 'true');
      assert.equal(cli.processes[0].options.model, 'claude-opus-5-5');

      const gatewayChat = store.insert(createSession({ cwd: dataDir, model: 'astra', mode: 'bypassPermissions' }));
      runner.enqueue(gatewayChat, { text: 'hi', clientId: 'c2' });
      await waitFor(settled(runner, gatewayChat));
      assert.equal(cli.processes[1].options.env.ANTHROPIC_BASE_URL, proxy.url, 'gateway models are unchanged');
      assert.equal(cli.processes[1].options.env.ENABLE_TOOL_SEARCH, 'true');
    } finally {
      up = false;
      gatewayServer.close();
    }
  });

  test('turned off, or with the relay down, Claude goes direct', async () => {
    const { runner, store, cli } = setup(async function* () {
      yield successResult();
    });
    const claude = store.insert(createSession({ cwd: os.tmpdir(), model: 'sonnet', mode: 'bypassPermissions' }));
    await sleep(50);
    runner.enqueue(claude, { text: 'hi', clientId: 'c1' });
    await waitFor(settled(runner, claude));
    assert.equal(cli.processes[0].options.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(cli.processes[0].options.env.ENABLE_TOOL_SEARCH, undefined);
  });

  test('without a relay status path there is no relay: nothing is probed and Claude goes direct', async () => {
    const asked = [];
    const gatewayServer = (await import('node:http')).createServer((req, res) => {
      asked.push(req.url);
      res.writeHead(200);
      res.end('{}');
    });
    await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-relay-'));
    tempDirs.push(dataDir);
    const store = createStore({ dataDir });
    const events = createEvents({ save: store.save, toPublic: publicSession, throttleMs: 1 });
    const cli = createFakeCli(async function* () {
      yield successResult();
    });
    const proxy = { url: 'http://127.0.0.1:9/proxy', apiKey: 'proxy-secret' };
    const runner = createRunner({ config: { gatewayUrl: `http://127.0.0.1:${gatewayServer.address().port}`, claudeExecutable: '/nonexistent/claude' }, gateway: proxy, events, query: cli.query, closeGraceMs: 50, log: () => {} });
    runners.push(runner);
    try {
      const claude = store.insert(createSession({ cwd: dataDir, model: 'opus', mode: 'bypassPermissions' }));
      runner.enqueue(claude, { text: 'hi', clientId: 'c1' });
      await waitFor(settled(runner, claude));
      assert.equal(cli.processes[0].options.env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(cli.processes[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.deepEqual(asked, []);
    } finally {
      gatewayServer.close();
    }
  });
});
