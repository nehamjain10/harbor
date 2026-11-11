// Session import sources for the e2e stack, all inside the stack's temp directory (the
// real ~/.claude and ~/.codex are never read):
// - a throwaway Codex home with two rollouts: one in a project folder (a shell command,
//   two apply_patch calls, a final answer) and one whose folder is outside the home
//   directory (listed, not importable);
// - a Claude Code session made the way the Claude desktop app makes one: the real CLI,
//   run headless against the mock gateway with the desktop app's entrypoint.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_SESSION = {
  id: '019b0e2e-0000-7000-8000-000000000001',
  title: 'Add a greeting script',
  prompt: 'Add a greeting script and mention it in the notes',
  answer: 'I added greet.sh, which prints a greeting, and mentioned it in notes.md.',
};
export const CODEX_OUTSIDE = {
  id: '019b0e2e-0000-7000-8000-000000000002',
  title: 'Tidy up the temp folder',
  cwd: '/tmp',
};
export const CODEX_IDS = [CODEX_SESSION.id, CODEX_OUTSIDE.id];

const GREET_PATCH = ['*** Begin Patch', '*** Add File: greet.sh', '+#!/bin/sh', '+# Print a greeting', '+echo "hello from greet.sh"', '*** End Patch'].join('\n');
const NOTES_PATCH = ['*** Begin Patch', '*** Update File: notes.md', '@@', '-Nothing yet.', '+greet.sh prints a greeting.', '*** End Patch'].join('\n');

/** Rollout lines (`[payload type, payload]` pairs) as JSONL, one second apart from `start`. */
function rollout(start, items) {
  return items.map(([type, payload], index) => JSON.stringify({ timestamp: new Date(start + index * 1000).toISOString(), type, payload }) + '\n').join('');
}

const userMessage = (text) => ['response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
const patchOutput = (letter, file) => JSON.stringify({ output: `Success. Updated the following files:\n${letter} ${file}\n`, metadata: { exit_code: 0 } });

/**
 * Writes the Codex home: `sessions/YYYY/MM/DD/rollout-*.jsonl` plus `session_index.jsonl`
 * (the thread name of the first session). `cwd` is the project folder of the first one.
 */
export function writeCodexHome(codexHome, { cwd }) {
  const start = Date.parse('2026-10-04T09:00:00.000Z');
  const day = path.join(codexHome, 'sessions', '2026', '10', '04');
  fs.mkdirSync(day, { recursive: true });

  const main = rollout(start, [
    ['session_meta', { id: CODEX_SESSION.id, timestamp: new Date(start).toISOString(), cwd, originator: 'codex-tui', cli_version: '0.200.0', git: { branch: 'main' } }],
    ['turn_context', { cwd, model: 'gpt-6-luna' }],
    userMessage(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`),
    userMessage(CODEX_SESSION.prompt),
    ['response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at the project files first.' }], encrypted_content: 'gAAAA' }],
    ['response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls', workdir: cwd }), call_id: 'call_e2e_1' }],
    ['response_item', { type: 'function_call_output', call_id: 'call_e2e_1', output: 'Chunk ID: 7f3a\nWall time: 0.0123 seconds\nProcess exited with code 0\nOriginal token count: 6\nOutput:\nhello.txt\nnotes.md\nsrc\n' }],
    ['response_item', { type: 'custom_tool_call', name: 'apply_patch', input: GREET_PATCH, call_id: 'call_e2e_2' }],
    ['response_item', { type: 'custom_tool_call_output', call_id: 'call_e2e_2', output: patchOutput('A', 'greet.sh') }],
    ['response_item', { type: 'custom_tool_call', name: 'apply_patch', input: NOTES_PATCH, call_id: 'call_e2e_3' }],
    ['response_item', { type: 'custom_tool_call_output', call_id: 'call_e2e_3', output: patchOutput('M', 'notes.md') }],
    ['response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: CODEX_SESSION.answer }], phase: 'final_answer' }],
    ['event_msg', { type: 'token_count' }],
  ]);
  fs.writeFileSync(path.join(day, `rollout-2026-10-04T09-00-00-${CODEX_SESSION.id}.jsonl`), main);

  const outsideStart = start + 3_600_000;
  const outside = rollout(outsideStart, [
    ['session_meta', { id: CODEX_OUTSIDE.id, timestamp: new Date(outsideStart).toISOString(), cwd: CODEX_OUTSIDE.cwd, originator: 'Codex Desktop', cli_version: '0.200.0' }],
    userMessage(CODEX_OUTSIDE.title),
    ['response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Nothing to tidy.' }], phase: 'final_answer' }],
  ]);
  fs.writeFileSync(path.join(day, `rollout-2026-10-04T10-00-00-${CODEX_OUTSIDE.id}.jsonl`), outside);

  const index = { id: CODEX_SESSION.id, thread_name: CODEX_SESSION.title, updated_at: new Date(start).toISOString() };
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify(index) + '\n');
}

/** Runs the Claude Code CLI once, headless; resolves with its JSON result. */
function runCli(stack, cwd, args) {
  const home = os.homedir();
  const env = {
    HOME: home,
    USER: process.env.USER || os.userInfo().username,
    PATH: [path.join(home, '.local/bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: stack.claudeConfigDir,
    // How the Claude desktop app runs Claude Code: headless, with its own entrypoint.
    // Sessions with this entrypoint are interactive ones (not "sdk-*").
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    ANTHROPIC_BASE_URL: stack.mock.url,
    ANTHROPIC_API_KEY: stack.mock.key,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  const fullArgs = ['-p', ...args, '--model', 'codex/gpt-6-luna', '--permission-mode', 'default', '--output-format', 'json'];
  return new Promise((resolve, reject) => {
    // Asynchronous on purpose: the mock gateway answers from this process.
    const child = spawn(stack.claudeExecutable, fullArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout);
        if (code === 0 && !result.is_error) return resolve(result);
      } catch {
        // Reported below.
      }
      reject(new Error(`claude ${args[0]} exited (${code ?? signal}): ${stdout.slice(0, 500)} ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * A two-turn Claude Code session in the stack's Claude folder, made with the real CLI as
 * the Claude desktop app makes one: a turn that runs Bash, then "Remember the word
 * PINEAPPLE". Resolves with `{id, file, cwd, title}`; the transcript is never edited.
 * The title is the last prompt, as Claude Code's own session list shows an untitled
 * session.
 */
export async function makeClaudeDesktopSession(stack) {
  const cwd = stack.makeRepo('desktop');
  const first = await runCli(stack, cwd, ['Check the shell first. [[mock:bash]]']);
  const second = await runCli(stack, cwd, ['Remember the word PINEAPPLE', '--resume', first.session_id]);
  if (second.session_id !== first.session_id) throw new Error('The resumed CLI turn started another session');
  const projects = path.join(stack.claudeConfigDir, 'projects');
  const file = fs
    .readdirSync(projects)
    .map((dir) => path.join(projects, dir, `${first.session_id}.jsonl`))
    .find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`No transcript for ${first.session_id}`);
  return { id: first.session_id, file, cwd, title: 'Remember the word PINEAPPLE' };
}
