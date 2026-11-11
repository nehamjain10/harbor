// The server only listens on a unix socket. This host is a shared login node and the
// app trusts the Tailscale identity header, so the socket must never be reachable by
// other local users: its directory has to be private and the socket itself 0600.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Throws unless `dir` is a directory owned by this user and closed to group and others. */
export function assertPrivateDirectory(dir) {
  let stats;
  try {
    stats = fs.statSync(dir);
  } catch (error) {
    throw new Error(`Refusing to listen: socket directory ${dir} is not accessible (${error.code || error.message}).`);
  }
  if (!stats.isDirectory()) throw new Error(`Refusing to listen: ${dir} is not a directory.`);
  const uid = process.getuid();
  if (stats.uid !== uid) {
    throw new Error(`Refusing to listen: socket directory ${dir} is owned by uid ${stats.uid}, not by this user (uid ${uid}).`);
  }
  if (stats.mode & 0o077) {
    const mode = (stats.mode & 0o777).toString(8).padStart(4, '0');
    throw new Error(
      `Refusing to listen: socket directory ${dir} is accessible to other users (mode ${mode}). Use a directory with mode 0700.`,
    );
  }
}

const PROBE_TIMEOUT_MS = 1000;
// sun_path holds 108 bytes on Linux including the terminating NUL. Longer paths are
// silently truncated by the kernel, which would bind a different (possibly shared) path.
const MAX_SOCKET_PATH_BYTES = 107;

/** Throws when the kernel would truncate `socketPath`. */
export function assertSocketPathFits(socketPath) {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Refusing to listen: socket path ${socketPath} is ${bytes} bytes; unix sockets allow at most ${MAX_SOCKET_PATH_BYTES}. Use a shorter WORKBENCH_SOCKET.`,
    );
  }
}

/**
 * Resolves 'stale' when nothing listens on the socket (a crashed run left it behind),
 * 'live' when a server answers, or an error code when the probe could not tell.
 */
function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish('live'));
    socket.once('error', (error) => finish(['ECONNREFUSED', 'ENOENT'].includes(error.code) ? 'stale' : error.code || 'error'));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish('timeout'));
  });
}

/**
 * Removes a stale socket from a previous run. Refuses to delete anything that is not a
 * socket, and refuses to take over a socket another server still answers on.
 */
async function removeStaleSocket(socketPath) {
  let stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!stats.isSocket()) throw new Error(`Refusing to listen: ${socketPath} exists and is not a socket.`);
  const state = await probeSocket(socketPath);
  if (state === 'live') throw new Error(`Refusing to listen: another server is already listening on ${socketPath}.`);
  if (state !== 'stale') throw new Error(`Refusing to listen: could not check whether ${socketPath} is in use (${state}).`);
  fs.rmSync(socketPath, { force: true });
}

/**
 * Starts `app` (an Express app or http.Server) on a private unix socket and resolves
 * with the listening http.Server. The socket is created under umask 077 (never briefly
 * group/world accessible) and then set to 0600.
 */
export async function listenOnSocket(app, socketPath) {
  assertSocketPathFits(socketPath);
  assertPrivateDirectory(path.dirname(socketPath));
  await removeStaleSocket(socketPath);
  const previousUmask = process.umask(0o077);
  let server;
  try {
    server = app.listen(socketPath);
  } finally {
    // Binding a unix socket happens synchronously inside listen(), so the umask can be
    // restored right away; Claude Code child processes must keep the user's normal umask.
    process.umask(previousUmask);
  }
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  fs.chmodSync(socketPath, 0o600);
  return server;
}
