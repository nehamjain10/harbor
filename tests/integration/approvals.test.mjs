// Approvals end to end: real Claude Code turns (the CLI at ~/.local/bin/claude) through
// the runner, the normalizing proxy and the mock gateway, answered the way the
// approvals route answers them. Isolated from the user's setup: no settings sources
// and a throwaway CLAUDE_CONFIG_DIR. Run with `npm run test:integration`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { KEEP_PLANNING_MESSAGE } from '../../server/approvals.mjs';
import { createEvents } from '../../server/events.mjs';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { createRunner } from '../../server/runner.mjs';
import { closeRunners, observedQuery } from './helpers.mjs';
import { createSession, createStore, publicSession } from '../../server/store.mjs';
import { startMockGateway } from '../mock-gateway.mjs';

const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const skip = !fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`;
const TURN_TIMEOUT_MS = 60_000;

let base;
let mock;
let proxy;
const runners = [];

before(async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-approvals-'));
  mock = await startMockGateway();
  proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
});

after(async () => {
  await closeRunners(runners);
  await proxy?.close();
  await mock?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/**
 * A runner wired like server.mjs whose SDK query is observed: `asked` lists every
 * canUseTool call the CLI made, `spawns` each Claude Code process (its options and the
 * control calls it got), `statusModes` the permission modes the CLI reported.
 */
function harness(mode) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const work = path.join(dir, 'work');
  const claudeConfigDir = path.join(dir, 'claude-config');
  fs.mkdirSync(work);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\n');
  const store = createStore({ dataDir: path.join(dir, 'data') });
  store.load();
  const events = createEvents({ save: store.save, toPublic: publicSession });
  const observed = { asked: [], statusModes: [] };
  const query = observedQuery({
    beforeSpawn: (args) => {
      const answer = args.options.canUseTool;
      args.options.canUseTool = (tool, input, options) => {
        observed.asked.push({ tool, input, suggestions: options.suggestions });
        return answer(tool, input, options);
      };
    },
    onMessage: (message) => {
      if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
        observed.statusModes.push(message.permissionMode);
      }
    },
  });
  const config = { claudeExecutable: CLAUDE, gatewayUrl: mock.url, settingSources: [], claudeConfigDir };
  const runner = createRunner({ config, events, gateway: { url: proxy.url, apiKey: proxy.secret }, query, log: () => {} });
  runners.push(runner);
  const session = store.insert(createSession({ cwd: work, model: 'luna', mode }));
  return { runner, session, work, claudeConfigDir, spawns: query.spawns, ...observed };
}

async function waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs one turn, answering each approval with `answer(pending)` (a POST
 * /api/approvals/:id body). Returns the pending entries that were shown.
 */
async function runTurn({ runner, session }, text, answer = () => ({ decision: 'deny', reason: 'Unexpected prompt' })) {
  const shown = [];
  runner.enqueue(session, { text });
  while (runner.isRunning(session.id)) {
    const pending = session.pending[0];
    if (pending && !shown.includes(pending)) {
      shown.push(pending);
      assert.equal(runner.resolveApproval(pending.id, answer(pending)), true);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return shown;
}

const lastAssistant = (session) => session.messages.findLast((m) => m.role === 'assistant')?.text;
const lastToolResult = () => mock.requests.findLast((request) => request.tools.length)?.lastToolResult;

describe('approvals end to end (real Claude Code CLI, mock gateway)', { skip }, () => {
  test('Bash in default mode asks; allow once runs it and asks again next time', async () => {
    const setup = harness('default');
    const [pending] = await runTurn(setup, '[[mock:bash:node -e 0]] run it', () => ({ decision: 'allow' }));
    assert.equal(pending.kind, 'permission');
    assert.equal(pending.tool, 'Bash');
    assert.equal(pending.input.command, 'node -e 0');
    assert.deepEqual(pending.suggestions, [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node -e 0' }], behavior: 'allow', destination: 'localSettings' },
    ]);
    assert.equal(setup.session.messages.find((m) => m.role === 'tool' && m.tool === 'Bash').state, 'done');
    assert.match(lastAssistant(setup.session), /^Tool result: ok/);
    assert.deepEqual(setup.session.allowRules ?? [], [], 'once records nothing');

    const again = await runTurn(setup, '[[mock:bash:node -e 0]] run it again', () => ({ decision: 'deny', reason: 'Not this time' }));
    assert.equal(again.length, 1, 'asked again');
    assert.match(lastAssistant(setup.session), /^Tool result: error — Not this time/);
  });

  test('allow always: the same command in a later turn runs without asking; no settings file is written', async () => {
    const setup = harness('default');
    await runTurn(setup, '[[mock:bash:node -e 0]] run it', () => ({ decision: 'allowAlways' }));
    assert.deepEqual(setup.session.allowRules, [{ toolName: 'Bash', ruleContent: 'node -e 0' }]);
    assert.equal(setup.asked.length, 1);

    const shown = await runTurn(setup, '[[mock:bash:node -e 0]] once more');
    assert.deepEqual(shown, []);
    assert.equal(setup.asked.length, 1, 'the CLI itself allowed it from its session rules');
    assert.equal(setup.spawns.length, 1, 'same process');
    assert.match(lastAssistant(setup.session), /^Tool result: ok/);

    // A new process (after an idle close) gets the grant as flag settings.
    await setup.runner.pool.close(setup.session.id);
    const restarted = await runTurn(setup, '[[mock:bash:node -e 0]] after a restart');
    assert.deepEqual(restarted, []);
    assert.equal(setup.spawns.length, 2);
    assert.deepEqual(setup.spawns[1].options.settings.permissions, { allow: ['Bash(node -e 0)'] });
    assert.equal(setup.asked.length, 1);
    assert.match(lastAssistant(setup.session), /^Tool result: ok/);
    assert.equal(setup.session.mode, 'default');
    assert.equal(fs.existsSync(path.join(setup.work, '.claude')), false, 'no project or local settings');
    assert.equal(fs.existsSync(path.join(setup.claudeConfigDir, 'settings.json')), false, 'no user settings');
  });

  test('allow always on a file-writing command takes the CLI\'s accept-edits suggestion', async () => {
    const setup = harness('default');
    const [pending] = await runTurn(setup, '[[mock:bash:touch made.txt]] make it', () => ({ decision: 'allowAlways' }));
    assert.ok(pending.suggestions.some((update) => update.type === 'setMode' && update.mode === 'acceptEdits'));
    assert.equal(pending.blockedPath, path.join(setup.work, 'made.txt'));
    assert.ok(fs.existsSync(path.join(setup.work, 'made.txt')));
    assert.equal(setup.session.mode, 'acceptEdits');
    assert.deepEqual(setup.session.allowRules, [{ toolName: 'Bash', ruleContent: 'touch made.txt' }]);
    assert.deepEqual(setup.session.allowDirectories, [setup.work]);
    assert.deepEqual(setup.statusModes, ['acceptEdits'], 'the CLI switched mode within the turn');
  });

  test('Edit asks with the change to show; allow once applies it', async () => {
    const setup = harness('default');
    const shown = await runTurn(setup, '[[mock:edit]] change the greeting', () => ({ decision: 'allow' }));
    const edit = shown.find((pending) => pending.tool === 'Edit');
    assert.equal(edit.kind, 'permission');
    assert.equal(edit.input.file_path, path.join(setup.work, 'hello.txt'));
    assert.deepEqual([edit.input.old_string, edit.input.new_string], ['hello', 'goodbye']);
    assert.equal(fs.readFileSync(path.join(setup.work, 'hello.txt'), 'utf8'), 'goodbye world\n');
    assert.equal(setup.session.mode, 'default');
  });

  test('plan approval with accept edits leaves plan mode for this turn and the next', async () => {
    const setup = harness('plan');
    const [pending] = await runTurn(setup, '[[mock:plan:file]] plan the change', () => ({ decision: 'allow', mode: 'acceptEdits' }));
    assert.equal(pending.kind, 'plan');
    assert.match(pending.input.plan, /^# Plan/);
    assert.equal(setup.session.plan.text, pending.input.plan);
    assert.match(lastToolResult().content, /User has approved your plan/);
    assert.deepEqual(setup.statusModes, ['acceptEdits'], 'the CLI took the chosen mode, not default');
    assert.equal(setup.session.mode, 'acceptEdits');

    await runTurn(setup, 'carry on');
    assert.equal(setup.spawns.length, 1);
    const modes = setup.spawns[0].controls.filter(([method]) => method === 'setPermissionMode').map(([, mode]) => mode);
    assert.deepEqual(modes, ['acceptEdits'], 'the next turn runs in accept-edits mode');
  });

  test('plan denial keeps planning and hands the feedback to the model', async () => {
    const setup = harness('plan');
    await runTurn(setup, '[[mock:plan:file]] plan the change', () => ({ decision: 'deny', reason: 'Add tests first' }));
    const result = lastToolResult();
    assert.equal(result.isError, true);
    assert.ok(result.content.includes(`${KEEP_PLANNING_MESSAGE} Their feedback: Add tests first`), result.content);
    assert.equal(setup.session.mode, 'plan');
  });

  test('AskUserQuestion answers reach the model', async () => {
    const setup = harness('default');
    const [pending] = await runTurn(setup, '[[mock:ask]] ask me', (entry) => ({
      decision: 'allow',
      answers: { [entry.input.questions[0].question]: 'Refactor' },
    }));
    assert.equal(pending.kind, 'question');
    assert.equal(pending.input.questions[0].question, 'Which approach should I take?');
    const result = lastToolResult();
    assert.equal(result.isError, false);
    assert.match(result.content, /"Which approach should I take\?"="Refactor"/);
    assert.match(lastAssistant(setup.session), /^Tool result: ok/);
  });
});
