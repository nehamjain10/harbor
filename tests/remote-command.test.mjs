import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pickTunnelPort, remoteEnv, remoteLine, shQuote, sshSpawnArgs } from '../server/remote-command.mjs';

describe('shQuote', () => {
  test('a shell reads every argument back exactly', () => {
    const tricky = [
      'plain',
      'a b',
      "it's",
      'say "hi"',
      '$HOME',
      '`id`',
      '$(rm -rf /)',
      'line1\nline2',
      '{"a":"b c","d":["$x"]}',
      '',
      'héllo ☃ 日本語',
      'back\\slash',
      "''",
      '-n',
      '*?[a-z]',
    ];
    for (const value of tricky) {
      const out = execFileSync('sh', ['-c', `printf '%s\\n' ${shQuote(value)}`], { encoding: 'utf8' });
      assert.equal(out, `${value}\n`, JSON.stringify(value));
    }
  });

  test('quotes the empty string as a pair of quotes', () => {
    assert.equal(shQuote(''), "''");
    assert.equal(shQuote("a'b"), `'a'\\''b'`);
  });
});

describe('remoteEnv', () => {
  const home = os.homedir();

  test('forwards only the Claude Code settings that travel', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-1',
      ANTHROPIC_MODEL: 'opus',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
      ANTHROPIC_LOG: path.join(home, 'claude.log'),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      CLAUDE_CONFIG_DIR: '/elsewhere/.claude',
      CLAUDE_AGENT_SDK_VERSION: '1',
      DISABLE_TELEMETRY: '1',
      MAX_THINKING_TOKENS: 31999,
      MAX_THINKING_TOKENS_EXTRA: 'no',
      MCP_TIMEOUT: '30000',
      BASH_MAX_TIMEOUT_MS: '600000',
      API_TIMEOUT_MS: '120000',
      API_TIMEOUT_MSX: 'no',
      PATH: '/usr/bin',
      HOME: home,
      AWS_SECRET_ACCESS_KEY: 'nope',
    };
    assert.deepEqual(remoteEnv(env), {
      ANTHROPIC_API_KEY: 'sk-1',
      ANTHROPIC_MODEL: 'opus',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      CLAUDE_AGENT_SDK_VERSION: '1',
      DISABLE_TELEMETRY: '1',
      MAX_THINKING_TOKENS: '31999',
      MCP_TIMEOUT: '30000',
      BASH_MAX_TIMEOUT_MS: '600000',
      API_TIMEOUT_MS: '120000',
    });
  });

  test('drops absolute local paths, which do not exist on the other cluster', () => {
    const env = {
      ANTHROPIC_MODEL: 'opus',
      CLAUDE_CODE_DEBUG: path.join(home, '.claude', 'debug.log'),
      MCP_SERVER_CONFIG: '/tmp/mcp.json',
      BASH_ENV: '/tmp/env.sh',
      CLAUDE_CODE_TMP: '/tmpx',
    };
    assert.deepEqual(remoteEnv(env), { ANTHROPIC_MODEL: 'opus', CLAUDE_CODE_TMP: '/tmpx' });
  });

  test('is a new object and skips values that are not strings', () => {
    const env = { ANTHROPIC_MODEL: 'opus', ANTHROPIC_KEY: undefined, MCP_SERVERS: { a: 1 } };
    const out = remoteEnv(env);
    assert.notEqual(out, env);
    assert.deepEqual(out, { ANTHROPIC_MODEL: 'opus' });
    assert.equal(remoteEnv(undefined).constructor, Object);
    assert.deepEqual(remoteEnv(undefined), {});
  });
});

describe('pickTunnelPort', () => {
  test('stays in range and is the same for the same key and attempt', () => {
    for (const key of ['gpu01', 'a very long host name', '', 'ünïcode']) {
      const first = pickTunnelPort(key);
      assert.equal(pickTunnelPort(key), first);
      assert.ok(first >= 41000 && first <= 48999, String(first));
    }
  });

  test('a retry moves to another port', () => {
    assert.notEqual(pickTunnelPort('gpu01', 1), pickTunnelPort('gpu01', 0));
    assert.notEqual(pickTunnelPort('gpu01', 2), pickTunnelPort('gpu01', 1));
  });
});

describe('remoteLine', () => {
  test('cds, then execs the command with the environment quoted one argument at a time', () => {
    assert.equal(
      remoteLine({
        cwd: '/scratch/my project',
        env: { FOO: 'a b', MAX_THINKING_TOKENS: '31999' },
        command: '/opt/claude/bin/claude',
        args: ['--resume', 's 1', "it's"],
      }),
      `cd '/scratch/my project' && exec env 'FOO=a b' 'MAX_THINKING_TOKENS=31999' '/opt/claude/bin/claude' '--resume' 's 1' 'it'\\''s'`,
    );
  });

  test('remoteClaude replaces command; no env and no args are fine', () => {
    assert.equal(
      remoteLine({ cwd: '/x', command: 'claude', remoteClaude: '/home/me/.local/bin/claude', args: [] }),
      `cd '/x' && exec env '/home/me/.local/bin/claude'`,
    );
  });

  test('the line really runs: cwd and env arrive as given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-command-'));
    try {
      const line = remoteLine({
        cwd: dir,
        env: { FOO: 'a b' },
        command: '/bin/sh',
        args: ['-c', 'echo "$FOO|$(pwd)"'],
      });
      const out = execFileSync('sh', ['-c', line], { encoding: 'utf8' });
      assert.equal(out.trimEnd(), `a b|${fs.realpathSync(dir)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sshSpawnArgs', () => {
  const base = {
    host: 'gpu01',
    cwd: '/scratch/proj',
    env: { ANTHROPIC_MODEL: 'opus' },
    command: 'claude',
    args: ['--resume', 'abc'],
  };

  test('ssh with the fixed options, the host and one remote line, and no ControlMaster', () => {
    assert.deepEqual(sshSpawnArgs(base), {
      command: 'ssh',
      args: [
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=4',
        '-o', 'ExitOnForwardFailure=yes',
        'gpu01',
        '--',
        remoteLine(base),
      ],
    });
    assert.ok(!sshSpawnArgs(base).args.some((arg) => /ControlMaster/.test(arg)));
  });

  test('a tunnel adds the reverse forward before the host', () => {
    const { args } = sshSpawnArgs({ ...base, tunnel: { remotePort: 42001, localPort: 18544 } });
    const at = args.indexOf('-R');
    assert.ok(at > 0);
    assert.equal(args[at + 1], '127.0.0.1:42001:127.0.0.1:18544');
    assert.equal(args[at + 2], 'gpu01');
    assert.equal(args.at(-1), remoteLine(base));
  });
});
