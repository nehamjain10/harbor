import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cleanTitle, createTitler, titlePrompt } from '../server/titles.mjs';

describe('chat titles', () => {
  test('cleanTitle keeps a short plain title', () => {
    assert.equal(cleanTitle('"Backend reward sweep."'), 'Backend reward sweep');
    assert.equal(cleanTitle('Title: Fix gateway origin check\n\nextra'), 'Fix gateway origin check');
    assert.equal(cleanTitle('**Harbor full-width layout**'), 'Harbor full-width layout');
    assert.equal(cleanTitle(''), null);
    assert.equal(cleanTitle('x'.repeat(200)), null);
    assert.equal(cleanTitle('word '.repeat(20)).length, 60);
  });

  test('titlePrompt clips long input', () => {
    const prompt = titlePrompt('a'.repeat(5000), 'b');
    assert.ok(prompt.length < 2200);
    assert.match(prompt, /Title:$/);
  });

  test('the titler returns the cleaned result, and null on failure', async () => {
    const make = (messages) =>
      createTitler({
        query: () => (async function* () { yield* messages; })(),
        claudeExecutable: '/nonexistent',
        env: () => ({}),
        log: () => {},
      });
    assert.equal(await make([{ type: 'result', subtype: 'success', result: 'Muscle eval sharding.' }])('hi', 'hello'), 'Muscle eval sharding');
    assert.equal(await make([{ type: 'result', subtype: 'error_during_execution', is_error: true }])('hi', 'hello'), null);
  });
});
