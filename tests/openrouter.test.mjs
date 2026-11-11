// OpenRouter models: the ZDR list parsing, its cache, and `or:` ids in the server catalog.
// No network: fetch is injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import {
  catalogIdForModel,
  compactThreshold,
  contextSettings,
  findModel,
  isKnownModel,
  resolveEffort,
  sdkModelId,
  setContextLimits,
  turnMode,
  validEffort,
} from '../server/models.mjs';
import { createOpenRouterCatalog, isOpenRouterId, openRouterModels, parseOpenRouterModels, setOpenRouterModels } from '../server/openrouter.mjs';

const TOOLS = ['tools', 'tool_choice', 'max_tokens'];
const endpoint = (modelId, modelName, extra = {}) => ({
  model_id: modelId,
  model_name: modelName,
  context_length: 131_072,
  pricing: { prompt: '0.000002', completion: '0.000008' },
  provider_name: 'Somebody',
  supported_parameters: TOOLS,
  ...extra,
});

const ZDR = {
  data: [
    endpoint('moonshotai/kimi-k3.1-pro', 'MoonshotAI: Kimi K3.1 Pro', { context_length: 262_144, supported_parameters: [...TOOLS, 'reasoning'] }),
    // The cheapest endpoint sets the price; the largest context wins.
    endpoint('moonshotai/kimi-k3.1-pro', 'MoonshotAI: Kimi K3.1 Pro', { context_length: 1_048_576, pricing: { prompt: '0.00000095', completion: '0.000004' } }),
    endpoint('moonshotai/kimi-k3.1-pro', 'MoonshotAI: Kimi K3.1 Pro', { pricing: { prompt: '0.000003', completion: '0.00001' } }),
    endpoint('acme/tiny', 'Acme: Tiny'),
    endpoint('acme/tiny:free', 'Acme: Tiny (free)', { pricing: { prompt: '0', completion: '0' } }),
    // No tools on any ZDR endpoint: Claude Code cannot use it.
    endpoint('acme/embed', 'Acme: Embed', { supported_parameters: ['max_tokens'] }),
    endpoint('mancer/weaver', 'Mancer Weaver', { pricing: { prompt: '-1', completion: '-1' } }),
    endpoint('bad id', 'Bad'),
  ],
};
const MODELS = {
  data: [
    { id: 'moonshotai/kimi-k3.1-pro', architecture: { input_modalities: ['text', 'image', 'video'] } },
    { id: 'acme/tiny', architecture: { input_modalities: ['text'] } },
  ],
};

const KIMI = {
  id: 'or:moonshotai/kimi-k3.1-pro',
  vendor: 'MoonshotAI',
  name: 'Kimi K3.1 Pro',
  contextWindow: 1_048_576,
  vision: true,
  reasoning: true,
  price: { in: 0.95, out: 4 },
};

describe('OpenRouter list', () => {
  test('one entry per tool-taking ZDR model, no :free ones, prices per million, vision joined, sorted by name', () => {
    const list = parseOpenRouterModels(ZDR, MODELS);
    assert.deepEqual(
      list.map((model) => model.id),
      ['or:moonshotai/kimi-k3.1-pro', 'or:mancer/weaver', 'or:acme/tiny'],
    );
    assert.deepEqual(list[0], { ...KIMI, name: 'Kimi K3.1 Pro' });
    assert.deepEqual(list[2], { id: 'or:acme/tiny', name: 'Tiny', vendor: 'Acme', contextWindow: 131_072, vision: false, reasoning: false, price: { in: 2, out: 8 } });
    // No "Vendor: " prefix: the vendor comes from the id; no fixed price: null.
    assert.deepEqual([list[1].name, list[1].vendor, list[1].price], ['Mancer Weaver', 'mancer', { in: null, out: null }]);
    // A bare array works too, and without the model list nothing has vision.
    assert.equal(parseOpenRouterModels(ZDR.data, null)[0].vision, false);
    assert.deepEqual(parseOpenRouterModels(null, null), []);
  });

  test('isOpenRouterId takes or:vendor/model, not a bare prefix or a :free model', () => {
    for (const id of ['or:moonshotai/kimi-k3.1-pro', 'or:openai/gpt-6:extended', 'or:~anthropic/claude']) assert.ok(isOpenRouterId(id), id);
    for (const id of ['or:', 'or:kimi', 'or:a/b/c', 'or:acme/tiny:free', 'openrouter/acme/tiny', 'or: acme/tiny', null, 42]) assert.ok(!isOpenRouterId(id), String(id));
  });

  test('the catalog fetches, saves to the data dir, loads it back without network, and keeps it when a fetch fails', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-openrouter-'));
    const urls = [];
    const ok = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => (url.endsWith('/endpoints/zdr') ? ZDR : MODELS) };
    };
    const quiet = { error() {} };
    setOpenRouterModels([]);
    const catalog = createOpenRouterCatalog({ dataDir, fetchImpl: ok, log: quiet });
    const list = await catalog.list();
    assert.equal(list.length, 3);
    assert.deepEqual(urls.sort(), ['https://openrouter.ai/api/v1/endpoints/zdr', 'https://openrouter.ai/api/v1/models']);
    // A known list is not fetched again.
    await catalog.list();
    assert.equal(urls.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'openrouter-models.json'), 'utf8')).models.length, 3);

    setOpenRouterModels([]);
    const down = async () => {
      throw new Error('offline');
    };
    const offline = createOpenRouterCatalog({ dataDir, fetchImpl: down, log: quiet });
    assert.equal(offline.load(), true);
    assert.equal(openRouterModels().length, 3);
    assert.equal((await offline.refresh()).length, 3, 'a failed fetch keeps the list');
    // Without the model list (vision) the ZDR list still loads.
    setOpenRouterModels([]);
    const noModels = async (url) => (url.endsWith('/models') ? { ok: false, status: 500 } : { ok: true, json: async () => ZDR });
    assert.equal((await createOpenRouterCatalog({ fetchImpl: noModels, log: quiet }).refresh()).length, 3);
    assert.equal(openRouterModels()[0].vision, false);
  });
});

describe('or: models in the catalog', () => {
  beforeEach(() => {
    setOpenRouterModels(parseOpenRouterModels(ZDR, MODELS));
    setContextLimits({});
  });

  test('a listed model resolves to a gateway entry with its name, window (at most 1M), vision and efforts', () => {
    const model = findModel('or:moonshotai/kimi-k3.1-pro');
    assert.deepEqual(model, {
      id: 'or:moonshotai/kimi-k3.1-pro',
      name: 'Kimi K3.1 Pro',
      model: 'openrouter/moonshotai/kimi-k3.1-pro',
      provider: 'OpenRouter',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      description: 'MoonshotAI model through OpenRouter (zero data retention)',
      contextWindow: 1_000_000,
      maxContext: 1_000_000,
      defaultContext: 1_000_000,
      vision: true,
      modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    });
    assert.equal(findModel('or:moonshotai/kimi-k3.1-pro'), model, 'memoized');
    assert.equal(sdkModelId(model), 'openrouter/moonshotai/kimi-k3.1-pro');
    assert.deepEqual(contextSettings(model), { autoCompactWindow: 800_000, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } });
    assert.ok(compactThreshold(model) > 700_000);
    assert.equal(turnMode(model, 'auto'), 'default');
    assert.ok(validEffort(model.id, 'high'));
    assert.ok(!validEffort(model.id, 'max'));
    assert.equal(resolveEffort(model.id, {}), 'medium');
  });

  test('a model without reasoning has no effort to choose', () => {
    const tiny = findModel('or:acme/tiny');
    assert.deepEqual([tiny.efforts, tiny.defaultEffort, tiny.contextWindow, tiny.vision], [[], null, 131_072, false]);
    assert.equal(resolveEffort(tiny.id, {}), null);
  });

  test('an id the list does not know yet gets a 200k window, and the entry updates in place when the list does', () => {
    const later = findModel('or:newco/model-9');
    assert.deepEqual([later.name, later.model, later.contextWindow, later.efforts.length, later.vision], ['model-9', 'openrouter/newco/model-9', 200_000, 3, false]);
    setOpenRouterModels([...openRouterModels(), { id: 'or:newco/model-9', name: 'Model 9', vendor: 'NewCo', contextWindow: 400_000, vision: true, reasoning: false, price: { in: 1, out: 2 } }]);
    assert.equal(findModel('or:newco/model-9'), later);
    assert.deepEqual([later.name, later.contextWindow, later.efforts, later.vision], ['Model 9', 400_000, [], true]);
  });

  test('bogus ids are unknown; the user context limits apply to or: models too', () => {
    for (const id of ['or:', 'or:kimi', 'or:acme/tiny:free']) {
      assert.equal(findModel(id), undefined, id);
      assert.equal(isKnownModel(id), false, id);
    }
    assert.ok(isKnownModel('or:acme/tiny'));
    setContextLimits({ 'or:acme/tiny': 100_000, 'or:moonshotai/kimi-k3.1-pro': 5_000_000 });
    assert.equal(findModel('or:acme/tiny').contextWindow, 100_000);
    assert.equal(findModel('or:moonshotai/kimi-k3.1-pro').contextWindow, 1_000_000, 'out of range: the default');
    setContextLimits({});
    assert.equal(findModel('or:acme/tiny').contextWindow, 131_072);
  });

  test('transcript model names map back to catalog ids, the fixed entries first', () => {
    assert.equal(catalogIdForModel('openrouter/moonshotai/kimi-k3.1-pro'), 'kimi31');
    assert.equal(catalogIdForModel('openrouter/google/gemini-4-argon'), 'argon');
    assert.equal(catalogIdForModel('openrouter/acme/tiny'), 'or:acme/tiny');
    assert.equal(catalogIdForModel('openrouter/acme'), undefined);
  });

  test('the fixed OpenRouter entries are ordinary gateway catalog models', () => {
    for (const id of ['kimi31', 'argon']) {
      const model = findModel(id);
      assert.equal(model.provider, 'OpenRouter');
      assert.match(model.model, /^openrouter\//);
      assert.equal(model.contextWindow, 1_048_576);
      assert.deepEqual(contextSettings(model).env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576' });
    }
  });
});
