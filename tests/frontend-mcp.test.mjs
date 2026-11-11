import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ago, chipServers, chipTitle, displayName, filterServers, groupOfName, groupServers, looksLikeCallback, statusLabel, statusTone, summarize, toolLabel } from '../src/lib/mcp.js';

const server = (name, status, group, extra = {}) => ({ name, status, group, tools: [], toolCount: 0, builtin: group === 'builtin', disabledInSession: false, ...extra });

describe('names and statuses', () => {
  test('plugin servers show the server and the plugin; connectors lose the claude.ai prefix', () => {
    assert.deepEqual(displayName({ name: 'plugin:slack:slack' }), { title: 'slack', context: 'plugin' });
    assert.deepEqual(displayName({ name: 'plugin:github:issues' }), { title: 'issues', context: 'plugin github' });
    assert.deepEqual(displayName({ name: 'claude.ai Slack' }), { title: 'Slack', context: '' });
    assert.deepEqual(displayName({ name: 'echo' }), { title: 'echo', context: '' });
    assert.deepEqual(displayName(undefined), { title: '', context: '' });
  });

  test('status words and dot colours, with the session’s switch winning', () => {
    assert.equal(statusLabel(server('a', 'connected', 'user')), 'Connected');
    assert.equal(statusLabel(server('a', 'needs-auth', 'user')), 'Needs sign-in');
    assert.equal(statusLabel(server('a', 'pending', 'user')), 'Connecting…');
    assert.equal(statusLabel(server('a', 'disabled', 'user')), 'Off in Claude Code');
    assert.equal(statusLabel(server('a', 'connected', 'user', { disabledInSession: true })), 'Off for this session');
    assert.equal(statusLabel(server('a', 'odd', 'user')), 'odd');
    assert.deepEqual(
      ['connected', 'pending', 'needs-auth', 'failed', 'disabled'].map((status) => statusTone(server('a', status, 'user'))),
      ['ok', 'busy', 'warn', 'bad', 'off'],
    );
    assert.equal(statusTone(server('a', 'failed', 'user', { disabledInSession: true })), 'off');
  });
});

describe('the list', () => {
  const rows = [
    server('meshy', 'connected', 'builtin'),
    server('claude.ai Slack', 'needs-auth', 'claudeai'),
    server('claude.ai Gmail', 'connected', 'claudeai', { tools: [{ name: 'search_threads' }], toolCount: 1 }),
    server('wiki', 'failed', 'user', { url: 'https://wiki.example.com/mcp' }),
    server('plugin:slack:slack', 'needs-auth', 'plugin', { url: 'https://mcp.slack.com/mcp' }),
    server('echo', 'connected', 'project'),
    server('claude.ai Asana', 'connected', 'claudeai'),
    server('stray', 'connected', undefined),
  ];

  test('groups in a fixed order, connected first and then by name; empty groups left out', () => {
    const groups = groupServers(rows);
    assert.deepEqual(groups.map((group) => [group.id, group.servers.map((row) => row.name)]), [
      ['claudeai', ['claude.ai Asana', 'claude.ai Gmail', 'claude.ai Slack']],
      ['plugin', ['plugin:slack:slack']],
      ['user', ['wiki']],
      ['project', ['echo']],
      ['other', ['stray']],
      ['builtin', ['meshy']],
    ]);
    assert.deepEqual(groupServers([]), []);
    assert.deepEqual(groupServers(undefined), []);
  });

  test('the filter matches the name, the address and the tools, every word', () => {
    const names = (query) => filterServers(rows, query).map((row) => row.name);
    assert.deepEqual(names('slack'), ['claude.ai Slack', 'plugin:slack:slack']);
    assert.deepEqual(names('SLACK plugin'), ['plugin:slack:slack'], 'case does not matter and every word has to match');
    assert.deepEqual(names('slack gmail'), []);
    assert.deepEqual(names('wiki.example'), ['wiki']);
    assert.deepEqual(names('search threads'), ['claude.ai Gmail']);
    assert.deepEqual(names('search_threads'), ['claude.ai Gmail']);
    assert.equal(filterServers(rows, '   ').length, rows.length);
    assert.equal(filterServers(rows).length, rows.length);
  });
});

describe('the topbar chip', () => {
  test('counts connected servers except Harbor’s own and the ones switched off', () => {
    const rows = [
      server('meshy', 'connected', 'builtin'),
      server('echo', 'connected', 'project'),
      server('off', 'connected', 'user', { disabledInSession: true }),
      server('claude.ai Gmail', 'connected', 'claudeai'),
    ];
    assert.deepEqual(summarize(rows), { connected: 2, attention: 0, total: 3 });
  });

  test('a failed server needs attention, so does a plugin that needs a sign-in; an unconnected claude.ai connector does not', () => {
    const rows = [
      server('claude.ai Slack', 'needs-auth', 'claudeai'),
      server('claude.ai Linear', 'needs-auth', 'claudeai'),
      server('plugin:slack:slack', 'needs-auth', 'plugin'),
      server('wiki', 'failed', 'user'),
      server('quiet', 'failed', 'user', { disabledInSession: true }),
    ];
    assert.deepEqual(summarize(rows), { connected: 0, attention: 2, total: 5 });
    assert.deepEqual(summarize([]), { connected: 0, attention: 0, total: 0 });
    assert.deepEqual(summarize(undefined), { connected: 0, attention: 0, total: 0 });
  });

  test('until a list was fetched the chip uses what the process reported at start', () => {
    assert.equal(groupOfName('meshy'), 'builtin');
    assert.equal(groupOfName('claude.ai Slack'), 'claudeai');
    assert.equal(groupOfName('plugin:slack:slack'), 'plugin');
    assert.equal(groupOfName('echo'), 'other');
    const session = { mcp: [{ name: 'meshy', status: 'connected' }, { name: 'echo', status: 'connected' }, { name: 'plugin:slack:slack', status: 'needs-auth' }], mcpDisabled: ['echo'] };
    assert.deepEqual(summarize(chipServers(session, null)), { connected: 0, attention: 1, total: 2 });
    assert.deepEqual(chipServers(session, [{ name: 'x', status: 'connected' }]), [{ name: 'x', status: 'connected' }], 'a fetched list wins');
    assert.deepEqual(chipServers(undefined, undefined), []);
  });

  test('tooltip and plural', () => {
    assert.equal(chipTitle({ connected: 0, attention: 0, total: 0 }), 'MCP servers: none configured (/mcp)');
    assert.equal(chipTitle({ connected: 0, attention: 0, total: 0 }, true), 'MCP servers (/mcp)');
    assert.equal(chipTitle({ connected: 2, attention: 1, total: 5 }), 'MCP servers: 2 of 5 connected, 1 needs attention (/mcp)');
    assert.equal(chipTitle({ connected: 2, attention: 2, total: 5 }), 'MCP servers: 2 of 5 connected, 2 need attention (/mcp)');
  });
});

describe('small helpers', () => {
  test('the pasted address looks like the localhost callback', () => {
    assert.equal(looksLikeCallback('http://localhost:3118/callback?code=abc&state=s'), true);
    assert.equal(looksLikeCallback('  "http://127.0.0.1:54321/callback?state=s&code=abc"  '), true);
    assert.equal(looksLikeCallback('http://localhost:3118/callback?error=access_denied&state=s'), true);
    assert.equal(looksLikeCallback('https://slack.com/oauth/v2/authorize?code=abc'), false);
    assert.equal(looksLikeCallback('http://localhost:3118/callback'), false);
    assert.equal(looksLikeCallback('code=abc'), false);
    assert.equal(looksLikeCallback(undefined), false);
  });

  test('tool names and times read as text', () => {
    assert.equal(toolLabel('search_threads'), 'search threads');
    const now = 1_000_000_000;
    assert.equal(ago(now - 5_000, now), 'just now');
    assert.equal(ago(now - 45_000, now), '45 s ago');
    assert.equal(ago(now - 5 * 60_000, now), '5 min ago');
    assert.equal(ago(now - 3 * 3_600_000, now), '3 h ago');
    assert.equal(ago(now + 5_000, now), 'just now');
  });
});
