// A minimal MCP server over stdio (newline-delimited JSON-RPC), for the end-to-end tests of
// the MCP manager: one tool, `echo`, that answers with its input. Writes its pid to the file
// named by MCP_ECHO_PIDFILE (one line per start), so a test can tell a reconnect started a
// new process. MCP_ECHO_DELAY_MS holds back the answer to `initialize`, so the server connects
// late, as plugin and claude.ai servers do. No dependencies.
import fs from 'node:fs';
import readline from 'node:readline';

if (process.env.MCP_ECHO_PIDFILE) fs.appendFileSync(process.env.MCP_ECHO_PIDFILE, `${process.pid}\n`);

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to echo' } } },
    annotations: { readOnlyHint: true },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

const DELAY_MS = Number(process.env.MCP_ECHO_DELAY_MS) || 0;

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications (initialized, cancelled, ...)
  switch (method) {
    case 'initialize':
      if (DELAY_MS) return setTimeout(() => reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } }), DELAY_MS);
      return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } });
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return reply(id, { content: [{ type: 'text', text: `echo: ${params?.arguments?.text ?? JSON.stringify(params?.arguments ?? {})}` }] });
    case 'ping':
      return reply(id, {});
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }) + '\n');
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    // Not JSON: ignore.
  }
});
