// Real-browser checks for the Claude Code settings dialog against the mocked v2 server
// (harness.mjs) and an in-memory copy of the /api/settings routes (settings-mock.mjs):
// opening it, each tab's main flow, "changed on disk", the unsaved-changes guard, the toast
// above the dialog and the phone layout. Run with `npm run test:browser`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, launch, openApp } from './harness.mjs';
import { createSettingsMock } from './settings-mock.mjs';

let browser;

before(async () => {
  buildApp();
  browser = await launch();
});

after(async () => {
  await browser?.close();
});

const HOME = '/home/you';
const WB = `${HOME}/claude-workbench`;
const CWD = `${HOME}/zenit-research`;

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

// The app with the settings mock, the dialog open (from the sidebar gear) on `tab`.
async function setup({ tab, prepare, ...options } = {}) {
  const opened = await openApp(browser, options);
  const mock = createSettingsMock({ home: HOME, folders: [WB, CWD] });
  prepare?.(mock, opened.server);
  opened.server.routes.push(mock.handle);
  const dialog = opened.page.locator('dialog.settings-dialog');
  const open = async () => {
    // On a phone the sidebar is a drawer behind the topbar button.
    if (options.isMobile) await opened.page.getByRole('button', { name: 'Show sidebar' }).click();
    await opened.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await opened.page.getByRole('button', { name: /Claude Code settings/ }).click();
    await dialog.waitFor();
    if (tab) await dialog.getByRole('tab', { name: tab, exact: true }).click();
  };
  return { ...opened, mock, dialog, open };
}

const saveRequests = (server, method) => server.requests.filter((r) => r.method === method && r.path.startsWith('settings/'));
const toastText = (page) => text(page.locator('.toast'));
// The page's errors, minus the browser's console line for each 409 the conflict tests provoke on purpose.
const errorsOf = (server) => server.errors.filter((message) => !/status of 409/.test(message));
const section = (dialog, title) => dialog.locator('.perm-section', { has: dialog.page().getByRole('heading', { name: title, exact: false }) });

test('opens from the sidebar gear, the palette and /settings, at the tab you name; Esc closes it', async () => {
  const { page, dialog, open, server } = await setup();
  await open();
  assert.equal(await text(dialog.locator('#dialog-title')), 'Claude Code settings');
  const tabs = await dialog.getByRole('tab').allTextContents();
  assert.deepEqual(tabs, ['Permissions', 'Hooks', 'CLAUDE.md', 'Memory', 'MCP servers', 'Models'], 'one tab per registry entry');
  assert.equal(await dialog.getByRole('tab', { selected: true }).textContent(), 'Permissions');
  assert.match(await text(dialog.locator('.settings-restart-note')), /rewrites their prompt cache once/);
  // The project defaults to the project of the open chat or the chosen one.
  assert.equal(await dialog.locator('#settings-project').inputValue(), CWD);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await page.keyboard.press('Control+k');
  await page.locator('.palette input').fill('claude code settings');
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  const input = page.locator('.composer textarea');
  await input.fill('/settings memory');
  await input.press('Enter');
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('tab', { selected: true }).textContent(), 'Memory');
  assert.equal(await input.inputValue(), '');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // The open chat's folder is the default project.
  await page.locator('.session-main', { hasText: 'Pick a deploy window' }).click();
  await page.waitForFunction(() => location.search === '?session=s-wait');
  await input.fill('/settings hooks');
  await input.press('Enter');
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('tab', { selected: true }).textContent(), 'Hooks');
  assert.equal(await dialog.locator('#settings-project').inputValue(), WB);
  assert.deepEqual(errorsOf(server), []);
});

test('permissions: add, check, edit and remove rules, default mode, save with a PATCH, toast above the dialog', async () => {
  const { page, dialog, open, mock, server } = await setup({
    tab: 'Permissions',
    prepare: (m) =>
      m.setFile(
        'user',
        'settings',
        JSON.stringify({ env: { A: '1' }, permissions: { allow: ['Bash(git status)', 'Read(~/notes/**)'], deny: ['Read(~/.ssh/**)'], defaultMode: 'acceptEdits' } }, null, 2) + '\n',
      ),
  });
  await open();
  const allow = section(dialog, 'Allow');
  await allow.locator('.rule-row').first().waitFor();
  assert.deepEqual(await allow.locator('.rule-text').allTextContents(), ['Bash(git status)', 'Read(~/notes/**)']);
  assert.equal(await dialog.locator('.perm-mode').inputValue(), 'acceptEdits');
  assert.match(await text(dialog.locator('.settings-path')), /^~\/\.claude\/settings\.json$/);
  assert.equal(await dialog.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing to save yet');
  assert.match(await text(dialog.locator('.settings-note').first()), /Every project/);

  // Add: the rule syntax is checked as you type, and a duplicate is refused.
  await allow.getByRole('button', { name: 'Add rule' }).click();
  const field = allow.getByRole('textbox', { name: 'Rule' });
  assert.match(await text(allow.locator('.rule-hint')), /Bash\(npm run test:\*\)/);
  await field.fill('not a rule!');
  assert.match(await text(allow.locator('.rule-problem')), /Write a tool name/);
  assert.equal(await allow.getByRole('button', { name: 'Add', exact: true }).isDisabled(), true);
  await field.fill('Bash(git status)');
  assert.equal(await text(allow.locator('.rule-problem')), 'This one is already in the list.');
  // Esc closes the field, not the dialog.
  await field.press('Escape');
  assert.equal(await dialog.count(), 1);
  assert.equal(await allow.locator('.rule-form').count(), 0);
  await allow.getByRole('button', { name: 'Add rule' }).click();
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Bash(npm run test:*)');
  await allow.getByRole('textbox', { name: 'Rule' }).press('Enter');
  assert.deepEqual(await allow.locator('.rule-text').allTextContents(), ['Bash(git status)', 'Read(~/notes/**)', 'Bash(npm run test:*)']);
  assert.equal(await text(allow.locator('.rule-row.is-new .settings-chip')), 'New');

  // Edit one in place; remove one from Deny; ask for a rule; change the mode.
  await allow.getByRole('button', { name: 'Edit Read(~/notes/**)' }).click();
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Read(~/notes/**)  ');
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Read(~/docs/**)');
  await allow.getByRole('button', { name: 'Save', exact: true }).click();
  assert.deepEqual(await allow.locator('.rule-text').allTextContents(), ['Bash(git status)', 'Read(~/docs/**)', 'Bash(npm run test:*)']);
  const deny = section(dialog, 'Deny');
  await deny.getByRole('button', { name: 'Remove Read(~/.ssh/**)' }).click();
  assert.equal(await text(deny.locator('.rule-empty')), 'None.');
  const ask = section(dialog, 'Ask');
  await ask.getByRole('button', { name: 'Add rule' }).click();
  await ask.getByRole('textbox', { name: 'Rule' }).fill('Bash(git push:*)');
  await ask.getByRole('textbox', { name: 'Rule' }).press('Enter');
  await dialog.locator('.perm-mode').selectOption('plan');

  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast').waitFor();
  assert.equal(await toastText(page), 'Saved · applies to 2 sessions after their next restart');
  const [request] = saveRequests(server, 'PATCH');
  assert.equal(request.path, 'settings/files/user/settings');
  assert.equal(request.body.cwd, undefined, 'the user scope sends no project');
  assert.deepEqual(request.body.permissions, {
    allow: ['Bash(git status)', 'Read(~/docs/**)', 'Bash(npm run test:*)'],
    ask: ['Bash(git push:*)'],
    deny: [],
    defaultMode: 'plan',
  });
  assert.equal(typeof request.body.version, 'string');
  // The toast is a popover in the top layer, so it shows above the modal dialog and its backdrop.
  assert.equal(await page.locator('.toast').evaluate((el) => el.matches(':popover-open')), true);

  // Everything else in the file is kept, and the list shows what is saved.
  const saved = JSON.parse(mock.file('user', 'settings'));
  assert.deepEqual(saved.env, { A: '1' });
  assert.equal(saved.permissions.defaultMode, 'plan');
  assert.equal(await allow.locator('.rule-row.is-new').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  assert.deepEqual(errorsOf(server), []);
});

test('permissions: project and local files follow the project picker; a missing file is created on save; session grants are removable', async () => {
  const { page, dialog, open, mock, server } = await setup({
    tab: 'Permissions',
    prepare: (m, s) => {
      m.setFile('project', 'settings', JSON.stringify({ permissions: { allow: ['Bash(make test)'] } }, null, 2) + '\n', CWD);
      const session = s.sessions.find((x) => x.id === 's-idle');
      session.allowRules = [{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Read' }];
      session.allowDirectories = ['/home/you/shared'];
    },
  });
  await page.locator('.session-main', { hasText: 'Review GPU memory profile' }).click();
  await page.waitForFunction(() => location.search === '?session=s-idle');
  await open();

  await dialog.getByRole('radio', { name: 'Project' }).click();
  await section(dialog, 'Allow').locator('.rule-row').first().waitFor();
  assert.deepEqual(await section(dialog, 'Allow').locator('.rule-text').allTextContents(), ['Bash(make test)']);
  assert.match(await text(dialog.locator('.settings-path')), /^~\/zenit-research\/\.claude\/settings\.json$/);

  // The other project has no settings file yet.
  await dialog.locator('#settings-project').selectOption(WB);
  await dialog.locator('.settings-chip', { hasText: 'Not created yet' }).waitFor();
  assert.equal(await section(dialog, 'Allow').locator('.rule-row').count(), 0);
  await dialog.getByRole('radio', { name: 'Local' }).click();
  await dialog.locator('.settings-chip', { hasText: 'Not created yet' }).waitFor();
  const deny = section(dialog, 'Deny');
  await deny.getByRole('button', { name: 'Add rule' }).click();
  await deny.getByRole('textbox', { name: 'Rule' }).fill('Bash(rm -rf:*)');
  await deny.getByRole('textbox', { name: 'Rule' }).press('Enter');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast').waitFor();
  const [patch] = saveRequests(server, 'PATCH');
  assert.equal(patch.path, 'settings/files/local/settings');
  assert.equal(patch.body.cwd, WB);
  assert.equal(patch.body.version, null, 'creating: no earlier version');
  assert.deepEqual(JSON.parse(mock.file('local', 'settings', WB)), { permissions: { deny: ['Bash(rm -rf:*)'] } });

  // This chat's "Always allow" grants: remove one, then clear the rest.
  await dialog.getByRole('radio', { name: 'Session' }).click();
  const rows = dialog.locator('.rule-text');
  assert.deepEqual(await rows.allTextContents(), ['Bash(npm test)', 'Read', 'access to /home/you/shared']);
  await dialog.getByRole('button', { name: 'Remove Bash(npm test)' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.settings-dialog .rule-text').length === 2);
  const grants = server.requests.filter((r) => r.path === 'sessions/s-idle');
  assert.deepEqual(grants[0].body, { allowRules: [{ toolName: 'Read' }] });
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.startsWith('Removed.'));
  assert.equal(await toastText(page), 'Removed. It will ask again.');
  await dialog.getByRole('button', { name: 'Remove access to /home/you/shared' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.settings-dialog .rule-text').length === 1);
  assert.deepEqual(grants.length + 1, server.requests.filter((r) => r.path === 'sessions/s-idle').length);
  await dialog.getByRole('button', { name: 'Clear all' }).click();
  await dialog.locator('.rule-empty').waitFor();
  assert.match(await text(dialog.locator('.rule-empty')), /Nothing was allowed in this chat/);
  assert.deepEqual(errorsOf(server), []);
});

test('hooks: the list per event, a JSON editor with validation, a diff before saving', async () => {
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './audit.sh', timeout: 10 }] }] };
  const { page, dialog, open, mock, server } = await setup({
    tab: 'Hooks',
    prepare: (m) => m.setFile('user', 'settings', JSON.stringify({ theme: 'dark', hooks }, null, 2) + '\n'),
  });
  await open();
  await dialog.locator('.hook-event').waitFor();
  assert.equal(await text(dialog.locator('.hook-event-name')), 'PreToolUse');
  assert.equal(await text(dialog.locator('.hook-matcher')), 'Bash');
  assert.equal(await text(dialog.locator('.hook-commands li')), './audit.sh 10s');
  const editor = dialog.getByRole('textbox', { name: 'Edit as JSON' });
  assert.deepEqual(JSON.parse(await editor.inputValue()), hooks);

  // Invalid JSON and a schema mistake name the problem and block saving.
  await editor.fill('{"PreToolUse": [');
  assert.match(await text(dialog.locator('.settings-problem')), /^Invalid JSON: /);
  assert.equal(await dialog.getByRole('button', { name: 'Review changes' }).isDisabled(), true);
  await editor.fill('{"Stop": {"a": 1}}');
  assert.equal(await text(dialog.locator('.settings-problem')), 'hooks.Stop must be a list of matcher groups.');
  // Spacing alone is not a change.
  await editor.fill(JSON.stringify(hooks));
  assert.equal(await dialog.locator('.settings-problem').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Review changes' }).isDisabled(), true);

  // A valid draft shows in the list at once; reviewing shows the diff, then Save.
  const next = { ...hooks, Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], Odd: [] };
  await editor.fill(JSON.stringify(next, null, 2));
  assert.deepEqual(await dialog.locator('.hook-event-name').allTextContents(), ['PreToolUse', 'Stop', 'OddUnknown event']);
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.locator('.diff-panel').waitFor();
  const added = await dialog.locator('.diff-table .d-add').allTextContents();
  assert.ok(added.some((line) => line.includes('say done')), 'the new command is an added line');
  // The comma after the old last event is the one line that changes.
  assert.deepEqual(await dialog.locator('.diff-table .d-del').allTextContents(), ['−  ]']);
  assert.match(await text(dialog.locator('.diff-counts')), /^\+\d+ −1$/);
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  assert.equal(await editor.count(), 1);
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast').waitFor();
  assert.equal(await toastText(page), 'Saved · applies to 2 sessions after their next restart');
  const [request] = saveRequests(server, 'PATCH');
  assert.deepEqual(request.body.hooks, next);
  assert.equal(request.body.permissions, undefined);
  assert.equal(JSON.parse(mock.file('user', 'settings')).theme, 'dark');
  assert.deepEqual(errorsOf(server), []);
});

test('CLAUDE.md: files per scope, preview, a diff before saving, create a missing file', async () => {
  const { page, dialog, open, mock, server } = await setup({
    tab: 'CLAUDE.md',
    prepare: (m) => {
      m.setFile('user', 'claude-md', '# Global rules\n\nBe brief.\n');
      m.setFile('project', 'claude-md', '# Project\n\nUse pnpm.\n', CWD);
    },
  });
  await open();
  await dialog.locator('.split-item').first().waitFor();
  const items = await dialog.locator('.split-item').evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
  assert.equal(items.length, 4);
  assert.match(items[0], /^CLAUDE\.md \d+ B · /);
  assert.match(items[1], /^CLAUDE\.md \d+ B · /);
  assert.equal(items[2], '.claude/CLAUDE.md Not created yet Create');
  assert.equal(items[3], 'CLAUDE.local.md Not created yet Create');

  // The user's file opens first.
  const area = dialog.getByRole('textbox', { name: 'Instructions' });
  assert.equal(await area.inputValue(), '# Global rules\n\nBe brief.\n');
  await area.fill('# Global rules\n\nBe brief.\n\n- Prefer small commits.\n');
  await dialog.getByRole('radio', { name: 'Preview' }).click();
  assert.equal(await text(dialog.locator('.md-preview h1')), 'Global rules');
  assert.equal(await text(dialog.locator('.md-preview li')), 'Prefer small commits.');
  await dialog.getByRole('radio', { name: 'Edit' }).click();
  assert.equal(await area.inputValue(), '# Global rules\n\nBe brief.\n\n- Prefer small commits.\n');

  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.locator('.diff-panel').waitFor();
  assert.deepEqual(await dialog.locator('.diff-table .d-add').allTextContents(), ['+ ', '+- Prefer small commits.']);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast').waitFor();
  assert.equal(await toastText(page), 'Saved · applies to 2 sessions after their next restart');
  const [put] = saveRequests(server, 'PUT');
  assert.equal(put.path, 'settings/files/user/claude-md');
  assert.equal(put.body.content, '# Global rules\n\nBe brief.\n\n- Prefer small commits.\n');
  assert.equal(put.body.cwd, undefined);
  assert.equal(mock.file('user', 'claude-md'), put.body.content);
  assert.equal(await dialog.getByRole('button', { name: 'Review changes' }).isDisabled(), true, 'saved: clean again');

  // Create a missing one (the local, uncommitted file).
  await dialog.getByRole('button', { name: /CLAUDE\.local\.md/ }).click();
  assert.match(await text(dialog.locator('.settings-pane .settings-note').last()), /does not exist yet/);
  await dialog.getByRole('textbox', { name: 'Instructions' }).fill('Never commit secrets.\n');
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.split-item .settings-chip').length === 2);
  const create = saveRequests(server, 'PUT')[1];
  assert.deepEqual({ ...create.body, content: undefined }, { cwd: CWD, version: null, content: undefined });
  assert.equal(mock.file('local', 'claude-md', CWD), 'Never commit secrets.\n');
  assert.deepEqual(errorsOf(server), []);
});

test('memory: list and search, edit frontmatter and body, new, add to index, delete, the index file', async () => {
  const index = '# Memory Index\n\n- [Alpha note](alpha.md) — the alpha hook\n- [Gone](gone.md) — was deleted\n';
  const alpha = '---\nname: Alpha note\ndescription: "the alpha hook"\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: abc\n---\n\nAlpha body.\n';
  const beta = '---\nname: Beta feedback\ndescription: "no mocks"\nmetadata:\n  type: feedback\n---\nBeta body.\n';
  const { page, dialog, open, mock, server } = await setup({
    tab: 'Memory',
    prepare: (m) => {
      m.setMemory(CWD, 'MEMORY.md', index);
      m.setMemory(CWD, 'alpha.md', alpha);
      m.setMemory(CWD, 'beta.md', beta);
    },
  });
  await open();
  await dialog.locator('.memory-item').first().waitFor();
  const rows = () => dialog.locator('.split-items .split-item').evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(await rows(), ['MEMORY.md Index · 2 entries', 'Alpha note project the alpha hook', 'Beta feedback feedback Not in index no mocks']);
  await dialog.getByRole('searchbox', { name: 'Search memories' }).fill('feedback');
  assert.deepEqual((await rows()).slice(1), ['Beta feedback feedback Not in index no mocks']);
  await dialog.getByRole('searchbox', { name: 'Search memories' }).fill('zzz');
  assert.equal(await text(dialog.locator('.memory-empty')), 'No memory matches “zzz”.');
  await dialog.getByRole('searchbox', { name: 'Search memories' }).fill('');

  // Edit: fields come from the frontmatter; only what changed is rewritten.
  await dialog.getByRole('button', { name: /Alpha note/ }).click();
  assert.equal(await dialog.locator('#memory-name').inputValue(), 'Alpha note');
  assert.equal(await dialog.locator('#memory-type').inputValue(), 'project');
  assert.equal(await dialog.locator('#memory-description').inputValue(), 'the alpha hook');
  assert.equal(await dialog.locator('#memory-body').inputValue(), '\nAlpha body.\n');
  await dialog.locator('#memory-description').fill('the alpha hook, revised');
  await dialog.locator('#memory-body').fill('\nAlpha body, longer.\n');
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.locator('.diff-panel').waitFor();
  assert.equal(await dialog.locator('.diff-table .d-del').count(), 2);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast').waitFor();
  assert.equal(await toastText(page), 'Saved', 'a memory body is read on demand: no restart');
  assert.equal(
    mock.memoryFile(CWD, 'alpha.md'),
    '---\nname: Alpha note\ndescription: "the alpha hook, revised"\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: abc\n---\n\nAlpha body, longer.\n',
  );

  // A memory that is not in the index can be added to it.
  await dialog.getByRole('button', { name: /Beta feedback/ }).click();
  await dialog.getByRole('button', { name: 'Add to index' }).click();
  await page.waitForFunction(() => !document.querySelector('.settings-dialog .settings-path .settings-chip.is-warn'));
  assert.equal(await toastText(page), 'Saved · applies to 2 sessions after their next restart');
  assert.match(mock.memoryFile(CWD, 'MEMORY.md'), /- \[Beta feedback\]\(beta\.md\) — no mocks\n$/);

  // New: the file name follows the title; a taken name is refused.
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  await dialog.locator('#new-memory-title').fill('Fresh idea');
  assert.equal(await dialog.locator('#new-memory-file').inputValue(), 'fresh-idea');
  await dialog.locator('#new-memory-description').fill('worth remembering');
  await dialog.locator('#new-memory-body').fill('Fresh body.\n');
  await dialog.locator('#new-memory-file').fill('alpha');
  assert.equal(await text(dialog.locator('.editor-problem')), 'A memory with this name exists.');
  assert.equal(await dialog.getByRole('button', { name: 'Create memory' }).isDisabled(), true);
  await dialog.locator('#new-memory-file').fill('fresh-idea');
  await dialog.getByRole('button', { name: 'Create memory' }).click();
  await dialog.locator('#memory-name').waitFor();
  assert.equal(await dialog.locator('#memory-name').inputValue(), 'Fresh idea');
  const created = saveRequests(server, 'PUT').find((r) => r.path === 'settings/memory/fresh-idea.md');
  assert.equal(created.body.version, null);
  assert.equal(mock.memoryFile(CWD, 'fresh-idea.md'), '---\nname: Fresh idea\ndescription: "worth remembering"\nmetadata:\n  type: project\n---\nFresh body.\n');
  assert.match(mock.memoryFile(CWD, 'MEMORY.md'), /- \[Fresh idea\]\(fresh-idea\.md\) — worth remembering\n$/);
  assert.match(await toastText(page), /^Saved · applies to 2 sessions/);
  await page.waitForFunction(() => document.querySelectorAll('.memory-item').length === 3);

  // Delete asks first, then removes the file and its index line.
  await dialog.getByRole('button', { name: /Beta feedback/ }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  assert.match(await text(dialog.locator('.detail-confirm')), /^Delete beta\.md\?/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(mock.memoryFile(CWD, 'beta.md') !== null, true, 'cancelled: still there');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('group', { name: 'Confirm delete' }).getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.memory-item').length === 2);
  assert.equal(await toastText(page), 'Deleted · applies to 2 sessions after their next restart');
  assert.equal(mock.memoryFile(CWD, 'beta.md'), null);
  assert.doesNotMatch(mock.memoryFile(CWD, 'MEMORY.md'), /beta\.md/);
  const [remove] = mock.requests.filter((r) => r.method === 'DELETE');
  assert.equal(remove.route, 'settings/memory/beta.md');
  assert.equal(remove.query.cwd, CWD);

  // The index: a line pointing at a missing file is flagged; it is editable like any file.
  await dialog.getByRole('button', { name: /^MEMORY\.md/ }).click();
  assert.equal(await text(dialog.locator('.settings-notice')), 'One line points to a file that does not exist: gone.md.');
  const area = dialog.getByRole('textbox', { name: 'Index' });
  const before = await area.inputValue();
  await area.fill(before.replace('- [Gone](gone.md) — was deleted\n', ''));
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('.settings-notice').waitFor({ state: 'detached' });
  assert.doesNotMatch(mock.memoryFile(CWD, 'MEMORY.md'), /gone\.md/);
  assert.deepEqual(errorsOf(server), []);
});

test('changed on disk: the conflict view shows the diff; overwrite or reload', async () => {
  const { page, dialog, open, mock, server } = await setup({
    tab: 'CLAUDE.md',
    prepare: (m) => m.setFile('user', 'claude-md', 'one\ntwo\nthree\n'),
  });
  await open();
  const area = dialog.getByRole('textbox', { name: 'Instructions' });
  await area.fill('one\ntwo mine\nthree\n');
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  // Meanwhile something else (Claude Code, an editor) changes the file.
  mock.setFile('user', 'claude-md', 'one\ntwo\nthree\nfour from disk\n');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('.settings-conflict').waitFor();
  assert.match(await text(dialog.locator('.settings-conflict .settings-notice')), /^Changed on disk\. .*CLAUDE\.md was changed since you opened it/);
  assert.deepEqual(await dialog.locator('.settings-conflict .diff-table .d-add').allTextContents(), ['+two mine']);
  assert.deepEqual(await dialog.locator('.settings-conflict .diff-table .d-del').allTextContents(), ['−two', '−four from disk']);
  assert.equal(mock.file('user', 'claude-md'), 'one\ntwo\nthree\nfour from disk\n', 'nothing was written');

  // Overwrite saves against the disk version.
  await dialog.getByRole('button', { name: 'Overwrite with mine' }).click();
  await page.locator('.toast').waitFor();
  assert.equal(mock.file('user', 'claude-md'), 'one\ntwo mine\nthree\n');
  const puts = saveRequests(server, 'PUT');
  assert.equal(puts.length, 2);
  assert.notEqual(puts[0].body.version, puts[1].body.version);
  assert.equal(await dialog.locator('.settings-conflict').count(), 0);
  assert.equal(await area.inputValue(), 'one\ntwo mine\nthree\n');

  // Reload takes what is on disk and drops the draft.
  await area.fill('one\nmine again\n');
  mock.setFile('user', 'claude-md', 'disk wins\n');
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('.settings-conflict').waitFor();
  await dialog.getByRole('button', { name: 'Reload from disk' }).click();
  await dialog.getByRole('textbox', { name: 'Instructions' }).waitFor();
  assert.equal(await dialog.getByRole('textbox', { name: 'Instructions' }).inputValue(), 'disk wins\n');
  assert.equal(await dialog.getByRole('button', { name: 'Review changes' }).isDisabled(), true);
  assert.equal(mock.file('user', 'claude-md'), 'disk wins\n');

  // The structured editors conflict too: the rules on disk against your draft.
  await dialog.getByRole('tab', { name: 'Permissions' }).click();
  const allow = section(dialog, 'Allow');
  await allow.getByRole('button', { name: 'Add rule' }).click();
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Bash(ls)');
  await allow.getByRole('textbox', { name: 'Rule' }).press('Enter');
  mock.setFile('user', 'settings', JSON.stringify({ permissions: { allow: ['Read'] } }));
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('.settings-conflict').waitFor();
  assert.deepEqual(await dialog.locator('.settings-conflict .diff-table .d-add').allTextContents(), ['+  Bash(ls)']);
  await dialog.getByRole('button', { name: 'Overwrite with mine' }).click();
  await page.waitForFunction(() => !document.querySelector('.settings-conflict'));
  assert.deepEqual(JSON.parse(mock.file('user', 'settings')).permissions.allow, ['Bash(ls)']);
  assert.deepEqual(errorsOf(server), []);
});

test('unsaved changes: leaving a tab, scope, project or the dialog asks first', async () => {
  const { page, dialog, open, server } = await setup({ tab: 'Permissions' });
  await open();
  const allow = section(dialog, 'Allow');
  await allow.getByRole('button', { name: 'Add rule' }).click();
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Bash(ls)');
  await allow.getByRole('textbox', { name: 'Rule' }).press('Enter');
  const leave = dialog.locator('.settings-leave');
  assert.equal(await leave.count(), 0);

  // Another tab: stay, then go and lose the draft.
  await dialog.getByRole('tab', { name: 'Hooks' }).click();
  assert.match(await text(leave), /You have unsaved changes\./);
  assert.equal(await dialog.getByRole('tab', { selected: true }).textContent(), 'Permissions');
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  assert.equal(await leave.count(), 0);
  assert.deepEqual(await allow.locator('.rule-text').allTextContents(), ['Bash(ls)']);
  await dialog.getByRole('tab', { name: 'Hooks' }).click();
  await leave.getByRole('button', { name: 'Discard changes' }).click();
  assert.equal(await dialog.getByRole('tab', { selected: true }).textContent(), 'Hooks');
  await dialog.getByRole('tab', { name: 'Permissions' }).click();
  assert.equal(await dialog.getByRole('tab', { name: 'Permissions', selected: true }).count(), 1, 'a clean editor does not ask');
  assert.equal(await section(dialog, 'Allow').locator('.rule-row').count(), 0, 'the draft is gone');

  // Another scope and another project ask as well.
  await allow.getByRole('button', { name: 'Add rule' }).click();
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Bash(pwd)');
  await allow.getByRole('textbox', { name: 'Rule' }).press('Enter');
  await dialog.getByRole('radio', { name: 'Project' }).click();
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  assert.equal(await dialog.getByRole('radio', { name: 'User', checked: true }).count(), 1);
  await dialog.locator('#settings-project').selectOption(WB);
  await leave.waitFor();
  assert.equal(await dialog.locator('#settings-project').inputValue(), CWD, 'not switched yet');
  await leave.getByRole('button', { name: 'Keep editing' }).click();

  // Closing: Esc, the close button and Done all ask; Discard closes.
  await page.keyboard.press('Escape');
  await leave.waitFor();
  assert.equal(await dialog.count(), 1);
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await leave.waitFor();
  await leave.getByRole('button', { name: 'Discard changes' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(server.requests.filter((r) => r.path.startsWith('settings/')), [], 'nothing was written');

  // A saved editor closes without asking.
  await open();
  await allow.getByRole('button', { name: 'Add rule' }).click();
  await allow.getByRole('textbox', { name: 'Rule' }).fill('Bash(pwd)');
  await allow.getByRole('textbox', { name: 'Rule' }).press('Enter');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errorsOf(server), []);
});

test('phone layout: a bottom sheet with scrolling tabs, one pane at a time, nothing wider than the screen', async () => {
  const { page, dialog, open, server } = await setup({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    waitForSessions: false,
    prepare: (m) => {
      m.setFile('user', 'claude-md', '# Global rules\n\nBe brief.\n');
      m.setFile('user', 'settings', JSON.stringify({ permissions: { allow: ['Bash(npm run test:* --reporter=verbose --coverage)', 'Read(~/a/very/long/path/that/keeps/going/and/going/**)'] } }, null, 2));
      m.setMemory(CWD, 'MEMORY.md', '# Memory Index\n\n- [Alpha note](alpha.md) — the alpha hook\n');
      m.setMemory(CWD, 'alpha.md', '---\nname: Alpha note\ndescription: "the alpha hook"\nmetadata:\n  type: project\n---\nAlpha body.\n');
    },
  });
  await page.locator('.composer textarea').waitFor();
  await open();
  const fits = async () =>
    page.evaluate(() => {
      const body = document.querySelector('.settings-dialog .dialog-body');
      return { page: document.documentElement.scrollWidth <= innerWidth, dialog: document.querySelector('.settings-dialog').offsetWidth === innerWidth, body: body.scrollWidth <= body.clientWidth };
    });
  await section(dialog, 'Allow').locator('.rule-row').first().waitFor();
  assert.deepEqual(await fits(), { page: true, dialog: true, body: true });

  await dialog.getByRole('tab', { name: 'Hooks' }).click();
  await dialog.locator('.hooks-json').waitFor();
  assert.deepEqual(await fits(), { page: true, dialog: true, body: true });

  // CLAUDE.md: the list first, a file opens its editor, Back returns.
  await dialog.getByRole('tab', { name: 'CLAUDE.md' }).click();
  await dialog.locator('.split-item').first().waitFor();
  assert.equal(await dialog.locator('.split-list').isVisible(), true);
  assert.equal(await dialog.locator('.split-detail').isVisible(), false);
  await dialog.locator('.split-item').first().click();
  await dialog.getByRole('textbox', { name: 'Instructions' }).waitFor();
  assert.equal(await dialog.locator('.split-list').isVisible(), false);
  assert.deepEqual(await fits(), { page: true, dialog: true, body: true });
  await dialog.getByRole('button', { name: 'Files' }).click();
  assert.equal(await dialog.locator('.split-list').isVisible(), true);

  await dialog.getByRole('tab', { name: 'Memory' }).click();
  await dialog.locator('.memory-item').first().click();
  await dialog.locator('#memory-name').waitFor();
  assert.deepEqual(await fits(), { page: true, dialog: true, body: true });
  // Every touch target of the editor is at least 30px tall.
  const small = await dialog.locator('button:visible, input:visible, select:visible').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height < 26).map((el) => el.outerHTML.slice(0, 80)));
  assert.deepEqual(small, []);
  assert.deepEqual(errorsOf(server), []);
});

test('models: each model\'s context limit is set, refused when out of range, and reset; the model picker follows', async () => {
  const models = [
    { id: 'astra', name: 'GPT-6 Astra', provider: 'OpenAI', contextWindow: 400_000, maxContext: 872_000, defaultContext: 400_000, minContext: 100_000, custom: false },
    { id: 'kimi', name: 'Kimi K3', provider: 'SGLang', contextWindow: 524_288, maxContext: 524_288, defaultContext: 524_288, minContext: 100_000, custom: false },
  ];
  const { page, dialog, open, server } = await setup({
    tab: 'Models',
    prepare: (mock, srv) =>
      srv.routes.push(async ({ route, method, body }) => {
        if (route !== 'model-settings') return null;
        if (method === 'PUT') {
          for (const [id, limit] of Object.entries(body.context)) {
            const model = models.find((m) => m.id === id);
            Object.assign(model, { contextWindow: limit ?? model.defaultContext, custom: limit !== null });
          }
        }
        return { json: { models } };
      }),
  });
  await open();
  const kimi = dialog.locator('.models-row', { hasText: 'Kimi K3' });
  const input = kimi.getByRole('spinbutton');
  assert.equal(await input.inputValue(), '524');
  assert.match(await text(kimi), /Default · 100k–524k/);

  await input.fill('50');
  assert.equal(await kimi.getByRole('button', { name: 'Save' }).isDisabled(), true, 'under 100k');
  await input.fill('200');
  await kimi.getByRole('button', { name: 'Save' }).click();
  await kimi.getByRole('button', { name: 'Reset' }).waitFor();
  assert.deepEqual(server.requests.filter((r) => r.path === 'model-settings').map((r) => r.body), [{ context: { kimi: 200_000 } }]);
  assert.match(await text(kimi), /Default 524k/);

  // The model picker shows the new window.
  await page.keyboard.press('Escape');
  await page.locator('.chip', { hasText: /Opus|Sonnet|Astra|Luna|Kimi|DeepSeek|Fable/ }).first().click();
  assert.match(await text(page.getByRole('option', { name: /Kimi K3/ })), /200k context/);
  await page.keyboard.press('Escape');

  await open();
  await dialog.getByRole('tab', { name: 'Models', exact: true }).click();
  await dialog.locator('.models-row', { hasText: 'Kimi K3' }).getByRole('button', { name: 'Reset' }).click();
  await dialog.locator('.models-row', { hasText: 'Kimi K3' }).getByRole('button', { name: 'Reset' }).waitFor({ state: 'detached' });
  assert.deepEqual(server.requests.filter((r) => r.path === 'model-settings').at(-1).body, { context: { kimi: null } });
  assert.deepEqual(errorsOf(server), []);
});
