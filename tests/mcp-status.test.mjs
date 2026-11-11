import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  authKind,
  disabledServers,
  mcpDenyRules,
  normalizeServerName,
  parseCallbackUrl,
  parseHiddenServers,
  publicServer,
  publicServers,
  publicUrl,
  scrubError,
  serverGroup,
} from '../server/mcp-status.mjs';

describe('server names inside tool names', () => {
  test('anything outside letters, digits, _ and - becomes _; claude.ai connectors also collapse and trim', () => {
    assert.equal(normalizeServerName('plugin:slack:slack'), 'plugin_slack_slack');
    assert.equal(normalizeServerName('my-server_2'), 'my-server_2');
    assert.equal(normalizeServerName('a b.c'), 'a_b_c');
    assert.equal(normalizeServerName('claude.ai Slack'), 'claude_ai_Slack');
    assert.equal(normalizeServerName('claude.ai Apollo.io'), 'claude_ai_Apollo_io');
    assert.equal(normalizeServerName('claude.ai  Hex!'), 'claude_ai_Hex');
  });

  test('deny rules name each server once, as the CLI prefixes its tools', () => {
    assert.deepEqual(mcpDenyRules(['claude.ai Slack', 'plugin:slack:slack', 'claude.ai Slack']), ['mcp__claude_ai_Slack', 'mcp__plugin_slack_slack']);
    assert.deepEqual(mcpDenyRules([]), []);
    assert.deepEqual(mcpDenyRules(undefined), []);
  });

  test('the disabled list is clean text without duplicates', () => {
    assert.deepEqual(disabledServers({ mcpDisabled: ['a', 'a', '', 7, 'b'] }), ['a', 'b']);
    assert.deepEqual(disabledServers({}), []);
    assert.deepEqual(disabledServers(undefined), []);
  });
});

describe('grouping and sign-in kinds', () => {
  const rows = {
    connector: { name: 'claude.ai Slack', status: 'needs-auth', scope: 'claudeai', source: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://mcp.slack.com/mcp', id: 'mcpsrv_1' } },
    plugin: { name: 'plugin:slack:slack', status: 'needs-auth', scope: 'dynamic', source: 'plugin', config: { type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: 'x', callbackPort: 3118 } } },
    project: { name: 'echo', status: 'connected', scope: 'project', source: 'project', config: { type: 'stdio', command: 'node' } },
    user: { name: 'comet', status: 'connected', scope: 'user', source: 'user', config: { type: 'http', url: 'https://comet.example/mcp' } },
    local: { name: 'scratch', status: 'failed', scope: 'local', source: 'local', config: { type: 'sse', url: 'https://x.example/sse' } },
    builtin: { name: 'meshy', status: 'connected', tools: [] },
    other: { name: 'dyn', status: 'connected', scope: 'dynamic', config: { type: 'stdio' } },
  };

  test('claude.ai connectors, plugins, user/project/local config, built-in and the rest', () => {
    assert.deepEqual(
      Object.values(rows).map(serverGroup),
      ['claudeai', 'plugin', 'project', 'user', 'local', 'builtin', 'other'],
    );
  });

  test('connectors sign in on claude.ai, http and sse servers by OAuth, local commands cannot', () => {
    assert.deepEqual(Object.values(rows).map(authKind), ['claudeai', 'oauth', null, 'oauth', 'oauth', null, null]);
  });
});

describe('public rows never carry secrets', () => {
  test('an http server shows its address without query, credentials or fragment; headers and env never appear', () => {
    assert.equal(publicUrl({ type: 'http', url: 'https://user:pw@mcp.example.com/v1/mcp?token=SECRET#frag' }), 'https://mcp.example.com/v1/mcp');
    assert.equal(publicUrl({ type: 'sse', url: 'https://sse.example.com/events' }), 'https://sse.example.com/events');
    assert.equal(publicUrl({ type: 'stdio', command: 'node' }), undefined);
    assert.equal(publicUrl({ type: 'claudeai-proxy', url: 'https://mcp.slack.com/mcp' }), undefined);
    assert.equal(publicUrl({ type: 'http', url: 'not a url' }), undefined);
    assert.equal(publicUrl(undefined), undefined);

    const row = publicServer({
      name: 'secretive',
      status: 'failed',
      scope: 'user',
      source: 'user',
      error: 'connect ECONNREFUSED https://mcp.example.com/v1?apiKey=SECRET with Bearer abc.def-123',
      config: { type: 'http', url: 'https://mcp.example.com/v1?apiKey=SECRET', headers: { Authorization: 'Bearer SECRET' }, oauth: { clientId: 'SECRET' } },
      serverInfo: { name: 'Secretive', version: '1.2' },
      tools: [{ name: 'a', description: 'Does a.', annotations: { readOnly: true } }, { name: 'b', annotations: { destructive: true } }],
    });
    assert.doesNotMatch(JSON.stringify(row), /SECRET|abc\.def/);
    assert.deepEqual(row, {
      name: 'secretive',
      status: 'failed',
      scope: 'user',
      source: 'user',
      group: 'user',
      type: 'http',
      url: 'https://mcp.example.com/v1',
      error: 'connect ECONNREFUSED https://mcp.example.com/v1 with Bearer …',
      serverInfo: { name: 'Secretive', version: '1.2' },
      tools: [
        { name: 'a', description: 'Does a.', readOnly: true },
        { name: 'b', description: '', destructive: true },
      ],
      toolCount: 2,
      builtin: false,
      disabledInSession: false,
      auth: 'oauth',
    });
    const stdio = publicServer({ name: 'local', status: 'connected', scope: 'project', config: { type: 'stdio', command: '/bin/x', args: ['--key', 'SECRET'], env: { K: 'SECRET' } } });
    assert.doesNotMatch(JSON.stringify(stdio), /SECRET|\/bin\/x/);
    assert.equal(stdio.type, 'stdio');
  });

  test('errors are cut short and only failed servers carry one', () => {
    assert.equal(scrubError('x'.repeat(500)).length, 300);
    assert.equal(scrubError('  two\n lines  '), 'two lines');
    assert.equal(scrubError(''), undefined);
    assert.equal('error' in publicServer({ name: 'a', status: 'connected', error: 'stale' }), false);
  });

  test('the built-in server is never switchable; other servers show this session’s switch', () => {
    const list = publicServers(
      [
        { name: 'meshy', status: 'connected' },
        { name: 'claude.ai Gmail', status: 'connected', config: { type: 'claudeai-proxy' }, tools: [{ name: 'search' }] },
        { name: 'plugin:slack:slack', status: 'needs-auth', config: { type: 'http', url: 'https://mcp.slack.com/mcp' } },
        null,
      ],
      { mcpDisabled: ['meshy', 'claude.ai Gmail'] },
    );
    assert.deepEqual(list.map((s) => [s.name, s.builtin, s.disabledInSession, s.type]), [
      ['meshy', true, false, 'sdk'],
      ['claude.ai Gmail', false, true, 'claudeai-proxy'],
      ['plugin:slack:slack', false, false, 'http'],
    ]);
  });
});

describe('the pasted sign-in address', () => {
  const ok = 'http://localhost:3118/callback?code=abc&state=xyz';

  test('accepts the localhost callback the browser failed to open', () => {
    assert.deepEqual(parseCallbackUrl(ok), { ok: true, url: ok, code: true, state: 'xyz' });
    assert.equal(parseCallbackUrl('  ' + ok + '\n').url, ok);
    assert.equal(parseCallbackUrl(`"${ok}"`).url, ok);
    assert.equal(parseCallbackUrl(`<${ok}>`).url, ok);
    assert.equal(parseCallbackUrl('http://127.0.0.1:54321/callback?code=1&state=2').ok, true);
    assert.equal(parseCallbackUrl('https://localhost/callback?code=1').ok, true);
    assert.equal(parseCallbackUrl('http://[::1]:3118/callback?code=1').ok, true);
  });

  test('an error answer is valid in form (the server explains it); the code is flagged missing', () => {
    assert.deepEqual(parseCallbackUrl('http://localhost:3118/callback?error=access_denied&state=s'), { ok: true, url: 'http://localhost:3118/callback?error=access_denied&state=s', code: false, error: 'access_denied', state: 's' });
  });

  test('refuses everything else with a plain reason', () => {
    const bad = (value) => {
      const result = parseCallbackUrl(value);
      assert.equal(result.ok, false, String(value));
      assert.ok(result.error.length > 10);
      return result.error;
    };
    bad(undefined);
    bad(42);
    bad('');
    bad('   ');
    bad('abc');
    bad('ftp://localhost/callback?code=1');
    bad('javascript:alert(1)');
    assert.match(bad('https://slack.com/oauth/v2/authorize?code=1'), /localhost/);
    assert.match(bad('http://evil.example/callback?code=1'), /localhost/);
    assert.match(bad('http://localhost.evil.example/callback?code=1'), /localhost/);
    assert.match(bad('http://localhost:3118/callback'), /no code/);
    assert.match(bad('http://localhost:3118/callback?state=x'), /no code/);
    assert.match(bad(`${ok} and more`), /one line/);
    assert.match(bad('http://localhost:3118/callback?code=' + 'a'.repeat(5000)), /too long/);
  });

  test('the reasons never repeat the pasted address (it holds the authorization code)', () => {
    for (const value of ['http://localhost:3118/callback', 'http://evil.example/?code=SECRETCODE', 'SECRETCODE']) {
      assert.doesNotMatch(parseCallbackUrl(value).error ?? '', /SECRETCODE|3118/);
    }
  });
});

describe('servers Claude Code leaves out as duplicates', () => {
  const log = [
    '2026-10-12T18:50:27.800Z [DEBUG] [MCP] Connecting to something',
    '2026-10-12T18:50:27.816Z [DEBUG] [MCP] Lazy dedup: suppressing 2 plugin server(s) that duplicate claude.ai connectors: plugin:slack:slack, plugin:other:other',
    '2026-10-12T18:50:27.828Z [DEBUG] Suppressing claude.ai connector "claude.ai Slack": duplicates manually-configured "plugin:slack:slack"',
    '2026-10-12T18:50:27.829Z [DEBUG] Suppressing claude.ai connector "claude.ai Slack": duplicates manually-configured "plugin:slack:slack"',
  ].join('\n');

  test('the debug log names them with the reason', () => {
    assert.deepEqual(parseHiddenServers(log), [
      { name: 'plugin:slack:slack', reason: 'It has the same address as a claude.ai connector.' },
      { name: 'plugin:other:other', reason: 'It has the same address as a claude.ai connector.' },
      { name: 'claude.ai Slack', reason: 'It has the same address as plugin:slack:slack.' },
    ]);
  });

  test('nothing in the log, or no log, means nothing hidden; the list is bounded', () => {
    assert.deepEqual(parseHiddenServers('just text\n[DEBUG] [MCP] ok'), []);
    assert.deepEqual(parseHiddenServers(undefined), []);
    const many = `Lazy dedup: suppressing 30 plugin server(s) that duplicate claude.ai connectors: ${Array.from({ length: 30 }, (_, i) => `plugin:p${i}:p${i}`).join(', ')}`;
    assert.equal(parseHiddenServers(many).length, 10);
  });
});
