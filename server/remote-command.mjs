// Running Claude Code on another remote cluster: the environment worth forwarding and the
// one ssh command line (port forward included) that starts it there under our pty host.
import crypto from 'node:crypto';
import os from 'node:os';

// Variables the remote Claude Code needs: its API settings, its own switches and timeouts.
const FORWARDED = /^(?:ANTHROPIC_|CLAUDE_CODE_|DISABLE_|MAX_THINKING_TOKENS$|MCP_|BASH_|API_TIMEOUT_MS$|CLAUDE_AGENT_SDK_|ENABLE_TOOL_SEARCH$)/;
// Set locally, meaningless or wrong remotely: the config folder, the gateway address.
const NOT_FORWARDED = new Set(['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL']);

/** One argument as the POSIX shell reads it back unchanged ('' for ''). */
export function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** An absolute local path: under this machine's HOME or under /tmp. */
function isLocalPath(value, home) {
  if (!value.startsWith('/')) return false;
  if (value === '/tmp' || value.startsWith('/tmp/')) return true;
  const base = home.replace(/\/+$/, '');
  return base !== '' && (value === base || value.startsWith(`${base}/`));
}

/** The variables of env that mean the same thing on the remote host, as strings. */
export function remoteEnv(env, home = os.homedir()) {
  const out = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!FORWARDED.test(name) || NOT_FORWARDED.has(name)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = String(value);
    if (isLocalPath(text, home)) continue;
    out[name] = text;
  }
  return out;
}

/** A stable tunnel port for this key, 41000-48999; a taken one is retried with attempt+1. */
export function pickTunnelPort(key, attempt = 0) {
  const digest = crypto.createHash('sha256').update(`${key}:${attempt}`).digest();
  return 41000 + (digest.readUInt32BE(0) % 8000);
}

/** The single line the remote shell runs: cd to the project, then exec the CLI. */
export function remoteLine({ cwd, env = {}, command, args = [], remoteClaude }) {
  const parts = ['cd', shQuote(cwd), '&&', 'exec', 'env'];
  for (const [name, value] of Object.entries(env)) parts.push(shQuote(`${name}=${value}`));
  parts.push(shQuote(remoteClaude ?? command));
  for (const arg of args) parts.push(shQuote(arg));
  return parts.join(' ');
}

/** The ssh invocation (no ControlMaster) whose remote line runs Claude Code there. */
export function sshSpawnArgs({ host, cwd, env, command, args, tunnel, remoteClaude }) {
  const sshArgs = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ExitOnForwardFailure=yes',
  ];
  if (tunnel) sshArgs.push('-R', `127.0.0.1:${tunnel.remotePort}:127.0.0.1:${tunnel.localPort}`);
  sshArgs.push(host, '--', remoteLine({ cwd, env, command, args, remoteClaude }));
  return { command: 'ssh', args: sshArgs };
}
