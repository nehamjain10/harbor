import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  MODES,
  RESTART_NOTICE,
  createSession,
  createStore,
  addNotice,
  migrateMode,
  normalizeMode,
  publicMessage,
  publicSession,
  sessionJsonParts,
  settleOrphanedTools,
} from '../server/store.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-store-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeSession(fields) {
  const session = {
    id: fields.id,
    title: 'Saved',
    cwd: '/tmp',
    model: 'opus',
    mode: 'yolo',
    status: 'idle',
    messages: [],
    pending: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...fields,
  };
  fs.writeFileSync(path.join(dataDir, session.id + '.json'), JSON.stringify(session));
  return session;
}

describe('mode names', () => {
  test('current names are kept as they are', () => {
    for (const mode of MODES) assert.equal(normalizeMode(mode), mode);
    assert.deepEqual(MODES, ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  });

  test('legacy v1 names map to the new names', () => {
    assert.equal(normalizeMode('yolo'), 'bypassPermissions');
    assert.equal(normalizeMode('ask'), 'default');
    assert.equal(normalizeMode('plan'), 'plan');
  });

  test('unknown names are rejected', () => {
    for (const value of ['', 'YOLO', 'dontAsk', 'constructor', 'toString', undefined, null, 3]) {
      assert.equal(normalizeMode(value), null, String(value));
    }
  });

  test('migration on load falls back to default for anything unrecognized', () => {
    assert.equal(migrateMode('yolo'), 'bypassPermissions');
    assert.equal(migrateMode('ask'), 'default');
    assert.equal(migrateMode('plan'), 'plan');
    assert.equal(migrateMode('acceptEdits'), 'acceptEdits');
    assert.equal(migrateMode(undefined), 'default');
    assert.equal(migrateMode('garbage'), 'default');
  });
});

describe('createStore().load', () => {
  test('migrates stored modes', () => {
    writeSession({ id: 'a', mode: 'yolo' });
    writeSession({ id: 'b', mode: 'ask' });
    writeSession({ id: 'c', mode: 'plan' });
    writeSession({ id: 'd', mode: 'auto' });
    const store = createStore({ dataDir });
    assert.equal(store.load(), 4);
    assert.equal(store.get('a').mode, 'bypassPermissions');
    assert.equal(store.get('b').mode, 'default');
    assert.equal(store.get('c').mode, 'plan');
    assert.equal(store.get('d').mode, 'auto');
  });

  test('conversations on a retired model continue on its successor', () => {
    // GLM 5.3 Flash left the gateway (10-16): its chats move to DeepSeek on the model's default effort.
    writeSession({ id: 'g', model: 'glm', efforts: { glm: 'low', opus: 'max' } });
    writeSession({ id: 'k', model: 'kimi', efforts: { kimi: 'low' } });
    const store = createStore({ dataDir });
    store.load();
    assert.equal(store.get('g').model, 'deepseek');
    assert.deepEqual(store.get('g').efforts, { opus: 'max' });
    assert.equal(store.get('k').model, 'kimi');
    assert.deepEqual(store.get('k').efforts, { kimi: 'low' });
  });

  test('a persisted Stop prevents automatic restart recovery', () => {
    writeSession({ id: 'stopped', status: 'running', stopRequested: true });
    const store = createStore({ dataDir });
    store.load();
    assert.equal(store.get('stopped').restartRecovery, undefined);
    assert.match(store.get('stopped').messages.at(-1).text, /remains stopped/);
  });

  test('marks running and waiting sessions interrupted with a restart notice', () => {
    writeSession({
      id: 'running',
      status: 'running',
      pending: [{ id: 'p1', tool: 'Bash' }],
      messages: [
        { id: 'm1', role: 'user', text: 'hi', at: 1500 },
        { id: 't1', role: 'tool', text: '', at: 1600, tool: 'Bash', toolId: 'x', state: 'running', elapsed: 4 },
      ],
    });
    writeSession({ id: 'waiting', status: 'waiting' });
    writeSession({ id: 'idle', status: 'idle' });
    const store = createStore({ dataDir });
    store.load();

    for (const id of ['running', 'waiting']) {
      const session = store.get(id);
      assert.equal(session.status, 'interrupted');
      assert.deepEqual(session.pending, []);
      const notice = session.messages.at(-1);
      assert.equal(notice.role, 'notice');
      assert.equal(notice.text, RESTART_NOTICE);
      assert.equal(notice.text, 'The server restarted. Resuming this conversation automatically.');
      assert.equal(session.restartRecovery, true);
      assert.equal(notice.level, 'warning');
      assert.equal(typeof notice.id, 'string');
      assert.equal(typeof notice.at, 'number');
    }
    assert.equal(store.get('running').messages.length, 3);
    const tool = store.get('running').messages[1];
    assert.equal(tool.state, 'error', 'a tool cut off by the restart stops spinning');
    assert.equal(tool.elapsed, undefined);

    const idle = store.get('idle');
    assert.equal(idle.status, 'idle');
    assert.equal(idle.messages.length, 0);
  });

  test('a background agent of an idle session stops spinning after a restart (its process is gone)', () => {
    writeSession({
      id: 'bg',
      status: 'idle',
      messages: [
        { id: 'm1', role: 'user', text: 'go', at: 1500 },
        { id: 't1', role: 'tool', text: '', at: 1600, tool: 'Agent', toolId: 'a', state: 'running', background: true, elapsed: 3 },
        { id: 't2', role: 'tool', text: '', at: 1700, tool: 'Bash', toolId: 'b', state: 'running', parentToolId: 'a' },
      ],
    });
    const store = createStore({ dataDir });
    store.load();
    const session = store.get('bg');
    assert.equal(session.status, 'idle', 'no turn was cut off');
    assert.deepEqual(
      session.messages.map((m) => [m.role, m.state]),
      [
        ['user', undefined],
        ['tool', 'error'],
        ['tool', 'error'],
      ],
    );
    assert.equal(session.messages[1].output, 'Interrupted before this tool call finished.');
    assert.equal(publicSession(session).backgroundAgents, 0);
  });

  test('publicSession counts running background agents (not nested, foreground or finished ones)', () => {
    const tool = (fields) => ({ id: fields.toolId, role: 'tool', text: '', at: 1, tool: 'Agent', state: 'running', ...fields });
    const session = {
      ...createSession({ cwd: '/tmp', model: 'luna', mode: 'default' }),
      messages: [
        tool({ toolId: 'a', background: true }),
        tool({ toolId: 'b', background: true }),
        tool({ toolId: 'c' }),
        tool({ toolId: 'd', background: true, state: 'done' }),
        tool({ toolId: 'e', background: true, parentToolId: 'a' }),
        tool({ toolId: 'f', background: true, tool: 'Bash' }),
      ],
    };
    assert.equal(publicSession(session).backgroundAgents, 2);
    assert.equal(publicSession(session, true).backgroundAgents, 2);
  });

  test('messages sent mid-turn that Claude never read go back to the front of the paused queue', () => {
    writeSession({
      id: 'steered',
      status: 'running',
      messages: [
        { id: 'm1', role: 'user', text: 'job', at: 1500, delivery: 'running' },
        { id: 'm2', role: 'user', text: 'also this', at: 1600, delivery: 'sent' },
        { id: 'm3', role: 'user', text: 'and this', at: 1700, delivery: 'sent' },
        { id: 'm4', role: 'user', text: 'after', at: 1800, delivery: 'queued' },
      ],
      steering: [
        { id: 'm2', text: 'also this' },
        { id: 'm3', text: 'and this' },
      ],
      queue: [{ id: 'm4', text: 'after' }],
    });
    const store = createStore({ dataDir });
    store.load();
    const session = store.get('steered');
    assert.deepEqual(session.queue.map((item) => item.id), ['m2', 'm3', 'm4']);
    assert.deepEqual(session.steering, []);
    assert.equal(session.queuePaused, true);
    assert.deepEqual(session.messages.slice(0, 4).map((m) => m.delivery), ['running', 'queued', 'queued', 'queued']);
    assert.deepEqual(publicSession(session).steering, []);
  });

  test('messages to a model agent that it never read are dropped by a restart; they are not queued or top level', () => {
    writeSession({
      id: 'workers',
      status: 'idle',
      messages: [
        { id: 'c1', role: 'tool', tool: 'mcp__meshy__delegate', toolId: 'toolu_a', state: 'running', agentId: 'luna-aaaaaa', at: 1 },
        { id: 'm1', role: 'user', text: 'first', parentToolId: 'toolu_a', from: 'lead', delivery: 'done', at: 2 },
        { id: 'm2', role: 'user', text: 'second', parentToolId: 'toolu_a', from: 'user', delivery: 'sent', at: 3 },
      ],
    });
    const store = createStore({ dataDir });
    store.load();
    const session = store.get('workers');
    assert.deepEqual(session.messages.slice(1).map((m) => m.delivery), ['done', 'dropped']);
    assert.equal(session.queue, undefined, 'never put back in the queue');
    assert.equal(session.queuePaused, undefined);
  });

  test('loading does not rewrite files', () => {
    writeSession({ id: 'a', mode: 'yolo', status: 'running' });
    const before = fs.readFileSync(path.join(dataDir, 'a.json'), 'utf8');
    createStore({ dataDir }).load();
    assert.equal(fs.readFileSync(path.join(dataDir, 'a.json'), 'utf8'), before);
  });

  test('skips and reports corrupt files, ignores leftover temp files', () => {
    writeSession({ id: 'good' });
    fs.writeFileSync(path.join(dataDir, 'broken.json'), '{"id": "broken",');
    fs.writeFileSync(path.join(dataDir, 'good.json.tmp'), '{"id": "tmp"}');
    const logged = [];
    const store = createStore({ dataDir, log: (message) => logged.push(message) });
    assert.equal(store.load(), 1);
    assert.ok(store.sessions.has('good'));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^Skipping unreadable session file .*broken\.json: /);
  });

  test('creates a missing data directory', () => {
    const nested = path.join(dataDir, 'nested', 'data');
    const store = createStore({ dataDir: nested });
    assert.equal(store.load(), 0);
    assert.ok(fs.statSync(nested).isDirectory());
  });

  test('get() throws a 404 for unknown sessions', () => {
    const store = createStore({ dataDir });
    store.load();
    assert.throws(() => store.get('missing'), (error) => error.status === 404 && error.message === 'Session not found');
  });
});

describe('createStore().save', () => {
  test('writes a private file atomically and survives a reload', () => {
    const store = createStore({ dataDir });
    store.load();
    const session = store.insert(createSession({ cwd: '/tmp', model: 'opus', mode: 'plan' }));
    session.messages.push({ id: 'm1', role: 'user', text: 'hello', at: 5 });
    session.sdkSessionId = 'sdk-123';
    const before = Date.now();
    store.save(session);

    const file = path.join(dataDir, session.id + '.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(file + '.tmp'), false);
    assert.ok(session.updatedAt >= before);

    const reloaded = createStore({ dataDir });
    reloaded.load();
    assert.deepEqual(reloaded.get(session.id), session);
  });

  test('overwrites an existing file in place', () => {
    const store = createStore({ dataDir });
    store.load();
    const session = store.insert(createSession({ cwd: '/tmp', model: 'opus', mode: 'default' }));
    store.save(session);
    session.title = 'Renamed';
    store.save(session);
    assert.deepEqual(fs.readdirSync(dataDir), [session.id + '.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, session.id + '.json'))).title, 'Renamed');
  });

  test('migrated modes are persisted on the next save', () => {
    writeSession({ id: 'legacy', mode: 'ask' });
    const store = createStore({ dataDir });
    store.load();
    store.save(store.get('legacy'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'legacy.json'))).mode, 'default');
  });
});

describe('createStore().saveAll', () => {
  test('saves every session and reports failures without stopping', () => {
    const logged = [];
    const store = createStore({ dataDir, log: (message) => logged.push(message) });
    store.load();
    const first = store.insert(createSession({ cwd: '/tmp', model: 'opus', mode: 'default' }));
    const broken = store.insert({ ...createSession({ cwd: '/tmp', model: 'opus', mode: 'default' }), id: 'missing-dir/x' });
    const last = store.insert(createSession({ cwd: '/tmp', model: 'opus', mode: 'default' }));
    assert.doesNotThrow(() => store.saveAll());
    assert.ok(fs.existsSync(path.join(dataDir, first.id + '.json')));
    assert.ok(fs.existsSync(path.join(dataDir, last.id + '.json')));
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`^Could not save session ${broken.id}: ENOENT`));
  });
});

describe('createStore().persist', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, id + '.json'), 'utf8'));
  const bigSession = () => {
    const session = createSession({ cwd: '/tmp', model: 'opus', mode: 'default' });
    for (let i = 0; i < 50; i++) addNotice(session, 'note ' + i);
    return session;
  };

  test('a small session is saved at once', () => {
    const store = createStore({ dataDir });
    const session = store.insert(createSession({ cwd: '/tmp', model: 'opus', mode: 'default' }));
    store.persist(session);
    assert.equal(onDisk(session.id).id, session.id);
  });

  test('a large one is written off the event loop, coalesced, as it was when the write began', async () => {
    const store = createStore({ dataDir, largeSaveBytes: 1000, largeSaveIntervalMs: 60 });
    const session = store.insert(bigSession());
    store.save(session);
    assert.ok(fs.statSync(path.join(dataDir, session.id + '.json')).size >= 1000);
    addNotice(session, 'first');
    store.persist(session);
    addNotice(session, 'second');
    store.persist(session);
    assert.equal(onDisk(session.id).messages.length, 50, 'not yet written');
    await sleep(40);
    assert.equal(onDisk(session.id).messages.length, 52, 'both changes in one write');
    assert.deepEqual(onDisk(session.id), JSON.parse(JSON.stringify(session)));
    // The next write waits for the interval after this one.
    addNotice(session, 'third');
    store.persist(session);
    await sleep(20);
    assert.equal(onDisk(session.id).messages.length, 52);
    await sleep(120);
    assert.equal(onDisk(session.id).messages.length, 53);
    assert.deepEqual(fs.readdirSync(dataDir), [session.id + '.json'], 'no temp file left');
  });

  test('a synchronous save (shutdown) is never overwritten by an older write still under way', async () => {
    const store = createStore({ dataDir, largeSaveBytes: 1000, largeSaveIntervalMs: 0 });
    const session = store.insert(bigSession());
    store.save(session);
    addNotice(session, 'pending');
    store.persist(session);
    await sleep(0);
    addNotice(session, 'at shutdown');
    store.saveAll();
    await sleep(60);
    assert.equal(onDisk(session.id).messages.at(-1).text, 'at shutdown');
  });

  test('sessionJsonParts joins to JSON.stringify of the session', () => {
    const session = bigSession();
    session.messages.push({ id: 'x', role: 'tool', input: { a: [1, { b: null }] }, output: '"quoted"\n' });
    session.skipped = undefined;
    session.fn = () => {};
    assert.equal(sessionJsonParts(session).join(''), JSON.stringify(session));
    assert.equal(sessionJsonParts({}).join(''), '{}');
    assert.equal(sessionJsonParts({ messages: [] }).join(''), '{"messages":[]}');
  });
});

describe('createStore().list', () => {
  test('orders sessions by most recent update', () => {
    writeSession({ id: 'old', updatedAt: 1 });
    writeSession({ id: 'new', updatedAt: 3 });
    writeSession({ id: 'mid', updatedAt: 2 });
    const store = createStore({ dataDir });
    store.load();
    assert.deepEqual(store.list().map((s) => s.id), ['new', 'mid', 'old']);
  });
});

describe('publicSession', () => {
  const session = {
    id: 's',
    createdAt: 100,
    sdkSessionId: 'secret',
    live: 'streaming',
    messages: [
      { role: 'user', at: 200 },
      { role: 'assistant', at: 400 },
      { role: 'user', at: 300 },
    ],
  };

  test('full copies keep the transcript but never the SDK session id', () => {
    const copy = publicSession(session, true);
    assert.equal(copy.sdkSessionId, undefined);
    assert.equal(copy.messages.length, 3);
    assert.equal(copy.live, 'streaming');
    assert.equal(copy.lastMessageAt, 300);
    assert.equal(session.sdkSessionId, 'secret', 'original untouched');
  });

  test('list copies drop messages and live text', () => {
    const copy = publicSession(session);
    assert.equal(copy.messages, undefined);
    assert.equal(copy.live, undefined);
    assert.equal(copy.lastMessageAt, 300);
  });

  test('a message to a model agent (nested under its card) does not date the session', () => {
    const nested = { createdAt: 100, messages: [{ role: 'user', at: 200 }, { role: 'user', at: 900, parentToolId: 'toolu_a', from: 'lead', delivery: 'sent' }] };
    assert.equal(publicSession(nested).lastMessageAt, 200);
  });

  test('lastMessageAt falls back to createdAt', () => {
    assert.equal(publicSession({ createdAt: 7, messages: [] }).lastMessageAt, 7);
  });

  test('imported sessions: old messages do not date the session; import plumbing stays here', () => {
    const imported = {
      createdAt: 500,
      messages: [
        { role: 'user', at: 100, imported: true },
        { role: 'assistant', at: 120, imported: true },
      ],
      source: { kind: 'claude', id: 'orig', createdAt: 90, updatedAt: 120 },
      forkFrom: 'orig',
      handoff: '[Harbor: ...]',
    };
    for (const copy of [publicSession(imported), publicSession(imported, true)]) {
      assert.equal(copy.lastMessageAt, 500, 'the import time');
      assert.equal(copy.forkFrom, undefined);
      assert.equal(copy.handoff, undefined);
      assert.deepEqual(copy.source, imported.source);
    }
    imported.messages.push({ role: 'user', at: 900 });
    assert.equal(publicSession(imported).lastMessageAt, 900);
  });
});

describe('v2 public copies and helpers', () => {
  test('full copies cut tool output at 4000 characters and flag it', () => {
    const long = { id: 't', role: 'tool', output: 'x'.repeat(4001) };
    const copy = publicMessage(long);
    assert.equal(copy.output.length, 4000);
    assert.equal(copy.outputTruncated, true);
    assert.equal(long.output.length, 4001, 'the stored message is untouched');
    const exact = { id: 'u', role: 'tool', output: 'x'.repeat(4000) };
    assert.equal(publicMessage(exact), exact);
    const text = { id: 'a', role: 'assistant', text: 'y'.repeat(9000) };
    assert.equal(publicMessage(text), text, 'only tool output is cut');
    // The cut copy is kept while the message is unchanged (its JSON stays cached).
    assert.equal(publicMessage(long), copy);
    long.state = 'done';
    const changed = publicMessage(long);
    assert.notEqual(changed, copy);
    assert.equal(changed.state, 'done');
    long.output = 'z'.repeat(5000);
    assert.equal(publicMessage(long).output, 'z'.repeat(4000));
    delete long.state;
    assert.equal(publicMessage(long).state, undefined);

    const session = { id: 's', createdAt: 1, messages: [long], sdkTotals: { cost: 1 } };
    const full = publicSession(session, true);
    assert.equal(full.messages[0].outputTruncated, true);
    assert.equal(full.sdkTotals, undefined, 'SDK bookkeeping stays on the server');
  });

  test('v1 sessions get empty v2 fields; list copies drop liveThinking too', () => {
    const v1 = { id: 's', createdAt: 1, messages: [] };
    const full = publicSession(v1, true);
    assert.deepEqual(
      { live: full.live, liveThinking: full.liveThinking, todos: full.todos, plan: full.plan, context: full.context, totals: full.totals, mcp: full.mcp },
      { live: '', liveThinking: '', todos: [], plan: null, context: null, totals: { cost: 0, outputTokens: 0, turns: 0 }, mcp: [] },
    );
    const list = publicSession({ ...v1, liveThinking: 'hmm' });
    assert.equal(list.liveThinking, undefined);
    assert.deepEqual(list.totals, { cost: 0, outputTokens: 0, turns: 0 });
  });

  test('addNotice defaults to info; settleOrphanedTools ends running tool calls', () => {
    const session = { messages: [{ role: 'tool', state: 'running', output: '' }, { role: 'tool', state: 'done', output: 'ok' }] };
    assert.equal(addNotice(session, 'Hi').level, 'info');
    settleOrphanedTools(session, 42);
    assert.deepEqual(session.messages[0], { role: 'tool', state: 'error', output: 'Interrupted before this tool call finished.', endedAt: 42 });
    assert.deepEqual(session.messages[1], { role: 'tool', state: 'done', output: 'ok' });

    // `keep` spares calls that are still really running (background subagents).
    const background = { messages: [{ role: 'tool', toolId: 'bg', state: 'running' }, { role: 'tool', toolId: 'x', state: 'running' }] };
    settleOrphanedTools(background, 43, (message) => message.toolId === 'bg');
    assert.deepEqual(background.messages.map((m) => m.state), ['running', 'error']);
  });
});
