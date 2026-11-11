// Short commands on another cluster over ssh: a home folder, a folder check, a file
// listing, git status, a file copy. Never a ControlMaster: its control socket hangs on
// the NFS home. WORKBENCH_SSH names another ssh (tests point it at tests/fake-ssh.mjs).
import { spawn } from 'node:child_process';
import { shQuote } from './remote-command.mjs';

export const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];

/** The ssh command to run (an absolute path or a name on PATH). */
export const sshCommand = (env = process.env) => env.WORKBENCH_SSH || 'ssh';

// Scripts run under /bin/sh whatever the login shell is (zsh on a Mac fails on an
// unmatched glob), with a `timeout` that only runs the command where there is none (macOS).
const PRELUDE = 'command -v timeout >/dev/null 2>&1 || timeout() { shift; "$@"; }\n';
export const posixScript = (script) => `exec /bin/sh -c ${shQuote(PRELUDE + script)}`;

/**
 * Runs `script` (a POSIX shell line) on `host` and resolves its stdout. `input` (a string,
 * Buffer or readable stream) goes to its stdin. Rejects with `code` (the exit status, 255
 * for ssh's own failures) and the first lines of stderr when it fails or times out.
 */
export function runSsh(host, script, { input = null, timeoutMs = 30_000, maxBytes = 16 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sshCommand(), [...SSH_OPTIONS, host, '--', posixScript(script)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let bytes = 0;
    let err = '';
    let failed = null;
    const timer = setTimeout(() => {
      failed = new Error(`ssh ${host} timed out`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = new Error(`ssh ${host}: the answer is too large`);
        child.kill('SIGKILL');
      } else out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 4000) err += chunk;
    });
    child.on('error', (error) => {
      failed = error;
    });
    child.stdin.on('error', () => {}); // it exited before reading everything
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      if (!failed && code === 0) return resolve(encoding ? stdout.toString(encoding) : stdout);
      const error = failed ?? new Error(err.trim().split('\n').slice(-3).join(' ') || `ssh ${host} exited with ${code}`);
      error.code = failed ? null : code;
      error.stderr = err;
      reject(error);
    });
    if (input && typeof input.pipe === 'function') input.pipe(child.stdin);
    else child.stdin.end(input ?? undefined);
  });
}
