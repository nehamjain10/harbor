// A stand-in for Claude Code under the CLI host: reads JSON lines on stdin and prints
// JSON lines. {cmd:'emit', n, delay} prints n numbered lines; {cmd:'request', id, subtype} prints a
// control_request; a control_response is echoed as {got: id}; a control_request from the
// server is answered after `delay` ms; {cmd:'exit', code} exits; {cmd:'slowTerm', ms} makes
// SIGTERM take `ms` to end it (as a busy Claude Code does).
import readline from 'node:readline';
let counter = 0;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.cmd === 'emit') {
    for (let i = 0; i < msg.n; i++) {
      out({ type: 'line', n: ++counter });
      if (msg.delay) await new Promise((r) => setTimeout(r, msg.delay));
    }
  } else if (msg.cmd === 'request') out({ type: 'control_request', request_id: msg.id, request: { subtype: msg.subtype ?? 'mcp_message' } });
  else if (msg.type === 'control_response') out({ type: 'got', id: msg.response.request_id });
  else if (msg.type === 'control_request') {
    setTimeout(() => out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }), msg.delay ?? 300);
  } else if (msg.cmd === 'exit') process.exit(msg.code ?? 0);
  else if (msg.cmd === 'slowTerm') {
    process.on('SIGTERM', () => setTimeout(() => process.exit(143), msg.ms));
    out({ type: 'slowTerm' });
  }
});
process.stdin.on('end', () => process.exit(0));
