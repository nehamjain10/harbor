// End-to-end flows: the real server (`node server.mjs` on a private socket), real Claude
// Code turns against the mock gateway, and Chromium through an authenticating proxy (see
// stack.mjs). Run with `npm run test:e2e`. Set E2E_TMPDIR to choose where the temp
// directory goes and E2E_ARTIFACTS to keep screenshots and the server log of failures.
import fs from 'node:fs';
import { after, before, describe } from 'node:test';
import { agentFlows } from './agents.mjs';
import { approvalFlows } from './approvals.mjs';
import { backgroundFlows } from './background.mjs';
import { chatFlows } from './chat.mjs';
import { composerFlows } from './composer.mjs';
import { forkFlows } from './fork.mjs';
import { importFlows } from './import.mjs';
import { mcpFlows } from './mcp.mjs';
import { modelAgentFlows } from './model-agents.mjs';
import { settingsFlows } from './settings.mjs';
import { shellFlows } from './shell.mjs';
import { tailFlows } from './tail.mjs';
import { CHROMIUM, CLAUDE, startStack } from './stack.mjs';

const skip = (!fs.existsSync(CLAUDE) && `Claude Code CLI not found at ${CLAUDE}`) || (!fs.existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}`);

describe('Harbor end to end (server, Claude Code CLI, mock gateway, Chromium)', { skip }, () => {
  const ctx = { stack: null };

  before(async () => {
    ctx.stack = await startStack();
  });

  after(async () => {
    await ctx.stack?.stop();
  });

  chatFlows(ctx);
  approvalFlows(ctx);
  agentFlows(ctx);
  modelAgentFlows(ctx);
  composerFlows(ctx);
  shellFlows(ctx);
  importFlows(ctx);
  settingsFlows(ctx);
  mcpFlows(ctx);
  forkFlows(ctx);
  tailFlows(ctx);
  backgroundFlows(ctx);
});
