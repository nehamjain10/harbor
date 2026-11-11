#!/usr/bin/env node
// A stand-in for ssh in the remote-cluster tests: `node fake-ssh.mjs --home DIR [ssh args]`.
// The host is ignored and the remote command runs here, as `sh -c` in DIR (the "remote"
// HOME) with a clean environment, as sshd would start it. `-R 127.0.0.1:R:127.0.0.1:L`
// forwards like ssh: a listener on R relays to L; a port already taken ends it at once
// with ssh's error and status 255 (ExitOnForwardFailure). Its pid file (`--pids FILE`)
// records one line per remote command, for the tests that check what is still running.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const argv = process.argv.slice(2);
let home = null;
let pids = null;
const forwards = [];
let i = 0;
for (; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--home') home = argv[++i];
  else if (arg === '--pids') pids = argv[++i];
  else if (arg === '-o' || arg === '-p' || arg === '-l' || arg === '-i') i++;
  else if (arg === '-R') forwards.push(argv[++i]);
  else if (arg.startsWith('-')) continue;
  else break;
}
// The host, then `--`, then the command.
i++;
if (argv[i] === '--') i++;
const command = argv.slice(i).join(' ');

function forward(spec) {
  const [, remotePort, , localPort] = spec.split(':');
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const upstream = net.connect(Number(localPort), '127.0.0.1');
      socket.pipe(upstream).pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    server.once('error', () => reject(new Error(`Error: remote port forwarding failed for listen port ${remotePort}`)));
    server.listen(Number(remotePort), '127.0.0.1', () => resolve(server));
  });
}

try {
  for (const spec of forwards) (await forward(spec)).unref();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exit(255);
}

const env = { HOME: home, PATH: process.env.PATH, USER: process.env.USER, LANG: process.env.LANG || 'C.UTF-8' };
const child = spawn('sh', ['-c', command], { cwd: home, env, stdio: ['pipe', 'pipe', 'inherit'] });
if (pids) fs.appendFileSync(pids, `${child.pid} ${process.pid}\n`);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stdin.on('error', () => {});
// The connection dropped (ssh killed): as with sshd, the remote command's input ends and
// its output goes nowhere.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    child.stdin.end();
    child.stdout.destroy();
    process.exit(255);
  });
}
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
