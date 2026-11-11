import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { normalizeToolInput } from '../server/normalize.mjs';

// The input schemas Claude Code 2.1.289 really sends (captured from the mock gateway).
const SCHEMAS = JSON.parse(fs.readFileSync(new URL('./fixtures/tool-schemas.json', import.meta.url)));

const QUESTIONS = [
  {
    question: 'Which approach?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'Small fix', description: 'Patch it' },
      { label: 'Refactor', description: 'Restructure first' },
    ],
  },
];
const TODOS = [
  { content: 'Write the fix', status: 'in_progress', activeForm: 'Writing the fix' },
  { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
];

// [name, tool, input, expected output (undefined = unchanged)]
const CASES = [
  ['Read pages:"" is dropped', 'Read', { file_path: '/a.txt', pages: '' }, { file_path: '/a.txt' }],
  ['Read limit:"" is dropped', 'Read', { file_path: '/a.txt', limit: '' }, { file_path: '/a.txt' }],
  ['Read offset:"10" becomes a number', 'Read', { file_path: '/a.txt', offset: '10' }, { file_path: '/a.txt', offset: 10 }],
  [
    'Read with every near-miss at once',
    'Read',
    { file_path: '/a.txt', pages: '', offset: ' 5 ', limit: null },
    { file_path: '/a.txt', offset: 5 },
  ],
  ['Read offset:"1.5" is not an integer, left alone', 'Read', { file_path: '/a.txt', offset: '1.5' }, undefined],
  ['Read offset:"ten" is not a number, left alone', 'Read', { file_path: '/a.txt', offset: 'ten' }, undefined],
  ['Read offset:"0x10" is not a clean number, left alone', 'Read', { file_path: '/a.txt', offset: '0x10' }, undefined],
  ['valid Read input is untouched', 'Read', { file_path: '/a.txt', offset: 3, limit: 20 }, undefined],
  [
    'Edit replace_all:"false" becomes a boolean',
    'Edit',
    { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: 'false' },
    { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: false },
  ],
  [
    'Edit replace_all:"True" becomes true',
    'Edit',
    { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: 'True' },
    { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: true },
  ],
  ['required empty strings are untouched', 'Edit', { file_path: '/a', old_string: 'x', new_string: '' }, undefined],
  ['required null is untouched', 'Edit', { file_path: '/a', old_string: null, new_string: 'y' }, undefined],
  [
    'Bash timeout:"60000" and description:"" are fixed',
    'Bash',
    { command: 'ls', timeout: '60000', description: '', run_in_background: 'false' },
    { command: 'ls', timeout: 60000, run_in_background: false },
  ],
  ['todos sent as a JSON string are parsed', 'TodoWrite', { todos: JSON.stringify(TODOS) }, { todos: TODOS }],
  ['todos that are not JSON stay a string', 'TodoWrite', { todos: '- write the fix' }, undefined],
  ['a JSON string of the wrong type is not used', 'TodoWrite', { todos: '{"content":"x"}' }, undefined],
  ['AskUserQuestion questions as a JSON string', 'AskUserQuestion', { questions: JSON.stringify(QUESTIONS) }, { questions: QUESTIONS }],
  [
    'nested AskUserQuestion fields are repaired inside the array',
    'AskUserQuestion',
    {
      questions: [
        {
          ...QUESTIONS[0],
          multiSelect: 'false',
          options: [
            { label: 'Small fix', description: 'Patch it', preview: '' },
            { label: 'Refactor', description: 'Restructure first' },
          ],
        },
      ],
    },
    { questions: QUESTIONS },
  ],
  [
    'nested repairs also apply after parsing a JSON string',
    'AskUserQuestion',
    { questions: JSON.stringify([{ ...QUESTIONS[0], multiSelect: 'false' }]) },
    { questions: QUESTIONS },
  ],
  ['open maps keep null on purpose (TaskUpdate metadata)', 'TaskUpdate', { taskId: '1', metadata: { stale: null } }, undefined],
  ['anyOf: a value one branch accepts is left alone', 'TaskUpdate', { taskId: '1', status: 'deleted' }, undefined],
  ['anyOf: an empty optional value is still dropped', 'TaskUpdate', { taskId: '1', status: '' }, { taskId: '1' }],
  ['numeric ids for string fields become strings', 'TaskUpdate', { taskId: 3, status: 'completed' }, { taskId: '3', status: 'completed' }],
  [
    'array of strings sent as a JSON string',
    'TaskUpdate',
    { taskId: '2', addBlockedBy: '["1"]' },
    { taskId: '2', addBlockedBy: ['1'] },
  ],
  ['an enum value outside the enum is not "fixed"', 'Agent', { description: 'd', prompt: 'p', model: 'gpt' }, undefined],
  ['an empty optional enum value is dropped', 'Agent', { description: 'd', prompt: 'p', model: '' }, { description: 'd', prompt: 'p' }],
  ['undeclared empty keys go where the schema forbids extras', 'Read', { file_path: '/a', bogus: '' }, { file_path: '/a' }],
  ['undeclared keys are kept where extras are allowed', 'ExitPlanMode', { plan: '# Plan', note: '' }, undefined],
];

describe('normalizeToolInput', () => {
  for (const [name, tool, input, expected] of CASES) {
    test(name, () => {
      const before = structuredClone(input);
      const result = normalizeToolInput(input, SCHEMAS[tool]);
      assert.deepEqual(input, before, 'the input object is never mutated');
      if (expected === undefined) {
        assert.equal(result.changed, false);
        assert.equal(result.input, input, 'unchanged input is returned as-is');
      } else {
        assert.equal(result.changed, true);
        assert.deepEqual(result.input, expected);
      }
    });
  }

  test('handles generic anyOf / oneOf / type arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        size: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['auto'] }] },
        flag: { type: ['boolean', 'null'] },
        mode: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        note: { type: ['string', 'null'] },
      },
    };
    assert.deepEqual(normalizeToolInput({ size: '12', flag: 'true', mode: '4' }, schema), {
      input: { size: 12, flag: true, mode: '4' },
      changed: true,
    });
    assert.deepEqual(normalizeToolInput({ size: 'auto', note: null }, schema).changed, false, 'null allowed by the type list stays');
  });

  test('a JSON-string root input is parsed', () => {
    const result = normalizeToolInput('{"file_path":"/a","pages":""}', SCHEMAS.Read);
    assert.deepEqual(result, { input: { file_path: '/a' }, changed: true });
  });

  test('missing or unusable schemas leave the input alone', () => {
    const input = { file_path: '/a', pages: '' };
    assert.deepEqual(normalizeToolInput(input, undefined), { input, changed: false });
    assert.deepEqual(normalizeToolInput(input, null), { input, changed: false });
    assert.deepEqual(normalizeToolInput(input, {}), { input, changed: false });
  });
});
