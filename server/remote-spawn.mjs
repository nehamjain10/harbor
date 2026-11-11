// A session's Claude Code process on another cluster. The SDK builds its spawn request
// (command, args, cwd, env) as for a local process; remoteSpawn turns it into a local
// process of the CLI host that runs it over ssh: `node ssh-launch.mjs`, with ssh's
// invocations and the remote environment in its own (private) environment. The CLI host
// owns that process like any other, so server restarts and reattaching work unchanged.
//
// Every model goes through the gateway, by way of this server's gateway proxy, through an ssh
// reverse tunnel: remote 127.0.0.1:<port> -> local proxy. The proxy wants its secret on
// every request; the login nodes are shared, and other users reach remote 127.0.0.1 too.
//   gateway models  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>, the secret as API key (as here)
//   Claude models   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/claude-relay, the secret in
//                   X-Harbor-Key (ANTHROPIC_CUSTOM_HEADERS), and a placeholder OAuth token the
//                   proxy swaps for the gateway's relay key: the cluster holds no Claude
//                   login, the gateway's accounts serve it (see gateway-proxy.mjs)
//   relay down      no base URL: the cluster's own Claude login, direct
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickTunnelPort, remoteEnv, sshSpawnArgs } from './remote-command.mjs';
import { RELAY_PLACEHOLDER } from './gateway-proxy.mjs';
import { sshCommand } from './ssh.mjs';

const LAUNCHER = fileURLToPath(new URL('./ssh-launch.mjs', import.meta.url));
// Tunnel ports tried per process (another user may hold one on a shared login node).
export const TUNNEL_ATTEMPTS = 6;
// What the launcher itself needs from this environment; nothing else goes with it.
const LAUNCHER_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK', 'TZ'];

/**
 * The remote shell that starts Claude Code: variables a cluster's own login set for an API
 * (ANTHROPIC_*) go, the KEY=VALUE lines from stdin (up to an empty one; see ssh-launch.mjs)
 * are exported, then the CLI ($0, with its arguments) runs on the rest of stdin. `read`
 * takes one byte at a time from a pipe, so nothing else is consumed.
 *
 * The connection may drop while the CLI is busy: sshd does not signal a session without a
 * terminal, and a CLI in the middle of a turn does not stop at the end of its input. So a
 * watchdog checks every 2 s that this shell still has the parent sshd gave it; once it is
 * orphaned, the CLI gets SIGTERM, then SIGKILL 5 s later.
 */
export const REMOTE_SHELL = [
  'for v in $(env | sed -n "s/^\\(ANTHROPIC_[A-Za-z0-9_]*\\)=.*/\\1/p"); do unset "$v"; done',
  'while IFS= read -r l && [ -n "$l" ]; do export "$l"; done',
  // A background job's stdin is /dev/null before any redirection: it gets ours by way of fd 3.
  'exec 3<&0',
  '"$0" "$@" <&3 3<&- & c=$!',
  'exec 3<&- 0</dev/null',
  'p=$PPID',
  '( while kill -0 "$c" 2>/dev/null; do if [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d " ")" != "$p" ]; then kill -TERM "$c" 2>/dev/null; sleep 5; kill -KILL "$c" 2>/dev/null; exit 0; fi; sleep 2; done ) </dev/null >/dev/null 2>&1 & w=$!',
  'wait "$c"; s=$?; kill "$w" 2>/dev/null; exit "$s"',
].join('\n');

/**
 * What the remote CLI runs with: the forwardable part of the SDK's env (remoteEnv), its
 * base URL moved to the tunnel. `gatewayUrl` is the local proxy and `relayUrl` the gateway's
 * Claude relay, as the local env would name them.
 */
export function tunnelEnv(env, { gatewayUrl, relayUrl, secret, port, home }) {
  const out = remoteEnv(env, home);
  const local = env.ANTHROPIC_BASE_URL?.replace(/\/+$/, '');
  const tunnel = `http://127.0.0.1:${port}`;
  delete out.ANTHROPIC_CUSTOM_HEADERS;
  if (local && local === gatewayUrl?.replace(/\/+$/, '')) out.ANTHROPIC_BASE_URL = tunnel;
  else if (local && relayUrl && (local === relayUrl.replace(/\/+$/, '') || local === gatewayUrl?.replace(/\/+$/, '') + '/claude-relay')) {
    out.ANTHROPIC_BASE_URL = `${tunnel}/claude-relay`;
    out.ANTHROPIC_CUSTOM_HEADERS = `X-Harbor-Key: ${secret}`;
    // No login on the cluster: the gateway's accounts serve it (RELAY_PLACEHOLDER).
    out.CLAUDE_CODE_OAUTH_TOKEN = RELAY_PLACEHOLDER;
  } else if (local) throw new Error(`A remote session cannot reach ${local}.`);
  // One line each (ssh-launch.mjs); no variable Claude Code needs has a newline.
  for (const [name, value] of Object.entries(out)) if (/[\n\r\0]/.test(value)) delete out[name];
  return out;
}

/**
 * The CLI host's spawn request for an SDK spawn request on `cluster` (a host): node running
 * ssh-launch.mjs, with one ssh invocation per tunnel port to try.
 * @param {object} options  the SDK's {command, args, cwd, env}
 * @param {object} route
 * @param {string} route.key  the process's CLI host key (picks its tunnel ports)
 * @param {string} route.remoteClaude  the CLI's path on the cluster (remote-claude.mjs)
 * @param {number} route.proxyPort  the local gateway proxy's port
 */
export function remoteSpawn(options, { cluster, key, remoteClaude, proxyPort, gatewayUrl, relayUrl, secret, ssh = sshCommand(), env = process.env, nodePath = process.execPath }) {
  const attempts = [];
  for (let attempt = 0; attempts.length < TUNNEL_ATTEMPTS && attempt < TUNNEL_ATTEMPTS * 4; attempt++) {
    const port = pickTunnelPort(key, attempt);
    if (attempts.some((item) => item.port === port)) continue;
    const remote = tunnelEnv(options.env ?? {}, { gatewayUrl, relayUrl, secret, port, home: os.homedir() });
    const { args } = sshSpawnArgs({
      host: cluster.host,
      cwd: options.cwd,
      env: {},
      command: 'sh',
      args: ['-c', REMOTE_SHELL, remoteClaude, ...(options.args ?? [])],
      tunnel: { remotePort: port, localPort: proxyPort },
    });
    // The control socket of a ControlMaster hangs on the NFS home: never one.
    attempts.push({ port, args: ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...args], env: remote });
  }
  const launcherEnv = Object.fromEntries(LAUNCHER_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
  launcherEnv.HARBOR_SSH_SPEC = JSON.stringify({ ssh, attempts });
  return { command: nodePath, args: [LAUNCHER], cwd: os.homedir(), env: launcherEnv };
}

/** Where a session's uploads go on its cluster. */
export function remoteUploadDir(home, sessionId) {
  return path.posix.join(home, '.local/share/harbor/uploads', sessionId);
}
