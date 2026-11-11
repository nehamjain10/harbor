import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSentDrafts, moveNewDraft } from '../src/lib/drafts.js';
import { KEYS } from '../src/lib/storage.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

const NEW = KEYS.draft(null);
const A = KEYS.draft('a');
const B = KEYS.draft('b');

test('a send from the new-session view moves the draft to the created session', () => {
  const storage = memoryStorage({ [NEW]: 'fix the bug\n' });
  moveNewDraft(storage, 'a', 'fix the bug');
  assert.deepEqual(storage.dump(), { [A]: 'fix the bug\n' });
  clearSentDrafts(storage, 'a', 'fix the bug', { created: true });
  assert.deepEqual(storage.dump(), {});
});

test('switching to another session while the session is created leaves its draft alone', () => {
  const storage = memoryStorage({ [NEW]: 'fix the bug', [B]: 'half-written reply for b' });
  // The user opened session B; the creation response arrives afterwards.
  moveNewDraft(storage, 'a', 'fix the bug');
  assert.equal(storage.getItem(B), 'half-written reply for b');
  clearSentDrafts(storage, 'a', 'fix the bug', { created: true });
  assert.deepEqual(storage.dump(), { [B]: 'half-written reply for b' });
});

test('leaving the new session before the message is accepted does not keep the sent text', () => {
  const storage = memoryStorage({ [NEW]: 'fix the bug' });
  moveNewDraft(storage, 'a', 'fix the bug');
  // The composer now shows session B; the message POST then succeeds.
  clearSentDrafts(storage, 'a', 'fix the bug', { created: true });
  assert.equal(storage.getItem(A), null, 'returning to the session must not offer the text again');
});

test('a failed send keeps the text in the created session for a retry', () => {
  const storage = memoryStorage({ [NEW]: 'fix the bug' });
  moveNewDraft(storage, 'a', 'fix the bug');
  // No clearSentDrafts: the message POST failed.
  assert.equal(storage.getItem(A), 'fix the bug');
  assert.equal(storage.getItem(NEW), null);
});

test('text typed after sending is kept', () => {
  const storage = memoryStorage({ [NEW]: 'something new' });
  moveNewDraft(storage, 'a', 'fix the bug');
  assert.equal(storage.getItem(NEW), 'something new');
  assert.equal(storage.getItem(A), 'fix the bug');
  storage.setItem(A, 'fix the bug, and also the tests');
  clearSentDrafts(storage, 'a', 'fix the bug', { created: true });
  assert.deepEqual(storage.dump(), { [NEW]: 'something new', [A]: 'fix the bug, and also the tests' });
});

test('a send to an existing session clears only that session draft', () => {
  const storage = memoryStorage({ [NEW]: 'yes', [A]: 'yes' });
  clearSentDrafts(storage, 'a', 'yes');
  assert.deepEqual(storage.dump(), { [NEW]: 'yes' });
});
