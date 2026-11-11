import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cachedJson } from '../server/json-cache.mjs';

describe('cachedJson', () => {
  test('is JSON.stringify, and an unchanged object keeps its JSON (the same string)', () => {
    const message = { id: 'm1', role: 'tool', input: { command: 'ls', args: ['-l', 2] }, output: 'x'.repeat(100), missing: undefined };
    const first = cachedJson(message);
    assert.equal(first, JSON.stringify(message));
    assert.equal(cachedJson(message), first);
  });

  test('sees every kind of change made in place', () => {
    const message = { id: 'm1', state: 'running', task: { id: 't1', status: null }, steps: [{ n: 1 }] };
    const check = (label, change) => {
      const before = cachedJson(message);
      change();
      const after = cachedJson(message);
      assert.equal(after, JSON.stringify(message), label);
      assert.notEqual(after, before, label);
    };
    check('a top-level value', () => (message.state = 'done'));
    check('a nested value', () => (message.task.status = 'completed'));
    check('a key added', () => (message.endedAt = 5));
    check('a key removed', () => delete message.endedAt);
    check('an array element changed', () => (message.steps[0].n = 2));
    check('an array grown', () => message.steps.push({ n: 3 }));
    check('an object replaced by an array', () => (message.task = ['t1']));
    check('a value set to undefined', () => (message.state = undefined));
    // Key order is part of the JSON: a key deleted and set again moves to the end.
    const ordered = { a: 1, b: 2, c: 3 };
    const before = cachedJson(ordered);
    delete ordered.a;
    ordered.a = 1;
    assert.notEqual(cachedJson(ordered), before);
    assert.equal(cachedJson(ordered), JSON.stringify(ordered));
  });

  test('objects that are not plain data are stringified every time', () => {
    const message = { id: 'm1', at: new Date(0) };
    cachedJson(message);
    message.at.setTime(1000);
    assert.equal(cachedJson(message), JSON.stringify(message));
  });
});
