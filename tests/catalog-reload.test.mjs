// The model catalog reloads in a running server (deploys without a restart).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as models from '../server/models.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-catalog-'));
const source = fs.readFileSync(new URL('../server/catalog.mjs', import.meta.url), 'utf8');
const original = new URL('../server/catalog.mjs', import.meta.url);

after(async () => {
  await models.reloadCatalog(original);
  fs.rmSync(dir, { recursive: true, force: true });
});

function catalogFile(name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return pathToFileURL(file);
}

test('a reloaded catalog replaces the live bindings and keeps the user\'s limits and fast choices', async () => {
  models.setContextLimits({ opus: 200_000 });
  models.setFastModes({ sol: true });
  const renamed = source.replace("name: 'Claude Opus 5.5'", "name: 'Claude Opus 5.5 (renamed)'");
  assert.notEqual(renamed, source);
  const result = await models.reloadCatalog(catalogFile('renamed.mjs', renamed));
  assert.ok(result.models.includes('opus'));
  assert.equal(models.findModel('opus').name, 'Claude Opus 5.5 (renamed)');
  assert.equal(models.MODELS.find((m) => m.id === 'opus').name, 'Claude Opus 5.5 (renamed)');
  assert.equal(models.findModel('opus').contextWindow, 200_000);
  assert.equal(models.findModel('sol').fast, true);
  assert.equal(models.sdkModelId(models.findModel('sol')), 'codex/gpt-6.1-sol+fast');
  models.setContextLimits({});
  models.setFastModes({});
});

test('a broken catalog is refused and the current one stays', async () => {
  const before = models.MODELS;
  await assert.rejects(models.reloadCatalog(catalogFile('syntax.mjs', 'export const MODELS = [')), SyntaxError);
  await assert.rejects(models.reloadCatalog(catalogFile('empty.mjs', 'export const MODELS = []; export const MODE_OPTIONS = [{}]; export const AGENT_HINTS = {};')), /non-empty array/);
  const noDefault = source.replace("id: 'opus'", "id: 'opus-x'");
  await assert.rejects(models.reloadCatalog(catalogFile('nodefault.mjs', noDefault)), /default model opus is missing/);
  assert.equal(models.MODELS, before);
});
