// The Claude Code binary a remote session runs: this machine's own (a self-contained
// x86_64 executable), copied once per version to ~/.local/share/harbor/claude-<version>
// on the cluster, so the CLI there speaks the same protocol as the SDK here. The other
// cluster's own ~/.local/bin/claude may be older. A host of another platform (a Mac)
// downloads the same version's build for itself from Anthropic's release bucket, checked
// against the checksum in that version's manifest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shQuote } from './remote-command.mjs';
import { runSsh } from './ssh.mjs';

export const REMOTE_DIR = '.local/share/harbor';
// A 270 MB copy across the Pacific takes a while.
const UPLOAD_TIMEOUT_MS = 20 * 60_000;
export const RELEASES = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';
const LOCAL_PLATFORM = 'linux-x64';

/** The release platform of `uname -sm` output (null when Claude Code has no build for it). */
export function releasePlatform(uname) {
  const [system, machine] = uname.trim().split(/\s+/);
  const os = { Linux: 'linux', Darwin: 'darwin' }[system];
  const arch = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' }[machine];
  return os && arch ? `${os}-${arch}` : null;
}

/**
 * The local executable behind `executable` (symlinks resolved) and its version: the
 * file's name when it is one (Claude Code installs to versions/<x.y.z>), else a hash of
 * where it is, its size and its time.
 */
export function localClaude(executable) {
  const file = fs.realpathSync(executable);
  const stats = fs.statSync(file);
  const name = path.basename(file);
  const version = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(name)
    ? name
    : crypto.createHash('sha256').update(`${file}\0${stats.size}\0${stats.mtimeMs}`).digest('hex').slice(0, 16);
  return { file, version, size: stats.size };
}

/**
 * @param {object} deps
 * @param {string} deps.executable  the local Claude Code (config.claudeExecutable)
 * @param {(cluster: object) => Promise<string>} deps.home  a cluster's home folder (clusters.home)
 * @param {Function} [deps.ssh]  runSsh (replaceable in tests)
 */
export function createRemoteClaude({ executable, home, ssh = runSsh, log = console.error, fetchJson = defaultFetchJson }) {
  const ready = new Map(); // host + version -> Promise<remote path>

  async function ship(host, local, remotePath) {
    const started = Date.now();
    log(`Copying Claude Code ${local.version} to ${host} (${Math.round(local.size / 1e6)} MB)…`);
    const dir = path.posix.dirname(remotePath);
    const tmp = `${shQuote(remotePath + '.tmp.')}$$`;
    // Written aside and renamed: a copy cut short is never taken for the binary.
    const script = `umask 077 && mkdir -p ${shQuote(dir)} && cat > ${tmp} && chmod 700 ${tmp} && mv -f ${tmp} ${shQuote(remotePath)} || { rm -f ${tmp}; exit 1; }`;
    await ssh(host, script, { input: fs.createReadStream(local.file), timeoutMs: UPLOAD_TIMEOUT_MS });
    log(`Claude Code ${local.version} is on ${host} (${Math.round((Date.now() - started) / 1000)} s).`);
    return remotePath;
  }

  /** Has the host fetch the release build of `version` for `platform` itself. */
  async function download(host, version, platform, remotePath) {
    const manifest = await fetchJson(`${RELEASES}/${version}/manifest.json`);
    const checksum = manifest?.platforms?.[platform]?.checksum;
    if (!/^[0-9a-f]{64}$/.test(checksum ?? '')) throw new Error(`Claude Code ${version} has no ${platform} build`);
    const started = Date.now();
    log(`Downloading Claude Code ${version} (${platform}) on ${host}…`);
    const dir = path.posix.dirname(remotePath);
    const tmp = `${shQuote(remotePath + '.tmp.')}$$`;
    const url = shQuote(`${RELEASES}/${version}/${platform}/claude`);
    const sum = `{ sha256sum ${tmp} 2>/dev/null || shasum -a 256 ${tmp}; } | cut -d' ' -f1`;
    const script = `umask 077 && mkdir -p ${shQuote(dir)} && curl -fsSL --retry 3 -o ${tmp} ${url} && [ "$(${sum})" = ${checksum} ] && chmod 700 ${tmp} && mv -f ${tmp} ${shQuote(remotePath)} || { rm -f ${tmp}; echo "download or checksum failed" >&2; exit 1; }`;
    await ssh(host, script, { timeoutMs: UPLOAD_TIMEOUT_MS });
    log(`Claude Code ${version} is on ${host} (${Math.round((Date.now() - started) / 1000)} s).`);
    return remotePath;
  }

  /** Copies this machine's build, or has a host of another platform download its own. */
  async function install(cluster, local, remoteHome) {
    const remotePath = path.posix.join(remoteHome, REMOTE_DIR, `claude-${local.version}`);
    if ((await ssh(cluster.host, `test -x ${shQuote(remotePath)} && echo yes || true`)).trim() === 'yes') return remotePath;
    const platform = releasePlatform(await ssh(cluster.host, 'uname -sm'));
    if (platform === LOCAL_PLATFORM) return ship(cluster.host, local, remotePath);
    if (!platform) throw new Error(`Claude Code has no build for ${cluster.label}`);
    if (!/^\d+\.\d+\.\d+/.test(local.version)) throw new Error(`This Claude Code (${local.version}) is not a release; ${cluster.label} needs one`);
    return download(cluster.host, local.version, platform, remotePath);
  }

  /**
   * The remote path of this machine's Claude Code on the cluster, copied there first if it
   * is not. Concurrent first spawns share one copy; a failed one is tried again next time.
   */
  function ensure(cluster) {
    const local = localClaude(executable);
    const key = `${cluster.host}\0${local.version}`;
    if (!ready.has(key)) {
      const pending = home(cluster).then((remoteHome) => install(cluster, local, remoteHome));
      pending.catch(() => ready.delete(key));
      ready.set(key, pending);
    }
    return ready.get(key);
  }

  return { ensure };
}

async function defaultFetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
