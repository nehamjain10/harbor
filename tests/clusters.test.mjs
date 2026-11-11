import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLUSTERS, createClusters, isRemote, loadClusters, parseClusters, sessionCluster } from '../server/clusters.mjs';
import { createRemoteClaude, localClaude, releasePlatform, RELEASES } from '../server/remote-claude.mjs';
import { createRemoteFiles } from '../server/remote-files.mjs';
import { pickTunnelPort } from '../server/remote-command.mjs';
import { REMOTE_SHELL, TUNNEL_ATTEMPTS, remoteSpawn, tunnelEnv } from '../server/remote-spawn.mjs';
import { envLines } from '../server/ssh-launch.mjs';

const FAKE_SSH = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-clusters-'));

const TEST_CLUSTERS = [
  { id: 'local', label: 'Here', host: null },
  { id: 'alpha', label: 'Alpha', host: 'alpha-login' },
  { id: 'beta', label: 'Beta', host: 'beta-login' },
];

describe('cluster list', () => {
  test('defaults: only this machine', () => {
    assert.deepEqual(parseClusters(undefined), DEFAULT_CLUSTERS);
    assert.deepEqual(parseClusters('').map((c) => c.id), ['local']);
    assert.equal(parseClusters()[0].host, null);
  });

  test('WORKBENCH_CLUSTERS replaces it; local is added when left out', () => {
    const list = parseClusters(JSON.stringify([{ id: 'lab', label: 'Lab', host: 'me@lab-login' }]));
    assert.deepEqual(list.map((c) => [c.id, c.host]), [['local', null], ['lab', 'me@lab-login']]);
  });

  test('WORKBENCH_CLUSTERS_FILE names a JSON file of the list; WORKBENCH_CLUSTERS wins over it', () => {
    const dir = tmp();
    const file = path.join(dir, 'clusters.json');
    fs.writeFileSync(file, JSON.stringify(TEST_CLUSTERS));
    assert.deepEqual(loadClusters({ WORKBENCH_CLUSTERS_FILE: file }), TEST_CLUSTERS);
    assert.deepEqual(loadClusters({ WORKBENCH_CLUSTERS_FILE: file, WORKBENCH_CLUSTERS: '[{"id":"lab","host":"lab-login"}]' }).map((c) => c.id), ['local', 'lab']);
    assert.deepEqual(loadClusters({}), DEFAULT_CLUSTERS);
    assert.throws(() => loadClusters({ WORKBENCH_CLUSTERS_FILE: path.join(dir, 'missing.json') }), /WORKBENCH_CLUSTERS_FILE: cannot read/);
    fs.writeFileSync(file, '[{"id":"x","host":null}]');
    assert.throws(() => loadClusters({ WORKBENCH_CLUSTERS_FILE: file }), /WORKBENCH_CLUSTERS/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses bad lists', () => {
    for (const value of ['{', '[]', '{"id":"x"}', '[{"id":"Bad id","host":"h"}]', '[{"id":"x","host":"-oProxyCommand=evil"}]', '[{"id":"x","host":null}]', '[{"id":"local","host":"h"}]', '[{"id":"a","host":"h"},{"id":"a","host":"g"}]']) {
      assert.throws(() => parseClusters(value), /WORKBENCH_CLUSTERS/, value);
    }
  });

  test('a session without a cluster runs here', () => {
    assert.equal(sessionCluster({}), 'local');
    assert.equal(isRemote({}), false);
    assert.equal(isRemote({ cluster: 'local' }), false);
    assert.equal(isRemote({ cluster: 'alpha' }), true);
  });

  test('home is asked once; remote folders are checked there, ~ is home, a failure is not kept', async () => {
    const calls = [];
    let fail = true;
    const ssh = async (host, script) => {
      calls.push([host, script]);
      if (script.includes('$HOME')) {
        if (fail) {
          fail = false;
          throw Object.assign(new Error('no route'), { code: 255 });
        }
        return '/home/me\n';
      }
      if (script.includes("'/home/me/proj'")) return '/home/me/proj\n';
      throw Object.assign(new Error(''), { code: 1 });
    };
    const clusters = createClusters({ list: TEST_CLUSTERS, ssh, log: () => {} });
    const alpha = clusters.get('alpha');
    await assert.rejects(clusters.remoteFolder(alpha, '~/proj'), /Could not reach Alpha/);
    assert.equal(await clusters.remoteFolder(alpha, '~/proj'), '/home/me/proj');
    assert.equal(await clusters.remoteFolder(alpha, '/home/me/x/../proj'), '/home/me/proj');
    await assert.rejects(clusters.remoteFolder(alpha, '/nope'), /\/nope is not a folder on Alpha/);
    await assert.rejects(clusters.remoteFolder(alpha, 'relative'), /absolute folder/);
    assert.equal(calls.filter(([, script]) => script.includes('$HOME')).length, 2, 'asked again after the failure, then kept');
    assert.throws(() => clusters.get('mars'), /Unknown cluster/);
    assert.equal(clusters.get(undefined).id, 'local');
  });

  test('the public list never waits long for a cluster', async () => {
    const ssh = (host) => (host === 'alpha-login' ? Promise.resolve('/home/o\n') : new Promise(() => {}));
    const clusters = createClusters({ list: TEST_CLUSTERS, ssh, log: () => {} });
    const started = Date.now();
    const list = await clusters.publicList({ waitMs: 100 });
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(list.map((c) => [c.id, c.label, c.home]), [['local', 'Here', null], ['alpha', 'Alpha', '/home/o'], ['beta', 'Beta', null]]);
  });
});

describe('remote spawn', () => {
  const gatewayUrl = 'http://127.0.0.1:5000';
  const relayUrl = 'http://127.0.0.1:3425/claude-relay';
  const secret = 's3cret';

  test('gateway routes: the tunnel and the secret as API key; local paths and other variables stay here', () => {
    const env = { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: secret, CLAUDE_CONFIG_DIR: '/x', ENABLE_TOOL_SEARCH: 'true', PATH: '/bin', CLAUDE_CODE_TMPDIR: path.join(os.homedir(), 'tmp'), CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    assert.deepEqual(tunnelEnv(env, { gatewayUrl, relayUrl, secret, port: 41234 }), {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234',
      ANTHROPIC_API_KEY: secret,
      ENABLE_TOOL_SEARCH: 'true',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    });
  });

  test('Claude through the relay: the tunnel’s /claude-relay, the secret in X-Harbor-Key, no API key', () => {
    const out = tunnelEnv({ ANTHROPIC_BASE_URL: relayUrl, ENABLE_TOOL_SEARCH: 'true' }, { gatewayUrl, relayUrl, secret, port: 41234 });
    assert.deepEqual(out, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234/claude-relay', ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_CUSTOM_HEADERS: 'X-Harbor-Key: s3cret', CLAUDE_CODE_OAUTH_TOKEN: 'harbor-relay' });
    const managed = tunnelEnv({ ANTHROPIC_BASE_URL: gatewayUrl + '/claude-relay', ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_CUSTOM_HEADERS: 'X-Harbor-Key: local', CLAUDE_CODE_OAUTH_TOKEN: 'harbor-relay' }, { gatewayUrl, relayUrl, secret, port: 41234 });
    assert.deepEqual(managed, out, 'local managed relay authentication is tunnelled identically');
  });

  test('Claude direct: no base URL (the cluster’s own login); an unknown local address is refused', () => {
    assert.deepEqual(tunnelEnv({ CLAUDE_CODE_ARTIFACT: '1' }, { gatewayUrl, relayUrl, secret, port: 1 }), { CLAUDE_CODE_ARTIFACT: '1' });
    assert.throws(() => tunnelEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, { gatewayUrl, relayUrl, secret, port: 1 }), /cannot reach/);
    // A value that cannot be one line is left out.
    assert.deepEqual(tunnelEnv({ CLAUDE_CODE_X: 'a\nb' }, { gatewayUrl, relayUrl, secret, port: 1 }), {});
  });

  test('the launcher: ssh per tunnel port, the secret only in its environment', () => {
    const request = { command: '/home/me/.local/bin/claude', args: ['--settings', '{"a":"it\'s"}'], cwd: '/remote/proj', env: { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: secret } };
    const spawned = remoteSpawn(request, { cluster: { host: 'alpha-login' }, key: 's:abc', remoteClaude: '/r/claude-2', proxyPort: 5000, gatewayUrl, relayUrl, secret, ssh: 'ssh', env: { PATH: '/bin', SECRET_THING: 'x' }, nodePath: '/node' });
    assert.equal(spawned.command, '/node');
    assert.match(spawned.args[0], /ssh-launch\.mjs$/);
    assert.deepEqual(Object.keys(spawned.env).sort(), ['HARBOR_SSH_SPEC', 'PATH']);
    const spec = JSON.parse(spawned.env.HARBOR_SSH_SPEC);
    assert.equal(spec.attempts.length, TUNNEL_ATTEMPTS);
    assert.equal(new Set(spec.attempts.map((a) => a.port)).size, TUNNEL_ATTEMPTS);
    assert.equal(spec.attempts[0].port, pickTunnelPort('s:abc', 0));
    const [first] = spec.attempts;
    assert.ok(!JSON.stringify(first.args).includes(secret), 'not on the command line');
    assert.equal(first.env.ANTHROPIC_API_KEY, secret);
    assert.equal(first.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${first.port}`);
    assert.ok(first.args.includes(`127.0.0.1:${first.port}:127.0.0.1:5000`));
    assert.ok(first.args.includes('ControlMaster=no'));
    assert.equal(first.args.at(-3), 'alpha-login');
  });

  test('the remote shell: exports the lines, starts the CLI with its arguments on the rest of stdin', async () => {
    const dir = tmp();
    const fake = path.join(dir, 'cli');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$@"; printf "%s|%s|%s|" "$ANTHROPIC_API_KEY" "$ANTHROPIC_CUSTOM_HEADERS" "${ANTHROPIC_STRAY-unset}"; cat\n', { mode: 0o700 });
    const args = ['--settings', '{"permissions":{"allow":["Read(//a b/**)"]},"q":"it\'s $HOME `x`"}', ''];
    const child = spawn('sh', ['-c', REMOTE_SHELL, fake, ...args], { env: { PATH: process.env.PATH, ANTHROPIC_STRAY: 'from the login' } });
    child.stdin.end(envLines({ ANTHROPIC_API_KEY: 'k=v with spaces', ANTHROPIC_CUSTOM_HEADERS: 'X-Harbor-Key: abc' }) + '{"type":"user"}\n');
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(out, `${args.join('|')}|k=v with spaces|X-Harbor-Key: abc|unset|{"type":"user"}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the launcher retries a taken tunnel port with everything written so far', async () => {
    const dir = tmp();
    const ssh = path.join(dir, 'ssh');
    fs.writeFileSync(ssh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SSH)} --home ${JSON.stringify(dir)} "$@"\n`, { mode: 0o700 });
    const target = net.createServer((socket) => socket.end('pong\n'));
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    const taken = net.createServer();
    const key = `s:${Date.now()}`;
    await new Promise((resolve) => taken.listen(pickTunnelPort(key, 0), '127.0.0.1', resolve));
    // The "CLI" echoes its input and what it reaches through the tunnel.
    const cli = path.join(dir, 'cli');
    fs.writeFileSync(cli, `#!/bin/sh\nhead -n 1\nnode -e "require('net').connect(+process.argv[1], '127.0.0.1').on('data', (d) => process.stdout.write(d))" "\${ANTHROPIC_BASE_URL##*:}"\n`, { mode: 0o700 });
    const spawned = remoteSpawn(
      { command: 'claude', args: [], cwd: dir, env: { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: secret } },
      { cluster: { host: 'h' }, key, remoteClaude: cli, proxyPort: target.address().port, gatewayUrl, relayUrl, secret, ssh },
    );
    const child = spawn(spawned.command, spawned.args, { env: spawned.env, cwd: spawned.cwd });
    child.stdin.write('hello\n');
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    taken.close();
    target.close();
    assert.equal(code, 0, err);
    assert.equal(out, 'hello\npong\n');
    assert.match(err, /tunnel port \d+ is taken; trying \d+/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('remote Claude Code binary', () => {
  test('copied once per cluster and version; concurrent first spawns share the copy; a failure is retried', async () => {
    const dir = tmp();
    const bin = path.join(dir, '2.1.999');
    fs.writeFileSync(bin, 'ELF');
    const link = path.join(dir, 'claude');
    fs.symlinkSync(bin, link);
    assert.deepEqual(localClaude(link), { file: bin, version: '2.1.999', size: 3 });
    const scripts = [];
    let installed = false;
    let failNext = true;
    const ssh = async (host, script, { input } = {}) => {
      scripts.push(script);
      if (script.startsWith('test -x')) return installed ? 'yes\n' : '';
      if (script === 'uname -sm') return 'Linux x86_64\n';
      if (failNext) {
        failNext = false;
        throw new Error('broken pipe');
      }
      for await (const chunk of input) assert.equal(String(chunk), 'ELF');
      installed = true;
      return '';
    };
    const remote = createRemoteClaude({ executable: link, home: async () => '/home/me', ssh, log: () => {} });
    const cluster = { id: 'alpha', host: 'alpha-login' };
    await assert.rejects(remote.ensure(cluster), /broken pipe/);
    const paths = await Promise.all([remote.ensure(cluster), remote.ensure(cluster)]);
    assert.deepEqual(paths, ['/home/me/.local/share/harbor/claude-2.1.999', '/home/me/.local/share/harbor/claude-2.1.999']);
    assert.equal(scripts.filter((s) => s.includes('cat >')).length, 2, 'the failed copy and one more');
    assert.match(scripts.at(-1), /mv -f .*\.tmp\.'\$\$ '\/home\/me\/\.local\/share\/harbor\/claude-2\.1\.999'/);
    await remote.ensure(cluster);
    assert.equal(scripts.length, 6, 'kept: no more ssh');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a Mac downloads its own build of the same version, checked against the manifest', async () => {
    assert.equal(releasePlatform('Darwin arm64\n'), 'darwin-arm64');
    assert.equal(releasePlatform('Linux aarch64'), 'linux-arm64');
    assert.equal(releasePlatform('SunOS sparc'), null);
    const dir = tmp();
    const bin = path.join(dir, '2.1.999');
    fs.writeFileSync(bin, 'ELF');
    const scripts = [];
    const ssh = async (host, script, { input } = {}) => {
      scripts.push(script);
      assert.equal(input ?? null, null, 'nothing is uploaded to a Mac');
      return script === 'uname -sm' ? 'Darwin arm64\n' : '';
    };
    const sum = 'a'.repeat(64);
    const fetched = [];
    const fetchJson = async (url) => {
      fetched.push(url);
      return { platforms: { 'darwin-arm64': { checksum: sum } } };
    };
    const remote = createRemoteClaude({ executable: bin, home: async () => '/Users/me', ssh, log: () => {}, fetchJson });
    assert.equal(await remote.ensure({ id: 'mac', label: 'Mac', host: 'mac' }), '/Users/me/.local/share/harbor/claude-2.1.999');
    assert.deepEqual(fetched, [`${RELEASES}/2.1.999/manifest.json`]);
    const script = scripts.at(-1);
    assert.match(script, /curl -fsSL .*'https:\/\/storage\.googleapis\.com\/.*\/2\.1\.999\/darwin-arm64\/claude'/);
    assert.ok(script.includes(`= ${sum} ] && chmod 700`), 'installed only when the checksum matches');
    const none = createRemoteClaude({ executable: bin, home: async () => '/Users/me', ssh, log: () => {}, fetchJson: async () => ({ platforms: {} }) });
    await assert.rejects(none.ensure({ id: 'mac', label: 'Mac', host: 'mac' }), /no darwin-arm64 build/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('remote folder views', () => {
  const cluster = { id: 'alpha', label: 'Alpha', host: 'alpha-login' };

  test('@ candidates from git or a walk, without .env files', async () => {
    let answer = 'G\nsrc/a.js\0.env\0README.md\0';
    const files = createRemoteFiles({ ssh: async () => answer });
    assert.deepEqual(await files.entries(cluster, '/r'), [
      { path: 'src/a.js', directory: false },
      { path: 'src', directory: true },
      { path: 'README.md', directory: false },
    ]);
    answer = 'W\nd data\0f data/x.csv\0f .env.local\0';
    assert.deepEqual(await files.entries(cluster, '/r'), [
      { path: 'data', directory: true },
      { path: 'data/x.csv', directory: false },
    ]);
  });

  test('changes: branch, tracked diff and numstat, untracked listed without contents', async () => {
    const ssh = async (host, script) => {
      const boundary = /printf '\\n%s\\n' ([0-9a-f]+)/.exec(script)[1];
      const end = `\n${boundary}\n`;
      return ['main', ' M a.txt\0', 'diff --git a/a.txt b/a.txt\n+x', '1\t0\ta.txt\0', 'new.txt\0'].join(end);
    };
    const result = await createRemoteFiles({ ssh }).changes(cluster, '/r');
    assert.deepEqual(result.files, [
      { path: 'a.txt', status: 'modified', adds: 1, dels: 0 },
      { path: 'new.txt', status: 'untracked', adds: 0, dels: 0 },
    ]);
    assert.equal(result.branch, 'main');
    assert.equal(result.diff, 'diff --git a/a.txt b/a.txt\n+x');
    assert.equal(result.status, ' M a.txt\n?? new.txt\n');
    assert.ok(result.notice);
    const failing = createRemoteFiles({ ssh: async () => Promise.reject(Object.assign(new Error('x'), { code: 4, stderr: 'not a git repository' })) });
    assert.equal((await failing.changes(cluster, '/r')).error, 'This folder is not a Git repository.');
  });

  test('preview: a folder listing, a file, binary and missing files', async () => {
    let answer;
    const files = createRemoteFiles({ ssh: async () => Buffer.from(answer) });
    answer = 'D\nf b.txt\0d src\0f .env\0d node_modules\0';
    assert.deepEqual(await files.preview(cluster, '/r', 'sub'), {
      path: 'sub',
      directory: true,
      items: [
        { name: 'src', directory: true, path: 'sub/src' },
        { name: 'b.txt', directory: false, path: 'sub/b.txt' },
      ],
    });
    answer = 'F\nhello';
    assert.deepEqual(await files.preview(cluster, '/r', 'a.txt'), { path: 'a.txt', directory: false, content: 'hello' });
    answer = 'F\n\0\0';
    await assert.rejects(files.preview(cluster, '/r', 'a.bin'), /Binary/);
    answer = 'N\n';
    await assert.rejects(files.preview(cluster, '/r', 'gone'), /not found/);
  });
});
