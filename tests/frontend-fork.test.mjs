// Fork (a new session with a copy of the conversation): which messages "Fork from here"
// is offered on, the notice that links back to the original, and the draft a fork from a
// message leaves for the new session's composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canForkFrom, splitForkNotice } from '../src/lib/fork.js';
import { attachmentsKey, readAttachments, storeForkDraft } from '../src/lib/drafts.js';
import { buildEntries } from '../src/lib/transcript.js';
import { KEYS } from '../src/lib/storage.js';

const session = (fields = {}) => ({ id: 's1', status: 'idle', removed: false, ...fields });
const user = (fields = {}) => ({ id: 'u1', role: 'user', text: 'Fix the bug.', delivery: 'done', at: 1000, ...fields });

test('canForkFrom: the user’s own delivered messages, in a session that is not in the Trash', () => {
  assert.equal(canForkFrom(user(), session()), true);
  // Whatever stage the turn is at: a fork copies only what came before the message.
  for (const delivery of ['running', 'stopped', 'interrupted', 'error', undefined]) assert.equal(canForkFrom(user({ delivery }), session()), true, String(delivery));
  assert.equal(canForkFrom(user(), session({ status: 'running' })), true, 'allowed while busy');
  assert.equal(canForkFrom(user(), session({ status: 'waiting' })), true);
});

test('canForkFrom: not queued, cancelled or nested messages, other roles, or the Trash', () => {
  assert.equal(canForkFrom(user({ delivery: 'queued' }), session()), false);
  assert.equal(canForkFrom(user({ delivery: 'cancelled' }), session()), false);
  assert.equal(canForkFrom(user({ parentToolId: 'toolu_agent', from: 'user' }), session()), false, 'a message to a model agent');
  assert.equal(canForkFrom({ id: 'a1', role: 'assistant', text: 'Done.' }, session()), false);
  assert.equal(canForkFrom({ id: 'n1', role: 'notice', text: 'Forked.' }, session()), false);
  assert.equal(canForkFrom(user(), session({ removed: true })), false);
  assert.equal(canForkFrom(user({ id: '' }), session()), false);
  assert.equal(canForkFrom(user(), null), false);
  assert.equal(canForkFrom(null, session()), false);
});

test('canForkFrom: imported messages only outside Codex imports', () => {
  assert.equal(canForkFrom(user({ imported: true }), session({ source: { kind: 'codex', id: 'x' } })), false);
  assert.equal(canForkFrom(user({ imported: true }), session({ source: { kind: 'claude', id: 'x' } })), true);
  // A turn made here, in a session that came from Codex, is not imported.
  assert.equal(canForkFrom(user(), session({ source: { kind: 'codex', id: 'x' } })), true);
});

test('canForkFrom agrees with the transcript: queued and nested messages are not shown anyway', () => {
  const messages = [user({ id: 'u1' }), user({ id: 'u2', delivery: 'queued' }), user({ id: 'u3', parentToolId: 'toolu_agent', from: 'user' })];
  const shown = buildEntries(messages).entries.filter((entry) => entry.type === 'user').map((entry) => entry.message.id);
  assert.deepEqual(shown, ['u1']);
  assert.deepEqual(shown.filter((id) => canForkFrom(messages.find((m) => m.id === id), session())), ['u1']);
});

test('splitForkNotice cuts the notice around the original’s title', () => {
  assert.deepEqual(splitForkNotice('Forked from “Review GPU memory profile”.'), { before: 'Forked from “', title: 'Review GPU memory profile', after: '”.' });
  assert.deepEqual(splitForkNotice('Forked from “Fix NCCL” before your message.'), { before: 'Forked from “', title: 'Fix NCCL', after: '” before your message.' });
  // Quotes inside the title stay in it.
  assert.equal(splitForkNotice('Forked from “Say “hi” again”.').title, 'Say “hi” again');
  assert.equal(splitForkNotice('Forked from “(untitled)”.').title, '(untitled)');
  assert.equal(splitForkNotice('Forked from a session.'), null);
  assert.equal(splitForkNotice(undefined), null);
});

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

const attachment = (id) => ({ id, name: id + '.png', size: 12, type: 'image/png', image: true, url: `/api/uploads/${id}` });

test('storeForkDraft leaves the message text and attachments as the new session’s draft', () => {
  const storage = memoryStorage();
  storeForkDraft(storage, 'fork1', { text: 'Fix the bug.\nThen the tests.', attachments: [attachment('a1'), attachment('a2')] });
  assert.equal(storage.getItem(KEYS.draft('fork1')), 'Fix the bug.\nThen the tests.');
  assert.deepEqual(readAttachments(storage, 'fork1').map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(Object.keys(storage.dump()).sort(), [attachmentsKey('fork1'), KEYS.draft('fork1')].sort());
});

test('storeForkDraft writes only what there is: no draft, an attachment-only message, bad entries', () => {
  const none = memoryStorage();
  storeForkDraft(none, 'fork1', undefined);
  storeForkDraft(none, 'fork1', { text: '  ', attachments: [] });
  assert.deepEqual(none.dump(), {});

  const filesOnly = memoryStorage();
  storeForkDraft(filesOnly, 'fork1', { text: '', attachments: [attachment('a1'), null, { name: 'no id' }] });
  assert.equal(filesOnly.getItem(KEYS.draft('fork1')), null);
  assert.deepEqual(readAttachments(filesOnly, 'fork1').map((a) => a.id), ['a1']);

  // Other drafts are left alone.
  const other = memoryStorage({ [KEYS.draft(null)]: 'typed in a new chat', [KEYS.draft('s1')]: 'half-written' });
  storeForkDraft(other, 'fork1', { text: 'Fix the bug.', attachments: [] });
  assert.deepEqual(other.dump(), { [KEYS.draft(null)]: 'typed in a new chat', [KEYS.draft('s1')]: 'half-written', [KEYS.draft('fork1')]: 'Fix the bug.' });
});
