// The approval decision mapping as plain data, without the SDK.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_DENY_MESSAGE,
  KEEP_PLANNING_MESSAGE,
  allowedBySession,
  applyApprovalToSession,
  approvalKind,
  bypassAnswer,
  decideApproval,
  mergeAllowRules,
  parseApprovalChoice,
  pendingEntry,
  ruleString,
  sessionPermissionSettings,
} from '../server/approvals.mjs';

const bashSuggestions = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
];

const entry = (tool, input, options = {}) => pendingEntry({ id: 'p1', tool, input, options: { toolUseID: 'tu', ...options }, at: 5 });

/** parse + decide, as the route and runner do. */
function decide(pending, body, context = { sessionMode: 'default' }) {
  const { choice, error } = parseApprovalChoice(body);
  assert.equal(error, undefined);
  return decideApproval(pending, choice, context);
}

describe('pending entries', () => {
  test('kind follows the tool', () => {
    assert.equal(approvalKind('AskUserQuestion'), 'question');
    assert.equal(approvalKind('ExitPlanMode'), 'plan');
    assert.equal(approvalKind('Bash'), 'permission');
    assert.equal(approvalKind('mcp__srv__tool'), 'permission');
  });

  test('keeps suggestions, blocked path, title and description; drops the rest', () => {
    const pending = entry('Bash', { command: 'cat /etc/x' }, {
      suggestions: bashSuggestions,
      blockedPath: '/etc/x',
      title: 'Claude wants to read /etc/x',
      description: 'Outside the project',
      displayName: 'Read file',
      requestId: 'r1',
      signal: new AbortController().signal,
    });
    assert.deepEqual(pending, {
      id: 'p1',
      kind: 'permission',
      tool: 'Bash',
      input: { command: 'cat /etc/x' },
      at: 5,
      toolUseID: 'tu',
      suggestions: bashSuggestions,
      blockedPath: '/etc/x',
      title: 'Claude wants to read /etc/x',
      description: 'Outside the project',
      displayName: 'Read file',
    });
    const risky = entry('Bash', { command: 'x' }, { decisionReason: 'writes a sensitive file', defaultToNo: true });
    assert.equal(risky.decisionReason, 'writes a sensitive file');
    assert.equal(risky.defaultToNo, true);
  });

  test('no suggestions when they are empty or the CLI suppresses "always"', () => {
    assert.equal('suggestions' in entry('Bash', {}, { suggestions: [] }), false);
    assert.equal('suggestions' in entry('Bash', {}, { suggestions: bashSuggestions, suppressAlwaysAllowRule: true }), false);
  });
});

describe('parseApprovalChoice', () => {
  test('v2 bodies', () => {
    assert.deepEqual(parseApprovalChoice({ decision: 'allowAlways' }), { choice: { decision: 'allowAlways' } });
    assert.deepEqual(parseApprovalChoice({ decision: 'deny', reason: '  not now ' }), { choice: { decision: 'deny', reason: 'not now' } });
    assert.deepEqual(parseApprovalChoice({ decision: 'deny', reason: '   ' }), { choice: { decision: 'deny' } });
    assert.deepEqual(parseApprovalChoice({ decision: 'allow', mode: 'ask' }), { choice: { decision: 'allow', mode: 'default' } });
    assert.deepEqual(parseApprovalChoice({ decision: 'allow', answers: { 'Which?': ['A', 'B'], 'Why?': 'Because' } }), {
      choice: { decision: 'allow', answers: { 'Which?': 'A, B', 'Why?': 'Because' } },
    });
  });

  test('legacy {allow} bodies', () => {
    assert.deepEqual(parseApprovalChoice({ allow: true }), { choice: { decision: 'allow' } });
    assert.deepEqual(parseApprovalChoice({ allow: false, reason: 'No' }), { choice: { decision: 'deny', reason: 'No' } });
    // decision wins when both are sent
    assert.deepEqual(parseApprovalChoice({ allow: false, decision: 'allow' }), { choice: { decision: 'allow' } });
  });

  test('invalid bodies', () => {
    for (const [body, error] of [
      [{}, 'Choose Allow or Deny.'],
      [{ allow: 'yes' }, 'Choose Allow or Deny.'],
      [{ decision: 'always' }, 'Choose Allow or Deny.'],
      [{ decision: 'deny', reason: 3 }, 'The reason must be text.'],
      [{ decision: 'allow', answers: ['A'] }, 'Answers must map each question to its answer.'],
      [{ decision: 'allow', answers: { q: 1 } }, 'Each answer must be text.'],
      [{ decision: 'allow', mode: 'plan' }, 'Unknown mode'],
      [{ decision: 'allow', mode: 'dontAsk' }, 'Unknown mode'],
    ]) {
      assert.deepEqual(parseApprovalChoice(body), { error }, JSON.stringify(body));
    }
  });
});

describe('decideApproval', () => {
  test('allow once passes the input through, without permission updates', () => {
    const pending = entry('Bash', { command: 'npm test' }, { suggestions: bashSuggestions });
    assert.deepEqual(decide(pending, { decision: 'allow' }), { result: { behavior: 'allow', updatedInput: { command: 'npm test' } } });
    assert.deepEqual(decide(pending, { allow: true }), { result: { behavior: 'allow', updatedInput: { command: 'npm test' } } });
  });

  test('allow always: every destination becomes session, allow rules are returned deduped', () => {
    const suggestions = [
      ...bashSuggestions,
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Bash', ruleContent: 'npm run lint' }],
        behavior: 'allow',
        destination: 'projectSettings',
      },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'deny', destination: 'userSettings' },
      { type: 'addDirectories', directories: ['/srv/shared'], destination: 'localSettings' },
    ];
    const pending = entry('Bash', { command: 'npm test' }, { suggestions });
    const decided = decide(pending, { decision: 'allowAlways' });
    assert.deepEqual(decided.result.updatedPermissions, suggestions.map((update) => ({ ...update, destination: 'session' })));
    assert.ok(decided.result.updatedPermissions.every((update) => update.destination === 'session'));
    assert.deepEqual(suggestions[0].destination, 'localSettings', 'the stored suggestions are not mutated');
    assert.deepEqual(decided.allowRules, [
      { toolName: 'Bash', ruleContent: 'npm test:*' },
      { toolName: 'Bash', ruleContent: 'npm run lint' },
    ]);
    assert.deepEqual(decided.allowDirectories, ['/srv/shared']);
    assert.equal(decided.mode, undefined);
  });

  test('allow always with a setMode suggestion changes the session mode', () => {
    const suggestions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    const decided = decide(entry('Edit', { file_path: '/p/a.txt' }, { suggestions }), { decision: 'allowAlways' });
    assert.deepEqual(decided.result.updatedPermissions, suggestions);
    assert.equal(decided.mode, 'acceptEdits');
    assert.deepEqual(decided.allowRules, []);
  });

  test('allow always without suggestions is allow once', () => {
    assert.deepEqual(decide(entry('Bash', { command: 'x' }), { decision: 'allowAlways' }), {
      result: { behavior: 'allow', updatedInput: { command: 'x' } },
    });
  });

  test('deny carries the reason or the default message', () => {
    const pending = entry('Bash', { command: 'rm -rf x' });
    assert.deepEqual(decide(pending, { decision: 'deny', reason: 'Not that' }).result, { behavior: 'deny', message: 'Not that' });
    assert.deepEqual(decide(pending, { decision: 'deny' }).result, { behavior: 'deny', message: DEFAULT_DENY_MESSAGE });
    assert.deepEqual(decide(pending, { allow: false }).result, { behavior: 'deny', message: DEFAULT_DENY_MESSAGE });
  });

  test('question answers are merged into the input', () => {
    const input = { questions: [{ question: 'Which approach?', header: 'Approach', options: [], multiSelect: false }] };
    const pending = entry('AskUserQuestion', input);
    assert.equal(pending.kind, 'question');
    assert.deepEqual(decide(pending, { decision: 'allow', answers: { 'Which approach?': 'Refactor' } }), {
      result: { behavior: 'allow', updatedInput: { ...input, answers: { 'Which approach?': 'Refactor' } } },
    });
    // Legacy body, and "always" means nothing more for a question.
    assert.deepEqual(decide(pending, { allow: true, answers: { 'Which approach?': 'Small fix' } }).result.updatedInput.answers, {
      'Which approach?': 'Small fix',
    });
    assert.equal(decide(pending, { decision: 'allowAlways', answers: {} }).result.updatedPermissions, undefined);
  });

  test('plan approval switches mode for the turn and the session', () => {
    const pending = entry('ExitPlanMode', { plan: '# Plan' }, { suggestions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
    assert.equal(pending.kind, 'plan');
    for (const mode of ['acceptEdits', 'default', 'bypassPermissions']) {
      assert.deepEqual(decide(pending, { decision: 'allow', mode }, { sessionMode: 'plan' }), {
        result: {
          behavior: 'allow',
          updatedInput: { plan: '# Plan' },
          updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
        },
        mode,
      });
    }
    // The SDK gets the mode the turn's model runs; the session keeps the user's choice.
    const auto = decide(pending, { decision: 'allow', mode: 'auto' }, { sessionMode: 'plan', sdkMode: () => 'default' });
    assert.equal(auto.result.updatedPermissions[0].mode, 'default');
    assert.equal(auto.mode, 'auto');
  });

  test('plan approval without a mode leaves plan mode (or keeps a non-plan mode)', () => {
    const pending = entry('ExitPlanMode', { plan: '# Plan' });
    assert.equal(decide(pending, { allow: true }, { sessionMode: 'plan' }).mode, 'default');
    assert.equal(decide(pending, { decision: 'allowAlways' }, { sessionMode: 'bypassPermissions' }).mode, 'bypassPermissions');
  });

  test('plan denial keeps planning with the feedback', () => {
    const pending = entry('ExitPlanMode', { plan: '# Plan' });
    assert.deepEqual(decide(pending, { decision: 'deny', reason: 'Add tests first' }, { sessionMode: 'plan' }), {
      result: { behavior: 'deny', message: `${KEEP_PLANNING_MESSAGE} Their feedback: Add tests first` },
    });
    assert.deepEqual(decide(pending, { decision: 'deny' }).result, { behavior: 'deny', message: KEEP_PLANNING_MESSAGE });
  });
});

describe('session grants', () => {
  test('rule strings follow Claude Code syntax', () => {
    assert.equal(ruleString({ toolName: 'Bash', ruleContent: 'npm test:*' }), 'Bash(npm test:*)');
    assert.equal(ruleString({ toolName: 'WebFetch' }), 'WebFetch');
    assert.equal(ruleString({ toolName: 'Bash', ruleContent: 'echo (a) \\ b' }), 'Bash(echo \\(a\\) \\\\ b)');
  });

  test('applying a decision merges rules and directories without duplicates', () => {
    const session = { mode: 'default', allowRules: [{ toolName: 'Bash', ruleContent: 'ls' }] };
    applyApprovalToSession(session, {
      allowRules: [{ toolName: 'Bash', ruleContent: 'ls' }, { toolName: 'WebFetch' }],
      allowDirectories: ['/a'],
      mode: 'acceptEdits',
    });
    applyApprovalToSession(session, { allowRules: [{ toolName: 'WebFetch' }], allowDirectories: ['/a', '/b'] });
    assert.deepEqual(session, {
      mode: 'acceptEdits',
      allowRules: [{ toolName: 'Bash', ruleContent: 'ls' }, { toolName: 'WebFetch' }],
      allowDirectories: ['/a', '/b'],
    });
    assert.deepEqual(mergeAllowRules([], []), []);
  });

  test('flag settings re-apply the grants', () => {
    assert.equal(sessionPermissionSettings({}), undefined);
    assert.equal(sessionPermissionSettings({ allowRules: [], allowDirectories: [] }), undefined);
    assert.deepEqual(
      sessionPermissionSettings({ allowRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'WebFetch' }], allowDirectories: ['/d'] }),
      { allow: ['Bash(npm test:*)', 'WebFetch'], additionalDirectories: ['/d'] },
    );
  });

  test('the backstop allows only exact matches', () => {
    const session = {
      allowRules: [
        { toolName: 'Bash', ruleContent: 'npm test:*' },
        { toolName: 'Bash', ruleContent: 'make build' },
        { toolName: 'WebFetch' },
      ],
    };
    assert.equal(allowedBySession(session, 'WebFetch', { url: 'https://x' }), true, 'whole-tool rule');
    assert.equal(allowedBySession(session, 'Bash', { command: 'make build' }), true, 'identical command');
    // Suggested rules are not trusted: the CLI asks despite them for reasons of its own.
    assert.equal(allowedBySession(session, 'Bash', { command: 'npm test --watch' }, { suggestions: bashSuggestions }), false);
    // A prefix rule is not matched by the backstop itself (compound commands); the CLI decides.
    assert.equal(allowedBySession(session, 'Bash', { command: 'npm test && rm -rf /' }), false);
    assert.equal(allowedBySession(session, 'Bash', { command: 'make build && rm -rf /' }), false);
    const other = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'allow', destination: 'session' }];
    assert.equal(allowedBySession(session, 'Bash', { command: 'rm x' }, { suggestions: other }), false);
    assert.equal(allowedBySession(session, 'Edit', { file_path: '/x' }, { suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }), false);
    assert.equal(allowedBySession({}, 'WebFetch', {}), false);
    // The CLI's own reasons to ask always win, even for an identical command.
    const project = { ...session, cwd: '/w', allowDirectories: ['/srv/shared'] };
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { decisionReason: 'sensitive file' }), false);
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { matchedAskRule: { source: 'userSettings', toolName: 'Bash' } }), false);
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { defaultToNo: true }), false);
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { blockedPath: '/etc/hostname' }), false, 'outside the project');
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { blockedPath: '/w-other/x' }), false, 'a sibling is not inside');
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { blockedPath: '/w/out.txt' }), true, 'inside the project');
    assert.equal(allowedBySession(project, 'Bash', { command: 'make build' }, { blockedPath: '/srv/shared/a' }), true, 'inside a granted directory');
    // Questions and plans always reach the user.
    const everything = { allowRules: [{ toolName: 'AskUserQuestion' }, { toolName: 'ExitPlanMode' }] };
    assert.equal(allowedBySession(everything, 'AskUserQuestion', {}), false);
    assert.equal(allowedBySession(everything, 'ExitPlanMode', {}), false);
  });
});

describe('bypassAnswer', () => {
  const rm = { decisionReason: 'Dangerous rm operation on possibly-empty variable path: $S/$s in `rm -rf $S/$s` (rewrite it as "${S:?}"/"${s:?}" or use a literal path)' };

  test('bypass mode answers the permission prompts Claude Code still raises', () => {
    assert.deepEqual(bypassAnswer('bypassPermissions', 'Bash', { command: 'x' }, { decisionReason: 'Compound command contains cd with output redirection' }), {
      behavior: 'allow',
      updatedInput: { command: 'x' },
    });
  });

  test('an rm on possibly-empty variables is sent back with the safe rewrite, not run', () => {
    const answer = bypassAnswer('bypassPermissions', 'Bash', { command: 'rm -rf $S/$s' }, rm);
    assert.equal(answer.behavior, 'deny');
    assert.match(answer.message, /\$\{S:\?\}/);
  });

  test('questions, plans and every other mode still go to the user', () => {
    assert.equal(bypassAnswer('bypassPermissions', 'AskUserQuestion', {}, {}), null);
    assert.equal(bypassAnswer('bypassPermissions', 'ExitPlanMode', {}, {}), null);
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) assert.equal(bypassAnswer(mode, 'Bash', {}, rm), null);
  });
});
