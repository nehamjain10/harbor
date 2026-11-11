// Re-records the SDK message fixtures used by tests/runner.test.mjs: real Claude Code
// turns against the mock gateway (through the normalizing proxy), saved as JSON.
// Usage: node tests/fixtures/record.mjs   (spawns ~/.local/bin/claude; takes a few seconds)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { startGatewayProxy } from '../../server/gateway-proxy.mjs';
import { findModel } from '../../server/models.mjs';
import { buildQueryOptions } from '../../server/runner.mjs';
import { startMockGateway } from '../mock-gateway.mjs';

const FIXTURES = path.dirname(new URL(import.meta.url).pathname);
const ONLY = process.argv[2];
const SCENARIOS = [
  { name: 'read-empty-pages', prompt: '[[mock:read-empty-pages]] read the file' },
  { name: 'todos', prompt: '[[mock:todos-as-string]] plan the work' },
  { name: 'thinking', prompt: '[[mock:thinking]] think first' },
  { name: 'agent', prompt: '[[mock:agent]] delegate this' },
  { name: 'agent-foreground', prompt: '[[mock:agent:foreground]] delegate this and wait' },
  { name: 'plan', prompt: '[[mock:plan:file]] make a plan', mode: 'plan' },
  { name: 'interrupt', prompt: '[[mock:slow]] stream slowly', interrupt: true },
  { name: 'api-error', prompt: '[[mock:api-error]] fail' },
];

process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
const mock = await startMockGateway();
const proxy = await startGatewayProxy({ upstream: mock.url, upstreamKey: mock.key, log: () => {} });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-fixture-work-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-fixture-config-'));
fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\nsecond line\n');

/** Replaces machine-specific paths so fixtures are stable and anonymous. */
function scrub(value) {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll(fs.realpathSync(work), '/work')
      .replaceAll(work, '/work')
      .replaceAll(configDir, '/claude-config')
      .replaceAll(os.homedir(), '/home/user')
      // Background task output files live under the CLI's per-user temp directory.
      .replace(/\/tmp\/claude-\d+\/[^/"\\]+/g, '/tmp/claude-tasks'),
  );
}

try {
  for (const scenario of SCENARIOS.filter((item) => !ONLY || item.name === ONLY)) {
    const abortController = new AbortController();
    const options = buildQueryOptions(
      { cwd: work, mode: scenario.mode ?? 'bypassPermissions' },
      {
        model: findModel('luna'),
        effort: 'medium',
        claudeExecutable: path.join(os.homedir(), '.local/bin/claude'),
        gateway: { url: proxy.url, apiKey: proxy.secret },
        settingSources: [],
        claudeConfigDir: configDir,
        abortController,
        canUseTool: async (tool, input) => ({ behavior: 'allow', updatedInput: input }),
      },
    );
    const messages = [];
    const stream = query({ prompt: scenario.prompt, options });
    let interrupted = false;
    let thrown = null;
    try {
      for await (const message of stream) {
        messages.push(message);
        const deltas = messages.filter((m) => m.event?.delta?.type === 'text_delta').length;
        if (scenario.interrupt && !interrupted && deltas >= 3) {
          interrupted = true;
          await stream.interrupt();
        }
      }
    } catch (error) {
      // The SDK throws after an interrupted turn's result; the runner must cope with that.
      thrown = error.message;
    }
    const file = path.join(FIXTURES, `sdk-${scenario.name}.json`);
    const fixture = { scenario: scenario.name, prompt: scenario.prompt, messages, ...(thrown ? { thrown } : {}) };
    fs.writeFileSync(file, JSON.stringify(scrub(fixture), null, 1) + '\n');
    console.log(`${scenario.name}: ${messages.length} messages -> ${path.relative(process.cwd(), file)}`);
  }
} finally {
  await proxy.close();
  await mock.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
}
