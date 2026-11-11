// A subagent's conversation from Claude Code's transcripts on disk (server/agent-transcript.mjs):
// the JSONL → message mapping, finding the transcript for a session, the caps, and the
// errors. Everything reads fixture copies in a temp folder, never ~/.claude.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { AGENT_TRANSCRIPT_LIMITS, createAgentTranscripts, projectSlug } from '../server/agent-transcript.mjs';
import { convertAgentTranscript, subagentFiles } from '../server/import-claude.mjs';
import { forEachLine } from '../server/jsonl.mjs';
import { AGENT_SESSION, NESTED_AGENT, OTHER_AGENT, ROOT_AGENT, copyAgentFixtures } from './fixtures/agent-transcript/setup.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-agent-transcript-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let count = 0;
/** A fresh Claude Code folder with the fixtures under `project` (default: the slug of the cwd). */
function fixtures({ project } = {}) {
  count += 1;
  const cwd = path.join(base, `home-${count}`, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const claudeHome = path.join(base, `claude-${count}`);
  const dir = copyAgentFixtures(claudeHome, { cwd, ...(project ? { project } : {}) });
  return { cwd, claudeHome, dir };
}

const card = (fields = {}) => ({ id: 'm-root', role: 'tool', tool: 'Agent', toolId: ROOT_AGENT, input: { description: 'Survey the repo' }, state: 'done', at: 1, ...fields });
const session = (cwd, fields = {}) => ({ id: 's1', cwd, sdkSessionId: AGENT_SESSION, messages: [card()], ...fields });
const shape = (messages) =>
  messages.map((m) => ({ role: m.role, ...(m.tool ? { tool: m.tool, state: m.state } : { text: m.text }), parent: m.parentToolId }));

describe('Claude Code subagent transcripts', () => {
  test('a subagent converts to messages rooted at its Agent call, with the agent it started nested under its card', async () => {
    const { dir } = fixtures();
    const files = new Map([...(await subagentFiles(path.dirname(path.dirname(dir)), [AGENT_SESSION]))]);
    const converted = await convertAgentTranscript(files, ROOT_AGENT, AGENT_TRANSCRIPT_LIMITS);
    assert.deepEqual(shape(converted.messages), [
      { role: 'thinking', text: 'Start with the top level, then the packages.', parent: ROOT_AGENT },
      { role: 'assistant', text: "I'll list the top level first.", parent: ROOT_AGENT },
      { role: 'tool', tool: 'Bash', state: 'done', parent: ROOT_AGENT },
      { role: 'tool', tool: 'Agent', state: 'done', parent: ROOT_AGENT },
      { role: 'tool', tool: 'Read', state: 'done', parent: NESTED_AGENT },
      { role: 'assistant', text: 'The README describes two packages: core and cli.', parent: NESTED_AGENT },
      // A message sent to it while it worked; its prompt (the first line) is on its card.
      { role: 'user', text: 'The coordinator sent a message while you were working:\nAlso note the license.', parent: ROOT_AGENT },
      { role: 'tool', tool: 'Read', state: 'done', parent: ROOT_AGENT },
      { role: 'assistant', text: 'The repository has two packages, core and cli, under the MIT license.', parent: ROOT_AGENT },
    ]);
    assert.equal(converted.omitted, 0);
    assert.equal(converted.partial, false);
    const [thinking, reply, bash, nested] = converted.messages;
    assert.equal(thinking.at, Date.parse('2026-10-06T09:00:02.000Z'));
    assert.equal(reply.model, 'opus');
    assert.equal(bash.output, 'README.md\nLICENSE\npackages');
    assert.equal(bash.endedAt, Date.parse('2026-10-06T09:00:03.000Z'));
    // The nested agent's card: its input, the report without Claude Code's hand-back line, its usage.
    assert.deepEqual(nested.input, { description: 'Read the README', prompt: 'Read README.md and summarize it.', subagent_type: 'Explore' });
    assert.equal(nested.output, 'The README describes two packages: core and cli.');
    assert.deepEqual(nested.usage, { tokens: 2400, toolUses: 1, durationMs: 5000 });
    assert.ok(converted.messages.every((m) => m.imported === true && typeof m.id === 'string' && m.sdkId === undefined));
    assert.equal(await convertAgentTranscript(files, 'toolu_missing', AGENT_TRANSCRIPT_LIMITS), null);
  });

  test('the transcript is found for the session: by its folder, in another project folder, or for an import', async () => {
    const { cwd, claudeHome } = fixtures();
    const transcripts = createAgentTranscripts({ config: { claudeConfigDir: claudeHome } });
    const result = await transcripts.read(session(cwd), ROOT_AGENT);
    assert.equal(result.toolId, ROOT_AGENT);
    assert.equal(result.agentId, 'a7c41e9d02b6f3851');
    assert.equal(result.agentType, 'general-purpose');
    assert.equal(result.description, 'Survey the repo');
    assert.equal(result.messages.length, 9);
    assert.equal(result.truncated, false);
    // An agent only the transcripts know (started by a subagent), and one picked by its meta, not its name.
    assert.deepEqual(shape((await transcripts.read(session(cwd), NESTED_AGENT)).messages).map((m) => m.tool || m.text), ['Read', 'The README describes two packages: core and cli.']);
    assert.equal((await transcripts.read(session(cwd), OTHER_AGENT)).messages.at(-1).text, 'Not this one.');

    // Claude Code shortens long folder names; any project folder holding the session is searched.
    const elsewhere = fixtures({ project: '-somewhere-else' });
    const moved = createAgentTranscripts({ config: { claudeConfigDir: elsewhere.claudeHome } });
    assert.equal((await moved.read(session(elsewhere.cwd), ROOT_AGENT)).messages.length, 9);

    // An imported Claude Code session: its agents ran in the original session.
    const imported = session(cwd, { sdkSessionId: '77777777-7777-4777-8777-777777777777', source: { kind: 'claude', id: AGENT_SESSION } });
    assert.equal((await transcripts.read(imported, ROOT_AGENT)).messages.length, 9);
    const forked = session(cwd, { sdkSessionId: undefined, forkFrom: AGENT_SESSION });
    assert.equal((await transcripts.read(forked, ROOT_AGENT)).messages.length, 9);
  });

  test('ids are checked before any path is built, and missing transcripts are 404s', async () => {
    const { cwd, claudeHome } = fixtures();
    const transcripts = createAgentTranscripts({ config: { claudeConfigDir: claudeHome } });
    const failure = (promise) => promise.then(() => assert.fail('expected an error'), (error) => ({ status: error.status, message: error.message }));
    for (const bad of ['../etc', 'a/b', '', 'x'.repeat(201), 'toolu_01 RootAgent']) {
      assert.deepEqual(await failure(transcripts.read(session(cwd), bad)), { status: 400, message: 'Invalid agent id.' });
    }
    assert.equal((await failure(transcripts.read(session(cwd), 'toolu_unknown'))).status, 404);
    // A session id that is not one is never joined into a path.
    assert.equal((await failure(transcripts.read(session(cwd, { sdkSessionId: '../../etc' }), ROOT_AGENT))).status, 404);
    assert.equal((await failure(transcripts.read(session(cwd, { sdkSessionId: undefined }), ROOT_AGENT))).status, 404);
    // A model agent's card, and a tool that is not an agent.
    const delegate = session(cwd, { messages: [card({ tool: 'mcp__meshy__delegate', agentId: 'luna-a1b2c3' })] });
    assert.match((await failure(transcripts.read(delegate, ROOT_AGENT))).message, /model agent/);
    const bash = session(cwd, { messages: [card({ tool: 'Bash' })] });
    assert.deepEqual(await failure(transcripts.read(bash, ROOT_AGENT)), { status: 404, message: 'Agent not found' });
    // A Claude Code folder without projects.
    const empty = createAgentTranscripts({ config: { claudeConfigDir: path.join(base, 'no-claude') } });
    assert.equal((await failure(empty.read(session(cwd), ROOT_AGENT))).status, 404);
  });

  test('a running agent keeps its open tool call; a finished one ends it as interrupted', async () => {
    const { cwd, claudeHome, dir } = fixtures();
    const file = path.join(dir, 'agent-a7c41e9d02b6f3851.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    // Cut after the Read call, before its result.
    fs.writeFileSync(file, lines.slice(0, 10).join('\n') + '\n');
    const transcripts = createAgentTranscripts({ config: { claudeConfigDir: claudeHome } });
    const running = await transcripts.read(session(cwd, { messages: [card({ state: 'running' })] }), ROOT_AGENT);
    assert.equal(running.messages.at(-1).tool, 'Read');
    assert.equal(running.messages.at(-1).state, 'running');
    const finished = await transcripts.read(session(cwd), ROOT_AGENT);
    assert.equal(finished.messages.at(-1).state, 'error');
    assert.equal(finished.messages.at(-1).output, 'Interrupted before this tool call finished.');
  });

  test('a background agent the subagent started ends with its task notification', async () => {
    const { dir } = fixtures();
    const file = path.join(dir, 'agent-a0c0ffee0c0ffee01.jsonl');
    const line = (fields) => JSON.stringify({ isSidechain: true, agentId: 'a0c0ffee0c0ffee01', sessionId: AGENT_SESSION, timestamp: '2026-10-06T09:01:00.000Z', ...fields });
    const notification =
      '<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Agent "Count files" finished</summary>\n<result>There are 42 files.</result>\n</task-notification>';
    fs.writeFileSync(
      file,
      [
        line({ parentUuid: null, uuid: 'u1', type: 'user', message: { role: 'user', content: 'Count the files.' } }),
        line({ parentUuid: 'u1', uuid: 'u2', type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Count files', prompt: 'Count them.', run_in_background: true } }] } }),
        line({ parentUuid: 'u2', uuid: 'u3', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] }, toolUseResult: { status: 'async_launched', agentId: 'a9' } }),
        line({ parentUuid: 'u3', uuid: 'u4', type: 'attachment', attachment: { type: 'queued_command', prompt: notification, commandMode: 'task-notification' } }),
      ].join('\n') + '\n',
    );
    const files = await subagentFiles(path.dirname(path.dirname(dir)), [AGENT_SESSION]);
    const [agent] = (await convertAgentTranscript(files, OTHER_AGENT, AGENT_TRANSCRIPT_LIMITS)).messages;
    assert.equal(agent.state, 'done');
    assert.equal(agent.background, true);
    assert.equal(agent.output, 'There are 42 files.');
  });

  test('huge transcripts are capped and say so', async () => {
    const { cwd, claudeHome } = fixtures();
    // The latest messages only: the agent's own earlier ones are counted.
    const few = createAgentTranscripts({ config: { claudeConfigDir: claudeHome }, limits: { messages: 3 } });
    const latest = await few.read(session(cwd), ROOT_AGENT);
    assert.deepEqual(shape(latest.messages).map((m) => m.tool || m.text), ['The coordinator sent a message while you were working:\nAlso note the license.', 'Read', 'The repository has two packages, core and cli, under the MIT license.']);
    assert.equal(latest.omitted, 4);
    assert.equal(latest.truncated, true);
    // Only the end of a file larger than the read limit.
    const tail = createAgentTranscripts({ config: { claudeConfigDir: claudeHome }, limits: { fileBytes: 1500 } });
    const partial = await tail.read(session(cwd), ROOT_AGENT);
    assert.equal(partial.partial, true);
    assert.equal(partial.truncated, true);
    assert.equal(partial.messages.at(-1).text, 'The repository has two packages, core and cli, under the MIT license.');
    assert.ok(partial.messages.length < 9);
  });

  test("Claude Code's project folder name for a working directory", () => {
    assert.equal(projectSlug('/home/you/.local/share/claude-workbench'), '-home-you--local-share-claude-workbench');
    assert.equal(projectSlug('/tmp/x_y z'), '-tmp-x-y-z');
  });
});

describe('forEachLine from an offset', () => {
  test('starts at the first whole line at or after the offset', async () => {
    const file = path.join(base, 'lines.jsonl');
    fs.writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
    const from = async (start, chunkBytes) => {
      const seen = [];
      await forEachLine(file, (text, offset) => seen.push([text, offset]), { start, chunkBytes });
      return seen;
    };
    assert.deepEqual(await from(0), [['aaaa', 0], ['bbbb', 5], ['cccc', 10]]);
    // Right at a line start, inside a line, and at the newline ending one.
    assert.deepEqual(await from(5, 3), [['bbbb', 5], ['cccc', 10]]);
    assert.deepEqual(await from(6, 3), [['cccc', 10]]);
    assert.deepEqual(await from(9, 4), [['cccc', 10]]);
    assert.deepEqual(await from(15), []);
  });
});
