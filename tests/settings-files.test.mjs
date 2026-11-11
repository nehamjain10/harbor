// The settings files module on a throwaway Claude config folder and project: the fixed
// allow-list, stale writes, JSON checks, byte-exact edits, atomic writes and backups, and
// memory with its index. Nothing here touches the real ~/.claude.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { projectSlug } from '../server/agent-transcript.mjs';
import { BACKUPS_KEPT, createSettingsFiles } from '../server/settings-files.mjs';

let base;
let configDir;
let project;
let outside;
let data;
let files;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-settings-')));
  configDir = path.join(base, 'config');
  project = path.join(base, 'home', 'project');
  outside = path.join(base, 'outside');
  data = path.join(base, 'data');
  for (const dir of [configDir, project, outside, data]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  files = createSettingsFiles({ config: { claudeConfigDir: configDir, dataDir: data }, log: () => {} });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const memoryDir = () => path.join(configDir, 'projects', projectSlug(project), 'memory');
const backups = () => (fs.existsSync(path.join(data, 'backups', 'settings')) ? fs.readdirSync(path.join(data, 'backups', 'settings')).sort() : []);
const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);
const mode = (file) => fs.statSync(file).mode & 0o777;

describe('the allow-list', () => {
  test('only the fixed files of each scope resolve, from the config folder and the project', async () => {
    const user = await files.read('user', 'settings');
    assert.equal(user.path, path.join(configDir, 'settings.json'));
    assert.equal((await files.read('user', 'claude-md')).path, path.join(configDir, 'CLAUDE.md'));
    assert.equal((await files.read('project', 'settings', project)).path, path.join(project, '.claude', 'settings.json'));
    assert.equal((await files.read('project', 'claude-md', project)).path, path.join(project, 'CLAUDE.md'));
    assert.equal((await files.read('project', 'dot-claude-md', project)).path, path.join(project, '.claude', 'CLAUDE.md'));
    assert.equal((await files.read('local', 'settings', project)).path, path.join(project, '.claude', 'settings.local.json'));
    assert.equal((await files.read('local', 'claude-md', project)).path, path.join(project, 'CLAUDE.local.md'));
    const { files: listed } = await files.list(project);
    assert.deepEqual(
      listed.map((file) => `${file.scope}/${file.id}`),
      ['user/settings', 'user/claude-md', 'project/settings', 'project/claude-md', 'project/dot-claude-md', 'local/settings', 'local/claude-md'],
    );
    assert.deepEqual((await files.list()).files.map((file) => file.scope), ['user', 'user']);
  });

  test('unknown scopes, files and ids that are paths are refused', async () => {
    for (const [scope, id] of [['user', 'nope'], ['user', '../settings'], ['user', 'dot-claude-md'], ['local', 'dot-claude-md'], ['bogus', 'settings'], ['memory', 'settings'], ['user', '/etc/passwd'], ['project', 'settings.json']]) {
      await rejects(files.read(scope, id, project), 404);
      await rejects(files.write(scope, id, project, { content: 'x', version: null }), 404);
    }
    await rejects(files.read('project', 'settings'), 400, 'project scope needs a folder');
    await rejects(files.patchSettings('user', 'claude-md', null, { version: null, permissions: { allow: ['Bash'] } }), 400);
  });

  test('memory names: only letters, digits, dot, dash and underscore, ending in .md, no leading dot', async () => {
    const odd = ['../x.md', 'a/b.md', '..', '.', '.hidden.md', '.md', 'x.txt', 'x', 'x.md/', 'x\0.md', '', 'a b.md', 'a\\b.md', '%2e%2e.md', 'é.md', 'x.md.', ' x.md', `${'a'.repeat(101)}.md`, '../../settings.json'];
    for (const name of odd) {
      await rejects(files.memoryRead(project, name), 400);
      await rejects(files.memoryWrite(project, name, { content: 'x', version: null }), 400);
      await rejects(files.memoryDelete(project, name, { version: 'x' }), 400);
    }
    assert.equal(fs.existsSync(memoryDir()), false, 'nothing was created');
    assert.equal((await files.memoryWrite(project, 'feedback_x-1.v2.md', { content: 'ok', version: null })).file.name, 'feedback_x-1.v2.md');
    assert.equal((await files.memoryRead(project, 'MEMORY.md')).exists, true, 'the new memory started the index');
  });

  test('a link that leaves the scope is refused, for reads, writes, deletes and in listings', async () => {
    // Project folder: a CLAUDE.md link out, and a .claude folder that is a link out.
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(project, 'CLAUDE.md'));
    await rejects(files.read('project', 'claude-md', project), 403);
    await rejects(files.write('project', 'claude-md', project, { content: 'x', version: null }), 403);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'secret');
    fs.symlinkSync(outside, path.join(project, '.claude'));
    await rejects(files.read('project', 'settings', project), 403);
    await rejects(files.patchSettings('local', 'settings', project, { version: null, permissions: { allow: ['Bash'] } }), 403);
    assert.deepEqual(fs.readdirSync(outside), ['secret.md']);
    const listed = (await files.list(project)).files;
    assert.match(listed.find((file) => file.scope === 'project' && file.id === 'claude-md').error, /leaves the project folder/);
    assert.equal(listed.find((file) => file.scope === 'project' && file.id === 'settings').error !== undefined, true);

    // User scope.
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(configDir, 'CLAUDE.md'));
    await rejects(files.read('user', 'claude-md'), 403);

    // Memory: a file link, and then the whole memory folder as a link.
    fs.mkdirSync(memoryDir(), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(memoryDir(), 'link.md'));
    await rejects(files.memoryRead(project, 'link.md'), 403);
    await rejects(files.memoryWrite(project, 'link.md', { content: 'x', version: null }), 403);
    await rejects(files.memoryDelete(project, 'link.md', { version: 'x' }), 403);
    const row = (await files.memoryList(project)).files.find((file) => file.name === 'link.md');
    assert.match(row.error, /leaves the memory folder/);
    fs.rmSync(memoryDir(), { recursive: true });
    fs.symlinkSync(outside, memoryDir());
    await rejects(files.memoryRead(project, 'a.md'), 403);
    await rejects(files.memoryList(project), 403);
    await rejects(files.memoryWrite(project, 'a.md', { content: 'x', version: null }), 403);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'secret');
    assert.deepEqual(fs.readdirSync(outside), ['secret.md']);
  });

  test('a link that stays inside the scope is followed, and kept', async () => {
    fs.mkdirSync(path.join(project, 'docs'));
    fs.writeFileSync(path.join(project, 'docs', 'AGENTS.md'), '# Agents\n');
    fs.symlinkSync(path.join('docs', 'AGENTS.md'), path.join(project, 'CLAUDE.md'));
    const view = await files.read('project', 'claude-md', project);
    assert.equal(view.content, '# Agents\n');
    await files.write('project', 'claude-md', project, { content: '# Agents\nMore\n', version: view.version });
    assert.equal(fs.lstatSync(path.join(project, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(project, 'docs', 'AGENTS.md'), 'utf8'), '# Agents\nMore\n');
  });

  test('folders, binary files and huge files are not edited', async () => {
    fs.mkdirSync(path.join(project, 'CLAUDE.md'));
    await rejects(files.read('project', 'claude-md', project), 400);
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), Buffer.from([0x61, 0, 0x62]));
    await rejects(files.read('user', 'claude-md'), 415);
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), Buffer.from([0xff, 0xfe, 0x41]));
    await rejects(files.read('user', 'claude-md'), 415);
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'x'.repeat(600 * 1024));
    await rejects(files.read('user', 'claude-md'), 413);
    await rejects(files.write('user', 'claude-md', null, { content: 'x'.repeat(600 * 1024), version: null }), 413);
    await rejects(files.write('user', 'claude-md', null, { content: 'a\0b', version: null }), 400);
    await rejects(files.write('user', 'claude-md', null, { content: 7, version: null }), 400);
  });
});

describe('versions and conflicts', () => {
  test('a read gives content and a version; a write from that version succeeds, a stale one fails with the current file', async () => {
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'one\n');
    const first = await files.read('user', 'claude-md');
    assert.deepEqual([first.exists, first.content, first.size], [true, 'one\n', 4]);
    assert.match(first.version, /^[0-9a-f]{16}$/);
    assert.equal(first.version, (await files.read('user', 'claude-md')).version);

    const second = await files.write('user', 'claude-md', null, { content: 'two\n', version: first.version });
    assert.equal(second.changed, true);
    assert.equal(second.file.content, 'two\n');
    assert.notEqual(second.file.version, first.version);

    await assert.rejects(
      files.write('user', 'claude-md', null, { content: 'three\n', version: first.version }),
      (error) => error.status === 409 && error.conflict === true && error.current.content === 'two\n' && error.current.version === second.file.version,
    );
    assert.equal(fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf8'), 'two\n');
  });

  test('creating needs version null, and a file that appeared meanwhile is a conflict', async () => {
    await rejects(files.write('user', 'claude-md', null, { content: 'x', version: 'abcd' }), 409);
    const created = await files.write('user', 'claude-md', null, { content: 'new\n', version: null });
    assert.equal(created.changed, true);
    await rejects(files.write('user', 'claude-md', null, { content: 'other\n', version: null }), 409);
  });

  test('the same content is never a conflict and is not written again', async () => {
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'same\n');
    const before = fs.statSync(path.join(configDir, 'CLAUDE.md'));
    const result = await files.write('user', 'claude-md', null, { content: 'same\n', version: 'stale-version' });
    assert.equal(result.changed, false);
    assert.equal(result.affects, null);
    assert.equal(fs.statSync(path.join(configDir, 'CLAUDE.md')).ino, before.ino);
    assert.deepEqual(backups(), []);
  });

  test('two writes from the same version: one wins, the other gets the conflict', async () => {
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'start\n');
    const { version } = await files.read('user', 'claude-md');
    const results = await Promise.allSettled([
      files.write('user', 'claude-md', null, { content: 'A\n', version }),
      files.write('user', 'claude-md', null, { content: 'B\n', version }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    assert.match(fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf8'), /^[AB]\n$/);
  });
});

describe('settings content', () => {
  test('invalid JSON is refused with the parse error, and the file stays as it was', async () => {
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{"a": 1}\n');
    const { version } = await files.read('project', 'settings', project);
    await assert.rejects(files.write('project', 'settings', project, { content: '{"a": ', version }), (error) => error.status === 400 && /^Invalid JSON: /.test(error.message));
    await rejects(files.write('project', 'settings', project, { content: '[1]', version }), 400);
    await assert.rejects(files.write('project', 'settings', project, { content: '{"hooks": []}', version }), (error) => error.status === 400 && /hooks/.test(error.message));
    await rejects(files.write('project', 'settings', project, { content: '{"permissions": {"allow": "Bash"}}', version }), 400);
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), '{"a": 1}\n');
    assert.deepEqual(backups(), []);
    // An unreadable file reads fine (so it can be fixed) but cannot be patched.
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{"a": ');
    const broken = await files.read('project', 'settings', project);
    assert.equal(broken.parsed.valid, false);
    assert.match(broken.parsed.error, /JSON/);
    await rejects(files.patchSettings('project', 'settings', project, { version: broken.version, permissions: { allow: ['Bash'] } }), 400);
  });

  test('the parsed view lists permissions and hooks', async () => {
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)'], defaultMode: 'plan', additionalDirectories: ['/tmp/x'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sync' }] }] }, model: 'opus' }),
    );
    const { parsed } = await files.read('user', 'settings');
    assert.deepEqual(parsed.permissions, { allow: ['Bash(ls)'], ask: [], deny: ['Read(.env)'], defaultMode: 'plan', additionalDirectories: ['/tmp/x'] });
    assert.deepEqual(parsed.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'sync' }] }] });
    assert.deepEqual(parsed.keys, ['permissions', 'hooks', 'model']);
    assert.equal((await files.read('local', 'settings', project)).parsed.valid, true, 'a missing file is an empty settings object');
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), '');
    assert.equal((await files.read('local', 'settings', project)).parsed.empty, true);
  });

  test('editing permissions and hooks keeps every other byte, key and order', async () => {
    const original = '{\n\t"zeta": {"a":   1,"b":2e3},\n\t"permissions": {\n\t\t"defaultMode": "auto",\n\t\t"disableBypassPermissionsMode": "disable"\n\t},\n\t"hooks": {\n\t\t"Stop": [{"hooks":[{"type":"command","command":"keep-me"}]}]\n\t},\n\t"name": "caf\\u00e9",\n\t"enabledPlugins": {"p@m": true}\n}\n';
    fs.writeFileSync(path.join(configDir, 'settings.json'), original);
    const { version } = await files.read('user', 'settings');

    const result = await files.patchSettings('user', 'settings', null, { version, permissions: { allow: ['Bash(npm run test:*)'], deny: ['Read(~/secrets/**)'] } });
    const text = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8');
    assert.equal(result.changed, true);
    const cut = original.indexOf('"disable"\n') + '"disable"'.length;
    assert.equal(text.slice(0, text.indexOf('"allow"')), original.slice(0, cut) + ',\n\t\t', 'everything before the new rules is untouched');
    assert.equal(text.slice(text.indexOf('\t},\n\t"hooks"')), original.slice(original.indexOf('\t},\n\t"hooks"')), 'everything after permissions is untouched');
    assert.deepEqual(Object.keys(JSON.parse(text)), ['zeta', 'permissions', 'hooks', 'name', 'enabledPlugins']);
    assert.deepEqual(JSON.parse(text).permissions, { defaultMode: 'auto', disableBypassPermissionsMode: 'disable', allow: ['Bash(npm run test:*)'], deny: ['Read(~/secrets/**)'] });

    // Hooks replaced: permissions and the rest do not move.
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check', timeout: 5 }] }] };
    const afterHooks = await files.patchSettings('user', 'settings', null, { version: result.file.version, hooks });
    const text2 = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8');
    assert.equal(text2.slice(0, text2.indexOf('"hooks"')), text.slice(0, text.indexOf('"hooks"')));
    assert.equal(text2.slice(text2.indexOf('\t"name"')), original.slice(original.indexOf('\t"name"')));
    assert.deepEqual(JSON.parse(text2).hooks, hooks);

    // Emptied lists, an emptied permissions object and empty hooks are removed again.
    const cleared = await files.patchSettings('user', 'settings', null, {
      version: afterHooks.file.version,
      permissions: { allow: [], deny: [], defaultMode: null, disableBypassPermissionsMode: undefined },
      hooks: null,
    }).catch((error) => error);
    assert.equal(cleared.status, 400, 'unknown permission keys are refused');
    const ok = await files.patchSettings('user', 'settings', null, { version: afterHooks.file.version, permissions: { allow: [], deny: [], defaultMode: null }, hooks: {} });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')), {
      zeta: { a: 1, b: 2000 },
      permissions: { disableBypassPermissionsMode: 'disable' },
      name: 'café',
      enabledPlugins: { 'p@m': true },
    });
    assert.equal(ok.changed, true);
  });

  test('a settings file is created by its first permission and deleted rule by rule; nothing is created for nothing', async () => {
    const none = await files.patchSettings('project', 'settings', project, { version: null, permissions: { allow: [] } });
    assert.equal(none.changed, false);
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);

    const first = await files.patchSettings('project', 'settings', project, { version: null, permissions: { allow: ['Bash(ls)', 'Bash(ls)', 'Read'] } });
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), '{\n  "permissions": {\n    "allow": [\n      "Bash(ls)",\n      "Read"\n    ]\n  }\n}\n');
    assert.deepEqual(first.file.parsed.permissions.allow, ['Bash(ls)', 'Read'], 'a rule listed twice is kept once');
    assert.equal(first.affects.scope, 'project');
    assert.equal(first.affects.cwd, project);

    await files.patchSettings('project', 'settings', project, { version: first.file.version, permissions: { allow: [] } });
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), '{}\n');
  });

  test('permission and hook problems are refused with a reason', async () => {
    const patch = (body) => files.patchSettings('user', 'settings', null, { version: null, ...body });
    await assert.rejects(patch({ permissions: { allow: ['two words'] } }), (error) => error.status === 400 && /permissions\.allow/.test(error.message));
    await assert.rejects(patch({ permissions: { allow: 'Bash' } }), (error) => error.status === 400);
    await assert.rejects(patch({ permissions: { colour: [] } }), (error) => error.status === 400 && /Unknown permissions setting/.test(error.message));
    await assert.rejects(patch({ permissions: [] }), (error) => error.status === 400);
    await assert.rejects(patch({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }), (error) => error.status === 400 && /command/.test(error.message));
    assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false);
  });
});

describe('writing', () => {
  test('replaces the file by renaming a temp file from the same folder, keeping its permissions', async () => {
    const file = path.join(configDir, 'settings.json');
    fs.writeFileSync(file, '{}\n');
    fs.chmodSync(file, 0o640);
    const inode = fs.statSync(file).ino;
    const { version } = await files.read('user', 'settings');
    await files.write('user', 'settings', null, { content: '{"model": "opus"}\n', version });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"model": "opus"}\n');
    assert.equal(mode(file), 0o640);
    assert.notEqual(fs.statSync(file).ino, inode, 'a new file took its place');
    assert.deepEqual(fs.readdirSync(configDir), ['settings.json'], 'no temp file is left behind');
  });

  test('a new file gets the usual permissions and its folders are created', async () => {
    await files.write('local', 'settings', project, { content: '{}\n', version: null });
    assert.equal(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'), '{}\n');
    assert.equal(mode(path.join(project, '.claude', 'settings.local.json')) & 0o600, 0o600);
    assert.deepEqual(backups(), [], 'nothing to back up when the file is new');
    assert.deepEqual(fs.readdirSync(path.join(project, '.claude')), ['settings.local.json']);
  });

  test('every change keeps the previous copy under the data folder, private, newest 50 only', async () => {
    const file = path.join(configDir, 'CLAUDE.md');
    fs.writeFileSync(file, 'v0\n');
    let version = (await files.read('user', 'claude-md')).version;
    await files.write('user', 'claude-md', null, { content: 'v1\n', version });
    const [name] = backups();
    assert.match(name, /^\d{8}T\d{9}Z-user-CLAUDE\.md$/);
    assert.equal(fs.readFileSync(path.join(data, 'backups', 'settings', name), 'utf8'), 'v0\n');
    assert.equal(mode(path.join(data, 'backups', 'settings', name)), 0o600);
    assert.equal(mode(path.join(data, 'backups')), 0o700);

    version = (await files.read('user', 'claude-md')).version;
    for (let i = 2; i < BACKUPS_KEPT + 8; i += 1) {
      const result = await files.write('user', 'claude-md', null, { content: `v${i}\n`, version });
      version = result.file.version;
    }
    const kept = backups();
    assert.equal(kept.length, BACKUPS_KEPT);
    assert.deepEqual([...kept].sort(), kept, 'names sort by time');
    // The newest backup is the copy before the last write; the oldest ones are gone.
    assert.equal(fs.readFileSync(path.join(data, 'backups', 'settings', kept.at(-1)), 'utf8'), `v${BACKUPS_KEPT + 6}\n`);
    assert.equal(kept.includes(name), false);
  });

  test('backup names say the scope and file, including the project\'s .claude/CLAUDE.md', async () => {
    await files.write('project', 'dot-claude-md', project, { content: 'a\n', version: null });
    await files.write('project', 'dot-claude-md', project, { content: 'b\n', version: (await files.read('project', 'dot-claude-md', project)).version });
    await files.write('local', 'settings', project, { content: '{}\n', version: null });
    await files.patchSettings('local', 'settings', project, { version: (await files.read('local', 'settings', project)).version, permissions: { allow: ['Bash'] } });
    assert.deepEqual(
      backups().map((name) => name.replace(/^\d{8}T\d{9}Z-/, '')),
      ['project-dot-claude-CLAUDE.md', 'local-settings.local.json'],
    );
  });
});

describe('memory', () => {
  const memory = (name, description, body = 'Body.\n') => `---\nname: ${name}\ndescription: "${description}"\nmetadata: \n  node_type: memory\n  type: project\n---\n\n${body}`;

  test('creating a memory adds its index line (title from the frontmatter, hook from the description)', async () => {
    const created = await files.memoryWrite(project, 'workbench-notes.md', { content: memory('workbench-notes', 'Workbench rewrite notes'), version: null });
    assert.equal(created.changed, true);
    assert.deepEqual(created.file.frontmatter, { name: 'workbench-notes', description: 'Workbench rewrite notes', type: 'project' });
    assert.equal(fs.readFileSync(path.join(memoryDir(), 'MEMORY.md'), 'utf8'), '# Memory Index\n\n- [workbench-notes](workbench-notes.md) — Workbench rewrite notes\n');
    assert.deepEqual(created.affects, { scope: 'memory', cwd: project });
    assert.equal(mode(memoryDir()), 0o700);

    await files.memoryWrite(project, 'second.md', { content: memory('second', 'ignored'), version: null, index: { title: 'Second one', hook: 'my own hook' } });
    assert.equal(
      fs.readFileSync(path.join(memoryDir(), 'MEMORY.md'), 'utf8'),
      '# Memory Index\n\n- [workbench-notes](workbench-notes.md) — Workbench rewrite notes\n- [Second one](second.md) — my own hook\n',
    );
  });

  test('editing a memory leaves the index alone and needs no restart; the index itself is editable', async () => {
    const created = await files.memoryWrite(project, 'a.md', { content: memory('a', 'first'), version: null });
    const index = (await files.memoryList(project)).index;
    const edited = await files.memoryWrite(project, 'a.md', { content: memory('a', 'changed description', 'New body.\n'), version: created.file.version });
    assert.equal(edited.changed, true);
    assert.equal(edited.affects, null, 'a memory body is read on demand, not at process start');
    assert.equal((await files.memoryList(project)).index.version, index.version, 'the index was not touched');

    const written = await files.memoryWrite(project, 'MEMORY.md', { content: '# Mine\n\n- [A](a.md) — first\n', version: index.version });
    assert.deepEqual(written.affects, { scope: 'memory', cwd: project });
    await rejects(files.memoryWrite(project, 'MEMORY.md', { content: 'x', version: index.version }), 409);
  });

  test('deleting a memory backs it up, removes it and its index lines', async () => {
    const a = await files.memoryWrite(project, 'a.md', { content: memory('a', 'first'), version: null });
    await files.memoryWrite(project, 'b.md', { content: memory('b', 'second'), version: null });
    await rejects(files.memoryDelete(project, 'a.md', { version: 'stale' }), 409);
    assert.equal(fs.existsSync(path.join(memoryDir(), 'a.md')), true);

    const result = await files.memoryDelete(project, 'a.md', { version: a.file.version });
    assert.equal(result.deleted, true);
    assert.deepEqual(result.affects, { scope: 'memory', cwd: project });
    assert.equal(fs.existsSync(path.join(memoryDir(), 'a.md')), false);
    assert.equal(fs.readFileSync(path.join(memoryDir(), 'MEMORY.md'), 'utf8'), '# Memory Index\n\n- [b](b.md) — second\n');
    const saved = backups().find((name) => name.endsWith('-memory-a.md'));
    assert.equal(fs.readFileSync(path.join(data, 'backups', 'settings', saved), 'utf8'), memory('a', 'first'));
    await rejects(files.memoryDelete(project, 'a.md', { version: a.file.version }), 404);
    await rejects(files.memoryDelete(project, 'MEMORY.md', { version: 'x' }), 400);
  });

  test('the list has each memory\'s frontmatter and index state, and the index lines that point nowhere', async () => {
    assert.deepEqual(await files.memoryList(project), {
      dir: memoryDir(),
      exists: false,
      cwd: project,
      index: { exists: false, size: 0, mtime: null, version: null, content: '', lines: [] },
      files: [],
      missing: [],
    });
    fs.mkdirSync(memoryDir(), { recursive: true });
    fs.writeFileSync(path.join(memoryDir(), 'MEMORY.md'), '# Memory Index\n\n- [A](a.md) — in\n- [Gone](gone.md) — deleted by hand\n');
    fs.writeFileSync(path.join(memoryDir(), 'a.md'), memory('a', 'Alpha'));
    fs.writeFileSync(path.join(memoryDir(), 'z.md'), '---\nname: zed\ndescription: Zed\ntype: feedback\n---\nBody');
    fs.writeFileSync(path.join(memoryDir(), 'notes.txt'), 'not a memory');
    fs.writeFileSync(path.join(memoryDir(), '.hidden.md'), 'hidden');
    fs.mkdirSync(path.join(memoryDir(), 'dir.md'));
    const list = await files.memoryList(project);
    assert.deepEqual(list.files.map((file) => [file.name, file.frontmatter, file.inIndex]), [
      ['a.md', { name: 'a', description: 'Alpha', type: 'project' }, true],
      ['z.md', { name: 'zed', description: 'Zed', type: 'feedback' }, false],
    ]);
    assert.equal(list.files[0].content, undefined, 'the list carries no bodies');
    assert.match(list.files[0].version, /^[0-9a-f]{16}$/);
    assert.deepEqual(list.index.lines.map((line) => line.file), ['a.md', 'gone.md']);
    assert.deepEqual(list.missing.map((line) => line.file), ['gone.md']);
    assert.equal((await files.memoryRead(project, 'z.md')).body, 'Body');
  });

  test('another project\'s memory is a different folder', async () => {
    const other = path.join(base, 'home', 'other');
    fs.mkdirSync(other);
    await files.memoryWrite(project, 'a.md', { content: 'mine', version: null });
    assert.equal((await files.memoryList(other)).exists, false);
    assert.notEqual(projectSlug(other), projectSlug(project));
  });
});

describe('what a write affects', () => {
  test('the user scope reaches every session, project and local ones their project, an unchanged file nothing', async () => {
    assert.deepEqual((await files.write('user', 'claude-md', null, { content: 'x', version: null })).affects, { scope: 'user', cwd: null });
    assert.deepEqual((await files.write('project', 'claude-md', project, { content: 'x', version: null })).affects, { scope: 'project', cwd: project });
    assert.deepEqual((await files.write('local', 'claude-md', project, { content: 'x', version: null })).affects, { scope: 'local', cwd: project });
    assert.equal((await files.write('user', 'claude-md', null, { content: 'x', version: 'whatever' })).affects, null);
  });
});
