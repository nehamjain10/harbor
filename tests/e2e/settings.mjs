// The Claude Code settings dialog against the real server and a real Claude Code process:
// an allow rule added in the UI reaches the CLI after its restart, so the command that
// asked before runs without an approval card; a second edit keeps a backup; a memory
// created in the UI lands in the (throwaway) Claude config folder with its index line.
// Nothing here may touch the real ~/.claude: the stack points the server at a temp folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSlug } from '../../server/agent-transcript.mjs';
import { createSession, flow, lastAssistant, send, textOf, toolsOf, waitFor, waitForPending, waitForTurns } from './helpers.mjs';

export function settingsFlows(ctx) {
  flow(ctx, 'settings dialog: an allow rule added in the UI runs a command without asking after the CLI restarts; backups and memory land in the temp config folder', async ({ stack, openSession }) => {
    const repo = fs.realpathSync(stack.makeRepo('settings'));
    const session = await createSession(stack, { cwd: repo, mode: 'default', title: 'Allow rule' });
    const { page } = await openSession(session.id);
    const command = 'touch granted.txt';
    const card = page.locator('.approval-permission');
    const mine = () => stack.cliProcesses().filter((proc) => proc.cwd === repo).map((proc) => proc.pid);
    const userSettings = path.join(stack.claudeConfigDir, 'settings.json');
    const projectSettings = path.join(repo, '.claude', 'settings.json');
    const realSettings = path.join(os.homedir(), '.claude', 'settings.json');
    const realBefore = fs.existsSync(realSettings) ? fs.statSync(realSettings).mtimeMs : null;

    // Control: in Ask mode the command asks; deny it.
    await send(page, `Make a file. [[mock:bash:${command}]]`);
    await waitForPending(stack, session.id);
    await card.waitFor();
    await card.getByRole('button', { name: /Deny/ }).click();
    const reason = card.locator('.approval-input');
    await reason.waitFor();
    await reason.fill('Not yet');
    await reason.press('Enter');
    await waitForTurns(stack, session.id, 1);
    assert.equal(fs.existsSync(path.join(repo, 'granted.txt')), false);
    const before = mine();
    assert.equal(before.length, 1, 'a Claude Code process stays up after the turn');

    // Add the rule in the dialog: the user's settings.json, in the throwaway config folder.
    const dialog = page.locator('dialog.settings-dialog');
    const openDialog = async () => {
      await page.locator('.sidebar-foot').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: /Claude Code settings/ }).click();
      await dialog.waitFor();
    };
    await openDialog();
    assert.equal(await dialog.locator('#settings-project').inputValue(), repo, 'the open chat is the default project');
    await dialog.locator('.settings-chip', { hasText: 'Not created yet' }).waitFor();
    await allowRule(dialog, `Bash(${command})`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => /^Saved/.test(await textOf(page.locator('.toast'))), { message: 'the saved toast' });
    // The user's settings reach every session's process: this chat's and any other flow's idle ones.
    const toasted = /^Saved · applies to (\d+) sessions? after (?:its|their) next restart$/.exec(await textOf(page.locator('.toast')));
    assert.ok(toasted && Number(toasted[1]) >= 1, 'the toast counts the sessions to restart');
    assert.deepEqual(JSON.parse(fs.readFileSync(userSettings, 'utf8')), { permissions: { allow: [`Bash(${command})`] } });
    assert.deepEqual(fs.readdirSync(stack.claudeConfigDir).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left behind');
    assert.equal(fs.existsSync(projectSettings), false, 'only the user scope was written');

    // The idle process was closed to restart; the next turn starts a new one that reads the file.
    await dialog.getByRole('button', { name: 'Done' }).click();
    await dialog.waitFor({ state: 'detached' });
    await waitFor(() => mine().length === 0, { message: 'the stale Claude Code process to be closed' });
    await send(page, `Make the file now. [[mock:bash:${command}]]`);
    const current = await waitForTurns(stack, session.id, 2);
    assert.equal(await page.locator('.approval').count(), 0, 'no approval card');
    assert.equal(toolsOf(current, 'Bash').at(-1).state, 'done');
    assert.match(lastAssistant(current), /^Tool result: ok/);
    assert.equal(fs.existsSync(path.join(repo, 'granted.txt')), true, 'the command ran');
    const after = mine();
    assert.equal(after.length, 1);
    assert.notEqual(after[0], before[0], 'a new process, started after the change');

    // A project file: created by the first save, backed up (owner-only, under the data folder) by the second.
    await openDialog();
    await dialog.getByRole('radio', { name: 'Project' }).click();
    await dialog.locator('.settings-chip', { hasText: 'Not created yet' }).waitFor();
    await denyRule(dialog, 'Bash(rm -rf:*)');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(() => fs.existsSync(projectSettings), { message: 'the project settings file' });
    const backups = path.join(stack.dataDir, 'backups', 'settings');
    const backupsOf = () => (fs.existsSync(backups) ? fs.readdirSync(backups) : []).filter((file) => file.endsWith('-project-settings.json'));
    assert.deepEqual(backupsOf(), [], 'a new file has no earlier copy to keep');
    const previous = fs.readFileSync(projectSettings, 'utf8');
    await waitFor(async () => (await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()) && (await dialog.locator('.rule-row.is-new').count()) === 0, { message: 'the first save to settle' });
    await denyRule(dialog, 'Bash(curl:*)');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(() => fs.readFileSync(projectSettings, 'utf8') !== previous, { message: 'the second save' });
    assert.deepEqual(JSON.parse(fs.readFileSync(projectSettings, 'utf8')), { permissions: { deny: ['Bash(rm -rf:*)', 'Bash(curl:*)'] } });
    const [name] = backupsOf();
    assert.ok(name, 'a backup of the previous settings.json');
    assert.equal(fs.readFileSync(path.join(backups, name), 'utf8'), previous);
    assert.equal(fs.statSync(path.join(backups, name)).mode & 0o777, 0o600);

    // A memory made in the dialog is a file in the Claude config folder (the throwaway one) with an index line.
    await dialog.getByRole('tab', { name: 'Memory' }).click();
    await dialog.getByRole('button', { name: 'New', exact: true }).click();
    await dialog.locator('#new-memory-title').fill('Deploy window');
    await dialog.locator('#new-memory-description').fill('deploys happen on Tuesdays');
    await dialog.locator('#new-memory-body').fill('Deploys go out on Tuesdays.\n');
    await dialog.getByRole('button', { name: 'Create memory' }).click();
    await dialog.locator('#memory-name').waitFor();
    const memoryDir = path.join(stack.claudeConfigDir, 'projects', projectSlug(repo), 'memory');
    assert.match(fs.readFileSync(path.join(memoryDir, 'deploy-window.md'), 'utf8'), /^---\nname: Deploy window\ndescription: "deploys happen on Tuesdays"\nmetadata:\n {2}type: project\n---\nDeploys go out on Tuesdays\.\n$/);
    assert.match(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), /^# Memory Index\n\n- \[Deploy window\]\(deploy-window\.md\) — deploys happen on Tuesdays\n$/);

    // The real ~/.claude was never touched.
    assert.equal(fs.existsSync(path.join(os.homedir(), '.claude', 'projects', projectSlug(repo))), false);
    assert.equal(fs.existsSync(realSettings) ? fs.statSync(realSettings).mtimeMs : null, realBefore);
  });
}

/** Types a rule into a list of the Permissions tab. */
async function addRule(dialog, list, rule) {
  const section = dialog.locator('.perm-section', { has: dialog.page().getByRole('heading', { name: list }) });
  await section.getByRole('button', { name: 'Add rule' }).click();
  await section.getByRole('textbox', { name: 'Rule' }).fill(rule);
  await section.getByRole('textbox', { name: 'Rule' }).press('Enter');
}

const allowRule = (dialog, rule) => addRule(dialog, 'Allow', rule);
const denyRule = (dialog, rule) => addRule(dialog, 'Deny', rule);
