import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createModelSettings } from '../server/model-settings.mjs';
import { catalogIdForModel, compactThreshold, contextSettings, findModel, sdkModelId, setContextLimits, setFastModes } from '../server/models.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'model-settings-'));

describe('model context limits', () => {
  after(() => setContextLimits({}));

  test('a gateway model tells Claude Code its window and compacts at 80% of it', () => {
    setContextLimits({});
    assert.deepEqual(contextSettings(findModel('astra')), { autoCompactWindow: 320_000, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000' } });
    // Claude Code takes compact windows up to 1M.
    setContextLimits({ deepseek: 1_000_000 });
    assert.equal(contextSettings(findModel('deepseek')).autoCompactWindow, 800_000);
    setContextLimits({});
    assert.equal(compactThreshold(findModel('astra')), 320_000 - 33_000);
  });

  test('a Claude model compacts by its 400k default; at its full window the user\'s own compact setting applies', () => {
    setContextLimits({});
    assert.deepEqual(contextSettings(findModel('opus')), { autoCompactWindow: 400_000, env: {} });
    setContextLimits({ opus: 1_000_000 });
    assert.deepEqual(contextSettings(findModel('opus')), { autoCompactWindow: undefined, env: {} });
    setContextLimits({ opus: 600_000 });
    assert.deepEqual(contextSettings(findModel('opus')), { autoCompactWindow: 600_000, env: {} });
    // Haiku is held to 400k (the user's choice): Claude Code is told so even at its max.
    assert.equal(findModel('haiku').maxContext, 400_000);
    assert.deepEqual(contextSettings(findModel('haiku')), { autoCompactWindow: 400_000, env: {} });
    setContextLimits({});
  });

  test('limits are saved, checked, reset and read back', () => {
    const dataDir = dir();
    const settings = createModelSettings({ dataDir });
    assert.equal(settings.get().models.find((m) => m.id === 'deepseek').contextWindow, 400_000, 'the user\'s default for DeepSeek');
    const after = settings.setContext({ deepseek: 300_000 });
    const deepseek = after.models.find((m) => m.id === 'deepseek');
    assert.deepEqual([deepseek.contextWindow, deepseek.maxContext, deepseek.custom], [300_000, 1_000_000, true]);
    assert.equal(findModel('deepseek').contextWindow, 300_000, 'the catalog follows');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'model-settings.json'), 'utf8')), { context: { deepseek: 300_000 } });

    for (const bad of [{ deepseek: 50_000 }, { deepseek: 2_000_000 }, { deepseek: 300_000.5 }, { deepseek: '300000' }, { nope: 300_000 }, null, []]) {
      assert.throws(() => settings.setContext(bad), (error) => error.status === 400, JSON.stringify(bad));
    }
    assert.equal(findModel('deepseek').contextWindow, 300_000, 'a refused change applies nothing');

    setContextLimits({});
    createModelSettings({ dataDir });
    assert.equal(findModel('deepseek').contextWindow, 300_000, 'read back at start');

    assert.equal(settings.setContext({ deepseek: null }).models.find((m) => m.id === 'deepseek').custom, false);
    assert.equal(findModel('deepseek').contextWindow, 400_000);
    settings.setContext({ astra: 400_000 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'model-settings.json'), 'utf8')), { context: {} }, 'its most is the default');
  });

  test('a broken file falls back to the defaults', () => {
    const dataDir = dir();
    fs.writeFileSync(path.join(dataDir, 'model-settings.json'), '{"context":{"deepseek":5,"kimi":200000}}');
    createModelSettings({ dataDir });
    assert.equal(findModel('deepseek').contextWindow, 400_000);
    assert.equal(findModel('kimi').contextWindow, 200_000);
    fs.writeFileSync(path.join(dataDir, 'model-settings.json'), 'not json');
    const original = console.error;
    console.error = () => {};
    try {
      createModelSettings({ dataDir });
    } finally {
      console.error = original;
    }
    assert.equal(findModel('kimi').contextWindow, 524_288);
  });
});

describe('fast mode', () => {
  after(() => setFastModes({}));

  test('a model in fast mode runs as its gateway fast name, and that name maps back', () => {
    setFastModes({});
    assert.equal(sdkModelId(findModel('sol')), 'codex/gpt-6.1-sol');
    setFastModes({ sol: true, opus: true, deepseek: true });
    assert.equal(sdkModelId(findModel('sol')), 'codex/gpt-6.1-sol+fast');
    assert.equal(sdkModelId(findModel('luna')), 'codex/gpt-6-luna');
    // Only models with a fast tier take it.
    assert.equal(sdkModelId(findModel('opus')), 'claude-opus-5-5');
    assert.equal(sdkModelId(findModel('deepseek')), 'litellm/DeepSeek-V4-Flash');
    assert.equal(catalogIdForModel('codex/gpt-6.1-sol+fast'), 'sol');
    assert.equal(catalogIdForModel('gpt-6.1-sol+fast'), 'sol');
  });

  test('is saved, read back, and only for models with a fast tier', () => {
    const dataDir = dir();
    const settings = createModelSettings({ dataDir });
    const data = settings.setFast({ sol: true });
    assert.equal(data.models.find((m) => m.id === 'sol').fast, true);
    assert.ok(data.models.find((m) => m.id === 'sol').fastNote);
    assert.equal(data.models.find((m) => m.id === 'opus').fastNote, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'model-settings.json'), 'utf8')).fast, { sol: true });
    assert.throws(() => settings.setFast({ opus: true }), /no fast mode/);
    assert.throws(() => settings.setFast({ sol: 'yes' }), /true or false/);
    assert.throws(() => settings.setFast({ nope: true }), /Unknown model/);
    setFastModes({});
    createModelSettings({ dataDir });
    assert.equal(findModel('sol').fast, true);
    settings.setFast({ sol: false });
    assert.equal(findModel('sol').fast, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'model-settings.json'), 'utf8')).fast, undefined);
  });
});
