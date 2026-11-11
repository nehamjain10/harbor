// A session for the steering browser tests (and the screenshots): the lead started three
// model agents (a Luna worker that runs, a DeepSeek worker that finished, a Kimi worker the
// lead stopped) and a Claude Code subagent that runs, messaged the Luna one, checked on
// them and stopped one. Messages to the Luna worker are nested under its card.
export const DELEGATE = 'mcp__meshy__delegate';
export const LUNA_ID = 'luna-a1b2c3';

export function steerMessages(at, { lunaRunning = true } = {}) {
  const worker = (id, model, description, fields) => ({
    id: 'm-' + id,
    role: 'tool',
    tool: DELEGATE,
    toolId: id,
    input: { model, task: `Write the tests for ${description.toLowerCase()}. Only touch tests/.`, description },
    at,
    background: true,
    agentModel: model,
    agentId: `${model}-a1b2c3`,
    taskId: `${model}-a1b2c3`,
    ...fields,
  });
  const nested = (id, parent, name, input, fields = {}) => ({ id: 'm-' + id, role: 'tool', tool: name, toolId: id, parentToolId: parent, input, state: 'done', at: at + 4000, endedAt: at + 5000, output: 'ok', ...fields });
  const luna = worker('d1', 'luna', 'Parser tests', {
    state: lunaRunning ? 'running' : 'done',
    output: lunaRunning ? 'Started worker luna-a1b2c3 (GPT-6 Luna agent, “Parser tests”).' : 'Added 14 tests.\n\nFiles changed: `tests/parser.test.mjs`',
    worktree: { branch: 'harbor/luna-a1b2c3', path: '/tmp/wt/luna-a1b2c3' },
    ...(lunaRunning ? { progress: { description: 'Working', toolUses: 3, tokens: 8200, lastTool: 'Read' } } : { endedAt: at + 90_000, usage: { toolUses: 3, tokens: 12_400, durationMs: 90_000 } }),
  });
  return [
    { id: 'u1', role: 'user', text: 'Split the test work: Luna takes the parser, DeepSeek the lexer, Kimi the formatter.', at: at - 20_000, delivery: 'done' },
    luna,
    // What the Luna worker did, and what it was told along the way.
    nested('c1', 'd1', 'Bash', { command: 'npm test -- parser', description: 'Run the parser tests' }, { output: '# pass 12' }),
    { id: 'w1', role: 'assistant', text: 'The parser has 12 cases so far; I will add the error paths next.', parentToolId: 'd1', model: 'luna', at: at + 6000 },
    { id: 'l1', role: 'user', text: 'Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.', parentToolId: 'd1', from: 'lead', delivery: 'done', at: at + 7000 },
    nested('c2', 'd1', 'Read', { file_path: '/home/you/claude-workbench/server/lexer.mjs' }, { at: at + 8000, endedAt: at + 8400 }),
    { id: 'l2', role: 'user', text: 'Skip the fixtures directory, it is generated.', parentToolId: 'd1', from: 'user', delivery: lunaRunning ? 'sent' : 'dropped', clientId: 'cid-1', at: at + 9000 },
    worker('d2', 'deepseek', 'Lexer tests', { state: 'done', endedAt: at + 60_000, output: 'Added 9 tests.\n\nFiles changed: `tests/lexer.test.mjs`', usage: { toolUses: 4, tokens: 9000, durationMs: 60_000 }, worktree: { branch: 'harbor/deepseek-a1b2c3', path: '/tmp/wt/deepseek-a1b2c3', commits: 1 } }),
    worker('d3', 'kimi', 'Formatter tests', {
      state: 'error',
      stopped: true,
      stoppedBy: 'lead',
      stopReason: 'The formatter is being rewritten; these tests would be thrown away.',
      endedAt: at + 30_000,
      output: 'Stopped by the lead before it finished.\n\nIt had read `server/format.mjs` and drafted two tests.',
    }),
    { id: 'a-native', role: 'tool', tool: 'Agent', toolId: 'a1', at, input: { description: 'Survey the repo', subagent_type: 'Explore', prompt: 'Look around and report.', run_in_background: true }, state: 'running', background: true, taskId: 't1', output: 'Async agent launched successfully.', progress: { description: 'Searching', toolUses: 2, tokens: 3000 } },
    { id: 'n1', role: 'tool', tool: 'Read', toolId: 'n1', parentToolId: 'a1', input: { file_path: '/repo/package.json' }, state: 'done', at: at + 2000, output: '{}' },
    // A follow-up the lead sent the Claude Code agent (SendMessage); no `from`, as imported ones.
    { id: 'n2', role: 'user', text: 'Also list the test folders.', parentToolId: 'a1', delivery: 'done', at: at + 3000 },
    // The lead's tools for its workers.
    { id: 'm-msg', role: 'tool', tool: 'mcp__meshy__message_agent', toolId: 'lm1', at: at + 7000, endedAt: at + 7100, state: 'done', input: { id: LUNA_ID, message: 'Also cover the lexer edge cases: unterminated strings, a lone `\\r`, and unicode escapes.' }, output: 'Sent to GPT-6 Luna agent luna-a1b2c3; it reads it at its next step.' },
    { id: 'm-chk', role: 'tool', tool: 'mcp__meshy__check_agents', toolId: 'lc1', at: at + 20_000, endedAt: at + 20_100, state: 'done', input: {}, output: 'luna-a1b2c3 (GPT-6 Luna agent, “Parser tests”): running, 3 tool uses, 8.2k tokens\ndeepseek-a1b2c3 (DeepSeek V4.1 Flash agent, “Lexer tests”): finished\nkimi-a1b2c3 (Kimi K3 agent, “Formatter tests”): running, 1 tool use' },
    { id: 'm-stop', role: 'tool', tool: 'mcp__meshy__stop_agent', toolId: 'ls1', at: at + 30_000, endedAt: at + 30_400, state: 'done', input: { id: 'kimi-a1b2c3', reason: 'The formatter is being rewritten; these tests would be thrown away.' }, output: 'Stopped by the lead before it finished.\n\nIt had read `server/format.mjs` and drafted two tests.' },
    { id: 'r1', role: 'assistant', text: 'The Luna worker is on the parser tests; DeepSeek is done and I stopped Kimi.', model: 'opus', at: at + 31_000 },
    { id: 'turn1', role: 'turn', duration: 31_000, outputTokens: 400, cost: 0, model: 'opus' },
  ];
}

// Applies message changes to the session fixture and pushes them as the server's delta
// (a new revision on top of the session's): replaced by id, else added at the end.
export async function pushDelta(page, session, changes, fields = {}) {
  const base = session.rev;
  session.rev = base + 1;
  for (const change of changes) {
    const at = session.messages.findIndex((m) => m.id === change.id);
    if (at >= 0) session.messages[at] = change;
    else session.messages.push(change);
  }
  Object.assign(session, fields);
  await page.evaluate((delta) => window.__emit('delta', delta), { id: session.id, rev: session.rev, base, count: session.messages.length, fields: { updatedAt: Date.now() + 1000, ...fields }, messages: changes });
}

// Opens the fixture session (the idle `s-old` of the harness) with `messages`.
export async function openSteerSession(page, server, messages, fields = {}) {
  const session = server.sessions.find((s) => s.id === 's-old');
  Object.assign(session, { messages, status: 'idle', backgroundAgents: 1, rev: 10, model: 'opus', ...fields });
  await page.locator('.session-main', { hasText: session.title }).click();
  await page.waitForFunction(() => location.search === '?session=s-old');
  await page.locator('.transcript-column', { hasText: 'Split the test work' }).first().waitFor();
  return session;
}
