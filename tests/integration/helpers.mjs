// Shared plumbing for the integration tests (real Claude Code CLI, mock gateway).
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

const CONTROL_METHODS = [
  'interrupt',
  'setPermissionMode',
  'setModel',
  'applyFlagSettings',
  'cancelAsyncMessage',
  'stopTask',
  'close',
  // MCP servers (server/mcp.mjs)
  'mcpServerStatus',
  'reconnectMcpServer',
  'toggleMcpServer',
  'mcpAuthenticate',
  'mcpSubmitOAuthCallbackUrl',
  'mcpClearAuth',
];

/**
 * An SDK query() that records what the runner does with each Claude Code process:
 * `spawns` gets one entry per process ({options, controls: [[method, ...args]], messages}),
 * and every control method is passed through to the real process. `onMessage(message)`
 * sees each SDK message before the runner does.
 */
export function observedQuery({ query = sdkQuery, onMessage, beforeSpawn } = {}) {
  const spawns = [];
  const wrapped = (args) => {
    beforeSpawn?.(args);
    const stream = query(args);
    const spawn = { options: args.options, controls: [], messages: [] };
    spawns.push(spawn);
    const messages = (async function* () {
      for await (const message of stream) {
        spawn.messages.push(message);
        onMessage?.(message, spawn);
        yield message;
      }
    })();
    for (const method of CONTROL_METHODS) {
      messages[method] = (...params) => {
        spawn.controls.push([method, ...params]);
        return stream[method](...params);
      };
    }
    return messages;
  };
  wrapped.spawns = spawns;
  return wrapped;
}

/** Ends every Claude Code process the runners keep alive (tests must not leave any). */
export async function closeRunners(runners, timeoutMs = 10_000) {
  for (const runner of runners.splice(0)) {
    runner.shutdown();
    const deadline = Date.now() + timeoutMs;
    while (runner.pool.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
