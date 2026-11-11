// Runs the built frontend in Chromium against a mocked v2 server: public/ is served
// from disk behind the production CSP, /api is answered from in-memory fixtures,
// EventSource is replaced by a scriptable fake (emit SSE events from the test), and
// window.Notification by a recorder. No server, socket or model call is involved.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { windowStart } from '../../server/tail.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ORIGIN = 'http://harbor.test';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CWD = '/home/you/zenit-research';
const WB = '/home/you/claude-workbench';

// `node --test` runs the browser test files in parallel processes, and each one
// builds in its `before` hook. Builds take turns (a lock directory) and, under the
// test runner, run once per run: the stamp records the runner's pid (every file's
// parent process). A file run on its own always builds.
export function buildApp() {
  const lock = path.join(root, 'public', '.build-lock');
  const stamp = path.join(root, 'public', '.build-stamp');
  fsSync.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fsSync.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A lock left behind by a crashed run.
      if (Date.now() - started > 60_000) fsSync.rmSync(lock, { recursive: true, force: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const runId = process.env.NODE_TEST_CONTEXT ? `runner ${process.ppid}` : '';
    const built = runId && fsSync.existsSync(stamp) && fsSync.readFileSync(stamp, 'utf8') === runId;
    if (!built) {
      execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'pipe' });
      fsSync.writeFileSync(stamp, runId);
    }
  } finally {
    fsSync.rmSync(lock, { recursive: true, force: true });
  }
}

export function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` });
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = [
  { id: 'default', label: 'Ask', description: 'Approve commands and edits before they run.' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edits apply automatically; commands still ask.' },
  { id: 'plan', label: 'Plan', description: 'Propose a plan before changing anything.' },
  { id: 'auto', label: 'Auto', description: 'Claude decides when to ask.' },
  { id: 'bypassPermissions', label: 'Bypass', description: 'Run commands and edit files without asking.' },
];

export function makeInfo() {
  const model = (id, name, provider, description, extra = {}) => ({
    id,
    name,
    provider,
    description,
    efforts: EFFORTS,
    defaultEffort: 'medium',
    contextWindow: provider === 'Claude' ? 200_000 : 400_000,
    vision: provider !== 'SGLang',
    modes: MODES.map((m) => m.id).filter((m) => m !== 'auto' || provider === 'Claude'),
    ...extra,
  });
  return {
    root: '/home/you',
    defaultProject: CWD,
    modes: MODES,
    models: [
      model('opus', 'Claude Opus 5.5', 'Claude', 'Most capable, for complex work'),
      model('sonnet', 'Claude Sonnet 5.5', 'Claude', 'Fast and capable for everyday coding'),
      model('fable', 'Claude Fable 5.2', 'Claude', 'Long-form reasoning and writing'),
      model('astra', 'GPT-6 Astra', 'OpenAI', 'Strong all-round reasoning'),
      model('luna', 'GPT-6 Luna', 'OpenAI', 'Quick, low-latency answers'),
      model('deepseek', 'DeepSeek V4.1 Flash', 'SGLang', 'Open model on the gateway', { efforts: [] }),
      model('kimi', 'Kimi K3', 'SGLang', 'Long context on the gateway', { efforts: [] }),
    ],
  };
}

// Fixture sessions (full, with messages). `now` anchors every timestamp.
export function makeSessions(now = Date.now()) {
  const base = (over) => ({
    efforts: {},
    mode: 'bypassPermissions',
    status: 'idle',
    pending: [],
    queue: [],
    pinned: false,
    archived: false,
    removed: false,
    context: { used: 42_000, window: 200_000 },
    ...over,
  });
  const chat = (user, reply, at) => [
    { id: 'u-' + at, role: 'user', text: user, at, delivery: 'done' },
    { id: 'a-' + at, role: 'assistant', text: reply, model: 'opus', effort: 'high', at: at + 20_000 },
    { id: 't-' + at, role: 'turn', duration: 24_000, outputTokens: 900, cost: 0.12, model: 'opus' },
  ];
  return [
    base({
      id: 's-run',
      title: 'Split server.mjs into readable modules',
      cwd: WB,
      model: 'opus',
      mode: 'acceptEdits',
      status: 'running',
      pinned: true,
      createdAt: now - 3 * HOUR,
      updatedAt: now - 2000,
      lastMessageAt: now - 4 * MINUTE,
      turnEndedAt: now - 2 * HOUR,
      lastViewedAt: now - 2 * HOUR,
      messages: [
        { id: 'u1', role: 'user', text: 'Split server.mjs into modules under server/.', at: now - 4 * MINUTE, delivery: 'running' },
        { id: 'a1', role: 'assistant', text: 'Reading the file first.', model: 'opus', effort: 'high', at: now - 3 * MINUTE },
      ],
    }),
    base({
      id: 's-wait',
      title: 'Pick a deploy window for v2',
      cwd: WB,
      model: 'luna',
      mode: 'default',
      status: 'waiting',
      createdAt: now - 2 * HOUR,
      updatedAt: now - 5000,
      lastMessageAt: now - 9 * MINUTE,
      pending: [{ id: 'p-initial', kind: 'question', tool: 'AskUserQuestion', at: now - 60_000, toolUseID: 'q0', input: { questions: [{ question: 'When?', options: [{ label: 'Tonight' }] }] } }],
      messages: chat('Plan the deploy of v2.', 'One question before I schedule it.', now - 9 * MINUTE),
    }),
    base({
      id: 's-unread',
      title: 'Fix the sidebar scroll jump on mobile Safari when the keyboard opens',
      cwd: WB,
      model: 'sonnet',
      createdAt: now - 5 * HOUR,
      updatedAt: now - 20 * MINUTE,
      lastMessageAt: now - 25 * MINUTE,
      turnEndedAt: now - 20 * MINUTE,
      lastViewedAt: now - 30 * MINUTE,
      messages: chat('Why does the list jump?', 'Found it: `visualViewport` resizes before layout settles.\nDetails follow.', now - 25 * MINUTE),
    }),
    base({
      id: 's-idle',
      title: 'Review GPU memory profile',
      cwd: CWD,
      model: 'opus',
      createdAt: now - 26 * HOUR,
      updatedAt: now - 25 * HOUR,
      lastMessageAt: now - 26 * HOUR,
      turnEndedAt: now - 25 * HOUR,
      lastViewedAt: now - 25 * HOUR,
      messages: chat('Profile memory of the trainer.', 'Peak is 71 GB during the backward pass.', now - 26 * HOUR),
    }),
    base({
      id: 's-old',
      title: 'Benchmark the tokenizer',
      cwd: CWD,
      model: 'luna',
      createdAt: now - 4 * 24 * HOUR,
      updatedAt: now - 4 * 24 * HOUR,
      lastMessageAt: now - 4 * 24 * HOUR,
      turnEndedAt: now - 4 * 24 * HOUR,
      lastViewedAt: now - 4 * 24 * HOUR,
      messages: chat('Benchmark the tokenizer.', 'It does 1.2M tokens/s.', now - 4 * 24 * HOUR),
    }),
    base({
      id: 's-arch',
      title: 'Old deploy notes',
      cwd: CWD,
      model: 'opus',
      archived: true,
      createdAt: now - 9 * 24 * HOUR,
      updatedAt: now - 9 * 24 * HOUR,
      lastMessageAt: now - 9 * 24 * HOUR,
      messages: chat('Notes', 'Done.', now - 9 * 24 * HOUR),
    }),
  ];
}

/* Session import (GET /api/import/:source, POST /api/import) */

const HOME = '/home/you';
const MB = 1024 * 1024;

// Imported sessions already in the store (`openApp({ imports: true })`): one from
// Claude Code with a cut history, one from Codex with an apply_patch edit.
export function makeImportedSessions(now = Date.now()) {
  const at = now - 3 * 24 * HOUR;
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/train/loop.py',
    '@@ def train_step(batch, model, optimizer):',
    '     loss = model(batch).loss',
    '-    loss.backward()',
    '-    optimizer.step()',
    '+    scaler.scale(loss).backward()',
    '+    scaler.step(optimizer)',
    '+    scaler.update()',
    '     optimizer.zero_grad(set_to_none=True)',
    '@@',
    '-LOG_EVERY = 10',
    '+LOG_EVERY = 50',
    '*** Add File: src/train/amp.py',
    '+import torch',
    '+',
    '+scaler = torch.cuda.amp.GradScaler()',
    '*** Delete File: src/train/legacy_fp16.py',
    '*** End Patch',
  ].join('\n');
  const common = { efforts: {}, mode: 'bypassPermissions', status: 'idle', pending: [], queue: [], pinned: false, archived: false, removed: false, context: null, createdAt: now - 40 * MINUTE, updatedAt: now - 40 * MINUTE, lastMessageAt: now - 40 * MINUTE };
  return [
    {
      ...common,
      id: 's-imp-claude',
      title: 'Fix the deploy timeout in the multi-node launcher',
      cwd: `${HOME}/api-server`,
      model: 'opus',
      source: { kind: 'claude', id: 'c0ffee01-claude', title: 'Fix the deploy timeout in the multi-node launcher', createdAt: at - 2 * HOUR, updatedAt: at, omitted: 1240 },
      messages: [
        { id: 'ic0', role: 'notice', imported: true, at: at - 2 * HOUR, text: '1,240 earlier messages are not shown. Claude still has the full conversation.' },
        { id: 'ic1', role: 'user', imported: true, at: at - 30 * MINUTE, text: 'The 4-node launch still hangs at the first all-reduce. Can you check the NCCL env?' },
        { id: 'ic2', role: 'tool', imported: true, tool: 'Bash', toolId: 'ict1', state: 'done', at: at - 29 * MINUTE, endedAt: at - 29 * MINUTE + 3000, input: { command: 'grep -n NCCL_ launch/multinode.sh' }, output: '14:export NCCL_SOCKET_IFNAME=eth0\n15:export NCCL_IB_DISABLE=1' },
        { id: 'ic3', role: 'assistant', imported: true, model: 'opus', at: at - 28 * MINUTE, text: 'The launcher pins `NCCL_SOCKET_IFNAME=eth0`, but the dedicated nodes expose `ens5`. NCCL waits on an interface that does not exist, so the first all-reduce never completes.\n\nDrop the pin (NCCL picks the right interface) or set it per partition.' },
      ],
    },
    {
      ...common,
      id: 's-imp-codex',
      title: 'Switch the trainer to mixed precision',
      cwd: `${HOME}/experiments/trainer`,
      model: 'sonnet',
      createdAt: now - 50 * MINUTE,
      updatedAt: now - 50 * MINUTE,
      lastMessageAt: now - 50 * MINUTE,
      source: { kind: 'codex', id: '019a-codex-amp', title: 'Switch the trainer to mixed precision', originator: 'Codex Desktop', createdAt: at - HOUR, updatedAt: at - 20 * MINUTE },
      messages: [
        { id: 'ix1', role: 'user', imported: true, at: at - HOUR, text: 'Switch the trainer to mixed precision and drop the old fp16 path.' },
        { id: 'ix2', role: 'thinking', imported: true, at: at - HOUR + 20_000, text: 'Use torch.cuda.amp with a GradScaler; the legacy fp16 module is unused.' },
        { id: 'ix3', role: 'tool', imported: true, tool: 'ApplyPatch', toolId: 'ixt1', state: 'done', at: at - HOUR + 30_000, endedAt: at - HOUR + 31_000, input: { patch }, output: 'Success. Updated the following files:\nM src/train/loop.py\nA src/train/amp.py\nD src/train/legacy_fp16.py' },
        { id: 'ix4', role: 'tool', imported: true, tool: 'Bash', toolId: 'ixt2', state: 'done', at: at - HOUR + 40_000, endedAt: at - HOUR + 52_000, input: { command: 'pytest -q tests/test_loop.py' }, output: '4 passed in 11.2s' },
        { id: 'ix5', role: 'assistant', imported: true, model: 'gpt-6-astra', at: at - HOUR + 60_000, text: 'The training step now runs under a `GradScaler`, the old fp16 module is gone, and the loop tests pass.' },
      ],
    },
  ];
}

// Picker candidates, newest first. With `imported`, two rows point at the sessions
// from makeImportedSessions().
export function makeImportCandidates(now = Date.now(), { imported = false } = {}) {
  const ago = (ms) => now - ms;
  const claude = [
    ['c0ffee01-claude', 'Fix the deploy timeout in the multi-node launcher', 'api-server', 3 * 24 * HOUR, 12.4 * MB, 'main'],
    ['c1', 'Port the image resizer into webapp', 'webapp', 2 * HOUR, 48 * MB, 'resizer-port'],
    ['c2', 'Why does the data loader use 59 GB per process?', 'experiments/trainer', 5 * HOUR, 3.1 * MB, 'main'],
    ['c3', 'Add thumbnail renders to the gallery stitcher', 'monorepo', 26 * HOUR, 7.8 * MB, 'feature/renders'],
    ['c4', 'Asset explorer: rate 1,000 assets with gpt-6-luna and plot the rubric histogram per category', 'asset-explorer', 30 * HOUR, 22 * MB, 'main'],
    ['c5', 'Debug the axis flip in the export step', 'monorepo', 2 * 24 * HOUR, 5.5 * MB, 'feature/renders'],
    ['c6', 'Write the sbatch script for the 4-node benchmark run', 'monorepo', 4 * 24 * HOUR, 640 * 1024, 'bench-run'],
    ['c7', 'Scratch build of the tokenizer bench', '/tmp/tokenizer-bench', 6 * 24 * HOUR, 210 * 1024, '', 'The folder is outside your home directory.'],
    ['c8', 'Disk cleanup: list the biggest directories under /srv', 'cluster-tools', 9 * 24 * HOUR, 1.9 * MB, ''],
    ['c9', 'Search ranking study: title boost + boxes', 'api-server', 12 * 24 * HOUR, 481 * MB, 'ranking'],
    ['c10', 'Sampling weights from review ratings', 'monorepo', 17 * 24 * HOUR, 9.6 * MB, 'quality'],
    ['c11', 'Set up Codex CLI next to Claude Code', '', 40 * 24 * HOUR, 120 * 1024, ''],
    ['c12', 'Feature flag status for v1 and v2', 'monorepo', 380 * 24 * HOUR, 2.2 * MB, 'main'],
  ];
  const codex = [
    ['019a-codex-amp', 'Switch the trainer to mixed precision', 'experiments/trainer', 3 * 24 * HOUR, 2.6 * MB, 'Codex Desktop'],
    ['x1', 'Summarize the RL framework options (verl-omni vs. own loop)', 'notes', 20 * MINUTE, 1.1 * MB, 'Codex Desktop'],
    ['x2', 'Relabel the 10-02 uploads with the new tags', 'data-pipeline', 3 * HOUR, 18 * MB, 'codex_exec'],
    ['x3', 'Profile the contact sheet renderer', 'asset-explorer/batch_run', 6 * HOUR, 4.4 * MB, 'codex-tui'],
    ['x4', 'Make the dashboard bind to the private address only', 'api-server', 9 * HOUR, 760 * 1024, 'Codex Desktop'],
    ['x5', 'Fix the multi-node startup race', 'api-server', 20 * HOUR, 3.3 * MB, 'Codex Desktop'],
    ['x6', 'Draft the release summary for Slack', 'monorepo', 25 * HOUR, 540 * 1024, 'Codex Desktop'],
    ['x7', 'Explain the tag cache layout', 'monorepo', 28 * HOUR, 980 * 1024, 'Codex Desktop'],
    ['x8', 'Old checkout: renderer experiments', 'old-renderer', 31 * HOUR, 6.2 * MB, 'Codex Desktop', 'The folder no longer exists.'],
    ['x9', 'Write unit tests for the tag sampler', 'monorepo', 2 * 24 * HOUR, 2.0 * MB, 'codex-tui'],
    ['x10', 'Batch-rate the queued rows', 'asset-explorer/batch_run', 2 * 24 * HOUR + HOUR, 11 * MB, 'codex_exec'],
    ['x11', 'Clean up stale tmux monitor sessions', '', 2 * 24 * HOUR + 5 * HOUR, 300 * 1024, 'Codex Desktop'],
    ['x12', 'Arena dispatcher: warm pool design', 'experiments/arena', 3 * 24 * HOUR + HOUR, 5.7 * MB, 'Codex Desktop'],
    ['x13', 'Investigate the cancelled jobs on node-2', 'monorepo', 3 * 24 * HOUR + 4 * HOUR, 1.4 * MB, 'Codex Desktop'],
    ['x14', 'Diff the config between runs 293737 and 295074', 'monorepo', 4 * 24 * HOUR, 870 * 1024, 'Codex Desktop'],
    ['x15', 'Port the channel test to the new encoder', 'webapp', 4 * 24 * HOUR + 2 * HOUR, 3.9 * MB, 'codex-tui'],
    ['x16', 'Add an OCR fallback for Chinese prompts', 'api-server', 5 * 24 * HOUR, 7.1 * MB, 'Codex Desktop'],
    ['x17', 'Prompt snapshot r6 dedupe', 'data-pipeline', 5 * 24 * HOUR + 3 * HOUR, 2.8 * MB, 'codex_exec'],
    ['x18', 'Review the r025 quality build', 'monorepo', 6 * 24 * HOUR, 1.6 * MB, 'Codex Desktop'],
    ['x19', 'Export the checkpoint for the parity check', 'api-server', 7 * 24 * HOUR, 4.0 * MB, 'Codex Desktop'],
    ['x20', 'Why is the eval baseline reading one readout?', 'webapp', 8 * 24 * HOUR, 2.3 * MB, 'Codex Desktop'],
    ['x21', 'Rewrite the gallery camera picker', 'monorepo', 9 * 24 * HOUR, 6.6 * MB, 'Codex Desktop'],
    ['x22', 'Throughput numbers for the API base', 'api-server', 10 * 24 * HOUR, 1.2 * MB, 'codex-tui'],
    ['x23', 'Codex Cloud task: bump lucide-preact', 'claude-workbench', 11 * 24 * HOUR, 450 * 1024, 'codex_cloud'],
    ['x24', 'Notes on the job queue preemption behaviour', 'notes', 13 * 24 * HOUR, 380 * 1024, 'Codex Desktop'],
    ['x25', 'Check the data root for the finetune', 'monorepo', 15 * 24 * HOUR, 2.9 * MB, 'Codex Desktop'],
    ['x26', 'Upload search with muse --corpus user', 'muse', 18 * 24 * HOUR, 1.0 * MB, 'Codex Desktop'],
    ['x27', 'Auto-eval CPU render batch: renderer pinning', 'autoeval', 21 * 24 * HOUR, 5.0 * MB, 'Codex Desktop'],
    ['x28', 'Migrate the cache fingerprint', 'autoeval', 25 * 24 * HOUR, 2.4 * MB, 'codex-tui'],
    ['x29', 'Plot loss vs samples for the 8B finetune', 'monorepo', 33 * 24 * HOUR, 8.8 * MB, 'Codex Desktop'],
    ['x30', 'Tidy the agent-sync hooks', 'agent-sync', 41 * 24 * HOUR, 640 * 1024, 'Codex Desktop'],
  ];
  const folder = (dir) => (dir.startsWith('/') ? dir : dir ? `${HOME}/${dir}` : HOME);
  const toClaude = ([id, title, dir, age, size, gitBranch, reason]) => ({
    id,
    title,
    cwd: folder(dir),
    createdAt: ago(age + 2 * HOUR),
    updatedAt: ago(age),
    size: Math.round(size),
    messages: Math.max(4, Math.round(size / 9000)),
    gitBranch: gitBranch || undefined,
    importable: !reason,
    reason,
  });
  const toCodex = ([id, title, dir, age, size, originator, reason]) => ({
    id,
    title,
    cwd: folder(dir),
    createdAt: ago(age + HOUR),
    updatedAt: ago(age),
    size: Math.round(size),
    originator,
    importable: !reason,
    reason,
  });
  const lists = { claude: claude.map(toClaude), codex: codex.map(toCodex) };
  if (imported) {
    lists.claude[0].importedAs = 's-imp-claude';
    lists.codex[0].importedAs = 's-imp-codex';
  }
  // Newest first, as the server sends them.
  for (const items of Object.values(lists)) items.sort((a, b) => b.updatedAt - a.updatedAt);
  return lists;
}

// The session POST /api/import creates for a candidate.
function importedSession(source, candidate, body, now) {
  const at = candidate.updatedAt;
  const messages =
    source === 'codex'
      ? [
          { id: `${candidate.id}-u`, role: 'user', imported: true, at: at - 60_000, text: candidate.title },
          { id: `${candidate.id}-a`, role: 'assistant', imported: true, model: 'gpt-6-astra', at, text: 'Done. Summary of the changes follows.' },
        ]
      : [
          { id: `${candidate.id}-u`, role: 'user', imported: true, at: at - 60_000, text: candidate.title },
          { id: `${candidate.id}-a`, role: 'assistant', imported: true, model: 'opus', at, text: 'Here is what I found.' },
        ];
  return {
    id: 'imp-' + candidate.id,
    title: candidate.title,
    cwd: candidate.cwd,
    model: body.model || 'opus',
    mode: body.mode || 'bypassPermissions',
    efforts: {},
    status: 'idle',
    pending: [],
    queue: [],
    pinned: false,
    archived: false,
    removed: false,
    context: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    source: { kind: source, id: candidate.id, title: candidate.title, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt, originator: candidate.originator },
    messages,
  };
}

const brief = ({ messages, live, liveThinking, ...rest }) => rest;

// MCP servers as GET /api/sessions/:id/mcp lists them (server/mcp-status.mjs): a connected
// project server, a broken one, Slack's plugin (needs the paste sign-in), claude.ai
// connectors (one connected, the rest not set up) and Harbor's own server.
export function makeMcpServers() {
  const row = (name, group, status, extra = {}) => ({
    name,
    status,
    scope: group === 'claudeai' ? 'claudeai' : group === 'plugin' ? 'dynamic' : group,
    source: group,
    group,
    type: 'http',
    tools: [],
    toolCount: 0,
    builtin: false,
    disabledInSession: false,
    auth: null,
    ...extra,
  });
  const tool = (name, description, extra = {}) => ({ name, description, ...extra });
  const connector = (title, status = 'needs-auth', extra = {}) => row(`claude.ai ${title}`, 'claudeai', status, { type: 'claudeai-proxy', auth: 'claudeai', ...extra });
  return [
    row('echo', 'project', 'connected', { type: 'stdio', tools: [tool('echo', 'Echoes the text back.', { readOnly: true })], toolCount: 1 }),
    row('wiki', 'user', 'failed', { url: 'https://wiki.example.com/mcp', error: 'connect ECONNREFUSED https://wiki.example.com/mcp', auth: 'oauth' }),
    row('plugin:slack:slack', 'plugin', 'needs-auth', { url: 'https://mcp.slack.example.com/mcp', auth: 'oauth' }),
    connector('Gmail', 'connected', {
      tools: [tool('search_threads', 'Search mail.', { readOnly: true }), tool('create_draft', 'Create a draft.'), tool('send_message', 'Send a message.', { destructive: true })],
      toolCount: 3,
    }),
    connector('Slack'),
    connector('Linear'),
    connector('Notion'),
    connector('Asana'),
    connector('Canva'),
    connector('Figma'),
    connector('Atlassian'),
    row('meshy', 'builtin', 'connected', {
      type: 'sdk',
      scope: 'sdk',
      source: 'sdk',
      builtin: true,
      tools: [tool('delegate', 'Start a worker on another model and carry on.'), tool('wait_agents', 'Collect the reports of the workers started with delegate.', { readOnly: true })],
      toolCount: 2,
    }),
  ];
}

// The MCP routes of the mocked server. `server.mcp` holds the rows (`servers`), what the
// listing says (`route`, `live`, `warm`: a recent listing answers `cached`), delays and
// failures, the sign-ins waiting (`signIn`), how long a sign-in link lives (`expiresIn`, in
// seconds), the servers Claude Code left out (`hidden`) and how a reconnect ends (`reconnect[name]`).
function answerMcp(server, session, { method, search, name, action, body }) {
  const mcp = server.mcp;
  const off = new Set(session?.mcpDisabled || []);
  const rows = () => mcp.servers.map((row) => ({ ...row, disabledInSession: !row.builtin && off.has(row.name) }));
  if (!name) {
    mcp.loads.push(search);
    if (mcp.error) return { status: mcp.error.status || 502, json: { error: mcp.error.error } };
    const cached = search.includes('cached=1');
    return { json: { live: mcp.live, route: mcp.route, at: Date.now(), servers: cached && !mcp.live && !mcp.warm ? null : rows(), hidden: mcp.hidden, ...(mcp.listError ? { error: mcp.listError } : {}) } };
  }
  const row = mcp.servers.find((entry) => entry.name === name);
  if (!row) return { status: 404, json: { error: 'This session has no MCP server with that name.' } };
  const current = () => rows().find((entry) => entry.name === name);
  if (row.builtin) return { status: 400, json: { error: `${name} is Harbor’s own server. It is built in and cannot be changed.` } };
  if (action === 'toggle') {
    if (typeof body?.enabled !== 'boolean') return { status: 400, json: { error: 'Enabled must be true or false.' } };
    if (mcp.toggleError) return { status: 502, json: { error: mcp.toggleError } };
    if (body.enabled) off.delete(name);
    else off.add(name);
    session.mcpDisabled = [...off];
    // Off in Claude Code's own settings for the project: only its own switch brings it back.
    const projectEnabled = body.enabled && row.status === 'disabled';
    if (projectEnabled) row.status = 'connected';
    return { json: { ok: true, enabled: body.enabled, mcpDisabled: [...off], live: mcp.live, projectEnabled, rev: (session.rev || 0) + 1 } };
  }
  if (action === 'reconnect') {
    const outcome = mcp.reconnect[name] || 'connected';
    row.status = outcome;
    if (outcome === 'failed') row.error = 'connect ECONNREFUSED';
    return { json: { ok: outcome === 'connected', live: mcp.live, server: current(), ...(outcome === 'connected' ? {} : { error: outcome === 'needs-auth' ? 'This server still needs you to sign in.' : 'connect ECONNREFUSED' }) } };
  }
  if (action === 'auth') {
    if (mcp.authError) return { status: 502, json: { error: mcp.authError } };
    if (row.auth === 'claudeai') {
      return {
        json: {
          kind: 'claudeai',
          authUrl: `https://claude.ai/api/organizations/org-1/mcp/start-auth/mcpsrv_${name.split(' ')[1]}?product_surface=sdk-ts`,
          settingsUrl: 'https://claude.ai/settings/connectors',
          instructions: ['Open the claude.ai link and connect this service there.', 'Approve access in the service’s own window.', 'Come back here and press Reconnect.'],
        },
      };
    }
    if (row.auth !== 'oauth') return { status: 400, json: { error: 'This server does not use a sign-in (it is a local command or Harbor’s own).' } };
    mcp.signIn[name] = { state: 'state-1' };
    return {
      json: {
        kind: 'oauth',
        authUrl: 'https://auth.example.com/oauth/authorize?response_type=code&client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&state=state-1',
        callbackPort: 3118,
        expiresInSeconds: mcp.expiresIn,
        instructions: [
          'Open the link and approve access.',
          'Your browser then goes to http://localhost:3118/callback?code=…, a port on the machine that runs Harbor. If that page fails to load, it is expected.',
          'Copy the whole address from the address bar and paste it below. If the page says you are signed in, nothing more is needed.',
        ],
      },
    };
  }
  if (action === 'auth/callback') {
    if (!mcp.signIn[name]) return { status: 409, json: { error: 'No sign-in is waiting for this server. It may have expired, or Claude Code restarted in the meantime. Start the sign-in again.' } };
    const url = String(body?.url || '');
    if (!/[?&]code=/.test(url)) return { status: 400, json: { error: 'The address has no code. Copy the whole address after approving, including everything after the “?”.' } };
    if (/state=wrong/.test(url)) return { status: 400, json: { error: 'That address belongs to an earlier sign-in attempt. Start the sign-in again and use the newest link.' } };
    delete mcp.signIn[name];
    row.status = mcp.afterSignIn || 'connected';
    return { json: { ok: row.status === 'connected', server: current(), ...(row.status === 'connected' ? {} : { error: 'The sign-in finished, but the server did not connect. Try Reconnect.' }) } };
  }
  if (action === 'auth/clear') {
    row.status = 'needs-auth';
    delete row.error;
    return { json: { ok: true, server: current() } };
  }
  return { status: 404, json: { error: 'Not mocked: mcp ' + action } };
}


// Browser-side fakes, installed before any page script runs.
function installFakes({ permission }) {
  window.__visibility = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => window.__visibility });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__visibility === 'hidden' });

  window.__notifications = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission() {
      FakeNotification.permission = 'granted';
      return Promise.resolve('granted');
    }
    constructor(title, options = {}) {
      this.title = title;
      this.options = options;
      this.closed = false;
      window.__notifications.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  window.Notification = FakeNotification;

  window.__streams = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      this.onerror = null;
      window.__streams.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.dispatch('ready', { at: Date.now() });
      }, 0);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    removeEventListener(type, listener) {
      this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== listener);
    }
    dispatch(type, data) {
      for (const listener of this.listeners[type] || []) listener({ type, data: JSON.stringify(data) });
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = FakeEventSource;
  window.__emit = (type, data) => {
    for (const stream of window.__streams) if (stream.readyState === 1) stream.dispatch(type, data);
  };
}

// Opens the app. Returns { page, context, server } where `server.requests` records
// every non-GET API call ({ method, path, body }) and `server.sessions` is the
// mutable fixture state.
//
// Import mocks: `server.candidates` ({ claude, codex } lists), `server.importLoads`
// (sources of every list request, in order), `server.importDelay`
// (ms before each import response; GET lists wait `importListDelay`),
// `server.importListError` ({ claude?: message }) and `server.importErrors`
// ({ [candidate id]: message }) can be changed from the test.
export async function openApp(browser, { viewport = { width: 1440, height: 900 }, colorScheme = 'dark', permission = 'default', theme, hasTouch = false, isMobile = false, url = '/', now = Date.now(), storage = {}, sessionsDelay = 0, waitForSessions = true, imports = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch, isMobile, deviceScaleFactor: isMobile ? 2 : 1 });
  const info = makeInfo();
  const sessions = [...makeSessions(now), ...(imports ? makeImportedSessions(now) : [])];
  const server = {
    info,
    sessions,
    requests: [],
    errors: [],
    candidates: makeImportCandidates(now, { imported: imports }),
    importLoads: [],
    importDelay: 0,
    importListDelay: 0,
    importListError: {},
    importErrors: {},
    // Milliseconds GET /api/sessions/:id waits before answering.
    sessionDelay: 0,
    // GET /api/sessions/:id requests, by session id, and those answered "unchanged" (the
    // client held the session's revision: `?rev=`, for a session given a `rev`).
    sessionFetches: {},
    unchangedFetches: {},
    // `?tail=N` asked of GET /api/sessions/:id (null: the whole session), in order; and
    // GET /api/sessions/:id/messages (older pages): { id, before, limit, beforeId }, and
    // milliseconds those wait before answering. Both cut as the server does (tail.mjs).
    tails: [],
    olderLoads: [],
    olderDelay: 0,
    // Milliseconds PATCH /api/sessions/:id and POST .../stop wait before answering, and
    // an error ({ status, error }) PATCH answers with instead of applying the patch.
    patchDelay: 0,
    patchError: null,
    stopDelay: 0,
    // POST /api/sessions/:id/agents/:toolId/message (a message to a running model agent):
    // milliseconds it waits before answering, and an error ({ status, error }) it answers
    // with instead of recording the message. A recorded message is added to the session
    // like the server does (`from: 'user'`, delivery `sent`) but not pushed over the
    // stream: the test emits that delta when it wants the copy to arrive.
    agentMessageDelay: 0,
    agentMessageError: null,
    agentMessages: [],
    // GET /api/agents: Claude Code's subagents (the model agents come from the catalog).
    agents: [
      { name: 'Explore', description: 'Fast read-only search agent for locating code.', model: 'inherit' },
      { name: 'general-purpose', description: 'General-purpose agent for multi-step tasks.', model: 'inherit' },
      { name: 'statusline-setup', description: "Configures the user's status line.", model: 'sonnet' },
    ],
    agentLoads: [],
    // Routes a test adds: each is called with { route, method, url, body } and answers
    // { status?, json } (or nothing, to pass); asked before the "Not mocked" 404.
    routes: [],
    // MCP servers (see answerMcp): the rows, the listing's route, whether Claude Code is
    // live, a recent listing (`warm`), and the sign-ins waiting.
    mcp: { servers: makeMcpServers(), route: 'claude', live: false, warm: false, delay: 0, error: null, listError: null, toggleError: null, authError: null, afterSignIn: null, reconnect: {}, signIn: {}, expiresIn: 300, hidden: [], loads: [] },
    // GET /api/sessions/:id/agents/:toolId/transcript answers, by `<session id> <tool id>`
    // (a body, or { status, error }; none: 404), and the requests made.
    agentTranscripts: {},
    transcriptLoads: [],
  };

  await context.addInitScript(installFakes, { permission });
  // Background loads after boot (warmUp in src/actions.js) are off unless a test turns them on:
  // the mocked server counts every fetch.
  const initialStorage = { 'mesh-code-warm-up': '0', ...storage, ...(theme ? { 'mesh-code-theme': theme } : {}) };
  await context.addInitScript((entries) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, initialStorage);

  const find = (id) => sessions.find((s) => s.id === id);
  await context.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (!url.pathname.startsWith('/api/')) {
      const file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
      try {
        const body = await fs.readFile(file);
        const headers = { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' };
        return route.fulfill({ status: 200, body, headers, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
      } catch {
        return route.fulfill({ status: 404, body: 'not found' });
      }
    }
    const route_ = url.pathname.slice('/api/'.length);
    let body = null;
    if (method !== 'GET') {
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      server.requests.push({ method, path: route_, body });
    }
    if (route_ === 'info') return route.fulfill({ json: info });
    if (route_ === 'sessions' && method === 'GET') {
      if (sessionsDelay) await new Promise((resolve) => setTimeout(resolve, sessionsDelay));
      return route.fulfill({ json: sessions.map(brief) });
    }
    if (route_ === 'sessions/prepare' && method === 'POST') return route.fulfill({ json: { prepareId: null } });
    let match = route_.match(/^sessions\/([^/]+)$/);
    if (match) {
      const session = find(decodeURIComponent(match[1]));
      if (!session) return route.fulfill({ status: 404, json: { error: 'Not found' } });
      if (method === 'PATCH') {
        if (server.patchDelay) await new Promise((resolve) => setTimeout(resolve, server.patchDelay));
        if (server.patchError) return route.fulfill({ status: server.patchError.status || 500, json: { error: server.patchError.error || 'Failed' } });
        for (const key of ['title', 'model', 'mode', 'pinned', 'archived', 'removed']) if (body[key] !== undefined) session[key] = body[key];
        for (const key of ['allowRules', 'allowDirectories']) if (Array.isArray(body[key])) session[key] = body[key];
        if (body.effort !== undefined) session.efforts = { ...session.efforts, [session.model]: body.effort };
        if (body.viewed) session.lastViewedAt = Date.now();
        session.updatedAt = Date.now();
        // Like the server: a patch answers with the list form.
        return route.fulfill({ json: brief(session) });
      }
      server.sessionFetches[session.id] = (server.sessionFetches[session.id] || 0) + 1;
      const tail = url.searchParams.has('tail') ? Number(url.searchParams.get('tail')) : null;
      server.tails.push(tail);
      if (server.sessionDelay) await new Promise((resolve) => setTimeout(resolve, server.sessionDelay));
      if (session.rev != null && url.searchParams.get('rev') === String(session.rev)) {
        server.unchangedFetches[session.id] = (server.unchangedFetches[session.id] || 0) + 1;
        return route.fulfill({ json: { id: session.id, rev: session.rev, unchanged: true } });
      }
      if (tail == null) return route.fulfill({ json: session });
      const from = windowStart(session.messages, { limit: tail, currentMessageId: session.currentMessageId });
      return route.fulfill({ json: { ...session, messages: session.messages.slice(from), messagesFrom: from, messageCount: session.messages.length } });
    }
    if ((match = route_.match(/^sessions\/([^/]+)\/messages$/)) && method === 'GET') {
      const session = find(decodeURIComponent(match[1]));
      if (!session) return route.fulfill({ status: 404, json: { error: 'Not found' } });
      const beforeId = url.searchParams.get('beforeId') || '';
      let before = Number(url.searchParams.get('before') ?? session.messages.length);
      const limit = Number(url.searchParams.get('limit') || 300);
      server.olderLoads.push({ id: session.id, before, limit, beforeId });
      if (server.olderDelay) await new Promise((resolve) => setTimeout(resolve, server.olderDelay));
      if (beforeId && session.messages[before]?.id !== beforeId) before = session.messages.findIndex((m) => m.id === beforeId);
      if (before < 0) return route.fulfill({ status: 409, json: { error: 'This conversation changed. Open it again to see it.' } });
      const from = windowStart(session.messages, { end: before, limit, currentMessageId: session.currentMessageId });
      return route.fulfill({ json: { messages: session.messages.slice(from, before), from, before, messageCount: session.messages.length, rev: session.rev ?? null } });
    }
    if ((match = route_.match(/^sessions\/([^/]+)\/mcp(?:\/([^/]+)\/(toggle|reconnect|auth\/callback|auth\/clear|auth))?$/)) || route_ === 'mcp') {
      if (server.mcp.delay) await new Promise((resolve) => setTimeout(resolve, server.mcp.delay));
      const session = match && find(decodeURIComponent(match[1]));
      if (match && !session) return route.fulfill({ status: 404, json: { error: 'Session not found' } });
      const answer = answerMcp(server, session, { method, search: url.search, name: match?.[2] && decodeURIComponent(match[2]), action: match?.[3], body });
      return route.fulfill({ status: answer.status || 200, json: answer.json });
    }
    if ((match = route_.match(/^sessions\/([^/]+)\/agents\/([^/]+)\/transcript$/)) && method === 'GET') {
      const key = `${decodeURIComponent(match[1])} ${decodeURIComponent(match[2])}`;
      server.transcriptLoads.push(key);
      const answer = server.agentTranscripts[key];
      if (!answer) return route.fulfill({ status: 404, json: { error: 'Claude Code has no transcript of this agent.' } });
      if (answer.status) return route.fulfill({ status: answer.status, json: { error: answer.error } });
      return route.fulfill({ json: answer });
    }
    if ((match = route_.match(/^sessions\/([^/]+)\/agents\/([^/]+)\/message$/)) && method === 'POST') {
      if (server.agentMessageDelay) await new Promise((resolve) => setTimeout(resolve, server.agentMessageDelay));
      if (server.agentMessageError) return route.fulfill({ status: server.agentMessageError.status || 500, json: { error: server.agentMessageError.error || 'Failed' } });
      const session = find(decodeURIComponent(match[1]));
      const toolId = decodeURIComponent(match[2]);
      const card = session?.messages.find((m) => m.role === 'tool' && m.toolId === toolId);
      if (!session || !card) return route.fulfill({ status: 404, json: { error: 'Not found' } });
      if (card.tool !== 'mcp__meshy__delegate') return route.fulfill({ status: 409, json: { error: 'Only model agents take messages.' } });
      if (card.state !== 'running') return route.fulfill({ status: 409, json: { error: 'That agent is not running.' } });
      const text = String(body?.text ?? '').trim();
      if (!text) return route.fulfill({ status: 400, json: { error: 'The message is empty.' } });
      if (text.length > 20_000) return route.fulfill({ status: 400, json: { error: 'The message is too long.' } });
      const message = { id: 'srv-' + (server.agentMessages.length + 1), role: 'user', text, parentToolId: toolId, from: 'user', delivery: 'sent', clientId: body.clientId, at: Date.now() };
      session.messages.push(message);
      server.agentMessages.push(message);
      return route.fulfill({ json: { ok: true, messageId: message.id } });
    }
    // Starting Claude Code while the first words are typed (actions.warmForTyping).
    if (/^sessions\/[^/]+\/warm$/.test(route_) && method === 'POST') return route.fulfill({ json: { started: true } });
    if ((match = route_.match(/^sessions\/([^/]+)\/stop$/))) {
      if (server.stopDelay) await new Promise((resolve) => setTimeout(resolve, server.stopDelay));
      return route.fulfill({ json: { ok: true } });
    }
    if (/^sessions\/[^/]+\/changes/.test(route_)) return route.fulfill({ json: { diff: '', status: '', branch: 'main', files: [] } });
    if (/^sessions\/[^/]+\/files/.test(route_)) return route.fulfill({ json: { path: '', directory: true, items: [] } });
    if (route_.startsWith('projects')) return route.fulfill({ json: { path: CWD, parent: '/home/you', items: [] } });
    if (route_ === 'agents' && method === 'GET') {
      server.agentLoads.push(url.searchParams.get('cwd'));
      const models = info.models.map((m) => ({ id: m.id, name: `${m.name} agent`, model: m.name, provider: m.provider, hint: m.description, direct: m.provider === 'Claude', vision: m.vision }));
      return route.fulfill({ json: { agents: server.agents, models } });
    }
    if ((match = route_.match(/^import\/(claude|codex)$/)) && method === 'GET') {
      server.importLoads.push(match[1]);
      if (server.importListDelay) await new Promise((resolve) => setTimeout(resolve, server.importListDelay));
      const error = server.importListError[match[1]];
      if (error) return route.fulfill({ status: 500, json: { error } });
      const items = server.candidates[match[1]];
      return route.fulfill({ json: { items, total: items.length } });
    }
    if (route_ === 'import' && method === 'POST') {
      if (server.importDelay) await new Promise((resolve) => setTimeout(resolve, server.importDelay));
      const list = server.candidates[body?.source];
      if (!list || !Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 20) return route.fulfill({ status: 400, json: { error: 'Invalid import request.' } });
      const result = { sessions: [], errors: [] };
      for (const id of body.ids) {
        const candidate = list.find((c) => c.id === id);
        if (server.importErrors[id] || !candidate || candidate.importable === false) {
          result.errors.push({ id, error: server.importErrors[id] || 'Not importable.' });
          continue;
        }
        let session = candidate.importedAs && find(candidate.importedAs);
        if (!session) {
          session = importedSession(body.source, candidate, body, Date.now());
          sessions.push(session);
          candidate.importedAs = session.id;
        }
        result.sessions.push(brief(session));
      }
      return route.fulfill({ json: result });
    }
    for (const handler of server.routes) {
      const answer = await handler({ route: route_, method, url, body });
      if (answer) return route.fulfill({ status: answer.status || 200, json: answer.json });
    }
    return route.fulfill({ status: 404, json: { error: 'Not mocked: ' + route_ } });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => server.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') server.errors.push(message.text());
  });
  await page.goto(ORIGIN + url);
  if (waitForSessions) await page.waitForSelector('.session-row');
  return { page, context, server };
}

// Pushes a full session over the fake SSE stream, as the server's `session` event.
export async function emitSession(page, session) {
  await page.evaluate((data) => window.__emit('session', data), session);
}

// Pushes a `delta` event (server/events.mjs).
export async function emitDelta(page, delta) {
  await page.evaluate((data) => window.__emit('delta', data), delta);
}

export async function setVisibility(page, state) {
  await page.evaluate((value) => {
    window.__visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

export const notifications = (page) =>
  page.evaluate(() => window.__notifications.map((n) => ({ title: n.title, body: n.options.body, tag: n.options.tag })));
