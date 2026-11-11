// The gateway proxy's port and secret, kept in the data folder (0600) so a restarted server
// listens where the Claude Code processes it took back from the CLI host already connect.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fileOf = (dataDir) => path.join(dataDir, 'gateway-proxy.json');

/** {port, secret} from the last server, or a fresh secret on any port. */
export function proxyAddress(dataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    if (Number.isInteger(saved.port) && saved.port > 0 && /^[0-9a-f]{64}$/.test(saved.secret)) return { port: saved.port, secret: saved.secret };
  } catch {
    // none yet
  }
  return { port: 0, secret: crypto.randomBytes(32).toString('hex') };
}

export function saveProxyAddress(dataDir, { port, secret }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = fileOf(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ port, secret }) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
