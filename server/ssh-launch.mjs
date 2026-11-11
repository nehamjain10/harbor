// Runs one remote Claude Code process over ssh, as a child of the CLI host (cli-host.mjs)
// like any local one: `node server/ssh-launch.mjs`, its stdin and stdout are the CLI's.
//
// The plan comes in the environment (HARBOR_SSH_SPEC, JSON), never on the command line:
// this login node is shared, and anyone can read a process's arguments. It is
//   {ssh, attempts: [{port, args, env}]}
// one ssh invocation per tunnel port to try (remote-spawn.mjs). `env` is what the remote
// CLI runs with, the gateway secret among it: it is written to ssh's stdin as KEY=VALUE
// lines ending in an empty one, ahead of everything the SDK writes, and the remote shell
// exports them before it starts Claude Code (remoteShell in remote-spawn.mjs).
//
// A tunnel port another user holds on the remote end makes ssh exit at once
// (ExitOnForwardFailure); the next attempt's port is tried, with everything the SDK has
// written so far sent again. Once the remote CLI has answered, ssh's end is the end.
// SIGTERM, SIGINT and SIGHUP end ssh; the remote CLI then reads the end of its input and
// exits.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FORWARD_FAILED = /remote port forwarding failed/i;

export function envLines(env) {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('') + '\n';
}

function main() {
  const spec = JSON.parse(process.env.HARBOR_SSH_SPEC || '{}');
  const attempts = Array.isArray(spec.attempts) ? spec.attempts : [];
  if (!attempts.length) {
    process.stderr.write('ssh-launch: no HARBOR_SSH_SPEC\n');
    process.exit(2);
  }
  const childEnv = { ...process.env };
  delete childEnv.HARBOR_SSH_SPEC;

  let child = null;
  let attempt = 0;
  let answered = false; // the remote CLI wrote something: no more retries
  let written = []; // what the SDK wrote before that, for a retry
  let inputEnded = false;
  let stopping = null;

  process.stdin.on('data', (chunk) => {
    if (!answered) written.push(chunk);
    child?.stdin.write(chunk);
  });
  process.stdin.on('end', () => {
    inputEnded = true;
    child?.stdin.end();
  });

  function start() {
    const { args, env } = attempts[attempt];
    const proc = spawn(spec.ssh || 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    child = proc;
    let stderr = '';
    proc.stdin.on('error', () => {});
    proc.stdin.write(envLines(env));
    for (const chunk of written) proc.stdin.write(chunk);
    if (inputEnded) proc.stdin.end();
    proc.stdout.on('data', (chunk) => {
      if (!answered) {
        answered = true;
        written = [];
      }
      // Backpressure: the host reads as fast as it can; ssh waits for it.
      if (!process.stdout.write(chunk)) {
        proc.stdout.pause();
        process.stdout.once('drain', () => proc.stdout.resume());
      }
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk;
      process.stderr.write(chunk);
    });
    proc.on('error', (error) => {
      process.stderr.write(`ssh-launch: ${error.message}\n`);
    });
    proc.on('close', (code, signal) => {
      if (!stopping && !answered && code === 255 && FORWARD_FAILED.test(stderr) && attempt + 1 < attempts.length) {
        attempt += 1;
        process.stderr.write(`ssh-launch: tunnel port ${attempts[attempt - 1].port} is taken; trying ${attempts[attempt].port}\n`);
        start();
        return;
      }
      // stdout may still be flushing to the host.
      process.stdout.end(() => process.exit(code ?? 1));
    });
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      stopping = signal;
      if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
      else process.exit(1);
    });
  }
  process.stdout.on('error', () => child?.kill('SIGTERM'));
  start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
