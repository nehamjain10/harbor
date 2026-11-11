// OpenRouter models for the picker's side menu. The gateway forces zero data retention on every
// OpenRouter request, so only models with a ZDR endpoint answer; and Claude Code always
// sends tools, so only endpoints that take tools count. The list comes from OpenRouter's
// public ZDR endpoint list (vision from its model list), refreshed every 6 h, kept in
// memory and in <data dir>/openrouter-models.json so a restart without network still
// knows the models. A session runs one as `or:<openrouter id>` (models.mjs findModel).
import fs from 'node:fs';
import path from 'node:path';

export const OPENROUTER_PREFIX = 'or:';
const ZDR_URL = 'https://openrouter.ai/api/v1/endpoints/zdr';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FILE = 'openrouter-models.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
// An OpenRouter model id: `vendor/model`, optionally with a `:variant`.
const ID_RE = /^[\w.~-]+\/[\w.~-]+(:[\w.~-]+)?$/;

// The current list ([{id, name, vendor, contextWindow, vision, reasoning, price}]) and a
// version that changes with it (models.mjs refreshes its synthesized entries).
let current = [];
let byId = new Map();
let version = 0;

/** Whether `id` (`or:vendor/model`) names an OpenRouter model Harbor can run. */
export function isOpenRouterId(id) {
  if (typeof id !== 'string' || !id.startsWith(OPENROUTER_PREFIX)) return false;
  const rest = id.slice(OPENROUTER_PREFIX.length);
  return ID_RE.test(rest) && !rest.endsWith(':free');
}

/** The cached facts about an `or:` model, or undefined when the list does not have it. */
export function openRouterModel(id) {
  return byId.get(id);
}

export function openRouterModels() {
  return current;
}

export function openRouterVersion() {
  return version;
}

/** Replace the cached list (tests, the disk cache, a refresh). */
export function setOpenRouterModels(list) {
  current = Array.isArray(list) ? list : [];
  byId = new Map(current.map((model) => [model.id, model]));
  version += 1;
}

// USD per token (a string) as USD per million tokens; null when OpenRouter has no fixed price.
function perMillion(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number) || number < 0) return null;
  return Number((number * 1e6).toPrecision(4));
}

function splitName(modelName, openrouterId) {
  const text = String(modelName || '');
  const colon = text.indexOf(': ');
  if (colon > 0) return { vendor: text.slice(0, colon), name: text.slice(colon + 2) };
  return { vendor: openrouterId.split('/')[0], name: text || openrouterId };
}

/**
 * The picker's list from OpenRouter's ZDR endpoint list (`zdr`: its JSON, `{data: [...]}`
 * or the array) and model list (`models`: `{data: [...]}`, for vision; optional). One
 * entry per model with a tool-taking ZDR endpoint, `:free` models left out; price is the
 * cheapest such endpoint's (the gateway routes by price), context the largest; sorted by name.
 */
export function parseOpenRouterModels(zdr, models) {
  const endpoints = Array.isArray(zdr) ? zdr : Array.isArray(zdr?.data) ? zdr.data : [];
  const vision = new Set();
  for (const model of Array.isArray(models?.data) ? models.data : []) {
    if (model?.architecture?.input_modalities?.includes('image')) vision.add(model.id);
  }
  const found = new Map();
  for (const endpoint of endpoints) {
    const openrouterId = endpoint?.model_id;
    const id = OPENROUTER_PREFIX + openrouterId;
    if (typeof openrouterId !== 'string' || !isOpenRouterId(id)) continue;
    const params = Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters : [];
    if (!params.includes('tools')) continue;
    const price = { in: perMillion(endpoint.pricing?.prompt), out: perMillion(endpoint.pricing?.completion) };
    const context = Number(endpoint.context_length) > 0 ? Number(endpoint.context_length) : 0;
    let model = found.get(id);
    if (!model) {
      model = { id, ...splitName(endpoint.model_name, openrouterId), contextWindow: 0, vision: vision.has(openrouterId), reasoning: false, price };
      found.set(id, model);
    } else if (price.in !== null && (model.price.in === null || price.in < model.price.in)) {
      model.price = price;
    }
    model.contextWindow = Math.max(model.contextWindow, context);
    if (params.includes('reasoning')) model.reasoning = true;
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Keeps the list current: `load()` reads the disk cache, `refresh()` fetches it (and saves
 * it), `start()` does both and refreshes every 6 h. A failed fetch keeps what is known.
 */
export function createOpenRouterCatalog({ dataDir, fetchImpl = globalThis.fetch, refreshMs = REFRESH_MS, log = console } = {}) {
  const file = dataDir ? path.join(dataDir, FILE) : null;
  let timer = null;
  let pending = null;

  function load() {
    if (!file) return false;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(saved?.models)) return false;
      setOpenRouterModels(saved.models);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') log.error(`Could not read ${file}: ${error.message}`);
      return false;
    }
  }

  function save(models) {
    if (!file) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ fetchedAt: new Date().toISOString(), models }) + '\n', { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch (error) {
      log.error(`Could not save ${file}: ${error.message}`);
    }
  }

  async function getJson(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  async function fetchList() {
    const [zdr, models] = await Promise.all([
      getJson(ZDR_URL),
      // Vision only: the list still works without it.
      getJson(MODELS_URL).catch((error) => {
        log.error(`Could not fetch OpenRouter's model list: ${error.message}`);
        return null;
      }),
    ]);
    const list = parseOpenRouterModels(zdr, models);
    if (!list.length) throw new Error('OpenRouter listed no ZDR models');
    return list;
  }

  /** Fetch the list now (concurrent calls share one fetch); resolves to the list in use. */
  function refresh() {
    pending ??= fetchList()
      .then((list) => {
        setOpenRouterModels(list);
        save(list);
      })
      .catch((error) => log.error(`Could not refresh the OpenRouter models: ${error.message}`))
      .finally(() => {
        pending = null;
      })
      .then(() => current);
    return pending;
  }

  function start() {
    load();
    const first = refresh();
    timer = setInterval(refresh, refreshMs);
    timer.unref?.();
    return first;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  /** The list, fetching it first when nothing is known yet. */
  async function list() {
    if (!current.length) await refresh();
    return current;
  }

  return { load, refresh, start, stop, list };
}
