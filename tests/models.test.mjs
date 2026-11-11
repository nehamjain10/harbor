import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_GATEWAY, REPO_DIR, loadConfig, parseSettingSources } from '../server/config.mjs';
import {
  MODELS,
  MODE_OPTIONS,
  findModel,
  modelSwitchNote,
  resolveEffort,
  sdkEnv,
  sdkModelId,
  systemPromptAppend,
  turnMode,
  validEffort,
} from '../server/models.mjs';

describe('model catalog', () => {
  test('lists the models in catalog order, v1 fields first, then capabilities', () => {
    assert.deepEqual(MODELS.map((model) => model.id), ['opus', 'sonnet', 'fable', 'haiku', 'sol', 'terra', 'astra', 'luna', 'deepseek', 'grok', 'kimi', 'kimi31', 'argon']);
    for (const model of MODELS) {
      assert.deepEqual(Object.keys(model), [
        'id', 'name', 'model', 'provider', 'efforts', 'defaultEffort', 'description', 'contextWindow', 'maxContext', 'defaultContext', 'vision', 'modes',
        // Codex's Fast mode, on the models that have it.
        ...(['sol', 'terra', 'astra', 'luna'].includes(model.id) ? ['fastNote', 'fast'] : []),
      ]);
      // A model with a fixed variant has no effort to choose.
      if (model.efforts.length) assert.ok(model.efforts.includes(model.defaultEffort), model.id);
      assert.ok(model.description.length > 10, model.id);
    }
  });

  test('capabilities: context window, vision and modes per route', () => {
    const table = Object.fromEntries(MODELS.map((m) => [m.id, [m.contextWindow, m.vision, m.modes.includes('auto')]]));
    assert.deepEqual(table, {
      opus: [400_000, true, true],
      sonnet: [400_000, true, true],
      fable: [400_000, true, true],
      haiku: [400_000, true, true],
      sol: [500_000, true, false],
      terra: [400_000, true, false],
      astra: [400_000, true, false],
      luna: [400_000, true, false],
      deepseek: [400_000, true, false],
      kimi: [524_288, true, false],
      grok: [400_000, true, false],
      kimi31: [1_048_576, true, false],
      argon: [1_048_576, true, false],
    });
    assert.deepEqual(MODE_OPTIONS.map((mode) => mode.id), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    for (const mode of MODE_OPTIONS) assert.deepEqual(Object.keys(mode), ['id', 'label', 'description']);
  });

  test('turnMode keeps modes the model offers and falls back to default', () => {
    assert.equal(turnMode(findModel('opus'), 'auto'), 'auto');
    assert.equal(turnMode(findModel('deepseek'), 'auto'), 'default');
    assert.equal(turnMode(findModel('deepseek'), 'bypassPermissions'), 'bypassPermissions');
    assert.equal(turnMode(findModel('deepseek'), 'nonsense'), 'default');
  });

  test('systemPromptAppend names the model, and adds the tool hint for gateway routes only', () => {
    assert.equal(
      systemPromptAppend(findModel('luna')),
      'Model identity: you are GPT-6 Luna (route codex/gpt-6-luna, provider OpenAI), selected by the user in Harbor. ' +
        'If a later "[Harbor: ...]" note in the conversation says the user switched models, that note is current.\n' +
        'When calling tools, send arguments with their correct JSON types and omit optional parameters you are not using (never send empty strings).',
    );
    assert.doesNotMatch(systemPromptAppend(findModel('sonnet')), /When calling tools/);
    assert.match(systemPromptAppend(findModel('sonnet')), /^Model identity: you are Claude Sonnet 5\.5 \(route claude\/claude-sonnet-5-5, provider Claude\)/);
  });

  test('modelSwitchNote names the new and the previous model, with the tool hint for gateway models', () => {
    assert.equal(
      modelSwitchNote(findModel('deepseek'), 'luna'),
      '[Harbor: from this message on you are DeepSeek V4.1 Flash (route litellm/DeepSeek-V4-Flash, provider DeepSeek); ' +
        'earlier turns in this conversation ran on GPT-6 Luna. ' +
        'When calling tools, send arguments with their correct JSON types and omit optional parameters you are not using (never send empty strings).]',
    );
    assert.equal(
      modelSwitchNote(findModel('opus'), 'deepseek'),
      '[Harbor: from this message on you are Claude Opus 5.5 (route claude/claude-opus-5-5, provider Claude); ' +
        'earlier turns in this conversation ran on DeepSeek V4.1 Flash.]',
    );
    assert.match(modelSwitchNote(findModel('opus'), 'retired-model'), /ran on retired-model\.\]$/, 'unknown ids are named as they are');
  });

  test('Claude models drop the claude/ prefix, gateway models keep their route', () => {
    assert.equal(sdkModelId(findModel('opus')), 'claude-opus-5-5');
    assert.equal(sdkModelId(findModel('fable')), 'claude-fable-5-2');
    assert.equal(sdkModelId(findModel('astra')), 'codex/gpt-6-astra');
    assert.equal(sdkModelId(findModel('kimi')), 'litellm/SGLang-Kimi-K3');
  });
});

describe('validEffort', () => {
  test('accepts default for any model', () => {
    for (const model of MODELS) assert.equal(validEffort(model.id, 'default'), true);
  });

  test('accepts only the efforts a model lists', () => {
    assert.equal(validEffort('opus', 'xhigh'), true);
    assert.equal(validEffort('opus', 'max'), true);
    assert.equal(validEffort('deepseek', 'medium'), false);
    assert.equal(validEffort('deepseek', 'low'), false);
    assert.equal(validEffort('kimi', 'low'), true);
    assert.equal(validEffort('deepseek', 'high'), true);
    assert.equal(validEffort('kimi', 'xhigh'), false);
  });

  test('rejects unknown models and values', () => {
    assert.equal(validEffort('gpt-2', 'high'), false);
    assert.equal(validEffort('opus', 'extreme'), false);
    assert.equal(validEffort('opus', undefined), false);
    assert.equal(validEffort('opus', ''), false);
  });
});

describe('resolveEffort', () => {
  test('uses the model default unless a concrete effort was chosen', () => {
    assert.equal(resolveEffort('opus', undefined), 'medium');
    assert.equal(resolveEffort('opus', { opus: 'default' }), 'medium');
    assert.equal(resolveEffort('sonnet', { opus: 'max' }), 'high');
    assert.equal(resolveEffort('opus', { opus: 'max' }), 'max');
  });
});

describe('sdkEnv', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'sk-real',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    CLAUDE_CODE_OAUTH_TOKEN: 'token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDECODE: '1',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CONFIG_DIR: '/home/me/.claude',
  };

  const TODO_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' };
  const ARTIFACT_ENV = { CLAUDE_CODE_ARTIFACT: '1' };

  test('direct runs strip every provider and auth override', () => {
    const env = sdkEnv(true, { gatewayUrl: 'http://gateway' }, baseEnv);
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CONFIG_DIR: '/home/me/.claude', ...TODO_ENV, ...ARTIFACT_ENV });
  });

  test('gateway runs point at the given endpoint and key', () => {
    const env = sdkEnv(false, { gatewayUrl: 'http://127.0.0.1:18999', apiKey: 'proxy-secret' }, baseEnv);
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18999');
    assert.equal(env.ANTHROPIC_API_KEY, 'proxy-secret');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude/claude-opus-5-5');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude/claude-haiku-5-5');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1', 'headless sessions get the TodoWrite checklist');
    assert.equal(env.CLAUDE_CODE_ENABLE_TASKS, '0');
    assert.equal(env.CLAUDE_CODE_ARTIFACT, '1', 'artifacts on, as in the desktop app');
  });

  test('host Claude Code session plumbing never reaches the child CLI', () => {
    const host = {
      ...baseEnv,
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-sock',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'xhigh',
      AI_AGENT: 'claude-code',
      USE_LOCAL_OAUTH: '',
    };
    for (const direct of [true, false]) {
      const leaked = Object.keys(sdkEnv(direct, { gatewayUrl: 'http://x', apiKey: 'k' }, host)).filter(
        (key) => (key.startsWith('CLAUDE') || key === 'AI_AGENT' || key.endsWith('_OAUTH')) && !(key in TODO_ENV) && !(key in ARTIFACT_ENV) && key !== 'CLAUDE_CONFIG_DIR',
      );
      assert.deepEqual(leaked, [], `direct=${direct}`);
    }
  });

  test('defaults to the local gateway and the placeholder key', () => {
    const env = sdkEnv(false, undefined, {});
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3425');
    assert.equal(env.ANTHROPIC_API_KEY, 'harbor');
  });

  test('a Claude config dir override replaces CLAUDE_CONFIG_DIR for both routes', () => {
    assert.equal(sdkEnv(true, { claudeConfigDir: '/tmp/cfg' }, baseEnv).CLAUDE_CONFIG_DIR, '/tmp/cfg');
    assert.equal(sdkEnv(false, { claudeConfigDir: '/tmp/cfg' }, baseEnv).CLAUDE_CONFIG_DIR, '/tmp/cfg');
  });

  test('does not modify the source environment', () => {
    const source = { ...baseEnv };
    sdkEnv(false, { gatewayUrl: 'http://x' }, source);
    assert.deepEqual(source, baseEnv);
  });
});

describe('loadConfig', () => {
  const required = { WORKBENCH_OWNER: 'me@example.com', WORKBENCH_HOST: 'host.example:18544' };

  test('requires owner and host', () => {
    assert.throws(() => loadConfig({}), /WORKBENCH_OWNER and WORKBENCH_HOST are required/);
    assert.throws(() => loadConfig({ WORKBENCH_OWNER: 'me' }), /required/);
  });

  test('defaults to the repo data dir, repo socket and local gateway', () => {
    const config = loadConfig(required);
    assert.equal(config.origin, 'https://host.example:18544');
    assert.equal(config.dataDir, path.join(REPO_DIR, 'data'));
    assert.equal(config.socketPath, path.join(REPO_DIR, 'web.sock'));
    assert.equal('port' in config, false, 'no TCP mode');
    assert.equal(config.gatewayUrl, DEFAULT_GATEWAY);
    assert.equal(config.claudeExecutable, path.join(config.homeRoot, '.local/bin/claude'));
  });

  test('loads every Claude Code settings source unless told otherwise', () => {
    const config = loadConfig(required);
    assert.deepEqual(config.settingSources, ['user', 'project', 'local']);
    assert.equal(config.claudeConfigDir, undefined);
    const isolated = loadConfig({ ...required, WORKBENCH_SETTING_SOURCES: 'project', WORKBENCH_CLAUDE_CONFIG_DIR: '/tmp/stage/claude' });
    assert.deepEqual(isolated.settingSources, ['project']);
    assert.equal(isolated.claudeConfigDir, '/tmp/stage/claude');
  });

  test('parseSettingSources accepts lists, none, and rejects unknown names', () => {
    assert.deepEqual(parseSettingSources('none'), []);
    assert.deepEqual(parseSettingSources(' user , local '), ['user', 'local']);
    assert.deepEqual(parseSettingSources(''), ['user', 'project', 'local']);
    assert.throws(() => parseSettingSources('user,global'), /unknown source global/);
  });

  test('honours staging overrides', () => {
    const config = loadConfig({
      ...required,
      WORKBENCH_DATA_DIR: '/tmp/stage/data',
      WORKBENCH_SOCKET: '/tmp/stage/web.sock',
      WORKBENCH_PORT: '18950',
      WORKBENCH_GATEWAY: 'http://127.0.0.1:18951/',
    });
    assert.equal(config.dataDir, '/tmp/stage/data');
    assert.equal(config.socketPath, '/tmp/stage/web.sock');
    assert.equal('port' in config, false, 'WORKBENCH_PORT is ignored');
    assert.equal(config.gatewayUrl, 'http://127.0.0.1:18951');
  });
});
